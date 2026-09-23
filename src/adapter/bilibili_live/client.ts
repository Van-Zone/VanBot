import WebSocket from "ws"
import { BaseAdapter } from "../base.js"
import {
  convertBiliDanmaku,
  decodePackets,
  encodePacket,
  segmentsToDanmakuText,
} from "./converter.js"
import type { DanmuInfoResp, NavResp, RoomInfoResp } from "./types.js"
import { normalizeSegments } from "../../core/messageUtils.js"
import { registerBot } from "../../core/botRegistry.js"
import type { Capabilities } from "../../core/capabilities.js"
import type { BotEvent } from "../../core/models/event.js"

export const BilibiliLiveAdapterMap = new Map<string, BilibiliLiveAdapter>()

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

// Bilibili 直播间适配器
// 原理：
// 1. 连接直播弹幕 WebSocket（wss://broadcastlv.chat.bilibili.com/sub 或 getDanmuInfo 下发的节点）
// 2. 连接后 5 秒内发送鉴权包（op=7），之后每 30 秒发送一次心跳（op=2）
// 3. 收到服务端消息包（op=5）解析 cmd：DANMU_MSG 等转成统一事件派发给插件
// 4. 发送消息：POST api.live.bilibili.com/msg/send 发送弹幕（需要机器人账号的 cookie）
// 配置项：
// botId        - 框架内标识
// type         - "bilibili_live"
// roomId       - 直播间号（短号/长号均可，会自动解析真实房间号）
// cookie       - B 站登录 Cookie（建议填，否则无法发送弹幕、昵称会被打码）
// csrf         - 可选，默认从 cookie 里取 bili_jct
// uid          - 可选，机器人账号 uid（不填会尝试从 cookie 自动获取）
// color        - 可选，弹幕颜色，默认 16777215（白色）
// mode         - 可选，弹幕模式，默认 1（普通弹幕）
// fontsize     - 可选，字体大小，默认 25
// ignoreSelf   - 可选，默认 true，忽略机器人自己发的弹幕（防循环）
// reconnectDelay - 可选，断线重连延迟（毫秒），默认 5000
export class BilibiliLiveAdapter extends BaseAdapter {
  public readonly botId: string
  private readonly cfg: Record<string, any>
  private ws?: WebSocket
  private heartbeatTimer?: NodeJS.Timeout
  private reconnectTimer?: NodeJS.Timeout
  // 主动断开标志：disconnect 后 close 事件不再触发自动重连
  private stopped = false
  private realRoomId: number = 0
  private selfIdValue: number = 0
  private roomTitle: string = ""
  private receivedAuthReply: boolean = false

  constructor(config: Record<string, any>) {
    super()
    this.cfg = config
    this.botId = config.botId
    BilibiliLiveAdapterMap.set(this.botId, this)
    registerBot(this)
  }

  public async connect(): Promise<void> {
    this.stopped = false
    const roomId = Number(this.cfg.roomId ?? 0)
    if (!roomId) throw new Error(`[${this.botId}] 缺少 roomId 配置`)
    const cookie = String(this.cfg.cookie ?? "")

    // 1. 解析真实房间号
    this.realRoomId = await this.resolveRoomId(roomId, cookie)
    // 2. 获取机器人自身 uid（selfId + 过滤自己弹幕用）
    this.selfIdValue = await this.resolveSelfId(cookie)
    // 2.5 确保 cookie 含 buvid3/buvid4（B 站弹幕鉴权接口风控要求）
    const fullCookie = await this.ensureBuvidCookie(cookie)
    // 3. 获取弹幕服务器节点 + 鉴权 token（优先 getConf，避开 getDanmuInfo 风控 -352）
    const { host, port, token } = await this.resolveDanmuHost(this.realRoomId, fullCookie)
    // 4. 连接 WS
    this.connectWs(host, port, token, fullCookie)
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
    console.log(`[${this.botId}] 直播间连接已关闭`)
  }

  // 房间 / 鉴权信息解析

  private async resolveRoomId(roomId: number, cookie: string): Promise<number> {
    try {
      const url = `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}`
      const res = await fetch(url, {
        headers: { "User-Agent": DEFAULT_UA, ...(cookie ? { Cookie: cookie } : {}) },
        signal: AbortSignal.timeout(8000),
      })
      const data = (await res.json()) as RoomInfoResp
      const realId = data.data?.room_id ?? roomId
      this.roomTitle = data.data?.title ?? ""
      const status = data.data?.live_status
      console.log(
        `[${this.botId}] 房间 ${roomId} → 真实ID ${realId} | ${status === 1 ? "直播中" : status === 2 ? "轮播中" : "未开播"} | ${this.roomTitle}`
      )
      return realId
    } catch (e) {
      console.warn(`[${this.botId}] 解析真实房间号失败，使用原房间号:`, (e as Error).message)
      return roomId
    }
  }

  private async resolveSelfId(cookie: string): Promise<number> {
    if (this.cfg.uid) return Number(this.cfg.uid)
    if (!cookie) return 0
    try {
      const res = await fetch("https://api.bilibili.com/x/web-interface/nav", {
        headers: { "User-Agent": DEFAULT_UA, Cookie: cookie },
        signal: AbortSignal.timeout(8000),
      })
      const data = (await res.json()) as NavResp
      if (data.code === 0 && data.data?.isLogin) {
        const mid = data.data.mid ?? 0
        console.log(`[${this.botId}] 已登录账号 uid=${mid} ${data.data.uname ?? ""}`)
        return mid
      }
    } catch {
      // 忽略，使用 0
    }
    return 0
  }

  // 确保 cookie 含有 buvid3/buvid4
  // B 站弹幕鉴权包和 getDanmuInfo 都要 buvid，缺了会被风控断连；没有就从 /x/frontend/finger/spi 自动补
  private async ensureBuvidCookie(cookie: string): Promise<string> {
    let c = String(cookie ?? "")
    if (this.getCookieValue(c, "buvid3") && this.getCookieValue(c, "buvid4")) return c
    try {
      const res = await fetch("https://api.bilibili.com/x/frontend/finger/spi", {
        headers: { "User-Agent": DEFAULT_UA },
        signal: AbortSignal.timeout(6000),
      })
      const j = (await res.json()) as any
      const b3 = j?.data?.b_3
      const b4 = j?.data?.b_4
      const parts: string[] = c ? c.split(";").map((s) => s.trim()).filter(Boolean) : []
      const has = (n: string) => parts.some((p) => p.startsWith(n + "="))
      if (b3 && !has("buvid3")) parts.push(`buvid3=${b3}`)
      if (b4 && !has("buvid4")) parts.push(`buvid4=${b4}`)
      c = parts.join("; ")
    } catch {
      // 拿不到就原样返回
    }
    return c
  }

  private async resolveDanmuHost(
    roomId: number,
    cookie: string
  ): Promise<{ host: string; port: number; token: string }> {
    const headers = {
      "User-Agent": DEFAULT_UA,
      Referer: `https://live.bilibili.com/${roomId}`,
      ...(cookie ? { Cookie: cookie } : {}),
    }

    // 优先旧版 getConf：返回 token + host_server_list，不受 getDanmuInfo 的 -352 风控影响
    try {
      const url = `https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=${roomId}&platform=pc&player=web`
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
      const data = (await res.json()) as any
      if (data.code === 0 && data.data) {
        const d = data.data
        const servers = d.host_server_list ?? []
        const h = servers[0] ?? { host: d.host ?? "broadcastlv.chat.bilibili.com", wss_port: 443 }
        const token = d.token ?? ""
        console.log(
          `[${this.botId}] 弹幕服务器(getConf): ${h.host}:${h.wss_port ?? 443} token=${token ? "已获取" : "为空"}`
        )
        return { host: h.host, port: h.wss_port || 443, token }
      }
      console.warn(`[${this.botId}] getConf 返回 code=${data.code}，尝试 getDanmuInfo`)
    } catch (e) {
      console.warn(`[${this.botId}] getConf 获取失败:`, (e as Error).message)
    }

    // 备用：getDanmuInfo（可能被 -352 风控）
    try {
      const url = `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=${roomId}`
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
      const data = (await res.json()) as DanmuInfoResp
      if (data.code === 0 && data.data?.host_list?.length) {
        const h = data.data.host_list[0]
        return { host: h.host, port: h.wss_port || 443, token: data.data.token ?? "" }
      }
      console.warn(`[${this.botId}] getDanmuInfo 返回 code=${data.code}（可能被风控），将使用默认地址（可能连不上）`)
    } catch (e) {
      console.warn(`[${this.botId}] 获取弹幕服务器失败:`, (e as Error).message)
    }
    return { host: "broadcastlv.chat.bilibili.com", port: 443, token: "" }
  }

  // WebSocket

  private connectWs(host: string, port: number, token: string, cookie: string): void {
    const url = `wss://${host}:${port}/sub`
    if (!token) {
      console.warn(`[${this.botId}] ⚠️ 未获取到弹幕鉴权 token，B 站会断开连接（code:1006）。请确认网络环境或手动配置 cookie`)
    }
    const ws = new WebSocket(url, {
      headers: {
        "User-Agent": DEFAULT_UA,
        ...(cookie ? { Cookie: cookie } : {}),
      },
    })
    this.ws = ws
    this.receivedAuthReply = false

    ws.on("open", () => {
      console.log(`✅ [${this.botId}] 弹幕WS已连接: ${url}`)
      // 5 秒内必须发送鉴权包
      const buvid = this.getCookieValue(cookie, "buvid3")
      const authBody = {
        uid: this.selfIdValue || 0,
        roomid: this.realRoomId,
        protover: 2, // 2 = zlib 压缩
        buvid,
        platform: "web",
        type: 2,
        key: token,
      }
      ws.send(encodePacket(7, JSON.stringify(authBody), 1))
      this.startHeartbeat()
    })

    ws.on("message", (data) => {
      let buf: Buffer
      if (Array.isArray(data)) {
        buf = Buffer.concat(data)
      } else if (Buffer.isBuffer(data)) {
        buf = data
      } else {
        buf = Buffer.from(new Uint8Array(data))
      }
      this.onWsData(buf)
    })

    ws.on("close", (code, reason) => {
      if (this.stopped) return
      const authState = this.receivedAuthReply ? "已鉴权" : "未收到鉴权回复"
      console.log(`[${this.botId}] WS关闭 code:${code} ${reason?.toString() ?? ""}（${authState}）`)
      this.connected = false
      this.reconnect()
    })

    ws.on("error", (err) => {
      console.error(`[${this.botId}] WS异常:`, err.message)
    })
  }

  private onWsData(frame: Buffer): void {
    const packets = decodePackets(frame)
    for (const p of packets) {
      if (p.op === 5) {
        // 服务端推送消息
        const bodyStr = p.body.toString("utf8")
        try {
          const json = JSON.parse(bodyStr)
          const cmd = json.cmd ?? ""
          if (cmd.startsWith("DANMU_MSG")) {
            this.handleDanmaku(json)
          } else if (cmd === "SUPER_CHAT_MESSAGE") {
            this.handleSuperChat(json)
          }
          // 其他（SEND_GIFT / INTERACT_WORD / LIVE 等）暂不处理
        } catch {
          // 解析失败忽略
        }
      } else if (p.op === 8) {
        // 鉴权回应：进入房间成功
        this.connected = true
        this.receivedAuthReply = true
        console.log(`✅ [${this.botId}] 已进入直播间 ${this.realRoomId}`)
      } else if (p.op === 3) {
        // 心跳回应（人气值），忽略
      }
    }
  }

  private handleDanmaku(raw: any): void {
    const info = raw.info ?? []
    const uid = info[2]?.[0]
    // 忽略机器人自己发的弹幕，防止死循环
    if (this.cfg.ignoreSelf !== false && this.selfIdValue && String(uid) === String(this.selfIdValue)) {
      return
    }
    convertBiliDanmaku(raw, this.botId, this.selfIdValue || Number(this.cfg.uid ?? 0), this.realRoomId, this)
  }

  private handleSuperChat(raw: any): void {
    const data = raw.data ?? {}
    // 醒目留言包装成普通弹幕事件（带金额信息）
    const wrapped = {
      cmd: "DANMU_MSG",
      info: [
        [0, 0, 0, 0, 0, 0, 0, data.ts ?? 0, 0, 0],
        data.message ?? "",
        [data.uid ?? 0, data.user_info?.uname ?? data.uname ?? ""],
      ],
    }
    this.handleDanmaku(wrapped)
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(encodePacket(2, "", 1))
      }
    }, 30000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
  }

  private reconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((e) => console.error(`[${this.botId}] 重连失败:`, e))
    }, this.cfg.reconnectDelay ?? 5000)
  }

  // API / 发送

  // 调用 B 站 API
  // 支持的 action（兼容 keyword.ts 的 onebotApi 调用）：
  // - send_group_msg / send_private_msg / send_msg : 发送弹幕（params: { group_id/user_id, message }）
  // - 其他：抛出"不支持"错误
  // 会话粒度能力：直播间只收发弹幕文本，无富媒体/群管理
  computeCapabilities(_event: BotEvent): Readonly<Capabilities> {
    return {
      text: true,
      image: false, video: false, record: false, file: false,
      markdown: false, button: false, at: false, reply: false, face: false, forward: false,
    }
  }

  public async callApi<T = any>(action: string, params: Record<string, any> = {}): Promise<T> {
    if (action === "send_group_msg" || action === "send_private_msg" || action === "send_msg") {
      const text = segmentsToDanmakuText(normalizeSegments(params.message ?? ""))
      return this.sendDanmaku(text) as Promise<T>
    }
    throw new Error(`[${this.botId}] 直播间不支持的 API 操作: ${action}`)
  }

  // 发送弹幕（POST api.live.bilibili.com/msg/send）
  private async sendDanmaku(text: string): Promise<any> {
    if (!text) return { code: 0, message: "空消息" }
    const cookie = String(this.cfg.cookie ?? "")
    if (!cookie) {
      throw new Error(`[${this.botId}] 未配置 cookie，无法发送弹幕（接收弹幕不受影响）`)
    }
    const csrf = String(this.cfg.csrf ?? this.getCookieValue(cookie, "bili_jct") ?? "")
    const rnd = Math.floor(Date.now() / 1000)
    const roomid = this.realRoomId || Number(this.cfg.roomId ?? 0)

    const body = new URLSearchParams()
    body.set("bubble", "0")
    body.set("msg", text)
    body.set("color", String(this.cfg.color ?? 16777215))
    body.set("mode", String(this.cfg.mode ?? 1))
    body.set("fontsize", String(this.cfg.fontsize ?? 25))
    body.set("rnd", String(rnd))
    body.set("roomid", String(roomid))
    body.set("csrf", csrf)
    body.set("csrf_token", csrf)

    const res = await fetch("https://api.live.bilibili.com/msg/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": DEFAULT_UA,
        "Cookie": cookie,
        "Origin": "https://live.bilibili.com",
        "Referer": `https://live.bilibili.com/${roomid}`,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(10000),
    })
    const data = (await res.json()) as any
    if (data.code !== 0) {
      throw new Error(`[${this.botId}] 发送弹幕失败: ${data.message ?? data.msg ?? JSON.stringify(data)}`)
    }
    return data
  }

  // 工具

  private getCookieValue(cookie: string, name: string): string {
    for (const part of cookie.split(";")) {
      const idx = part.indexOf("=")
      if (idx === -1) continue
      const k = part.slice(0, idx).trim()
      if (k === name) return part.slice(idx + 1).trim()
    }
    return ""
  }

  public async destroy(): Promise<void> {
    await this.disconnect()
    BilibiliLiveAdapterMap.delete(this.botId)
    await super.destroy()
  }
}

export function getBilibiliLiveAdapterById(botId: string): BilibiliLiveAdapter | undefined {
  return BilibiliLiveAdapterMap.get(botId)
}
