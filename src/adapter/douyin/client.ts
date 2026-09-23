// playwright-core 为 douyin 适配器专属重型依赖，运行时懒加载（未安装/不支持的平台不影响框架启动）
import type { BrowserContext, Page } from "playwright-core"
import fs from "fs"
import path from "path"
import { BaseAdapter } from "../base.js"
import { convertDouyinMessage } from "./converter.js"
import type { DouyinConversation, DouyinRawMessage } from "./types.js"
import { normalizeSegments, segmentsToText } from "../../core/messageUtils.js"
import { registerBot } from "../../core/botRegistry.js"
import type { Capabilities } from "../../core/capabilities.js"
import type { BotEvent } from "../../core/models/event.js"

export const DouyinAdapterMap = new Map<string, DouyinAdapter>()

let playwrightCache: typeof import("playwright-core") | null = null
// 懒加载 playwright-core，缺失时给出明确的适配器依赖安装提示（而非框架启动崩溃）
async function loadPlaywright(botId: string): Promise<typeof import("playwright-core")> {
  if (playwrightCache) return playwrightCache
  try {
    playwrightCache = await import("playwright-core")
    return playwrightCache
  } catch (e) {
    throw new Error(`[${botId}] 缺少 playwright-core 依赖，请先安装 douyin 适配器依赖: npm i playwright-core（${(e as Error).message}）`)
  }
}

const DOUYIN_URL = "https://www.douyin.com"
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

// 反检测脚本：伪装浏览器指纹，绕过抖音反自动化检测。
// 关键：--headless=new + 持久化指纹(launchPersistentContext) + 本脚本。
const STEALTH_SCRIPT = `(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  window.chrome = { runtime: {}, loadTimes: function(){}, csi: function(){}, app: {} };
  const originalQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (parameters) => (
    parameters.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : originalQuery(parameters)
  );
  Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN','zh','en'] });
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
})();`

// 聊天输入框文本注入脚本。
// 抖音精选聊天输入框是 contenteditable（class 含 editor-kit-container），
// 需模拟 innerText + input + paste 事件触发编辑器 onChange。
const DRAFTJS_PASTE_SCRIPT = `(text) => {
  const editor = document.querySelector('[data-contents="true"]')
    || document.querySelector('.DraftEditor-editor [contenteditable="true"]')
    || document.querySelector('.DraftEditor-root [contenteditable="true"]')
    || document.querySelector('[contenteditable]');
  if (!editor) return { success: false, error: 'editor not found' };
  editor.focus();
  editor.innerText = text;
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  dt.setData('text/html', text);
  editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  return { success: true, method: 'paste' };
}`

// 自动探测系统浏览器（Windows Edge/Chrome + Linux/macOS 常见路径）
function detectBrowserExecutable(): string {
  const candidates = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  throw new Error(`[Douyin] 未找到系统浏览器（Chrome/Edge），请在配置里填 executablePath`)
}

// 抖音适配器（基于抖音网页版私信消息面板的浏览器自动化）
// 原理：
// 1. launchPersistentContext 持久化浏览器指纹 + 反检测脚本 + --headless=new，绕过验证码风控
// 2. 登录只用 cookie（含 sessionid）：写入后打开首页检测登录态
// 3. 接收：点击右上角"消息"按钮打开右侧消息面板（SPA），轮询会话列表
// （.conversationConversationItemwrapper 稳定语义 class），检测"最后消息+时间"指纹变化 → 派发事件
// 4. 发送：打开面板 → 点会话进入聊天窗口 → contenteditable 输入框注入文本 → 点发送/回车
// 已知限制（抖音网页版消息功能弱化）：
// - 接收的是会话列表的"最后消息预览"（可能是表情/图片占位，富媒体内容读不到）
// - 网页版面板顶部有"下载客户端，实时接收好友消息"横幅，说明完整聊天能力受限
// - 每次操作都要保持消息面板打开，偶发需要重试
// 配置项：
// botId           - 框架内标识
// type            - "douyin"
// cookie          - 必填，抖音网页版登录 cookie 字符串（须含 sessionid）
// executablePath  - 可选，浏览器路径（默认自动探测系统 Edge/Chrome）
// headless        - 可选，无头模式，默认 true（--headless=new + 反检测）；被验证码拦截时设 false 用真实窗口
// profileDir      - 可选，浏览器指纹持久化目录（默认 ./data/douyin_profile/<botId>，不要删）
// sessionDir      - 可选，登录态 storage_state 保存目录（默认 ./data/douyin_session）
// pollInterval    - 可选，轮询间隔毫秒，默认 2500
export class DouyinAdapter extends BaseAdapter {
  public readonly botId: string
  // 机器人自身标识（网页版拿不到用户名，默认 douyin）
  public selfId: string = "douyin"
  private readonly cfg: Record<string, any>
  private context?: BrowserContext
  private page?: Page
  private pollTimer?: NodeJS.Timeout
  private stopped = false
  // 轮询/发送互斥，避免页面操作冲突
  private busy = false
  // 各会话最新消息指纹（昵称 -> preview|time）
  private lastSeen = new Map<string, string>()
  // 自己刚发送的消息（昵称 -> text），用于过滤回显
  private selfSent = new Map<string, { text: string; at: number }>()

  constructor(config: Record<string, any>) {
    super()
    this.cfg = config
    this.botId = config.botId
    DouyinAdapterMap.set(this.botId, this)
    registerBot(this)
  }

  public async connect(): Promise<void> {
    this.stopped = false
    if (!this.cfg.cookie) {
      throw new Error(`[${this.botId}] 缺少 cookie 配置（必须包含 sessionid）`)
    }
    const exe = this.cfg.executablePath || detectBrowserExecutable()
    console.log(`[${this.botId}] 使用浏览器: ${exe}`)

    const headless = this.cfg.headless !== false
    const args = ["--disable-blink-features=AutomationControlled", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage"]
    if (headless) args.push("--headless=new")

    // 持久化指纹目录（抖音按浏览器指纹风控，持久化后一次性过验证，长期免验证）
    const profileDir = this.cfg.profileDir ?? path.join(process.cwd(), "data", "douyin_profile", this.botId)
    fs.mkdirSync(path.dirname(profileDir), { recursive: true })

    const { chromium } = await loadPlaywright(this.botId)
    const context = await chromium.launchPersistentContext(profileDir, {
      executablePath: exe,
      headless,
      viewport: { width: 1280, height: 800 },
      userAgent: UA,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      args,
    })
    this.context = context
    await context.addInitScript(STEALTH_SCRIPT)
    this.page = context.pages()[0] ?? (await context.newPage())

    // 注入 cookie
    await this.applyManualCookie(String(this.cfg.cookie))
    if (!this.cfg.cookie) {
      const sessionFile = this.sessionFilePath()
      if (fs.existsSync(sessionFile)) {
        try {
          const st = JSON.parse(fs.readFileSync(sessionFile, "utf8"))
          if (Array.isArray(st.cookies) && st.cookies.length) {
            await context.addCookies(st.cookies)
          }
        } catch {
          // session 损坏忽略
        }
      }
    }

    await this.page.goto(DOUYIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {})
    await this.sleep(3000)
    await this.dismissPopups()

    // 检测验证码中间页（cookie 有效也可能被 headless 风控拦截）
    const title = (await this.page.title().catch(() => "")) || ""
    if (title.includes("验证码")) {
      this.connected = false
      await this.safeClose()
      throw new Error(
        `[${this.botId}] 页面被抖音验证码风控拦截（headless 指纹）。请把 config.json 该 bot 的 "headless" 改为 false，用真实窗口过验证一次（之后 profileDir 持久化指纹免验证）；或降低使用频率。`
      )
    }

    if (!(await this.isLoggedIn())) {
      this.connected = false
      await this.safeClose()
      throw new Error(
        `[${this.botId}] 登录态无效：cookie 里没有有效的 sessionid，或已过期。请从已登录抖音的浏览器复制最新 cookie 填入 config.json（F12 → console → document.cookie）。`
      )
    }
    this.connected = true
    console.log(`✅ [${this.botId}] 登录成功（cookie 有效）`)
    await this.saveSession()
    this.startPolling()
  }

  public async disconnect(): Promise<void> {
    this.stopped = true
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
    await this.safeClose()
    this.connected = false
    console.log(`[${this.botId}] 已断开`)
  }

  private async safeClose(): Promise<void> {
    if (this.context) {
      try {
        await this.context.close()
      } catch {
        // 忽略
      }
      this.context = undefined
    }
  }

  // 登录（仅 cookie）

  private sessionFilePath(): string {
    const dir = this.cfg.sessionDir ?? path.join(process.cwd(), "data", "douyin_session")
    fs.mkdirSync(dir, { recursive: true })
    return path.join(dir, `${this.botId}.json`)
  }

  private async applyManualCookie(cookieStr: string): Promise<void> {
    if (!this.context) return
    const list = cookieStr
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const i = s.indexOf("=")
        const name = i > -1 ? s.slice(0, i).trim() : s
        const value = i > -1 ? s.slice(i + 1).trim() : ""
        return { name, value, domain: ".douyin.com", path: "/", secure: true }
      })
    if (list.length) {
      try {
        await this.context.addCookies(list)
      } catch (e) {
        console.error(`[${this.botId}] 写入 cookie 失败:`, (e as Error).message)
      }
    }
  }

  private async isLoggedIn(): Promise<boolean> {
    if (!this.context) return false
    try {
      const cookies = await this.context.cookies(DOUYIN_URL)
      const names = new Set(cookies.map((c) => c.name))
      return ["sessionid", "sid_guard", "sid_ucp_virtual"].some((n) => names.has(n))
    } catch {
      return false
    }
  }

  private async saveSession(): Promise<void> {
    if (!this.context) return
    try {
      const state = await this.context.storageState()
      fs.writeFileSync(this.sessionFilePath(), JSON.stringify(state, null, 2))
      console.log(`[${this.botId}] 登录态已保存 → ${this.sessionFilePath()}`)
    } catch (e) {
      console.error(`[${this.botId}] 保存登录态失败:`, (e as Error).message)
    }
  }

  // 消息面板（SPA 右侧抽屉）

  // 确保消息面板打开。
  // 抖音网页版消息入口 = 右上角"消息"按钮，点击后右侧弹出面板（URL 不变）。
  // 自动点击偶发不生效（页面未就绪/命中异常），故采用"刷新重试 + 等待可见"策略。
  private async ensureMessagePanel(): Promise<boolean> {
    const page = this.page!
    const listSel = ".conversationConversationListwrapper, .conversationConversationItemwrapper"
    // 已打开：会话列表可见
    if (await page.locator(listSel).first().isVisible({ timeout: 1000 }).catch(() => false)) {
      return true
    }
    // 误跳搜索页 → 回首页
    if (page.url().includes("/search")) {
      await page.goto(DOUYIN_URL, { waitUntil: "domcontentloaded" }).catch(() => {})
      await this.sleep(3500)
      await this.dismissPopups()
    }
    // 多次尝试：点消息按钮 → 等会话列表可见；失败则刷新首页重试
    for (let i = 0; i < 3; i++) {
      await this.clickMessageButton()
      try {
        await page.locator(listSel).first().waitFor({ timeout: 15000, state: "visible" })
        await this.dismissPopups()
        return true
      } catch {
        console.log(`[${this.botId}] 消息面板打开失败(第${i + 1}次)，刷新重试...`)
        await page.goto(DOUYIN_URL, { waitUntil: "domcontentloaded" }).catch(() => {})
        await this.sleep(3500)
        await this.dismissPopups()
      }
    }
    return false
  }

  // 点击右上角"消息"按钮（导航栏可见文本定位，坐标兜底）
  private async clickMessageButton(): Promise<boolean> {
    const page = this.page!
    // 方式1：可见的"消息"文本（导航栏按钮；面板横幅"下载客户端..."不可见，不会误中）
    const msgBtn = page.locator("text=消息").first()
    if (await msgBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
      await msgBtn.click().catch(() => {})
      return true
    }
    // 方式2：坐标兜底（右上角导航，千分比 914,45）
    try {
      const x = Math.round((914 / 1000) * 1280)
      const y = Math.round((45 / 1000) * 800)
      await page.mouse.click(x, y)
      return true
    } catch {
      return false
    }
  }

  // 从消息面板提取会话列表（结构化提取：昵称/时间/预览/未读 是独立元素）
  // 会话项 [data-e2e="conversation-item"]：
  // 昵称 .conversationConversationItemtitle
  // 时间 [class*='timeStr']
  // 预览 [class*='HinttextBox']（pre 元素，真正的最后消息文本）
  // 未读 [class*='unreadCountBadge'] / .semi-badge-count（独立 badge，不会混进预览）
  private async extractPanelConversations(): Promise<DouyinConversation[]> {
    const page = this.page!
    const items = await page
      .locator("[data-e2e='conversation-item'], .conversationConversationItemwrapper")
      .all()
      .catch(() => [])
    const out: DouyinConversation[] = []
    for (const item of items) {
      try {
        const nickname = ((await item.locator(".conversationConversationItemtitle").first().innerText({ timeout: 600 }).catch(() => "")) || "").trim()
        if (!nickname) continue
        const timestamp = ((await item.locator("[class*='timeStr']").first().innerText({ timeout: 500 }).catch(() => "")) || "").trim()
        const preview = ((await item.locator("[class*='HinttextBox'], pre[class*='Hint'], [class*='hintText']").first().innerText({ timeout: 500 }).catch(() => "")) || "").trim()
        const unread = ((await item.locator("[class*='unreadCountBadge'], [class*='UnReadCount'], .semi-badge-count").first().innerText({ timeout: 500 }).catch(() => "")) || "").trim()
        out.push({ nickname, lastMessage: preview, unread, timestamp, isGroup: false })
      } catch {
        // 单条解析失败跳过
      }
    }
    return out
  }

  // 打开指定会话（面板内文本定位）
  private async openConversation(name: string): Promise<boolean> {
    const page = this.page!
    const el = page.locator(`text=${name}`).first()
    try {
      await el.waitFor({ timeout: 6000, state: "visible" })
      await el.click()
      return true
    } catch {
      return false
    }
  }

  // 接收：轮询面板会话列表

  private startPolling(): void {
    const interval = this.cfg.pollInterval ?? 2500
    this.pollTimer = setInterval(() => {
      this.pollOnce().catch(() => {})
    }, interval)
    console.log(`[${this.botId}] 开始轮询消息面板（每 ${interval}ms）`)
  }

  private async pollOnce(): Promise<void> {
    if (this.busy || !this.page || !this.connected) return
    this.busy = true
    try {
      if (!(await this.ensureMessagePanel())) return
      const convs = await this.extractPanelConversations()
      for (const conv of convs) {
        const key = conv.nickname
        if (!key) continue
        const fp = `${conv.lastMessage}|${conv.timestamp}`
        const prev = this.lastSeen.get(key)
        this.lastSeen.set(key, fp)
        if (!prev || prev === fp) continue
        if (this.isSelfEcho(key, conv.lastMessage)) continue
        const raw: DouyinRawMessage = {
          convName: key,
          isGroup: conv.isGroup,
          text: conv.lastMessage || "[未知消息]",
          senderName: key,
          time: Math.floor(Date.now() / 1000),
          isSelf: false,
        }
        convertDouyinMessage(raw, this.botId, this.selfId, this)
      }
    } catch {
      // 轮询失败静默，下次重试
    } finally {
      this.busy = false
    }
  }

  // 判断会话最新预览是否为"自己刚发送"的回显
  private isSelfEcho(convName: string, preview: string): boolean {
    const sent = this.selfSent.get(convName)
    if (!sent) return false
    if (Date.now() - sent.at < 30000 && (preview.includes(sent.text) || sent.text.includes(preview))) return true
    if (Date.now() - sent.at > 30000) this.selfSent.delete(convName)
    return false
  }

  // 发送

  // 向指定会话（昵称）发送文本
  private async sendText(convName: string, text: string): Promise<void> {
    if (!this.page || !this.connected) throw new Error(`[${this.botId}] 未登录，无法发送`)
    if (!convName) throw new Error(`[${this.botId}] 缺少目标会话（昵称）`)
    this.busy = true
    try {
      if (!(await this.ensureMessagePanel())) {
        throw new Error(`[${this.botId}] 消息面板打开失败`)
      }
      const opened = await this.openConversation(convName)
      if (!opened) throw new Error(`[${this.botId}] 找不到会话「${convName}」`)
      // 等聊天输入框出现
      try {
        await this.page.locator("[contenteditable]").first().waitFor({ timeout: 15000, state: "visible" })
      } catch {
        // 输入框未出现，可能点击未进聊天
      }
      await this.sleep(800)
      const typed = await this.typeMessage(text)
      if (!typed) throw new Error(`[${this.botId}] 输入框操作失败`)
      await this.sleep(400)
      const sent = await this.clickSend()
      if (!sent) throw new Error(`[${this.botId}] 发送失败`)
      this.selfSent.set(convName, { text, at: Date.now() })
      await this.sleep(500)
    } finally {
      this.busy = false
    }
  }

  // 聊天输入框注入文本（contenteditable，页面唯一，注意别点顶部搜索框）
  private async typeMessage(text: string): Promise<boolean> {
    const page = this.page!
    let clicked = false
    // 聊天输入框是 contenteditable（class 含 editor/mess）；搜索框是普通 input，用 div[class*='input'] 会误点
    for (const sel of ["[contenteditable]", ".DraftEditor-editor", "textarea"]) {
      const el = page.locator(sel).first()
      if (await el.isVisible({ timeout: 2500 }).catch(() => false)) {
        await el.click().catch(() => {})
        clicked = true
        break
      }
    }
    if (!clicked) return false
    await this.sleep(400)
    const result = await page.evaluate(DRAFTJS_PASTE_SCRIPT, text).catch(() => null)
    if (result && typeof result === "object" && (result as any).success) {
      await this.sleep(400)
      return true
    }
    // 兜底：直接 fill
    try {
      const input = page.locator("[contenteditable], textarea").first()
      if (await input.isVisible({ timeout: 1500 }).catch(() => false)) {
        await input.fill(text)
        return true
      }
    } catch {}
    return false
  }

  // 点击发送按钮（聊天窗口内找，兜底回车）
  private async clickSend(): Promise<boolean> {
    const page = this.page!
    for (const btnSel of ["button:has-text('发送')", "[class*='send-btn']", "[class*='sendButton']", "div[class*='send']", "button[type='submit']", "svg[class*='send']"]) {
      const el = page.locator(btnSel).first()
      if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
        await el.click().catch(() => {})
        return true
      }
    }
    // 兜底：按 Enter 发送（抖音聊天一般回车发送）
    try {
      await page.locator("[contenteditable]").first().press("Enter")
      return true
    } catch {
      return false
    }
  }

  // 工具

  private async sleep(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms))
  }

  private async dismissPopups(): Promise<void> {
    if (!this.page) return
    for (const t of ["我知道了", "稍后再说", "暂不", "关闭"]) {
      const btn = this.page.locator(`text=${t}`).first()
      try {
        if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
          await btn.click().catch(() => {})
          await this.sleep(300)
        }
      } catch {}
    }
  }

  // 会话粒度能力：抖音网页版私信仅文本可靠，不支持富媒体段与群管理。
  computeCapabilities(_event: BotEvent): Readonly<Capabilities> {
    return {
      text: true, image: false, video: false, record: false, file: false,
      markdown: false, button: false, at: false, reply: false, face: false, forward: false,
    }
  }

  public async callApi<T = any>(action: string, params: Record<string, any> = {}): Promise<T> {
    const segs = normalizeSegments(params.message)
    const text = segmentsToText(segs)
    switch (action) {
      case "send_group_msg":
        await this.sendText(String(params.group_id ?? ""), text)
        return true as unknown as T
      case "send_private_msg":
        await this.sendText(String(params.user_id ?? ""), text)
        return true as unknown as T
      case "send_msg":
        if (params.group_id) {
          await this.sendText(String(params.group_id), text)
        } else {
          await this.sendText(String(params.user_id ?? ""), text)
        }
        return true as unknown as T
      case "get_contacts": {
        if (!this.connected) throw new Error(`[${this.botId}] 未登录`)
        this.busy = true
        try {
          if (!(await this.ensureMessagePanel())) return [] as unknown as T
          return (await this.extractPanelConversations()) as unknown as T
        } finally {
          this.busy = false
        }
      }
      default:
        throw new Error(`[${this.botId}] 不支持的 API 操作: ${action}`)
    }
  }

  public async destroy(): Promise<void> {
    await this.disconnect()
    DouyinAdapterMap.delete(this.botId)
    await super.destroy()
  }
}

export function getDouyinAdapterById(botId: string): DouyinAdapter | undefined {
  return DouyinAdapterMap.get(botId)
}
