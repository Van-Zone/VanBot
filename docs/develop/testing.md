---
title: 单元测试
description: MockAdapter 纯内存测试与框架内核自测
---

# 单元测试（MockAdapter）

`src/testing/mockAdapter.ts` 提供纯内存 Mock 适配器：**完全不需要 WebSocket / 网络**，纯内存模拟输入事件（走真实内核管道：traceId / 归一化 / 中间件 / 插件分发），并捕获框架输出发送的消息。

```ts
import { MockAdapter } from "../src/testing/mockAdapter.js"

const bot = new MockAdapter({ botId: "MOCK" })

// 模拟会话不支持图片（测试发送降级）
bot.setCapabilities({ image: false })

// 注入一条私聊文本事件（走真实内核管道）
await bot.receivePrivateMessage("10001", "测试降级")

// 等待异步链（中间件 + 插件 handler）跑完
await bot.flush()

// 查看捕获的发送消息
console.log(bot.sent)
// → [{ action: "send_private_msg", message: [降级后的段...], ... }]
```

## 支持的能力

- `sendEvent(eventName, event)`：注入任意事件；
- `receivePrivateMessage / receiveGroupMessage`：便捷方法；
- `setCapabilities(caps)`：自定义会话能力（默认全能力上覆盖）；
- `sent`：捕获发送消息数组；
- `flush()`：等待异步链跑完；
- `clearSent()`：清空捕获。

## 框架内核自测

框架自身的纯内核逻辑（能力体系、发送降级、消息归一、事件归一、中间件）在 `test/` 目录下用 `node:test` 维护单元测试，不依赖任何网络：

```bash
npm test           # 运行全部内核单测
npm run typecheck  # 仅对 src 与 test 做类型检查（外置 plugin 不参与框架类型检查）
```

新增内核逻辑时应同步补充对应用例；插件作者则使用上面的 MockAdapter 为自己的插件写测试。
