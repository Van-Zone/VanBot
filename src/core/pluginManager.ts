import { readdir } from "fs/promises"
import { watch } from "fs"
import { readdirSync } from "fs"
import { access } from "fs/promises"
import { join, resolve } from "path"
import { globalBus } from "./eventBus.js"
import type { BotEvent } from "./models/event.js"
import type { BaseAdapter } from "../adapter/base.js"
import type { VanbotPlugin } from "./pluginContext.js"
import { hasCapabilities } from "./capabilities.js"
import type { PluginEntry } from "./config.js"
import type { PluginApiProxy, PluginApiName } from "./pluginApi.js"

// 插件配置条目：boolean 或 { enable, apis }
export type PluginEntryConfig = boolean | PluginEntry

function entryEnabled(v: PluginEntryConfig | undefined): boolean {
  if (v === undefined) return false
  if (typeof v === "boolean") return v
  return v.enable !== false
}

function entryApis(v: PluginEntryConfig | undefined): PluginApiName[] | undefined {
  if (v && typeof v === "object" && Array.isArray(v.apis)) return v.apis as PluginApiName[]
  return undefined
}

type PluginHandler = (eventName: string, event: BotEvent, bot: BaseAdapter) => void

interface LoadedPlugin {
  name: string
  handler: PluginHandler | null
  filePath: string
  enabled: boolean
  // definePlugin 插件（新体系，走 ctx 隔离 + 副作用追踪）
  vanbot?: VanbotPlugin
}

// 插件管理器
export class PluginManager {
  private plugins = new Map<string, LoadedPlugin>()
  private readonly pluginDir: string
  private readonly enabledMap: Record<string, PluginEntryConfig>
  private readonly hotReload: boolean
  private reloadTimers = new Map<string, NodeJS.Timeout>()
  private watcher: ReturnType<typeof watch> | null = null
  // 代理 API 工厂：启用 definePlugin 时注入 ctx.api（受权限管控）
  private readonly apiFactory?: (
    name: string,
    metaApis: PluginApiName[],
    cfgApis?: PluginApiName[],
  ) => PluginApiProxy

  constructor(
    pluginDir: string,
    enabledMap: Record<string, PluginEntryConfig>,
    hotReload = true,
    options: {
      apiFactory?: (
        name: string,
        metaApis: PluginApiName[],
        cfgApis?: PluginApiName[],
      ) => PluginApiProxy
    } = {},
  ) {
    this.pluginDir = resolve(pluginDir)
    this.enabledMap = enabledMap
    this.hotReload = hotReload
    this.apiFactory = options.apiFactory
  }

  // 扫描并加载所有插件
  async loadAll(): Promise<void> {
    let files: string[]
    try {
      files = await readdir(this.pluginDir)
    } catch {
      console.warn(`[插件] 插件目录不存在: ${this.pluginDir}`)
      return
    }

    const tsFiles = files.filter(f => f.endsWith(".ts") && !f.startsWith("_"))
    console.log(`[插件] 发现 ${tsFiles.length} 个插件文件`)

    for (const file of tsFiles) {
      const name = file.replace(/\.ts$/, "")
      if (!entryEnabled(this.enabledMap[name])) {
        console.log(`[插件] ${name} 已在配置中禁用，跳过加载`)
        continue
      }
      try {
        await this.loadPlugin(name, join(this.pluginDir, file))
      } catch (err) {
        console.error(`[插件] 加载 ${name} 失败:`, err)
      }
    }

    if (this.hotReload) this.startWatch()
  }

  // 加载单个插件
  private async loadPlugin(name: string, filePath: string): Promise<void> {
    const mod = await this.dynamicImport(filePath)
    const handler = this.buildHandler(name, mod)
    const vanbot = mod.default?.kind === "vanbot-plugin" ? (mod.default as VanbotPlugin) : undefined

    const plugin: LoadedPlugin = {
      name,
      handler,
      filePath,
      enabled: false,
      vanbot,
    }
    this.plugins.set(name, plugin)

    const shouldEnable = entryEnabled(this.enabledMap[name])
    if (shouldEnable) {
      // 依赖检查（仅提示，不阻断）
      if (vanbot?.meta.dependencies?.length) {
        for (const dep of vanbot.meta.dependencies) {
          if (!this.enabledMap[dep]) {
            console.warn(`[插件] ${name} 依赖 ${dep}，但该插件未启用`)
          }
        }
      }
      await this.enablePlugin(name)
    } else {
      console.log(`[插件] ${name} 已加载（未启用）`)
    }
  }

  // 根据模块导出构建事件处理器（仅支持新式 definePlugin 插件）
  private buildHandler(name: string, mod: Record<string, any>): PluginHandler | null {
    // 新体系：definePlugin 产物（ctx 隔离 + requiresCapabilities 自动过滤）
    if (mod.default?.kind === "vanbot-plugin") {
      const vp = mod.default as VanbotPlugin
      const onEvent = vp.handlers?.onEvent
      return (eventName: string, event: BotEvent, bot: BaseAdapter) => {
        if (!onEvent) return
        // 插件声明所需会话能力：事件能力不足时自动跳过（能力下沉内核）
        if (vp.meta.requiresCapabilities?.length) {
          const caps = event.capabilities ?? {}
          if (!hasCapabilities(caps, vp.meta.requiresCapabilities)) return
        }
        Promise.resolve(onEvent(event, bot)).catch(e =>
          console.error(`[插件:${name}] onEvent 异常:`, e)
        )
      }
    }
    // 仅支持新式 definePlugin 插件，旧式 onEvent 写法已彻底移除、不与新体系并存；
    // 非 definePlugin 模块一律跳过并提示
    console.warn(
      `[插件] ${name} 未导出 definePlugin（${name}.ts 请使用 definePlugin 新式写法），已跳过，不接收事件`,
    )
    return null
  }

  // 动态导入模块，加时间戳绕过缓存以支持热重载
  private async dynamicImport(filePath: string): Promise<Record<string, any>> {
    const normalized = filePath.replace(/\\/g, "/")
    const url = `file:///${normalized}?t=${Date.now()}`
    return await import(url)
  }

  // 启用插件
  async enablePlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name)
    if (!plugin) {
      console.warn(`[插件] 未找到 ${name}`)
      return
    }
    if (plugin.enabled) return

    if (plugin.handler) {
      globalBus.on("*", plugin.handler)
    }
    // definePlugin：注入受控代理 API → 提交缓存的 Skill（activate）→ 执行 onEnable
    if (plugin.vanbot) {
      // 两道闸门：插件声明 apis + config 白名单（交集），未声明则 api 为 undefined（全禁用）
      const metaApis = plugin.vanbot.meta.apis
      if (this.apiFactory && metaApis?.length) {
        plugin.vanbot.ctx.api = this.apiFactory(name, metaApis, entryApis(this.enabledMap[name]))
      }
      plugin.vanbot.ctx.activate()
      if (plugin.vanbot.handlers?.onEnable) {
        await plugin.vanbot.handlers.onEnable()
      }
    }
    plugin.enabled = true
    console.log(`[插件] ${name} 已启用`)
  }

  // 按新配置同步插件启停（config.json 热重载用）：只处理变化的插件，不重复加载
  async syncEnabled(enabledMap: Record<string, PluginEntryConfig>): Promise<void> {
    // 更新内部开关表
    for (const key of Object.keys(this.enabledMap)) delete this.enabledMap[key]
    Object.assign(this.enabledMap, enabledMap)

    // 热插拔：新启用但尚未加载的插件（如初始禁用、热重载后打开），动态加载
    let files: string[] = []
    try {
      files = await readdir(this.pluginDir)
    } catch {
      // 插件目录不可读时忽略
    }
    for (const file of files) {
      const name = file.replace(/\.ts$/, "")
      if (!file.endsWith(".ts") || file.startsWith("_")) continue
      if (entryEnabled(enabledMap[name]) && !this.plugins.has(name)) {
        try {
          await this.loadPlugin(name, join(this.pluginDir, file))
          console.log(`[插件] ${name} 已动态加载（config 热重载启用）`)
        } catch (err) {
          console.error(`[插件] 加载 ${name} 失败:`, err)
        }
      }
    }

    // 只启停变化的插件
    for (const name of this.plugins.keys()) {
      const should = entryEnabled(this.enabledMap[name])
      const plugin = this.plugins.get(name)!
      if (should && !plugin.enabled) await this.enablePlugin(name)
      else if (!should && plugin.enabled) await this.disablePlugin(name)
    }
  }

  // 禁用插件
  async disablePlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name)
    if (!plugin || !plugin.enabled) return

    if (plugin.handler) {
      globalBus.off("*", plugin.handler)
    }
    // definePlugin：先 onDisable，再 dispose 清理全部副作用（定时器/监听/Skill）
    if (plugin.vanbot) {
      if (plugin.vanbot.handlers?.onDisable) {
        await plugin.vanbot.handlers.onDisable()
      }
      plugin.vanbot.ctx.dispose()
    }
    plugin.enabled = false
    console.log(`[插件] ${name} 已禁用`)
  }

  // 热重载单个插件
  async reloadPlugin(name: string): Promise<void> {
    const plugin = this.plugins.get(name)
    if (!plugin) return

    // 文件已被删除 → 彻底卸载（off handler + 移除注册），避免旧模块 handler 残留重复响应
    try {
      await access(plugin.filePath)
    } catch {
      console.log(`[插件] ${name} 文件已删除，彻底卸载`)
      await this.disablePlugin(name)
      this.plugins.delete(name)
      return
    }

    const wasEnabled = plugin.enabled
    if (wasEnabled) await this.disablePlugin(name)

    try {
      const mod = await this.dynamicImport(plugin.filePath)
      // 关键：同步更新 vanbot 引用（新模块会 create 新的 PluginContext），
      // 否则 enablePlugin 仍向旧 ctx 注入 api，新 handler 捕获的新 ctx.api 会是 undefined
      plugin.vanbot = mod.default?.kind === "vanbot-plugin" ? (mod.default as VanbotPlugin) : undefined
      plugin.handler = this.buildHandler(name, mod)
      if (wasEnabled) await this.enablePlugin(name)
      console.log(`[插件] ${name} 热重载完成`)
    } catch (err) {
      console.error(`[插件] ${name} 热重载失败，保持原版本:`, err)
      // 恢复原模块
      if (wasEnabled) await this.enablePlugin(name)
    }
  }

  // 获取已加载插件名列表
  getEnabledNames(): string[] {
    const result: string[] = []
    for (const p of this.plugins.values()) {
      if (p.enabled) result.push(p.name)
    }
    return result
  }

  // 获取全部已加载插件及启用状态（供代理 API 只读查询，不暴露内部对象）
  getAllPlugins(): { name: string; enabled: boolean }[] {
    return [...this.plugins.values()].map((p) => ({ name: p.name, enabled: p.enabled }))
  }

  // 列出全部插件（含未加载/禁用的），供代理 API 的 plugin.list 使用
  listAllPlugins(): { name: string; loaded: boolean; enabled: boolean }[] {
    let files: string[] = []
    try {
      files = readdirSync(this.pluginDir).filter((f) => f.endsWith(".ts") && !f.startsWith("_"))
    } catch {
      // 插件目录不可读时忽略
    }
    return files.map((f) => {
      const name = f.replace(/\.ts$/, "")
      const p = this.plugins.get(name)
      return { name, loaded: !!p, enabled: !!p?.enabled }
    })
  }

  // 启动文件监听实现热加载
  private startWatch(): void {
    try {
      this.watcher = watch(this.pluginDir, { persistent: false }, (eventType, filename) => {
        if (!filename || !filename.endsWith(".ts")) return
        const name = filename.replace(/\.ts$/, "")

        // 防抖：1000ms 内多次改动只重载一次
        if (this.reloadTimers.has(name)) return
        const timer = setTimeout(() => {
          this.reloadTimers.delete(name)
          this.reloadPlugin(name).catch(e =>
            console.error(`[插件] ${name} 重载异常:`, e)
          )
        }, 1000)
        this.reloadTimers.set(name, timer)
      })
      console.log(`[插件] 热加载监听已启动: ${this.pluginDir}`)
    } catch (err) {
      console.warn(`[插件] 热加载监听启动失败:`, err)
    }
  }

  // 停止所有插件并清理
  async destroy(): Promise<void> {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
    for (const name of [...this.plugins.keys()]) {
      await this.disablePlugin(name)
    }
    this.plugins.clear()
  }
}
