// WebUI 控制台（零依赖，内置 http 服务 + 单页前端）
// 面向不会用 CLI 的用户：可视化查看系统状态、机器人收发统计、插件启用状态，
// 可直接启停 / 添加 / 删除机器人，启停插件（写回 config.json，框架热重载自动生效）。
// 数据全部来自 PluginApiBridge（受控能力层），不暴露内核原始对象。
import http from "http"
import { existsSync, readFileSync, readdirSync } from "fs"
import { resolve, join } from "path"
import { PluginApiBridge } from "./pluginApi.js"

export interface WebUIConfig {
  enable?: boolean
  port?: number
  host?: string
}

const PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VanBotJS 控制台</title>
<style>
  :root {
    --bg:#0a1324; --panel:#121f3a; --panel2:#182a4d; --border:#26385e;
    --text:#e8eefb; --dim:#8fa0bd;
    --accent:#4a86f5; --accent-d:#3a6fd8; --accent-soft:rgba(74,134,245,.15);
    --green:#3fb950; --red:#f85149; --yellow:#d29922;
  }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:radial-gradient(1100px 480px at 15% -10%,rgba(74,134,245,.20),transparent),radial-gradient(900px 420px at 90% -5%,rgba(135,110,255,.12),transparent),var(--bg); background-attachment:fixed; color:var(--text); font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; padding:24px; }
  .wrap { max-width:1000px; margin:0 auto; overflow-x:auto; }
  .head { display:flex; align-items:center; gap:12px; margin-bottom:4px; }
  .head img { width:38px; height:38px; border-radius:9px; }
  h1 { font-size:21px; background:linear-gradient(90deg,#5b94ff,#9b7bff); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .sub { color:var(--dim); font-size:12px; margin-bottom:20px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:24px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:14px 16px; }
  .card .k { color:var(--dim); font-size:12px; margin-bottom:4px; }
  .card .v { font-size:20px; font-weight:600; }
  .sec-head { display:flex; align-items:center; justify-content:space-between; margin:22px 0 10px; }
  h2 { font-size:15px; }
  .btn { border:1px solid var(--accent); background:var(--accent); color:#fff; border-radius:8px; padding:6px 14px; font-size:13px; cursor:pointer; transition:.15s; }
  .btn:hover { background:var(--accent-d); border-color:var(--accent-d); }
  .btn.ghost { background:transparent; color:var(--accent); }
  .btn.ghost:hover { background:var(--accent-soft); }
  .btn.danger { -webkit-appearance:none; appearance:none; border:none; outline:none; background:transparent; box-shadow:none; color:var(--dim); padding:3px 6px; font-size:12px; border-radius:6px; cursor:pointer; transition:.15s; white-space:nowrap; font-family:inherit; }
  .btn.danger:hover { color:#ff7a72; background:rgba(248,81,73,.12); }
  table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--border); border-radius:10px; overflow:hidden; }
  th,td { text-align:left; padding:9px 14px; border-bottom:1px solid var(--border); font-size:13px; white-space:nowrap; }
  th { color:var(--dim); font-weight:500; background:rgba(74,134,245,.08); }
  tr:last-child td { border-bottom:none; }
  .badge { display:inline-block; padding:2px 10px; border-radius:99px; font-size:12px; white-space:nowrap; }
  .badge.on { background:rgba(63,185,80,.15); color:var(--green); }
  .badge.off { background:rgba(139,152,173,.15); color:var(--dim); }
  .badge.dis { background:rgba(248,81,73,.15); color:var(--red); }
  .type { color:var(--accent); font-family:ui-monospace,Consolas,monospace; font-size:12px; }
  .mono { font-family:ui-monospace,Consolas,monospace; font-size:12px; }
  td.mono { max-width:180px; overflow:hidden; text-overflow:ellipsis; }
  .muted { color:var(--dim); }
  .switch { position:relative; width:40px; height:22px; display:inline-block; vertical-align:middle; }
  .switch input { opacity:0; width:0; height:0; }
  .slider { position:absolute; inset:0; background:#2c3650; border-radius:99px; cursor:pointer; transition:.2s; }
  .slider:before { content:""; position:absolute; width:16px; height:16px; left:3px; top:3px; background:#8b98ad; border-radius:50%; transition:.2s; }
  .switch input:checked + .slider { background:var(--accent); }
  .switch input:checked + .slider:before { transform:translateX(18px); background:#fff; }
  .row-act { display:flex; align-items:center; gap:12px; justify-content:center; }
  .form-panel { background:var(--panel); border:1px solid var(--accent); border-radius:10px; padding:16px; margin-bottom:12px; display:none; }
  .form-panel.show { display:block; }
  .form-row { display:flex; gap:12px; margin-bottom:10px; flex-wrap:wrap; }
  .form-row label { width:88px; color:var(--dim); font-size:13px; line-height:32px; }
  .form-row input, .form-row select, .form-row textarea { flex:1; min-width:200px; background:var(--panel2); border:1px solid var(--border); color:var(--text); border-radius:8px; padding:7px 10px; font-size:13px; font-family:inherit; }
  .form-row textarea { font-family:ui-monospace,Consolas,monospace; min-height:150px; resize:vertical; }
  .form-actions { display:flex; gap:10px; justify-content:flex-end; margin-top:6px; }
  .err { color:var(--red); font-size:12px; margin-top:8px; }
  .ok { color:var(--green); font-size:12px; margin-top:8px; }
  .empty { color:var(--dim); padding:16px; text-align:center; }
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <img src="/logo" alt="logo" onerror="this.style.display='none'">
    <h1>VanBotJS 控制台</h1>
  </div>
  <div class="sub" id="sub">加载中...</div>

  <div class="cards" id="sysCards"></div>

  <div class="sec-head">
    <h2>机器人</h2>
    <button class="btn" id="addBotBtn">+ 添加机器人</button>
  </div>
  <div class="form-panel" id="addForm">
    <div class="form-row"><label>botId</label><input id="f_botId" placeholder="框架内唯一标识，如 QQ-Test"></div>
    <div class="form-row"><label>适配器类型</label><select id="f_type"></select></div>
    <div class="form-row"><label>完整配置</label><textarea id="f_cfg" spellcheck="false"></textarea></div>
    <div class="form-actions">
      <button class="btn ghost" id="addCancel">取消</button>
      <button class="btn" id="addSubmit">确认添加</button>
    </div>
  </div>
  <table>
    <thead><tr><th>botId</th><th>类型</th><th>状态</th><th>selfId</th><th>接收</th><th>发送</th><th style="text-align:center">启用</th><th style="text-align:center">操作</th></tr></thead>
    <tbody id="botRows"></tbody>
  </table>

  <h2 style="margin-top:22px">插件</h2>
  <table>
    <thead><tr><th>名称</th><th>状态</th><th style="text-align:center">启用</th></tr></thead>
    <tbody id="pluginRows"></tbody>
  </table>

  <div id="msg"></div>
</div>
<script>
let adapterTypes = []
async function get(url, body) {
  const opt = body ? { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(body) } : {}
  const r = await fetch(url, opt)
  if (!r.ok) throw new Error((await r.text()) || ("HTTP " + r.status))
  return r.json()
}
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
function fmtBytes(b) { if (b == null) return "-"; if (b >= 1073741824) return (b/1073741824).toFixed(1)+" GB"; if (b >= 1048576) return (b/1048576).toFixed(1)+" MB"; return (b/1024).toFixed(0)+" KB" }
function fmtTime(s) { if (s == null) return "-"; s = Math.floor(s); const d = Math.floor(s/86400), h = Math.floor(s%86400/3600), m = Math.floor(s%3600/60); return d>0 ? d+"天"+h+"时" : h>0 ? h+"时"+m+"分" : m+"分"+s%60+"秒" }
function msg(text, ok) { const m = document.getElementById("msg"); m.className = ok ? "ok" : "err"; m.textContent = text; if (ok) setTimeout(() => { m.textContent = "" }, 3000) }
let busy = false
async function toggleBot(botId, on, sw) {
  if (busy) return; busy = true; sw.disabled = true
  try { await get("/api/bot/enable", { botId, enable: on }); msg(on ? "已启用 " + botId : "已停用 " + botId, true) }
  catch (e) { msg("操作失败: " + e.message); sw.checked = !on }
  finally { sw.disabled = false; busy = false; refresh() }
}
async function togglePlugin(name, on, sw) {
  if (busy) return; busy = true; sw.disabled = true
  try { await get("/api/plugin/enable", { name, enable: on }); msg(on ? "已启用插件 " + name : "已停用插件 " + name, true) }
  catch (e) { msg("操作失败: " + e.message); sw.checked = !on }
  finally { sw.disabled = false; busy = false; refresh() }
}
async function removeBot(botId) {
  if (!confirm("确认删除机器人 " + botId + " ？（会从 config.json 移除并断开连接）")) return
  try { await get("/api/bot/remove", { botId }); msg("已删除 " + botId, true); refresh() }
  catch (e) { msg("删除失败: " + e.message) }
}
function badge(text, cls) { return el("span", "badge " + cls, text) }
function sw(on, cb) {
  const label = el("label", "switch"); const inp = document.createElement("input"); inp.type = "checkbox"; inp.checked = on
  inp.addEventListener("change", () => cb(inp.checked, inp)); label.append(inp, el("span", "slider")); return label
}
// 各适配器最小配置模板
const TPL = {
  onebot11: { mode:"ws_reverse", port:8080, path:"/onebot" },
  milky: { mode:"ws", url:"ws://127.0.0.1:8080" },
  satori: { mode:"ws", url:"ws://127.0.0.1:5500" },
  qq: { appId:"", appSecret:"", intents:33554432, reconnectDelay:5000, ignoreSelf:true },
  telegram: { token:"" },
  wechat: { appId:"", appSecret:"", token:"" },
  kook: { token:"" },
  discord: { token:"" },
  weixin_oc: {},
  bilibili_live: { roomId:0 },
  icqq: {},
  douyin: { cookie:"" },
  minecraft: { host:"localhost", port:25565, username:"Bot" },
  sandbox: { port:8800 },
}
function fillTpl() {
  const botId = document.getElementById("f_botId").value.trim() || "MyBot"
  const type = document.getElementById("f_type").value
  const cfg = Object.assign({ botId, type, enable:true }, TPL[type] || {})
  document.getElementById("f_cfg").value = JSON.stringify(cfg, null, 2)
}
async function refresh() {
  try {
    const d = await get("/api/status")
    document.getElementById("sub").textContent = "运行中 · " + d.system.platform + "/" + d.system.arch + " · 已运行 " + fmtTime(d.system.processUptime) + " · 刷新于 " + new Date().toLocaleTimeString()
    const sc = document.getElementById("sysCards"); sc.innerHTML = ""
    const mk = (k, v) => { const c = el("div", "card"); c.append(el("div", "k", k), el("div", "v", v)); sc.append(c) }
    mk("CPU 占用", d.system.cpuUsage + "%")
    mk("内存占用", d.system.memUsage + "%")
    mk("内存", fmtBytes(d.system.totalMem - d.system.freeMem) + " / " + fmtBytes(d.system.totalMem))
    mk("平台", d.system.platform + " / " + d.system.arch)
    const totalR = d.bots.reduce((s, b) => s + (b.stats ? b.stats.received : 0), 0)
    const totalS = d.bots.reduce((s, b) => s + (b.stats ? b.stats.sent : 0), 0)
    mk("总接收", String(totalR)); mk("总发送", String(totalS))
    const br = document.getElementById("botRows"); br.innerHTML = ""
    if (!d.bots.length) { const trE = el("tr"); const tdE = el("td", "empty", "暂无机器人，点右上角「添加机器人」"); tdE.colSpan = 8; trE.append(tdE); br.append(trE) }
    for (const b of d.bots) {
      const tr = el("tr")
      tr.append(el("td", "mono", b.botId || "-"))
      tr.append(el("td", "type", b.type || "-"))
      const st = !b.enabled ? badge("已禁用", "dis") : b.connected ? badge("在线", "on") : badge("离线", "off")
      const tdSt = el("td", null, ""); tdSt.append(st); tr.append(tdSt)
      tr.append(el("td", "mono muted", b.selfId || "-"))
      tr.append(el("td", "mono", String(b.stats ? b.stats.received : 0)))
      tr.append(el("td", "mono", String(b.stats ? b.stats.sent : 0)))
      const tdSw = el("td"); tdSw.style.textAlign = "center"; tdSw.append(sw(b.enabled, (on, e2) => toggleBot(b.botId, on, e2))); tr.append(tdSw)
      const tdAct = el("td"); tdAct.style.textAlign = "center"
      const del = el("button", "btn danger", "删除"); del.addEventListener("click", () => removeBot(b.botId)); tdAct.append(del); tr.append(tdAct)
      br.append(tr)
    }
    const pr = document.getElementById("pluginRows"); pr.innerHTML = ""
    if (!d.plugins.length) { const trE = el("tr"); const tdE = el("td", "empty", "暂无插件"); tdE.colSpan = 3; trE.append(tdE); pr.append(trE) }
    for (const p of d.plugins) {
      const tr = el("tr")
      tr.append(el("td", "mono", p.name))
      const st = !p.loaded ? badge("未安装", "dis") : p.enabled ? badge("已启用", "on") : badge("已停用", "off")
      const tdSt = el("td", null, ""); tdSt.append(st); tr.append(tdSt)
      const td = el("td"); td.style.textAlign = "center"
      if (p.loaded) td.append(sw(p.enabled, (on, e2) => togglePlugin(p.name, on, e2)))
      tr.append(td); pr.append(tr)
    }
  } catch (e) { msg("加载失败: " + e.message) }
}
async function initAddForm() {
  if (adapterTypes.length) return
  adapterTypes = (await get("/api/adapter-types")).types || []
  const sel = document.getElementById("f_type"); sel.innerHTML = ""
  for (const t of adapterTypes) { const o = document.createElement("option"); o.value = t; o.textContent = t; sel.append(o) }
  fillTpl()
}
document.getElementById("addBotBtn").addEventListener("click", async () => {
  await initAddForm(); fillTpl()
  document.getElementById("addForm").classList.add("show")
})
document.getElementById("f_type").addEventListener("change", fillTpl)
document.getElementById("f_botId").addEventListener("input", fillTpl)
document.getElementById("addCancel").addEventListener("click", () => document.getElementById("addForm").classList.remove("show"))
document.getElementById("addSubmit").addEventListener("click", async () => {
  let cfg
  try { cfg = JSON.parse(document.getElementById("f_cfg").value) }
  catch (e) { msg("配置不是合法 JSON: " + e.message); return }
  if (!cfg.botId || !cfg.type) { msg("配置必须包含 botId 和 type"); return }
  try {
    await get("/api/bot/add", { cfg })
    msg("已添加机器人 " + cfg.botId, true)
    document.getElementById("addForm").classList.remove("show")
    refresh()
  } catch (e) { msg("添加失败: " + e.message) }
})
refresh(); setInterval(refresh, 3000)
</script>
</body>
</html>`

// 扫描 src/adapter 下已安装的适配器类型（目录名 = type）
function installedAdapterTypes(): string[] {
  const dir = resolve("src/adapter")
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "client.ts")))
    .map((d) => d.name)
}

// 启动 WebUI。返回句柄供优雅关闭。
export function startWebUI(bridge: PluginApiBridge, cfg: WebUIConfig): { close(): void } {
  const host = cfg.host ?? "127.0.0.1"
  const port = cfg.port ?? 8080
  // logo 作为框架静态资源随源码分发（不放在运行态 data 目录，避免被 gitignore）
  const logoPath = resolve("src/assets/logo.png")

  const server = http.createServer(async (req, res) => {
    const url = (req.url ?? "/").split("?")[0]
    const send = (code: number, body: string, type = "application/json") => {
      res.writeHead(code, {
        "Content-Type": type + "; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      })
      res.end(body)
    }
    const readBody = () =>
      new Promise<string>((resolveBody, reject) => {
        let data = ""
        req.on("data", (c) => (data += c))
        req.on("end", () => resolveBody(data))
        req.on("error", reject)
      })

    try {
      if (req.method === "GET" && url === "/") {
        send(200, PAGE, "text/html")
        return
      }
      // logo 图片（存在则返回，前端 onerror 自动隐藏）
      if (req.method === "GET" && url === "/logo") {
        if (existsSync(logoPath)) {
          res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "max-age=86400" })
          res.end(readFileSync(logoPath))
        } else {
          res.writeHead(404); res.end()
        }
        return
      }
      if (req.method === "GET" && url === "/api/status") {
        const [system, bots, plugins] = await Promise.all([
          bridge.getSystemInfo(),
          Promise.resolve(bridge.listBots()),
          Promise.resolve(bridge.listPlugins()),
        ])
        send(200, JSON.stringify({ system, bots, plugins }))
        return
      }
      if (req.method === "GET" && url === "/api/adapter-types") {
        send(200, JSON.stringify({ types: installedAdapterTypes() }))
        return
      }
      if (req.method === "POST" && url === "/api/bot/enable") {
        const { botId, enable } = JSON.parse(await readBody())
        if (typeof botId !== "string") { send(400, JSON.stringify({ error: "缺少 botId" })); return }
        if (enable) await bridge.enableBot(botId)
        else await bridge.disableBot(botId)
        send(200, JSON.stringify({ ok: true }))
        return
      }
      if (req.method === "POST" && url === "/api/bot/add") {
        const { cfg } = JSON.parse(await readBody())
        if (!cfg || typeof cfg.botId !== "string" || typeof cfg.type !== "string") {
          send(400, JSON.stringify({ error: "配置必须包含 botId 和 type" })); return
        }
        await bridge.addBot(cfg)
        send(200, JSON.stringify({ ok: true }))
        return
      }
      if (req.method === "POST" && url === "/api/bot/remove") {
        const { botId } = JSON.parse(await readBody())
        if (typeof botId !== "string") { send(400, JSON.stringify({ error: "缺少 botId" })); return }
        await bridge.removeBot(botId)
        send(200, JSON.stringify({ ok: true }))
        return
      }
      if (req.method === "POST" && url === "/api/plugin/enable") {
        const { name, enable } = JSON.parse(await readBody())
        if (typeof name !== "string") { send(400, JSON.stringify({ error: "缺少 name" })); return }
        if (enable) await bridge.enablePlugin(name)
        else await bridge.disablePlugin(name)
        send(200, JSON.stringify({ ok: true }))
        return
      }
      send(404, JSON.stringify({ error: "Not Found" }))
    } catch (e) {
      send(500, JSON.stringify({ error: (e as Error).message }))
    }
  })

  server.listen(port, host, () => {
    console.log(`[WebUI] 控制台已启动: http://${host}:${port}  （config.json 的 webui 可改端口/开关）`)
  })
  server.on("error", (e) => {
    console.error(`[WebUI] 启动失败: ${(e as Error).message}（config.json 的 webui.port 可换端口）`)
  })

  return {
    close() {
      try { server.close() } catch { /* ignore */ }
    },
  }
}
