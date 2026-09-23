import WebSocket from "ws"
import { BaseAdapter } from "../base.js"
import { convertKookEvent, segmentsToKookText } from "./converter.js"
import type { KookApiResp } from "./types.js"
import { KOOK_SIGNAL } from "./types.js"
import type { MessageChain } from "../../core/models/message.js"
import { normalizeSegments } from "../../core/messageUtils.js"
import { registerBot } from "../../core/botRegistry.js"
import type { Capabilities } from "../../core/capabilities.js"
import type { BotEvent } from "../../core/models/event.js"

export const KookAdapterMap = new Map<string, KookAdapter>()

const API_BASE = "https://www.kookapp.cn/api/v3"

// KOOK（开黑啦）官方机器人适配器
// 原理：
// 1. GET /gateway/index 获取网关地址（compress=0 免压缩）
// 2. 连接 WebSocket，收 HELLO(s=1) 握手；每 30s 发 PING(s=2) 心跳，收 PONG(s=3)
// 3. 收 EVENT(s=0)：频道/私聊消息 → 转统一事件派发给插件；断线自动重连（可 resume）
// 4. 发送：/message/create（频道）、/direct-message/create（私聊），文本用 kmarkdown(type=9)
// 配置项：
// botId  - 框架内标识
// type   - "kook"
// token  - KOOK 开发者平台机器人 Token（必填）
// reconnectDelay - 可选，断线重连延迟毫秒，默认 5000
export class KookAdapter extends BaseAdapter {
  public readonly botId: string
  private readonly cfg: Record<string, any>
  private ws?: WebSocket
  private heartbeatTimer?: NodeJS.Timeout
  private reconnectTimer?: NodeJS.Timeout
  // 主动断开标志：disconnect 后 close 事件不再触发自动重连
  private stopped = false
  private sessionId: string = ""
  private lastSn: number = 0
  private heartbeatOk: boolean = true

  constructor(config: Record<string, any>) {
    super()
    this.cfg = config
    this.botId = config.botId
    KookAdapterMap.set(this.botId, this)
    registerBot(this)
  }

  public async connect(): Promise<void> {
    this.stopped = false
    if (!this.cfg.token) throw new Error(`[${this.botId}] 缺少 token 配置`)
    // 1. 获取机器人自身信息
    try {
      const me = (await this.api("user/me", {}, undefined, "GET")) as KookApiResp
      if (me.data?.id) {
        this.selfId = String(me.data.id)
        console.log(`✅ [${this.botId}] 登录成功: ${me.data.username ?? ""} (${this.selfId})`)
      }
    } catch (e: any) {
      console.error(`[${this.botId}] 获取用户信息失败:`, e?.message ?? e)
    }
    // 2. 获取网关并连接
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
    const res = await fetch(`${API_BASE}/gateway/index?compress=0`, {
      headers: this.authHeaders(),
      signal: AbortSignal.timeout(10000),
    })
    const data = (await res.json()) as KookApiResp
    if (data.code !== 0 || !data.data?.url) {
      throw new Error(`[${this.botId}] 获取网关失败: ${data.message ?? JSON.stringify(data)}`)
    }
    let url = String(data.data.url)
    // 断线恢复：追加 resume 参数
    if (this.sessionId) {
      url += `${url.includes("?") ? "&" : "?"}resume=1&sn=${this.lastSn}&session_id=${this.sessionId}`
    }
    return url
  }

  private connectWs(url: string): void {
    const ws = new WebSocket(url, { headers: { "User-Agent": "VanBotJS/1.0" } })
    this.ws = ws

    ws.on("open", () => {
      console.log(`✅ [${this.botId}] 网关已连接`)
    })

    ws.on("message", (data) => {
      let buf: Buffer
      if (Array.isArray(data)) buf = Buffer.concat(data)
      else if (Buffer.isBuffer(data)) buf = data
      else buf = Buffer.from(new Uint8Array(data as ArrayBuffer))
      try {
        const payload = JSON.parse(buf.toString("utf8"))
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

  private handlePayload(p: { s?: number; d?: any; sn?: number }): void {
    const signal = p.s
    if (signal === KOOK_SIGNAL.HELLO) {
      // 握手结果
      if (p.d?.code === 0) {
        this.sessionId = p.d.session_id ?? ""
        this.connected = true
        console.log(`✅ [${this.botId}] 握手成功 session:${this.sessionId}`)
        // 恢复会话：发送 RESUME(s=4)
        if (this.lastSn > 0) {
          this.send({ s: KOOK_SIGNAL.RESUME, sn: this.lastSn })
        }
        this.startHeartbeat()
      } else {
        console.error(`[${this.botId}] 握手失败:`, JSON.stringify(p.d))
      }
    } else if (signal === KOOK_SIGNAL.EVENT) {
      if (typeof p.sn === "number") this.lastSn = p.sn
      convertKookEvent(p.d, this.botId, this.selfId, this)
    } else if (signal === KOOK_SIGNAL.PONG) {
      this.heartbeatOk = true
    } else if (signal === KOOK_SIGNAL.RESUME_ACK) {
      this.connected = true
      console.log(`✅ [${this.botId}] 会话已恢复`)
    } else if (signal === KOOK_SIGNAL.RECONNECT) {
      // 服务端要求重连：清空会话，重连
      console.log(`[${this.botId}] 收到重连指令`)
      this.sessionId = ""
      this.lastSn = 0
      this.ws?.close()
    }
  }

  private send(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj))
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.heartbeatOk = false
      this.send({ s: KOOK_SIGNAL.PING, sn: this.lastSn })
      // 6 秒内没收到 PONG 视为超时（交由下次/重连处理）
      setTimeout(() => {
        if (!this.heartbeatOk) {
          console.warn(`[${this.botId}] 心跳超时，主动重连`)
          this.ws?.close()
        }
      }, 6000)
    }, 30000)
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

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bot ${this.cfg.token}`, "User-Agent": "VanBotJS/1.0" }
  }

  // 调用 KOOK HTTP API（默认 POST，可指定 GET）
  private async api(method: string, params: Record<string, any> = {}, form?: FormData, httpMethod: "GET" | "POST" = "POST"): Promise<any> {
    const headers: Record<string, string> = this.authHeaders()
    let url = `${API_BASE}/${method}`
    let res: Awaited<ReturnType<typeof fetch>>
    if (httpMethod === "GET") {
      const qs = new URLSearchParams()
      for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v))
      url += `?${qs.toString()}`
      res = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(15000) })
    } else if (form) {
      res = await fetch(url, { method: "POST", headers, body: form, signal: AbortSignal.timeout(30000) })
    } else {
      headers["Content-Type"] = "application/json"
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(15000),
      })
    }
    return res.json()
  }

  // 调用 KOOK 官方 API
  // 支持 action：
  // - send_group_msg  : 发送频道消息（params: { group_id=频道id, message }）
  // - send_private_msg: 发送私聊消息（params: { user_id, message }）
  // - send_msg        : 自动判断（有 group_id 走频道，否则走私聊）
  // message 支持字符串或消息段数组（text/markdown/image）
  // 会话粒度能力：
  // - markdown → kmarkdown(type 9) 原生；at → (met)id(met) 原生；
  // - image/video/record/file 原生上传；
  // - face/button/reply/forward 无法表达 → false（内核可降级）
  computeCapabilities(_event: BotEvent): Readonly<Capabilities> {
    return {
      text: true, image: true, video: true, record: true, file: true,
      markdown: true, at: true,
      face: false, button: false, reply: false, forward: false,
    }
  }

  public async callApi<T = any>(action: string, params: Record<string, any> = {}): Promise<T> {
    if (action === "send_group_msg") {
      return this.sendKookMessage(String(params.group_id ?? ""), params.message, "channel") as unknown as Promise<T>
    }
    if (action === "send_private_msg") {
      return this.sendKookMessage(String(params.user_id ?? ""), params.message, "dm") as unknown as Promise<T>
    }
    if (action === "send_msg") {
      if (params.group_id) return this.sendKookMessage(String(params.group_id), params.message, "channel") as unknown as Promise<T>
      return this.sendKookMessage(String(params.user_id ?? ""), params.message, "dm") as unknown as Promise<T>
    }
    throw new Error(`[${this.botId}] 不支持的 API 操作: ${action}`)
  }

  // 发送 KOOK 消息
  private async sendKookMessage(target: string, message: MessageChain | string, kind: "channel" | "dm"): Promise<KookApiResp> {
    if (!target) throw new Error(`[${this.botId}] 缺少目标 id`)
    const segments = normalizeSegments(message) as Array<{ type: string; data: Record<string, any> }>

    // markdown 段（或 CQ:markdown）→ kmarkdown
    const mdSeg = segments.find((s) => s.type === "markdown")
    const mdStr = typeof message === "string" ? extractCqMarkdown(message as string) : ""
    const mdContent = mdStr || (mdSeg ? String(mdSeg.data?.content ?? "") : "")

    // 媒体段（图片/视频/语音/文件）：需要上传到 KOOK 拿 url，按类型发 type 2/3/8/4
    const mediaSeg = segments.find((s) => ["image", "video", "record", "file"].includes(s.type))
    let mediaUrl = ""
    if (mediaSeg) {
      const source = String(mediaSeg.data?.url ?? mediaSeg.data?.file ?? "")
      mediaUrl = await this.uploadImage(source)
    }

    const body: Record<string, any> = { target_id: target, nonce: String(Date.now()) }
    if (mediaUrl) {
      body.type = mediaSeg?.type === "video" ? 3 : mediaSeg?.type === "record" ? 8 : mediaSeg?.type === "file" ? 4 : 2
      body.content = mediaUrl
    } else if (mdContent) {
      body.type = 9
      body.content = mdContent
    } else {
      body.type = 9
      body.content = segmentsToKookText(segments)
    }

    const resp = (await this.api(kind === "dm" ? "direct-message/create" : "message/create", body)) as KookApiResp
    if (resp.code !== 0) {
      throw new Error(`[${this.botId}] 发送失败: ${resp.message ?? JSON.stringify(resp)} (code:${resp.code})`)
    }
    return resp
  }

  // 上传图片到 KOOK（返回可发送的 url）
  private async uploadImage(source: string): Promise<string> {
    if (!source) return ""
    if (/^https?:\/\//.test(source)) {
      // 已是公网 url：KOOK 只接受机器人上传的资源，尝试原样发送（非 kook 资源可能失败）
      return source
    }
    if (source.startsWith("base64://")) {
      try {
        const buf = Buffer.from(source.slice("base64://".length), "base64")
        const form = new FormData()
        form.append("file", new Blob([new Uint8Array(buf)], { type: "image/png" }), "image.png")
        const resp = (await this.api("asset/create", {}, form)) as KookApiResp
        if (resp.code === 0 && resp.data?.url) return String(resp.data.url)
      } catch (e: any) {
        console.error(`[${this.botId}] 上传图片失败:`, e?.message ?? e)
      }
    }
    return ""
  }

  public async destroy(): Promise<void> {
    await this.disconnect()
    KookAdapterMap.delete(this.botId)
    await super.destroy()
  }
}

// 从 [CQ:markdown,data={...}] 字符串提取 markdown 内容
function extractCqMarkdown(msg: string): string {
  const m = msg.match(/^\[CQ:markdown,data=([\s\S]*?)\]$/)
  if (!m) return ""
  try {
    const parsed = JSON.parse(m[1])
    return String(parsed.content ?? "")
  } catch {
    return m[1]
  }
}

export function getKookAdapterById(botId: string): KookAdapter | undefined {
  return KookAdapterMap.get(botId)
}
