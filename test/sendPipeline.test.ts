// 发送侧能力降级流水线单测
import { test } from "node:test"
import assert from "node:assert/strict"
import { applySendFallback, needsDowngrade } from "../src/core/sendPipeline.js"
import type { AnySeg } from "../src/core/messageUtils.js"

const text = (t: string): AnySeg => ({ type: "text", data: { text: t } })
const onlyText = { text: true } // 仅支持文本的会话

test("无能力声明的段原样通过", () => {
  const chain = [text("a"), text("b")]
  const out = applySendFallback(chain, onlyText)
  assert.equal(out.length, 2)
  assert.equal(out[0].data.text, "a")
})

test("会话满足段能力时保留", () => {
  const img: AnySeg = { type: "image", data: { url: "u" }, capabilities: ["image"] }
  const out = applySendFallback([img], { text: true, image: true })
  assert.equal(out.length, 1)
  assert.equal(out[0].type, "image")
})

test("缺能力且有 fallback：替换为降级段", () => {
  const btn: AnySeg = {
    type: "button",
    data: { text: "点我" },
    capabilities: ["button"],
    fallback: [text("[按钮]")],
  }
  const out = applySendFallback([btn], onlyText)
  assert.equal(out.length, 1)
  assert.equal(out[0].type, "text")
  assert.equal(out[0].data.text, "[按钮]")
})

test("缺能力且无 fallback：丢弃该段，其余保留", () => {
  const img: AnySeg = { type: "image", data: { url: "u" }, capabilities: ["image"] }
  const out = applySendFallback([text("前"), img, text("后")], onlyText)
  assert.deepEqual(out.map((s) => s.data.text), ["前", "后"])
})

test("fallback 段仍缺能力时继续递归降级", () => {
  // 按钮降级为图片，图片仍不支持，再降级为文本
  const img: AnySeg = {
    type: "image",
    data: { url: "u" },
    capabilities: ["image"],
    fallback: [text("[图片]")],
  }
  const btn: AnySeg = {
    type: "button",
    data: { text: "x" },
    capabilities: ["button"],
    fallback: [img],
  }
  const out = applySendFallback([btn], onlyText)
  assert.equal(out.length, 1)
  assert.equal(out[0].data.text, "[图片]")
})

test("降级不修改原始消息链（返回全新数组）", () => {
  const btn: AnySeg = {
    type: "button",
    data: { text: "x" },
    capabilities: ["button"],
    fallback: [text("fb")],
  }
  const snapshot = JSON.parse(JSON.stringify([btn]))
  applySendFallback([btn], onlyText)
  assert.deepEqual(JSON.parse(JSON.stringify([btn])), snapshot)
})

test("过深的 fallback 链被深度上限截断，不死循环", () => {
  // 构造 8 层、每层都缺能力且继续 fallback 的链，最深层无 fallback
  let deep: AnySeg = { type: "image", data: {}, capabilities: ["image"] }
  for (let i = 0; i < 7; i++) {
    deep = { type: "button", data: {}, capabilities: ["button"], fallback: [deep] }
  }
  const out = applySendFallback([deep], onlyText)
  assert.deepEqual(out, [])
})

test("needsDowngrade 仅判断不修改", () => {
  assert.equal(needsDowngrade({ capabilities: ["image"] }, onlyText), true)
  assert.equal(needsDowngrade({ capabilities: ["text"] }, onlyText), false)
  assert.equal(needsDowngrade({}, onlyText), false)
})
