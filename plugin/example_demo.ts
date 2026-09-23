//
// 示例插件：展示简洁的业务写法（definePlugin + ctx + Skill）
//
// 特点：
// - 不写 if(platform === xxx)，只判断能力标记（getCapabilities / ctx.hasCapabilities）；
// - 发送带能力声明的段，内核自动降级（fallback）；
// - 定时器用 ctx.setTimeout，插件卸载/热重载自动清理；
// - 注册中立 Skill（/echo），既人工命令可调、也可供外部调用方生成函数调用描述；
// - 声明代理 API（apis）并通过 ctx.api 调用（未授权调用会抛错）。
//
// 启用：config.json plugins 里加 "example_demo": true（可配 apis 白名单收窄）。
//
import { definePlugin } from "../src/core/pluginContext.js"
import { MessageSegment } from "../src/core/models/message.js"
import type { BotEvent } from "../src/core/models/event.js"

export default definePlugin(
  {
    name: "example_demo",
    version: "1.0.0",
    description: "展示 definePlugin 新写法：能力判断 + 发送降级 + Skill + 代理 API",
    requiresCapabilities: ["text"],
    permissions: ["user"],
    // 声明需要调用的代理 API（config.json 的 plugins.apis 白名单可再收窄）
    apis: ["plugin.list"],
  },
  (ctx) => {
    // 注册中立 Skill（人工命令 /echo xxx 与外部工具均可调用）
    ctx.registerSkill({
      name: "echo",
      description: "原样回显一段文本",
      parameters: {
        type: "object",
        properties: { input: { type: "string", description: "要回显的内容" } },
        required: ["input"],
      },
      invoke: async (event: BotEvent, params: Record<string, any>) => {
        return `echo: ${params.input ?? ""}`
      },
    })

    return {
      onEvent: async (event: BotEvent) => {
        // 只处理文本消息
        const text = event.message
          ?.filter((s) => s.type === "text")
          .map((s) => String(s.data?.text ?? ""))
          .join("")
        if (!text) return

        // 例 1：能力判断（绝不判断平台字符串）
        const caps = event.getCapabilities?.() ?? {}
        if (caps.canMuteMember) {
          console.log(`[example_demo] 当前会话可以禁言（traceId=${event.traceId}）`)
        }

        // 例 2：发送带能力声明的段 → 内核自动降级
        if (text === "测试降级") {
          await ctx.reply(event, [
            MessageSegment.text("这段文本一定发").needs("text"),
            MessageSegment.image("https://example.com/nonexist.png")
              .needs("image")
              .fallbackTo(MessageSegment.text("[图片在本会话不可用，已降级为文本]")),
          ])
        } else if (text.startsWith("你好")) {
          await ctx.reply(event, "你好呀！试试发「测试降级」，或 /echo 你好")
        }
      },

      onEnable: () => {
        console.log("[example_demo] 已启用")
        // 例 3：通过受控代理 API 查询（不暴露内核对象；未授权会抛错被 try/catch 捕获）
        try {
          const plugins = ctx.api?.listPlugins?.() ?? []
          console.log(`[example_demo] 当前插件列表: ${plugins.map((p) => p.name).join(", ") || "无"}`)
        } catch (err: any) {
          console.warn(`[example_demo] 代理 API 调用被拒: ${err?.message ?? err}`)
        }
        // 用 ctx.setTimeout（框架追踪，卸载时自动清理）
        ctx.setTimeout(() => {
          console.log("[example_demo] 3 秒定时器（ctx 追踪，卸载自动清理）")
        }, 3000)
      },

      onDisable: () => {
        console.log("[example_demo] 已禁用（副作用由内核自动清理）")
      },
    }
  },
)
