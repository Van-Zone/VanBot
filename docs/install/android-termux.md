---
title: Android（Termux）安装
description: 在手机 Termux 上运行 VanBotJS
---

# Android（Termux）安装

VanBotJS 纯 Node 运行，可以在手机 Termux（Android 终端模拟器）上跑。先在 [F-Droid](https://f-droid.org/) 或 [GitHub](https://github.com/termux/termux-app) 安装 Termux。

## 1. 一键安装

打开 Termux，执行：

```bash
curl -fsSL http://bot.ziyi.asia/JSver/install_vanbot.sh | bash
```

脚本会自动安装 Node.js、git 等依赖，拉取项目到 `~/VanBotJS` 并安装依赖。

> `skia-canvas` 是可选原生依赖，在 Android 上编译失败会被自动忽略（依赖它的插件降级为文本输出），**不影响运行**。

## 2. 启动

```bash
cd ~/VanBotJS
npx tsx src/index.ts
```

`tsx` 不做类型检查，type-only 导入运行时零加载，手机也能跑。

## 3. 防后台被杀

```bash
termux-wake-lock      # 阻止系统休眠 / 杀后台
```

## 平台注意事项

- **douyin 适配器在 Termux 必须设 `enable: false`**：它依赖 playwright + 真实浏览器（Windows 的 Edge），Android 无此环境。框架已做动态加载——即使忘记关，加载失败也会被捕获并跳过，不会闪退；
- Termux 若报 `Unsupported platform: android`：来自 `playwright-core`，只要不启用 douyin 就不会加载；
- 手机端建议连接 WiFi、关闭省电限制，微信服务号回调等需要公网地址的平台配合内网穿透使用。
