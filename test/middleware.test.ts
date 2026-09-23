// 洋葱中间件流水线单测
import { test } from "node:test"
import assert from "node:assert/strict"
import { MiddlewarePipeline } from "../src/core/middleware.js"
import { normalizeEvent } from "../src/core/eventPipeline.js"

function makeEvent() {
  return normalizeEvent({
    botId: "B",
    selfId: "1",
    userId: "2",
    postType: "message",
    message: [{ type: "text", data: { text: "origin" } }],
    raw: {},
  } as never)
}

test("洋葱模型：进入顺序、emit、退出顺序正确", async () => {
  const pipe = new MiddlewarePipeline()
  const order: string[] = []
  pipe.use(async (_e, next) => {
    order.push("m1-in")
    await next()
    order.push("m1-out")
  }, "mw1")
  pipe.use(async (_e, next) => {
    order.push("m2-in")
    await next()
    order.push("m2-out")
  }, "mw2")

  let emitCount = 0
  await pipe.run(makeEvent(), null as never, async () => {
    order.push("emit")
    emitCount++
  })
  assert.deepEqual(order, ["m1-in", "m2-in", "emit", "m2-out", "m1-out"])
  assert.equal(emitCount, 1)
})

test("中间件抛错被捕获，不阻断后续中间件与最终 emit", async () => {
  const pipe = new MiddlewarePipeline()
  const reached: string[] = []
  pipe.use(async () => {
    throw new Error("中间件故障")
  }, "bad")
  pipe.use(async (_e, next) => {
    reached.push("next-mw")
    await next()
  }, "good")

  let emitted = false
  await pipe.run(makeEvent(), null as never, async () => {
    emitted = true
  })
  assert.deepEqual(reached, ["next-mw"])
  assert.equal(emitted, true)
})

test("快照：修改事件的中间件产生前后快照，可按名定位", async () => {
  const pipe = new MiddlewarePipeline()
  pipe.use(async (e, next) => {
    ;(e.message[0].data as { text: string }).text = "changed"
    await next()
  }, "editor")
  await pipe.run(makeEvent(), null as never, async () => {})
  const snaps = pipe.getSnapshots()
  // 单个中间件发生修改时记录一条 before/after 快照
  assert.equal(snaps.length, 1)
  assert.ok(snaps.some((s) => s.middleware === "editor"))
  pipe.clearSnapshots()
  assert.equal(pipe.getSnapshots().length, 0)
})
