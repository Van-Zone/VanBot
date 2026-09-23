---
title: Milky
description: Milky 本地协议接入与 API
---

# Milky

> Milky（QQ 的一个本地协议实现）适配器。支持正向 WS、反向 WS、HTTP 三种连接，发送走本地 HTTP API（需 Milky 开启 EnabledHttp）。

---



适配器类型：`"milky"`　源码：`src/adapter/milky/`
协议：Milky（QQ 的一个本地协议实现，通常跑在 127.0.0.1 某个端口）。支持三种连接方式：正向 WS、反向 WS、HTTP(webhook)；发送统一走 HTTP `POST /api/{action}`。

---

## 安装

```bash
van adapter install milky
```

---
## 1. 配置文件

### 方式一：正向 WS（本框架连 Milky 事件 WS）——默认

```jsonc
{
  "botId": "Milky-Bot",
  "type": "milky",
  "mode": "ws",                     // 正向 WS（默认）
  "host": "127.0.0.1",              // Milky 服务地址（默认 127.0.0.1）
  "port": 3000,                     // Milky 本地端口（默认 3000）
  "path": "/event",                 // 事件 WS 路径（默认 /event）
  "token": ""                       // 可选 Bearer Token（会拼到 WS query：?token=）
}
```

### 方式二：反向 WS（本框架起 WS 服务，等 Milky 连入）

```jsonc
{
  "botId": "Milky-Bot",
  "type": "milky",
  "mode": "ws_reverse",             // 反向 WS
  "port": 3000,                     // 本框架监听端口
  "path": "/event",                 // 监听路径（Milky 配置 ws://<本机IP>:3000/event）
  "token": ""                       // 可选鉴权 token（校验 query ?token=）
}
```

### 方式三：HTTP(webhook)（本框架起 HTTP 服务接收 Milky 事件上报）

```jsonc
{
  "botId": "Milky-Bot",
  "type": "milky",
  "mode": "http",                   // HTTP(webhook)
  "port": 3001,                     // 本框架 HTTP 监听端口
  "path": "/event",                 // 监听路径（Milky 的 HTTP 上报地址填 http://<本机IP>:3001/event）
  "token": ""                       // 可选鉴权 token
}
```

> 三种模式下发送都走 Milky 的 HTTP API（`POST http://127.0.0.1:{port}/api/{action}`，需 Milky 开启 EnabledHttp）。

---

## 2. 能接收的事件

Milky 推送的 QQ 消息事件转统一事件：
- 群消息 → `group_message`
- 私聊 → `private_message`
- 通知类 → `notice`

`userId`/`groupId` 为 QQ 号。

---

## 3. 发送 API（插件内统一 `bot.callApi`）

适配器会把 OneBot 风格的 action 转发为 Milky 的 HTTP 接口：

```ts
// 发群消息
await bot.callApi("send_group_msg", { group_id: 123456789, message: "你好" })
// → POST /api/send_group { params: { gid: 123456789, message } }

// 发私聊
await bot.callApi("send_private_msg", { user_id: 123456, message: "你好" })
// → POST /api/send_private { params: { uid: 123456, message } }

// 自动判断
await bot.callApi("send_msg", { group_id: 123456789, message: "你好" })
// → send_group 或 send_private
```

`message` 支持字符串或消息段数组（text/image 等）。

### 返回值

Milky HTTP 返回的 JSON（含 `echo` 回显）。

---

## 4. 相关文档

- Milky 项目（本地协议）：由你的 Milky 部署提供接口定义（`/api/send_group`、`/api/send_private` 等）。
