import WebSocket, { WebSocketServer } from "ws"
import http from "http"
import { BaseAdapter } from "../base.js"
import { convertSatoriEvent, segmentsToSatoriContent } from "./converter.js"
import type { SatoriEvent, SatoriOpCode, SatoriWsFrame } from "./types.js"
import { normalizeSegments } from "../../core/messageUtils.js"
import { registerBot } from "../../core/botRegistry.js"
import type { Capabilities } from "../../core/capabilities.js"
import type { BotEvent } from "../../core/models/event.js"

export type SatoriConnectMode = "ws" | "ws_reverse" | "http"

export const SatoriAdapterMap = new Map<string, SatoriAdapter>()

export class SatoriAdapter extends BaseAdapter {
    public readonly botId: string
    private readonly cfg: Record<string, any>
    private ws?: WebSocket
    private wss?: WebSocketServer
    private httpServer?: http.Server
    private reconnectTimer?: NodeJS.Timeout
    // 主动断开标志：disconnect 后 close 事件不再触发自动重连
    private stopped = false
    private heartbeatTimer?: NodeJS.Timeout
    private apiBaseUrl: string = ""

    constructor(config: Record<string, any>) {
        super()
        this.cfg = config
        this.botId = config.botId
        SatoriAdapterMap.set(this.botId, this)
        registerBot(this)
    }

    public async connect(): Promise<void> {
        this.stopped = false
        const mode = (this.cfg.mode as SatoriConnectMode) ?? "ws"
        if (mode === "ws_reverse") {
            this.startWsServer()
        } else if (mode === "http") {
            this.startHttpServer()
        } else {
            await this.startWsClient()
        }
    }

    private initApiBase(): string {
        const host = this.cfg.host ?? "127.0.0.1"
        const port = this.cfg.port ?? 5140
        this.apiBaseUrl = `http://${host}:${port}/v1`
        return this.apiBaseUrl
    }

    // 正向 WS：作为客户端连接 Satori 服务端
    private async startWsClient(): Promise<void> {
        const host = this.cfg.host ?? "127.0.0.1"
        const port = this.cfg.port ?? 5140
        const token = this.cfg.token ?? ""
        const path = this.cfg.path ?? "/v1/events"
        this.initApiBase()

        const wsUrl = new URL(`ws://${host}:${port}${path}`)
        console.log(`[${this.botId}] 连接地址：${wsUrl.toString()}`)
        const ws = new WebSocket(wsUrl.toString())
        this.ws = ws

        ws.on("open", () => {
            console.log(`✅ [${this.botId}] WebSocket 已连接，发送鉴权`)
            const identifyFrame: SatoriWsFrame = {
                op: 3 as SatoriOpCode,
                body: { token },
            }
            ws.send(JSON.stringify(identifyFrame))
        })

        this.bindWsEvents()
    }

    // 反向 WS：本地起 WS 服务器，等 Satori 服务端连进来
    private startWsServer(): void {
        this.initApiBase()
        if (this.wss) {
            this.wss.close(() => {
                console.log(`[${this.botId}] 旧WS服务已关闭，释放端口`)
            })
        }
        const wss = new WebSocketServer({ port: this.cfg.port ?? 5140 })
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
            this.bindWsEvents()
            console.log(`✅ [${this.botId}] 反向WS客户端连接成功`)
        })

        wss.on("error", (err) => {
            console.error(`[${this.botId}] WS服务监听异常：`, err)
        })

        console.log(`[${this.botId}] 反向WS监听 | 端口:${this.cfg.port ?? 5140} 路径:${this.cfg.path ?? "/v1/events"}`)
    }

    // HTTP(webhook) 模式：本地起 HTTP 服务接收 Satori 事件上报（POST /v1/events）
    private startHttpServer(): void {
        this.initApiBase()
        const path = this.cfg.path ?? "/v1/events"
        const port = this.cfg.port ?? 5141
        const server = http.createServer((req, res) => {
            if (req.method === "POST" && (path === "/" || req.url === path)) {
                let body = ""
                req.on("data", (c) => (body += c))
                req.on("end", () => {
                    try {
                        const event = JSON.parse(body) as SatoriEvent
                        convertSatoriEvent(event, this.botId)
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
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer)
            this.heartbeatTimer = undefined
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

    private bindWsEvents(): void {
        if (!this.ws) return

        this.ws.on("message", (buf) => {
            try {
                const frame: SatoriWsFrame = JSON.parse(buf.toString())
                this.handleWsFrame(frame)
            } catch (e) {
                console.error(`[${this.botId}] WS报文解析失败`, e)
            }
        })

        this.ws.on("close", (code) => {
            if (this.stopped) return
            console.log(`[${this.botId}] WS关闭 code:${code}，5秒后重连`)
            this.connected = false
            this.stopHeartbeat()
            this.reconnect()
        })

        this.ws.on("error", (err) => {
            console.error(`[${this.botId}] WS连接异常:`, err.message)
        })
    }

    private handleWsFrame(frame: SatoriWsFrame): void {
        switch (frame.op) {
            case 0: // EVENT
                if (frame.body) {
                    const event = frame.body as SatoriEvent
                    convertSatoriEvent(event, this.botId)
                }
                break
            case 1: // PING (服务端发心跳)
                // 回复 PONG
                if (this.ws?.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({ op: 2 }))
                }
                break
            case 2: // PONG
                // 收到心跳响应
                break
            case 3: // IDENTIFY（反向模式下客户端连入时发送鉴权）
                this.connected = true
                console.log(`✅ [${this.botId}] 收到鉴权，就绪`)
                if (this.ws?.readyState === WebSocket.OPEN) {
                    // 回复 READY
                    this.ws.send(
                        JSON.stringify({
                            op: 4,
                            body: { logins: [{ self_id: String(this.cfg.selfId ?? this.botId), platform: this.cfg.platform ?? "satori" }] },
                        })
                    )
                }
                this.startHeartbeat()
                break
            case 4: // READY
                this.connected = true
                console.log(`✅ [${this.botId}] 鉴权成功，就绪`)
                if (frame.body?.logins) {
                    const logins = frame.body.logins as Array<{ self_id: string; platform: string }>
                    logins.forEach(l => {
                        console.log(`  登录账号: platform=${l.platform} self_id=${l.self_id}`)
                    })
                }
                this.startHeartbeat()
                break
            default:
                console.log(`[${this.botId}] 未知 op: ${frame.op}`)
        }
    }

    private startHeartbeat(): void {
        this.stopHeartbeat()
        this.heartbeatTimer = setInterval(() => {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ op: 1 })) // PING
            }
        }, 15000) // 15秒心跳
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
            this.connect().catch(e => console.error(`[${this.botId}] 重连失败:`, e))
        }, 5000)
    }

  // API 调用
  // 调用 Satori API
  // 标准方式: HTTP POST /v1/{action}
  // 会话粒度能力：Satori 原生支持富媒体/markdown/at/reply/forward/face；
  // 群聊支持禁言/踢出（mapAction 已映射 guild.member.mute/kick）；按钮不原生支持。
    computeCapabilities(event: BotEvent): Readonly<Capabilities> {
        const isGroup = !!event.groupId && String(event.groupId) !== "undefined" && String(event.groupId) !== "0"
        return {
            text: true, image: true, video: true, record: true, file: true,
            markdown: true, at: true, reply: true, face: true, forward: true,
            button: false,
            canMuteMember: isGroup,
            canKickMember: isGroup,
        }
    }

    public async callApi<T = any>(action: string, params: Record<string, any> = {}): Promise<T> {
        const token = this.cfg.token ?? ""

        // 兼容 OneBot 风格的 action 名称，映射到 Satori
        const satoriAction = this.mapAction(action)
        const satoriParams = this.mapParams(action, params)

        const url = `${this.apiBaseUrl}/${satoriAction}`
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
        }
        if (token) headers.Authorization = `Bearer ${token}`

        const res = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(satoriParams),
            signal: AbortSignal.timeout(10000),
        })

        const rawText = await res.text()
        if (!res.ok) {
            throw new Error(`Satori API ${satoriAction} 失败: HTTP ${res.status} ${rawText}`)
        }

        let ret: any
        try {
            ret = JSON.parse(rawText)
        } catch {
            return rawText as unknown as T
        }

        // Satori 标准返回直接是 data，部分实现包裹一层
        if (ret && ret.data !== undefined) return ret.data as T
        return ret as T
    }

    // OneBot action → Satori action 映射
    private mapAction(action: string): string {
        const map: Record<string, string> = {
            "send_msg": "message.create",
            "send_group_msg": "message.create",
            "send_private_msg": "message.create",
            "delete_msg": "message.delete",
            "get_msg": "message.get",
            "get_group_member_list": "guild.member.list",
            "get_group_member_info": "guild.member.get",
            "get_group_list": "guild.list",
            "set_group_kick": "guild.member.kick",
            "set_group_ban": "guild.member.mute",
            "set_group_whole_ban": "guild.member.mute",
        }
        return map[action] ?? action
    }

    // OneBot params → Satori params 映射
    private mapParams(action: string, params: Record<string, any>): Record<string, any> {
        const result: Record<string, any> = { ...params }

        // 发送消息：转换消息格式 + 映射 ID
        if (action === "send_msg" || action === "send_group_msg" || action === "send_private_msg") {
            // channel_id 优先，其次 group_id / user_id
            if (params.channel_id) {
                result.channel_id = params.channel_id
            } else if (params.group_id) {
                result.channel_id = String(params.group_id)
            } else if (params.user_id) {
                // 私信需要 user_id，Satori 用 channel_id 或 direct message
                result.user_id = String(params.user_id)
            }
            delete result.group_id
            delete result.user_id

            // 消息内容转换（字符串 / 段数组 / 单段对象 都兼容）
            const segs = normalizeSegments(params.message)
            if (segs.length === 1 && segs[0].type === "text" && typeof params.message === "string") {
                // 纯字符串原样保留（避免对 Satori 兼容文本做额外转义）
                result.content = params.message
            } else {
                result.content = segmentsToSatoriContent(segs)
            }
            delete result.message
        }

        // 撤回消息
        if (action === "delete_msg") {
            if (params.message_id) {
                result.message_id = String(params.message_id)
            }
        }

        return result
    }

    async sendGroupMsg(groupId: number | string, chain: any): Promise<any> {
        const content = Array.isArray(chain)
            ? segmentsToSatoriContent(chain)
            : String(chain)
        return this.callApi("message.create", {
            channel_id: String(groupId),
            content,
        })
    }

    async sendPrivateMsg(userId: number | string, chain: any): Promise<any> {
        const content = Array.isArray(chain)
            ? segmentsToSatoriContent(chain)
            : String(chain)
        return this.callApi("message.create", {
            user_id: String(userId),
            content,
        })
    }

    public async destroy(): Promise<void> {
        await this.disconnect()
        SatoriAdapterMap.delete(this.botId)
    }
}

export function getSatoriAdapterById(botId: string): SatoriAdapter | undefined {
    return SatoriAdapterMap.get(botId)
}
