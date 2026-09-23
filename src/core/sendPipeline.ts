// 发送降级流水线（内核发送侧）
// 链路：插件调用 reply / sendMsg → 【内核先执行降级】 → 适配器只做协议翻译。
// 规则：
// - 遍历消息段数组，拿当前会话 event.capabilities 对比 segment.capabilities；
// - 当前会话缺少该段声明的任意一个 capability → 用 segment.fallback 替换；
// - 未提供 fallback → 丢弃该组件；
// - 无 capabilities 声明的段原样通过（旧写法完全兼容）；
// - 处理完成后得到全新消息数组，再交给适配器翻译发送。
// ⚠️ 适配器只做协议翻译，绝不能处理降级。
import type { Capabilities } from "./capabilities.js"
import { hasCapabilities } from "./capabilities.js"
import type { AnySeg } from "./messageUtils.js"

const MAX_DEPTH = 5

// 递归降级一段消息。
// @param seg     消息段
// @param caps    会话能力集
// @param depth   递归深度（防 fallback 自引用死循环）
function downgradeSeg(seg: AnySeg, caps: Readonly<Capabilities>, depth: number): AnySeg[] {
  if (hasCapabilities(caps, seg.capabilities)) {
    return [seg]
  }
  // 能力不足 → 使用 fallback（若 fallback 内部也有能力声明，继续降级）
  if (seg.fallback && seg.fallback.length > 0 && depth < MAX_DEPTH) {
    const out: AnySeg[] = []
    for (const f of seg.fallback) {
      out.push(...downgradeSeg(f, caps, depth + 1))
    }
    return out
  }
  // 无 fallback → 丢弃
  return []
}

// 对整条消息链执行能力降级，返回全新数组。
// @param chain  原始消息链（不修改入参）
// @param caps   当前会话能力集
export function applySendFallback(chain: AnySeg[], caps: Readonly<Capabilities>): AnySeg[] {
  const out: AnySeg[] = []
  for (const seg of chain) {
    if (!seg) continue
    out.push(...downgradeSeg(seg, caps, 0))
  }
  return out
}

// 判断一段消息是否需要降级（供调试/日志输出，不改动）。
export function needsDowngrade(seg: { capabilities?: string[] }, caps: Readonly<Capabilities>): boolean {
  return !hasCapabilities(caps, seg.capabilities)
}
