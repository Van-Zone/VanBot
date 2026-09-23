# VanBotJS 多平台接入指南

本框架的核心思想：**一份插件（`plugin/keyword.ts`）通过"适配器"同时服务多个平台**。
无论消息来自 QQ、微信公众号、B 站直播间、Telegram、KOOK 还是 Discord，都会先被适配器转成框架统一的 `BotEvent`，派发给插件处理；插件回复时调用统一的发送动作（`bot.callApi` / `ctx.reply`），携带会话能力集由内核自动降级，再由适配器翻译成对应平台的发送 API。

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│  QQ (OneBot11)│  │  微信公众号    │   │ B站直播间     │
│  ws 8080      │  │  http 8090    │   │  wss 弹幕     │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ QQ官方机器人   │   │  Telegram    │   │  KOOK/Discord │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │ 统一事件 BotEvent │                  │
       └─────────┬────────┴──────────────────┘
                 ▼
    内核归一化（traceId / ID字符串 / 能力集 / 未知段占位）
                 ▼
        globalBus (事件总线) + 中间件（快照）
                 ▼
     PluginManager → plugin/keyword.ts（或任何 plugin/*.ts）
        definePlugin.onEvent(event, bot)
                 ▼
   内核发送降级（applySendFallback）→ bot.callApi("send_msg",...)
                 ▼
   各适配器 callApi() 把消息翻译回平台并发送
```

## 目录结构

```
VanBotJS/
├── src/
│   ├── index.ts                 # 启动入口：读 config.json，创建适配器，加载插件
│   ├── core/                    # 内核：config / 事件总线 / 能力体系 / 降级流水线 / 中间件
│   │   ├── capabilities.ts      # 会话能力体系（computeCapabilities / FULL_CAPABILITIES）
│   │   ├── sendPipeline.ts      # 发送降级（applySendFallback）
│   │   ├── eventPipeline.ts     # 接收归一化（traceId / ID 字符串 / 未知段占位）
│   │   ├── middleware.ts        # 中间件 + 快照
│   │   ├── pluginContext.ts     # definePlugin + ctx（副作用追踪 / Skill 注册）
│   │   ├── pluginManager.ts     # 插件加载 / 热重载（目录在根 plugin/）
│   │   └── models/              # 统一事件/消息模型（MessageSegment + capabilities/fallback）
│   └── adapter/                 # 各协议适配器（base + onebot11/qq/telegram/...）
└── plugin/                      # ★ 插件目录（热插拔，放在根目录）
    ├── keyword.ts               # 词库插件（多平台共用，唯一的业务逻辑）
    ├── example_demo.ts          # 示例插件（definePlugin 新写法，config 启用后生效）
    └── lib/                     # 插件共享依赖（子目录不会被当作插件加载）
        └── transEvent.ts        # 消息/通知/元事件文本转换（供 keyword 使用）
```

> 插件机制：`plugin/` 下每个 `.ts` 文件是一个插件（`_` 开头的跳过），config.json `plugins` 字段
> 控制启用（`"keyword": true`）；支持热插拔（新增/删除文件自动感知）与热重载（改动自动 reload，
> definePlugin 插件的定时器/监听/Skill 由内核自动清理）。共享依赖放 `plugin/lib/` 子目录。

## 配置热重载

**`config.json` 支持热重载**：保存后 0.8 秒自动生效，无需重启进程。

- **`bots` 数组变化** → 新增机器人自动启动；删除的机器人自动断开；已有机器人配置变更自动重建重连；
- **`plugins` 开关变化** → 自动启用/禁用对应插件（含动态加载此前未加载的插件）；
- JSON 格式错误时保持原配置继续运行，并在控制台打印错误。

> 注意：热重载只处理配置差异。修改 `hotReload` 本身不影响已运行的监听。
> 微信服务号等依赖服务器端回调 URL 的平台，配置变更重建适配器时会同步更新回调路由。

## 机器人开关与插件代理 API

- **bot 级开关**：每个机器人配置可加 `"enable": false` 临时停用（默认 true），热重载生效。
- **插件代理 API（`ctx.api`）**：插件以受控方式查机器人状态/收发统计、启停插件、启停/新增/移除机器人，
  不暴露内核原始对象。权限两道闸门：插件 `definePlugin` 声明 `apis` + config.json 该插件的 `apis` 白名单（取交集）。
  详见 `docs/API-Plugin.md`，示例见 `plugin/example_demo.ts`。

---

## 一、QQ（OneBot11）

已有适配器，把 QQ 接到任意 OneBot11 实现（如 **NapCat**、**Lagrange**、**LLOneBot**、**Go-CQHTTP** 等）。

### config.json 配置

```json
{
  "botId": "Van-None",
  "type": "onebot11",
  "mode": "ws_reverse",
  "port": 8080,
  "path": "/onebot/v1/ws",
  "token": ""
}
```

- `mode`：`ws_reverse`（框架做服务端，等你的一言 OneBot 客户端连上来）或 `ws_client`（框架主动连接，需配 `url`）
- `token`：与 OneBot 服务端一致，留空则不限
- 对接时把 NapCat 等配置为"反向 WebSocket"，地址填 `ws://127.0.0.1:8080/onebot/v1/ws`

**注意**：插件统一走新式 `definePlugin` + `ctx.reply(event, message)`（内核自动按会话能力降级）或 `bot.callApi(action, params)` 发送；所以 OneBot 适配器与 keyword 天然兼容，无需额外配置。

---

## 二、微信公众号 / 服务号

适配器 `src/adapter/wechat/` 已完成并与 keyword.ts 打通。支持：

- 接收：文本 / 图片 / 语音 / 视频 / 位置 / 链接 消息 + 关注/取关等事件
- 发送：通过**客服消息接口**发送（文本、图片、语音、视频；图片/语音自动上传素材库）
- 被动回复：可选，5 秒内返回 XML（见下文）

### config.json 配置

```json
{
  "botId": "WeChat-Official",
  "type": "wechat",
  "appId": "wxXXXXXXXXXXXX",
  "appSecret": "XXXXXXXXXXXXXXXXXXXXXXXX",
  "token": "你的服务器配置Token",
  "port": 8090,
  "path": "/wechat/callback",
  "passiveMode": true
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `appId` / `appSecret` | 是 | 公众号开发凭据 |
| `token` | 是 | 与微信后台「服务器配置」的 Token 完全一致，**不能为空** |
| `port` | 否 | 回调端口，默认 80（微信要求 http 用 80、https 用 443） |
| `path` | 否 | 回调路径，默认 `/wechat/callback` |
| `passiveMode` | 否 | 是否用被动回复（默认 `false`）。**未认证的公众号必须设为 `true`**，否则发消息会报 `48001 api unauthorized` |

### 关于 passiveMode（重要）

微信的「客服消息」接口**要求公众号通过微信认证**。未认证的订阅号/服务号调用会返回 `errcode:48001 api unauthorized`。

- `passiveMode: true`：机器人回复改用**被动回复**（消息进来 5 秒内返回 XML），**不需要认证也能用**，且没有客服消息的 48 小时限制。代价是回复必须在 5 秒内完成、且只能发文本（图片/语音会被丢弃）。
- `passiveMode: false`：走客服消息接口，需要认证的服务号；能发文本/图片/语音（图片语音会自动上传素材库）。

如果你的公众号已认证、想用客服消息（可发图片、无 5 秒限制），把 `passiveMode` 去掉或设为 `false` 即可。

### 微信公众平台后台配置（重要）

1. 登录微信公众平台 → 「设置与开发」→「基本配置」→「服务器配置」：
   - **URL**：`http://<你的公网域名或IP>:8090/wechat/callback`（必须是公网可访问，建议用 Nginx/花生壳 反代或内网穿透）
   - **Token**：与 config.json 里的 `token` 一致
   - **消息加解密方式**：明文模式（`encodingAESKey` 暂不支持加密模式，留空即可）
   - 点击「提交」→ 框架收到 GET 验证请求后自动通过
2. **IP 白名单**：在「基本配置 → IP 白名单」里加入你服务器的出口 IP，否则 `access_token` 获取会被拒绝（启动日志会报"获取 access_token 失败"）
3. **客服消息权限**：微信规定用户主动给公众号发消息后 **48 小时内**，公众号才能给该用户推送客服消息。超过 48 小时发送会报错，这是平台限制，无法绕过。

### 与 keyword.ts 的对接说明

- 微信没有"群"概念，所有消息都作为**私聊消息**（`private_message`）派发给插件；
- 适配器已把 `raw.sender`、`raw.message_id`、`raw.time` 补齐，和 OneBot11 的事件结构一致，keyword.ts 无需改动即可读取（`[用户名]`、`[消息id]`、`[时间戳]` 等变量都能用）；
- 插件回复的**多段消息**（如 `文字+图片`）会按顺序转成多条客服消息；文本会合并发送；
- 图片/语音：插件里 `[图片.图片地址]` 会生成 `base64://` 或 `http(s)://` 的图片段，适配器会自动把图片上传到微信临时素材库再发送，无需手动处理。

### 被动回复（可选进阶）

微信要求服务器在 5 秒内返回响应。keyword 的回复是异步的，默认走客服消息（更灵活）。若你想用"被动回复"（不依赖 48 小时窗口），可在自定义插件里这样用：

```ts
await bot.callApi("passive_reply", { user_id: "openid", content: "这是被动回复" })
```

框架会在微信 POST 回调的响应里直接返回该内容（5 秒内）。注意被动回复与 keyword 的自动回复不要同时用，避免冲突。

---

## 三、B 站直播间（新增）

适配器 `src/adapter/bilibili/`：**接收直播间弹幕 → 交给 keyword.ts → 以弹幕形式发回直播间**。

### 原理

- 接收：连接 B 站直播弹幕 WebSocket（`wss://broadcastlv.chat.bilibili.com/sub` 或 `getDanmuInfo` 下发的节点），30 秒心跳保活，解析 `DANMU_MSG`（弹幕）与 `SUPER_CHAT_MESSAGE`（醒目留言）
- 发送：`POST https://api.live.bilibili.com/msg/send` 发送弹幕（**需要机器人账号的 Cookie**，即机器人本人是房主/有发送权限）
- 直播间按"群聊"处理：`groupId = 房间号`，所以 keyword.ts 会用 `send_group_msg` 回弹幕，每个直播间独立使用一套词库/数据

### config.json 配置

```json
{
  "botId": "Bili-Live",
  "type": "bilibili",
  "roomId": 0,
  "cookie": "SESSDATA=...; bili_jct=...; buvid3=...; DedeUserID=...;",
  "csrf": "",
  "uid": 0,
  "color": 16777215,
  "mode": 1,
  "fontsize": 25,
  "ignoreSelf": true
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `botId` | 是 | 框架内唯一标识 |
| `type` | 是 | 固定 `"bilibili"` |
| `roomId` | 是 | 直播间号（短号/长号均可，启动时自动解析为真实房间号） |
| `cookie` | 接收可省/发送必填 | B 站登录 Cookie。填了才能发弹幕；不填也能收弹幕，但用户名会被打码、无法发送 |
| `csrf` | 否 | 默认自动从 cookie 的 `bili_jct` 取 |
| `uid` | 否 | 机器人账号 uid，不填会尝试用 cookie 自动获取 |
| `color` / `mode` / `fontsize` | 否 | 弹幕颜色 / 模式 / 字号，默认白色普通弹幕 |
| `ignoreSelf` | 否 | 默认 `true`，忽略机器人自己发的弹幕，防止"弹幕→回复→弹幕"死循环 |

### 获取 Cookie

1. 用机器人账号（**能发弹幕的号**）在浏览器登录 bilibili.com
2. F12 → Network → 随便刷新一个页面，找到任意请求的 `Cookie` 请求头，整段复制
3. 至少需要 `SESSDATA`（登录凭证）和 `bili_jct`（发送弹幕的 CSRF）

### 注意

- **发送弹幕**：机器人账号必须对该直播间有发送权限（通常是房主本人或房管），且需开启弹幕开关；发送频率过高会被 B 站风控
- 收到的礼物、进场、开播等消息目前不处理（只处理弹幕和醒目留言）
- 断线自动重连（默认 5 秒后），无需干预

---

## 三、QQ 官方机器人（新版官方协议，区别于 OneBot11）

适配器 `src/adapter/qq/`：走 QQ 开放平台官方机器人协议（WebSocket 网关 + REST 发送），**不需要 NapCat/go-cqhttp**。

### 原理

- 接收：主动连接官方网关 `wss://api.sgroup.qq.com`（自动获取），发送 `IDENTIFY` 鉴权（token = `QQBot {AppID}.{BotToken}`），按 intents 订阅事件；按 HELLO 下发周期心跳，断线自动重连 + `RESUME` 恢复会话
- 发送：`POST /v2/groups/{group_openid}/messages`（群）、`/v2/users/{openid}/messages`（单聊）
- 群 @ 消息 → `group_message`，单聊 → `private_message`；机器人被加群/删群/加好友等 → `notice`
- QQ 用 **openid**（字符串）不是 QQ 号，`userId`/`groupId` 都是 openid

### config.json 配置

```json
{
  "botId": "QQ-Official",
  "type": "qq",
  "appId": "102123456",
  "botToken": "xxxxxxxx",
  "intents": 33554432,
  "reconnectDelay": 5000
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `botId` | 是 | 框架内唯一标识 |
| `type` | 是 | 固定 `"qq"` |
| `appId` | 是 | QQ 开放平台机器人 AppID |
| `appSecret` | 是（与 botToken 二选一） | AppSecret，AppID+AppSecret 模式自动换取 access_token（7200s 有效） |
| `botToken` | 否（与 appSecret 二选一） | 群机器人令牌，`access_token = AppID.BotToken`，免换取 |
| `intents` | 否 | 事件订阅位，默认 33554432（群聊+单聊） |
| `gateway` | 否 | 网关地址，默认自动获取 |
| `reconnectDelay` | 否 | 断线重连毫秒，默认 5000 |

### 使用前准备

1. 到 [QQ 开放平台](https://q.qq.com/) 创建机器人，拿 AppID 和 BotToken
2. 把机器人加进测试群（≤20 人的群，需群主/管理员在"群设置→群机器人"里添加）
3. 控制台确认已勾选"机器人事件订阅"里的"群聊@消息 / 单聊消息"
4. 启动后，群里 @ 机器人发消息，或直接私聊机器人

详细 API 见 `docs/API-QQ.md`。

---

## 四、Telegram 官方机器人

适配器 `src/adapter/telegram/`：走 Telegram 官方 Bot API（getUpdates 长轮询接收），**不需要第三方框架**。

### 原理

- 接收：getUpdates 长轮询（offset/timeout），机器人主动连出，**无需公网回调**；自动处理 401（token 错）/ 409（重复轮询）
- 发送：sendMessage / sendPhoto / sendVoice / sendVideo / sendDocument（file_id / URL / base64 均支持）
- 私聊 → `private_message`，群聊 → `group_message`（groupId 为负数 chat.id），回调按钮 → `notice`

### config.json 配置

```json
{
  "botId": "TG-Bot",
  "type": "telegram",
  "token": "123456789:AAExXXX",
  "pollTimeout": 50,
  "reconnectDelay": 3000
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `botId` | 是 | 框架内唯一标识 |
| `type` | 是 | 固定 `"telegram"` |
| `token` | 是 | @BotFather 创建机器人拿到的令牌 |
| `pollTimeout` | 否 | 长轮询秒数，默认 50（上限 50） |
| `reconnectDelay` | 否 | 轮询出错重试毫秒，默认 3000 |

> ⚠️ Telegram 在国内不可直连，需在能访问 `api.telegram.org` 的环境运行。

详细 API 见 `docs/API-Telegram.md`。

---

## 五、KOOK（开黑啦）官方机器人

适配器 `src/adapter/kook/`：走 KOOK 开发者平台官方协议（WebSocket 网关 + HTTP 发送）。

- 接收：`GET /gateway/index` 拿网关 → WebSocket 连接 → HELLO 握手 → 每 30s PING 心跳；频道消息/私聊消息/系统事件转统一事件
- 发送：`/message/create`（频道，kmarkdown）、`/direct-message/create`（私聊）；图片需机器人上传的资源
- 频道消息 → `group_message`（groupId=频道id），私聊 → `private_message`

```json
{
  "botId": "KOOK-Bot",
  "type": "kook",
  "token": "你的KOOK机器人Token"
}
```

凭据在 [KOOK 开发者中心](https://developer.kookapp.cn/) 新建应用→机器人→连接模式选 WebSocket 获取。国内可直连。详细 API 见 `docs/API-Kook.md`。

---

## 六、Discord 官方机器人

适配器 `src/adapter/discord/`：走 Discord Bot API v10（WebSocket 网关 + REST 发送）。

- 接收：`GET /gateway` 拿网关 → WebSocket → IDENTIFY 鉴权（intents 订阅）→ 心跳 → MESSAGE_CREATE 转统一事件
- 发送：`POST /channels/{channel_id}/messages`（REST）
- 频道消息 → `group_message`（groupId=channel_id），私聊 → `private_message`

```json
{
  "botId": "DC-Bot",
  "type": "discord",
  "token": "你的DiscordBotToken",
  "intents": 37377
}
```

凭据在 [Discord Developer Portal](https://discord.com/developers/applications) 获取；**必须在 Bot 后台开启 Message Content Intent** 才能读消息正文。**国内需海外环境/代理**。详细 API 见 `docs/API-Discord.md`。

---

## 七、keyword.ts 发送统一为 `bot.callApi`

**重要变更**：keyword.ts 已彻底移除 `onebotApi(...)`，插件所有发送/调用统一走 `bot.callApi(action, params)`，且**只用一个 `send_msg`**——群聊传 `group_id`、私聊传 `user_id`，适配器自动路由。

```ts
// 群聊
await bot.callApi("send_msg", { group_id: gid, message })

// 私聊
await bot.callApi("send_msg", { user_id: uid, message })

// 或同时传（适配器优先取 group_id）
await bot.callApi("send_msg", { group_id: gid, user_id: uid, message })
```

### 消息格式（一份消息，全部平台）

`message` 支持三种写法，任何适配器都能识别：

```ts
// 1. 纯字符串
"你好"

// 2. 单段对象
{ type: "text", data: { text: "你好" } }

// 3. 段数组（多段，推荐）
[
  { type: "text", data: { text: "你好" } },
  { type: "image", data: { url: "https://..." } },
  { type: "at", data: { qq: "123456" } }
]
```

各适配器发送入口统一调用 `normalizeSegments()` 归一化，不认识的消息段用 `segmentsToText()` 兜底渲染成文本，**绝不崩溃**。常用段类型：`text` / `at` / `image` / `face` / `video` / `record` / `file` / `reply` / `markdown` / `button` 等。

> QQ 官方机器人专属：`markdown` 段/`[CQ:markdown]` 串可附带 `buttons`（或 `button` 段）发送带键盘的 markdown 消息，见 `docs/API-QQ.md`。插件 `#markdown` 命令支持按钮语法：`#markdown 内容 || 按钮A | 按钮B ;; 按钮C`。

每个适配器都实现了自己的 `callApi`，所以**同一份 keyword.ts 无需任何改动**即可在 QQ / Telegram / 微信 / B 站 / KOOK / Discord / OneBot11 之间切换。详见各适配器文档：

- `docs/API-QQ.md`（QQ官方机器人）
- `docs/API-Telegram.md`（Telegram）
- `docs/API-Kook.md`（KOOK）
- `docs/API-Discord.md`（Discord）
- `docs/API-OneBot11.md`（NapCat/onebot11）
- `docs/API-Wechat.md`（微信公众号）
- `docs/API-WeixinOC.md`（个人微信，openclaw-weixin/iLink）
- `docs/API-Bilibili.md`（B站直播间）
- `docs/API-Milky.md` / `docs/API-Satori.md`（Milky / Satori）
- `docs/能力矩阵.md`（各平台接收/发送能力一览）
- `docs/内核能力.md`（内核能力：能力体系/发送降级/事件归一化/definePlugin/Skill/Mock）

### 接收与发送能力：能获取到什么就接收，能做什么就支持

- **接收**：各适配器把平台推送的原始消息**全量解析**成统一消息段（文本/@/图片/视频/语音/文件/引用/转发/表情/卡片），不丢数据；昵称、消息 ID、群成员角色等都填进 `event.raw.sender`。
- **发送**：插件统一写 `send_msg` + 消息段，适配器各自转平台格式；某平台不支持的段**自动降级为文本**（`segmentsToText`），绝不崩溃、绝不发 `[object Object]`。
- 各平台具体支持哪些段、哪些事件，见 `docs/能力矩阵.md`。

### 配置项：`ignoreSelf`（所有适配器通用）

每个机器人配置里都可加 `ignoreSelf`，**默认 true**，用于忽略机器人自己发出的消息（防止自问自答死循环）：

```json
{ "botId": "DC-Bot", "type": "discord", "token": "...", "ignoreSelf": true }
```

- `true`（默认）：机器人自己发的消息不派发给插件。
- `false`：连自己发的消息也交给插件处理（一般不推荐）。
- 统一在 `BaseAdapter.emitEvent` 处理：比对事件里的 `selfId`（机器人真实 ID）与 `userId`（发送者 ID），相等即忽略。
- **QQ 官方机器人**：平台本身就不会推送机器人自己发出的消息，`ignoreSelf` 在 QQ 上基本不触发，属于冗余配置，但保留无妨。
- **Discord / KOOK / Telegram**：这些平台会（或可能）把机器人自己的消息推回来，`ignoreSelf: true` 能防止循环。

---

## 八、启动与验证

```bash
npm run dev        # 或直接双击 start.bat
```

启动日志应看到：

```
[配置] 已加载 N 个机器人实例
[启动] onebot11 适配器已启动: Van-None
[启动] wechat 适配器已启动: WeChat-Official
[启动] bilibili 适配器已启动: Bili-Live
[启动] qq 适配器已启动: QQ-Official
[启动] telegram 适配器已启动: TG-Bot
[启动] kook 适配器已启动: KOOK-Bot
[启动] discord 适配器已启动: DC-Bot
[插件] keyword 已启用
[启动] 已启用插件: keyword
[启动] VanBotJS 启动完成，等待事件...
```

## 九、keyword.ts 常用操作（多平台通用）

以同一个词库逻辑跑所有平台：

| 操作 | 说明 |
|---|---|
| 触发词条 | 在 `Van_keyword/<机器人selfId>/lexicon/default.json` 添加词条：`{"触发词": {"r": ["回复内容"], "s": 1}}`（s=1 精准，s=0 模糊） |
| 设主人 | 任意平台给机器人发 `#设置主人号 <你的平台ID>`（QQ 是 QQ 号，微信是 openid，B站是 uid；多个用英文逗号隔开） |
| 内置标签 | 回复内容支持 `[图片.url]`、`[艾特.qq]`、`[用户id]`、`[数据.xx]` 等，配置见 `Van_keyword/config.json` 的 `value` |

> 各平台的"机器人 ID"（决定数据目录 `Van_keyword/<selfId>/`）：
> - QQ：机器人 QQ 号
> - 微信：公众号原始 ID（`gh_xxxx`）
> - 个人微信：ilink_bot_id（扫码登录后生成，如 `xxx@im.bot`）
> - B站：机器人账号 uid

## 十、常见问题排查

| 现象 | 原因 / 解决 |
|---|---|
| `access_token` 获取失败 | 公众号后台没配 IP 白名单；appId/appSecret 填错 |
| 微信收不到消息 / 验证失败 | Token 不一致；URL 公网不可达；未用明文模式 |
| 微信超过 48 小时发不出消息 | 平台限制，需用户先主动发消息 |
| B 站能收弹幕不能发 | cookie 缺失或过期；账号无发送权限；风控 |
| B 站弹幕用户名是 `***` | 未带 cookie 接收，属正常隐私保护 |
| 端口占用 `EADDRINUSE` | 另一个实例已在跑，先停掉旧的再启动 |

## 十一、新增一个平台适配器（模板）

1. 在 `src/adapter/<name>/` 下新建 `types.ts` / `converter.ts` / `client.ts`；
2. `client.ts` 继承 `BaseAdapter`，实现 `connect()`、`disconnect()`、`callApi()`；
3. 收到平台消息时调用 `this.emitEvent("group_message"|"private_message", event)` 派发；`event` 里补 `raw.sender`、`raw.message_id`、`raw.time`；
4. `callApi` 里实现 `send_msg` / `send_group_msg` / `send_private_msg`（keyword 只依赖这三个）；
5. 在 `src/core/config.ts` 的类型联合里加上 `"<name>"`，在 `src/index.ts` 的 `createAdapter` 里加一个 `case`。
