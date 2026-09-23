---
title: QQ 个人号（icqq）
description: QQ 个人号 icqq 协议接入与 API
---

# QQ 个人号（icqq）

> QQ 个人号（基于 icqq 库，QQ 安卓协议）。用真实 QQ 号直接登录（密码 / 扫码），群管理能力较全：禁言 / 移出 / 设管理 / 改群名片 / 发文件 / 点赞等。

---



适配器类型：`"icqq"`　源码：`src/adapter/icqq/`
协议：基于 [icqq](https://github.com/icqqjs/icqq)（oicq 分支，QQ 安卓协议），**用 QQ 号直接登录**（扫码/密码），与 onebot11、QQ 开放平台无关。

> ⚠️ 与其它适配器的核心区别：icqq 是**登录式**机器人——用真实 QQ 号登录，需要处理扫码/设备锁/滑块验证；登录成功前无法收发。QQ 协议（安卓端）属于非官方协议，账号有被限制风险，请自行评估使用。

---

## 安装

```bash
van adapter install icqq
```

---
## 1. 配置文件

```jsonc
{
  "botId": "Icqq-Bot",          // 框架内唯一标识
  "type": "icqq",               // 适配器类型固定为 icqq
  "account": 123456789,         // QQ 号（必填）
  "password": "",               // 可选；填了走密码登录（安卓协议），为空走扫码登录（Watch 协议）
  "platform": 1,                // 可选，登录协议：1=安卓(默认) 2=安卓平板 3=手表(可扫码) 4=MacOS 5=iPad 6=Tim
  "dataDir": "",                // 可选，数据目录（设备信息/会话 token，默认 icqq 的 ./data 文件夹）
  "signApiAddr": "",            // 可选，签名服务器地址（未配置可能登录失败/无法收发，建议自建 qsign）
  "qrcodeDir": "",              // 可选，扫码时二维码图片保存目录（默认 ./data/icqq_qrcode）
  "logLevel": "error",          // 可选，icqq 内部日志级别：trace/debug/info/warn/error/fatal/mark/off；默认 error，刷屏时可设 "off" 完全静音
  "ignoreSelf": true            // 可选，忽略机器人自己发的消息，防死循环（默认 true）
}
```

### 登录方式说明

- **密码登录**：填 `password`，走安卓协议，只需首次验证一次设备便长期有效（token 会存到 `dataDir`）。
- **扫码登录**：不填 `password`，适配器强制用 Watch 协议扫码。启动后控制台打印二维码 URL，并把二维码图片保存到 `qrcodeDir`（默认 `./data/icqq_qrcode/<botId>_qrcode.png`），用**手机 QQ** 扫码即可。二维码约 60 秒过期，会自动刷新。
- **滑块验证**：触发 `system.login.slider` 时控制台打印 URL，浏览器打开完成验证；或调用 `getIcqqAdapterById(botId).submitSlider(ticket)` 提交。
- **设备锁**：触发 `system.login.device` 时用手机 QQ 打开提示链接完成验证后自动登录。

---

## 2. 能接收的事件（全量）

| icqq 事件 | 框架事件 | 说明 |
|---|---|---|
| `message.group` | `group_message` | 群消息（`groupId`=群号、`userId`=QQ号） |
| `message.private` | `private_message` | 私聊（`sub_type`=friend 好友 / group 群临时会话） |
| `notice.group.*` | `notice` | 群通知（加人/退群/撤回/戳一戳/禁言/管理变更/转让） |
| `notice.friend.*` | `notice` | 好友通知（加好友/删好友/撤回/戳一戳） |
| `request.friend` | `request` | 好友申请 |
| `request.group.add` / `request.group.invite` | `request` | 加群申请 / 群邀请 |

事件里 `userId`/`groupId` 都是真实 QQ 号（数字，框架已统一转字符串）。

**消息段**（能收到并转换）：
| 类型 | 消息段 |
|---|---|
| 文本 | `{ type:"text", data:{text} }` |
| @某人 | `{ type:"at", data:{qq, name} }` |
| 表情 | `{ type:"face", data:{id} }` |
| 图片/闪照 | `{ type:"image", data:{url, file, flash?} }` |
| 语音 | `{ type:"record", data:{url, file} }` |
| 视频 | `{ type:"video", data:{url, file} }` |
| 引用回复 | `{ type:"reply", data:{id, text} }` |
| JSON 卡片 | `{ type:"json", data:{data} }` |
| XML 卡片 | `{ type:"xml", data:{data} }` |
| 链接分享 | `{ type:"share", data:{url,title,...} }` |
| 文件 | `{ type:"file", data:{name,fid,...} }` |
| 合并转发 | `{ type:"forward", data:{nodes} }` |

**用户昵称/群名片**：`event.raw.sender.nickname`（昵称）、`event.raw.sender.card`（群名片）、`event.raw.sender.role`（owner/admin/member）。

---

## 3. 发送 API（插件内统一 `bot.callApi`）

适配器自动把 OneBot 风格 action 映射到 icqq 方法：

| action | icqq 实现 | 说明 |
|---|---|---|
| `send_group_msg` | `sendGroupMsg(group_id, msg)` | 发群消息 |
| `send_private_msg` | `sendPrivateMsg(user_id, msg)` | 发私聊 |
| `send_msg` | 有 `group_id` 走群，否则私聊 | 插件统一写法 |
| `send_temp_msg` | `sendTempMsg(group_id, user_id, msg)` | 群临时会话 |
| `delete_msg` | `deleteMsg(message_id)` | 撤回 |
| `get_group_list` | `client.gl` | 群列表 |
| `get_group_member_list` | `pickGroup().getMemberMap()` | 群成员列表 |
| `get_group_member_info` | `pickMember().renew()` | 群成员资料 |
| `set_group_kick` | `pickMember().kick()` | 踢人 |
| `set_group_ban` | `pickMember().mute(duration)` | 禁言（秒，0=解除） |
| `set_group_whole_ban` | `pickGroup().muteAll()` | 全员禁言 |
| `set_group_admin` | `pickMember().setAdmin()` | 设置管理员 |
| `set_group_card` | `pickMember().setCard()` | 设置群名片 |
| `set_group_name` | `pickGroup().setName()` | 设置群名 |
| `send_like` | `pickFriend().thumbUp()` | 点赞 |
| `send_group_file` | `pickGroup().fs.upload(file, name)` | 发群文件（本地路径） |

```ts
// 发群消息（QQ 号就是群号）
await bot.callApi("send_group_msg", { group_id: 123456789, message: "你好" })

// 发私聊
await bot.callApi("send_private_msg", { user_id: 123456, message: "你好" })

// 自动判断（插件统一写法：群聊传 group_id，私聊传 user_id）
await bot.callApi("send_msg", { group_id: 123456789, message: "你好" })

// 引用回复：消息段里带 reply 段即可（id = 被引用消息的 message_id）
await bot.callApi("send_group_msg", {
  group_id: 123456789,
  message: [
    { type: "reply", data: { id: "xxxx" } },
    { type: "text", data: { text: "这是回复" } }
  ]
})

// 群管理
await bot.callApi("set_group_ban", { group_id: 123456789, user_id: 123456, duration: 600 })
await bot.callApi("set_group_kick", { group_id: 123456789, user_id: 123456 })
```

**消息段**（发送）：字符串或段数组均可；`image/record/video` 的 `file` 支持**本地路径 / URL**（URL 会自动下载再发送）；`at` 的 `qq` 为 `"all"` 时发 @全体。**markdown / button 段不支持**，会由内核降级逻辑丢弃（或转纯文本，取决于插件的 fallback）。

### 返回值

icqq 方法返回的原始结果（群消息为 `{ message_id, seq, rand, time, ... }`）。

---

## 4. 常见问题

- **扫码时一直刷「二维码扫码遇到错误: 1 (获取二维码失败，请重试)」**：icqq 0.6.x 获取二维码/登录普遍**依赖签名服务器**。请在配置里填 `signApiAddr`（自建 [qsign 签名服务器](https://github.com/icqqjs/icqq)，如 `http://127.0.0.1:8080/sign`），否则二维码获取失败会反复重试刷屏。适配器默认已把 icqq 内部日志压到 `error` 级并做了二维码节流；仍嫌吵可设 `logLevel: "off"` 完全静音（框架自己的提示/登录成功日志不受影响）。
- **登录不上**：icqq 属非官方协议，QQ 风控严格。优先 `password` 密码登录 + 自建 `signApiAddr` 签名服务器；扫码登录需在同一 IP 环境（Watch 协议）。
- **`dataDir` 的作用**：存放设备信息（`device.json`）与登录 token，**首次登录后不要删除**，否则每次都要重新验证设备。
- **收不到自己的消息**：`ignoreSelf` 默认 true 过滤自己发的消息。
- **合并转发**：能收到（`forward` 段），但发送暂不支持。
- **程序闪退/异常**：icqq 断线会自动按 `reconn_interval` 重连（默认 5 秒）；框架配置里 `reconnectDelay` 不作用于 icqq 内部重连。

---

## 5. 相关文档

- icqq 项目：`https://github.com/icqqjs/icqq`
- oicq（上游）API 参考：`https://github.com/takayama-lily/oicq`
- 密码登录/签名服务器教程（icqq 文档）：`https://github.com/icqqjs/icqq`
