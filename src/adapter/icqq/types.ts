// icqq 适配器类型定义
// 基于 icqq（oicq 分支，QQ 安卓协议）：
// createClient(config) 创建客户端，login(uin?, password?) 登录
// 事件: system.login.qrcode / system.online / message.group / message.private / notice.* / request.*
// 发送: sendGroupMsg / sendPrivateMsg / sendTempMsg / deleteMsg
// 文档: https://github.com/icqqjs/icqq

// icqq 消息元素（扁平格式 { type, ... }，非框架的 { type, data }）
export interface IcqqSegment {
  type: string
  [key: string]: any
}

// icqq 群消息事件关键字段
export interface IcqqGroupMessage {
  post_type: "message"
  message_type: "group"
  sub_type?: string
  group_id: number
  group_name?: string
  user_id: number
  message_id: string
  message: IcqqSegment[]
  raw_message?: string
  seq?: number
  rand?: number
  time: number
  atme?: boolean
  atall?: boolean
  sender?: {
    user_id?: number
    nickname?: string
    card?: string
    role?: string
    [k: string]: any
  }
  source?: any
}

// icqq 私聊消息事件关键字段
export interface IcqqPrivateMessage {
  post_type: "message"
  message_type: "private"
  sub_type?: string
  from_id: number
  to_id: number
  user_id: number
  message_id: string
  message: IcqqSegment[]
  raw_message?: string
  seq?: number
  rand?: number
  time: number
  sender?: {
    user_id?: number
    nickname?: string
    [k: string]: any
  }
  source?: any
}
