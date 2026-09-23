// KOOK（开黑啦）官方机器人适配器类型定义
// 基于 KOOK 开发者平台：
// API 基址:   https://www.kookapp.cn/api/v3
// WebSocket:  先 GET /gateway/index 拿网关地址，再连 WS
// 鉴权:       Authorization: Bot {token}
// 发送:       /message/create（频道）、/direct-message/create（私聊）
// 文档: https://developer.kookapp.cn/doc/

// WS 信令
export const KOOK_SIGNAL = {
  EVENT: 0, // server->client 事件
  HELLO: 1, // server->client 握手结果
  PING: 2, // client->server 心跳
  PONG: 3, // server->client 心跳回应
  RESUME: 4, // client->server 恢复会话
  RECONNECT: 5, // server->client 要求重连
  RESUME_ACK: 6, // server->client 恢复成功
} as const

// KOOK 消息事件 d.type（内容类型）
export const KOOK_MSG_TYPE = {
  TEXT: 1,
  IMAGE: 2,
  VIDEO: 3,
  FILE: 4,
  K_MARKDOWN: 9,
  CARD: 10,
  ITEM: 12,
} as const

// 事件包（s=0）
export interface KookEvent {
  channel_type?: string // GROUP / PERSON / WEBHOOK_CHALLENGE
  type?: number // 1/2/3/4/9/10 消息；255 系统事件
  target_id?: string
  author_id?: string
  content?: any
  msg_id?: string
  msg_timestamp?: number
  nonce?: string
  extra?: Record<string, any>
  [key: string]: any
}

// WS 下行包
export interface KookGatewayPayload {
  s?: number
  d?: any
  sn?: number
}

// HTTP 统一返回
export interface KookApiResp {
  code?: number
  message?: string
  data?: any
  [key: string]: any
}

// 用户信息（/user/me）
export interface KookUserInfo {
  id?: string
  username?: string
  nickname?: string
  [key: string]: any
}
