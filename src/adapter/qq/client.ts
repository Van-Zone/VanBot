import WebSocket from "ws"
import http from "http"
import fs from "fs"
import path from "path"
import crypto from "crypto"
import { BaseAdapter } from "../base.js"
import { convertQqEvent, segmentsToQqText } from "./converter.js"
import type { QqAppTokenResp, QqGatewayPayload, QqSendResp } from "./types.js"
import {
  QQ_OP,
  QQ_INTENT,
  QQ_FILE_TYPE,
  QQ_BUTTON_ACTION,
  QQ_BUTTON_STYLE,
  QQ_PERMISSION_TYPE,
  QQ_MUTE_OP,
} from "./types.js"
import type { MessageChain } from "../../core/models/message.js"
import { normalizeSegments } from "../../core/messageUtils.js"
import { registerBot } from "../../core/botRegistry.js"
import type { Capabilities } from "../../core/capabilities.js"
import type { BotEvent } from "../../core/models/event.js"

export const QqAdapterMap = new Map<string, QqAdapter>()

const DEFAULT_UA = "VanBotJS/1.0"
// openapi 统一基址（官方"接口调用与鉴权"文档）
const OPENAPI_BASE = "https://api.bot.qq.com"

// QQ 官方机器人适配器（新版 QQ 开放平台）
// 原理：
// 1. WebSocket 连接官方网关（wss://api.sgroup.qq.com 或 /gateway/bot 下发地址）
// 2. 连接后发送 IDENTIFY 鉴权（token = "QQBot {AppID}.{BotToken}"），按 intents 订阅事件
// 3. 按 HELLO 下发的心跳周期发送心跳；断线后重连并发送 RESUME 恢复会话
// 4. 收到 DISPATCH 事件：群@消息/单聊/频道消息/按钮交互 → 转统一事件派发给插件
// 5. 发送：POST /v2/groups/{group_openid}/messages（群）、/v2/users/{openid}/messages（单聊）
// 连接模式（mode）：
// - "websockets"（默认）：官方加密 WebSocket 网关（wss://）
// - "ws"：明文 WebSocket 网关（ws://，用于本地代理/自建网关；url 会从 wss:// 转为 ws://）
// - "webhook"：HTTP 回调模式（开放平台配置回调 URL，官方 POST 推送事件到本框架监听端口）
// 配置项：
// botId        - 框架内标识
// type         - "qq"
// mode         - 可选，连接模式，默认 "websockets"
// appId        - QQ 开放平台机器人 AppID
// botToken     - 群机器人令牌（QQ开放平台-开发设置），与 appSecret 二选一
// appSecret    - AppSecret（频道/旧版 AppSecret 模式），与 botToken 二选一
// intents      - 可选，事件订阅位，默认 GROUP_AND_C2C_EVENT | INTERACTION
// gateway      - 可选，网关地址，默认自动获取
// port / path  - webhook 模式下本地监听端口与路径（默认 8080 / "/"）
// debug        - 可选，true 时输出收发/交互/媒体的详细调试日志，默认 false
// reconnectDelay - 可选，重连延迟毫秒，默认 5000
export class QqAdapter extends BaseAdapter {
  public readonly botId: string
  private readonly cfg: Record<string, any>
  private ws?: WebSocket
  private httpServer?: http.Server
  private heartbeatTimer?: NodeJS.Timeout
  private reconnectTimer?: NodeJS.Timeout
  // 主动断开标志：disconnect 后 close 事件不再触发自动重连
  private stopped = false
  private accessToken: string = ""
  private tokenRefreshing: Promise<void> | null = null
  private intents: number = 0
  private shardCount: number = 1
  private lastSeq: number | null = null
  private sessionId: string = ""
  private shouldResume: boolean = false
  private msgSeqMap = new Map<string, number>()
  // 已回应的交互 id（防止同一 interaction_id 重复回应）
  private ackedInteractions = new Set<string>()
  // 消息缓存（get_msg API 使用）：message_id -> { event, expireAt }
  private messageCache = new Map<string, { event: BotEvent; expireAt: number }>()
  private static readonly MSG_CACHE_MAX = 1000
  private static readonly MSG_CACHE_TTL = 60 * 60 * 1000 // 缓存1小时

  constructor(config: Record<string, any>) {
    super()
    this.cfg = config
    this.botId = config.botId
    this.intents = Number(
      config.intents ??
        (QQ_INTENT.GROUP_AND_C2C_EVENT | QQ_INTENT.INTERACTION | QQ_INTENT.GROUP_MEMBER_EVENT),
    )
    QqAdapterMap.set(this.botId, this)
    registerBot(this)
  }

  // 调试日志（cfg.debug=true 时输出）
  private debug(...args: unknown[]): void {
    if (this.cfg.debug) console.log(`[${this.botId}][debug]`, ...args)
  }

  public async connect(): Promise<void> {
    this.stopped = false
    if (!this.cfg.appId) throw new Error(`[${this.botId}] 缺少 appId 配置`)
    // 机器人自身标识（appId），供接收/发送日志使用
    this.selfId = String(this.cfg.appId)
    // 1. 解析 accessToken
    this.accessToken = await this.resolveAccessToken()
    const mode = String(this.cfg.mode ?? "websockets")
    // 2. webhook 模式：不起 WS，起 HTTP 服务收事件回调
    if (mode === "webhook") {
      this.startWebhookServer()
      return
    }
    // 3. 获取网关地址与分片数
    const url = await this.resolveGateway(mode)
    // 4. 连接 WS（READY 后才置 connected）
    this.connectWs(url)
  }

  public async disconnect(): Promise<void> {
    this.stopped = true
    this.stopHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    if (this.ws) {
      this.ws.close()
      this.ws = undefined
    }
    if (this.httpServer) {
      this.httpServer.close()
      this.httpServer = undefined
    }
    this.connected = false
    console.log(`[${this.botId}] 网关连接已关闭`)
  }

  // 鉴权 / 网关

  private async resolveAccessToken(): Promise<string> {
    if (this.cfg.botToken) {
      // 群机器人：access_token = AppID.BotToken
      return `${this.cfg.appId}.${this.cfg.botToken}`
    }
    if (this.cfg.appSecret) {
      const res = await fetch(`${OPENAPI_BASE}/app/getAppAccessToken`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": DEFAULT_UA },
        body: JSON.stringify({ appId: this.cfg.appId, clientSecret: this.cfg.appSecret }),
        signal: AbortSignal.timeout(10000),
      })
      const data = (await res.json()) as QqAppTokenResp
      if (!data.access_token) {
        throw new Error(`[${this.botId}] 获取 AppAccessToken 失败: ${data.message ?? JSON.stringify(data)}`)
      }
      return data.access_token
    }
    throw new Error(`[${this.botId}] 需要配置 botToken（群机器人）或 appSecret（频道）`)
  }

  private async refreshToken(): Promise<void> {
    if (this.tokenRefreshing) return this.tokenRefreshing
    this.tokenRefreshing = (async () => {
      this.accessToken = await this.resolveAccessToken()
    })()
    try { await this.tokenRefreshing } finally { this.tokenRefreshing = null }
  }

  private isTokenExpired(data: any, status: number): boolean {
    if (status === 401) return true
    const code = Number(data?.code)
    return code === 11243 || code === 11244 || code === 11245
  }

  private authHeaders(token: string): Record<string, string> {
    return {
      Authorization: `QQBot ${token}`,
      "User-Agent": DEFAULT_UA,
      "Content-Type": "application/json; charset=utf-8",
    }
  }

  private async resolveGateway(mode: string = "websockets"): Promise<string> {
    if (this.cfg.gateway) {
      // 用户显式配置网关：mode=ws 时强制转为明文 ws://
      const g = String(this.cfg.gateway)
      return mode === "ws" ? g.replace(/^wss:\/\//, "ws://") : g
    }
    const hosts = ["https://api.bot.qq.com", "https://api.sgroup.qq.com"]
    for (const host of hosts) {
      try {
        const res = await fetch(`${host}/gateway/bot`, {
          headers: { Authorization: `QQBot ${this.accessToken}`, "User-Agent": DEFAULT_UA },
          signal: AbortSignal.timeout(8000),
        })
        const data = (await res.json()) as any
        if (data.shards && Number(data.shards) > 0) this.shardCount = Number(data.shards)
        if (data.url) {
          return mode === "ws" ? String(data.url).replace(/^wss:\/\//, "ws://") : String(data.url)
        }
      } catch {
        // 尝试下一个主机
      }
    }
    const fb = mode === "ws" ? "ws://api.sgroup.qq.com" : "wss://api.sgroup.qq.com"
    return fb
  }

  // webhook 模式：本地起 HTTP 服务接收 QQ 开放平台推送的事件回调
  private startWebhookServer(): void {
    const listenPath = String(this.cfg.path ?? "/")
    const port = Number(this.cfg.port ?? 8080)
    const secret = String(this.cfg.appSecret ?? this.cfg.botToken ?? "")
    const server = http.createServer((req, res) => {
      if (req.method !== "POST" || (listenPath !== "/" && req.url?.split("?")[0] !== listenPath)) {
        res.writeHead(404)
        res.end()
        return
      }
      let body = ""
      req.on("data", (c) => (body += c))
      req.on("end", () => {
        try {
          const payload = JSON.parse(body) as QqGatewayPayload
          // op=13：开放平台对回调地址进行验证，需按 ed25519 算法回签名
          if (payload.op === 13) {
            const { plain_token, event_ts } = payload.d ?? {}
            const signature = signWebhookValidation(secret, String(event_ts ?? ""), String(plain_token ?? ""))
            res.writeHead(200, { "Content-Type": "application/json" })
            res.end(JSON.stringify({ plain_token, signature }))
            return
          }
          this.handlePayload(payload)
        } catch (err) {
          console.error(`[${this.botId}] 解析 webhook 事件失败：`, err)
        }
        res.writeHead(204)
        res.end()
      })
    })
    server.on("error", (err) => {
      console.error(`[${this.botId}] HTTP 服务监听异常：`, err)
    })
    server.listen(port, () => {
      this.connected = true
      console.log(`✅ [${this.botId}] webhook 监听 | 端口:${port} 路径:${listenPath}（发送仍走 OpenAPI）`)
    })
    this.httpServer = server
  }

  // WebSocket

  private connectWs(url: string): void {
    const ws = new WebSocket(url, { headers: { "User-Agent": DEFAULT_UA } })
    this.ws = ws

    ws.on("open", () => {
      console.log(`✅ [${this.botId}] 网关已连接: ${url}`)
      if (this.sessionId && this.shouldResume) {
        // 恢复连接（seq 需 +1）
        this.send({ op: QQ_OP.RESUME, d: { token: `QQBot ${this.accessToken}`, session_id: this.sessionId, seq: (this.lastSeq ?? 0) + 1 } })
      } else {
        this.send({
          op: QQ_OP.IDENTIFY,
          d: { token: `QQBot ${this.accessToken}`, intents: this.intents, shard: [0, this.shardCount], properties: {} },
        })
      }
    })

    ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      let buf: Buffer
      if (Array.isArray(data)) buf = Buffer.concat(data)
      else if (Buffer.isBuffer(data)) buf = data
      else buf = Buffer.from(new Uint8Array(data as ArrayBuffer))
      try {
        const payload = JSON.parse(buf.toString("utf8")) as QqGatewayPayload
        this.handlePayload(payload)
      } catch {
        // 忽略解析失败
      }
    })

    ws.on("close", (code: number, reason: Buffer) => {
      if (this.stopped) return
      this.connected = false
      this.stopHeartbeat()
      if (code === 4014) {
        // intent 无权限：订阅了未开通或新版不支持的事件位
        console.error(`[${this.botId}] 网关关闭 code:4014 intent 无权限——intents 含未开通事件位。群/C2C=1<<25；按钮交互=1<<26；公域频道需申请后再加 1<<30；私域频道=1<<9。请按已开通范围收敛 intents`)
      } else {
        console.log(`[${this.botId}] 网关关闭 code:${code} ${reason?.toString() ?? ""}`)
      }
      this.scheduleReconnect()
    })

    ws.on("error", (err: Error) => {
      console.error(`[${this.botId}] 网关异常:`, err.message)
    })
  }

  private handlePayload(p: QqGatewayPayload): void {
    switch (p.op) {
      case QQ_OP.HELLO:
        this.startHeartbeat(p.d?.heartbeat_interval ?? 45000)
        break
      case QQ_OP.DISPATCH: {
        if (typeof p.s === "number") this.lastSeq = p.s
        const t = p.t ?? ""
        if (t === "READY") {
          this.sessionId = p.d?.session_id ?? ""
          this.connected = true
          this.shouldResume = true
          console.log(`✅ [${this.botId}] 鉴权成功, 机器人: ${p.d?.user?.username ?? ""} (${p.d?.user?.id ?? ""})`)
          return
        }
        if (t === "RESUMED") {
          this.connected = true
          console.log(`✅ [${this.botId}] 会话已恢复`)
          return
        }
        convertQqEvent(p, this.botId, String(this.cfg.appId ?? this.botId), this)
        break
      }
      case QQ_OP.HEARTBEAT_ACK:
        // 心跳回应，正常
        break
      case QQ_OP.RECONNECT:
        // 服务端要求重连：重连后走 RESUME
        this.shouldResume = true
        this.ws?.close()
        break
      case QQ_OP.INVALID_SESSION:
        // 会话失效：重连后重新 IDENTIFY
        this.shouldResume = false
        this.sessionId = ""
        this.ws?.close()
        break
    }
  }

  private send(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj))
    }
  }

  private startHeartbeat(interval: number): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.send({ op: QQ_OP.HEARTBEAT, d: this.lastSeq ?? null })
    }, interval)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((e) => console.error(`[${this.botId}] 重连失败:`, e))
    }, this.cfg.reconnectDelay ?? 5000)
  }

  // 能力集 / 消息缓存

  // 会话粒度能力：QQ 群聊支持禁言/踢出，私聊没有；
  // 富媒体/markdown/按钮/引用/表情全部原生支持。
  computeCapabilities(event: BotEvent): Readonly<Capabilities> {
    const isGroup = !!event.groupId && String(event.groupId) !== "undefined" && String(event.groupId) !== "0"
    return {
      text: true, image: true, video: true, record: true, file: true,
      markdown: true, button: true, at: true, reply: true, face: true,
      canMuteMember: isGroup,
      canKickMember: isGroup,
    }
  }

  // 缓存收到的消息（供 get_msg API 查询）
  // 同时用当前消息 ID 和引用消息 ID（reply 段的 id）作为 key 缓存
  public cacheMessage(event: BotEvent): void {
    const msgId = String((event.raw as any)?.message_id ?? "")
    if (!msgId) return
    const now = Date.now()
    // 清理过期条目
    for (const [id, item] of this.messageCache) {
      if (item.expireAt < now) this.messageCache.delete(id)
    }
    const entry = { event, expireAt: now + QqAdapter.MSG_CACHE_TTL }
    // 用当前消息 ID 缓存
    this.setCacheEntry(msgId, entry)
    // 提取引用消息 ID（reply 段的 data.id），也作为 key 缓存同一条事件
    for (const seg of event.message ?? []) {
      if (seg.type === "reply" && seg.data?.id) {
        const refId = String(seg.data.id)
        if (refId && refId !== msgId) this.setCacheEntry(refId, entry)
      }
    }
  }

  // 写入缓存条目（带上限保护）
  private setCacheEntry(key: string, entry: { event: BotEvent; expireAt: number }): void {
    if (this.messageCache.size >= QqAdapter.MSG_CACHE_MAX && !this.messageCache.has(key)) {
      const firstKey = this.messageCache.keys().next().value
      if (firstKey) this.messageCache.delete(firstKey)
    }
    this.messageCache.set(key, entry)
  }

  // 从缓存获取消息事件
  public getCachedMessage(msgId: string): BotEvent | null {
    const item = this.messageCache.get(String(msgId))
    if (!item) return null
    if (item.expireAt < Date.now()) {
      this.messageCache.delete(String(msgId))
      return null
    }
    return item.event
  }

  // 统一 OpenAPI 调用（鉴权 + 错误处理 + 查询串拼装）
  // method: HTTP 方法；apiPath: 以 / 开头的接口路径；body: 请求体；query: 查询参数
  private async openapi<T = any>(
    method: string,
    apiPath: string,
    opts: { body?: unknown; query?: Record<string, any>; timeoutMs?: number } = {},
  ): Promise<T> {
    if (!this.accessToken) throw new Error(`[${this.botId}] 尚未获取 access_token`)
    let url = `${OPENAPI_BASE}${apiPath}`
    if (opts.query) {
      const qs = Object.entries(opts.query)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&")
      if (qs) url += `?${qs}`
    }
    const doRequest = (token: string) => fetch(url, {
      method,
      headers: this.authHeaders(token),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
    })
    let res = await doRequest(this.accessToken)
    let data = (await res.json().catch(() => ({}))) as any
    if (this.isTokenExpired(data, res.status)) {
      await this.refreshToken()
      res = await doRequest(this.accessToken)
      data = (await res.json().catch(() => ({}))) as any
    }
    if (!res.ok || (data.code && Number(data.code) !== 0)) {
      throw new Error(`[${this.botId}] API ${method} ${apiPath} 失败: ${data.message ?? data.msg ?? data.errMsg ?? JSON.stringify(data)} (code:${data.code ?? res.status})`)
    }
    return data as T
  }

  // 交互回调回应：PUT /interactions/{interaction_id}，body {code}
  // 仅 type=11/12 需要；同一 id 只回应一次；不回应则客户端一直 loading 直到超时
  public async ackInteraction(interactionId: string, code: number = 0): Promise<void> {
    const id = String(interactionId ?? "")
    if (!id) throw new Error(`[${this.botId}] 交互回应缺少 interaction_id`)
    if (this.ackedInteractions.has(id)) {
      this.debug(`交互 ${id} 已回应过，跳过`)
      return
    }
    this.ackedInteractions.add(id)
    await this.openapi("PUT", `/interactions/${encodeURIComponent(id)}`, { body: { code } })
    this.debug(`交互 ${id} 已回应 code=${code}`)
  }

  public async callApi<T = any>(action: string, params: Record<string, any> = {}): Promise<T> {
    // ===== 消息发送（群 / 单聊，支持被动标识透传）=====
    if (action === "send_group_msg") {
      return this.postMessage({
        targetType: "group",
        targetOpenid: String(params.group_id ?? ""),
        message: params.message,
        passive: pickPassive(params),
      }) as unknown as Promise<T>
    }
    if (action === "send_private_msg") {
      return this.postMessage({
        targetType: "c2c",
        targetOpenid: String(params.user_id ?? ""),
        message: params.message,
        passive: pickPassive(params),
      }) as unknown as Promise<T>
    }
    if (action === "send_msg") {
      const targetType = params.group_id ? "group" : "c2c"
      return this.postMessage({
        targetType,
        targetOpenid: String(params.group_id ?? params.user_id ?? ""),
        message: params.message,
        passive: pickPassive(params),
      }) as unknown as Promise<T>
    }
    if (action === "send_channel_msg" || action === "send_guild_msg") {
      return this.postMessage({
        targetType: "channel",
        targetOpenid: String(params.channel_id ?? ""),
        message: params.message,
        passive: pickPassive(params),
      }) as unknown as Promise<T>
    }
    if (action === "send_dms_msg" || action === "send_direct_msg") {
      return this.postMessage({
        targetType: "dms",
        targetOpenid: String(params.guild_id ?? ""),
        message: params.message,
        passive: pickPassive(params),
      }) as unknown as Promise<T>
    }

    // ===== 消息撤回 =====
    if (action === "delete_msg" || action === "recall_msg") {
      return this.recallMessage(params) as unknown as Promise<T>
    }
    if (action === "recall_group_msg") {
      return this.openapi("DELETE", `/v2/groups/${enc(params.group_id)}/messages/${enc(params.message_id)}`) as unknown as Promise<T>
    }
    if (action === "recall_private_msg" || action === "recall_c2c_msg") {
      return this.openapi("DELETE", `/v2/users/${enc(params.user_id)}/messages/${enc(params.message_id)}`) as unknown as Promise<T>
    }
    if (action === "recall_channel_msg" || action === "delete_channel_msg") {
      return this.openapi("DELETE", `/channels/${enc(params.channel_id)}/messages/${enc(params.message_id)}`, {
        query: { hidetip: params.hidetip ?? false },
      }) as unknown as Promise<T>
    }
    if (action === "recall_dms_msg" || action === "delete_dms_msg") {
      return this.openapi("DELETE", `/dms/${enc(params.guild_id)}/messages/${enc(params.message_id)}`, {
        query: { hidetip: params.hidetip ?? false },
      }) as unknown as Promise<T>
    }

    // ===== 消息查询（优先缓存）=====
    if (action === "get_msg") {
      const msgId = String(params.message_id ?? params.messageId ?? "")
      if (!msgId) throw new Error(`[${this.botId}] get_msg 缺少 message_id`)
      const gid = String(params.group_id ?? "")
      const uid = String(params.user_id ?? "")
      if (gid) return this.openapi("GET", `/v2/groups/${enc(gid)}/messages/${enc(msgId)}`) as unknown as Promise<T>
      if (uid) return this.openapi("GET", `/v2/users/${enc(uid)}/messages/${enc(msgId)}`) as unknown as Promise<T>
      const event = this.getCachedMessage(msgId)
      if (!event) throw new Error(`[${this.botId}] 未找到消息: ${msgId}（可能已过期或未缓存）`)
      return event as unknown as T
    }

    // ===== 富媒体上传（返回 file_info）=====
    if (action === "upload_group_media" || action === "upload_group_file") {
      return this.uploadMedia("group", String(params.group_id ?? ""), String(params.url ?? params.file ?? ""), params.file_type ? mediaTypeFromCode(Number(params.file_type)) : "file") as unknown as Promise<T>
    }
    if (action === "upload_private_media" || action === "upload_private_file" || action === "upload_c2c_media") {
      return this.uploadMedia("c2c", String(params.user_id ?? ""), String(params.url ?? params.file ?? ""), params.file_type ? mediaTypeFromCode(Number(params.file_type)) : "file") as unknown as Promise<T>
    }

    // ===== 群成员 / 群资料 / 机器人状态 =====
    if (action === "get_group_member_list") {
      return this.openapi("GET", `/v2/groups/${enc(params.group_id)}/members`, {
        query: { cursor: params.cursor },
      }) as unknown as Promise<T>
    }
    if (action === "get_group_member_info") {
      const member = String(params.member_openid ?? params.member_id ?? params.user_id ?? "")
      return this.openapi("GET", `/v2/groups/${enc(params.group_id)}/members/${enc(member)}`) as unknown as Promise<T>
    }
    if (action === "get_group_bot_info" || action === "get_group_bot_self_info" || action === "get_group_bot_state") {
      return this.openapi("GET", `/v2/groups/${enc(params.group_id)}/bot_state`) as unknown as Promise<T>
    }
    if (action === "get_group_info") {
      return this.openapi("GET", `/v2/groups/${enc(params.group_id)}/info`) as unknown as Promise<T>
    }

    // ===== 群禁言（restrict_chat_setting）=====
    if (action === "set_group_ban" || action === "set_group_mute") {
      return this.setGroupMute(params, QQ_MUTE_OP.ADD) as unknown as Promise<T>
    }
    if (action === "update_group_ban" || action === "update_group_mute") {
      return this.setGroupMute(params, QQ_MUTE_OP.UPDATE) as unknown as Promise<T>
    }
    if (action === "unset_group_ban" || action === "unset_group_mute" || action === "delete_group_ban") {
      return this.setGroupMute(params, QQ_MUTE_OP.DEL) as unknown as Promise<T>
    }
    if (action === "get_group_ban_setting" || action === "get_group_mute_setting" || action === "get_restrict_chat_setting") {
      return this.openapi("GET", `/v2/groups/${enc(params.group_id)}/restrict_chat_setting`) as unknown as Promise<T>
    }

    // ===== 群踢人（batch_remove_members）=====
    if (action === "set_group_kick" || action === "set_group_kick_member" || action === "batch_remove_members") {
      const ids = pickMemberIds(params)
      if (!ids.length) throw new Error(`[${this.botId}] 群踢人缺少 member_openid(s)`)
      return this.openapi("POST", `/v2/groups/${enc(params.group_id)}/batch_remove_members`, {
        body: {
          member_openids: ids,
          add_to_member_blacklist: params.add_to_member_blacklist ?? params.blacklist ?? false,
        },
      }) as unknown as Promise<T>
    }

    // ===== 群黑名单 =====
    if (action === "get_group_blacklist") {
      return this.openapi("GET", `/v2/groups/${enc(params.group_id)}/member_blacklist`, {
        query: { cursor: params.cursor, limit: params.limit },
      }) as unknown as Promise<T>
    }
    if (action === "set_group_blacklist" || action === "add_group_blacklist") {
      const ids = pickMemberIds(params)
      return this.openapi("POST", `/v2/groups/${enc(params.group_id)}/member_blacklist`, {
        body: { op: QQ_MUTE_OP.ADD, member_openids: ids },
      }) as unknown as Promise<T>
    }
    if (action === "unset_group_blacklist" || action === "delete_group_blacklist") {
      const ids = pickMemberIds(params)
      return this.openapi("POST", `/v2/groups/${enc(params.group_id)}/member_blacklist`, {
        body: { op: QQ_MUTE_OP.DEL, member_openids: ids },
      }) as unknown as Promise<T>
    }

    // ===== 交互回调回应 =====
    if (action === "reply_interaction" || action === "interaction_reply" || action === "reply_action") {
      await this.ackInteraction(String(params.interaction_id ?? params.action_id ?? params.id ?? ""), Number(params.code ?? 0))
      return {} as T
    }

    // ===== 机器人自身信息 =====
    if (action === "get_self_info" || action === "get_me") {
      return this.openapi("GET", "/users/@me") as unknown as Promise<T>
    }

    // ===== 频道：Guild =====
    if (action === "get_guild_list" || action === "get_guilds") {
      return this.openapi("GET", "/users/@me/guilds", {
        query: { before: params.before, after: params.after, limit: params.limit },
      }) as unknown as Promise<T>
    }
    if (action === "get_guild") {
      return this.openapi("GET", `/guilds/${enc(params.guild_id)}`) as unknown as Promise<T>
    }

    // ===== 频道：子频道 Channel =====
    if (action === "get_channels" || action === "get_channel_list") {
      return this.openapi("GET", `/guilds/${enc(params.guild_id)}/channels`) as unknown as Promise<T>
    }
    if (action === "get_channel") {
      return this.openapi("GET", `/channels/${enc(params.channel_id)}`) as unknown as Promise<T>
    }
    if (action === "create_channel") {
      return this.openapi("POST", `/guilds/${enc(params.guild_id)}/channels`, { body: params }) as unknown as Promise<T>
    }
    if (action === "set_channel" || action === "update_channel" || action === "patch_channel") {
      return this.openapi("PATCH", `/channels/${enc(params.channel_id)}`, { body: params }) as unknown as Promise<T>
    }
    if (action === "delete_channel") {
      return this.openapi("DELETE", `/channels/${enc(params.channel_id)}`) as unknown as Promise<T>
    }
    if (action === "get_online_nums" || action === "get_channel_online_nums") {
      return this.openapi("GET", `/channels/${enc(params.channel_id)}/online_nums`) as unknown as Promise<T>
    }

    // ===== 频道：成员 Member =====
    if (action === "get_guild_member_list") {
      return this.openapi("GET", `/guilds/${enc(params.guild_id)}/members`, {
        query: { after: params.after, limit: params.limit },
      }) as unknown as Promise<T>
    }
    if (action === "get_guild_member") {
      return this.openapi("GET", `/guilds/${enc(params.guild_id)}/members/${enc(params.user_id)}`) as unknown as Promise<T>
    }
    if (action === "kick_guild_member" || action === "delete_guild_member") {
      return this.openapi("DELETE", `/guilds/${enc(params.guild_id)}/members/${enc(params.user_id)}`, {
        body: {
          add_blacklist: params.add_blacklist ?? false,
          delete_history_msg_days: params.delete_history_msg_days ?? 0,
        },
      }) as unknown as Promise<T>
    }
    if (action === "get_role_members") {
      return this.openapi("GET", `/guilds/${enc(params.guild_id)}/roles/${enc(params.role_id)}/members`, {
        query: { start_index: params.start_index, limit: params.limit },
      }) as unknown as Promise<T>
    }
    if (action === "set_guild_mute" || action === "mute_guild_member") {
      const body: Record<string, any> = {}
      if (params.mute_end_timestamp !== undefined) body.mute_end_timestamp = String(params.mute_end_timestamp)
      if (params.mute_seconds !== undefined) body.mute_seconds = String(params.mute_seconds)
      if (params.user_ids) body.user_ids = params.user_ids
      return this.openapi("PATCH", `/guilds/${enc(params.guild_id)}/mute`, { body }) as unknown as Promise<T>
    }

    // ===== 频道：身份组 Role =====
    if (action === "get_role_list" || action === "get_guild_roles") {
      return this.openapi("GET", `/guilds/${enc(params.guild_id)}/roles`) as unknown as Promise<T>
    }
    if (action === "create_role") {
      return this.openapi("POST", `/guilds/${enc(params.guild_id)}/roles`, {
        body: { filter: params.filter ?? 0, info: pickRoleInfo(params) },
      }) as unknown as Promise<T>
    }
    if (action === "set_role" || action === "update_role" || action === "patch_role") {
      return this.openapi("PATCH", `/guilds/${enc(params.guild_id)}/roles/${enc(params.role_id)}`, {
        body: { filter: params.filter ?? 0, info: pickRoleInfo(params) },
      }) as unknown as Promise<T>
    }
    if (action === "delete_role") {
      return this.openapi("DELETE", `/guilds/${enc(params.guild_id)}/roles/${enc(params.role_id)}`) as unknown as Promise<T>
    }
    if (action === "member_add_role") {
      return this.openapi("PUT", `/guilds/${enc(params.guild_id)}/members/${enc(params.user_id)}/roles/${enc(params.role_id)}`, {
        body: { channel: params.channel ? { id: params.channel } : undefined },
      }) as unknown as Promise<T>
    }
    if (action === "member_del_role") {
      return this.openapi("DELETE", `/guilds/${enc(params.guild_id)}/members/${enc(params.user_id)}/roles/${enc(params.role_id)}`, {
        body: { channel: params.channel ? { id: params.channel } : undefined },
      }) as unknown as Promise<T>
    }

    // ===== 频道：公告 Announces =====
    if (action === "create_guild_announce" || action === "post_guild_announce") {
      return this.openapi("POST", `/guilds/${enc(params.guild_id)}/announces`, { body: params }) as unknown as Promise<T>
    }
    if (action === "delete_guild_announce") {
      return this.openapi("DELETE", `/guilds/${enc(params.guild_id)}/announces/${enc(params.message_id ?? "all")}`) as unknown as Promise<T>
    }

    // ===== 频道：日程 Schedule =====
    if (action === "get_schedule_list" || action === "get_schedules") {
      return this.openapi("GET", `/channels/${enc(params.channel_id)}/schedules`, {
        query: { since: params.since },
      }) as unknown as Promise<T>
    }
    if (action === "get_schedule") {
      return this.openapi("GET", `/channels/${enc(params.channel_id)}/schedules/${enc(params.schedule_id)}`) as unknown as Promise<T>
    }
    if (action === "create_schedule") {
      return this.openapi("POST", `/channels/${enc(params.channel_id)}/schedules`, { body: { schedule: params.schedule ?? params } }) as unknown as Promise<T>
    }
    if (action === "update_schedule" || action === "patch_schedule") {
      return this.openapi("PATCH", `/channels/${enc(params.channel_id)}/schedules/${enc(params.schedule_id)}`, { body: { schedule: params.schedule ?? params } }) as unknown as Promise<T>
    }
    if (action === "delete_schedule") {
      return this.openapi("DELETE", `/channels/${enc(params.channel_id)}/schedules/${enc(params.schedule_id)}`) as unknown as Promise<T>
    }

    // ===== 频道：论坛 Forum =====
    if (action === "get_threads" || action === "get_thread_list") {
      return this.openapi("GET", `/channels/${enc(params.channel_id)}/threads`) as unknown as Promise<T>
    }
    if (action === "put_thread" || action === "create_thread" || action === "publish_thread") {
      return this.openapi("PUT", `/channels/${enc(params.channel_id)}/threads`, { body: params }) as unknown as Promise<T>
    }
    if (action === "delete_thread") {
      return this.openapi("DELETE", `/channels/${enc(params.channel_id)}/threads/${enc(params.thread_id)}`) as unknown as Promise<T>
    }

    // ===== 频道：音频 Audio =====
    if (action === "audio_control" || action === "post_audio") {
      return this.openapi("POST", `/channels/${enc(params.channel_id)}/audio`, { body: params }) as unknown as Promise<T>
    }
    if (action === "mic_up" || action === "put_mic") {
      return this.openapi("PUT", `/channels/${enc(params.channel_id)}/mic`) as unknown as Promise<T>
    }
    if (action === "mic_down" || action === "delete_mic") {
      return this.openapi("DELETE", `/channels/${enc(params.channel_id)}/mic`) as unknown as Promise<T>
    }

    // ===== 频道：私信 DMS =====
    if (action === "create_dms" || action === "create_direct_session") {
      return this.openapi("POST", "/users/@me/dms", {
        body: { recipient_id: String(params.recipient_id ?? params.user_id ?? ""), source_guild_id: String(params.source_guild_id ?? params.guild_id ?? "") },
      }) as unknown as Promise<T>
    }

    // ===== 频道：表情表态 Reaction =====
    if (action === "put_message_reaction" || action === "add_message_reaction") {
      return this.openapi("PUT", `/channels/${enc(params.channel_id)}/messages/${enc(params.message_id)}/reactions/${enc(params.type ?? 1)}/${enc(params.id ?? params.emoji_id)}`) as unknown as Promise<T>
    }
    if (action === "delete_message_reaction" || action === "remove_message_reaction") {
      return this.openapi("DELETE", `/channels/${enc(params.channel_id)}/messages/${enc(params.message_id)}/reactions/${enc(params.type ?? 1)}/${enc(params.id ?? params.emoji_id)}`) as unknown as Promise<T>
    }
    if (action === "get_reaction_users" || action === "get_message_reaction_users") {
      return this.openapi("GET", `/channels/${enc(params.channel_id)}/messages/${enc(params.message_id)}/reactions/${enc(params.type ?? 1)}/${enc(params.id ?? params.emoji_id)}`, {
        query: { cookie: params.cookie, limit: params.limit },
      }) as unknown as Promise<T>
    }

    // ===== 频道：精华消息 Pins =====
    if (action === "put_pin" || action === "add_pin" || action === "add_pinned_message") {
      return this.openapi("PUT", `/channels/${enc(params.channel_id)}/pins/${enc(params.message_id)}`) as unknown as Promise<T>
    }
    if (action === "get_pins" || action === "get_pinned_messages") {
      return this.openapi("GET", `/channels/${enc(params.channel_id)}/pins`) as unknown as Promise<T>
    }
    if (action === "delete_pin" || action === "remove_pin" || action === "remove_pinned_message") {
      return this.openapi("DELETE", `/channels/${enc(params.channel_id)}/pins/${enc(params.message_id ?? "all")}`) as unknown as Promise<T>
    }

    // ===== 频道：权限 =====
    if (action === "get_api_permission" || action === "get_guild_api_permission") {
      return this.openapi("GET", `/guilds/${enc(params.guild_id)}/api_permission`) as unknown as Promise<T>
    }
    if (action === "get_channel_member_permissions") {
      return this.openapi("GET", `/channels/${enc(params.channel_id)}/members/${enc(params.user_id)}/permissions`) as unknown as Promise<T>
    }
    if (action === "set_channel_member_permissions") {
      return this.openapi("PUT", `/channels/${enc(params.channel_id)}/members/${enc(params.user_id)}/permissions`, {
        body: { add: params.add, remove: params.remove },
      }) as unknown as Promise<T>
    }
    if (action === "get_channel_role_permissions") {
      return this.openapi("GET", `/channels/${enc(params.channel_id)}/roles/${enc(params.role_id)}/permissions`) as unknown as Promise<T>
    }
    if (action === "set_channel_role_permissions") {
      return this.openapi("PUT", `/channels/${enc(params.channel_id)}/roles/${enc(params.role_id)}/permissions`, {
        body: { add: params.add, remove: params.remove },
      }) as unknown as Promise<T>
    }

    throw new Error(`[${this.botId}] 不支持的 API 操作: ${action}`)
  }

  // 群成员禁言 / 解禁（POST restrict_chat_setting）
  private async setGroupMute(params: Record<string, any>, op: string): Promise<unknown> {
    const groupOpenid = String(params.group_id ?? "")
    const targets = pickMemberIds(params)
    if (!targets.length) throw new Error(`[${this.botId}] 群禁言缺少 member_openid(s)`)
    const members = targets.map((memberOpenid) => {
      const item: Record<string, any> = { op, member_openid: memberOpenid }
      if (op !== QQ_MUTE_OP.DEL) {
        // duration/mute_seconds → 到期 RFC3339；最大 30 天
        const seconds = Number(params.duration ?? params.mute_seconds ?? params.seconds ?? 600)
        item.mute_expire_at = new Date(Date.now() + seconds * 1000).toISOString()
      } else {
        item.mute_expire_at = ""
      }
      return item
    })
    return this.openapi("POST", `/v2/groups/${enc(groupOpenid)}/restrict_chat_setting`, { body: { members } })
  }

  // 撤回消息（自动按群 / 单聊 / 频道选择路径）
  private async recallMessage(params: Record<string, any>): Promise<unknown> {
    const msgId = String(params.message_id ?? params.messageId ?? "")
    if (!msgId) throw new Error(`[${this.botId}] delete_msg 缺少 message_id`)
    const gid = String(params.group_id ?? "")
    const uid = String(params.user_id ?? "")
    const cid = String(params.channel_id ?? "")
    if (cid) {
      return this.openapi("DELETE", `/channels/${enc(cid)}/messages/${enc(msgId)}`, { query: { hidetip: params.hidetip ?? false } })
    }
    if (gid) return this.openapi("DELETE", `/v2/groups/${enc(gid)}/messages/${enc(msgId)}`)
    if (uid) return this.openapi("DELETE", `/v2/users/${enc(uid)}/messages/${enc(msgId)}`)
    throw new Error(`[${this.botId}] delete_msg 需要 group_id / user_id / channel_id`)
  }

  // 以「回复事件」方式发送：自动注入被动标识
  // - 消息事件：用 msg_id（缺失则主动发送，不回退 event_id，避免 event_id 无效）
  // - 通知/交互事件：用 event_id（INTERACTION_CREATE / GROUP_ADD_ROBOT / GROUP_MSG_RECEIVE 等官方支持的事件）
  public async reply(event: BotEvent, chain: MessageChain | string): Promise<unknown> {
    const raw = event.raw as any
    const target = resolveEventTarget(event)
    const passive: { msgId?: string; eventId?: string } = {}
    if (raw.message_id) {
      passive.msgId = String(raw.message_id)
    } else if (event.postType === "notice" && raw.event_id) {
      passive.eventId = String(raw.event_id)
    }
    return this.postMessage({ ...target, message: chain, passive })
  }

  // 发送 QQ 消息（群 / 单聊 / 频道 / 频道私信），主动或被动
  private async postMessage(args: {
    targetType: "group" | "c2c" | "channel" | "dms"
    targetOpenid: string
    message: MessageChain | string
    passive?: { msgId?: string; eventId?: string }
  }): Promise<QqSendResp> {
    const { targetType, targetOpenid } = args
    if (!targetOpenid) throw new Error(`[${this.botId}] 缺少目标 openid`)
    if (!this.accessToken) throw new Error(`[${this.botId}] 尚未获取 access_token`)

    const message = args.message
    const segments = normalizeSegments(message)
    const text = segmentsToQqText(segments)
    const mdContent = this.extractMarkdownContent(message)
    const mdButtons = this.extractMarkdownButtons(message)
    const keyboard = this.buildKeyboard(segments, mdButtons)
    const arkObject = this.extractArkObject(segments)
    const embedObject = this.extractEmbedObject(segments)
    const mediaSeg = segments.find((s) => ["image", "video", "record", "file"].includes(s.type))

    let endpoint = ""
    if (targetType === "group") endpoint = `/v2/groups/${targetOpenid}/messages`
    else if (targetType === "c2c") endpoint = `/v2/users/${targetOpenid}/messages`
    else if (targetType === "channel") endpoint = `/channels/${targetOpenid}/messages`
    else endpoint = `/dms/${targetOpenid}/messages`

    const isV2 = targetType === "group" || targetType === "c2c"
    const passive = args.passive ?? {}

    // 群 / 单聊：以 msg_type 区分消息类型
    if (isV2) {
      const body: Record<string, any> = { msg_seq: this.nextMsgSeq(`${targetType}:${targetOpenid}`) }
      if (passive.msgId) body.msg_id = passive.msgId
      if (passive.eventId) body.event_id = passive.eventId

      if (mdContent) {
        body.content = ""
        body.msg_type = 2
        body.markdown = { content: mdContent }
        if (keyboard) body.keyboard = keyboard
      } else if (arkObject) {
        body.content = ""
        body.msg_type = 3
        body.ark = arkObject
      } else if (embedObject) {
        body.content = ""
        body.msg_type = 4
        body.embed = embedObject
      } else {
        let fileInfo = ""
        if (mediaSeg) {
          const source = String(mediaSeg.data?.url ?? mediaSeg.data?.file ?? "")
          fileInfo = await this.uploadMedia(targetType, targetOpenid, source, mediaSeg.type)
        }
        body.msg_type = fileInfo ? 7 : 0
        if (fileInfo) body.media = { file_info: fileInfo }
        // content 必填；无文本时用占位兜底
        body.content = text || (mediaSeg ? this.mediaPlaceholder(mediaSeg) : "")
        if (keyboard && !fileInfo) body.keyboard = keyboard
      }

      const data = await this.openapi<QqSendResp>("POST", endpoint, { body })
      const sentId = String(data.id ?? "")
      this.cacheSentMessage(targetType, targetOpenid, message, sentId)
      return { id: sentId, message_id: sentId }
    }

    // 频道 / 频道私信：以对象字段区分内容类型
    const body: Record<string, any> = {}
    if (passive.msgId) body.msg_id = passive.msgId
    if (passive.eventId) body.event_id = passive.eventId

    if (mdContent) {
      body.markdown = { content: mdContent }
      if (keyboard) body.keyboard = keyboard
    } else if (arkObject) {
      body.ark = arkObject
    } else if (embedObject) {
      body.embed = embedObject
    } else {
      if (text) body.content = text
      // 频道图片：image 字段传 url（平台转存）；本地/其他媒体需 multipart，暂以 url 支持
      if (mediaSeg && mediaSeg.type === "image") {
        const imgUrl = String(mediaSeg.data?.url ?? mediaSeg.data?.file ?? "")
        if (/^https?:\/\//.test(imgUrl)) body.image = imgUrl
      }
      if (keyboard) body.keyboard = keyboard
    }

    const data = await this.openapi<QqSendResp>("POST", endpoint, { body })
    const sentId = String(data.id ?? "")
    this.cacheSentMessage(targetType, targetOpenid, message, sentId)
    return { id: sentId, message_id: sentId }
  }

  // 富媒体占位文本（content 必填时兜底）
  private mediaPlaceholder(seg: { type: string }): string {
    switch (seg.type) {
      case "image": return "[图片]"
      case "video": return "[视频]"
      case "record": return "[语音]"
      default: return "[文件]"
    }
  }

  // 缓存机器人发送的消息（供 get_msg API 查询）
  private cacheSentMessage(
    targetType: "group" | "c2c" | "channel" | "dms",
    targetOpenid: string,
    message: MessageChain | string,
    msgId: string
  ): void {
    if (!msgId) return
    const segments = normalizeSegments(message)
    const isPrivate = targetType === "c2c"
    const event: BotEvent = {
      botId: this.botId,
      selfId: this.selfId,
      userId: isPrivate ? targetOpenid : "",
      groupId: isPrivate ? undefined : targetOpenid,
      message: segments,
      postType: isPrivate ? "private_message" : "group_message",
      raw: {
        message_id: msgId,
        sender: { user_id: this.selfId, nickname: "bot", is_bot: true },
        time: Math.floor(Date.now() / 1000),
        platform: "qq-official",
      },
    }
    this.cacheMessage(event)
  }

  // 从段数组提取 ark 对象：ark 段直接取 data；json 段解析 data.data
  private extractArkObject(segments: Array<{ type: string; data: Record<string, any> }>): Record<string, any> | null {
    const arkSeg = segments.find((s) => s.type === "ark")
    if (arkSeg) return arkSeg.data
    const jsonSeg = segments.find((s) => s.type === "json")
    if (jsonSeg?.data?.data) {
      try { return JSON.parse(String(jsonSeg.data.data)) } catch { return null }
    }
    return null
  }

  // 从段数组提取 embed 对象
  private extractEmbedObject(segments: Array<{ type: string; data: Record<string, any> }>): Record<string, any> | null {
    const seg = segments.find((s) => s.type === "embed")
    return seg ? seg.data : null
  }

  // 从消息段/按钮段构建 QQ keyboard
  // 按钮来源两处（可合并）：
  // 1. mdButtons：markdown 的 data.buttons 数组
  // 2. button 段：MessageSegment.button({...})
  // action.type：0 跳转（url/scheme）、1 回调（INTERACTION_CREATE 回传 data）、2 指令
  // 限制：最多 5 行，每行最多 5 个
  private buildKeyboard(
    segments: Array<{ type: string; data: Record<string, any> }>,
    mdButtons: Array<Record<string, any>> = []
  ): Record<string, any> | null {
    const list: Array<Record<string, any>> = [...mdButtons]
    for (const seg of segments) {
      if (seg.type === "button") list.push(seg.data ?? {})
    }
    if (!list.length) return null

    // 每行按钮：优先按 row/group 分组，否则每行最多 5 个
    const rows: Array<{ buttons: any[] }> = []
    let cur: any[] = []
    let curRow: string | number | undefined

    const flush = () => {
      if (cur.length) {
        rows.push({ buttons: cur })
        cur = []
      }
    }

    for (const raw of list) {
      const label = String(raw.text ?? raw.label ?? "")
      if (!label) continue
      const rowKey = raw.row ?? raw.group
      if (rowKey !== undefined && rowKey !== curRow) {
        flush()
        curRow = rowKey
      } else if (rowKey === undefined && cur.length >= 5) {
        flush()
      }

      const url = String(raw.url ?? "")
      const explicitType = raw.action_type ?? raw.atype ?? raw.type
      // 动作类型：显式指定优先；有 url/scheme 且无回调 → 跳转；否则回调
      let actionType: number
      if (explicitType !== undefined && !isNaN(Number(explicitType))) actionType = Number(explicitType)
      else actionType = url && !raw.callback ? QQ_BUTTON_ACTION.URL : QQ_BUTTON_ACTION.CALLBACK

      const id = String(raw.id ?? raw.callback ?? label).slice(0, 32)
      const permType = Number(raw.permission?.type ?? raw.permission_type ?? QQ_PERMISSION_TYPE.ALL)
      const button: Record<string, any> = {
        id,
        render_data: {
          label,
          visited_label: String(raw.visited ?? raw.visited_label ?? label),
          style: Number(raw.style ?? QQ_BUTTON_STYLE.GRAY),
        },
        action: {
          type: actionType,
          permission: raw.permission ?? {
            type: permType,
            specify_user_ids: raw.specify_user_ids,
            specify_role_ids: raw.specify_role_ids,
          },
          unsupport_tips: String(raw.unsupport_tips ?? "请升级客户端后查看"),
          data:
            actionType === QQ_BUTTON_ACTION.URL ? url :
            actionType === QQ_BUTTON_ACTION.COMMAND ? String(raw.command ?? raw.data ?? raw.callback ?? id) :
            String(raw.callback ?? raw.data ?? id),
          reply: raw.reply ?? false,
          enter: raw.enter ?? false,
        },
      }
      if (raw.group_id) button.action.group_id = String(raw.group_id)
      if (raw.modal) button.action.modal = raw.modal
      cur.push(button)
    }
    flush()
    if (!rows.length) return null
    // 行数 / 每行个数上限保护
    return { content: { rows: rows.slice(0, 5).map((r) => ({ buttons: r.buttons.slice(0, 5) })) } }
  }

  // 从 message（字符串或段数组）中提取 markdown 内容
  // 支持：[CQ:markdown,data={"content":"..."}] 字符串；{ type:"markdown", data:{content} } 段
  private extractMarkdownContent(message: MessageChain | string): string {
    if (typeof message === "string") {
      const m = message.match(/^\[CQ:markdown,data=([\s\S]*?)\]$/)
      if (m) {
        try {
          const parsed = JSON.parse(m[1])
          return String(parsed.content ?? parsed.prompt ?? "")
        } catch {
          return String(m[1])
        }
      }
      return ""
    }
    const mdSeg = message.find((s) => (s as any).type === "markdown")
    if (mdSeg) return String((mdSeg as any).data?.content ?? (mdSeg as any).data?.text ?? "")
    return ""
  }

  // 从 message 中提取按钮列表
  // 来源：markdown data.buttons；button 段由 buildKeyboard 收集
  // 返回统一按钮描述数组
  private extractMarkdownButtons(message: MessageChain | string): Array<Record<string, any>> {
    let parsedData: Record<string, any> | null = null
    if (typeof message === "string") {
      const m = message.match(/^\[CQ:markdown,data=([\s\S]*?)\]$/)
      if (m) {
        try {
          parsedData = JSON.parse(m[1]) as Record<string, any>
        } catch {
          return []
        }
      }
    } else {
      const mdSeg = message.find((s) => (s as any).type === "markdown")
      if (mdSeg) parsedData = (mdSeg as any).data ?? {}
    }
    if (!parsedData || !Array.isArray(parsedData.buttons)) return []
    return parsedData.buttons.filter((b: any) => b && (b.text || b.label))
  }

  // 上传媒体资源，返回 file_info 供发送用
  // @param source http(s) url / base64://... / 本地文件路径
  // @param segType 媒体段类型（image/video/record/file）→ 对应 file_type
  // file_type: 1 图片 / 2 视频 / 3 语音 / 4 文件
  private async uploadMedia(
    targetType: "group" | "c2c" | "channel" | "dms",
    targetOpenid: string,
    source: string,
    segType: string = "image"
  ): Promise<string> {
    if (!source) return ""
    let uploadEndpoint = ""
    if (targetType === "group") uploadEndpoint = `/v2/groups/${targetOpenid}/files`
    else if (targetType === "c2c") uploadEndpoint = `/v2/users/${targetOpenid}/files`
    else return ""

    const fileType =
      segType === "video" ? QQ_FILE_TYPE.VIDEO :
      segType === "record" ? QQ_FILE_TYPE.VOICE :
      segType === "file" ? QQ_FILE_TYPE.FILE :
      QQ_FILE_TYPE.IMAGE

    const HARD_LIMIT = 200 * 1024 * 1024
    const CHUNK_THRESHOLD = 5 * 1024 * 1024

    let fileName = "file"
    if (/^https?:\/\//.test(source)) {
      try { fileName = decodeURIComponent(source.split("/").pop()?.split("?")[0] || "file") } catch {}
    } else if (fs.existsSync(source)) {
      fileName = path.basename(source)
    }

    // 本地大文件走分片上传
    if (fs.existsSync(source)) {
      const stat = fs.statSync(source)
      if (stat.size > HARD_LIMIT) {
        console.error(`[${this.botId}] 文件过大(${Math.round(stat.size / 1024 / 1024)}MB)，QQ 硬限 200MB`)
        return ""
      }
      if (stat.size > CHUNK_THRESHOLD) {
        return this.uploadChunked(targetType, targetOpenid, source, fileName, fileType, stat.size)
      }
    }

    const body: Record<string, any> = { file_type: fileType, srv_send_msg: false, file_name: fileName }
    if (/^https?:\/\//.test(source)) {
      body.url = source
    } else if (source.startsWith("base64://")) {
      body.file_data = source.slice("base64://".length)
    } else if (fs.existsSync(source)) {
      body.file_data = fs.readFileSync(source).toString("base64")
    } else {
      return ""
    }

    try {
      this.debug("上传媒体:", uploadEndpoint, "file_type:", fileType, "file_name:", fileName)
      const data = await this.openapi<{ file_info?: string }>("POST", uploadEndpoint, { body, timeoutMs: 30000 })
      return data.file_info ?? ""
    } catch (e: any) {
      console.error(`[${this.botId}] 上传媒体失败: ${e?.message ?? e}，改发纯文本`)
      return ""
    }
  }

  // 大文件分片上传（>5MB 自动触发）
  private async uploadChunked(
    targetType: "group" | "c2c",
    targetOpenid: string,
    filePath: string,
    fileName: string,
    fileType: number,
    fileSize: number,
  ): Promise<string> {
    const scope = targetType === "c2c" ? "users" : "groups"
    const preparePath = `/v2/${scope}/${targetOpenid}/upload_prepare`
    const partFinishPath = `/v2/${scope}/${targetOpenid}/upload_part_finish`
    const completePath = `/v2/${scope}/${targetOpenid}/files`
    const MD5_10M_SIZE = 10002432

    console.log(`[${this.botId}] 分片上传: ${fileName} (${(fileSize / 1024 / 1024).toFixed(2)}MB)`)

    // 计算 md5 / sha1 / md5_10m
    const md5 = crypto.createHash("md5")
    const sha1 = crypto.createHash("sha1")
    const md5_10m = crypto.createHash("md5")
    let consumed = 0
    const needsMd5_10m = fileSize > MD5_10M_SIZE
    const fd = fs.openSync(filePath, "r")
    const buf = Buffer.alloc(64 * 1024)
    try {
      while (true) {
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, null)
        if (bytesRead === 0) break
        const chunk = bytesRead < buf.length ? buf.subarray(0, bytesRead) : buf
        md5.update(chunk)
        sha1.update(chunk)
        if (needsMd5_10m) {
          const remaining = MD5_10M_SIZE - consumed
          if (remaining > 0) md5_10m.update(remaining >= chunk.length ? chunk : chunk.subarray(0, remaining))
        }
        consumed += bytesRead
      }
    } finally {
      fs.closeSync(fd)
    }
    const md5Hex = md5.digest("hex")
    const sha1Hex = sha1.digest("hex")
    const md5_10m_Hex = needsMd5_10m ? md5_10m.digest("hex") : md5Hex

    // 1. upload_prepare
    const prepare = await this.openapi<{
      upload_id: string
      block_size: number
      parts: { index: number; presigned_url: string }[]
      concurrency?: number
    }>("POST", preparePath, {
      body: { file_type: fileType, file_name: fileName, file_size: fileSize, md5: md5Hex, sha1: sha1Hex, md5_10m: md5_10m_Hex },
      timeoutMs: 30000,
    })
    const { upload_id, block_size, parts } = prepare
    const maxConcurrent = Math.min(prepare.concurrency ?? 1, 10)
    console.log(`[${this.botId}] 分片上传准备完成: ${parts.length} 片, 每片 ${(block_size / 1024 / 1024).toFixed(1)}MB, 并发 ${maxConcurrent}`)

    // 2. 逐片上传
    const fd2 = fs.openSync(filePath, "r")
    try {
      let done = 0
      const uploadPart = async (part: { index: number; presigned_url: string }) => {
        const offset = (part.index - 1) * block_size
        const length = Math.min(block_size, fileSize - offset)
        const partBuf = Buffer.alloc(length)
        fs.readSync(fd2, partBuf, 0, length, offset)
        const partMd5 = crypto.createHash("md5").update(partBuf).digest("hex")

        // PUT 到 COS 预签名 URL
        await fetch(part.presigned_url, { method: "PUT", body: partBuf, headers: { "Content-Length": String(length) } })

        // 通知分片完成
        await this.openapi("POST", partFinishPath, {
          body: { upload_id, part_index: part.index, block_size: length, md5: partMd5 },
          timeoutMs: 30000,
        })
        done++
        console.log(`[${this.botId}] 分片上传进度: ${done}/${parts.length}`)
      }

      // 并发控制
      for (let i = 0; i < parts.length; i += maxConcurrent) {
        const batch = parts.slice(i, i + maxConcurrent)
        await Promise.all(batch.map(p => uploadPart(p)))
      }
    } finally {
      fs.closeSync(fd2)
    }

    // 3. complete_upload
    const result = await this.openapi<{ file_info?: string; file_uuid?: string }>("POST", completePath, {
      body: { upload_id },
      timeoutMs: 30000,
    })
    console.log(`[${this.botId}] 分片上传完成: ${fileName}`)
    return result.file_info ?? ""
  }

  // 每个会话的 msg_seq 单调递增
  private nextMsgSeq(target: string): number {
    const next = (this.msgSeqMap.get(target) ?? 0) + 1
    this.msgSeqMap.set(target, next)
    return next
  }

  public async destroy(): Promise<void> {
    await this.disconnect()
    QqAdapterMap.delete(this.botId)
    await super.destroy()
  }
}

export function getQqAdapterById(botId: string): QqAdapter | undefined {
  return QqAdapterMap.get(botId)
}

// ===== 模块内工具函数 =====

function enc(v: unknown): string {
  return encodeURIComponent(String(v ?? ""))
}

// 提取被动回复标识（msg_id / event_id）
function pickPassive(p: Record<string, any>): { msgId?: string; eventId?: string } {
  const out: { msgId?: string; eventId?: string } = {}
  if (p.msg_id) out.msgId = String(p.msg_id)
  if (p.event_id) out.eventId = String(p.event_id)
  return out
}

// 提取成员 openid 列表（兼容单个 member_openid/member_id/user_id 与数组 member_openids）
function pickMemberIds(p: Record<string, any>): string[] {
  if (Array.isArray(p.member_openids)) return p.member_openids.map(String).filter(Boolean)
  const single = String(p.member_openid ?? p.member_id ?? p.user_id ?? "")
  return single ? [single] : []
}

// 身份组 info（name/color/hoist）
function pickRoleInfo(p: Record<string, any>): Record<string, any> {
  const info: Record<string, any> = {}
  if (p.name !== undefined) info.name = p.name
  if (p.color !== undefined) info.color = Number(p.color)
  if (p.hoist !== undefined) info.hoist = Number(p.hoist)
  return info
}

// file_type code → 媒体段类型
function mediaTypeFromCode(code: number): string {
  if (code === QQ_FILE_TYPE.VIDEO) return "video"
  if (code === QQ_FILE_TYPE.VOICE) return "record"
  if (code === QQ_FILE_TYPE.FILE) return "file"
  return "image"
}

// 从事件解析发送目标（群 / 单聊 / 频道）
function resolveEventTarget(event: BotEvent): {
  targetType: "group" | "c2c" | "channel"
  targetOpenid: string
} {
  const raw = event.raw as any
  const chatType = Number(raw.chat_type)
  if (chatType === 2) return { targetType: "c2c", targetOpenid: String(event.userId) }
  if (chatType === 0) return { targetType: "channel", targetOpenid: String(event.groupId) }
  if (chatType === 1) return { targetType: "group", targetOpenid: String(event.groupId) }
  if (event.groupId) return { targetType: "group", targetOpenid: String(event.groupId) }
  return { targetType: "c2c", targetOpenid: String(event.userId) }
}

// webhook 回调地址验证签名（ed25519）：
// 以 secret 重复填充至 32 字节作为种子生成 ed25519 私钥，对 event_ts+plain_token 签名
function signWebhookValidation(secret: string, eventTs: string, plainToken: string): string {
  let seed = secret
  while (seed.length < 32) seed += seed
  const seedBuf = Buffer.from(seed.slice(0, 32), "utf8")
  // ed25519 PKCS8 DER 固定前缀（含 0420 OCTET STRING 标记）
  const derPrefix = Buffer.from("302e020100300506032b657004220420", "hex")
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([derPrefix, seedBuf]),
    format: "der",
    type: "pkcs8",
  })
  return crypto.sign(null, Buffer.from(`${eventTs}${plainToken}`, "utf8"), privateKey).toString("hex")
}
