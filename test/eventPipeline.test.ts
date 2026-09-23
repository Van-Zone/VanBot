// 接收事件归一化流水线单测
import { test } from "node:test"
import assert from "node:assert/strict"
import { createTraceId, normalizeEvent } from "../src/core/eventPipeline.js"
import type { BotEvent } from "../src/core/models/event.js"

// 构造最小原始事件（userId 故意给数字，验证字符串化）
function rawEvent(over: Record<string, unknown> = {}): BotEvent {
  return {
    botId: "B",
    selfId: "100",
    userId: 200 as unknown as string,
    postType: "message",
    messageType: "private",
    message: [
      { type: "text", data: { text: "hi" } },
      { type: "weird_seg", data: {} },
    ],
    time: 1700000000,
    raw: {},
    ...over,
  } as unknown as BotEvent
}

test("createTraceId: tr_ 前缀且全局唯一", () => {
  const a = createTraceId()
  const b = createTraceId()
  assert.ok(a.startsWith("tr_"))
  assert.notEqual(a, b)
})

test("normalizeEvent: 所有 ID 统一为字符串", () => {
  const e = normalizeEvent(rawEvent())
  assert.equal(typeof e.userId, "string")
  assert.equal(e.userId, "200")
  assert.equal(e.selfId, "100")
})

test("normalizeEvent: 空 groupId 归一为 undefined", () => {
  assert.equal(normalizeEvent(rawEvent({ groupId: 0 })).groupId, undefined)
  assert.equal(normalizeEvent(rawEvent({ groupId: "" })).groupId, undefined)
  assert.equal(normalizeEvent(rawEvent({ groupId: 999 })).groupId, "999")
})

test("normalizeEvent: 未知消息段转占位文本", () => {
  const e = normalizeEvent(rawEvent())
  assert.equal(e.message.length, 2)
  assert.equal(e.message[0].type, "text")
  assert.equal(e.message[1].type, "text")
  assert.equal(e.message[1].data.text, "[未知消息]")
})

test("normalizeEvent: 默认能力集为 FULL 且被冻结，并注入 getCapabilities", () => {
  const e = normalizeEvent(rawEvent())
  assert.equal(e.capabilities?.text, true)
  assert.equal(Object.isFrozen(e.capabilities), true)
  assert.equal(typeof e.getCapabilities, "function")
  assert.equal(e.getCapabilities!().image, true)
})

test("normalizeEvent: 采用适配器上报的会话能力", () => {
  const adapter = { computeCapabilities: () => ({ text: true }) } as never
  const e = normalizeEvent(rawEvent(), adapter)
  assert.equal(e.capabilities?.text, true)
  assert.equal(e.capabilities?.image, undefined)
})

test("normalizeEvent: 适配器能力计算抛错时回退 FULL，不影响事件下发", () => {
  const adapter = {
    computeCapabilities: () => {
      throw new Error("boom")
    },
  } as never
  const e = normalizeEvent(rawEvent(), adapter)
  assert.equal(e.capabilities?.text, true)
  assert.equal(e.capabilities?.image, true)
})

test("normalizeEvent: 已有 traceId 不被覆盖，缺失才生成", () => {
  const kept = normalizeEvent(rawEvent({ traceId: "tr_fixed" }))
  assert.equal(kept.traceId, "tr_fixed")
  const created = normalizeEvent(rawEvent())
  assert.ok(created.traceId!.startsWith("tr_"))
})

test("normalizeEvent: 合法 Unix 秒原样保留，非法/零值回退为当前秒", () => {
  assert.equal(normalizeEvent(rawEvent()).time, 1700000000)
  const e = normalizeEvent(rawEvent({ time: 0 }))
  assert.equal(typeof e.time, "number")
  assert.ok((e.time as number) > 0)
  assert.ok(Math.abs(Math.floor(Date.now() / 1000) - (e.time as number)) <= 5)
})
