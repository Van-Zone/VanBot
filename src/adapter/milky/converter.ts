import type { MilkyRawEvent, MilkySegment } from "./types.js"
import type { BotEvent } from "../../core/models/event.js"
import { getMilkyAdapterById } from "./client.js"

function milkySegToRaw(segs?: MilkySegment[]): Array<{ type: string; data: Record<string, any> }> {
    if (!Array.isArray(segs)) return []
    return segs.map(item => {
        const data = { ...item.data }
        if (item.type === "image" && !data.url && data.temp_url) {
            data.url = data.temp_url
        }
        return { type: item.type, data }
    })
}

// 将 Milky 原始事件转换为框架统一事件并派发
export function convertMilkyEvent(rawEv: MilkyRawEvent, botId: string): void {
    try {
        const data = rawEv.data ?? {}
        const event: BotEvent = {
            botId,
            selfId: rawEv.self_id,
            userId: data.sender_id ?? 0,
            groupId: data.group?.group_id,
            message: milkySegToRaw(data.segments),
            postType: "group_message",
            raw: rawEv as unknown as Record<string, any>,
        }

        let eventName = ""
        if (rawEv.event_type === "message_receive") {
            eventName = data.message_scene === "group" ? "group_message" : "private_message"
        } else if (rawEv.event_type === "notify") {
            eventName = "notice"
        } else if (rawEv.event_type === "meta") {
            eventName = "meta_event"
        }

        event.postType = eventName as BotEvent["postType"]

        if (eventName) {
            const adapter = getMilkyAdapterById(botId)
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
