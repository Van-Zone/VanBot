// icqq 为该适配器专属依赖，连接时懒加载，未安装只影响 icqq 本身，不拖垮框架
import path from "path"
import fs from "fs"
import { BaseAdapter } from "../base.js"
import {
  convertIcqqGroupMessage,
  convertIcqqPrivateMessage,
  convertIcqqNotice,
  segmentsToIcqq,
  extractReplyId,
} from "./converter.js"
import type { Capabilities } from "../../core/capabilities.js"
import type { BotEvent } from "../../core/models/event.js"
import { normalizeSegments } from "../../core/messageUtils.js"
import { registerBot } from "../../core/botRegistry.js"

let icqqCache: typeof import("icqq") | null = null
// 懒加载 icqq，缺失时给出安装提示
async function loadIcqq(botId: string): Promise<typeof import("icqq")> {
  if (icqqCache) return icqqCache
  try {
    icqqCache = await import("icqq")
    return icqqCache
  } catch (e) {
    throw new Error(`[icqq ${botId}] 缺少 icqq 依赖，请先安装 icqq 适配器依赖: npm i icqq（${(e as Error).message}）`)
  }
}

export const IcqqAdapterMap = new Map<string, IcqqAdapter>()

// icqq 适配器（基于 icqq，QQ 安卓协议登录式机器人）
// 原理：
// 1. createClient 创建客户端（无密码时用 Watch 协议扫码登录，有密码用安卓协议密码登录）
// 2. 监听 system.login.qrcode / slider / device 处理登录验证；system.online 后置 connected
// 3. 监听 message.group / message.private → 转统一事件派发给插件
// 4. 发送：sendGroupMsg / sendPrivateMsg / sendTempMsg（支持群禁言/踢人等群管理）
// 配置项：
// botId        - 框架内标识
// type         - "icqq"
// account      - QQ 号（必填，登录时传入）
// password     - 可选，密码登录；为空则扫码登录（Watch 协议，需同一 IP 环境）
// platform     - 可选，登录协议（1=安卓 2=安卓平板 3=手表(可扫码) 4=MacOS 5=iPad 6=Tim），默认 1；无密码扫码时强制 3
// dataDir      - 可选，数据存储目录（设备信息/会话/token，默认 icqq 自己的 data 文件夹）
// signApiAddr  - 可选，签名服务器地址（未配置可能登录失败或无法收发）
// qrcodeDir    - 可选，扫码登录时二维码图片保存目录（默认 ./data/icqq_qrcode）
// ignoreSelf   - 可选，默认 true，忽略机器人自己发的消息（防循环）
export class IcqqAdapter extends BaseAdapter {
  public readonly botId: string
  private readonly cfg: Record<string, any>
  private client: any = null
  private stopped = false
  // 二维码节流：避免刷新时反复打印/保存
  private lastQrcodeAt = 0
  private lastQrcodeKey = ""
  // 签名服务器提示只打一次
  private signHinted = false

  constructor(config: Record<string, any>) {
    super()
    this.cfg = config
    this.botId = config.botId
    IcqqAdapterMap.set(this.botId, this)
    registerBot(this)
  }

  public async connect(): Promise<void> {
    this.stopped = false
    const account = Number(this.cfg.account)
    if (!account) throw new Error(`[${this.botId}] 缺少 account 配置`)
    this.selfId = String(account)

    // 无密码 → 扫码登录，必须 Watch 协议；有密码 → 默认安卓协议
    const platform = this.cfg.platform
      ? Number(this.cfg.platform)
      : this.cfg.password
        ? 1
        : 3

    // 扫码模式 + 未配置签名服务器：提示一次（icqq 获取二维码/登录普遍需要 qsign）
    if (!this.cfg.password && !this.cfg.signApiAddr && !this.signHinted) {
      this.signHinted = true
      console.warn(
        `[${this.botId}] ⚠️ 未配置签名服务器（signApiAddr）。icqq 扫码获取二维码/登录大概率会失败并反复重试刷屏，` +
        `建议部署 qsign 签名服务器并填入 signApiAddr（如 http://127.0.0.1:8080/sign）。` +
        `若坚持使用，可设置 logLevel: "off" 静音 icqq 内部日志。`
      )
    }

    const icqqDataDir = this.cfg.dataDir
      ? String(this.cfg.dataDir)
      : path.join(process.cwd(), "data", "icqq")
    fs.mkdirSync(icqqDataDir, { recursive: true })

    const { createClient } = await loadIcqq(this.botId)
    const client = createClient({
      log_level: (this.cfg.logLevel as any) ?? "error",
      ignore_self: this.cfg.ignoreSelf !== false,
      data_dir: icqqDataDir,
      ...(this.cfg.signApiAddr ? { sign_api_addr: String(this.cfg.signApiAddr) } : {}),
      ...(this.cfg.ver ? { ver: String(this.cfg.ver) } : {}),
      ...(this.cfg.cacheGroupMember !== undefined ? { cache_group_member: !!this.cfg.cacheGroupMember } : {}),
      ...(this.cfg.resend !== undefined ? { resend: !!this.cfg.resend } : {}),
      ...(this.cfg.reconnInterval !== undefined ? { reconn_interval: Number(this.cfg.reconnInterval) } : {}),
      platform,
    })
    this.client = client

    // 登录事件
    client.on("system.login.qrcode", (e: any) => this.onQrcode(e))
    client.on("system.login.slider", (e: any) => {
      console.log(`[${this.botId}] 需要滑块验证：${e?.url ?? ""}`)
      console.log(`  请用浏览器打开完成验证（或调用 getIcqqAdapterById().submitSlider(ticket) 提交）`)
    })
    client.on("system.login.device", () => {
      console.log(`[${this.botId}] 需要设备锁验证：请用手机 QQ 打开 https://ssl.ptlogin2.qq.com/jump?ptlang=2052&clientuin=${account}&clientkey= 完成验证后自动登录`)
    })
    client.on("system.login.error", (e: any) => {
      console.error(`[${this.botId}] 登录失败: ${e?.message ?? JSON.stringify(e ?? "")}`)
    })
    client.on("system.online", () => {
      this.connected = true
      console.log(`✅ [${this.botId}] 登录成功: ${account} (${client.nickname ?? ""})`)
    })
    client.on("system.offline", (e: any) => {
      this.connected = false
      console.log(`[${this.botId}] 已下线: ${e?.message ?? ""}`)
    })

    // 消息事件
    client.on("message.group", (e: any) => convertIcqqGroupMessage(e, this.botId, this.selfId, this))
    client.on("message.private", (e: any) => convertIcqqPrivateMessage(e, this.botId, this.selfId, this))

    // 通知 / 请求事件
    client.on("notice.group", (e: any) => convertIcqqNotice(e, this.botId, this.selfId, this, "notice"))
    client.on("notice.friend", (e: any) => convertIcqqNotice(e, this.botId, this.selfId, this, "notice"))
    client.on("request.friend", (e: any) => convertIcqqNotice(e, this.botId, this.selfId, this, "request"))
    client.on("request.group.add", (e: any) => convertIcqqNotice(e, this.botId, this.selfId, this, "request"))
    client.on("request.group.invite", (e: any) => convertIcqqNotice(e, this.botId, this.selfId, this, "request"))

    // 登录
    if (this.cfg.password) {
      await client.login(account, String(this.cfg.password))
    } else {
      client.login()
    }
  }

  // 扫码登录：保存二维码图片并打印 URL（节流：相同二维码 60 秒内不重复提示）
  private onQrcode(e: any): void {
    const now = Date.now()
    const url = String(e?.url ?? "")
    const imgSrc = e?.image
    const key = url || (imgSrc ? String(Buffer.isBuffer(imgSrc) ? imgSrc.length : (imgSrc as any)?.length ?? 0) : "")
    // 二维码刷新但内容没变 → 不重复提示
    if (now - this.lastQrcodeAt < 60000 && key === this.lastQrcodeKey) return
    this.lastQrcodeAt = now
    this.lastQrcodeKey = key

    let imgFile = ""
    if (imgSrc) {
      try {
        const dir = this.cfg.qrcodeDir ?? path.join(process.cwd(), "data", "icqq_qrcode")
        fs.mkdirSync(dir, { recursive: true })
        imgFile = path.join(dir, `${this.botId}_qrcode.png`)
        const buf = Buffer.isBuffer(imgSrc) ? imgSrc : Buffer.from(imgSrc as any)
        fs.writeFileSync(imgFile, buf)
      } catch (err) {
        console.error(`[${this.botId}] 保存二维码失败:`, (err as Error).message)
      }
    }
    if (!url && !imgFile) {
      // 拿不到二维码内容（多为获取失败）：只在切换状态时提示一次，避免刷屏
      console.log(`[${this.botId}] 正在获取二维码...（若持续失败请检查签名服务器 signApiAddr / 网络）`)
      return
    }
    console.log(`\n[${this.botId}] 请使用手机 QQ 扫码登录：`)
    if (url) console.log(`  URL: ${url}`)
    if (imgFile) console.log(`  二维码图片已保存: ${imgFile}`)
    console.log(`  登录成功后自动上线。二维码约 60 秒过期，过期会自动刷新。\n`)
  }

  // 提交滑块验证码（system.login.slider 事件后手动调用）
  public async submitSlider(ticket: string): Promise<void> {
    if (!this.client) throw new Error(`[${this.botId}] icqq 客户端未初始化`)
    await this.client.submitSlider(ticket)
  }

  public async disconnect(): Promise<void> {
    this.stopped = true
    if (this.client) {
      try {
        await this.client.logout()
      } catch {
        // 忽略登出异常
      }
    }
    this.connected = false
    console.log(`[${this.botId}] 已登出`)
  }

  // 会话粒度能力：icqq 原生支持文本/图片/语音/视频/@/回复/表情/卡片(json/xml)/分享；
  // 群聊拥有禁言/踢出能力，私聊没有；markdown/按钮/合并转发不原生支持。
  computeCapabilities(event: BotEvent): Readonly<Capabilities> {
    const isGroup = !!event.groupId && String(event.groupId) !== "undefined" && String(event.groupId) !== "0"
    const role = (event.raw as any)?.sender?.role ?? ""
    return {
      text: true, image: true, video: true, record: true, file: true,
      markdown: false, button: false, at: true, reply: true, face: true,
      forward: false, json: true,
      canMuteMember: isGroup,
      canKickMember: isGroup,
      isGroupAdmin: isGroup && (role === "admin" || role === "owner"),
      isGroupOwner: isGroup && role === "owner",
    }
  }

  public async callApi<T = any>(action: string, params: Record<string, any> = {}): Promise<T> {
    if (!this.client) throw new Error(`[${this.botId}] icqq 客户端未初始化`)
    const segs = normalizeSegments(params.message)
    const icqqMsg = segmentsToIcqq(segs)
    const replyId = extractReplyId(segs)

    switch (action) {
      case "send_group_msg": {
        const msg = replyId ? [{ type: "reply", id: replyId }, ...icqqMsg] : icqqMsg
        return this.client.sendGroupMsg(Number(params.group_id), msg)
      }
      case "send_private_msg": {
        const msg = replyId ? [{ type: "reply", id: replyId }, ...icqqMsg] : icqqMsg
        return this.client.sendPrivateMsg(Number(params.user_id), msg)
      }
      case "send_msg": {
        const msg = replyId ? [{ type: "reply", id: replyId }, ...icqqMsg] : icqqMsg
        if (params.group_id) return this.client.sendGroupMsg(Number(params.group_id), msg)
        return this.client.sendPrivateMsg(Number(params.user_id ?? 0), msg)
      }
      case "send_temp_msg":
        return this.client.sendTempMsg(Number(params.group_id), Number(params.user_id), icqqMsg)
      case "delete_msg":
        return this.client.deleteMsg(String(params.message_id ?? ""))
      case "get_group_list":
        return (Array.from((this.client.gl ?? new Map()).values()).map((g: any) => ({
          group_id: g.group_id,
          group_name: g.name ?? "",
        })) as unknown) as T
      case "get_group_member_list": {
        const group = this.client.pickGroup(Number(params.group_id))
        const map = await group.getMemberMap()
        return (Array.from(map.values()).map((m: any) => ({
          user_id: m.user_id,
          nickname: m.card || m.nickname || "",
          card: m.card ?? "",
          role: m.is_owner ? "owner" : m.is_admin ? "admin" : "member",
        })) as unknown) as T
      }
      case "get_group_member_info": {
        const member = this.client.pickMember(Number(params.group_id), Number(params.user_id))
        await member.renew()
        return ({
          user_id: member.user_id,
          nickname: member.card || member.nickname || "",
          card: member.card ?? "",
          role: member.is_owner ? "owner" : member.is_admin ? "admin" : "member",
        } as unknown) as T
      }
      case "set_group_kick":
        await this.client.pickMember(Number(params.group_id), Number(params.user_id)).kick(params.reject_add_request !== false)
        return true as unknown as T
      case "set_group_ban":
        await this.client.pickMember(Number(params.group_id), Number(params.user_id)).mute(Number(params.duration ?? 0))
        return true as unknown as T
      case "set_group_whole_ban":
        await this.client.pickGroup(Number(params.group_id)).muteAll(params.enable !== false)
        return true as unknown as T
      case "set_group_admin":
        await this.client.pickMember(Number(params.group_id), Number(params.user_id)).setAdmin(params.enable !== false)
        return true as unknown as T
      case "set_group_card":
        await this.client.pickMember(Number(params.group_id), Number(params.user_id)).setCard(String(params.card ?? ""))
        return true as unknown as T
      case "set_group_name":
        await this.client.pickGroup(Number(params.group_id)).setName(String(params.group_name ?? ""))
        return true as unknown as T
      case "send_like":
        await this.client.pickFriend(Number(params.user_id)).thumbUp(Number(params.times ?? 1))
        return true as unknown as T
      case "send_group_file":
        await this.client.pickGroup(Number(params.group_id)).fs.upload(String(params.file), params.name)
        return true as unknown as T
      default:
        throw new Error(`[${this.botId}] 不支持的 API 操作: ${action}`)
    }
  }

  public async destroy(): Promise<void> {
    await this.disconnect()
    IcqqAdapterMap.delete(this.botId)
    await super.destroy()
  }
}

export function getIcqqAdapterById(botId: string): IcqqAdapter | undefined {
  return IcqqAdapterMap.get(botId)
}
