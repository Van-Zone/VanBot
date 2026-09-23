// WeChatFerry 消息转换器：wechatferry WxMsg → 框架统一 BotEvent
import type { BotEvent } from "../../core/models/event.js"
import { WcfMsgType, WcfAppMsgType } from "./types.js"
import type { WcfRawMessage } from "./types.js"

// 从 XML 中提取指定标签的文本内容
function extractXmlTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i")
  const m = xml.match(re)
  return m ? m[1].trim() : ""
}

// 从 XML 中提取属性
function extractXmlAttr(xml: string, tag: string, attr: string): string {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, "i")
  const m = xml.match(re)
  return m ? m[1] : ""
}

// 判断是否为系统通知类消息（非用户普通消息）
export function isSystemMessage(raw: WcfRawMessage): boolean {
  return raw.type === WcfMsgType.Sys
      || raw.type === WcfMsgType.Recalled
      || raw.type === WcfMsgType.SysNotice
      || raw.type === WcfMsgType.StatusNotify
}

// 判断是否为自己发出的消息
export function isSelfMessage(raw: WcfRawMessage): boolean {
  return raw.isSender === 1
}

// 将 wechatferry 消息转换为框架统一事件
export function convertWcfEvent(raw: WcfRawMessage, botId: string, selfId: string): BotEvent {
  const isGroup = !!raw.roomid && raw.roomid !== ""
  const postType = isGroup ? "group_message" : "private_message"

  // 消息段数组
  const message: Array<{ type: string; data: Record<string, unknown> }> = []

  switch (raw.type) {
    case WcfMsgType.Text: // 文本
      message.push({ type: "text", data: { text: raw.content } })
      break

    case WcfMsgType.Image: // 图片
      message.push({
        type: "image",
        data: {
          file: raw.extra || raw.thumb || "",
          url: "",
          path: raw.extra || "",
        },
      })
      break

    case WcfMsgType.Voice: // 语音
      message.push({
        type: "record",
        data: {
          file: raw.extra || "",
          path: raw.extra || "",
        },
      })
      break

    case WcfMsgType.Video: // 视频
    case WcfMsgType.MicroVideo:
      message.push({
        type: "video",
        data: {
          file: raw.extra || "",
          thumb: raw.thumb || "",
        },
      })
      break

    case WcfMsgType.Emoticon: // 表情包
      message.push({
        type: "image",
        data: {
          file: raw.extra || raw.thumb || "",
          type: "emotion",
        },
      })
      break

    case WcfMsgType.Location: // 位置
      message.push({
        type: "location",
        data: {
          lat: extractXmlAttr(raw.xml, "location", "x"),
          lon: extractXmlAttr(raw.xml, "location", "y"),
          title: extractXmlAttr(raw.xml, "location", "label"),
          content: raw.content,
        },
      })
      break

    case WcfMsgType.App: { // 文件 / 链接 / 小程序 / 转账 / 聊天记录（XML 内容，需区分子类型）
      const appMsgType = Number(extractXmlAttr(raw.xml, "appmsg", "appmsg_type") || extractXmlAttr(raw.xml, "msg", "appmsg_type"))
      const title = extractXmlTag(raw.xml, "title")
      const des = extractXmlTag(raw.xml, "des")
      const url = extractXmlTag(raw.xml, "url")

      if (appMsgType === WcfAppMsgType.Url || (url && url.startsWith("http"))) {
        // 链接分享
        message.push({
          type: "share",
          data: { url, title, content: des },
        })
      } else if (appMsgType === WcfAppMsgType.ChatHistory || extractXmlTag(raw.xml, "recorditem")) {
        // 聊天记录
        message.push({ type: "text", data: { text: `[聊天记录] ${title}` } })
      } else if (extractXmlTag(raw.xml, "username") && extractXmlTag(raw.xml, "nickname")) {
        // 名片
        message.push({
          type: "contact",
          data: {
            wxid: extractXmlTag(raw.xml, "username"),
            nickname: extractXmlTag(raw.xml, "nickname"),
          },
        })
      } else if (appMsgType === WcfAppMsgType.MiniProgram || appMsgType === WcfAppMsgType.MiniProgramApp) {
        // 小程序
        message.push({
          type: "text",
          data: { text: `[小程序] ${title}` },
        })
      } else if (appMsgType === WcfAppMsgType.Transfers || Number(raw.type) === WcfMsgType.Transfer) {
        // 转账
        message.push({ type: "text", data: { text: `[转账] ${title}` } })
      } else if (Number(raw.type) === WcfMsgType.RedEnvelope || appMsgType === WcfAppMsgType.RedEnvelopes) {
        // 红包
        message.push({ type: "text", data: { text: `[红包] ${title}` } })
      } else {
        // 默认按文件处理
        const fileName = title || raw.content || "文件"
        message.push({
          type: "file",
          data: { file: raw.extra || "", name: fileName, path: raw.extra || "" },
        })
      }
      break
    }

    case WcfMsgType.File: // 文件（type=2004）
      message.push({
        type: "file",
        data: { file: raw.extra || "", name: raw.content || "文件", path: raw.extra || "" },
      })
      break

    case WcfMsgType.ShareCard: // 名片
      message.push({
        type: "contact",
        data: {
          wxid: extractXmlTag(raw.xml, "username"),
          nickname: extractXmlTag(raw.xml, "nickname"),
        },
      })
      break

    case WcfMsgType.Sys: // 系统通知（拍一拍、入群、退群等）
      message.push({ type: "text", data: { text: raw.content } })
      break

    case WcfMsgType.Recalled: // 撤回消息
      message.push({ type: "text", data: { text: "[撤回消息]" } })
      break

    case WcfMsgType.VerifyMsg: // 好友请求
    case WcfMsgType.PossibleFriendMsg:
      message.push({ type: "text", data: { text: `[好友请求] ${raw.content}` } })
      break

    default:
      // 未知类型，保留原始内容
      message.push({
        type: "text",
        data: { text: raw.content || `[未知消息类型: ${raw.type}]` },
      })
  }

  return {
    botId,
    selfId,
    userId: raw.sender,
    groupId: isGroup ? raw.roomid : undefined,
    message,
    postType: postType as BotEvent["postType"],
    raw: {
      ...raw,
      sender: { nickname: raw.sender }, // 微信没有昵称，用 wxid 占位
      message_id: raw.id,
      time: raw.createTime || Math.floor(Date.now() / 1000),
    },
  }
}
