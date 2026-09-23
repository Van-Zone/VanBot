import WebSocket, { WebSocketServer } from "ws"
import http from "http"
import { randomUUID } from "crypto"
import { BaseAdapter } from "../base.js"
import { convertMilkyEvent } from "./converter.js"
import type { MilkyRawEvent } from "./types.js"
import { registerBot } from "../../core/botRegistry.js"
import type { Capabilities } from "../../core/capabilities.js"
import type { BotEvent } from "../../core/models/event.js"

export type MilkyConnectMode = "ws" | "ws_reverse" | "http"

export const MilkyAdapterMap = new Map<string, MilkyAdapter>()

export class MilkyAdapter extends BaseAdapter {
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
        MilkyAdapterMap.set(this.botId, this)
        registerBot(this)
    }

    public async connect(): Promise<void> {
        this.stopped = false
        const mode = (this.cfg.mode as MilkyConnectMode) ?? "ws"
        if (mode === "ws_reverse") {
            this.startWsServer()
        } else if (mode === "http") {
            this.startHttpServer()
        } else {
            await this.startWsClient()
        }
    }

    // 正向 WS：客户端连接 Milky 服务端的事件 WS
    private async startWsClient(): Promise<void> {
        const port = this.cfg.port ?? 3000
        const token = this.cfg.token ?? ""
        const cfgPath = this.cfg.path ?? "/event"
        const host = this.cfg.host ?? "127.0.0.1"
        const wsUrl = new URL(`ws://${host}`)
        wsUrl.port = String(port)
        wsUrl.pathname = cfgPath
        if (token) wsUrl.searchParams.set("token", token)
        const fullWsUrl = wsUrl.toString()

        console.log(`[${this.botId}] 事件WS连接地址：${fullWsUrl}`)
        const ws = new WebSocket(fullWsUrl)
        this.ws = ws

        setTimeout(() => this.bindWs(), 100)

        ws.on("open", () => {
            this.connected = true
            console.log(`✅ [${this.botId}] /event WS 事件通道连接成功`)
        })
        ws.on("close", (code, reason) => {
            if (this.stopped) return
            console.log(`[${this.botId}] WS关闭 code:${code} ${reason}`)
            this.connected = false
            this.reconnect()
        })
        ws.on("error", () => {
            console.log(`[${this.botId}] WS连接失败，请确认Milky服务已启动`)
        })
    }

    // 反向 WS：本地起 WS 服务器，等 Milky 服务端连进来
    private startWsServer(): void {
        if (this.wss) {
            this.wss.close(() => {
                console.log(`[${this.botId}] 旧WS服务已关闭，释放端口`)
            })
        }
        const wss = new WebSocketServer({ port: this.cfg.port ?? 3000 })
        this.wss = wss

        wss.on("connection", (ws, req) => {
            const url = req.url ?? ""
            const reqPath = url.split("?")[0]
            if (this.cfg.path && reqPath !== this.cfg.path) {
                return ws.close(1008, "path not match")
            }
            const queryToken = new URL(url, "http://x").searchParams.get("token")
            if (this.cfg.token && queryToken !== this.cfg.token) {
                return ws.close(1008, "token invalid")
            }
            this.ws = ws
            this.connected = true
            this.bindWs()
            console.log(`✅ [${this.botId}] 反向WS客户端连接成功`)
        })

        wss.on("error", (err) => {
            console.error(`[${this.botId}] WS服务监听异常：`, err)
        })

        console.log(`[${this.botId}] 反向WS监听 | 端口:${this.cfg.port ?? 3000} 路径:${this.cfg.path ?? "/event"}`)
    }

    // HTTP(webhook) 模式：本地起 HTTP 服务接收 Milky 事件上报
    private startHttpServer(): void {
        const path = this.cfg.path ?? "/event"
        const port = this.cfg.port ?? 3001
        const server = http.createServer((req, res) => {
            if (req.method === "POST" && (path === "/" || req.url === path)) {
                let body = ""
                req.on("data", (c) => (body += c))
                req.on("end", () => {
                    try {
                        const json = JSON.parse(body)
                        convertMilkyEvent(json, this.botId)
                    } catch (err) {
                        console.error(`[${this.botId}] 解析 HTTP 事件失败：`, err)
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
            console.log(`✅ [${this.botId}] HTTP(webhook) 监听 | 端口:${port} 路径:${path}`)
        })
        this.httpServer = server
    }

    public async disconnect(): Promise<void> {
        this.stopped = true
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = undefined
        }
        if (this.ws) {
            this.ws.close(1000, "程序退出")
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

    private bindWs(): void {
        if (!this.ws) return
        this.ws.on("message", (buf) => {
            try {
                const text = buf.toString()
                const json = JSON.parse(text) as MilkyRawEvent
                convertMilkyEvent(json, this.botId)
            } catch (e) {
                console.error(`[${this.botId}] 事件报文解析失败`, e)
            }
        })
    }

    private reconnect(): void {
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
        console.log(`[${this.botId}] 30秒后自动重连事件WS`)
        this.reconnectTimer = setTimeout(() => {
            this.connect().catch(e => console.error(`[${this.botId}] 重连失败:`, e))
        }, 30000)
    }

  // 会话粒度能力：Milky 服务端按 OneBot 风格解析消息段，原生支持全量消息段；
  // 群聊拥有禁言/踢出能力，私聊没有。
    computeCapabilities(event: BotEvent): Readonly<Capabilities> {
        const isGroup = !!event.groupId && String(event.groupId) !== "undefined" && String(event.groupId) !== "0"
        return {
            text: true, image: true, video: true, record: true, file: true,
            markdown: true, button: true, at: true, reply: true, face: true,
            forward: true, json: true,
            canMuteMember: isGroup,
            canKickMember: isGroup,
        }
    }

    public async callApi<T = any>(action: string, params: Record<string, any> = {}): Promise<T> {
        const port = this.cfg.port ?? 3000
        const token = this.cfg.token ?? ""
        const baseUrl = new URL("http://127.0.0.1")
        baseUrl.port = String(port)

        let targetApi = action
        const reqParams = { ...params }

        if (action === "send_msg") {
            if (reqParams.group_id) {
                targetApi = "send_group"
                reqParams.gid = reqParams.group_id
                delete reqParams.group_id
            } else if (reqParams.user_id) {
                targetApi = "send_private"
                reqParams.uid = reqParams.user_id
                delete reqParams.user_id
            }
        }

        baseUrl.pathname = `/api/${targetApi}`
        const fullApiUrl = baseUrl.toString()

        const echo = randomUUID()
        const body = { echo, params: reqParams }
        const headers: Record<string, string> = { "Content-Type": "application/json" }
        if (token) headers.Authorization = `Bearer ${token}`

        const res = await fetch(fullApiUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(8000),
        })

        const rawText = await res.text()

        if (res.status === 404) {
            throw new Error(`Milky接口404：不存在接口 /api/${targetApi}，确认Milky已开启EnabledHttp并重启`)
        }

        let ret: any
        try {
            ret = JSON.parse(rawText)
        } catch {
            throw new Error(`Milky API返回非JSON内容：${rawText}`)
        }

        if (ret.retcode !== 0) {
            throw new Error(`Milky接口调用失败 retcode:${ret.retcode} 提示:${ret.message ?? "无"}`)
        }
        return ret.data as T
    }

    public async destroy(): Promise<void> {
        await this.disconnect()
        MilkyAdapterMap.delete(this.botId)
    }
}

export function getMilkyAdapterById(botId: string): MilkyAdapter | undefined {
    return MilkyAdapterMap.get(botId)
}
