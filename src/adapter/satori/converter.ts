import type { BotEvent } from "../../core/models/event.js"
import type { SatoriEvent } from "./types.js"
import { getSatoriAdapterById } from "./client.js"

interface SatoriElement {
  tag: string
  attrs: Record<string, string>
  children?: SatoriNode[]
  selfClosing?: boolean
}

type SatoriNode = string | SatoriElement

// 简易 Satori 元素解析器
// 解析如: 纯文本<at id="123"/>更多<img src="http://x"/>
function parseSatoriElements(content: string): SatoriNode[] {
  const nodes: SatoriNode[] = []
  let i = 0
  let textBuf = ""

  while (i < content.length) {
    if (content[i] === "<") {
      // 尝试解析标签
      const closeIdx = content.indexOf(">", i)
      if (closeIdx === -1) {
        textBuf += content.slice(i)
        break
      }
      const tagContent = content.slice(i + 1, closeIdx)

      // 注释或不支持的标签，当文本处理
      if (tagContent.startsWith("!--") || tagContent.startsWith("!")) {
        textBuf += content.slice(i, closeIdx + 1)
        i = closeIdx + 1
        continue
      }

      // 结束标签 </tag>
      if (tagContent.startsWith("/")) {
        i = closeIdx + 1
        continue
      }

      // flush 文本
      if (textBuf) {
        nodes.push(textBuf)
        textBuf = ""
      }

      const selfClosing = tagContent.endsWith("/")
      const inner = selfClosing ? tagContent.slice(0, -1).trim() : tagContent.trim()
      const spaceIdx = inner.search(/\s/)
      const tag = spaceIdx === -1 ? inner : inner.slice(0, spaceIdx)
      const attrStr = spaceIdx === -1 ? "" : inner.slice(spaceIdx + 1)

      const attrs = parseAttrs(attrStr)
      nodes.push({ tag, attrs, selfClosing })

      i = closeIdx + 1
    } else {
      textBuf += content[i]
      i++
    }
  }
  if (textBuf) nodes.push(textBuf)
  return nodes
}

function parseAttrs(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const reg = /(\w[\w-]*)\s*=\s*"([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = reg.exec(attrStr)) !== null) {
    attrs[m[1]] = m[2]
  }
  return attrs
}

// Satori 元素 → 框架统一消息段 {type, data}
export function satoriContentToSegments(content: string): Array<{ type: string; data: Record<string, any> }> {
  const nodes = parseSatoriElements(content)
  const segments: Array<{ type: string; data: Record<string, any> }> = []

  for (const node of nodes) {
    if (typeof node === "string") {
      if (node) segments.push({ type: "text", data: { text: node } })
      continue
    }
    const el = node as SatoriElement
    switch (el.tag) {
      case "at":
        segments.push({
          type: "at",
          data: {
            qq: el.attrs.id ?? el.attrs.name ?? "",
            name: el.attrs.name ?? "",
          },
        })
        break
      case "img":
      case "image":
        segments.push({
          type: "image",
          data: {
            file: el.attrs.src ?? el.attrs.file ?? "",
            url: el.attrs.src ?? "",
          },
        })
        break
      case "face":
        segments.push({
          type: "face",
          data: {
            id: el.attrs.id ?? "",
            name: el.attrs.name ?? "",
          },
        })
        break
      case "audio":
      case "record":
        segments.push({
          type: "record",
          data: { file: el.attrs.src ?? "" },
        })
        break
      case "video":
        segments.push({
          type: "video",
          data: { file: el.attrs.src ?? "" },
        })
        break
      case "file":
        segments.push({
          type: "file",
          data: { file: el.attrs.src ?? "", id: el.attrs.id ?? "" },
        })
        break
      case "br":
        segments.push({ type: "text", data: { text: "\n" } })
        break
      case "p":
        // 段落，加换行
        segments.push({ type: "text", data: { text: "\n" } })
        break
      case "a":
        segments.push({ type: "text", data: { text: el.attrs.href ?? "" } })
        break
      case "quote":
      case "reply":
        segments.push({
          type: "reply",
          data: { id: el.attrs.id ?? "" },
        })
        break
      case "sharp":
        segments.push({
          type: "text",
          data: { text: `#${el.attrs.name ?? el.attrs.id ?? ""}` },
        })
        break
      default:
        // 未知标签，尝试取文本属性
        if (el.attrs.text) {
          segments.push({ type: "text", data: { text: el.attrs.text } })
        }
        break
    }
  }
  return segments
}

// 框架统一消息段 → Satori 元素字符串
export function segmentsToSatoriContent(
  segments: Array<{ type: string; data: Record<string, any> }>
): string {
  let result = ""
  for (const seg of segments) {
    switch (seg.type) {
      case "text":
        result += String(seg.data.text ?? "")
        break
      case "at":
        result += `<at id="${seg.data.qq ?? seg.data.id ?? ""}"/>`
        break
      case "image":
        result += `<img src="${seg.data.file ?? seg.data.url ?? ""}"/>`
        break
      case "face":
        result += `<face id="${seg.data.id ?? ""}"/>`
        break
      case "record":
        result += `<audio src="${seg.data.file ?? ""}"/>`
        break
      case "video":
        result += `<video src="${seg.data.file ?? ""}"/>`
        break
      case "reply":
        result += `<quote id="${seg.data.id ?? ""}"/>`
        break
      case "file":
        result += `<file src="${seg.data.file ?? seg.data.id ?? ""}"/>`
        break
      default:
        // 其他类型尝试序列化为文本
        result += String(seg.data.text ?? JSON.stringify(seg.data))
        break
    }
  }
  return result
}

// 事件转换

// Satori 事件 → 框架统一事件
export function convertSatoriEvent(rawEv: SatoriEvent, botId: string): void {
  try {
    const channel = rawEv.channel
    const guild = rawEv.guild
    const user = rawEv.user ?? rawEv.member?.user ?? rawEv.message?.user
    const message = rawEv.message

    const isPrivate = channel?.type === 1 // 1 = 私信

    const event: BotEvent = {
      botId,
      selfId: rawEv.self_id,
      userId: user?.id ?? 0,
      groupId: isPrivate ? undefined : guild?.id ?? channel?.id,
      message: message ? satoriContentToSegments(message.content) : [],
      postType: "group_message",
      raw: rawEv as unknown as Record<string, any>,
    }

    // 补充 sender 信息到 raw，兼容 keyword.ts 的 event.raw.sender 读取
    if (user) {
      ;(event.raw as any).sender = {
        user_id: user.id,
        nickname: user.nick ?? user.name ?? "",
        card: rawEv.member?.nick ?? user.nick ?? "",
        role: rawEv.member?.joined_at ? "member" : "",
      }
    }
    if (message) {
      ;(event.raw as any).message_id = message.id
      ;(event.raw as any).time = message.created_at ?? rawEv.timestamp
    }
    if (guild) {
      ;(event.raw as any).group_name = guild.name ?? ""
    }

    let eventName = ""
    switch (rawEv.type) {
      case "message-created":
        eventName = isPrivate ? "private_message" : "group_message"
        break
      case "message-updated":
      case "message-deleted":
        eventName = "notice"
        break
      case "guild-member-added":
      case "guild-member-removed":
      case "guild-member-updated":
      case "guild-added":
      case "guild-removed":
      case "guild-updated":
      case "channel-added":
      case "channel-removed":
      case "channel-updated":
        eventName = "notice"
        break
      case "login-added":
      case "login-removed":
      case "login-updated":
        eventName = "meta_event"
        break
      case "reaction-added":
      case "reaction-removed":
        eventName = "notice"
        break
      default:
        eventName = rawEv.type
        break
    }

    event.postType = eventName as BotEvent["postType"]

    if (eventName) {
      const adapter = getSatoriAdapterById(botId)
      if (adapter) {
        adapter.emitEvent(eventName, event)
      } else {
        console.warn(`[${botId}] 适配器实例未找到，事件无法派发`)
      }
    }
  } catch (err) {
    console.error(`[${botId}] 事件转换失败`, err)
  }
}
