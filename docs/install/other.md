---
title: 其他平台与常见问题
description: macOS / Docker / 软路由 等部署与跨平台 FAQ
---

# 其他平台与常见问题

## macOS

与 Linux 相同：

```bash
# 安装 Node（用 Homebrew）
brew install node

cd VanBotJS
npm install
van run
```

## Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=optional
COPY . .
CMD ["npx", "tsx", "src/index.ts"]
```

```bash
docker build -t vanbot .
docker run -d --name vanbot -v "$PWD/config.json:/app/config.json" -v "$PWD/data:/app/data" -p 8080:8080 vanbot
```

## 软路由 / 随身 WiFi / NAS（Linux arm 设备）

与 Linux 安装相同，注意：

- arm 架构下 `skia-canvas` 等原生依赖可能装不上，会被自动忽略；
- 内存较小的设备建议只启用 1–2 个机器人；
- douyin 适配器需要浏览器，此类设备直接 `enable: false`。

## 跨平台常见问题

### 收不到消息 / 发不出去

- **微信服务号**：回调 URL 必须 http(s)，官方要求 80/443 端口；`Invalid signature` 通常是 URL 没带 `?echostr` 验签或 token 不一致。
- **QQ 官方**：群消息需 @ 机器人才收到，去开放平台开启"接收所有消息"；intents 掩码要包含所需事件。
- **Discord**：机器人开关全开仍收不到 → 检查 `MESSAGE_CONTENT` 特权 intent 是否在后台开启；发送 `Unknown Channel` → 检查权限 / 频道 ID。
- **抖音**：无头模式可能收不到消息，建议有头并打开右上角"消息"面板；收到的文本末尾若带数字是未读数（已结构化提取）。
- **个人微信 weixin_oc**：识别场景是私聊；需要手机微信含 ClawBot 插件并扫码登录。

### 权限与热重载

- "无权调用高级 API"：插件未声明 `apis` 或 config 白名单未允许 → 补声明 / 白名单即可；
- 改 config 后未生效：等待约 0.8 秒防抖；JSON 报错会保持原配置并打印。

### 其它

- **程序闪退**：单个适配器连接失败不影响整体（打印错误继续运行）；
- **单实例锁**：`.vanbot.lock` 防止同一目录重复启动；重复启动的实例会自动退出。
