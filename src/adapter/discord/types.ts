// Discord 官方机器人适配器类型定义
// 基于 Discord Bot API v10：
// Gateway:   GET https://discord.com/api/v10/gateway → wss://gateway.discord.gg/?v=10&encoding=json
// REST 基址:  https://discord.com/api/v10
// 鉴权:       Authorization: Bot {token}（Identify 里 token 为裸 token）
// 发送:       POST /channels/{channel_id}/messages
// 文档: https://discord.com/developers/docs/intro

// 网关 opcode
export const DISCORD_OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const

// 事件订阅 intents（位标记）
export const DISCORD_INTENT = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  DIRECT_MESSAGES: 1 << 12,
  DIRECT_MESSAGE_REACTIONS: 1 << 13,
  MESSAGE_CONTENT: 1 << 15, // 特权 Intent：读取消息正文必需
} as const

// 网关下行 payload
export interface DiscordGatewayPayload {
  op: number
  d?: any
  s?: number
  t?: string
}

// 消息对象（MESSAGE_CREATE）
export interface DiscordMessage {
  id?: string
  channel_id?: string
  guild_id?: string | null
  author?: { id?: string; username?: string; global_name?: string; bot?: boolean; [key: string]: any }
  content?: string
  timestamp?: string
  attachments?: Array<{ id: string; url: string; filename?: string; content_type?: string }>
  embeds?: any[]
  sticker_items?: any[]
  [key: string]: any
}

// REST 统一响应（错误时非 2xx + json body）
export interface DiscordApiResp {
  ok?: boolean
  id?: string
  content?: string
  message?: string
  code?: number
  [key: string]: any
}
