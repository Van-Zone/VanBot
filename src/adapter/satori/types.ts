// Satori 协议类型定义
// 参考: https://satori.js.org/

// Satori 通道类型
export type SatoriChannelType = 0 | 1 | 2 | 3 | 4
// 0: 文本频道  1: 私信  2: 语音频道  3: 分类  4: 频道

// Satori 通道
export interface SatoriChannel {
  id: string
  type: SatoriChannelType
  name?: string
  parent_id?: string
}

// Satori 服务器（群组）
export interface SatoriGuild {
  id: string
  name?: string
  avatar?: string
}

// Satori 用户
export interface SatoriUser {
  id: string
  name?: string
  nick?: string
  avatar?: string
  is_bot?: boolean
}

// Satori 群成员
export interface SatoriMember {
  user?: SatoriUser
  nick?: string
  avatar?: string
  joined_at?: number
}

// Satori 消息
export interface SatoriMessage {
  id: string
  content: string
  channel?: SatoriChannel
  guild?: SatoriGuild
  member?: SatoriMember
  user?: SatoriUser
  created_at?: number
  updated_at?: number
}

// Satori 登录信息
export interface SatoriLogin {
  user?: SatoriUser
  self_id: string
  platform: string
  status?: number
  features?: string[]
  proxy_url?: string
}

// Satori 事件
export interface SatoriEvent {
  id: number
  type: string
  platform: string
  self_id: string
  timestamp: number
  channel?: SatoriChannel
  guild?: SatoriGuild
  login?: SatoriLogin
  member?: SatoriMember
  message?: SatoriMessage
  user?: SatoriUser
  argv?: any
  button?: any
  [key: string]: any
}

// Satori WebSocket 操作码
export enum SatoriOpCode {
  EVENT = 0,
  PING = 1,
  PONG = 2,
  IDENTIFY = 3,
  READY = 4,
}

// Satori WS 消息帧
export interface SatoriWsFrame {
  op: SatoriOpCode
  body?: any
  id?: number
}

// Satori API 响应
export interface SatoriApiResp<T = any> {
  data?: T
  code?: number
  message?: string
}
