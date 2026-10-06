type ConfigType = {
    segKeep: Record<string, string>
    noticeTpl: Record<string, string>
    metaTpl: Record<string, string>
    showRawLog: boolean
    MASTER_LIST: string[]
}

export function transMessage(segList: Array<{ type: string; data: Record<string, any> }>, config: ConfigType): string {
    let res = ""
    for (const seg of segList) {
        const tpl = config.segKeep?.[seg.type] ?? ""
        if (!tpl) continue
        let output = tpl
        for (const key in seg.data) {
            let val = seg.data[key]
            if (seg.type === "image" && key === "url" && !val) val = seg.data.temp_url
            output = output.replaceAll(`{${key}}`, String(val ?? ""))
        }
        res += output
    }
    return res.replaceAll("\n", "\\n")
}

export function transNotice(raw: any, selfId: number, config: ConfigType): { targetId: number; text: string } {
    let tplKey = ""
    const data: Record<string, any> = { "self_id": selfId }
    let targetId = selfId

    if (raw.notice_type === "notify") {
        if (raw.sub_type === "poke") {
            tplKey = "notify_poke";
            data["target_id"] = raw.target_id;
            targetId = Number(raw.target_id)
        } else if (raw.sub_type === "input_status") {
            tplKey = "notify_input_status";
            data["user_id"] = raw.user_id;
            data["status_text"] = raw.status_text;
            targetId = Number(raw.user_id)
        } else if (raw.sub_type === "online") {
            tplKey = "friend_online";
            data["user_id"] = raw.user_id;
            targetId = Number(raw.user_id)
        } else if (raw.sub_type === "offline") {
            tplKey = "friend_offline";
            data["user_id"] = raw.user_id;
            targetId = Number(raw.user_id)
        }
    } else if (raw.notice_type === "group_increase") {
        tplKey = "group_increase";
        data["user_id"] = raw.user_id;
        targetId = Number(raw.user_id)
    } else if (raw.notice_type === "group_recall") {
        tplKey = "group_recall";
        data["operator_id"] = raw.operator_id;
        targetId = Number(raw.operator_id)
    } else if (raw.notice_type === "group_admin") {
        tplKey = raw.sub_type === "set" ? "group_admin_set" : "group_admin_unset";
        data["user_id"] = raw.user_id;
        targetId = Number(raw.user_id)
    } else if (raw.notice_type === "group_ban") {
        tplKey = "group_ban";
        data["user_id"] = raw.user_id;
        targetId = Number(raw.user_id)
    } else if (raw.notice_type === "friend_add") {
        tplKey = "friend_add";
        data["user_id"] = raw.user_id;
        targetId = Number(raw.user_id)
    }

    let text = ""
    const tpl = config.noticeTpl?.[tplKey]
    if (tpl) {
        let tplStr = tpl
        for (const k in data) tplStr = tplStr.replace(`{${k}}`, String(data[k]))
        text = tplStr
    } else {
        text = `[unknown_notice]`
    }
    return { targetId, text }
}

export function transMeta(raw: any, selfId: number, config: ConfigType): { targetId: number; text: string } {
    let tplKey = ""
    const data: Record<string, any> = { "self_id": selfId }
    let targetId = selfId

    if (raw.meta_event_type === "heartbeat") {
        tplKey = "heartbeat";
        data["status"] = JSON.stringify(raw.status ?? {})
    } else if (raw.meta_event_type === "lifecycle") {
        if (raw.sub_type === "connect") tplKey = "lifecycle_connect"
        else if (raw.sub_type === "disconnect") tplKey = "lifecycle_disconnect"
        else if (raw.sub_type === "reconnect") tplKey = "lifecycle_reconnect"
    }

    let text = ""
    const tpl = config.metaTpl?.[tplKey]
    if (tpl) {
        let tplStr = tpl
        for (const k in data) tplStr = tplStr.replace(`{${k}}`, String(data[k]))
        text = tplStr
    } else {
        text = `[unknown_meta]`
    }
    return { targetId, text }
}