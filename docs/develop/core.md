---
title: 内核能力
description: VanBotJS 内核能力说明
---

# VanBotJS 内核能力



> 目标：把多平台兼容**下沉到框架内核**，业务插件尽量不写 `if (platform === xxx)`；
> 发送侧内核自动消息降级；接收侧事件归一清洗；可调试追踪、安全插件体系、中立 Skill 能力注册。
>
> 插件统一放在根目录 `plugin/`，**只支持新式 `definePlugin` 插件**
> （旧式插件与 `src/cmd/` 已彻底移除，不允许并存）。

---

## 1. 消息段扩展：capabilities / fallback

```ts
// src/core/models/message.ts
export interface IMsgSegment {
  type: MsgSegmentType
  data: Record<string, string | number>

  // 该消息组件依赖的会话能力标识，例 ["button","image"]（发送降级用）
  capabilities?: string[]
  // 平台能力不支持时自动替换的降级段；仅发送流水线使用，接收不使用
  fallback?: MessageSegment[]

  toOneBot11(): Record<string, any>
}
```

链式构造（推荐）：

```ts
MessageSegment.image("https://x/a.png")
  .needs("image")                                     // 声明依赖能力
  .fallbackTo(MessageSegment.text("[图片不可用]"))      // 降级段
```

- **接收侧不使用 fallback**（只解析真实内容）；
- 无 `capabilities` 的旧段 100% 兼容，原样通过。

## 2. 会话能力体系（Capabilities，Event 级别）

```ts
// src/core/capabilities.ts
export interface Capabilities {
  text?: boolean; image?: boolean; video?: boolean; audio?: boolean
  file?: boolean; markdown?: boolean; button?: boolean
  at?: boolean; reply?: boolean; face?: boolean
  canMuteMember?: boolean; canKickMember?: boolean
  isGroupOwner?: boolean; isGroupAdmin?: boolean
  [key: string]: boolean | undefined        // 任意扩展能力
}

export const CAP = { TEXT:"text", IMAGE:"image", ..., CAN_MUTE:"canMuteMember" } as const
```

- **能力是会话粒度**（一个群 / 一个私聊），不是平台写死；
- 事件挂载 `event.capabilities: Readonly<Capabilities>`，方法 `event.getCapabilities()`；
- 平台独有数据放 `event.platformExtra?: unknown`（无则 undefined）；
- 业务代码**禁止硬编码平台字符串**，只能判断能力标记。

适配器上报（会话粒度，按事件区分）：

```ts
// src/adapter/base.ts —— 默认全能力，明确限制的适配器覆盖
abstract class BaseAdapter {
  computeCapabilities(_event: BotEvent): Readonly<Capabilities> {
    return FULL_CAPABILITIES   // 默认：text/image/video/audio/file/markdown/button/at/reply/face
  }
}

// 例：QQ 适配器
computeCapabilities(event) {
  return {
    ...FULL_CAPABILITIES,
    canMuteMember: event.groupId ? true : false,   // 群有、私聊没有
    canKickMember: event.groupId ? true : false,
  }
}

// 例：个人微信（不支持发语音）
computeCapabilities(event) {
  return { ...FULL_CAPABILITIES, audio: false }
}
```

## 3. 发送降级流水线（内核发送侧）

链路：插件 `reply / sendMsg` → **内核先降级** → 适配器只做协议翻译。

```ts
// src/core/sendPipeline.ts
export function applySendFallback(chain: AnySeg[], caps: Readonly<Capabilities>): AnySeg[]
```

规则：
- 段声明的 `capabilities` 缺任一 → 用 `fallback` 替换（fallback 内部还可再降级，最多 5 层）；
- 无 fallback → 丢弃该组件；
- 无 capabilities 的段原样通过；
- 返回全新数组，不修改入参。

入口：`BaseAdapter.sendMsg / sendGroupMsg / sendPrivateMsg(target, chain, { capabilities })`。
插件侧 `ctx.reply(event, message)` 自动带上 `event.capabilities` 走降级。

⚠️ 适配器只做协议翻译，**绝不处理降级**。

## 4. 接收事件流水线（适配器 → 内核 → 插件）

```
适配器(原始协议→基础Event+Segment) → 内核管道(normalizeEvent) → 中间件(快照) → globalBus → 插件
```

`normalizeEvent` 做的事（`src/core/eventPipeline.ts`）：

| 处理 | 说明 |
|---|---|
| `traceId` | 生成 `tr_xxxx`，贯穿接收→中间件→插件→回复全程 |
| ID 字符串化 | `selfId/userId/groupId` 统一转 string，消除数字/雪花坑 |
| 时间统一 | 从 `raw.time / create_time_ms / Date.now()` 归一为 Unix 秒 → `event.time` |
| 未知段占位 | 非白名单消息段 → `{type:"text", data:{text:"[未知消息]"}}` |
| 能力集填充 | 调 `adapter.computeCapabilities(event)` → `event.capabilities` |
| `getCapabilities()` | 注入方法 |

中间件（`src/core/middleware.ts`）：

```ts
globalMiddleware.use(async (event, next) => {
  console.log("before", event.traceId)
  event.raw.myMarker = true            // 可修改事件
  await next()                          // 进入下一层（最内层触发插件）
}, "my-mw")                             // 命名便于快照追踪

globalMiddleware.getSnapshots()         // 每个中间件执行前后快照（改动了事件的会记录）
```

## 5. 插件系统增强（definePlugin + ctx + 副作用追踪）

```ts
// src/core/pluginContext.ts
export interface PluginMeta {
  name: string
  version?: string
  description?: string
  dependencies?: string[]              // 依赖插件（启用时检查提示）
  requiresCapabilities?: string[]      // 事件能力不足时自动跳过该事件
  permissions?: string[]               // 权限声明（内核记录）
}

export interface PluginContext {
  name: string
  setTimeout(fn, ms, ...args)          // 框架封装，卸载自动清理
  setInterval(fn, ms, ...args)
  on(eventName, cb)                    // 事件监听，卸载自动移除
  registerSkill(skill)
  reply(event, message)                // 自动带 event.capabilities 降级 + traceId 日志
  hasCapabilities(caps, need)
  dispose()                            // 清理全部副作用
}

export function definePlugin(meta, setup): VanbotPlugin
```

- **ctx 隔离**：每个插件独立 PluginContext，不污染全局；
- **副作用追踪**：定时器/监听/Skill 全部登记，插件禁用/热重载自动清理（防内存泄漏）；
- `requiresCapabilities`：插件声明所需能力，事件能力不足时内核自动跳过（能力下沉）。

## 6. 中立 Skill 注册

```ts
export interface Skill {
  name: string
  description: string
  parameters?: Record<string, any>     // JSON Schema
  requiredCapabilities?: string[]
  invoke: (event: BotEvent, params: Record<string, any>) => SkillResult | Promise<SkillResult>
}
```

- `ctx.registerSkill(skill)` 注册；
- 注册后**自动生成普通命令** `/技能名 参数`（也可配 `#` 前缀）；
- 外部调用方可用 `skillRegistry.getFunctionSchema()` 生成函数调用描述；
- **同一套 invoke** 既人工命令调用、也可外部工具调用。

## 7. MockAdapter 单元测试

```ts
// src/testing/mockAdapter.ts —— 纯内存，零网络
const bot = new MockAdapter({ botId: "MOCK" })
bot.setCapabilities({ image: false })          // 模拟本会话不支持图片
globalBus.on("private_message", (n, e) => {    // 或挂真实插件
  bot.sendMsg({ userId: e.userId }, [...], { capabilities: e.capabilities })
})
await bot.receivePrivateMessage("U1", "hi")    // 注入事件（走真实内核管道）
await bot.flush()                              // 等待异步链
console.log(bot.sent)                          // 捕获框架输出发送的消息
```

## 8. 业务插件示例

见 `plugin/example_demo.ts`（插件目录为根目录 `plugin/`），核心展示：

```ts
import { definePlugin } from "../core/pluginContext.js"
import { MessageSegment } from "../core/models/message.js"

export default definePlugin(
  { name: "demo", description: "示例", requiresCapabilities: ["text"], permissions: ["user"] },
  (ctx) => {
    ctx.registerSkill({
      name: "echo",
      description: "回显文本",
      parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] },
      invoke: async (_e, p) => `echo: ${p.input ?? ""}`,
    })
    return {
      onEvent: async (event) => {
        // 判断能力而非平台
        if (event.getCapabilities?.().canMuteMember) { /* 可禁言 */ }
        // ✅ 发送带能力声明的段，内核自动降级
        await ctx.reply(event, [
          MessageSegment.text("正文").needs("text"),
          MessageSegment.image("https://x/a.png").needs("image").fallbackTo(MessageSegment.text("[图片降级]")),
        ])
      },
      onEnable: () => { ctx.setTimeout(() => console.log("tick"), 1000) },
    }
  },
)
```

## 9. 适配器接入点小结

适配器要做的**只有两件事**（协议本身零改动）：
1. `computeCapabilities(event)`：按会话返回能力集（不实现=默认全能力）；
2. 其余照旧（转换原始协议 → 基础 Event；发送走 `callApi` 协议翻译）。

**已全部落地**：10 个适配器（QQ官方 / Telegram / KOOK / Discord / 微信公号 / 个人微信 weixin_oc /
OneBot11 / Satori / Milky / B站直播）均已实现 `computeCapabilities`（见 [能力总览](/platform/abilities) 第三节）。
插件已统一：所有发送统一走 `sendMsgCtx(bot, event, {group_id/user_id}, message)` →
`bot.sendMsg`（携带 `event.capabilities`，内核先降级再翻译）。

### 消息段标签全新写法

插件里的 `[at:xxx]` / `[image:url]` 等标签，不再硬编码裸对象 `{ type, data }`，
统一改用 `MessageSegment` 链式构造（`MessageSegment` 已补全 at/reply/face/image/record/video/
file/forward/json/music/markdown/button 静态方法 + `.needs()` / `.fallbackTo()`）：

```ts
// 旧写法（硬编码裸对象）
{ key: "at", build: (p) => ({ type: "at", data: { qq: p[1] } }) }

// 全新写法（能力声明 + 自动降级）
{ key: "at", build: (p) => MessageSegment.at(p[1]).needs("at").fallbackTo(MessageSegment.text(`@${p[1]}`)) }
{ key: "image", build: async (p) => MessageSegment.image(`base64://${await getUrlBase64(p.slice(1).join("."))}`).needs("image").fallbackTo(MessageSegment.text("[图片]")) }
{ key: "markdown", build: async (p) => MessageSegment.markdown(mdData).needs("markdown").fallbackTo(MessageSegment.text(mdContent)) }
```

段会经过 `&#123;&#123;NODE:base64(json)&#125;&#125;` 编码保留 `capabilities`/`fallback`，最终由主流程 `sendMsgCtx`
统一发送；能力不足的平台由内核自动降级（如 at→文本、image→"[图片]"、markdown→纯文本），
支持原生能力的平台（QQ/onebot/KOOK/Discord 等）原样发送。业务插件一份代码跑所有平台。
