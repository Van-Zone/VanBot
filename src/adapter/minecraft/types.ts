// Minecraft 适配器配置项（config.json 中 type: "minecraft"）
// host       - 服务器地址，必填（如 "mc.ziyi.asia"）
// port       - 服务器端口，默认 25565
// username   - 机器人游戏名，必填
// auth       - 认证方式：offline（离线）| microsoft（正版）| mojang，默认 offline
// version    - 游戏版本（如 "1.20.1"），留空自动协商
// viewDistance - 可选，视野距离（块），默认 8
// ignoreSelf - 可选，默认 true，忽略机器人自己发的消息
export interface MinecraftConfig {
  botId: string
  type: "minecraft"
  host?: string
  port?: number
  username?: string
  auth?: "offline" | "microsoft" | "mojang"
  version?: string
  viewDistance?: number
  ignoreSelf?: boolean
  [key: string]: any
}

// mineflayer 登录/连接事件参数
export interface McLoginData {
  uuid?: string
  username?: string
}
