---
title: 抖音
description: 抖音网页版私信接入与 API
---

# 抖音

> 抖音网页版私信（浏览器自动化驱动，参考 Douyin-mcp）。cookie 登录、有头模式更稳；只支持文本收发，需要本机有 Edge / Chrome 浏览器环境。

---



适配器类型：`"douyin"`　源码：`src/adapter/douyin/`
协议：基于**抖音网页版私信（/messages）**的浏览器自动化，收发参考 [Douyin-mcp](https://github.com/Lozzi1910/Douyin-mcp)。

> 说明：抖音 web 接口普遍需要 `a_bogus` 签名（逆向 webmssdk.js），纯 HTTP 方案不稳定且易失效，故本适配器采用**系统浏览器（Edge/Chrome）驱动网页版私信页**实现 cookie 登录与私信收发。
> ⚠️ 网页版自动化属于非官方方式，有账号风控风险，请自行评估使用。
> 抖音对 headless 指纹有验证码风控，适配器内置**反检测脚本 + 持久化浏览器指纹（profileDir）**，若仍被验证码拦截，把 `headless` 设为 `false` 用真实窗口过验证一次（之后持久化指纹会长期免验证）。

---

## 安装

```bash
van adapter install douyin
```

---
## 1. 配置文件

```jsonc
{
  "botId": "抖音",                    // 框架内唯一标识
  "type": "douyin",                   // 适配器类型固定为 douyin
  "cookie": "sessionid=xxx; sid_guard=yyy; ...", // 必填：抖音网页版登录 cookie（须含 sessionid）
  "executablePath": "",               // 可选，浏览器绝对路径（默认自动探测系统 Edge/Chrome）
  "headless": true,                   // 可选，无头模式（默认 true；被验证码拦截时设 false 用真实窗口过验证一次）
  "profileDir": "",                   // 可选，浏览器指纹持久化目录（默认 ./data/douyin_profile/<botId>，不要删，删了会重新触发验证码）
  "sessionDir": "",                   // 可选，登录态保存目录（默认 ./data/douyin_session）
  "pollInterval": 2500                // 可选，接收轮询间隔毫秒（默认 2500）
}
```

**依赖**：`playwright-core`（已随项目安装）+ 系统 Edge/Chrome（无需下载浏览器）。

### 登录方式（只用 cookie）

1. **手动 cookie（唯一登录方式）**：`cookie` 填抖音网页版登录后的 cookie 字符串。从**已登录抖音**的浏览器（Edge/Chrome）按 `F12 → 控制台 → 输入 document.cookie` 复制整段即可；或从开发者工具 Network 里任一个 douyin.com 请求的 Cookie 头复制。适配器会把 cookie 写入浏览器上下文并检测 `sessionid`/`sid_guard`/`sid_ucp_virtual` 确认登录。
2. **会话复用**：登录成功会保存 storage_state 到 `sessionDir/<botId>.json`；但按当前实现**优先使用 config.cookie**，所以只要 cookie 长期有效即可。若 cookie 过期，重新复制一份填上即可。

> **登录的本质**：抖音登录凭证就是 `sessionid` 等 cookie。无需扫码——扫码本质也是换 cookie。直接填 cookie 即等价。
> cookie 有效期不固定，一般数天到数周；过期后日志会提示"登录态无效"，重填 cookie 即可。

---

## 2. 能接收的事件

适配器点击网页版右上角"消息"按钮，打开**右侧消息面板**（SPA，URL 不变），轮询面板内的**会话列表**（稳定语义 class `conversationConversationItemwrapper`），检测会话"最后消息预览 + 时间"指纹变化即派发事件：

| 场景 | 框架事件 | 标识 |
|---|---|---|
| 好友私信 | `private_message` | `userId` = 对方昵称 |

**消息段**：收到的是会话列表的**最后一条消息预览**（文本），统一转为 `{ type:"text", data:{ text } }`；若预览是表情/图片占位，文本可能为空或呈现为占位，此时转 `[未知消息]`。

**昵称**：`event.raw.sender.nickname` = 对方昵称。

> ⚠️ 网页版消息能力已被抖音弱化：面板顶部横幅"下载客户端，实时接收好友消息"。适配器基于面板会话列表实现接收，**能拿到最新消息预览（含未读变化），但富媒体内容（图片/视频）读不到**。

---

## 3. 发送 API（插件内统一 `bot.callApi`）

抖音网页版聊天输入框是 contenteditable（class 含 `editor-kit-container`），适配器通过注入文本（innerText + input + paste 事件）后点发送按钮（兜底回车）完成发送，只支持文本：

| action | 说明 |
|---|---|
| `send_private_msg` | `params.user_id` = 对方昵称，发送私聊 |
| `send_group_msg` | `params.group_id` = 群名（当前网页版面板仅私聊会话，群聊暂不可用） |
| `send_msg` | 有 `group_id` 走群聊，否则走私聊（插件统一写法） |
| `get_contacts` | 返回消息面板会话列表（昵称、最后消息预览、时间、是否群聊） |

```ts
// 给昵称为"Van."的好友发私聊
await bot.callApi("send_private_msg", { user_id: "Van.", message: "你好" })

// 自动判断（群聊传 group_id，私聊传 user_id）
await bot.callApi("send_msg", { user_id: "Van.", message: "在吗" })

// 获取最近联系人
const contacts = await bot.callApi("get_contacts")
```

> 注意：抖音没有数字 ID，`user_id` 这里**填会话昵称**，必须与消息面板里显示的一致。

---

## 4. 能力说明

`Capabilities`：`text: true`，其余（image/video/record/file/markdown/button/at/reply/face/forward）均为 `false`，`canMuteMember/canKickMember` 为 `false`。插件里若给抖音发富媒体段，会被内核降级逻辑自动丢弃（或按插件 fallback 转文本）。

---

## 5. 常见问题

- **登录态无效**：cookie 里没有 sessionid / 过期。从**已登录抖音的浏览器**（Edge/Chrome）按 `F12 → 控制台 → 输入 document.cookie` 复制整段填入 config.json 的 `cookie` 字段。适配器会检测 `sessionid`/`sid_guard`/`sid_ucp_virtual`。
- **验证码风控**：headless 模式（无论新旧）都可能触发滑块验证码，页面标题变为"验证码中间页"。适配器用 `--headless=new` + 反检测脚本 + **持久化指纹（profileDir）** 已大幅降低触发率；仍触发就把 `headless` 改为 `false` 用真实窗口过验证一次（之后 profileDir 持久化指纹免验证），或降低使用频率。
- **收不到消息**：确认日志出现"登录成功"；适配器轮询**消息面板会话列表**，只有会话有新消息（预览/时间变化）才派发事件。若面板打不开或没有会话，自然收不到。网页版消息被抖音弱化（面板有"下载客户端"横幅），**富媒体（图片/视频）读不到**，只能拿到文本预览。
- **发消息失败**：昵称必须与消息面板里完全一致；发送会打开面板→点会话→注入 contenteditable→点发送/回车。若误点到顶部搜索框导致跳到搜索页，适配器会自动回首页重开面板。
- **自己发的消息被重复接收**：适配器记录自己刚发内容做回显过滤（30 秒窗口）+ 发送时置 busy 防并发。
- **浏览器找不到**：自动探测 Edge/Chrome 失败时，在 `executablePath` 填浏览器绝对路径。
- **风控**：高频轮询/发送可能触发抖音风控，建议 `pollInterval` 不要低于 1500ms。

---

## 6. 相关参考

- Douyin MCP Server（本适配器收发实现参考）：`https://github.com/Lozzi1910/Douyin-mcp`
- 抖音 web 私信协议分析（WebSocket 实时 + 编码层）：`https://juejin.cn/post/7653873632477462564`
