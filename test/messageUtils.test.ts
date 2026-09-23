// 跨平台消息归一化与文本兜底单测
import { test } from "node:test"
import assert from "node:assert/strict"
import { normalizeSegments, segmentsToText } from "../src/core/messageUtils.js"

test("normalizeSegments: 字符串转单文本段", () => {
  const out = normalizeSegments("你好")
  assert.equal(out.length, 1)
  assert.equal(out[0].type, "text")
  assert.equal(out[0].data.text, "你好")
})

test("normalizeSegments: null / undefined 返回空数组", () => {
  assert.deepEqual(normalizeSegments(null), [])
  assert.deepEqual(normalizeSegments(undefined), [])
})

test("normalizeSegments: 单段对象包装为数组并补 data", () => {
  const out = normalizeSegments({ type: "image", data: { url: "u" } })
  assert.equal(out.length, 1)
  assert.equal(out[0].type, "image")
})

test("normalizeSegments: 缺 type 兜底为 text，缺 data 补空对象", () => {
  const out = normalizeSegments([{ type: "at" }, {}])
  assert.equal(out[0].type, "at")
  assert.deepEqual(out[0].data, {})
  assert.equal(out[1].type, "text")
})

test("normalizeSegments: capabilities / fallback 被复制", () => {
  const out = normalizeSegments([
    { type: "image", data: { url: "u" }, capabilities: ["image"], fallback: [{ type: "text", data: { text: "x" } }] },
  ])
  assert.deepEqual(out[0].capabilities, ["image"])
  assert.equal(out[0].fallback?.[0].type, "text")
})

test("segmentsToText: 各类型文本兜底不崩溃", () => {
  const segs = normalizeSegments([
    { type: "text", data: { text: "你好" } },
    { type: "at", data: { qq: "123", name: "张三" } },
    { type: "face", data: { id: 9 } },
    { type: "image", data: {} },
    { type: "record", data: {} },
    { type: "video", data: {} },
    { type: "markdown", data: { content: "**粗**" } },
    { type: "button", data: { label: "确定" } },
  ])
  const text = segmentsToText(segs)
  assert.ok(text.includes("你好"))
  assert.ok(text.includes("@张三"))
  assert.ok(text.includes("[表情9]"))
  assert.ok(text.includes("[图片]"))
  assert.ok(text.includes("[语音]"))
  assert.ok(text.includes("[视频]"))
  assert.ok(text.includes("**粗**"))
  assert.ok(text.includes("[按钮:确定]"))
})

test("segmentsToText: 空数组返回空字符串", () => {
  assert.equal(segmentsToText([]), "")
})
