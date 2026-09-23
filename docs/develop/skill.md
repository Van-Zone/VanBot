---
title: Skill 技能
description: 内核中立能力注册，命令与外部调用方共用
---

# Skill 技能（内核中立能力注册）

内核**不引入任何第三方工具 SDK**——工具能力完全由插件提供。通过 `ctx.registerSkill()` 注册的技能，**同一套 invoke 业务逻辑**既可以作为普通命令被调用，也可以供外部调用方读取注册表自动生成函数调用描述。

```ts
interface Skill {
  name: string                    // 技能名（唯一，命令触发 /name）
  description: string             // 描述（供外部调用方理解用途）
  parameters?: Record<string, any> // 参数结构描述（供函数调用 / 命令参数校验）
  requiredCapabilities?: string[]  // 执行所需的会话能力
  invoke: (event, params) => string | MessageSegment[] | Promise<...>
}

ctx.registerSkill({
  name: "weather",
  description: "查询天气",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  invoke: async (event, params) => `查询 ${params.city} 的天气...`,
})
```

## 两种调用方式

- **命令调用**：注册后自动启动命令桥，收到形如 `/weather 北京` 的文本消息自动调用并回发结果；
- **外部调用**：外部调用方用 `skillRegistry.getFunctionSchema()` 生成函数调用描述，把 invoke 作为工具使用。

## 其它

- 命令参数解析：优先 JSON，其次 `k=v`，否则作为 `input`；
- 命令前缀默认 `/`（与插件内部自定义的触发方式互不冲突）。
