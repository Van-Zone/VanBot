// WeFlow 适配器类型定义
// WeFlow 是一个本地运行的微信数据查看工具，提供 HTTP API（默认端口 5031）
// 支持微信 4.0+，通过 Hook 微信数据库获取聊天记录

// 聊天会话
export interface WeFlowSession {
  talker: string              // 会话 ID（私聊是 wxid，群是 xxx@chatroom）
  displayName?: string        // 显示名称
  lastMsg?: string            // 最后一条消息
  lastMsgTime?: number        // 最后一条消息时间戳
  [key: string]: unknown
}

// 消息
export interface WeFlowMessage {
  msgId?: string | number     // 消息 ID
  talker?: string             // 会话 ID
  speaker?: string            // 发送者（群消息时有效）
  content?: string            // 消息内容
  type?: number | string      // 消息类型
  createTime?: number         // 创建时间戳
  sequence?: number           // 序列号
  [key: string]: unknown
}

// 联系人
export interface WeFlowContact {
  wxid?: string
  nickname?: string
  remark?: string
  type?: number
  [key: string]: unknown
}

// 群成员
export interface WeFlowGroupMember {
  wxid?: string
  nickname?: string
  [key: string]: unknown
}

// API 通用响应
export interface WeFlowResponse<T = unknown> {
  code?: number
  data?: T
  msg?: string
  [key: string]: unknown
}
