<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { scanPlugin, type ScanReport } from '../utils/scan'
import type { PluginInfo } from '../data/builtin-plugins'

const serverPlugins = ref<PluginInfo[]>([])
const loadError = ref('')
const loading = ref(false)

async function loadPlugins() {
  loading.value = true
  loadError.value = ''
  try {
    const res = await fetch('/api/plugins')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    serverPlugins.value = await res.json()
  } catch (e: any) {
    loadError.value = '无法连接插件服务，请先启动 node server.js'
  } finally {
    loading.value = false
  }
}

const allPlugins = computed(() => serverPlugins.value)

const searchQuery = ref('')
const filteredPlugins = computed(() => {
  if (!searchQuery.value.trim()) return allPlugins.value
  const q = searchQuery.value.toLowerCase()
  return allPlugins.value.filter((p) =>
    p.name.toLowerCase().includes(q) ||
    p.description.toLowerCase().includes(q) ||
    p.author.toLowerCase().includes(q) ||
    p.tags.some((t) => t.toLowerCase().includes(q)),
  )
})

const stats = computed(() => ({
  total: allPlugins.value.length,
  low: allPlugins.value.filter((p) => p.report.risk === '低').length,
  mid: allPlugins.value.filter((p) => p.report.risk === '中').length,
  high: allPlugins.value.filter((p) => p.report.risk === '高').length,
}))

const selectedPlugin = ref<PluginInfo | null>(null)
function openDetail(p: PluginInfo) {
  // 点击时动态重新扫描，避免旧缓存 report 不准
  selectedPlugin.value = { ...p, report: scanPlugin(p.source) }
}
function closeDetail() { selectedPlugin.value = null }

const showPublish = ref(false)
const form = ref({
  githubUrl: '',
  name: '', author: '', version: '1.0.0', description: '',
  license: '', tags: '', apis: '', repo: '', source: '',
})
const fetching = ref(false)
const fetchError = ref('')
const scanResult = ref<ScanReport | null>(null)
const autoFilled = ref(false)
let scanTimer: ReturnType<typeof setTimeout> | null = null

// 从源码提取第三方依赖（排除相对路径和框架内部模块）
function extractDependencies(source: string): string[] {
  const deps = new Set<string>()
  const importRe = /(?:import|from)\s+["']([^"']+)["']/g
  let m: RegExpExecArray | null
  while ((m = importRe.exec(source)) !== null) {
    const dep = m[1]
    if (dep.startsWith('.') || dep.startsWith('/') || dep.startsWith('..')) continue
    if (dep.includes('/src/') || dep.startsWith('~/')) continue
    // 只取包名（@scope/pkg 或 pkg）
    const pkg = dep.startsWith('@') ? dep.split('/').slice(0, 2).join('/') : dep.split('/')[0]
    if (pkg) deps.add(pkg)
  }
  return [...deps]
}

// 从源码 definePlugin({...}) 自动识别元数据
function extractPluginMeta(source: string) {
  const r: Record<string, string> = {}
  const m = (re: RegExp) => source.match(re)?.[1]
  const name = m(/name:\s*["']([^"']*)["']/)
  if (name) r.name = name
  const version = m(/version:\s*["']([^"']*)["']/)
  if (version) r.version = version
  const description = m(/description:\s*["']([^"']*)["']/)
  if (description) r.description = description
  const author = m(/author:\s*["']([^"']*)["']/)
  if (author) r.author = author
  const license = m(/license:\s*["']([^"']*)["']/)
  if (license) r.license = license
  const apisMatch = source.match(/apis:\s*\[([^\]]*)\]/)
  if (apisMatch) {
    r.apis = apisMatch[1].split(',').map((s) => s.trim().replace(/["']/g, '')).filter(Boolean).join(', ')
  }
  const tagsMatch = source.match(/(?:tags|keywords):\s*\[([^\]]*)\]/)
  if (tagsMatch) {
    r.tags = tagsMatch[1].split(',').map((s) => s.trim().replace(/["']/g, '')).filter(Boolean).join(', ')
  }
  const repoMatch = source.match(/(?:repo|repository|homepage):\s*["']([^"']*)["']/)
  if (repoMatch) r.repo = repoMatch[1]
  return r
}

// 从 GitHub 仓库拉取插件文件并识别元数据
async function fetchFromGithub() {
  const url = form.value.githubUrl.trim()
  if (!url) { alert('请输入 GitHub 仓库地址'); return }

  const match = url.match(/github\.com\/([^\/\s]+)\/([^\/\s#?]+)/)
  if (!match) { alert('无效的 GitHub 地址，格式：https://github.com/owner/repo'); return }
  const owner = match[1]
  const repo = match[2].replace(/\.git$/, '').replace(/\/+$/, '')

  fetching.value = true
  fetchError.value = ''

  try {
    // 获取仓库信息（默认分支、作者）
    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`)
    if (!repoRes.ok) throw new Error(`仓库访问失败（HTTP ${repoRes.status}），请确认仓库公开且地址正确`)
    const repoData = await repoRes.json()
    const defaultBranch = repoData.default_branch || 'main'
    form.value.repo = repoData.html_url || url
    if (!form.value.author) form.value.author = repoData.owner?.login || owner
    if (!form.value.description && repoData.description) form.value.description = repoData.description

    // 获取文件树
    const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`)
    if (!treeRes.ok) throw new Error(`文件列表获取失败（HTTP ${treeRes.status}）`)
    const treeData = await treeRes.json()
    const files = (treeData.tree || []).filter((f: any) =>
      f.type === 'blob' && /\.(ts|js|mjs|cjs)$/.test(f.path) &&
      !f.path.includes('node_modules') && !f.path.includes('.git') && !f.path.includes('dist/')
    )

    // 逐个拉取文件，找包含 definePlugin 的插件文件
    let pluginSource = ''
    let pluginPath = ''
    for (const f of files) {
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${defaultBranch}/${f.path}`
      try {
        const rawRes = await fetch(rawUrl)
        if (rawRes.ok) {
          const content = await rawRes.text()
          if (content.includes('definePlugin')) {
            pluginSource = content
            pluginPath = f.path
            break
          }
        }
      } catch { /* 跳过单个文件失败 */ }
    }

    if (!pluginSource) throw new Error('未在仓库中找到包含 definePlugin 的插件文件（.ts/.js）')

    form.value.source = pluginSource

    // 自动识别元数据
    const meta = extractPluginMeta(pluginSource)
    if (meta.name) form.value.name = meta.name
    if (meta.version) form.value.version = meta.version
    if (meta.description) form.value.description = meta.description
    if (meta.author) form.value.author = meta.author
    if (meta.license) form.value.license = meta.license
    if (meta.apis) form.value.apis = meta.apis
    if (meta.tags) form.value.tags = meta.tags
    if (meta.repo) form.value.repo = meta.repo

    scanResult.value = scanPlugin(pluginSource)
    autoFilled.value = true
  } catch (e: any) {
    fetchError.value = e.message || '获取失败'
  } finally {
    fetching.value = false
  }
}

function onSourceInput() {
  if (scanTimer) clearTimeout(scanTimer)
  scanTimer = setTimeout(() => {
    if (!form.value.source.trim()) {
      scanResult.value = null
      autoFilled.value = false
      return
    }
    scanResult.value = scanPlugin(form.value.source)
    // 自动从源码识别元数据并填充
    const meta = extractPluginMeta(form.value.source)
    if (meta.name) form.value.name = meta.name
    if (meta.version) form.value.version = meta.version
    if (meta.description) form.value.description = meta.description
    if (meta.author) form.value.author = meta.author
    if (meta.license) form.value.license = meta.license
    if (meta.apis) form.value.apis = meta.apis
    if (meta.tags) form.value.tags = meta.tags
    if (meta.repo) form.value.repo = meta.repo
    autoFilled.value = Object.keys(meta).length > 0
  }, 300)
}

async function submitPlugin() {
  if (!form.value.name.trim() || !form.value.source.trim()) {
    alert('请先获取插件信息（填写 GitHub 地址并点击获取）')
    return
  }
  const plugin = {
    name: form.value.name.trim(),
    version: form.value.version.trim() || '1.0.0',
    author: form.value.author.trim() || '匿名',
    description: form.value.description.trim(),
    license: form.value.license.trim() || 'unknown',
    tags: form.value.tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    repo: form.value.repo.trim(),
    apis: form.value.apis.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    source: form.value.source,
    fileSize: new TextEncoder().encode(form.value.source).length,
    dependencies: extractDependencies(form.value.source),
    report: scanPlugin(form.value.source),
  }
  try {
    const res = await fetch('/api/plugins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(plugin),
    })
    const data = await res.json()
    if (!res.ok) {
      alert('发布失败: ' + (data.error || res.statusText))
      return
    }
    await loadPlugins()
    showPublish.value = false
    form.value = { githubUrl: '', name: '', author: '', version: '1.0.0', description: '', license: '', tags: '', apis: '', repo: '', source: '' }
    scanResult.value = null
    autoFilled.value = false
    fetchError.value = ''
  } catch (e: any) {
    alert('发布失败: ' + e.message + '（请确认 node server.js 已启动）')
  }
}

function riskClass(risk?: string) {
  if (risk === '高') return 'high'
  if (risk === '中') return 'mid'
  return 'low'
}

function formatSize(bytes?: number): string {
  if (!bytes) return '-'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(2) + ' MB'
}

function formatDate(iso?: string): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return d.toLocaleDateString('zh-CN') + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

onMounted(() => {
  loadPlugins()
})
</script>

<template>
  <div class="pc">
    <!-- 工具栏 -->
    <div class="pc-toolbar">
      <div class="pc-search">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input v-model="searchQuery" placeholder="搜索插件名 / 作者 / 描述 / 标签..." />
      </div>
      <button class="pc-btn pc-btn-primary" @click="showPublish = true">发布插件</button>
    </div>

    <!-- 服务状态提示 -->
    <div v-if="loadError" class="pc-server-error">
      <span>{{ loadError }}</span>
      <button class="pc-btn pc-btn-primary" @click="loadPlugins">重试</button>
    </div>

    <!-- 统计 -->
    <div class="pc-stats">
      <span>共 <strong>{{ stats.total }}</strong> 个插件</span>
      <span class="pc-stat-low">低风险 {{ stats.low }}</span>
      <span class="pc-stat-mid">中风险 {{ stats.mid }}</span>
      <span class="pc-stat-high">高风险 {{ stats.high }}</span>
    </div>

    <!-- 插件列表 -->
    <div v-if="filteredPlugins.length" class="pc-grid">
      <div v-for="p in filteredPlugins" :key="p.id" class="pc-card" @click="openDetail(p)">
        <div class="pc-card-head">
          <strong class="pc-card-name">{{ p.name }}</strong>
          <span :class="'pc-badge ' + riskClass(p.report.risk)">{{ p.report.risk }}风险</span>
        </div>
        <p class="pc-card-desc">{{ p.description || '（暂无简介）' }}</p>
        <div class="pc-card-tags">
          <span v-for="t in p.tags" :key="t" class="pc-tag">{{ t }}</span>
        </div>
        <div class="pc-card-meta">
          <span>v{{ p.version }}</span>
          <span>{{ p.author }}</span>
          <span>平台API {{ p.report.callApi.length }}</span>
          <span>代理API {{ p.report.proxyApi.length }}</span>
        </div>
      </div>
    </div>
    <div v-else class="pc-empty">没有找到符合条件的插件</div>

    <!-- 详情弹窗 -->
    <div v-if="selectedPlugin" class="pc-mask" @click.self="closeDetail">
      <div class="pc-modal">
        <button class="pc-close" @click="closeDetail">×</button>
        <div class="pc-detail-head">
          <h2>{{ selectedPlugin.name }}</h2>
          <span :class="'pc-badge ' + riskClass(selectedPlugin.report.risk)">{{ selectedPlugin.report.risk }}风险</span>
        </div>
        <p class="pc-detail-desc">{{ selectedPlugin.description }}</p>

        <div class="pc-info">
          <div><span>版本</span><span>{{ selectedPlugin.version }}</span></div>
          <div><span>作者</span><span>{{ selectedPlugin.author }}</span></div>
          <div><span>协议</span><span>{{ selectedPlugin.license }}</span></div>
          <div><span>标签</span><span>{{ selectedPlugin.tags.join(', ') || '-' }}</span></div>
          <div><span>文件大小</span><span>{{ formatSize(selectedPlugin.fileSize) }}</span></div>
          <div><span>发布时间</span><span>{{ formatDate(selectedPlugin.createdAt) }}</span></div>
          <div><span>第三方依赖</span><span>{{ selectedPlugin.dependencies?.length ? selectedPlugin.dependencies.join(', ') : '（无）' }}</span></div>
          <div><span>开源地址</span><span>{{ selectedPlugin.repo ? selectedPlugin.repo : '-' }}</span></div>
          <div><span>声明 API</span><span>{{ selectedPlugin.apis.join(', ') || '（无）' }}</span></div>
        </div>

        <div class="pc-report">
          <h3>安全检测报告</h3>
          <div :class="'pc-risk-banner ' + riskClass(selectedPlugin.report.risk)">
            <strong>{{ selectedPlugin.report.risk }}风险</strong>
            <span>{{ selectedPlugin.report.note }}</span>
          </div>

          <details open>
            <summary>平台原生 API（bot.callApi）<span class="pc-count">{{ selectedPlugin.report.callApi.length }} 处</span><span class="pc-hint">无需声明</span></summary>
            <table v-if="selectedPlugin.report.callApi.length">
              <thead><tr><th>API 名称</th><th>行号</th><th>代码</th></tr></thead>
              <tbody>
                <tr v-for="(item, i) in selectedPlugin.report.callApi" :key="i">
                  <td>{{ item.action }}<span v-if="item.dynamic" class="pc-dyn">动态调用</span></td>
                  <td class="pc-line">L{{ item.line }}</td>
                  <td class="pc-code">{{ item.code }}</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="pc-none">（无）</p>
          </details>

          <details>
            <summary>代理 API（ctx.api）<span class="pc-count">{{ selectedPlugin.report.proxyApi.length }} 处</span><span class="pc-hint">需在 apis 声明</span></summary>
            <table v-if="selectedPlugin.report.proxyApi.length">
              <thead><tr><th>方法</th><th>行号</th><th>代码</th></tr></thead>
              <tbody>
                <tr v-for="(item, i) in selectedPlugin.report.proxyApi" :key="i">
                  <td>{{ item.method }}</td>
                  <td class="pc-line">L{{ item.line }}</td>
                  <td class="pc-code">{{ item.code }}</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="pc-none">（无）</p>
          </details>

          <details>
            <summary>网络请求<span class="pc-count">{{ selectedPlugin.report.network.length }} 处</span></summary>
            <table v-if="selectedPlugin.report.network.length">
              <thead><tr><th>行号</th><th>代码</th></tr></thead>
              <tbody>
                <tr v-for="(item, i) in selectedPlugin.report.network" :key="i">
                  <td class="pc-line">L{{ item.line }}</td>
                  <td class="pc-code">{{ item.code }}</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="pc-none">（无）</p>
          </details>

          <details>
            <summary>文件操作<span class="pc-count">{{ selectedPlugin.report.filesystem.length }} 处</span></summary>
            <table v-if="selectedPlugin.report.filesystem.length">
              <thead><tr><th>行号</th><th>代码</th></tr></thead>
              <tbody>
                <tr v-for="(item, i) in selectedPlugin.report.filesystem" :key="i">
                  <td class="pc-line">L{{ item.line }}</td>
                  <td class="pc-code">{{ item.code }}</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="pc-none">（无）</p>
          </details>

          <details>
            <summary>危险操作<span class="pc-count">{{ selectedPlugin.report.dangerous.length }} 处</span></summary>
            <table v-if="selectedPlugin.report.dangerous.length">
              <thead><tr><th>行号</th><th>代码</th></tr></thead>
              <tbody>
                <tr v-for="(item, i) in selectedPlugin.report.dangerous" :key="i">
                  <td class="pc-line">L{{ item.line }}</td>
                  <td class="pc-code">{{ item.code }}</td>
                </tr>
              </tbody>
            </table>
            <p v-else class="pc-none">（无）</p>
          </details>

          <details>
            <summary>代理 API 声明对比<span class="pc-count">{{ selectedPlugin.report.undeclaredCallApi.length }} 项未声明</span></summary>
            <div class="pc-perm">
              <p><strong>声明 apis：</strong>{{ selectedPlugin.report.declaredApis.length ? selectedPlugin.report.declaredApis.join(', ') : '（未声明）' }}</p>
              <p><strong>未声明但调用（ctx.api）：</strong>
                <span v-if="selectedPlugin.report.undeclaredCallApi.length">
                  <span v-for="u in selectedPlugin.report.undeclaredCallApi" :key="u" class="pc-undeclared">{{ u }}</span>
                </span>
                <span v-else class="pc-safe">无</span>
              </p>
            </div>
          </details>
        </div>

        <details>
          <summary>插件源码</summary>
          <pre class="pc-source">{{ selectedPlugin.source }}</pre>
        </details>
      </div>
    </div>

    <!-- 发布弹窗 -->
    <div v-if="showPublish" class="pc-mask" @click.self="showPublish = false">
      <div class="pc-modal pc-modal-large">
        <button class="pc-close" @click="showPublish = false">×</button>
        <h2>发布插件</h2>
        <p class="pc-auto-hint">输入 GitHub 仓库地址，自动拉取插件文件并识别元数据</p>

        <!-- GitHub 地址输入 -->
        <div class="pc-github-row">
          <input v-model="form.githubUrl" class="pc-github-input" placeholder="https://github.com/owner/repo" @keyup.enter="fetchFromGithub" />
          <button class="pc-btn pc-btn-primary" :disabled="fetching" @click="fetchFromGithub">
            {{ fetching ? '拉取中...' : '获取插件信息' }}
          </button>
        </div>
        <p v-if="fetchError" class="pc-fetch-error">{{ fetchError }}</p>

        <!-- 获取成功后显示元数据编辑 + 安全扫描 -->
        <div v-if="autoFilled" class="pc-form-grid">
          <div class="pc-form">
            <div class="pc-field">
              <label>插件名称 *</label>
              <input v-model="form.name" placeholder="my_plugin" />
            </div>
            <div class="pc-field-row">
              <div class="pc-field">
                <label>版本</label>
                <input v-model="form.version" />
              </div>
              <div class="pc-field">
                <label>作者</label>
                <input v-model="form.author" placeholder="你的昵称" />
              </div>
            </div>
            <div class="pc-field">
              <label>简介</label>
              <textarea v-model="form.description" rows="2" placeholder="这个插件做什么？"></textarea>
            </div>
            <div class="pc-field-row">
              <div class="pc-field">
                <label>标签（逗号分隔）</label>
                <input v-model="form.tags" placeholder="工具, 娱乐" />
              </div>
              <div class="pc-field">
                <label>开源协议</label>
                <input v-model="form.license" placeholder="GPLv3 / MIT" />
              </div>
            </div>
            <div class="pc-field">
              <label>声明 API（逗号分隔）</label>
              <input v-model="form.apis" placeholder="plugin.list" />
            </div>
            <div class="pc-field">
              <label>开源地址</label>
              <input v-model="form.repo" placeholder="https://github.com/xxx/xxx" />
            </div>
          </div>
          <div class="pc-scan">
            <h3>安全检测报告</h3>
            <div v-if="scanResult" class="pc-report">
              <div :class="'pc-risk-banner ' + riskClass(scanResult.risk)">
                <strong>{{ scanResult.risk }}风险</strong>
                <span>{{ scanResult.note }}</span>
              </div>
              <div class="pc-scan-items">
                <div><span>平台 API</span><strong>{{ scanResult.callApi.length }}</strong></div>
                <div><span>代理 API</span><strong>{{ scanResult.proxyApi.length }}</strong></div>
                <div><span>网络请求</span><strong>{{ scanResult.network.length }}</strong></div>
                <div><span>文件操作</span><strong>{{ scanResult.filesystem.length }}</strong></div>
                <div><span>危险操作</span><strong>{{ scanResult.dangerous.length }}</strong></div>
                <div><span>未声明代理 API</span><strong>{{ scanResult.undeclaredCallApi.length }}</strong></div>
              </div>
              <div v-if="scanResult.proxyApi.length" class="pc-scan-list">
                <p><strong>调用的代理 API（ctx.api）：</strong></p>
                <span v-for="(item, i) in scanResult.proxyApi" :key="i" class="pc-scan-tag">{{ item.method }}</span>
              </div>
            </div>
            <p v-else class="pc-none">获取插件信息后自动生成检测报告</p>
          </div>
        </div>
        <button v-if="autoFilled" class="pc-btn pc-btn-primary pc-submit" @click="submitPlugin">发布到社区</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pc { margin: 16px 0; }

/* 工具栏 */
.pc-toolbar { display: flex; gap: 12px; align-items: center; margin-bottom: 14px; }
.pc-search {
  flex: 1; display: flex; align-items: center; gap: 8px;
  background: var(--vp-c-bg-soft); border: 1px solid var(--vp-c-divider);
  border-radius: 8px; padding: 0 12px; height: 40px; color: var(--vp-c-text-2);
}
.pc-search input {
  border: none; outline: none; background: transparent; width: 100%;
  font-size: 14px; color: var(--vp-c-text-1);
}

/* 按钮 */
.pc-btn {
  border: none; border-radius: 8px; padding: 9px 18px;
  font-size: 14px; font-weight: 600; cursor: pointer;
}
.pc-btn-primary { background: #527dec; color: #fff; }
.pc-btn-primary:hover { background: #395dba; }
.pc-btn-danger { background: var(--vp-c-danger-soft); color: var(--vp-c-danger-1); margin-top: 12px; }

/* 统计 */
.pc-stats { display: flex; gap: 16px; font-size: 13px; color: var(--vp-c-text-2); margin-bottom: 16px; flex-wrap: wrap; }
.pc-stat-low { color: #16a34a; }
.pc-stat-mid { color: #d97706; }
.pc-stat-high { color: #dc2626; }

/* 卡片网格 */
.pc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 14px; }
.pc-card {
  background: var(--vp-c-bg); border: 1px solid var(--vp-c-divider);
  border-radius: 10px; padding: 16px; cursor: pointer;
  transition: border-color 0.15s, transform 0.15s;
  display: flex; flex-direction: column; gap: 8px;
}
.pc-card:hover { border-color: #527dec; transform: translateY(-2px); }
.pc-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.pc-card-name { font-size: 15px; font-weight: 700; }
.pc-card-desc {
  margin: 0; font-size: 13px; color: var(--vp-c-text-2);
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; min-height: 36px;
}
.pc-card-tags { display: flex; gap: 6px; flex-wrap: wrap; }
.pc-tag { font-size: 11px; background: var(--vp-c-bg-soft); color: var(--vp-c-text-2); border-radius: 4px; padding: 1px 7px; }
.pc-card-meta {
  display: flex; gap: 10px; font-size: 12px; color: var(--vp-c-text-3);
  border-top: 1px solid var(--vp-c-divider); padding-top: 8px; margin-top: auto;
}

/* 风险徽章 */
.pc-badge {
  display: inline-flex; align-items: center; font-size: 11px; font-weight: 700;
  border-radius: 999px; padding: 2px 9px; flex-shrink: 0;
}
.pc-badge.low { background: rgba(22,163,74,0.12); color: #16a34a; }
.pc-badge.mid { background: rgba(217,119,6,0.12); color: #d97706; }
.pc-badge.high { background: rgba(220,38,38,0.12); color: #dc2626; }

.pc-empty { text-align: center; padding: 40px; color: var(--vp-c-text-3); }

/* 弹窗 */
.pc-mask {
  position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 100;
  display: flex; align-items: flex-start; justify-content: center; padding: 40px 20px;
  overflow-y: auto;
}
.pc-modal {
  background: var(--vp-c-bg); border-radius: 12px; padding: 24px;
  max-width: 720px; width: 100%; position: relative;
  max-height: calc(100vh - 80px); overflow-y: auto;
}
.pc-modal-large { max-width: 900px; }
.pc-close {
  position: absolute; top: 12px; right: 16px; background: none; border: none;
  font-size: 24px; cursor: pointer; color: var(--vp-c-text-2); line-height: 1;
}
.pc-close:hover { color: var(--vp-c-text-1); }

/* 详情 */
.pc-detail-head { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
.pc-detail-head h2 { margin: 0; font-size: 20px; }
.pc-detail-desc { color: var(--vp-c-text-2); font-size: 14px; margin: 0 0 16px; }

.pc-info {
  display: grid; grid-template-columns: 1fr 1fr; gap: 0;
  border: 1px solid var(--vp-c-divider); border-radius: 8px; overflow: hidden;
  margin-bottom: 20px;
}
.pc-info > div {
  display: flex; justify-content: space-between; padding: 8px 12px;
  border-bottom: 1px solid var(--vp-c-divider); font-size: 13px;
}
.pc-info > div:nth-child(odd) { border-right: 1px solid var(--vp-c-divider); }
.pc-info > div span:first-child { color: var(--vp-c-text-2); }
.pc-info > div span:last-child { text-align: right; word-break: break-all; max-width: 60%; }

/* 安全报告 */
.pc-report h3 { font-size: 16px; margin: 0 0 12px; }
.pc-risk-banner {
  border-radius: 8px; padding: 12px 14px; margin-bottom: 14px;
  display: flex; flex-direction: column; gap: 4px;
}
.pc-risk-banner.low { background: rgba(22,163,74,0.1); color: #16a34a; }
.pc-risk-banner.mid { background: rgba(217,119,6,0.1); color: #d97706; }
.pc-risk-banner.high { background: rgba(220,38,38,0.1); color: #dc2626; }
.pc-risk-banner span { font-size: 13px; opacity: 0.9; }

.pc-report details {
  border: 1px solid var(--vp-c-divider); border-radius: 8px;
  margin-bottom: 8px; overflow: hidden;
}
.pc-report summary {
  padding: 10px 14px; cursor: pointer; font-weight: 600; font-size: 14px;
  display: flex; align-items: center; user-select: none;
}
.pc-report summary:hover { background: var(--vp-c-bg-soft); }
.pc-count { margin-left: auto; font-size: 12px; color: var(--vp-c-text-2); font-weight: 500; }
.pc-hint { margin-left: 8px; font-size: 11px; color: var(--vp-c-text-3); font-weight: 400; }
.pc-auto-hint { font-size: 13px; color: #16a34a; margin: 0 0 14px; }
.pc-github-row { display: flex; gap: 10px; margin-bottom: 10px; }
.pc-github-input {
  flex: 1; border: 1px solid var(--vp-c-divider); border-radius: 8px;
  padding: 0 14px; font-size: 14px; font-family: inherit;
  background: var(--vp-c-bg); color: var(--vp-c-text-1); outline: none; height: 42px;
}
.pc-github-input:focus { border-color: #527dec; }
.pc-fetch-error { color: #dc2626; font-size: 13px; margin: 0 0 14px; }
.pc-server-error {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  background: rgba(220,38,38,0.08); border: 1px solid rgba(220,38,38,0.3);
  border-radius: 8px; padding: 12px 16px; margin-bottom: 14px;
  font-size: 14px; color: #dc2626;
}
.pc-report .body, .pc-report table, .pc-report .pc-none, .pc-report .pc-perm { padding: 0 14px 12px; }

.pc-report table { width: 100%; border-collapse: collapse; font-size: 13px; }
.pc-report th, .pc-report td {
  text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--vp-c-divider); vertical-align: top;
}
.pc-report th { color: var(--vp-c-text-2); font-weight: 600; white-space: nowrap; }
.pc-code { font-family: Consolas, monospace; font-size: 12px; color: var(--vp-c-text-2); word-break: break-all; }
.pc-line { white-space: nowrap; color: var(--vp-c-text-3); }
.pc-dyn { color: #d97706; font-size: 11px; margin-left: 6px; font-weight: 600; }
.pc-none { color: var(--vp-c-text-3); font-size: 13px; padding: 8px 14px 12px; }
.pc-perm p { margin: 6px 0; font-size: 13px; }
.pc-undeclared {
  background: rgba(220,38,38,0.1); color: #dc2626; border-radius: 4px;
  padding: 1px 6px; font-size: 12px; font-weight: 600; margin-right: 4px;
}
.pc-safe { color: #16a34a; font-weight: 600; }

.pc-source {
  background: #292d3e; color: #bfc7d5; border-radius: 8px; padding: 14px;
  font-family: Consolas, monospace; font-size: 12px; line-height: 1.6;
  overflow-x: auto; max-height: 400px; overflow-y: auto; white-space: pre;
  margin: 8px 14px 12px;
}

/* 发布表单 */
.pc-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
@media (max-width: 768px) { .pc-form-grid { grid-template-columns: 1fr; } }
.pc-field { margin-bottom: 12px; }
.pc-field label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px; color: var(--vp-c-text-2); }
.pc-field input, .pc-field textarea {
  width: 100%; border: 1px solid var(--vp-c-divider); border-radius: 6px;
  padding: 8px 10px; font-size: 13px; font-family: inherit;
  background: var(--vp-c-bg); color: var(--vp-c-text-1); outline: none;
}
.pc-field input:focus, .pc-field textarea:focus { border-color: #527dec; }
.pc-field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.pc-source-input { font-family: Consolas, monospace; font-size: 12px; resize: vertical; }

.pc-scan h3 { font-size: 15px; margin: 0 0 12px; }
.pc-scan-items {
  display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-bottom: 14px;
}
.pc-scan-items > div {
  background: var(--vp-c-bg-soft); border-radius: 6px; padding: 8px 10px;
  display: flex; flex-direction: column; gap: 2px;
}
.pc-scan-items span { font-size: 11px; color: var(--vp-c-text-2); }
.pc-scan-items strong { font-size: 18px; }
.pc-scan-list p { margin: 0 0 6px; font-size: 13px; }
.pc-scan-tag {
  display: inline-block; background: var(--vp-c-bg-soft); border-radius: 4px;
  padding: 2px 8px; font-size: 12px; margin: 0 4px 4px 0;
}
.pc-submit { width: 100%; margin-top: 16px; }
</style>
