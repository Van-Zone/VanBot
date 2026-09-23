---
title: KOOK
description: KOOK（开黑啦）官方机器人接入与 API
---

# KOOK

> KOOK（开黑啦）开发者平台官方机器人。WebSocket 网关 + HTTP 发送，支持文本 / 图片 / 视频 / 文件 / kmarkdown。国内可直连。

---



适配器类型：`"kook"`　源码：`src/adapter/kook/`（types.ts / converter.ts / client.ts）
协议：KOOK 开发者平台官方机器人（WebSocket 网关 + HTTP 发送）。

---

## 安装

```bash
van adapter install kook
```

---
## 1. 配置文件

```jsonc
{
  "botId": "KOOK-Bot",             // 框架内唯一标识（任意起名）
  "type": "kook",                  // 适配器类型固定为 kook
  "token": "你的KOOK机器人Token",    // KOOK 开发者平台机器人 Token（必填）
  "reconnectDelay": 5000           // 可选，断线重连毫秒，默认 5000
}
```

> **凭据**：访问 [KOOK 开发者中心](https://developer.kookapp.cn/) → 新建应用 → 机器人 → 连接模式选 **WebSocket** → 复制 Token。
> **网络**：KOOK 国内可直连，无需公网回调。

---

## 2. 能接收的事件（全部已派发）

| KOOK 事件 | 框架事件 | 说明 |
|---|---|---|
| 消息事件（d.type=1 文字 / 9 KMarkdown），channel_type=`GROUP` | `group_message` | 频道消息，`groupId`=频道id |
| 消息事件，channel_type=`PERSON` | `private_message` | 私聊机器人 |
| 消息事件（d.type=2 图片 / 3 视频 / 4 文件） | `group_message`/`private_message` | 富媒体消息（图片→image 段等） |
| 系统事件（d.type=255） | `notice` | 进服务器/被移出/角色变动等（raw.notice_type=extra.type） |

事件对象（`BotEvent`）字段：
```ts
{
  botId: "KOOK-Bot",
  selfId: "机器人用户id",
  userId: "author_id",           // 发送者 KOOK 用户 id
  groupId: "频道id",             // 频道消息；私聊为空
  message: [{ type: "text", data: { text: "..." } }],
  postType: "group_message" | "private_message" | "notice",
  raw: { ...原始事件, sender, message_id, time, platform: "kook" }
}
```

---

## 3. 发送 API（插件内统一 `bot.callApi`）

### 3.1 发送频道消息

```ts
await bot.callApi("send_group_msg", {
  group_id: "频道id",             // 事件里的 groupId
  message: "大家好"                // 字符串或消息段数组
})
```

### 3.2 发送私聊消息

```ts
await bot.callApi("send_private_msg", {
  user_id: "用户id",              // 事件里的 userId
  message: "你好"
})
```

### 3.3 自动判断

```ts
await bot.callApi("send_msg", {
  group_id: "...",               // 有则发频道
  user_id: "...",                // 否则发私聊
  message: "..."
})
```

### 3.4 消息段

- 文本 → `text` 段（以 KMarkdown type=9 发送，兼容纯文本与 markdown）
- markdown → `{ type: "markdown", data: { content: "..." } }`（或 `[CQ:markdown,data=...]` 字符串），以 KMarkdown 发送
- 图片 → `image` 段（`data.url` 需为公网 url 或 base64://；KOOK 要求图片由机器人上传，非 KOOK 资源可能失败）

### 3.5 返回值

```ts
const ret = await bot.callApi("send_group_msg", {...})
// ret = { code: 0, data: { msg_id: "xxxx", ... } }
```

---

## 4. 常见问题

- **收不到消息**：确认机器人已加入服务器、连接模式为 WebSocket，且机器人有对应频道权限。
- **发不出图片**：KOOK 规定图片必须是机器人通过 `/api/v3/asset/create` 上传的资源，普通外链会被拒绝（提示"找不到资源"）。
- **消息配额**：单日 10,000 条/开发者账号。
- **@人**：KOOK 用 `(met)用户id(met)` 语法，消息段 `at` 会自动转换。

---

## 5. 相关文档

- WebSocket 协议：`https://developer.kookapp.cn/doc/websocket`
- 发送消息：`https://developer.kookapp.cn/doc/http/message`
- 事件结构：`https://developer.kookapp.cn/doc/event/event-introduction`
