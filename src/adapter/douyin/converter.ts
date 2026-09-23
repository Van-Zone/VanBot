import type { BotEvent } from "../../core/models/event.js"
import type { DouyinAdapter } from "./client.js"
import type { DouyinRawMessage } from "./types.js"

// 抖音网页版消息（DOM 提取）→ 框架统一事件并派发
// 私聊：userId = 对方昵称；群聊：groupId = 群名。
// 网页版只提供文本预览，富媒体以占位文本呈现。
export function convertDouyinMessage(
  raw: DouyinRawMessage,
  botId: string,
  selfId: string,
  adapter: DouyinAdapter
): void {
  const postType = raw.isGroup ? "group_message" : "private_message"
  const text = raw.text || "[未知消息]"
  const event: BotEvent = {
    botId,
    selfId,
    userId: raw.isGroup ? "" : raw.convName,
    groupId: raw.isGroup ? raw.convName : undefined,
    message: [{ type: "text", data: { text } }],
    postType,
    raw: raw as unknown as Record<string, any>,
  }
  ;(event.raw as any).sender = {
    nickname: raw.senderName || raw.convName || "",
    user_id: raw.isGroup ? "" : raw.convName,
  }
  ;(event.raw as any).platform = "douyin"
  ;(event.raw as any).time = raw.time
  adapter.emitEvent(postType, event)
}
