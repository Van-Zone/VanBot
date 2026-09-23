---
title: 能力体系
description: 会话粒度能力 Capabilities 与发送降级
---

# 会话能力体系（Capabilities）

核心原则：能力是**会话粒度**（一个群 / 一个私聊），不是平台全局写死。例如 QQ 群有 `canMuteMember`，QQ 私聊没有。

## 常用能力标识（CAP 常量）

| 能力 | 含义 | 能力 | 含义 |
| --- | --- | --- | --- |
| `text` | 文本 | `button` | 按钮 / inline keyboard |
| `image` | 图片 | `canMuteMember` | 群：可禁言成员 |
| `video` | 视频 | `canKickMember` | 群：可移出成员 |
| `audio` | 语音 | `isGroupOwner` | 当前会话机器人为群主 |
| `file` | 文件 | `isGroupAdmin` | 当前会话机器人为管理员 |
| `markdown` | markdown 富文本 | `at / reply / face` | @ / 引用 / 表情 |

## 能力从哪来

每个适配器通过 `BaseAdapter.computeCapabilities(event)` 上报当前会话能力集；未覆盖的适配器默认全能力（`FULL_CAPABILITIES`），与旧行为一致。业务代码判断：

```ts
hasCapabilities(caps, need)      // 判断会话能力是否满足
ctx.hasCapabilities(caps, need)  // 插件 ctx 便捷方法
event.getCapabilities?.().xxx    // 从事件取能力
```

## 发送降级示例

```ts
// 发送带能力声明 + 降级的消息
await ctx.reply(event, [
  MessageSegment.text("这段一定发").needs("text"),
  MessageSegment.image(url).needs("image")
    .fallbackTo(MessageSegment.text("[图片在本会话不可用]")),
])
```

QQ 官方机器人会发原生 markdown + 按钮；B站 / Telegram / 个人微信 等不支持时自动发送 fallback 纯文本；无 fallback 的段直接丢弃，绝不崩溃。

::: tip
完整能力矩阵见 [能力总览](/platform/abilities)。
:::
