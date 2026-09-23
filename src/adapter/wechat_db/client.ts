// 微信数据库适配器（直读模式）
// 直读微信 4.x 解密后的 SQLite 数据库，轮询新消息
//
// 1. 微信 4.x 桌面版已登录
// 2. 数据库已解密（用 WeFlow 或其他工具解密）
// 3. 解密后的 .db 文件路径已配置
//
// 配置项：
// botId         - 框架内标识
// type          - "wechat_db"
// dbPath        - 解密后的消息数据库文件路径（如 message_0.db）
// tableName     - 消息表名，默认 "message"
// pollInterval  - 轮询间隔（毫秒），默认 3000
// selfWxid      - 自己的 wxid（用于过滤自己发的消息）

import { BaseAdapter } from "../base.js"
import type { DbMessage } from "./types.js"
import { registerBot } from "../../core/botRegistry.js"
import type { Capabilities } from "../../core/capabilities.js"
import type { BotEvent } from "../../core/models/event.js"
import { MessageSegment } from "../../core/models/message.js"
import type { MessageChain } from "../../core/models/message.js"
import { botLog } from "../../core/logger.js"

export class WeChatDbAdapter extends BaseAdapter {
  public readonly botId: string
  private readonly cfg: Record<string, any>
  private dbPath: string
  private readonly tableName: string
  private readonly pollInterval: number
  private readonly selfWxid: string
  private readonly selfWxname: string
  private key: string
  private readonly dataDir: string
  private watcher?: import('chokidar').FSWatcher
  private pollTimer?: NodeJS.Timeout
  private lastMsgTime: number = 0
  private db: any = null
  private originalDbPath: string = ""  // 原加密数据库路径
  private tmpDir: string = ""          // 临时目录
  private encKey: Buffer | null = null // 缓存的加密密钥
  private macKey: Buffer | null = null // 缓存的 HMAC 密钥
  private contactMap: Map<string, { username: string, nickName: string, isGroup: boolean }> = new Map() // hash -> 联系人信息
  private idToUsername: Map<number, string> = new Map() // contact id -> username
  private usernameToId: Map<string, number> = new Map() // username -> contact id
  private lastFileMtime: number = 0  // 上次读取的文件修改时间
  private lastWalCommit: number = 0
  private lastWalFrames: Map<number, string> = new Map()  // 上次 WAL commit 计数

  private currentChat: string = ""   // 当前打开的聊天对象（缓存，避免重复搜索）
  private sendQueue: Array<() => Promise<void>> = []  // 发送队列，串行执行
  private sending: boolean = false   // 是否正在发送
  private polling: boolean = false   // 是否正在轮询（防止并发）
  private mainDbDecrypted: boolean = false  // 主库是否已解密过
  private eventQueue: Array<() => Promise<void>> = []  // 事件队列，保证消息按顺序处理
  private processingEvent: boolean = false  // 是否正在处理事件

  constructor(config: Record<string, any>) {
    super()
    this.cfg = config
    this.botId = config.botId
    this.dbPath = config.dbPath || ""
    this.tableName = config.tableName || "message"
    this.pollInterval = config.pollInterval || 1000
    this.selfWxid = config.selfWxid || ""
    this.selfWxname = config.selfWxname || ""
    this.key = config.key || ""
    this.dataDir = config.dataDir || ""
    registerBot(this)
  }

  public async connect(): Promise<void> {
    // 优先自动从微信进程内存扫描密钥；失败再回退到 config.json 里手动配置的 key
    if (this.dataDir && this.cfg.autoGetKey !== false) {
      try {
        console.log(`[WeChatDb] 尝试自动获取数据库密钥...`)
        const { scanWeChatDatabaseKey } = await import("./keyScanner.js")
        const autoKey = await scanWeChatDatabaseKey({
          dataDir: this.dataDir,
          wechatInstallPath: this.cfg.wechatInstallPath || undefined,
          log: (m: string) => console.log(m),
        })
        if (autoKey) {
          this.key = autoKey
          console.log(`[WeChatDb] 自动获取数据库密钥成功`)
        } else if (this.key) {
          console.log(`[WeChatDb] 自动获取密钥失败，使用配置文件中的 key`)
        } else {
          throw new Error("[WeChatDb] 自动获取密钥失败，且未在 config.json 配置 key；请填写 key 或登录微信后重试")
        }
      } catch (e) {
        if (this.key) {
          console.log(`[WeChatDb] 自动获取密钥异常，回退配置 key: ${(e as Error).message}`)
        } else {
          throw e
        }
      }
    }
    // 如果配置了 key，先解密数据库
    if (this.key && this.dataDir) {
      console.log(`[WeChatDb] 开始解密...`)
      await this.decryptDatabase()
    }

    if (!this.dbPath) {
      throw new Error(
        "[WeChatDb] 配置错误：\n" +
        "  方式一（推荐）：配置 dataDir + key，适配器自动解密\n" +
        "  方式二：配置 dbPath（解密后的数据库文件路径）"
      )
    }

    // 动态加载 better-sqlite3
    try {
      // @ts-ignore - better-sqlite3 可选依赖，运行时动态加载
      const Database = (await import("better-sqlite3")).default
      this.db = new Database(this.dbPath, { readonly: true, fileMustExist: true })
      console.log(`[WeChatDb] 数据库已连接: ${this.dbPath}`)
    } catch (e) {
      throw new Error(
        `[WeChatDb] 无法连接数据库: ${(e as Error).message}\n` +
        `  请确认:\n` +
        `    1. 数据库文件存在且路径正确\n` +
        `    2. 数据库已解密（不是加密的 .db 文件）\n` +
        `    3. 已安装 better-sqlite3: npm install better-sqlite3`
      )
    }

    // 加载联系人映射（Msg_<hash> -> 昵称）
    await this.loadContactMap()

    // 初始化：获取当前最新消息时间作为起点（遍历所有 Msg_* 表）
    try {
      const tables = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"
      ).all() as { name: string }[]

      // 记录每个表的最大 rowid
      let maxTime = 0
      for (const { name: tableName } of tables) {
        try {
          const row = this.db.prepare(`SELECT MAX(create_time) as maxTime FROM ` + tableName).get()
          if (row?.maxTime && row.maxTime > maxTime) {
            maxTime = row.maxTime
          }
        } catch {}
      }
      if (maxTime > 0) {
        this.lastMsgTime = maxTime
        console.log(`[WeChatDb] 初始时间戳: ${this.lastMsgTime} (跳过历史消息)`)
      }
      console.log(`[WeChatDb] 共找到 ${tables.length} 个消息表`)
    } catch (e) {
      console.warn(`[WeChatDb] 获取初始时间戳失败: ${(e as Error).message}`)
    }




    // 内核级文件监听 WAL，微信一写立刻触发，不用等缓存
    const path = await import("path")
    const walPath = path.join(this.dataDir, "db_storage/message/message_0.db-wal")
    let debounceTimer: NodeJS.Timeout | undefined
    // @ts-ignore
    const chokidar = (await import("chokidar")).default
    this.watcher = chokidar.watch(walPath, { persistent: true, awaitWriteFinish: false })
    this.watcher.on("change", () => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => this.pollMessages(), 10)
    })

    this.connected = true

  }
  public async disconnect(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close()
      this.watcher = undefined
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
    console.log(`[WeChatDb] 适配器已断开 (botId=${this.botId})`)
  }

  // 统一 API 入口
  public async callApi<T = unknown>(action: string, params?: Record<string, unknown>): Promise<T> {
    switch (action) {
      case "get_messages":
        return this.queryMessages(params) as T
      case "get_sessions":
        return this.querySessions() as T
      case "get_contacts":
        return this.getContacts() as T
      case "get_group_members":
        return this.getGroupMembers(params) as T
      case "get_history":
        return this.getHistory(params) as T
      case "get_favorites":
        return this.getFavorites(params) as T
      case "get_moments":
        return this.getMoments(params) as T
      case "get_group_announcement":
        return this.getGroupAnnouncement(params) as T
      case "get_emoticons":
        return this.getEmoticons(params) as T
      case "get_biz_contacts":
        return this.getBizContacts() as T
      case "get_contact_labels":
        return this.getContactLabels() as T
      default:
        throw new Error(`[WeChatDb] 不支持 ${action}`)
    }
  }

  // 获取联系人列表
  private getContacts(): unknown {
    const result: { username: string, nick_name: string, is_group: boolean }[] = []
    for (const [, info] of this.contactMap) {
      result.push({
        username: info.username,
        nick_name: info.nickName,
        is_group: info.isGroup,
      })
    }
    return result
  }

  // 获取群成员
  private async getGroupMembers(params?: Record<string, unknown>): Promise<unknown> {
    const groupId = String(params?.group_id || "")
    if (!groupId) return []

    const fs = await import("fs/promises")
    const path = await import("path")
    const crypto = await import("crypto")

    try {
      const contactDbPath = path.join(this.dataDir, "db_storage", "contact", "contact.db")
      const fileBuffer = await fs.readFile(contactDbPath)
      const PAGE_SIZE = 4096, KEY_SIZE = 32, SALT_SIZE = 16, IV_SIZE = 16, HMAC_SIZE = 64, RESERVE_SIZE = IV_SIZE + HMAC_SIZE
      const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "utf8")
      const salt = fileBuffer.subarray(0, SALT_SIZE)
      const keyMaterial = Buffer.from(this.key, "hex")
      const encKey = crypto.pbkdf2Sync(keyMaterial, salt, 256000, KEY_SIZE, "sha512")
      const totalPages = Math.ceil(fileBuffer.length / PAGE_SIZE)
      const decrypted = Buffer.alloc(totalPages * PAGE_SIZE)
      for (let i = 0; i < totalPages; i++) {
        const pageNum = i + 1, start = i * PAGE_SIZE
        const page = fileBuffer.subarray(start, start + PAGE_SIZE)
        const iv = page.subarray(PAGE_SIZE - RESERVE_SIZE, PAGE_SIZE - RESERVE_SIZE + IV_SIZE)
        const pageOffset = pageNum === 1 ? SALT_SIZE : 0
        const encrypted = page.subarray(pageOffset, PAGE_SIZE - RESERVE_SIZE)
        const decipher = crypto.createDecipheriv("aes-256-cbc", encKey, iv)
        decipher.setAutoPadding(false)
        const dp = Buffer.concat([decipher.update(encrypted), decipher.final()])
        if (pageNum === 1) { SQLITE_HEADER.copy(decrypted, start); dp.copy(decrypted, start + SALT_SIZE) }
        else { dp.copy(decrypted, start) }
      }
      const os = await import("os")
      const tmpPath = path.join(os.tmpdir(), `contact-${Date.now()}.db`)
      await fs.writeFile(tmpPath, decrypted)
      const Database = (await import("better-sqlite3")).default
      const db = new Database(tmpPath, { readonly: true })

      // 找群的 id
      const groupRow = db.prepare("SELECT id FROM contact WHERE username = ?").get(groupId) as { id: number }
      if (!groupRow) return []
      const roomId = groupRow.id

      // 找群成员
      const members = db.prepare("SELECT member_id FROM chatroom_member WHERE room_id = ?").all(roomId) as { member_id: number }[]
      const result: { wxid: string, nick_name: string }[] = []
      for (const m of members) {
        const userRow = db.prepare("SELECT username, nick_name FROM contact WHERE id = ?").get(m.member_id) as { username: string, nick_name: string }
        if (userRow) {
          result.push({ wxid: userRow.username, nick_name: userRow.nick_name || userRow.username })
        }
      }
      db.close()
      return result
    } catch (e) {
      console.warn(`[WeChatDb] get_group_members 失败: ${(e as Error).message}`)
      return []
    }
  }

  // 获取聊天历史
  private getHistory(params?: Record<string, unknown>): unknown {
    if (!this.db) return []
    const talker = String(params?.talker || "")
    const limit = Number(params?.limit || 50)
    if (!talker) return []

    const crypto = require("crypto")
    const hash = crypto.createHash("md5").update(talker).digest("hex")
    const tableName = `Msg_${hash}`

    try {
      return this.db.prepare(
        `SELECT * FROM ${tableName} ORDER BY create_time DESC LIMIT ?`
      ).all(limit)
    } catch {
      return []
    }
  }

  // 获取收藏
  private async getFavorites(params?: Record<string, unknown>): Promise<unknown> {
    const limit = Number(params?.limit || 50)
    const fs = await import("fs/promises")
    const path = await import("path")
    const crypto = await import("crypto")

    try {
      const favPath = path.join(this.dataDir, "db_storage", "favorite", "favorite.db")
      const fileBuffer = await fs.readFile(favPath)
      const PAGE_SIZE = 4096, KEY_SIZE = 32, SALT_SIZE = 16, IV_SIZE = 16, HMAC_SIZE = 64, RESERVE_SIZE = IV_SIZE + HMAC_SIZE
      const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "utf8")
      const salt = fileBuffer.subarray(0, SALT_SIZE)
      const keyMaterial = Buffer.from(this.key, "hex")
      const encKey = crypto.pbkdf2Sync(keyMaterial, salt, 256000, KEY_SIZE, "sha512")
      const totalPages = Math.ceil(fileBuffer.length / PAGE_SIZE)
      const decrypted = Buffer.alloc(totalPages * PAGE_SIZE)
      for (let i = 0; i < totalPages; i++) {
        const pageNum = i + 1, start = i * PAGE_SIZE
        const page = fileBuffer.subarray(start, start + PAGE_SIZE)
        const iv = page.subarray(PAGE_SIZE - RESERVE_SIZE, PAGE_SIZE - RESERVE_SIZE + IV_SIZE)
        const pageOffset = pageNum === 1 ? SALT_SIZE : 0
        const encrypted = page.subarray(pageOffset, PAGE_SIZE - RESERVE_SIZE)
        const decipher = crypto.createDecipheriv("aes-256-cbc", encKey, iv)
        decipher.setAutoPadding(false)
        const dp = Buffer.concat([decipher.update(encrypted), decipher.final()])
        if (pageNum === 1) { SQLITE_HEADER.copy(decrypted, start); dp.copy(decrypted, start + SALT_SIZE) }
        else { dp.copy(decrypted, start) }
      }
      const os = await import("os")
      const tmpPath = path.join(os.tmpdir(), `fav-${Date.now()}.db`)
      await fs.writeFile(tmpPath, decrypted)
      const Database = (await import("better-sqlite3")).default
      const db = new Database(tmpPath, { readonly: true })
      const rows = db.prepare("SELECT type, content, fromusr, update_time FROM fav_db_item ORDER BY update_time DESC LIMIT ?").all(limit)
      db.close()
      return rows
    } catch (e) {
      console.warn(`[WeChatDb] get_favorites 失败: ${(e as Error).message}`)
      return []
    }
  }

  // 获取朋友圈
  private async getMoments(params?: Record<string, unknown>): Promise<unknown> {
    const limit = Number(params?.limit || 50)
    const fs = await import("fs/promises")
    const path = await import("path")
    const crypto = await import("crypto")

    try {
      const snsPath = path.join(this.dataDir, "db_storage", "sns", "sns.db")
      const fileBuffer = await fs.readFile(snsPath)
      const PAGE_SIZE = 4096, KEY_SIZE = 32, SALT_SIZE = 16, IV_SIZE = 16, HMAC_SIZE = 64, RESERVE_SIZE = IV_SIZE + HMAC_SIZE
      const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "utf8")
      const salt = fileBuffer.subarray(0, SALT_SIZE)
      const keyMaterial = Buffer.from(this.key, "hex")
      const encKey = crypto.pbkdf2Sync(keyMaterial, salt, 256000, KEY_SIZE, "sha512")
      const totalPages = Math.ceil(fileBuffer.length / PAGE_SIZE)
      const decrypted = Buffer.alloc(totalPages * PAGE_SIZE)
      for (let i = 0; i < totalPages; i++) {
        const pageNum = i + 1, start = i * PAGE_SIZE
        const page = fileBuffer.subarray(start, start + PAGE_SIZE)
        const iv = page.subarray(PAGE_SIZE - RESERVE_SIZE, PAGE_SIZE - RESERVE_SIZE + IV_SIZE)
        const pageOffset = pageNum === 1 ? SALT_SIZE : 0
        const encrypted = page.subarray(pageOffset, PAGE_SIZE - RESERVE_SIZE)
        const decipher = crypto.createDecipheriv("aes-256-cbc", encKey, iv)
        decipher.setAutoPadding(false)
        const dp = Buffer.concat([decipher.update(encrypted), decipher.final()])
        if (pageNum === 1) { SQLITE_HEADER.copy(decrypted, start); dp.copy(decrypted, start + SALT_SIZE) }
        else { dp.copy(decrypted, start) }
      }
      const os = await import("os")
      const tmpPath = path.join(os.tmpdir(), `sns-${Date.now()}.db`)
      await fs.writeFile(tmpPath, decrypted)
      const Database = (await import("better-sqlite3")).default
      const db = new Database(tmpPath, { readonly: true })
      const rows = db.prepare("SELECT user_name, content, pack_info_buf FROM SnsTimeLine LIMIT ?").all(limit)
      db.close()
      return rows
    } catch (e) {
      console.warn(`[WeChatDb] get_moments 失败: ${(e as Error).message}`)
      return []
    }
  }

  // 能力集（模拟键鼠发送，支持文本、图片、文件）
  public computeCapabilities(_event: BotEvent): Readonly<Capabilities> {
    return {
      text: true,
      image: true,
      record: true,
      video: true,
      file: true,
      at: false,
      reply: false,
      face: false,
      forward: false,
      markdown: false,
      card: false,
      canMuteMember: false,
      canKickMember: false,
      canSetAdmin: false,
    }
  }

  // 发送群消息（模拟键鼠）
  public async sendGroupMsg(groupId: number | string, chain: MessageChain | string): Promise<unknown> {
    await this.sendViaKeyboard(chain, groupId)
    return { ok: true }
  }

  // 发送私聊消息（模拟键鼠）
  public async sendPrivateMsg(userId: number | string, chain: MessageChain | string): Promise<unknown> {
    await this.sendViaKeyboard(chain, userId)
    return { ok: true }
  }

  // 模拟键鼠发送消息（支持文本和图片）—— 加入队列，串行执行
  private async sendViaKeyboard(chain: MessageChain | string, target: number | string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sendQueue.push(async () => {
        try {
          await this.doSend(chain, target)
          resolve()
        } catch (e) {
          reject(e)
        }
      })
      this.processSendQueue()
    })
  }

  // 处理发送队列
  private async processSendQueue(): Promise<void> {
    if (this.sending) return
    this.sending = true
    while (this.sendQueue.length > 0) {
      const task = this.sendQueue.shift()!
      await task()
    }
    this.sending = false
  }

  // 实际执行发送
  private async doSend(chain: MessageChain | string, target: number | string): Promise<void> {
    try {
      const { exec } = await import("child_process")
      const { promisify } = await import("util")
      const execAsync = promisify(exec)

      // 动态加载 nut-js
      // @ts-ignore
      const nut = await import("@nut-tree/nut-js")

      // 1. 激活个人微信窗口（优先按昵称找，更准确）
      let psCmd: string
      if (this.selfWxname) {
        // 按窗口标题找
        const escapedName = this.selfWxname.replace(/'/g, "''")
        psCmd = `(New-Object -ComObject wscript.shell).AppActivate('${escapedName}')`
      } else {
        // 按进程名找
        psCmd = `(New-Object -ComObject wscript.shell).AppActivate((Get-Process Weixin -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).Id)`
      }
      await execAsync(`powershell -command "${psCmd}"`)
      await new Promise(r => setTimeout(r, 150))

      const targetStr = String(target)

      // 查找目标昵称
      let targetName = targetStr
      for (const [, info] of this.contactMap) {
        if (info.username === targetStr) {
          targetName = info.nickName
          break
        }
      }

      // 2. 如果不是同一个聊天，才需要搜索切换
      if (this.currentChat !== targetStr) {
        // 从联系人映射里找目标昵称，用昵称搜索
        let searchKey = targetStr

        // 方式1：如果是 Msg_<hash> 格式，去掉前缀后查
        let hashKey = targetStr
        if (hashKey.startsWith("Msg_")) {
          hashKey = hashKey.substring(4)
        }
        const byHash = this.contactMap.get(hashKey)
        if (byHash) {
          searchKey = byHash.nickName
        } else {
          // 方式2：遍历找 username 匹配
          for (const [, info] of this.contactMap) {
            if (info.username === targetStr) {
              searchKey = info.nickName
              break
            }
          }
        }

        // Ctrl+F 打开搜索
        await nut.keyboard.pressKey(nut.Key.LeftControl)
        await nut.keyboard.pressKey(nut.Key.F)
        await nut.keyboard.releaseKey(nut.Key.F)
        await nut.keyboard.releaseKey(nut.Key.LeftControl)
        await new Promise(r => setTimeout(r, 150))

        // 粘贴搜索词（写到临时文件，避免转义问题）
        const fsTmp = await import("fs/promises")
        const osTmp = await import("os")
        const pathTmp = await import("path")
        const tmpKeyFile = pathTmp.join(osTmp.tmpdir(), `wechat-search-${Date.now()}.txt`)
        await fsTmp.writeFile(tmpKeyFile, searchKey, "utf8")
        await execAsync(`powershell -command "Set-Clipboard -Value (Get-Content '${tmpKeyFile}' -Raw -Encoding UTF8)"`)
        await new Promise(r => setTimeout(r, 50))

        await nut.keyboard.pressKey(nut.Key.LeftControl)
        await nut.keyboard.pressKey(nut.Key.V)
        await nut.keyboard.releaseKey(nut.Key.V)
        await nut.keyboard.releaseKey(nut.Key.LeftControl)
        await new Promise(r => setTimeout(r, 200))

        // 回车打开聊天
        await nut.keyboard.pressKey(nut.Key.Enter)
        await nut.keyboard.releaseKey(nut.Key.Enter)
        await new Promise(r => setTimeout(r, 150))

        this.currentChat = targetStr
      }

      // 3. 解析消息链
      const segments: any[] = typeof chain === "string"
        ? [{ type: "text", data: { text: chain } }]
        : chain


      // 合并连续的 text segment（避免插件把 JSON 等带 [] 的内容拆成多个 text segment）
      const merged: any[] = []
      for (const s of segments) {
        if (s.type === "text" && merged.length > 0 && merged[merged.length - 1].type === "text") {
          merged[merged.length - 1].data.text = (merged[merged.length - 1].data.text || "") + (s.data?.text || "")
        } else {
          merged.push(s)
        }
      }

      // 4. 逐个发送消息段
      for (const seg of merged) {
        if (seg.type === "text") {
          // 文本消息
          const text = seg.data.text || ""
          // 文本消息（写到临时文件，避免转义问题）
          const fsTxt = await import("fs/promises")
          const osTxt = await import("os")
          const pathTxt = await import("path")
          const tmpTxtFile = pathTxt.join(osTxt.tmpdir(), `wechat-msg-${Date.now()}.txt`)
          await fsTxt.writeFile(tmpTxtFile, text, "utf8")
          await execAsync(`powershell -command "Set-Clipboard -Value (Get-Content '${tmpTxtFile}' -Raw -Encoding UTF8)"`)
          await new Promise(r => setTimeout(r, 50))
          await new Promise(r => setTimeout(r, 50))

          await nut.keyboard.pressKey(nut.Key.LeftControl)
          await nut.keyboard.pressKey(nut.Key.V)
          await nut.keyboard.releaseKey(nut.Key.V)
          await nut.keyboard.releaseKey(nut.Key.LeftControl)
          await new Promise(r => setTimeout(r, 100))

          await nut.keyboard.pressKey(nut.Key.Enter)
          await nut.keyboard.releaseKey(nut.Key.Enter)
          await new Promise(r => setTimeout(r, 100))

          // 打印发送日志（统一格式）
          const isGroupChat = targetStr.includes("@chatroom")
          botLog(this.selfWxid, "->", isGroupChat ? "群聊" : "私聊", targetStr, text)
        } else if (seg.type === "image") {
          // 图片消息：把图片复制到剪贴板，然后粘贴发送
          const input = seg.data.file || seg.data.url || ""
          if (!input) continue

          let file = input

          // 支持 base64:// 格式
          if (input.startsWith("base64://")) {
            const base64Data = input.substring(9)
            const imgBuffer = Buffer.from(base64Data, "base64")
            const fs = await import("fs/promises")
            const os = await import("os")
            const path = await import("path")
            const tmpFile = path.join(os.tmpdir(), `wechat-img-${Date.now()}.png`)
            await fs.writeFile(tmpFile, imgBuffer)
            file = tmpFile
          }

          // 用 PowerShell 把图片放到剪贴板
          const escapedFile = file.replace(/'/g, "''")
          const psImageCmd = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $img = [System.Drawing.Image]::FromFile('${escapedFile}'); [System.Windows.Forms.Clipboard]::SetImage($img)`
          await execAsync(`powershell -command "${psImageCmd}"`)
          await new Promise(r => setTimeout(r, 100))

          // Ctrl+V 粘贴图片
          await nut.keyboard.pressKey(nut.Key.LeftControl)
          await nut.keyboard.pressKey(nut.Key.V)
          await nut.keyboard.releaseKey(nut.Key.V)
          await nut.keyboard.releaseKey(nut.Key.LeftControl)
          await new Promise(r => setTimeout(r, 200))

          // 回车发送
          await nut.keyboard.pressKey(nut.Key.Enter)
          await nut.keyboard.releaseKey(nut.Key.Enter)
          await new Promise(r => setTimeout(r, 100))

          const isGroupChat = targetStr.includes("@chatroom")
          botLog(this.selfWxid, "->", isGroupChat ? "群聊" : "私聊", targetStr, "[图片]")
        } else if (seg.type === "record" || seg.type === "video" || seg.type === "file") {
          // 语音/视频/文件：当文件发送
          const file = seg.data.file || seg.data.url || ""
          if (!file) continue

          // 把文件路径放到剪贴板（用文件形式）
          const fs = await import("fs/promises")
          const os = await import("os")
          const path = await import("path")

          // 支持 base64:// 格式
          let actualFile = file
          if (file.startsWith("base64://")) {
            const base64Data = file.substring(9)
            const imgBuffer = Buffer.from(base64Data, "base64")
            const ext = seg.type === "record" ? ".mp3" : seg.type === "video" ? ".mp4" : ".dat"
            const tmpFile = path.join(os.tmpdir(), `wechat-file-${Date.now()}${ext}`)
            await fs.writeFile(tmpFile, imgBuffer)
            actualFile = tmpFile
          }

          // 用 PowerShell 把文件复制到剪贴板（文件形式）
          const escapedFile = actualFile.replace(/'/g, "''")
          const psFileCmd = `Add-Type -AssemblyName System.Windows.Forms; $files = New-Object System.Collections.Specialized.StringCollection; $files.Add('${escapedFile}'); [System.Windows.Forms.Clipboard]::SetFileDropList($files)`
          await execAsync(`powershell -command "${psFileCmd}"`)
          await new Promise(r => setTimeout(r, 100))

          // Ctrl+V 粘贴文件
          await nut.keyboard.pressKey(nut.Key.LeftControl)
          await nut.keyboard.pressKey(nut.Key.V)
          await nut.keyboard.releaseKey(nut.Key.V)
          await nut.keyboard.releaseKey(nut.Key.LeftControl)
          await new Promise(r => setTimeout(r, 200))

          // 回车发送
          await nut.keyboard.pressKey(nut.Key.Enter)
          await nut.keyboard.releaseKey(nut.Key.Enter)
          await new Promise(r => setTimeout(r, 100))

          const isGroupChat = targetStr.includes("@chatroom")
          botLog(this.selfWxid, "->", isGroupChat ? "群聊" : "私聊", targetStr, `[${seg.type}]`)
        }
      }
    } catch (e) {
      throw new Error(`[WeChatDb] 发送消息失败: ${(e as Error).message}`)
    }
  }

  // ============ 自动解密 ============

  private async decryptDatabase(): Promise<void> {
    const fs = await import("fs/promises")
    const path = await import("path")
    const os = await import("os")

    // 找到消息数据库文件
    const msgDir = path.join(this.dataDir, "db_storage", "message")
    let msgDbPath = path.join(msgDir, "message_0.db")

    try {
      await fs.access(msgDbPath)
    } catch {
      // 尝试其他可能的文件名
      const possibleNames = ["message_0.db", "biz_message_0.db", "MSG0.db", "message.db"]
      let found = false
      for (const name of possibleNames) {
        try {
          const testPath = path.join(msgDir, name)
          await fs.access(testPath)
          msgDbPath = testPath
          found = true
          break
        } catch {}
      }
      if (!found) {
        throw new Error(`[WeChatDb] 在 ${msgDir} 找不到消息数据库文件`)
      }
    }

    console.log(`[WeChatDb] 找到加密数据库: ${msgDbPath}`)

    // 自己实现解密（参考 WeChatDataAnalysis 的解密逻辑）
    try {
      const crypto = await import("crypto")
      const fileBuffer = await fs.readFile(msgDbPath)

      // 微信 4.x 参数
      const PAGE_SIZE = 4096
      const KEY_SIZE = 32
      const SALT_SIZE = 16
      const IV_SIZE = 16
      const HMAC_SIZE = 64
      const RESERVE_SIZE = IV_SIZE + HMAC_SIZE // 80
      const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "utf8")

      // 读取 salt（第 1 页前 16 字节）
      const salt = fileBuffer.subarray(0, SALT_SIZE)
      console.log(`[WeChatDb] 数据库 salt: ${salt.toString("hex")}`)

      // 密钥材料（用户提供的 64 位 hex = 32 字节）
      const keyMaterial = Buffer.from(this.key, "hex")
      if (keyMaterial.length !== KEY_SIZE) {
        throw new Error(`密钥长度不对，应该是 64 位 hex（32 字节），实际 ${keyMaterial.length} 字节`)
      }

      // 派生 enc_key 和 mac_key
      let encKey: Buffer
      let macKey: Buffer
      let keyMode: string

      // mac_salt = salt 每个字节异或 0x3A
      const macSalt = Buffer.from(salt.map(b => b ^ 0x3A))

      // 先试 raw key 模式（用户提供的是 32 字节 enc_key）
      const macKeyRaw = crypto.pbkdf2Sync(keyMaterial, macSalt, 2, KEY_SIZE, "sha512")
      const page1 = fileBuffer.subarray(0, PAGE_SIZE)
      const storedHmac1 = page1.subarray(PAGE_SIZE - HMAC_SIZE, PAGE_SIZE)

      // 计算第 1 页 HMAC
      const hmacRaw = crypto.createHmac("sha512", macKeyRaw)
      hmacRaw.update(page1.subarray(SALT_SIZE, PAGE_SIZE - RESERVE_SIZE + IV_SIZE))
      hmacRaw.update(Buffer.from([1, 0, 0, 0])) // page number 1, little-endian
      const computedHmacRaw = hmacRaw.digest()

      if (crypto.timingSafeEqual(storedHmac1, computedHmacRaw)) {
        encKey = keyMaterial
        macKey = macKeyRaw
        keyMode = "raw_enc_key"
      } else {
        // 试 passphrase 模式：PBKDF2 派生 enc_key
        encKey = crypto.pbkdf2Sync(keyMaterial, salt, 256000, KEY_SIZE, "sha512")
        macKey = crypto.pbkdf2Sync(encKey, macSalt, 2, KEY_SIZE, "sha512")

        const hmacPass = crypto.createHmac("sha512", macKey)
        hmacPass.update(page1.subarray(SALT_SIZE, PAGE_SIZE - RESERVE_SIZE + IV_SIZE))
        hmacPass.update(Buffer.from([1, 0, 0, 0]))
        const computedHmacPass = hmacPass.digest()

        if (crypto.timingSafeEqual(storedHmac1, computedHmacPass)) {
          keyMode = "passphrase"
        } else {
          throw new Error("密钥验证失败（HMAC 不匹配），密钥可能不对")
        }
      }

      console.log(`[WeChatDb] 密钥验证成功，模式: ${keyMode}`)

      // 逐页解密
      const totalPages = Math.ceil(fileBuffer.length / PAGE_SIZE)
      const decrypted = Buffer.alloc(totalPages * PAGE_SIZE)

      for (let i = 0; i < totalPages; i++) {
        const pageNum = i + 1
        const start = i * PAGE_SIZE
        const page = fileBuffer.subarray(start, start + PAGE_SIZE)

        // IV = page[PAGE_SIZE - RESERVE_SIZE : PAGE_SIZE - RESERVE_SIZE + IV_SIZE]
        const iv = page.subarray(PAGE_SIZE - RESERVE_SIZE, PAGE_SIZE - RESERVE_SIZE + IV_SIZE)

        // encrypted data = page[offset : PAGE_SIZE - RESERVE_SIZE]
        const pageOffset = pageNum === 1 ? SALT_SIZE : 0
        const encrypted = page.subarray(pageOffset, PAGE_SIZE - RESERVE_SIZE)

        // AES-256-CBC 解密
        const decipher = crypto.createDecipheriv("aes-256-cbc", encKey, iv)
        decipher.setAutoPadding(false)
        const decryptedPage = Buffer.concat([decipher.update(encrypted), decipher.final()])

        // 写入输出
        if (pageNum === 1) {
          // 第 1 页：SQLite header + decrypted + zero padding
          SQLITE_HEADER.copy(decrypted, start)
          decryptedPage.copy(decrypted, start + SALT_SIZE)
        } else {
          decryptedPage.copy(decrypted, start)
        }
      }

      console.log(`[WeChatDb] 解密完成，共 ${totalPages} 页`)

      // 保存到临时文件
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wechat_db-"))
      const tmpDbPath = path.join(tmpDir, "message_decrypted.db")
      await fs.writeFile(tmpDbPath, decrypted)

      this.dbPath = tmpDbPath
      this.originalDbPath = msgDbPath  // 保存原加密数据库路径
      this.tmpDir = tmpDir            // 保存临时目录
      this.encKey = encKey            // 缓存加密密钥
      this.macKey = macKey            // 缓存 HMAC 密钥
      console.log(`[WeChatDb] 数据库解密完成: ${tmpDbPath}`)
    } catch (e) {
      throw new Error(
        `[WeChatDb] 数据库解密失败: ${(e as Error).message}\n` +
        `  请确认密钥是否正确`
      )
    }
  }

  // ============ 加载联系人映射 ============

  private async loadContactMap(): Promise<void> {
    if (!this.dataDir || !this.key) return

    const fs = await import("fs/promises")
    const path = await import("path")
    const crypto = await import("crypto")

    try {
      // 解密一个加密 db 文件的通用函数
      const decryptDbFile = async (dbPath: string): Promise<string> => {
        const fileBuffer = await fs.readFile(dbPath)
        const PAGE_SIZE = 4096
        const KEY_SIZE = 32
        const SALT_SIZE = 16
        const IV_SIZE = 16
        const HMAC_SIZE = 64
        const RESERVE_SIZE = IV_SIZE + HMAC_SIZE
        const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "utf8")

        const salt = fileBuffer.subarray(0, SALT_SIZE)
        const keyMaterial = Buffer.from(this.key, "hex")
        const encKey = crypto.pbkdf2Sync(keyMaterial, salt, 256000, KEY_SIZE, "sha512")

        const totalPages = Math.ceil(fileBuffer.length / PAGE_SIZE)
        const decrypted = Buffer.alloc(totalPages * PAGE_SIZE)

        for (let i = 0; i < totalPages; i++) {
          const pageNum = i + 1
          const start = i * PAGE_SIZE
          const page = fileBuffer.subarray(start, start + PAGE_SIZE)
          const iv = page.subarray(PAGE_SIZE - RESERVE_SIZE, PAGE_SIZE - RESERVE_SIZE + IV_SIZE)
          const pageOffset = pageNum === 1 ? SALT_SIZE : 0
          const encrypted = page.subarray(pageOffset, PAGE_SIZE - RESERVE_SIZE)
          const decipher = crypto.createDecipheriv("aes-256-cbc", encKey, iv)
          decipher.setAutoPadding(false)
          const decryptedPage = Buffer.concat([decipher.update(encrypted), decipher.final()])
          if (pageNum === 1) {
            SQLITE_HEADER.copy(decrypted, start)
            decryptedPage.copy(decrypted, start + SALT_SIZE)
          } else {
            decryptedPage.copy(decrypted, start)
          }
        }

        const outPath = path.join(this.tmpDir, path.basename(dbPath) + ".decrypted")
        await fs.writeFile(outPath, decrypted)
        return outPath
      }

      // 1. 从 contact.db 加载联系人
      const contactDbPath = path.join(this.dataDir, "db_storage", "contact", "contact.db")
      try {
        await fs.access(contactDbPath)
        const tmpContactPath = await decryptDbFile(contactDbPath)
        // @ts-ignore
        const Database = (await import("better-sqlite3")).default
        const contactDb = new Database(tmpContactPath, { readonly: true, fileMustExist: true })
        const contacts = contactDb.prepare("SELECT id, username, nick_name FROM contact").all() as { id: number, username: string, nick_name: string }[]

        let groupCount = 0
        for (const c of contacts) {
          const hash = crypto.createHash("md5").update(c.username).digest("hex")
          const isGroup = c.username.endsWith("@chatroom")
          if (isGroup) groupCount++
          this.contactMap.set(hash, {
            username: c.username,
            nickName: c.nick_name || c.username,
            isGroup,
          })
          this.idToUsername.set(c.id, c.username)
        }
        contactDb.close()
        console.log(`[WeChatDb] 从 contact.db 加载 ${contacts.length} 个联系人`)
      } catch (e) {
        console.warn(`[WeChatDb] contact.db 读取失败: ${(e as Error).message}`)
      }

      // 2. 从 session.db 加载会话（补充不在 contact 里的群/好友）
      const sessionDbPath = path.join(this.dataDir, "db_storage", "session", "session.db")
      try {
        await fs.access(sessionDbPath)
        const tmpSessionPath = await decryptDbFile(sessionDbPath)
        // @ts-ignore
        const Database = (await import("better-sqlite3")).default
        const sessionDb = new Database(tmpSessionPath, { readonly: true, fileMustExist: true })
        const sessions = sessionDb.prepare("SELECT username FROM SessionTable").all() as { username: string }[]

        let addedCount = 0
        for (const s of sessions) {
          const hash = crypto.createHash("md5").update(s.username).digest("hex")
          // 只加 contact 里没有的
          if (!this.contactMap.has(hash)) {
            const isGroup = s.username.endsWith("@chatroom")
            this.contactMap.set(hash, {
              username: s.username,
              nickName: s.username, // session 表没昵称，先用 username
              isGroup,
            })
            addedCount++
          }
        }
        sessionDb.close()
        console.log(`[WeChatDb] 从 session.db 补充 ${addedCount} 个会话`)
      } catch (e) {
        console.warn(`[WeChatDb] session.db 读取失败: ${(e as Error).message}`)
      }

      console.log(`[WeChatDb] 共 ${this.contactMap.size} 个会话映射`)
    } catch (e) {
      console.warn(`[WeChatDb] 加载联系人映射失败: ${(e as Error).message}`)
    }
  }

  // ============ 轮询新消息 ============

  private async pollMessages(): Promise<void> {
    // 防止并发轮询，保证消息顺序
    if (this.polling) return
    this.polling = true
    if (!this.db) return

    try {
      // 每次轮询前重新解密最新的数据库（包括 WAL 更新）
      await this.refreshDecryptedDb()

      // 微信 4.x：每个聊天对象一张表（Msg_<hash>）
      const tables = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"
      ).all() as { name: string }[]

      if (tables.length === 0) {
        return
      }

      for (const { name: tableName } of tables) {
        try {
          // 查询比 lastMsgTime 更新的消息
          const rows = this.db.prepare(
            `SELECT * FROM ` + tableName + ` WHERE create_time > ? ORDER BY create_time ASC LIMIT 10`
          ).all(this.lastMsgTime) as DbMessage[]
          if (rows.length === 0) continue

          for (const row of rows) {
            const msgTime = row.create_time || 0

            // 更新全局时间戳
            // 更新全局时间戳
            if (msgTime > this.lastMsgTime) {
              this.lastMsgTime = msgTime
            }
            // 打印到日志
            const timeNum = msgTime || 0
            const time = new Date(timeNum < 1e12 ? timeNum * 1000 : timeNum).toLocaleString()
            const type = row.local_type || 0
            const rawContent = row.message_content
            const senderId = row.real_sender_id || 0

            // 消息类型映射
            const typeMap: Record<number, string> = {
              1: "文本",
              3: "图片",
              34: "语音",
              42: "名片",
              50: "音视频通话",
              266287972401: "拍一拍",
              43: "视频",
              47: "表情",
              48: "位置",
              49: "链接/附件",
              244813135921: "引用消息",
              2001: "红包",
              2002: "小程序",
              2003: "群邀请",
              10000: "系统消息",
            }
            const typeName = typeMap[type] || `type=${type}`

            // content 可能是 string 或 Buffer（图片、音频、压缩文本等）
            let contentStr = ""
            if (typeof rawContent === "string") {
              contentStr = rawContent
            } else if (rawContent && typeof rawContent === "object") {
              // 是 Buffer，微信用 ZSTD 压缩长文本
              const buf = Buffer.isBuffer(rawContent) ? rawContent : Buffer.from(rawContent)

              // 检查是不是 ZSTD 压缩（魔数 28 b5 2f fd）
              if (buf.length >= 4 && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd) {
                try {
                  // @ts-ignore
                  const fzstd = await import("fzstd")
                  const decompressed = fzstd.decompress(buf)
                  contentStr = Buffer.from(decompressed).toString("utf8")
                } catch {
                  contentStr = "[二进制]"
                }
              } else {
                contentStr = "[二进制]"
              }
            }

            // 解析消息并触发事件
            const hash = tableName.replace("Msg_", "")
            const contact = this.contactMap.get(hash)
            const isGroup = contact?.isGroup || false
            const talkerUsername = contact?.username || tableName
            const talkerName = contact?.nickName || tableName

            // 解析发送者
            let senderWxid = this.selfWxid
            let senderNick = "我"
            let msgContent = contentStr
            if (isGroup) {
              if (contentStr) {
                // 群文本消息：content 格式是 "wxid: \n消息内容"
                const match = contentStr.match(/^([^:\n]+):\n?(.*)$/s)
                if (match) {
                  senderWxid = match[1].trim()
                  msgContent = match[2].trim()
                  for (const [, info] of this.contactMap) {
                    if (info.username === senderWxid) {
                      senderNick = info.nickName
                      break
                    }
                  }
                }
              } else {
                // 群二进制消息（图片/语音等）：用 real_sender_id 找发送者
                senderWxid = this.idToUsername.get(senderId) || "unknown"
                for (const [, info] of this.contactMap) {
                  if (info.username === senderWxid) {
                    senderNick = info.nickName
                    break
                  }
                }
              }
            } else {
              // 私聊：对方发的消息
              senderWxid = talkerUsername
              senderNick = talkerName
            }

            // 自己发的消息由框架 ignoreSelf 配置控制（config.json 里 ignoreSelf: true/false）

            // 构造消息链
            const message: MessageSegment[] = []
            if (type === 10000 || type === 10002 || type === 266287972401) {
              // 系统消息：解析类型
              let sysMsg = `[系统消息]`
              const sysContent = msgContent || ""
              if (type === 266287972401 || sysContent.includes("拍一拍") || sysContent.includes("<patter>")) {
                sysMsg = `[拍一拍]`
              } else if (sysContent.includes("加入了群聊") || sysContent.includes("邀请") && sysContent.includes("群聊")) {
                sysMsg = `[入群]`
              } else if (sysContent.includes("退出了群聊") || sysContent.includes("移出了群聊")) {
                sysMsg = `[退群]`
              } else if (sysContent.includes("管理员")) {
                sysMsg = `[群管理变更]`
              } else if (sysContent.includes("修改群名") || sysContent.includes("群名称")) {
                sysMsg = `[群名变更]`
              } else if (sysContent.includes("撤回了一条消息")) {
                sysMsg = `[消息撤回]`
              } else if (sysContent) {
                sysMsg = "[系统] " + sysContent.substring(0, 50)
              }
              message.push(MessageSegment.text(sysMsg))
            } else if (type === 1 && msgContent) {
              // 文本消息
              message.push(MessageSegment.text(msgContent))
            } else if (type === 3) {
              // 图片
              message.push(MessageSegment.text("[图片]"))
            } else if (type === 47) {
              // 表情
              message.push(MessageSegment.text(`[表情]`))
            } else if (type === 34) {
              // 语音
              message.push(MessageSegment.text(`[语音]`))
            } else if (type === 43) {
              // 视频
              message.push(MessageSegment.text(`[视频]`))
            } else if (type === 48) {
              // 位置
              message.push(MessageSegment.text(`[位置]`))
            } else if (type === 49) {
              // 链接/附件
              message.push(MessageSegment.text(`[链接/附件]`))
            } else if (type === 50) {
              // 音视频通话
              message.push(MessageSegment.text(`[音视频通话]`))
            } else if (type === 244813135921) {
              // 引用消息
              message.push(MessageSegment.text(`[引用消息]`))
            } else {
              // 其他类型
              message.push(MessageSegment.text(`[类型]`))
            }
            // 构造事件
            const event: BotEvent = {
              botId: this.botId,
              selfId: this.selfWxid,
              userId: senderWxid,
              groupId: isGroup ? talkerUsername : undefined,
              message,
              postType: isGroup ? "group_message" : "private_message",
              raw: {
                message_id: String(row.local_id),
                time: msgTime,
                platform: "wechat_db",
                sender: {
                  user_id: senderWxid,
                  nickname: senderNick,
                },
                talker: talkerUsername,
                talker_name: talkerName,
                type,
              },
            }

            // 事件入队，保证按接收顺序串行处理
            const eventName = isGroup ? "group_message" : "private_message"
            this.eventQueue.push(async () => {
              this.emitEvent(eventName, event)
            })
            this.processEventQueue()

            // 接收日志由框架统一打印
          }
        } catch (e) {
          console.debug(`[WeChatDb] 查询 ${tableName} 出错: ${(e as Error).message}`)
        }
      }
    } catch (e) {
      console.debug(`[WeChatDb] 轮询出错: ${(e as Error).message}`)
    } finally {
      this.polling = false
    }
  }

  // 串行处理事件队列，保证消息顺序
  private async processEventQueue(): Promise<void> {
    if (this.processingEvent) return
    this.processingEvent = true
    while (this.eventQueue.length > 0) {
      const task = this.eventQueue.shift()!
      try {
        await task()
      } catch (e) {
        console.debug(`[WeChatDb] 事件处理出错: ${(e as Error).message}`)
      }
    }
    this.processingEvent = false
  }

  // 重新解密数据库（解密主库 + WAL 后重新打开连接）
  private async refreshDecryptedDb(): Promise<void> {
    if (!this.originalDbPath || !this.tmpDir || !this.encKey) return

    const fs = await import("fs/promises")
    const path = await import("path")
    const crypto = await import("crypto")

    try {
      const walPath = this.originalDbPath + "-wal"

      // 读取主库
      const fileBuffer = await fs.readFile(this.originalDbPath)

      const PAGE_SIZE = 4096
      const SALT_SIZE = 16
      const IV_SIZE = 16
      const HMAC_SIZE = 64
      const RESERVE_SIZE = IV_SIZE + HMAC_SIZE
      const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "utf8")
      const encKey = this.encKey

      // 解密主库
      const totalPages = Math.ceil(fileBuffer.length / PAGE_SIZE)
      const decrypted = Buffer.alloc(totalPages * PAGE_SIZE)
      for (let i = 0; i < totalPages; i++) {
        const pageNum = i + 1
        const start = i * PAGE_SIZE
        const page = fileBuffer.subarray(start, start + PAGE_SIZE)

        const iv = page.subarray(PAGE_SIZE - RESERVE_SIZE, PAGE_SIZE - RESERVE_SIZE + IV_SIZE)
        const offset = pageNum === 1 ? SALT_SIZE : 0
        const encrypted = page.subarray(offset, PAGE_SIZE - RESERVE_SIZE)

        const decipher = crypto.createDecipheriv("aes-256-cbc", encKey, iv)
        decipher.setAutoPadding(false)
        const decryptedPage = Buffer.concat([decipher.update(encrypted), decipher.final()])

        if (pageNum === 1) {
          SQLITE_HEADER.copy(decrypted, start)
          decryptedPage.copy(decrypted, start + SALT_SIZE)
        } else {
          decryptedPage.copy(decrypted, start)
        }
      }

      // 关闭旧连接
      if (this.db) this.db.close()

      // 写主库
      const tmpDbPath = path.join(this.tmpDir, "message_decrypted.db")
      await fs.writeFile(tmpDbPath, decrypted)

      // 解密 WAL
      try {
        const walBuffer = await fs.readFile(walPath)
        const WAL_FRAME_HEADER = 24
        const decryptedWal = Buffer.alloc(walBuffer.length)
        walBuffer.copy(decryptedWal, 0, 0, 32)
        for (let off = 32; off + WAL_FRAME_HEADER + PAGE_SIZE <= walBuffer.length; off += WAL_FRAME_HEADER + PAGE_SIZE) {
          walBuffer.copy(decryptedWal, off, off, off + WAL_FRAME_HEADER)
          const page = walBuffer.subarray(off + WAL_FRAME_HEADER, off + WAL_FRAME_HEADER + PAGE_SIZE)
          const iv = page.subarray(PAGE_SIZE - RESERVE_SIZE, PAGE_SIZE - RESERVE_SIZE + IV_SIZE)
          const encrypted = page.subarray(0, PAGE_SIZE - RESERVE_SIZE)
          const decipher = crypto.createDecipheriv("aes-256-cbc", encKey, iv)
          decipher.setAutoPadding(false)
          const decryptedPage = Buffer.concat([decipher.update(encrypted), decipher.final()])
          decryptedPage.copy(decryptedWal, off + WAL_FRAME_HEADER)
        }
        await fs.writeFile(path.join(this.tmpDir, "message_decrypted.db-wal"), decryptedWal)
      } catch {}



      // @ts-ignore
      const Database = (await import("better-sqlite3")).default
      this.db = new Database(tmpDbPath, { readonly: true, fileMustExist: true })
    } catch (e) {
      console.debug(`[WeChatDb] 重新解密失败: ${(e as Error).message}`)
    }
  }
  private queryMessages(params?: Record<string, unknown>): unknown {
    if (!this.db) return []
    const talker = params?.talker
    const limit = Number(params?.limit || 50)

    if (talker) {
      return this.db.prepare(
        `SELECT * FROM ${this.tableName} WHERE talker = ? ORDER BY createTime DESC LIMIT ?`
      ).all(talker, limit)
    }
    return this.db.prepare(
      `SELECT * FROM ${this.tableName} ORDER BY createTime DESC LIMIT ?`
    ).all(limit)
  }

  private querySessions(): unknown {
    if (!this.db) return []
    // 按 talker 分组，取最新一条消息
    try {
      return this.db.prepare(
        `SELECT talker, MAX(createTime) as lastTime, MAX(content) as lastMsg
         FROM ${this.tableName}
         GROUP BY talker
         ORDER BY lastTime DESC
         LIMIT 50`
      ).all()
    } catch {
      return []
    }
  }

  // 获取群公告
  private async getGroupAnnouncement(params?: Record<string, unknown>): Promise<unknown> {
    const groupId = String(params?.group_id || "")
    if (!groupId) return null

    const fs = await import("fs/promises")
    const path = await import("path")
    const crypto = await import("crypto")

    try {
      const contactDbPath = path.join(this.dataDir, "db_storage", "contact", "contact.db")
      const fileBuffer = await fs.readFile(contactDbPath)
      const PAGE_SIZE = 4096, KEY_SIZE = 32, SALT_SIZE = 16, IV_SIZE = 16, HMAC_SIZE = 64, RESERVE_SIZE = IV_SIZE + HMAC_SIZE
      const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "utf8")
      const salt = fileBuffer.subarray(0, SALT_SIZE)
      const keyMaterial = Buffer.from(this.key, "hex")
      const encKey = crypto.pbkdf2Sync(keyMaterial, salt, 256000, KEY_SIZE, "sha512")
      const totalPages = Math.ceil(fileBuffer.length / PAGE_SIZE)
      const decrypted = Buffer.alloc(totalPages * PAGE_SIZE)
      for (let i = 0; i < totalPages; i++) {
        const pageNum = i + 1, start = i * PAGE_SIZE
        const page = fileBuffer.subarray(start, start + PAGE_SIZE)
        const iv = page.subarray(PAGE_SIZE - RESERVE_SIZE, PAGE_SIZE - RESERVE_SIZE + IV_SIZE)
        const pageOffset = pageNum === 1 ? SALT_SIZE : 0
        const encrypted = page.subarray(pageOffset, PAGE_SIZE - RESERVE_SIZE)
        const decipher = crypto.createDecipheriv("aes-256-cbc", encKey, iv)
        decipher.setAutoPadding(false)
        const dp = Buffer.concat([decipher.update(encrypted), decipher.final()])
        if (pageNum === 1) { SQLITE_HEADER.copy(decrypted, start); dp.copy(decrypted, start + SALT_SIZE) }
        else { dp.copy(decrypted, start) }
      }
      const os = await import("os")
      const tmpPath = path.join(os.tmpdir(), `contact-${Date.now()}.db`)
      await fs.writeFile(tmpPath, decrypted)
      const Database = (await import("better-sqlite3")).default
      const db = new Database(tmpPath, { readonly: true })

      // 找群的 id
      const groupRow = db.prepare("SELECT id FROM contact WHERE username = ?").get(groupId) as { id: number }
      if (!groupRow) return null

      // 找群公告
      const row = db.prepare("SELECT announcement_ FROM chat_room_info_detail WHERE room_id_ = ?").get(groupRow.id) as { announcement_: string }
      db.close()
      return row?.announcement_ || ""
    } catch (e) {
      console.warn(`[WeChatDb] get_group_announcement 失败: ${(e as Error).message}`)
      return null
    }
  }

  // 获取表情列表
  private async getEmoticons(params?: Record<string, unknown>): Promise<unknown> {
    const limit = Number(params?.limit || 50)
    const fs = await import("fs/promises")
    const path = await import("path")
    const crypto = await import("crypto")

    try {
      const emoticonPath = path.join(this.dataDir, "db_storage", "emoticon", "emoticon.db")
      const fileBuffer = await fs.readFile(emoticonPath)
      const PAGE_SIZE = 4096, KEY_SIZE = 32, SALT_SIZE = 16, IV_SIZE = 16, HMAC_SIZE = 64, RESERVE_SIZE = IV_SIZE + HMAC_SIZE
      const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "utf8")
      const salt = fileBuffer.subarray(0, SALT_SIZE)
      const keyMaterial = Buffer.from(this.key, "hex")
      const encKey = crypto.pbkdf2Sync(keyMaterial, salt, 256000, KEY_SIZE, "sha512")
      const totalPages = Math.ceil(fileBuffer.length / PAGE_SIZE)
      const decrypted = Buffer.alloc(totalPages * PAGE_SIZE)
      for (let i = 0; i < totalPages; i++) {
        const pageNum = i + 1, start = i * PAGE_SIZE
        const page = fileBuffer.subarray(start, start + PAGE_SIZE)
        const iv = page.subarray(PAGE_SIZE - RESERVE_SIZE, PAGE_SIZE - RESERVE_SIZE + IV_SIZE)
        const pageOffset = pageNum === 1 ? SALT_SIZE : 0
        const encrypted = page.subarray(pageOffset, PAGE_SIZE - RESERVE_SIZE)
        const decipher = crypto.createDecipheriv("aes-256-cbc", encKey, iv)
        decipher.setAutoPadding(false)
        const dp = Buffer.concat([decipher.update(encrypted), decipher.final()])
        if (pageNum === 1) { SQLITE_HEADER.copy(decrypted, start); dp.copy(decrypted, start + SALT_SIZE) }
        else { dp.copy(decrypted, start) }
      }
      const os = await import("os")
      const tmpPath = path.join(os.tmpdir(), `emoticon-${Date.now()}.db`)
      await fs.writeFile(tmpPath, decrypted)
      const Database = (await import("better-sqlite3")).default
      const db = new Database(tmpPath, { readonly: true })
      // 先看看有哪些表
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      console.log("emoticon.db 表:", tables.map((t: any) => t.name).join(", "))
      db.close()
      return tables
    } catch (e) {
      console.warn(`[WeChatDb] get_emoticons 失败: ${(e as Error).message}`)
      return []
    }
  }

  // 获取公众号列表
  private async getBizContacts(): Promise<unknown> {
    const fs = await import("fs/promises")
    const path = await import("path")
    const crypto = await import("crypto")

    try {
      const contactDbPath = path.join(this.dataDir, "db_storage", "contact", "contact.db")
      const fileBuffer = await fs.readFile(contactDbPath)
      const PAGE_SIZE = 4096, KEY_SIZE = 32, SALT_SIZE = 16, IV_SIZE = 16, HMAC_SIZE = 64, RESERVE_SIZE = IV_SIZE + HMAC_SIZE
      const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "utf8")
      const salt = fileBuffer.subarray(0, SALT_SIZE)
      const keyMaterial = Buffer.from(this.key, "hex")
      const encKey = crypto.pbkdf2Sync(keyMaterial, salt, 256000, KEY_SIZE, "sha512")
      const totalPages = Math.ceil(fileBuffer.length / PAGE_SIZE)
      const decrypted = Buffer.alloc(totalPages * PAGE_SIZE)
      for (let i = 0; i < totalPages; i++) {
        const pageNum = i + 1, start = i * PAGE_SIZE
        const page = fileBuffer.subarray(start, start + PAGE_SIZE)
        const iv = page.subarray(PAGE_SIZE - RESERVE_SIZE, PAGE_SIZE - RESERVE_SIZE + IV_SIZE)
        const pageOffset = pageNum === 1 ? SALT_SIZE : 0
        const encrypted = page.subarray(pageOffset, PAGE_SIZE - RESERVE_SIZE)
        const decipher = crypto.createDecipheriv("aes-256-cbc", encKey, iv)
        decipher.setAutoPadding(false)
        const dp = Buffer.concat([decipher.update(encrypted), decipher.final()])
        if (pageNum === 1) { SQLITE_HEADER.copy(decrypted, start); dp.copy(decrypted, start + SALT_SIZE) }
        else { dp.copy(decrypted, start) }
      }
      const os = await import("os")
      const tmpPath = path.join(os.tmpdir(), `contact-${Date.now()}.db`)
      await fs.writeFile(tmpPath, decrypted)
      const Database = (await import("better-sqlite3")).default
      const db = new Database(tmpPath, { readonly: true })
      const rows = db.prepare("SELECT username, nick_name, type FROM biz_info").all()
      db.close()
      return rows
    } catch (e) {
      console.warn(`[WeChatDb] get_biz_contacts 失败: ${(e as Error).message}`)
      return []
    }
  }

  // 获取联系人标签
  private async getContactLabels(): Promise<unknown> {
    const fs = await import("fs/promises")
    const path = await import("path")
    const crypto = await import("crypto")

    try {
      const contactDbPath = path.join(this.dataDir, "db_storage", "contact", "contact.db")
      const fileBuffer = await fs.readFile(contactDbPath)
      const PAGE_SIZE = 4096, KEY_SIZE = 32, SALT_SIZE = 16, IV_SIZE = 16, HMAC_SIZE = 64, RESERVE_SIZE = IV_SIZE + HMAC_SIZE
      const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "utf8")
      const salt = fileBuffer.subarray(0, SALT_SIZE)
      const keyMaterial = Buffer.from(this.key, "hex")
      const encKey = crypto.pbkdf2Sync(keyMaterial, salt, 256000, KEY_SIZE, "sha512")
      const totalPages = Math.ceil(fileBuffer.length / PAGE_SIZE)
      const decrypted = Buffer.alloc(totalPages * PAGE_SIZE)
      for (let i = 0; i < totalPages; i++) {
        const pageNum = i + 1, start = i * PAGE_SIZE
        const page = fileBuffer.subarray(start, start + PAGE_SIZE)
        const iv = page.subarray(PAGE_SIZE - RESERVE_SIZE, PAGE_SIZE - RESERVE_SIZE + IV_SIZE)
        const pageOffset = pageNum === 1 ? SALT_SIZE : 0
        const encrypted = page.subarray(pageOffset, PAGE_SIZE - RESERVE_SIZE)
        const decipher = crypto.createDecipheriv("aes-256-cbc", encKey, iv)
        decipher.setAutoPadding(false)
        const dp = Buffer.concat([decipher.update(encrypted), decipher.final()])
        if (pageNum === 1) { SQLITE_HEADER.copy(decrypted, start); dp.copy(decrypted, start + SALT_SIZE) }
        else { dp.copy(decrypted, start) }
      }
      const os = await import("os")
      const tmpPath = path.join(os.tmpdir(), `contact-${Date.now()}.db`)
      await fs.writeFile(tmpPath, decrypted)
      const Database = (await import("better-sqlite3")).default
      const db = new Database(tmpPath, { readonly: true })
      const rows = db.prepare("SELECT label_id_, label_name_ FROM contact_label").all()
      db.close()
      return rows
    } catch (e) {
      console.warn(`[WeChatDb] get_contact_labels 失败: ${(e as Error).message}`)
      return []
    }
  }
}


































































