export interface OB11BaseEvent {
  time: number
  self_id: number
  post_type: "message" | "meta_event" | "notice" | "request"
}

export interface OB11MessageEvent extends OB11BaseEvent {
  post_type: "message"
  message_type: "group" | "private"
  sub_type: string
  message_id: number
  user_id: number
  group_id?: number
  message: Array<{ type: string; data: Record<string, any> }>
  raw_message: string
  sender: { user_id: number; nickname: string }
}

export interface OB11Heartbeat extends OB11BaseEvent {
  post_type: "meta_event"
  meta_event_type: "heartbeat"
  status: Record<string, any>
}

// OB11 API 请求格式
export interface OB11ApiReq {
  action: string
  params: Record<string, any>
  echo: string
}

export type OB11ConnectMode = "ws_client" | "ws_reverse" | "http"