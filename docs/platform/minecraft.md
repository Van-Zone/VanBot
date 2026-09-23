---
title: Minecraft
description: Minecraft 服务器聊天机器人（mineflayer）
---

# Minecraft

> 基于 [mineflayer](https://github.com/PrismarineJS/mineflayer) 的 MC 服务器聊天机器人适配器。连接离线 / 正版服务器，接收游戏内聊天并回复，附带建房 / 传送 / 丢包等指令（参考 `mc/` 目录示例脚本）。

---

适配器类型：`"minecraft"`　源码：`src/adapter/minecraft/`（types.ts / converter.ts / client.ts）
依赖：`mineflayer`、`mineflayer-pathfinder`、`vec3`（已加入框架依赖）

---

## 安装

```bash
van adapter install minecraft
```

---
## 1. 配置文件

```jsonc
{
  "botId": "MC",                     // 框架内唯一标识（任意起名）
  "type": "minecraft",               // 适配器类型固定为 minecraft
  "host": "mc.ziyi.asia",            // 服务器地址（必填）
  "port": 25565,                     // 可选，服务器端口，默认 25565
  "username": "VanBot",              // 可选，机器人游戏名，默认 "VanBot"
  "auth": "offline",                 // 可选，offline（离线）/ microsoft（正版）/ mojang，默认 offline
  "version": "1.20.1",               // 可选，游戏版本，留空自动协商
  "ignoreSelf": true                 // 可选，默认 true，忽略机器人自己发的消息
}
```

> **依赖**：mineflayer 已加入框架依赖，正常 `npm install` 即可。若手动删除过依赖，需执行 `npm i mineflayer mineflayer-pathfinder vec3`。
> **兼容**：mineflayer 按需动态加载，未安装依赖或加载失败时跳过该适配器，不影响其它平台启动。

---

## 2. 能接收的事件（全部已派发）

| 服务器事件 | 框架事件 | 说明 |
|---|---|---|
| 玩家聊天 `chat` | `private_message` | 玩家在游戏内发言，`userId` = 玩家名 |
| 系统消息 `message` | `private_message` | 死亡 / 成就 / 系统提示等 |
| 玩家加入 `playerJoined` | `notice` | 玩家进入服务器，控制台同步显示 |
| 玩家退出 `playerLeft` | `notice` | 玩家离开服务器 |
| 玩家死亡 `playerDied` | `notice` | 玩家在游戏内死亡 |
| 进度/成就 `advancement` | `notice` | 1.12+ 玩家达成进度或成就 |
| 旧版成就 `playerAchievement` | `notice` | 1.11 及以下版本成就 |
| 机器人死亡 `death` | `notice` | 机器人自身死亡 |
| 机器人重生 `respawn` | `notice` | 机器人重生 |
| 生命值/饥饿值变化 `health` | `notice` | 机器人血量或饥饿值变化 |

事件对象（`BotEvent`）字段：
```ts
{
  botId: "MC",
  selfId: "VanBot",                  // 机器人游戏名
  userId: "Steve",                   // 发言玩家名（服务器事件为相关玩家）
  groupId: undefined,                // MC 聊天为全局广播，无群概念
  message: [{ type: "text", data: { text: "你好" } }],
  postType: "private_message" | "notice",
  raw: { player, msg, platform: "minecraft", notice_type: "player_join", ... }
}
```

> **服务器事件显示**：玩家加入/退出/死亡/成就等事件会在控制台打印（如 `[MC MC] 玩家加入: Steve`），同时派发为 `notice` 事件供插件处理。日志插件若需显示 notice 事件，可在 `onEvent` 中增加 `postType === "notice"` 的判断。

**消息段**：仅 `text`（MC 聊天只有纯文本）。

> **说明**：Minecraft 聊天是全局广播，统一按私聊事件派发，方便插件逻辑统一处理。机器人自己的消息会被 `ignoreSelf` 过滤，防止循环。

---

## 3. 发送 API（插件内统一 `bot.callApi`）

### 3.1 发送聊天

MC 聊天为全局广播，三种 action 等价（目标字段可省略）：

```ts
// 群聊 / 私聊 / 通用，均可（MC 无群，都会调用 bot.chat）
await bot.callApi("send_msg", { message: "大家好，我是机器人" })
await bot.callApi("send_private_msg", { user_id: "Steve", message: "你好" })
await bot.callApi("send_group_msg", { group_id: "0", message: "你好" })
```

`message` 支持字符串或消息段数组，非文本段会转为占位文本：

```ts
{ type: "text", data: { text: "文本" } }
{ type: "image", data: { file: "http://x.png" } }   // → [图片:http://x.png]
```

### 3.2 建房 / 传送 / 丢包指令（参考 `mc/bot.js`）

```ts
await bot.callApi("house")          // 泥土小屋（默认 5x5、墙高 3）
await bot.callApi("houseWood")      // 橡木木板小屋
await bot.callApi("undo")           // 撤销拆除上一次建造的房子
await bot.callApi("tp", { player: "Steve" })   // 传送到指定玩家身边
await bot.callApi("dropAll")        // 丢弃背包全部物品
```

可在 config 里调大小：`"houseSize": 7, "wallHeight": 4`。

### 3.3 其他 API

```ts
await bot.callApi("get_me")   // 返回 { botId, selfId, host, port, online }
```

---

## 4. 常见问题

- **连不上服务器**：检查 `host` / `port` / `version` 是否正确；离线服务器用 `auth: "offline"`，正版用 `"microsoft"` 或 `"mojang"`。
- **提示缺 mineflayer 依赖**：执行 `npm i mineflayer mineflayer-pathfinder vec3` 后重启。
- **机器人建房失败**：建房区域必须是空地，被方块挡住会提示"有方块挡住"。
- **机器人被踢出**：控制台会打印踢出原因（`kicked`），常见于服务器封禁 / 同名冲突。
- **断线重连**：与服务器断开后自动按 `reconnectDelay`（默认 5000ms）重连。

---

## 5. 相关文档

- mineflayer 官方文档：`https://github.com/PrismarineJS/mineflayer`
- mineflayer-pathfinder：`https://github.com/PrismarineJS/mineflayer-pathfinder`
- 参考脚本：本项目 `mc/bot.js`（独立建房机器人示例）
