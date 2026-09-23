// Telegram 官方机器人适配器类型定义
// 基于 Telegram Bot API：
// Base: https://api.telegram.org/bot<token>/<method>
// 接收: getUpdates 长轮询（offset/timeout/limit，无需公网回调）
// 发送: sendMessage / sendPhoto / sendVoice / sendVideo / sendAudio 等
// 文档: https://core.telegram.org/bots/api

export interface TgUser {
  id: number
  is_bot: boolean
  first_name?: string
  last_name?: string
  username?: string
}

export interface TgChat {
  id: number
  type: string
  title?: string
  username?: string
  first_name?: string
  last_name?: string
}

export interface TgPhotoSize {
  file_id: string
  file_unique_id: string
  width: number
  height: number
  file_size?: number
}

export interface TgMessage {
  message_id: number
  from?: TgUser
  chat: TgChat
  date: number
  text?: string
  caption?: string
  photo?: TgPhotoSize[]
  voice?: { file_id: string; duration?: number; mime_type?: string }
  video?: { file_id: string; duration?: number; mime_type?: string; file_name?: string }
  audio?: { file_id: string; duration?: number; mime_type?: string; title?: string }
  document?: { file_id: string; file_name?: string; mime_type?: string }
  sticker?: { file_id: string; emoji?: string }
  animation?: { file_id: string; file_name?: string }
  new_chat_members?: TgUser[]
  left_chat_member?: TgUser
  [key: string]: any
}

export interface TgCallbackQuery {
  id: string
  from: TgUser
  message?: TgMessage
  data?: string
  [key: string]: any
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
  edited_message?: TgMessage
  channel_post?: TgMessage
  callback_query?: TgCallbackQuery
  my_chat_member?: any
  [key: string]: any
}

export interface TgApiResp {
  ok: boolean
  result?: any
  description?: string
  error_code?: number
  [key: string]: any
}
