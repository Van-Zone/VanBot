import WebSocket from "ws"
import http from "http"
import { BaseAdapter } from "../base.js"
import { convertQqEvent, segmentsToQqText } from "./converter.js"
import type { QqAppTokenResp, QqGatewayPayload, QqSendResp } from "./types.js"
import { QQ_OP, QQ_INTENT } from "./types.js"
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
// 3. 按 HELLO 下发的心跳周期发送心跳；断线后重连并发送 RESUME 恢复会话（seq 需 +1）
// 4. 收到 DISPATCH 事件：群@消息/单聊/频道消息 → 转统一事件派发给插件
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
// intents      - 可选，事件订阅位，默认 GROUP_AND_C2C_EVENT | GUILD_MESSAGES | PUBLIC_GUILD_MESSAGES
// gateway      - 可选，网关地址，默认自动获取
// port / path  - webhook 模式下本地监听端口与路径（默认 8080 / "/"）
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
  private intents: number = 0
  private shardCount: number = 1
  private lastSeq: number | null = null
  private sessionId: string = ""
  private shouldResume: boolean = false
  private msgSeqMap = new Map<string, number>()
  // 消息缓存（get_msg API 使用）：message_id -> { event, expireAt }
  private messageCache = new Map<string, { event: BotEvent; expireAt: number }>()
  private static readonly MSG_CACHE_MAX = 1000
  private static readonly MSG_CACHE_TTL = 60 * 60 * 1000 // 缓存1小时

  constructor(config: Record<string, any>) {
    super()
    this.cfg = config
    this.botId = config.botId
    this.intents = Number(config.intents ?? (QQ_INTENT.GROUP_AND_C2C_EVENT | QQ_INTENT.GUILD_MESSAGES | QQ_INTENT.PUBLIC_GUILD_MESSAGES))
    QqAdapterMap.set(this.botId, this)
    registerBot(this)
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
    const path = this.cfg.path ?? "/"
    const port = this.cfg.port ?? 8080
    const server = http.createServer((req, res) => {
      if (req.method === "POST" && (path === "/" || req.url === path)) {
        let body = ""
        req.on("data", (c) => (body += c))
        req.on("end", () => {
          try {
            const payload = JSON.parse(body) as QqGatewayPayload
            this.handlePayload(payload)
          } catch (err) {
            console.error(`[${this.botId}] 解析 webhook 事件失败：`, err)
          }
          res.writeHead(204)
          res.end()
        })
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    server.on("error", (err) => {
      console.error(`[${this.botId}] HTTP 服务监听异常：`, err)
    })
    server.listen(port, () => {
      this.connected = true
      console.log(`✅ [${this.botId}] webhook 监听 | 端口:${port} 路径:${path}（发送仍走 OpenAPI）`)
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

    ws.on("message", (data) => {
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

    ws.on("close", (code, reason) => {
      if (this.stopped) return
      this.connected = false
      this.stopHeartbeat()
      if (code === 4014) {
        // intent 无权限：订阅了未开通或新版不支持的事件位
        console.error(`[${this.botId}] 网关关闭 code:4014 intent 无权限——intents 含未开通或新版不支持的事件位（如旧版频道意图 1<<9/1<<12）。只保留已开通事件：群/C2C=1<<25；公域频道需开放平台申请后再加 1<<30`) 
      } else {
        console.log(`[${this.botId}] 网关关闭 code:${code} ${reason?.toString() ?? ""}`)
      }
      this.scheduleReconnect()
    })

    ws.on("error", (err) => {
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
          console.log(`✅ [${this.botId}] 鉴权成功，机器人: ${p.d?.user?.username ?? ""} (${p.d?.user?.id ?? ""})`)
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

  // API / 发送

  // 调用 QQ 官方 API
  // 支持的 action：
  // - send_group_msg   : 发送群消息（params: { group_id=群openid, message }）
  // - send_private_msg : 发送单聊消息（params: { user_id=用户openid, message }）
  // - send_msg         : 自动判断（有 group_id 走群，否则走单聊）
  // message 支持字符串或消息段数组（text/image；image 支持 url 或 base64://）
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

  // 调用 QQ 官方 v2 OpenAPI（统一鉴权 + 错误处理）
  // method: HTTP 方法；path: 以 / 开头的路径（自动拼 base 与 access_token 鉴权）
  private async v2Request(method: string, path: string, body?: unknown, timeoutMs = 15000): Promise<any> {
    if (!this.accessToken) throw new Error(`[${this.botId}] 尚未获取 access_token`)
    const res = await fetch(`${OPENAPI_BASE}${path}`, {
      method,
      headers: {
        Authorization: `QQBot ${this.accessToken}`,
        "User-Agent": DEFAULT_UA,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const data = (await res.json().catch(() => ({}))) as any
    if (!res.ok || (data.code && data.code !== 0)) {
      throw new Error(`[${this.botId}] API ${method} ${path} 失败: ${data.message ?? data.msg ?? data.errMsg ?? JSON.stringify(data)} (code:${data.code ?? res.status})`)
    }
    return data
  }

  public async callApi<T = any>(action: string, params: Record<string, any> = {}): Promise<T> {
    // ===== 消息发送 =====
    if (action === "send_group_msg") {
      return this.sendQqMessage("group", String(params.group_id ?? ""), params.message) as unknown as Promise<T>
    }
    if (action === "send_private_msg") {
      return this.sendQqMessage("c2c", String(params.user_id ?? ""), params.message) as unknown as Promise<T>
    }
    if (action === "send_msg") {
      if (params.group_id) {
        return this.sendQqMessage("group", String(params.group_id), params.message) as unknown as Promise<T>
      }
      return this.sendQqMessage("c2c", String(params.user_id ?? ""), params.message) as unknown as Promise<T>
    }

    // ===== 消息撤回 / 查询 =====
    if (action === "delete_msg" || action === "recall_msg") {
      const msgId = String(params.message_id ?? params.messageId ?? "")
      if (!msgId) throw new Error(`[${this.botId}] delete_msg 缺少 message_id`)
      const gid = String(params.group_id ?? "")
      const uid = String(params.user_id ?? "")
      if (gid) return this.v2Request("DELETE", `/v2/groups/${encodeURIComponent(gid)}/messages/${encodeURIComponent(msgId)}`) as unknown as Promise<T>
      if (uid) return this.v2Request("DELETE", `/v2/users/${encodeURIComponent(uid)}/messages/${encodeURIComponent(msgId)}`) as unknown as Promise<T>
      throw new Error(`[${this.botId}] delete_msg 需要 group_id 或 user_id`)
    }
    if (action === "recall_group_msg") {
      return this.v2Request("DELETE", `/v2/groups/${encodeURIComponent(String(params.group_id ?? ""))}/messages/${encodeURIComponent(String(params.message_id ?? ""))}`) as unknown as Promise<T>
    }
    if (action === "recall_private_msg") {
      return this.v2Request("DELETE", `/v2/users/${encodeURIComponent(String(params.user_id ?? ""))}/messages/${encodeURIComponent(String(params.message_id ?? ""))}`) as unknown as Promise<T>
    }
    if (action === "get_msg") {
      const msgId = String(params.message_id ?? params.messageId ?? "")
      if (!msgId) throw new Error(`[${this.botId}] get_msg 缺少 message_id`)
      const gid = String(params.group_id ?? "")
      const uid = String(params.user_id ?? "")
      if (gid) return this.v2Request("GET", `/v2/groups/${encodeURIComponent(gid)}/messages/${encodeURIComponent(msgId)}`) as unknown as Promise<T>
      if (uid) return this.v2Request("GET", `/v2/users/${encodeURIComponent(uid)}/messages/${encodeURIComponent(msgId)}`) as unknown as Promise<T>
      const event = this.getCachedMessage(msgId)
      if (!event) throw new Error(`[${this.botId}] 未找到消息: ${msgId}（可能已过期或未缓存）`)
      return event as unknown as T
    }
    if (action === "get_group_msg" || action === "get_group_message") {
      return this.v2Request("GET", `/v2/groups/${encodeURIComponent(String(params.group_id ?? ""))}/messages/${encodeURIComponent(String(params.message_id ?? ""))}`) as unknown as Promise<T>
    }
    if (action === "get_private_msg" || action === "get_c2c_msg") {
      return this.v2Request("GET", `/v2/users/${encodeURIComponent(String(params.user_id ?? ""))}/messages/${encodeURIComponent(String(params.message_id ?? ""))}`) as unknown as Promise<T>
    }
    if (action === "get_group_msg_list" || action === "get_group_messages") {
      return this.v2Request("GET", `/v2/groups/${encodeURIComponent(String(params.group_id ?? ""))}/messages`) as unknown as Promise<T>
    }

    // ===== 富媒体文件 =====
    if (action === "upload_group_file") {
      return this.v2Request("POST", `/v2/groups/${encodeURIComponent(String(params.group_id ?? ""))}/files`, {
        file_type: Number(params.file_type ?? 1),
        url: params.url,
        file_data: params.file_data,
      }) as unknown as Promise<T>
    }
    if (action === "upload_private_file") {
      return this.v2Request("POST", `/v2/users/${encodeURIComponent(String(params.user_id ?? ""))}/files`, {
        file_type: Number(params.file_type ?? 1),
        url: params.url,
        file_data: params.file_data,
      }) as unknown as Promise<T>
    }
    if (action === "get_group_file_info") {
      return this.v2Request("GET", `/v2/groups/${encodeURIComponent(String(params.group_id ?? ""))}/files/${encodeURIComponent(String(params.file_info ?? ""))}`) as unknown as Promise<T>
    }
    if (action === "get_private_file_info") {
      return this.v2Request("GET", `/v2/users/${encodeURIComponent(String(params.user_id ?? ""))}/files/${encodeURIComponent(String(params.file_info ?? ""))}`) as unknown as Promise<T>
    }

    // ===== 表情表态 =====
    if (action === "set_msg_emoji_like" || action === "set_message_reaction") {
      const msgId = String(params.message_id ?? params.messageId ?? "")
      if (!msgId) throw new Error(`[${this.botId}] 表情表态缺少 message_id`)
      const gid = String(params.group_id ?? "")
      const uid = String(params.user_id ?? "")
      const body = { emoji_type: Number(params.emoji_type ?? params.emojiType ?? 1) }
      if (gid) return this.v2Request("POST", `/v2/groups/${encodeURIComponent(gid)}/messages/${encodeURIComponent(msgId)}/reaction`, body) as unknown as Promise<T>
      if (uid) return this.v2Request("POST", `/v2/users/${encodeURIComponent(uid)}/messages/${encodeURIComponent(msgId)}/reaction`, body) as unknown as Promise<T>
      throw new Error(`[${this.botId}] 表情表态需要 group_id 或 user_id`)
    }
    if (action === "delete_msg_emoji_like" || action === "delete_message_reaction") {
      const msgId = String(params.message_id ?? params.messageId ?? "")
      if (!msgId) throw new Error(`[${this.botId}] 取消表态缺少 message_id`)
      const gid = String(params.group_id ?? "")
      const uid = String(params.user_id ?? "")
      if (gid) return this.v2Request("DELETE", `/v2/groups/${encodeURIComponent(gid)}/messages/${encodeURIComponent(msgId)}/reaction`) as unknown as Promise<T>
      if (uid) return this.v2Request("DELETE", `/v2/users/${encodeURIComponent(uid)}/messages/${encodeURIComponent(msgId)}/reaction`) as unknown as Promise<T>
      throw new Error(`[${this.botId}] 取消表态需要 group_id 或 user_id`)
    }

    // ===== 群管理 =====
    if (action === "get_group_member_list") {
      return this.v2Request("GET", `/v2/groups/${encodeURIComponent(String(params.group_id ?? ""))}/members`) as unknown as Promise<T>
    }
    if (action === "get_group_member_info") {
      const member = String(params.member_openid ?? params.member_id ?? params.user_id ?? "")
      return this.v2Request("GET", `/v2/groups/${encodeURIComponent(String(params.group_id ?? ""))}/members/${encodeURIComponent(member)}`) as unknown as Promise<T>
    }
    if (action === "get_group_bot_info" || action === "get_group_bot_self_info") {
      return this.v2Request("GET", `/v2/groups/${encodeURIComponent(String(params.group_id ?? ""))}/members/bot_self`) as unknown as Promise<T>
    }
    if (action === "set_group_ban") {
      const member = String(params.member_openid ?? params.member_id ?? params.user_id ?? "")
      const body = { mute_seconds: Number(params.duration ?? params.mute_seconds ?? 600) }
      return this.v2Request("POST", `/v2/groups/${encodeURIComponent(String(params.group_id ?? ""))}/members/${encodeURIComponent(member)}/mute`, body) as unknown as Promise<T>
    }
    if (action === "unset_group_ban" || action === "delete_group_ban") {
      const member = String(params.member_openid ?? params.member_id ?? params.user_id ?? "")
      return this.v2Request("DELETE", `/v2/groups/${encodeURIComponent(String(params.group_id ?? ""))}/members/${encodeURIComponent(member)}/mute`) as unknown as Promise<T>
    }
    if (action === "set_group_kick") {
      const member = String(params.member_openid ?? params.member_id ?? params.user_id ?? "")
      return this.v2Request("DELETE", `/v2/groups/${encodeURIComponent(String(params.group_id ?? ""))}/members/${encodeURIComponent(member)}`) as unknown as Promise<T>
    }
    if (action === "set_group_nickname" || action === "set_group_card") {
      const member = String(params.member_openid ?? params.member_id ?? params.user_id ?? "")
      const body = { nickname: String(params.nickname ?? params.card ?? "") }
      return this.v2Request("POST", `/v2/groups/${encodeURIComponent(String(params.group_id ?? ""))}/members/${encodeURIComponent(member)}/nickname`, body) as unknown as Promise<T>
    }

    // ===== C2C / 好友 =====
    if (action === "set_friend_add" || action === "add_friend") {
      return this.v2Request("POST", `/v2/users/${encodeURIComponent(String(params.user_id ?? ""))}/friends`) as unknown as Promise<T>
    }
    if (action === "delete_friend") {
      return this.v2Request("DELETE", `/v2/users/${encodeURIComponent(String(params.user_id ?? ""))}/friends`) as unknown as Promise<T>
    }
    if (action === "set_user_block" || action === "block_user") {
      return this.v2Request("POST", `/v2/users/${encodeURIComponent(String(params.user_id ?? ""))}/block`) as unknown as Promise<T>
    }
    if (action === "unset_user_block" || action === "unblock_user") {
      return this.v2Request("DELETE", `/v2/users/${encodeURIComponent(String(params.user_id ?? ""))}/block`) as unknown as Promise<T>
    }

    // ===== 按钮回调回应 =====
    if (action === "reply_interaction" || action === "interaction_reply" || action === "reply_action") {
      const id = String(params.interaction_id ?? params.action_id ?? params.id ?? "")
      if (!id) throw new Error(`[${this.botId}] 按钮回调缺少 interaction_id`)
      const body: Record<string, any> = {}
      if (params.code !== undefined) body.code = Number(params.code)
      return this.v2Request("PUT", `/interactions/${encodeURIComponent(id)}`, body) as unknown as Promise<T>
    }

    // ===== 机器人资料 =====
    if (action === "get_self_info" || action === "get_me") {
      return this.v2Request("GET", "/users/@me") as unknown as Promise<T>
    }

    // ===== 消息审核结果 =====
    if (action === "get_audit_result" || action === "get_message_audit") {
      return this.v2Request("GET", `/v2/message_audit/${encodeURIComponent(String(params.audit_id ?? ""))}`) as unknown as Promise<T>
    }

    throw new Error(`[${this.botId}] 不支持的 API 操作: ${action}`)
  }

  // 发送 QQ 消息（群/单聊/频道）
  private async sendQqMessage(
    targetType: "group" | "c2c" | "channel",
    targetOpenid: string,
    message: MessageChain | string
  ): Promise<QqSendResp> {
    if (!targetOpenid) throw new Error(`[${this.botId}] 缺少目标 openid`)
    if (!this.accessToken) throw new Error(`[${this.botId}] 尚未获取 access_token`)

    // 解析 markdown：支持 [CQ:markdown,data={...}] 字符串 或 { type:"markdown", data:{content} } 段
    const mdContent = this.extractMarkdownContent(message)
    const mdButtons = this.extractMarkdownButtons(message)
    const segments = normalizeSegments(message)
    const text = segmentsToQqText(segments)
    const mediaSeg = segments.find((s) => ["image", "video", "record", "file"].includes(s.type))
    const keyboard = this.buildKeyboard(segments, mdButtons)
    const msgSeq = this.nextMsgSeq(targetOpenid)

    let endpoint = ""
    if (targetType === "group") endpoint = `${OPENAPI_BASE}/v2/groups/${targetOpenid}/messages`
    else if (targetType === "c2c") endpoint = `${OPENAPI_BASE}/v2/users/${targetOpenid}/messages`
    else endpoint = `${OPENAPI_BASE}/channels/${targetOpenid}/messages`

    const headers: Record<string, string> = {
      Authorization: `QQBot ${this.accessToken}`,
      "User-Agent": DEFAULT_UA,
      "Content-Type": "application/json",
    }

    // Markdown 消息（msg_type:2），优先级最高；有按钮段时附加 keyboard
    if (mdContent) {
      const body: Record<string, any> = { content: "", msg_type: 2, msg_seq: msgSeq, markdown: { content: mdContent } }
      if (keyboard) body.keyboard = keyboard
      const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) })
      const data = (await res.json()) as any
      if (!res.ok || (data.code && data.code !== 0)) {
        throw new Error(`[${this.botId}] 发送 markdown 消息失败: ${data.message ?? data.msg ?? JSON.stringify(data)} (code:${data.code})`)
      }
      const sentId = String(data.id ?? "")
      this.cacheSentMessage(targetType, targetOpenid, message, sentId)
      return { id: sentId, message_id: sentId }
    }

    // 富媒体（图片/视频/语音/文件）：先上传拿 file_info（官方富媒体流程），再用 msg_type:7 + media 发送
    let fileInfo = ""
    if (mediaSeg) {
      const source = String(mediaSeg.data?.url ?? mediaSeg.data?.file ?? "")
      fileInfo = await this.uploadMedia(targetType, targetOpenid, source, mediaSeg.type)
    }

    const body: Record<string, any> = { content: text, msg_type: fileInfo ? 7 : 0, msg_seq: msgSeq }
    if (fileInfo) body.media = { file_info: fileInfo }
    if (keyboard && !fileInfo) body.keyboard = keyboard

    const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) })
    const data = (await res.json()) as any

    if (!res.ok || (data.code && data.code !== 0)) {
      throw new Error(`[${this.botId}] 发送${targetType}消息失败: ${data.message ?? data.msg ?? JSON.stringify(data)} (code:${data.code})`)
    }
    const sentId = String(data.id ?? "")
    this.cacheSentMessage(targetType, targetOpenid, message, sentId)
    return { id: sentId, message_id: sentId }
  }

  // 从消息段/按钮段构建 QQ keyboard
  // 按钮来源两处（可合并）：
  // 1. mdButtons：markdown 的 data.buttons 数组 [{ text, callback?, url?, visited?, row? }]
  // 2. button 段：{ type:"button", data:{ text, callback?, url?, visited?, row? } }
  // 规则：url 开头 http(s) → 跳转按钮(type 1)；否则回传按钮(type 2，点击后 INTERACTION_CREATE 回传 callback)
  // 缓存机器人发送的消息（供 get_msg API 查询）
  private cacheSentMessage(
    targetType: "group" | "c2c" | "channel",
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

  private buildKeyboard(
    segments: Array<{ type: string; data: Record<string, any> }>,
    mdButtons: Array<Record<string, any>> = []
  ): Record<string, any> | null {
    const list: Array<Record<string, any>> = [...mdButtons]
    for (const seg of segments) {
      if (seg.type === "button") list.push(seg.data ?? {})
    }
    if (!list.length) return null

    // 每行按钮：优先按 row 分组，否则每行最多 5 个
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
      const isUrl = /^https?:\/\//.test(url)
      const id = String(raw.id ?? raw.callback ?? label).slice(0, 32) || `b${rows.length * 10 + cur.length}`
      cur.push({
        id,
        render_data: {
          label,
          visited_label: String(raw.visited ?? label),
        },
        action: {
          type: isUrl ? 1 : 2,
          permission: { type: 2 },
          unsupport_tips: "请升级客户端后查看",
          data: isUrl ? url : String(raw.callback ?? id),
          reply: false,
          enter: true,
        },
      })
    }
    flush()
    if (!rows.length) return null
    return { content: { rows } }
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
    if (mdSeg) return String((mdSeg as any).data?.content ?? "")
    return ""
  }

  // 从 message 中提取按钮列表
  // 来源：
  // 1. [CQ:markdown,data={"content":"...","buttons":[...]}] 里的 buttons 数组
  // 2. { type:"markdown", data:{ content, buttons:[...] } } 里的 buttons
  // 3. { type:"button", data:{ text, callback?, url? } } 段（由 buildKeyboard 收集）
  // 返回统一按钮描述数组 [{ text, callback?, url?, visited?, row? }]
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
  // @param source http(s) url 或 base64://... 数据
  // @param segType 媒体段类型（image/video/record/file）→ 对应 file_type
  // QQ 官方 file_type: 1=图片 3=视频 4=语音 5=文件
  private async uploadMedia(
    targetType: "group" | "c2c" | "channel",
    targetOpenid: string,
    source: string,
    segType = "image"
  ): Promise<string> {
    if (!source) return ""
    let uploadEndpoint = ""
    if (targetType === "group") uploadEndpoint = `${OPENAPI_BASE}/v2/groups/${targetOpenid}/files`
    else if (targetType === "c2c") uploadEndpoint = `${OPENAPI_BASE}/v2/users/${targetOpenid}/files`
    else return "" // 频道不做富媒体上传，忽略媒体

    const fileType = segType === "video" ? 3 : segType === "record" ? 4 : segType === "file" ? 5 : 1
    const body: Record<string, any> = { file_type: fileType }
    if (/^https?:\/\//.test(source)) {
      body.url = source
    } else if (source.startsWith("base64://")) {
      body.file_data = source.slice("base64://".length)
    } else {
      return "" // 非 url / base64（如 file_id），无法上传
    }

    try {
      const res = await fetch(uploadEndpoint, {
        method: "POST",
        headers: {
          Authorization: `QQBot ${this.accessToken}`,
          "User-Agent": DEFAULT_UA,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      })
      const data = (await res.json()) as any
      if (!res.ok || (data.code && data.code !== 0)) {
        console.error(`[${this.botId}] 上传媒体失败: ${data.message ?? JSON.stringify(data)} (code:${data.code})，改发纯文本`)
        return ""
      }
      return data.file_info ?? ""
    } catch (e: any) {
      console.error(`[${this.botId}] 上传媒体异常:`, e?.message ?? e, "，改发纯文本")
      return ""
    }
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
