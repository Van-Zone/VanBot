import http from "node:http"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { BaseAdapter } from "../base.js"
import { registerBot } from "../../core/botRegistry.js"
import type { BotEvent } from "../../core/models/event.js"
import type { Capabilities } from "../../core/capabilities.js"
import { normalizeSegments, segmentsToText } from "../../core/messageUtils.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

// sandbox 模拟环境中的一条消息（网页轮询拉取）
export interface SandboxMsg {
  seq: number
  scene: "group" | "private"
  groupId: string
  userId: string
  role: "user" | "bot"
  name: string
  text: string
  time: number
}

// 会话 key：群聊 group:<gid>，私聊 private:<uid>
function sessionKey(scene: "group" | "private", groupId: string, userId: string): string {
  return scene === "group" ? `group:${groupId}` : `private:${userId}`
}


// Sandbox 适配器：用户通过网页访问，在网页上模拟群聊/私聊场景，
// 消息走框架插件管线处理，机器人回复实时显示在网页。
export class SandboxAdapter extends BaseAdapter {
  public readonly botId: string
  private readonly cfg: Record<string, any>
  private httpServer?: http.Server
  // 机器人自身 ID / 昵称（网页上显示）
  private readonly selfName: string
  // 消息历史（内存，重启即清空）
  private history: SandboxMsg[] = []
  private seq = 0
  // 页面 HTML（首次读取后缓存）
  private webHtml?: string

  constructor(config: Record<string, any>) {
    super()
    this.cfg = config
    this.botId = config.botId
    this.selfName = String(config.selfName ?? "Bot")
    // sandbox 机器人在场景中的协议 ID
    this.selfId = String(config.selfId ?? config.botId ?? "sandbox")
    registerBot(this)
  }

  public async connect(): Promise<void> {
    const port = Number(this.cfg.port ?? 8800)
    const server = http.createServer((req, res) => this.handleHttp(req, res))
    server.on("error", (err) => {
      console.error(`[${this.botId}] 网页服务异常：${(err as Error).message}`)
      this.connected = false
    })
    await new Promise<void>((resolve) => server.listen(port, resolve))
    this.httpServer = server
    this.connected = true
    console.log(`✅ [${this.botId}] 模拟环境网页已启动: http://127.0.0.1:${port}`)
  }

  public async disconnect(): Promise<void> {
    this.connected = false
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer?.close(() => resolve()))
      this.httpServer = undefined
    }
  }

  // 会话粒度能力：sandbox 模拟环境，群聊拥有全员管理能力，私聊没有
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

  // 模拟 API：发送类写入页面消息流；其余返回基础 mock
  public async callApi<T = any>(action: string, params: Record<string, any> = {}): Promise<T> {
    if (action === "send_msg" || action === "send_group_msg" || action === "send_private_msg") {
      let scene: "group" | "private"
      let gid = ""
      let uid = ""
      if (action === "send_group_msg" || params.group_id) {
        scene = "group"
        gid = String(params.group_id ?? "")
      } else if (action === "send_private_msg" || params.user_id) {
        scene = "private"
        uid = String(params.user_id ?? "")
      } else {
        throw new Error(`[${this.botId}] ${action} 缺少目标 group_id/user_id`)
      }
      this.pushMsg(scene, gid, uid, "bot", this.selfName, segmentsToText(normalizeSegments(params.message)))
      this.stats.sent++
      return { message_id: `sb_${Date.now()}_${this.seq}` } as T
    }
    if (action === "get_login_info") {
      return { user_id: Number(this.selfId) || 0, nickname: this.selfName } as T
    }
    // 其余 API：sandbox 环境模拟成功
    return { status: "ok", data: {} } as T
  }

  // 追加一条消息到历史（网页轮询可见）
  private pushMsg(scene: "group" | "private", groupId: string, userId: string, role: "user" | "bot", name: string, text: string): void {
    this.history.push({
      seq: ++this.seq,
      scene,
      groupId,
      userId,
      role,
      name,
      text,
      time: Math.floor(Date.now() / 1000),
    })
    // 防止无限增长
    if (this.history.length > 5000) this.history = this.history.slice(-3000)
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = (req.url ?? "/").split("?")[0]
    try {
      if (req.method === "GET" && (url === "/" || url === "/index.html")) {
        if (!this.webHtml) {
          this.webHtml = await readFile(join(__dirname, "web.html"), "utf8")
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        res.end(this.webHtml)
        return
      }
      if (req.method === "GET" && url === "/api/state") {
        const since = Number(new URL(req.url ?? "/", "http://x").searchParams.get("since") ?? 0)
        const fresh = this.history.filter((m) => m.seq > since)
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
        res.end(JSON.stringify({ seq: this.seq, selfName: this.selfName, messages: fresh }))
        return
      }
      if (req.method === "POST" && url === "/api/send") {
        const body = await this.readBody(req)
        const p = typeof body === "string" ? JSON.parse(body) : body
        const scene: "group" | "private" = p.scene === "private" ? "private" : "group"
        const gid = String(p.groupId ?? "10001")
        const uid = String(p.userId ?? (scene === "group" ? `u_${Math.random().toString(36).slice(2, 8)}` : "10086"))
        const name = String(p.name ?? uid)
        const text = String(p.text ?? "")
        if (!text) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" })
          res.end(JSON.stringify({ error: "text 为空" }))
          return
        }
        this.pushMsg(scene, gid, uid, "user", name, text)
        // 构造框架事件，进入插件管线
        const event: BotEvent = {
          botId: this.botId,
          selfId: this.selfId,
          userId: uid,
          groupId: scene === "group" ? gid : undefined,
          message: [{ type: "text", data: { text } }],
          postType: scene === "group" ? "group_message" : "private_message",
          raw: { time: Math.floor(Date.now() / 1000) },
        }
        this.emitEvent(event.postType, event)
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" })
        res.end(JSON.stringify({ ok: true, seq: this.seq }))
        return
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
      res.end("Not Found")
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" })
      res.end(JSON.stringify({ error: (err as Error).message }))
    }
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = ""
      req.on("data", (c) => (body += c))
      req.on("end", () => resolve(body))
      req.on("error", reject)
    })
  }

  public async destroy(): Promise<void> {
    await this.disconnect()
  }
}
