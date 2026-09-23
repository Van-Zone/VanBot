---
title: Satori
description: Satori 跨平台开放协议接入与 API
---

# Satori

> Satori 跨平台聊天机器人开放协议。支持正向 WS、反向 WS、HTTP 三种连接，发送统一走 HTTP `POST {apiBase}/v1/{action}`，action 自动映射到 Satori 协议。

---



适配器类型：`"satori"`　源码：`src/adapter/satori/`
协议：Satori 协议（跨平台聊天机器人开放协议）。支持三种连接方式：正向 WS、反向 WS、HTTP(webhook)；发送统一走 HTTP `POST {apiBase}/v1/{action}`，可对接多个 Satori 兼容平台。

---

## 安装

```bash
van adapter install satori
```

---
## 1. 配置文件

### 方式一：正向 WS（本框架连 Satori 服务端）——默认

```jsonc
{
  "botId": "Satori-Bot",
  "type": "satori",
  "mode": "ws",                      // 正向 WS（默认）
  "host": "127.0.0.1",               // Satori 服务地址（默认 127.0.0.1）
  "port": 5140,                      // Satori 端口（默认 5140）
  "path": "/v1/events",              // 事件 WS 路径（默认 /v1/events）
  "token": "",                       // 可选 Bearer Token
  "platform": ""                     // 可选平台标识
}
```

### 方式二：反向 WS（本框架起 WS 服务，等 Satori 服务端连入）

```jsonc
{
  "botId": "Satori-Bot",
  "type": "satori",
  "mode": "ws_reverse",              // 反向 WS
  "port": 5140,                      // 本框架监听端口
  "path": "/v1/events",              // 监听路径（Satori 客户端配置 ws://<本机IP>:5140/v1/events）
  "token": "",                       // 可选鉴权 token（校验 query ?token=）
  "platform": ""                     // 可选平台标识（READY 回给服务端的 logins.platform）
}
```

### 方式三：HTTP(webhook)（本框架起 HTTP 服务接收 Satori 事件上报）

```jsonc
{
  "botId": "Satori-Bot",
  "type": "satori",
  "mode": "http",                    // HTTP(webhook)
  "port": 5141,                      // 本框架 HTTP 监听端口
  "path": "/v1/events",              // 监听路径（Satori 的 webhook 上报地址填 http://<本机IP>:5141/v1/events）
  "token": "",                       // 可选鉴权 token
  "platform": ""                     // 可选平台标识
}
```

> 三种模式下发送都走 Satori HTTP API（`POST http://{host}:{port}/v1/{action}`）。

---

## 2. 能接收的事件

Satori 推送的事件转统一事件：群消息 → `group_message`、私聊 → `private_message`、通知 → `notice`。

---

## 3. 发送 API（插件内统一 `bot.callApi`）

适配器自动把 OneBot 风格的 action 映射到 Satori API：

| OneBot action | Satori API |
|---|---|
| `send_msg` / `send_group_msg` / `send_private_msg` | `message.create` |
| `delete_msg` | `message.delete` |
| `get_msg` | `message.get` |
| `get_group_list` | `guild.list` |
| `get_group_member_list` | `guild.member.list` |
| `get_group_member_info` | `guild.member.get` |
| `set_group_kick` | `guild.member.kick` |
| `set_group_ban` / `set_group_whole_ban` | `guild.member.mute` |

```ts
await bot.callApi("send_group_msg", { group_id: "群id", message: "你好" })
// → POST {apiBase}/message.create { channel_id: "群id", content: "你好" }

await bot.callApi("send_private_msg", { user_id: "用户id", message: "你好" })
```

`message` 支持字符串或消息段数组，自动转换为 Satori content 格式。

### 返回值

Satori API 返回的 JSON（非 2xx 会抛错）。

---

## 4. 相关文档

- Satori 协议：`https://satori.js.org/`
