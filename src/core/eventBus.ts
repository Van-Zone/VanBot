type EventCallback = (eventName: string, ...args: any[]) => Promise<void> | void

class EventBus {
  private readonly map: Record<string, EventCallback[]> = {}
  private wildcardHandlers: EventCallback[] = []

  on(event: string, cb: EventCallback) {
    if (event === "*") {
      this.wildcardHandlers.push(cb)
      return
    }
    if (!this.map[event]) this.map[event] = []
    this.map[event].push(cb)
  }

  // 移除指定监听，用于插件热重载
  off(event: string, cb: EventCallback) {
    if (event === "*") {
      const idx = this.wildcardHandlers.indexOf(cb)
      if (idx >= 0) this.wildcardHandlers.splice(idx, 1)
      return
    }
    const list = this.map[event]
    if (!list) return
    const idx = list.indexOf(cb)
    if (idx >= 0) list.splice(idx, 1)
  }

  // 移除某个事件的全部监听
  clear(event: string) {
    if (event === "*") {
      this.wildcardHandlers = []
      return
    }
    delete this.map[event]
  }

  emit(event: string, ...payload: any[]) {
    // 先执行通配监听
    this.wildcardHandlers.forEach(cb => {
      Promise.resolve(cb(event, ...payload)).catch(e => console.error("通配事件异常:", e))
    })
    // 再执行对应事件单独监听
    const list = this.map[event]
    if (!list) return
    list.forEach(cb => {
      Promise.resolve(cb(event, ...payload)).catch(e => console.error(`${event} 事件异常:`, e))
    })
  }
}

export const globalBus = new EventBus()
