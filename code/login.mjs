#!/usr/bin/env node
// 学工系统 CAS 登录：读 ~/pw.txt（第 1 行账号、第 2 行密码），自动完成统一身份认证。
// 用法：node code/login.mjs   成功退出码 0，失败非 0。密码不打印、不落日志。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CDP = process.env.CDP_PORT || 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const raw = readFileSync(join(homedir(), "pw.txt"), "utf8").split(/\r?\n/).filter((l) => l.trim());
const user = raw[0].trim();
const pass = raw[1].trim();
if (!user || !pass) throw new Error("pw.txt 需要两行：账号、密码");

const list = await (await fetch("http://127.0.0.1:" + CDP + "/json/list")).json();
const page = list.find((x) => x.type === "page" && (x.url.includes("sso.dlut") || x.url.includes("dutxg")));
if (!page) throw new Error("没有找到学工系统/CAS 标签页");

const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pend = new Map();
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true }); return r.result?.result?.value; };

async function clickSel(sel) {
  const s = await ev("(function(){ var e = document.querySelector(" + JSON.stringify(sel) + "); if (!e) return null; e.scrollIntoView({block:'center'}); var r = e.getBoundingClientRect(); return JSON.stringify({x:Math.round(r.left+r.width/2), y:Math.round(r.top+r.height/2)}); })()");
  if (!s || s === "null") return false;
  const p = JSON.parse(s);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y });
  await sleep(120);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", buttons: 1, clickCount: 1 });
  await sleep(80);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(300);
  return true;
}

if (await ev("!!document.querySelector('.role_box')")) { console.log("已登录，无需操作"); ws.close(); process.exit(0); }
if (!(await ev("!!document.getElementById('un')"))) {
  await ev("location.href='https://sso.dlut.edu.cn/cas/login?service=http://dutxg.dlut.edu.cn/gzsc/shiro-cas'");
  await sleep(7000);
}
if (!(await ev("!!document.getElementById('un')"))) throw new Error("CAS 登录页未加载");

await clickSel("#un");
await send("Input.insertText", { text: user });
await sleep(400);
await clickSel("#pd");
await send("Input.insertText", { text: pass });
await sleep(400);

const f = JSON.parse(await ev("JSON.stringify({u:(document.getElementById('un')||{}).value||'', pLen:((document.getElementById('pd')||{}).value||'').length})"));
console.log("已填账号:", f.u, "| 密码长度:", f.pLen);
if (f.u !== user || f.pLen !== pass.length) throw new Error("输入未生效");

if (!(await clickSel("#index_login_btn"))) throw new Error("找不到登录按钮");
console.log("已点登录，等待跳转…");

let landed = false;
for (let i = 0; i < 40; i++) {
  await sleep(1500);
  const url = await ev("location.href");
  if (url && url.includes("dutxg.dlut.edu.cn") && !url.includes("cas/login")) {
    const role = await ev("(function(){ var b = document.querySelector('.role_box'); return b ? b.innerText.replace(/\\s+/g,' ') : ''; })()");
    if (role) { console.log("登录成功，角色:", role); landed = true; break; }
  }
  const err = await ev("(document.body.innerText.match(/[^\\n]*(错误|失败|不正确|锁定)[^\\n]*/)||[''])[0]");
  if (err && err.length < 60 && (await ev("!!document.getElementById('un')"))) { console.log("CAS 提示:", err); break; }
}
ws.close();
process.exit(landed ? 0 : 1);
