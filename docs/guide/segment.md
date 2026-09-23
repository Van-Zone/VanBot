---
title: 消息段
description: MessageSegment 统一消息段与发送降级
---

# 消息段（MessageSegment）

统一的内部消息段：`{ type, data, capabilities?, fallback? }`。所有适配器发送时都接受「字符串 / 单段对象 / 段数组」。

## 消息段类型

| 类型 | 说明 | 常见 data 字段 |
| --- | --- | --- |
| `text` | 文本 | `text` |
| `at` | @提及 | `qq` |
| `image` | 图片 | `file`（本地路径 / URL / base64://） |
| `video` / `record` | 视频 / 语音 | `file` |
| `file` | 文件 | 平台相关字段 |
| `reply` | 引用回复 | `id` |
| `face` | 表情 | `id` |
| `forward` / `dice` / `rps` / `poke` | 转发 / 骰子 / 猜拳 / 戳一戳 | 平台相关 |
| `json` / `music` | 卡片 / 音乐分享 | `data` / 平台相关 |
| `markdown` | 富文本 markdown | 平台相关（QQ 官方 msg_type 2） |
| `button` | 按钮（inline keyboard） | 平台相关（QQ 官方 keyboard） |

## 构建消息段

```ts
import { MessageSegment } from "../src/core/models/message.js"

MessageSegment.text("你好")
MessageSegment.at("123456")
MessageSegment.image("https://example.com/a.png")   // 或 base64://xxxx
MessageSegment.reply("msgId")
MessageSegment.markdown({ content: "# 标题", keyboard: { /* ... */ } })
MessageSegment.button({ rows: [ /* ... */ ] })
```

## 能力声明与降级（发送侧）

消息段可声明它依赖的会话能力，以及能力不足时的降级段：

```ts
// 能力声明 + 降级：本会话不支持图片时，自动替换为文本
MessageSegment.image(url)
  .needs("image")                                    // 依赖能力
  .fallbackTo(MessageSegment.text("[图片不可用]"))     // 降级段

// 多能力：markdown + button，缺任一就降级
MessageSegment.markdown(md).needs("markdown", "button")
  .fallbackTo(MessageSegment.text("纯文本内容"))
```

::: warning
**fallback 只在内核发送侧执行**：插件 `ctx.reply` → 内核 `applySendFallback` 对比 `event.capabilities` → 能力不足替换为 fallback（无 fallback 则丢弃）→ 交给适配器翻译。接收侧不使用 fallback。适配器绝不做降级。
:::
