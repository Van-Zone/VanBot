// 内核中立 Skill 注册体系
// 内核不引入任何第三方工具 SDK——工具能力完全由插件提供。
// 本模块只做：
// 1. ctx.registerSkill() 注册技能（插件上下文可用）；
// 2. 注册后框架自动生成普通命令（`/技能名 参数`）可直接调用；
// 3. 插件可读取全局注册表，自动生成函数调用描述（供外部调用方使用）；
// 4. 同一套 invoke 业务逻辑，既可供人工命令调用，也可供外部工具调用。
import { globalBus } from "./eventBus.js"
import { get_bot } from "./botRegistry.js"
import { normalizeSegments, segmentsToText } from "./messageUtils.js"
import type { BotEvent } from "./models/event.js"
import type { Capabilities } from "./capabilities.js"
import { hasCapabilities } from "./capabilities.js"

// 消息段数组（发送侧输入）
export type SkillResult = string | Array<{ type: string; data: Record<string, any> }>

export interface Skill {
  // 技能名（唯一，命令触发名 /name）
  name: string
  // 技能描述（供外部调用方理解用途）
  description: string
  // 参数结构描述（供函数调用 / 命令参数校验）
  parameters?: Record<string, any>
  // 执行该技能所需的会话能力
  requiredCapabilities?: string[]
  // 实际执行逻辑：既服务人工命令，也服务外部工具调用
  invoke: (event: BotEvent, params: Record<string, any>) => SkillResult | Promise<SkillResult>
}

// 函数调用描述（供外部调用方直接使用）
export interface FunctionCallSchema {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, any>
  }
}

class SkillRegistry {
  private readonly skills = new Map<string, Skill>()
  private commandBridgeStarted = false
  // 命令前缀（默认 "/"，避免与 keyword 的 "#" 冲突）
  private commandPrefixes = ["/"]

  // 注册技能；同名覆盖并打印提示。注册后自动启动命令桥（幂等）
  register(skill: Skill): void {
    if (!skill || !skill.name) return
    this.skills.set(skill.name, skill)
    console.log(`[Skill] 已注册: /${skill.name} — ${skill.description}`)
    this.startCommandBridge()
  }

  unregister(name: string): void {
    this.skills.delete(name)
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name)
  }

  list(): Skill[] {
    return [...this.skills.values()]
  }

  // 读取全局注册表生成函数调用描述
  getFunctionSchema(): FunctionCallSchema[] {
    return [...this.skills.values()].map((s) => ({
      type: "function",
      function: {
        name: s.name,
        description: s.description,
        parameters: s.parameters ?? { type: "object", properties: {} },
      },
    }))
  }

  // 启动自动命令桥：收到文本消息形如 `/技能名 参数` → 调用 invoke → 结果发回。
  // 自动启动（注册首个技能时），无需手动调用。
  startCommandBridge(prefixes?: string[]): void {
    if (this.commandBridgeStarted) return
    if (prefixes && prefixes.length) this.commandPrefixes = prefixes
    this.commandBridgeStarted = true
    globalBus.on("*", async (eventName: string, event: BotEvent) => {
      if (eventName !== "private_message" && eventName !== "group_message") return
      if (!event || !event.message) return
      const text = extractPlainText(event)
      if (!text) return
      const hit = this.tryParseCommand(text)
      if (!hit) return
      const skill = this.skills.get(hit.name)
      if (!skill) return
      // 会话能力校验
      const caps: Readonly<Capabilities> = event.capabilities ?? {}
      if (!hasCapabilities(caps, skill.requiredCapabilities)) {
        this.reply(event, `技能 /${hit.name} 需要会话能力 [${(skill.requiredCapabilities ?? []).join(",")}]，当前会话不支持`)
        return
      }
      try {
        const result = await skill.invoke(event, hit.params)
        this.reply(event, result)
      } catch (err: any) {
        this.reply(event, `技能 /${hit.name} 执行失败: ${err?.message ?? err}`)
      }
    })
    console.log(`[Skill] 命令桥已启动，前缀: ${this.commandPrefixes.join(" ")}`)
  }

  // 把结果发回消息来源会话
  private reply(event: BotEvent, result: SkillResult): void {
    const bot = get_bot(event.botId)
    if (!bot) return
    const target = event.groupId
      ? { groupId: event.groupId }
      : { userId: event.userId }
    bot.sendMsg(target as any, result as any).catch((err: any) =>
      console.error(`[Skill] 回复失败:`, err?.message ?? err),
    )
  }

  private tryParseCommand(text: string): { name: string; params: Record<string, any> } | null {
    for (const p of this.commandPrefixes) {
      if (!text.startsWith(p)) continue
      const rest = text.slice(p.length).trim()
      if (!rest) continue
      const spaceIdx = rest.search(/\s/)
      const name = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx)
      const argStr = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1).trim()
      if (!name) continue
      return { name, params: parseCommandArgs(argStr) }
    }
    return null
  }
}

// 解析命令参数：优先 JSON，其次 k=v，否则作为 input
function parseCommandArgs(argStr: string): Record<string, any> {
  if (!argStr) return {}
  // JSON
  if (argStr.startsWith("{") || argStr.startsWith("[")) {
    try {
      return { data: JSON.parse(argStr) }
    } catch {
      // fallthrough
    }
  }
  // k=v k=v
  if (/\w+=[^ ]+/.test(argStr)) {
    const out: Record<string, any> = {}
    for (const pair of argStr.split(/\s+/)) {
      const eq = pair.indexOf("=")
      if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1)
    }
    if (Object.keys(out).length) return out
  }
  return { input: argStr }
}

// 提取消息纯文本（拼接 text 段）
function extractPlainText(event: BotEvent): string {
  if (!Array.isArray(event.message)) return ""
  return event.message
    .filter((s) => s.type === "text")
    .map((s) => String(s.data?.text ?? ""))
    .join("")
}

// 全局技能注册表
export const skillRegistry = new SkillRegistry()
