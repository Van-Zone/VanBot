import type { BotEvent } from "../../core/models/event.js"
import type { QqAdapter } from "./client.js"

// 去掉 QQ 消息内容里的 @机器人 标签，例如 <@!botid>你好
export function stripQqMentions(text: string): string {
  return (text ?? "")
    .replace(/<@![^>]*>/g, "")
    .replace(/<@[^>]*>/g, "")
    .trim()
}

// 框架统一消息段 → QQ 文本内容（仅取 text 段，其他段尽量转文本）
export function segmentsToQqText(
  segments: Array<{ type: string; data: Record<string, any> }>
): string {
  let text = ""
  for (const seg of segments) {
    if (seg.type === "text") {
      text += String(seg.data.text ?? "")
    } else if (seg.type === "at") {
      text += `@${seg.data.name ?? seg.data.qq ?? ""} `
    } else if (seg.type === "face") {
      text += `[表情${seg.data.id ?? ""}]`
    }
    // image/record/video 等由图片/媒体字段处理
  }
  return text
}

// QQ 消息事件 → 框架统一事件并派发
// 群聊/单聊/频道消息统一转为 group_message 或 private_message
// 新版事件结构（GROUP_AT_MESSAGE_CREATE / GROUP_MESSAGE_CREATE / C2C_MESSAGE_CREATE）：
// d.author.username       用户昵称（群聊有值；单聊可能为空）
// d.author.member_openid  群成员 openid（群聊）
// d.author.user_openid    用户 openid（单聊）
// d.content               文本内容（已去除@机器人前缀）
// d.message_type          0=纯文本 3=ARK卡片 101=并行 102=聊天记录 103=引用
// d.attachments[]         附件（image/jpeg|png|gif、video/mp4、voice、file）
// d.mentions[]            @的用户列表
// d.msg_elements[]        消息元素（引用消息含被引用内容）
export function convertQqEvent(raw: any, botId: string, selfId: string, adapter: QqAdapter): void {
  const eventType: string = raw.t ?? ""
  const d = raw.d ?? {}

  if (eventType === "GROUP_AT_MESSAGE_CREATE" || eventType === "GROUP_MESSAGE_CREATE") {
    // 群里 @ 机器人 / 群消息（全量模式）
    const author = d.author ?? {}
    const userOpenid = author.user_openid ?? author.id ?? ""
    const memberOpenid = author.member_openid ?? ""
    const nickname = String(author.username ?? author.nickname ?? "")
    const event: BotEvent = {
      botId,
      selfId,
      userId: userOpenid || memberOpenid,
      groupId: d.group_openid ?? "",
      message: qqMsgToSegments(d),
      postType: "group_message",
      raw: raw as unknown as Record<string, any>,
    }
    ;(event.raw as any).sender = {
      user_id: userOpenid || memberOpenid,
      nickname,
      card: "",
      role: author.member_role ?? "member",
      member_openid: memberOpenid,
      user_openid: userOpenid,
      username: nickname,
      is_bot: !!author.bot,
    }
    ;(event.raw as any).message_id = d.id ?? ""
    ;(event.raw as any).time = d.timestamp ? Math.floor(new Date(d.timestamp).getTime() / 1000) : Math.floor(Date.now() / 1000)
    ;(event.raw as any).platform = "qq-official"
    adapter.cacheMessage(event)
    adapter.emitEvent("group_message", event)
    return
  }

  if (eventType === "C2C_MESSAGE_CREATE") {
    // 单聊（用户直接找机器人）
    const author = d.author ?? {}
    const userOpenid = author.user_openid ?? author.id ?? ""
    const nickname = String(author.username ?? author.nickname ?? "")
    const event: BotEvent = {
      botId,
      selfId,
      userId: userOpenid,
      groupId: undefined,
      message: qqMsgToSegments(d),
      postType: "private_message",
      raw: raw as unknown as Record<string, any>,
    }
    ;(event.raw as any).sender = {
      user_id: userOpenid,
      nickname,
      card: "",
      role: "user",
      user_openid: userOpenid,
      username: nickname,
      is_bot: !!author.bot,
    }
    ;(event.raw as any).message_id = d.id ?? ""
    ;(event.raw as any).time = d.timestamp ? Math.floor(new Date(d.timestamp).getTime() / 1000) : Math.floor(Date.now() / 1000)
    ;(event.raw as any).platform = "qq-official"
    adapter.cacheMessage(event)
    adapter.emitEvent("private_message", event)
    return
  }

  if (eventType === "MESSAGE_CREATE" || eventType === "AT_MESSAGE_CREATE") {
    // 频道消息（公域，旧版结构）
    const event: BotEvent = {
      botId,
      selfId,
      userId: d.author?.id ?? "",
      groupId: d.channel_id ?? "",
      message: qqMsgToSegments(d),
      postType: "group_message",
      raw: raw as unknown as Record<string, any>,
    }
    ;(event.raw as any).sender = {
      user_id: d.author?.id ?? "",
      nickname: d.author?.username ?? "",
      card: "",
      role: "member",
    }
    ;(event.raw as any).message_id = d.id ?? ""
    ;(event.raw as any).time = d.timestamp ? Math.floor(new Date(d.timestamp).getTime() / 1000) : Math.floor(Date.now() / 1000)
    ;(event.raw as any).platform = "qq-official"
    adapter.cacheMessage(event)
    adapter.emitEvent("group_message", event)
    return
  }

  if (eventType === "INTERACTION_CREATE") {
    // 按钮/交互回调（用户点击 markdown 附带的按钮）
    const dd = d.data ?? {}
    const resolved = dd.resolved ?? {}
    const clickUser = String(
      resolved.user?.id ?? d.user?.id ?? d.author?.user_openid ?? d.member?.user?.id ?? ""
    )
    const groupContext = d.group_openid ?? d.channel_id ?? d.guild_id
    const buttonId = String(dd.button_id ?? resolved.button_data?.id ?? "")
    const buttonLabel = String(resolved.button_data?.label ?? dd.label ?? "")
    const event: BotEvent = {
      botId,
      selfId,
      userId: clickUser,
      groupId: groupContext ? String(groupContext) : undefined,
      message: [],
      postType: "notice",
      raw: raw as unknown as Record<string, any>,
    }
    ;(event.raw as any).notice_type = "INTERACTION_CREATE"
    ;(event.raw as any).button_id = buttonId
    ;(event.raw as any).button_label = buttonLabel
    ;(event.raw as any).button_data = dd
    ;(event.raw as any).interaction_id = d.id ?? ""
    ;(event.raw as any).time = Math.floor(Date.now() / 1000)
    ;(event.raw as any).platform = "qq-official"
    adapter.emitEvent("notice", event)
    return
  }

  // 其余事件（加群/退群/加好友等）作为 notice 派发，插件可按需监听
  const noticeEvent: BotEvent = {
    botId,
    selfId,
    userId: d.author?.user_openid ?? d.author?.id ?? "",
    groupId: d.group_openid ?? d.channel_id ?? undefined,
    message: [],
    postType: "notice",
    raw: raw as unknown as Record<string, any>,
  }
  ;(noticeEvent.raw as any).notice_type = eventType
  ;(noticeEvent.raw as any).platform = "qq-official"
  adapter.emitEvent("notice", noticeEvent)
}

// QQ 消息内容 → 框架统一消息段
// 支持：文本 / 图片 / 视频 / 语音(record) / 文件 / 引用消息 / @ / 表情 / ARK卡片
// 新版消息（GROUP_AT_MESSAGE_CREATE / C2C_MESSAGE_CREATE）：
// - message_type: 0=文本 3=ARK卡片 101=并行 102=聊天记录 103=引用
// - attachments:  图片/视频/语音/文件附件
// - msg_elements: 引用/聊天记录/并行消息的内容元素（递归）
// - mentions:     @的用户列表
// 旧版频道消息（MESSAGE_CREATE / AT_MESSAGE_CREATE）：
// - msg_type: 2=图片 3=视频 4=语音 7=富媒体
// - attachments: 同新版
function qqMsgToSegments(d: any): Array<{ type: string; data: Record<string, any> }> {
  const segments: Array<{ type: string; data: Record<string, any> }> = []
  const msgType = d.message_type ?? d.msg_type ?? 0
  const content = String(d.content ?? "")

  // 1) 引用消息（message_type=103）：msg_elements[0] 为被引用内容
  const elements = Array.isArray(d.msg_elements) ? d.msg_elements : []
  if (msgType === 103 && elements.length) {
    const ref = elements[0]
    // 被引用消息 ID：msg_idx（REFIDX_...）或 message_scene.ext 里的 ref_msg_idx
    const refId = String(
      ref.msg_idx ??
      (Array.isArray(d.message_scene?.ext)
        ? d.message_scene.ext.map((e: string) => String(e)).find((e: string) => e.startsWith("ref_msg_idx="))?.split("=")[1] ?? ""
        : "") ??
      ""
    )
    segments.push({
      type: "reply",
      data: {
        id: refId || String(d.id ?? ""),        // 被引用消息 ID（segKeep 模板 [reply.{id}] 用）
        text: String(ref.content ?? ""),         // 被引用消息正文（模板可改 [reply.{text}]）
        name: ref.author?.username ?? "",        // 被引用消息发送者昵称
        message_id: String(d.id ?? ""),          // 当前消息 ID
      },
    })
  } else if (msgType === 102) {
    // 聊天记录：合并各元素正文
    const parts: string[] = []
    const collect = (list: any[]) => {
      for (const el of list ?? []) {
        if (el?.content) parts.push(String(el.content))
        if (Array.isArray(el.msg_elements)) collect(el.msg_elements)
      }
    }
    collect(elements)
    if (parts.length) segments.push({ type: "text", data: { text: parts.join("\n") } })
  } else if (msgType === 101) {
    // 并行消息：递归展开所有元素
    const collect = (list: any[]) => {
      for (const el of list ?? []) {
        if (el?.content) {
          const sub = qqMsgToSegments(el)
          if (sub.length) segments.push(...sub)
        }
        if (Array.isArray(el.msg_elements)) collect(el.msg_elements)
      }
    }
    collect(elements)
  } else if (msgType === 3 && d.ark_data) {
    // ARK 卡片消息：转 json 段（保留结构化数据）
    segments.push({ type: "json", data: { data: JSON.stringify(d.ark_data) } })
  }

  // 2) 文本内容（去 @机器人 前缀；content 可能含 <img>/<emoji>/<a> 等标签，一并解析）
  const text = stripQqMentions(content)
  if (text) {
    pushMarkdownTags(segments, text)
  }

  // 3) @ 的用户列表 → at 段
  if (Array.isArray(d.mentions)) {
    for (const m of d.mentions) {
      if (!m) continue
      segments.push({
        type: "at",
        data: { qq: m.user_openid ?? m.id ?? "", name: m.username ?? "" },
      })
    }
  }

  // 4) 附件（图片/视频/语音/文件）→ 媒体段
  if (Array.isArray(d.attachments)) {
    for (const att of d.attachments) {
      if (!att || !att.url) continue
      const ct = String(att.content_type ?? "").toLowerCase()
      const url = String(att.url)
      if (ct.startsWith("image")) {
        segments.push({ type: "image", data: { url, file: url, name: att.filename ?? "" } })
      } else if (ct === "voice" || ct.includes("audio")) {
        const seg: Record<string, any> = { url, file: url, name: att.filename ?? "" }
        if (att.voice_wav_url) seg.wav = String(att.voice_wav_url)
        if (att.asr_refer_text) seg.asr = String(att.asr_refer_text)
        segments.push({ type: "record", data: seg })
      } else if (ct.includes("video")) {
        segments.push({ type: "video", data: { url, file: url, name: att.filename ?? "" } })
      } else if (ct === "file") {
        segments.push({ type: "file", data: { url, file: url, name: att.filename ?? "" } })
      } else {
        segments.push({ type: "file", data: { url, file: url, name: att.filename ?? att.url ?? "" } })
      }
    }
  }

  // 5) 旧版频道消息：msg_type=2/3/4 时 content 即媒体 url
  if (!segments.length && /^https?:\/\//.test(content)) {
    if (msgType === 2) segments.push({ type: "image", data: { url: content, file: content } })
    else if (msgType === 3) segments.push({ type: "video", data: { url: content, file: content } })
    else if (msgType === 4) segments.push({ type: "record", data: { url: content, file: content } })
  }

  return segments
}

// 解析 content 中的富文本标签并追加到 segments：
// <img src=".."/>、<video src=".."/>、<record src=".."/>、<emoji:id/>、<a href="..">text</a>、<@xxx/>
// 文本部分作为 text 段保留，按出现顺序拼接。
function pushMarkdownTags(segments: Array<{ type: string; data: Record<string, any> }>, raw: string): void {
  const RE =
    /(<img[^>]*src="([^"]*)"[^>]*\/?>|<video[^>]*src="([^"]*)"[^>]*\/?>|<record[^>]*src="([^"]*)"[^>]*\/?>|<audio[^>]*src="([^"]*)"[^>]*\/?>|<emoji:(\d+)\/>|<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>|<@!?([^>\/\s]+)\/>)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = RE.exec(raw)) !== null) {
    const before = raw.slice(last, m.index)
    if (before) segments.push({ type: "text", data: { text: before } })
    const [full, , img, video, record, audio, emoji, href, linkText, atId] = m
    if (img) segments.push({ type: "image", data: { url: img, file: img } })
    else if (video) segments.push({ type: "video", data: { url: video, file: video } })
    else if (record) segments.push({ type: "record", data: { url: record, file: record } })
    else if (audio) segments.push({ type: "record", data: { url: audio, file: audio } })
    else if (emoji) segments.push({ type: "face", data: { id: emoji } })
    else if (href) {
      const t = (linkText ?? "").trim()
      segments.push({ type: "text", data: { text: t ? `${t} (${href})` : href } })
    } else if (atId) {
      segments.push({ type: "at", data: { qq: atId, name: atId } })
    }
    last = m.index + full.length
  }
  const tail = raw.slice(last)
  if (tail) segments.push({ type: "text", data: { text: tail } })
}
