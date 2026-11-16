# AGENTS.md

这个仓库是 VanBotJS，多平台机器人框架。仓库根目录没有 `package.json`，框架源码在 `develop/`，所有 npm 命令都要先进入这个目录执行。

## 目录

- `develop/src/core/`：内核。事件模型、能力体系、发送降级、插件管理、WebUI、代理 API 都在这里。
- `develop/src/adapter/`：适配器。一个平台一个目录，目录名就是 `config.json` 里的 `type`。
- `develop/plugin/`：市场插件。这里是扁平的单文件插件，例如 `plugin/keyword.ts`。
- `develop/dev/`：开发页插件。一个插件一个目录，入口固定 `index.ts`，可以带子文件。
- `develop/test/`：内核测试。
- `develop/docs/`：VitePress 文档。
- `develop/config.example.json`：配置示例。真实的 `config.json` 不进仓库。

## 常用命令

```bash
cd develop
npm install
npm run dev        # 用 tsx 直接跑源码
npm test           # 内核测试
npm run typecheck  # tsc --noEmit
npm run docs:dev   # 本地文档
```

源码由 `tsx` 直接运行，不需要先编译。

## 改代码时注意

### 插件

- 市场插件放 `plugin/<name>.ts`，开发页插件放 `dev/<name>/index.ts`，两种形态不要混。
- 用 `definePlugin(meta, setup)`，不是旧的 `definePlugin({ match, handler })`。
- 插件里不要判断平台字符串。需要区分能力时用 `event.getCapabilities()` 或 `ctx.hasCapabilities()`。
- 定时器、全局监听用 `ctx.setTimeout`、`ctx.setInterval`、`ctx.on`。不要直接挂 `setInterval` 或全局事件，否则插件热重载/停用后清不掉。
- 发消息统一走 `ctx.reply(event, ...)` 或 `bot.callApi(...)`。消息段可以声明 `needs()` / `fallbackTo()`，由内核处理降级，不要在插件里逐个平台拼格式。
- 需要机器人、插件、统计等受控接口时，先在 `definePlugin` 的 `apis` 里声明，再在 `config.json` 的插件配置里授权白名单，运行时用 `ctx.api`。不要把内核对象直接暴露给插件。
- 关键词回复这类可能被反复触发的插件，用 `ctx.throttle(key, ms)` 做冷却。

### 适配器

- 新增适配器时在 `src/adapter/<name>/` 下建目录，启动时会自动扫描，不需要在 `index` 里加 `case`。
- 适配器负责把平台消息转成统一的 `BotEvent`，发送时把统一消息段翻译成平台 API。
- 平台 SDK 和额外依赖写进该适配器自己的 `package.json`，不要往内核依赖里塞。
- 适配器安装或更新后要重启框架。当前进程只在启动时加载适配器。

### WebUI

- 页面模板在 `src/core/webui/index.html`，HTML、CSS、JS 都在这一个文件里，没有前端构建步骤。
- 模板在启动时读入内存。改完页面要重启框架才能看到。
- 后端接口在 `src/core/webui.js`。
- 不要在页面里直接读密钥、Cookie 或本机数据库；需要展示的信息走服务端接口，并且不要回传敏感值。

### 配置

- 不要提交 `config.json`、`data/`、`node_modules/`。
- 改机器人、插件配置时走现有的配置写入入口，不要从多个地方各自写 `config.json`，否则容易和热重载打架。
- `config.json` 改动会触发热重载；适配器代码和 WebUI 模板不会。

## 提交前

```bash
cd develop
npm run typecheck
npm test
```

当前仓库没有统一的 lint/format 脚本。新增代码跟着所在文件的风格写，不要顺手全文件重排。
