// 中间件流水线（接收侧）
// 中间件依次执行，`next()` 进入下一层，
// 最内层触发事件分发（globalBus.emit → 插件）。
// 快照记录：每个中间件执行前后保存 event 深拷贝快照，
// 用于调试排查"哪个中间件改动了事件"。
import { globalBus } from "./eventBus.js"
import type { BotEvent } from "./models/event.js"
import type { BaseAdapter } from "../adapter/base.js"

export type MiddlewareFn = (
  event: BotEvent,
  next: () => Promise<void>,
) => Promise<void> | void

// 一次执行的快照记录
export interface MiddlewareSnapshot {
  seq: number
  middleware: string
  before: string
  after: string
  at: number
}

const MAX_SNAPSHOTS = 200

export class MiddlewarePipeline {
  private readonly fns: Array<{ name: string; fn: MiddlewareFn }> = []
  private snapshots: MiddlewareSnapshot[] = []
  private seq = 0

  // 注册中间件（可命名，便于快照追踪）
  use(fn: MiddlewareFn, name = fn.name || `mw${this.fns.length + 1}`): void {
    this.fns.push({ name, fn })
  }

  // 最近 N 条中间件快照（调试用）
  getSnapshots(): MiddlewareSnapshot[] {
    return [...this.snapshots]
  }

  clearSnapshots(): void {
    this.snapshots = []
  }

  // 运行整条中间件链（最内层触发 globalBus）。
  // @returns 返回 Promise，但调用方无需 await（fire-and-forget）
  async run(event: BotEvent, adapter: BaseAdapter, emit: () => void): Promise<void> {
    let i = 0
    const dispatch = async (): Promise<void> => {
      if (i >= this.fns.length) {
        emit()
        return
      }
      const { name, fn } = this.fns[i++]
      const before = this.snapshotOf(event)
      try {
        await fn(event, dispatch)
      } catch (err) {
        console.error(`[中间件:${name}] 执行异常:`, err)
        // 中间件出错不中断整条链，继续下一层
        await dispatch()
      }
      const after = this.snapshotOf(event)
      if (before !== after) {
        this.pushSnapshot(name, before, after)
      }
    }
    await dispatch()
  }

  private snapshotOf(event: BotEvent): string {
    try {
      return JSON.stringify({ ...event, message: event.message })
    } catch {
      return "<unserializable>"
    }
  }

  private pushSnapshot(name: string, before: string, after: string): void {
    this.snapshots.push({ seq: ++this.seq, middleware: name, before, after, at: Date.now() })
    if (this.snapshots.length > MAX_SNAPSHOTS) {
      this.snapshots.splice(0, this.snapshots.length - MAX_SNAPSHOTS)
    }
  }
}

// 全局共享的中间件管道（适配器 emitEvent 时自动经过）
export const globalMiddleware = new MiddlewarePipeline()
