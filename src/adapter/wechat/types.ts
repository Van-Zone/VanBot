// 微信公众号 / 服务号 相关类型定义

// 微信回调推送的普通消息（XML 解析后）
export interface WechatRawMessage {
  ToUserName: string       // 开发者微信号
  FromUserName: string     // 发送方帐号（OpenID）
  CreateTime: number       // 消息创建时间
  MsgType: string          // 消息类型：text/image/voice/video/shortvideo/location/link
  Content?: string         // 文本消息内容
  MsgId?: number | string  // 消息ID
  MediaId?: string         // 图片/语音/视频媒体ID
  PicUrl?: string          // 图片链接
  Format?: string          // 语音格式
  Recognition?: string     // 语音识别结果
  ThumbMediaId?: string    // 视频缩略图媒体ID
  Location_X?: number      // 地理位置纬度
  Location_Y?: number      // 地理位置经度
  Scale?: number           // 地图缩放大小
  Label?: string           // 地理位置信息
  Title?: string           // 链接消息标题
  Description?: string     // 链接消息描述
  Url?: string             // 链接消息URL
}

// 微信回调推送的事件（XML 解析后）
export interface WechatRawEvent {
  ToUserName: string
  FromUserName: string
  CreateTime: number
  MsgType: "event"
  Event: string            // 事件类型：subscribe/unsubscribe/SCAN/LOCATION/CLICK/VIEW
  EventKey?: string        // 事件KEY值
  Ticket?: string          // 二维码ticket
  Latitude?: number        // 地理位置纬度
  Longitude?: number       // 地理位置经度
  Precision?: number       // 地理位置精度
}

export type WechatRawPayload = WechatRawMessage | WechatRawEvent

// 客服消息 - 文本
export interface WechatKfText {
  touser: string
  msgtype: "text"
  text: { content: string }
}

// 客服消息 - 图片
export interface WechatKfImage {
  touser: string
  msgtype: "image"
  image: { media_id: string }
}

// 客服消息 - 语音
export interface WechatKfVoice {
  touser: string
  msgtype: "voice"
  voice: { media_id: string }
}

// 客服消息 - 视频
export interface WechatKfVideo {
  touser: string
  msgtype: "video"
  video: {
    media_id: string
    thumb_media_id: string
    title?: string
    description?: string
  }
}

// 客服消息 - 图文（外链）
export interface WechatKfNews {
  touser: string
  msgtype: "news"
  news: {
    articles: Array<{
      title: string
      description: string
      url: string
      picurl: string
    }>
  }
}

// 模板消息
export interface WechatTemplateMsg {
  touser: string
  template_id: string
  url?: string
  miniprogram?: { appid: string; pagepath: string }
  data: Record<string, { value: string; color?: string }>
}

// access_token 响应
export interface WechatAccessTokenResp {
  access_token: string
  expires_in: number
}

// 微信 API 通用响应
export interface WechatApiResp {
  errcode: number
  errmsg: string
  [key: string]: any
}
