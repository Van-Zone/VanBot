// 抖音适配器类型定义
// 基于抖音网页版（www.douyin.com/messages 私信页）的浏览器自动化（参考 Douyin-mcp）：
// - 登录：仅用 cookie（含 sessionid），launchPersistentContext 持久化指纹 + 反检测脚本绕过风控
// - 收发：驱动网页版私信 /messages，轮询会话最新消息接收、Draft.js 注入输入 + 点发送按钮
// 说明：抖音 web 接口普遍需要 a_bogus 签名，纯 HTTP 逆向不稳定，故采用浏览器自动化。

// 抖音会话（一个私聊好友或一个群聊）
export interface DouyinConversation {
  // 会话标识：私聊=对方昵称，群聊=群名
  nickname: string
  // 最新一条消息预览
  lastMessage: string
  // 未读数文本（空串表示无未读）
  unread: string
  // 最新消息时间文本
  timestamp: string
  // 是否为群聊
  isGroup: boolean
}

// 抖音消息事件（网页版 DOM 提取的简化结构）
export interface DouyinRawMessage {
  // 会话名（对方昵称或群名）
  convName: string
  // 是否为群聊
  isGroup: boolean
  // 消息文本
  text: string
  // 发送者昵称（群聊里才有意义，私聊即对方）
  senderName: string
  // 时间戳（秒）
  time: number
  // 是否为机器人自己发送
  isSelf: boolean
}
