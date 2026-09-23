// 框架内置已知适配器类型（适配器外置后仍允许任意字符串，故 BotConfig.type 为 已知名 | 任意字符串）
export type KnownAdapterType =
  | "onebot11" | "milky" | "satori" | "wechat" | "wechatferry" | "weflow" | "wechat_db"
  | "bilibili_live" | "bilibili" | "qq" | "telegram"
  | "kook" | "discord" | "weixin_oc" | "icqq"
  | "douyin" | "minecraft" | "sandbox"

// 单个机器人实例配置
export interface BotConfig {
  // 框架内唯一标识
  botId: string
  // 是否启用（默认 true；false 时跳过启动）
  enable?: boolean
  // 适配器类型：内置类型有编辑器提示，外置适配器可填任意字符串（目录名）
  type: KnownAdapterType | (string & {})
  // 连接模式：onebot11 用 ws_client/ws_reverse/http；milky/satori 用 ws/ws_reverse/http；qq 用 websocket/websockets/webhook
  mode?: string
  // 监听端口（反向 WS / HTTP）
  port?: number
  // WS 路径
  path?: string
  // 正向 WS 地址
  url?: string
  // 鉴权 token
  token?: string
  // Satori / 其他协议的平台标识
  platform?: string
  [key: string]: any
}

// 插件配置：key 为插件名（不含扩展名）
// value 可为：
// true / false          仅开关
// { enable, apis? }      开关 + 代理 API 白名单
// apis: 允许该插件调用的 PluginApiName 列表（如 ["bot.status", "plugin.list"]）
// 未写 apis 视为不额外限制（跟随插件声明）；空数组 [] 表示全部禁用
export interface PluginEntry {
  enable?: boolean
  apis?: string[]
}
export type PluginConfig = Record<string, boolean | PluginEntry>

// 顶层配置文件结构
export interface AppConfig {
  bots: BotConfig[]
  plugins: PluginConfig
  // 插件热加载开关，默认 true
  hotReload?: boolean
  // WebUI 控制台（默认启用，127.0.0.1:8080）
  webui?: { enable?: boolean; port?: number; host?: string }
}

// 配置解析入口类型（仅支持新版对象格式，旧版纯数组格式已移除，不允许并存）
export type RawConfig = AppConfig
