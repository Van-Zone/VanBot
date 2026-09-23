#!/usr/bin/env node
//
// VanBotJS CLI
//
// 用法：
//   van run                        运行框架（等价 npm run dev）
//   van adapter list               列出已安装 / 社区可安装的适配器
//   van adapter install <名称|序号> 从社区安装适配器（自动装依赖）
//   van adapter remove <名称>       移除本地适配器目录
//   van adapter info <名称>         查看适配器详情
//   van plugin list                列出已安装 / 社区可安装的插件
//   van plugin install <名称|序号>  从社区安装插件
//   van plugin remove <名称>        移除本地插件
//   van plugin info <名称>          查看插件详情
//   van                             无参数：进入交互式主菜单
//   van -h / --help                 查看帮助
//   van -v / --version              查看版本
//
// 社区源配置（config.json 顶层，完整清单 URL）：
//   "adapterApi": "https://bot.ziyi.asia/api/adapters"
//   "pluginApi":  "https://bot.ziyi.asia/api/plugins"
//
import { createRequire } from "module"
import { spawn, execSync } from "child_process"
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "fs"
import { resolve, join } from "path"
import { fileURLToPath } from "url"
import readline from "readline"

const require = createRequire(import.meta.url)
const __dirname = fileURLToPath(new URL(".", import.meta.url))
const ROOT = resolve(__dirname, "..")
const CONFIG_PATH = join(ROOT, "config.json")
const ADAPTER_DIR = join(ROOT, "src", "adapter")
const PLUGIN_DIR = join(ROOT, "plugin")

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))

//
// 终端彩色输出（Windows 兼容）
//
const useColor = process.stdout.isTTY && process.platform !== "win32"
function color(code, s) {
  return useColor ? `\x1b[${code}m${s}\x1b[0m` : s
}
const cBold = (s) => color(1, s)
const cDim = (s) => color(2, s)
const cGreen = (s) => color(32, s)
const cCyan = (s) => color(36, s)
const cYellow = (s) => color(33, s)
const cRed = (s) => color(31, s)

//
// 读取 config.json 的社区源配置
//
function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error(cRed("未找到 config.json:") + ` ${CONFIG_PATH}`)
    process.exit(1)
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"))
}

function apiField(name) {
  const cfg = loadConfig()
  if (!cfg[name]) {
    console.error(
      cRed(`config.json 未配置 ${name}。`) +
        `\n  请在 config.json 顶层添加，例如: "${name}": "https://bot.ziyi.asia/api/xxx"`,
    )
    process.exit(1)
  }
  return cfg[name].replace(/\/+$/, "")
}

const adapterApi = () => apiField("adapterApi")
const pluginApi = () => apiField("pluginApi")

// 本机已安装的适配器（src/adapter 下的目录）
function installedAdapters() {
  if (!existsSync(ADAPTER_DIR)) return []
  return readdirSync(ADAPTER_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(ADAPTER_DIR, d.name, "client.ts")))
    .map((d) => d.name)
}

// 本机已安装的插件（plugin 下的 *.ts，下划线开头视为禁用不加载）
function installedPlugins() {
  if (!existsSync(PLUGIN_DIR)) return []
  return readdirSync(PLUGIN_DIR)
    .filter((f) => f.endsWith(".ts") && !f.startsWith("_"))
    .map((f) => f.slice(0, -3))
}

// 从社区拉取清单
async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "VanBotJS-CLI" },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return JSON.parse(await res.text())
}

async function fetchAdapterList() {
  const list = await fetchJson(adapterApi())
  if (!Array.isArray(list)) throw new Error("社区返回的不是适配器清单")
  return list
}

async function fetchPluginList() {
  const list = await fetchJson(pluginApi())
  if (!Array.isArray(list)) throw new Error("社区返回的不是插件清单")
  return list
}

//
// 运行框架
//
function cmdRun() {
  const tsxCli = require.resolve("tsx/cli")
  console.log(cCyan("VanBotJS 启动中..."))
  console.log(cDim("  使用 tsx 运行 src/index.ts\n"))
  const child = spawn(process.execPath, [tsxCli, "src/index.ts"], {
    cwd: ROOT,
    stdio: "inherit",
  })
  child.on("exit", (code) => {
    process.exit(code ?? 0)
  })
}

//
// 适配器列表
//
async function cmdAdapterList() {
  const installed = new Set(installedAdapters())
  console.log(cBold("\nVanBotJS 适配器列表\n"))
  let rows = []
  let err = ""
  try {
    rows = (await fetchAdapterList()).map((a, i) => {
      const has = installed.has(a.name)
      const mark = has ? cGreen("● 已安装") : cDim("○ 未安装")
      const deps = a.dependencies?.length ? cDim(" deps:" + a.dependencies.join(",")) : ""
      return `  ${String(i + 1).padEnd(3)} ${cCyan(a.name.padEnd(16))} ${mark}  ${cDim(a.description || "")}${deps}`
    })
  } catch (e) {
    err = cDim("  (社区源不可达: " + e.message + ")")
  }
  console.log(rows.length ? rows.join("\n") : cDim("  （社区清单为空或不可达）"))
  if (err) console.log(err)
  const localOnly = [...installed].filter((n) => !rows.some((r) => r.includes(` ${n.padEnd(16)} `)))
  if (localOnly.length) console.log("\n" + cDim("  本机已装但不在社区: " + localOnly.join(", ")))
  console.log(cDim("\n安装: van adapter install <名称|序号>   详情: van adapter info <名称>"))
  console.log(cDim("社区源: " + adapterApi()))
}

//
// 适配器安装
//
async function cmdAdapterInstall(nameArg) {
  const installed = new Set(installedAdapters())
  let list
  try {
    list = await fetchAdapterList()
  } catch (e) {
    console.error(cRed(`社区源不可达: ${e.message}`))
    console.error(cDim(`  请检查 config.json 的 adapterApi 配置。`))
    process.exit(1)
  }
  const pick = (l) => (/^\d+$/.test(nameArg) ? l[parseInt(nameArg, 10) - 1] : l.find((a) => a.name === nameArg))
  const target = pick(list)
  if (!target) {
    console.error(cRed(`未找到适配器 "${nameArg}"，请先运行 van adapter list 查看`))
    process.exit(1)
  }
  if (installed.has(target.name)) {
    console.log(cYellow(`适配器 ${target.name} 已安装（src/adapter/${target.name}/）`))
    return
  }
  const base = adapterApi()
  const dest = join(ADAPTER_DIR, target.name)
  mkdirSync(dest, { recursive: true })
  // package.json 为适配器依赖清单，默认一并落地，便于离线查看依赖与二次分发
  const files = target.files?.length ? target.files : ["package.json", "client.ts", "converter.ts", "types.ts"]
  console.log(cCyan(`正在从社区安装适配器 ${target.name} ...`))
  let ok = 0
  for (const f of files) {
    const url = `${base}/${target.name}/raw?file=${encodeURIComponent(f)}`
    try {
      const text = await (await fetch(url, {
        headers: { "User-Agent": "VanBotJS-CLI" },
        signal: AbortSignal.timeout(30000),
      })).text()
      writeFileSync(join(dest, f), text, "utf8")
      console.log(cGreen(`  [OK] ${f}`))
      ok++
    } catch (e) {
      console.error(cRed(`  [失败] ${f}: ${e.message}`))
    }
  }
  // 依赖优先取社区清单；社区未声明时回退读适配器自带 package.json
  let deps = target.dependencies || []
  if (!deps.length) {
    const localManifest = join(dest, "package.json")
    if (existsSync(localManifest)) {
      try {
        deps = Object.keys(JSON.parse(readFileSync(localManifest, "utf8")).dependencies || {})
      } catch {
        // 清单损坏时忽略，按无依赖处理
      }
    }
  }
  if (deps.length) {
    console.log(cCyan(`安装依赖: ${deps.join(", ")} ...`))
    try {
      execSync(`npm install ${deps.join(" ")} --no-audit --no-fund`, { cwd: ROOT, stdio: "inherit" })
      console.log(cGreen("依赖安装完成"))
    } catch (e) {
      console.error(cRed(`依赖安装失败: ${e.message}`))
    }
  }
  if (ok) {
    console.log(cGreen(`适配器 ${target.name} 已安装到 src/adapter/${target.name}/`))
    console.log(cDim("   修改 config.json 添加对应 bot 配置后重启即可生效。"))
  } else {
    console.error(cRed(`适配器 ${target.name} 文件均下载失败，请检查网络或社区源`))
  }
}

//
// 移除本地适配器目录
//
async function cmdAdapterRemove(nameArg) {
  const dest = join(ADAPTER_DIR, nameArg)
  if (!existsSync(dest)) {
    console.error(cRed(`适配器 ${nameArg} 不存在（${dest}）`))
    process.exit(1)
  }
  const ans = await ask(`确认删除适配器 ${nameArg}（目录: ${dest}）？(y/N): `)
  if (ans !== "y" && ans !== "Y") {
    console.log(cDim("已取消删除"))
    return
  }
  rmSync(dest, { recursive: true, force: true })
  console.log(cGreen(`已移除适配器 ${nameArg}（目录: ${dest}）`))
  console.log(cDim("   若 config.json 中仍引用该 type，重启后对应 bot 会提示未安装。"))
}

//
// 适配器详情
//
async function cmdAdapterInfo(nameArg) {
  const dest = join(ADAPTER_DIR, nameArg)
  const installed = existsSync(dest)
  const files = installed
    ? readdirSync(dest, { withFileTypes: true }).filter((f) => f.isFile()).map((f) => f.name)
    : []
  console.log(cBold("\n适配器详情\n"))
  console.log(`  名称:       ${cCyan(nameArg)}`)
  console.log(`  状态:       ${installed ? cGreen("● 已安装") : cDim("○ 未安装")}`)
  console.log(`  本地路径:   ${dest}`)
  try {
    const item = (await fetchAdapterList()).find((a) => a.name === nameArg)
    if (item) {
      console.log(`  描述:       ${item.description ?? ""}`)
      console.log(`  版本:       ${item.version ?? "-"}`)
      console.log(`  依赖:       ${item.dependencies?.length ? item.dependencies.join(", ") : "无"}`)
      console.log(`  下载文件:   ${(item.files?.length ? item.files : ["package.json", "client.ts", "converter.ts", "types.ts"]).join(", ")}`)
    }
  } catch (e) {
    console.log(`  描述:       ${cDim("（社区不可达: " + e.message + "）")}`)
  }
  // 本地已安装：读适配器自带 package.json，展示其声明依赖
  const localManifestPath = join(dest, "package.json")
  if (installed && existsSync(localManifestPath)) {
    try {
      const m = JSON.parse(readFileSync(localManifestPath, "utf8"))
      const names = Object.keys(m.dependencies || {})
      if (names.length) console.log(`  本地依赖:   ${names.join(", ")}`)
    } catch {
      // 清单损坏忽略
    }
  }
  if (files.length) console.log(`  本地文件:   ${files.join(", ")}`)
  console.log("")
  console.log(cDim(`  社区源: ${adapterApi()}`))
  console.log(cDim("  安装: van adapter install <名称|序号>"))
  console.log("")
}

//
// 插件列表
//
async function cmdPluginList() {
  const installed = new Set(installedPlugins())
  console.log(cBold("\nVanBotJS 插件列表\n"))
  let rows = []
  let err = ""
  try {
    rows = (await fetchPluginList()).map((p, i) => {
      const has = installed.has(p.name)
      const mark = has ? cGreen("● 已安装") : cDim("○ 未安装")
      const extra = p.author ? `  ${cDim("by " + p.author)}` : ""
      return `  ${String(i + 1).padEnd(3)} ${cCyan(p.name.padEnd(16))} ${mark}  ${cDim(p.description || "")}${extra}`
    })
  } catch (e) {
    err = cDim("  (社区源不可达: " + e.message + ")")
  }
  console.log(rows.length ? rows.join("\n") : cDim("  （社区清单为空或不可达）"))
  if (err) console.log(err)
  const localOnly = [...installed].filter((n) => !rows.some((r) => r.includes(` ${n.padEnd(16)} `)))
  if (localOnly.length) console.log("\n" + cDim("  本机已装但不在社区: " + localOnly.join(", ")))
  console.log(cDim("\n安装: van plugin install <名称|序号>   详情: van plugin info <名称>"))
  console.log(cDim("社区源: " + pluginApi()))
}

//
// 插件安装（source 内嵌于清单，写入 plugin/<name>.ts）
//
async function cmdPluginInstall(nameArg) {
  const installed = new Set(installedPlugins())
  let list
  try {
    list = await fetchPluginList()
  } catch (e) {
    console.error(cRed(`社区源不可达: ${e.message}`))
    console.error(cDim(`  请检查 config.json 的 pluginApi 配置。`))
    process.exit(1)
  }
  const pick = (l) => (/^\d+$/.test(nameArg) ? l[parseInt(nameArg, 10) - 1] : l.find((p) => p.name === nameArg))
  const target = pick(list)
  if (!target) {
    console.error(cRed(`未找到插件 "${nameArg}"，请先运行 van plugin list 查看`))
    process.exit(1)
  }
  if (installed.has(target.name)) {
    console.log(cYellow(`插件 ${target.name} 已安装（plugin/${target.name}.ts）`))
    return
  }
  if (!target.source) {
    console.error(cRed(`插件 ${target.name} 缺少源码（source 为空）`))
    process.exit(1)
  }
  if (!existsSync(PLUGIN_DIR)) mkdirSync(PLUGIN_DIR, { recursive: true })
  writeFileSync(join(PLUGIN_DIR, target.name + ".ts"), target.source, "utf8")
  console.log(cGreen(`插件 ${target.name} v${target.version || "-"} 已安装到 plugin/${target.name}.ts`))
  console.log(cDim("   在 config.json 的 plugins 中添加启用配置后生效，例如:"))
  console.log(cDim(`   "plugins": { "${target.name}": true }`))
  console.log(cDim("   框架已开启热重载时，保存 config.json 后自动加载。"))
}

//
// 移除本地插件
//
async function cmdPluginRemove(nameArg) {
  const dest = join(PLUGIN_DIR, nameArg + ".ts")
  if (!existsSync(dest)) {
    console.error(cRed(`插件 ${nameArg} 不存在（${dest}）`))
    process.exit(1)
  }
  const ans = await ask(`确认删除插件 ${nameArg}（文件: ${dest}）？(y/N): `)
  if (ans !== "y" && ans !== "Y") {
    console.log(cDim("已取消删除"))
    return
  }
  rmSync(dest, { force: true })
  console.log(cGreen(`已移除插件 ${nameArg}（文件: ${dest}）`))
  console.log(cDim("   若 config.json 的 plugins 中仍引用该插件名，重启后会自动跳过。"))
}

//
// 插件详情
//
async function cmdPluginInfo(nameArg) {
  const dest = join(PLUGIN_DIR, nameArg + ".ts")
  const installed = existsSync(dest)
  console.log(cBold("\n插件详情\n"))
  console.log(`  名称:       ${cCyan(nameArg)}`)
  console.log(`  状态:       ${installed ? cGreen("● 已安装") : cDim("○ 未安装")}`)
  console.log(`  本地路径:   ${dest}`)
  try {
    const item = (await fetchPluginList()).find((p) => p.name === nameArg)
    if (item) {
      console.log(`  描述:       ${item.description ?? ""}`)
      console.log(`  版本:       ${item.version ?? "-"}`)
      if (item.author) console.log(`  作者:       ${item.author}`)
      if (item.license) console.log(`  协议:       ${item.license}`)
      if (item.tags?.length) console.log(`  标签:       ${item.tags.join(", ")}`)
      if (item.repo) console.log(`  仓库:       ${item.repo}`)
      if (item.apis?.length) console.log(`  声明 API:   ${item.apis.join(", ")}`)
    }
  } catch (e) {
    console.log(`  描述:       ${cDim("（社区不可达: " + e.message + "）")}`)
  }
  console.log("")
  console.log(cDim(`  社区源: ${pluginApi()}`))
  console.log(cDim("  安装: van plugin install <名称|序号>"))
  console.log("")
}

//
// 交互式主菜单
//
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => rl.question(question, (ans) => {
    rl.close()
    resolve(ans.trim())
  }))
}

async function cmdMenu() {
  console.log(cBold("\nVanBotJS 控制台\n"))
  console.log("  1. " + cCyan("运行框架") + cDim("（van run）"))
  console.log("  2. " + cCyan("查看适配器列表") + cDim("（van adapter list）"))
  console.log("  3. " + cCyan("查看适配器详情") + cDim("（van adapter info <名称>）"))
  console.log("  4. " + cCyan("安装适配器") + cDim("（van adapter install <名称|序号>）"))
  console.log("  5. " + cCyan("移除适配器") + cDim("（van adapter remove <名称>）"))
  console.log("  6. " + cCyan("查看插件列表") + cDim("（van plugin list）"))
  console.log("  7. " + cCyan("安装插件") + cDim("（van plugin install <名称|序号>）"))
  console.log("  8. " + cCyan("移除插件") + cDim("（van plugin remove <名称>）"))
  console.log("  9. " + cCyan("查看帮助") + cDim("（van -h）"))
  console.log("  10. " + cCyan("查看版本") + cDim("（van -v）"))
  console.log("  11. " + cCyan("退出"))
  console.log("")
  const ans = await ask("请选择操作 (1-11): ")
  if (ans === "1") return cmdRun()
  if (ans === "2") { await cmdAdapterList(); return cmdMenu() }
  if (ans === "3") { await cmdAdapterInfo(await ask("请输入适配器名称: ")); return cmdMenu() }
  if (ans === "4") { await cmdAdapterInstall(await ask("请输入要安装的适配器名称或序号: ")); return cmdMenu() }
  if (ans === "5") { await cmdAdapterRemove(await ask("请输入要移除的适配器名称: ")); return cmdMenu() }
  if (ans === "6") { await cmdPluginList(); return cmdMenu() }
  if (ans === "7") { await cmdPluginInstall(await ask("请输入要安装的插件名称或序号: ")); return cmdMenu() }
  if (ans === "8") { await cmdPluginRemove(await ask("请输入要移除的插件名称: ")); return cmdMenu() }
  if (ans === "9") { showHelp(); return cmdMenu() }
  if (ans === "10") { console.log(pkg.version); return cmdMenu() }
  console.log("已退出")
}

function showHelp() {
  console.log(`
${cBold("VanBotJS CLI")} ${pkg.version} —— 多平台机器人框架

${cBold("用法:")}
  ${cCyan("van run")}                  运行框架（等价 npm run dev）
  ${cCyan("van")}                      进入交互式主菜单（大目录）
  ${cCyan("van adapter list")}         列出已安装 / 社区可安装的适配器
  ${cCyan("van adapter info <名称>")}   查看适配器详情
  ${cCyan("van adapter install <名称|序号>")}   从社区安装适配器（自动装依赖）
  ${cCyan("van adapter remove <名称>")}         移除本地适配器目录
  ${cCyan("van plugin list")}          列出已安装 / 社区可安装的插件
  ${cCyan("van plugin info <名称>")}    查看插件详情
  ${cCyan("van plugin install <名称|序号>")}    从社区安装插件
  ${cCyan("van plugin remove <名称>")}          移除本地插件
  ${cCyan("van -h / --help")}          查看帮助
  ${cCyan("van -v / --version")}       查看版本

${cBold("社区源配置:")}
  在 config.json 顶层设置（完整清单 URL）:
  ${cCyan('"adapterApi": "https://bot.ziyi.asia/api/adapters"')}
  ${cCyan('"pluginApi": "https://bot.ziyi.asia/api/plugins"')}

${cBold("示例:")}
  van run                          # 启动机器人
  van adapter install minecraft    # 安装 Minecraft 适配器
  van plugin install keyword       # 安装 keyword 插件
`)
}

async function main() {
  const args = process.argv.slice(2)
  const first = args[0]

  if (first === "-h" || first === "--help" || first === "help") {
    showHelp()
    return
  }
  if (first === "-v" || first === "--version" || first === "version") {
    console.log(pkg.version)
    return
  }
  if (first === "run") {
    cmdRun()
    return
  }
  if (first === "adapter") {
    const sub = args[1]
    if (sub === "list") return await cmdAdapterList()
    if (sub === "install") {
      if (!args[2]) { console.error(cRed("用法: van adapter install <名称|序号>")); process.exit(1) }
      return await cmdAdapterInstall(args[2])
    }
    if (sub === "remove") {
      if (!args[2]) { console.error(cRed("用法: van adapter remove <名称>")); process.exit(1) }
      return await cmdAdapterRemove(args[2])
    }
    if (sub === "info") {
      if (!args[2]) { console.error(cRed("用法: van adapter info <名称>")); process.exit(1) }
      return await cmdAdapterInfo(args[2])
    }
    console.error(cRed(`未知子命令: ${sub ?? ""}`))
    showHelp()
    return
  }
  if (first === "plugin") {
    const sub = args[1]
    if (sub === "list") return await cmdPluginList()
    if (sub === "install") {
      if (!args[2]) { console.error(cRed("用法: van plugin install <名称|序号>")); process.exit(1) }
      return await cmdPluginInstall(args[2])
    }
    if (sub === "remove") {
      if (!args[2]) { console.error(cRed("用法: van plugin remove <名称>")); process.exit(1) }
      return await cmdPluginRemove(args[2])
    }
    if (sub === "info") {
      if (!args[2]) { console.error(cRed("用法: van plugin info <名称>")); process.exit(1) }
      return await cmdPluginInfo(args[2])
    }
    console.error(cRed(`未知子命令: ${sub ?? ""}`))
    showHelp()
    return
  }
  if (first) {
    console.error(cRed(`未知命令: ${first}`))
    showHelp()
    return
  }
  await cmdMenu()
}

main().catch((e) => {
  console.error(cRed("CLI 错误:"), e)
  process.exit(1)
})
