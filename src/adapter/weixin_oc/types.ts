// openclaw-weixin（腾讯 iLink 协议）类型定义
// 参考：https://github.com/Tencent/openclaw-weixin
// 所有接口：HTTP/JSON POST，登录后走 Bearer 鉴权。
import type { BotConfig } from "../../core/config.js"

// 配置

export interface WeixinOcConfig extends BotConfig {
  // 微信接口基础地址，扫码登录成功后自动回填，也可手动填（从 OpenClaw 登录态导出）
  baseUrl?: string
  // bot_token，扫码登录成功后自动回填，也可手动填
  token?: string
  // 长轮询超时（毫秒），默认 35000
  longPollTimeoutMs?: number
  // API 超时（毫秒），默认 15000
  apiTimeoutMs?: number
  // 是否自动扫码登录（未配置 token 时），默认 true
  qrLogin?: boolean
  // 扫码二维码保存目录，默认 ./data
  qrSaveDir?: string
}

// iLink 通用

// 每次请求附带的元信息（类似 UA）
export interface BaseInfo {
  channel_version?: string
  bot_agent?: string
}

// CDN 媒体引用（图片/语音/文件/视频通过 CDN + AES-128-ECB 传输）
export interface CDNMedia {
  // CDN 下载/上传的加密参数
  encrypt_query_param?: string
  // base64 编码的 AES-128 key
  aes_key?: string
  // 0=只加密 fileid, 1=打包缩略图/中图等信息
  encrypt_type?: number
  // 完整下载 URL（服务端直接返回）
  full_url?: string
}

export const MessageItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
} as const

export const MessageType = {
  USER: 1,
  BOT: 2,
} as const

export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const

// 消息条目

export interface TextItem {
  text?: string
}

export interface ImageItem {
  // 原图 CDN 引用
  media?: CDNMedia
  // 缩略图 CDN 引用
  thumb_media?: CDNMedia
  // Raw AES-128 key as hex string (16 bytes)
  aeskey?: string
  url?: string
  mid_size?: number
  thumb_size?: number
  hd_size?: number
}

export interface VoiceItem {
  media?: CDNMedia
  // 编码类型（6=silk 等）
  encode_type?: number
  // 采样率 (Hz)
  sample_rate?: number
  // 语音长度 (毫秒)
  playtime?: number
  // 语音转文字内容（微信云端自动转录）
  text?: string
}

export interface FileItem {
  media?: CDNMedia
  file_name?: string
  md5?: string
  len?: string
}

export interface VideoItem {
  media?: CDNMedia
  video_size?: number
  play_length?: number
  video_md5?: string
  thumb_media?: CDNMedia
}

export interface RefMessage {
  message_item?: MessageItem
  // 摘要
  title?: string
}

export interface MessageItem {
  type?: number
  create_time_ms?: number
  update_time_ms?: number
  is_completed?: boolean
  msg_id?: string
  ref_msg?: RefMessage
  text_item?: TextItem
  image_item?: ImageItem
  voice_item?: VoiceItem
  file_item?: FileItem
  video_item?: VideoItem
}

// 消息

export interface WeixinMessage {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  create_time_ms?: number
  session_id?: string
  // 群聊场景下的群 ID（个人微信协议，可为空）
  group_id?: string
  message_type?: number
  message_state?: number
  item_list?: MessageItem[]
  // 会话上下文令牌，回复时必须原样带回
  context_token?: string
  run_id?: string
}

// 接口请求/响应

export interface GetUpdatesResp {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinMessage[]
  // 同步游标，下次请求必须回传
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

export interface SendMessageReq {
  msg?: WeixinMessage
}

export interface SendMessageResp {
  ret?: number
  errmsg?: string
}

export interface GetUploadUrlReq {
  filekey?: string
  // 1=IMAGE, 2=VIDEO, 3=FILE
  media_type?: number
  to_user_id?: string
  // 原文件明文大小
  rawsize?: number
  // 原文件明文 MD5
  rawfilemd5?: string
  // AES-128-ECB 加密后的密文大小
  filesize?: number
  // 不需要缩略图上传 URL，默认 false
  no_need_thumb?: boolean
  // 加密 key（hex）
  aeskey?: string
}

export interface GetUploadUrlResp {
  upload_param?: string
  thumb_upload_param?: string
  // 完整上传 URL（服务端直接返回，无需客户端拼接）
  upload_full_url?: string
}

// 扫码登录

export interface QRCodeResponse {
  qrcode: string
  // 二维码内容 URL
  qrcode_img_content: string
}

export interface QRStatusResponse {
  status:
    | "wait"
    | "scaned"
    | "confirmed"
    | "expired"
    | "need_verifycode"
    | "verify_code_blocked"
    | "scaned_but_redirect"
    | "binded_redirect"
  bot_token?: string
  ilink_bot_id?: string
  baseurl?: string
  ilink_user_id?: string
  redirect_host?: string
}

// 本地持久化的登录凭证
export interface WeixinOcCredential {
  botId: string
  baseUrl: string
  token: string
  selfId: string
  // 扫码者的微信用户 ID
  userId?: string
  savedAt: number
}
