import zlib from "zlib"
import type { BotEvent } from "../../core/models/event.js"
import type { BilibiliLiveAdapter } from "./client.js"

// B 站直播弹幕协议编解码 + 事件转换
// 数据包格式（全部大端 Big Endian）：
// 偏移 0   - int32   Packet Length    整个包长度（含头）
// 偏移 4   - int16   Header Length    头长度，固定 16
// 偏移 6   - int16   Protocol Version 0=JSON / 1=人气int32 / 2=zlib / 3=brotli
// 偏移 8   - int32   Operation        2=心跳 3=心跳回应 5=服务端消息 7=鉴权 8=鉴权回应
// 偏移 12  - int32   Sequence Id      保留，通常 1
// 偏移 16  - byte[]  Body             正文

export interface BiliPacket {
  version: number
  op: number
  seq: number
  body: Buffer
}

// 编码一个 B 站数据包
export function encodePacket(op: number, body: Buffer | string, version = 1): Buffer {
  const bodyBuf = typeof body === "string" ? Buffer.from(body, "utf8") : body
  const packetLen = 16 + bodyBuf.length
  const header = Buffer.alloc(16)
  header.writeUInt32BE(packetLen, 0) // Packet Length
  header.writeUInt16BE(16, 4)        // Header Length
  header.writeUInt16BE(version, 6)   // Protocol Version
  header.writeUInt32BE(op, 8)        // Operation
  header.writeUInt32BE(1, 12)        // Sequence Id
  return Buffer.concat([header, bodyBuf])
}

// 解码一个 WebSocket 帧
// 一个帧可能包含多个数据包（首尾相连），且 body 可能是 zlib/brotli 压缩后嵌套多个包
export function decodePackets(frame: Buffer): BiliPacket[] {
  const packets: BiliPacket[] = []
  let offset = 0
  while (offset + 16 <= frame.length) {
    const packetLen = frame.readUInt32BE(offset)
    const headerLen = frame.readUInt16BE(offset + 4)
    const version = frame.readUInt16BE(offset + 6)
    const op = frame.readUInt32BE(offset + 8)
    const seq = frame.readUInt32BE(offset + 12)

    if (packetLen < headerLen || offset + packetLen > frame.length) break
    let body = frame.subarray(offset + headerLen, offset + packetLen)
    offset += packetLen

    if (version === 2) {
      // zlib 压缩：解压后是一组新包
      try {
        packets.push(...decodePackets(zlib.inflateSync(body)))
      } catch {
        // 解压失败跳过
      }
      continue
    }
    if (version === 3) {
      // brotli 压缩
      try {
        packets.push(...decodePackets(zlib.brotliDecompressSync(body)))
      } catch {
        // 解压失败跳过
      }
      continue
    }
    packets.push({ version, op, seq, body })
  }
  return packets
}

// 框架统一消息段 → B 站弹幕纯文本
// B 站弹幕只支持文本/表情，图片视频等无法发送，丢弃并保留文本
export function segmentsToDanmakuText(
  segments: Array<{ type: string; data: Record<string, any> }>
): string {
  let text = ""
  for (const seg of segments) {
    if (seg.type === "text") {
      text += String(seg.data.text ?? "")
    } else if (seg.type === "at") {
      text += `@${seg.data.name ?? seg.data.qq ?? ""} `
    } else if (seg.type === "face") {
      text += `[表情${seg.data.id ?? ""}]`
    }
    // image/video/record 等 B 站弹幕不支持，直接忽略
  }
  return text.trim()
}

// 弹幕 JSON → 框架统一事件并派发
// 直播间按"群聊"处理：groupId = 房间号，keyword.ts 会用 send_group_msg 回弹幕
export function convertBiliDanmaku(
  raw: any,
  botId: string,
  selfId: number | string,
  roomId: number | string,
  adapter: BilibiliLiveAdapter
): void {
  const info = raw.info ?? []
  const text = String(info[1] ?? "")
  const uid = info[2]?.[0] ?? 0
  const username = info[2]?.[1] ?? ""
  const ts = info[0]?.[7] ?? Math.floor(Date.now() / 1000)

  const event: BotEvent = {
    botId,
    selfId,
    userId: uid,
    groupId: roomId,
    message: [{ type: "text", data: { text } }],
    postType: "group_message",
    raw: raw as unknown as Record<string, any>,
  }

  // 补充 sender 信息，兼容 keyword.ts 从 event.raw.sender 读取
  ;(event.raw as any).sender = {
    user_id: uid,
    nickname: username,
    card: "",
    role: "member",
  }
  ;(event.raw as any).message_id = `${raw.cmd ?? "DANMU_MSG"}-${uid}-${ts}`
  ;(event.raw as any).time = ts
  ;(event.raw as any).platform = "bilibili_live"
  ;(event.raw as any).room_id = roomId

  adapter.emitEvent("group_message", event)
}
