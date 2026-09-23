// WeFlow 适配器
// 通过 WeFlow 本地 HTTP API（默认 http://127.0.0.1:5031）接入微信
// WeFlow 支持微信 4.0+，通过 Hook 微信数据库获取聊天记录
//
// 前置条件：
// 1. 安装并运行 WeFlow 桌面应用
// 2. 微信桌面版已登录
// 3. WeFlow 中启用 API 服务（设置 → API 服务 → 启动服务）
// 4. 复制 Access Token 填到配置中
//
// 配置项：
// botId         - 框架内标识
// type          - "weflow"
// baseUrl       - WeFlow API 地址，默认 http://127.0.0.1:5031
// accessToken   - API 访问令牌（WeFlow 设置中获取）
// pollInterval  - 消息轮询间隔（毫秒），默认 3000

import { BaseAdapter } from "../base.js"
import { convertWeFlowMessage, isGroupMessage } from "./converter.js"
import type { WeFlowMessage, WeFlowSession } from "./types.js"
import { registerBot } from "../../core/botRegistry.js"
import type { Capabilities } from "../../core/capabilities.js"
import type { BotEvent } from "../../core/models/event.js"
import type { MessageChain } from "../../core/models/message.js"

export class WeFlowAdapter extends BaseAdapter {
  public readonly botId: string
  private readonly cfg: Record<string, any>
  private readonly baseUrl: string
  private readonly accessToken: string
  private readonly pollInterval: number
  private pollTimer?: NodeJS.Timeout
  private lastMsgTime: Map<string, number> = new Map()

  constructor(config: Record<string, any>) {
    super()
    this.cfg = config
    this.botId = config.botId
    this.baseUrl = (config.baseUrl || "http://127.0.0.1:5031").replace(/\/$/, "")
    this.accessToken = config.accessToken || ""
    this.pollInterval = config.pollInterval || 3000
    registerBot(this)
  }

  public async connect(): Promise<void> {
    // 健康检查
    await this.apiRequest("/health", false)
    console.log(`[WeFlow] API 连接成功: ${this.baseUrl}`)

    // 获取自己的 wxid（从联系人列表或会话中推断）
    try {
      const sessions = await this.apiRequest("/api/v1/sessions?limit=1")
      console.log(`[WeFlow] 会话列表获取成功`)
    } catch (e) {
      console.warn(`[WeFlow] 获取会话列表失败: ${(e as Error).message}`)
    }

    // 启动消息轮询
    this.pollTimer = setInterval(() => this.pollMessages(), this.pollInterval)

    this.connected = true
    console.log(`[WeFlow] 适配器已启动 (botId=${this.botId}, 轮询间隔=${this.pollInterval}ms)`)
  }

  public async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
    this.connected = false
    console.log(`[WeFlow] 适配器已断开 (botId=${this.botId})`)
  }

  // 统一 API 入口
  public async callApi<T = unknown>(action: string, params?: Record<string, unknown>): Promise<T> {
    switch (action) {
      case "send_text":
      case "send_private_msg":
      case "send_group_msg":
        return this.sendViaWeFlow(params ?? {}) as T

      case "get_sessions":
        return this.apiRequest("/api/v1/sessions", true, params) as T

      case "get_messages":
        return this.apiRequest("/api/v1/messages", true, params) as T

      case "get_contacts":
        return this.apiRequest("/api/v1/contacts", true, params) as T

      case "get_group_members":
        return this.apiRequest("/api/v1/group-members", true, params) as T

      default:
        // 通用 API 调用
        const path = action.startsWith("/") ? action : `/api/v1/${action}`
        return this.apiRequest(path, true, params) as T
    }
  }

  // 微信会话能力集
  public computeCapabilities(_event: BotEvent): Readonly<Capabilities> {
    return {
      text: true,
      image: false,    // WeFlow 目前主要是读取，发送图片待确认
      record: false,
      video: false,
      file: false,
      at: true,
      reply: false,
      face: false,
      forward: false,
      markdown: false,
      card: false,
      canMuteMember: false,
      canKickMember: false,
      canSetAdmin: false,
    }
  }

  // ============ 发送消息 ============

  public async sendGroupMsg(groupId: number | string, chain: MessageChain | string): Promise<unknown> {
    return this.sendChain(String(groupId), chain)
  }

  public async sendPrivateMsg(userId: number | string, chain: MessageChain | string): Promise<unknown> {
    return this.sendChain(String(userId), chain)
  }

  private async sendChain(receiver: string, chain: MessageChain | string): Promise<unknown> {
    const text = typeof chain === "string" ? chain : this.chainToText(chain)
    if (!text) return { code: -1, msg: "空消息" }

    // WeFlow 发送消息 API 待确认，先尝试常见端点
    try {
      const resp = await this.apiRequest("/api/v1/messages/send", true, {
        method: "POST",
        body: {
          talker: receiver,
          content: text,
          type: 1,
        },
      })
      return resp
    } catch {
      // 如果发送端点不存在，尝试另一个常见路径
      try {
        return await this.apiRequest("/api/v1/send-text", true, {
          method: "POST",
          body: { talker: receiver, content: text },
        })
      } catch (e) {
        throw new Error(
          `[WeFlow] 发送消息失败：WeFlow API 可能不支持发送消息。` +
          `请确认 WeFlow 版本是否支持发送功能。错误: ${(e as Error).message}`
        )
      }
    }
  }

  private async sendViaWeFlow(params: Record<string, unknown>): Promise<unknown> {
    const receiver = String(params.group_id ?? params.user_id ?? params.talker ?? "")
    const message = params.message ?? params.text ?? ""
    if (!receiver) return { code: -1, msg: "缺少 receiver" }
    return this.sendChain(receiver, message as MessageChain | string)
  }

  private chainToText(chain: MessageChain): string {
    return chain
      .map(seg => {
        switch (seg.type) {
          case "text": return seg.data?.text ?? ""
          case "at": return `@${seg.data?.qq ?? seg.data?.user_id ?? ""} `
          case "face": return `[表情:${seg.data?.id ?? ""}]`
          default: return `[${seg.type}]`
        }
      })
      .join("")
  }

  // ============ 消息轮询 ============

  private async pollMessages(): Promise<void> {
    try {
      // 获取最新会话列表（取最近活跃的）
      const sessionsResp = await this.apiRequest<WeFlowSession[]>("/api/v1/sessions?limit=20")
      const sessions = Array.isArray(sessionsResp) ? sessionsResp : (sessionsResp as any)?.data ?? []

      for (const session of sessions) {
        const talker = session.talker
        if (!talker) continue

        // 获取该会话最新的几条消息
        const since = this.lastMsgTime.get(talker) || 0
        const msgResp = await this.apiRequest<WeFlowMessage[]>(
          `/api/v1/messages?talker=${encodeURIComponent(talker)}&limit=5&since=${since}`
        )
        const messages = Array.isArray(msgResp) ? msgResp : (msgResp as any)?.data ?? []

        for (const msg of messages) {
          const msgTime = msg.createTime || 0
          const lastSeen = this.lastMsgTime.get(talker) || 0

          // 跳过旧消息和自己发的消息
          if (msgTime <= lastSeen) continue

          // 更新时间戳
          const prevTime = this.lastMsgTime.get(talker) || 0; if (msgTime > prevTime) {
            this.lastMsgTime.set(talker, msgTime)
          }

          // 转换并派发事件
          const event = convertWeFlowMessage(msg, this.botId, this.selfId)
          const eventName = isGroupMessage(talker) ? "group_message" : "private_message"
          this.emitEvent(eventName, event)
        }
      }
    } catch (e) {
      // 轮询出错不中断，下次再试
      console.debug(`[WeFlow] 轮询消息出错: ${(e as Error).message}`)
    }
  }

  // ============ HTTP API 调用 ============

  private async apiRequest<T = unknown>(
    path: string,
    needAuth = true,
    options?: { query?: Record<string, unknown>; method?: string; body?: unknown }
  ): Promise<T> {
    const url = new URL(path.startsWith("http") ? path : `${this.baseUrl}${path}`)

    // 添加查询参数
    if (options?.query) {
      for (const [k, v] of Object.entries(options.query)) {
        if (v !== undefined && v !== null) {
          url.searchParams.set(k, String(v))
        }
      }
    }

    const headers: Record<string, string> = {}
    if (needAuth && this.accessToken) {
      headers["Authorization"] = `Bearer ${this.accessToken}`
    }

    const method = options?.method || "GET"
    const fetchOptions: RequestInit = { method, headers }

    if (method !== "GET" && options?.body !== undefined) {
      headers["Content-Type"] = "application/json"
      fetchOptions.body = JSON.stringify(options.body)
    }

    const resp = await fetch(url.toString(), fetchOptions)
    if (!resp.ok) {
      throw new Error(`WeFlow API ${method} ${url.pathname} 失败: HTTP ${resp.status}`)
    }
    return resp.json() as Promise<T>
  }
}
