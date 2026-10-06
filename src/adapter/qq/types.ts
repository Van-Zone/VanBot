// QQ 官方机器人适配器类型定义
// 基于 QQ 开放平台（api-v2）协议：
// WebSocket 网关: wss://api.sgroup.qq.com（或 /gateway/bot 下发地址）
// REST 统一基址: https://api.bot.qq.com
// 鉴权:          Authorization: QQBot {AppID}.{BotToken}（或 AppAccessToken）
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
  // 群成员变动 / 加群申请（群场景）
  GROUP_MEMBER_EVENT: 1 << 24,
  // 群聊 + 单聊（QQ 群机器人 / C2C）
  GROUP_AND_C2C_EVENT: 1 << 25,
  INTERACTION: 1 << 26,
  MESSAGE_AUDIT: 1 << 27,
  FORUMS_EVENT: 1 << 28,
  AUDIO_ACTION: 1 << 29,
  GUILD_MESSAGES: 1 << 9, // 频道消息（私域）
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  DIRECT_MESSAGE: 1 << 12,
  PUBLIC_GUILD_MESSAGES: 1 << 30, // 频道 @消息（公域）
} as const

// 互动事件类型 INTERACTION_CREATE d.type
export const QQ_INTERACTION_TYPE = {
  INLINE_KEYBOARD: 11, // 消息内联按钮回调
  CALLBACK_COMMAND: 12, // 单聊快捷菜单回调
  MESSAGE_FEEDBACK: 13, // 消息反馈（点赞 / 点踩）
  CLEAR_SESSION: 14, // 清空会话
  STORY_CHANGE: 15, // 进出故事集
  MODEL_SWITCH: 16, // 切换模型
  USER_AUTHORIZE: 18, // 用户授权
  GROUP_AUTHORIZE: 19, // 群授权
  GROUP_AUTHORIZE_CHANGE: 20, // 群授权状态变更
} as const

// 消息类型 msg_type
export const QQ_MSG_TYPE = {
  TEXT: 0, // 文本
  MARKDOWN: 2, // markdown
  ARK: 3, // ark 结构化卡片
  EMBED: 4, // embed
  INPUT_NOTIFY: 6, // 输入中状态（单聊）
  MEDIA: 7, // 富媒体
} as const

// 富媒体类型 file_type
export const QQ_FILE_TYPE = {
  IMAGE: 1, // 图片（png/jpg）
  VIDEO: 2, // 视频（mp4）
  VOICE: 3, // 语音（silk/wav/mp3/flac）
  FILE: 4, // 文件
} as const

// 按钮动作类型 action.type
export const QQ_BUTTON_ACTION = {
  URL: 0, // 跳转（http / 小程序 scheme）
  CALLBACK: 1, // 回调（触发 INTERACTION_CREATE）
  COMMAND: 2, // 指令（输入框插入 @bot data）
} as const

// 按钮样式 render_data.style
export const QQ_BUTTON_STYLE = {
  GRAY: 0, // 灰色线框
  BLUE: 1, // 蓝色线框
  RED_TEXT: 3, // 白底红字
  BLUE_BG: 4, // 蓝底白字
} as const

// 按钮权限类型 action.permission.type
export const QQ_PERMISSION_TYPE = {
  SPECIFY_USER: 0, // 指定用户
  ADMIN: 1, // 仅管理者
  ALL: 2, // 所有人
  SPECIFY_ROLE: 3, // 指定身份组（仅频道）
} as const

// 聊天场景 chat_type
export const QQ_CHAT_TYPE = {
  GUILD: 0, // 频道
  GROUP: 1, // 群聊
  C2C: 2, // 单聊
} as const

// 群成员禁言操作 op
export const QQ_MUTE_OP = {
  ADD: "add", // 增加禁言
  UPDATE: "update", // 更新到期时间
  DEL: "del", // 解除禁言
} as const

// 网关下行 payload
export interface QqGatewayPayload {
  op: number
  d?: any
  s?: number
  t?: string
  id?: string
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
  message_type?: number
  msg_type?: number
  msg_seq?: number
  attachments?: any[]
  [key: string]: any
}

// 发送消息响应
export interface QqSendResp {
  id?: string
  message_id?: string
  timestamp?: string
  code?: number
  message?: string
  [key: string]: any
}

// 上传媒体响应（v2/groups/{openid}/files）
export interface QqFileUploadResp {
  file_uuid?: string
  file_info?: string
  ttl?: number
  id?: string
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
