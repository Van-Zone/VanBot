---
title: B站直播间
description: B站直播间弹幕接入与 API
---

# B站直播间

> B 站直播间。弹幕 WebSocket（WSS）接收 + 弹幕 HTTP 发送，只收发弹幕文本（无富媒体），直播间按群聊处理。

---



适配器类型：`"bilibili_live"`（兼容旧值 `"bilibili"`）　源码：`src/adapter/bilibili_live/`
协议：B 站直播弹幕 WebSocket（接收）+ 弹幕发送 HTTP（发送）。

> **改名说明**：原适配器类型 `"bilibili"` 已更名为 `"bilibili_live"`。配置里可直接写 `"bilibili_live"`；若仍写旧值 `"bilibili"` 框架也会兼容识别。

---

## 安装

```bash
van adapter install bilibili_live
```

---
## 1. 配置文件

```jsonc
{
  "botId": "Bili-Live",
  "type": "bilibili_live",
  "roomId": 0,                   // 直播间号（必填，短号/长号均可）
  "cookie": "SESSDATA=...; bili_jct=...; buvid3=...; DedeUserID=...;",
  "csrf": "",                    // 可选，默认从 cookie 的 bili_jct 取
  "uid": 0,                      // 可选，机器人账号 uid
  "color": 16777215,             // 弹幕颜色
  "mode": 1,                     // 弹幕模式
  "fontsize": 25,
  "ignoreSelf": true             // 忽略自己发的弹幕，防死循环
}
```

---

## 2. 能接收的事件

| B 站事件 | 框架事件 | 说明 |
|---|---|---|
| 弹幕（DANMU_MSG） | `group_message` | `groupId`=房间号、`userId`=用户 uid |
| 醒目留言（SUPER_CHAT_MESSAGE） | `group_message` | 同上 |

直播间按"群聊"处理，每个直播间独立使用一套数据。

---

## 3. 发送 API（插件内统一 `bot.callApi`）

发送弹幕需要机器人账号 Cookie（机器人本人需有该直播间发送权限）：

```ts
// 发弹幕（直播间 = 群聊）
await bot.callApi("send_group_msg", {
  group_id: 0,                   // 房间号（不填也会发到配置的房间）
  message: "你好"
})

// send_msg / send_private_msg 同 send_group_msg（都发弹幕到配置的房间）
await bot.callApi("send_msg", { message: "弹幕内容" })
```

`message` 支持字符串或消息段数组（文本）。图片/富媒体不支持（弹幕只有文本）。

### 返回值

```ts
{ code: 0, message: "0", data: { ... } }
```

---

## 4. 常见问题

- **发不出去**：未配置 cookie、或账号无该房间发送权限、或发送频率过高被风控。
- **用户名打码**：未填 cookie 时接收的弹幕用户名会被打码。
- **`ignoreSelf`**：默认 true，忽略机器人自己发的弹幕，防止"弹幕→回复→弹幕"死循环。

---

## 5. 相关文档

- B 站直播开放平台：`https://open-live.bilibili.com/`
