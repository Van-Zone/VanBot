---
title: 个人微信（wechat_db）
description: 直读微信 4.x 加密数据库，接收消息 + 模拟键鼠发送
---

# 个人微信（wechat_db）

> 直读微信 4.x 桌面版的加密 SQLite 数据库，实时接收消息；通过模拟键鼠实现发送消息。无需 Hook、无需注入，兼容性好。

---

适配器类型：`"wechat_db"`　源码：`src/adapter/wechat_db/`
协议：微信 4.x 本地数据库（WCDB 魔改版 SQLCipher）+ Windows 模拟键鼠发送。

---

## 特点

- ✅ 直读数据库，不注入、不 Hook，不影响微信正常运行
- ✅ 支持私聊、群聊消息接收
- ✅ 支持文本、图片、语音、视频、文件发送（模拟键鼠）
- ✅ **自动获取数据库密钥**（运行中扫描微信进程内存，无需手动填写）
- ✅ 自动解密数据库（内置 SQLCipher 解密逻辑）
- ✅ 自动加载联系人映射（群名、昵称）

---

## 1. 数据库密钥

适配器默认会**自动获取**数据库密钥，无需手动填写：启动时若微信桌面版正在运行且已登录，会扫描微信进程内存并结合 `Weixin.dll` 还原出 64 位密钥，再用数据库首页 HMAC 校验，全程约数秒。

- 自动获取为**默认行为**，配置里的 `key` 仅作为**备用**（自动获取失败时兜底，例如微信未运行）。
- 原理参考 [WeChatDataAnalysis](https://github.com/LifeArchiveProject/WeChatDataAnalysis)：内存中存放的是 `raw_key = passphrase XOR internal_db_key`，`internal_db_key` 从 `Weixin.dll` 代码段特征提取，二者异或还原后做 PBKDF2/HMAC 校验。
- 自动获取依赖可选原生 FFI 库 **koffi**（`npm install koffi`），仅 Windows 可用。
- 如不希望自动获取，可设置 `"autoGetKey": false`，此时必须手动填写 `key`。

手动获取密钥的备用方式：用 WeChatDataAnalysis、PyWxDump 等工具扫描微信进程内存，得到 64 位十六进制字符串（32 字节）填入 `key`。

---

## 2. 配置文件

```jsonc
{
  "botId": "WeChatDB",
  "type": "wechat_db",
  "selfWxid": "wxid_xxxxxxxxxxxxxxxx",      // 你的微信 wxid
  "selfWxname": "你的微信昵称",              // 微信窗口标题（用于激活窗口，建议配置）
  "dataDir": "C:/Users/你的用户名/Documents/xwechat_files/wxid_xxxxxxxxxxxxxxxx_xxxx",  // 微信数据目录
  // "key": "4de39ed4....",                 // 数据库密钥（64位hex），默认自动获取，仅备用
  // "autoGetKey": true,                    // 是否自动从微信进程内存获取密钥，默认 true
  // "wechatInstallPath": "",               // 微信安装目录（可选，正常情况下自动探测）
  "pollInterval": 1000,                     // 轮询间隔（毫秒），默认 1000
  "ignoreSelf": true                        // 是否忽略自己发的消息，默认 true
}
```

### 配置说明

| 配置项 | 必填 | 说明 |
|---|---|---|
| `selfWxid` | ✅ | 你的微信 wxid（如 `wxid_xxx`） |
| `selfWxname` | 推荐 | 你的微信昵称（窗口标题），用于准确激活微信窗口 |
| `dataDir` | ✅ | 微信数据目录（`xwechat_files/wxid_xxx_xxxx`） |
| `key` | 可选 | 数据库解密密钥（64 位 hex）；默认自动获取，此项仅在自动获取失败时作为备用 |
| `autoGetKey` | 可选 | 是否自动扫描微信进程内存获取密钥，默认 `true`；设为 `false` 时必须填写 `key` |
| `wechatInstallPath` | 可选 | 微信安装目录/`Weixin.exe`/`Weixin.dll` 路径，默认自动探测，探测失败时手动指定 |
| `pollInterval` | 可选 | 轮询间隔，默认 1000ms |
| `ignoreSelf` | 可选 | 忽略自己发的消息，默认 true |

---

## 3. 能接收的事件

| 消息类型 | 框架事件 | 说明 |
|---|---|---|
| 私聊文本 | `private_message` | `userId`=对方 wxid |
| 群聊文本 | `group_message` | `groupId`=群号，`userId`=发送者 wxid |
| 图片/语音/视频/表情 | 同上 | 显示为 `[图片]`、`[语音]` 等占位符 |

---

## 4. 发送 API

### 4.1 发送文本

```ts
// 私聊
await bot.sendPrivateMsg("wxid_xxx", "你好")

// 群聊
await bot.sendGroupMsg("xxx@chatroom", "大家好")
```

### 4.2 发送图片

```ts
// 本地文件
await bot.sendPrivateMsg("wxid_xxx", [
  MessageSegment.text("这是一张图片："),
  MessageSegment.image("C:/path/to/image.png")
])

// Base64
await bot.sendPrivateMsg("wxid_xxx", [
  MessageSegment.image("base64://iVBORw0KGgoAAAANSUhEUgAA...")
])
```

### 4.3 发送文件/语音/视频

```ts
// 语音（当文件发送）
await bot.sendPrivateMsg("wxid_xxx", [
  MessageSegment.record("C:/path/to/audio.mp3")
])

// 视频
await bot.sendPrivateMsg("wxid_xxx", [
  MessageSegment.video("C:/path/to/video.mp4")
])

// 文件
await bot.sendPrivateMsg("wxid_xxx", [
  MessageSegment.file("C:/path/to/document.pdf")
])
```

---

## 5. 查询 API（`bot.callApi`）

适配器直读数据库，提供以下查询接口：

### 5.1 获取联系人列表

```ts
const contacts = await bot.callApi("get_contacts")
// 返回: [{ username: "wxid_xxx", nick_name: "昵称", is_group: false }, ...]
```

### 5.2 获取群成员列表

```ts
const members = await bot.callApi("get_group_members", {
  group_id: "xxx@chatroom"
})
```

### 5.3 获取聊天历史

```ts
const messages = await bot.callApi("get_history", {
  talker: "wxid_xxx",  // 对方 wxid 或群号
  limit: 50            // 条数，默认 50
})
```

### 5.4 获取收藏列表

```ts
const favorites = await bot.callApi("get_favorites", {
  limit: 50
})
```

### 5.5 获取朋友圈

```ts
const moments = await bot.callApi("get_moments", {
  limit: 50
})
```

### 5.6 获取群公告

```ts
const announcement = await bot.callApi("get_group_announcement", {
  group_id: "xxx@chatroom"
})
```

### 5.7 获取表情列表

```ts
const emoticons = await bot.callApi("get_emoticons", {
  limit: 50
})
```

### 5.8 获取公众号列表

```ts
const bizList = await bot.callApi("get_biz_contacts")
```

### 5.9 获取联系人标签

```ts
const labels = await bot.callApi("get_contact_labels")
```

---

## 6. 工作原理

1. **获取密钥**：默认扫描运行中的微信进程内存，结合 `Weixin.dll` 还原并校验数据库密钥（失败则回退配置中的 `key`）
2. **数据库解密**：用密钥逐页 AES-256-CBC 解密微信数据库
3. **监听新消息**：监听 WAL 文件变化并重新解密，查询比上次更新的消息
4. **联系人映射**：从 contact.db、session.db 加载联系人，建立 hash → 昵称映射
5. **发送消息**：模拟键鼠操作 —— 激活微信窗口 → Ctrl+F 搜索聊天对象 → 粘贴消息 → 回车发送

---

## 7. 常见问题

- **自动获取密钥失败**：确认微信桌面版已启动并登录；安装依赖 `npm install koffi`；若微信装在非默认目录，配置 `wechatInstallPath`；仍失败可手动获取后填入 `key`
- **收不到消息**：检查密钥是否正确、dataDir 路径是否正确
- **发送消息打开企业微信**：配置 `selfWxname` 为你的微信昵称，按窗口标题激活
- **接收消息延迟**：微信攒批写入 WAL，纯磁盘直读约有数秒延迟（文件变化是实时的，但消息内容需等微信提交事务）
- **图片/语音显示为二进制**：正常，目前只显示类型占位符，不解析内容
- **多数据库**：微信按时间段分库（message_0.db, message_1.db...），目前只轮询 message_0.db

---

## 8. 相关项目

- [WeChatDataAnalysis](https://github.com/LifeArchiveProject/WeChatDataAnalysis)：微信数据库解密参考
- [wx-view](https://github.com/recarto404/wx-view)：微信消息查看工具
