import type { BotEvent } from "../../core/models/event.js"
import { MessageSegment, type MessageChain } from "../../core/models/message.js"
import type { QqGatewayPayload, QqMessageData } from "./types.js"
import { QQ_INTERACTION_TYPE } from "./types.js"
import type { QqAdapter } from "./client.js"

// 将 QQ 官方机器人事件转换为统一 BotEvent
// 事件来源（intents）：
// - 群@消息 GROUP_AT_MESSAGE_CREATE / 全量 GROUP_MESSAGE_CREATE（1<<25）
// - 单聊 C2C_MESSAGE_CREATE（1<<25）
// - 频道 @消息 AT_MESSAGE_CREATE / 全量 MESSAGE_CREATE（1<<30 或 1<<9）
// - 频道私信 DIRECT_MESSAGE_CREATE（1<<12）
// - 按钮/菜单交互 INTERACTION_CREATE（1<<26）
// - 群机器人进退、群成员变动、好友、主动消息开关、订阅状态、消息审核等通知
export function convertQqEvent(
  payload: QqGatewayPayload,
  botId: string,
  selfId: string,
  adapter: QqAdapter,
): void {
  const t = payload.t ?? ""
  const d = (payload.d ?? {}) as any
  const topEventId = String(payload.id ?? "")

  // ===== 消息事件 =====
  if (t === "GROUP_AT_MESSAGE_CREATE" || t === "GROUP_MESSAGE_CREATE") {
    const event = buildMessageEvent({
      payload, d, botId, selfId, chatType: 1,
      groupId: String(d.group_openid ?? ""),
      userId: String(d.author?.member_openid ?? ""),
      postType: "group_message",
    })
    adapter.cacheMessage(event)
    adapter.emitEvent("group_message", event)
    return
  }

  if (t === "C2C_MESSAGE_CREATE") {
    const event = buildMessageEvent({
      payload, d, botId, selfId, chatType: 2,
      groupId: "",
      userId: String(d.author?.user_openid ?? ""),
      postType: "private_message",
    })
    adapter.cacheMessage(event)
    adapter.emitEvent("private_message", event)
    return
  }

  if (t === "AT_MESSAGE_CREATE" || t === "MESSAGE_CREATE") {
    const event = buildMessageEvent({
      payload, d, botId, selfId, chatType: 0,
      groupId: String(d.channel_id ?? ""),
      userId: String(d.author?.id ?? d.author?.user_openid ?? ""),
      postType: "group_message",
    })
    adapter.cacheMessage(event)
    adapter.emitEvent("group_message", event)
    return
  }

  if (t === "DIRECT_MESSAGE_CREATE") {
    const event = buildMessageEvent({
      payload, d, botId, selfId, chatType: 0,
      groupId: "",
      userId: String(d.author?.id ?? d.author?.user_openid ?? ""),
      postType: "private_message",
    })
    // 频道私信保留 channel_id / guild_id 于 raw
    Object.assign(event.raw as object, { channel_id: String(d.channel_id ?? ""), guild_id: String(d.guild_id ?? "") })
    adapter.cacheMessage(event)
    adapter.emitEvent("private_message", event)
    return
  }

  // ===== 交互事件（按钮 / 菜单 / 反馈等）=====
  if (t === "INTERACTION_CREATE") {
    convertInteraction(payload, botId, selfId, adapter)
    return
  }

  // ===== 群机器人被加 / 被移出 =====
  if (t === "GROUP_ADD_ROBOT" || t === "GROUP_DEL_ROBOT") {
    const event = baseNotice(botId, selfId, "group_robot", t === "GROUP_ADD_ROBOT" ? "add" : "remove", d, topEventId, 1)
    event.groupId = String(d.group_openid ?? "")
    event.userId = String(d.op_member_openid ?? "")
    adapter.emitEvent("notice", event)
    return
  }

  // ===== 群成员进退（1<<24）=====
  if (t === "GROUP_MEMBER_ADD" || t === "GROUP_MEMBER_REMOVE") {
    const event = baseNotice(botId, selfId, "group_member", t === "GROUP_MEMBER_ADD" ? "increase" : "decrease", d, topEventId, 1)
    event.groupId = String(d.group_openid ?? "")
    event.userId = String(d.member_openid ?? "")
    adapter.emitEvent("notice", event)
    return
  }

  // ===== 用户申请加群（1<<24）=====
  if (t === "GROUP_JOIN_REQUEST") {
    const event = baseNotice(botId, selfId, "group_request", "add", d, topEventId, 1)
    event.groupId = String(d.group_openid ?? "")
    event.userId = String(d.member_openid ?? "")
    Object.assign(event.raw as object, {
      join_request_id: String(d.join_request_id ?? ""),
      comment: String(d.verify_info?.verify_message ?? ""),
      apply_source: String(d.apply_source ?? ""),
      invited_by: String(d.invited_by ?? ""),
      flag: String(d.join_request_id ?? ""),
    })
    adapter.emitEvent("notice", event)
    return
  }

  // ===== 好友增删 =====
  if (t === "FRIEND_ADD" || t === "FRIEND_DEL") {
    const event = baseNotice(botId, selfId, "friend", t === "FRIEND_ADD" ? "increase" : "decrease", d, topEventId, 2)
    event.userId = String(d.openid ?? "")
    adapter.emitEvent("notice", event)
    return
  }

  // ===== 单聊主动消息开关 =====
  if (t === "C2C_MSG_RECEIVE" || t === "C2C_MSG_REJECT") {
    const event = baseNotice(botId, selfId, "c2c_setting", t === "C2C_MSG_RECEIVE" ? "receive" : "reject", d, topEventId, 2)
    event.userId = String(d.openid ?? "")
    adapter.emitEvent("notice", event)
    return
  }

  // ===== 群主动消息开关 =====
  if (t === "GROUP_MSG_RECEIVE" || t === "GROUP_MSG_REJECT") {
    const event = baseNotice(botId, selfId, "group_setting", t === "GROUP_MSG_RECEIVE" ? "receive" : "reject", d, topEventId, 1)
    event.groupId = String(d.group_openid ?? "")
    event.userId = String(d.op_member_openid ?? "")
    adapter.emitEvent("notice", event)
    return
  }

  // ===== 订阅消息模板授权状态 =====
  if (t === "SUBSCRIBE_MESSAGE_STATUS") {
    const event = baseNotice(botId, selfId, "subscribe_status", "", d, topEventId, d.group_openid ? 1 : 2)
    event.groupId = String(d.group_openid ?? "")
    event.userId = String(d.openid ?? "")
    adapter.emitEvent("notice", event)
    return
  }

  // ===== 频道消息审核结果（1<<27）=====
  if (t === "MESSAGE_AUDIT_PASS" || t === "MESSAGE_AUDIT_REJECT") {
    const event = baseNotice(botId, selfId, "message_audit", t === "MESSAGE_AUDIT_PASS" ? "pass" : "reject", d, topEventId, 0)
    event.groupId = String(d.channel_id ?? "")
    adapter.emitEvent("notice", event)
    return
  }

  // ===== 音频 / 论坛 / 其他频道通知：统一透传为 notice =====
  if (
    t === "AUDIO_START" || t === "AUDIO_FINISH" || t === "AUDIO_OFFLINE" ||
    t === "FORUM_THREAD_CREATE" || t === "FORUM_THREAD_UPDATE" || t === "FORUM_THREAD_DELETE" ||
    t === "FORUM_POST_CREATE" || t === "FORUM_POST_DELETE" ||
    t === "FORUM_REPLY_CREATE" || t === "FORUM_REPLY_DELETE" ||
    t === "FORUM_PUBLISH_AUDIT_RESULT" ||
    t === "MESSAGE_REACTION_ADD" || t === "MESSAGE_REACTION_REMOVE" ||
    t === "OPEN_FORUM_THREAD_CREATE" || t === "OPEN_FORUM_THREAD_UPDATE" ||
    t === "OPEN_FORUM_THREAD_DELETE" || t === "OPEN_FORUM_POST_CREATE" ||
    t === "OPEN_FORUM_POST_DELETE" || t === "OPEN_FORUM_REPLY_CREATE" ||
    t === "OPEN_FORUM_REPLY_DELETE"
  ) {
    const event = baseNotice(botId, selfId, t.toLowerCase(), "", d, topEventId, 0)
    event.groupId = String(d.channel_id ?? "")
    event.userId = String(d.user_id ?? d.author?.id ?? "")
    adapter.emitEvent("notice", event)
    return
  }

  // 其余未识别事件忽略，避免向插件派发噪声
}

// 构建消息事件
function buildMessageEvent(args: {
  payload: QqGatewayPayload
  d: QqMessageData
  botId: string
  selfId: string
  chatType: number
  groupId: string
  userId: string
  postType: "group_message" | "private_message"
}): BotEvent {
  const { d, botId, selfId, chatType, groupId, userId, postType, payload } = args
  const message = buildMessageSegments(d)
  const isGroup = postType === "group_message"
  const event: BotEvent = {
    botId,
    selfId,
    userId,
    groupId: isGroup ? groupId : undefined,
    message,
    postType,
    raw: {
      // 消息 ID（被动回复 msg_id）；顶层事件 ID（event_id）
      message_id: String(d.id ?? ""),
      event_id: String(payload.id ?? ""),
      chat_type: chatType,
      platform: "qq-official",
      sender: buildSender(d, chatType),
      time: toUnixSeconds(d.timestamp),
      group_openid: String(d.group_openid ?? ""),
      user_openid: String(d.author?.user_openid ?? d.author?.id ?? ""),
      guild_id: String(d.guild_id ?? ""),
      channel_id: String(d.channel_id ?? ""),
      raw_message: d,
    },
  }
  return event
}

// 交互事件转换
function convertInteraction(
  payload: QqGatewayPayload,
  botId: string,
  selfId: string,
  adapter: QqAdapter,
): void {
  const d = payload.d ?? {}
  const interactionId = String(d.id ?? "")
  const passiveEventId = String(payload.id ?? "")
  const type = Number(d.type ?? 0)
  const resolved = d.data?.resolved ?? {}
  const groupOpenid = String(d.group_openid ?? "")
  const memberOpenid = String(d.group_member_openid ?? "")
  const userOpenid = String(d.user_openid ?? (d.member?.user?.id ?? ""))
  const chatType = Number(d.chat_type ?? (groupOpenid ? 1 : userOpenid ? 2 : 0))

  // 仅 type=11（内联按钮）/12（快捷菜单）需要回应；
  // 必须立即 PUT /interactions/{interaction_id}，否则客户端一直 loading 直到超时。
  // 回应只负责停止 loading，业务消息另以事件最外层 id 作为 event_id 走被动发送。
  if ((type === QQ_INTERACTION_TYPE.INLINE_KEYBOARD || type === QQ_INTERACTION_TYPE.CALLBACK_COMMAND) && interactionId) {
    void adapter.ackInteraction(interactionId, 0).catch((e: unknown) => {
      console.error(`[${botId}] 交互回应失败: ${(e as Error)?.message ?? e}`)
    })
  }

  const buttonData = String(resolved.button_data ?? resolved.data ?? "")
  const message: MessageChain = buttonData ? [MessageSegment.text(buttonData)] : []

  const event: BotEvent = {
    botId,
    selfId,
    userId: chatType === 1 ? memberOpenid : userOpenid,
    groupId: chatType === 1 ? groupOpenid : chatType === 0 ? String(d.channel_id ?? "") : undefined,
    message,
    postType: "notice",
    raw: {
      notice_type: "interaction",
      sub_type: interactionSubType(type),
      interaction_id: interactionId,
      // 被动消息 event_id 取事件最外层 id（群 5 分钟 / 单聊 60 分钟窗口）
      event_id: passiveEventId,
      interaction_type: type,
      chat_type: chatType,
      platform: "qq-official",
      resolved: {
        button_id: String(resolved.button_id ?? resolved.feature_id ?? ""),
        button_data: buttonData,
        ...resolved,
      },
      group_openid: groupOpenid,
      member_openid: memberOpenid,
      user_openid: userOpenid,
      guild_id: String(d.guild_id ?? ""),
      channel_id: String(d.channel_id ?? ""),
      time: toUnixSeconds(d.timestamp),
      raw_event: d,
    },
  }
  adapter.emitEvent("notice", event)
}

// 交互类型 → sub_type 语义
function interactionSubType(type: number): string {
  switch (type) {
    case QQ_INTERACTION_TYPE.INLINE_KEYBOARD: return "button"
    case QQ_INTERACTION_TYPE.CALLBACK_COMMAND: return "command"
    case QQ_INTERACTION_TYPE.MESSAGE_FEEDBACK: return "feedback"
    case QQ_INTERACTION_TYPE.CLEAR_SESSION: return "clear_session"
    case QQ_INTERACTION_TYPE.STORY_CHANGE: return "story"
    case QQ_INTERACTION_TYPE.MODEL_SWITCH: return "model_switch"
    case QQ_INTERACTION_TYPE.USER_AUTHORIZE: return "user_authorize"
    case QQ_INTERACTION_TYPE.GROUP_AUTHORIZE: return "group_authorize"
    case QQ_INTERACTION_TYPE.GROUP_AUTHORIZE_CHANGE: return "group_authorize_change"
    default: return "unknown"
  }
}

// 通知事件基础结构
function baseNotice(
  botId: string,
  selfId: string,
  noticeType: string,
  subType: string,
  d: any,
  topEventId: string,
  chatType: number,
): BotEvent {
  return {
    botId,
    selfId,
    userId: "",
    message: [],
    postType: "notice",
    raw: {
      notice_type: noticeType,
      sub_type: subType,
      event_id: String(d.id ?? topEventId ?? ""),
      chat_type: chatType,
      platform: "qq-official",
      time: toUnixSeconds(d.timestamp ?? d.apply_at),
      raw_event: d,
    },
  }
}

// 构建发送者信息
function buildSender(d: QqMessageData, chatType: number): Record<string, unknown> {
  const a = d.author ?? {}
  if (chatType === 1) {
    return {
      user_id: String(a.member_openid ?? ""),
      member_openid: String(a.member_openid ?? ""),
      nickname: String(a.member_name ?? ""),
      member_role: String(a.member_role ?? ""),
      is_bot: !!a.bot,
    }
  }
  if (chatType === 2) {
    return {
      user_id: String(a.user_openid ?? ""),
      user_openid: String(a.user_openid ?? ""),
      nickname: String(a.user_name ?? ""),
      is_bot: !!a.bot,
    }
  }
  return {
    user_id: String(a.id ?? a.user_openid ?? ""),
    nickname: String(a.username ?? a.member_name ?? ""),
    avatar: String(a.avatar ?? ""),
    is_bot: !!a.bot,
    roles: Array.isArray(a.roles) ? a.roles : [],
  }
}

// 由消息事件构建消息段：文本（含 @ 解析）+ 附件 + markdown/ark/embed + 引用
function buildMessageSegments(d: QqMessageData): MessageChain {
  const segments: MessageChain = []
  const content = String(d.content ?? "")

  // 解析 <@!id>/<@id> 提及为 at 段，其余作为文本
  const mentionRe = /<@!?(\d+)>/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = mentionRe.exec(content)) !== null) {
    if (m.index > last) pushText(content.slice(last, m.index))
    segments.push(MessageSegment.at(m[1]))
    last = m.index + m[0].length
  }
  if (last < content.length) pushText(content.slice(last))
  function pushText(t: string): void {
    const tt = t.trim()
    if (tt) segments.push(MessageSegment.text(tt))
  }

  // 附件：群/C2C 附件 url 为相对路径，补 files.qlogo.cn 主机
  for (const attachment of d.attachments ?? []) {
    const rawUrl = String(attachment.url ?? "")
    const url = /^https?:\/\//.test(rawUrl) ? rawUrl : `https://files.qlogo.cn${rawUrl.startsWith("/") ? "" : "/"}${rawUrl}`
    const ct = String(attachment.content_type ?? "")
    if (ct.startsWith("image") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(rawUrl)) {
      segments.push(MessageSegment.image(url))
    } else if (ct.startsWith("video") || /\.(mp4|mov)$/i.test(rawUrl)) {
      segments.push(MessageSegment.video(url))
    } else if (ct.startsWith("audio") || /\.(silk|amr|wav|mp3|flac)$/i.test(rawUrl)) {
      segments.push(MessageSegment.record(url))
    } else {
      segments.push(MessageSegment.file({ url, name: String(attachment.filename ?? "file") }))
    }
  }

  // markdown / ark / embed / 引用
  if (d.markdown) {
    segments.push(MessageSegment.markdown({ content: String(d.markdown.content ?? content) }))
  }
  if (d.ark) segments.push(MessageSegment.json(JSON.stringify(d.ark)))
  if (d.embed) segments.push(MessageSegment.embed(d.embed))
  if (d.message_reference?.message_id) {
    segments.push(MessageSegment.reply(String(d.message_reference.message_id)))
  }
  return segments
}

// ISO 时间串 / Unix 秒 → Unix 秒
function toUnixSeconds(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v) {
    const parsed = Date.parse(v)
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000)
  }
  return Math.floor(Date.now() / 1000)
}

// 将消息段序列化为 QQ 纯文本（markdown/按钮/卡片等走独立字段，此处返回空）
export function segmentsToQqText(segments: Array<{ type: string; data: Record<string, any> }>): string {
  let text = ""
  for (const seg of segments) {
    switch (seg.type) {
      case "text":
        text += String(seg.data?.text ?? "")
        break
      case "at":
        text += `<@${seg.data?.qq ?? ""}>`
        break
      case "face":
        text += `<emoji:${seg.data?.id ?? ""}>`
        break
      case "image":
      case "video":
      case "record":
      case "file":
      case "json":
      case "ark":
      case "embed":
      case "music":
      case "forward":
      case "markdown":
      case "button":
        // 上述类型通过对应消息字段发送，不计入纯文本
        break
      default:
        break
    }
  }
  return text
}
