import http from "http"
import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"
import { BaseAdapter } from "../base.js"
import { convertWechatEvent, parseWechatXml, buildPassiveReply } from "./converter.js"
import type { WechatRawPayload, WechatApiResp, WechatAccessTokenResp } from "./types.js"
import { normalizeSegments, segmentsToText } from "../../core/messageUtils.js"
import { registerBot } from "../../core/botRegistry.js"
import type { Capabilities } from "../../core/capabilities.js"
import type { BotEvent } from "../../core/models/event.js"

export const WechatAdapterMap = new Map<string, WechatAdapter>()

// 微信公众号 / 服务号 适配器
// 工作原理：
// 1. 启动 HTTP 服务器监听微信回调（服务器配置URL）
// 2. GET 请求：验证服务器地址（signature + echostr）
// 3. POST 请求：接收用户消息/事件，转换为框架统一事件派发
// 4. 发送消息：通过客服消息 API（需 access_token），用户48小时内交互过才能发送
// 5. 被动回复：在5秒内直接返回 XML 响应（可选，通过 callApi("passive_reply")）
// 配置项：
// botId       - 框架内标识
// type        - "wechat"
// appId       - 公众号 AppID
// appSecret   - 公众号 AppSecret
// token       - 服务器配置 Token
// port        - 回调监听端口
// path        - 回调路径，默认 /wechat/callback
// encodingAESKey - 消息加解密密钥（暂仅支持明文模式，留空即可）
// 被动回复模式下的缓冲条目
interface PassiveReplyEntry {
    userId: string
    text: string
    resolve: (text: string) => void
    timer: NodeJS.Timeout
}

export class WechatAdapter extends BaseAdapter {
    public readonly botId: string
    private readonly cfg: Record<string, any>
    private server?: http.Server
    private accessToken: string = ""
    private accessTokenExpireAt: number = 0
    // 存储待被动回复的内容（按 FromUserName 索引）
    private passiveReplyMap = new Map<string, string>()
    // 被动回复模式缓冲：capture 插件通过 callApi 产生的回复，等待窗口内返回给微信
    private passiveBuffer = new Map<string, PassiveReplyEntry>()

    constructor(config: Record<string, any>) {
        super()
        this.cfg = config
        this.botId = config.botId
        WechatAdapterMap.set(this.botId, this)
        registerBot(this)
    }

    public async connect(): Promise<void> {
        const port = this.cfg.port ?? 80
        const path = this.cfg.path ?? "/wechat/callback"
        const token = this.cfg.token ?? ""

        this.server = http.createServer((req, res) => {
            const reqUrl = new URL(req.url ?? "/", `http://localhost:${port}`)

            // 路径校验
            if (reqUrl.pathname !== path) {
                res.writeHead(404)
                res.end("Not Found")
                return
            }

            if (req.method === "GET") {
                // 服务器地址验证
                this.handleVerify(reqUrl, token, res)
            } else if (req.method === "POST") {
                // 接收消息
                this.handleMessage(req, res)
            } else {
                res.writeHead(405)
                res.end("Method Not Allowed")
            }
        })

        this.server.listen(port, () => {
            console.log(`✅ [${this.botId}] 回调服务已启动 | 端口:${port} 路径:${path}`)
            console.log(`   请在微信公众平台配置服务器地址：http://<你的域名>:${port}${path}`)
        })

        this.server.on("error", (err) => {
            console.error(`[${this.botId}] 回调服务异常：`, err)
        })

        this.connected = true

        // 预取 access_token
        this.refreshAccessToken().catch(e => console.warn(`[${this.botId}] 初始 access_token 获取失败：`, e.message))
    }

    public async disconnect(): Promise<void> {
        if (this.server) {
            this.server.close()
            this.server = undefined
        }
        this.connected = false
        console.log(`[${this.botId}] 回调服务已关闭`)
    }

  // 服务器地址验证（GET）
  // 微信发送 signature, timestamp, nonce, echostr
  // 校验通过后原样返回 echostr
    private handleVerify(reqUrl: URL, token: string, res: http.ServerResponse): void {
        const signature = reqUrl.searchParams.get("signature") ?? ""
        const timestamp = reqUrl.searchParams.get("timestamp") ?? ""
        const nonce = reqUrl.searchParams.get("nonce") ?? ""
        const echostr = reqUrl.searchParams.get("echostr") ?? ""

        const arr = [token, timestamp, nonce].sort()
        const calculated = createHash("sha1").update(arr.join("")).digest("hex")

        if (calculated === signature) {
            res.writeHead(200, { "Content-Type": "text/plain" })
            res.end(echostr)
            console.log(`[${this.botId}] 服务器地址验证通过`)
        } else {
            res.writeHead(403)
            res.end("Invalid signature")
            console.warn(`[${this.botId}] 服务器地址验证失败：签名不匹配`)
        }
    }

    // 接收消息（POST）
    private handleMessage(req: http.IncomingMessage, res: http.ServerResponse): void {
        let body = ""
        req.on("data", (chunk) => { body += chunk })
        req.on("end", async () => {
            try {
                const parsed = parseWechatXml(body) as unknown as WechatRawPayload
                const fromUser = parsed.FromUserName
                const toUser = parsed.ToUserName
                const isEvent = parsed.MsgType === "event"

                // 优先：插件通过 passive_reply 主动设置的被动回复
                const preset = this.passiveReplyMap.get(fromUser)
                if (preset) {
                    this.passiveReplyMap.delete(fromUser)
                    const replyXml = buildPassiveReply(fromUser, toUser, preset)
                    res.writeHead(200, { "Content-Type": "application/xml" })
                    res.end(replyXml)
                    return
                }

                // 被动回复模式：先注册回复缓冲，再派发事件；插件 callApi 发送时会被捕获
                let passivePromise: Promise<string> | undefined
                if (this.cfg.passiveMode && !isEvent) {
                    passivePromise = this.waitPassiveReply(fromUser)
                }

                // 转换并派发事件（插件异步处理）
                convertWechatEvent(parsed, this.botId, this)

                if (passivePromise) {
                    const replyText = await passivePromise
                    if (replyText) {
                        res.writeHead(200, { "Content-Type": "application/xml" })
                        res.end(buildPassiveReply(fromUser, toUser, replyText))
                    } else {
                        res.writeHead(200, { "Content-Type": "text/plain" })
                        res.end("")
                    }
                } else {
                    res.writeHead(200, { "Content-Type": "text/plain" })
                    res.end("")
                }
            } catch (err) {
                console.error(`[${this.botId}] 消息处理失败：`, err)
                res.writeHead(200, { "Content-Type": "text/plain" })
                res.end("")
            }
        })
    }

  // 等待插件在 passiveMode 下通过 callApi 产生的回复
  // 收到回复后经 debounce 尽快返回；最多等待 passiveTimeout（默认 4500ms，微信上限 5 秒）
    private waitPassiveReply(userId: string): Promise<string> {
        const hardTimeoutMs = this.cfg.passiveTimeout ?? 4500
        return new Promise<string>((resolve) => {
            const entry: PassiveReplyEntry = {
                userId,
                text: "",
                resolve,
                timer: undefined as unknown as NodeJS.Timeout,
            }
            entry.timer = setTimeout(() => this.finishPassive(entry), hardTimeoutMs)
            this.passiveBuffer.set(userId, entry)
        })
    }

    // 结束一条被动回复缓冲，返回累计文本
    private finishPassive(entry: PassiveReplyEntry): void {
        if (entry.timer) clearTimeout(entry.timer)
        if (this.passiveBuffer.get(entry.userId) === entry) this.passiveBuffer.delete(entry.userId)
        entry.resolve(entry.text)
    }

    // 捕获插件发送的文本作为被动回复，成功捕获返回 true
    private capturePassive(userId: string, text: string): boolean {
        const entry = this.passiveBuffer.get(userId)
        if (!entry) return false
        if (text) entry.text += (entry.text ? "\n" : "") + text
        // 重置 debounce 定时器：短时间无新发送则立即返回
        if (entry.timer) clearTimeout(entry.timer)
        entry.timer = setTimeout(() => this.finishPassive(entry), this.cfg.passiveDebounce ?? 200)
        return true
    }

  // 获取并缓存 access_token
  // 有效期 7200 秒，提前 300 秒刷新
    private async refreshAccessToken(): Promise<string> {
        const now = Date.now()
        if (this.accessToken && now < this.accessTokenExpireAt - 300000) {
            return this.accessToken
        }

        const appId = this.cfg.appId
        const appSecret = this.cfg.appSecret
        if (!appId || !appSecret) {
            throw new Error(`[${this.botId}] 缺少 appId 或 appSecret，无法获取 access_token`)
        }

        const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${appId}&secret=${appSecret}`
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
        const data = (await res.json()) as WechatAccessTokenResp & { errcode?: number; errmsg?: string }

        if (data.errcode) {
            throw new Error(`[${this.botId}] 获取 access_token 失败：${data.errmsg} (errcode:${data.errcode})`)
        }

        this.accessToken = data.access_token
        this.accessTokenExpireAt = now + data.expires_in * 1000
        console.log(`[${this.botId}] access_token 已刷新，有效期 ${data.expires_in} 秒`)
        return this.accessToken
    }

  // 调用微信 API
  // 支持的 action：
  // - send_private_msg / send_msg    : 发送客服消息（params: { user_id, message }）
  // - send_group_msg                 : 公众号无群，等同 send_private_msg
  // - passive_reply                  : 设置被动回复（params: { user_id, content }）
  // - template_send                  : 发送模板消息（params: 模板消息完整结构）
  // - user_info                      : 获取用户信息（params: { user_id }）
  // - 其他                           : 直接透传到微信 API（params 作为请求体）
  // 会话粒度能力：公众号仅客服消息 text/image/video/record/file；
  // 无群聊、无 at/reply/markdown/button/表情。
    computeCapabilities(_event: BotEvent): Readonly<Capabilities> {
        return {
            text: true, image: true, video: true, record: true, file: true,
            markdown: false, button: false, at: false, reply: false, face: false, forward: false,
        }
    }

    public async callApi<T = any>(action: string, params: Record<string, any> = {}): Promise<T> {
        // 被动回复：不调用 API，直接存入 map 等待回调响应
        if (action === "passive_reply") {
            const userId = params.user_id ?? params.touser
            const content = params.content ?? params.text ?? ""
            if (userId) this.passiveReplyMap.set(String(userId), String(content))
            return { errcode: 0, errmsg: "ok" } as T
        }

        // 发送消息：被动回复模式直接捕获，不依赖 access_token（未认证账号/非白名单 IP 也能用）
        if (action === "send_private_msg" || action === "send_msg" || action === "send_group_msg") {
            const userId = params.user_id ?? params.touser
            if (this.cfg.passiveMode && userId) {
                const text = segmentsToText(normalizeSegments(params.message ?? ""))
                if (this.capturePassive(String(userId), text)) {
                    return { errcode: 0, errmsg: "ok" } as T
                }
            }
        }

        const token = await this.refreshAccessToken()

        // 发送客服消息
        if (action === "send_private_msg" || action === "send_msg" || action === "send_group_msg") {
            return this.sendKfMessage(token, params) as Promise<T>
        }

        // 模板消息
        if (action === "template_send") {
            return this.postWechatApi(`https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${token}`, params) as Promise<T>
        }

        // 获取用户信息
        if (action === "user_info") {
            const userId = params.user_id ?? params.openid
            const url = `https://api.weixin.qq.com/cgi-bin/user/info?access_token=${token}&openid=${userId}&lang=zh_CN`
            const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
            return res.json() as Promise<T>
        }

        // 其他 action 透传：action 作为 API 路径
        const url = `https://api.weixin.qq.com/cgi-bin/${action}?access_token=${token}`
        return this.postWechatApi(url, params) as Promise<T>
    }

  // 发送客服消息
  // message 支持：
  // - 字符串（纯文本）
  // - 消息段数组（按顺序发送：文本合并发送，图片/语音/视频单独发送并自动上传素材）
  // - 直接作为消息体
    private async sendKfMessage(token: string, params: Record<string, any>): Promise<WechatApiResp> {
        const userId = params.user_id ?? params.touser
        if (!userId) throw new Error("缺少 user_id / touser 参数")

        const message = params.message
        // 兼容单段对象 {type,data}：包成数组走多段发送
        const msgForSend =
          typeof message === "string" || Array.isArray(message)
            ? message
            : message && typeof message === "object" && (message as any).type
              ? [message]
              : message
        const sendUrl = `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${token}`

        if (typeof msgForSend === "string") {
            // 纯文本
            return this.postWechatApi(sendUrl, {
                touser: String(userId),
                msgtype: "text",
                text: { content: msgForSend },
            })
        }

        if (Array.isArray(msgForSend)) {
            // 多段消息：文本累积合并，媒体单独发送（顺序保持）
            let textBuf = ""
            const flushText = async () => {
                if (textBuf) {
                    await this.postWechatApi(sendUrl, {
                        touser: String(userId),
                        msgtype: "text",
                        text: { content: textBuf },
                    })
                    textBuf = ""
                }
            }
            for (const seg of msgForSend) {
                if (!seg || typeof seg !== "object") continue
                if (seg.type === "text") {
                    textBuf += String(seg.data?.text ?? "")
                } else if (seg.type === "image" || seg.type === "record" || seg.type === "voice" || seg.type === "video") {
                    await flushText()
                    await this.sendKfMedia(sendUrl, userId, seg)
                } else {
                    // at/face 等微信客服消息不支持，取文本属性保留
                    textBuf += String(seg.data?.text ?? seg.data?.content ?? "")
                }
            }
            await flushText()
            return { errcode: 0, errmsg: "ok" } as WechatApiResp
        }

        // 直接作为消息体
        return this.postWechatApi(sendUrl, { touser: String(userId), ...message })
    }

  // 发送单条媒体客服消息（图片/语音/视频）
  // 优先使用已有的 media_id；没有则尝试从 base64:// / file:// / http(s):// 上传素材
    private async sendKfMedia(sendUrl: string, userId: string | number, seg: Record<string, any>): Promise<WechatApiResp> {
        const data = seg.data ?? {}
        const file = String(data.file ?? "")
        const url = String(data.url ?? "")

        // 1) 已有 media_id 直接用
        let media_id = data.media_id ?? ""
        if (!media_id && /^[a-f0-9]{32,}$/i.test(file)) {
            // 微信 media_id 一般是长 hex 字符串（接收到的图片/语音消息 file 就是 media_id）
            media_id = file
        }

        // 2) 尝试上传素材获取 media_id
        if (!media_id) {
            try {
                const media = await this.getMediaBuffer(seg)
                if (media) {
                    media_id = await this.uploadMedia(seg.type, media.buf, media.ext)
                }
            } catch (err) {
                console.warn(`[${this.botId}] 媒体素材上传失败:`, (err as Error).message)
            }
        }

        if (!media_id) {
            // 无法发送媒体，发文字占位
            return this.postWechatApi(sendUrl, {
                touser: String(userId),
                msgtype: "text",
                text: { content: `[${seg.type}]` },
            })
        }

        if (seg.type === "video") {
            return this.postWechatApi(sendUrl, {
                touser: String(userId),
                msgtype: "video",
                video: {
                    media_id,
                    thumb_media_id: data.thumb_media_id ?? data.thumbMediaId ?? "",
                    title: data.title ?? "",
                    description: data.description ?? "",
                },
            })
        }

        const msgtype = seg.type === "record" || seg.type === "voice" ? "voice" : "image"
        return this.postWechatApi(sendUrl, {
            touser: String(userId),
            msgtype,
            [msgtype]: { media_id },
        })
    }

    // 从消息段中取出媒体二进制与扩展名
    private async getMediaBuffer(seg: Record<string, any>): Promise<{ buf: Buffer; ext: string } | null> {
        const data = seg.data ?? {}
        let source = String(data.url ?? data.file ?? "")
        if (!source) return null

        // base64:// 内嵌
        if (source.startsWith("base64://")) {
            const b64 = source.slice("base64://".length)
            return { buf: Buffer.from(b64, "base64"), ext: this.guessExt(source, seg.type) }
        }

        // file:// 本地文件
        if (source.startsWith("file://")) {
            let filePath = decodeURIComponent(source.replace(/^file:\/\//, ""))
            if (/^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.slice(1)
            const buf = await fs.readFile(filePath)
            return { buf, ext: path.extname(filePath).slice(1) || this.guessExt("", seg.type) }
        }

        // http(s):// 网络图片
        if (/^https?:\/\//.test(source)) {
            const res = await fetch(source, {
                headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36" },
                signal: AbortSignal.timeout(15000),
            })
            if (!res.ok) return null
            const buf = Buffer.from(await res.arrayBuffer())
            const ct = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
            const extMap: Record<string, string> = {
                "image/jpeg": "jpg",
                "image/png": "png",
                "image/gif": "gif",
                "image/webp": "webp",
                "audio/mpeg": "mp3",
                "audio/amr": "amr",
                "audio/wav": "wav",
                "video/mp4": "mp4",
            }
            return { buf, ext: extMap[ct] ?? "jpg" }
        }
        return null
    }

    // 上传永久/临时素材（临时素材 media/upload），返回 media_id
    private async uploadMedia(type: string, buf: Buffer, ext: string): Promise<string> {
        const token = await this.refreshAccessToken()
        const apiType = type === "record" || type === "voice" ? "voice" : type === "video" ? "video" : "image"
        const uploadUrl = `https://api.weixin.qq.com/cgi-bin/media/upload?access_token=${token}&type=${apiType}`

        const mimeMap: Record<string, string> = {
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            png: "image/png",
            gif: "image/gif",
            webp: "image/webp",
            bmp: "image/bmp",
            mp3: "audio/mpeg",
            amr: "audio/amr",
            wav: "audio/wav",
            mp4: "video/mp4",
        }
        const mime = mimeMap[ext.toLowerCase()] ?? "application/octet-stream"
        const filename = `upload_${Date.now()}.${ext || "jpg"}`

        // 用 Node 原生 fetch + FormData（Node 18+ 全局可用），避免 node-fetch 的 multipart 兼容问题
        const form = new FormData()
        form.append("media", new Blob([new Uint8Array(buf)], { type: mime }), filename)

        const res = await fetch(uploadUrl, {
            method: "POST",
            body: form,
            signal: AbortSignal.timeout(20000),
        })
        const data = (await res.json()) as any
        if (data.errcode && data.errcode !== 0) {
            throw new Error(`上传素材失败: ${data.errmsg} (errcode:${data.errcode})`)
        }
        return data.media_id
    }

    // 根据 URL 或段类型猜测扩展名
    private guessExt(source: string, type: string): string {
        const m = /\.(\w{2,4})(?:[?#]|$)/.exec(source)
        if (m) return m[1].toLowerCase()
        if (type === "voice" || type === "record") return "mp3"
        if (type === "video") return "mp4"
        return "jpg"
    }

    // POST 微信 API 通用方法
    private async postWechatApi(url: string, body: Record<string, any>): Promise<WechatApiResp> {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(10000),
        })
        const data = (await res.json()) as WechatApiResp
        if (data.errcode && data.errcode !== 0) {
            throw new Error(`微信API错误：${data.errmsg} (errcode:${data.errcode})`)
        }
        return data
    }

    // 重写发送私聊消息（公众号全部是私聊）
    public async sendPrivateMsg(userId: number | string, chain: any): Promise<any> {
        return this.callApi("send_private_msg", { user_id: userId, message: chain })
    }

    // 公众号无群聊，sendGroupMsg 等同 sendPrivateMsg
    public async sendGroupMsg(groupId: number | string, chain: any): Promise<any> {
        return this.callApi("send_private_msg", { user_id: groupId, message: chain })
    }

    public async destroy(): Promise<void> {
        await this.disconnect()
        WechatAdapterMap.delete(this.botId)
        super.destroy()
    }
}

export function getWechatAdapterById(botId: string): WechatAdapter | undefined {
    return WechatAdapterMap.get(botId)
}
