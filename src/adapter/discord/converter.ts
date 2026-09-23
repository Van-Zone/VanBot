import type { BotEvent } from "../../core/models/event.js"
import type { DiscordMessage } from "./types.js"
import type { DiscordAdapter } from "./client.js"

// Discord 消息 → 框架统一消息段
// 支持：文本 / 图片 / 视频 / 语音 / 文件 / 引用(message_reference) / @(mentions)
export function discordToSegments(msg: DiscordMessage): Array<{ type: string; data: Record<string, any> }> {
  const segments: Array<{ type: string; data: Record<string, any> }> = []

  // 引用消息（回复某人）：message_reference.message_id
  if (msg.message_reference) {
    const refId = msg.message_reference.message_id ?? ""
    const refAuthor = msg.referenced_message?.author?.username ?? msg.referenced_message?.author?.global_name ?? ""
    const refContent = msg.referenced_message?.content ?? (msg.referenced_message?.attachments?.length ? "[媒体消息]" : "")
    segments.push({
      type: "reply",
      data: { id: String(refId ?? ""), text: String(refContent ?? ""), name: String(refAuthor ?? "") },
    })
  }
  // @ 提及：content 里的 <@id> 换成 @名字，另生成 at 段
  let content = msg.content ?? ""
  if (msg.mentions && msg.mentions.length) {
    for (const m of msg.mentions) {
      const name = m.global_name ?? m.username ?? String(m.id ?? "")
      content = content.replace(new RegExp(`<@!?${m.id}>`, "g"), `@${name}`)
      segments.push({ type: "at", data: { qq: String(m.id ?? ""), name } })
    }
  }
  if (content) segments.push({ type: "text", data: { text: content } })
  if (msg.attachments && msg.attachments.length) {
    for (const att of msg.attachments) {
      if (att.content_type?.startsWith("image/")) {
        segments.push({ type: "image", data: { url: att.url, file: att.url, name: att.filename ?? "" } })
      } else if (att.content_type?.startsWith("video/")) {
        segments.push({ type: "video", data: { url: att.url, file: att.url, name: att.filename ?? "" } })
      } else if (att.content_type?.startsWith("audio/")) {
        segments.push({ type: "record", data: { url: att.url, file: att.url, name: att.filename ?? "" } })
      } else {
        segments.push({ type: "file", data: { url: att.url, file: att.url, name: att.filename ?? "file" } })
      }
    }
  }
  if (segments.length === 0) segments.push({ type: "text", data: { text: "[未知消息]" } })
  return segments
}

// Discord MESSAGE_CREATE 事件 → 框架统一事件并派发
// 有 guild_id = 群聊（groupId=channel_id），无 guild_id = 私聊
export function convertDiscordMessage(msg: DiscordMessage, botId: string, selfId: string, adapter: DiscordAdapter): void {
  const isGuild = !!msg.guild_id
  const event: BotEvent = {
    botId,
    selfId,
    userId: msg.author?.id ?? "",
    groupId: isGuild ? msg.channel_id ?? "" : undefined,
    message: discordToSegments(msg),
    postType: isGuild ? "group_message" : "private_message",
    raw: msg as unknown as Record<string, any>,
  }
  ;(event.raw as any).sender = {
    user_id: msg.author?.id ?? "",
    nickname: msg.author?.global_name ?? msg.author?.username ?? "",
    card: "",
    role: "member",
  }
  ;(event.raw as any).message_id = msg.id ?? ""
  ;(event.raw as any).time = msg.timestamp ? Math.floor(new Date(msg.timestamp).getTime() / 1000) : Math.floor(Date.now() / 1000)
  ;(event.raw as any).platform = "discord"

  if (isGuild) {
    adapter.emitEvent("group_message", event)
  } else {
    // 记录 用户id → DM频道id，私聊回复时直接命中缓存
    if (typeof (adapter as any).cacheDmChannel === "function") {
      (adapter as any).cacheDmChannel(msg.author?.id ?? "", msg.channel_id ?? "")
    }
    adapter.emitEvent("private_message", event)
  }
}

// 框架消息段 → Discord 文本内容
export function segmentsToDiscordText(segments: Array<{ type: string; data: Record<string, any> }>): string {
  let text = ""
  for (const seg of segments) {
    if (seg.type === "text") text += String(seg.data.text ?? "")
    else if (seg.type === "at") text += `<@${seg.data.qq ?? seg.data.id ?? ""}> `
    else if (seg.type === "markdown") text += String(seg.data.content ?? "")
  }
  return text
}
