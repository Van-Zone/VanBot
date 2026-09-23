---
title: 事件 / 发送流水线
description: 接收事件归一化与发送降级流水线
---

# 事件 / 发送流水线

## 接收：适配器 → 内核 → 插件

1. 适配器把原始协议转成基础 `BotEvent` + `MessageSegment`；
2. 内核归一化（traceId / ID 字符串化 / 时间 / 未知段占位 / 能力集）；
3. 中间件执行（每个中间件前后保存 event 快照，方便排查谁改动了事件），最内层触发 `globalBus` 派发给插件；
4. 插件 `onEvent` 收到标准化事件。

```ts
// 注册一个中间件（全局共享管道）
import { globalMiddleware } from "../src/core/middleware.js"

globalMiddleware.use(async (event, next) => {
  console.log("before:", event.traceId)
  await next()          // 进入下一层，最内层派发给插件
  console.log("after:", event.traceId)
}, "logger")

// 调试：查看最近快照
globalMiddleware.getSnapshots()
```

## 发送：插件 → 内核降级 → 适配器翻译

```
await ctx.reply(event, [...])              // 插件层：只组消息
      ↓
内核 applySendFallback(chain, event.capabilities)   // 能力不足 → fallback / 丢弃
      ↓
bot.callApi("send_msg", { group_id | user_id, message })   // 统一发送动作
      ↓
适配器把统一段翻译成平台格式并发送
```

::: tip 统一发送动作
`send_msg` 群聊传 `group_id`，私聊传 `user_id`；`BaseAdapter` 也提供 `sendMsg / sendGroupMsg / sendPrivateMsg` 便捷方法。
:::
