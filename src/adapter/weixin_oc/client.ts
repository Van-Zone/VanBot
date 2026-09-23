import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto"
import { readFile, writeFile, mkdir, access } from "node:fs/promises"
import { resolve, join, extname } from "node:path"
import { BaseAdapter } from "../base.js"
import { convertWxMessage } from "./converter.js"
import type {
  WeixinOcConfig,
  WeixinMessage,
  CDNMedia,
  GetUpdatesResp,
  SendMessageResp,
  QRCodeResponse,
  QRStatusResponse,
  GetUploadUrlResp,
  WeixinOcCredential,
} from "./types.js"
import { registerBot } from "../../core/botRegistry.js"
import { normalizeSegments, segmentsToText } from "../../core/messageUtils.js"
import type { MessageChain } from "../../core/models/message.js"
import type { Capabilities } from "../../core/capabilities.js"
import type { BotEvent } from "../../core/models/event.js"

export const WeixinOcAdapterMap = new Map<string, WeixinOcAdapter>()

// 固定接口地址（二维码/状态轮询）
const FIXED_BASE_URL = "https://ilinkai.weixin.qq.com"
// CDN 上传/下载地址
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c"
const BOT_TYPE = "3"
const CHANNEL_VERSION = "1.0.3"
const QR_LOGIN_TIMEOUT_MS = 480_000

function randomWechatUin(): string {
  const u32 = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(u32), "utf-8").toString("base64")
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  }
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`
  return headers
}

function aesEcbPaddedSize(n: number): number {
  return Math.ceil((n + 1) / 16) * 16
}

// 生成 CDN 下载 URL
function buildCdnDownloadUrl(param: string): string {
  return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(param)}`
}

// 生成 CDN 上传 URL（服务端未返回 upload_full_url 时兜底）
function buildCdnUploadUrl(uploadParam: string, filekey: string): string {
  return `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`
}

// 个人微信适配器（openclaw-weixin / 腾讯 iLink 官方协议）
// 原理：
// 1. 首次连接：扫码登录（get_bot_qrcode → 轮询 get_qrcode_status → confirmed 拿 bot_token + baseurl）
// 凭证自动保存到 data/weixin_oc_<botId>.json，后续免扫码
// 2. 接收：POST /ilink/bot/getupdates 长轮询（35s），游标 get_updates_buf 防重
// 3. 发送：POST /ilink/bot/sendmessage，必须带 context_token 才能关联对话窗口
// 4. 媒体：图片/视频/文件发送需 AES-128-ECB 加密上传 CDN；接收时下载并解密到本地
// 配置项：
// botId      - 框架内标识
// type       - "weixin_oc"
// baseUrl    - 可选，接口地址（扫码登录成功后自动回填；也可从 OpenClaw 登录态导出手动填）
// token      - 可选，bot_token（同上）
// longPollTimeoutMs - 长轮询超时（毫秒），默认 35000
// apiTimeoutMs      - API 超时（毫秒），默认 15000
// ignoreSelf - 忽略机器人自己的消息，默认 true
// 注意：
// - 需要手机微信版本 iOS>=8.0.70 / Android>=8.0.69，且微信内有 ClawBot 插件
// - 消息不带昵称（个人微信协议限制）
// - 语音发送不受支持，会降级为文本
export class WeixinOcAdapter extends BaseAdapter {
  public readonly botId: string
  private readonly cfg: WeixinOcConfig
  private running: boolean = false
  private baseUrl: string = FIXED_BASE_URL
  private token: string = ""
  private getUpdatesBuf: string = ""
  private pollingBaseUrl: string = FIXED_BASE_URL
  // 会话上下文令牌缓存：userId → context_token
  private readonly contextTokens = new Map<string, string>()
  private readonly dataDir: string

  // 会话粒度能力：个人微信可发 text/image/video/file；
  // 语音发送不支持（降级文本）、无 at/reply/markdown/button/表情；仅私聊（无群）。
  computeCapabilities(_event: BotEvent): Readonly<Capabilities> {
    return {
      text: true, image: true, video: true, file: true,
      record: false, audio: false,
      markdown: false, button: false, at: false, reply: false, face: false, forward: false,
    }
  }

  constructor(config: WeixinOcConfig) {
    super()
    this.cfg = config
    this.botId = config.botId
    this.dataDir = resolve(this.cfg.qrSaveDir ?? "./data")
    WeixinOcAdapterMap.set(this.botId, this)
    registerBot(this)
  }

  // 连接

  public async connect(): Promise<void> {
    // 1) 配置里已带凭证
    if (this.cfg.baseUrl && this.cfg.token) {
      this.baseUrl = this.cfg.baseUrl
      this.token = this.cfg.token
      this.selfId = this.cfg.selfId ? String(this.cfg.selfId) : this.cfg.botId
    }
    // 2) 从本地凭证文件恢复
    else {
      const cred = await this.loadCredential()
      if (cred?.baseUrl && cred.token) {
        this.baseUrl = cred.baseUrl
        this.token = cred.token
        this.selfId = cred.selfId || this.cfg.botId
        console.log(`[${this.botId}] 已从本地凭证恢复登录态`)
      }
      // 3) 扫码登录
      else if (this.cfg.qrLogin !== false) {
        await this.loginByQr()
      } else {
        throw new Error(`[${this.botId}] 未配置 token/baseUrl，且 qrLogin 已关闭`)
      }
    }

    if (!this.token) {
      throw new Error(`[${this.botId}] 登录失败：未获取到 bot_token`)
    }

    this.running = true
    this.connected = true
    console.log(`✅ [${this.botId}] 已连接 (baseUrl=${this.baseUrl})`)
    // 启动长轮询（不阻塞 connect 返回）
    this.poll().catch((e) => console.error(`[${this.botId}] 轮询异常:`, e))
  }

  public async disconnect(): Promise<void> {
    this.running = false
    this.connected = false
    console.log(`[${this.botId}] 已停止轮询`)
  }

  // 扫码登录

  private async loginByQr(): Promise<void> {
    console.log(`[${this.botId}] 开始扫码登录个人微信...`)
    // 1) 申请二维码
    let qr: QRCodeResponse
    try {
      qr = await this.apiPost<QRCodeResponse>(
        FIXED_BASE_URL,
        `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`,
        { local_token_list: [] },
        undefined,
        15000,
      )
    } catch (err: any) {
      throw new Error(`[${this.botId}] 申请登录二维码失败: ${err?.message ?? err}`)
    }
    const qrcode = qr.qrcode
    const qrUrl = qr.qrcode_img_content
    if (!qrcode || !qrUrl) {
      throw new Error(`[${this.botId}] 二维码响应缺少 qrcode / qrcode_img_content`)
    }

    // 2) 生成二维码图片 + 打印链接
    await mkdir(this.dataDir, { recursive: true })
    const qrPng = join(this.dataDir, `qrcode_${this.botId}.png`)
    try {
      const QRCode = (await import("qrcode")).default
      await QRCode.toFile(qrPng, qrUrl, { width: 320, margin: 1 })
      console.log(`📱 [${this.botId}] 请用手机微信扫码登录（微信需含 ClawBot 插件，版本 iOS>=8.0.70 / Android>=8.0.69）`)
      console.log(`📱 [${this.botId}] 二维码图片已保存: ${qrPng}`)
    } catch {
      console.log(`📱 [${this.botId}] 请打开以下链接用二维码工具生成二维码后扫码:`)
    }
    console.log(`📱 [${this.botId}] 扫码链接: ${qrUrl}`)

    // 3) 长轮询扫码状态
    let pollingBase = FIXED_BASE_URL
    const deadline = Date.now() + QR_LOGIN_TIMEOUT_MS
    let verifyCode: string | undefined

    while (Date.now() < deadline) {
      let statusResp: QRStatusResponse
      try {
        statusResp = await this.apiGet<QRStatusResponse>(
          pollingBase,
          `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}${verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : ""}`,
          35000,
        )
      } catch {
        // 长轮询超时 / 网关错误 → 继续等
        await this.sleep(1000)
        continue
      }

      switch (statusResp.status) {
        case "wait":
          break
        case "scaned":
          console.log(`[${this.botId}] 已扫码，正在确认...`)
          break
        case "need_verifycode": {
          const code = await this.readStdinLine(
            `[${this.botId}] 请输入手机微信上显示的数字：`,
          )
          verifyCode = code
          continue
        }
        case "scaned_but_redirect": {
          if (statusResp.redirect_host) {
            pollingBase = `https://${statusResp.redirect_host}`
            console.log(`[${this.botId}] 切换到轮询地址: ${pollingBase}`)
          }
          break
        }
        case "confirmed": {
          if (!statusResp.bot_token || !statusResp.baseurl) {
            throw new Error(`[${this.botId}] 登录确认但缺少 bot_token/baseurl`)
          }
          this.token = statusResp.bot_token
          this.baseUrl = statusResp.baseurl
          this.selfId = statusResp.ilink_bot_id || this.cfg.botId
          await this.saveCredential(statusResp)
          console.log(`✅ [${this.botId}] 扫码登录成功 (selfId=${this.selfId})`)
          return
        }
        case "expired":
        case "verify_code_blocked":
          throw new Error(`[${this.botId}] 二维码已失效/多次输入错误（${statusResp.status}），请重新启动以重新生成二维码`)
        case "binded_redirect":
          console.log(`[${this.botId}] 检测到该微信已绑定，若本地无凭证请手动在 config 填 baseUrl+token`)
          break
        default:
          break
      }
      await this.sleep(1000)
    }
    throw new Error(`[${this.botId}] 扫码登录超时，请重试`)
  }

  private readStdinLine(prompt: string): Promise<string> {
    return new Promise((resolveFn) => {
      process.stdout.write(prompt)
      let input = ""
      const onData = (chunk: Buffer | string) => {
        input += chunk.toString()
        if (input.includes("\n")) {
          process.stdin.removeListener("data", onData)
          process.stdin.pause()
          resolveFn(input.trim())
        }
      }
      process.stdin.resume()
      process.stdin.setEncoding("utf-8")
      process.stdin.on("data", onData)
    })
  }

  // 凭证持久化

  private credentialPath(): string {
    return join(this.dataDir, `weixin_oc_${this.botId}.json`)
  }

  private async loadCredential(): Promise<WeixinOcCredential | null> {
    try {
      const raw = await readFile(this.credentialPath(), "utf-8")
      return JSON.parse(raw) as WeixinOcCredential
    } catch {
      return null
    }
  }

  private async saveCredential(status: QRStatusResponse): Promise<void> {
    await mkdir(this.dataDir, { recursive: true })
    const cred: WeixinOcCredential = {
      botId: this.botId,
      baseUrl: this.baseUrl,
      token: this.token,
      selfId: this.selfId,
      userId: status.ilink_user_id,
      savedAt: Date.now(),
    }
    try {
      await writeFile(this.credentialPath(), JSON.stringify(cred, null, 2), "utf-8")
      console.log(`[${this.botId}] 登录凭证已保存: ${this.credentialPath()}`)
    } catch (err: any) {
      console.warn(`[${this.botId}] 凭证保存失败: ${err?.message ?? err}（可手动在 config 填 baseUrl+token）`)
    }
  }

  // 长轮询接收

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const resp = await this.apiPost<GetUpdatesResp>(
          this.baseUrl,
          "ilink/bot/getupdates",
          {
            get_updates_buf: this.getUpdatesBuf,
            base_info: { channel_version: CHANNEL_VERSION },
          },
          this.token,
          this.cfg.longPollTimeoutMs ?? 35000,
        )

        if (resp.ret !== undefined && resp.ret !== 0) {
          console.error(`[${this.botId}] getupdates ret=${resp.ret} errcode=${resp.errcode ?? ""} errmsg=${resp.errmsg ?? ""}`)
          if (resp.errcode === -14) {
            console.error(`[${this.botId}] 会话超时，需要重新扫码登录（删除 data/weixin_oc_${this.botId}.json 后重启）`)
          }
          await this.sleep(this.cfg.reconnectDelay ?? 3000)
          continue
        }

        if (resp.get_updates_buf !== undefined) {
          this.getUpdatesBuf = resp.get_updates_buf
        }
        const msgs = Array.isArray(resp.msgs) ? resp.msgs : []
        for (const msg of msgs) {
          await this.handleMessage(msg)
        }
        if (msgs.length === 0 && !this.connected) {
          this.connected = true
          console.log(`✅ [${this.botId}] 长轮询已就绪`)
        }
      } catch (err: any) {
        const isAbort = err?.name === "AbortError"
        if (!isAbort) {
          console.error(`[${this.botId}] 轮询出错:`, err?.message ?? err)
        }
        if (!this.running) break
        // 长轮询超时（AbortError）是正常边界：无缝进入下一轮，减少接收延迟
        if (!isAbort) {
          await this.sleep(this.cfg.reconnectDelay ?? 3000)
        }
      }
    }
  }

  private async handleMessage(msg: WeixinMessage): Promise<void> {
    if (!msg || !msg.from_user_id) return
    // 只处理用户主动发来的消息（message_type=1），跳过机器人自己发出去的消息（2），
    // 否则机器人回复会被 getupdates 拉回来再次触发插件 → 重复发送/自循环
    if (msg.message_type !== undefined && msg.message_type !== 1) return
    try {
      await convertWxMessage(msg, this.botId, this)
    } catch (err: any) {
      console.error(`[${this.botId}] 处理消息异常:`, err?.message ?? err)
    }
  }

  // API 调用

  private async apiPost<T>(
    baseUrl: string,
    endpoint: string,
    body: Record<string, any>,
    token?: string,
    timeoutMs = 15000,
  ): Promise<T> {
    const url = `${baseUrl.replace(/\/$/, "")}/${endpoint}`
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const raw = await res.text()
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${raw}`)
    }
    return JSON.parse(raw) as T
  }

  private async apiGet<T>(baseUrl: string, endpoint: string, timeoutMs = 15000): Promise<T> {
    const url = `${baseUrl.replace(/\/$/, "")}/${endpoint}`
    const res = await fetch(url, {
      method: "GET",
      headers: {
        AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": randomWechatUin(),
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    const raw = await res.text()
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${raw}`)
    }
    return JSON.parse(raw) as T
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }

  // 会话上下文

  public setContextToken(userId: string, token: string): void {
    this.contextTokens.set(userId, token)
  }

  public getContextToken(userId: string): string | undefined {
    return this.contextTokens.get(userId)
  }

  // 媒体：接收（下载 + 解密）

  // 从 CDN 下载媒体并 AES-128-ECB 解密到本地，返回本地文件路径。
  // 解密 key：优先 item.aeskey（hex），其次 media.aes_key（base64）。
  public async downloadMedia(
    media: CDNMedia,
    aeskeyHex: string | undefined,
    kind: "img" | "audio" | "video" | "file",
  ): Promise<string | undefined> {
    try {
      const param = media.encrypt_query_param
      if (!param) return undefined
      const url = media.full_url || buildCdnDownloadUrl(param)
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
      if (!res.ok) return undefined
      const cipherBuf = Buffer.from(await res.arrayBuffer())

      let keyBuf: Buffer | undefined
      if (aeskeyHex) {
        keyBuf = Buffer.from(aeskeyHex, "hex")
      } else if (media.aes_key) {
        keyBuf = Buffer.from(media.aes_key, "base64")
      }
      let plain = cipherBuf
      if (keyBuf && keyBuf.length === 16) {
        const decipher = createDecipheriv("aes-128-ecb", keyBuf, null)
        plain = Buffer.concat([decipher.update(cipherBuf), decipher.final()])
      }

      const dir = join(this.dataDir, "media", this.botId)
      await mkdir(dir, { recursive: true })
      const extMap: Record<string, string> = { img: ".img", audio: ".audio", video: ".video", file: ".file" }
      const name = `wx_${Date.now()}_${randomBytes(4).toString("hex")}${extMap[kind]}`
      const filePath = join(dir, name)
      await writeFile(filePath, plain)
      return filePath
    } catch {
      return undefined
    }
  }

  // 媒体：发送（加密 + CDN 上传）

  // 把任意文件引用解析成 Buffer：http(s) url / base64:// / 本地路径
  private async resolveFileToBuffer(source: string): Promise<Buffer> {
    if (source.startsWith("base64://")) {
      return Buffer.from(source.slice("base64://".length), "base64")
    }
    if (/^https?:\/\//i.test(source)) {
      const res = await fetch(source, { signal: AbortSignal.timeout(30000) })
      if (!res.ok) throw new Error(`下载失败 ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    }
    // 本地路径
    await access(source)
    return readFile(source)
  }

  // 推断扩展名（上传文件名用）
  private guessFileName(source: string, name?: string): string {
    if (name) return name
    if (/^https?:\/\//i.test(source)) {
      try {
        const p = new URL(source).pathname
        const ext = extname(p)
        if (ext) return `file${ext}`
      } catch {
        // ignore
      }
    }
    return "file"
  }

  // 加密上传文件到微信 CDN
  // @returns { encrypt_query_param, aes_key } 用于构造 CDNMedia
  private async uploadMedia(
    source: string,
    mediaType: number,
    toUserId: string,
    name?: string,
  ): Promise<{ encrypt_query_param: string; aes_key: string; file_name: string }> {
    const plaintext = await this.resolveFileToBuffer(source)
    const rawsize = plaintext.length
    const rawfilemd5 = createHash("md5").update(plaintext).digest("hex")
    const filesize = aesEcbPaddedSize(rawsize)
    const filekey = randomBytes(16).toString("hex")
    const aeskey = randomBytes(16)

    const uploadUrlResp = await this.apiPost<GetUploadUrlResp>(
      this.baseUrl,
      "ilink/bot/getuploadurl",
      {
        filekey,
        media_type: mediaType,
        to_user_id: toUserId,
        rawsize,
        rawfilemd5,
        filesize,
        no_need_thumb: true,
        aeskey: aeskey.toString("hex"),
        base_info: { channel_version: CHANNEL_VERSION },
      },
      this.token,
      this.cfg.apiTimeoutMs ?? 15000,
    )

    const uploadFullUrl = uploadUrlResp.upload_full_url?.trim()
    const uploadParam = uploadUrlResp.upload_param
    if (!uploadFullUrl && !uploadParam) {
      throw new Error("getuploadurl 未返回上传地址")
    }

    // 加密
    const cipher = createCipheriv("aes-128-ecb", aeskey, null)
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])

    const cdnUrl = uploadFullUrl || buildCdnUploadUrl(uploadParam!, filekey)
    const cdnRes = await fetch(cdnUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: ciphertext,
      signal: AbortSignal.timeout(30000),
    })
    if (cdnRes.status !== 200) {
      const msg = cdnRes.headers.get("x-error-message") ?? `status ${cdnRes.status}`
      throw new Error(`CDN 上传失败: ${msg}`)
    }
    const downloadParam = cdnRes.headers.get("x-encrypted-param")
    if (!downloadParam) {
      throw new Error("CDN 上传响应缺少 x-encrypted-param")
    }

    return {
      encrypt_query_param: downloadParam,
      aes_key: aeskey.toString("base64"),
      file_name: this.guessFileName(source, name),
    }
  }

  // 发送

  // 调用统一 API
  // 支持的 action：
  // - send_msg / send_private_msg / send_group_msg
  // params: { user_id / group_id, message, context_token? }
  // - send_text : { user_id, text }
  // - send_image : { user_id, image/file/url, name? }
  // - send_video : { user_id, video/file/url, name? }
  // - send_file : { user_id, file/url, name? }
  // - get_me : 返回机器人信息
  public async callApi<T = any>(action: string, params: Record<string, any> = {}): Promise<T> {
    if (action === "send_msg" || action === "send_private_msg" || action === "send_group_msg") {
      const target = params.user_id ?? params.group_id
      if (!target) {
        throw new Error(`[${this.botId}] ${action} 缺少目标 user_id/group_id`)
      }
      return this.sendWxMessage(String(target), params.message, params.context_token) as unknown as Promise<T>
    }
    if (action === "send_text") {
      return this.sendWxMessage(String(params.user_id ?? params.group_id), [{ type: "text", data: { text: String(params.text ?? "") } }], params.context_token) as unknown as Promise<T>
    }
    if (action === "send_image") {
      const src = params.image ?? params.file ?? params.url
      if (!src) throw new Error(`[${this.botId}] send_image 缺少 image/file/url`)
      return this.sendWxMessage(String(params.user_id ?? params.group_id), [{ type: "image", data: { file: src, name: params.name } }], params.context_token) as unknown as Promise<T>
    }
    if (action === "send_video") {
      const src = params.video ?? params.file ?? params.url
      if (!src) throw new Error(`[${this.botId}] send_video 缺少 video/file/url`)
      return this.sendWxMessage(String(params.user_id ?? params.group_id), [{ type: "video", data: { file: src, name: params.name } }], params.context_token) as unknown as Promise<T>
    }
    if (action === "send_file") {
      const src = params.file ?? params.url
      if (!src) throw new Error(`[${this.botId}] send_file 缺少 file/url`)
      return this.sendWxMessage(String(params.user_id ?? params.group_id), [{ type: "file", data: { file: src, name: params.name } }], params.context_token) as unknown as Promise<T>
    }
    if (action === "get_me") {
      return { selfId: this.selfId, baseUrl: this.baseUrl, connected: this.connected } as unknown as Promise<T>
    }
    throw new Error(`[${this.botId}] 不支持的 API 操作: ${action}`)
  }

  // 发送个人微信消息（自动按段转换，媒体加密上传 CDN）
  private async sendWxMessage(
    toUserId: string,
    message: unknown,
    contextToken?: string,
  ): Promise<SendMessageResp> {
    const segments = normalizeSegments(message)

    const itemList: Array<Record<string, any>> = []
    let textBuf = ""

    const flushText = () => {
      if (textBuf) {
        itemList.push({ type: 1, text_item: { text: textBuf } })
        textBuf = ""
      }
    }

    for (const seg of segments) {
      const type = seg.type
      const data = seg.data ?? {}

      if (type === "text") {
        textBuf += String(data.text ?? "")
        continue
      }
      if (type === "at") {
        textBuf += `@${data.name ?? data.qq ?? data.id ?? ""} `
        continue
      }
      if (type === "face") {
        textBuf += `[表情${data.id ?? ""}]`
        continue
      }
      if (type === "markdown") {
        textBuf += String(data.content ?? data.text ?? "")
        continue
      }
      if (type === "button") {
        textBuf += `[按钮:${data.text ?? data.label ?? ""}]`
        continue
      }
      if (type === "reply") {
        // 个人微信发送不支持引用占位，仅保留引用摘要文本
        const t = String(data.text ?? "")
        if (t) textBuf += `[回复]${t} `
        continue
      }
      if (type === "record") {
        // 微信不支持发送语音，降级为文本
        textBuf += `[语音]${String(data.text ?? "")} `
        continue
      }

      // 媒体段：先冲刷累积文本（文本在前）
      flushText()
      try {
        const src = String(data.file ?? data.url ?? data.file_id ?? data.path ?? "")
        if (!src) throw new Error("媒体段缺少 file/url")
        if (type === "image") {
          const info = await this.uploadMedia(src, 1, toUserId, data.name)
          itemList.push({ type: 2, image_item: { media: { encrypt_query_param: info.encrypt_query_param, aes_key: info.aes_key } } })
        } else if (type === "video") {
          const info = await this.uploadMedia(src, 2, toUserId, data.name)
          itemList.push({ type: 5, video_item: { media: { encrypt_query_param: info.encrypt_query_param, aes_key: info.aes_key } } })
        } else if (type === "file") {
          const info = await this.uploadMedia(src, 3, toUserId, data.name)
          itemList.push({ type: 4, file_item: { media: { encrypt_query_param: info.encrypt_query_param, aes_key: info.aes_key }, file_name: info.file_name } })
        } else {
          // 未知段 → 文本兜底
          textBuf += segmentsToText([seg])
        }
      } catch (err: any) {
        // 媒体上传失败 → 降级为文本，不崩溃
        console.error(`[${this.botId}] 媒体发送失败，降级为文本: ${err?.message ?? err}`)
        textBuf += segmentsToText([seg])
      }
    }
    flushText()

    if (itemList.length === 0) {
      itemList.push({ type: 1, text_item: { text: textBuf || "[空消息]" } })
    }

    const context = contextToken ?? this.getContextToken(toUserId) ?? ""
    const body = {
      msg: {
        from_user_id: "",
        to_user_id: toUserId,
        client_id: `wx-bot-${randomBytes(8).toString("hex")}`,
        message_type: 2,
        message_state: 2,
        context_token: context,
        item_list: itemList,
      },
    }

    const resp = await this.apiPost<SendMessageResp>(
      this.baseUrl,
      "ilink/bot/sendmessage",
      body,
      this.token,
      this.cfg.apiTimeoutMs ?? 15000,
    )
    if (resp.ret !== undefined && resp.ret !== 0) {
      throw new Error(`[${this.botId}] 发送失败: ret=${resp.ret} errmsg=${resp.errmsg ?? ""}`)
    }
    return resp
  }

  public async destroy(): Promise<void> {
    await this.disconnect()
    WeixinOcAdapterMap.delete(this.botId)
    await super.destroy()
  }
}

export function getWeixinOcAdapterById(botId: string): WeixinOcAdapter | undefined {
  return WeixinOcAdapterMap.get(botId)
}
