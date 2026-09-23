import type { BotEvent } from "../../core/models/event.js"
import type { MinecraftAdapter } from "./client.js"

// mineflayer 聊天消息 → 框架统一事件
// Minecraft 聊天是全局广播（无群概念），统一按私聊事件派发：
// userId 为发言玩家名，selfId 为机器人游戏名。
// 若来自机器人自身（ignored），返回 null。
export function mcChatToEvent(
  player: string,
  msg: string,
  botId: string,
  selfId: string,
  adapter: MinecraftAdapter,
): BotEvent | null {
  if (selfId && player === selfId) return null
  const event: BotEvent = {
    botId,
    selfId,
    userId: String(player),
    groupId: undefined,
    message: [{ type: "text", data: { text: String(msg) } }],
    postType: "private_message",
    raw: { player, msg: String(msg), platform: "minecraft" },
  }
  ;(event.raw as any).sender = { user_id: String(player), nickname: String(player), card: "" }
  ;(event.raw as any).time = Math.floor(Date.now() / 1000)
  return event
}
