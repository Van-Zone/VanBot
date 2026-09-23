import { readFile, writeFile } from "fs/promises"
import { watch, existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync, readdirSync } from "fs"
import { resolve, join } from "path"
import os from "os"
import { PluginManager } from "./core/pluginManager.js"
import type { AppConfig, BotConfig, RawConfig } from "./core/config.js"
import type { BaseAdapter } from "./adapter/base.js"
import { PluginApiManager, type PluginApiBridge, type BotSnapshot, type SystemInfo } from "./core/pluginApi.js"
import { startWebUI } from "./core/webui.js"

const CONFIG_PATH = resolve("./config.json")
// 插件统一放在项目根目录 plugin/ 下（热插拔 + 热重载），共享依赖放 plugin/lib/ 子目录
const PLUGIN_DIR = join(process.cwd(), "plugin")
// 单实例锁文件
const LOCK_FILE = resolve("data/.vanbot.lock")
// 当前进程是否持有单实例锁（重复实例退出时不删除锁，避免误删首个实例的锁）
let lockOwner = false

// 检查 PID 对应的进程是否存活（Windows/Linux 通用）
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === "EPERM" // 存在但无权访问
  }
}

// 获取单实例锁：已有存活实例则退出
function acquireSingleInstance(): void {
  try {
    if (existsSync(LOCK_FILE)) {
      const oldPid = parseInt(readFileSync(LOCK_FILE, "utf8"), 10)
      if (oldPid && oldPid !== process.pid && isPidAlive(oldPid)) {
        console.error(`[启动] 检测到已有 VanBotJS 实例在运行 (PID ${oldPid})，禁止重复启动，程序退出。`)
        console.error(`[启动] 如需重启请先关闭旧实例。`)
        process.exit(1)
      }
      console.log(`[启动] 检测到残留锁文件（PID ${oldPid} 已退出），接管。`)
    }
    mkdirSync(resolve("data"), { recursive: true })
    writeFileSync(LOCK_FILE, String(process.pid), "utf8")
    lockOwner = true
  } catch (err) {
    console.error("[启动] 写入单实例锁失败（不影响启动）:", err)
  }
}

// 释放单实例锁（仅持锁进程）
function releaseSingleInstance(): void {
  if (!lockOwner) return
  try {
    unlinkSync(LOCK_FILE)
  } catch {
    // 忽略
  }
}

// 采集系统信息：CPU 占用（两次采样）+ 内存 + 运行时间
async function collectSystemInfo(): Promise<SystemInfo> {
  const cpu1 = os.cpus()
  await new Promise((r) => setTimeout(r, 200)) // 采样间隔，取 CPU 变化量
  const cpu2 = os.cpus()
  const sum = (cs: os.CpuInfo[]) =>
    cs.reduce(
      (acc, c) => {
        const t = c.times
        const total = t.user + t.nice + t.sys + t.idle + t.irq
        return { idle: acc.idle + t.idle, total: acc.total + total }
      },
      { idle: 0, total: 0 },
    )
  const a = sum(cpu1)
  const b = sum(cpu2)
  const idleDelta = b.idle - a.idle
  const totalDelta = b.total - a.total
  const cpuUsage =
    totalDelta > 0 ? Math.min(100, Math.max(0, Math.round((1 - idleDelta / totalDelta) * 100))) : 0

  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  return {
    cpuUsage,
    totalMem,
    freeMem,
    memUsage: Math.round(((totalMem - freeMem) / totalMem) * 100),
    systemUptime: os.uptime(),
    processUptime: process.uptime(),
    platform: os.platform(),
    arch: os.arch(),
  }
}
// Larry 3D
const LOGO = `
 __  __                   ____            __        _____  ____       
/\\ \\/\\ \\                 /\\  _\`\\         /\\ \\__    /\\___ \\/\\  _\`\\     
\\ \\ \\ \\ \\     __      ___\\ \\ \\L\\ \\    ___\\ \\ ,_\\   \\/__/\\ \\ \\,\\L\\_\\   
 \\ \\ \\ \\ \\  /'__\`\\  /' _ \`\\ \\  _ <'  / __\`\\ \\ \\/      _\\ \\ \\/_\\__ \\   
  \\ \\ \\_/ \\/\\ \\L\\.\\_/\\ \\/\\ \\ \\ \\L\\ \\/\\ \\L\\ \\ \\ \\_  __/\\ \\_\\ \\/\\ \\L\\ \\ 
   \\ \`\\___/\\ \\__/.\\_\\ \\_\\ \\_\\ \\____/\\ \\____/\\ \\__\\/\\_\\ \\____/\\ \`\\____\\
    \`\\/__/  \\/__/\\/_/\\/_/\\/_/\\/___/  \\/___/  \\/__/\\/_/\\/___/  \\/_____/   
`

async function loadConfig(): Promise<AppConfig> {
  const raw = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as RawConfig

  // 仅支持新版对象格式；旧版纯数组格式已彻底移除（不允许新旧并存）
  if (Array.isArray(raw)) {
    throw new Error(
      'config.json 使用了已移除的旧版纯数组格式，请改为新版对象格式：{ "bots": [...], "plugins": {...} }',
    )
  }

  return raw
}

// 适配器运行时注册表：扫描 src/adapter/ 下已安装的适配器目录，动态加载。
// 框架核心不内置任何适配器 —— 未安装的类型会提示 van adapter install。
type AdapterCtor = new (cfg: BotConfig) => BaseAdapter
const adapterCtors = new Map<string, AdapterCtor>()

// 扫描 src/adapter/<name>/client.js，探测导出的 Adapter 类并注册（目录名 = type）。
// 加载失败（缺依赖 / 平台不支持等）跳过该适配器，不影响其它平台启动。
async function loadAdapters(): Promise<void> {
  const dir = resolve("src/adapter")
  if (!existsSync(dir)) return
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "client.ts")))
    .map((d) => d.name)
  const loaded: string[] = []
  for (const name of names) {
    try {
      const mod = await import(`./adapter/${name}/client.js`)
      const ctorKey = Object.keys(mod).find((k) => k.endsWith("Adapter") && typeof mod[k] === "function")
      if (!ctorKey) {
        console.warn("[配置] 适配器 " + name + " 未导出 Adapter 类，跳过")
        continue
      }
      adapterCtors.set(name, mod[ctorKey] as AdapterCtor)
      loaded.push(name)
    } catch (e) {
      console.warn("[配置] 适配器 " + name + " 加载失败，已跳过: " + (e as Error).message)
    }
  }
  console.log("[启动] 已加载适配器: " + (loaded.length ? loaded.join(", ") : "无"))
}

async function createAdapter(cfg: BotConfig): Promise<BaseAdapter | null> {
  const Ctor = adapterCtors.get(cfg.type)
  if (!Ctor) {
    console.error("[配置] 未安装适配器类型 " + cfg.type + " (botId: " + cfg.botId + ")，请运行: van adapter install " + cfg.type)
    return null
  }
  try {
    return new Ctor(cfg)
  } catch (e) {
    console.error("[配置] 适配器 " + cfg.type + " 实例化失败（可能缺少依赖）: " + (e as Error).message)
    return null
  }
}
// 适配器运行时管理（config.json 热重载）
const adapterMap = new Map<string, BaseAdapter>()
const adapterCfgMap = new Map<string, BotConfig>()
// 当前 config 的 bots 全量（含 enable:false 的禁用项），供代理 API 列出
let currentBotsConfig: BotConfig[] = []

// 按配置启动/重建/移除适配器。
// - enable === false → 若在运行则断开（不启动）
// - 新增 botId → 启动新适配器
// - 已有 botId 配置变更 → 销毁旧实例并重建重连
// - 配置中已删除的 botId → 销毁移除
async function applyBots(config: AppConfig, init = false): Promise<void> {
  const tag = init ? "[启动]" : "[热重载]"
  const seen = new Set<string>()
  for (const cfg of config.bots) {
    // bot 级开关：enable === false 时不启动，运行中的断开
    if (cfg.enable === false) {
      const disabled = adapterMap.get(cfg.botId)
      if (disabled) {
        console.log(`${tag} ${cfg.botId} 已禁用（enable=false），断开...`)
        try {
          await disabled.destroy()
        } catch (err) {
          console.error(`${tag} ${cfg.botId} 断开异常:`, err)
        }
        adapterMap.delete(cfg.botId)
        adapterCfgMap.delete(cfg.botId)
      }
      continue
    }
    seen.add(cfg.botId)
    const existing = adapterMap.get(cfg.botId)
    const oldCfg = adapterCfgMap.get(cfg.botId)
    const cfgChanged = !!oldCfg && JSON.stringify(oldCfg) !== JSON.stringify(cfg)
    if (existing && !cfgChanged) continue // 无变化，保持连接

    if (existing) {
      // 配置变更 → 重建
      console.log(`${tag} ${cfg.botId} 配置变更，重建适配器...`)
      try {
        await existing.destroy()
      } catch (err) {
        console.error(`${tag} ${cfg.botId} 销毁异常:`, err)
      }
      adapterMap.delete(cfg.botId)
      adapterCfgMap.delete(cfg.botId)
    }

    const adapter = await createAdapter(cfg)
    if (!adapter) continue
    try {
      await adapter.connect()
      adapterMap.set(cfg.botId, adapter)
      adapterCfgMap.set(cfg.botId, cfg)
      console.log(`${tag} ${cfg.type} 适配器已启动: ${cfg.botId}`)
    } catch (err) {
      console.error(`${tag} ${cfg.botId} 连接失败:`, err)
    }
  }

  // 移除配置中已删除的机器人
  for (const [botId, adapter] of adapterMap) {
    if (!seen.has(botId)) {
      console.log(`${tag} 配置中已移除机器人，断开: ${botId}`)
      try {
        await adapter.destroy()
      } catch (err) {
        console.error(`${tag} ${botId} 断开异常:`, err)
      }
      adapterMap.delete(botId)
      adapterCfgMap.delete(botId)
    }
  }
}

// 写回 config.json（保留格式；config watcher 会据此触发热重载）
async function updateConfigFile(mutator: (cfg: AppConfig) => void): Promise<void> {
  const cfg = await loadConfig()
  mutator(cfg)
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8")
}

// 机器人只读快照（不暴露原始 adapter 对象；adapter 可为 undefined 表示未运行/禁用）
function botSnapshot(adapter: BaseAdapter | undefined, cfg?: BotConfig, enabled = true): BotSnapshot {
  return {
    botId: cfg?.botId ?? adapter?.botId ?? "",
    type: cfg?.type ?? "",
    connected: !!adapter?.connected,
    enabled,
    selfId: adapter ? (adapter.selfId ?? "") : "",
    stats: adapter ? { ...adapter.stats } : { received: 0, sent: 0 },
  }
}

// 更新某个 bot 的 enable 开关（写回 config + 即时应用）
async function setBotEnable(botId: string, enable: boolean): Promise<void> {
  await updateConfigFile((c) => {
    const b = c.bots.find((x) => x.botId === botId)
    if (b) b.enable = enable
  })
  await applyBots(await loadConfig())
}

async function bootstrap(): Promise<void> {
  // 单实例锁：禁止重复启动
  acquireSingleInstance()

  console.log(LOGO)
  console.log("VanBotJS 启动中...\n")

  // 加载配置
  const config = await loadConfig()
  currentBotsConfig = config.bots
  console.log(`[配置] 已加载 ${config.bots.length} 个机器人实例`)
  console.log(`[配置] 插件热加载: ${config.hotReload !== false ? "开启" : "关闭"}`)

  // 加载插件（目录在根 plugin/）
  // 代理 API 桥（受限能力，不暴露内核原始对象）
  let pluginApiManager!: PluginApiManager
  const pluginApiBridge: PluginApiBridge = {
    listBots: () =>
      currentBotsConfig.map((cfg) => {
        const a = adapterMap.get(cfg.botId)
        return botSnapshot(a, cfg, cfg.enable !== false)
      }),
    getBotStatus: (botId) => {
      if (botId) {
        const a = adapterMap.get(botId)
        const cfg = currentBotsConfig.find((c) => c.botId === botId)
        return a ? botSnapshot(a, cfg, cfg?.enable !== false) : undefined
      }
      return currentBotsConfig.map((cfg) => {
        const a = adapterMap.get(cfg.botId)
        return botSnapshot(a, cfg, cfg.enable !== false)
      })
    },
    enableBot: (botId) => setBotEnable(botId, true),
    disableBot: (botId) => setBotEnable(botId, false),
    addBot: async (cfg) => {
      await updateConfigFile((c) => {
        if (!c.bots.some((b) => b.botId === cfg.botId)) {
          c.bots.push({ ...cfg, enable: cfg.enable ?? true } as BotConfig)
        }
      })
      await applyBots(await loadConfig())
    },
    removeBot: async (botId) => {
      await updateConfigFile((c) => {
        c.bots = c.bots.filter((b) => b.botId !== botId)
      })
      await applyBots(await loadConfig())
    },
    listPlugins: () => pluginManager.listAllPlugins(),
    enablePlugin: (n) => pluginManager.enablePlugin(n),
    disablePlugin: (n) => pluginManager.disablePlugin(n),
    getMessageStats: () => {
      const o: Record<string, { received: number; sent: number }> = {}
      for (const [botId, a] of adapterMap) o[botId] = { ...a.stats }
      return o
    },
    getSystemInfo: () => collectSystemInfo(),
  }
  pluginApiManager = new PluginApiManager(pluginApiBridge)

  // WebUI 控制台（config.webui 可开关/改端口；热重载同步）
  let webuiServer: { close(): void } | undefined
  function syncWebUI(cfg: AppConfig): void {
    const w = cfg.webui ?? { enable: true, port: 8080 }
    if (w.enable === false) {
      if (webuiServer) {
        webuiServer.close()
        webuiServer = undefined
        console.log("[WebUI] 控制台已关闭")
      }
      return
    }
    if (!webuiServer) webuiServer = startWebUI(pluginApiBridge, w)
  }

  const pluginManager = new PluginManager(
    PLUGIN_DIR,
    config.plugins ?? {},
    config.hotReload !== false,
    {
      // 插件启用时按「声明 ∩ config 白名单」注入受控 ctx.api
      apiFactory: (name, metaApis, cfgApis) => pluginApiManager.createApi(name, metaApis, cfgApis),
    }
  )
  await pluginManager.loadAll()

  // 扫描加载已安装适配器（支持热重载，未安装类型提示安装命令）
  await loadAdapters()

  // 启动适配器（支持热重载）
  await applyBots(config, true)

  // 启动 WebUI 控制台
  syncWebUI(config)

  if (adapterMap.size === 0) {
    console.warn("[启动] 当前没有运行中的适配器（全部禁用或连接失败）。程序保持运行，可修改 config.json 热重载，或通过代理 API（#启用机器人 <botId>）恢复。")
  }

  const enabled = pluginManager.getEnabledNames()
  console.log(`\n[启动] 已启用插件: ${enabled.length > 0 ? enabled.join(", ") : "无"}`)
  console.log("[启动] VanBotJS 启动完成，等待事件...\n")

  // config.json 热重载（改机器人配置 / 插件开关自动生效）
  let configTimer: NodeJS.Timeout | undefined
  const configWatcher = watch(CONFIG_PATH, () => {
    clearTimeout(configTimer)
    configTimer = setTimeout(async () => {
      try {
        const newConfig = await loadConfig()
        currentBotsConfig = newConfig.bots
        console.log("\n[热重载] 检测到 config.json 变更，应用新配置...")
        await applyBots(newConfig)
        await pluginManager.syncEnabled(newConfig.plugins ?? {})
        syncWebUI(newConfig)
        console.log("[热重载] 配置已生效\n")
      } catch (err) {
        console.error("[热重载] 配置应用失败（保持原配置运行）:", err)
      }
    }, 800)
  })

  // 优雅关闭
  const shutdown = async (signal: string) => {
    console.log(`\n[关闭] 收到 ${signal} 信号，正在优雅关闭...`)
    if (configTimer) clearTimeout(configTimer)
    configWatcher.close()
    if (webuiServer) {
      webuiServer.close()
      console.log("[关闭] WebUI 已关闭")
    }
    await pluginManager.destroy()
    for (const adapter of adapterMap.values()) {
      try {
        await adapter.destroy()
        console.log(`[关闭] ${adapter.botId} 已断开`)
      } catch (err) {
        console.error(`[关闭] ${adapter.botId} 断开异常:`, err)
      }
    }
    console.log("[关闭] 全部资源已释放，程序退出")
    process.exit(0)
  }

  // 进程退出时释放单实例锁（仅持锁进程）
  process.on("exit", releaseSingleInstance)
  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))
}

bootstrap().catch(err => {
  console.error("[启动失败]", err)
  process.exit(1)
})
