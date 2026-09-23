---
title: 个人微信（weixin_oc）
description: 个人微信 openclaw-weixin 接入与 API
---

# 个人微信（weixin_oc）

> 个人微信（腾讯官方 openclaw-weixin / iLink 协议）。手机微信扫码登录、HTTP 长轮询收发、媒体 CDN 加密。与微信公众号（wechat）不同，识别场景为私聊。

---



> 通过腾讯官方 **openclaw-weixin**（iLink 协议）接入**个人微信**，与微信公众号（`wechat`）不同：
> 扫码登录、无需公网回调地址、走 HTTP 长轮询收发消息。
>
> 基于腾讯官方 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（iLink）协议

## 安装

```bash
van adapter install weixin_oc
```

---
## 原理

```
手机微信 ←→ 腾讯 iLink 服务器(ilinkai.weixin.qq.com) ←→ 本适配器(VanBotJS)
```

- **登录**：`get_bot_qrcode` 申请二维码 → 手机微信扫码（需微信内含 ClawBot 插件）→ `get_qrcode_status` 轮询 → 拿到 `bot_token` + `baseurl`
- **接收**：`POST /ilink/bot/getupdates` 长轮询（35 秒 hold），用 `get_updates_buf` 游标防重复
- **发送**：`POST /ilink/bot/sendmessage`，**必须携带 `context_token`**（收到的消息里带回）才能关联到正确对话窗口
- **媒体**：图片/视频/文件走 CDN，AES-128-ECB 加密——发送时加密上传，接收时下载解密到本地

## 前提

- 手机微信升级到最新版：**iOS >= 8.0.70，Android >= 8.0.69**
- 手机微信内包含 **ClawBot 插件**（微信官方个人 Bot 功能）
- 消息不带发送者昵称（个人微信协议限制）

## 配置

```json
{
  "botId": "WX-Personal",
  "type": "weixin_oc",
  "longPollTimeoutMs": 35000,
  "apiTimeoutMs": 15000,
  "ignoreSelf": true
}
```

| 配置项 | 说明 |
|---|---|
| `botId` | 框架内唯一标识 |
| `type` | 固定 `"weixin_oc"` |
| `baseUrl` | 可选。接口地址，**扫码登录成功后自动回填**；也可手动填（从 OpenClaw 登录态导出） |
| `token` | 可选。bot_token，同上自动回填 |
| `longPollTimeoutMs` | 长轮询超时（毫秒），默认 35000 |
| `apiTimeoutMs` | 普通 API 超时（毫秒），默认 15000 |
| `qrLogin` | 是否自动扫码登录（未配置 token 时），默认 true |
| `qrSaveDir` | 二维码图片/媒体/凭证保存目录，默认 `./data` |
| `ignoreSelf` | 忽略机器人自己的消息，默认 true |

## 首次使用：扫码登录

1. 在 `config.json` 加入上面的配置（无需填 token/baseUrl）
2. 启动 `npm run dev`，控制台会打印：
   - 扫码链接（`qrCode...` URL）
   - 二维码图片保存路径：`data/qrcode_WX-Personal.png`（用 qrcode 生成）
3. 用手机微信打开该二维码图片扫码，并在微信内确认登录
4. 登录成功后自动把 `baseUrl` + `token` 保存到 `data/weixin_oc_WX-Personal.json`
5. **下次启动免扫码**（登录态有效期内），提示 `已从本地凭证恢复登录态`
6. 若提示"会话超时"（errcode -14），删除该凭证文件重启即可重新扫码

> 登录成功后会打印 `✅ [WX-Personal] 已连接`，然后用微信发条消息验证。

## API 调用（插件统一 `bot.callApi`）

与其它平台一致，插件通过 `send_msg` 统一发送：

| action | 参数 | 说明 |
|---|---|---|
| `send_msg` / `send_private_msg` / `send_group_msg` | `user_id`（或 `group_id`）、`message`、`context_token?` | 通用发送。个人微信场景目标就是 `user_id` |
| `send_text` | `user_id`, `text` | 快捷发文本 |
| `send_image` | `user_id`, `image`/`file`/`url`, `name?` | 发图片（自动加密上传 CDN） |
| `send_video` | `user_id`, `video`/`file`/`url`, `name?` | 发视频 |
| `send_file` | `user_id`, `file`/`url`, `name?` | 发文件 |
| `get_me` | — | 返回 `{ selfId, baseUrl, connected }` |

### message 消息段支持

`message` 支持：字符串 / 单段对象 `{type,data}` / 段数组（`normalizeSegments` 统一处理）。

| 段 | 发送行为 |
|---|---|
| `text` / `at` / `face` / `markdown` / `button` | 合并为文本（markdown/button 降级为纯文本） |
| `image` | ✅ 自动 AES 加密上传 CDN，原样送达 |
| `video` | ✅ 自动加密上传 CDN |
| `file` | ✅ 自动加密上传 CDN（`data.name` 为文件名） |
| `record` | ❌ 微信不支持发送语音 → 降级为 `[语音]` 文本 |
| `reply` | ❌ 不支持引用占位 → 降级为 `[回复]xxx` 文本 |
| 其它未知段 | `segmentsToText` 兜底为文本 |

`file`/`url` 支持：**本地路径**、**http(s) URL**（自动下载）、**`base64://`** 前缀。

> 发送时若插件不传 `context_token`，适配器会自动使用最近一次从该用户收到的 `context_token`，无需关心。

## 接收事件

适配器把消息转成统一事件（`BotEvent`）派发：

- 私聊 → `private_message`，群聊（有 `group_id`）→ `group_message`
- `event.raw` 保留完整原始报文（含 `context_token`、`item_list` 等）
- `event.raw.sender.nickname` 恒为空（协议无昵称字段）

支持接收的消息类型：

| item type | 含义 | 转成段 |
|---|---|---|
| 1 | 文本 | `text` |
| 2 | 图片 | `image`（下载解密，`data.file` = 本地路径） |
| 3 | 语音 | `record`（`data.text` 为云端转写）+ `text`（`[语音]转写内容`） |
| 4 | 文件 | `file`（`data.file` = 本地路径） |
| 5 | 视频 | `video`（`data.file` = 本地路径） |
| `ref_msg` | 引用 | `reply`（`data.text` 为被引用内容） |

媒体接收后解密保存在 `data/media/<botId>/`，插件可直接读取使用。

## 与其它适配器的差异

| 项 | 个人微信（weixin_oc） | 微信公众号（wechat） |
|---|---|---|
| 登录 | 手机扫码 | 后台配置 appId/appSecret |
| 接收 | HTTP 长轮询 | Webhook 回调 |
| 昵称 | 协议无 | 需认证接口 |
| 媒体 | CDN 加密收发 | 客服消息接口 |
| 群聊 | 字段原生支持（有限） | 无 |

## 常见问题

- **扫码后提示"需要输入数字"**：微信会显示 6 位数字验证码，在控制台输入即可。
- **长时间没有新消息**：确认手机微信内 ClawBot 插件在线、后台允许微信运行。微信官方 Bot 协议**只能收到用户主动发给机器人的消息**（不会推送群聊/他人消息）。
- **接收有延迟 / 不自动**：长轮询每 35 秒一轮，正常消息应在 35 秒内到达。若完全收不到，先确认控制台出现 `长轮询已就绪` 且每 ~35s 有轮询日志；再确认手机微信 ClawBot 在线。
- **发送失败 `ret != 0`**：通常是 `context_token` 过期，让用户再发一条消息刷新即可。
- **发送失败 / 不发**：确认 `channel_version` 为 `1.0.3`（协议要求），发送请求带 `client_id`；若从未收到过该用户消息，`context_token` 为空，服务端可能拒绝——先让用户主动发一条消息。
- **媒体发送失败自动降级文本**：网络/CDN 异常时不会中断，按段降级为 `[图片]` 等文本发出。

### 协议实现要点（与官方 ClawBot/逆向 SDK 对齐）

- `base_info.channel_version = "1.0.3"`（不要用 2.0.0，会导致长轮询异常收不到推送）
- `getupdates` 长轮询超时（AbortError）视为正常边界，无缝进入下一轮
- 只处理 `message_type === 1`（用户消息），跳过 `2`（机器人自己发的），防止回复被拉回造成重复发送/自循环
- `sendmessage` 必须带 `client_id`（随机）、`from_user_id`（空串）、`context_token`
