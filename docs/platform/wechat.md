---
title: 微信公众号 / 服务号
description: 微信公众号 / 服务号接入与 API
---

# 微信公众号 / 服务号

> 微信公众号 / 服务号。HTTP 回调接收 + 客服消息 / 被动回复发送；开启 `passiveMode` 后未认证公众号也能在 5 秒内被动回复。

---



适配器类型：`"wechat"`　源码：`src/adapter/wechat/`
协议：微信公众平台（公众号/服务号），HTTP 回调接收 + 客服消息/被动回复发送。

---

## 安装

```bash
van adapter install wechat
```

---
## 1. 配置文件

```jsonc
{
  "botId": "WeChat-Official",
  "type": "wechat",
  "appId": "wx你的AppID",
  "appSecret": "你的AppSecret",
  "token": "你的服务器配置Token",   // 公众平台后台填的 Token
  "port": 8090,                   // 回调监听端口
  "path": "/wechat/callback",     // 回调路径
  "passiveMode": true             // 推荐 true：被动回复模式（未认证公众号也能回复）
}
```

> **网络**：微信要求回调地址公网可达（http 走 80 端口 / https 走 443 端口）。需在服务器/内网穿透配置 URL 转发到本框架端口，并在公众平台后台"服务器配置"填入 `http://你的公网地址/wechat/callback`。
> **认证**：客服消息接口（`send_private_msg` 主动发送）需要**微信认证**，未认证公众号会报 `errcode:48001`。开启 `passiveMode:true` 后，用户发消息 5 秒内的回复走被动回复（XML 直接返回），无需认证、无 48 小时限制。

---

## 2. 能接收的事件

| 微信事件 | 框架事件 | 说明 |
|---|---|---|
| 文本/图片/语音消息 | `private_message` | `userId`=用户 openid |
| 关注/取关等 | `notice` | raw.notice_type 标识 |

---

## 3. 发送 API（插件内统一 `bot.callApi`）

### 3.1 被动回复（passiveMode，推荐）

消息进来 5 秒内插件调 `send_msg`/`send_private_msg`，会以 XML 被动回复直接返回给用户（无需认证）：

```ts
await bot.callApi("send_private_msg", {
  user_id: "用户openid",
  message: "回复内容"
})
```

### 3.2 客服消息（需认证公众号）

用户 48 小时内有互动时可主动推送：

```ts
await bot.callApi("send_msg", {
  user_id: "用户openid",
  message: "主动推送"
})
```

### 3.3 显式被动回复

```ts
await bot.callApi("passive_reply", {
  user_id: "用户openid",
  content: "要返回的文本"
})
```

图片/语音会自动上传素材后发送；多段消息按顺序发送。

### 返回值

```ts
{ errcode: 0, errmsg: "ok" }
```

---

## 4. 常见问题

- **收不到消息**：回调地址公网不可达、Token 不一致、未在公众平台提交服务器配置。
- **`Invalid signature`**：URL 端口配错（http 只能 80 / https 只能 443）。
- **`errcode:48001`**：未认证公众号调用客服接口 → 开 `passiveMode:true` 走被动回复。
- **`40164`**：服务器 IP 不在白名单，但 passiveMode 不受影响。

---

## 5. 相关文档

- 微信公众平台开发文档：`https://developers.weixin.qq.com/doc/offiaccount/`
