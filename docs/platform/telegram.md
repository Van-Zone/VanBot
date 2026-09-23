---
title: Telegram
description: Telegram 官方机器人接入与 API
---

# Telegram

> Telegram 官方 Bot API。`getUpdates` 长轮询接收 + REST 发送，支持文本 / 图片 / 视频 / 语音 / 文件。无需公网回调，但需要能访问 api.telegram.org 的环境。

---



适配器类型：`"telegram"`　源码：`src/adapter/telegram/`（types.ts / converter.ts / client.ts）
协议：Telegram 官方 Bot API（getUpdates 长轮询接收 + REST 发送）。

---

## 安装

```bash
van adapter install telegram
```

---
## 1. 配置文件

```jsonc
{
  "botId": "TG-Bot",               // 框架内唯一标识（任意起名）
  "type": "telegram",              // 适配器类型固定为 telegram
  "token": "123456789:AAExXXX",    // BotFather 申请的机器人令牌（必填）
  "pollTimeout": 50,               // 可选，长轮询超时秒数，默认 50（Telegram 上限 50）
  "reconnectDelay": 3000           // 可选，轮询出错重试间隔毫秒，默认 3000
}
```

> **网络要求**：Telegram API 在国内不可直连。机器人需运行在能访问 `api.telegram.org` 的环境（海外服务器 / 机场 / 系统级代理）。
> **无需公网回调**：用 getUpdates 长轮询，机器人**主动**连出，不要求公网 IP 或 HTTPS 回调 URL。

---

## 2. 能接收的事件（全部已派发）

| Telegram 更新类型 | 框架事件 | 说明 |
|---|---|---|
| `message`（私聊） | `private_message` | 用户私聊机器人 |
| `message`（群/超级群/频道） | `group_message` | 群消息，`groupId` = 负数 chat.id |
| `edited_message` | `private_message` / `group_message` | 编辑过的消息（按原 chat 类型派发） |
| `channel_post` | `group_message` | 频道/频道内发布 |
| `callback_query` | `notice` | 内联键盘按钮回调（raw.data 为按钮 payload） |
| `my_chat_member` 等其余 | `notice` | 机器人自身成员状态变化等 |

事件对象（`BotEvent`）字段：
```ts
{
  botId: "TG-Bot",
  selfId: "987654321",            // getMe 拿到的机器人 ID
  userId: "123456789",            // 发送者 Telegram ID
  groupId: "-1001234567890",      // 群聊为负数 chat.id，私聊为空
  message: [{ type: "text", data: { text: "/start" } }],
  postType: "group_message" | "private_message" | "notice",
  raw: { ...原始消息, sender: {user_id, nickname, ...}, message_id, time, platform: "telegram" }
}
```

**消息段**：
- 文本 → `text`
- 图片 → `image`（`data.file_id` 取最大尺寸；`data.file` 同）
- 语音 → `record`（file_id）
- 视频 → `video`（file_id）
- 文件 → `file`（file_id + name）
- 贴纸 → `text`（`[贴纸emoji]`）
- 图片 caption 会作为额外 text 段

---

## 3. 发送 API（插件内统一 `bot.callApi`）

> 2025+ 版本插件已去掉 `onebotApi`，全部走 `bot.callApi(action, params)`。

### 3.1 发送私聊 / 群聊（同一个接口）

Telegram 不区分群/私聊的发送端点，按 `chat_id` 路由即可，三种 action 等价：

```ts
// 私聊
await bot.callApi("send_private_msg", {
  user_id: 123456789,               // 用户 Telegram ID
  message: "你好呀"
})

// 群聊
await bot.callApi("send_group_msg", {
  group_id: -1001234567890,         // 群 chat.id（负数）
  message: "大家好"
})

// 自动/通用（也可显式传 chat_id）
await bot.callApi("send_msg", {
  chat_id: 123456789,
  message: "通用发送"
})
```

> ⚠️ Telegram 机器人**不能主动私聊**用户：必须用户先给机器人发过消息（如 `/start`），或用户主动加了机器人，才能向其 `sendMessage`。

### 3.2 富媒体（消息段）

`message` 支持字符串或段数组：

```ts
// 文本
{ type: "text", data: { text: "文本" } }

// 图片：file_id（推荐）/ 公网 url / base64:// 均可
{ type: "image", data: { file_id: "AgACAgUAAxkD..." } }
{ type: "image", data: { url: "https://example.com/a.jpg" } }
{ type: "image", data: { file: "base64://iVBOR..." } }

// 语音 / 视频 / 文件
{ type: "record", data: { file_id: "AwAC..." } }
{ type: "video",  data: { file_id: "BAAC..." } }
{ type: "file",   data: { file_id: "BQAC...", name: "a.pdf" } }
```

- `file_id` 直接用（机器人收到的媒体自动带 file_id，可直接转发）
- 公网 url：Telegram 服务端会自动下载
- `base64://`：本地转为 multipart 上传
- 多段消息会**按顺序依次发送**，媒体前的文本自动作为该媒体的 caption

### 3.3 其他 API

```ts
await bot.callApi("get_me")   // 返回机器人自身信息 { ok, result: { id, username, ... } }
```

### 3.4 返回值

```ts
const ret = await bot.callApi("send_private_msg", {...})
// ret = { ok: true, result: { message_id: 42, chat: {...}, ... } }
```

---

## 4. 常见问题

- **`token` 从哪来**：Telegram 里找 @BotFather → `/newbot` 创建机器人 → 拿到 token。
- **机器人收不到群消息**：把机器人拉进群后，群内成员需**先 @ 机器人或直接发消息**触发；超级群还要把机器人设为管理员才能看所有消息（机器人本身可收 @ 消息）。
- **409 Conflict 报错**：有另一个进程在用同一个 token 轮询 getUpdates，停掉旧的即可（Telegram 同一 token 只允许一个 getUpdates 长轮询）。
- **401 Unauthorized**：token 填错了。
- **国内连不上**：Telegram 被墙，需海外环境/代理运行，这不是代码问题。
- **`#设置主人号` 的 ID**：直接用事件里的 `userId`（Telegram 数字 ID），可正常存主人号。

---

## 5. 相关文档

- Telegram Bot API 官方文档：`https://core.telegram.org/bots/api`
- getUpdates 长轮询：`https://core.telegram.org/bots/api#getupdates`
- sendMessage / sendPhoto：`https://core.telegram.org/bots/api#sendmessage` / `#sendphoto`
