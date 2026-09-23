---
title: QQ（OneBot11 / NapCat）
description: OneBot11 标准协议接入与 API
---

# QQ（OneBot11 / NapCat）

> 对接 NapCat / Lagrange / go-cqhttp 等 OneBot11 实现。支持正向 WS、反向 WS、HTTP 三种连接方式，`callApi` 通用转发——OneBot11 全部接口（含群管理）都能用。

---



适配器类型：`"onebot11"`　源码：`src/adapter/onebot11/`
协议：OneBot 11 标准，支持三种连接方式：正向 WS、反向 WS、HTTP(webhook)，对接 NapCat（或 go-cqhttp 等 OneBot11 实现）。

---

## 安装

```bash
van adapter install onebot11
```

---
## 1. 配置文件

### 方式一：反向 WS（NapCat 主动连本框架）——默认推荐

```jsonc
{
  "botId": "Van-None",
  "type": "onebot11",
  "mode": "ws_reverse",          // 反向 WS：本框架起 WS 服务等 NapCat 连入
  "port": 8080,                  // 监听端口
  "path": "/onebot/v1/ws",       // 监听路径（NapCat 填 "ws://<本机IP>:8080/onebot/v1/ws"）
  "token": ""                    // 可选鉴权 token（NapCat 配置相同的 access_token）
}
```

### 方式二：正向 WS（本框架主动连 NapCat）

```jsonc
{
  "botId": "Van-None",
  "type": "onebot11",
  "mode": "ws_client",           // 正向 WS：本框架作为客户端连 NapCat
  "url": "ws://127.0.0.1:3001",  // NapCat 的正向 WS 地址（必填）
  "token": ""                    // 可选鉴权 token
}
```

### 方式三：HTTP(webhook)（NapCat HTTP 上报 + HTTP API）

```jsonc
{
  "botId": "Van-None",
  "type": "onebot11",
  "mode": "http",                // HTTP：本框架起 HTTP 服务接收 OneBot 事件上报
  "port": 8080,                  // 本框架 HTTP 监听端口（NapCat 的"HTTP 上报地址"填 http://<本机IP>:8080/<path>）
  "path": "/event",              // 监听路径（默认 "/"，NapCat 填对应地址）
  "apiUrl": "http://127.0.0.1:3000", // NapCat 的 HTTP API 地址（发送走 POST {apiUrl}/api/{action}，默认 http://127.0.0.1:3000）
  "token": ""                    // 可选鉴权 token
}
```

> 模式与 NapCat 端对应：
> - NapCat 配置"正向 WS" → 本框架用 `ws_client`
> - NapCat 配置"反向 WS" → 本框架用 `ws_reverse`
> - NapCat 配置"HTTP 上报" → 本框架用 `http`（事件用 HTTP POST 上报到本框架，发送走 `apiUrl` 的 HTTP API）

---

## 2. 能接收的事件

NapCat 推送的全部事件都会转成框架统一事件：
- `message.group` → `group_message`（`groupId`=群号、`userId`=QQ号）
- `message.private` → `private_message`
- `notice.*` → `notice`
- `request.*` → `request`

事件里 `userId`/`groupId` 都是 QQ 号（数字），可直接用于发送/管理操作。

---

## 3. 发送 API（插件内统一 `bot.callApi`）

OneBot11 适配器的 `callApi` 是**通用转发**：任意 OneBot11 action + params 原样发往 NapCat（WS 模式经 WS echo 配对；HTTP 模式经 `POST {apiUrl}/api/{action}`），NapCat 支持的全部接口都能用（全量）。

```ts
// 发送群消息
await bot.callApi("send_group_msg", { group_id: 123456789, message: "你好" })

// 发送私聊
await bot.callApi("send_private_msg", { user_id: 123456, message: "你好" })

// 自动判断
await bot.callApi("send_msg", { group_id: 123456789, user_id: 123456, message: "你好" })

// 管理操作（NapCat 原生支持）
await bot.callApi("set_group_ban", { group_id: 123456789, user_id: 123456, duration: 600 })
await bot.callApi("set_group_kick", { group_id: 123456789, user_id: 123456, reject_add_request: false })
await bot.callApi("delete_msg", { message_id: 12345 })
await bot.callApi("send_like", { user_id: 123456, times: 3 })
await bot.callApi("get_msg", { message_id: 12345 })
```

### 消息段 / CQ 码

`message` 支持字符串（含 CQ 码）或消息段数组：
```ts
// CQ 码字符串（NapCat 原生支持）
"[CQ:image,file=xxx] 看图"
"[CQ:at,qq=123456] 你好"

// 消息段数组
[
  { type: "at", data: { qq: "123456" } },
  { type: "text", data: { text: " 你好" } },
  { type: "image", data: { file: "https://xxx/a.jpg" } }
]
```
**markdown**：发送 `[CQ:markdown,data={"content":"..."}]` 字符串，NapCat 会渲染为 markdown 消息。

### 返回值

NapCat 返回的 `data` 字段（如 `{ message_id: 123 }`）。

---

## 4. 相关文档

- OneBot 11 规范：`https://github.com/botuniverse/onebot-11`
- NapCat：`https://napneko.github.io/`
