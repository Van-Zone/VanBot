---
title: 能力总览
description: 多平台收发能力矩阵
---

# 多平台能力矩阵



> 原则：**能获取到什么就接收什么，能做什么就支持什么**。所有平台的事件统一转换为框架消息段
> （`text` / `at` / `image` / `video` / `record` / `file` / `reply` / `forward` / `face` / `json` 等），
> 插件用同一份代码处理所有平台；发送侧每个适配器把统一段转成平台格式，不支持的段兜底降级为文本，绝不崩溃。

## 安装适配器

框架不内置平台适配器，统一通过社区安装（`van adapter list` 查看 / `van adapter remove` 移除）：

```bash
van adapter install <适配器名>
```

---
## 一、接收能力（消息 → 统一段）

| 消息段 | QQ官方 | Telegram | KOOK | Discord | 微信公号 | 个人微信 | OneBot11/NapCat | Satori/Milky | B站直播 |
|---|---|---|---|---|---|---|---|---|---|
| 文本 `text` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅(弹幕) |
| @ `at` | ✅(mentions) | 文本含@ | ✅((met)) | ✅(mentions) | 无群 | ❌ | ✅ | ✅ | ❌ |
| 图片 `image` | ✅(attachments) | ✅(photo) | ✅(type2) | ✅(attachments) | ✅ | ✅(CDN解密) | ✅ | ✅ | ❌ |
| 视频 `video` | ✅(attachments) | ✅(video) | ✅(type3) | ✅(attachments) | ✅ | ✅(CDN解密) | ✅ | ✅ | ❌ |
| 语音 `record` | ✅(voice+ASR) | ✅(voice/audio) | ✅(type8) | ✅(audio) | ✅ | ✅(云端转文字) | ✅ | ✅ | ❌ |
| 文件 `file` | ✅(file) | ✅(document) | ✅(type4) | ✅(file) | ✅ | ✅(CDN解密) | ✅ | ✅ | ❌ |
| 引用 `reply` | ✅(msg_type 103) | ✅(reply_to) | ✅(extra.quote) | ✅(message_ref) | ❌ | ✅(ref_msg) | ✅ | ✅ | ❌ |
| 转发 `forward` | 部分(并行101) | ✅(forward_from) | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ❌ |
| 表情 `face` | ✅(emoji标签) | 贴纸→文本 | ✅((emj)) | ❌ | ❌ | ❌ | ✅ | ✅ | 礼物 |
| 卡片 `json` | ✅(ARK) | ❌ | 卡片→文本 | ❌ | 链接→文本 | ❌ | ✅ | ❌ | ❌ |
| 昵称 nickname | ✅(author.username) | ✅(first_name) | ✅(author.nickname) | ✅(global_name) | ❌(需认证API) | ❌(协议无) | ✅ | ✅ | ✅ |
| 事件 notice | ✅(群成员/交互) | ✅(callback/成员) | ✅(type255) | 部分 | ✅(关注/菜单) | 仅消息 | ✅ | ✅ | 部分 |

## 二、发送能力（统一段 → 平台）

| 消息段 | QQ官方 | Telegram | KOOK | Discord | 微信公号 | 个人微信 | OneBot11/NapCat | Satori/Milky | B站直播 |
|---|---|---|---|---|---|---|---|---|---|
| 文本 `text` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅(弹幕) |
| 图片 `image` | ✅富媒体 | ✅ | ✅ | ✅embed | ✅客服 | ✅(加密上传) | ✅ | ✅ | ❌ |
| 视频 `video` | ✅富媒体 | ✅ | ✅ | ✅附件上传 | ✅客服 | ✅(加密上传) | ✅ | ✅ | ❌ |
| 语音 `record` | ✅富媒体 | ✅ | ✅ | ✅附件上传 | ✅客服 | ❌(降级文本) | ✅ | ✅ | ❌ |
| 文件 `file` | ✅富媒体 | ✅ | ✅ | ✅附件上传 | ✅客服 | ✅(加密上传) | ✅ | ✅ | ❌ |
| markdown | ✅(msg_type2) | 转文本 | ✅(kmarkdown) | 转文本 | ❌ | 转文本 | ✅ | ✅ | ❌ |
| 按钮 button | ✅(keyboard) | 转文本 | ❌ | ❌ | ❌ | 转文本 | ✅ | ❌ | ❌ |
| @ at | ✅ | 转文本 | ✅((met)) | ✅(<@id>) | ❌ | 转文本 | ✅ | ✅ | ❌ |
| 引用 reply | ✅(msg_id) | ❌ | ❌ | ❌ | ❌ | 转文本 | ✅ | ✅ | ❌ |

## 三、会话能力（computeCapabilities，会话粒度）

> 能力是**会话粒度**（群/私聊不同），不是平台全局写死。适配器按事件返回 `Capabilities`，
> 内核据此做发送降级：段声明 `capabilities` + `fallback`，会话缺能力时自动降级，无 fallback 则丢弃。
> 业务插件只判断能力标记，**禁止硬编码平台字符串**。

| 能力 | QQ官方 | Telegram | KOOK | Discord | 微信公号 | 个人微信 | OneBot11 | Satori | Milky | B站 |
|---|---|---|---|---|---|---|---|---|---|---|
| text | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| image | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| video | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| record | ✅ | ✅ | ✅ | ✅ | ✅ | ❌(降级文本) | ✅ | ✅ | ✅ | ❌ |
| file | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| markdown | ✅(msg_type2) | ✅(转文本) | ✅(kmarkdown) | ✅(原生) | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ |
| button | ✅(keyboard) | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ | ✅ | ❌ |
| at | ✅ | ✅(转文本) | ✅((met)) | ✅(<@id>) | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ |
| reply | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ |
| face | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ |
| canMuteMember | 群✅/私❌ | ❌ | ❌ | ❌ | ❌ | ❌ | 群✅ | 群✅ | 群✅ | ❌ |
| canKickMember | 群✅/私❌ | ❌ | ❌ | ❌ | ❌ | ❌ | 群✅ | 群✅ | 群✅ | ❌ |

**降级示例**：`MessageSegment.markdown(...).needs("markdown").fallbackTo(MessageSegment.text("纯文本"))`
→ QQ 发原生 markdown；B站/TG/个人微信 发 fallback 纯文本；微信公号丢弃。

## 四、说明与注意事项

- **消息段统一输入**：字符串 / 单段对象 `{type,data}` / 段数组，所有适配器都接受（`normalizeSegments`）。
- **降级兜底**：某平台不支持的消息段会被 `segmentsToText` 转成可读文本发送，不会报错或发 `[object Object]`。
- **QQ 官方机器人**：接收最全（attachments/引用/ARK/语音ASR），发送支持富媒体与 markdown+按钮；群消息默认需@机器人，开启"接收所有消息"才收全部。
- **Discord**：发送视频/语音/文件走 multipart 上传（URL 先下载再传）；私聊自动解析 DM 频道；MESSAGE_CONTENT 是特权 intent，需后台开启。
- **微信公号**：昵称需认证接口（`GET /cgi-bin/user/info`），passiveMode（未认证）下拿不到，`sender.nickname` 为空。
- **个人微信（weixin_oc）**：基于腾讯官方 openclaw-weixin（iLink）协议，扫码登录；接收媒体自动 CDN 下载并 AES-128-ECB 解密到本地；发送图片/视频/文件自动加密上传；**昵称协议里没有、语音发送不支持**（降级文本）；消息回复必须带 `context_token`（适配器自动缓存）。需要手机微信含 ClawBot 插件（iOS>=8.0.70 / Android>=8.0.69）。
- **B站直播间**：只收发弹幕文本，无富媒体；弹幕来源为 getConf 接口 + WebSocket。
- **`ignoreSelf`**：默认 true 忽略机器人自己的消息（防死循环），各平台均可在 config 配置。
