// 日志工具：机器人收发消息格式化输出
const GREEN = "\x1b[32m"
const RESET = "\x1b[0m"

function getTime() {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  const h = String(d.getHours()).padStart(2, "0")
  const mi = String(d.getMinutes()).padStart(2, "0")
  const s = String(d.getSeconds()).padStart(2, "0")
  return `${m}-${day} ${h}:${s}`
}

// 输出一条机器人收发日志
// @param selfId 机器人 ID（绿色）
// @param dir 方向，<- 收到 / -> 发出
// @param type 私聊/群聊/通知/事件/插件
// @param targetId 群号/对方 ID/触发者 ID
// @param content 消息/事件完整转码文本
export function botLog(
  selfId: string,
  dir: "<-" | "->",
  type: "私聊" | "群聊" | "通知" | "事件" | "插件",
  targetId: string,
  content: string
) {
  const time = getTime()
  const botStr = `${GREEN}${selfId}${RESET}`
  console.log(`${time} | ${botStr} ${dir} ${type} (${targetId}) ${content}`)
}
