// 插件安全扫描（前端纯文本分析，不执行代码）
// 从 community-web/scan.js 移植，逻辑一致

export interface ScanItem {
  action?: string
  method?: string
  line: number
  code: string
  dynamic?: boolean
}

export interface ScanReport {
  callApi: ScanItem[]
  proxyApi: ScanItem[]
  network: ScanItem[]
  filesystem: ScanItem[]
  dangerous: ScanItem[]
  declaredApis: string[]
  undeclaredCallApi: string[]
  hasDeclarations: boolean
  risk: '低' | '中' | '高'
  note: string
}

function extractDeclaredApis(code: string): { has: boolean; apis: string[] } {
  const m = code.match(/apis\s*:\s*\[([^\]]*)\]/)
  if (!m) return { has: false, apis: [] }
  const apis = m[1]
    .split(',')
    .map((s) => s.trim().replace(/['"`]/g, ''))
    .filter(Boolean)
  return { has: true, apis }
}

// 数组/对象/Promise 常用方法名（这些不是代理 API，需过滤）
const NATIVE_METHODS = new Set([
  'map', 'filter', 'forEach', 'reduce', 'reduceRight', 'find', 'findIndex',
  'some', 'every', 'includes', 'indexOf', 'lastIndexOf', 'push', 'pop',
  'shift', 'unshift', 'slice', 'splice', 'concat', 'join', 'reverse',
  'sort', 'flat', 'flatMap', 'keys', 'values', 'entries', 'from', 'of',
  'toString', 'valueOf', 'constructor', 'hasOwnProperty', 'isPrototypeOf',
  'propertyIsEnumerable', 'toLocaleString', 'then', 'catch', 'finally',
  'bind', 'call', 'apply', 'toString', 'length', 'name',
])

function scanLine(line: string, lineNo: number, report: ScanReport, proxyAliases: Set<string>) {
  const codeStr = line.trim().slice(0, 100)
  if (!line.trim()) return

  // callApi
  const callApiRe = /(?:\.callApi|callApi)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = callApiRe.exec(line)) !== null) {
    const rest = line.slice(m.index + m[0].length)
    const strMatch = rest.match(/^\s*(['"`])(.*?)\1/)
    if (strMatch) {
      report.callApi.push({ action: strMatch[2], line: lineNo, code: codeStr, dynamic: false })
    } else {
      report.callApi.push({ action: '(动态调用)', line: lineNo, code: codeStr, dynamic: true })
    }
  }

  // 代理 API：ctx.api.xxx() / this.api.xxx() / 别名变量.xxx()（如 const api = ctx.api）
  const prefixes = ['ctx.api', 'this.api', ...proxyAliases]
  for (const prefix of prefixes) {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(?:^|[^.\\w$])${escaped}\\??((?:\\.[A-Za-z_$][\\w$]*)+)[?.]*\\s*\\(`, 'g')
    while ((m = re.exec(line)) !== null) {
      const chain = m[1].replace(/^\./, '')
      // 过滤数组/对象常用方法名（防止 map/filter/forEach 等被误判为代理 API）
      const method = chain.split('.').pop()?.toLowerCase() ?? ''
      if (NATIVE_METHODS.has(method)) continue
      if (!report.proxyApi.some((p) => p.line === lineNo && p.method === chain)) {
        report.proxyApi.push({ method: chain, line: lineNo, code: codeStr })
      }
    }
  }

  // 网络请求（只检测函数调用，字符串里的 URL 不算）
  if (/(?:req|fetch|axios|got|https?\.get|https?\.request)\s*\(/.test(line)) {
    report.network.push({ line: lineNo, code: codeStr })
  }

  // 文件操作
  if (/(?:fs\.|fs\/promises).*?(readFile|writeFile|appendFile|unlink|rm|rename|mkdir|copyFile|readdir|stat|exists)\b|from\s+["']fs["']|from\s+["']fs\/promises["']/.test(line)) {
    report.filesystem.push({ line: lineNo, code: codeStr })
  }

  // 危险操作
  if (/\beval\s*\(|new\s+Function|child_process|(?:^|[^.\w$])(exec|execSync|spawn|spawnSync)\s*\(|process\.exit\s*\(|import\s*\(/.test(line)) {
    report.dangerous.push({ line: lineNo, code: codeStr })
  }
}

// 粗略匹配代理 API 调用与声明（声明 plugin.list，调用可能是 listPlugins 或 plugin.list）
function isProxyDeclared(callName: string, declared: Set<string>): boolean {
  if (declared.has(callName)) return true
  const callLower = callName.toLowerCase()
  const callLast = callName.split('.').pop()?.toLowerCase() ?? ''
  for (const d of declared) {
    const declLower = d.toLowerCase()
    const declLast = d.split('.').pop()?.toLowerCase() ?? ''
    if (callLower.includes(declLower) || declLower.includes(callLower)) return true
    if (callLast && declLast && (callLast.includes(declLast) || declLast.includes(callLast))) return true
  }
  return false
}

function judgeRisk(report: ScanReport): { risk: '低' | '中' | '高'; note: string } {
  if (report.dangerous.length > 0) {
    return { risk: '高', note: `包含 ${report.dangerous.length} 处 eval/子进程/动态执行等危险操作，强烈不建议安装` }
  }
  if (report.undeclaredCallApi.length > 0) {
    return { risk: '中', note: `调用了 ${report.undeclaredCallApi.length} 个未声明的代理 API（ctx.api）：${report.undeclaredCallApi.join(' / ')}，可能越权` }
  }
  if (report.network.length > 0 || report.filesystem.length > 0) {
    return { risk: '中', note: `有网络请求 ${report.network.length} 处、文件操作 ${report.filesystem.length} 处，注意审查目标地址与用途` }
  }
  return { risk: '低', note: '代理 API 均已声明，无网络 / 文件 / 危险操作' }
}

export function scanPlugin(sourceCode: string): ScanReport {
  const code = String(sourceCode ?? '')
  const report: ScanReport = {
    callApi: [],
    proxyApi: [],
    network: [],
    filesystem: [],
    dangerous: [],
    declaredApis: [],
    undeclaredCallApi: [],
    hasDeclarations: false,
    risk: '低',
    note: '',
  }

  const decl = extractDeclaredApis(code)
  report.hasDeclarations = decl.has
  report.declaredApis = decl.apis

  // 收集 ctx.api 的变量别名（如 const api = ctx.api / const { api } = ctx）
  const proxyAliases = new Set<string>()
  let am: RegExpExecArray | null
  const aliasRe = /(?:const|let|var)\s+(\w+)\s*=\s*(?:ctx|this)\.api/g
  while ((am = aliasRe.exec(code)) !== null) proxyAliases.add(am[1])
  const destructRe = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:ctx|this)\b/g
  while ((am = destructRe.exec(code)) !== null) {
    am[1].split(',').forEach((s) => {
      const name = s.trim().split(':')[0].trim()
      if (name === 'api') proxyAliases.add('api')
    })
  }

  const lines = code.split('\n')
  for (let i = 0; i < lines.length; i++) {
    scanLine(lines[i], i + 1, report, proxyAliases)
  }

  const declared = new Set(report.declaredApis)
  // 未声明检测只针对代理 API（ctx.api）；bot.callApi 是平台原生 API，无需声明
  report.undeclaredCallApi = [...new Set(
    report.proxyApi.filter((c) => !isProxyDeclared(c.method, declared)).map((c) => c.method),
  )]

  const judged = judgeRisk(report)
  report.risk = judged.risk
  report.note = judged.note
  return report
}
