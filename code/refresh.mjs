#!/usr/bin/env node
// 定时刷新学工系统页面：长时间挂着的页面会累积标签、后端 session 也可能失效，
// 导致「添加」能建标签但表单不渲染。由 watcher 每 2 小时调用一次。
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const CDP = process.env.CDP_PORT || 9222;
const ROOT = (process.env.TALK_ROOT || join(homedir(), "talk-form"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch("http://127.0.0.1:" + CDP + "/json/list")).json();
const page = list.find((x) => x.type === "page" && x.url.includes("dutxg"));
if (!page) {
  console.log("没有学工系统标签页，尝试打开");
  // 新版本 Chrome 忽略 /json/new?url=，只会开 about:blank，得自己导航
  const created = await (await fetch("http://127.0.0.1:" + CDP + "/json/new", { method: "PUT" })).json();
  if (created && created.webSocketDebuggerUrl) {
    const w = new WebSocket(created.webSocketDebuggerUrl);
    await new Promise((r) => (w.onopen = r));
    w.send(JSON.stringify({ id: 1, method: "Page.navigate", params: { url: "http://dutxg.dlut.edu.cn/gzsc/" } }));
    await sleep(1500);
    try { w.close(); } catch {}
  }
  await sleep(8000);
}

const list2 = await (await fetch("http://127.0.0.1:" + CDP + "/json/list")).json();
const p2 = list2.find((x) => x.type === "page" && x.url.includes("dutxg"));
if (!p2) { console.log("无法打开学工系统"); process.exit(1); }

const ws = new WebSocket(p2.webSocketDebuggerUrl);
let seq = 0;
const pend = new Map();
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true }); return r.result?.result?.value; };

await send("Page.enable");
await send("Page.reload", { ignoreCache: false });
await sleep(11000);

const url = String(await ev("location.href"));
const role = await ev("(function(){ var b = document.querySelector('.role_box'); return b ? b.innerText.replace(/\\s+/g,' ') : ''; })()");
console.log("刷新后 URL:", url, "| 角色:", role || "(无)");

let ok = !!role;
if (!ok && /login|authserver|sso/.test(url)) {
  console.log("会话已过期，自动登录");
  try {
    execFileSync(process.execPath, [join(ROOT, "code", "login.mjs")], { stdio: "inherit", timeout: 120000 });
    await sleep(5000);
    const role2 = await ev("(function(){ var b = document.querySelector('.role_box'); return b ? b.innerText.replace(/\\s+/g,' ') : ''; })()");
    ok = !!role2;
    console.log("登录后角色:", role2 || "(无)");
  } catch (e) {
    console.log("自动登录失败:", e.message);
  }
}
ws.close();
process.exit(ok ? 0 : 1);
