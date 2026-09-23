// WeFlow 消息转换器：WeFlowMessage → 框架统一 BotEvent
import type { BotEvent } from "../../core/models/event.js"
import type { WeFlowMessage } from "./types.js"

// 判断是否为群消息
export function isGroupMessage(talker: string): boolean {
  return talker.endsWith("@chatroom")
}

// 从群消息 content 中提取实际发送者和文本
// WeFlow 群消息格式可能是 "wxid:\n内容" 或包含 speaker 字段
export function parseGroupContent(msg: WeFlowMessage): { sender: string; text: string } {
  let sender = msg.speaker ?? ""
  let text = msg.content ?? ""

  // 如果没有 speaker，尝试从 content 中提取
  if (!sender && text) {
    const lines = text.split("\n")
    if (lines.length >= 2 && lines[0].endsWith(":")) {
      sender = lines[0].slice(0, -1)
      text = lines.slice(1).join("\n")
    }
  }

  return { sender, text }
}

// 将 WeFlow 消息转换为框架统一事件
export function convertWeFlowMessage(
  msg: WeFlowMessage,
  botId: string,
  selfId: string,
): BotEvent {
  const talker = msg.talker ?? ""
  const group = isGroupMessage(talker)

  let sender = msg.speaker ?? talker
  let text = msg.content ?? ""

  if (group) {
    const parsed = parseGroupContent(msg)
    sender = parsed.sender || talker
    text = parsed.text
  }

  // 消息段数组
  const message: Array<{ type: string; data: Record<string, unknown> }> = [
    { type: "text", data: { text } },
  ]

  return {
    botId,
    selfId,
    userId: sender,
    groupId: group ? talker : undefined,
    message,
    postType: group ? "group_message" : "private_message",
    raw: {
      ...msg,
      message_id: msg.msgId,
      time: msg.createTime || Math.floor(Date.now() / 1000),
    },
  }
}
