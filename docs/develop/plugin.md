---
title: 插件开发
description: definePlugin 新式插件写法与 ctx 能力
---

# 插件开发（definePlugin）

插件放在 `plugin/*.ts`，用 `definePlugin` 声明元数据并返回事件处理器。所有插件获得**隔离的 PluginContext**（`ctx`），禁止污染全局。

## 完整示例

```ts
// plugin/example_demo.ts
import { definePlugin } from "../src/core/pluginContext.js"
import { MessageSegment } from "../src/core/models/message.js"

export default definePlugin(
  {
    name: "example_demo",
    version: "1.0.0",
    description: "示例插件",
    requiresCapabilities: ["text"],   // 处理事件所需会话能力（不足自动跳过）
    permissions: ["user"],            // 权限声明（内核记录）
    apis: ["plugin.list"],            // ★ 声明要调用的代理 API（未声明则全禁用）
  },
  (ctx) => {
    // 注册中立 Skill（人工命令 /echo 与外部调用方都可调用）
    ctx.registerSkill({
      name: "echo",
      description: "原样回显一段文本",
      parameters: {
        type: "object",
        properties: { input: { type: "string", description: "要回显的内容" } },
        required: ["input"],
      },
      invoke: async (event, params) => `echo: ${params.input ?? ""}`,
    })

    return {
      onEvent: async (event) => {
        const text = event.message
          ?.filter((s) => s.type === "text")
          .map((s) => String(s.data?.text ?? ""))
          .join("")
        if (!text) return

        // 能力判断（绝不判断平台字符串）
        if (event.getCapabilities?.().canMuteMember) {
          console.log(`当前会话可以禁言 traceId=${event.traceId}`)
        }

        // 发送带能力声明 + 降级的消息
        if (text === "测试降级") {
          await ctx.reply(event, [
            MessageSegment.text("这段一定发").needs("text"),
            MessageSegment.image("https://example.com/nonexist.png")
              .needs("image")
              .fallbackTo(MessageSegment.text("[图片不可用，降级为文本]")),
          ])
        } else if (text.startsWith("你好")) {
          await ctx.reply(event, "你好呀！试试发「测试降级」，或 /echo 你好")
        }
      },
      onEnable: () => {
        // 用 ctx.setTimeout（框架追踪，卸载自动清理）
        ctx.setTimeout(() => console.log("3 秒定时器"), 3000)
      },
      onDisable: () => {},
    }
  },
)
```

## ctx 提供的核心能力

| 方法 | 说明 |
| --- | --- |
| `ctx.reply(event, msg)` | 回复当前事件来源会话（自动携带能力集走内核降级） |
| `ctx.setTimeout / setInterval / clear*` | 框架封装定时器，插件卸载 / 热重载自动全部清理 |
| `ctx.on / off` | 事件监听（卸载自动移除） |
| `ctx.registerSkill(skill)` | 注册中立 Skill |
| `ctx.api` | 受控代理 API（需声明 `apis` + 白名单，未授权调用抛错） |
| `ctx.hasCapabilities(caps, need)` | 判断能力是否满足 |

::: warning 副作用追踪
插件**禁止直接使用原生 `setTimeout / setInterval` 与裸事件监听**，应使用 `ctx` 封装版——内核保存所有句柄，插件禁用 / 热重载时自动清理，杜绝内存泄漏残留。
:::

## definePlugin 签名

```ts
interface PluginMeta {
  name: string
  version?: string
  description?: string
  dependencies?: string[]          // 依赖的其它插件（启动时检查提示）
  requiresCapabilities?: string[]  // 处理事件所需会话能力
  permissions?: string[]           // 权限声明
  apis?: PluginApiName[]           // 需要调用的代理 API（未声明全禁用）
}
definePlugin(meta, (ctx) => ({ onEvent, onEnable, onDisable }))
```
