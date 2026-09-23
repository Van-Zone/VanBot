// QQ 官方机器人适配器类型定义
// 基于 QQ 开放平台（api-v2）协议：
// WebSocket 网关: wss://api.sgroup.qq.com（或 /gateway/bot 下发地址）
// REST API 基址:  https://api.sgroup.qq.com
// 鉴权:          Authorization: QQBot {AppID}.{BotToken}
// 文档: https://bot.q.qq.com/wiki/develop/api-v2/

// 网关 opcode
export const QQ_OP = {
  DISPATCH: 0, // 服务端推送事件
  HEARTBEAT: 1, // 心跳
  IDENTIFY: 2, // 鉴权
  RESUME: 6, // 恢复连接
  RECONNECT: 7, // 服务端要求重连
  INVALID_SESSION: 9, // 会话失效
  HELLO: 10, // 连接建立，携带心跳周期
  HEARTBEAT_ACK: 11, // 心跳回应
} as const

// 事件订阅 intents（位标记）
export const QQ_INTENT = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  DIRECT_MESSAGE: 1 << 12,
  // 群聊 + 单聊（QQ 群机器人 / C2C）
  GROUP_AND_C2C_EVENT: 1 << 25,
  INTERACTION: 1 << 26,
  MESSAGE_AUDIT: 1 << 27,
  FORUMS_EVENT: 1 << 28,
  AUDIO_ACTION: 1 << 29,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
} as const

// 网关下行 payload
export interface QqGatewayPayload {
  op: number
  d?: any
  s?: number
  t?: string
}

// 消息事件 data（群聊 / 单聊 / 频道通用字段）
export interface QqMessageData {
  id?: string
  group_openid?: string
  channel_id?: string
  guild_id?: string
  author?: {
    user_openid?: string
    member_openid?: string
    id?: string
    [key: string]: any
  }
  content?: string
  timestamp?: string
  msg_type?: number
  msg_seq?: number
  attachments?: any[]
  [key: string]: any
}

// 发送消息响应
export interface QqSendResp {
  id?: string
  message_id?: string
  code?: number
  message?: string
  [key: string]: any
}

// 上传媒体响应（v2/groups/{openid}/files）
export interface QqFileUploadResp {
  file_info?: string
  code?: number
  message?: string
  [key: string]: any
}

// getAppAccessToken 响应（AppSecret 模式）
export interface QqAppTokenResp {
  access_token?: string
  expires_in?: number
  code?: number
  message?: string
  [key: string]: any
}
