// WeChatFerry (wechatferry npm 包) 相关类型定义
// 仓库：https://github.com/wechatferry/wechatferry
// 文档：https://wcferry.netlify.app/
//
// 工作原理：
// @wechatferry/core 通过 koffi 加载 sdk.dll，注入微信进程，
// 通过 NNG (tcp://127.0.0.1:10086) 与微信通信。
// 不需要 Python，纯 Node.js 实现。

// 从 @wechatferry/core 导出的核心类型（运行时动态导入，这里只做结构声明）
export interface WcfUserInfo {
  wxid: string
  name: string
  mobile: string
  [key: string]: unknown
}

// wechatferry 消息结构（WxMsg 的 plain object 形式）
export interface WcfRawMessage {
  type: number          // 消息类型（WechatMessageType 枚举）
  id: string            // 消息 id
  xml: string           // 消息 xml 部分
  sender: string        // 发送人 wxid（群消息时为实际发送者）
  roomid: string        // 群 id（仅群消息有，私聊为空字符串）
  content: string       // 消息内容
  thumb: string         // 图片/视频缩略图路径
  extra: string         // 图片/视频/文件实际路径
  isSender: number      // 是否自己发送（0=别人，1=自己）
  createTime: number    // 消息创建时间（秒级时间戳）
  [key: string]: unknown
}

// 消息类型枚举（@wechatferry/core 的 WechatMessageType）
export enum WcfMsgType {
  Moment = 0,
  Text = 1,
  Image = 3,
  Voice = 34,
  VerifyMsg = 37,
  PossibleFriendMsg = 40,
  ShareCard = 42,
  Video = 43,
  Emoticon = 47,
  Location = 48,
  App = 49,           // 文件/链接/小程序/转账等（XML 内容）
  VoipMsg = 50,
  StatusNotify = 51,
  VoipNotify = 52,
  VoipInvite = 53,
  MicroVideo = 62,
  VerifyMsgEnterprise = 65,
  Transfer = 2000,
  RedEnvelope = 2001,
  MiniProgram = 2002,
  GroupInvite = 2003,
  File = 2004,
  SysNotice = 9999,
  Sys = 10000,
  Recalled = 10002,
}

// App 消息子类型（type=49 时通过 XML 中的 appmsg_type 区分）
export enum WcfAppMsgType {
  Text = 1,
  Img = 2,
  Audio = 3,
  Video = 4,
  Url = 5,
  Attach = 6,
  Open = 7,
  Emoji = 8,
  VoiceRemind = 9,
  ScanGood = 10,
  Good = 13,
  Emotion = 15,
  CardTicket = 16,
  RealtimeShareLocation = 17,
  ChatHistory = 19,
  MiniProgram = 33,
  MiniProgramApp = 36,
  Channels = 51,
  GroupNote = 53,
  ReferMsg = 57,
  Transfers = 2000,
  RedEnvelopes = 2001,
}

// wechatferry 核心实例的最小接口（用于类型标注，实际从 @wechatferry/core 动态导入）
export interface WcfCore {
  start(): void
  stop(): void
  isLogin(): boolean
  getUserInfo(): WcfUserInfo
  resetSdk(): void
  on(event: "message", listener: (msg: WcfRawMessage) => void): this
  on(event: "sended", listener: () => void): this
  off(event: string, listener: (...args: any[]) => void): this
  sendTxt(text: string, receiver: string, mentionIdList?: string[]): number
  sendImg(image: unknown, receiver: string): number   // image 为 FileBox 实例
  sendFile(file: unknown, receiver: string): number    // file 为 FileBox 实例
  sendRichText(desc: Record<string, unknown>, receiver: string): number
  sendXml(xml: Record<string, unknown>, receiver: string): void
  forwardMsg(messageId: string, receiver: string): number
  revokeMsg(messageId: string): number
  execDbQuery(db: string, sql: string): unknown
  getDbNames(): string[]
  inviteRoomMembers(roomId: string, wxids: string[]): number
  addRoomMembers(roomId: string, wxids: string[]): number
  delRoomMembers(roomId: string, wxids: string[]): number
}

// wechatferry 核心模块的导出结构
export interface WcfCoreModule {
  Wechatferry: new (options?: Record<string, unknown>) => WcfCore
  WechatMessageType: typeof WcfMsgType
  WechatAppMessageType: typeof WcfAppMsgType
}
