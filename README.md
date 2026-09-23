<div align="center">

![LOGO](http://bot.ziyi.asia/VanBot_logo.png)

**多平台机器人框架** · 一个插件跑全平台

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg?style=flat-square)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Version](https://img.shields.io/badge/version-1.0.0-8A2BE2?style=flat-square)]()
[![QQ Group](https://img.shields.io/badge/QQ%E7%BE%A4-1019070322-12B7F5?style=flat-square&logo=tencentqq)](https://qm.qq.com/q/7jXfN4yGzB)

---

内核负责统一事件模型、会话能力（capabilities）、发送侧自动降级、中间件流水线与插件系统；各平台以**可插拔适配器**形式按需安装，一份插件可运行在全部平台，业务代码不需要判断平台。

</div>

## ✨ 特性

| | |
|---|---|
| 🔌 **适配器可插拔** | 不内置任何平台，通过 CLI 从社区按需安装，依赖随适配器隔离 |
| 🧩 **会话粒度能力体系** | 按群 / 私聊上报能力，插件只判断能力、不写平台分支 |
| 📉 **发送侧自动降级** | 消息段声明 `capabilities` 与 `fallback`，内核发送前自动替换或丢弃不支持的组件 |
| 🔄 **统一接收管道** | ID 字符串化、时间归一、未知段占位、全局 `traceId` 贯穿收发与日志 |
| 🔥 **插件热插拔 / 热重载** | 洋葱中间件、受控代理 API（插件需声明并在 config 白名单授权） |
| 🖥️ **内置 WebUI 控制台** | 系统状态、机器人 / 插件启停，浏览器即可管理 |
| 🪶 **零重型绑定** | 平台 SDK 全部懒加载，未安装或平台不支持时只跳过对应适配器，不拖垮框架 |

## 🌐 支持的平台及通信协议

> 通过社区适配器按需安装，内核本身不绑定任何平台。

![QQ](https://img.shields.io/badge/QQ-qq-12B7F5?style=flat-square&logo=tencentqq)
![微信](https://img.shields.io/badge/微信-wechat-07C160?style=flat-square&logo=wechat)
![Telegram](https://img.shields.io/badge/Telegram-telegram-26A5E4?style=flat-square&logo=telegram&logoColor=white)
![Discord](https://img.shields.io/badge/Discord-discord-5865F2?style=flat-square&logo=discord&logoColor=white)
![KOOK](https://img.shields.io/badge/KOOK-kook-7433FF?style=flat-square)
![抖音](https://img.shields.io/badge/%E6%8A%96%E9%9F%B3-douyin-000000?style=flat-square&logo=tiktok)
![B站直播](https://img.shields.io/badge/B%E7%AB%99%E7%9B%B4%E6%92%AD-bilibili_live-00A1D6?style=flat-square&logo=bilibili)
![Minecraft](https://img.shields.io/badge/Minecraft-minecraft-62B47A?style=flat-square&logo=minecraft&logoColor=white)
![OneBot11](https://img.shields.io/badge/OneBot11-onebot11-FF6B6B?style=flat-square)
![Satori](https://img.shields.io/badge/Satori-satori-FF6B6B?style=flat-square)
[![Milky](https://img.shields.io/badge/Milky-milky-FFA500?style=flat-square)](https://milky.ntqqrev.org/)
![Sandbox](https://img.shields.io/badge/Sandbox-sandbox-999?style=flat-square)

## 🚀 快速开始

### 环境要求

- Node.js >= 18（依赖全局 `fetch`）
- 能访问社区源（默认 `http://bot.ziyi.asia`，可在 config 中修改）

### 安装

```bash
# 克隆并安装依赖（仅内核依赖，体积小）
git clone https://github.com/ZiYiQuQ/VanBot.git VanBotJS
cd VanBotJS
npm install

# 准备配置（真实 config.json 含密钥，已被 .gitignore 忽略）
cp config.example.json config.json
```

> Linux / Termux 也可一键安装：`curl -fsSL http://bot.ziyi.asia/JSver/install_vanbot.sh | bash`

### 运行

```bash
# 1. 查看社区可安装的适配器
van adapter list

# 2. 安装需要的平台（自动安装该适配器依赖）
van adapter install qq

# 3. 编辑 config.json，填入对应平台凭据并把 enable 改为 true

# 4. 启动
van run
# 或本地开发模式（tsx 直跑 TS）
npm run dev
```

启动后访问 **WebUI 控制台**：http://127.0.0.1:8080 （端口 / 开关在 `config.json` 的 `webui` 字段）。

## 🛠️ CLI

| 命令 | 作用 |
| --- | --- |
| `van run` | 运行框架 |
| `van adapter list / info <名>` | 适配器列表 / 详情 |
| `van adapter install <名>` | 从社区安装适配器并自动装依赖 |
| `van adapter remove <名>` | 移除本地适配器 |
| `van plugin list / info <名>` | 插件列表 / 详情 |
| `van plugin install <名>` | 从社区安装插件到 `plugin/` |
| `van plugin remove <名>` | 移除本地插件 |
| `van -h` / `van -v` | 帮助 / 版本 |
| `van` | 交互式菜单 |

## 📦 适配器依赖隔离

每个适配器目录自带 `package.json`，在 `dependencies` 中声明该平台所需的外部包；内核主包只保留运行必需的最小依赖。安装适配器时 CLI 会自动安装这些依赖；平台 SDK 在适配器连接时才懒加载，因此未安装的平台既不会增加体积，也不会影响其他平台启动。

## 🧩 插件开发

插件放在项目根目录 `plugin/<name>.ts`，通过 `definePlugin` 声明元数据（名称、所需能力、受控代理 API 等）。修改 `config.json` 的 `plugins` 字段即可热启停。

```ts
import { definePlugin } from "./src/core/plugin.js"

export default definePlugin({
  name: "hello",
  description: "示例插件",
  match: (e) => e.raw_message === "hello",
  handler: async (e) => {
    await e.reply("Hello, VanBotJS!")
  },
})
```

详见文档站「开发」章节。

## 📁 项目结构

```
src/
  core/        内核：事件/发送管道、能力体系、插件系统、WebUI、代理 API
  adapter/     适配器（按需安装，目录名 = config 中的 type）
  testing/     MockAdapter，供插件单元测试
  types/       类型补充声明
plugin/        用户插件（不随框架内置）
bin/van.mjs    CLI
docs/          VitePress 文档站与社区
test/          内核单元测试
```

## 💬 社区与交流

- **文档站**：http://bot.ziyi.asia
- **QQ 官方群**：[1019070322](https://qm.qq.com/q/7jXfN4yGzB) — 问题反馈、插件分享、适配器开发交流
- **GitHub Issues**：[提交 Bug / 功能建议](https://github.com/ZiYiQuQ/VanBot/issues)

## 🤝 贡献

欢迎提交 Issue 与 Pull Request！

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feat/your-feature`
3. 提交改动：`git commit -m 'feat: add something'`
4. 推送分支：`git push origin feat/your-feature`
5. 发起 Pull Request

提交前请运行 `npm run typecheck` 确保类型检查通过。

## 📄 License

[AGPL-3.0](./LICENSE) © 2026 VanBotJS Contributors

## 🙏 参考项目

- [WeChatDataAnalysis](https://github.com/LifeArchiveProject/WeChatDataAnalysis) — 微信 4.x 数据库解密与消息解析参考
- [wechat4-db-decryptor](https://github.com/2809728882/wechat4-db-decryptor) — 微信进程内存扫描数据库密钥方案
- [wx-view](https://github.com/recarto404/wx-view) — 微信消息类型与二进制内容解析参考

---

<div align="center">

如果这个项目对你有帮助，欢迎点个 ⭐ Star 支持一下！

</div>
