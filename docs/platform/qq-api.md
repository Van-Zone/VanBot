---
title: QQ API 参考
description: QQ 官方机器人 bot.callApi 完整调用参考（动作 / 参数 / 示例 / 返回）
---

# QQ API 参考（bot.callApi）

> 插件统一通过 `bot.callApi(action, params)` 调用 QQ 官方 v2 服务器接口。本文件是完整调用参考：动作名、传入参数、示例与返回值。
> 已映射 **server-inter 里「群 / C2C / 互动」场景的全部常用服务器接口**；频道 / 论坛 / 音频 / 日程 / 权限等分类按设计排除，未映射。
> 源码：`src/adapter/qq/client.ts`（`callApi` + `v2Request`）。

## 通用约定

- 入口：`await bot.callApi(action, params)`
- 目标 ID：群用 `group_id`（群 openid），用户用 `user_id`（用户 openid）
- 群成员类参数统一兼容：`member_openid ?? member_id ?? user_id`
- `message` 支持**字符串或消息段数组**（段类型见 [消息段](#markdown--按钮--富媒体)）
- 成功：返回官方响应体（发送类 `{ id, message_id }`；查询类返回对应数据）
- 失败：抛错 `[QQ botId] API METHOD path 失败: message (code:xxx)`
- 未知动作：抛 `[QQ botId] 不支持的 API 操作: action`

---

## 一、消息发送

### `send_group_msg` 发送群消息

发送消息到群。

| 参数 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `group_id` | 是 | string | 群 openid（来自事件 `groupId`） |
| `message` | 是 | string / 段数组 | 消息内容 |

```ts
await bot.callApi("send_group_msg", { group_id: "GROUP_OPEN_xxx", message: "大家好" })
```

**返回**：`{ id, message_id }`

### `send_private_msg` 发送单聊（C2C）消息

| 参数 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `user_id` | 是 | string | 用户 openid（来自事件 `userId`） |
| `message` | 是 | string / 段数组 | 消息内容 |

```ts
await bot.callApi("send_private_msg", { user_id: "USER_OPEN_xxx", message: "你好" })
```

### `send_msg` 自动判断群 / 私聊

插件统一写法：群聊传 `group_id`，私聊传 `user_id`，适配器自动路由。

| 参数 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `group_id` | 二选一 | string | 群 openid |
| `user_id` | 二选一 | string | 用户 openid |
| `message` | 是 | string / 段数组 | 消息内容 |

```ts
await bot.callApi("send_msg", { group_id: "G", message: "群消息" })
await bot.callApi("send_msg", { user_id: "U", message: "私聊消息" })
```

### Markdown / 按钮 / 富媒体

`message` 消息段支持：

```ts
// 纯文本
{ type: "text", data: { text: "文本" } }

// Markdown（msg_type:2，需开通 markdown 权限）
{ type: "markdown", data: { content: "# 标题\n**加粗**" } }
// 或 CQ 字符串
"[CQ:markdown,data={\"content\":\"# 标题\\n**加粗**\"}]"

// Markdown + 按钮（keyboard）
[
  { type: "markdown", data: { content: "# 标题" } },
  { type: "button", data: { text: "点赞", callback: "like" } },        // 回传按钮
  { type: "button", data: { text: "官网", url: "https://qq.com", row: 1 } } // 跳转按钮
]

// 富媒体（上传后按 file_type 发送；1图/3视频/4语音/5文件）
{ type: "image",  data: { url: "https://a/b.jpg" } }
{ type: "video",  data: { url: "https://a/v.mp4" } }
{ type: "record", data: { url: "https://a/v.silk" } }
{ type: "file",   data: { url: "https://a/a.pdf" } }
{ type: "image",  data: { file: "base64://..." } }
```

按钮段字段：`text`（必填）、`callback`（回传数据）、`url`（http 跳转）、`row`（同行分组）、`visited`（点击后文字）。

---

## 二、撤回消息

### `delete_msg` / `recall_msg` 撤回（自动判断群 / 私聊）

只能撤回**机器人自己发的**、且发送未超过 **2 分钟** 的消息。

| 参数 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `message_id` | 是 | string | 消息 ID |
| `group_id` | 二选一 | string | 群 openid（群消息） |
| `user_id` | 二选一 | string | 用户 openid（单聊消息） |

```ts
await bot.callApi("delete_msg", { group_id: "G", message_id: "msg_xxx" })
```

### `recall_group_msg` 撤回群消息

| 参数 | 必填 | 说明 |
|---|---|---|
| `group_id` | 是 | 群 openid |
| `message_id` | 是 | 消息 ID |

### `recall_private_msg` 撤回单聊消息

| 参数 | 必填 | 说明 |
|---|---|---|
| `user_id` | 是 | 用户 openid |
| `message_id` | 是 | 消息 ID |

---

## 三、查询消息

### `get_msg` 获取单条消息

带 `group_id` / `user_id` 时走官方接口；两者都没有时回退到本地缓存（进程内最近 1 小时收发的消息）。

| 参数 | 必填 | 说明 |
|---|---|---|
| `message_id` | 是 | 消息 ID |
| `group_id` | 二选一 | 群 openid |
| `user_id` | 二选一 | 用户 openid |

```ts
const msg = await bot.callApi("get_msg", { group_id: "G", message_id: "msg_xxx" })
```

### `get_group_msg` / `get_group_message` 获取群消息

| 参数 | 必填 | 说明 |
|---|---|---|
| `group_id` | 是 | 群 openid |
| `message_id` | 是 | 消息 ID |

### `get_private_msg` / `get_c2c_msg` 获取单聊消息

| 参数 | 必填 | 说明 |
|---|---|---|
| `user_id` | 是 | 用户 openid |
| `message_id` | 是 | 消息 ID |

### `get_group_msg_list` / `get_group_messages` 群消息列表

| 参数 | 必填 | 说明 |
|---|---|---|
| `group_id` | 是 | 群 openid |

---

## 四、富媒体文件

### `upload_group_file` / `upload_private_file` 上传文件

上传后返回 `file_info`，可用于发送富媒体（或 `media.file_info`）。

| 参数 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `group_id` / `user_id` | 是 | string | 群 / 用户 openid |
| `file_type` | 是 | number | 1 图片 / 3 视频 / 4 语音 / 5 文件 |
| `url` | 二选一 | string | 公网文件地址 |
| `file_data` | 二选一 | string | 文件原始数据（base64） |

```ts
const { file_info } = await bot.callApi("upload_group_file", {
  group_id: "G", file_type: 1, url: "https://a/b.png"
})
```

**返回**：`{ file_info, file_uuid, ttl }`

### `get_group_file_info` / `get_private_file_info` 获取文件信息

| 参数 | 必填 | 说明 |
|---|---|---|
| `group_id` / `user_id` | 是 | 群 / 用户 openid |
| `file_info` | 是 | 上传返回的 file_info |

---

## 五、表情表态

### `set_msg_emoji_like` / `set_message_reaction` 消息表情表态

| 参数 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `message_id` | 是 | string | 消息 ID |
| `group_id` | 二选一 | string | 群 openid |
| `user_id` | 二选一 | string | 用户 openid |
| `emoji_type` | 否 | number | 表态表情类型，默认 1 |

```ts
await bot.callApi("set_msg_emoji_like", { group_id: "G", message_id: "msg_xxx", emoji_type: 1 })
```

### `delete_msg_emoji_like` / `delete_message_reaction` 取消表态

| 参数 | 必填 | 说明 |
|---|---|---|
| `message_id` | 是 | 消息 ID |
| `group_id` / `user_id` | 二选一 | 群 / 用户 openid |

---

## 六、群管理

### `get_group_member_list` 群成员列表

| 参数 | 必填 | 说明 |
|---|---|---|
| `group_id` | 是 | 群 openid |

### `get_group_member_info` 群成员信息

| 参数 | 必填 | 说明 |
|---|---|---|
| `group_id` | 是 | 群 openid |
| `member_openid` / `user_id` | 是 | 群成员 openid |

### `get_group_bot_info` / `get_group_bot_self_info` 机器人在群信息

| 参数 | 必填 | 说明 |
|---|---|---|
| `group_id` | 是 | 群 openid |

### `set_group_ban` 禁言成员

| 参数 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `group_id` | 是 | string | 群 openid |
| `member_openid` / `user_id` | 是 | string | 群成员 openid（**member_openid**） |
| `duration` | 否 | number | 禁言秒数，默认 600 |

### `unset_group_ban` / `delete_group_ban` 解除禁言

| 参数 | 必填 | 说明 |
|---|---|---|
| `group_id` | 是 | 群 openid |
| `member_openid` / `user_id` | 是 | 群成员 openid |

### `set_group_kick` 移出群

| 参数 | 必填 | 说明 |
|---|---|---|
| `group_id` | 是 | 群 openid |
| `member_openid` / `user_id` | 是 | 群成员 openid |

### `set_group_nickname` / `set_group_card` 设置群昵称

| 参数 | 必填 | 说明 |
|---|---|---|
| `group_id` | 是 | 群 openid |
| `member_openid` / `user_id` | 是 | 群成员 openid |
| `nickname` / `card` | 是 | 新昵称 |

```ts
// 组合示例
await bot.callApi("set_group_ban", { group_id: "G", user_id: "MEMBER_OPEN_xxx", duration: 600 })
await bot.callApi("unset_group_ban", { group_id: "G", user_id: "MEMBER_OPEN_xxx" })
await bot.callApi("set_group_kick", { group_id: "G", user_id: "MEMBER_OPEN_xxx" })
await bot.callApi("set_group_card", { group_id: "G", user_id: "MEMBER_OPEN_xxx", card: "新昵称" })
```

> ⚠️ 群禁言 / 踢人 / 改昵称接口认 **member_openid**（群成员 openid，事件 `raw.sender.member_openid`），不是 `user_openid`。

---

## 七、C2C / 好友

### `set_friend_add` / `add_friend` 加好友

| 参数 | 必填 | 说明 |
|---|---|---|
| `user_id` | 是 | 用户 openid |

### `delete_friend` 删除好友

| 参数 | 必填 | 说明 |
|---|---|---|
| `user_id` | 是 | 用户 openid |

### `set_user_block` / `block_user` 拉黑用户

| 参数 | 必填 | 说明 |
|---|---|---|
| `user_id` | 是 | 用户 openid |

### `unset_user_block` / `unblock_user` 解除拉黑

| 参数 | 必填 | 说明 |
|---|---|---|
| `user_id` | 是 | 用户 openid |

---

## 八、按钮回调回应

### `reply_interaction` / `interaction_reply` / `reply_action`

用户点击按钮推送 `INTERACTION_CREATE` 事件后，必须调用本接口回应，否则客户端一直 loading 直到超时（同一 `interaction_id` 只能回应一次）。

| 参数 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `interaction_id` | 是 | string | 事件 `raw.interaction_id` |
| `code` | 否 | number | 回应码，默认不传（官方建议 0） |

```ts
if (event.raw.notice_type === "INTERACTION_CREATE") {
  await bot.callApi("reply_interaction", {
    interaction_id: event.raw.interaction_id,
    code: 0,
  })
}
```

---

## 九、机器人资料

### `get_self_info` / `get_me` 获取机器人自身信息

无参数。

```ts
const me = await bot.callApi("get_self_info", {})
// me = { id: "AppID", username: "...", avatar: "..." }
```

---

## 十、消息审核

### `get_audit_result` / `get_message_audit` 消息审核结果

需订阅 `MESSAGE_AUDIT` 事件（intent 1<<27）。

| 参数 | 必填 | 说明 |
|---|---|---|
| `audit_id` | 是 | 审核 ID（来自 MESSAGE_AUDIT 事件） |

---

## 未映射的官方 v2 接口

- **频道体系**（server-inter/channel 下：子频道 / 频道成员 / 发言权限 / 身份组 / 日程 / 论坛 / 音频 / 频道表态 / 置顶 / 公告等）——按设计排除，不走群/C2C 场景；
- **流式消息**（`PATCH .../messages/{id}` 编辑式流式输出）——官方端点未完全开放，未映射；
- **指令面板 / 自定义菜单**（C2C / 群快捷指令）——未映射；
- **入群申请 / 审批**——未映射；
- **富媒体消息获取**（`.../rich_media`）——该接口属频道能力，群/C2C 未开放。

需要补哪个，可在框架 `callApi` 中按相同模式添加。
