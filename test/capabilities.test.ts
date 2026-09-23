// 会话能力体系单测
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  hasCapabilities,
  mergeCapabilities,
  getCapabilitiesOf,
  FULL_CAPABILITIES,
  EMPTY_CAPABILITIES,
} from "../src/core/capabilities.js"

test("hasCapabilities: 无声明需求即满足", () => {
  assert.equal(hasCapabilities(EMPTY_CAPABILITIES, undefined), true)
  assert.equal(hasCapabilities(EMPTY_CAPABILITIES, []), true)
  assert.equal(hasCapabilities(FULL_CAPABILITIES, undefined), true)
})

test("hasCapabilities: 全部具备才满足，缺一个即不满足", () => {
  const caps = { text: true, image: true, button: false }
  assert.equal(hasCapabilities(caps, ["text"]), true)
  assert.equal(hasCapabilities(caps, ["text", "image"]), true)
  // button 显式 false
  assert.equal(hasCapabilities(caps, ["text", "button"]), false)
  // 未声明的能力视为不具备
  assert.equal(hasCapabilities(caps, ["text", "video"]), false)
})

test("mergeCapabilities: 后者覆盖前者，跳过 undefined", () => {
  const merged = mergeCapabilities({ text: true, image: false }, undefined, { image: true, audio: true })
  assert.deepEqual(merged, { text: true, image: true, audio: true })
})

test("mergeCapabilities: 返回新对象且不修改入参", () => {
  const a = { text: true }
  const b = { image: true }
  const merged = mergeCapabilities(a, b)
  assert.notEqual(merged, a)
  assert.deepEqual(a, { text: true })
  assert.deepEqual(b, { image: true })
})

test("getCapabilitiesOf: 缺省回退空能力集", () => {
  assert.equal(getCapabilitiesOf({}), EMPTY_CAPABILITIES)
  const caps = { text: true }
  assert.equal(getCapabilitiesOf({ capabilities: caps }), caps)
})
