import type { BotEvent } from "../core/models/event.js"
import type { MessageChain } from "../core/models/message.js"
import { globalBus } from "../core/eventBus.js"
import { registerBot, registerSelfId, unregisterBot } from "../core/botRegistry.js"
import { normalizeEvent } from "../core/eventPipeline.js"
import { globalMiddleware } from "../core/middleware.js"
import { normalizeSegments, segmentsToText } from "../core/messageUtils.js"
import { applySendFallback } from "../core/sendPipeline.js"
import type { Capabilities } from "../core/capabilities.js"
import { FULL_CAPABILITIES } from "../core/capabilities.js"
import { botLog } from "../core/logger.js"

// 发送上下文：可携带会话能力集，内核据此做发送降级
export interface SendContext {
  capabilities?: Readonly<Capabilities>
}

// 适配器基类
// 所有协议适配器（OneBot11 / Milky / Satori / ...）都继承此类
// 内核职责（本类已处理，适配器无需关心）：
// - emitEvent：生成 traceId、归一化事件、填充会话能力集、跑中间件再派发
// - sendMsg：若提供 capabilities 则先执行内核发送降级，再交给适配器翻译
export abstract class BaseAdapter {
  // 框架内机器人标识
  public botId: string = ""
  // 是否已连接
  public connected: boolean = false
  // 收发统计（供代理 API 只读查询）
  public stats = { received: 0, sent: 0 }
  // 协议侧自身标识（适配器登录后设置，如 QQ 号 / 机器人名）
  public selfId: string = ""

  constructor() {
    // 子类自行设置 this.botId 后会自动注册
  }

  abstract connect(): Promise<void>
  abstract disconnect(): Promise<void>
  // 平台 API 统一入口。对插件/内核暴露的契约默认 unknown（调用方需显式指定泛型或自行收窄），
  // 避免隐式 any 向业务层扩散；适配器内部实现属于协议翻译边界，可用 any 接收平台原始参数。
  abstract callApi<T = unknown>(action: string, params?: Record<string, unknown>): Promise<T>

  // 上报【会话粒度】能力集合。
  // 适配器可按事件（群/私聊/是否管理员）返回不同能力集；
  // 未实现默认全能力（与引入能力体系前行为一致）。
  // 例：QQ 群返回 { text,image,...,canMuteMember:true }，QQ 私聊无 canMuteMember。
  computeCapabilities(_event: BotEvent): Readonly<Capabilities> {
    return FULL_CAPABILITIES
  }

  // 发送群消息（ctx.capabilities 存在时先内核降级）
  async sendGroupMsg(
    groupId: number | string,
    chain: MessageChain | string,
    ctx?: SendContext,
  ): Promise<unknown> {
    if (ctx?.capabilities) {
      const downgraded = applySendFallback(normalizeSegments(chain), ctx.capabilities)
      const r = await this.callApi("send_group_msg", { group_id: groupId, message: downgraded })
      this.stats.sent++
      this.emitMessageSent(String(groupId), "", downgraded)
      return r
    }
    const message = typeof chain === "string" ? chain : chain.map(s => s.toOneBot11())
    const r = await this.callApi("send_group_msg", { group_id: groupId, message })
    this.stats.sent++
    this.emitMessageSent(String(groupId), "", message)
    return r
  }

  // 发送私聊消息（ctx.capabilities 存在时先内核降级）
  async sendPrivateMsg(
    userId: number | string,
    chain: MessageChain | string,
    ctx?: SendContext,
  ): Promise<unknown> {
    if (ctx?.capabilities) {
      const downgraded = applySendFallback(normalizeSegments(chain), ctx.capabilities)
      const r = await this.callApi("send_private_msg", { user_id: userId, message: downgraded })
      this.stats.sent++
      this.emitMessageSent("", String(userId), downgraded)
      return r
    }
    const message = typeof chain === "string" ? chain : chain.map(s => s.toOneBot11())
    const r = await this.callApi("send_private_msg", { user_id: userId, message })
    this.stats.sent++
    this.emitMessageSent("", String(userId), message)
    return r
  }

  // 自动判断群/私聊发送（ctx.capabilities 存在时先内核降级）
  async sendMsg(
    target: { groupId?: number | string; userId?: number | string },
    chain: MessageChain | string,
    ctx?: SendContext,
  ): Promise<unknown> {
    if (target.groupId) {
      return this.sendGroupMsg(target.groupId, chain, ctx)
    }
    return this.sendPrivateMsg(target.userId ?? 0, chain, ctx)
  }

  // 发送成功后派发 message_sent 事件（供日志插件显示机器人发出的消息）
  // 不经过 emitEvent（不走 ignoreSelf / 收发统计 / 归一化），直接广播给插件
  private emitMessageSent(groupId: string, userId: string, message: unknown): void {
    const gid = String(groupId ?? "")
    const uid = String(userId ?? "")
    const ev: BotEvent = {
      botId: this.botId,
      selfId: this.selfId || this.botId,
      userId: uid || gid,
      groupId: gid || undefined,
      message: normalizeSegments(message),
      postType: "message_sent",
      raw: {},
      capabilities: FULL_CAPABILITIES,
    }
    globalBus.emit("message_sent", ev, this)
    // 统一显示发出的消息日志（不依赖 log 插件）
    const logType = gid ? "群聊" : "私聊"
    botLog(String(ev.selfId ?? this.botId), "->", logType, gid || uid, segmentsToText(ev.message))
  }

  // 将转换后的统一事件派发到事件总线
  // 内核管道：生成 traceId → 归一化（ID 转字符串/时间统一/未知段占位/能力集）
  // → 中间件（快照记录）→ globalBus 派发给插件。
  // 同时自动登记 selfId 到全局注册表。
  // 统一处理 ignoreSelf：默认忽略机器人自己产生的消息（防止循环/刷屏）。
  // 子类在 config 里配置 `ignoreSelf: false` 可关闭（默认 true）。
  emitEvent(eventName: string, event: BotEvent): void {
    if (event.selfId) registerSelfId(this, event.selfId)
    const cfg = (this as { cfg?: Record<string, unknown> }).cfg
    const ignoreSelf = cfg ? cfg.ignoreSelf !== false : true
    if (ignoreSelf && event.selfId && event.userId && String(event.selfId) === String(event.userId)) {
      // 机器人自己发的消息，忽略
      return
    }
    this.stats.received++
    // 内核归一化（traceId / ID 字符串化 / 时间 / 未知段占位 / 能力集 / getCapabilities）
    const normalized = normalizeEvent(event, this)
    // 统一显示收到的消息日志（不依赖 log 插件）
    if (eventName === "group_message" || eventName === "private_message") {
      const selfId = String(normalized.selfId ?? this.selfId ?? this.botId)
      const uid = normalized.userId ? String(normalized.userId) : ""
      const gid = normalized.groupId ? String(normalized.groupId) : ""
      botLog(selfId, "<-", gid ? "群聊" : "私聊", gid || uid, segmentsToText(normalized.message ?? []))
    }
    // 中间件（最内层触发插件分发）；fire-and-forget
    globalMiddleware.run(normalized, this, () => {
      globalBus.emit(eventName, normalized, this)
    }).catch((e) => console.error("[中间件] 管道执行异常:", e))
  }

  // 销毁适配器，释放资源
  async destroy(): Promise<void> {
    await this.disconnect()
    unregisterBot(this)
  }
}
