//
// 作者: ZiYi / 星星，交流群: 1019070322
// 项目地址: https://github.com/Van-Zone/VanBotJS/
// 本项目基于 GPLv3 许可证开源
//
import { botLog } from "../src/core/logger.js";
import { definePlugin, type PluginContext } from "../src/core/pluginContext.js";
import type { BaseAdapter } from "../src/adapter/base.js";
import type { BotEvent } from "../src/core/models/event.js";
import { MessageSegment } from "../src/core/models/message.js";
import { get_bot } from "../src/core/botRegistry.js";
import { transMessage, transNotice, transMeta } from "./lib/transEvent.js";
import fs from "fs/promises";
import path from "path";
import * as schedule from "node-schedule";
import type { Image as SkiaImage, Canvas as SkiaCanvas, CanvasRenderingContext2D as SkiaCtx } from "skia-canvas";

// skia-canvas 动态加载：加载失败返回 null，上层降级，不阻塞插件
let skiaMod: (typeof import("skia-canvas")) | null | undefined;
async function getSkia(): Promise<typeof import("skia-canvas") | null> {
    if (skiaMod !== undefined) return skiaMod;
    try {
        skiaMod = await import("skia-canvas");
    } catch {
        skiaMod = null;
        console.warn("[keyword] skia-canvas 不可用（原生依赖缺失），图片渲染功能降级为文本");
    }
    return skiaMod;
}
import { createWriteStream } from "fs";

// 统一发送入口：群聊传 group_id，私聊传 user_id；
async function sendMsgCtx(
    bot: BaseAdapter,
    event: BotEvent | undefined,
    target: { group_id?: unknown; user_id?: unknown },
    message: unknown
): Promise<any> {
    const gid = target.group_id !== undefined && target.group_id !== null ? String(target.group_id) : "";
    const tid = gid && gid !== "0" && gid !== "undefined"
        ? { groupId: gid }
        : { userId: String(target.user_id ?? "") };
    return bot.sendMsg(
        tid,
        message as any,
        event?.capabilities ? { capabilities: event.capabilities } : undefined
    );
}

// 文件位置
const ROOT_DIR = process.cwd();
const PLUGIN_DATA = path.join(ROOT_DIR, "Van_keyword");
const CONFIG_FILE_PATH = path.join(PLUGIN_DATA, "config.json");
// 发送变量 (发送消息ID)
const global_message_ids: Record<string, Record<string, number | undefined>> = {};
// 词条变量 (触发词条ID)
const global_lexicon_ids: Record<string, Record<string, number | undefined>> = {};
// 词汇量变量 (总词条数)
const global_lexicon_totals: Record<string, Record<string, number | undefined>> = {};
// 报错变量 (文本)
const global_error_reply: Record<string, Record<string, string | undefined>> = {};
// 其他
const fileCachePool = new Map<string, FileCacheItem>();
const jobPool: Record<string, PoolJob> = {};
const taskCache: Record<string, unknown> = {};
// 插件上下文（definePlugin 工厂执行时赋值），用于把定时器纳入框架副作用追踪
let pluginCtx: PluginContext | null = null;
// 定时器统一走 ctx：插件热重载/卸载时由框架自动清理，避免句柄泄漏；ctx 未就绪时回退原生
function safeSetTimeout(fn: (...args: any[]) => void, ms?: number, ...args: any[]): any {
    return pluginCtx ? pluginCtx.setTimeout(fn, ms, ...args) : (globalThis as any).setTimeout(fn, ms, ...args);
}
function safeClearTimeout(id: any): void {
    if (pluginCtx) pluginCtx.clearTimeout(id); else (globalThis as any).clearTimeout(id);
}
function safeSetInterval(fn: (...args: any[]) => void, ms?: number, ...args: any[]): any {
    return pluginCtx ? pluginCtx.setInterval(fn, ms, ...args) : (globalThis as any).setInterval(fn, ms, ...args);
}
function safeClearInterval(id: any): void {
    if (pluginCtx) pluginCtx.clearInterval(id); else (globalThis as any).clearInterval(id);
}
// 类型定义
type FileCacheItem = {
    rawText: string | null;
    jsonData: unknown | null;
    loadPromise: Promise<{ rawText: string; jsonData?: unknown }> | null;
};
interface CoinItem {
    group: string;
    type: string;
    user: string;
    data: string | number;
    note?: string;
    uptime: string;
}
interface CoinStorage {
    work: CoinItem[];
}
interface CoinRankItem extends CoinItem {
    rank: number;
}
type MsgSegment = { type: string; data: Record<string, unknown> };
type LexRule = { r: string[]; s: number };
type LexSingleItem = { id: number; } & Omit<Record<string, LexRule>, "id">;
type LexRootData = {
    work: LexSingleItem[];
    recycle: LexSingleItem[];
    maxId: number;
};
type CheckResult = [boolean, boolean];
// 词库匹配命中结果
type LexMatchResult = { replyList: string[]; capture: string[] | false };
// 任务相关
export interface TaskConfig {
  botId: string;
  groupId: string;
  userId: string;
  msg: string;
  time: string;
  cache: boolean;
}
export interface TaskListObj {
  work: TaskConfig[];
}
interface IntervalJob {
  timer: NodeJS.Timeout;
}
type PoolJob = schedule.Job | IntervalJob;
type ParseTimeResult = Date | schedule.RecurrenceRule | { intervalSec: number };
type JsonValue = string | number | boolean | null | JsonValue[] | Record<string, any>;
type KeyMappingInput = string | Record<string, string> | null | undefined;
interface DrawElement {
    type: "block" | "text" | "image";
    x: number;
    y: number;
    width?: number;
    height?: number;
    text?: string;
    lines?: string[];
    fill?: string;
    bgColor?: string;
    borderColor?: string;
    radius?: number;
    img?: SkiaImage;
}


// 文件修改
export async function fileCacheIO(
    absolutePath: string,
    mode: "r" | "w",
    content?: string | unknown,
    forceRefresh = false
): Promise<string | any> {
    const ext = path.extname(absolutePath).toLowerCase();
    const isJsonFile = ext === ".json";

    if (mode === "w") {
        if (content === undefined) throw new Error("写入模式必须传入content参数");
        const dirPath = path.dirname(absolutePath);
        await fs.mkdir(dirPath, { recursive: true });

        let writeStr: string;
        if (isJsonFile && typeof content !== "string") {
            writeStr = JSON.stringify(content, null, 4);
        } else {
            writeStr = String(content);
        }

        await fs.writeFile(absolutePath, writeStr, "utf-8");
        fileCachePool.delete(absolutePath);
        return "写入成功";
    }

    if (forceRefresh) fileCachePool.delete(absolutePath);
    if (fileCachePool.has(absolutePath)) {
        const cache = fileCachePool.get(absolutePath)!;
        if (cache.rawText !== null && cache.loadPromise === null) {
            return isJsonFile ? cache.jsonData : cache.rawText;
        }
        if (cache.loadPromise) {
            const res = await cache.loadPromise;
            return isJsonFile ? res.jsonData : res.rawText;
        }
    }

    const cacheItem: FileCacheItem = {
        rawText: null,
        jsonData: null,
        loadPromise: null
    };
    fileCachePool.set(absolutePath, cacheItem);

    cacheItem.loadPromise = (async () => {
        try {
            const stat = await fs.stat(absolutePath);
            if (!stat.isFile()) throw new Error(`非文件: ${absolutePath}`);
            const rawText = await fs.readFile(absolutePath, "utf-8");
            cacheItem.rawText = rawText;

            let jsonData: unknown | undefined;
            if (isJsonFile) {
                jsonData = JSON.parse(rawText);
                cacheItem.jsonData = jsonData;
            }
            return { rawText, jsonData };
        } catch (err) {
            fileCachePool.delete(absolutePath);
            throw err;
        } finally {
            cacheItem.loadPromise = null;
        }
    })();

    const result = await cacheItem.loadPromise;
    return isJsonFile ? result.jsonData : result.rawText;
}

// 缓存清理工具
export const FileCacheManager = {
    clearSingle: (p: string) => fileCachePool.delete(p),
    clearAll: () => fileCachePool.clear(),
    getSize: () => fileCachePool.size
};

// per-file 异步互斥队列：同一文件的"读-改-写"必须串行执行，
// 否则两个并发操作各自读到旧值、先后写回，后写覆盖先写会丢数据。
const fileMutexTails = new Map<string, Promise<void>>();
function withFileLock<T>(fileKey: string, task: () => Promise<T>): Promise<T> {
    const prev = fileMutexTails.get(fileKey) ?? Promise.resolve();
    // 前一个任务无论成败都继续执行当前任务，但当前任务自身的成败仍原样抛出
    const run = prev.then(task, task);
    const tail = run.then(() => undefined, () => undefined);
    fileMutexTails.set(fileKey, tail);
    // 队列排空后清理键，避免 Map 无限增长
    tail.then(() => {
        if (fileMutexTails.get(fileKey) === tail) fileMutexTails.delete(fileKey);
    });
    return run;
}

// 词库数据处理
async function LexiconManager(
    selfId: string,
    lexiconId: string,
    opType: string,
    kwargs: Record<string, any>
): Promise<string | LexMatchResult> {
    const getLexFilePath = (id: string) => path.join(PLUGIN_DATA, String(id), "lexicon", `${lexiconId}.json`);

    function parseTarget(input: string): { type: "id" | "name"; value: number | string } {
        const realInput = input.trim();
        if (realInput.startsWith("#")) {
            const numStr = realInput.slice(1).trim();
            const num = Number(numStr);
            if (!isNaN(num) && Number.isInteger(num) && num > 0) {
                return { type: "id", value: num };
            } else {
                return { type: "id", value: numStr };
            }
        }
        return { type: "name", value: realInput };
    }

    function _matchTemplate(templateKey: string, inputText: string): false | string[] {
        let safeKey = templateKey.replaceAll("[", "\\[").replaceAll("]", "\\]");
        const placeholderReg = /\\\[n\.(\d+)\\\]/g;
        const placeholders: number[] = [];
        let m: RegExpExecArray | null;
        while ((m = placeholderReg.exec(safeKey))) {
            placeholders.push(Number(m[1]));
        }
        const patternStr = "^" + safeKey.replaceAll(/\\\[n\.\d+\\\]/g, "(.+?)") + "$";
        try {
            const pattern = new RegExp(patternStr);
            const match = pattern.exec(inputText);
            if (!match) return false;
            const result: string[] = ["", "", "", "", "", "", ""];
            placeholders.forEach((idx, i) => {
                if (idx < result.length) {
                    result[idx] = match![i + 1];
                }
            });
            return result.every(x => !x) ? false : result;
        } catch {
            return false;
        }
    }

    const builtInItem: any = {
        id: 0,
        "say [n.1]": {
            r: ["[judge.{[userid]in[coin.0.OWNER.0.0.[selfid]]}|{[userid]in[coin.0.MASTER.0.0.[selfid]]}][n.1]"],
            s: 1
        }
    };

    const loadLex = async (force: boolean): Promise<LexRootData> => {
        if (force) fileCachePool.delete(getLexFilePath(selfId));
        let data: LexRootData;
        try {
            data = await fileCacheIO(getLexFilePath(selfId), "r") as LexRootData;
            data.work ??= [];
            data.recycle ??= [];
            data.maxId ??= 0;
        } catch {
            data = { work: [], recycle: [], maxId: 0 };
        }
        if (!data.work.find(item => item.id === 0)) {
            data.work.unshift(builtInItem);
        }
        global_lexicon_totals[selfId] ??= {};
        global_lexicon_totals[selfId].count = data.work.length;
        return data;
    };

    const saveLex = async (data: LexRootData) => {
        await fileCacheIO(getLexFilePath(selfId), "w", data);
        fileCachePool.delete(getLexFilePath(selfId));
        global_lexicon_totals[selfId] ??= {};
        global_lexicon_totals[selfId].count = data.work.length;
    };

    const validOps = new Set([
        "get", "add", "remove",
        "look", "restore", "reset",
        "edit_name", "edit_mode"
    ]);
    if (!validOps.has(opType)) {
        return `无效操作！支持指令：${[...validOps].join("、")}`;
    }

    if (opType === "get") {
        const value = kwargs.value;
        if (!value) return "";
        const lexData = await loadLex(false);
        global_lexicon_ids[selfId] ??= {};

        const normalList: any[] = [];
        const pureWildcardList: any[] = [];
        for (const item of lexData.work) {
            const keys = Object.keys(item).filter(k => k !== "id");
            const keyword = keys[0];
            if (keyword === "[n.1]") {
                pureWildcardList.push({ item, keyword });
            } else {
                normalList.push({ item, keyword });
            }
        }

        for (const entry of normalList) {
            const { item, keyword } = entry;
            const rule = item[keyword];
            const s = rule.s ?? 1;
            if (s === 1) {
                if (keyword.includes("[n.")) {
                    const captureArr = _matchTemplate(keyword, value);
                    if (captureArr !== false) {
                        global_lexicon_ids[selfId].hit = item.id;
                        return { replyList: rule.r, capture: captureArr };
                    }
                } else {
                    if (value === keyword) {
                        global_lexicon_ids[selfId].hit = item.id;
                        return { replyList: rule.r, capture: false };
                    }
                }
            } else {
                if (value.includes(keyword)) {
                    global_lexicon_ids[selfId].hit = item.id;
                    return { replyList: rule.r, capture: false };
                }
            }
        }

        const matchedWildcards: Array<{ item: any; keyword: string; count: number }> = [];
        for (const entry of pureWildcardList) {
            const { item, keyword } = entry;
            const rule = item[keyword];
            const s = rule.s ?? 1;
            if (s === 1) {
                const captureArr = _matchTemplate(keyword, value);
                if (captureArr !== false) {
                    const count = (keyword.match(/\[n\.\d+\]/g) || []).length;
                    matchedWildcards.push({ item, keyword, count });
                }
            } else {
                if (value.includes(keyword)) {
                    const count = (keyword.match(/\[n\.\d+\]/g) || []).length;
                    matchedWildcards.push({ item, keyword, count });
                }
            }
        }
        if (matchedWildcards.length > 0) {
            matchedWildcards.sort((a, b) => b.count - a.count);
            const best = matchedWildcards[0];
            global_lexicon_ids[selfId].hit = best.item.id;
            return { replyList: best.item[best.keyword].r, capture: _matchTemplate(best.keyword, value) || [] };
        }

        global_lexicon_ids[selfId].hit = 0;
        return "";
    }

    if (opType === "add") {
        const { n, r, s } = kwargs;
        if (!n || !r || s === undefined) {
            return "缺少参数：n(触发词)、r(回复内容)、s(模式字符串\"1\"精准/\"0\"模糊)";
        }
        const sNum = Number(s);
        if (![0, 1].includes(sNum)) return "s只能是字符串\"1\"(精准) 或 \"0\"(模糊)";

        const lexData = await loadLex(true);
        const existIdx = lexData.work.findIndex(it => !!it[n]);
        if (existIdx >= 0) {
            const target = lexData.work[existIdx][n];
            if (!target.r.includes(r)) {
                target.r.push(r);
            }
        } else {
            lexData.work.push({ id: ++lexData.maxId, [n]: { r: [r], s: sNum } } as any);
        }
        await saveLex(lexData);
        return "添加成功";
    }

    if (opType === "remove") {
        const queryRaw = kwargs.query;
        if (!queryRaw) return "缺少参数 query；示例：#5（按ID） / 触发词文本（按词删除）";
        const lexData = await loadLex(true);
        const parsed = parseTarget(queryRaw);

        if (parsed.type === "id") {
            const targetId = parsed.value as number;
            const idx = lexData.work.findIndex(it => it.id === targetId);
            if (idx === -1) return `不存在id:${targetId}`;
            const delItem = lexData.work.splice(idx, 1)[0];
            lexData.recycle.push(delItem);
            await saveLex(lexData);
            const key = Object.keys(delItem).filter(k => k !== "id")[0];
            return `已删除id${targetId}，触发词：${key}（移入回收站）`;
        } else {
            const delName = parsed.value as string;
            const keep: typeof lexData.work = [];
            const deleted: typeof lexData.work = [];
            for (const item of lexData.work) {
                const key = Object.keys(item).filter(k => k !== "id")[0];
                if (key === delName) {
                    if (item.id !== 0) {
                        deleted.push(item);
                    } else {
                        keep.push(item);
                    }
                } else {
                    keep.push(item);
                }
            }
            lexData.work = keep;
            lexData.recycle.push(...deleted);
            await saveLex(lexData);
            return deleted.length > 0 ? `成功删除${deleted.length}条词条，并移入回收站` : "未找到对应触发词词条";
        }
    }

    if (opType === "look") {
        const queryRaw = kwargs.query;
        if (queryRaw === undefined || queryRaw === null || queryRaw === "") return "缺少参数 query；示例：#3 / #1‑10 / 关键词";
        const lexData = await loadLex(true);
        const msg: string[] = [];
        const parsed = parseTarget(queryRaw);

        const allItems: Array<{ item: any; isTrash: boolean }> = [];
        for (const i of lexData.work) allItems.push({ item: i, isTrash: false });
        for (const i of lexData.recycle) allItems.push({ item: i, isTrash: true });

        if (parsed.type === "id") {
            const inputStr = String(parsed.value);
            let start: number, end: number;
            if (inputStr.includes("-")) {
                const [sStr, eStr] = inputStr.split("-");
                start = Number(sStr);
                end = Number(eStr);
                if (isNaN(start) || isNaN(end)) return "ID区间格式错误，示例 #1‑10";
            } else {
                start = Number(inputStr);
                end = Number(inputStr);
            }

            for (const { item, isTrash } of allItems) {
                if (item.id >= start && item.id <= end) {
                    const key = Object.keys(item).filter(k => k !== "id")[0];
                    const rule = item[key];
                    const mode = rule.s === 1 ? "精准" : "模糊";
                    if (start === end) {
                        let flag = isTrash ? "回收站" : "工作区";
                        msg.push(`［ID${item.id}］${key}\n［INFO］${flag} | ${mode}\n`);
                        rule.r.forEach((rr: string, i: number) => msg.push(`\n(${i + 1})${rr}`));
                    } else {
                        let flag = isTrash ? "🗑" : "";
                        msg.push(`${flag}［ID${item.id}］${key}\n`);
                    }
                }
            }
            if (msg.length === 0) return "未找到匹配ID词条";
        } else {
            const keyword = parsed.value as string;
            let found = false;
            for (const { item, isTrash } of allItems) {
                const key = Object.keys(item).filter(k => k !== "id")[0];
                if (key.includes(keyword)) {
                    found = true;
                    const flag = isTrash ? "🗑" : "";
                    msg.push(`${flag}［ID${item.id}］${key}\n`);
                }
            }
            if (!found) return "未找到匹配词条";
        }
        msg.push(`\n工作区总共${lexData.work.length}条词条，回收站${lexData.recycle.length}条`);
        return msg.join("");
    }

    if (opType === "restore") {
        const lexData = await loadLex(true);
        const arg: string = kwargs.query ?? "";
        if (arg === "") {
            const count = lexData.recycle.length;
            if (count === 0) return "回收站为空，无词条可以恢复";
            lexData.work.push(...lexData.recycle);
            lexData.recycle = [];
            await saveLex(lexData);
            return `成功恢复${count}条词条（保留原始ID）`;
        }
        const parsed = parseTarget(arg);
        let targetItem: any = null;
        if (parsed.type === "id") {
            const targetId = parsed.value as number;
            targetItem = lexData.recycle.find(it => it.id === targetId);
            if (!targetItem) return `回收站中未找到ID:${targetId}的词条`;
        } else {
            const targetWord = parsed.value as string;
            targetItem = lexData.recycle.find(it => {
                const k = Object.keys(it).filter(kk => kk !== "id")[0];
                return k === targetWord;
            });
            if (!targetItem) return `回收站中未找到触发词【${targetWord}】的词条`;
        }
        const idx = lexData.recycle.indexOf(targetItem);
        lexData.recycle.splice(idx, 1);
        lexData.work.push(targetItem);
        await saveLex(lexData);
        const key = Object.keys(targetItem).filter(k => k !== "id")[0];
        return `成功恢复词条ID${targetItem.id}，触发词：${key}`;
    }

    if (opType === "reset") {
        const lexData = await loadLex(true);
        const builtIn = lexData.work.find(x => x.id === 0);
        const rest = lexData.work.filter(x => x.id !== 0);
        lexData.maxId = 0;
        for (const item of rest) {
            item.id = ++lexData.maxId;
        }
        lexData.work = builtIn ? [builtIn, ...rest] : rest;
        await saveLex(lexData);
        return `ID重整完成！共${lexData.work.length}条词条，ID重新从1开始连续排序`;
    }

    if (opType === "edit_name") {
        const targetRaw: string = kwargs.target;
        const newName: string = kwargs.new_name;
        if (targetRaw === undefined || !newName) return "缺少参数 target、new_name；target示例：#3 / 旧触发词";
        const lexData = await loadLex(true);
        const parsed = parseTarget(targetRaw);

        let targetItem: any = null;
        if (parsed.type === "id") {
            const tid = parsed.value as number;
            targetItem = lexData.work.find(it => it.id === tid);
            if (!targetItem) return `未找到ID:${tid}的词条（回收站词条请先恢复）`;
        } else {
            const oldWord = parsed.value as string;
            targetItem = lexData.work.find(it => {
                const k = Object.keys(it).filter(kk => kk !== "id")[0];
                return k === oldWord;
            });
            if (!targetItem) return `未找到触发词【${oldWord}】的词条（回收站词条请先恢复）`;
        }

        if (targetItem.id === 0) return "禁止修改内置词条(id=0)";
        const oldKey = Object.keys(targetItem).filter(k => k !== "id")[0];
        if (oldKey === newName) return "新触发词与旧触发词相同，无需修改";
        const existOther = lexData.work.some(it => !!it[newName]);
        if (existOther) return `触发词【${newName}】已存在其他词条，不能修改`;

        targetItem[newName] = targetItem[oldKey];
        delete targetItem[oldKey];
        await saveLex(lexData);
        return `修改成功！ID${targetItem.id}：【${oldKey}】 →【${newName}】`;
    }

    if (opType === "edit_mode") {
        const targetRaw: string = kwargs.target;
        const newModeRaw: string = kwargs.new_mode;
        if (targetRaw === undefined || newModeRaw === undefined) return "缺少参数 target、new_mode；target:#3/触发词，new_mode:\"1\"精准/\"0\"模糊";
        const newMode = Number(newModeRaw);
        if (![0, 1].includes(newMode)) return "new_mode只能是字符串\"1\"(精准) 或 \"0\"(模糊)";

        const lexData = await loadLex(true);
        const parsed = parseTarget(targetRaw);

        let targetItem: any = null;
        if (parsed.type === "id") {
            const tid = parsed.value as number;
            targetItem = lexData.work.find(it => it.id === tid);
            if (!targetItem) return `未找到ID:${tid}的词条（回收站词条请先恢复）`;
        } else {
            const word = parsed.value as string;
            targetItem = lexData.work.find(it => {
                const k = Object.keys(it).filter(kk => kk !== "id")[0];
                return k === word;
            });
            if (!targetItem) return `未找到触发词【${word}】的词条（回收站词条请先恢复）`;
        }

        if (targetItem.id === 0) return "禁止修改内置词条(id=0)";
        const key = Object.keys(targetItem).filter(k => k !== "id")[0];
        const rule = targetItem[key];
        const oldMode = rule.s;
        if (oldMode === newMode) return `该词条已经是${newMode === 1 ? "精准" : "模糊"}模式，无需修改`;
        rule.s = newMode;
        await saveLex(lexData);
        return `模式修改成功！ID${targetItem.id}【${key}】：${oldMode === 1 ? "精准" : "模糊"} → ${newMode === 1 ? "精准" : "模糊"}`;
    }

    return "未知操作类型";
}
         
// 文件base64处理
async function getUrlBase64(
    rawStr: string
): Promise<string> {
    // file
    if (rawStr.startsWith("file://")) {
        if (typeof window !== "undefined") {
            console.error("浏览器环境不支持 file:// 协议文件读取");
            return "";
        }

        let filePath = decodeURIComponent(rawStr.replace(/^file:\/\//, ""));
        // Windows file:///C:/xxx 去除开头多余斜杠
        if (/^\/[A-Za-z]:\//.test(filePath)) {
            filePath = filePath.slice(1);
        }

        try {
            const buf = await fs.readFile(filePath);
            return buf.toString("base64");
        } catch (err) {
            console.error("读取file://本地文件失败:", err);
            return "";
        }
    }
    // http / https
    let url = rawStr;
    const i1 = url.indexOf("http");
    const i2 = url.indexOf("http", i1 + 1);
    if (i2 !== -1) {
        url = url.slice(0, i2) + encodeURIComponent(url.slice(i2));
    }
    console.log("请求地址:", url);

    const ctl = new AbortController();
    const t = safeSetTimeout(() => ctl.abort(), 60000);

    try {
        const headers: Record<string, string> = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36"
        };
        const opt: RequestInit = {
            method: "GET",
            signal: ctl.signal,
            headers
        };

        const res = await fetch(url, opt);
        if (!res.ok) {
            console.error(`资源请求失败，HTTP状态码：${res.status}`);
            return "";
        }
        const arrayBuf = await res.arrayBuffer();
        const buf = Buffer.from(arrayBuf);
        return buf.toString("base64");
    } catch (err) {
        console.error("获取资源二进制异常:", err);
        return "";
    } finally {
        safeClearTimeout(t);
    }
}

// JSON处理变量
export async function jsonConvert(
    jsonInput: string | JsonValue, outputType: "text" | "image" = "text", keyMapping: KeyMappingInput = null
) {
    const DEFAULT_CONFIG = {
        canvasMargin: 20,
        maxCanvasWidth: 900,
        canvasBg: "#f7f8fa",
        fontSize: 14,
        fontFamily: "Microsoft YaHei",
        paddingX: 12,
        paddingY: 8,
        itemSpacing: 10,
        indent: 24,
        keyValueSpacing: 12,
        borderRadius: 8,
        lineHeight: 20,
        image: {
            fixedWidth: 400,
            padding: 6,
            timeout: 5000,
            hideKeyWhenImage: true,
            loadFailedText: "[图片加载失败]",
        },
        colors: {
            defaultText: "#333333",
            keyTextColor: "#1967d2",
            linkBlue: "#1565c0",
            numberGreen: "#0b8043",
            truePink: "#d93025",
            falseNullGray: "#5f6368",
            valueBlockBg: "#ffffff",
            keyBlockBg: "#e8f0fe",
            objectBlockBg: "#fef7e0",
            objectBlockBorder: "#f5db5b",
            arrayBlockBg: "#e6f4ea",
            arrayBlockBorder: "#34a853",
        },
    };

    let rawData: JsonValue;
    if (typeof jsonInput === "string") {
        try {
            rawData = JSON.parse(jsonInput);
        } catch (e) {
            throw new Error(`JSON解析失败: ${(e as Error).message}`);
        }
    } else {
        rawData = jsonInput;
    }

    let mappingDict: Record<string, string> | null = null;
    if (keyMapping) {
        if (typeof keyMapping === "object") {
            mappingDict = keyMapping;
        } else {
            const map: Record<string, string> = {};
            keyMapping.split(",").forEach((item) => {
                const s = item.trim();
                if (!s || !s.includes("=")) return;
                const [k, v] = s.split("=", 2).map((i) => i.trim());
                map[k] = v;
            });
            mappingDict = map;
        }
    }

    const preprocessData = (data: JsonValue): JsonValue => {
        if (Array.isArray(data)) {
            return data.map(item => preprocessData(item));
        }
        if (typeof data === "object" && data !== null) {
            const res: Record<string, JsonValue> = {};
            for (const [k, v] of Object.entries(data)) {
                if (mappingDict?.[k] === "") continue;
                const newKey = mappingDict?.[k] ?? k;
                res[newKey] = preprocessData(v);
            }
            return res;
        }
        return data;
    };

    const processedData = preprocessData(rawData);

    const formatValue = (val: JsonValue): string => {
        if (val === null) return "null";
        if (typeof val === "boolean") return val ? "true" : "false";
        if (typeof val === "number") return String(val);
        return String(val);
    };

    const isImageUrl = (text: unknown): boolean => {
        if (typeof text !== "string") return false;
        const lower = text.toLowerCase().trim();
        const suffix = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];
        return suffix.some(e => lower.endsWith(e));
    };

    // 新增：识别http/https链接
    const isLinkText = (text: string): boolean => {
        const t = text.trim().toLowerCase();
        return t.startsWith("http://") || t.startsWith("https://") || t.startsWith("www.");
    };

    // 文本树缩进：1空格
    const buildTextTree = (data: JsonValue, indent: number): string[] => {
        const lines: string[] = [];
        const space = " ".repeat(indent);
        if (Array.isArray(data)) {
            if (data.length === 0) return [`${space}空数组`];
            data.forEach(item => {
                if (Array.isArray(item) || (typeof item === "object" && item)) {
                    lines.push(`${space}- `);
                    lines.push(...buildTextTree(item, indent + 1));
                } else {
                    lines.push(`${space}- ${formatValue(item)}`);
                }
            });
        } else if (typeof data === "object" && data) {
            const obj = data as Record<string, JsonValue>;
            if (Object.keys(obj).length === 0) return [`${space}空对象`];
            for (const [k, v] of Object.entries(obj)) {
                const hideKey = mappingDict?.[k] === "/";
                if (Array.isArray(v) || (typeof v === "object" && v)) {
                    if (hideKey) {
                        lines.push(...buildTextTree(v, indent));
                    } else {
                        lines.push(`${space}${k}:`);
                        lines.push(...buildTextTree(v, indent + 1));
                    }
                } else {
                    const str = formatValue(v);
                    lines.push(hideKey ? `${space}${str}` : `${space}${k}: ${str}`);
                }
            }
        } else {
            lines.push(`${space}${formatValue(data)}`);
        }
        return lines;
    };

    // skia-canvas 原生依赖不可用时，image 输出自动降级为文本（不报错、不阻塞）
    const skiaNS = await getSkia();
    if (outputType === "image" && !skiaNS) {
        const lines = buildTextTree(processedData, 0);
        return lines.join("\n") + "\n（skia-canvas 不可用，已降级为文本输出）";
    }

    if (outputType === "text") {
        const lines = buildTextTree(processedData, 0);
        return lines.join("\n");
    }

    const loadNetworkImage = async (url: string, timeout: number): Promise<SkiaImage | null> => {
        const controller = new AbortController();
        const timer = safeSetTimeout(() => controller.abort(), timeout);
        try {
            const res = await fetch(url, {
                signal: controller.signal,
                headers: {
                    "User-Agent": "Mozilla/5.0 Node.js Canvas Bot",
                },
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const arrayBuf = await res.arrayBuffer();
            const buf = Buffer.from(arrayBuf);
            const img = new skiaNS!.Image();
            img.src = buf;
            return img;
        } catch {
            return null;
        } finally {
            safeClearTimeout(timer);
        }
    };

    // 文本自动换行分割
    function wrapText(ctx: SkiaCtx, text: string, maxW: number): string[] {
        const words = Array.from(text);
        const lines: string[] = [];
        let current = "";
        for (const char of words) {
            const test = current + char;
            if (ctx.measureText(test).width > maxW && current) {
                lines.push(current);
                current = char;
            } else {
                current = test;
            }
        }
        if (current) lines.push(current);
        return lines;
    }

    let allElements: DrawElement[] = [];
    const calcLayout = async (data: JsonValue, x: number, y: number, maxWidth: number, ctxRef: SkiaCtx) => {
        const elements: DrawElement[] = [];
        const { paddingX, paddingY, itemSpacing, indent, keyValueSpacing, borderRadius, colors, image: imgCfg, fontSize, lineHeight } = DEFAULT_CONFIG;
        const availableW = Math.max(maxWidth - paddingX * 2, 50);

        if (Array.isArray(data)) {
            let currY = y + paddingY;
            let maxW = 0;
            for (const item of data) {
                const res = await calcLayout(item, x + paddingX, currY, availableW - indent, ctxRef);
                elements.push(...res.elements);
                maxW = Math.max(maxW, res.contentWidth);
                currY = res.endY + itemSpacing;
            }
            const boxW = Math.max(maxW + paddingX * 2, 100);
            const boxH = currY - y - itemSpacing + paddingY;
            elements.unshift({
                type: "block",
                x,
                y,
                width: boxW,
                height: boxH,
                bgColor: colors.arrayBlockBg,
                borderColor: colors.arrayBlockBorder,
                radius: borderRadius,
            });
            return { endY: y + boxH, contentWidth: boxW, elements };
        }
        if (typeof data === "object" && data !== null) {
            const obj = data as Record<string, JsonValue>;
            let currY = y + paddingY;
            let maxW = 0;
            for (const [key, val] of Object.entries(obj)) {
                const hideKey = mappingDict?.[key] === "/";
                const isImgVal = isImageUrl(val) && imgCfg.hideKeyWhenImage;
                if (hideKey || isImgVal) {
                    const res = await calcLayout(val, x + paddingX, currY, availableW, ctxRef);
                    elements.push(...res.elements);
                    maxW = Math.max(maxW, res.contentWidth);
                    currY = res.endY + itemSpacing;
                    continue;
                }
                // 真实测量key宽度
                ctxRef.font = `${fontSize}px ${DEFAULT_CONFIG.fontFamily}`;
                const keyW = ctxRef.measureText(key).width;
                const keyBoxW = keyW + paddingX * 2;

                const valRes = await calcLayout(val, x + paddingX + keyBoxW + keyValueSpacing, currY, availableW - keyBoxW - keyValueSpacing, ctxRef);
                elements.push(...valRes.elements);
                elements.push({
                    type: "block",
                    x: x + paddingX,
                    y: currY,
                    width: keyBoxW,
                    height: fontSize + paddingY,
                    bgColor: colors.keyBlockBg,
                    radius: borderRadius,
                });
                elements.push({
                    type: "text",
                    x: x + paddingX + paddingX / 2,
                    y: currY,
                    text: key,
                    fill: colors.keyTextColor,
                });
                const lineW = keyBoxW + keyValueSpacing + valRes.contentWidth;
                maxW = Math.max(maxW, lineW);
                currY = Math.max(currY + fontSize + paddingY, valRes.endY) + itemSpacing;
            }
            const boxW = Math.max(maxW + paddingX * 2, 100);
            const boxH = currY - y - itemSpacing + paddingY;
            elements.unshift({
                type: "block",
                x,
                y,
                width: boxW,
                height: boxH,
                bgColor: colors.objectBlockBg,
                borderColor: colors.objectBlockBorder,
                radius: borderRadius,
            });
            return { endY: y + boxH, contentWidth: boxW, elements };
        }

        let textStr = formatValue(data);
        let drawImg: SkiaImage | null = null;
        if (isImageUrl(textStr)) {
            drawImg = await loadNetworkImage(textStr, DEFAULT_CONFIG.image.timeout);
            if (!drawImg) textStr = DEFAULT_CONFIG.image.loadFailedText;
        }
        if (drawImg) {
            const scale = DEFAULT_CONFIG.image.fixedWidth / drawImg.width;
            const imgH = drawImg.height * scale;
            const boxW = DEFAULT_CONFIG.image.fixedWidth + DEFAULT_CONFIG.image.padding * 2;
            const boxH = imgH + DEFAULT_CONFIG.image.padding * 2;
            elements.push({
                type: "block",
                x,
                y,
                width: boxW,
                height: boxH,
                bgColor: DEFAULT_CONFIG.colors.valueBlockBg,
                radius: DEFAULT_CONFIG.borderRadius,
            });
            elements.push({
                type: "image",
                x: x + DEFAULT_CONFIG.image.padding,
                y: y + DEFAULT_CONFIG.image.padding,
                width: DEFAULT_CONFIG.image.fixedWidth,
                height: imgH,
                img: drawImg,
            });
            return { endY: y + boxH, contentWidth: boxW, elements };
        }

        // 长文本自动换行
        ctxRef.font = `${fontSize}px ${DEFAULT_CONFIG.fontFamily}`;
        const textLines = wrapText(ctxRef, textStr, availableW - paddingX * 2);
        const totalTextH = textLines.length * lineHeight;
        const lineMaxW = Math.max(...textLines.map(l => ctxRef.measureText(l).width));

        let textColor = DEFAULT_CONFIG.colors.defaultText;
        const lower = textStr.toLowerCase();
        // 链接颜色优先
        if (isLinkText(textStr)) {
            textColor = DEFAULT_CONFIG.colors.linkBlue;
        } else if (lower === "null") {
            textColor = DEFAULT_CONFIG.colors.falseNullGray;
        } else if (["false", "no", "否"].includes(lower)) {
            textColor = DEFAULT_CONFIG.colors.falseNullGray;
        } else if (["true", "yes", "是"].includes(lower)) {
            textColor = DEFAULT_CONFIG.colors.truePink;
        } else if (/^-?\d+(\.\d+)?$/.test(textStr)) {
            textColor = DEFAULT_CONFIG.colors.numberGreen;
        }

        const boxW = lineMaxW + paddingX * 2;
        const boxH = totalTextH + paddingY * 2;
        elements.push({
            type: "block",
            x,
            y,
            width: boxW,
            height: boxH,
            bgColor: DEFAULT_CONFIG.colors.valueBlockBg,
            radius: DEFAULT_CONFIG.borderRadius,
        });
        elements.push({
            type: "text",
            x: x + paddingX,
            y: y + paddingY,
            text: textStr,
            lines: textLines,
            fill: textColor,
        });
        return { endY: y + boxH, contentWidth: boxW, elements };
    };

    // 临时canvas预测量文本
    const tempCanvas = new skiaNS!.Canvas(DEFAULT_CONFIG.maxCanvasWidth, 2000);
    const tempCtx = tempCanvas.getContext("2d");
    tempCtx.font = `${DEFAULT_CONFIG.fontSize}px ${DEFAULT_CONFIG.fontFamily}`;
    const layoutResult = await calcLayout(processedData, DEFAULT_CONFIG.canvasMargin, DEFAULT_CONFIG.canvasMargin, DEFAULT_CONFIG.maxCanvasWidth - DEFAULT_CONFIG.canvasMargin * 2, tempCtx);
    allElements = layoutResult.elements;

    const cw = Math.min(DEFAULT_CONFIG.maxCanvasWidth, layoutResult.contentWidth + DEFAULT_CONFIG.canvasMargin * 2);
    const ch = layoutResult.endY + DEFAULT_CONFIG.canvasMargin;

    const canvas = new skiaNS!.Canvas(Math.max(cw, 200), Math.max(ch, 200));
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = DEFAULT_CONFIG.canvasBg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 1.绘制所有block
    for (const el of allElements) {
        if (el.type === "block") {
            ctx.beginPath();
            ctx.roundRect(el.x, el.y, el.width!, el.height!, el.radius!);
            ctx.fillStyle = el.bgColor!;
            ctx.fill();
            if (el.borderColor) {
                ctx.strokeStyle = el.borderColor;
                ctx.lineWidth = 2;
                ctx.stroke();
            }
        }
    }

    // 2.绘制图片
    for (const el of allElements) {
        if (el.type === "image" && el.img) {
            ctx.drawImage(el.img, el.x, el.y, el.width!, el.height!);
        }
    }

    // 3.文字渲染核心：Key居中｜单行value居中｜多行value顶部左对齐
    ctx.font = `${DEFAULT_CONFIG.fontSize}px ${DEFAULT_CONFIG.fontFamily}`;
    ctx.textBaseline = "top";
    for (const el of allElements) {
        if (el.type !== "text") continue;
        ctx.fillStyle = el.fill!;
        const baseY = el.y!;
        const lines = el.lines && el.lines.length > 0 ? el.lines : [el.text!];
        const isKeyText = el.fill === DEFAULT_CONFIG.colors.keyTextColor;

        if (isKeyText) {
            // Key蓝底块内垂直居中
            const parentBlock = allElements.find(b =>
                b.type === "block" &&
                b.bgColor === DEFAULT_CONFIG.colors.keyBlockBg &&
                b.x <= el.x! &&
                b.y <= el.y! &&
                (b.x + b.width!) >= el.x! &&
                (b.y + b.height!) >= el.y!
            );
            const centerY = parentBlock
                ? parentBlock.y! + (parentBlock.height! - DEFAULT_CONFIG.fontSize) / 2
                : baseY;
            ctx.fillText(el.text!, el.x!, centerY);
        } else {
            const lineCount = lines.length;
            if (lineCount === 1) {
                // 单行value居中
                const parentBlock = allElements.find(b =>
                    b.type === "block" &&
                    b.bgColor === DEFAULT_CONFIG.colors.valueBlockBg &&
                    b.x <= el.x! &&
                    b.y <= el.y! &&
                    (b.x + b.width!) >= el.x! &&
                    (b.y + b.height!) >= el.y!
                );
                const centerY = parentBlock
                    ? parentBlock.y! + (parentBlock.height! - DEFAULT_CONFIG.fontSize) / 2
                    : baseY;
                ctx.fillText(lines[0], el.x!, centerY);
            } else {
                // 多行value顶部顺序排布
                lines.forEach((line, idx) => {
                    const lineY = baseY + idx * DEFAULT_CONFIG.lineHeight;
                    ctx.fillText(line, el.x!, lineY);
                });
            }
        }
    }

    const buf = await canvas.toBuffer("png");
    const base64Str = `${buf.toString("base64")}`;
    return base64Str;
}

// 请求变量
async function req(
    rawStr: string,
    method: "GET" | "POST" = "GET",
    postData?: Record<string, unknown>
): Promise<string> {
    let url = rawStr;
    const i1 = url.indexOf("http"), i2 = url.indexOf("http", i1 + 1);
    if (i2 !== -1) url = url.slice(0, i2) + encodeURIComponent(url.slice(i2));

    const ctl = new AbortController();
    const t = safeSetTimeout(() => ctl.abort(), 60000);
    try {
        const headers: Record<string, string> = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36"
        };
        const opt: RequestInit = {
            method,
            signal: ctl.signal,
            headers
        };
        if (method === "POST" && postData) {
            headers["Content-Type"] = "application/json";
            opt.body = JSON.stringify(postData);
        }
        const res = await fetch(url, opt);
        return (await res.text()).trim();
    } catch {
        return "";
    } finally {
        safeClearTimeout(t);
    }
}

// 积分变量
async function coins_operation(
    selfId: string,
    group: string,
    user: string,
    change: string,
    type: string,
    note: string = ""
): Promise<string> {
    const lexPath = path.join(PLUGIN_DATA, String(selfId), "data.json");
    let coins_data: CoinStorage;

    try {
        const raw = await fileCacheIO(lexPath, "r", undefined, true) as Partial<CoinStorage>;
        coins_data = { work: Array.isArray(raw.work) ? raw.work : [] };
    } catch {
        coins_data = { work: [] };
    }

    if (["list", "list_top", "list_bottom"].includes(change)) {
        let list = coins_data.work.filter(item => item.type === type);
        if (group !== "0") list = list.filter(item => item.group === group);

        const getNum = (it: CoinItem) => {
            const s = String(it.data).trim();
            return /^\d+$/.test(s) ? Number(s) : 0;
        };

        if (change === "list" || change === "list_top") {
            list.sort((a, b) => getNum(b) - getNum(a));
        } else {
            list.sort((a, b) => getNum(a) - getNum(b));
        }

        if (change === "list_top") {
            const rankList: CoinRankItem[] = list.map((item, idx) => ({ ...item, rank: idx + 1 }));
            return JSON.stringify(rankList);
        }

        const lines = list.map((item, idx) => {
            const name = item.note ?? item.user;
            return `${idx + 1}. ${name} ｜ ${item.data}`;
        });
        return lines.join("\n");
    }

    if (change === "0") {
        const target = coins_data.work.find(i => i.group === group && i.type === type && i.user === user);
        return String(target?.data ?? "0");
    }

    // 写操作加 per-file 锁：锁内重读最新数据再修改并写回，串行化防止并发覆盖
    return withFileLock(lexPath, async () => {
        let fresh: CoinStorage;
        try {
            const raw = await fileCacheIO(lexPath, "r", undefined, true) as Partial<CoinStorage>;
            fresh = { work: Array.isArray(raw.work) ? raw.work : [] };
        } catch {
            fresh = { work: [] };
        }

        let assignMode = false, appendMode = false, removeMode = false;
        let returnChange = change;
        let coinsChange = 0;

        const now = new Date();
        const pad = (n: number) => n.toString().padStart(2, "0");
        const uptime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

        if (change.startsWith("||") && change.endsWith("||")) {
            returnChange = change.slice(2, -2);
            assignMode = true;
        } else if (change.startsWith("++")) {
            returnChange = change.slice(2).trim();
            appendMode = true;
        } else if (change.startsWith("--")) {
            returnChange = change.slice(2).trim();
            removeMode = true;
        } else if (/^[+-]\d+$/.test(change)) {
            const num = parseInt(change.slice(1), 10);
            coinsChange = change.startsWith("+") ? num : -num;
        } else {
            throw new Error(`错误参数：${change}`);
        }

        let updated = false;
        const targetItem = fresh.work.find(i => i.group === group && i.type === type && i.user === user);

        if (targetItem) {
            if (assignMode) {
                targetItem.data = returnChange;
            } else if (appendMode) {
                const list = String(targetItem.data).trim() ? String(targetItem.data).split(",") : [];
                if (!list.includes(returnChange)) list.push(returnChange);
                targetItem.data = list.join(",");
                returnChange = targetItem.data;
            } else if (removeMode) {
                const list = String(targetItem.data).trim() ? String(targetItem.data).split(",") : [];
                const idx = list.indexOf(returnChange);
                if (idx > -1) list.splice(idx, 1);
                targetItem.data = list.join(",");
                returnChange = targetItem.data;
            } else {
                const init = Number(targetItem.data);
                targetItem.data = Number.isFinite(init) ? init + coinsChange : coinsChange;
            }
            targetItem.uptime = uptime;
            if (note) targetItem.note = note;
            updated = true;
        }

        if (!updated) {
            let itemData: string | number;
            if (assignMode) itemData = returnChange;
            else if (appendMode) itemData = returnChange;
            else if (removeMode) itemData = "";
            else itemData = coinsChange;
            fresh.work.push({
                group,
                type,
                user,
                data: itemData,
                note: note || undefined,
                uptime
            });
        }

        await fileCacheIO(lexPath, "w", fresh);
        return returnChange;
    });
}


// 加载该机器人的所有变量标签 name 覆盖（存于 data.json，type 前缀 VNAME:）
async function loadVNameOverrides(selfId: string): Promise<Map<string, string>> {
    const dataPath = path.join(PLUGIN_DATA, String(selfId), "data.json");
    const overrides = new Map<string, string>();
    try {
        const raw = await fileCacheIO(dataPath, "r", undefined, true) as Partial<CoinStorage>;
        const work = Array.isArray(raw.work) ? raw.work : [];
        for (const item of work) {
            if (item.type.startsWith("VNAME:") && item.group === "0" && item.user === "0") {
                const key = item.type.slice(6);
                const val = String(item.data ?? "").trim();
                if (val) overrides.set(key, val);
            }
        }
    } catch {
        // 无数据文件时返回空 Map
    }
    return overrides;
}

// 加载该机器人的自定义别名（data.json 里 type 前缀 ALIAS:，data 为 JSON 字符串）
async function loadCustomAliases(selfId: string): Promise<Record<string, any>> {
    const dataPath = path.join(PLUGIN_DATA, String(selfId), "data.json");
    const aliases: Record<string, any> = {};
    try {
        const raw = await fileCacheIO(dataPath, "r", undefined, true) as Partial<CoinStorage>;
        const work = Array.isArray(raw.work) ? raw.work : [];
        for (const item of work) {
            if (item.type.startsWith("ALIAS:") && item.group === "0" && item.user === "0") {
                const key = item.type.slice(6);
                try {
                    aliases[key] = JSON.parse(String(item.data));
                } catch {
                    // 解析失败跳过
                }
            }
        }
    } catch {
        // 无数据文件时返回空对象
    }
    return aliases;
}

// 存文件变量
export async function saveFile(
    selfId: string, url: string
): Promise<string> {
    const saveFolder = path.join(PLUGIN_DATA, selfId, "filedata");
    await fs.mkdir(saveFolder, { recursive: true });

    let maxNum = 0;
    try {
        const entries = await fs.readdir(saveFolder);
        for (const name of entries) {
            const base = path.parse(name).name;
            if (/^\d+$/.test(base)) {
                const num = parseInt(base, 10);
                if (num > maxNum) maxNum = num;
            }
        }
    } catch { }
    const fileNum = maxNum + 1;

    const mimeMap: Record<string, string> = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/gif": ".gif",
        "image/webp": ".webp",
        "image/bmp": ".bmp",
        "text/plain": ".txt",
        "application/json": ".json",
        "application/octet-stream": ".bin",
        "audio/mpeg": ".mp3",
        "audio/wav": ".wav",
        "audio/ogg": ".ogg",
        "audio/flac": ".flac",
        "audio/aac": ".aac",
        "video/mp4": ".mp4",
        "video/mpeg": ".mpeg",
        "video/ogg": ".ogv",
        "video/webm": ".webm",
        "video/x-msvideo": ".avi"
    };
    let ext = ".txt";
    let savePath = "";
    let filename = "";

    try {
        const controller = new AbortController();
        const timeoutId = safeSetTimeout(() => controller.abort(), 15000);
        const res = await fetch(url, { redirect: "follow", signal: controller.signal });
        safeClearTimeout(timeoutId);

        if (!res.ok) throw new Error(`HTTP status ${res.status}`);
        const contentType = res.headers.get("content-type") ?? "";
        const ct = contentType.split(";")[0].trim().toLowerCase();
        ext = mimeMap[ct] ?? ".txt";

        filename = `${fileNum}${ext}`;
        savePath = path.join(saveFolder, filename);
        if (!res.body) throw new Error("response body empty");

        const writeStream = createWriteStream(savePath);
        const reader = res.body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            writeStream.write(value);
        }
        await new Promise<void>((resolve, reject) => writeStream.end((err: any) => err ? reject(err) : resolve()));
    } catch {
        filename = `${fileNum}_fail.txt`;``
        savePath = path.join(saveFolder, filename);
        await fs.writeFile(savePath, `${url}`, "utf-8");
    }

    console.log(savePath);
    return `file://PLUGIN_DATA/${selfId}/filedata/${filename}`;
}

// 判断变量
async function judge(
    text: string
): Promise<boolean> {
    const BOOL_TRUE = '{_BOOL_TRUE_}';
    const BOOL_FALSE = '{_BOOL_FALSE_}';
    const strip_quotes = (x: string): string => {
        x = x.trim();
        if (x.length >= 2) {
            const f = x[0];
            const l = x.at(-1)!;
            if ((f === "'" || f === '"') && f === l) return x.slice(1, -1).trim();
        }
        return x;
    };

    const check_single = (singleCond: string): CheckResult => {
        let s = singleCond.slice(1, -1).trim().replace(/\s+/g, ' ');
        if (!s) return [false, false];
        if (s === '_BOOL_TRUE_') return [true, true];
        if (s === '_BOOL_FALSE_') return [true, false];
        s = s.replace(/notin/gi, 'not in');

        const notInReg = /^(.+?)\s*not\s*in\s*(.+)$/i;
        const nm = s.match(notInReg);
        if (nm) {
            const v = strip_quotes(nm[1]);
            try {
                const arr = nm[2].split(',').map(item => strip_quotes(item)).filter(Boolean);
                return [true, arr.length ? !arr.includes(v) : true];
            } catch {
                return [false, false];
            }
        }

        const inReg = /^(.+?)\s*in\s*(.+)$/i;
        const im = s.match(inReg);
        if (im) {
            const v = strip_quotes(im[1]);
            try {
                const arr = im[2].split(',').map(item => strip_quotes(item)).filter(Boolean);
                return [true, arr.length ? arr.includes(v) : false];
            } catch {
                return [false, false];
            }
        }

        const opM = s.match(/(!=|>=|<=|==|>|<|=)/);
        if (opM) {
            const op = opM[1];
            const idx = opM.index!;
            const a = strip_quotes(s.slice(0, idx));
            const b = strip_quotes(s.slice(idx + op.length));
            const realOp = op === '=' ? '==' : op;
            if (realOp === '==') return [true, a === b];
            if (realOp === '!=') return [true, a !== b];
            try {
                const fa = parseFloat(a);
                const fb = parseFloat(b);
                if (realOp === '>') return [true, fa > fb];
                if (realOp === '<') return [true, fa < fb];
                if (realOp === '>=') return [true, fa >= fb];
                if (realOp === '<=') return [true, fa <= fb];
            } catch {
                return [false, false];
            }
        }
        return [false, false];
    };

    const calc_expr = (expr: string): boolean => {
        while (expr.includes('(')) {
            const bk = expr.match(/\(([^()]+)\)/) as any;
            if (!bk) break;
            const r = calc_expr(bk[1]);
            expr = expr.slice(0, bk.index) + (r ? BOOL_TRUE : BOOL_FALSE) + expr.slice(bk.index + bk[0].length);
        }
        // 兼容简写：无花括号且无 &| 时视为单个判断（如 [judge.1=0] / [judge.2in2] / [judge.a not in b]）
        if (!/\{/.test(expr) && !/[&|]/.test(expr)) {
            const [ok, val] = check_single("{" + expr.trim() + "}");
            return ok ? val : false;
        }
        const tokens = expr.match(/\{[^{}]+\}|[&|]/g) || [];
        if (!tokens.length) return false;
        const vals: boolean[] = [];
        const ops: string[] = [];
        for (const t of tokens) {
            if (t === '&' || t === '|') ops.push(t);
            else {
                const [ok, val] = check_single(t);
                if (!ok) return false;
                vals.push(val);
            }
        }
        if (ops.length !== vals.length - 1) return false;
        let i = 0;
        while (i < ops.length) {
            if (ops[i] === '&') {
                vals[i] = vals[i] && vals[i + 1];
                vals.splice(i + 1, 1);
                ops.splice(i, 1);
            } else i++;
        }
        return vals.some(Boolean);
    };

    let res = false;
    try { res = calc_expr(text); } catch {}
    return res;
}

// 分段变量
async function clauseTask(
    text: string, 
    bot: BaseAdapter, 
    event: BotEvent
): Promise<void> {
    const sleep = (s: number) => new Promise(resolve => safeSetTimeout(resolve, s * 1000));
    const send = async (msg: string) => {
        const params = event.groupId && event.groupId !== 0 
            ? { group_id: event.groupId, message: msg } 
            : { user_id: event.userId, message: msg };
        await bot.callApi("send_msg", params);
    };
    const numReg = /\[分段\.(\d+)\]/g;
    const nums = [...text.matchAll(numReg)].map(m => Number(m[1]));
    const parts = text.split(/\[分段\.\d+\]/);
    const texts = parts.map(s => s.trim()).filter(Boolean);
    const times = parts.at(-1) === '' ? nums.slice(0, -1) : nums;
    const max = Math.min(texts.length, times.length);
    for (let i = 0; i < max; i++) {
        const message = await parseBracketStr(texts[i], bot, event) as any;
        await send(message);
        await sleep(times[i]);
    }
    if (texts.length) {
        const lastMsg = await parseBracketStr(texts.at(-1)!, bot, event) as any;
        await send(lastMsg);
    }
}

// 结构变量
async function getValue(
    text: string
): Promise<string> {
    const reg = /(\[|【)[^.]+?\.(.+?)(\]|】)/;
    const match = text.match(reg);
    return match ? match[2] : text;
}

// 任务变量
// 任务文件按机器人(selfId)隔离存放
function taskFilePath(selfId: string): string {
    return path.join(PLUGIN_DATA, String(selfId), "task.json");
}
// 读取某机器人的任务列表（文件缺失/损坏时回退空列表）
async function readTaskList(selfId: string): Promise<TaskListObj> {
    try {
        const obj = await fileCacheIO(taskFilePath(selfId), "r") as Partial<TaskListObj>;
        return { work: Array.isArray(obj.work) ? obj.work : [] };
    } catch {
        return { work: [] };
    }
}
async function task_operation(
    selfId: string,
    op: string,
    params: any
): Promise<TaskListObj> {
    const filePath = taskFilePath(selfId);
    // 写操作加文件锁，串行化防止并发覆盖
    return withFileLock(filePath, async () => {
        const obj = await readTaskList(selfId);
        switch (op) {
            case "add": {
                // params 为完整任务对象（botId/groupId/userId/msg/time/cache）
                obj.work.push(params);
                await fileCacheIO(filePath, "w", obj);
                return obj;
            }

            case "del": {
                const num = Number(params);
                const index = num - 1;
                if (index >= 0 && index < obj.work.length) {
                    obj.work.splice(index, 1);
                }
                await fileCacheIO(filePath, "w", obj);
                return obj;
            }

            case "read": {
                return obj;
            }

            default:
                throw new Error("不支持的操作:" + op);
        }
    });
}

// [x.?]变量
interface XVarWait {
    selfId: string;
    targetId: string;
    uid: string;
    parts: Array<{ text: string; varN?: number; transform?: boolean }>;
    idx: number;      // 下一个待处理的 part 下标
    waitVar: number;  // 当前等待输入的变量号
    deadline: number; // 等待超时时间戳
    used: number[];   // 本次交互已使用的变量号（结束后清理）
    timer?: NodeJS.Timeout; // 超时自动清理定时器
}
const xWaitStates: Record<string, XVarWait> = {};
const X_WAIT_TIMEOUT = 3 * 60 * 1000;
async function clearXVars(selfId: string, targetId: string, uid: string, vars: number[]): Promise<void> {
    for (const n of vars) {
        await coins_operation(selfId, targetId, uid, `||||`, `X${n}`);
    }
}
async function handleXVar(bot: BaseAdapter, event: BotEvent, stateKey: string, template: string, input?: string): Promise<boolean> {
    const selfId = String(event.selfId ?? "");
    const uid = String(event.userId ?? "");
    const gid = String(event.groupId ?? "");
    const targetId = gid ? gid : uid;
    const target = gid ? { group_id: gid } : { user_id: uid };
    const send = async (out: string) => {
        if (!out.trim()) return;
        const segs = await parseBracketStr(out, bot, event);
        if (JSON.stringify(segs) !== "[]") await sendMsgCtx(bot, event, target, segs);
    };

    let state = xWaitStates[stateKey];
    if (!state) {
        // 新触发：按 [x.n] 切分模板
        const parts: Array<{ text: string; varN?: number; transform?: boolean }> = [];
        const regex = /\[x\.(\d+)(?:\.t)?\]/g;
        let lastIdx = 0;
        let m: RegExpExecArray | null;
        while ((m = regex.exec(template)) !== null) {
            if (m.index > lastIdx) parts.push({ text: template.slice(lastIdx, m.index) });
            const isTransform = m[0].endsWith(".t]");
            parts.push({ text: "", varN: Number(m[1]), transform: isTransform });
            lastIdx = m.index + m[0].length;
        }
        if (lastIdx < template.length) parts.push({ text: template.slice(lastIdx) });
        state = { selfId, targetId, uid, parts, idx: 0, waitVar: 0, deadline: Date.now() + X_WAIT_TIMEOUT, used: [] };
        xWaitStates[stateKey] = state;
    } else if (input !== undefined) {
        // 等待中输入续接：先判超时（正常情况下定时器已自动清理，此处仅防御）
        if (Date.now() > state.deadline) {
            if (state.timer) safeClearTimeout(state.timer);
            await clearXVars(state.selfId, state.targetId, state.uid, state.used);
            delete xWaitStates[stateKey];
            return false; // 超时作废：本次输入不接收
        }
        if (state.timer) safeClearTimeout(state.timer);
        await coins_operation(state.selfId, state.targetId, state.uid, `||${input}||`, `X${state.waitVar}`);
        if (!state.used.includes(state.waitVar)) state.used.push(state.waitVar);
    }

    // 从 state.idx 继续处理模板
    let out = "";
    let i = state.idx;
    while (i < state.parts.length) {
        const part = state.parts[i];
        if (part.varN === undefined) { out += part.text; i++; }
        else {
            const n = part.varN;
            const val = await coins_operation(state.selfId, state.targetId, state.uid, "0", `X${n}`);
            if (!val || val === "0") {
                // 无值：发送已累积内容，进入等待
                await send(out);
                state.idx = i + 1;
                state.waitVar = n;
                state.deadline = Date.now() + X_WAIT_TIMEOUT;
                // 重置超时定时器：3 分钟到点自动清理状态和已存值
                if (state.timer) safeClearTimeout(state.timer);
                state.timer = safeSetTimeout(() => {
                    if (xWaitStates[stateKey] === state) {
                        clearXVars(state.selfId, state.targetId, state.uid, state.used).then(() => {
                            if (xWaitStates[stateKey] === state) delete xWaitStates[stateKey];
                        });
                    }
                }, X_WAIT_TIMEOUT);
                return true;
            }
            out += part.transform ? await getValue(val) : val;
            if (!state.used.includes(n)) state.used.push(n);
            i++;
        }
    }
    // 整条模板处理完：发送剩余，清理状态和值
    if (state.timer) safeClearTimeout(state.timer);
    await send(out);
    await clearXVars(state.selfId, state.targetId, state.uid, state.used);
    delete xWaitStates[stateKey];
    return true;
}

// 待发消息处理
async function parseBracketStr(
    inputStr: string,
    bot: BaseAdapter,
    event: BotEvent
): Promise<MsgSegment[]> {
    const selfId = event.selfId ? String(event.selfId) : "";
    const userId = event.userId ? String(event.userId) : "";
    const groupId = event.groupId ? String(event.groupId) : "";
    const isGroupMsg = !!groupId;
    const sendTarget = () => (isGroupMsg ? { group_id: groupId } : { user_id: userId });
    inputStr = lexiconValue(inputStr);
    const cfg = await fileCacheIO(CONFIG_FILE_PATH, "r") as Record<string, any>;
    const vnameOverrides = await loadVNameOverrides(selfId);
    // 加载自定义别名并合并到 cfg.value（自定义覆盖默认）
    const customAliases = await loadCustomAliases(selfId);
    if (Object.keys(customAliases).length) {
        Object.assign(cfg.value, customAliases);
    }
    function getEffectiveName(typeKey: string, fallback: string): string {
        const override = vnameOverrides.get(typeKey);
        if (override) return override;
        return cfg.value?.[typeKey]?.name ?? fallback;
    }
    const OR_NAME = getEffectiveName("or", "或");
    const RANDOM_SEP = "[" + OR_NAME + "]";
    const SEGMENT_TAG = getEffectiveName("divide", "分段.{p1}").replace(/\.{p\d+}$/, "");
    function escapeRegStr(s: string): string {
        return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    function lexiconValue(text: string): string {
        text = text.replace("PLUGIN_DATA", PLUGIN_DATA);
        const reg = /\[lexicon\|([\s\S]*?)\|([01])\]/g;
        return text.replace(reg, (fullMatch, innerText, flag) => {
            const safeInner = innerText
                .replace(/\[/g, "［［")
                .replace(/\]/g, "］］");
            return `[lexicon|${safeInner}|${flag}]`;
        });
    }
    async function matchTemplateGetParams(tpl: string, content: string): Promise<string[] | null> {
        const varReg = /\{p(\d+)\}/g;
        const placeholders: number[] = [];
        let safeTpl = escapeRegStr(tpl);
        let matchItem: RegExpExecArray | null;
        while ((matchItem = varReg.exec(tpl)) !== null) {
            const num = Number(matchItem[1]);
            placeholders.push(num);
            safeTpl = safeTpl.replace(`\\{p${num}\\}`, "(.*?)");
        }
        const reg = new RegExp(`^${safeTpl}$`);
        const result = content.match(reg);
        if (!result) return null;
        const params: string[] = [];
        for (let i = 0; i < placeholders.length; i++) {
            params[placeholders[i]] = result[i + 1];
        }
        return params;
    }
    function getTypeTemplate(typeKey: string): Record<string, string> {
        const item = cfg.value?.[typeKey];
        if (!item || typeof item.name !== "string") throw new Error(`value.${typeKey} 模板缺失`);
        const override = vnameOverrides.get(typeKey);
        if (override) return { ...item, name: override };
        return item;
    }
    // 根据配置自动生成 key.{p1}.{p2}...
    function buildKeyTemplate(typeKey: string, tplObj: Record<string, string>): string {
        const pNums: number[] = [];
        Object.keys(tplObj).forEach(k => {
            const m = k.match(/^p(\d+)$/);
            if (m) pNums.push(Number(m[1]));
        });
        pNums.sort((a, b) => a - b);
        const parts = [typeKey, ...pNums.map(n => `{p${n}}`)];
        return parts.join(".");
    }
    async function resolveValue(raw: string): Promise<string> {
        if (/\[([^\[\]]+)\]/.test(raw)) {
            const processed = await replaceInner(raw);
            return processed.replace(/\{\{NODE:.*?\}\}/g, "");
        }
        return raw;
    }
    async function operation(text: string, alltext: string): Promise<MsgSegment | string | null> {
        const typeMap: Array<{
            key: string;
            build: (p: string[]) => Promise<MsgSegment | string> | MsgSegment | string;
        }> = [
            { key: "at", build: (p) => MessageSegment.at(p[1]).needs("at").fallbackTo(MessageSegment.text(`@${p[1]}`)) },
            { key: "reply", build: (p) => MessageSegment.reply(p[1]).needs("reply").fallbackTo(MessageSegment.text("[回复消息]")) },
            { key: "face", build: (p) => MessageSegment.face(p[1]).needs("face").fallbackTo(MessageSegment.text("[表情]")) },
            { key: "image", build: async (p) => MessageSegment.image(`base64://${await getUrlBase64(p.slice(1).join("."))}`).needs("image").fallbackTo(MessageSegment.text("[图片]")) },
            { key: "record", build: async (p) => MessageSegment.record(`base64://${await getUrlBase64(p.slice(1).join("."))}`).needs("record").fallbackTo(MessageSegment.text("[语音]")) },
            { key: "video", build: async (p) => MessageSegment.video(`base64://${await getUrlBase64(p.slice(1).join("."))}`).needs("video").fallbackTo(MessageSegment.text("[视频]")) },
            { key: "forward", build: (p) => MessageSegment.forward(p[1]) },
            { key: "dice", build: (p) => new MessageSegment("dice", { id: p[1] }) },
            { key: "rps", build: (p) => new MessageSegment("rps", { id: p[1] }) },
            { key: "poke", build: (p) => new MessageSegment("poke", { id: p[1] }) },
            { key: "fileid", build: (p) => MessageSegment.file({ file_id: p[1] }).needs("file").fallbackTo(MessageSegment.text("[文件]")) },
            { key: "file", build: (p) => MessageSegment.file({ file: p.slice(1).join(".") }).needs("file").fallbackTo(MessageSegment.text("[文件]")) },
            { key: "json", build: (p) => MessageSegment.json(p.slice(1).join(".")) },
            {
                key: "music",
                build: async (p) => MessageSegment.music({
                    type: "custom",
                    url: p[3],
                    audio: p[2],
                    title: p[1],
                    image: p[4]
                })
            },
            {
                key: "markdown",
                build: async (p) => {
                    // 用法：#markdown 内容 || 按钮A | 按钮B ;; 按钮C
                    // "|" 同行按钮，";;" 换行；按钮格式：文字 或 文字=回传 或 文字=url:https://...
                    const input = p.slice(1).join(".").replace(/\\n/g, "\n");
                    const [contentPart, btnPart] = input.split("||");
                    const mdContent = (contentPart ?? "").trim() || `# 📢测试标题
**加粗文字**
- 列表项1
- 列表项2

[🔗腾讯](https://www.qq.com)
`;
                    const buttons: Array<Record<string, any>> = [];
                    if (btnPart) {
                        btnPart.split(";;").forEach((rowStr, rowIdx) => {
                            rowStr.split("|").forEach((b) => {
                                b = b.trim();
                                if (!b) return;
                                const eq = b.indexOf("=");
                                let text = b, cb: string | undefined, url: string | undefined;
                                if (eq > 0) {
                                    text = b.slice(0, eq).trim();
                                    const val = b.slice(eq + 1).trim();
                                    if (val.startsWith("url:")) url = val.slice(4);
                                    else cb = val;
                                }
                                const btn: Record<string, any> = { text };
                                if (cb) btn.callback = cb;
                                if (url) btn.url = url;
                                if (rowIdx) btn.row = rowIdx;
                                buttons.push(btn);
                            });
                        });
                    }
                    const mdData: Record<string, any> = { content: mdContent };
                    if (buttons.length) mdData.buttons = buttons;
                    // 支持原生 markdown 的平台（QQ/onebot/KOOK/Discord 等）原样发送，
                    // 其余平台由内核自动降级为纯文本内容
                    return MessageSegment.markdown(mdData).needs("markdown").fallbackTo(MessageSegment.text(mdContent));
                }
            },
            {
                key: "send",
                build: async (p) => {
                    // 跨平台推送：[send.机器人ID.group.user.消息内容]
                    // 机器人ID：botId 或 selfId；group：群聊目标（0/空 → 私聊）；user：私聊目标
                    const str = p[1] ?? "";
                    const dot1 = str.indexOf(".");
                    if (dot1 <= 0) return "[send] 格式错误，应为 [send.机器人ID.group.user.消息内容]";
                    const dot2 = str.indexOf(".", dot1 + 1);
                    if (dot2 === -1) return "[send] 格式错误，缺少 group/user";
                    const dot3 = str.indexOf(".", dot2 + 1);
                    if (dot3 === -1) return "[send] 格式错误，缺少消息内容";
                    const targetBotId = str.slice(0, dot1);
                    const groupId = str.slice(dot1 + 1, dot2);
                    const userId = str.slice(dot2 + 1, dot3);
                    const content = str.slice(dot3 + 1);

                    const targetBot = get_bot(targetBotId);
                    if (!targetBot) return `[send] 找不到机器人 ${targetBotId}`;
                    if (!content.trim()) return "[send] 消息内容为空";
                    try {
                        if (groupId && groupId !== "0" && groupId !== "undefined") {
                            await targetBot.sendGroupMsg(groupId, content);
                        } else {
                            if (!userId || userId === "undefined") return "[send] 缺少私聊目标 user";
                            await targetBot.sendPrivateMsg(userId, content);
                        }
                        return "";
                    } catch (e) {
                        return `[send] 发送失败: ${(e as Error).message}`;
                    }
                }
            },
            {
                key: "cs",
                build: async (p) => {
                    let a = await bot.callApi("get_moments", {
                        limit: 1
                    });
                    console.log(p[1]+JSON.stringify(a));
                    return JSON.stringify(a);
                }
            },
            {
                key: "pat",
                build: async (p) => {
                    if (p[2] == p[1]) {
                        await bot.callApi("friend_poke", {
                            target_id: p[2],
                            user_id: p[1]
                        });
                    } else {
                        await bot.callApi("group_poke", {
                            group_id: p[2],
                            user_id: p[1]
                        });
                    }
                    return "";
                }
            },
            {
                key: "sign",
                build: async (p) => {
                    await bot.callApi("send_group_sign", {
                        group_id: p[1]
                    });
                    return "";
                }
            },
            {
                key: "emoji",
                build: async (p) => {
                    await bot.callApi("set_msg_emoji_like", {
                        message_id: p[1],
                        emoji_id: p[2],
                        set: p[2] !== "0"
                    });
                    return "";
                }
            },
            {
                key: "like",
                build: async (p) => {
                    await bot.callApi("send_like", {
                        user_id: p[2],
                        times: p[1]
                    });
                    return "";
                }
            },
            {
                key: "recall",
                build: async (p) => {
                    await bot.callApi("delete_msg", {
                        message_id: p[1]
                    });
                    return "";
                }
            },
            {
                key: "ban",
                build: async (p) => {
                    if (p[2] == "all") {
                        await bot.callApi("set_group_whole_ban", {
                            group_id: p[3],
                            enable: p[1]
                        });
                    } else {
                        await bot.callApi("set_group_ban", {
                            group_id: p[3],
                            user_id: p[2],
                            duration: p[1]
                        });
                    }
                    return "";
                }
            },
            {
                key: "kick",
                build: async (p) => {
                    await bot.callApi("set_group_kick", {
                        group_id: p[3],
                        user_id: p[1],
                        reject_add_request: p[2]
                    });
                    return "";
                }
            },
            {
                key: "setadmin",
                build: async (p) => {
                    await bot.callApi("set_group_admin", {
                        group_id: p[3],
                        user_id: p[1],
                        enable: p[2]
                    });
                    return "";
                }
            },
            {
                key: "setcard",
                build: async (p) => {
                    await bot.callApi("set_group_card", {
                        group_id: p[3],
                        user_id: p[2],
                        card: p[1]
                    });
                    return "";
                }
            },
            {
                key: "settitle",
                build: async (p) => {
                    await bot.callApi("set_group_special_title", {
                        group_id: p[3],
                        user_id: p[2],
                        special_title: p[1]
                    });
                    return "";
                }
            },
            {
                key: "essence",
                build: async (p) => {
                    if (p[2]) {
                        await bot.callApi("set_essence_msg", { message_id: p[1] });
                    } else {
                        await bot.callApi("delete_essence_msg", { message_id: p[1] });
                    }
                    return "";
                }
            },
            {
                key: "delgroup",
                build: async (p) => {
                    await bot.callApi("set_group_leave", { group_id: p[1] });
                    return "";
                }
            },
            {
                key: "delfriend",
                build: async (p) => {
                    await bot.callApi("delete_friend", { user_id: p[1] });
                    return "";
                }
            },
            {
                key: "airecord",
                build: async (p) => {
                    await bot.callApi("send_group_ai_record", {
                        character: p[2],
                        group_id: groupId,
                        text: p[1]
                    });
                    return "";
                }
            },
            {
                key: "totext",
                build: async (p) => {
                    const result = await bot.callApi<{ text?: string }>("voice_msg_to_text", { message_id: p[1] });
                    return result.text ?? "";
                }
            },
            {
                key: "ocr",
                build: async (p) => {
                    const result = await bot.callApi<{ data: { texts: Array<{ text: string }> } }>("ocr_image", { image: p.slice(1).join(".") });
                    return result.data.texts[0]?.text ?? "";
                }
            },
            {
                key: "info",
                build: async (p) => {
                    const info = await bot.callApi<{ stat: Record<string, unknown> }>("get_status", {});
                    console.log(info);
                    return String(info.stat[p[1]] ?? "");
                }
            },
            { key: "get", build: async (p) => {
                    const fetch_data = await req(p.slice(1).join("."))
                    try {
                        JSON.parse(fetch_data);
                        const base64 = Buffer.from(fetch_data, "utf8").toString('base64');
                        return base64;
                    } catch (err) {
                        return fetch_data;
                    }
                }
            },
            {
                key: "convert",
                build: async (p) => {
                    console.log(p.slice(3).join("."));
                    const json_data = Buffer.from((p.slice(3).join(".")), 'base64').toString("utf8");
                    console.log(json_data);
                    if (p[1] == "image") {
                        const imageBase = await jsonConvert(json_data, "image", p[2]);
                        return { type: "image", data: { file: `base64://${imageBase}` } }
                    } else {
                        const text = await jsonConvert(json_data, "text", p[2]);
                        return text;
                    }
                }
            },
            {
                key: "coin",
                build: async (p) => await coins_operation(p[5], p[4], p[3], p[1], p[2], event.raw.sender?.nickname ?? "")
            },
            {
                key: "savefile",
                build: async (p) => await saveFile(selfId, p.slice(1).join("."))
            },
            {
                key: "msg",
                build: async (p) => {
                    const msg = await bot.callApi<{ message?: MsgSegment[] }>("get_msg", { message_id: p[1]});
                    const cfg = await fileCacheIO(CONFIG_FILE_PATH, "r");
                    const transmsg = transMessage(msg.message ?? [], cfg);
                    if (p[2] == "true" || p[2] == "t") {
                        return transmsg.replace(/\[/g, "【").replace(/\]/g, "】");
                    }
                    return transmsg;
                }
            },
            {
                key: "getvalue",
                build: async (p) => {
                    return await getValue(p.slice(1).join("."));
                }
            },
            {
                key: "random",
                build: (p) => String(Math.floor(Math.random() * (+p[1] - (+p[2]) + 1)) + +p[2])
            },
            {
                key: "cooldown",
                build: async (p) => {
                    const cooltime = await coins_operation(selfId, groupId, userId, `0`, `COOLDOWN:${global_lexicon_ids[selfId].hit}`);
                    if (cooltime!=="0" && ((+cooltime - Date.now())>0)) {
                        // 冷却中
                        return "VanError";
                    } else {
                        let cooldowntime;
                        if (p[1] == "0") {
                            cooldowntime = new Date().setHours(24, 0, 0, 0);
                        } else {
                            cooldowntime = Date.now() + (+p[1] * 1000);
                        }
                        await coins_operation(selfId, groupId, userId, `||${cooldowntime}||`, `COOLDOWN:${global_lexicon_ids[selfId].hit}`);
                        return "";
                    }
                }
            },
            {
                key: "cooldowntime",
                build: async (p) => {
                    const cooltime = await coins_operation(selfId, groupId, userId, `0`, `COOLDOWN:${global_lexicon_ids[selfId].hit}`);
                    return String((+cooltime - Date.now())/1000);
                }
            },
            {
                key: "lexselect",
                build: async (p) => {
                    await coins_operation(selfId, "0", selfId, `||${p[1]}||`, `SELECT`);
                    return "";
                }
            },
            {
                key: "lexused",
                build: async (p) => {
                    await coins_operation(selfId, groupId, "0", `||${p[1]}||`, `USED`);
                    return "";
                }
            },
            {
                key: "lexselecting",
                build: async (p) => {
                    return await coins_operation(selfId, "0", selfId, `0`, `SELECT`);
                }
            },
            {
                key: "lexusing",
                build: async (p) => {
                    return await coins_operation(selfId, groupId, "0", `0`, `USED`);
                }
            },
            {
                key: "msgerror",
                build: async (p) => {
                    global_error_reply[selfId].text = p[1];
                    return "";
                }
            },
            {
                key: "judge",
                build: async (p) => {
                    let judge_result = await judge(p.slice(1).join("."));
                    if (judge_result) {
                        return "";
                    } else {
                        return "VanJudgeFalse";
                    }
                }
            },
            {
                key: "task",
                build: async (p) => {
                    if (p[1] == "start") {
                        await controlTasks(selfId, await readTaskList(selfId))
                        return "任务已启动";
                    } else if (p[1] == "stop") {
                        await controlTasks(selfId, await readTaskList(selfId), "stop")
                        return "任务已暂停";
                    } else if (p[1] == "add") {
                        const taskData = await task_operation(selfId, p[1], JSON.parse(p[2]))
                        await controlTasks(selfId, taskData)
                        return "任务添加成功";
                    } else if (p[1] == "del") {
                        const taskData = await task_operation(selfId, p[1], p[2])
                        await controlTasks(selfId, taskData)
                        return "任务删除成功";
                    }
                    return "";
                }
            },
            { key: "botid", build: () => String(event.raw.sender?.nickname ?? "") },
            { key: "selfid", build: () => String(event.selfId ?? "") },
            { key: "userid", build: () => String(event.userId ?? "") },
            { key: "groupid", build: () => String(event.groupId ?? "") },
            { key: "username", build: () => String(event.raw.sender?.nickname ?? "") },
            { key: "usercard", build: () => String((event.raw.sender?.card || event.raw.sender?.nickname) ?? "") },
            { key: "userrole", build: () => String(event.raw.sender?.role ?? "") },
            { key: "groupname", build: () => String(event.raw.group_name ?? "") },
            { key: "msgid", build: () => String(event.raw.message_id ?? "") },
            { key: "time", build: () => String(event.raw.time ?? "") },
            { key: "newline", build: () => "\n" },
            { key: "lexid", build: () => String(global_lexicon_ids[selfId].hit) },
            { key: "lextotal", build: () => String(global_lexicon_totals[selfId].count) },
            { key: "sendid", build: () => String(global_message_ids[selfId]?.[event.groupId || event.userId]) },
            {
                key: "lexicon",
                build: async (p) => {
                    let lexSelect = await coins_operation(selfId, "0", selfId, `0`, `SELECT`) as string;
                    lexSelect = lexSelect == "0" ? "default" : lexSelect;
                    if (p[1] == "加词") {
                        const key = p[2].replace(/［［/g, "[").replace(/］］/g, "]").replace(/｜｜/g, "|");
                        const reply = p[3].replace(/［［/g, "[").replace(/］］/g, "]").replace(/｜｜/g, "|");
                        const ok = await LexiconManager(selfId, lexSelect, "add", {n:key,r:reply,s:p[4]})
                        return ok as string;
                    } else if (p[1] == "删词") {
                        const ok = await LexiconManager(selfId, lexSelect, "remove", {query: p[2]})
                        if (ok) {
                            return ok as string;
                        } else {
                            return ok as string;
                        }
                    } else if (p[1] == "恢复") {
                        const ok = await LexiconManager(selfId, lexSelect, "restore",{query:p[2]})
                        if (ok) {
                            return ok as string;
                        } else {
                            return ok as string;
                        }
                    } else if (p[1] == "改词名") {
                        const ok = await LexiconManager(selfId, lexSelect, "edit_name",{target:p[2], new_name:p[3]})
                        if (ok) {
                            return ok as string;
                        } else {
                            return ok as string;
                        }
                    } else if (p[1] == "改模式") {
                        const ok = await LexiconManager(selfId, lexSelect, "edit_mode",{target:p[2], new_mode:p[3]})
                        if (ok) {
                            return ok as string;
                        } else {
                            return ok as string;
                        }
                    } else if (p[1] == "查词") {
                        const list = await LexiconManager(selfId, lexSelect, "look", {query:p[2]}) as string;
                        return list.replace(/\[/g, "【").replace(/\]/g, "】");
                    } else if (p[1] == "重整") {
                        const ok = await LexiconManager(selfId, lexSelect, "reset_all",{})
                        return ok as string;
                    }
                    if (p[1] == "更新配置") {
                        await fileCacheIO(CONFIG_FILE_PATH, "r", undefined, true);
                        return "重新加载配置成功";
                    } else if (p[1] == "重载词库") {
                        const lexPath = path.join(PLUGIN_DATA, selfId, "lexicon", `${lexSelect}.json`);
                        fileCachePool.delete(lexPath);
                        return "词库缓存已清空，下次匹配读取磁盘最新词库";
                    }
                    return "";
                }
            },
        ];

        // 别名/宏替换：带 expand 字段的标签优先匹配，展开为标准标签后由外层递归解析
        for (const aliasKey of Object.keys(cfg.value)) {
            const aliasDef = cfg.value[aliasKey];
            if (!aliasDef?.expand || typeof aliasDef.expand !== "string") continue;
            const tplObj = getTypeTemplate(aliasKey);
            const nameTemplate = tplObj.name;
            const keyTemplate = buildKeyTemplate(aliasKey, tplObj);
            let params = await matchTemplateGetParams(nameTemplate, text);
            if (params === null) {
                params = await matchTemplateGetParams(keyTemplate, text);
            }
            if (params === null) continue;
            const filledParams: string[] = [];
            for (const key of Object.keys(tplObj)) {
                const matchP = key.match(/^p(\d+)$/);
                if (!matchP) continue;
                const idx = Number(matchP[1]);
                const captureVal = params[idx];
                if (captureVal && captureVal.trim() !== "") {
                    filledParams[idx] = await resolveValue(captureVal);
                } else {
                    filledParams[idx] = await resolveValue(tplObj[key]);
                }
            }
            let expanded = aliasDef.expand;
            for (let i = 1; i < filledParams.length; i++) {
                if (filledParams[i] !== undefined && filledParams[i] !== null) {
                    expanded = expanded.split(`{p${i}}`).join(filledParams[i]);
                }
            }
            return `[${expanded}]`;
        }

        for (const item of typeMap) {
            const typeKey = item.key;
            const tplObj = getTypeTemplate(typeKey);
            const nameTemplate = tplObj.name;
            const keyTemplate = buildKeyTemplate(typeKey, tplObj);

            let params = await matchTemplateGetParams(nameTemplate, text);
            if (params === null) {
                params = await matchTemplateGetParams(keyTemplate, text);
            }

            if (params === null) continue;

            const filledParams: string[] = [];
            for (const key of Object.keys(tplObj)) {
                const matchP = key.match(/^p(\d+)$/);
                if (!matchP) continue;
                const idx = Number(matchP[1]);
                const captureVal = params[idx];
                if (captureVal && captureVal.trim() !== "") {
                    // 捕获参数里若含嵌套标签（如 [markdown.[userid]]），先递归解析成纯文本
                    filledParams[idx] = await resolveValue(captureVal);
                } else {
                    filledParams[idx] = await resolveValue(tplObj[key]);
                }
            }
            const result = await item.build(filledParams);
            return result;
        }
        return null;
    }
    async function replaceInner(s: string, depth: number = 0): Promise<string> {
        // 内层优先：反复找到“第一个内部无嵌套的 [xxx]”标签（从左到右、从内到外），
        // 求值替换，直到没有可处理的标签为止。
        // 未知标签先占位（循环结束还原原样），避免死循环。
        const unknownRe = /\{\{UNKNOWN:([A-Za-z0-9+/=]+)\}\}/g;
        const innermostRe = /\[([^\[\]]*)\]/;
        // judge 分段：找下一个 judge 标签（兼容自定义 name 与原 key）
        const judgeName = String(getTypeTemplate("judge")?.name ?? "judge").replace(/\.\{p\d+\}$/, "");
        const nextJudgeRe = judgeName === "judge"
            ? /\[judge\./
            : new RegExp("\\[" + escapeRegStr(judgeName) + "\\.|\\[judge\\.");
        let guard = 0;
        while (guard++ < 2000) {
            const m = innermostRe.exec(s);
            if (!m) break;
            const fullNode = m[0];
            const innerText = m[1];
            const matchIndex = m.index;
            const opResult = await operation(innerText, s);
            if (opResult === "VanJudgeFalse") {
                // 分段判断：仅丢弃当前 judge 节点后直到下一个 judge 标签（或结尾）的文本
                const before = s.substring(0, matchIndex);
                const afterNode = s.substring(matchIndex + fullNode.length);
                const nextJudgeIdx = afterNode.search(nextJudgeRe);
                s = nextJudgeIdx === -1 ? before : before + afterNode.slice(nextJudgeIdx);
                continue;
            }
            if (opResult === "VanError") {
                console.log(global_error_reply[selfId].text);
                return String(global_error_reply[selfId].text);
            }
            let replaceStr: string;
            if (opResult === null) {
                replaceStr = `{{UNKNOWN:${Buffer.from(fullNode, "utf8").toString("base64")}}}`;
            } else if (typeof opResult === "object" && opResult !== null && "type" in opResult) {
                replaceStr = `{{NODE:${Buffer.from(JSON.stringify(opResult), "utf8").toString("base64")}}}`;
            } else {
                replaceStr = String(opResult);
            }
            s = s.slice(0, matchIndex) + replaceStr + s.slice(matchIndex + fullNode.length);
        }
        // 还原未知标签占位
        return s.replace(unknownRe, (_m, b64) => Buffer.from(b64, "base64").toString("utf8"));
    }

    global_error_reply[selfId] ??= {};
    global_error_reply[selfId].text = "";

    // 兼容原 key 形式：自定义 name 后，原 [divide.N] 仍可触发分段
    if (SEGMENT_TAG !== "divide") {
        inputStr = inputStr.replace(/\[divide\.(\d+)\]/g, `[${SEGMENT_TAG}.$1]`);
    }
    const reg = new RegExp("\\[" + escapeRegStr(SEGMENT_TAG) + "\\.\\d+\\]");
    if (reg.test(inputStr)) {
        await clauseTask(inputStr, bot, event);
        inputStr = "";
    }

    // 兼容原 key 形式：原 [or] 仍可作为随机分隔符
    if (OR_NAME !== "or") {
        inputStr = inputStr.replaceAll("[or]", RANDOM_SEP);
    }
    const candidates = inputStr.split(RANDOM_SEP);
    const selectedText = candidates[Math.floor(Math.random() * candidates.length)];
    const processedRaw = await replaceInner(selectedText);
    const resultArr: MsgSegment[] = [];
    const tokenReg = /(\{\{NODE:.+?\}\}|[^{]+)/g;
    for (const token of processedRaw.matchAll(tokenReg)) {
        let content = token[0];
        if (content.startsWith("{{NODE:")) {
            const jsonStr = Buffer.from(content.replace("{{NODE:", "").replace("}}", ""), "base64").toString("utf8");
            resultArr.push(JSON.parse(jsonStr));
        } else if (content.trim()) {
            resultArr.push({ type: "text", data: { text: content.replace(/\\n/g, "\n") } });
        }
    }

    return resultArr;
}

//最高权限调用
async function handleAdminCmd(
    bot: BaseAdapter,
    event: BotEvent,
    ctx: PluginContext,
    transStr: string,
    gid: string,
    uid: string,
): Promise<boolean> {
    const api = ctx.api;
    if (!api) return false;
    const send = (msg: unknown) => sendMsgCtx(bot, event, { group_id: gid, user_id: uid }, msg);
    try {
        // 机器人列表（含禁用）
        if (transStr === "#机器人列表") {
            const bots = api.listBots();
            if (!bots.length) { await send("暂无机器人"); return true; }
            const lines = bots.map(b =>
                `${b.botId} [${b.type}] ${b.connected ? "●在线" : b.enabled ? "×未连接" : "○禁用"}`
            );
            await send("机器人列表：\n" + lines.join("\n"));
            return true;
        }
        // 插件列表（含未加载/禁用）
        if (transStr === "#插件列表") {
            const plugins = api.listPlugins();
            if (!plugins.length) { await send("暂无插件"); return true; }
            const lines = plugins.map(p => `${p.name} ${p.enabled ? "●启用" : p.loaded ? "○禁用" : "×未加载"}`);
            await send("插件列表：\n" + lines.join("\n"));
            return true;
        }
        // 启用机器人 / #停用机器人 <botId>
        const botToggle = transStr.match(/^#(启用|停用)机器人\s+(.+)$/);
        if (botToggle) {
            const id = botToggle[2].trim();
            await (botToggle[1] === "启用" ? api.enableBot(id) : api.disableBot(id));
            await send(`已${botToggle[1]}机器人 ${id}`);
            return true;
        }
        // 启用插件 / #停用插件 <name>
        const pluginToggle = transStr.match(/^#(启用|停用)插件\s+(.+)$/);
        if (pluginToggle) {
            const name = pluginToggle[2].trim();
            await (pluginToggle[1] === "启用" ? api.enablePlugin(name) : api.disablePlugin(name));
            await send(`已${pluginToggle[1]}插件 ${name}`);
            return true;
        }
        // 移除机器人 <botId>
        if (transStr.startsWith("#移除机器人")) {
            const id = transStr.replace("#移除机器人", "").trim();
            if (!id) { await send("用法：#移除机器人 <botId>"); return true; }
            await api.removeBot(id);
            await send(`已移除机器人 ${id}`);
            return true;
        }
        // 新增机器人 <json>
        if (transStr.startsWith("#新增机器人")) {
            const arg = transStr.replace("#新增机器人", "").trim();
            try {
                const cfg = JSON.parse(arg);
                await api.addBot(cfg);
                await send(`已新增机器人 ${cfg.botId ?? "(未填 botId)"}`);
            } catch (e: any) {
                await send(`新增机器人失败: ${e.message}（用法：#新增机器人 {json}）`);
            }
            return true;
        }
        // 状态：系统信息（CPU/内存）+ 所有平台收发汇总
        if (transStr === "#状态") {
            const sys = await api.getSystemInfo();
            const stats = api.getMessageStats();
            let recv = 0, sent = 0;
            for (const k of Object.keys(stats)) { recv += stats[k].received; sent += stats[k].sent; }
            await send(
                "系统状态：\n" +
                `框架：VanBotJS\n` +
                `CPU：${sys.cpuUsage}%\n` +
                `内存：${sys.memUsage}%\n` +
                `平台：${sys.platform}/${sys.arch}\n` +
                `进程运行：${Math.round(sys.processUptime / 60)} 分钟\n` +
                `全平台统计：收 ${recv} / 发 ${sent}`
            );
            return true;
        }
        // 收发统计
        if (transStr === "#收发统计") {
            const stats = api.getMessageStats();
            const keys = Object.keys(stats);
            if (!keys.length) { await send("暂无收发记录"); return true; }
            const lines = keys.map(k => `${k}: 收${stats[k].received} / 发${stats[k].sent}`);
            await send("收发统计：\n" + lines.join("\n"));
            return true;
        }
    } catch (e: any) {
        await send(`管理指令执行失败: ${e.message}`);
        return true;
    }
    return false;
}

// 接收发送消息处理
async function keywordOnEvent(
    event: BotEvent,
    bot: BaseAdapter,
    ctx: PluginContext
): Promise<void> {
    try {
        const raw = event.raw;
        if (raw.status === "ok") return;

        const selfId = event.selfId ? String(event.selfId) : "";
        const uid = event.userId ? String(event.userId) : "";
        const gid = event.groupId ? String(event.groupId) : "";

        const cfg = await fileCacheIO(CONFIG_FILE_PATH, "r") as any;
        const ownerList = cfg.OWNER_LIST || [];
        const masterId = await coins_operation(selfId, "0", "0", `0`, `MASTER`);
        const masterList = masterId == "0" ? [] : masterId.split(",");

        if (cfg.showRawLog) {
            console.log(event);
        }
        
        const isMsgEvent = event.postType === "group_message" || event.postType === "private_message" || raw.post_type === "message_sent";
        if (isMsgEvent) {
            const transStr = transMessage(event.message ?? [], cfg);
            const logType = gid ? "群聊" : "私聊";
            const targetId = gid ? gid : uid;
            // x 变量交互：正在等待用户输入时，优先把这条消息作为输入接收，不再走词条匹配
            const xKey = `${selfId}|${targetId}|${uid}`;
            if (xWaitStates[xKey]) {
                // 已消费（正常续接）→ 返回；超时作废（未消费）→ 继续走词条匹配
                if (await handleXVar(bot, event, xKey, "", transStr)) return;
            }

            // 主人号配置
            if (masterList.length == 0) {
                if (transStr.startsWith('#设置主人号 ')) {
                    let masterid = transStr.replace("#设置主人号 ", "");
                    await coins_operation(selfId, "0", "0", `||${masterid}||`, `MASTER`);
                    await sendMsgCtx(bot, event, { group_id: gid, user_id: uid }, `已成功将${masterid}设置为主人号`)
                    botLog(selfId, "<-", "插件", selfId, `配置主人号成功，当前主人号: ${masterid}`);
                    return;
                } else {
                    botLog(selfId, "<-", "插件", selfId, `配置主人号指令：#设置主人号 你的QQ号(当前用户id: ${uid})(多个主人号用英文逗号隔开)`);
                }
            }

            let lexUsed = await coins_operation(selfId, targetId, "0", `0`, `USED`);
            lexUsed = lexUsed == "0" ? "default" : lexUsed;

            const matchResult = await LexiconManager(selfId, lexUsed, "get", { value: transStr }) as any;
            if (matchResult && matchResult !== "") {
                // cards
                let cards = await req(`http://bot.ziyi.asia/cards/?action=auth&key=${lexUsed}&qq=${selfId}`)
                if (cards == "no") {
                    botLog(selfId, "<-", "插件", selfId, `【${lexUsed}】词库卡密授权已到期！`);
                    return;
                }

                const rawReplyList = matchResult.replyList;
                const rawReply = rawReplyList[Math.floor(Math.random() * rawReplyList.length)];
                let tempText = rawReply;

                // 替换 [n.x] 捕获占位
                if (matchResult.capture !== false) {
                    const captureArr = matchResult.capture;
                    for (let i = 0; i < captureArr.length; i++) {
                        tempText = tempText.replaceAll(`[n.${i}]`, captureArr[i]);
                        tempText = tempText.replaceAll(`[n.${i}.t]`, await getValue(captureArr[i]));
                    }
                }

                // x 变量交互：模板含 [x.n] 时进入交互流程（重新触发词条 = 重置旧交互）
                if (/\[x\.\d+\]/.test(tempText)) {
                    const xKey2 = `${selfId}|${targetId}|${uid}`;
                    const oldState = xWaitStates[xKey2];
                    if (oldState) {
                        if (oldState.timer) safeClearTimeout(oldState.timer);
                        await clearXVars(oldState.selfId, oldState.targetId, oldState.uid, oldState.used);
                        delete xWaitStates[xKey2];
                    }
                    await handleXVar(bot, event, xKey2, tempText);
                } else {
                    // 解析标签 → 消息段数组
                    const messageSegments = await parseBracketStr(tempText, bot, event);

                    try {
                        if (JSON.stringify(messageSegments) === "[]") {
                            botLog(selfId, "<-", "插件", selfId, "空消息");
                        } else {
                            global_message_ids[selfId] ??= {};
                            let sendid;
                            sendid = await sendMsgCtx(bot, event, { group_id: gid, user_id: uid }, messageSegments) as { message_id: number };
                            global_message_ids[selfId][targetId] = sendid.message_id;
                        }
                    } catch (lexErr) {
                        const msg = `消息发送异常！\nenv: ${logType}\nenvID: ${targetId}\nrobotID: ${selfId}\nevent: ${event.postType}\nreceive: ${transStr}\nsend: ${JSON.stringify(messageSegments)}\nerror: ${(lexErr as Error).message}`;
                        if (cfg.errorNotice) {
                            await sendMsgCtx(bot, event, { user_id: ownerList[0] }, msg);
                        } else {
                            botLog(selfId, "<-", "插件", selfId, msg);
                        }
                    }
                }
            }

            let lexSelect = await coins_operation(selfId, "0", selfId, `0`, `SELECT`);
            lexSelect = lexSelect == "0" ? "default" : lexSelect;

            // 主人消息处理
            if (masterList.includes(uid)) {
                // 联网导入词库
                const match = transStr.match(/^\[VanBot\](.*?)词库表/);
                if (match) {
                    const lexicon_import_url = cfg.lexicon_import_url;
                    const lexicon_name = match[1]
                    const lexicon_location = path.join(PLUGIN_DATA, selfId, "lexicon", `${lexicon_name}.json`);
                    await LexiconManager(selfId, lexicon_name, "reset",{})
                    let trandata = {"varPoolText": transStr.replace(/\\n/g, '\n'), "templateName": lexicon_name};
                    let ndata = JSON.parse(await req(lexicon_import_url, "POST", trandata));
                    let odata = await fileCacheIO(lexicon_location, "r", undefined, true);
                    const map = {} as Record<string, unknown>;
                    odata.work.forEach((v: Record<string, unknown>) => map[Object.keys(v)[0]] = v);
                    ndata.work.forEach((v: Record<string, unknown>) => map[Object.keys(v)[0]] = v);
                    const work = Object.values(map);
                    await fileCacheIO(lexicon_location, "w", JSON.stringify({work}, null, 4));
                    await LexiconManager(selfId, lexicon_name, "reset",{})
                    await coins_operation(selfId, "0", selfId, `||${lexicon_name}||`, `SELECT`)
                    let lexicon_config = await req(`http://bot.ziyi.asia/JSver/data/${lexicon_name}.json`);
                    await fileCacheIO(CONFIG_FILE_PATH, "w", lexicon_config);
                    await sendMsgCtx(bot, event, { group_id: gid, user_id: uid }, lexicon_name + "词库配置成功")
                    botLog(selfId, "<-", "插件", targetId, lexicon_name + "词库配置成功")
                }

                // 热更新
                if(transStr === "#更新插件"){
                    const plugin_path = path.join(ROOT_DIR, "plugin", "keyword.ts");
                    const plugin_code = await req("http://bot.ziyi.asia/JSver/keyword.ts");
                    await fileCacheIO(plugin_path, "w", plugin_code)
                    await sendMsgCtx(bot, event, { group_id: gid, user_id: uid }, "更新完成，已自动重启！")
                }

                if (transStr === "#更新配置") {
                    await fileCacheIO(CONFIG_FILE_PATH, "r", undefined, true)
                    await sendMsgCtx(bot, event, { group_id: gid, user_id: uid }, `重新加载配置成功`)
                    botLog(selfId, "<-", "插件", targetId, "配置文件已重新加载")
                }

                if (transStr === "#重置本群") {
                    await coins_operation(selfId, targetId, "0", `||0||`, `USED`);
                    await sendMsgCtx(bot, event, { group_id: gid, user_id: uid }, "本群重置成功")
                }

                if(transStr === "#重整词库"){
                    const res = await LexiconManager(selfId, lexSelect, "reset",{})
                    await sendMsgCtx(bot, event, { group_id: gid, user_id: uid }, res)
                }
                // 变量标签 name 覆盖管理
                const vnameOverridesCmd = await loadVNameOverrides(selfId);

                // #设置标签 <key> <新name>
                const setTagMatch = transStr.match(/^#设置标签\s+(\S+)\s+(.+)$/);
                if (setTagMatch) {
                    const tagKey = setTagMatch[1];
                    const newName = setTagMatch[2].trim();
                    if (!cfg.value?.[tagKey]) {
                        await sendMsgCtx(bot, event, { group_id: gid, user_id: uid }, "未知标签 key：" + tagKey);
                        return;
                    }
                    const allNames = new Map();
                    for (const k of Object.keys(cfg.value)) {
                        const v = cfg.value[k];
                        if (v?.name) allNames.set(v.name, k);
                    }
                    for (const [k, n] of vnameOverridesCmd) {
                        allNames.set(n, k);
                    }
                    allNames.delete(newName);
                    const conflict = allNames.get(newName);
                    if (conflict) {
                        await sendMsgCtx(bot, event, { group_id: gid, user_id: uid }, "标签名【" + newName + "】已被标签【" + conflict + "】占用，不能设置");
                        return;
                    }
                    const pMatches = newName.match(/\{p(\d+)\}/g);
                    if (pMatches) {
                        const missing = [];
                        for (const pm of pMatches) {
                            const pn = pm.replace(/[{}]/g, "");
                            if (!cfg.value[tagKey][pn]) missing.push(pn);
                        }
                        if (missing.length) {
                            await sendMsgCtx(bot, event, { group_id: gid, user_id: uid }, "警告：新 name 用到了 " + missing.join("、") + "，但该标签无对应默认值，使用时必须手动传参");
                        }
                    }
                    await coins_operation(selfId, "0", "0", "||" + newName + "||", "VNAME:" + tagKey);
                    await sendMsgCtx(bot, event, { group_id: gid, user_id: uid }, "标签【" + tagKey + "】已设置为：" + newName);
                    return;
                }

                // #查看标签
                if (transStr === "#查看标签") {
                    const lines = [];
                    for (const k of Object.keys(cfg.value)) {
                        const v = cfg.value[k];
                        if (!v?.name) continue;
                        const override = vnameOverridesCmd.get(k);
                        lines.push(override ? k + " → " + override + "（已覆盖，默认：" + v.name + "）" : k + " → " + v.name);
                    }
                    await sendMsgCtx(bot, event, { group_id: gid, user_id: uid }, "变量标签列表：\n" + lines.join("\n"));
                    return;
                }

                // #重置标签 <key>
                const resetTagMatch = transStr.match(/^#重置标签\s+(\S+)$/);
                if (resetTagMatch) {
                    const tagKey = resetTagMatch[1];
                    if (!cfg.value?.[tagKey]) {
                        await sendMsgCtx(bot, event, { group_id: gid, user_id: uid }, "未知标签 key：" + tagKey);
                        return;
                    }
                    if (!vnameOverridesCmd.has(tagKey)) {
                        await sendMsgCtx(bot, event, { group_id: gid, user_id: uid }, "标签【" + tagKey + "】未设置覆盖，无需重置");
                        return;
                    }
                    await coins_operation(selfId, "0", "0", "||||", "VNAME:" + tagKey);
                    await sendMsgCtx(bot, event, { group_id: gid, user_id: uid }, "标签【" + tagKey + "】已恢复默认：" + cfg.value[tagKey].name);
                    return;
                }

                // #设置别名 <name> <expand>
                const setAliasMatch = transStr.match(/^#设置别名\s+(\S+)\s+(.+)$/);
                if (setAliasMatch) {
                    const aliasName = setAliasMatch[1];
                    const expand = setAliasMatch[2].trim();
                    // 解析 name 里的 {pN} 占位符，自动生成 p1/p2 等默认参数
                    const aliasDef: Record<string, string> = { name: aliasName, expand };
                    const pMatches = aliasName.match(/\{p(\d+)\}/g);
                    if (pMatches) {
                        for (const pm of pMatches) {
                            const pn = pm.replace(/[{}]/g, "");
                            if (!aliasDef[pn]) aliasDef[pn] = "";
                        }
                    }
                    await coins_operation(selfId, "0", "0", "||" + JSON.stringify(aliasDef) + "||", "ALIAS:" + aliasName);
                    await sendMsgCtx(bot, event, { group_id: gid, user_id: uid }, "别名【" + aliasName + "】已设置：" + expand);
                    return;
                }

                // #查看别名
                if (transStr === "#查看别名") {
                    const customAliasesCmd = await loadCustomAliases(selfId);
                    const lines: string[] = [];
                    for (const k of Object.keys(cfg.value)) {
                        const v = cfg.value[k];
                        if (!v?.expand) continue;
                        const isCustom = !!customAliasesCmd[k];
                        lines.push((isCustom ? "[自定义] " : "[默认] ") + k + "：" + v.name + " → " + v.expand);
                    }
                    if (!lines.length) {
                        await sendMsgCtx(bot, event, { group_id: gid, user_id: uid }, "暂无别名");
                    } else {
                        await sendMsgCtx(bot, event, { group_id: gid, user_id: uid }, "别名列表：\n" + lines.join("\n"));
                    }
                    return;
                }

                // #删除别名 <name>
                const delAliasMatch = transStr.match(/^#删除别名\s+(\S+)$/);
                if (delAliasMatch) {
                    const aliasName = delAliasMatch[1];
                    const customAliasesCmd = await loadCustomAliases(selfId);
                    if (!customAliasesCmd[aliasName]) {
                        await sendMsgCtx(bot, event, { group_id: gid, user_id: uid }, "别名【" + aliasName + "】不是自定义别名，无法删除（默认别名不可删除）");
                        return;
                    }
                    await coins_operation(selfId, "0", "0", "||||", "ALIAS:" + aliasName);
                    await sendMsgCtx(bot, event, { group_id: gid, user_id: uid }, "别名【" + aliasName + "】已删除");
                    return;
                }
            }
            
            // 最高所有者消息处理
            if (ownerList.includes(uid)) {
                if (await handleAdminCmd(bot, event, ctx, transStr, gid, uid)) return;
            }

        } else if (event.postType === "notice") {
            const noticeInfo = transNotice(raw, +selfId, cfg);
            botLog(selfId, "<-", "通知", String(noticeInfo.targetId), noticeInfo.text);
        } else if (event.postType === "meta_event") {
            const metaInfo = transMeta(raw, +selfId, cfg);
            botLog(selfId, "<-", "通知", String(metaInfo.targetId), metaInfo.text);
        }
    } catch (err) {
        console.error(`[事件处理异常]`, err);
        console.log("异常事件原始数据：", event.raw);
    }
}

// 插件导出
export default definePlugin(
  {
    name: "keyword",
    version: "1.0.0",
    author: "ZiYi",
    license: "GPLv3",
    tags: ["词库", "lexicon"],
    repo: "https://github.com/Van-Zone/VanBotJS/",
    description: "超级自定义词库插件",
    requiresCapabilities: ["text"],
    permissions: ["owner"],
    apis: [
      "bot.list", "bot.status", "bot.enable", "bot.disable", "bot.add", "bot.remove",
      "plugin.list", "plugin.enable", "plugin.disable",
      "stats.messages", "sys.info",
    ],
  },
  (ctx) => {
    // 保存上下文，供模块内定时器走框架副作用追踪
    pluginCtx = ctx;
    // 注册中立 Skill（人工命令 / AI function-call 两用）
    registerKeywordSkills(ctx);
    return {
      onEvent: (event, bot) => keywordOnEvent(event, bot, ctx),
      // 停用/热重载时清理全部定时任务与交互等待，杜绝句柄泄漏
      onDisable: () => clearAllJobs(),
    };
  },
)

// 时间解析
function parseHumanTime(
    timeStr: string
): ParseTimeResult {
    const rule = new schedule.RecurrenceRule();
    rule.tz = "Asia/Shanghai";
    const s = timeStr.trim();

    const sixNumMatch = s.match(/^(\d+) (\d+) (\d+) (\d+) (\d+) (\d+)$/);
    if (sixNumMatch) {
        const [, year, month, date, hour, minute, second] = sixNumMatch.map(Number);
        if (year !== 0) rule.year = year;
        if (month !== 0) rule.month = month - 1;
        if (date !== 0) rule.date = date;
        if (hour !== 0) rule.hour = hour;
        if (minute !== 0) rule.minute = minute;
        if (second !== 0) rule.second = second;
        return rule;
    }

    if (/^\d{4}\.\d{2}\.\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
        return new Date(s.replace(/\./g, "-"));
    }
    if (/^\d{2}\.\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
        const [md, hms] = s.split(" ");
        const [month, date] = md.split(".").map(Number);
        const [hour, minute, second] = hms.split(":").map(Number);
        Object.assign(rule, { month: month - 1, date, hour, minute, second });
        return rule;
    }
    if (/^W\d{1} \d{2}:\d{2}:\d{2}$/.test(s)) {
        const [weekStr, hms] = s.split(" ");
        const weekDay = parseInt(weekStr.replace("W", ""), 10);
        const [hour, minute, second] = hms.split(":").map(Number);
        Object.assign(rule, { dayOfWeek: weekDay, hour, minute, second });
        return rule;
    }
    if (/^\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
        const [dateStr, hms] = s.split(" ");
        const [hour, minute, second] = hms.split(":").map(Number);
        Object.assign(rule, { date: Number(dateStr), hour, minute, second });
        return rule;
    }
    if (/^\d{2}:\d{2}:\d{2}$/.test(s)) {
        const [hour, minute, second] = s.split(":").map(Number);
        Object.assign(rule, { hour, minute, second });
        return rule;
    }
    if (/^\d{2}:\d{2}$/.test(s)) {
        const [minute, second] = s.split(":").map(Number);
        Object.assign(rule, { minute, second });
        return rule;
    }

    const sec = parseInt(s, 10);
    if (!Number.isNaN(sec)) {
        return { intervalSec: sec };
    }

    throw new Error(`无法解析 time：${timeStr}`);
}

// 清理全部任务定时器与等待中的 x 变量交互（插件停用/热重载时调用，防止句柄泄漏）
function clearAllJobs(): void {
    for (const job of Object.values(jobPool)) {
        if ("cancel" in job && typeof job.cancel === "function") job.cancel();
        if ("timer" in job) safeClearInterval(job.timer);
    }
    Object.keys(jobPool).forEach(k => delete jobPool[k]);
    Object.keys(taskCache).forEach(k => delete taskCache[k]);
    for (const st of Object.values(xWaitStates)) {
        if (st.timer) safeClearTimeout(st.timer);
    }
    Object.keys(xWaitStates).forEach(k => delete xWaitStates[k]);
    console.log("[keyword] 已清理全部定时任务与交互等待状态");
}

// 注册中立 Skill：同一套 invoke 逻辑既可用 /技能名 人工触发，也可供 AI 插件 function-call
function registerKeywordSkills(ctx: PluginContext): void {
    // 查询当前发言用户在指定分类下的积分/数据值
    ctx.registerSkill({
        name: "kw_coins",
        description: "查询当前发言用户在指定分类下的积分或数据值",
        parameters: {
            type: "object",
            properties: {
                type: { type: "string", description: "积分/数据分类名，例如金币、MASTER" }
            },
            required: ["type"]
        },
        requiredCapabilities: ["text"],
        invoke: async (event, params) => {
            const selfId = String(event.selfId ?? "");
            const gid = event.groupId ? String(event.groupId) : "0";
            const uid = String(event.userId ?? "");
            return await coins_operation(selfId, gid, uid, "0", String(params?.type ?? ""));
        }
    });
    // 渲染一段 keyword 变量标签模板，返回纯文本（供 AI 复用词库变量能力）
    ctx.registerSkill({
        name: "kw_render",
        description: "渲染一段 keyword 变量标签模板并返回纯文本结果",
        parameters: {
            type: "object",
            properties: {
                template: { type: "string", description: "含变量标签的模板文本，如 [userid]、[random.1.100]" }
            },
            required: ["template"]
        },
        requiredCapabilities: ["text"],
        invoke: async (event, params) => {
            const bot = get_bot(event.botId) ?? ({} as BaseAdapter);
            const segs = await parseBracketStr(String(params?.template ?? ""), bot, event);
            return segs.map(s => String(s.data?.text ?? "")).join("");
        }
    });
}

// 定时&循环 任务执行（任务按 selfId 隔离，启停只影响该机器人自身的任务）
async function controlTasks(
    selfId: string, taskObj: TaskListObj, action: "start" | "stop" = "start"
): Promise<void> {
    const prefix = `task_${selfId}_`;
    for (const [k, job] of Object.entries(jobPool)) {
        if (!k.startsWith(prefix)) continue;
        if ("cancel" in job && typeof job.cancel === "function") job.cancel();
        if ("timer" in job) safeClearInterval(job.timer);
        delete jobPool[k];
    }
    // 仅清理本机器人的去重缓存
    Object.keys(taskCache).forEach(k => {
        if (k.includes(`"botId":"${selfId}"`)) delete taskCache[k];
    });
    console.log(`已清空机器人 ${selfId} 的旧定时任务 & 任务缓存`);

    if (action === "stop") {
        console.log("所有任务已关闭");
        return;
    }

    const list = taskObj.work ?? [];
    const cfg = await fileCacheIO(CONFIG_FILE_PATH, "r") as any;
    const webui_url = cfg.webui_url;
    const webui_status = cfg.webui_status;
    if (webui_url && webui_status) {
        /*
        list.push({
            time: "30",
            botId: "102046363",
            groupId: "310231744",
            userId: "804019614",
            msg: `[get.${webui_url}102046363.txt]`,
            cache: true
        } as any);
        */
    }
    
    list.forEach((item) => {
        const cacheKey = JSON.stringify({ botId: item.botId, groupId: item.groupId, userId: item.userId, msg: item.msg, time: item.time });
        const parsed = parseHumanTime(item.time);

        const taskFn = async () => {
        try {
            const taskBot = get_bot(item.botId);
            if (!taskBot) {
                console.warn(`[定时任务] 机器人 ${item.botId} 不存在或未连接，跳过本次执行`);
                return;
            }
            const taskEvent: BotEvent = {
            botId: item.botId,
            selfId: taskBot.selfId || item.botId,
            userId: item.userId ?? 0,
            groupId: item.groupId  ?? 0,
            message: [],
            postType: "meta_event",
            raw: { time: Math.floor(Date.now() / 1000) },
            }
            const newRes = await parseBracketStr(item.msg, taskBot, taskEvent);

            if (item.cache) {
                // 对象不能比较 作者知识+1
                if (JSON.stringify(taskCache[cacheKey]) === JSON.stringify(newRes)) {
                    console.log("禁止回复");
                    return;
                }
            taskCache[cacheKey] = newRes;
            }
            // 触发任务
            await sendMsgCtx(taskBot, taskEvent, {
                group_id: item.groupId,
                user_id: item.userId,
            }, newRes)
        } catch (e) {
            console.error("任务执行异常：", e);
        }
        };

        let job: PoolJob;
        if (parsed instanceof Date) {
            job = schedule.scheduleJob(parsed, taskFn);
        } else if ("intervalSec" in parsed) {
            job = { timer: safeSetInterval(taskFn, parsed.intervalSec * 1000) };
        } else {
            job = schedule.scheduleJob(parsed, taskFn);
        }
        const key = `task_${item.botId}_${item.groupId}_${item.userId}_${item.msg}`;
        jobPool[key] = job;
        console.log(`创建任务 key:${key} time:${item.time} cache:${!!item.cache}`);
    });
}