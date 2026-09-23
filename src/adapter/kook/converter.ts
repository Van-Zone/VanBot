import type { BotEvent } from "../../core/models/event.js"
import type { KookEvent } from "./types.js"
import type { KookAdapter } from "./client.js"

// KOOK 事件 → 框架统一事件并派发
// 消息事件 d.type: 1文字 / 2图片 / 3视频 / 4文件 / 9kmarkdown / 10卡片 / 12道具
// channel_type: GROUP = 频道消息(群聊)，PERSON = 私聊
// d.type === 255 = 系统/通知事件
export function convertKookEvent(raw: any, botId: string, selfId: string, adapter: KookAdapter): void {
  const d = (raw?.d ?? raw) as KookEvent
  const type = d.type ?? 0

  // 系统事件
  if (type === 255) {
    const notice: BotEvent = {
      botId,
      selfId,
      userId: d.author_id ?? "",
      groupId: d.channel_type === "PERSON" ? undefined : d.target_id ?? "",
      message: [],
      postType: "notice",
      raw: raw as unknown as Record<string, any>,
    }
    ;(notice.raw as any).notice_type = String(d.extra?.type ?? "kook_system")
    ;(notice.raw as any).platform = "kook"
    adapter.emitEvent("notice", notice)
    return
  }

  // 普通消息：type 1/2/3/4/9/10/12
  const isPrivate = d.channel_type === "PERSON"
  const event: BotEvent = {
    botId,
    selfId,
    userId: d.author_id ?? "",
    groupId: isPrivate ? undefined : d.target_id ?? "",
    message: kookToSegments(d),
    postType: isPrivate ? "private_message" : "group_message",
    raw: raw as unknown as Record<string, any>,
  }
  ;(event.raw as any).sender = {
    user_id: d.author_id ?? "",
    nickname: d.extra?.author?.nickname ?? d.extra?.author?.username ?? "",
    card: "",
    role: "member",
  }
  ;(event.raw as any).message_id = d.msg_id ?? ""
  ;(event.raw as any).time = d.msg_timestamp ? Math.floor(Number(d.msg_timestamp) / 1000) : Math.floor(Date.now() / 1000)
  ;(event.raw as any).platform = "kook"

  if (isPrivate) {
    adapter.emitEvent("private_message", event)
  } else {
    adapter.emitEvent("group_message", event)
  }
}

// KOOK 消息内容 → 框架统一消息段
function kookToSegments(d: KookEvent): Array<{ type: string; data: Record<string, any> }> {
  const segments: Array<{ type: string; data: Record<string, any> }> = []
  const type = d.type ?? 0
  const content = String(d.content ?? "")

  // 引用消息（回复某人）：extra.quote = { id, content, author }
  const quote = d.extra?.quote
  if (quote?.id) {
    segments.push({
      type: "reply",
      data: {
        id: String(quote.id ?? ""),
        text: String(quote.content ?? ""),
        name: quote.author?.username ?? quote.author?.nickname ?? "",
      },
    })
  }

  if (type === 1 || type === 9) {
    // 文字 / kmarkdown：解析 @ 语法 (met)用户id(met)
    const parsed = kookContentToSegments(content)
    if (parsed.length) segments.push(...parsed)
  } else if (type === 2) {
    // 图片：content = 图片 url
    if (content) segments.push({ type: "image", data: { url: content, file: content } })
  } else if (type === 3) {
    if (content) segments.push({ type: "video", data: { url: content, file: content } })
  } else if (type === 4) {
    const url = d.extra?.attachments?.url ?? content
    segments.push({ type: "file", data: { file: url, url, name: d.extra?.attachments?.name ?? "file" } })
  } else if (type === 8) {
    // 语音
    const url = d.extra?.attachments?.url ?? content
    segments.push({ type: "record", data: { file: url, url, name: d.extra?.attachments?.name ?? "voice" } })
  } else if (type === 10) {
    segments.push({ type: "text", data: { text: "[卡片消息]" } })
  } else if (type === 12) {
    segments.push({ type: "text", data: { text: "[道具消息]" } })
  }

  if (segments.length === 0) segments.push({ type: "text", data: { text: "[未知消息]" } })
  return segments
}

// 解析 KOOK 文本中的 @ 语法（(met)用户id(met)[昵称]）和表情（(emj)id(emj)）
function kookContentToSegments(content: string): Array<{ type: string; data: Record<string, any> }> {
  const segments: Array<{ type: string; data: Record<string, any> }> = []
  // @ 和表情总是成对出现：(met)id(met)  /  (emj)id(emj)
  const RE = /\((met)\)([^()]+?)\(met\)(?:\[([^\]]*)\])?|\((emj)\)([^()]+?)\(emj\)(?:\[([^\]]*)\])?/g
  let last = 0
  let m: RegExpExecArray | null
  let hasTag = false
  while ((m = RE.exec(content)) !== null) {
    hasTag = true
    const before = content.slice(last, m.index)
    if (before) segments.push({ type: "text", data: { text: before } })
    if (m[1] === "met") {
      const id = m[2].trim()
      segments.push({ type: "at", data: { qq: id, name: m[3] ?? id } })
    } else if (m[4] === "emj") {
      segments.push({ type: "face", data: { id: m[5] ?? "" } })
    }
    last = m.index + m[0].length
  }
  if (!hasTag) {
    // 无 @/表情，纯文本
    segments.push({ type: "text", data: { text: content } })
  } else {
    const tail = content.slice(last)
    if (tail) segments.push({ type: "text", data: { text: tail } })
  }
  return segments
}

// 框架消息段 → KOOK 文本（text/kmarkdown 内容）
export function segmentsToKookText(segments: Array<{ type: string; data: Record<string, any> }>): string {
  let text = ""
  for (const seg of segments) {
    if (seg.type === "text") text += String(seg.data.text ?? "")
    else if (seg.type === "at") text += `(met)${seg.data.qq ?? ""}(met) `
    else if (seg.type === "face") text += `[表情${seg.data.id ?? ""}]`
    else if (seg.type === "markdown") text += String(seg.data.content ?? "")
  }
  return text
}
