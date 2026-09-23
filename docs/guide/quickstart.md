---
title: 快速上手
description: 安装、配置、启动 VanBotJS
---

# 快速上手

## 1. 安装依赖

需要 **Node.js ≥ 18**（含 npm）。项目使用 `tsx` 直接运行 TypeScript，无需先编译。

```bash
npm install
```

::: tip 依赖外置：主包很轻，平台依赖随适配器安装
框架主包只保留运行必需的最小依赖，**不内置任何平台 SDK**。每个适配器目录自带 package.json 声明自己的依赖，执行 `van adapter install <名称>` 时会自动安装，无需手动 npm i。

- 平台 SDK（如 douyin 的 playwright-core、icqq、mineflayer 等）在适配器连接时才**懒加载**；未安装或当前平台不支持（如 Termux/Android 无法运行浏览器内核）时只跳过该适配器并给出安装提示，不会导致整个框架启动崩溃。
- 删除适配器不会影响其它部分；想彻底清理其依赖可手动 `npm uninstall <包名>`。
:::

## 2. 编辑 config.json

配置你想接入的机器人（示例为 QQ 官方机器人）：

```json
{
  "bots": [
    {
      "botId": "QQ",
      "type": "qq",
      "enable": true,
      "appId": "102046363",
      "appSecret": "你的AppSecret",
      "intents": 33554432,
      "reconnectDelay": 5000,
      "ignoreSelf": true
    }
  ],
  "plugins": { "example_demo": true },
  "hotReload": true
}
```

## 3. 启动

```bash
van run        # 推荐：等价于 npm run dev（npx tsx src/index.ts）
```

也可直接：

```bash
npm run dev
```

启动后程序保持运行：加载插件 → 连接各适配器 → 监听事件。控制台打印每个机器人的连接状态。

### van 命令行（CLI）

项目自带 `van` 命令，`van` 是入口大目录，可运行框架、管理适配器：

```bash
van                      # 进入交互式主菜单（运行框架 / 查看 / 安装适配器）
van run                  # 运行框架
van adapter list         # 列出已安装 / 社区可安装的适配器
van adapter info <名称>  # 查看适配器详情
van adapter install <名称|序号>   # 从社区安装适配器（自动装依赖）
van adapter remove <名称>         # 移除本地适配器目录
van plugin list                  # 列出已安装 / 社区可安装的插件
van plugin install <名称|序号>     # 从社区安装插件
van plugin remove <名称>           # 移除本地插件
van -h                   # 查看帮助
```

::: tip 适配器社区源
适配器统一从社区安装，社区地址在 `config.json` 顶层 `adapterApi` 配置（完整清单 URL）：

```json
{
  "adapterApi": "https://bot.ziyi.asia/api/adapters",
  "pluginApi": "https://bot.ziyi.asia/api/plugins"
}
```

修改后无需重启框架，`van` 命令直接读取该配置。
:::

使用方式：

```bash
npm link                 # 全局注册 van 命令（之后可直接输入 van）
# 或临时使用：
node bin/van.mjs run
```

## 4. WebUI 控制台

框架内置可视化控制台（面向不会用命令行的用户），启动后访问 **http://127.0.0.1:8080** ：

- **系统状态**：CPU / 内存 / 平台 / 运行时间 / 全部平台收发统计
- **机器人**：在线状态、selfId、收发统计，可直接启停、添加、删除
- **插件**：启用状态，可直接启停

`config.json` 的 `webui` 字段可开关或换端口：

```json
"webui": { "enable": true, "port": 8080 }
```

修改后保存 config.json 热重载即生效（无需重启）。

::: tip 外网访问
WebUI 默认只监听 127.0.0.1（仅本机能开）。远程管理推荐 SSH 隧道，在你自己电脑执行 `ssh -L 8080:127.0.0.1:8080 用户@服务器IP`，再开 http://127.0.0.1:8080 即可，无需在服务器放行端口。若要长期用域名公网访问，请先用反向代理套上 HTTPS 和访问密码；当前控制台没有登录鉴权，不要直接把端口裸露到公网。
:::

## 5. 体验热重载

::: tip
修改 `config.json`（保存后约 0.8 秒自动生效）或 `plugin/*.ts`（改动自动 reload），都无需重启进程。程序内置单实例锁，同一目录不会重复启动。
:::
