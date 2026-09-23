import type { BotEvent } from "../../core/models/event.js"
import type { WeixinMessage, MessageItem } from "./types.js"
import type { WeixinOcAdapter } from "./client.js"
import { MessageItemType } from "./types.js"

// 个人微信（openclaw-weixin / iLink）消息 → 框架统一消息段
// 支持接收：文本 / 图片 / 语音（云端转文字）/ 文件 / 视频 / 引用
// 媒体接收时从 CDN 下载并 AES-128-ECB 解密到本地临时目录，data.file 指向本地文件。

function extractTextFromItem(item: MessageItem): string {
  return item.text_item?.text ?? ""
}

// 从引用消息里提取文本摘要
function extractRefText(ref: MessageItem | undefined): string {
  if (!ref) return ""
  if (ref.text_item?.text) return ref.text_item.text
  if (ref.file_item?.file_name) return `[文件:${ref.file_item.file_name}]`
  if (ref.image_item) return "[图片]"
  if (ref.video_item) return "[视频]"
  if (ref.voice_item?.text) return `[语音]${ref.voice_item.text}`
  return ""
}

export async function wxMsgToSegments(
  msg: WeixinMessage,
  adapter: WeixinOcAdapter,
): Promise<Array<{ type: string; data: Record<string, any> }>> {
  const segments: Array<{ type: string; data: Record<string, any> }> = []

  for (const item of msg.item_list ?? []) {
    const type = item.type ?? 0

    switch (type) {
      case MessageItemType.TEXT: {
        const text = extractTextFromItem(item)
        if (text) segments.push({ type: "text", data: { text } })
        break
      }
      case MessageItemType.IMAGE: {
        const img = item.image_item
        const media = img?.media ?? img?.thumb_media
        const local = media
          ? await adapter.downloadMedia(media, img?.aeskey, "img")
          : undefined
        segments.push({ type: "image", data: local ? { file: local, url: local } : { text: "[图片]" } })
        break
      }
      case MessageItemType.VOICE: {
        const voice = item.voice_item
        const local = voice?.media
          ? await adapter.downloadMedia(voice.media, undefined, "audio")
          : undefined
        const seg: Record<string, any> = { duration: voice?.playtime ?? 0 }
        if (voice?.text) seg.text = voice.text
        if (local) seg.file = local
        segments.push({ type: "record", data: seg })
        // 语音转文字（微信云端转录）也作为文本段发出，方便插件文本匹配
        if (voice?.text) {
          segments.push({ type: "text", data: { text: `[语音]${voice.text}` } })
        }
        break
      }
      case MessageItemType.FILE: {
        const file = item.file_item
        const local = file?.media
          ? await adapter.downloadMedia(file.media, undefined, "file")
          : undefined
        const seg: Record<string, any> = { name: file?.file_name ?? "" }
        if (local) seg.file = local
        segments.push({ type: "file", data: seg })
        break
      }
      case MessageItemType.VIDEO: {
        const video = item.video_item
        const local = video?.media
          ? await adapter.downloadMedia(video.media, undefined, "video")
          : undefined
        const seg: Record<string, any> = { duration: video?.play_length ?? 0 }
        if (local) seg.file = local
        segments.push({ type: "video", data: seg })
        break
      }
      default:
        break
    }

    // 引用消息（回复）
    if (item.ref_msg) {
      const ref = item.ref_msg.message_item
      const refText = extractRefText(ref)
      segments.push({
        type: "reply",
        data: {
          id: String(ref?.msg_id ?? item.msg_id ?? ""),
          text: refText || item.ref_msg.title || "",
          name: "",
        },
      })
    }
  }

  if (segments.length === 0) {
    segments.push({ type: "text", data: { text: "[未知消息]" } })
  }
  return segments
}

// 个人微信消息 → 框架统一事件并派发
export async function convertWxMessage(
  msg: WeixinMessage,
  botId: string,
  adapter: WeixinOcAdapter,
): Promise<void> {
  const selfId = adapter.selfId || String(msg.to_user_id ?? "")
  const userId = String(msg.from_user_id ?? "")
  const groupId = msg.group_id || undefined

  // 缓存会话上下文令牌（回复时必须带回）
  if (userId && msg.context_token) {
    adapter.setContextToken(userId, msg.context_token)
  }

  const segments = await wxMsgToSegments(msg, adapter)

  const event: BotEvent = {
    botId,
    selfId,
    userId,
    groupId,
    message: segments,
    postType: groupId ? "group_message" : "private_message",
    raw: msg as unknown as Record<string, any>,
  }
  ;(event.raw as any).sender = {
    user_id: userId,
    // 个人微信协议消息不带昵称字段（协议限制）
    nickname: "",
    card: "",
    role: groupId ? "member" : "user",
  }
  ;(event.raw as any).message_id = String(msg.message_id ?? "")
  ;(event.raw as any).time = Math.floor((msg.create_time_ms ?? Date.now()) / 1000)
  ;(event.raw as any).platform = "weixin_oc"
  ;(event.raw as any).context_token = msg.context_token ?? ""

  if (groupId) {
    adapter.emitEvent("group_message", event)
  } else {
    adapter.emitEvent("private_message", event)
  }
}
