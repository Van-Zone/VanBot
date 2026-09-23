// 会话能力体系（Capabilities）
// 核心原则：
// - 能力是【会话粒度】（一个群 / 一个私聊会话），不是平台全局写死。
// 例：QQ 群拥有 `canMuteMember`，QQ 私聊没有。
// - 每个适配器在输出事件时，通过 `BaseAdapter.computeCapabilities(event)`
// 上报当前会话的能力集合；未覆盖的适配器默认全能力（见 base.ts），
// 明确知道限制的适配器再覆盖声明能力子集。
// - 业务插件禁止硬编码判断平台字符串，只能判断能力标记。
// - 平台独有的 API 放 `event.platformExtra`，能力判断只走 capabilities。

// 常用能力标识（也是 MessageSegment.capabilities 与 Capabilities 键名的统一来源）
export const CAP = {
  // 文本
  TEXT: "text",
  // 图片
  IMAGE: "image",
  // 视频
  VIDEO: "video",
  // 语音
  AUDIO: "audio",
  // 文件
  FILE: "file",
  // markdown
  MARKDOWN: "markdown",
  // 按钮（inline keyboard）
  BUTTON: "button",
  // @提及
  AT: "at",
  // 引用回复
  REPLY: "reply",
  // 表情
  FACE: "face",
  // 群管理：禁言成员
  CAN_MUTE: "canMuteMember",
  // 群管理：移出成员
  CAN_KICK: "canKickMember",
  // 当前会话中机器人是群主
  IS_GROUP_OWNER: "isGroupOwner",
  // 当前会话中机器人是群管理员
  IS_GROUP_ADMIN: "isGroupAdmin",
} as const

// 会话粒度能力集合。
// 值为 `true` 表示具备该能力；`undefined`/`false` 表示不具备。
// 允许任意扩展键（第三方能力标识）。
export interface Capabilities {
  text?: boolean
  image?: boolean
  video?: boolean
  audio?: boolean
  file?: boolean
  markdown?: boolean
  button?: boolean
  at?: boolean
  reply?: boolean
  face?: boolean
  canMuteMember?: boolean
  canKickMember?: boolean
  isGroupOwner?: boolean
  isGroupAdmin?: boolean
  // 自定义扩展能力标识（key 即能力名）
  [key: string]: boolean | undefined
}

// 空能力集
export const EMPTY_CAPABILITIES: Readonly<Capabilities> = {}

// 框架认为所有适配器都具备的"通用基线能力"
export const GENERIC_CAPABILITIES: Readonly<Capabilities> = {
  text: true,
}

// 默认全能力。
// 适配器未实现 computeCapabilities 时，框架假定它支持通用富媒体能力，
// 行为与「未引入能力体系之前」一致（旧段不受影响）；
// 明确知道限制的适配器再覆盖声明能力子集（如个人微信不支持发语音）。
export const FULL_CAPABILITIES: Readonly<Capabilities> = {
  text: true,
  image: true,
  video: true,
  audio: true,
  file: true,
  markdown: true,
  button: true,
  at: true,
  reply: true,
  face: true,
}

// 判断当前会话能力集是否满足某个消息段声明的全部能力。
// @param caps  会话能力集（event.capabilities）
// @param need  消息段声明的依赖能力标识列表（segment.capabilities）
export function hasCapabilities(caps: Readonly<Capabilities>, need: string[] | undefined): boolean {
  if (!need || need.length === 0) return true
  return need.every((cap) => caps[cap] === true)
}

// 合并能力集（后者覆盖前者），返回新对象（不修改入参）。
export function mergeCapabilities(...lists: Array<Readonly<Capabilities> | undefined>): Capabilities {
  const out: Capabilities = {}
  for (const l of lists) {
    if (!l) continue
    for (const [k, v] of Object.entries(l)) {
      if (v !== undefined) out[k] = v
    }
  }
  return out
}

// 从事件获取能力集（事件经过内核管道后 capabilities 必存在）
export function getCapabilitiesOf(event: { capabilities?: Readonly<Capabilities> }): Readonly<Capabilities> {
  return event.capabilities ?? EMPTY_CAPABILITIES
}
