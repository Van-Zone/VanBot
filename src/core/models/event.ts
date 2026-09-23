import type { MessageChain } from "./message.js"
import type { Capabilities } from "../capabilities.js"

export type EventType =
  | "group_message"
  | "private_message"
  | "message_sent"
  | "notice"
  | "meta_event"
  | "request"
  | "*"

// 框架统一事件结构，所有适配器转换后都走这个
export interface BotEvent {
  // 框架内机器人标识
  botId: string
  // 协议侧自身 ID（QQ号 / platform id）
  selfId: number | string
  // 发送者 ID
  userId: number | string
  // 群 ID，私聊时为 undefined / 0
  groupId?: number | string
  // 消息段数组（统一为 {type, data} 格式）
  message: Array<{ type: string; data: Record<string, any> }>
  // 事件类型
  postType: EventType
  // 原始协议报文（调试用）
  raw: Record<string, any>

  // 内核管道注入的标准化字段（适配器无需填写，管道自动补齐）

  // 全局唯一追踪 ID，贯穿 接收 → 中间件 → 插件 → 回复 全过程。
  // 由内核管道在事件进入时生成；发送回复时 echo 到日志。
  traceId?: string

  // 会话粒度能力集合（只读）。
  // 由内核管道调用适配器 computeCapabilities(event) 后填充。
  // 事件经过管道后保证存在（默认 GENERIC_CAPABILITIES / 适配器声明）。
  capabilities?: Readonly<Capabilities>

  // 统一时间戳（Unix 秒）。
  // 由管道从 raw.time / raw.create_time / Date.now() 归一化填充。
  time?: number

  // 平台独有数据（如按钮回调原始 payload、群成员权限等）。
  // 不存在即为 undefined；业务代码禁止硬编码平台字符串判断，只能判断能力标记。
  platformExtra?: unknown

  // 返回当前会话能力集。
  // 由内核管道注入（事件进入后该方法即存在）；未经过管道时为空集。
  // 例：if (event.getCapabilities?.().canMuteMember) { ... }
  getCapabilities?: () => Readonly<Capabilities>
}

// 获取事件能力集（等价于 event.getCapabilities()）。
// 事件经过管道后 capabilities 已填充；未经过管道的兜底空集。
export function getEventCapabilities(event: BotEvent): Readonly<Capabilities> {
  return event.capabilities ?? {}
}

// 兼容旧代码的别名
export type BaseBotEvent = BotEvent
