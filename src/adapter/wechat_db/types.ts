// 微信数据库适配器类型定义
// 直读微信 4.x 解密后的 SQLite 数据库，轮询新消息

// 消息表记录（微信 4.x）
export interface DbMessage {
  local_id?: number           // 本地消息ID
  server_id?: number          // 服务器消息ID
  local_type?: number         // 消息类型
  sort_seq?: number           // 排序序列号
  real_sender_id?: number     // 发送者ID
  create_time?: number        // 创建时间戳
  status?: number             // 状态
  message_content?: string    // 消息内容
  source?: string             // 来源
  tableName?: string          // 所属表名（Msg_xxx）
  [key: string]: unknown
}

// 会话表记录
export interface DbSession {
  talker?: string         // 聊天对象
  lastMsg?: string        // 最后一条消息
  lastTime?: number       // 最后消息时间
  [key: string]: unknown
}
