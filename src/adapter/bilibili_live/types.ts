// Bilibili 直播间适配器相关类型定义
// 弹幕协议基于 B 站直播弹幕 WebSocket（broadcastlv / 信息流节点）
// 文档参考: https://github.com/dxx/react-bilibili/blob/master/bilibili-api/WebSocket.md

// 直播间房间信息（room/v1/Room/get_info）
export interface RoomInfoResp {
  code: number
  message: string
  data: {
    // 主播 uid
    uid: number
    // 真实房间号（长号）
    room_id: number
    // 短号，0 表示无
    short_id: number
    // 0-未开播 1-直播中 2-轮播中
    live_status: number
    title?: string
    [key: string]: any
  }
}

// 弹幕信息流配置（xlive/web-room/v1/index/getDanmuInfo）
export interface DanmuInfoResp {
  code: number
  message: string
  data: {
    token: string
    host_list: Array<{
      host: string
      port: number
      wss_port: number
      ws_port: number
    }>
    [key: string]: any
  }
}

// 登录态 nav 接口（取机器人自己的 uid）
export interface NavResp {
  code: number
  message: string
  data: {
    isLogin: boolean
    mid?: number
    uname?: string
    [key: string]: any
  }
}

// 发送弹幕响应（msg/send）
export interface DanmakuSendResp {
  code: number
  message: string
  msg?: string
  data?: any
}

// 弹幕事件 cmd 常量
export const BILI_CMD = {
  DANMU_MSG: "DANMU_MSG",
  SUPER_CHAT: "SUPER_CHAT_MESSAGE",
  GIFT: "SEND_GIFT",
  INTERACT_WORD: "INTERACT_WORD",
  ENTRY_EFFECT: "ENTRY_EFFECT",
  LIVE: "LIVE",
  PREPARING: "PREPARING",
} as const
