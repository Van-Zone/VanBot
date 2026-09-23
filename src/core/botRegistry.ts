import type { BaseAdapter } from "../adapter/base.js"

// 全局机器人实例注册表
// 插件可通过 get_bot(机器人Q号字符串 / botId) 获取适配器实例

// 按框架内 botId 索引
const botsByBotId = new Map<string, BaseAdapter>()
// 按协议侧 selfId（QQ号 / 平台ID）索引
const botsBySelfId = new Map<string, BaseAdapter>()

// 注册机器人实例（适配器构造时调用）
export function registerBot(bot: BaseAdapter): void {
  if (!bot?.botId) return
  botsByBotId.set(bot.botId, bot)
}

// 登记 selfId 与实例的映射（首次收到事件时自动调用）
export function registerSelfId(bot: BaseAdapter, selfId: string | number): void {
  if (!selfId) return
  botsBySelfId.set(String(selfId), bot)
}

// 通过机器人标识获取实例
// 优先按 botId 查找，再按 selfId（QQ号/平台ID）查找
// @param id 机器人Q号字符串 或 botId
export function get_bot(id: string): BaseAdapter | undefined {
  if (!id) return undefined
  return botsByBotId.get(id) ?? botsBySelfId.get(id)
}

// 注销机器人实例（适配器销毁时调用）
export function unregisterBot(bot: BaseAdapter): void {
  if (!bot) return
  botsByBotId.delete(bot.botId)
  for (const [sid, b] of botsBySelfId) {
    if (b === bot) botsBySelfId.delete(sid)
  }
}

// 获取所有已注册的机器人实例
export function get_all_bots(): BaseAdapter[] {
  return [...botsByBotId.values()]
}
