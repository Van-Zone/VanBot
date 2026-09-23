// 微信 4.x 数据库密钥自动扫描（内存方案，无需 Hook / 无需 Python）
//
// 参考 WeChatDataAnalysis 的 key_v4.py + dll_key_scan.py 原理：
//   1. Weixin.dll 的代码段里，编译器用 4 条 `mov rdx, imm64`（48 BA <8字节>）
//      指令拼接出一个 32 字节的 internal_db_key（辅助掩码 key），末尾跟 `test rax,rax`。
//   2. 微信进程内存中并不直接存放数据库 passphrase，而是存放
//      raw_key = passphrase XOR internal_db_key，通过一段固定的 YARA 特征定位
//      （一个 {指针, 0, len=0x20, cap=0x2f} 的小块，指针指向 32 字节 raw_key）。
//   3. 恢复：passphrase = raw_key XOR internal_db_key，
//      再用数据库第 1 页的 SQLCipher HMAC（PBKDF2 256000 + SHA512）验证，命中即正确密钥。
//
// 仅在 Windows + 微信运行中可用。失败返回 null，由调用方回退到手动配置的 key。

import crypto from "crypto"
import fs from "fs"
import path from "path"
import { execFileSync } from "child_process"

// ---- 加密参数（微信 4.x 魔改 SQLCipher）----
const PAGE_SIZE = 4096
const KEY_SIZE = 32
const SALT_SIZE = 16
const IV_SIZE = 16
const HMAC_SIZE = 64
const RESERVE_SIZE = IV_SIZE + HMAC_SIZE // 80
const PBKDF2_ITERATIONS = 256000

// ---- Windows 内存常量 ----
const PROCESS_VM_READ = 0x0010
const PROCESS_QUERY_INFORMATION = 0x0400
const MEM_COMMIT = 0x1000
const MEM_PRIVATE = 0x20000
const PAGE_GUARD = 0x100
const PAGE_NOCACHE = 0x200
const CHUNK_SIZE = 16 * 1024 * 1024 // 大块内存分块读取（16MB）

const IMAGE_SCN_MEM_EXECUTE = 0x20000000

export interface ScanOptions {
  /** 账号数据目录（.../xwechat_files/wxid_xxx_xxxx），用于取消息库第 1 页做 HMAC 校验 */
  dataDir: string
  /** 可选：微信安装目录（或 Weixin.exe / Weixin.dll 路径），不传则自动探测 */
  wechatInstallPath?: string
  /** 可选：日志函数 */
  log?: (msg: string) => void
}

function noop() {}

/** 枚举所有微信进程 PID（Weixin.exe / WeChat.exe） */
function findWeixinPids(): number[] {
  try {
    const out = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" })
    const pids: number[] = []
    const re = /^"(?:Weixin|WeChat)\.exe","(\d+)"/gim
    let m: RegExpExecArray | null
    while ((m = re.exec(out))) pids.push(Number(m[1]))
    return pids
  } catch {
    return []
  }
}

/** 取微信主进程的可执行文件路径（最早启动的那个），用于推导安装目录 */
function getWeixinExePath(): string {
  try {
    const p = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "(Get-Process Weixin,WeChat -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1).Path",
      ],
      { encoding: "utf8" }
    ).trim()
    return p
  } catch {
    return ""
  }
}

/** 定位 Weixin.dll：配置路径 > 进程目录 > 默认安装目录 */
function findWeixinDll(installPath?: string): string {
  const candidates: string[] = []
  const pushIfFile = (p: string) => {
    try {
      if (fs.statSync(p).isFile()) candidates.push(p)
    } catch {}
  }
  const collectFromDir = (dir: string) => {
    pushIfFile(path.join(dir, "Weixin.dll"))
    pushIfFile(path.join(dir, "WeChat.dll"))
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    // 版本号子目录（如 4.1.15.11）以及 install/<ver>/
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const sub = path.join(dir, e.name)
      pushIfFile(path.join(sub, "Weixin.dll"))
      pushIfFile(path.join(sub, "WeChat.dll"))
      pushIfFile(path.join(sub, "install", "Weixin.dll"))
    }
    pushIfFile(path.join(dir, "install", "Weixin.dll"))
  }

  if (installPath) {
    let st: fs.Stats | null = null
    try {
      st = fs.statSync(installPath)
    } catch {}
    if (st?.isFile()) {
      collectFromDir(path.dirname(installPath))
    } else if (st?.isDirectory()) {
      collectFromDir(installPath)
    }
  }

  const exePath = getWeixinExePath()
  if (exePath) collectFromDir(path.dirname(exePath))

  // 兜底默认安装目录
  for (const base of [
    "C:/Program Files/Tencent/Weixin",
    "C:/Program Files (x86)/Tencent/Weixin",
    "C:/Program Files/Tencent/WeChat",
    "C:/Program Files (x86)/Tencent/WeChat",
  ]) {
    collectFromDir(base)
  }

  // 取修改时间最新的一个（多版本并存时优先当前版本）
  candidates.sort((a, b) => {
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs
    } catch {
      return 0
    }
  })
  return candidates[0] || ""
}

/** 手动解析 PE，返回所有可执行段的文件数据（无需 pefile 依赖） */
function getExecutableSections(buf: Buffer): { name: string; data: Buffer }[] {
  const peOff = buf.readUInt32LE(0x3c)
  if (buf.toString("ascii", peOff, peOff + 4) !== "PE\0\0") {
    throw new Error("不是有效的 PE 文件")
  }
  const numSections = buf.readUInt16LE(peOff + 6)
  const sizeOptHdr = buf.readUInt16LE(peOff + 20)
  const secStart = peOff + 24 + sizeOptHdr
  const out: { name: string; data: Buffer }[] = []
  for (let i = 0; i < numSections; i++) {
    const off = secStart + i * 40
    const name = buf.toString("ascii", off, off + 8).replace(/\0.*$/, "")
    const rawSize = buf.readUInt32LE(off + 16)
    const rawPtr = buf.readUInt32LE(off + 20)
    const chars = buf.readUInt32LE(off + 36)
    if (chars & IMAGE_SCN_MEM_EXECUTE && rawSize > 0) {
      out.push({ name, data: buf.subarray(rawPtr, rawPtr + rawSize) })
    }
  }
  return out
}

/**
 * 在代码段扫描特征：
 *   48 BA (8字节) .{3,8}? 48 BA (8字节) .{3,8}? 48 BA (8字节) .{3,8}? 48 BA (8字节) .{3,8}? 48 85 C0
 * 4 组 8 字节立即数拼成 32 字节 internal_db_key。
 */
function scanDllInternalKeys(code: Buffer): string[] {
  const keys = new Set<string>()
  const n = code.length
  for (let i = 0; i + 60 <= n; i++) {
    if (code[i] !== 0x48 || code[i + 1] !== 0xba) continue
    const groups: Buffer[] = []
    let pos = i
    let ok = true
    for (let g = 0; g < 4; g++) {
      if (code[pos] !== 0x48 || code[pos + 1] !== 0xba) {
        ok = false
        break
      }
      groups.push(code.subarray(pos + 2, pos + 10))
      pos += 10
      let found = false
      if (g < 3) {
        for (let gap = 3; gap <= 8; gap++) {
          if (code[pos + gap] === 0x48 && code[pos + gap + 1] === 0xba) {
            pos += gap
            found = true
            break
          }
        }
      } else {
        for (let gap = 3; gap <= 8; gap++) {
          if (
            code[pos + gap] === 0x48 &&
            code[pos + gap + 1] === 0x85 &&
            code[pos + gap + 2] === 0xc0
          ) {
            found = true
            break
          }
        }
      }
      if (!found) {
        ok = false
        break
      }
    }
    if (ok) keys.add(Buffer.concat(groups).toString("hex"))
  }
  return [...keys]
}

/** 熵过滤：判断 32 字节是否像随机密钥（排除指针/ASCII 文本） */
function isPotentialKey(key: Buffer): boolean {
  if (key.length !== KEY_SIZE) return false
  if (new Set(key).size < 15) return false
  let printable = 0
  for (const b of key) if (b >= 32 && b <= 126) printable++
  return printable <= 24
}

interface KoffiEnv {
  koffi: any
  kernel32: any
  MBI: any
  OpenProcess: any
  CloseHandle: any
  ReadProcessMemory: any
  VirtualQueryEx: any
}

async function loadKoffi(): Promise<KoffiEnv | null> {
  let koffi: any
  try {
    koffi = (await import("koffi")).default
  } catch {
    return null
  }
  const kernel32 = koffi.load("kernel32.dll")
  const MBI = koffi.struct("MEMORY_BASIC_INFORMATION_WCDB", {
    BaseAddress: "void*",
    AllocationBase: "void*",
    AllocationProtect: "uint32",
    PartitionId: "uint32",
    RegionSize: "uintptr",
    State: "uint32",
    Protect: "uint32",
    Type: "uint32",
  })
  return {
    koffi,
    kernel32,
    MBI,
    OpenProcess: kernel32.func("void* OpenProcess(uint32, bool, uint32)"),
    CloseHandle: kernel32.func("bool CloseHandle(void*)"),
    ReadProcessMemory: kernel32.func("bool ReadProcessMemory(void*, void*, void*, uintptr, void*)"),
    VirtualQueryEx: kernel32.func(
      "int32 VirtualQueryEx(void*, void*, MEMORY_BASIC_INFORMATION_WCDB*, uintptr)"
    ),
  }
}

/** 扫描单个进程，返回该进程内所有 raw_key 候选（hex） */
function collectRawKeys(env: KoffiEnv, pid: number): Set<string> {
  const { koffi, MBI, OpenProcess, CloseHandle, ReadProcessMemory, VirtualQueryEx } = env
  const result = new Set<string>()
  const handle = OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, pid)
  if (!handle) return result
  const mbiPtr = koffi.alloc(MBI, 1)
  let address = 0n

  const readAt = (addr: bigint, n: number): Buffer | null => {
    const buf = Buffer.alloc(n)
    return ReadProcessMemory(handle, koffi.as(addr, "void*"), buf, n, null) ? buf : null
  }

  try {
    while (address < 0x7fffffffffffn) {
      const ret = VirtualQueryEx(
        handle,
        koffi.as(address, "void*"),
        mbiPtr,
        koffi.sizeof(MBI)
      )
      if (ret === 0) break
      const mbi = koffi.decode(mbiPtr, MBI)
      const base = BigInt(mbi.BaseAddress ?? 0)
      const size = BigInt(mbi.RegionSize ?? 0)
      if (size === 0n) break

      if (
        mbi.State === MEM_COMMIT &&
        mbi.Type === MEM_PRIVATE &&
        !(mbi.Protect & PAGE_GUARD) &&
        !(mbi.Protect & PAGE_NOCACHE)
      ) {
        for (let off = 0n; off < size; off += BigInt(CHUNK_SIZE)) {
          const remain = size - off
          const n = Number(remain < BigInt(CHUNK_SIZE) ? remain : BigInt(CHUNK_SIZE))
          const buf = Buffer.alloc(n)
          if (ReadProcessMemory(handle, koffi.as(base + off, "void*"), buf, n, null)) {
            for (let i = 0; i + 32 <= n; i++) {
              // YARA 特征：offset 6-15 为 0；@16 u64 = 0x20（key 长度）；@24 u64 = 0x2f（capacity）
              if (buf[i + 6] !== 0 || buf[i + 7] !== 0) continue
              if (buf.readUInt32LE(i + 8) !== 0 || buf.readUInt32LE(i + 12) !== 0) continue
              if (buf.readBigUInt64LE(i + 16) !== 0x20n) continue
              if (buf.readBigUInt64LE(i + 24) !== 0x2fn) continue
              const ptr = buf.readBigUInt64LE(i)
              if (ptr <= 0x10000n || ptr >= 0x7fffffffffffn) continue
              const key = readAt(ptr, KEY_SIZE)
              if (key && isPotentialKey(key)) result.add(key.toString("hex"))
            }
          }
        }
      }
      address = base + size
    }
  } finally {
    koffi.free(mbiPtr)
    CloseHandle(handle)
  }
  return result
}

/** 用数据库第 1 页校验 passphrase（passphrase 模式：PBKDF2 256000 + HMAC-SHA512） */
function verifyPassphrase(passphrase: Buffer, page1: Buffer): boolean {
  try {
    const salt = page1.subarray(0, SALT_SIZE)
    const macSalt = Buffer.from(salt.map((b) => b ^ 0x3a))
    const encKey = crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, KEY_SIZE, "sha512")
    const macKey = crypto.pbkdf2Sync(encKey, macSalt, 2, KEY_SIZE, "sha512")
    const storedHmac = page1.subarray(PAGE_SIZE - HMAC_SIZE, PAGE_SIZE)
    const mac = crypto.createHmac("sha512", macKey)
    mac.update(page1.subarray(SALT_SIZE, PAGE_SIZE - RESERVE_SIZE + IV_SIZE))
    mac.update(Buffer.from([1, 0, 0, 0])) // 小端页号 1
    return crypto.timingSafeEqual(storedHmac, mac.digest())
  } catch {
    return false
  }
}

/** 读取消息库第 1 页（加密页）用于 HMAC 校验 */
function readFirstPage(dataDir: string): Buffer | null {
  const msgDir = path.join(dataDir, "db_storage", "message")
  const names = ["message_0.db", "message.db", "biz_message_0.db", "MSG0.db"]
  for (const name of names) {
    const p = path.join(msgDir, name)
    try {
      const fd = fs.openSync(p, "r")
      try {
        const buf = Buffer.alloc(PAGE_SIZE)
        const n = fs.readSync(fd, buf, 0, PAGE_SIZE, 0)
        if (n === PAGE_SIZE) return buf
      } finally {
        fs.closeSync(fd)
      }
    } catch {}
  }
  return null
}

/**
 * 自动扫描微信数据库密钥。
 * 成功返回 64 位 hex passphrase；任何环节失败返回 null（调用方回退手动 key）。
 */
export async function scanWeChatDatabaseKey(opts: ScanOptions): Promise<string | null> {
  const log = opts.log || noop
  if (process.platform !== "win32") return null

  const page1 = readFirstPage(opts.dataDir)
  if (!page1) {
    log("[KeyScan] 找不到消息数据库，无法校验密钥")
    return null
  }

  // 1. 定位并扫描 Weixin.dll，得到 internal_db_key 候选
  const dllPath = findWeixinDll(opts.wechatInstallPath)
  if (!dllPath) {
    log("[KeyScan] 未找到 Weixin.dll")
    return null
  }
  let internalKeys: Buffer[] = []
  try {
    const dllBuf = fs.readFileSync(dllPath)
    const sections = getExecutableSections(dllBuf)
    const set = new Set<string>()
    for (const sec of sections) {
      for (const k of scanDllInternalKeys(sec.data)) set.add(k)
    }
    internalKeys = [...set].map((h) => Buffer.from(h, "hex"))
  } catch (e) {
    log(`[KeyScan] 扫描 Weixin.dll 失败: ${(e as Error).message}`)
    return null
  }
  if (internalKeys.length === 0) {
    log("[KeyScan] DLL 中未找到 internal_db_key 特征（微信版本可能不受支持）")
    return null
  }
  log(`[KeyScan] Weixin.dll 找到 ${internalKeys.length} 个辅助 key 候选`)

  // 2. 加载 koffi
  const env = await loadKoffi()
  if (!env) {
    log("[KeyScan] 未安装 koffi，无法扫描内存（npm install koffi）")
    return null
  }

  // 3. 逐进程扫描内存，边扫边验证，命中即返回
  const pids = findWeixinPids()
  if (pids.length === 0) {
    log("[KeyScan] 未发现运行中的微信进程")
    return null
  }
  for (const pid of pids) {
    let rawSet: Set<string>
    try {
      rawSet = collectRawKeys(env, pid)
    } catch {
      continue
    }
    if (rawSet.size === 0) continue
    for (const rawHex of rawSet) {
      const raw = Buffer.from(rawHex, "hex")
      for (const ik of internalKeys) {
        const pass = Buffer.alloc(KEY_SIZE)
        for (let i = 0; i < KEY_SIZE; i++) pass[i] = raw[i] ^ ik[i]
        if (verifyPassphrase(pass, page1)) {
          log(`[KeyScan] 内存扫描成功（pid=${pid}）`)
          return pass.toString("hex")
        }
      }
    }
  }

  log("[KeyScan] 内存扫描完成，但没有候选通过 HMAC 校验")
  return null
}
