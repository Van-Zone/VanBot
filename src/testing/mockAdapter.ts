// MockAdapter —— 单元测试用内存适配器
// 完全不需要 WebSocket / 网络：
// - 纯内存模拟输入事件（走真实内核管道：traceId/归一化/中间件/插件分发）；
// - 捕获框架输出发送的消息（callApi 的 send_* 动作全部记录）；
// - 可配置会话能力集，用于测试"发送降级"。
// 用法：
// const bot = new MockAdapter({ botId: "MOCK" })
// bot.setCapabilities({ image: false })           // 模拟不支持图片
// await bot.sendEvent("private_message", {...})    // 注入事件
// await bot.flush()                                // 等待异步链
// console.log(bot.sent)                            // 查看发送消息
import { BaseAdapter } from "../adapter/base.js"
import { registerBot } from "../core/botRegistry.js"
import { normalizeEvent } from "../core/eventPipeline.js"
import { globalMiddleware } from "../core/middleware.js"
import { globalBus } from "../core/eventBus.js"
import type { BotEvent } from "../core/models/event.js"
import type { Capabilities } from "../core/capabilities.js"
import { FULL_CAPABILITIES } from "../core/capabilities.js"

export interface MockSent {
  action: string
  params: Record<string, any>
  target: { groupId?: string; userId?: string }
  message: unknown
}

export class MockAdapter extends BaseAdapter {
  public readonly botId: string
  private readonly cfg: Record<string, any>
  // 捕获的发送消息
  public readonly sent: MockSent[] = []
  // 自定义会话能力（测试降级用）
  private caps: Readonly<Capabilities> = FULL_CAPABILITIES

  constructor(config: Record<string, any> = {}) {
    super()
    this.cfg = config
    this.botId = config.botId ?? "MOCK"
    registerBot(this)
  }

  async connect(): Promise<void> {
    this.connected = true
  }

  async disconnect(): Promise<void> {
    this.connected = false
  }

  // 设置模拟会话能力（在默认全能力基础上覆盖；传 false 即关闭该能力）
  setCapabilities(caps: Readonly<Capabilities>): void {
    this.caps = Object.freeze({ ...FULL_CAPABILITIES, ...caps })
  }

  override computeCapabilities(_event: BotEvent): Readonly<Capabilities> {
    return this.caps
  }

  // 捕获所有发送动作
  async callApi<T = any>(action: string, params: Record<string, any> = {}): Promise<T> {
    if (action === "send_msg" || action === "send_private_msg" || action === "send_group_msg") {
      const target = params.group_id
        ? { groupId: String(params.group_id) }
        : { userId: String(params.user_id ?? "") }
      this.sent.push({ action, params, target, message: params.message })
      return { ok: true, data: { message_id: `mock_${this.sent.length}` } } as unknown as Promise<T>
    }
    if (action === "get_me" || action === "get_self_id") {
      return { selfId: this.botId } as unknown as Promise<T>
    }
    throw new Error(`MockAdapter 不支持的 API: ${action}`)
  }

  // 注入一条事件（走真实内核管道，但不重复生成 traceId——由管道处理）
  async sendEvent(eventName: string, event: Partial<BotEvent> & { postType: BotEvent["postType"] }): Promise<BotEvent> {
    const full: BotEvent = {
      botId: event.botId ?? this.botId,
      selfId: event.selfId ?? this.botId,
      userId: event.userId ?? "",
      groupId: event.groupId,
      message: event.message ?? [],
      postType: event.postType,
      raw: event.raw ?? {},
      ...(event as any),
    }
    const normalized = normalizeEvent(full, this)
    this.stats.received++ // 模拟适配器收到一条消息
    globalMiddleware.run(normalized, this, () => {
      globalBus.emit(eventName, normalized, this)
    }).catch((e: any) => console.error("[Mock] 管道异常:", e))
    return normalized
  }

  // 便捷：模拟收到一条私聊文本
  async receivePrivateMessage(userId: string, text: string): Promise<BotEvent> {
    return this.sendEvent("private_message", {
      userId,
      postType: "private_message",
      message: [{ type: "text", data: { text } }],
      raw: { text },
    })
  }

  // 便捷：模拟收到一条群消息
  async receiveGroupMessage(groupId: string, userId: string, text: string): Promise<BotEvent> {
    return this.sendEvent("group_message", {
      groupId,
      userId,
      postType: "group_message",
      message: [{ type: "text", data: { text } }],
      raw: { text },
    })
  }

  // 等待异步链跑完（中间件 + 插件 handler）。
  // 注入事件后调用本方法，再断言 sent。
  async flush(): Promise<void> {
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setTimeout(r, 5))
  }

  clearSent(): void {
    this.sent.length = 0
  }
}
