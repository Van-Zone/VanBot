// 跨平台统一消息工具
// 让「一份插件（keyword.ts）用全部平台」成为可能：
// 插件发给适配器的 message 可以是 ——
// 1. 纯字符串："你好"
// 2. 单段对象：{ type: "text", data: { text: "你好" } }
// 3. 段数组：  [{ type: "text", data: { text: "你好" } }, { type: "image", data: { url: "..." } }]
// 所有适配器在发送入口统一调用 normalizeSegments() 归一化成段数组，
// 再各自转换成平台格式；未知/不支持的消息段用 segmentsToText() 兜底渲染为文本，绝不崩溃。

export type AnySeg = {
  type: string
  data: Record<string, any>
  // 段依赖的会话能力（发送降级用）
  capabilities?: string[]
  // 能力不足时的降级段（仅发送流水线用）
  fallback?: AnySeg[]
}

// 任意 message 输入 → 标准段数组 [{type, data, capabilities?, fallback?}]
export function normalizeSegments(message: unknown): AnySeg[] {
  if (message === null || message === undefined) return []
  if (typeof message === "string") {
    return [{ type: "text", data: { text: message } }]
  }
  const toSeg = (s: AnySeg): AnySeg => {
    const out: AnySeg = { type: String(s?.type ?? "text"), data: (s?.data ?? {}) as Record<string, any> }
    if (Array.isArray(s?.capabilities) && s.capabilities.length) out.capabilities = [...s.capabilities]
    if (Array.isArray(s?.fallback) && s.fallback.length) out.fallback = s.fallback.map(toSeg)
    return out
  }
  if (Array.isArray(message)) {
    return (message as AnySeg[]).map(toSeg)
  }
  if (typeof message === "object") {
    const m = message as AnySeg
    if (typeof m.type === "string" || "type" in (message as object)) {
      return [toSeg(m)]
    }
  }
  return [{ type: "text", data: { text: String(message ?? "") } }]
}

// 段数组 → 纯文本（全类型兜底渲染，未知类型也不崩溃）
export function segmentsToText(segments: AnySeg[]): string {
  let text = ""
  for (const seg of segments) {
    const t = String(seg.type ?? "")
    const d = (seg.data ?? {}) as Record<string, any>
    switch (t) {
      case "text":
        text += String(d.text ?? "")
        break
      case "at":
        text += `@${d.name ?? d.qq ?? d.id ?? ""} `
        break
      case "face":
        text += `[表情${d.id ?? d.name ?? ""}]`
        break
      case "markdown":
        text += String(d.content ?? d.text ?? "")
        break
      case "button":
        text += `[按钮:${d.text ?? d.label ?? ""}]`
        break
      case "image":
        text += "[图片]"
        break
      case "record":
        text += "[语音]"
        break
      case "video":
        text += "[视频]"
        break
      case "file":
        text += `[文件:${d.name ?? ""}]`
        break
      case "reply":
        text += "[回复]"
        break
      case "forward":
        text += "[转发消息]"
        break
      case "json":
        text += "[卡片]"
        break
      case "dice":
        text += "[骰子]"
        break
      case "rps":
        text += "[猜拳]"
        break
      case "poke":
        text += "[戳一戳]"
        break
      case "music":
        text += "[音乐]"
        break
      default:
        text += String(d.text ?? "")
    }
  }
  return text
}
