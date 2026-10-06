import type { BotEvent } from "../../core/models/event.js"
import type { OneBot11Adapter } from "./client.js"

// 将 OneBot V11 原始事件转换为框架统一事件并派发
export function convertOb11Event(raw: any, botId: string, bot: OneBot11Adapter): void {
    const event: BotEvent = {
        botId,
        selfId: raw.self_id ?? 0,
        userId: raw.sender?.user_id ?? raw.user_id ?? 0,
        groupId: raw.group_id ?? undefined,
        message: raw.message ?? [],
        postType: "group_message",
        raw,
    }

    let eventName = ""
    if (raw.post_type === "message") {
        eventName = raw.message_type === "group" ? "group_message" : "private_message"
    } else if (raw.post_type === "notice") {
        eventName = "notice"
    } else if (raw.post_type === "meta_event") {
        eventName = "meta_event"
    } else if (raw.post_type === "request") {
        eventName = "request"
    } else if (raw.post_type === "message_sent") {
        eventName = "message_sent"
    }

    event.postType = eventName as BotEvent["postType"]

    if (eventName) {
        bot.emitEvent(eventName, event)
    }
}
