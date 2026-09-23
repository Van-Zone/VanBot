import type { BotEvent } from "../../core/models/event.js"
import type { WechatRawPayload, WechatRawMessage, WechatRawEvent } from "./types.js"
import type { WechatAdapter } from "./client.js"

// 简易 XML 解析（仅处理微信回调的扁平结构，不支持嵌套）
// 微信回调 XML 格式：
// <xml>
// <ToUserName><![CDATA[xxx]]></ToUserName>
// <FromUserName><![CDATA[xxx]]></FromUserName>
// ...
// </xml>
export function parseWechatXml(xml: string): Record<string, string> {
  const result: Record<string, string> = {}
  const reg = /<(\w+)>(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*))<\/\1>/g
  let m: RegExpExecArray | null
  while ((m = reg.exec(xml)) !== null) {
    result[m[1]] = m[2] !== undefined ? m[2] : (m[3] ?? "")
  }
  return result
}

// 微信消息 → 框架统一消息段
function wechatMsgToSegments(raw: WechatRawMessage): Array<{ type: string; data: Record<string, any> }> {
  const segments: Array<{ type: string; data: Record<string, any> }> = []
  switch (raw.MsgType) {
    case "text":
      segments.push({ type: "text", data: { text: raw.Content ?? "" } })
      break
    case "image":
      segments.push({
        type: "image",
        data: { file: raw.MediaId ?? "", url: raw.PicUrl ?? "", media_id: raw.MediaId ?? "" },
      })
      break
    case "voice":
      segments.push({
        type: "record",
        data: { file: raw.MediaId ?? "", media_id: raw.MediaId ?? "", format: raw.Format ?? "", recognition: raw.Recognition ?? "" },
      })
      break
    case "video":
    case "shortvideo":
      segments.push({
        type: "video",
        data: { file: raw.MediaId ?? "", media_id: raw.MediaId ?? "", thumb_media_id: raw.ThumbMediaId ?? "" },
      })
      break
    case "file":
      segments.push({
        type: "file",
        data: { file: raw.MediaId ?? "", media_id: raw.MediaId ?? "", name: raw.Title ?? "file" },
      })
      break
    case "location":
      segments.push({
        type: "location",
        data: {
          lat: raw.Location_X ?? 0,
          lon: raw.Location_Y ?? 0,
          scale: raw.Scale ?? 0,
          label: raw.Label ?? "",
        },
      })
      break
    case "link":
      segments.push({
        type: "link",
        data: { title: raw.Title ?? "", description: raw.Description ?? "", url: raw.Url ?? "" },
      })
      break
    default:
      // 未知类型，放原始内容到文本
      segments.push({ type: "text", data: { text: `[${raw.MsgType}]` } })
      break
  }
  return segments
}

// 将微信原始消息/事件转换为框架统一事件并派发
export function convertWechatEvent(raw: WechatRawPayload, botId: string, adapter: WechatAdapter): void {
  const isEvent = raw.MsgType === "event"
  const fromUser = raw.FromUserName  // OpenID
  const toUser = raw.ToUserName      // 公众号微信号

  // 微信公众号没有群概念，全部作为私聊处理
  const event: BotEvent = {
    botId,
    selfId: toUser,                   // 公众号自身ID
    userId: fromUser,                 // 用户 OpenID
    groupId: undefined,               // 公众号无群
    message: isEvent ? [] : wechatMsgToSegments(raw as WechatRawMessage),
    postType: "private_message",
    raw: raw as unknown as Record<string, any>,
  }

  // 补充 sender 信息，兼容 keyword.ts 的 event.raw.sender 读取
  ;(event.raw as any).sender = {
    user_id: fromUser,
    nickname: "",                     // 微信 OpenID 无法直接获取昵称，需调用 API
    card: "",
    role: "user",
  }
  ;(event.raw as any).message_id = (raw as WechatRawMessage).MsgId ?? ""
  ;(event.raw as any).time = raw.CreateTime
  ;(event.raw as any).platform = "wechat"

  let eventName = ""
  if (isEvent) {
    const ev = raw as WechatRawEvent
    eventName = "notice"
    ;(event.raw as any).notice_type = ev.Event
    ;(event.raw as any).event_key = ev.EventKey ?? ""
  } else {
    eventName = "private_message"
  }

  event.postType = eventName as BotEvent["postType"]

  if (eventName) {
    adapter.emitEvent(eventName, event)
  }
}

// 生成被动回复 XML（5秒内返回给微信服务器）
export function buildPassiveReply(
  toUser: string,
  fromUser: string,
  content: string
): string {
  const now = Math.floor(Date.now() / 1000)
  const escaped = content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
  return `<xml>
  <ToUserName><![CDATA[${toUser}]]></ToUserName>
  <FromUserName><![CDATA[${fromUser}]]></FromUserName>
  <CreateTime>${now}</CreateTime>
  <MsgType><![CDATA[text]]></MsgType>
  <Content><![CDATA[${escaped}]]></Content>
</xml>`
}
