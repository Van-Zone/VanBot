import { BaseAdapter } from "../base.js"
import { convertTgUpdate } from "./converter.js"
import type { TgApiResp } from "./types.js"
import type { MessageChain } from "../../core/models/message.js"
import { normalizeSegments } from "../../core/messageUtils.js"
import { registerBot } from "../../core/botRegistry.js"
import type { Capabilities } from "../../core/capabilities.js"
import type { BotEvent } from "../../core/models/event.js"

export const TelegramAdapterMap = new Map<string, TelegramAdapter>()

const API_BASE = "https://api.telegram.org"

// Telegram 官方机器人适配器
// 原理：
// 1. 启动时调用 getMe 获取机器人自身信息（selfId）
// 2. 用 getUpdates 长轮询接收事件（offset/timeout，无需公网回调）
// 3. 收到 message/edited_message/channel_post/callback_query 等 → 转统一事件派发给插件
// 4. 发送：sendMessage / sendPhoto / sendVoice / sendVideo / sendAudio
// 配置项：
// botId       - 框架内标识
// type        - "telegram"
// token       - BotFather 申请的机器人令牌（如 123456:ABC-xxx）
// pollTimeout - 可选，长轮询超时秒数，默认 50（Telegram 上限 50）
// reconnectDelay - 可选，轮询出错重试等待毫秒，默认 3000
// 注意：Telegram 在国内网络不可直连，需在能访问 api.telegram.org 的环境运行
// （海外服务器 / 代理）。
export class TelegramAdapter extends BaseAdapter {
  public readonly botId: string
  private readonly cfg: Record<string, any>
  private running: boolean = false
  private lastUpdateId: number = 0
  private selfIdStr: string = ""

  constructor(config: Record<string, any>) {
    super()
    this.cfg = config
    this.botId = config.botId
    TelegramAdapterMap.set(this.botId, this)
    registerBot(this)
  }

  public async connect(): Promise<void> {
    if (!this.cfg.token) throw new Error(`[${this.botId}] 缺少 token 配置（BotFather 获取）`)
    // 获取机器人信息
    const me = await this.api("getMe")
    if (!me.ok) {
      throw new Error(`[${this.botId}] getMe 失败: ${me.description} (${me.error_code}) —— 请检查 token 是否正确`)
    }
    this.selfIdStr = String(me.result?.id ?? "")
    this.selfId = this.selfIdStr
    console.log(`✅ [${this.botId}] 登录成功: @${me.result?.username ?? ""} (${this.selfIdStr})`)
    this.running = true
    // 启动长轮询（不阻塞 connect 返回）
    this.poll().catch((e) => console.error(`[${this.botId}] 轮询异常:`, e))
  }

  public async disconnect(): Promise<void> {
    this.running = false
    this.connected = false
    console.log(`[${this.botId}] 已停止轮询`)
  }

  // 长轮询接收

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const params: Record<string, any> = {
          timeout: this.cfg.pollTimeout ?? 50,
          allowed_updates: JSON.stringify([
            "message",
            "edited_message",
            "channel_post",
            "callback_query",
            "my_chat_member",
          ]),
        }
        if (this.lastUpdateId) {
          params.offset = this.lastUpdateId + 1
        }
        const data = await this.api("getUpdates", params, (this.cfg.pollTimeout ?? 50) * 1000 + 10000)
        if (!data.ok) {
          if (data.error_code === 401) {
            console.error(`[${this.botId}] token 无效(401)，停止轮询`)
            this.running = false
            break
          }
          if (data.error_code === 409) {
            console.error(`[${this.botId}] 有另一个实例在轮询(409)，请先停掉其他进程，5 秒后重试`)
          } else {
            console.error(`[${this.botId}] getUpdates 错误 ${data.error_code}: ${data.description}`)
          }
          await this.sleep(this.cfg.reconnectDelay ?? 3000)
          continue
        }
        const updates = Array.isArray(data.result) ? data.result : []
        for (const u of updates) {
          this.lastUpdateId = Math.max(this.lastUpdateId, u.update_id)
          convertTgUpdate(u, this.botId, this.selfIdStr, this)
        }
        if (updates.length === 0 && !this.connected) {
          this.connected = true
          console.log(`✅ [${this.botId}] 轮询已就绪`)
        }
      } catch (e: any) {
        console.error(`[${this.botId}] 轮询出错:`, e?.message ?? e)
        await this.sleep(this.cfg.reconnectDelay ?? 3000)
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }

  // API 调用

  // 调用 Telegram Bot API
  // @param method 方法名，如 sendMessage / getMe
  // @param params 参数（对象值自动 JSON 序列化）
  private async api(method: string, params: Record<string, any> = {}, timeoutMs = 20000): Promise<TgApiResp> {
    const url = `${API_BASE}/bot${this.cfg.token}/${method}`
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue
      qs.set(k, typeof v === "object" ? JSON.stringify(v) : String(v))
    }
    const res = await fetch(`${url}?${qs.toString()}`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    })
    return (await res.json()) as TgApiResp
  }

  // 带 multipart 文件上传的 API 调用
  private async apiMultipart(method: string, fields: Record<string, string>, fileField: string, fileBuf: Buffer, fileName: string): Promise<TgApiResp> {
    const form = new FormData()
    for (const [k, v] of Object.entries(fields)) form.append(k, v)
    form.append(fileField, new Blob([new Uint8Array(fileBuf)]), fileName)
    const res = await fetch(`${API_BASE}/bot${this.cfg.token}/${method}`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(30000),
    })
    return (await res.json()) as TgApiResp
  }

  // 调用 Telegram 官方 API
  // 支持的 action：
  // - send_msg / send_private_msg / send_group_msg : 发送消息
  // params: { chat_id / user_id / group_id, message }
  // message 支持字符串或消息段数组：
  // text → sendMessage
  // image → sendPhoto（file_id / URL / base64://）
  // record → sendVoice
  // video → sendVideo
  // file → sendDocument
  // - get_me : 返回机器人信息
  // 会话粒度能力：
  // - 富媒体（text/image/video/record/file）原生发送；
  // - at 转 "@名字"、markdown 转纯文本（内容可表达）；
  // - face/button/reply/forward 无法表达 → false（内核可降级）
  computeCapabilities(_event: BotEvent): Readonly<Capabilities> {
    return {
      text: true, image: true, video: true, record: true, file: true,
      at: true, markdown: true,
      face: false, button: false, reply: false, forward: false,
    }
  }

  public async callApi<T = any>(action: string, params: Record<string, any> = {}): Promise<T> {
    if (action === "send_msg" || action === "send_private_msg" || action === "send_group_msg") {
      const chatId = params.chat_id ?? params.group_id ?? params.user_id
      if (chatId === undefined || chatId === null || chatId === "") {
        throw new Error(`[${this.botId}] ${action} 缺少目标 chat_id/group_id/user_id`)
      }
      return this.sendTgMessage(String(chatId), params.message) as unknown as Promise<T>
    }
    if (action === "get_me") {
      return this.api("getMe") as unknown as Promise<T>
    }
    throw new Error(`[${this.botId}] 不支持的 API 操作: ${action}`)
  }

  // 发送 Telegram 消息（按消息段依次发送）
  private async sendTgMessage(chatId: string, message: MessageChain | string): Promise<TgApiResp> {
    const segments = normalizeSegments(message)

    let last: TgApiResp = { ok: true }
    let pendingCaption = ""

    for (const seg of segments) {
      const type = seg.type
      const data = seg.data ?? {}

      if (type === "text" || type === "at" || type === "face" || type === "markdown" || type === "button") {
        // 文本类：at → @名字，face → [表情]，markdown/button → 取内容
        if (type === "at") pendingCaption += `@${data.name ?? data.qq ?? data.id ?? ""} `
        else if (type === "face") pendingCaption += `[表情${data.id ?? ""}]`
        else if (type === "markdown") pendingCaption += String(data.content ?? data.text ?? "")
        else if (type === "button") pendingCaption += `[${data.text ?? data.label ?? ""}]`
        else pendingCaption += String(data.text ?? "")
        continue
      }

      // 先发送媒体（带 caption）
      if (pendingCaption) {
        if (type === "image") {
          last = await this.sendPhoto(chatId, data, pendingCaption)
        } else if (type === "record") {
          last = await this.sendVoice(chatId, data, pendingCaption)
        } else if (type === "video") {
          last = await this.sendVideo(chatId, data, pendingCaption)
        } else if (type === "file") {
          last = await this.sendDocument(chatId, data, pendingCaption)
        }
        pendingCaption = ""
        this.checkResp(last)
        continue
      }

      // 无 caption，媒体各自发送
      if (type === "image") {
        last = await this.sendPhoto(chatId, data)
      } else if (type === "record") {
        last = await this.sendVoice(chatId, data)
      } else if (type === "video") {
        last = await this.sendVideo(chatId, data)
      } else if (type === "file") {
        last = await this.sendDocument(chatId, data)
      }
      this.checkResp(last)
    }

    // 剩余文本发送
    if (pendingCaption) {
      last = await this.api("sendMessage", { chat_id: chatId, text: pendingCaption })
      this.checkResp(last)
    }

    return last
  }

  // 解析媒体来源：file_id（纯字符串） / http url / base64
  private resolveMedia(data: Record<string, any>): { kind: "file_id" | "url" | "base64"; value: string; buf?: Buffer } {
    const source = String(data.file_id ?? data.file ?? data.url ?? data.path ?? "")
    if (source.startsWith("base64://")) {
      return { kind: "base64", value: source, buf: Buffer.from(source.slice("base64://".length), "base64") }
    }
    if (/^https?:\/\//.test(source)) {
      return { kind: "url", value: source }
    }
    return { kind: "file_id", value: source }
  }

  private async sendPhoto(chatId: string, data: Record<string, any>, caption = ""): Promise<TgApiResp> {
    const media = this.resolveMedia(data)
    if (media.kind === "base64") {
      return this.apiMultipart("sendPhoto", { chat_id: chatId, ...(caption ? { caption } : {}) }, "photo", media.buf!, "photo.png")
    }
    return this.api("sendPhoto", { chat_id: chatId, photo: media.value, ...(caption ? { caption } : {}) })
  }

  private async sendVoice(chatId: string, data: Record<string, any>, caption = ""): Promise<TgApiResp> {
    const media = this.resolveMedia(data)
    if (media.kind === "base64") {
      return this.apiMultipart("sendVoice", { chat_id: chatId, ...(caption ? { caption } : {}) }, "voice", media.buf!, "voice.ogg")
    }
    return this.api("sendVoice", { chat_id: chatId, voice: media.value, ...(caption ? { caption } : {}) })
  }

  private async sendVideo(chatId: string, data: Record<string, any>, caption = ""): Promise<TgApiResp> {
    const media = this.resolveMedia(data)
    if (media.kind === "base64") {
      return this.apiMultipart("sendVideo", { chat_id: chatId, ...(caption ? { caption } : {}) }, "video", media.buf!, "video.mp4")
    }
    return this.api("sendVideo", { chat_id: chatId, video: media.value, ...(caption ? { caption } : {}) })
  }

  private async sendDocument(chatId: string, data: Record<string, any>, caption = ""): Promise<TgApiResp> {
    const media = this.resolveMedia(data)
    if (media.kind === "base64") {
      return this.apiMultipart("sendDocument", { chat_id: chatId, ...(caption ? { caption } : {}) }, "document", media.buf!, data.name ?? "file")
    }
    return this.api("sendDocument", { chat_id: chatId, document: media.value, ...(caption ? { caption } : {}) })
  }

  private checkResp(resp: TgApiResp): void {
    if (!resp.ok) {
      throw new Error(`[${this.botId}] 发送失败: ${resp.description} (${resp.error_code})`)
    }
  }

  public async destroy(): Promise<void> {
    await this.disconnect()
    TelegramAdapterMap.delete(this.botId)
    await super.destroy()
  }
}

export function getTelegramAdapterById(botId: string): TelegramAdapter | undefined {
  return TelegramAdapterMap.get(botId)
}
