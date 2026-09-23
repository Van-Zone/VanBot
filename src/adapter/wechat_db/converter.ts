// 微信数据库消息转换器：DbMessage → 框架统一 BotEvent
import type { BotEvent } from "../../core/models/event.js"
import type { DbMessage } from "./types.js"

// 将数据库消息转换为框架统一事件
// 注意：微信 4.x 每个聊天对象一张表，talker 从表名映射
export function convertDbMessage(
  msg: DbMessage,
  botId: string,
  selfId: string,
  talker: string
): BotEvent {
  const group = talker.endsWith("@chatroom")
  const text = msg.message_content || ""

  // 消息段数组
  const message: Array<{ type: string; data: Record<string, unknown> }> = [
    { type: "text", data: { text } },
  ]

  return {
    botId,
    selfId,
    userId: talker,
    groupId: group ? talker : undefined,
    message,
    postType: group ? "group_message" : "private_message",
    raw: {
      ...msg,
      message_id: msg.local_id,
      time: msg.create_time || Math.floor(Date.now() / 1000),
    },
  }
}
