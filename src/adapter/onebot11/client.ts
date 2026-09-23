import WebSocket, { WebSocketServer } from "ws"
import http from "http"
import { randomUUID } from "crypto"
import { BaseAdapter } from "../base.js"
import type { OB11ApiReq, OB11ConnectMode } from "./types.js"
import { convertOb11Event } from "./converter.js"
import type { MessageChain } from "../../core/models/message.js"
import { registerBot } from "../../core/botRegistry.js"
import type { Capabilities } from "../../core/capabilities.js"
import type { BotEvent } from "../../core/models/event.js"

export class OneBot11Adapter extends BaseAdapter {
  public readonly botId: string
  private readonly cfg: Record<string, any>
  private ws?: WebSocket
  private wss?: WebSocketServer
  private httpServer?: http.Server
  private reconnectTimer?: NodeJS.Timeout
  // 主动断开标志：disconnect 后 close 事件不再触发自动重连
  private stopped = false

  constructor(config: Record<string, any>) {
    super()
    this.cfg = config
    this.botId = config.botId
    registerBot(this)
  }

  public async connect(): Promise<void> {
    this.stopped = false
    const mode = this.cfg.mode as OB11ConnectMode
    if (mode === "ws_reverse") {
      this.startWsServer()
    } else if (mode === "ws_client") {
      await this.startWsClient()
    } else if (mode === "http") {
      this.startHttpServer()
    } else {
      throw new Error(`[${this.botId}] 未知连接模式: ${mode}`)
    }
  }

  public async disconnect(): Promise<void> {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    if (this.ws) {
      this.ws.close()
      this.ws = undefined
    }
    if (this.wss) {
      this.wss.close()
      this.wss = undefined
    }
    if (this.httpServer) {
      this.httpServer.close()
      this.httpServer = undefined
    }
    this.connected = false
  }

  private startWsServer(): void {
    if (this.wss) {
      this.wss.close(() => {
        console.log(`[${this.botId}] 旧WS服务已关闭，释放端口`)
      })
    }

    const wss = new WebSocketServer({ port: this.cfg.port })
    this.wss = wss

    wss.on("connection", (ws, req) => {
      if (req.url !== this.cfg.path) {
        return ws.close(1008, "path not match")
      }
      const authHeader = req.headers.authorization
      if (this.cfg.token && authHeader !== `Bearer ${this.cfg.token}`) {
        return ws.close(1008, "token invalid")
      }

      this.ws = ws
      this.connected = true
      this.bindWsEvents()
      console.log(`✅ [${this.botId}] OneBot11 反向WS客户端连接成功`)
    })

    wss.on("error", (err) => {
      console.error(`[${this.botId}] WS服务监听异常：`, err)
    })

    console.log(`[${this.botId}] OneBot11 反向WS监听 | 端口:${this.cfg.port} 路径:${this.cfg.path}`)
  }

  private async startWsClient(): Promise<void> {
    const ws = new WebSocket(this.cfg.url)
    this.ws = ws

    ws.on("open", () => {
      this.connected = true
      console.log(`✅ [${this.botId}] OneBot11 正向WS连接成功`)
    })

    this.bindWsEvents()
  }

  // HTTP(webhook) 模式：本地起 HTTP 服务接收 OneBot 事件上报
  private startHttpServer(): void {
    const path = this.cfg.path ?? "/"
    const port = this.cfg.port ?? 8080
    const server = http.createServer((req, res) => {
      if (req.method === "POST" && (path === "/" || req.url === path)) {
        let body = ""
        req.on("data", (c) => (body += c))
        req.on("end", () => {
          try {
            const json = JSON.parse(body)
            convertOb11Event(json, this.botId, this)
          } catch (err) {
            console.error(`[${this.botId}] 解析 OB11 HTTP 事件失败：`, err)
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
      console.log(`✅ [${this.botId}] OneBot11 HTTP(webhook) 监听 | 端口:${port} 路径:${path}`)
    })
    this.httpServer = server
  }

  private bindWsEvents(): void {
    if (!this.ws) return

    this.ws.on("message", (rawData) => {
      try {
        const json = JSON.parse(rawData.toString())
        convertOb11Event(json, this.botId, this)
      } catch (err) {
        console.error(`[${this.botId}] 解析OB11消息失败：`, err)
      }
    })

    this.ws.on("close", (code) => {
      if (this.stopped) return
      console.log(`[${this.botId}] 连接关闭 code:${code}，2秒后重连`)
      this.connected = false
      this.ws = undefined

      if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
      if (this.wss) this.wss.close()

      this.reconnectTimer = setTimeout(() => {
        this.connect().catch(e => console.error(`[${this.botId}] 重连失败:`, e))
      }, 2000)
    })

    this.ws.on("error", (err) => {
      console.error(`[${this.botId}] WS连接异常：`, err)
    })
  }

  // 通用 API 调用
  // 会话粒度能力：OneBot11/NapCat 原生支持全部消息段与群管理；
  // 群聊拥有禁言/踢出能力，私聊没有；群管理员可由 sender.role 判断。
  computeCapabilities(event: BotEvent): Readonly<Capabilities> {
    const isGroup = !!event.groupId && String(event.groupId) !== "undefined" && String(event.groupId) !== "0"
    const role = (event.raw as any)?.sender?.role ?? ""
    return {
      text: true, image: true, video: true, record: true, file: true,
      markdown: true, button: true, at: true, reply: true, face: true,
      forward: true, json: true,
      canMuteMember: isGroup,
      canKickMember: isGroup,
      isGroupAdmin: isGroup && (role === "admin" || role === "owner"),
      isGroupOwner: isGroup && role === "owner",
    }
  }

  public async callApi<T = any>(action: string, params?: Record<string, any>): Promise<T> {
    if (this.cfg.mode === "http") {
      return this.callApiHttp(action, params)
    }
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error("WS未连接，无法调用API"))
      }
      const reqId = randomUUID()
      const p = { ...(params ?? {}) }
      // 兼容：message 传了单段对象 {type,data} 时，包成数组（NapCat 需要字符串或数组）
      if (p.message && typeof p.message === "object" && !Array.isArray(p.message) && typeof p.message.type === "string") {
        p.message = [p.message]
      }
      const req: OB11ApiReq = {
        action,
        params: p,
        echo: reqId,
      }
      this.ws.send(JSON.stringify(req))

      const tempHandler = (raw: Buffer) => {
        try {
          const res = JSON.parse(raw.toString())
          if (res.echo === reqId) {
            this.ws?.off("message", tempHandler)
            if (res.retcode === 0) resolve(res.data)
            else reject(new Error(`API返回错误：${res.msg}`))
          }
        } catch {
          // 忽略解析错误
        }
      }
      this.ws.on("message", tempHandler)

      setTimeout(() => {
        this.ws?.off("message", tempHandler)
        reject(new Error(`API ${action} 请求超时`))
      }, 10000)
    })
  }

  // HTTP 模式：POST {apiUrl}/api/{action} 调 OneBot 接口（NapCat 风格）
  private async callApiHttp<T = any>(action: string, params?: Record<string, any>): Promise<T> {
    const base = String(this.cfg.apiUrl ?? this.cfg.url ?? "http://127.0.0.1:3000")
    const reqId = randomUUID()
    const p = { ...(params ?? {}) }
    if (p.message && typeof p.message === "object" && !Array.isArray(p.message) && typeof p.message.type === "string") {
      p.message = [p.message]
    }
    const res = await fetch(`${base}/api/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.cfg.token ? { Authorization: `Bearer ${this.cfg.token}` } : {}),
      },
      body: JSON.stringify({ ...p, echo: reqId }),
    })
    let data: any
    try {
      data = await res.json()
    } catch {
      throw new Error(`HTTP API ${action} 返回非 JSON：HTTP ${res.status}`)
    }
    if (data?.retcode === 0) return data.data
    throw new Error(`API返回错误：${data?.msg ?? data?.message ?? JSON.stringify(data)}`)
  }

  public async destroy(): Promise<void> {
    await this.disconnect()
  }
}
