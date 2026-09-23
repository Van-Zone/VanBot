---
title: 代理 API
description: ctx.api 受控能力层与权限模型
---

# 插件代理 API（ctx.api）



## 1. bot 级启用开关

config.json 每个机器人都可加 `enable` 字段：

```json
{
  "bots": [
    { "botId": "Van-None", "type": "onebot11", "enable": true },
    { "botId": "WX-Personal", "type": "weixin_oc", "enable": false }
  ]
}
```

- `enable` 省略 = `true`（默认启用）；`false` 时该机器人**不启动**。
- 支持热重载：改 `enable` 保存后自动生效（启用→连接，禁用→断开）。
- 运行中的进程也可通过代理 API 动态改开关（见下文 `bot.enable` / `bot.disable`，会同步写回 config.json）。

## 2. plugins 配置新格式

`plugins` 字段的值可以是：

- `true` / `false`：仅开关（旧格式，兼容）；
- 对象 `{ "enable": bool, "apis": ["bot.status", ...] }`：
  - `enable`：开关；
  - `apis`：允许该插件调用的代理 API 白名单（可选）。
    - 未写 `apis` → 不额外限制（跟随插件声明）；
    - 空数组 `[]` → 该插件所有代理 API 全禁用。

```json
{
  "plugins": {
    "example_demo": true,
    "my_plugin": { "enable": true, "apis": ["plugin.list"] }
  }
}
```

## 3. 代理 API 一览

插件通过 `ctx.api` 调用（只读快照，不暴露内核原始对象）。

| API | 说明 | 返回值 |
|---|---|---|
| `ctx.api.listBots()` | 列出所有机器人 | `BotSnapshot[]` |
| `ctx.api.getBotStatus(botId?)` | 单个/全部机器人状态 | `BotSnapshot \| BotSnapshot[]` |
| `ctx.api.enableBot(botId)` | 启用机器人（写回 config + 即时连接） | `Promise<void>` |
| `ctx.api.disableBot(botId)` | 禁用机器人（写回 config + 断开） | `Promise<void>` |
| `ctx.api.addBot(cfg)` | 新增机器人（写回 config + 启动） | `Promise<void>` |
| `ctx.api.removeBot(botId)` | 移除机器人（写回 config + 断开） | `Promise<void>` |
| `ctx.api.listPlugins()` | 列出所有插件及启用状态 | `PluginStatus[]` |
| `ctx.api.enablePlugin(name)` | 启用插件 | `Promise<void>` |
| `ctx.api.disablePlugin(name)` | 禁用插件 | `Promise<void>` |
| `ctx.api.getMessageStats()` | 各机器人收发消息统计 | `Record<botId, {received, sent}>` |

```ts
interface BotSnapshot {
  botId: string
  type: string        // 适配器类型
  connected: boolean
  selfId: string
  stats: { received: number; sent: number }
}
interface PluginStatus {
  name: string
  enabled: boolean
}
```

> 安全设计：返回的都是**只读快照**（新对象），插件拿不到 adapter / pluginManager / botRegistry 的引用，无法绕过内核直接操作。

## 4. 权限模型（两道闸门）

插件要调用代理 API，必须同时满足：

1. **插件声明**：`definePlugin` 元数据里写 `apis: [...]`（未声明则该插件所有代理 API 禁用）；
2. **配置白名单**：config.json 该插件的 `apis` 白名单（可选收窄）。

**实际可用 = 插件声明 ∩ 配置白名单**。未授权调用会抛错：

```
[API] 插件 xxx 无权调用 bot.enable（需在 definePlugin 声明 apis，且 config.json plugins 白名单允许）
```

## 5. 插件侧写法示例

```ts
import { definePlugin } from "../src/core/pluginContext.js"

export default definePlugin(
  {
    name: "ops",
    description: "管理插件：查询状态 / 启停机器人",
    // 声明需要调用的代理 API
    apis: ["bot.list", "bot.status", "bot.enable", "bot.disable", "stats.messages"],
  },
  (ctx) => ({
    onEvent: async (event) => {
      const text = event.message?.filter((s) => s.type === "text")
        .map((s) => String(s.data?.text ?? "")).join("") ?? ""
      try {
        if (text === "机器人状态") {
          const bots = ctx.api!.listBots()
          const lines = bots.map((b) =>
            `${b.botId} [${b.type}] ${b.connected ? "在线" : "离线"} 收${b.stats.received}/发${b.stats.sent}`
          )
          await ctx.reply(event, lines.join("\n") || "无机器人")
        } else if (text.startsWith("停用机器人 ")) {
          const id = text.slice("停用机器人 ".length).trim()
          await ctx.api!.disableBot(id)
          await ctx.reply(event, `已停用 ${id}`)
        }
      } catch (err: any) {
        await ctx.reply(event, `操作失败：${err?.message ?? err}`)
      }
    },
  }),
)
```

## 6. 示例插件 example_demo

`plugin/example_demo.ts` 已展示 `ctx.api.listPlugins()` 用法（声明 `apis: ["plugin.list"]`）。
启用：config.json 里 `"example_demo": { "enable": true, "apis": ["plugin.list"] }`。

## 7. 消息日志（内核内置）

收发消息日志（`MM-DD hh:mm | botId <- 群聊 (xxx) 内容` / `-> 私聊 (xxx) 内容`）由框架内核内置显示
（BaseAdapter 在接收/发送流水线统一输出，格式与 `botLog` 一致），**不依赖任何插件**、无需配置即可显示，所有平台一致。
机器人服务器事件等通知类日志也走同一 `botLog` 通道。

管理类操作通过代理 API（`ctx.api`：`bot.*` / `plugin.*` / `stats.*` / `sys.*`）暴露，由需要它的插件在 `apis` 里声明后调用。

## 8. 单实例锁（禁止重复启动）

程序启动时创建锁文件 `./.vanbot.lock`（写入进程 PID），防止重复启动：

- 已有存活实例（锁文件 PID 仍在运行）→ 打印提示并**退出**，不会重复连接适配器；
- 锁文件残留但进程已退出（如异常崩溃）→ 自动接管；
- 进程正常退出（SIGINT/SIGTERM/exit）→ 自动删除锁文件；
- 重复启动的实例退出时**不会**删除首个实例的锁，避免误删。
