// 接收事件归一化管道（适配器 → 内核 → 插件）
// 适配器只负责把原始协议转成基础内部 Event + MessageSegment；
// 兼容/标准化业务处理全部下沉到内核这里：
// - 分配全局唯一 traceId（贯穿接收→中间件→插件→回复）；
// - 所有 ID 统一转字符串，消除数字/雪花字符串坑；
// - 统一时间格式（Unix 秒 → event.time）；
// - 未知消息段统一转占位 `[未知消息]`；
// - 填充会话能力集 event.capabilities（调用适配器 computeCapabilities）；
// - 注入 event.getCapabilities() 方法。
import { randomBytes } from "node:crypto"
import type { BotEvent } from "./models/event.js"
import type { BaseAdapter } from "../adapter/base.js"
import type { Capabilities } from "./capabilities.js"
import { FULL_CAPABILITIES } from "./capabilities.js"

// 框架已知的消息段类型白名单（未知类型 → 占位）
const KNOWN_SEG_TYPES = new Set<string>([
  "text", "at", "image", "face", "video", "reply", "record", "file",
  "forward", "dice", "rps", "poke", "json", "music", "markdown", "button",
])

// 生成全局唯一追踪 ID（24 位十六进制）
export function createTraceId(): string {
  return `tr_${randomBytes(12).toString("hex")}`
}

// 从原始报文提取统一时间（Unix 秒）
function extractTime(event: BotEvent): number {
  const raw = event.raw ?? {}
  if (typeof raw.time === "number" && raw.time > 0) return raw.time
  if (typeof raw.time === "string" && raw.time) {
    const t = Number(raw.time)
    if (t > 0) return t
  }
  if (typeof raw.create_time_ms === "number" && raw.create_time_ms > 0) {
    return Math.floor(raw.create_time_ms / 1000)
  }
  if (typeof raw.create_time === "number" && raw.create_time > 0) {
    return raw.create_time
  }
  return Math.floor(Date.now() / 1000)
}

// 把任意 ID 安全转成字符串
function toIdString(v: number | string | undefined): string {
  if (v === undefined || v === null) return ""
  return String(v)
}

// 归一化一条事件（原地增强 event 对象并返回）。
// @param adapter 可选；用于上报会话能力集 computeCapabilities
export function normalizeEvent(event: BotEvent, adapter?: BaseAdapter): BotEvent {
  // 1. traceId
  if (!event.traceId) {
    event.traceId = createTraceId()
  }

  // 2. 统一 ID 为字符串
  event.selfId = toIdString(event.selfId)
  event.userId = toIdString(event.userId)
  if (event.groupId !== undefined && event.groupId !== null && event.groupId !== "" && event.groupId !== 0) {
    event.groupId = toIdString(event.groupId)
  } else {
    event.groupId = undefined
  }

  // 3. 统一时间
  if (typeof event.time !== "number" || event.time <= 0) {
    event.time = extractTime(event)
  }

  // 4. 未知消息段 → 占位
  if (Array.isArray(event.message)) {
    event.message = event.message.map((seg) => {
      const t = String(seg?.type ?? "")
      if (!KNOWN_SEG_TYPES.has(t)) {
        return { type: "text", data: { text: "[未知消息]" } }
      }
      return seg
    })
  }

  // 5. 会话能力集（适配器上报，未实现则默认全能力）
  let caps: Readonly<Capabilities> = FULL_CAPABILITIES
  try {
    caps = adapter?.computeCapabilities?.(event) ?? FULL_CAPABILITIES
  } catch {
    caps = FULL_CAPABILITIES
  }
  event.capabilities = Object.freeze({ ...caps }) as Readonly<Capabilities>

  // 6. 注入 getCapabilities 方法
  const frozen = event.capabilities
  ;(event as any).getCapabilities = () => frozen

  return event
}

// 打印事件（含 traceId），供日志追踪使用。
export function logEvent(prefix: string, event: BotEvent): void {
  const text = Array.isArray(event.message)
    ? event.message.map((s) => (s.type === "text" ? String(s.data?.text ?? "") : `[${s.type}]`)).join("")
    : ""
  console.log(`${prefix} [${event.traceId ?? "-"}] ${event.postType} bot=${event.botId} user=${event.userId} group=${event.groupId ?? "-"} ${text}`.trim())
}
