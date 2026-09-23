import type { BotEvent } from "../../core/models/event.js"
import type { TgUpdate, TgMessage } from "./types.js"
import type { TelegramAdapter } from "./client.js"

// Telegram 消息 → 框架统一消息段
// 支持：文本 / 图片 / 语音 / 视频 / 音频 / 文件 / 贴纸 / 动图 / 引用(reply_to_message) / 转发(forward_from)
export function tgMsgToSegments(msg: TgMessage): Array<{ type: string; data: Record<string, any> }> {
  const segments: Array<{ type: string; data: Record<string, any> }> = []

  // 引用消息（回复别人）
  if (msg.reply_to_message) {
    const ref = msg.reply_to_message
    const refText =
      ref.text ?? ref.caption ??
      (ref.photo?.length || ref.video ? "[媒体消息]" : ref.voice ? "[语音]" : ref.document ? `[文件:${ref.document.file_name ?? ""}]` : "")
    segments.push({
      type: "reply",
      data: {
        id: String(ref.message_id ?? ""),
        text: String(refText ?? ""),
        name: ref.from?.first_name ?? ref.from?.username ?? "",
      },
    })
  }
  // 转发来源（来自他人/群/频道）
  if (msg.forward_from || msg.forward_from_chat) {
    const src = msg.forward_from
      ? `${msg.forward_from.first_name ?? ""} ${msg.forward_from.username ?? ""}`.trim()
      : msg.forward_from_chat?.title ?? ""
    segments.push({ type: "forward", data: { name: src, id: String(msg.forward_date ?? "") } })
  }

  if (msg.photo && msg.photo.length) {
    // 取最大尺寸
    const best = msg.photo[msg.photo.length - 1]
    segments.push({ type: "image", data: { file_id: best.file_id, file: best.file_id } })
  }
  if (msg.voice) {
    segments.push({ type: "record", data: { file_id: msg.voice.file_id, file: msg.voice.file_id, duration: msg.voice.duration ?? 0 } })
  }
  if (msg.video) {
    segments.push({ type: "video", data: { file_id: msg.video.file_id, file: msg.video.file_id } })
  }
  if (msg.audio) {
    segments.push({ type: "record", data: { file_id: msg.audio.file_id, file: msg.audio.file_id, name: msg.audio.title ?? "" } })
  }
  if (msg.document) {
    segments.push({ type: "file", data: { file_id: msg.document.file_id, file: msg.document.file_id, name: msg.document.file_name ?? "" } })
  }
  if (msg.sticker) {
    segments.push({ type: "text", data: { text: msg.sticker.emoji ? `[贴纸${msg.sticker.emoji}]` : "[贴纸]" } })
  }
  if (msg.animation) {
    segments.push({ type: "image", data: { file_id: msg.animation.file_id, file: msg.animation.file_id } })
  }
  // 文本 + 媒体 caption
  const text = msg.text ?? msg.caption ?? ""
  if (text) {
    segments.push({ type: "text", data: { text } })
  }
  if (segments.length === 0) {
    segments.push({ type: "text", data: { text: "[未知消息]" } })
  }
  return segments
}

// Telegram update → 框架统一事件并派发
export function convertTgUpdate(update: TgUpdate, botId: string, selfId: string, adapter: TelegramAdapter): void {
  if (update.message) {
    emitTgMessage(update.message, botId, selfId, adapter)
    return
  }
  if (update.edited_message) {
    // 编辑消息：仍按普通消息派发
    emitTgMessage(update.edited_message, botId, selfId, adapter)
    return
  }
  if (update.channel_post) {
    emitTgMessage(update.channel_post, botId, selfId, adapter)
    return
  }
  if (update.callback_query) {
    // 内联按钮回调：转 notice 派发，raw.data 为按钮 payload
    const event: BotEvent = {
      botId,
      selfId,
      userId: String(update.callback_query.from.id),
      groupId: update.callback_query.message?.chat?.type === "private" ? undefined : String(update.callback_query.message?.chat?.id ?? ""),
      message: [{ type: "text", data: { text: `[回调:${update.callback_query.data ?? ""}]` } }],
      postType: "notice",
      raw: update as unknown as Record<string, any>,
    }
    ;(event.raw as any).notice_type = "callback_query"
    ;(event.raw as any).platform = "telegram"
    adapter.emitEvent("notice", event)
    return
  }

  // 其余（成员变动等）统一 notice
  const event: BotEvent = {
    botId,
    selfId,
    userId: "",
    groupId: undefined,
    message: [],
    postType: "notice",
    raw: update as unknown as Record<string, any>,
  }
  ;(event.raw as any).notice_type = "update"
  ;(event.raw as any).platform = "telegram"
  adapter.emitEvent("notice", event)
}

function emitTgMessage(msg: TgMessage, botId: string, selfId: string, adapter: TelegramAdapter): void {
  const chat = msg.chat
  const isPrivate = chat.type === "private"

  const event: BotEvent = {
    botId,
    selfId,
    userId: String(msg.from?.id ?? ""),
    groupId: isPrivate ? undefined : String(chat.id),
    message: tgMsgToSegments(msg),
    postType: isPrivate ? "private_message" : "group_message",
    raw: msg as unknown as Record<string, any>,
  }
  ;(event.raw as any).sender = {
    user_id: String(msg.from?.id ?? ""),
    nickname: msg.from?.first_name ?? msg.from?.username ?? "",
    card: "",
    role: isPrivate ? "user" : "member",
  }
  ;(event.raw as any).message_id = String(msg.message_id)
  ;(event.raw as any).time = msg.date
  ;(event.raw as any).platform = "telegram"

  if (isPrivate) {
    adapter.emitEvent("private_message", event)
  } else {
    adapter.emitEvent("group_message", event)
  }
}
