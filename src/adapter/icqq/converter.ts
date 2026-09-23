import type { BotEvent } from "../../core/models/event.js"
import type { IcqqAdapter } from "./client.js"
import type { IcqqSegment } from "./types.js"

// icqq 原始消息段（扁平 { type, ... }）→ 框架统一消息段（{ type, data }）
// 文本/图片/语音/视频/@/表情/回复/json/xml/share/文件等全量转换
export function icqqMsgToSegments(
  elems: IcqqSegment[] | undefined
): Array<{ type: string; data: Record<string, any> }> {
  const out: Array<{ type: string; data: Record<string, any> }> = []
  if (!Array.isArray(elems)) return out
  for (const el of elems) {
    if (!el || typeof el.type !== "string") continue
    switch (el.type) {
      case "text":
        if (el.text) out.push({ type: "text", data: { text: String(el.text) } })
        break
      case "at":
        out.push({
          type: "at",
          data: {
            qq: String(el.qq ?? ""),
            name: String(el.text ?? el.name ?? ""),
          },
        })
        break
      case "face":
      case "sface":
        out.push({ type: "face", data: { id: String(el.id ?? ""), text: el.text ?? "" } })
        break
      case "bface":
        out.push({ type: "face", data: { id: "bface", file: el.file ?? "", text: el.text ?? "" } })
        break
      case "image":
      case "flash": {
        // 收到的图片段带 url / file
        const url = String(el.url ?? el.file ?? "")
        const d: Record<string, any> = { file: url }
        if (url) d.url = url
        if (el.file) d.file = el.file
        if (el.type === "flash") d.flash = true
        out.push({ type: "image", data: d })
        break
      }
      case "record":
        out.push({
          type: "record",
          data: { file: el.file ?? "", url: el.url ?? "", name: el.name ?? "" },
        })
        break
      case "video":
        out.push({
          type: "video",
          data: { file: el.file ?? "", url: el.url ?? "", name: el.name ?? "" },
        })
        break
      case "reply": {
        // 引用回复：icqq 的 ReplyElem.text 是被引用内容
        const d: Record<string, any> = { id: String(el.id ?? "") }
        if (el.text) d.text = String(el.text)
        if (el.message) d.message = el.message
        out.push({ type: "reply", data: d })
        break
      }
      case "json":
        out.push({ type: "json", data: { data: el.data ?? "" } })
        break
      case "xml":
        out.push({ type: "xml", data: { data: el.data ?? "", id: el.id ?? "" } })
        break
      case "share":
        out.push({
          type: "share",
          data: {
            url: el.url ?? "",
            title: el.title ?? "",
            content: el.content ?? "",
            image: el.image ?? "",
          },
        })
        break
      case "file":
        out.push({
          type: "file",
          data: {
            name: el.name ?? "",
            fid: el.fid ?? "",
            md5: el.md5 ?? "",
            size: el.size ?? 0,
            url: el.url ?? "",
          },
        })
        break
      case "forward":
        out.push({ type: "forward", data: { nodes: el.nodes ?? [] } })
        break
      case "mirai":
      case "poke":
      case "location":
      case "music":
      default:
        // 未知段：保留原始数据，便于上层感知
        out.push({ type: el.type, data: { ...el } })
        break
    }
  }
  return out
}

// 群消息事件 → 框架统一事件并派发
export function convertIcqqGroupMessage(
  e: any,
  botId: string,
  selfId: string,
  adapter: IcqqAdapter
): void {
  const sender = e.sender ?? {}
  const event: BotEvent = {
    botId,
    selfId,
    userId: String(e.user_id ?? e.from_id ?? ""),
    groupId: String(e.group_id ?? ""),
    message: icqqMsgToSegments(e.message),
    postType: "group_message",
    raw: e as unknown as Record<string, any>,
  }
  ;(event.raw as any).sender = {
    user_id: e.user_id ?? 0,
    nickname: sender.nickname ?? "",
    card: sender.card ?? "",
    role: sender.role ?? "member",
    group_name: e.group_name ?? "",
  }
  ;(event.raw as any).message_id = String(e.message_id ?? "")
  ;(event.raw as any).seq = e.seq
  ;(event.raw as any).rand = e.rand
  ;(event.raw as any).time = e.time ?? Math.floor(Date.now() / 1000)
  ;(event.raw as any).atme = !!e.atme
  ;(event.raw as any).platform = "icqq"
  adapter.emitEvent("group_message", event)
}

// 私聊消息事件 → 框架统一事件并派发
export function convertIcqqPrivateMessage(
  e: any,
  botId: string,
  selfId: string,
  adapter: IcqqAdapter
): void {
  const sender = e.sender ?? {}
  const event: BotEvent = {
    botId,
    selfId,
    userId: String(e.user_id ?? e.from_id ?? ""),
    groupId: undefined,
    message: icqqMsgToSegments(e.message),
    postType: "private_message",
    raw: e as unknown as Record<string, any>,
  }
  ;(event.raw as any).sender = {
    user_id: e.user_id ?? e.from_id ?? 0,
    nickname: sender.nickname ?? "",
    sub_type: e.sub_type ?? "",
  }
  ;(event.raw as any).message_id = String(e.message_id ?? "")
  ;(event.raw as any).seq = e.seq
  ;(event.raw as any).rand = e.rand
  ;(event.raw as any).time = e.time ?? Math.floor(Date.now() / 1000)
  ;(event.raw as any).platform = "icqq"
  adapter.emitEvent("private_message", event)
}

// 通知/请求事件 → 框架 notice / request 事件并派发
export function convertIcqqNotice(
  e: any,
  botId: string,
  selfId: string,
  adapter: IcqqAdapter,
  eventName: "notice" | "request"
): void {
  const event: BotEvent = {
    botId,
    selfId,
    userId: String(e.user_id ?? e.from_id ?? ""),
    groupId: e.group_id ? String(e.group_id) : undefined,
    message: [],
    postType: eventName,
    raw: e as unknown as Record<string, any>,
  }
  ;(event.raw as any).notice_type = e.notice_type ?? e.request_type ?? String(e.event_type ?? "")
  ;(event.raw as any).platform = "icqq"
  adapter.emitEvent(eventName, event)
}

// 框架统一消息段（{ type, data }）→ icqq 扁平消息段
// 发送侧使用；适配器不做降级（内核已完成）。
export function segmentsToIcqq(
  segments: Array<{ type: string; data: Record<string, any> }>
): IcqqSegment[] {
  const out: IcqqSegment[] = []
  for (const seg of segments) {
    const data = seg.data ?? {}
    switch (seg.type) {
      case "text":
        if (data.text) out.push({ type: "text", text: String(data.text) })
        break
      case "at":
        out.push({ type: "at", qq: data.qq === "all" || data.qq === 0 ? "all" : Number(data.qq) || data.qq })
        break
      case "face":
        out.push({ type: "face", id: Number(data.id) || 0 })
        break
      case "image":
        out.push({ type: "image", file: String(data.file ?? data.url ?? "") })
        break
      case "record":
        out.push({ type: "record", file: String(data.file ?? data.url ?? "") })
        break
      case "video":
        out.push({ type: "video", file: String(data.file ?? data.url ?? "") })
        break
      case "reply":
        out.push({ type: "reply", id: String(data.id ?? "") })
        break
      case "json":
        out.push({ type: "json", data: data.data ?? "" })
        break
      case "xml":
        out.push({ type: "xml", data: String(data.data ?? "") })
        break
      case "share":
        out.push({
          type: "share",
          url: String(data.url ?? ""),
          title: String(data.title ?? ""),
          content: String(data.content ?? ""),
          image: String(data.image ?? ""),
        })
        break
      case "file":
        out.push({
          type: "file",
          name: String(data.name ?? ""),
          fid: String(data.fid ?? ""),
          md5: String(data.md5 ?? ""),
          size: Number(data.size) || 0,
        })
        break
      case "button":
      case "markdown":
      case "forward":
        // icqq 不支持按钮/markdown/合并转发，丢弃
        break
      default:
        // 其他未知段丢弃，避免发送失败
        break
    }
  }
  return out
}

// 提取消息中的第一个 reply 段 id（供发送侧引用）
export function extractReplyId(
  segments: Array<{ type: string; data: Record<string, any> }>
): string {
  for (const seg of segments) {
    if (seg.type === "reply") return String(seg.data?.id ?? "")
  }
  return ""
}
