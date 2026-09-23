import WebSocket from "ws"
import { BaseAdapter } from "../base.js"
import { convertDiscordMessage, segmentsToDiscordText } from "./converter.js"
import type { DiscordApiResp, DiscordGatewayPayload, DiscordMessage } from "./types.js"
import { DISCORD_OP, DISCORD_INTENT } from "./types.js"
import type { MessageChain } from "../../core/models/message.js"
import { normalizeSegments } from "../../core/messageUtils.js"
import { registerBot } from "../../core/botRegistry.js"
import type { Capabilities } from "../../core/capabilities.js"
import type { BotEvent } from "../../core/models/event.js"

export const DiscordAdapterMap = new Map<string, DiscordAdapter>()

const REST_BASE = "https://discord.com/api/v10"
const GATEWAY_QUERY = "/?v=10&encoding=json"

// Discord 官方机器人适配器
// 原理：
// 1. GET /gateway 获取网关地址 → 连接 wss://gateway.discord.gg/?v=10&encoding=json
// 2. 收 HELLO(op10) 获取心跳周期 → 发 IDENTIFY(op2) 鉴权（intents 订阅事件）
// 3. 心跳 op1 / ACK op11；断线重连后 RESUME(op6) 恢复会话
// 4. 收 DISPATCH(op0)：MESSAGE_CREATE → 转统一事件派发给插件
// 5. 发送：POST /channels/{channel_id}/messages（REST）
// 配置项：
// botId   - 框架内标识
// type    - "discord"
// token   - Discord 开发者平台 Bot Token（必填）
// intents - 可选，默认 GUILDS|GUILD_MESSAGES|DIRECT_MESSAGES|MESSAGE_CONTENT
// reconnectDelay - 可选，断线重连毫秒，默认 5000
// 注意：Discord 国内不可直连，需海外环境/代理运行。
// MESSAGE_CONTENT 是特权 intent，需在开发者后台开启 "Message Content Intent"。
export class DiscordAdapter extends BaseAdapter {
  public readonly botId: string
  private readonly cfg: Record<string, any>
  private ws?: WebSocket
  private heartbeatTimer?: NodeJS.Timeout
  private reconnectTimer?: NodeJS.Timeout
  // 主动断开标志：disconnect 后 close 事件不再触发自动重连
  private stopped = false
  private intents: number = 0
  private lastSeq: number | null = null
  private sessionId: string = ""
  private shouldResume: boolean = false
  // 私聊缓存：userId → DM channel_id（从收到的私聊事件记录，发私聊时用）
  private dmChannelCache = new Map<string, string>()

  constructor(config: Record<string, any>) {
    super()
    this.cfg = config
    this.botId = config.botId
    this.intents = Number(
      config.intents ??
        (DISCORD_INTENT.GUILDS |
          DISCORD_INTENT.GUILD_MESSAGES |
          DISCORD_INTENT.DIRECT_MESSAGES |
          DISCORD_INTENT.MESSAGE_CONTENT)
    )
    DiscordAdapterMap.set(this.botId, this)
    registerBot(this)
  }

  public async connect(): Promise<void> {
    this.stopped = false
    if (!this.cfg.token) throw new Error(`[${this.botId}] 缺少 token 配置`)
    // 检查 intents 是否覆盖消息事件（收不到消息的最常见原因）
    const miss: string[] = []
    if (!(this.intents & DISCORD_INTENT.GUILD_MESSAGES)) miss.push("GUILD_MESSAGES(512)")
    if (!(this.intents & DISCORD_INTENT.DIRECT_MESSAGES)) miss.push("DIRECT_MESSAGES(4096)")
    if (!(this.intents & DISCORD_INTENT.MESSAGE_CONTENT)) miss.push("MESSAGE_CONTENT(32768)")
    if (miss.length) {
      console.warn(`[${this.botId}] ⚠️ 当前 intents=${this.intents} 缺少: ${miss.join("、")} —— 将无法接收对应消息，请改用 intents=37377 或补齐这些位`)
    } else {
      console.log(`[${this.botId}] intents=${this.intents}（含频道/私聊/消息正文）`)
    }
    const url = await this.resolveGateway()
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
    this.connected = false
    console.log(`[${this.botId}] 网关已关闭`)
  }

  // 网关

  private async resolveGateway(): Promise<string> {
    try {
      const res = await fetch(`${REST_BASE}/gateway`, { signal: AbortSignal.timeout(10000) })
      const data = (await res.json()) as any
      if (data.url) return `${data.url}${GATEWAY_QUERY}`
    } catch {
      // 忽略，使用默认网关
    }
    return `wss://gateway.discord.gg${GATEWAY_QUERY}`
  }

  private connectWs(url: string): void {
    const ws = new WebSocket(url, { headers: { "User-Agent": "VanBotJS/1.0" } })
    this.ws = ws

    ws.on("open", () => {
      console.log(`✅ [${this.botId}] 网关已连接`)
      // 恢复或首次鉴权
      if (this.sessionId && this.shouldResume) {
        this.send({
          op: DISCORD_OP.RESUME,
          d: { token: this.cfg.token, session_id: this.sessionId, seq: this.lastSeq ?? null },
        })
      } else {
        this.send({
          op: DISCORD_OP.IDENTIFY,
          d: {
            token: this.cfg.token,
            intents: this.intents,
            properties: { os: process.platform, browser: "VanBotJS", device: "VanBotJS" },
            shard: [0, 1],
          },
        })
      }
    })

    ws.on("message", (data) => {
      let buf: Buffer
      if (Array.isArray(data)) buf = Buffer.concat(data)
      else if (Buffer.isBuffer(data)) buf = data
      else buf = Buffer.from(new Uint8Array(data as ArrayBuffer))
      try {
        const payload = JSON.parse(buf.toString("utf8")) as DiscordGatewayPayload
        this.handlePayload(payload)
      } catch {
        // 忽略解析失败
      }
    })

    ws.on("close", (code, reason) => {
      if (this.stopped) return
      this.connected = false
      this.stopHeartbeat()
      console.log(`[${this.botId}] 网关关闭 code:${code} ${reason?.toString() ?? ""}`)
      this.scheduleReconnect()
    })

    ws.on("error", (err) => {
      console.error(`[${this.botId}] 网关异常:`, err.message)
    })
  }

  private handlePayload(p: DiscordGatewayPayload): void {
    switch (p.op) {
      case DISCORD_OP.HELLO:
        this.startHeartbeat(p.d?.heartbeat_interval ?? 41250)
        break
      case DISCORD_OP.DISPATCH: {
        if (typeof p.s === "number") this.lastSeq = p.s
        const t = p.t ?? ""
        if (t === "READY") {
          this.sessionId = p.d?.session_id ?? ""
          this.selfId = String(p.d?.user?.id ?? "")
          this.connected = true
          this.shouldResume = true
          console.log(`✅ [${this.botId}] 登录成功: ${p.d?.user?.username ?? ""} (${this.selfId})`)
          return
        }
        if (t === "RESUMED") {
          this.connected = true
          console.log(`✅ [${this.botId}] 会话已恢复`)
          return
        }
        if (t === "MESSAGE_CREATE") {
          const msg = p.d as DiscordMessage
          // 忽略机器人自己的消息（默认开启，config.ignoreSelf:false 可关闭）
          if (this.cfg.ignoreSelf !== false && msg.author?.id === this.selfId) return
          convertDiscordMessage(msg, this.botId, this.selfId, this)
        }
        // 其余事件暂不处理（可扩展）
        break
      }
      case DISCORD_OP.HEARTBEAT_ACK:
        // 心跳回应
        break
      case DISCORD_OP.RECONNECT:
        this.shouldResume = true
        this.ws?.close()
        break
      case DISCORD_OP.INVALID_SESSION:
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
      this.send({ op: DISCORD_OP.HEARTBEAT, d: this.lastSeq ?? null })
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

  // API

  // 调用 Discord 官方 API
  // 支持 action：
  // - send_group_msg  : 发送频道消息（params: { group_id=频道id, message }）
  // - send_private_msg: 发送私聊消息（params: { user_id=私聊频道id, message }）
  // - send_msg        : 自动判断（有 group_id 走频道，否则走私聊）
  // message 支持字符串或消息段数组（text/image）
  // 会话粒度能力：
  // - text/markdown 原生（Discord 消息即 markdown 渲染）；
  // - image(embed)/video/record/file(附件上传)/at(<@id>) 原生；
  // - face/button/reply/forward 无法表达 → false（内核可降级）
  computeCapabilities(_event: BotEvent): Readonly<Capabilities> {
    return {
      text: true, image: true, video: true, record: true, file: true,
      markdown: true, at: true,
      face: false, button: false, reply: false, forward: false,
    }
  }

  public async callApi<T = any>(action: string, params: Record<string, any> = {}): Promise<T> {
    if (action === "send_group_msg" || action === "send_private_msg" || action === "send_msg") {
      if (params.channel_id !== undefined && params.channel_id !== null && params.channel_id !== "") {
        return this.sendDiscordMessage(String(params.channel_id), params.message) as unknown as Promise<T>
      }
      if (params.group_id !== undefined && params.group_id !== null && params.group_id !== "") {
        return this.sendDiscordMessage(String(params.group_id), params.message) as unknown as Promise<T>
      }
      if (params.user_id !== undefined && params.user_id !== null && params.user_id !== "") {
        // 私聊：user_id 是 Discord 用户 id，需解析为 DM 频道
        const channelId = await this.resolveDmChannel(String(params.user_id))
        return this.sendDiscordMessage(channelId, params.message) as unknown as Promise<T>
      }
      throw new Error(`[${this.botId}] ${action} 缺少目标 channel_id/group_id/user_id`)
    }
    throw new Error(`[${this.botId}] 不支持的 API 操作: ${action}`)
  }

  // 记录私聊映射（收到 DM 消息时由 converter 调用）
  public cacheDmChannel(userId: string, channelId: string): void {
    if (userId && channelId) this.dmChannelCache.set(userId, channelId)
  }

  // 由用户 id 解析 DM 频道：优先缓存，无则调 Create DM 接口
  private async resolveDmChannel(userId: string): Promise<string> {
    const cached = this.dmChannelCache.get(userId)
    if (cached) return cached
    const res = await fetch(`${REST_BASE}/users/@me/channels`, {
      method: "POST",
      headers: { Authorization: `Bot ${this.cfg.token}`, "Content-Type": "application/json", "User-Agent": "VanBotJS/1.0" },
      body: JSON.stringify({ recipient_id: userId }),
      signal: AbortSignal.timeout(15000),
    })
    const data = (await res.json()) as any
    if (!res.ok) {
      throw new Error(`[${this.botId}] 解析私聊频道失败: ${data.message ?? JSON.stringify(data)} (code:${data.code ?? res.status})`)
    }
    this.dmChannelCache.set(userId, data.id)
    return data.id
  }

  // 发送 Discord 消息（文本/图片 URL 一体发送）
  private async sendDiscordMessage(channelId: string, message: MessageChain | string): Promise<DiscordApiResp> {
    const segments = normalizeSegments(message) as Array<{ type: string; data: Record<string, any> }>
    const text = segmentsToDiscordText(segments)
    const imageSeg = segments.find((s) => s.type === "image")
    const mediaSeg = segments.find((s) => ["video", "record", "file"].includes(s.type))

    // 媒体（视频/语音/文件）：需 multipart 上传文件；source 为 http url 时先下载再上传
    if (mediaSeg) {
      const url = String(mediaSeg.data?.url ?? mediaSeg.data?.file ?? "")
      const name = String(mediaSeg.data?.name ?? "attachment")
      try {
        let buf: Buffer | undefined
        if (url.startsWith("base64://")) {
          buf = Buffer.from(url.slice("base64://".length), "base64")
        } else if (/^https?:\/\//.test(url)) {
          const dl = await fetch(url, { signal: AbortSignal.timeout(15000) })
          buf = Buffer.from(await dl.arrayBuffer())
        }
        if (buf) {
          return this.sendDiscordAttachment(channelId, text, buf, name)
        }
      } catch (e: any) {
        console.error(`[${this.botId}] 媒体下载/上传失败，改发纯文本:`, e?.message ?? e)
      }
    }

    // 图片：优先用 embed 里的图片 URL，文本放 content
    const body: Record<string, any> = { content: text }
    if (imageSeg) {
      const url = String(imageSeg.data?.url ?? imageSeg.data?.file ?? "")
      if (/^https?:\/\//.test(url)) {
        body.embeds = [{ image: { url } }]
      }
    }

    const res = await fetch(`${REST_BASE}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${this.cfg.token}`, "Content-Type": "application/json", "User-Agent": "VanBotJS/1.0" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
    const data = (await res.json()) as any
    if (!res.ok) {
      throw new Error(`[${this.botId}] 发送失败: ${data.message ?? JSON.stringify(data)} (code:${data.code ?? res.status})`)
    }
    return data
  }

  // Discord multipart 上传附件（视频/语音/文件）
  private async sendDiscordAttachment(channelId: string, text: string, buf: Buffer, name: string): Promise<DiscordApiResp> {
    const form = new FormData()
    form.append("content", text)
    form.append("files[0]", new Blob([new Uint8Array(buf)]), name || "attachment")
    const res = await fetch(`${REST_BASE}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${this.cfg.token}`, "User-Agent": "VanBotJS/1.0" },
      body: form,
      signal: AbortSignal.timeout(30000),
    })
    const data = (await res.json()) as any
    if (!res.ok) {
      throw new Error(`[${this.botId}] 发送附件失败: ${data.message ?? JSON.stringify(data)} (code:${data.code ?? res.status})`)
    }
    return data
  }

  public async destroy(): Promise<void> {
    await this.disconnect()
    DiscordAdapterMap.delete(this.botId)
    await super.destroy()
  }
}

export function getDiscordAdapterById(botId: string): DiscordAdapter | undefined {
  return DiscordAdapterMap.get(botId)
}
