import { createRequire } from "module"
import { BaseAdapter } from "../base.js"
import { mcChatToEvent } from "./converter.js"
import type { MessageChain } from "../../core/models/message.js"
import { normalizeSegments } from "../../core/messageUtils.js"
import { registerBot } from "../../core/botRegistry.js"
import type { Capabilities } from "../../core/capabilities.js"
import type { BotEvent } from "../../core/models/event.js"
import { botLog } from "../../core/logger.js"
import type { MinecraftConfig } from "./types.js"

// mineflayer 是 CJS 包，且不强制随框架安装；用 createRequire 按需加载，
// 缺依赖时 connect() 抛错，由框架捕获并跳过该适配器（不影响其它平台）。
const require = createRequire(import.meta.url)
let mineflayerMod: any = null
let pathfinderMod: any = null
let vec3Mod: any = null
function loadMcDeps(): void {
  if (mineflayerMod && pathfinderMod && vec3Mod) return
  try {
    mineflayerMod = require("mineflayer")
    pathfinderMod = require("mineflayer-pathfinder")
    vec3Mod = require("vec3")
  } catch (e) {
    throw new Error(
      `[MC] 缺少 mineflayer 依赖，请先安装: npm i mineflayer mineflayer-pathfinder vec3（${(e as Error).message}）`,
    )
  }
}

export const MinecraftAdapterMap = new Map<string, MinecraftAdapter>()

// Minecraft 适配器（基于 mineflayer）
// 原理：
// 1. 用 mineflayer.createBot 连接 MC 服务器（离线/正版认证）
// 2. bot.on('chat') 接收聊天 → 转统一事件派发给插件
// 3. 发送：bot.chat(text)（MC 聊天为全局广播）
// 4. 额外提供建房/传送/丢包等指令 API（参考 mc/bot.js）
// 配置项（config.json 中 type: "minecraft"）：
// botId    - 框架内标识
// type     - "minecraft"
// host     - 服务器地址，必填（如 "mc.ziyi.asia"）
// port     - 服务器端口，默认 25565
// username - 机器人游戏名，必填
// auth     - offline（离线）| microsoft（正版）| mojang，默认 offline
// version  - 游戏版本（如 "1.20.1"），留空自动协商
// ignoreSelf - 可选，默认 true
export class MinecraftAdapter extends BaseAdapter {
  public readonly botId: string
  private readonly cfg: MinecraftConfig
  private bot: any = null
  private stopped = false
  // 上一次建造的方块坐标，用于撤销
  private lastHouseBlocks: Array<{ x: number; y: number; z: number }> = []

  constructor(config: Record<string, any>) {
    super()
    this.cfg = config as MinecraftConfig
    this.botId = config.botId
    MinecraftAdapterMap.set(this.botId, this)
    registerBot(this)
  }

  public async connect(): Promise<void> {
    loadMcDeps()
    if (!this.cfg.host) throw new Error(`[${this.botId}] 缺少 host 配置（服务器地址）`)
    if (!this.cfg.username) throw new Error(`[${this.botId}] 缺少 username 配置（机器人游戏名）`)

    const mf = mineflayerMod
    const bot = mf.createBot({
      host: this.cfg.host,
      port: this.cfg.port ?? 25565,
      username: this.cfg.username,
      auth: this.cfg.auth ?? "offline",
      version: this.cfg.version || undefined,
      viewDistance: this.cfg.viewDistance ?? 8,
    })
    this.bot = bot

    // 加载寻路插件（建房/传送会用到）
    try {
      bot.loadPlugin(pathfinderMod.pathfinder)
    } catch {
      // 加载失败不阻断聊天收发
    }

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        cleanup()
        this.connected = true
        const uuid = bot.entity?.uuid ?? bot.player?.uuid ?? ""
        const username = bot.username ?? this.cfg.username ?? ""
        this.selfId = username
        console.log(`✅ [${this.botId}] 已连接 ${this.cfg.host}:${this.cfg.port ?? 25565}（玩家: ${username}${uuid ? `, uuid: ${uuid}` : ""}）`)
        resolve()
      }
      const onErr = (err: any) => {
        cleanup()
        reject(new Error(`[${this.botId}] 连接失败: ${err?.message ?? err}`))
      }
      const cleanup = () => {
        bot.removeListener("spawn", onSpawn)
        bot.removeListener("error", onErr)
        bot.removeListener("kicked", onKicked)
      }
      const onKicked = (r: any) => {
        console.error(`[${this.botId}] 被服务器踢出: ${r}`)
      }
      bot.once("spawn", onSpawn)
      bot.once("error", onErr)
      bot.on("kicked", onKicked)
      // 超时保护：30 秒连不上视为失败
      setTimeout(() => {
        if (!this.connected) {
          cleanup()
          reject(new Error(`[${this.botId}] 连接超时（30s），请检查服务器地址/版本`))
        }
      }, 30000).unref?.()
    })

    // 接收聊天消息
    bot.on("chat", (player: string, msg: string) => {
      const event = mcChatToEvent(player, msg, this.botId, this.selfId, this)
      if (event) this.emitEvent("private_message", event)
    })

    // 服务器系统消息（死亡、成就等）也转发为私聊事件，方便日志查看
    bot.on("message", (jsonMsg: any) => {
      try {
        const text = jsonMsg?.toString?.() ?? ""
        if (!text) return
        // 系统消息的 sender 非玩家，用 selfId 占位；ignoreSelf 过滤
        if (this.cfg.ignoreSelf !== false && text.includes(this.selfId)) return
        const event = mcChatToEvent(this.selfId, text, this.botId, this.selfId, this)
        if (event) this.emitEvent("private_message", event)
      } catch {
        // 忽略解析失败的消息
      }
    })

    bot.on("kicked", (r: any) => {
      console.error(`[${this.botId}] 被踢出: ${r}`)
      this.connected = false
    })

    // ===== 服务器事件：玩家加入/退出/死亡/成就/机器人状态 =====
    bot.on("playerJoined", (player: any) => {
      const name = player?.username ?? player?.displayName ?? "未知玩家"
      this.emitNotice("player_join", `玩家加入: ${name}`, { userId: name, player })
    })
    bot.on("playerLeft", (player: any) => {
      const name = player?.username ?? player?.displayName ?? "未知玩家"
      this.emitNotice("player_leave", `玩家退出: ${name}`, { userId: name, player })
    })
    bot.on("playerDied", (player: any) => {
      const name = player?.username ?? player?.displayName ?? "未知玩家"
      this.emitNotice("player_death", `玩家死亡: ${name}`, { userId: name, player })
    })
    // 1.12+ 进度/成就
    bot.on("advancement", (adv: any) => {
      const title = adv?.title ?? adv?.id ?? "未知成就"
      const desc = adv?.description ? `（${adv.description}）` : ""
      const who = adv?.player?.username ?? adv?.username ?? "某玩家"
      this.emitNotice("advancement", `${who} 达成成就: ${title}${desc}`, { userId: who, advancement: adv })
    })
    // 旧版成就（1.11 及以下）
    bot.on("playerAchievement", (player: any, achievement: any) => {
      const name = player?.username ?? "未知玩家"
      const title = typeof achievement === "string" ? achievement : achievement?.id ?? achievement?.title ?? "未知成就"
      this.emitNotice("player_achievement", `${name} 获得成就: ${title}`, { userId: name, achievement })
    })
    // 机器人自身死亡
    bot.on("death", () => {
      this.emitNotice("self_death", `机器人 ${this.selfId} 死亡`, { userId: this.selfId })
    })
    // 机器人重生
    bot.on("respawn", () => {
      this.emitNotice("self_respawn", `机器人 ${this.selfId} 已重生`, { userId: this.selfId })
    })
    // 生命值/饥饿值变化（仅在明显变化时提示，避免刷屏）
    let lastHealth = -1
    let lastFood = -1
    bot.on("health", () => {
      const h = Math.round(bot.health ?? 0)
      const f = Math.round(bot.food ?? 0)
      if (lastHealth !== -1 && h !== lastHealth) {
        this.emitNotice("health_change", `生命值变化: ${lastHealth} → ${h}`, { userId: this.selfId, health: h, food: f })
      }
      if (lastFood !== -1 && f !== lastFood) {
        this.emitNotice("food_change", `饥饿值变化: ${lastFood} → ${f}`, { userId: this.selfId, health: h, food: f })
      }
      lastHealth = h
      lastFood = f
    })

    bot.on("error", (e: any) => {
      console.error(`[${this.botId}] 连接错误:`, e?.message ?? e)
    })
    bot.on("end", () => {
      if (this.stopped) return
      console.error(`[${this.botId}] 与服务器断开，等待重连...`)
      this.connected = false
      // 自动重连（指数退避）
      const delay = this.cfg.reconnectDelay ?? 5000
      setTimeout(() => {
        if (!this.stopped) {
          this.connect().catch((e) => console.error(`[${this.botId}] 重连失败:`, e?.message ?? e))
        }
      }, delay)
    })
  }

  public async disconnect(): Promise<void> {
    this.stopped = true
    if (this.bot) {
      try {
        this.bot.end?.("机器人主动断开")
      } catch {
        // 忽略
      }
    }
    this.connected = false
    console.log(`[${this.botId}] 已断开`)
  }

  // 派发服务器事件（玩家加入/退出/死亡/成就等）为框架 notice 事件，
  // 同时用 botLog 统一格式输出，与其它平台的收发日志风格一致。
  private emitNotice(noticeType: string, text: string, extra: Record<string, any> = {}): void {
    botLog(this.selfId, "<-", "通知", String(extra.userId ?? ""), text)
    const event: BotEvent = {
      botId: this.botId,
      selfId: this.selfId,
      userId: extra.userId ?? "",
      groupId: undefined,
      message: [{ type: "text", data: { text } }],
      postType: "notice",
      raw: { platform: "minecraft", notice_type: noticeType, text, ...extra },
    }
    ;(event.raw as any).time = Math.floor(Date.now() / 1000)
    this.emitEvent("notice", event)
  }

  // 会话能力：Minecraft 聊天只支持纯文本，富媒体/按钮等不支持
  computeCapabilities(_event: BotEvent): Readonly<Capabilities> {
    return {
      text: true,
      image: false,
      video: false,
      audio: false,
      file: false,
      markdown: false,
      button: false,
      at: false,
      reply: false,
      face: false,
    }
  }

  // 统一 API 调用入口
  // 支持：
  // - send_msg / send_private_msg / send_group_msg : 发送聊天（params: { user_id/group_id, message }）
  // - chat <text> : 快捷发送
  // - get_me : 返回机器人自身信息
  // - house / houseWood / undo / tp / dropAll : 建房/传送/丢包（参考 mc/bot.js）
  public async callApi<T = any>(action: string, params: Record<string, any> = {}): Promise<T> {
    if (action === "send_msg" || action === "send_private_msg" || action === "send_group_msg") {
      await this.sendMcMessage(params.message)
      return { ok: true } as unknown as T
    }
    if (action === "chat") {
      await this.sendMcMessage(params.text ?? params.message)
      return { ok: true } as unknown as T
    }
    if (action === "get_me") {
      return {
        botId: this.botId,
        selfId: this.selfId,
        host: this.cfg.host,
        port: this.cfg.port ?? 25565,
        online: this.connected,
      } as unknown as T
    }
    if (action === "house") {
      await this.buildHouse("dirt")
      return { ok: true } as unknown as T
    }
    if (action === "houseWood") {
      await this.buildHouse("oak_planks")
      return { ok: true } as unknown as T
    }
    if (action === "undo") {
      await this.undoHouse()
      return { ok: true } as unknown as T
    }
    if (action === "tp") {
      await this.teleportToPlayer(String(params.player ?? params.user_id ?? ""))
      return { ok: true } as unknown as T
    }
    if (action === "dropAll") {
      await this.dropAllItems()
      return { ok: true } as unknown as T
    }
    throw new Error(`[${this.botId}] 不支持的 API 操作: ${action}`)
  }

  // 发送聊天消息（MC 只支持文本，逐段拼接文本类消息）
  private async sendMcMessage(message: MessageChain | string): Promise<void> {
    const segments = normalizeSegments(message)
    const parts: string[] = []
    for (const seg of segments) {
      const type = seg.type
      const data = seg.data ?? {}
      if (type === "text" || type === "markdown") {
        parts.push(String(data.text ?? data.content ?? ""))
      } else if (type === "at") {
        parts.push(`@${data.name ?? data.qq ?? data.id ?? ""}`)
      } else if (type === "face") {
        parts.push(`[表情${data.id ?? ""}]`)
      } else if (type === "image") {
        parts.push(`[图片:${data.file ?? data.url ?? ""}]`)
      } else if (type === "record" || type === "voice") {
        parts.push("[语音]")
      } else if (type === "video") {
        parts.push("[视频]")
      } else if (type === "file") {
        parts.push(`[文件:${data.name ?? data.file ?? ""}]`)
      } else {
        parts.push(`[${type}]`)
      }
    }
    const text = parts.join("").trim()
    if (!text) return
    if (!this.bot || !this.connected) throw new Error(`[${this.botId}] 未连接，无法发送`)
    this.bot.chat(text)
  }

  // ===== 扩展指令：建房 / 传送 / 丢包（参考 mc/bot.js）=====

  private isAir(pos: any): boolean {
    try {
      const b = this.bot.blockAt(pos)
      return !!b && b.name === "air"
    } catch {
      return true
    }
  }

  private checkAreaEmpty(center: any, houseSize: number, wallHeight: number): boolean {
    const half = Math.floor(houseSize / 2)
    for (let dx = -half; dx <= half; dx++) {
      for (let dz = -half; dz <= half; dz++) {
        for (let dy = 0; dy < wallHeight; dy++) {
          const p = center.offset(dx, dy, dz).floor()
          if (!this.isAir(p)) return false
        }
      }
    }
    return true
  }

  // 通用建造：blockName 传方块名，记录坐标用于撤销
  private async buildAtCenter(center: any, blockName: string, houseSize: number, wallHeight: number): Promise<boolean> {
    this.lastHouseBlocks = []
    const half = Math.floor(houseSize / 2)
    if (!this.checkAreaEmpty(center, houseSize, wallHeight)) {
      return false
    }
    const setblock = (x: number, y: number, z: number) => {
      this.bot.chat(`/setblock ${Math.floor(x)} ${Math.floor(y)} ${Math.floor(z)} ${blockName}`)
      this.lastHouseBlocks.push({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) })
    }
    // 地板
    for (let dx = -half; dx <= half; dx++) {
      for (let dz = -half; dz <= half; dz++) {
        setblock(center.x + dx, center.y, center.z + dz)
      }
    }
    // 围墙
    for (let y = 1; y <= wallHeight; y++) {
      for (let x = -half; x <= half; x++) {
        setblock(center.x + x, center.y + y, center.z - half)
        setblock(center.x + x, center.y + y, center.z + half)
      }
      for (let z = -half + 1; z <= half - 1; z++) {
        setblock(center.x - half, center.y + y, center.z + z)
        setblock(center.x + half, center.y + y, center.z + z)
      }
    }
    return true
  }

  private async buildHouse(blockName: string): Promise<void> {
    const houseSize = this.cfg.houseSize ?? 5
    const wallHeight = this.cfg.wallHeight ?? 3
    if (!this.bot?.entity) throw new Error("[MC] 尚未进入游戏")
    const center = this.bot.entity.position.floor()
    const ok = await this.buildAtCenter(center, blockName, houseSize, wallHeight)
    this.bot.chat(ok ? `✅${blockName} 小屋生成完成！` : "❌建房区域有方块挡住，请换空地！")
  }

  private async undoHouse(): Promise<void> {
    if (this.lastHouseBlocks.length === 0) {
      this.bot.chat("❌没有可以撤销的房子！")
      return
    }
    this.bot.chat("🔧正在拆除房子...")
    for (const pos of this.lastHouseBlocks) {
      this.bot.chat(`/setblock ${pos.x} ${pos.y} ${pos.z} air`)
    }
    this.lastHouseBlocks = []
    this.bot.chat("✅房子已撤销拆除！")
  }

  private async teleportToPlayer(playerName: string): Promise<void> {
    if (!playerName) {
      this.bot.chat("❌缺少玩家名，用法: !tp <玩家名>")
      return
    }
    const targetPlayer = this.bot.players?.[playerName]
    if (!targetPlayer || !targetPlayer.entity) {
      this.bot.chat(`❌找不到玩家 ${playerName}`)
      return
    }
    const p = targetPlayer.entity.position
    this.bot.chat(`/tp ${this.selfId} ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}`)
    this.bot.chat(`✅已传送到 ${playerName} 身边`)
  }

  private async dropAllItems(): Promise<void> {
    try {
      const items = this.bot.inventory?.items?.() ?? []
      if (items.length === 0) {
        this.bot.chat("📦背包已经是空的")
        return
      }
      for (const it of items) {
        await this.bot.tossStack(it)
      }
      this.bot.chat("✅背包全部物品已丢弃！")
    } catch {
      this.bot.chat("❌丢包失败（可能无此权限）")
    }
  }

  public async destroy(): Promise<void> {
    await this.disconnect()
    MinecraftAdapterMap.delete(this.botId)
    await super.destroy()
  }
}

export function getMinecraftAdapterById(botId: string): MinecraftAdapter | undefined {
  return MinecraftAdapterMap.get(botId)
}
