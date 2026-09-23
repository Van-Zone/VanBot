---
title: 事件模型
description: BotEvent 统一事件结构与内核归一化
---

# 事件模型（BotEvent）

所有平台的事件统一转换为 `BotEvent`，经过内核归一化管道后派发给插件。

```ts
interface BotEvent {
  botId: string;                              // 框架内机器人标识
  selfId: number | string;                    // 协议侧自身 ID（归一化后为字符串）
  userId: number | string;                    // 发送者 ID（字符串）
  groupId?: number | string;                  // 群 ID，私聊时为 undefined
  message: Array<{ type: string; data: Record<string, any> }>;  // 消息段数组
  postType: EventType;                        // group_message | private_message | notice | meta_event | request
  raw: Record<string, any>;                   // 原始协议报文（调试用）

  traceId?: string;                           // ★ 全局唯一追踪 ID（管道注入）
  time?: number;                              // ★ 统一 Unix 秒时间戳（管道归一化）
  capabilities?: Readonly<Capabilities>;      // ★ 会话粒度能力集（管道注入）
  platformExtra?: unknown;                    // 平台独有数据（业务禁止判断平台字符串）
  getCapabilities?: () => Readonly<Capabilities>;  // ★ 获取能力集（管道注入）
}
```

## 内核归一化（适配器 → 插件前）

- **traceId**：分配全局唯一追踪 ID，贯穿 接收 → 中间件 → 插件 → 回复，日志里可全链路定位；
- **ID 字符串化**：所有 ID 统一转字符串，消除数字 / 雪花字符串类型坑；
- **时间统一**：从 `raw.time / create_time_ms / create_time` 归一化到 `event.time`（Unix 秒）；
- **未知段占位**：未知消息段类型转为 `[未知消息]` 文本段；
- **能力集**：调用适配器 `computeCapabilities(event)` 填充会话能力，冻结后挂到 `event.capabilities`，并注入 `getCapabilities()`。

::: tip
插件里判断能力：`event.getCapabilities?.().canMuteMember` 或 `ctx.hasCapabilities(event.capabilities, ["image"])`——**永远不判断平台字符串**。
:::
