---
title: QQ 官方机器人
description: QQ 开放平台官方机器人接入与 API
---

# QQ 官方机器人

> QQ 开放平台官方机器人。支持 `websockets`（官方加密网关）/ `ws` / `webhook` 三种接收方式，发送统一走 OpenAPI REST。接收最全（文本 / @ / 图片 / 视频 / 语音+ASR / 文件 / 引用 / ARK 卡片 / 表情），发送支持富媒体与 markdown + 按钮（keyboard）。

---



适配器类型：`"qq"`　源码：`src/adapter/qq/`（types.ts / converter.ts / client.ts）
协议：QQ 开放平台官方机器人（api-v2，网关 + REST 发送），**与 onebot11 无关**。支持三种接收方式：`websockets`（官方加密网关 wss://）、`ws`（明文网关）、`webhook`（HTTP 回调）；发送统一走 OpenAPI REST。

---

## 安装

```bash
van adapter install qq
```

---
## 1. 配置文件

### 方式一：websockets（官方加密网关 wss://）——默认

```jsonc
{
  "botId": "QQ-Official",          // 框架内唯一标识（任意起名）
  "type": "qq",                    // 适配器类型固定为 qq
  "mode": "websockets",            // 可选。默认 websockets：连官方加密网关 wss://（自动 /gateway/bot 或回退 api.sgroup.qq.com）
  "appId": "102123456",            // QQ 开放平台 AppID（必填）
  "appSecret": "你的AppSecret",     // AppSecret（必填，开发设置获取），用于换取 access_token
  // 二选一：上面是 AppSecret 模式（AppID+AppSecret，自动换取 7200 秒有效的 access_token）；
  //         也可以用群机器人令牌 BotToken（无需换取，access_token = AppID.BotToken）：
  // "botToken": "xxxxxxxx",
  "intents": 33554432,             // 可选。默认 33554432（群聊+单聊）。需要频道/其他事件见第 4 节
  "gateway": "",                   // 可选，网关地址，默认自动获取
  "reconnectDelay": 5000           // 可选，断线重连延迟毫秒，默认 5000
}
```

### 方式二：ws（明文 WebSocket 网关 ws://）

```jsonc
{
  "botId": "QQ-Official",
  "type": "qq",
  "mode": "ws",                    // 明文 ws:// 网关（用于本地代理 / 自建网关）
  "appId": "102123456",
  "appSecret": "你的AppSecret",     // 或 botToken
  "gateway": "ws://127.0.0.1:8080", // 你的明文网关地址（必填；不填则把官方 wss:// 地址替换成 ws://）
  "intents": 33554432
}
```

### 方式三：webhook（HTTP 回调）

```jsonc
{
  "botId": "QQ-Official",
  "type": "qq",
  "mode": "webhook",               // HTTP 回调：本框架起 HTTP 服务接收 QQ 开放平台推送的事件
  "appId": "102123456",
  "appSecret": "你的AppSecret",     // 或 botToken（发送仍走 OpenAPI，需要凭据）
  "port": 8080,                    // 本框架 HTTP 监听端口（默认 8080）
  "path": "/",                     // 回调路径（默认 "/"，开放平台配置 http://<公网域名/IP>:8080/）
  "intents": 33554432
}
```

> 使用 webhook 模式时，需在 QQ 开放平台 → 开发设置 → 配置"Webhook 回调 URL"为 `http://<公网地址>:<port><path>`，并选择要订阅的事件。注意：回调 URL 需要公网可访问（或用内网穿透）。

> **凭据说明（两种模式）**
> - **AppSecret 模式**：填 `appId` + `appSecret`，适配器自动调 `POST https://api.bot.qq.com/app/getAppAccessToken`（body: `{appId, clientSecret}`）换取 `access_token`（7200 秒有效，断线重连时自动重新换取）。
> - **BotToken 模式**：填 `appId` + `botToken`，`access_token = AppID.BotToken`，无需换取。
> 鉴权与所有 REST 请求头均为 `Authorization: QQBot {access_token}`；openapi 统一基址 `https://api.bot.qq.com`。
> **网络要求**：`websockets`/`ws` 模式直接连 QQ 开放平台网关，国内可直连，无需公网回调、无需 IP 白名单即可收发（WebSocket 主动连接）；`webhook` 模式则需要公网可访问的回调 URL。

---

## 2. 能接收的事件（全部已派发）

| QQ 事件 t | 框架事件 | 说明 |
|---|---|---|
| `GROUP_AT_MESSAGE_CREATE` | `group_message` | 群里 @ 机器人（群机器人核心，含群 openid） |
| `C2C_MESSAGE_CREATE` | `private_message` | 用户单聊机器人 |
| `GROUP_MESSAGE_CREATE` | `group_message` | 群消息（如订阅到） |
| `MESSAGE_CREATE` / `AT_MESSAGE_CREATE` | `group_message` | 频道消息（需订阅对应 intent） |
| `GROUP_ADD_ROBOT` / `GROUP_DEL_ROBOT` / `GROUP_MSG_REJECT` / `GROUP_MSG_RECEIVE` / `FRIEND_ADD` / `FRIEND_DEL` / `C2C_MSG_REJECT` / `C2C_MSG_RECEIVE` 等 | `notice` | 好友/群/单聊关系事件（raw.notice_type = 原事件名） |

事件对象（`BotEvent`）字段：
```ts
{
  botId: "QQ-Official",
  selfId: "102123456",          // AppID
  userId: "USER_OPEN_xxx",      // 用户 openid（群消息取 user_openid）
  groupId: "GROUP_OPEN_xxx",    // 群 openid（群消息），单聊为空
  message: [{ type: "text", data: { text: "你好" } }],
  postType: "group_message" | "private_message" | "notice",
  raw: { ...原始事件, sender: {user_id, member_openid, user_openid}, message_id, time, platform: "qq-official" }
}
```

**消息段**：文本 `text`；图片 `image`（`data.url`）。群消息内容里的 `<@!机器人>` 前缀已自动剥离。
**关键点**：QQ 用 **openid**（每次可能变化的字符串），不是 QQ 号。`userId`/`groupId` 都存 openid。

---

## 3. bot.callApi API 参考

> 插件统一通过 `bot.callApi(action, params)` 调用平台 API（不再用 onebotApi）。本页列出 qq 适配器映射的官方 v2 接口。
> 发送类（send_*）的 `message` 接受字符串或消息段数组；其余接口参数见各小节。
> 已覆盖：消息收发 / 撤回 / 查询、富媒体、表情表态、群管理、C2C 好友、按钮回调回应、机器人资料、消息审核。
> 官方 v2 还有流式消息、指令面板 / 自定义菜单、入群申请审批等少数接口未映射；频道 / 论坛 / 音频类按设计排除，需要可再补。

### 3.1 发送消息

| action | 说明 | 关键参数 |
|---|---|---|
| `send_group_msg` | 发送群消息 | `group_id`（群 openid）, `message` |
| `send_private_msg` | 发送单聊（C2C） | `user_id`（用户 openid）, `message` |
| `send_msg` | 自动判断群/私聊 | `group_id` 或 `user_id`, `message` |

```ts
await bot.callApi("send_msg", { group_id: "GROUP_OPEN_xxx", message: "大家好，我是机器人" })
await bot.callApi("send_msg", { user_id: "USER_OPEN_xxx", message: "你好呀" })
```

### 3.2 消息段（富媒体 / Markdown / 按钮）

`message` 支持字符串或段数组。

**纯文本：**
```ts
{ type: "text", data: { text: "文本" } }
```

**Markdown 消息（msg_type:2）** —— 通过 `[CQ:markdown,data={...}]` 字符串或 `markdown` 段发送：
```ts
// 方式一：CQ 字符串
"[CQ:markdown,data={\"content\":\"# 标题\\n**加粗**\"}]"
// 方式二：markdown 消息段
{ type: "markdown", data: { content: "# 标题\n**加粗**" } }
```
适配器自动发送 `msg_type:2 + markdown.content`。需机器人**已开通 markdown 权限**。

**Markdown + 按钮（keyboard）：**
```ts
// markdown 段 + button 段（按钮字段：text 必填；callback 回传；url 跳转；row 同行；visited 点击后文字）
[
  { type: "markdown", data: { content: "# 标题" } },
  { type: "button", data: { text: "点赞", callback: "like" } },
  { type: "button", data: { text: "官网", url: "https://qq.com", row: 1 } }
]
```

**接收按钮点击（INTERACTION_CREATE）：** 用户点回传按钮后推送 `notice` 事件：
```ts
event.raw.notice_type === "INTERACTION_CREATE"
event.raw.button_id      // = callback 数据
event.raw.button_label   // 按钮文字
event.raw.interaction_id // 回应按钮回调用（见 3.9）
event.userId             // 点击用户 openid
```

**富媒体（图片/视频/语音/文件，官方上传流程）：**
```ts
{ type: "image",  data: { url: "https://example.com/a.jpg" } }
{ type: "video",  data: { url: "https://example.com/v.mp4" } }
{ type: "record", data: { url: "https://example.com/v.silk" } }
{ type: "file",   data: { url: "https://example.com/a.pdf" } }
{ type: "image",  data: { file: "base64://iVBORw0KGgo..." } }
```
适配器按段类型选 `file_type`（1=图片 3=视频 4=语音 5=文件）上传拿 `file_info`，再以 `msg_type:7 + media.file_info` 发送；上传失败自动降级纯文本。

### 3.3 撤回消息

| action | 说明 | 关键参数 |
|---|---|---|
| `delete_msg` / `recall_msg` | 自动判断群/私聊撤回 | `message_id`, `group_id` 或 `user_id` |
| `recall_group_msg` | 撤回群消息 | `group_id`, `message_id` |
| `recall_private_msg` | 撤回单聊消息 | `user_id`, `message_id` |

> 只能撤回**机器人自己发的**、且发送未超过 **2 分钟** 的消息。

```ts
await bot.callApi("delete_msg", { group_id: "GROUP_OPEN_xxx", message_id: "msg_xxx" })
```

### 3.4 查询消息

| action | 说明 | 关键参数 |
|---|---|---|
| `get_msg` | 获取单条消息（带 group_id/user_id 走官方接口，否则回退本地缓存） | `message_id`, `group_id` 或 `user_id` |
| `get_group_msg` / `get_group_message` | 获取群消息 | `group_id`, `message_id` |
| `get_private_msg` / `get_c2c_msg` | 获取单聊消息 | `user_id`, `message_id` |
| `get_group_msg_list` / `get_group_messages` | 群消息列表 | `group_id` |

```ts
const msg = await bot.callApi("get_msg", { group_id: "G", message_id: "msg_xxx" })
```

### 3.5 富媒体文件

| action | 说明 | 关键参数 |
|---|---|---|
| `upload_group_file` | 上传群文件，返回 file_info | `group_id`, `file_type`(1图/3视频/4语音/5文件), `url` 或 `file_data` |
| `upload_private_file` | 上传单聊文件 | `user_id`, `file_type`, `url` 或 `file_data` |
| `get_group_file_info` | 群文件信息 | `group_id`, `file_info` |
| `get_private_file_info` | 单聊文件信息 | `user_id`, `file_info` |

```ts
const { file_info } = await bot.callApi("upload_group_file", { group_id: "G", file_type: 1, url: "https://a/b.png" })
```

### 3.6 表情表态

| action | 说明 | 关键参数 |
|---|---|---|
| `set_msg_emoji_like` / `set_message_reaction` | 消息表情表态 | `message_id`, `group_id` 或 `user_id`, `emoji_type` |
| `delete_msg_emoji_like` / `delete_message_reaction` | 取消表态 | `message_id`, `group_id` 或 `user_id` |

```ts
await bot.callApi("set_msg_emoji_like", { group_id: "G", message_id: "msg_xxx", emoji_type: 1 })
```

### 3.7 群管理

| action | 说明 | 关键参数 |
|---|---|---|
| `get_group_member_list` | 群成员列表 | `group_id` |
| `get_group_member_info` | 群成员信息 | `group_id`, `member_openid` / `user_id` |
| `get_group_bot_info` / `get_group_bot_self_info` | 机器人在群信息 | `group_id` |
| `set_group_ban` | 禁言成员 | `group_id`, `member_openid` / `user_id`, `duration`（秒） |
| `unset_group_ban` / `delete_group_ban` | 解除禁言 | `group_id`, `member_openid` / `user_id` |
| `set_group_kick` | 移出群 | `group_id`, `member_openid` / `user_id` |
| `set_group_nickname` / `set_group_card` | 设置群昵称 | `group_id`, `member_openid` / `user_id`, `nickname` / `card` |

> 成员参数统一兼容 `member_openid ?? member_id ?? user_id`。QQ 群禁言 / 踢人接口认 **member_openid**（群成员 openid，事件 `raw.sender.member_openid`），不是 user_openid。

```ts
await bot.callApi("set_group_ban", { group_id: "G", user_id: "MEMBER_OPEN_xxx", duration: 600 })
await bot.callApi("unset_group_ban", { group_id: "G", user_id: "MEMBER_OPEN_xxx" })
await bot.callApi("set_group_kick", { group_id: "G", user_id: "MEMBER_OPEN_xxx" })
```

### 3.8 C2C / 好友

| action | 说明 | 关键参数 |
|---|---|---|
| `set_friend_add` / `add_friend` | 加好友 | `user_id` |
| `delete_friend` | 删好友 | `user_id` |
| `set_user_block` / `block_user` | 拉黑用户 | `user_id` |
| `unset_user_block` / `unblock_user` | 解除拉黑 | `user_id` |

### 3.9 按钮回调回应

用户点击按钮后推送 `INTERACTION_CREATE` 事件，需调用本接口回应，否则客户端一直 loading 直到超时：

| action | 说明 | 关键参数 |
|---|---|---|
| `reply_interaction` / `interaction_reply` / `reply_action` | 回应按钮回调 | `interaction_id`, `code`（可选） |

```ts
// 在 notice 分支处理按钮点击
if (event.raw.notice_type === "INTERACTION_CREATE") {
  await bot.callApi("reply_interaction", { interaction_id: event.raw.interaction_id, code: 0 })
}
```

### 3.10 机器人资料

| action | 说明 |
|---|---|
| `get_self_info` / `get_me` | 获取机器人自身信息（GET /users/@me） |

```ts
const me = await bot.callApi("get_self_info", {})
```

### 3.11 消息审核

| action | 说明 | 关键参数 |
|---|---|---|
| `get_audit_result` / `get_message_audit` | 消息审核结果（需订阅 MESSAGE_AUDIT 事件） | `audit_id` |

### 3.12 返回值与错误

- 成功：直接返回官方响应体（发送类返回 `{ id, message_id }`；查询类返回对应数据）。
- 失败：抛错 `[QQ botId] API METHOD path 失败: message (code:xxx)`。
- 未实现的 action：抛 `[QQ botId] 不支持的 API 操作: action`。

---

## 4. intents 订阅（"接收全部事件"）

默认订阅 `GROUP_AND_C2C_EVENT | GUILD_MESSAGES | PUBLIC_GUILD_MESSAGES`，覆盖群聊+单聊+频道消息。
如需更多事件，按位或后填入 `intents`：

| Intent | 值 | 覆盖事件 |
|---|---|---|
| GUILDS | 1 | 频道相关 |
| GUILD_MEMBERS | 2 | 频道成员变动 |
| GUILD_MESSAGES | 512 | 频道消息 |
| GUILD_MESSAGE_REACTIONS | 1024 | 频道消息表态 |
| DIRECT_MESSAGE | 4096 | 频道私信 |
| **GROUP_AND_C2C_EVENT** | **33554432** | **群@+单聊+好友/群关系事件（默认）** |
| INTERACTION | 67108864 | 交互事件 |
| MESSAGE_AUDIT | 134217728 | 消息审核 |
| FORUMS_EVENT | 268435456 | 论坛事件（仅私域） |
| AUDIO_ACTION | 536870912 | 音频动作 |
| PUBLIC_GUILD_MESSAGES | 1073741824 | 公域频道消息 |

> ⚠️ 只订阅你的机器人**有权限**的 intent，否则连接会被服务端拒绝。

---

## 5. 接收事件结构（图片/语音/视频/引用/昵称）

收到 `GROUP_AT_MESSAGE_CREATE`（群@）、`GROUP_MESSAGE_CREATE`（全量群消息）、`C2C_MESSAGE_CREATE`（单聊）时，适配器已把 QQ 原始消息解析为统一消息段：

| 类型 | 消息段 | 数据来源 |
|---|---|---|
| 文本 | `{ type:"text", data:{text} }` | `content`（已去 @机器人 前缀） |
| 图片 | `{ type:"image", data:{url} }` | `attachments[]`（content_type=image/*） |
| 视频 | `{ type:"video", data:{url} }` | `attachments[]`（content_type=video/*） |
| 语音 | `{ type:"record", data:{url, asr?, wav?} }` | `attachments[]`（content_type=voice；`asr` 是语音转文字结果，`wav` 是 WAV 地址） |
| 文件 | `{ type:"file", data:{url, name} }` | `attachments[]`（content_type=file） |
| 引用消息 | `{ type:"reply", data:{text} }` | `message_type=103` + `msg_elements[0].content` |
| @某人 | `{ type:"at", data:{qq, name} }` | `mentions[]` |
| 表情 | `{ type:"face", data:{id} }` | `content` 内 `<emoji:id/>` |
| ARK 卡片 | `{ type:"json", data:{data} }` | `message_type=3` + `ark_data` |

**用户昵称**：群聊昵称在 `event.raw.sender.nickname`（取自 `author.username`）；单聊昵称平台可能返回空。

```ts
// 插件里获取
event.raw.sender.nickname   // 发送者昵称
event.raw.sender.user_openid
event.raw.sender.member_openid
event.raw.message_id        // 消息 ID
event.userId / event.groupId
```

> ⚠️ 如果只订阅 `GROUP_AND_C2C_EVENT`，**群消息默认只在用户 @ 机器人 时推送**（`GROUP_AT_MESSAGE_CREATE`）。要让机器人收到群里**所有**消息（含图片/语音/引用，不 @ 也推），需在 QQ 开放平台控制台开启"接收所有消息"功能（`GROUP_MESSAGE_CREATE`）。

---

## 6. 常见问题

- **`appId`/`botToken` 从哪来**：QQ 开放平台 → 创建机器人 → 开发设置 → 查看 AppID 与 BotToken（令牌）。
- **机器人怎么进群**：群设置 → 群机器人 → 添加你的机器人（需群主/管理员）。个人开发者可加进 ≤20 人的测试群。
- **群 openid 哪来**：机器人收到群消息后，事件里的 `groupId` 就是群 openid；单聊的 `userId` 是用户 openid。
- **机器人主动私聊用户有限制**：QQ 限制机器人主动发消息次数（每月 3 条），被 @ 或用户先私聊后被动回复无限。群内回复群（`send_group_msg`）不受此限。
- **收不到消息**：确认 `appId/botToken` 正确、控制台里已配置"机器人事件订阅"里勾选"群聊@消息/单聊消息"、机器人已加入群。群内**图片/语音/视频**等也要能收到，需开启"接收所有消息"。
- **`Invalid signature` 之类与微信无关**：本适配器不走 HTTP 回调，没有签名校验。
- **机器人自己发的消息收不到**：QQ 官方平台**本身就不推送机器人自己发出的消息**（这是平台行为，与 `ignoreSelf` 无关）。`ignoreSelf` 主要用于 Discord / KOOK 这类会把自己消息也推给机器人的平台，防止机器人自问自答死循环。

---

## 6. 相关文档

- 官方接入/鉴权/心跳：`https://bot.q.qq.com/wiki/develop/api/gateway/reference.html`
- 事件订阅 intents：`https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html`
- 发送消息（群/单聊）：`https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/send.html`
- 富媒体 file_info：`https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/rich-media.html`
