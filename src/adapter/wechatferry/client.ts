// WeChatFerry 适配器（纯 Node.js 版，不需要 Python）
//
// 工作原理：
// 1. 依赖 npm 包 wechatferry（@wechatferry/core），通过 koffi 加载 sdk.dll 注入微信
// 2. 接收消息：wcf.on('message', callback) 事件监听
// 3. 发送消息：wcf.sendTxt / sendImg / sendFile（图片文件需 FileBox）
//
// 前置条件：
// - Windows 10/11（必须，sdk.dll 是 Windows DLL）
// - 微信 PC 版 3.9.x（wechatferry 包内置对应版本的 sdk.dll）
// - 微信已登录并保持运行
// - npm install wechatferry（框架会按需动态加载）
//
// 配置项：
// botId       - 框架内标识
// type        - "wechatferry"
// sdkPort     - sdk.dll 通信端口，默认 10086
// sdkHost     - sdk.dll 通信地址，默认 127.0.0.1
// sdkDebug    - 是否启用 sdk 调试模式，默认 false
// ignoreSelf  - 是否忽略自己发出的消息，默认 true
// keepalive   - 登录后是否持续检查存活（秒数或 true=30s），默认 false

import { exec } from "child_process"
import net from "net"
import { BaseAdapter } from "../base.js"
import { convertWcfEvent, isSystemMessage, isSelfMessage } from "./converter.js"
import type { WcfCore, WcfCoreModule, WcfRawMessage, WcfUserInfo } from "./types.js"
import { registerBot } from "../../core/botRegistry.js"
import type { Capabilities } from "../../core/capabilities.js"
import type { BotEvent } from "../../core/models/event.js"
import type { MessageChain } from "../../core/models/message.js"

export class WechatFerryAdapter extends BaseAdapter {
  public readonly botId: string
  private readonly cfg: Record<string, any>
  private wcf: WcfCore | null = null
  private selfWxid: string = ""
  private messageHandler: ((msg: WcfRawMessage) => void) | null = null
  private keepaliveTimer: NodeJS.Timeout | null = null
  private aliveCounter: number = 0

  constructor(config: Record<string, any>) {
    super()
    this.cfg = config
    this.botId = config.botId
    registerBot(this)
  }

  public async connect(): Promise<void> {
    // 启动前清理残留进程和端口（解决"首次能注入后续失败"问题）
    await this.cleanupBeforeConnect()

    // 动态加载 wechatferry（可选依赖，未安装时给出明确错误）
    let module: WcfCoreModule
    try {
      // @ts-ignore wechatferry 是可选依赖，未安装时运行时会抛错并给出提示
      module = await import("wechatferry") as unknown as WcfCoreModule
      // 如果主包没有导出 Wechatferry，尝试从 @wechatferry/core 导入
      if (!module.Wechatferry) {
        // @ts-ignore 同上
        const core = await import("@wechatferry/core") as unknown as WcfCoreModule
        module = core
      }
    } catch (e) {
      throw new Error(
        `[WeChatFerry] 未安装 wechatferry 依赖，请运行: npm install wechatferry\n` +
        `原始错误: ${(e as Error).message}`
      )
    }

    // 创建 wcf 实例
    const sdkOptions: Record<string, unknown> = {}
    if (this.cfg.sdkPort) sdkOptions.port = this.cfg.sdkPort
    if (this.cfg.sdkHost) sdkOptions.host = this.cfg.sdkHost
    if (this.cfg.sdkDebug) sdkOptions.debug = this.cfg.sdkDebug

    this.wcf = new module.Wechatferry(sdkOptions)

    // 启动（sdk.dll 注入微信并建立 NNG 通信）
    try {
      this.wcf.start()
    } catch (e) {
      const errMsg = (e as Error).message
      // 常见错误：Connection refused = sdk.dll 注入失败，通常是微信版本不兼容
      if (errMsg.includes("Connection refused") || errMsg.includes("connect")) {
        throw new Error(
          `[WeChatFerry] sdk.dll 注入微信失败，NNG 端口 10086 未监听。\n` +
          `最可能的原因：微信版本不兼容。\n` +
          `当前 wechatferry 包要求微信版本为 3.9.12.17（参考 https://wcferry.netlify.app/guide.html）。\n` +
          `请降级微信到 3.9.12.17，下载地址：https://github.com/tom-snow/wechat-windows-versions/releases\n` +
          `降级后请关闭微信自动更新，防止被偷偷升级。\n` +
          `原始错误: ${errMsg}`
        )
      }
      throw new Error(`[WeChatFerry] 启动失败: ${errMsg}`)
    }

    // 等待登录（最多等 10 秒）
    const loggedIn = await this.waitForLogin(10000)
    if (!loggedIn) {
      console.warn("[WeChatFerry] 等待登录超时，请确认微信已登录且 sdk.dll 注入成功")
      console.warn("[WeChatFerry] 如果微信崩溃退出，说明微信版本不兼容，请降级到 3.9.12.17")
    }

    // 获取自己的 wxid
    try {
      const userInfo = this.wcf.getUserInfo() as WcfUserInfo
      if (userInfo?.wxid) {
        this.selfWxid = userInfo.wxid
        this.selfId = userInfo.wxid
      }
    } catch (e) {
      console.warn(`[WeChatFerry] 获取用户信息失败: ${(e as Error).message}`)
    }

    // 注册消息监听
    this.messageHandler = (msg: WcfRawMessage) => this.handleIncomingMessage(msg)
    this.wcf.on("message", this.messageHandler)

    // 启动存活检查（如果配置了）
    if (this.cfg.keepalive) {
      this.startKeepalive()
    }

    this.connected = true
    console.log(`[WeChatFerry] 适配器已启动 (botId=${this.botId}, wxid=${this.selfWxid || "未知"})`)
  }

  public async disconnect(): Promise<void> {
    // 停止存活检查
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }

    // 移除消息监听
    if (this.wcf && this.messageHandler) {
      this.wcf.off("message", this.messageHandler)
      this.messageHandler = null
    }

    // 停止 wcf
    if (this.wcf) {
      try {
        this.wcf.stop()
      } catch (e) {
        console.warn(`[WeChatFerry] 停止 wcf 时出错: ${(e as Error).message}`)
      }
      this.wcf = null
    }

    this.connected = false
  }

  // 启动前清理：检测端口占用、杀掉残留微信进程
  // 解决"首次注入成功，后续启动注入失败"问题
  private async cleanupBeforeConnect(): Promise<void> {
    const port = this.cfg.sdkPort ?? 10086
    const autoCleanup = this.cfg.autoCleanup !== false // 默认开启

    // 1. 检测端口是否被占用
    const portOccupied = await this.isPortOccupied(port)
    if (!portOccupied) return

    console.warn(`[WeChatFerry] 检测到端口 ${port} 被占用，可能是上次退出时残留进程未清理`)

    if (!autoCleanup) {
      console.warn(`[WeChatFerry] autoCleanup 已关闭，请手动执行：taskkill /F /IM WeChat.exe`)
      return
    }

    // 2. 杀掉残留微信进程
    try {
      await this.execCommand("taskkill /F /IM WeChat.exe")
      console.log("[WeChatFerry] 已清理残留微信进程")
    } catch (e) {
      // 没有找到进程是正常的
    }

    // 3. 杀掉占用端口的进程（可能是 node 或其他）
    try {
      const pids = await this.getPidsByPort(port)
      for (const pid of pids) {
        try {
          await this.execCommand(`taskkill /F /PID ${pid}`)
          console.log(`[WeChatFerry] 已清理占用端口 ${port} 的进程 PID=${pid}`)
        } catch {
          // 杀不掉就跳过
        }
      }
    } catch {
      // 查询失败就跳过
    }

    // 4. 等一下让进程完全退出
    await new Promise(resolve => setTimeout(resolve, 1500))

    console.warn("[WeChatFerry] 清理完成，请重新打开微信并登录后再启动框架")
  }

  // 检测端口是否被占用
  private async isPortOccupied(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer()
      server.once("error", () => resolve(true))
      server.once("listening", () => {
        server.close()
        resolve(false)
      })
      server.listen(port, "127.0.0.1")
    })
  }

  // 根据端口查找占用进程的 PID
  private async getPidsByPort(port: number): Promise<string[]> {
    return new Promise((resolve) => {
      exec(`netstat -ano | findstr :${port}`, (error, stdout) => {
        if (error) return resolve([])
        const pids = new Set<string>()
        for (const line of stdout.split("\n")) {
          const match = line.trim().match(/\s+(\d+)$/)
          if (match) pids.add(match[1])
        }
        resolve([...pids])
      })
    })
  }

  // 执行命令
  private execCommand(cmd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      exec(cmd, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  // 统一 API 入口
  public async callApi<T = unknown>(action: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.wcf) throw new Error("[WeChatFerry] 适配器未连接")

    switch (action) {
      case "send_private_msg":
      case "send_group_msg":
        return this.sendViaWcf(params ?? {}) as T

      case "send_text":
        return this.wcf.sendTxt(
          String(params?.text ?? params?.message ?? ""),
          String(params?.user_id ?? params?.group_id ?? params?.receiver ?? ""),
          params?.aters as string[] | undefined,
        ) as T

      case "send_image":
        return this.sendImage(
          String(params?.file ?? params?.path ?? params?.url ?? ""),
          String(params?.user_id ?? params?.group_id ?? params?.receiver ?? ""),
        ) as T

      case "send_file":
        return this.sendFile(
          String(params?.file ?? params?.path ?? ""),
          String(params?.user_id ?? params?.group_id ?? params?.receiver ?? ""),
        ) as T

      case "get_login_status":
        return this.wcf.isLogin() as T

      case "get_self_wxid":
      case "get_self_id":
        return this.selfWxid as T

      case "get_user_info":
        return this.wcf.getUserInfo() as T

      case "get_contacts":
      case "get_contact_list":
        return this.wcf.execDbQuery("MicroMsg.db", "SELECT * FROM Contact") as T

      case "get_chatrooms":
        return this.wcf.execDbQuery("MicroMsg.db", "SELECT * FROM ChatRoom") as T

      case "revoke_msg":
        return this.wcf.revokeMsg(String(params?.message_id ?? params?.id ?? "")) as T

      case "forward_msg":
        return this.wcf.forwardMsg(
          String(params?.message_id ?? params?.id ?? ""),
          String(params?.receiver ?? params?.group_id ?? params?.user_id ?? ""),
        ) as T

      case "invite_room_members":
        return this.wcf.inviteRoomMembers(
          String(params?.room_id ?? params?.group_id ?? ""),
          this.toWxidArray(params?.wxids ?? params?.user_ids),
        ) as T

      case "add_room_members":
        return this.wcf.addRoomMembers(
          String(params?.room_id ?? params?.group_id ?? ""),
          this.toWxidArray(params?.wxids ?? params?.user_ids),
        ) as T

      case "remove_room_members":
      case "kick_room_members":
        return this.wcf.delRoomMembers(
          String(params?.room_id ?? params?.group_id ?? ""),
          this.toWxidArray(params?.wxids ?? params?.user_ids),
        ) as T

      case "exec_db_query":
        return this.wcf.execDbQuery(
          String(params?.db ?? "MicroMsg.db"),
          String(params?.sql ?? ""),
        ) as T

      case "get_db_names":
        return this.wcf.getDbNames() as T

      default:
        throw new Error(`[WeChatFerry] 不支持的 API action: ${action}`)
    }
  }

  // 微信会话能力集
  public computeCapabilities(_event: BotEvent): Readonly<Capabilities> {
    return {
      text: true,
      image: true,
      record: true,
      video: true,
      file: true,
      at: true,
      reply: false,
      face: true,
      forward: true,
      markdown: false,
      card: false,
      canMuteMember: false,
      canKickMember: true,   // wechatferry 支持踢人
      canSetAdmin: false,
    }
  }

  // ============ 发送消息 ============

  // 发送群消息
  public async sendGroupMsg(
    groupId: number | string,
    chain: MessageChain | string,
  ): Promise<unknown> {
    return this.sendChain(String(groupId), chain)
  }

  // 发送私聊消息
  public async sendPrivateMsg(
    userId: number | string,
    chain: MessageChain | string,
  ): Promise<unknown> {
    return this.sendChain(String(userId), chain)
  }

  // 将消息链转换并发送
  private async sendChain(receiver: string, chain: MessageChain | string): Promise<unknown> {
    const wcf = this.wcf
    if (!wcf) throw new Error("[WeChatFerry] 适配器未连接")

    if (typeof chain === "string") {
      return wcf.sendTxt(chain, receiver)
    }

    // 分段发送：文本合并，图片/文件/视频单独发
    let textBuf = ""
    let atList: string[] = []
    const results: unknown[] = []

    const flushText = async () => {
      if (textBuf.trim()) {
        results.push(wcf.sendTxt(textBuf.trim(), receiver, atList.length > 0 ? atList : undefined))
        textBuf = ""
        atList = []
      }
    }

    for (const seg of chain) {
      switch (seg.type) {
        case "text":
          textBuf += (seg.data?.text ?? "") + "\n"
          break

        case "at": {
          const wxid = String(seg.data?.qq ?? seg.data?.user_id ?? seg.data?.wxid ?? "")
          if (wxid) {
            atList.push(wxid)
            textBuf += `@${wxid} `
          }
          break
        }

        case "image": {
          await flushText()
          const file = String(seg.data?.file ?? seg.data?.path ?? seg.data?.url ?? "")
          if (file) {
            results.push(await this.sendImage(file, receiver))
          }
          break
        }

        case "record": {
          await flushText()
          // wechatferry 没有直接发语音的端点，降级为文本提示
          textBuf += "[语音消息]"
          break
        }

        case "video": {
          await flushText()
          const file = String(seg.data?.file ?? seg.data?.path ?? "")
          if (file && !file.startsWith("http") && !file.startsWith("base64://")) {
            results.push(await this.sendFile(file, receiver))
          } else {
            textBuf += "[视频]"
          }
          break
        }

        case "file": {
          await flushText()
          const file = String(seg.data?.file ?? seg.data?.path ?? "")
          if (file && !file.startsWith("http") && !file.startsWith("base64://")) {
            results.push(await this.sendFile(file, receiver))
          } else {
            textBuf += "[文件]"
          }
          break
        }

        case "face":
          textBuf += `[表情:${seg.data?.id ?? ""}]`
          break

        default:
          textBuf += `[${seg.type}]`
      }
    }

    await flushText()
    return results.length > 0 ? results[results.length - 1] : 0
  }

  // 通过 callApi 发送（兼容 BaseAdapter 默认路径）
  private async sendViaWcf(params: Record<string, unknown>): Promise<unknown> {
    const receiver = String(params.group_id ?? params.user_id ?? "")
    const message = params.message
    if (!receiver) return { status: -1, error: "缺少 receiver" }
    return this.sendChain(receiver, message as MessageChain | string)
  }

  // 发送图片（支持本地路径和网络 URL）
  private async sendImage(file: string, receiver: string): Promise<number> {
    if (!this.wcf) throw new Error("[WeChatFerry] 适配器未连接")

    try {
      // 动态加载 file-box
      // @ts-ignore file-box 是可选依赖
      const fileBoxModule = await import("file-box")
      const FileBox = fileBoxModule.FileBox
      let image: unknown

      if (file.startsWith("http://") || file.startsWith("https://")) {
        image = FileBox.fromUrl(file)
      } else if (file.startsWith("base64://")) {
        image = FileBox.fromBase64(file.slice(9), "image.png")
      } else {
        image = FileBox.fromFile(file)
      }

      return this.wcf.sendImg(image, receiver)
    } catch (e) {
      console.error(`[WeChatFerry] 发送图片失败: ${(e as Error).message}`)
      return -1
    }
  }

  // 发送文件
  private async sendFile(file: string, receiver: string): Promise<number> {
    if (!this.wcf) throw new Error("[WeChatFerry] 适配器未连接")

    try {
      // @ts-ignore file-box 是可选依赖
      const fileBoxModule = await import("file-box")
      const FileBox = fileBoxModule.FileBox
      let fileBox: unknown

      if (file.startsWith("http://") || file.startsWith("https://")) {
        fileBox = FileBox.fromUrl(file)
      } else {
        fileBox = FileBox.fromFile(file)
      }

      return this.wcf.sendFile(fileBox, receiver)
    } catch (e) {
      console.error(`[WeChatFerry] 发送文件失败: ${(e as Error).message}`)
      return -1
    }
  }

  // ============ 消息处理 ============

  private handleIncomingMessage(raw: WcfRawMessage): void {
    if (!raw || !raw.sender) return

    // 忽略自己发出的消息
    const ignoreSelf = this.cfg.ignoreSelf !== false
    if (ignoreSelf && isSelfMessage(raw)) return

    // 更新存活计数器
    this.aliveCounter = 0

    // 系统通知类消息作为 notice 事件派发
    if (isSystemMessage(raw)) {
      const event = convertWcfEvent(raw, this.botId, this.selfWxid || this.botId)
      event.postType = "notice"
      this.emitEvent("notice", event)
      return
    }

    const event = convertWcfEvent(raw, this.botId, this.selfWxid || this.botId)
    const eventName = event.postType === "group_message" ? "group_message" : "private_message"
    this.emitEvent(eventName, event)
  }

  // ============ 存活检查 ============

  private startKeepalive(): void {
    const interval = typeof this.cfg.keepalive === "number" ? this.cfg.keepalive : 30
    this.keepaliveTimer = setInterval(() => {
      this.aliveCounter++
      if (this.aliveCounter >= interval) {
        this.aliveCounter = 0
        try {
          if (this.wcf && !this.wcf.isLogin()) {
            console.warn("[WeChatFerry] 检测到微信未登录，尝试重置 SDK...")
            this.wcf.resetSdk()
          }
        } catch (e) {
          console.warn(`[WeChatFerry] 存活检查失败: ${(e as Error).message}`)
        }
      }
    }, 1000)
  }

  // 等待登录成功
  private async waitForLogin(timeout: number): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      try {
        if (this.wcf?.isLogin()) return true
      } catch {
        // 检查失败，继续等
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    return false
  }

  // 辅助：将 wxids 参数转为数组
  private toWxidArray(wxids: unknown): string[] {
    if (Array.isArray(wxids)) return wxids.map(String)
    if (typeof wxids === "string") return wxids.split(",").map(s => s.trim()).filter(Boolean)
    return []
  }
}
