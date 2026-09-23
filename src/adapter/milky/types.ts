export interface MilkySegment {
    type: string
    data: Record<string, any>
}

export interface MilkyRawEvent {
    time: number
    self_id: number
    event_type: string
    data?: {
        group?: { group_id: number }
        sender_id?: number
        message_scene?: "group" | "private"
        segments?: MilkySegment[]
    }
}

export interface MilkyApiReq {
    echo: string
    action: string
    params: Record<string, any>
}

export interface MilkyApiResp {
    echo: string
    code: number
    msg?: string
    data?: any
}