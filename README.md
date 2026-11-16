<div align="center">

![LOGO](http://bot.ziyi.asia/VanBot_logo.png)

**VanBotJS**

多平台机器人框架

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg?style=flat-square)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![QQ Group](https://img.shields.io/badge/QQ%E7%BE%A4-1019070322-12B7F5?style=flat-square&logo=tencentqq)](https://qm.qq.com/q/7jXfN4yGzB)

</div>

VanBotJS 是一个多平台机器人框架。内核不直接对接平台，平台协议放在适配器里。消息进来先转成统一的 `BotEvent`，再交给插件；插件按会话能力处理，不需要到处写 `if (platform === ...)`。

同一份插件可以接多个平台，但具体能用到什么程度，要看对应适配器支持哪些消息类型。平台不支持的段，内核会在发送时降级或替换成文本。

## 目前有的东西

- 适配器按需安装，内核不内置任何平台。
- 接收消息统一做归一化：ID 转字符串、时间统一、未知段保留占位，整条链路带 `traceId`。
- 会话能力按群聊、私聊分别计算，插件判断能力，不判断平台。
- 发送时按能力降级，平台不支持的图片、按钮等段不会原样丢过去。
- 内置 WebUI：机器人、插件、实时事件、终端日志、消息测试都能在浏览器里操作。
- WebUI 里有开发页，可以贴代码或让 AI 写插件，保存后直接加载。
- `config.json` 改动会自动重载；插件支持热重载。
- 适配器安装或更新后需要重启框架，因为适配器只在启动时扫描加载。

## 支持的平台

社区适配器目前有这些，实际以 `van adapter list` 为准：

- QQ：`qq`（官方机器人）、`onebot11`
- 微信：`wechat`（公众号）、`weixin_oc`、`wechat_db`
- B 站：`bilibili_live`、`bilibili_ck`
- 抖音：`douyin_ck`
- 微博：`weibo_ck`
- 其他：`telegram`、`discord`、`kook`、`satori`、`milky`、`minecraft`、`sandbox`

`sandbox` 是本地测试用的模拟环境，不连接真实平台。

注意：不是所有适配器都能在任意系统上跑。抖音发送依赖本机的 `.signer` 浏览器，微博、微信数据库这类适配器也依赖桌面环境或本机数据；Termux 上更适合 Telegram、Discord、KOOK、OneBot11、Satori、Milky、Sandbox 这类纯 HTTP / WebSocket 适配器。

## 快速开始

源码在仓库的 `develop/` 目录，下面的命令都在这个目录里执行。

```bash
git clone https://github.com/ZiYiQuQ/VanBot.git VanBotJS
cd VanBotJS/develop
npm install

cp config.example.json config.json
# Windows: copy config.example.json config.json
```

启动：

```bash
npm run dev
```

启动后看窗口里打印的控制台地址。源码默认是 `http://127.0.0.1:8080/`，发布包默认是 `8888`；端口被占用时框架会自动往后找，最终以日志里的地址为准。第一次打开要设置访问密码。

安装平台适配器：

```bash
./van adapter list
./van adapter install qq
```

Windows 下把 `./van` 换成 `van.bat`。装完适配器重启框架，然后在 WebUI 的机器人页添加机器人、填凭据。

如果不想自己装源码，可以直接用 Releases 里的压缩包：

- Windows 双击 `start.bat`
- Linux / macOS 执行 `./start.sh`，macOS 也可以双击 `start.command`
- Termux 可以执行：

```bash
curl -fsSL http://bot.ziyi.asia/JSver/install_vanbot.sh | bash
cd ~/vanbot
npm run dev
```

发布包第一次启动会自动安装当前系统需要的依赖，并生成 `config.json`。不要把 Windows 的 `node_modules` 直接复制到 Linux 或 Termux，`tsx` / `esbuild` 的平台包不一样。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `van run` | 启动框架 |
| `van adapter list` | 查看已安装和社区可安装的适配器 |
| `van adapter info <名称>` | 查看适配器详情 |
| `van adapter install <名称>` | 安装适配器，并安装它自己的依赖 |
| `van adapter remove <名称>` | 删除本地适配器 |
| `van plugin list` | 查看已安装和社区可安装的插件 |
| `van plugin info <名称>` | 查看插件详情 |
| `van plugin install <名称>` | 安装插件 |
| `van plugin remove <名称>` | 删除本地插件 |
| `van -h` / `van -v` | 帮助 / 版本 |
| `van` | 交互式菜单 |

Windows 下用 `van.bat`。

## 适配器依赖

每个适配器目录里有自己的 `package.json`，平台 SDK 写在那个文件里。安装适配器时 CLI 会一起装依赖，内核包只保留运行必需的东西。平台 SDK 到连接时才加载，没装的平台不会影响其他适配器启动。

## 写插件

市场插件是单个文件，放在 `plugin/<名字>.ts`。开发页写的插件放在 `dev/<名字>/index.ts`，可以带子文件。

一个能跑的最小例子：

```ts
import { definePlugin } from "../src/core/pluginContext.js"

export default definePlugin(
  {
    name: "hello",
    version: "1.0.0",
    description: "收到 hello 就回复",
    requiresCapabilities: ["text"],
  },
  (ctx) => ({
    onEvent: async (event) => {
      const text = event.message
        ?.filter((seg) => seg.type === "text")
        .map((seg) => String(seg.data?.text ?? ""))
        .join("")

      if (text === "hello") {
        await ctx.reply(event, "Hello, VanBotJS!")
      }
    },
  }),
)
```

然后在 `config.json` 里启用：

```json
{
  "plugins": {
    "hello": true
  }
}
```

插件里需要判断平台差异时，优先看 `event.getCapabilities()` 或 `ctx.hasCapabilities()`，不要直接判断平台名。需要调机器人、插件、统计之类的接口，先在 `definePlugin` 的 `apis` 里声明，再在 `config.json` 里给白名单，运行时通过 `ctx.api` 调用。

## 目录

```text
src/
  core/        内核：事件、发送、能力、插件、WebUI
  adapter/     适配器，一个平台一个目录
  testing/     MockAdapter，测试插件用
  types/       类型补充
plugin/        市场插件，单文件
dev/           开发页插件，一插件一个目录
bin/van.mjs    CLI
test/          内核测试
docs/          文档站
data/          运行数据、日志、插件历史版本
```

`config.json`、`data/`、`node_modules/` 不要提交到仓库，也不要发给别人。`config.json` 里通常有 token、Cookie 或密钥。

## 社区

- 文档站：http://bot.ziyi.asia
- QQ 群：1019070322（[加群链接](https://qm.qq.com/q/7jXfN4yGzB)）
- Issue：https://github.com/ZiYiQuQ/VanBot/issues

## 贡献

Issue 和 PR 都可以。改代码前先在 `develop/` 里 `npm install`，提交前跑一下：

```bash
npm run typecheck
npm test
```

## License

[AGPL-3.0](./LICENSE)

## 参考

微信数据库解析部分参考了这几个项目：

- [WeChatDataAnalysis](https://github.com/LifeArchiveProject/WeChatDataAnalysis)
- [wechat4-db-decryptor](https://github.com/2809728882/wechat4-db-decryptor)
- [wx-view](https://github.com/recarto404/wx-view)
