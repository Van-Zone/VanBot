// 插件上下文与 definePlugin（插件体系）
// - ctx 隔离：每个插件获得独立 PluginContext，禁止随意污染全局；
// - 副作用追踪：插件只能用 ctx.setTimeout / ctx.setInterval / ctx.on，
// 内核记录所有定时器与监听句柄，插件卸载/热重载时自动全部清理；
// - 中立 Skill 注册：ctx.registerSkill()，既服务人工命令也服务外部工具。
import { globalBus } from "./eventBus.js"
import { get_bot } from "./botRegistry.js"
import { skillRegistry } from "./skillRegistry.js"
import type { Skill, SkillResult } from "./skillRegistry.js"
import { applySendFallback } from "./sendPipeline.js"
import { normalizeSegments } from "./messageUtils.js"
import type { BotEvent } from "./models/event.js"
import type { BaseAdapter } from "../adapter/base.js"
import type { Capabilities } from "./capabilities.js"
import { hasCapabilities } from "./capabilities.js"
import type { PluginApiProxy, PluginApiName } from "./pluginApi.js"

// 插件元数据声明
export interface PluginMeta {
  // 插件名（唯一）
  name: string
  version?: string
  description?: string
  // 作者
  author?: string
  // 开源协议（如 GPLv3 / MIT）
  license?: string
  // 标签（用于社区分类/搜索）
  tags?: string[]
  // 开源地址（仓库 URL）
  repo?: string
  // 主页/文档地址
  homepage?: string
  // 依赖的其它插件名（启动时检查并提示）
  dependencies?: string[]
  // 处理事件所需的会话能力（事件能力不足时自动跳过）
  requiresCapabilities?: string[]
  // 权限声明（如 "admin" / "owner"；内核记录，具体鉴权由插件/上层实现）
  permissions?: string[]
  // 声明需要调用的代理 API（未声明则全禁用；config.json 白名单可再收窄）
  apis?: PluginApiName[]
}

export interface PluginHandlers {
  onEvent?: (event: BotEvent, bot: BaseAdapter) => void | Promise<void>
  onEnable?: () => void | Promise<void>
  onDisable?: () => void | Promise<void>
}

// 副作用句柄（统一可清理）
interface SideEffect {
  dispose: () => void
}

// 插件上下文：隔离 + 副作用追踪 + 回复（自动内核降级）
export class PluginContext {
  public readonly name: string
  private readonly effects = new Set<SideEffect>()
  private readonly skillNames = new Set<string>()
  private disposed = false
  private active = false
  // 未启用前注册的技能（启用时统一提交）
  private readonly pendingSkills: Skill[] = []
  // 受控代理 API（由 PluginManager 启用插件时注入；未授权调用会抛错）
  public api: PluginApiProxy | undefined

  constructor(name: string) {
    this.name = name
  }

  // 定时器（框架封装，卸载时自动清理）

  setTimeout(fn: (...args: any[]) => void, ms?: number, ...args: any[]): any {
    const id: any = setTimeout(fn, ms, ...args)
    this.effects.add({ dispose: () => clearTimeout(id) })
    return id
  }

  setInterval(fn: (...args: any[]) => void, ms?: number, ...args: any[]): any {
    const id: any = setInterval(fn, ms, ...args)
    this.effects.add({ dispose: () => clearInterval(id) })
    return id
  }

  clearTimeout(id: any): void {
    clearTimeout(id)
  }

  clearInterval(id: any): void {
    clearInterval(id)
  }

  // 事件监听（追踪，卸载时自动移除）

  on(eventName: string, cb: (...args: any[]) => void): void {
    globalBus.on(eventName, cb)
    this.effects.add({ dispose: () => globalBus.off(eventName, cb) })
  }

  off(eventName: string, cb: (...args: any[]) => void): void {
    globalBus.off(eventName, cb)
  }

  // Skill 注册（未启用时缓存，启用时提交，卸载时自动注销）

  registerSkill(skill: Skill): void {
    if (this.active) {
      skillRegistry.register(skill)
      this.skillNames.add(skill.name)
    } else {
      this.pendingSkills.push(skill)
    }
  }

  // 插件启用时提交缓存的 Skill
  activate(): void {
    if (this.active || this.disposed) return
    this.active = true
    for (const s of this.pendingSkills) {
      skillRegistry.register(s)
      this.skillNames.add(s.name)
    }
    this.pendingSkills.length = 0
  }

  // 回复（自动内核降级 + traceId 日志）

  // 回复当前事件来源会话。
  // 自动带上 event.capabilities 走内核发送降级；
  // 日志携带 traceId，贯穿接收→回复全程。
  reply(event: BotEvent, message: unknown): Promise<any> {
    const bot = get_bot(event.botId)
    if (!bot) {
      return Promise.reject(new Error(`[插件:${this.name}] 找不到机器人 ${event.botId}`))
    }
    const target = event.groupId ? { groupId: event.groupId } : { userId: event.userId }
    return bot.sendMsg(target as any, message as any, { capabilities: event.capabilities } as any).then((r: any) => {
      if (event.traceId) {
        console.log(`[reply:${this.name}] traceId=${event.traceId} → ${event.groupId ? `群${event.groupId}` : `私聊${event.userId}`}`)
      }
      return r
    })
  }

  // 判断当前会话能力是否满足（业务代码只判断能力标记，不判断平台）
  hasCapabilities(caps: Readonly<Capabilities>, need: string[] | undefined): boolean {
    return hasCapabilities(caps, need)
  }

  // 销毁：清理全部副作用

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.active = false
    for (const e of this.effects) {
      try {
        e.dispose()
      } catch {
        // ignore
      }
    }
    this.effects.clear()
    for (const n of this.skillNames) {
      skillRegistry.unregister(n)
    }
    this.skillNames.clear()
    this.pendingSkills.length = 0
    console.log(`[插件:${this.name}] 已清理副作用（定时器/监听/Skill）`)
  }
}

// definePlugin 产物（PluginManager 识别 kind 走新路径）
export interface VanbotPlugin {
  kind: "vanbot-plugin"
  meta: PluginMeta
  ctx: PluginContext
  handlers: PluginHandlers
}

// 定义插件（新式插件唯一入口：ctx 隔离 + 副作用追踪 + 能力判断）
// @example
// export default definePlugin(
// { name: "greet", description: "示例插件", requiresCapabilities: ["text"] },
// (ctx) => ({
// onEvent: async (event, bot) => {
// if (event.postType === "private_message") {
// await ctx.reply(event, "你好！")
// }
// },
// }),
// )
export function definePlugin(meta: PluginMeta, setup: (ctx: PluginContext) => PluginHandlers | void): VanbotPlugin {
  const ctx = new PluginContext(meta.name)
  const handlers = (setup(ctx) ?? {}) as PluginHandlers
  return { kind: "vanbot-plugin", meta, ctx, handlers }
}
