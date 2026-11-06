#!/usr/bin/env node
// 重点关注上报（http://dutxg.dlut.edu.cn/zdgz/#/FocusReport）读取器
//
// 页面结构（2026-11-05 实测，勿凭直觉改）：
//   页面把一张表拆成 3 个 <table>：主表（性别…出库周）、左侧固定列（序号/姓名学号）、右侧固定列（重点关注等级/当前状态/操作）
//   三张表行数一致、按行号一一对应，必须按下标拼接才能拿到完整记录
//   默认角色是「学生」，会跳 #/403，需先切辅导员（逻辑同 cdp_submit）
//
// 用法：
//   node code/focus.mjs            # 读取并打印汇总
//   node code/focus.mjs --json     # 输出完整 JSON
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CDP = process.env.CDP_PORT || 9222;
const ROOT = (process.env.TALK_ROOT || join(homedir(), "talk-form"));
const OUT = join(ROOT, "data", "focus_students.json");
const URL_FOCUS = "http://dutxg.dlut.edu.cn/zdgz/#/FocusReport";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asJson = process.argv.includes("--json");

async function targets() {
  return (await (await fetch("http://127.0.0.1:" + CDP + "/json/list")).json()).filter((x) => x.type === "page");
}

// 专属标签页：只认 /zdgz，避免动到 watcher 正在用的 /gzsc
async function focusTab() {
  let t = (await targets()).find((x) => x.url.includes("/zdgz"));
  if (t) return t;
  // 注意：新版本 Chrome 的 /json/new?url= 不再导航，只会开一个 about:blank，必须自己 Page.navigate
  const created = await (await fetch("http://127.0.0.1:" + CDP + "/json/new", { method: "PUT" })).json();
  if (created && created.webSocketDebuggerUrl) {
    const { ws, send } = await connect(created.webSocketDebuggerUrl);
    try { await send("Page.navigate", { url: URL_FOCUS }); } catch (e) {}
    ws.close();
  }
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    t = (await targets()).find((x) => x.url.includes("/zdgz"));
    if (t) return t;
  }
  throw new Error("打开重点关注页面失败");
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pend = new Map();
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (method, params = {}) => new Promise((res) => { const id = ++seq; pend.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  return { ws, send };
}

async function evaluate(send, expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
  if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval failed");
  return r.result?.result?.value;
}

async function clickRect(send, expr, name) {
  const s = await evaluate(send, "(() => { const el = " + expr + "; if (!el) return ''; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return Math.round(r.left + r.width / 2) + ',' + Math.round(r.top + r.height / 2); })()");
  if (!s) throw new Error("找不到可点击元素: " + name);
  const [x, y] = String(s).split(",").map(Number);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

const ROLE_EXPR = "(() => { const b = document.querySelector('.role_box'); if (!b) return ''; const v = b.querySelector('.ant-select-selection-selected-value'); return v ? v.innerText.trim() : b.innerText.trim().slice(0, 10); })()";

async function ensureCounselor(send) {
  let role = await evaluate(send, ROLE_EXPR);
  if (/辅导员/.test(role)) return role;
  if (!/学生/.test(role)) return role;
  await clickRect(send, "document.querySelector('.role_box .ant-select-selection')", "角色下拉");
  await sleep(1200);
  await clickRect(send, "Array.from(document.querySelectorAll('.ant-select-dropdown-menu-item')).find(i => i.getBoundingClientRect().width > 0 && /辅导员/.test(i.innerText))", "辅导员选项");
  await sleep(6000);
  return evaluate(send, ROLE_EXPR);
}

// 三张表按下标拼接
const EXTRACT = `(() => {
  const tabs = Array.from(document.querySelectorAll('table'));
  if (tabs.length < 1) return JSON.stringify({ error: 'no-table', text: (document.body.innerText || '').slice(0, 200) });
  const grab = (tb) => ({
    heads: Array.from(tb.querySelectorAll('thead th')).map(th => (th.innerText || '').trim()),
    rows: Array.from(tb.querySelectorAll('tbody tr')).map(tr => Array.from(tr.children).map(td => (td.innerText || '').trim()))
  });
  const main = grab(tabs[0]);
  const left = tabs[1] ? grab(tabs[1]) : { heads: [], rows: [] };
  const right = tabs[2] ? grab(tabs[2]) : { heads: [], rows: [] };
  const total = document.querySelector('.ant-pagination-total-text');
  const items = main.rows.map((r, i) => {
    const o = {};
    main.heads.forEach((h, k) => { if (h) o[h] = r[k] || ''; });
    const L = left.rows[i] || [];
    const R = right.rows[i] || [];
    const nameCell = L[2] || '';
    const m = nameCell.match(/^(.+?)[（(](\\d+)[）)]$/);
    return {
      seq: L[1] || '',
      name: m ? m[1].trim() : nameCell,
      xh: m ? m[2] : '',
      level: R[0] || '',
      state: R[1] || '',
      gender: o['性别'] || '', cls: o['班级'] || '', grade: o['年级'] || '', college: o['学院'] || '',
      talks14: o['近两周谈话次数'] || '', risk: o['风险类别'] || '', keyword: o['关键词'] || '',
      stuState: o['学生状态'] || '', source: o['重点关注来源'] || '',
      reportedBy: o['上报人'] || '', reportedAt: o['上报时间'] || '',
      inWeek: o['入库周'] || '', outWeek: o['出库周'] || ''
    };
  }).filter(x => x.name);
  return JSON.stringify({ url: location.href, total: total ? total.innerText : '', n: items.length, items });
})()`;

async function main() {
  const t = await focusTab();
  const { ws, send } = await connect(t.webSocketDebuggerUrl);
  await send("Page.enable");
  // 注意：/zdgz 下还有「学生谈话考核统计」等其他页面，必须精确判断 hash
  if (!t.url.includes("FocusReport")) { await send("Page.navigate", { url: URL_FOCUS }); await sleep(9000); }

  let role = await evaluate(send, ROLE_EXPR);
  if (!/辅导员/.test(role)) {
    role = await ensureCounselor(send);
    if (/辅导员/.test(role)) { await send("Page.navigate", { url: URL_FOCUS }); await sleep(8000); }
  }

  let info = JSON.parse(await evaluate(send, EXTRACT) || "{}");
  if (info.error === "no-table" || !info.items || !info.items.length) {
    // 可能停在 #/403 或还没渲染，刷新一次再试
    await send("Page.navigate", { url: URL_FOCUS });
    await sleep(9000);
    info = JSON.parse(await evaluate(send, EXTRACT) || "{}");
  }

  if (!info.items || !info.items.length) {
    // 抓空多半是页面没渲染好或停在别的子页：保留上一次结果，不覆盖
    console.error("未解析到记录（" + (info.error || info.url || "未知") + "），保留旧数据");
    ws.close();
    process.exit(2);
  }

  const payload = {
    fetchedAt: new Date().toISOString(),
    role,
    url: info.url || "",
    total: info.total || "",
    count: (info.items || []).length,
    items: info.items || [],
  };
  mkdirSync(join(ROOT, "data"), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload, null, 1));

  if (asJson) console.log(JSON.stringify(payload, null, 1));
  else {
    console.log("角色:", role, "| 分页:", payload.total, "| 记录:", payload.count);
    payload.items.slice(0, 6).forEach((x) => console.log(" ", x.seq, x.name, x.xh, "|", x.cls, "| 近两周谈话:", x.talks14, "|", x.level, x.state));
  }
  ws.close();
  return payload;
}

main().catch((e) => { console.error("失败:", e.message); process.exit(1); });
