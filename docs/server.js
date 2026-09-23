// VanBotJS 文档 + 插件社区服务
// 零依赖，原生 http 模块。同时提供静态页面和插件 API。
// 插件数据存储在 data/plugins.json，手动编辑/删除该文件即可管理插件。
// 用法：node server.js （默认端口 3000，可用 PORT=xxxx 覆盖）

import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 3000
const DATA_FILE = path.join(__dirname, 'data', 'plugins.json')
const ADAPTERS_DATA_FILE = path.join(__dirname, 'data', 'adapters.json')
const ADAPTERS_DIR = path.join(__dirname, 'data', 'adapters')
const DIST_DIR = path.join(__dirname, '.vitepress', 'dist')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
}

function ensureDataFile() {
  const dir = path.dirname(DATA_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf8')
}

function readPlugins() {
  ensureDataFile()
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

function writePlugins(plugins) {
  ensureDataFile()
  fs.writeFileSync(DATA_FILE, JSON.stringify(plugins, null, 2), 'utf8')
}

function ensureAdaptersData() {
  const dir = path.dirname(ADAPTERS_DATA_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  if (!fs.existsSync(ADAPTERS_DATA_FILE)) fs.writeFileSync(ADAPTERS_DATA_FILE, '[]', 'utf8')
}

function readAdapters() {
  ensureAdaptersData()
  try {
    const data = JSON.parse(fs.readFileSync(ADAPTERS_DATA_FILE, 'utf8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

// 适配器源文件安全读取（防路径穿越）
function adapterRawPath(name, file) {
  if (!/^[\w-]+$/.test(name) || !/^[\w./-]+$/.test(file)) return null
  const dir = path.join(ADAPTERS_DIR, name)
  const filePath = path.join(dir, file)
  if (!filePath.startsWith(dir + path.sep)) return null
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null
  return filePath
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0])
  if (urlPath === '/') urlPath = '/index.html'

  const filePath = path.join(DIST_DIR, urlPath)
  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase()
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
    fs.createReadStream(filePath).pipe(res)
  } else {
    // SPA fallback
    const indexPath = path.join(DIST_DIR, 'index.html')
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      fs.createReadStream(indexPath).pipe(res)
    } else {
      res.writeHead(404); res.end('Not Found. 请先运行 npx vitepress build 构建文档。')
    }
  }
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return
  }

  // GET /api/plugins — 获取插件列表
  if (req.url === '/api/plugins' && req.method === 'GET') {
    sendJson(res, 200, readPlugins())
    return
  }

  // POST /api/plugins — 发布插件
  if (req.url === '/api/plugins' && req.method === 'POST') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      try {
        const plugin = JSON.parse(body)
        if (!plugin.name || !plugin.source) {
          sendJson(res, 400, { error: '缺少 name 或 source 字段' })
          return
        }
        const plugins = readPlugins()
        // 同名同版本拒绝重复发布
        if (plugins.some((p) => p.name === plugin.name && p.version === plugin.version)) {
          sendJson(res, 409, { error: `插件 ${plugin.name} v${plugin.version} 已存在` })
          return
        }
        plugin.id = 'plugin-' + Date.now()
        plugin.createdAt = plugin.createdAt || new Date().toISOString()
        plugins.push(plugin)
        writePlugins(plugins)
        sendJson(res, 201, { success: true, id: plugin.id, total: plugins.length })
      } catch (e) {
        sendJson(res, 400, { error: 'JSON 解析失败: ' + e.message })
      }
    })
    return
  }

  // GET /api/adapters — 获取适配器清单（van adapter list / install 使用）
  if (req.url === '/api/adapters' && req.method === 'GET') {
    sendJson(res, 200, readAdapters())
    return
  }

  // GET /api/adapters/<name>/raw?file=xxx — 获取适配器源文件内容
  const rawMatch = req.url.match(/^\/api\/adapters\/([^/?]+)\/raw(?:\?|$)/)
  if (rawMatch && req.method === 'GET') {
    const name = decodeURIComponent(rawMatch[1])
    const search = new URL(req.url, 'http://localhost').searchParams
    const file = search.get('file') || ''
    const fp = adapterRawPath(name, file)
    if (!fp) { sendJson(res, 404, { error: '文件不存在' }); return }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    fs.createReadStream(fp).pipe(res)
    return
  }

  // 静态文件
  serveStatic(req, res)
})

server.listen(PORT, () => {
  console.log('========================================')
  console.log('  VanBotJS 文档 + 插件社区服务已启动')
  console.log(`  访问地址: http://localhost:${PORT}`)
  console.log(`  插件数据: ${DATA_FILE}`)
  console.log(`  适配器数据: ${ADAPTERS_DATA_FILE}`)
  console.log('  管理插件: 手动编辑/删除 data/plugins.json')
  console.log('========================================')
})
