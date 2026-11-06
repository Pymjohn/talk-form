#!/usr/bin/env node
// 谈心谈话 · 手机端填写服务
// 手机浏览器打开 → 填表 → 入队；后续由 CDP 驱动学工系统落库（第二步接入）。
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, statSync, readdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import webpush from "web-push";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, "data");
const QUEUE = join(DATA, "queue.jsonl");
const TOKEN_FILE = join(DATA, "token.txt");
const PLAN = join(DATA, "plan.json");
const STUDENTS = join(DATA, "students.json");
const ATTACH_DIR = join(DATA, "attachments");
mkdirSync(ATTACH_DIR, { recursive: true });
// md → docx 转换器（学工系统只接受办公文档）
const PY_KML = process.env.TALK_PY || "python3";   // 带 pandas 的解释器，用于 md→docx
const MD2DOCX = join(ROOT, "code", "md2docx.py");
const PORT = Number(process.env.TALK_PORT || 8787);
const VAPID_FILE = join(DATA, "vapid.json");
const SUBS_FILE = join(DATA, "push_subs.json");
const PUSH_LOG = join(DATA, "push_log.json");
const FOCUS_STATUS = join(DATA, "focus_status.json");
const NOTIFY_AHEAD_DAYS = 4;        // DDL 前 4 天开始提醒

let vapid = { publicKey: "", privateKey: "" };
try { vapid = JSON.parse(readFileSync(VAPID_FILE, "utf8")); } catch {}
if (vapid.publicKey && vapid.privateKey) {
  webpush.setVapidDetails("mailto:talk@local", vapid.publicKey, vapid.privateKey);
} else {
  console.log("警告: 缺少 data/vapid.json，推送不可用");
}

// SSE 客户端集合 + 广播
const sseClients = new Set();
function broadcast(event, data) {
  const payload = "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
  let n = 0;
  for (const c of sseClients) {
    try { c.res.write(payload); n++; } catch {}
  }
  return n;
}

// ===== 结构化运行日志（各环节成功/失败） =====
const APPLOG = join(DATA, "app.log");
function alog(stage, ok, detail) {
  try {
    const line = JSON.stringify({
      t: new Date().toISOString(),
      tl: localStamp(),
      stage: stage,
      ok: !!ok,
      detail: String(detail == null ? "" : detail).slice(0, 300),
    }) + "\n";
    appendFileSync(APPLOG, line);
    if (statSync(APPLOG).size > 512 * 1024) {
      const all = readFileSync(APPLOG, "utf8").split("\n").filter(Boolean);
      writeFileSync(APPLOG, all.slice(-400).join("\n") + "\n");
    }
  } catch (e) {}
}

function readSubs() { try { const a = JSON.parse(readFileSync(SUBS_FILE, "utf8")); return Array.isArray(a) ? a : []; } catch { return []; } }
function writeSubs(a) { writeFileSync(SUBS_FILE, JSON.stringify(a, null, 1)); }
function readPushLog() { try { return JSON.parse(readFileSync(PUSH_LOG, "utf8")) || {}; } catch { return {}; } }
function writePushLog(o) { writeFileSync(PUSH_LOG, JSON.stringify(o)); }

// 推送一条给所有订阅端；410/404 说明端点失效，顺手清理
async function pushAll(payload) {
  const subs = readSubs();
  if (!subs.length) return { sent: 0, total: 0 };
  const alive = [];
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(s, JSON.stringify(payload));
      alive.push(s); sent++;
    } catch (e) {
      const code = e && e.statusCode;
      if (code === 404 || code === 410) { wlog("推送端点已失效，移除: " + String(s.endpoint).slice(-24)); }
      else { alive.push(s); wlog("推送失败 " + (code || "") + ": " + (e.message || e)); }
    }
  }
  if (alive.length !== subs.length) writeSubs(alive);
  return { sent, total: subs.length };
}

mkdirSync(DATA, { recursive: true });
if (!existsSync(TOKEN_FILE)) writeFileSync(TOKEN_FILE, randomBytes(9).toString("hex"), { mode: 0o600 });
const TOKEN = readFileSync(TOKEN_FILE, "utf8").trim();

const ENUMS = {
  fangshi: ["面谈", "电话", "短信", "QQ", "微信", "其他"],
  famaoren: ["辅导员", "学生", "家长", "导师"],
  shegong: ["班委", "级队委", "各级团学社", "无"],
  leibie: ["重点关注", "科研学业", "心理疏导", "导学关系", "家庭问题", "思想问题", "人际交往", "突发问题", "社会工作", "就业规划", "经济资助", "党员发展", "违规违纪", "家长谈话", "其他"],
  zipin: ["效果很好", "效果较好", "一般", "略有效果", "没有效果"],
  genzong: ["需要进一步跟踪", "暂不需要跟踪"],
  bj: ["未来2404", "未来2405", "未来2406", "未来2407"],
};

// 姓名必填；学号选填（填了用于精确锁定，避免重名错选）
const REQUIRED = ["xm", "thrq", "kssj", "thsc", "fangshi", "famaoren", "zipin", "genzong"];
const DEFAULT_DIDIAN = "104";   // 地点不填时按 104 提交

let studCache = { mtime: 0, data: null };
function readStudents() {
  try {
    const st = statSync(STUDENTS);
    if (studCache.data && studCache.mtime === st.mtimeMs) return studCache.data;
    const d = JSON.parse(readFileSync(STUDENTS, "utf8"));
    studCache = { mtime: st.mtimeMs, data: d };
    return d;
  } catch {
    return { meta: { count: 0, columns: [] }, students: [] };
  }
}

function readPlan() {
  try { const a = JSON.parse(readFileSync(PLAN, "utf8")); return Array.isArray(a) ? a : []; } catch { return []; }
}
function writePlan(arr) { writeFileSync(PLAN, JSON.stringify(arr, null, 1)); }

function validate(o) {
  const errs = [];
  if (!String(o.thdd ?? "").trim()) o.thdd = DEFAULT_DIDIAN;   // 地点缺省补 104，不作必填拦截
  for (const k of REQUIRED) if (!String(o[k] ?? "").trim()) errs.push("缺少字段: " + k);
  if (o.xh && !/^\d{6,14}$/.test(String(o.xh))) errs.push("学号填了就要是 6–14 位数字");
  if (o.thrq && !/^\d{4}-\d{2}-\d{2}$/.test(o.thrq)) errs.push("日期格式应为 YYYY-MM-DD");
  if (o.kssj && !/^\d{2}:\d{2}$/.test(o.kssj)) errs.push("时间格式应为 HH:MM");
  if (o.thsc && !(Number(o.thsc) > 0 && Number(o.thsc) <= 600)) errs.push("时长应为 1–600 分钟");
  // 学工系统表单校验：要点/分析各不少于 5 字
  if (String(o.yaodian || "").trim().length < 5) errs.push("谈话要点至少 5 个字");
  if (String(o.fenxi || "").trim().length < 5) errs.push("谈话分析至少 5 个字");
  for (const [k, list] of Object.entries(ENUMS)) {
    const v = o[k]; if (!v) continue;
    const arr = Array.isArray(v) ? v : [v];
    for (const x of arr) if (!list.includes(x)) errs.push(k + " 取值非法: " + x);
  }
  if (Array.isArray(o.leibie) && o.leibie.length === 0) errs.push("至少选一个谈话类别");
  return errs;
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}
function authed(req, url) {
  if (url.searchParams.get("k") === TOKEN) return true;
  return (req.headers.cookie || "").includes("talk=" + TOKEN);
}

// ===== 常驻队列 watcher：发现待提交记录且 CDP 浏览器在线时，自动拉起 cdp_submit =====
const CDP_PORT = process.env.CDP_PORT || 9222;
const SUBMIT = join(ROOT, "code", "cdp_submit.mjs");
const SUBMIT_LOG = join(DATA, "submit.log");
let submitProc = null;
// 页面定时刷新：长时间挂着的页面会累积标签、session 也可能失效，导致新表单不渲染
const REFRESH_FILE = join(DATA, "last_refresh.json");
const REFRESH_INTERVAL = 2 * 3600 * 1000;
let lastRefreshAt = 0;
try { lastRefreshAt = JSON.parse(readFileSync(REFRESH_FILE, "utf8")).at || 0; } catch {}
let refreshing = false;

function keepFresh() {
  if (refreshing) return;
  if (Date.now() - lastRefreshAt < REFRESH_INTERVAL) return;
  if (submitProc) return;                 // 有任务在跑，等下一轮
  refreshing = true;
  wlog("定时刷新页面（距上次 " + Math.round((Date.now() - lastRefreshAt) / 60000) + " 分钟）");
  const p = spawn(process.execPath, [join(ROOT, "code", "refresh.mjs")], { stdio: "ignore" });
  p.on("exit", (code) => {
    lastRefreshAt = Date.now();
    try { writeFileSync(REFRESH_FILE, JSON.stringify({ at: lastRefreshAt })); } catch {}
    wlog("页面定时刷新结束 code=" + code);
    refreshing = false;
  });
  p.on("error", (e) => { wlog("刷新进程错误: " + e.message); refreshing = false; });
}

// 本地时间字符串（submit.log 里不能用 toISOString，那是 UTC，看起来会差 8 小时）
function localStamp(d) {
  d = d || new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " +
    p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function wlog(msg) {
  console.log("[watch] " + msg);
  try { appendFileSync(SUBMIT_LOG, localStamp() + " " + msg + "\n"); } catch {}
}

async function cdpAlive() {
  try {
    const r = await fetch("http://127.0.0.1:" + CDP_PORT + "/json/version", { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch { return false; }
}

async function watchTick() {
  if (submitProc || refreshing) return;
  keepFresh();
  if (refreshing) return;
  let pending = [];
  try {
    pending = existsSync(QUEUE)
      ? readFileSync(QUEUE, "utf8").split("\n").filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } })
          .filter((r) => r && r.status === "queued")
      : [];
  } catch (e) { wlog("读队列失败: " + e.message); return; }
  if (!pending.length) return;
  if (!(await cdpAlive())) return; // 浏览器未就绪（自启中/被关），等下一轮
  wlog("发现 " + pending.length + " 条待提交记录，启动 CDP 提交");
  alog("watcher 启动", true, pending.length + " 条：" + pending.map((x) => x.xm).join("、"));
  submitProc = spawn(process.execPath, [SUBMIT, "--queue"], { stdio: ["ignore", "pipe", "pipe"] });
  submitProc.stdout.on("data", (d) => d.toString().split("\n").filter(Boolean).forEach((l) => wlog(l)));
  submitProc.stderr.on("data", (d) => d.toString().split("\n").filter(Boolean).forEach((l) => wlog("[err] " + l)));
  submitProc.on("exit", (code) => {
    wlog("提交进程退出 code=" + code);
    alog("watcher 结束", code === 0, "提交进程退出码 " + code);
    submitProc = null;
  });
  submitProc.on("error", (e) => { wlog("提交进程错误: " + e.message); submitProc = null; });
}
setInterval(watchTick, 30000);
setTimeout(watchTick, 5000); // 启动后先查一次

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  // 访问诊断日志：能区分「TCP 没到」和「到了但页面没出来」
  if (!/^127\.|^::1$/.test(req.socket.remoteAddress || "")) {
    console.log("[req]", new Date().toISOString().slice(11, 19), req.socket.remoteAddress, req.method, p);
  }

  if (p === "/" || p === "/index.html") {
    if (!authed(req, url)) { res.writeHead(403, { "content-type": "text/plain; charset=utf-8" }); return res.end("需要访问令牌：/?k=<token>"); }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": "talk=" + TOKEN + "; Path=/; Max-Age=31536000; HttpOnly",
    });
    return res.end(readFileSync(join(ROOT, "public", "index.html"), "utf8").replace("__ENUMS__", JSON.stringify(ENUMS)));
  }

  if (p === "/api/submit" && req.method === "POST") {
    if (!authed(req, url)) return json(res, 403, { ok: false, error: "unauthorized" });
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => {
      let o;
      try { o = JSON.parse(body); } catch { return json(res, 400, { ok: false, error: "JSON 解析失败" }); }
      const errs = validate(o);
      if (errs.length) {
        alog("提交校验", false, String(o.xm || "") + "：" + errs.join("；"));
        return json(res, 400, { ok: false, errors: errs });
      }
      const rec = { id: Date.now().toString(36) + randomBytes(2).toString("hex"), status: "queued", createdAt: new Date().toISOString(), ...o };
      appendFileSync(QUEUE, JSON.stringify(rec) + "\n");
      alog("提交入队", true, rec.xm + " " + rec.thrq + " " + rec.kssj + " → " + rec.id);
      json(res, 200, { ok: true, id: rec.id });
    });
    return;
  }

  if (p === "/api/items") {
    if (!authed(req, url)) return json(res, 403, { ok: false, error: "unauthorized" });
    const lines = existsSync(QUEUE) ? readFileSync(QUEUE, "utf8").trim().split("\n").filter(Boolean) : [];
    const items = lines.slice(-50).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return json(res, 200, { ok: true, items });
  }

  // ===== 附件上传（谈话录音/记录）=====
  if (p === "/api/attach" && req.method === "POST") {
    if (!authed(req, url)) return json(res, 403, { ok: false, error: "unauthorized" });
    const raw = decodeURIComponent(url.searchParams.get("name") || "file");
    const safe = raw.replace(/[\\/:*?"<>|\s]+/g, "_").slice(-90) || "file";
    const id = Date.now().toString(36) + randomBytes(2).toString("hex");
    const dir = join(ATTACH_DIR, id);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, safe);
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > 30e6) { aborted = true; req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (aborted) return;
      try {
        writeFileSync(file, Buffer.concat(chunks));
        // .md 自动转 docx（学工系统会拒绝 md）
        if (/\.md$/i.test(safe)) {
          const docxName = safe.replace(/\.md$/i, ".docx");
          const docxPath = join(dir, docxName);
          try {
            execFileSync(PY_KML, [MD2DOCX, file, docxPath], { timeout: 60000, stdio: "ignore" });
            const st = statSync(docxPath);
            return json(res, 200, { ok: true, id, name: docxName, path: docxPath, size: st.size, convertedFrom: safe });
          } catch (e) {
            return json(res, 500, { ok: false, error: "md 转 docx 失败: " + (e.message || e) });
          }
        }
        json(res, 200, { ok: true, id, name: safe, path: file, size });
      } catch (e) {
        json(res, 500, { ok: false, error: e.message });
      }
    });
    return;
  }

  // ===== 每日提醒内容（App 后台任务用，不依赖网页）=====
  if (p === "/api/daily-brief" && req.method === "GET") {
    if (!authed(req, url)) return json(res, 403, { ok: false, error: "unauthorized" });
    const _d = new Date(); _d.setDate(_d.getDate() + 1);
    const _p = (n) => String(n).padStart(2, "0");
    const tomorrow = _d.getFullYear() + "-" + _p(_d.getMonth() + 1) + "-" + _p(_d.getDate());
    let plans = [];
    try { plans = readPlan().filter((x) => x.status !== "done" && x.thrq === tomorrow); } catch {}
    plans.sort((a, b) => (a.thrq + a.kssj).localeCompare(b.thrq + b.kssj));

    let fst = null;
    try { fst = JSON.parse(readFileSync(FOCUS_STATUS, "utf8")); } catch {}
    const rows = ((fst && fst.rows) || []).filter((r) => r.status !== "inactive" && r.status !== "done");

    // 周期剩余天数：用 period.end 实时算，避免 focus_status 快照过期导致天数不动
    const today0 = new Date(); today0.setHours(0, 0, 0, 0);
    const endRaw = fst && fst.period ? String(fst.period.end).slice(0, 10) : "";
    const endDate = endRaw ? new Date(endRaw + "T00:00:00") : null;
    const daysLeft = endDate && !isNaN(endDate) ? Math.max(0, Math.ceil((endDate - today0) / 86400000)) : null;
    const leftTxt = daysLeft == null ? "?" : daysLeft;

    const lines = [];
    if (fst && fst.period) {
      lines.push("考核周期 #" + fst.period.idx + "  " + String(fst.period.start).slice(5) + " ~ " + String(fst.period.end).slice(5));
    }
    lines.push("本周期还剩 " + leftTxt + " 天" + (daysLeft === 0 ? "（今天截止）" : ""));
    lines.push("");
    if (rows.length) {
      lines.push("还有 " + rows.length + " 人本周期没谈：");
      rows.slice().sort((a, b) => (a.daysLeft || 0) - (b.daysLeft || 0))
        .slice(0, 8)
        .forEach((r) => lines.push("· " + r.name + (r.cls ? "（" + r.cls + "）" : "") + (r.daysLeft === 0 ? " 今天截止" : " 剩 " + r.daysLeft + " 天")));
      if (rows.length > 8) lines.push("… 还有 " + (rows.length - 8) + " 人");
    } else {
      lines.push("本周期关注学生都已谈过");
    }

    const title = "谈心提醒 · 本周期还剩 " + leftTxt + " 天" +
      (rows.length ? " · " + rows.length + " 人未谈" : "");

    // 供 App 写进系统日历的明细（未来 30 天的待谈名单）
    let upcoming = [];
    try {
      upcoming = readPlan()
        .filter((x) => x.status !== "done" && x.thrq)
        .sort((a, b) => (a.thrq + a.kssj).localeCompare(b.thrq + b.kssj))
        .slice(0, 30)
        .map((x) => ({ id: x.id, xm: x.xm, bj: x.bj || "", xh: x.xh || "", thrq: x.thrq, kssj: x.kssj || "09:00", thdd: x.thdd || "" }));
    } catch {}

    return json(res, 200, {
      ok: true, title, desc: lines.join("\n"),
      plans: plans.length, focus: rows.length,
      items: upcoming,
    });
  }

  // ===== 客户端尺寸上报（用于适配调试）=====
  if (p === "/api/client-info" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on("end", () => {
      let o = {};
      try { o = JSON.parse(body); } catch {}
      alog("客户端信息", true,
        (o.w || "?") + "x" + (o.h || "?") + " dpr" + (o.dpr || "?") +
        " 屏" + (o.sw || "?") + "x" + (o.sh || "?") + " | " + String(o.ua || "").slice(0, 90));
      json(res, 200, { ok: true });
    });
    return;
  }

  // ===== 运行日志（各环节成功/失败）=====
  if (p === "/api/logs" && req.method === "GET") {
    if (!authed(req, url)) return json(res, 403, { ok: false, error: "unauthorized" });
    const limit = Math.min(200, Number(url.searchParams.get("limit") || 60) || 60);
    let lines = [];
    try { lines = readFileSync(join(DATA, "app.log"), "utf8").split("\n").filter(Boolean).slice(-limit); } catch {}
    const items = [];
    for (const l of lines) { try { items.push(JSON.parse(l)); } catch {} }
    items.reverse();
    return json(res, 200, { ok: true, items });
  }

  // ===== App 版本信息（供 App 内自更新）=====
  if (p === "/api/app/version" && req.method === "GET") {
    if (!authed(req, url)) return json(res, 403, { ok: false, error: "unauthorized" });
    let info = null;
    try { info = JSON.parse(readFileSync(join(ROOT, "public", "apk", "talk-notify.version.json"), "utf8")); } catch {}
    if (!info) return json(res, 404, { ok: false, error: "缺少版本文件" });
    const apk = join(ROOT, "public", "apk", "talk-notify.apk");
    if (!existsSync(apk)) return json(res, 404, { ok: false, error: "缺少 APK" });
    return json(res, 200, {
      ok: true,
      versionCode: info.versionCode,
      versionName: info.versionName,
      size: statSync(apk).size,
      url: "/apk/talk-notify.apk?k=" + TOKEN + "&v=" + info.versionCode,
    });
  }

  // ===== 手机端文件下载（APK / 脚本）=====
  if (p.startsWith("/apk/") && req.method === "GET") {
    if (!authed(req, url)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      return res.end("需要访问令牌：?k=<token>");
    }
    const name = decodeURIComponent(p.slice("/apk/".length));
    if (!/^[\w.+-]+\.apk$/i.test(name)) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      return res.end("非法文件名");
    }
    alog("APK下载", true, name);
    const file = join(ROOT, "public", "apk", name);
    if (!existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("文件不存在");
    }
    res.writeHead(200, {
      "content-type": "application/vnd.android.package-archive",
      "content-disposition": 'attachment; filename="' + name + '"',
      "content-length": statSync(file).size,
      "cache-control": "no-store",
    });
    return res.end(readFileSync(file));
  }

  // ===== 手机端脚本下载（Termux 用）=====
  if ((p === "/termux/alerts.sh" || p === "/termux/notify.sh" || p === "/termux/boot.sh") && req.method === "GET") {
    if (!authed(req, url)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      return res.end("需要访问令牌：?k=<token>");
    }
    const file = p === "/termux/alerts.sh" ? "termux-alerts.sh" : (p === "/termux/boot.sh" ? "termux-boot.sh" : "termux-notify.sh");
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    return res.end(readFileSync(join(ROOT, "code", file), "utf8"));
  }

  // ===== 实时事件流（SSE）：手机端常连接收，收到即弹本地通知 =====
  if (p === "/api/alerts/stream" && req.method === "GET") {
    if (!authed(req, url)) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      return res.end("unauthorized");
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected " + new Date().toISOString() + "\n\n");
    const client = { res };
    sseClients.add(client);
    wlog("事件流连接 +1（当前 " + sseClients.size + "）");
    alog("实时连接", true, "客户端接入，当前 " + sseClients.size + " 个");
    const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25000);
    req.on("close", () => {
      clearInterval(hb);
      sseClients.delete(client);
      wlog("事件流断开（当前 " + sseClients.size + "）");
    });
    return;
  }

  if (p === "/api/app/sync-calendar" && req.method === "POST") {
    if (!authed(req, url)) return json(res, 403, { ok: false, error: "unauthorized" });
    const n = broadcast("alert", { action: "calendar", title: "服务器指令 · 同步日历", body: "立即更新本周期提醒" });
    alog("日历指令", n > 0, "已下发，在线连接 " + n + " 个");
    return json(res, 200, { ok: true, clients: n });
  }

  if (p === "/api/alerts/test" && req.method === "POST") {
    if (!authed(req, url)) return json(res, 403, { ok: false, error: "unauthorized" });
    const n = broadcast("alert", { title: "服务器指令 · 测试", body: "看到这条说明服务器能主动叫醒手机", url: "/#focus" });
    return json(res, 200, { ok: true, clients: n });
  }

  // ===== 推送订阅 =====
  if (p === "/api/push/key" && req.method === "GET") {
    if (!authed(req, url)) return json(res, 403, { ok: false, error: "unauthorized" });
    return json(res, 200, { ok: true, key: vapid.publicKey, subs: readSubs().length, ahead: NOTIFY_AHEAD_DAYS });
  }

  if (p === "/api/push/subscribe" && req.method === "POST") {
    if (!authed(req, url)) return json(res, 403, { ok: false, error: "unauthorized" });
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on("end", () => {
      let sub;
      try { sub = JSON.parse(body); } catch { return json(res, 400, { ok: false, error: "JSON 解析失败" }); }
      if (!sub || !sub.endpoint) return json(res, 400, { ok: false, error: "缺少 endpoint" });
      const subs = readSubs().filter((s) => s.endpoint !== sub.endpoint);
      subs.push({ endpoint: sub.endpoint, keys: sub.keys, ua: String(sub.ua || "").slice(0, 80), at: new Date().toISOString() });
      writeSubs(subs);
      wlog("新增推送订阅，共 " + subs.length + " 个");
      return json(res, 200, { ok: true, subs: subs.length });
    });
    return;
  }

  if (p === "/api/push/unsubscribe" && req.method === "POST") {
    if (!authed(req, url)) return json(res, 403, { ok: false, error: "unauthorized" });
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on("end", () => {
      let o = {};
      try { o = JSON.parse(body); } catch {}
      const subs = readSubs().filter((s) => s.endpoint !== o.endpoint);
      writeSubs(subs);
      return json(res, 200, { ok: true, subs: subs.length });
    });
    return;
  }

  if (p === "/api/push/test" && req.method === "POST") {
    if (!authed(req, url)) return json(res, 403, { ok: false, error: "unauthorized" });
    pushAll({ title: "谈心谈话 · 通知已开启", body: "之后重点关注学生临近 14 天期限时会推给你", url: "/#plan", tag: "test" })
      .then((r) => json(res, 200, { ok: true, ...r }))
      .catch((e) => json(res, 500, { ok: false, error: e.message }));
    return;
  }

  // ===== 重点关注 =====
  if (p === "/api/focus" && req.method === "GET") {
    if (!authed(req, url)) return json(res, 403, { ok: false, error: "unauthorized" });
    let d = null;
    try { d = JSON.parse(readFileSync(FOCUS_STATUS, "utf8")); } catch {}
    return json(res, 200, { ok: true, ahead: NOTIFY_AHEAD_DAYS, data: d });
  }

  // 给 Service Worker / 页面用的精简提醒数据（不含敏感字段）
  if (p === "/api/focus/brief" && req.method === "GET") {
    if (!authed(req, url)) return json(res, 403, { ok: false, error: "unauthorized" });
    let d = null;
    try { d = JSON.parse(readFileSync(FOCUS_STATUS, "utf8")); } catch {}
    if (!d || !d.rows) return json(res, 200, { ok: true, need: 0, text: "", period: null });
    const urgent = d.rows.filter((r) => r.status === "urgent");
    const pending = d.rows.filter((r) => r.status === "pending" || r.status === "urgent");
    const text = urgent.slice(0, 4).map((r) => r.name + " 剩" + r.daysLeft + "天").join("、") +
      (urgent.length > 4 ? " 等 " + urgent.length + " 人" : "");
    return json(res, 200, {
      ok: true, need: urgent.length, pending: pending.length, text,
      period: d.period ? d.period.end : null,
    });
  }

  if (p === "/api/focus/refresh" && req.method === "POST") {
    if (!authed(req, url)) return json(res, 403, { ok: false, error: "unauthorized" });
    try {
      // 学工 CAS 会话过期会跳登录页，focus.mjs 直接失败；自动用 pw.txt 重登一次再抓
      try {
        execFileSync(process.execPath, [join(ROOT, "code", "focus.mjs")], { timeout: 180000, stdio: "ignore" });
      } catch (e1) {
        wlog("重点关注抓取失败，尝试自动登录后重试（" + (e1.message || e1) + "）");
        execFileSync(process.execPath, [join(ROOT, "code", "login.mjs")], { timeout: 150000, stdio: "ignore" });
        execFileSync(process.execPath, [join(ROOT, "code", "focus.mjs")], { timeout: 180000, stdio: "ignore" });
      }
      execFileSync(process.execPath, [join(ROOT, "code", "focus_cycle.mjs")], { timeout: 60000, stdio: "ignore" });
      const d = JSON.parse(readFileSync(FOCUS_STATUS, "utf8"));
      wlog("重点关注已刷新: 关注中 " + d.activeCount + " 人，本周期已谈 " + d.doneCount + " 人");
      return json(res, 200, { ok: true, data: d });
    } catch (e) {
      return json(res, 500, { ok: false, error: "读取失败: " + (e.message || e) });
    }
  }

  // ===== 附件库（列表 / 删除）=====
  if (p === "/api/attachments" && req.method === "GET") {
    if (!authed(req, url)) return json(res, 403, { ok: false, error: "unauthorized" });
    const items = [];
    let ents = [];
    try { ents = readdirSync(ATTACH_DIR, { withFileTypes: true }); } catch (e) {}
    for (const d of ents) {
      const abs = join(ATTACH_DIR, d.name);
      if (d.isDirectory()) {
        let files = [];
        try { files = readdirSync(abs); } catch (e) { continue; }
        for (const fn of files) {
          try {
            const st = statSync(join(abs, fn));
            items.push({ id: d.name, name: fn, size: st.size, at: st.mtime.toISOString(), path: join(abs, fn) });
          } catch (e) {}
        }
      } else if (d.isFile()) {
        try {
          const st = statSync(abs);
          items.push({ id: d.name, name: d.name, size: st.size, at: st.mtime.toISOString(), path: abs });
        } catch (e) {}
      }
    }
    items.sort((a, b) => (a.at < b.at ? 1 : -1));
    return json(res, 200, { ok: true, items: items.slice(0, 100) });
  }

  if (p.startsWith("/api/attachments/") && req.method === "DELETE") {
    if (!authed(req, url)) return json(res, 403, { ok: false, error: "unauthorized" });
    const id = decodeURIComponent(p.slice("/api/attachments/".length));
    if (!/^[a-z0-9]+$/i.test(id)) return json(res, 400, { ok: false, error: "非法 id" });
    try { rmSync(join(ATTACH_DIR, id), { recursive: true, force: true }); } catch (e) {}
    return json(res, 200, { ok: true });
  }

  // ===== 周计划名单 =====
  if (p === "/api/plan") {
    if (!authed(req, url)) return json(res, 403, { ok: false, error: "unauthorized" });
    if (req.method === "GET") return json(res, 200, { ok: true, items: readPlan() });
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 2e5) req.destroy(); });
      req.on("end", () => {
        let o;
        try { o = JSON.parse(body); } catch { return json(res, 400, { ok: false, error: "JSON 解析失败" }); }
        const xm = String(o.xm || "").trim();
        if (!xm) return json(res, 400, { ok: false, error: "姓名必填" });
        const bj = String(o.bj || "").trim();
        if (!bj) return json(res, 400, { ok: false, error: "班级必填" });
        if (!ENUMS.bj.includes(bj)) return json(res, 400, { ok: false, error: "班级取值非法: " + bj });
        const arr = readPlan();
        const rec = {
          id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
          xm,
          bj,
          xh: String(o.xh || "").trim(),
          thrq: String(o.thrq || "").trim(),
          kssj: String(o.kssj || "").trim(),
          thdd: String(o.thdd || "").trim(),
          status: "pending",
          createdAt: new Date().toISOString(),
        };
        arr.push(rec);
        writePlan(arr);
        return json(res, 200, { ok: true, item: rec });
      });
      return;
    }
  }

  // ===== 学生档案（来自 data/students.json，由 code/import_students.py 生成） =====
  if (p === "/api/student") {
    if (!authed(req, url)) return json(res, 403, { ok: false, error: "unauthorized" });
    const xh = (url.searchParams.get("xh") || "").trim();
    const xm = (url.searchParams.get("xm") || "").trim();
    const db = readStudents();
    const columns = (db.meta && db.meta.columns) || [];
    const list = db.students || [];
    if (!xh && !xm) return json(res, 200, { ok: true, student: null, columns, count: list.length });
    if (xh) {
      const hit = list.find((x) => String(x.xh) === xh);
      if (hit) return json(res, 200, { ok: true, student: hit, columns });
    }
    if (xm) {
      const cands = list.filter((x) => String(x.xm) === xm);
      if (cands.length === 1) return json(res, 200, { ok: true, student: cands[0], columns });
      if (cands.length > 1) return json(res, 200, { ok: true, student: null, ambiguous: true, candidates: cands.map((x) => ({ xh: x.xh, xm: x.xm, bj: x.bj })), columns });
    }
    return json(res, 200, { ok: true, student: null, columns, count: list.length });
  }

  if (p === "/api/plan/done" && req.method === "POST") {
    if (!authed(req, url)) return json(res, 403, { ok: false, error: "unauthorized" });
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 2e5) req.destroy(); });
    req.on("end", () => {
      let o;
      try { o = JSON.parse(body); } catch { return json(res, 400, { ok: false, error: "JSON 解析失败" }); }
      const arr = readPlan();
      const it = arr.find((x) => x.id === o.id);
      if (!it) return json(res, 404, { ok: false, error: "名单项不存在" });
      it.status = "done";
      it.doneAt = new Date().toISOString();
      if (o.queueId) it.queueId = String(o.queueId);
      writePlan(arr);
      return json(res, 200, { ok: true, item: it });
    });
    return;
  }

  if (p.startsWith("/api/plan/") && (req.method === "PATCH" || req.method === "PUT")) {
    if (!authed(req, url)) return json(res, 403, { ok: false, error: "unauthorized" });
    const id = decodeURIComponent(p.slice("/api/plan/".length));
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 2e4) req.destroy(); });
    req.on("end", () => {
      let o;
      try { o = JSON.parse(body); } catch { return json(res, 400, { ok: false, error: "JSON 解析失败" }); }
      const arr = readPlan();
      const it = arr.find((x) => x.id === id);
      if (!it) return json(res, 404, { ok: false, error: "名单项不存在" });
      if (o.thrq != null) {
        const v = String(o.thrq).trim();
        if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return json(res, 400, { ok: false, error: "日期格式应为 YYYY-MM-DD" });
        it.thrq = v;
      }
      if (o.kssj != null) {
        const v = String(o.kssj).trim();
        if (v && !/^\d{2}:\d{2}$/.test(v)) return json(res, 400, { ok: false, error: "时间格式应为 HH:MM" });
        it.kssj = v;
      }
      if (o.thdd != null) it.thdd = String(o.thdd).trim();
      it.updatedAt = new Date().toISOString();
      writePlan(arr);
      return json(res, 200, { ok: true, item: it });
    });
    return;
  }

  if (p.startsWith("/api/plan/") && req.method === "DELETE") {
    if (!authed(req, url)) return json(res, 403, { ok: false, error: "unauthorized" });
    const id = decodeURIComponent(p.slice("/api/plan/".length));
    const arr = readPlan().filter((x) => x.id !== id);
    writePlan(arr);
    return json(res, 200, { ok: true, left: arr.length });
  }

  // 静态资源：manifest / service worker / 图标（PWA 需要同源 + 根路径作用域）
  if (p === "/manifest.webmanifest" || p === "/sw.js" || /^\/icon-\d+\.png$/.test(p)) {
    const file = join(ROOT, "public", p.slice(1));
    if (!existsSync(file)) { res.writeHead(404); return res.end(); }
    const type = p.endsWith(".png") ? "image/png"
      : p.endsWith(".js") ? "application/javascript; charset=utf-8"
      : "application/manifest+json; charset=utf-8";
    res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=3600" });
    return res.end(readFileSync(file));
  }

  if (p === "/health") return json(res, 200, { ok: true, port: PORT, watcher: { busy: !!submitProc } });
  if (p === "/api/log") {
    if (!authed(req, url)) return json(res, 403, { ok: false, error: "unauthorized" });
    const tail = existsSync(SUBMIT_LOG) ? readFileSync(SUBMIT_LOG, "utf8").split("\n").slice(-40).join("\n") : "(空)";
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return res.end(tail);
  }
  json(res, 404, { ok: false, error: "not found" });
});

// TCP 连接级日志（排除本机），用于诊断手机能否连上
server.on("connection", (sock) => {
  if (!/^127\.|^::1$/.test(sock.remoteAddress || "")) {
    console.log("[conn]", new Date().toISOString().slice(11, 19), sock.remoteAddress + ":" + sock.remotePort);
  }
});

// ===== 重点关注 14 天周期检查 =====
// 每小时跑一次：抓学工「重点关注」页 → 算 DDL → 临期/逾期/无记录的推送提醒（每人每天最多一条）
const FOCUS_CHECK_FILE = join(DATA, "last_focus_check.json");
const FOCUS_INTERVAL = 60 * 60 * 1000;
let lastFocusCheck = 0;
try { lastFocusCheck = JSON.parse(readFileSync(FOCUS_CHECK_FILE, "utf8")).at || 0; } catch {}
let focusBusy = false;

function runScript(script, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(ROOT, "code", script)], { stdio: "ignore" });
    const t = setTimeout(() => { try { p.kill(); } catch {} reject(new Error(script + " 超时")); }, timeoutMs || 180000);
    p.on("exit", (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(script + " 退出码 " + code)); });
    p.on("error", (e) => { clearTimeout(t); reject(e); });
  });
}

const localYmd = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");

function describe(r) {
  if (r.daysLeft === 0) return r.name + " 本周期今天截止";
  return r.name + " 本周期还没谈，剩 " + r.daysLeft + " 天";
}

async function runScriptWithLogin(script, timeoutMs) {
  try {
    await runScript(script, timeoutMs);
  } catch (e) {
    wlog(script + " 失败（" + e.message + "），尝试自动登录后重试");
    await runScript("login.mjs", 150000);
    await runScript(script, timeoutMs);
  }
}

async function focusCheck(reason) {
  if (focusBusy) return;
  focusBusy = true;
  try {
    wlog("重点关注检查（" + reason + "）");
    await runScriptWithLogin("focus.mjs", 180000);
    await runScript("focus_cycle.mjs", 60000);
    lastFocusCheck = Date.now();
    try { writeFileSync(FOCUS_CHECK_FILE, JSON.stringify({ at: lastFocusCheck })); } catch {}

    const st = JSON.parse(readFileSync(FOCUS_STATUS, "utf8"));
    const today = localYmd(new Date());
    const log = readPushLog();
    // 只在「本周期还没谈 && 本周期剩余 <= 4 天」时提醒
    const alerts = (st.rows || []).filter((r) => r.status === "urgent");
    const fresh = alerts.filter((r) => !log[today + "|" + r.name]);
    alog("重点关注检查", true, "关注中 " + (st.activeCount || 0) + " 已谈 " + (st.doneCount || 0) + "，本周期待谈 " + alerts.length);
    if (!fresh.length) { wlog("重点关注无新提醒（本周期待谈 " + alerts.length + " 人）"); return; }

    const title = st.period
      ? "重点周期 · " + fresh.length + " 人本周期未谈（" + st.period.end.slice(5) + " 截止）"
      : "重点周期 · " + fresh.length + " 人未谈";
    const body = fresh.slice(0, 5).map(describe).join("；") + (fresh.length > 5 ? " 等 " + fresh.length + " 人" : "");
    const res = await pushAll({ title, body, url: "/#plan", tag: "focus-cycle" });
    const nSse = broadcast("alert", { title, body, url: "/#focus" });   // 手机端 SSE 收到后弹本地通知
    alog("到期提醒", true, "推送 " + res.sent + "/" + res.total + "，实时连接 " + nSse + " 个：" + body.slice(0, 80));
    fresh.forEach((r) => { log[today + "|" + r.name] = r.status; });
    writePushLog(log);
    wlog("推送提醒: " + body + " （成功 " + res.sent + "/" + res.total + "）");
  } catch (e) {
    wlog("重点关注检查失败: " + (e.message || e));
    alog("重点关注检查", false, e.message || String(e));
  } finally {
    focusBusy = false;
  }
}

server.listen(PORT, "0.0.0.0", () => {
  console.log("listening http://0.0.0.0:" + PORT);
  console.log("token: " + TOKEN);
  setTimeout(() => focusCheck("启动后首次"), 40000);
  setInterval(() => { if (Date.now() - lastFocusCheck > FOCUS_INTERVAL) focusCheck("定时"); }, 10 * 60 * 1000);
});
