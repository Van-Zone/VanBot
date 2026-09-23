// 插件代理 API（受控能力层）
// 设计目标：插件不能直接触碰内核原始对象（adapter / pluginManager / botRegistry），
// 只能通过本层暴露的【只读快照 + 受控操作】与框架交互。
// 权限模型（两道闸门，缺一不可）：
// 1. 插件声明：definePlugin 元数据里声明 `apis: PluginApiName[]`（未声明则全部禁用）；
// 2. 配置白名单：config.json 的 plugins 字段可对该插件再收窄
// （`"example": { "enable": true, "apis": ["bot.status"] }`）。
// 实际可用 = 插件声明 ∩ 配置白名单；配置未写 apis 时视为不额外限制（跟随插件声明）。

// 代理 API 名称集合
export type PluginApiName =
  | "bot.list"      // 列出所有机器人（含禁用，只读快照）
  | "bot.status"    // 获取单个机器人状态（只读快照）
  | "bot.enable"    // 启用机器人
  | "bot.disable"   // 禁用机器人
  | "bot.add"       // 新增机器人
  | "bot.remove"    // 移除机器人
  | "plugin.list"   // 列出所有插件及启用状态（含未加载/禁用）
  | "plugin.enable" // 启用插件
  | "plugin.disable"// 禁用插件
  | "stats.messages"// 收发消息统计
  | "sys.info"      // 系统信息（CPU/内存/运行时间）

// 机器人只读快照（不暴露原始 adapter）
export interface BotSnapshot {
  botId: string
  type: string
  connected: boolean
  // 是否启用（config enable !== false；含未启动的禁用项）
  enabled: boolean
  selfId: string
  stats: { received: number; sent: number }
}

// 插件状态（不暴露 PluginManager 内部对象）
export interface PluginStatus {
  name: string
  // 是否已加载（plugin 目录存在该文件）
  loaded: boolean
  enabled: boolean
}

// 系统信息（CPU/内存/运行时间）
export interface SystemInfo {
  // CPU 使用率百分比 0-100
  cpuUsage: number
  // 内存总量（字节）
  totalMem: number
  // 空闲内存（字节）
  freeMem: number
  // 内存使用率百分比 0-100
  memUsage: number
  // 系统已运行秒数
  systemUptime: number
  // 进程已运行秒数
  processUptime: number
  // 平台标识，如 win32 / linux / darwin
  platform: string
  // CPU 架构，如 x64 / arm64
  arch: string
}

// 内核桥接层：由 index.ts 组装，持有受限能力，不暴露原始对象
export interface PluginApiBridge {
  listBots(): BotSnapshot[]
  getBotStatus(botId?: string): BotSnapshot | BotSnapshot[] | undefined
  enableBot(botId: string): Promise<void>
  disableBot(botId: string): Promise<void>
  addBot(cfg: Record<string, any>): Promise<void>
  removeBot(botId: string): Promise<void>
  listPlugins(): PluginStatus[]
  enablePlugin(name: string): Promise<void>
  disablePlugin(name: string): Promise<void>
  getMessageStats(): Record<string, { received: number; sent: number }>
  getSystemInfo(): Promise<SystemInfo>
}

// 每个插件获得一个独立受限代理。
// 未授权的调用直接抛错（明确提示缺声明还是缺白名单）。
export class PluginApiProxy {
  private readonly allowed: Set<PluginApiName>

  constructor(
    private readonly pluginName: string,
    declared: PluginApiName[],
    private readonly bridge: PluginApiBridge,
    cfgAllowed?: PluginApiName[],
  ) {
    // 可用 = 插件声明 ∩ 配置白名单（config 未写 apis 则跟随声明）
    const list = cfgAllowed
      ? declared.filter((a) => cfgAllowed.includes(a))
      : [...declared]
    this.allowed = new Set(list)
  }

  // 该插件实际被授权的 API 列表（供调试/日志）
  get granted(): PluginApiName[] {
    return [...this.allowed]
  }

  private check(name: PluginApiName): void {
    if (!this.allowed.has(name)) {
      throw new Error(
        `[API] 插件 ${this.pluginName} 无权调用 ${name}（需在 definePlugin 声明 apis，且 config.json plugins 白名单允许）`,
      )
    }
  }

  // 机器人

  listBots(): BotSnapshot[] {
    this.check("bot.list")
    return this.bridge.listBots()
  }

  getBotStatus(botId?: string): BotSnapshot | BotSnapshot[] | undefined {
    this.check("bot.status")
    return this.bridge.getBotStatus(botId)
  }

  async enableBot(botId: string): Promise<void> {
    this.check("bot.enable")
    return this.bridge.enableBot(botId)
  }

  async disableBot(botId: string): Promise<void> {
    this.check("bot.disable")
    return this.bridge.disableBot(botId)
  }

  async addBot(cfg: Record<string, any>): Promise<void> {
    this.check("bot.add")
    return this.bridge.addBot(cfg)
  }

  async removeBot(botId: string): Promise<void> {
    this.check("bot.remove")
    return this.bridge.removeBot(botId)
  }

  // 插件

  listPlugins(): PluginStatus[] {
    this.check("plugin.list")
    return this.bridge.listPlugins()
  }

  async enablePlugin(name: string): Promise<void> {
    this.check("plugin.enable")
    return this.bridge.enablePlugin(name)
  }

  async disablePlugin(name: string): Promise<void> {
    this.check("plugin.disable")
    return this.bridge.disablePlugin(name)
  }

  // 收发统计

  getMessageStats(): Record<string, { received: number; sent: number }> {
    this.check("stats.messages")
    return this.bridge.getMessageStats()
  }

  // 系统信息

  async getSystemInfo(): Promise<SystemInfo> {
    this.check("sys.info")
    return this.bridge.getSystemInfo()
  }
}

// 代理 API 管理器：为每个启用插件创建受限代理。
export class PluginApiManager {
  constructor(private readonly bridge: PluginApiBridge) {}

  createApi(
    pluginName: string,
    declared: PluginApiName[],
    cfgAllowed?: PluginApiName[],
  ): PluginApiProxy {
    return new PluginApiProxy(pluginName, declared, this.bridge, cfgAllowed)
  }
}
