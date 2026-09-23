---
title: Discord
description: Discord 官方机器人接入与 API
---

# Discord

> Discord 官方机器人。Gateway WebSocket 连接 + REST 发送，支持文本 / 图片 / 视频 / 语音 / 文件，私聊自动解析 DM 频道。需海外环境并开启 Message Content Intent。

---



适配器类型：`"discord"`　源码：`src/adapter/discord/`（types.ts / converter.ts / client.ts）
协议：Discord Bot API v10（WebSocket 网关 + REST 发送）。

---

## 安装

```bash
van adapter install discord
```

---
## 1. 配置文件

```jsonc
{
  "botId": "DC-Bot",               // 框架内唯一标识（任意起名）
  "type": "discord",               // 适配器类型固定为 discord
  "token": "你的DiscordBotToken",   // Discord 开发者平台 Bot Token（必填）
  "intents": 37377,                // 可选，默认 GUILDS|GUILD_MESSAGES|DIRECT_MESSAGES|MESSAGE_CONTENT
  "reconnectDelay": 5000           // 可选，断线重连毫秒，默认 5000
}
```

> **凭据**：访问 [Discord Developer Portal](https://discord.com/developers/applications) → New Application → Bot → 复制 Token；把机器人加进服务器/允许私聊。
> **必须开启**：Bot 页面 → Privileged Gateway Intents → **Message Content Intent**（否则读不到消息正文）。
> **⚠️ 网络**：Discord 国内不可直连，需海外服务器/代理环境运行。

默认 intents = `37377`（= GUILDS 1 + GUILD_MESSAGES 512 + DIRECT_MESSAGES 4096 + MESSAGE_CONTENT 32768）。
> ⚠️ 若自定义 `intents`，**必须包含 `GUILD_MESSAGES(512)`**（收频道消息）和 `DIRECT_MESSAGES(4096)`（收私聊），否则机器人连上但收不到消息。如需更多按位或后填 `intents`（见第 4 节）。

---

## 2. 能接收的事件

| Discord 事件 | 框架事件 | 说明 |
|---|---|---|
| `MESSAGE_CREATE`（有 guild_id） | `group_message` | 频道消息，`groupId`=channel_id |
| `MESSAGE_CREATE`（无 guild_id） | `private_message` | 私聊消息 |

事件对象（`BotEvent`）字段：
```ts
{
  botId: "DC-Bot",
  selfId: "机器人id",
  userId: "author.id",
  groupId: "channel_id",         // 频道消息；私聊为空
  message: [{ type: "text", data: { text: "..." } }],
  postType: "group_message" | "private_message",
  raw: { ...原始消息, sender, message_id, time, platform: "discord" }
}
```
机器人自己的消息已自动忽略（防死循环）。

---

## 3. 发送 API（插件内统一 `bot.callApi`）

### 3.1 发送频道消息

```ts
await bot.callApi("send_group_msg", {
  group_id: "频道id",             // Discord channel_id（事件里的 groupId）
  message: "大家好"
})
```

### 3.2 发送私聊消息

```ts
await bot.callApi("send_private_msg", {
  user_id: "用户id",             // 事件里的 userId（Discord 用户 id）
  message: "你好"
})
```
适配器会自动解析该用户的 DM 频道：优先用收到私聊事件时的缓存，否则调用 `POST /users/@me/channels` 创建/获取 DM 频道后再发送。

### 3.3 自动判断 / 通用

```ts
await bot.callApi("send_msg", {
  group_id: "频道id",            // 优先：频道消息回频道
  user_id: "用户id",             // 否则：自动解析 DM 频道
  message: "..."
})
```

### 3.4 消息段

- 文本 → `text` 段
- 图片 → `image` 段（`data.url` 为公网 url，会以 embed 方式附带；Discord 仅支持 url 发送）
- markdown 段 → 以纯文本发送（Discord 消息本身支持部分 markdown 语法渲染，无需特殊处理）

### 3.5 返回值

```ts
const ret = await bot.callApi("send_group_msg", {...})
// ret = { id: "消息id", channel_id, content, ... }
```

---

## 4. intents（默认已含常用）

| Intent | 值 | 说明 |
|---|---|---|
| GUILDS | 1 | 频道/服务器基础 |
| GUILD_MEMBERS | 2 | 成员变动（特权） |
| GUILD_MESSAGES | 512 | 频道消息 |
| GUILD_MESSAGE_REACTIONS | 1024 | 消息表态 |
| DIRECT_MESSAGES | 4096 | 私聊消息 |
| MESSAGE_CONTENT | 32768 | 读取消息正文（特权，必开） |

特权 intents（GUILD_MEMBERS / MESSAGE_CONTENT / PRESENCE）需在开发者后台手动开启，否则订阅会报错。

---

## 5. 常见问题

- **收不到消息**：确认已开启 Message Content Intent、机器人已加入服务器、给了读取权限；私聊需用户先发消息。
- **401 Unauthorized**：token 错误或没带对。
- **连不上网关**：国内网络问题，需代理/海外环境。
- **`MESSAGE_CONTENT` 报错**：后台没开特权 intent，或订阅了无权限的 intent。

---

## 6. 相关文档

- Gateway：`https://discord.com/developers/docs/events/gateway`
- 发送消息：`https://discord.com/developers/docs/resources/message`
- Intents：`https://discord.com/developers/docs/events/gateway#intents`
