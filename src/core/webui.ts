// WebUI 控制台（零依赖，内置 http + SSE 实时推送 + 单页前端）
// 功能：系统概览、实时消息日志、运行日志、机器人管理（表单化配置）、
//       适配器市场、插件管理、统计图表。移动端底部标签栏适配。
import http from "http"
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from "fs"
import { resolve, join } from "path"
import { execSync } from "child_process"
import { globalBus } from "./eventBus.js"
import { get_bot } from "./botRegistry.js"
import type { PluginApiBridge } from "./pluginApi.js"
import type { BotEvent } from "./models/event.js"

export interface WebUIConfig {
  enable?: boolean
  port?: number
  host?: string
}

// ─── 消息环形缓冲区 ───────────────────────────────────────────────
const MAX_MESSAGES = 500
const messageLog: Array<{
  id: number
  time: number
  botId: string
  type: string
  direction: "in" | "out"
  userId: string
  groupId?: string
  nickname?: string
  content: string
  rawType?: string
}> = []
let msgSeq = 0

function eventToText(event: BotEvent): string {
  const parts: string[] = []
  for (const seg of event.message ?? []) {
    if (seg.type === "text") parts.push(seg.data.text ?? "")
    else if (seg.type === "image") parts.push("[图片]")
    else if (seg.type === "voice" || seg.type === "audio") parts.push("[语音]")
    else if (seg.type === "video") parts.push("[视频]")
    else if (seg.type === "file") parts.push("[文件]")
    else if (seg.type === "emoji" || seg.type === "face") parts.push(seg.data.text ?? "[表情]")
    else if (seg.type === "at") parts.push(`@${seg.data.qq ?? seg.data.name ?? ""}`)
    else if (seg.type === "reply") parts.push("[引用]")
    else if (seg.type === "node") parts.push("[合并转发]")
    else parts.push(`[${seg.type}]`)
  }
  return parts.join("") || "(空)"
}

globalBus.on("*", (eventName: string, event: BotEvent) => {
  if (!event || typeof event !== "object") return
  const isOut = eventName === "message_sent"
  const type = isOut ? "message_sent" : (event.postType ?? eventName)
  if (type === "meta_event" && event.raw?.meta_event_type === "heartbeat") return
  const entry = {
    id: ++msgSeq,
    time: event.time ?? Math.floor(Date.now() / 1000),
    botId: event.botId ?? "",
    type,
    direction: isOut ? "out" as const : "in" as const,
    userId: String(event.userId ?? ""),
    groupId: event.groupId ? String(event.groupId) : undefined,
    nickname: event.raw?.sender?.nickname ?? event.raw?.nickname ?? undefined,
    content: eventToText(event),
    rawType: event.raw?.message_type ?? undefined,
  }
  messageLog.push(entry)
  if (messageLog.length > MAX_MESSAGES) messageLog.shift()
  broadcast({ type: "message", data: entry })
})

// ─── 运行日志捕获 ─────────────────────────────────────────────────
const MAX_LOGS = 1000
const runLog: Array<{ id: number; time: string; level: string; text: string }> = []
let logSeq = 0
const sseClients = new Set<http.ServerResponse>()

function captureLog(level: string, original: (...args: any[]) => void) {
  return (...args: any[]) => {
    original(...args)
    const text = args.map(a => {
      if (typeof a === "string") return a
      try { return JSON.stringify(a) } catch { return String(a) }
    }).join(" ")
    const entry = { id: ++logSeq, time: new Date().toLocaleTimeString(), level, text }
    runLog.push(entry)
    if (runLog.length > MAX_LOGS) runLog.shift()
    broadcast({ type: "log", data: entry })
  }
}
const origLog = console.log.bind(console)
const origWarn = console.warn.bind(console)
const origError = console.error.bind(console)
console.log = captureLog("info", origLog)
console.warn = captureLog("warn", origWarn)
console.error = captureLog("error", origError)

// ─── SSE 广播 ─────────────────────────────────────────────────────
function broadcast(msg: { type: string; data: unknown }) {
  const payload = `data: ${JSON.stringify(msg)}\n\n`
  for (const res of sseClients) {
    try { res.write(payload) } catch { sseClients.delete(res) }
  }
}

// ─── 统计（按小时聚合收发） ────────────────────────────────────────
const hourlyStats = new Map<string, { received: number; sent: number }>()
function hourKey(ts: number): string {
  const d = new Date(ts * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:00`
}
globalBus.on("*", (_eventName: string, event: BotEvent) => {
  if (!event || typeof event !== "object") return
  const isOut = _eventName === "message_sent"
  if (isOut || _eventName === "group_message" || _eventName === "private_message") {
    const key = hourKey(event.time ?? Math.floor(Date.now() / 1000))
    const cur = hourlyStats.get(key) ?? { received: 0, sent: 0 }
    if (isOut) cur.sent++
    else cur.received++
    hourlyStats.set(key, cur)
  }
})

// ─── 社区源代理 ────────────────────────────────────────────────────
function getConfigPath(): string { return resolve("./config.json") }
function readConfig(): any {
  try { return JSON.parse(readFileSync(getConfigPath(), "utf-8")) } catch { return {} }
}
function adapterApiBase(): string {
  const cfg = readConfig()
  return (cfg.adapterApi ?? "http://bot.ziyi.asia/api/adapters").replace(/\/$/, "")
}
function pluginApiBase(): string {
  const cfg = readConfig()
  return (cfg.pluginApi ?? "http://bot.ziyi.asia/api/plugins").replace(/\/$/, "")
}
async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { "User-Agent": "VanBotJS-WebUI" }, signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}
function installedAdapterTypes(): string[] {
  const dir = resolve("src/adapter")
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "client.ts")))
    .map((d) => d.name)
}
function installedPlugins(): string[] {
  const dir = resolve("plugin")
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".ts"))
    .map((d) => d.name.replace(/\.ts$/, ""))
}

// ─── 适配器安装 ────────────────────────────────────────────────────
async function installAdapter(name: string): Promise<{ ok: boolean; message: string }> {
  const list = await fetchJson(`${adapterApiBase()}.json`)
  const adapters = Array.isArray(list) ? list : (list.adapters ?? [])
  const target = adapters.find((a: any) => a.name === name)
  if (!target) return { ok: false, message: `社区源中未找到适配器 ${name}` }
  const dest = join(resolve("src/adapter"), name)
  if (existsSync(dest)) return { ok: false, message: `适配器 ${name} 已安装` }
  mkdirSync(dest, { recursive: true })
  const files = target.files?.length ? target.files : ["package.json", "client.ts", "converter.ts", "types.ts"]
  let okCount = 0
  for (const f of files) {
    try {
      const res = await fetch(`${adapterApiBase()}/${name}/${encodeURIComponent(f)}`, {
        headers: { "User-Agent": "VanBotJS-WebUI" }, signal: AbortSignal.timeout(30000),
      })
      if (!res.ok) continue
      const text = await res.text()
      if (text.trimStart().startsWith("<!DOCTYPE")) continue
      writeFileSync(join(dest, f), text, "utf8")
      okCount++
    } catch { /* continue */ }
  }
  if (okCount === 0) { rmSync(dest, { recursive: true, force: true }); return { ok: false, message: "文件下载全部失败" } }
  let deps = target.dependencies || []
  if (!deps.length) {
    const manifestPath = join(dest, "package.json")
    if (existsSync(manifestPath)) {
      try { deps = Object.keys(JSON.parse(readFileSync(manifestPath, "utf8")).dependencies || {}) } catch { /* ignore */ }
    }
  }
  if (deps.length) {
    try { execSync(`npm install ${deps.join(" ")} --no-audit --no-fund`, { cwd: resolve("."), stdio: "pipe", timeout: 120000 }) } catch { /* ignore */ }
  }
  return { ok: true, message: `适配器 ${name} 安装成功（${okCount}/${files.length} 文件）` }
}

async function installPlugin(name: string): Promise<{ ok: boolean; message: string }> {
  const list = await fetchJson(`${pluginApiBase()}.json`)
  const plugins = Array.isArray(list) ? list : (list.plugins ?? [])
  const target = plugins.find((p: any) => p.name === name)
  if (!target) return { ok: false, message: `社区源中未找到插件 ${name}` }
  const dest = resolve("plugin")
  mkdirSync(dest, { recursive: true })
  const files = target.files?.length ? target.files : [`${name}.ts`]
  let okCount = 0
  for (const f of files) {
    try {
      const res = await fetch(`${pluginApiBase()}/${name}/${encodeURIComponent(f)}`, {
        headers: { "User-Agent": "VanBotJS-WebUI" }, signal: AbortSignal.timeout(30000),
      })
      if (!res.ok) continue
      const text = await res.text()
      if (text.trimStart().startsWith("<!DOCTYPE")) continue
      writeFileSync(join(dest, f), text, "utf8")
      okCount++
    } catch { /* continue */ }
  }
  if (okCount === 0) return { ok: false, message: "文件下载全部失败" }
  const deps = target.dependencies || []
  if (deps.length) {
    try { execSync(`npm install ${deps.join(" ")} --no-audit --no-fund`, { cwd: resolve("."), stdio: "pipe", timeout: 120000 }) } catch { /* ignore */ }
  }
  return { ok: true, message: `插件 ${name} 安装成功` }
}

// ─── 前端页面 ───────────────────────────────────────────────────────
const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>VanBotJS 控制台</title>
<style>
:root{
  --bg:#0a1324;--panel:#121f3a;--panel2:#182a4d;--border:#26385e;
  --text:#e8eefb;--dim:#8fa0bd;
  --accent:#4a86f5;--accent-d:#3a6fd8;--accent-soft:rgba(74,134,245,.15);
  --green:#3fb950;--red:#f85149;--yellow:#d29922;--purple:#a371f7;
}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
body{background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;padding:0;min-height:100vh;padding-bottom:64px}
.wrap{max-width:1100px;margin:0 auto;padding:16px}
.head{display:flex;align-items:center;gap:10px;margin-bottom:4px}
.head img{width:32px;height:32px;border-radius:8px}
h1{font-size:18px;background:linear-gradient(90deg,#5b94ff,#9b7bff);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{color:var(--dim);font-size:11px;margin-bottom:16px}
.page{display:none}.page.active{display:block}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:16px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:12px 14px}
.card .k{color:var(--dim);font-size:11px;margin-bottom:2px}
.card .v{font-size:18px;font-weight:600}
.sec-head{display:flex;align-items:center;justify-content:space-between;margin:16px 0 8px}
h2{font-size:14px}
.btn{border:1px solid var(--accent);background:var(--accent);color:#fff;border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;transition:.15s;font-family:inherit}
.btn:hover{background:var(--accent-d)}
.btn.ghost{background:transparent;color:var(--accent)}
.btn.ghost:hover{background:var(--accent-soft)}
.btn.danger{background:transparent;border:none;color:var(--dim);padding:3px 6px;font-size:11px}
.btn.danger:hover{color:#ff7a72}
.btn.sm{padding:4px 8px;font-size:11px}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--border);border-radius:10px;overflow:hidden;font-size:12px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
th{color:var(--dim);font-weight:500;background:rgba(74,134,245,.08)}
tr:last-child td{border-bottom:none}
.badge{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;white-space:nowrap}
.badge.on{background:rgba(63,185,80,.15);color:var(--green)}
.badge.off{background:rgba(139,152,173,.15);color:var(--dim)}
.badge.dis{background:rgba(248,81,73,.15);color:var(--red)}
.badge.info{background:rgba(74,134,245,.15);color:var(--accent)}
.type{color:var(--accent);font-family:ui-monospace,Consolas,monospace;font-size:11px}
.mono{font-family:ui-monospace,Consolas,monospace;font-size:11px}
.muted{color:var(--dim)}
.switch{position:relative;width:36px;height:20px;display:inline-block;vertical-align:middle}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;inset:0;background:#2c3650;border-radius:99px;cursor:pointer;transition:.2s}
.slider:before{content:"";position:absolute;width:14px;height:14px;left:3px;top:3px;background:#8b98ad;border-radius:50%;transition:.2s}
.switch input:checked+.slider{background:var(--accent)}
.switch input:checked+.slider:before{transform:translateX(16px);background:#fff}
.form-panel{background:var(--panel);border:1px solid var(--accent);border-radius:10px;padding:14px;margin-bottom:12px;display:none}
.form-panel.show{display:block}
.form-row{display:flex;gap:10px;margin-bottom:8px;flex-wrap:wrap;align-items:center}
.form-row label{width:80px;color:var(--dim);font-size:12px;flex-shrink:0}
.form-row input,.form-row select,.form-row textarea{flex:1;min-width:160px;background:var(--panel2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:6px 10px;font-size:12px;font-family:inherit}
.form-row textarea{min-height:120px;resize:vertical;font-family:ui-monospace,Consolas,monospace}
.form-row input[type=checkbox]{flex:0;min-width:0;width:16px;height:16px}
.form-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:6px}
.err{color:var(--red);font-size:11px;margin-top:6px}
.ok{color:var(--green);font-size:11px;margin-top:6px}
.empty{color:var(--dim);padding:14px;text-align:center}
/* 底部标签栏（移动端） */
.tabbar{position:fixed;bottom:0;left:0;right:0;background:var(--panel);border-top:1px solid var(--border);display:flex;z-index:100;padding-bottom:env(safe-area-inset-bottom)}
.tabbar button{flex:1;background:none;border:none;color:var(--dim);padding:8px 4px;font-size:10px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:2px;font-family:inherit;transition:.15s}
.tabbar button .ico{font-size:18px;line-height:1}
.tabbar button.active{color:var(--accent)}
/* 消息日志 */
.msg-list{background:var(--panel);border:1px solid var(--border);border-radius:10px;overflow:hidden}
.msg-item{padding:8px 12px;border-bottom:1px solid var(--border);font-size:12px;display:flex;gap:8px;align-items:baseline}
.msg-item:last-child{border-bottom:none}
.msg-item .time{color:var(--dim);font-family:ui-monospace,monospace;font-size:11px;flex-shrink:0}
.msg-item .dir{flex-shrink:0;font-weight:600;font-size:11px}
.msg-item .dir.in{color:var(--green)}
.msg-item .dir.out{color:var(--accent)}
.msg-item .bot{color:var(--purple);font-size:11px;flex-shrink:0}
.msg-item .who{color:var(--yellow);font-size:11px;flex-shrink:0;max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.msg-item .content{flex:1;word-break:break-all;white-space:pre-wrap}
.msg-item .tag{color:var(--dim);font-size:10px;flex-shrink:0}
/* 运行日志 */
.log-list{background:#0d1117;border:1px solid var(--border);border-radius:10px;padding:10px;font-family:ui-monospace,Consolas,monospace;font-size:11px;max-height:60vh;overflow-y:auto;line-height:1.5}
.log-line{white-space:pre-wrap;word-break:break-all;margin-bottom:2px}
.log-line .t{color:#6e7681}
.log-line .l-info{color:#58a6ff}
.log-line .l-warn{color:#d29922}
.log-line .l-error{color:#f85149}
/* 过滤栏 */
.filter-bar{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:center}
.filter-bar input,.filter-bar select{background:var(--panel2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:6px 10px;font-size:12px;font-family:inherit}
.filter-bar input{flex:1;min-width:120px}
/* 市场卡片 */
.market-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
.market-card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:12px}
.market-card .name{font-weight:600;font-size:13px;margin-bottom:2px}
.market-card .desc{color:var(--dim);font-size:11px;margin-bottom:8px;min-height:32px}
.market-card .meta{display:flex;justify-content:space-between;align-items:center;font-size:11px}
/* 统计图表 */
.chart-box{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:12px}
.chart-title{font-size:12px;color:var(--dim);margin-bottom:8px}
.chart-canvas{width:100%;height:180px;display:block}
/* 详情面板 */
.detail-panel{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:12px}
.detail-panel .row{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);font-size:12px}
.detail-panel .row:last-child{border-bottom:none}
.detail-panel .row .k{color:var(--dim)}
/* 桌面端：侧边栏 */
@media(min-width:768px){
  body{padding-bottom:0;padding-left:84px}
  .tabbar{top:0;bottom:0;left:0;right:auto;width:84px;flex-direction:column;border-top:none;border-right:1px solid var(--border)}
  .tabbar button{padding:14px 4px;font-size:10px}
  .tabbar button .ico{font-size:22px}
  .wrap{padding:32px 40px;max-width:1200px;margin:0 auto}
  h1{font-size:20px}
}
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <img src="/logo" alt="logo" onerror="this.style.display='none'">
    <h1>VanBotJS 控制台</h1>
  </div>
  <div class="sub" id="sub">加载中...</div>

  <!-- 概览 -->
  <div class="page active" id="page-overview">
    <div class="cards" id="sysCards"></div>
    <div class="sec-head"><h2>机器人</h2><button class="btn sm" onclick="switchPage('bots')">管理</button></div>
    <table><thead><tr><th>botId</th><th>类型</th><th>状态</th><th>接收</th><th>发送</th></tr></thead><tbody id="ovBotRows"></tbody></table>
    <div class="sec-head"><h2>插件</h2><button class="btn sm" onclick="switchPage('plugins')">管理</button></div>
    <table><thead><tr><th>名称</th><th>状态</th></tr></thead><tbody id="ovPluginRows"></tbody></table>
    <div class="sec-head" style="margin-top:20px"><h2>消息收发趋势（最近24小时）</h2></div>
    <div class="chart-box"><canvas class="chart-canvas" id="chartHourly"></canvas></div>
    <div class="cards" id="statCards" style="margin-top:12px"></div>
  </div>

  

  <!-- 运行日志 -->
  <div class="page" id="page-logs">
    <div class="filter-bar">
      <input id="logFilter" placeholder="搜索日志..." oninput="renderLogs()">
      <select id="logBotFilter" onchange="renderLogs()"><option value="">全部机器人</option></select>
      <select id="logTypeFilter" onchange="renderLogs()"><option value="">全部会话</option><option value="私聊">私聊</option><option value="群聊">群聊</option><option value="插件">插件</option></select>
      <select id="logLevelFilter" onchange="renderLogs()"><option value="">全部级别</option><option value="info">info</option><option value="warn">warn</option><option value="error">error</option></select>
      <button class="btn sm" onclick="openSendPanel()">发送消息</button>
      <button class="btn ghost sm" onclick="document.getElementById('logList').scrollTop=999999">到底部</button>
    </div>
    <div id="sendPanel" class="form-panel" style="margin-bottom:12px">
      <div class="sec-head"><h3>发送测试消息</h3><button class="btn ghost sm" onclick="document.getElementById('sendPanel').classList.remove('show')">关闭</button></div>
      <div class="form-row"><label>机器人</label><select id="sendBotId"></select></div>
      <div class="form-row"><label>会话类型</label><select id="sendTargetType"><option value="private">私聊</option><option value="group">群聊</option></select></div>
      <div class="form-row"><label>目标ID</label><input id="sendTargetId" placeholder="对方ID/群号"></div>
      <div class="form-row"><label>消息内容</label><textarea id="sendMessage" rows="3"></textarea></div>
      <div class="form-actions"><button class="btn" onclick="doSendTest()">发送</button><span id="sendResult" class="muted"></span></div>
    </div>
    <div class="log-list" id="logList"></div>
  </div>

  <!-- 机器人管理 -->
  <div class="page" id="page-bots">
    <div class="sec-head"><h2>机器人</h2><button class="btn sm" id="addBotBtn">+ 添加机器人</button></div>
    <div class="form-panel" id="addForm">
      <div class="form-row"><label>botId</label><input id="f_botId" placeholder="如 QQ-Test"></div>
      <div class="form-row"><label>适配器类型</label><select id="f_type"></select></div>
      <div id="f_schemaFields"></div>
      <div class="form-row" id="f_cfgRow" style="display:none"><label style="align-self:flex-start">高级(JSON)</label><textarea id="f_cfg" spellcheck="false"></textarea></div>
      <div class="form-row"><button type="button" class="btn ghost sm" onclick="document.getElementById('f_cfgRow').style.display=document.getElementById('f_cfgRow').style.display==='none'?'':'none'">高级(JSON)</button></div>
      <div class="form-actions"><button class="btn ghost" id="addCancel">取消</button><button class="btn" id="addSubmit">确认添加</button></div>
      <div id="addMsg"></div>
    </div>
    
    <div class="bot-grid" id="botRows" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px"></div>
  </div>

  <!-- 适配器市场 -->
  <div class="page" id="page-market">
    <div class="sec-head"><h2>源配置</h2></div>
    <div class="form-panel show" style="margin-bottom:16px">
      <div class="form-row"><label>适配器源</label><input id="srcAdapterApi" placeholder="http://bot.ziyi.asia/api/adapters"></div>
      <div class="form-row"><label>插件源</label><input id="srcPluginApi" placeholder="http://bot.ziyi.asia/api/plugins"></div>
      <div class="form-actions"><button class="btn" onclick="saveSources()">保存源配置</button><span id="srcResult" class="muted"></span></div>
    </div>
    <div class="sec-head"><h2>适配器市场</h2></div>
    <div class="market-grid" id="adapterMarket"></div>
    <div class="sec-head" style="margin-top:20px"><h2>插件市场</h2></div>
    <div class="market-grid" id="pluginMarket"></div>
  </div>

  <!-- 插件管理 -->
  <div class="page" id="page-plugins">
    <div class="sec-head"><h2>已安装插件</h2></div>
    <div id="pluginRows" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px"></div>
  </div>

</div>

<!-- 底部标签栏 -->
<div class="tabbar">
  <button class="active" data-page="overview" onclick="switchPage('overview')"><span class="ico">📊</span>概览</button>
  <button data-page="logs" onclick="switchPage('logs')"><span class="ico">📋</span>日志</button>
  <button data-page="bots" onclick="switchPage('bots')"><span class="ico">🤖</span>机器人</button>
  <button data-page="plugins" onclick="switchPage('plugins')"><span class="ico">🧩</span>插件</button>
  <button data-page="market" onclick="switchPage('market')"><span class="ico">🛒</span>市场</button>
</div>

<script>
let adapterTypes=[];let statusData=null;let allLogs=[];let hourlyData=[];let busy=false;
const SCHEMA={
  onebot11:{mode:{type:"select",options:["ws_reverse","ws"]},port:{type:"number"},path:{type:"text"},url:{type:"text",showWhen:{mode:"ws"}},token:{type:"text"},ignoreSelf:{type:"boolean"}},
  milky:{mode:{type:"select",options:["ws","ws_reverse"]},url:{type:"text"},port:{type:"number",showWhen:{mode:"ws_reverse"}},path:{type:"text",showWhen:{mode:"ws_reverse"}},token:{type:"text"},ignoreSelf:{type:"boolean"}},
  satori:{mode:{type:"select",options:["ws","webhook"]},url:{type:"text"},port:{type:"number",showWhen:{mode:"webhook"}},path:{type:"text",showWhen:{mode:"webhook"}},token:{type:"text"}},
  qq:{appId:{type:"text"},appSecret:{type:"text"},intents:{type:"number"},reconnectDelay:{type:"number"},ignoreSelf:{type:"boolean"}},
  telegram:{token:{type:"text"},pollingInterval:{type:"number"}},
  kook:{token:{type:"text"},ignoreSelf:{type:"boolean"}},
  discord:{token:{type:"text"},intents:{type:"number"}},
  wechat:{appId:{type:"text"},appSecret:{type:"text"},token:{type:"text"}},
  wechat_db:{wxname:{type:"text"},dbKey:{type:"text"},selfWxname:{type:"text"},ignoreSelf:{type:"boolean"}},
  weixin_oc:{cookie:{type:"text"},token:{type:"text"}},
  bilibili_live:{roomId:{type:"number"}},
  icqq:{qq:{type:"number"},password:{type:"text"},platform:{type:"select",options:[1,2,3,4,5]}},
  douyin:{cookie:{type:"text"}},
  minecraft:{host:{type:"text"},port:{type:"number"},username:{type:"text"}},
  sandbox:{port:{type:"number"}},
};
function el(tag,cls,text,attrs){const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;if(attrs)for(const[k,v]of Object.entries(attrs)){if(k==="style")e.setAttribute("style",v);else e[k]=v}return e}
function fmtBytes(b){if(b==null)return"-";if(b>=1073741824)return(b/1073741824).toFixed(1)+" GB";if(b>=1048576)return(b/1048576).toFixed(1)+" MB";return(b/1024).toFixed(0)+" KB"}
function fmtTime(s){if(s==null)return"-";s=Math.floor(s);const d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d>0?d+"天"+h+"时":h>0?h+"时"+m+"分":m+"分"+s%60+"秒"}
function fmtTs(ts){return new Date(ts*1000).toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"})}
async function api(url,body){const opt=body?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}:{};const r=await fetch(url,opt);if(!r.ok)throw new Error((await r.text())||("HTTP "+r.status));return r.json()}
function switchPage(name){document.querySelectorAll(".page").forEach(p=>p.classList.remove("active"));document.getElementById("page-"+name).classList.add("active");document.querySelectorAll(".tabbar button").forEach(b=>b.classList.toggle("active",b.dataset.page===name));if(name==="market"){loadMarket();loadSources()}if(name==="overview")renderStats();if(name==="logs")renderLogs()}
function badge(text,cls){return el("span","badge "+cls,text)}
function sw(on,cb){const label=el("label","switch");const inp=document.createElement("input");inp.type="checkbox";inp.checked=on;inp.addEventListener("change",()=>cb(inp.checked,inp));label.append(inp,el("span","slider"));return label}
// SSE
const evtSource=new EventSource("/api/stream");
evtSource.onmessage=e=>{try{const m=JSON.parse(e.data);if(m.type==="log"){allLogs.push(m.data);if(allLogs.length>1000)allLogs.shift();if(document.getElementById("page-logs").classList.contains("active"))renderLogs()}if(m.type==="status"){statusData=m.data;renderOverview()}}catch{}};
// 概览
function renderOverview(){if(!statusData)return;const d=statusData;document.getElementById("sub").textContent="运行中 · "+d.system.platform+"/"+d.system.arch+" · 已运行 "+fmtTime(d.system.processUptime);
const sc=document.getElementById("sysCards");sc.innerHTML="";const mk=(k,v)=>{const c=el("div","card");c.append(el("div","k",k),el("div","v",v));sc.append(c)};
mk("CPU",d.system.cpuUsage+"%");mk("内存",d.system.memUsage+"%");mk("运行",fmtTime(d.system.processUptime));
const tR=d.bots.reduce((s,b)=>s+(b.stats?b.stats.received:0),0),tS=d.bots.reduce((s,b)=>s+(b.stats?b.stats.sent:0),0);
mk("总接收",String(tR));mk("总发送",String(tS));mk("机器人",String(d.bots.length));mk("插件",String(d.plugins.length));
const br=document.getElementById("ovBotRows");br.innerHTML="";if(!d.bots.length){const tr=el("tr");const td=el("td","empty","暂无");td.colSpan=5;tr.append(td);br.append(tr)}
for(const b of d.bots){const tr=el("tr");tr.append(el("td","mono",b.botId||"-"),el("td","type",b.type||"-"));const st=!b.enabled?badge("已禁用","dis"):b.connected?badge("在线","on"):badge("离线","off");const td=el("td");td.append(st);tr.append(td);tr.append(el("td","mono",String(b.stats?b.stats.received:0)),el("td","mono",String(b.stats?b.stats.sent:0)));br.append(tr)}
const pr=document.getElementById("ovPluginRows");pr.innerHTML="";if(!d.plugins.length){const tr=el("tr");const td=el("td","empty","暂无");td.colSpan=2;tr.append(td);pr.append(tr)}
for(const p of d.plugins){const tr=el("tr");tr.append(el("td","mono",p.name));const st=!p.loaded?badge("未安装","dis"):p.enabled?badge("已启用","on"):badge("已停用","off");const td=el("td");td.append(st);tr.append(td);pr.append(tr)}}
// 消息日志
function renderLogs(){const q=document.getElementById("logFilter").value.toLowerCase();const lvl=document.getElementById("logLevelFilter").value;
const botF=document.getElementById("logBotFilter").value;const typeF=document.getElementById("logTypeFilter").value;
const list=document.getElementById("logList");list.innerHTML="";
const ansiRe=/\\x1b\\[[0-9;]*m/g;
const botIds=new Set();
const filtered=allLogs.filter(l=>{
  if(lvl&&l.level!==lvl)return false;
  const clean=l.text.replace(ansiRe,"");
  if(q&&!clean.toLowerCase().includes(q))return false;
  const bm=clean.match(/\\|\\s*(\\S+?)\\s*[<-]/);
  if(bm)botIds.add(bm[1]);
  if(botF&&(!bm||bm[1]!==botF))return false;
  if(typeF&&!clean.includes(typeF))return false;
  return true;
});
const botSel=document.getElementById("logBotFilter");const cur=botSel.value;
botSel.innerHTML='<option value="">全部机器人</option>';
for(const id of [...botIds].sort()){const o=document.createElement("option");o.value=id;o.textContent=id;botSel.append(o)}
botSel.value=cur;
if(!filtered.length){list.append(el("div","empty","暂无日志"));return}
for(const l of filtered.slice(-300)){const clean=l.text.replace(ansiRe,"");
const item=el("div","log-item");
item.append(colorizeLog(clean,l.level));
list.append(item)}
list.scrollTop=999999}
function colorizeLog(text,logLevel){
  const frag=document.createDocumentFragment();
  const m=text.match(/^(\\d{2}-\\d{2}\\s+\\d{2}:\\d{2})\\s+\\|\\s+(\\S+?)\\s+(<-|->)\\s+(私聊|群聊|通知|事件|插件)\\s+\\(([^)]+)\\)\\s*(.*)$/);
  const row=document.createElement("div");
  row.style.cssText="display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;line-height:1.7";
  const mk=(txt,color,bold,mono)=>{const s=document.createElement("span");s.textContent=txt;s.style.color=color;if(bold)s.style.fontWeight=bold;if(mono)s.style.fontFamily="monospace";s.style.fontSize=mono?"12px":"13px";return s};
  if(logLevel){const lc=logLevel==="error"?"#ef5350":logLevel==="warn"?"#ffb74d":"#90a4ae";row.append(mk("["+logLevel.toUpperCase()+"]",lc,"700",null))}
  if(!m){row.append(mk(text,"#bbb",null,null));frag.append(row);return frag}
  const [,time,botId,dir,chatType,chatId,content]=m;
  row.append(mk(time,"#78909c",null,true));
  row.append(mk(botId,"#ffd54f","600",null));
  row.append(mk(dir==="<-"?"接收":"发送",dir==="<-"?"#66bb6a":"#ff8a65","700",null));
  const tc=chatType==="私聊"?"#42a5f5":chatType==="群聊"?"#ab47bc":chatType==="通知"?"#26c6da":chatType==="事件"?"#ffa726":"#ffa726";
  row.append(mk(chatType,tc,"600",null));
  row.append(mk("("+chatId+")","#546e7a",null,true));
  row.append(mk(content,"#eceff1",null,null));
  frag.append(row);
  return frag}async function toggleBot(botId,on,swEl){if(busy)return;busy=true;swEl.disabled=true;try{await api("/api/bot/enable",{botId,enable:on})}catch(e){swEl.checked=!on}finally{swEl.disabled=false;busy=false;await refresh()}}
async function togglePlugin(name,on,swEl){if(busy)return;busy=true;swEl.disabled=true;try{await api("/api/plugin/enable",{name,enable:on})}catch(e){swEl.checked=!on}finally{swEl.disabled=false;busy=false;await refresh()}}
async function removeBot(botId){if(!confirm("确认删除机器人 "+botId+" ？"))return;try{await api("/api/bot/remove",{botId});await refresh()}catch(e){alert("删除失败: "+e.message)}}
function renderBots(){if(!statusData)return;const d=statusData;const br=document.getElementById("botRows");br.innerHTML="";
if(!d.bots.length){br.append(el("div","empty","暂无机器人，点右上角添加"))}
for(const b of d.bots){const card=el("div","market-card");
const head=el("div");head.style.display="flex";head.style.justifyContent="space-between";head.style.alignItems="center";head.style.marginBottom="6px";
head.append(el("div","name",b.botId||"-"));
const st=!b.enabled?badge("已禁用","dis"):b.connected?badge("在线","on"):badge("离线","off");head.append(st);card.append(head);
card.append(el("div","desc","类型: "+(b.type||"-")+"  |  selfId: "+(b.selfId||"-")));
const stats=el("div");stats.style.display="flex";stats.style.gap="16px";stats.style.margin="8px 0";
stats.append(el("span","muted","接收 "+(b.stats?b.stats.received:0)));stats.append(el("span","muted","发送 "+(b.stats?b.stats.sent:0)));card.append(stats);
const actions=el("div");actions.style.display="flex";actions.style.justifyContent="space-between";actions.style.alignItems="center";
const swWrap=el("div");swWrap.onclick=e=>e.stopPropagation();swWrap.append(sw(b.enabled,(on,e2)=>toggleBot(b.botId,on,e2)));actions.append(swWrap);
const del=el("button","btn danger","删除");del.onclick=e=>{e.stopPropagation();removeBot(b.botId)};actions.append(del);card.append(actions);br.append(card)}}function renderPlugins(){if(!statusData)return;const d=statusData;const pr=document.getElementById("pluginRows");pr.innerHTML="";
if(!d.plugins.length){pr.append(el("div","empty","暂无插件"))}
for(const p of d.plugins){const card=el("div","market-card");
const head=el("div");head.style.display="flex";head.style.justifyContent="space-between";head.style.alignItems="center";
head.append(el("div","name",p.name));
const st=!p.loaded?badge("未安装","dis"):p.enabled?badge("已启用","on"):badge("已停用","off");head.append(st);card.append(head);
card.append(el("div","desc","技能数: "+(p.skills??0)));
const actions=el("div");actions.style.display="flex";actions.style.justifyContent="flex-end";actions.style.marginTop="8px";
if(p.loaded){const swEl=sw(p.enabled,(on)=>togglePlugin(p.name,on,swEl));actions.append(swEl)}
card.append(actions);pr.append(card)}}function buildSchemaFields(type,cfg){const container=document.getElementById("f_schemaFields");container.innerHTML="";const schema=SCHEMA[type];if(!schema)return;
const LABELS={mode:"连接模式",port:"端口",path:"路径",url:"地址",token:"令牌",ignoreSelf:"忽略自身消息",
appId:"AppID",clientSecret:"ClientSecret",secret:"密钥",apiRoot:"API地址",baseUrl:"基础地址",
selfId:"自身ID",botId:"机器人ID",nickname:"昵称",prefix:"命令前缀",admins:"管理员列表",
dbKey:"数据库密钥",dbPath:"数据库路径",selfWxname:"微信昵称",wxWindowTitle:"窗口标题",
cookie:"Cookie",roomId:"房间号",channel:"频道",tokenSecret:"Token密钥",
accessToken:"访问令牌",refreshToken:"刷新令牌",expireTime:"过期时间",
host:"主机",username:"用户名",password:"密码",database:"数据库名",
apiKey:"API Key",apiSecret:"API Secret",webhookUrl:"Webhook地址",
verifyToken:"验证令牌",encodingAesKey:"加密AES密钥",
groupId:"群ID",userId:"用户ID",targetId:"目标ID",
messageCache:"消息缓存",logLevel:"日志级别",debug:"调试模式",
reconnectInterval:"重连间隔",heartbeatInterval:"心跳间隔",
maxRetries:"最大重试次数",timeout:"超时时间(ms)"};
for(const[key,def]of Object.entries(schema)){if(def.showWhen){const sk=Object.keys(def.showWhen)[0];if(cfg[sk]!==def.showWhen[sk])continue}
const row=el("div","form-row");
const labelText=def.label||LABELS[key]||key;
const labelEl=el("label",labelText);
if(def.desc){labelEl.title=def.desc;labelEl.style.cursor="help"}
row.append(labelEl);let input;
if(def.type==="select"){input=document.createElement("select");for(const opt of def.options){const o=document.createElement("option");o.value=opt;o.textContent=opt;input.append(o)}input.value=cfg[key]??def.options[0]}
else if(def.type==="number"){input=document.createElement("input");input.type="text";input.value=cfg[key]??"";input.placeholder=def.placeholder||"请输入"+labelText}
else if(def.type==="boolean"){input=document.createElement("input");input.type="checkbox";input.checked=!!cfg[key];input.style.width="20px"}
else{input=document.createElement("input");input.type="text";input.value=cfg[key]??"";input.placeholder=def.placeholder||"请输入"+labelText}
input.dataset.key=key;input.addEventListener("change",syncCfgFromFields);row.append(input);container.append(row)}}
function syncCfgFromFields(){const cfg={};document.querySelectorAll("#f_schemaFields [data-key]").forEach(inp=>{const k=inp.dataset.key;cfg[k]=inp.type==="checkbox"?inp.checked:inp.type==="number"?Number(inp.value):inp.value});
const type=document.getElementById("f_type").value;const botId=document.getElementById("f_botId").value.trim()||"MyBot";
document.getElementById("f_cfg").value=JSON.stringify(Object.assign({botId,type,enable:true},cfg),null,2)}function syncCfgFromSchema(){const type=document.getElementById("f_type").value;let cfg;try{cfg=JSON.parse(document.getElementById("f_cfg").value)}catch{cfg={}}
const schema=SCHEMA[type]||{};for(const[key,def]of Object.entries(schema)){const el2=document.getElementById("sf_"+key);if(!el2)continue;cfg[key]=def.type==="boolean"?el2.checked:(def.type==="number"?(el2.value===""?undefined:Number(el2.value)):el2.value);if(cfg[key]===undefined)delete cfg[key]}
document.getElementById("f_cfg").value=JSON.stringify(cfg,null,2)}
function fillTpl(){const botId=document.getElementById("f_botId").value.trim()||"MyBot";const type=document.getElementById("f_type").value;const cfg=Object.assign({botId,type,enable:true},SCHEMA[type]?Object.fromEntries(Object.entries(SCHEMA[type]).map(([k,d])=>[k,d.type==="select"?d.options[0]:d.type==="number"?0:d.type==="boolean"?false:""])):{});
document.getElementById("f_cfg").value=JSON.stringify(cfg,null,2);buildSchemaFields(type,cfg)}
// 市场
async function loadMarket(){try{
if(!adapterTypes.length)adapterTypes=(await api("/api/adapter-types")).types||[];
const[aList,pList]=await Promise.all([api("/api/registry/adapters"),api("/api/registry/plugins")]);
const installedA=new Set(adapterTypes);const am=document.getElementById("adapterMarket");am.innerHTML="";
for(const a of(aList.adapters||aList||[])){const card=el("div","market-card");card.append(el("div","name",a.name),el("div","desc",a.description||"暂无描述"));
const meta=el("div","meta");const ver=el("span","muted","v"+(a.version||"?"));meta.append(ver);
const isInst=installedA.has(a.name);const btn=el("button",isInst?"btn ghost sm":"btn sm",isInst?"已安装":"安装");if(!isInst){btn.onclick=async()=>{btn.disabled=true;btn.textContent="安装中...";try{const r=await api("/api/adapter/install",{name:a.name});alert(r.message);if(r.ok)loadMarket()}catch(e){alert("安装失败: "+e.message)}finally{btn.disabled=false;btn.textContent=isInst?"已安装":"安装"}};btn.disabled=isInst}
meta.append(btn);card.append(meta);am.append(card)}
const installedP=new Set(await api("/api/installed-plugins").then(r=>r.plugins||[]).catch(()=>[]));
const pm=document.getElementById("pluginMarket");pm.innerHTML="";
for(const p of(pList.plugins||pList||[])){const card=el("div","market-card");card.append(el("div","name",p.name),el("div","desc",p.description||"暂无描述"));
const meta=el("div","meta");meta.append(el("span","muted","v"+(p.version||"?")));
const isInst=installedP.has(p.name);const btn2=el("button",isInst?"btn ghost sm":"btn sm",isInst?"已安装":"安装");if(!isInst){btn2.onclick=async()=>{btn2.disabled=true;btn2.textContent="安装中...";try{const r=await api("/api/plugin/install",{name:p.name});alert(r.message);if(r.ok)loadMarket()}catch(e){alert("安装失败: "+e.message)}finally{btn2.disabled=false;btn2.textContent=isInst?"已安装":"安装"}};btn2.disabled=isInst}
meta.append(btn2);card.append(meta);pm.append(card)}
}catch(e){document.getElementById("adapterMarket").innerHTML='<div class="empty">社区源不可达: '+e.message+'</div>'}}
async function loadSources(){try{const r=await api("/api/config/sources");document.getElementById("srcAdapterApi").value=r.adapterApi||"";document.getElementById("srcPluginApi").value=r.pluginApi||""}catch(e){}}
async function saveSources(){const adapterApi=document.getElementById("srcAdapterApi").value.trim();const pluginApi=document.getElementById("srcPluginApi").value.trim();const result=document.getElementById("srcResult");result.textContent="保存中...";try{const r=await api("/api/config/sources",{adapterApi,pluginApi});result.textContent=r.ok?"已保存，刷新市场生效":"保存失败"}catch(e){result.textContent="保存失败: "+e.message}}
// 统计
function openSendPanel(){const p=document.getElementById("sendPanel");p.classList.toggle("show");
if(p.classList.contains("show")){const sel=document.getElementById("sendBotId");sel.innerHTML="";
for(const b of (statusData?.bots||[])){const o=document.createElement("option");o.value=b.botId||b.id||b.selfId||"";o.textContent=(b.botId||b.id||b.selfId||"未知")+(b.type?" ["+b.type+"]":"")+(b.connected?" ✓":"");sel.append(o)}}}
async function doSendTest(){const botId=document.getElementById("sendBotId").value;const targetType=document.getElementById("sendTargetType").value;
const targetId=document.getElementById("sendTargetId").value.trim();const message=document.getElementById("sendMessage").value;
const result=document.getElementById("sendResult");
if(!botId){result.textContent="请选择机器人";return}if(!targetId){result.textContent="请输入目标ID";return}if(!message){result.textContent="请输入消息内容";return}
result.textContent="发送中...";
try{const r=await api("/api/bot/send",{botId,targetType,targetId,message});result.textContent=r.ok?"发送成功":"发送失败: "+(r.error||"");
if(r.ok)document.getElementById("sendMessage").value=""}catch(e){result.textContent="发送失败: "+e.message}}function renderStats(){if(!hourlyData.length)return;
const canvas=document.getElementById("chartHourly");const ctx=canvas.getContext("2d");const W=canvas.width=canvas.offsetWidth*2,H=canvas.height=360;ctx.scale(2,2);const w=W/2,h=H/2;
const data=hourlyData.slice(-24);const maxV=Math.max(...data.map(d=>d.received+d.sent),1);
ctx.clearRect(0,0,w,h);const padL=36,padB=24,chartW=w-padL-8,chartH=h-padB-8;
ctx.strokeStyle="#26385e";ctx.lineWidth=1;ctx.fillStyle="#8fa0bd";ctx.font="10px sans-serif";
for(let i=0;i<=4;i++){const y=chartH-(chartH*i/4);ctx.beginPath();ctx.moveTo(padL,y);ctx.lineTo(w-8,y);ctx.stroke();ctx.fillText(Math.round(maxV*i/4),4,y+3)}
const bw=chartW/data.length*0.6;
data.forEach((d,i)=>{const x=padL+chartW*i/data.length+chartW/data.length*0.2;
const rh=chartH*d.received/maxV,sh=chartH*d.sent/maxV;
ctx.fillStyle="#3fb950";ctx.fillRect(x,chartH-rh,bw/2,rh);
ctx.fillStyle="#4a86f5";ctx.fillRect(x+bw/2,chartH-sh,bw/2,sh);
if(i%4===0){ctx.fillStyle="#8fa0bd";ctx.fillText(d.hour.slice(-5),x,chartH+14)}});
ctx.fillStyle="#3fb950";ctx.fillRect(w-100,4,10,10);ctx.fillStyle="#e8eefb";ctx.fillText("接收",w-86,13);
ctx.fillStyle="#4a86f5";ctx.fillRect(w-50,4,10,10);ctx.fillStyle="#e8eefb";ctx.fillText("发送",w-36,13);
const sc=document.getElementById("statCards");sc.innerHTML="";
const tR=hourlyData.reduce((s,d)=>s+d.received,0),tS=hourlyData.reduce((s,d)=>s+d.sent,0);
const mk=(k,v)=>{const c=el("div","card");c.append(el("div","k",k),el("div","v",v));sc.append(c)};
mk("24h接收",String(tR));mk("24h发送",String(tS));mk("峰值小时",String(Math.max(...hourlyData.map(d=>d.received+d.sent),0)))}
// 刷新
async function refresh(){try{statusData=await api("/api/status");renderOverview();renderBots();renderPlugins();if(document.getElementById("page-overview").classList.contains("active"))renderStats()}catch(e){document.getElementById("sub").textContent="连接失败: "+e.message}}
// 初始化
document.getElementById("addBotBtn").addEventListener("click",async()=>{if(!adapterTypes.length)adapterTypes=(await api("/api/adapter-types")).types||[];const sel=document.getElementById("f_type");sel.innerHTML="";for(const t of adapterTypes){const o=document.createElement("option");o.value=t;o.textContent=t;sel.append(o)}fillTpl();document.getElementById("addForm").classList.add("show")});
document.getElementById("f_type").addEventListener("change",fillTpl);
document.getElementById("f_botId").addEventListener("input",()=>{let c=JSON.parse(document.getElementById("f_cfg").value);c.botId=document.getElementById("f_botId").value.trim()||"MyBot";document.getElementById("f_cfg").value=JSON.stringify(c,null,2)});
document.getElementById("addCancel").addEventListener("click",()=>document.getElementById("addForm").classList.remove("show"));
document.getElementById("addSubmit").addEventListener("click",async()=>{let cfg;try{cfg=JSON.parse(document.getElementById("f_cfg").value)}catch(e){document.getElementById("addMsg").innerHTML='<div class="err">配置不是合法JSON</div>';return}
if(!cfg.botId||!cfg.type){document.getElementById("addMsg").innerHTML='<div class="err">配置必须包含 botId 和 type</div>';return}
try{await api("/api/bot/add",{cfg});document.getElementById("addMsg").innerHTML='<div class="ok">已添加 '+cfg.botId+'</div>';document.getElementById("addForm").classList.remove("show");await refresh()}catch(e){document.getElementById("addMsg").innerHTML='<div class="err">添加失败: '+e.message+'</div>'}});
refresh();
// 定时拉取统计数据
(async()=>{try{const r=await api("/api/stats/hourly");hourlyData=r.stats||[];renderStats()}catch{}})();
setInterval(async()=>{try{const r=await api("/api/stats/hourly");hourlyData=r.stats||[];if(document.getElementById("page-overview").classList.contains("active"))renderStats()}catch{}},10000);
</script>
</body>
</html>`

// ─── HTTP 服务 ─────────────────────────────────────────────────────
export function startWebUI(bridge: PluginApiBridge, cfg: WebUIConfig): { close(): void } {
  const host = cfg.host ?? "127.0.0.1"
  const port = cfg.port ?? 8080
  const logoPath = resolve("src/assets/logo.png")

  const server = http.createServer(async (req, res) => {
    const url = (req.url ?? "/").split("?")[0]
    const send = (code: number, body: string, type = "application/json") => {
      res.writeHead(code, { "Content-Type": type + "; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" })
      res.end(body)
    }
    const readBody = () => new Promise<string>((resolveBody, reject) => {
      let data = ""
      req.on("data", (c) => (data += c))
      req.on("end", () => resolveBody(data))
      req.on("error", reject)
    })

    try {
      if (req.method === "GET" && url === "/") { send(200, PAGE, "text/html"); return }
      if (req.method === "GET" && url === "/logo") {
        if (existsSync(logoPath)) { res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "max-age=86400" }); res.end(readFileSync(logoPath)) }
        else { res.writeHead(404); res.end() }
        return
      }
      // SSE 实时流
      if (req.method === "GET" && url === "/api/stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" })
        res.write(`data: ${JSON.stringify({ type: "message_history", data: messageLog })}\n\n`)
        res.write(`data: ${JSON.stringify({ type: "log_history", data: runLog })}\n\n`)
        sseClients.add(res)
        req.on("close", () => sseClients.delete(res))
        // 定时推送状态
        const statusTimer = setInterval(async () => {
          try {
            const [system, bots, plugins] = await Promise.all([bridge.getSystemInfo(), Promise.resolve(bridge.listBots()), Promise.resolve(bridge.listPlugins())])
            res.write(`data: ${JSON.stringify({ type: "status", data: { system, bots, plugins } })}\n\n`)
          } catch { /* ignore */ }
        }, 5000)
        req.on("close", () => clearInterval(statusTimer))
        return
      }
      if (req.method === "GET" && url === "/api/status") {
        const [system, bots, plugins] = await Promise.all([bridge.getSystemInfo(), Promise.resolve(bridge.listBots()), Promise.resolve(bridge.listPlugins())])
        send(200, JSON.stringify({ system, bots, plugins })); return
      }
      if (req.method === "GET" && url === "/api/config/sources") {
        const cfg = readConfig()
        send(200, JSON.stringify({ adapterApi: cfg.adapterApi ?? "", pluginApi: cfg.pluginApi ?? "" })); return
      }
      if (req.method === "POST" && url === "/api/config/sources") {
        const { adapterApi, pluginApi } = JSON.parse(await readBody())
        const cfg = readConfig()
        if (typeof adapterApi === "string") cfg.adapterApi = adapterApi || undefined
        if (typeof pluginApi === "string") cfg.pluginApi = pluginApi || undefined
        writeFileSync(getConfigPath(), JSON.stringify(cfg, null, 2), "utf-8")
        send(200, JSON.stringify({ ok: true })); return
      }
      if (req.method === "GET" && url === "/api/adapter-types") { send(200, JSON.stringify({ types: installedAdapterTypes() })); return }
      if (req.method === "GET" && url === "/api/installed-plugins") { send(200, JSON.stringify({ plugins: installedPlugins() })); return }
      if (req.method === "GET" && url === "/api/registry/adapters") {
        try { const list = await fetchJson(`${adapterApiBase()}.json`); send(200, JSON.stringify(list)) } catch (e) { send(502, JSON.stringify({ error: String(e) })) }
        return
      }
      if (req.method === "GET" && url === "/api/registry/plugins") {
        try { const list = await fetchJson(`${pluginApiBase()}.json`); send(200, JSON.stringify(list)) } catch (e) { send(502, JSON.stringify({ error: String(e) })) }
        return
      }
      if (req.method === "GET" && url === "/api/stats/hourly") {
        const stats = Array.from(hourlyStats.entries()).map(([hour, v]) => ({ hour, ...v })).sort((a, b) => a.hour.localeCompare(b.hour))
        send(200, JSON.stringify({ stats })); return
      }
      if (req.method === "POST" && url === "/api/bot/enable") {
        const { botId, enable } = JSON.parse(await readBody())
        if (typeof botId !== "string") { send(400, JSON.stringify({ error: "缺少 botId" })); return }
        if (enable) await bridge.enableBot(botId); else await bridge.disableBot(botId)
        send(200, JSON.stringify({ ok: true })); return
      }
      if (req.method === "POST" && url === "/api/bot/add") {
        const { cfg: botCfg } = JSON.parse(await readBody())
        if (!botCfg || typeof botCfg.botId !== "string" || typeof botCfg.type !== "string") { send(400, JSON.stringify({ error: "配置必须包含 botId 和 type" })); return }
        await bridge.addBot(botCfg); send(200, JSON.stringify({ ok: true })); return
      }
      if (req.method === "POST" && url === "/api/bot/remove") {
        const { botId } = JSON.parse(await readBody())
        if (typeof botId !== "string") { send(400, JSON.stringify({ error: "缺少 botId" })); return }
        await bridge.removeBot(botId); send(200, JSON.stringify({ ok: true })); return
      }
      if (req.method === "POST" && url === "/api/bot/send") {
        const { botId, targetType, targetId, message } = JSON.parse(await readBody())
        const bot = get_bot(botId)
        if (!bot) { send(404, JSON.stringify({ error: "机器人未找到" })); return }
        try {
          const target = targetType === "group" ? { groupId: targetId } : { userId: targetId }
          await bot.sendMsg(target, String(message))
          send(200, JSON.stringify({ ok: true })); return
        } catch (e: any) {
          send(500, JSON.stringify({ error: String(e?.message ?? e) })); return
        }
      }
      if (req.method === "POST" && url === "/api/plugin/enable") {
        const { name, enable } = JSON.parse(await readBody())
        if (typeof name !== "string") { send(400, JSON.stringify({ error: "缺少 name" })); return }
        if (enable) await bridge.enablePlugin(name); else await bridge.disablePlugin(name)
        send(200, JSON.stringify({ ok: true })); return
      }
      if (req.method === "POST" && url === "/api/adapter/install") {
        const { name } = JSON.parse(await readBody())
        if (typeof name !== "string") { send(400, JSON.stringify({ error: "缺少 name" })); return }
        const result = await installAdapter(name); send(result.ok ? 200 : 500, JSON.stringify(result)); return
      }
      if (req.method === "POST" && url === "/api/plugin/install") {
        const { name } = JSON.parse(await readBody())
        if (typeof name !== "string") { send(400, JSON.stringify({ error: "缺少 name" })); return }
        const result = await installPlugin(name); send(result.ok ? 200 : 500, JSON.stringify(result)); return
      }
      send(404, JSON.stringify({ error: "Not Found" }))
    } catch (e) {
      send(500, JSON.stringify({ error: (e as Error).message }))
    }
  })

  server.listen(port, host, () => {
    origLog(`[WebUI] 控制台已启动: http://${host}:${port}`)
  })
  server.on("error", (e) => {
    origError(`[WebUI] 启动失败: ${(e as Error).message}`)
  })

  return {
    close() {
      try { server.close() } catch { /* ignore */ }
      for (const res of sseClients) { try { res.end() } catch { /* ignore */ } }
      sseClients.clear()
    },
  }
}
