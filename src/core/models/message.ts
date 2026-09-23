export type MsgSegmentType =
  | "text"
  | "at"
  | "image"
  | "face"
  | "video"
  | "reply"
  | "record"
  | "file"
  | "forward"
  | "dice"
  | "rps"
  | "poke"
  | "json"
  | "music"
  | "markdown"
  | "button"

export interface IMsgSegment {
  type: MsgSegmentType
  data: Record<string, any>

  // 该消息组件依赖的会话能力标识列表。
  // 例：按钮段 ["button"]、带图卡片 ["image","button"]。
  // 发送流水线据此对比 `event.capabilities` 做内核降级。
  capabilities?: string[]

  // 平台能力不支持时，自动替换的降级消息段。
  // 仅【发送流水线】使用；接收消息不使用 fallback。
  // 未提供 fallback 时该组件被丢弃。
  fallback?: MessageSegment[]

  toOneBot11(): Record<string, any>
}

export class MessageSegment implements IMsgSegment {
  type: MsgSegmentType
  data: Record<string, string | number>
  capabilities?: string[]
  fallback?: MessageSegment[]

  constructor(type: MsgSegmentType, data: Record<string, string | number>) {
    this.type = type
    this.data = data
  }

  toOneBot11() {
    return { type: this.type, data: this.data }
  }

  static text(text: string): MessageSegment {
    return new MessageSegment("text", { text })
  }
  static at(qq: number | string): MessageSegment {
    return new MessageSegment("at", { qq: String(qq) })
  }
  static image(file: string): MessageSegment {
    return new MessageSegment("image", { file })
  }
  static face(id: number | string): MessageSegment {
    return new MessageSegment("face", { id: String(id) })
  }
  static reply(id: number | string): MessageSegment {
    return new MessageSegment("reply", { id: String(id) })
  }
  static video(file: string): MessageSegment {
    return new MessageSegment("video", { file })
  }
  static record(file: string): MessageSegment {
    return new MessageSegment("record", { file })
  }
  static file(data: Record<string, any>): MessageSegment {
    return new MessageSegment("file", data)
  }
  static forward(id: number | string): MessageSegment {
    return new MessageSegment("forward", { id: String(id) })
  }
  static json(data: string): MessageSegment {
    return new MessageSegment("json", { data })
  }
  static music(data: Record<string, any>): MessageSegment {
    return new MessageSegment("music", data)
  }
  static markdown(data: Record<string, any>): MessageSegment {
    return new MessageSegment("markdown", data)
  }
  static button(data: Record<string, any>): MessageSegment {
    return new MessageSegment("button", data)
  }

  // 声明本段依赖的会话能力（供发送降级用）。
  // 例：MessageSegment.image(url).needs("image")
  needs(...caps: string[]): MessageSegment {
    this.capabilities = caps
    return this
  }

  // 设置能力不支持时的降级段。
  // 例：MessageSegment.image(url).needs("image").fallbackTo(MessageSegment.text("[图片]"))
  fallbackTo(...segs: MessageSegment[]): MessageSegment {
    this.fallback = segs
    return this
  }
}

// 类型别名导出
export type MessageChain = MessageSegment[]
