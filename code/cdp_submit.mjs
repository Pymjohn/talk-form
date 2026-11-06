#!/usr/bin/env node
// 谈心谈话自动录入：队列 → 选人 → 填表 → 提交
//
// 用法：
//   node cdp_submit.mjs --queue                 # 消费队列里所有 queued 记录
//   node cdp_submit.mjs --json '<记录JSON>'      # 单条录入
//   两者都可加 --dry（停在提交前）或 --limit N
//
// 前提：浏览器运行中且已登录学工系统；页面停在 http://dutxg.dlut.edu.cn/gzsc/
// 已验证的页面事实（勿凭直觉改）：
//   - 「添加」只是新建空白表单标签，不会弹选人框
//   - 必须再点空白表单的 #XM（姓名输入框），学生选择器才会弹出
//   - 日期/时间选择器必须真实点击+键入+回车，程序化赋值无效
//   - 保存草稿对新记录无效（只发 getPkids），必须走「提交」
//   - 多标签页会同时挂载多份相同 id，所有操作必须收敛到 .ant-tabs-tabpane-active
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const CDP = process.env.CDP_PORT || 9222;
const ROOT = (process.env.TALK_ROOT || join(homedir(), "talk-form"));
const DATA = join(ROOT, "data");
const QUEUE = join(DATA, "queue.jsonl");
const SHOT_DIR = join(DATA, "shots");
// 活动表单可能随标签页切换短暂消失，且存在多份同 id 输入框。
// __pane 返回「含 #XM 的最后一个活动面板」，找不到时退回 document。
const PANE = "window.__pane()";
// 注意：箭头函数必须带外层括号，插值后紧跟 (c) 才是真正的调用；少了括号会变成恒真的函数体（2026-10-28 血泪教训）
const norm = "((e) => (e.innerText || e.textContent || '').replace(/\\s+/g, '').trim())";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

async function pageWs() {
  const base = "http://127.0.0.1:" + CDP;
  const list = await (await fetch(base + "/json/list")).json();
  let t = list.find((x) => x.type === "page" && x.url.includes("dutxg.dlut.edu.cn/gzsc"));
  if (!t) {
    // 常驻浏览器可能没开学工系统标签页，自动新建（Chrome 111+ 要求 PUT）
    console.log("未找到学工系统标签页，自动打开…");
    // 新版本 Chrome 忽略 /json/new?url=，只会开 about:blank，得自己导航
    const created = await (await fetch(base + "/json/new", { method: "PUT" })).json();
    if (created && created.webSocketDebuggerUrl) {
      const w = new WebSocket(created.webSocketDebuggerUrl);
      await new Promise((r) => (w.onopen = r));
      w.send(JSON.stringify({ id: 1, method: "Page.navigate", params: { url: "http://dutxg.dlut.edu.cn/gzsc/" } }));
      await sleep(1500);
      try { w.close(); } catch {}
    }
    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      const rows = await (await fetch(base + "/json/list")).json();
      t = rows.find((x) => x.type === "page" && x.webSocketDebuggerUrl && x.url.includes("dutxg.dlut.edu.cn"));
      if (t && t.url.includes("/gzsc")) break;
      t = null;
    }
    if (!t) throw new Error("自动打开学工系统标签页失败");
  }
  return t.webSocketDebuggerUrl;
}

// 角色确保：新开页面会默认落到学生权限，必须切到辅导员才能查到学生
async function currentRole(send) {
  return evaluate(send, `(() => { const box = document.querySelector('.role_box'); if (!box) return '';
    const v = box.querySelector('.ant-select-selection-selected-value');
    return v ? v.innerText.trim() : box.innerText.trim().slice(0, 10); })()`);
}
async function ensureCounselor(send) {
  let role = await currentRole(send);
  if (/辅导员/.test(role)) return role;
  if (!/学生/.test(role)) throw new Error("无法识别当前角色: '" + role + "'");
  console.log("当前是学生角色，切换到辅导员…");
  await clickRect(send, "document.querySelector('.role_box .ant-select-selection')", "角色下拉");
  await sleep(1200);
  await clickRect(send, `(() => Array.from(document.querySelectorAll('.ant-select-dropdown-menu-item')).find(i => i.getBoundingClientRect().width > 0 && /辅导员/.test(i.innerText)))()`, "辅导员选项");
  await sleep(6000); // 等页面按新角色重载
  role = await currentRole(send);
  if (!/辅导员/.test(role)) throw new Error("切换辅导员失败: " + role);
  return role;
}

// 页面健康检查：白屏/加载失败时自动刷新（最多 3 轮），避免 watcher 每轮都在第一步失败
async function ensurePageHealthy(send) {
  for (let i = 0; i < 3; i++) {
    const state = await evaluate(send, `(() => {
      const txt = document.body ? (document.body.innerText || '') : '';
      return JSON.stringify({ len: txt.length, role: !!document.querySelector('.role_box'), login: /login|authserver|sso/.test(location.href) });
    })()`);
    let st = {};
    try { st = JSON.parse(state); } catch {}
    if (st.login) return;            // 登录页交给 assertLoggedIn 处理
    if (st.len > 50 && st.role) return;
    console.log("页面异常（白屏/未渲染），刷新重试 " + (i + 1) + "/3");
    try { await evaluate(send, "location.reload(); 'ok'"); } catch {}
    await sleep(9000);
  }
  console.log("页面仍异常，继续尝试后续步骤");
}

// 登录态检测：跳到统一身份认证即视为会话过期
async function assertLoggedIn(send) {
  const bad = await evaluate(send, '(() => {' +
    'if (/login|authserver|sso/.test(location.href)) return "url:" + location.href;' +
    'const txt = (document.body && document.body.innerText || "").slice(0, 600);' +
    'if (/统一身份认证|账号登录|用户名登录/.test(txt)) return "page:" + location.href;' +
    'return ""; })()');
  if (bad) throw new Error("dutxg 会话已过期(" + bad + ")，请在常驻浏览器窗口重新登录一次，watcher 会自动重试");
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let seq = 0;
    const pend = new Map();
    ws.onopen = () => resolve({ send, close });
    ws.onerror = () => reject(new Error("CDP 连接失败"));
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    };
    function send(method, params = {}, ms = 20000) {
      const id = ++seq;
      return new Promise((res, rej) => {
        const timer = setTimeout(() => { pend.delete(id); rej(new Error(method + " 超时")); }, ms);
        pend.set(id, { res, rej, timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    }
    function close() { try { ws.close(); } catch {} }
  });
}

async function evaluate(send, expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("页面异常: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

async function clickRect(send, finder, label) {
  // 关键：必须确认元素真的滚进视口再点击，否则坐标落在视口外=幻影点击（2026-10-28 实测）
  let box = null;
  for (let i = 0; i < 4 && !box; i++) {
    box = await evaluate(send, `(() => { const el = ${finder}; if (!el) return null;
      el.scrollIntoView({block:'center', inline:'nearest'});
      let r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) window.scrollBy(0, r.top - window.innerHeight / 2);
      r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) return 'offscreen';
      return {x: Math.round(r.left+r.width/2), y: Math.round(r.top+r.height/2), w: Math.round(r.width)}; })()`);
    if (box === "offscreen" || !box || !box.w) { box = null; await sleep(600); }
  }
  if (!box) throw new Error("元素不在视口内或找不到: " + label);
  await sleep(150);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(400);
  return box;
}

async function setByLabel(send, label, value) {
  const r = await evaluate(send, `(() => {
    const pane = ${PANE};
    const cell = Array.from((pane || document).querySelectorAll('.ant-descriptions-item-label')).find(c => ${norm}(c) === ${JSON.stringify(label)});
    if (!cell) return 'no-label';
    const content = cell.nextElementSibling;
    const el = content && content.querySelector('input,textarea');
    if (!el) return 'no-input';
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
    el.focus(); set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  })()`);
  if (r === "no-label" || r === "no-input") throw new Error("写入失败: " + label + " (" + r + ")");
  return r;
}

// 关键：选项必须按行作用域匹配——「其他」同时存在于谈话方式和谈话类别，全局匹配会选错行
async function pick(send, rowLabel, text) {
  let ok = "";
  for (let a = 0; a < 3 && ok !== "ok"; a++) {
    ok = await evaluate(send, `(() => {
      const pane = ${PANE};
      const cells = (pane || document).querySelectorAll('.ant-descriptions-item-label');
      let row = null;
      for (const c of cells) { if (${norm}(c) === ${JSON.stringify(rowLabel)}) { row = c.nextElementSibling; break; } }
      if (!row) return 'no-row';
      const w = Array.from(row.querySelectorAll('.ant-radio-wrapper, .ant-checkbox-wrapper')).find(x => ${norm}(x) === ${JSON.stringify(text)});
      if (!w) { row.scrollIntoView({ block: 'center' }); return 'no-opt'; }
      w.click(); return 'ok';
    })()`);
    if (ok !== "ok") await sleep(1500); // 新标签页渲染有延迟；no-opt 时上面已滚动触发懒渲染
  }
  if (ok !== "ok") throw new Error("选项写入失败: " + rowLabel + "/" + text + " (" + ok + ")");
  await sleep(120);
}

async function setPicker(send, selector, value, label) {
  const read = () => evaluate(send, `(() => { const pane = ${PANE}; const el = (pane || document).querySelector(${JSON.stringify(selector)}); return el ? el.value : ''; })()`);
  await clickRect(send, `(() => { const pane = ${PANE}; return (pane || document).querySelector(${JSON.stringify(selector)}); })()`, label);
  // 关键：选择器输入框可能已带默认值（如今天），直接 insertText 会变成追加 → 必须先全选清空
  for (let attempt = 0; attempt < 3; attempt++) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
    await sleep(120);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    await sleep(200);
    const cleared = await read();
    if (!cleared) break;
  }
  await send("Input.insertText", { text: value });
  await sleep(300);
  for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await sleep(600);
  // 面板收合：antd 的日期/时间面板 Enter 偶发不关闭，会一直悬浮遮挡页面。
  // 按可见性判断（class 里没有 hidden 也可能通过 transform 显示），并用「点击页头空白」触发外部点击关闭。
  const panelOpen = await evaluate(send, `(() => {
    const ps = document.querySelectorAll('.ant-time-picker-panel, .ant-calendar-picker-container, .ant-calendar-panel');
    for (const p of ps) {
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      const r = p.getBoundingClientRect();
      if (r.width > 20 && r.height > 20) return true;
    }
    return false;
  })()`);
  if (panelOpen) {
    const vp = await evaluate(send, "JSON.stringify({ w: window.innerWidth, h: window.innerHeight })");
    let v = { w: 1200, h: 800 };
    try { v = JSON.parse(vp); } catch {}
    const px = Math.round(v.w * 0.55), py = 28;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py });
    await sleep(120);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: px, y: py, button: "left", buttons: 1, clickCount: 1 });
    await sleep(80);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: px, y: py, button: "left", buttons: 0, clickCount: 1 });
    await sleep(500);
    console.log("面板已收合（点击页头空白）");
  }
  let got = await read();
  if (got !== value) {
    // 再试一次：重新点开选择器重复同一流程
    await clickRect(send, `(() => { const pane = ${PANE}; return (pane || document).querySelector(${JSON.stringify(selector)}); })()`, label + "重试");
    await send("Input.insertText", { text: value });
    await sleep(300);
    for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await sleep(800);
    got = await read();
  }
  if (got !== value) throw new Error(label + " 写入失败: 期望 " + value + "，实际 " + got);
}

// 时间选择器：必须像真人一样在面板里点选小时/分钟（直接输入后 Enter 不会确认，面板会一直悬浮）
async function setTimePicker(send, selector, value, label) {
  const read = () => evaluate(send, `(() => { const pane = ${PANE}; const el = (pane || document).querySelector(${JSON.stringify(selector)}); return el ? el.value : ''; })()`);
  const [hh, mm] = String(value).split(":");
  const granular = ["00", "15", "30", "45"].includes(mm);
  await clickRect(send, `(() => { const pane = ${PANE}; return (pane || document).querySelector(${JSON.stringify(selector)}); })()`, label);
  await sleep(1000);
  const pickCol = (colIdx, text) => `(() => {
    const panels = Array.from(document.querySelectorAll('.ant-time-picker-panel')).filter(p => p.getBoundingClientRect().width > 0);
    const panel = panels[panels.length - 1];
    if (!panel) return null;
    const cols = panel.querySelectorAll('.ant-time-picker-panel-select');
    const lis = cols[${colIdx}] ? cols[${colIdx}].querySelectorAll('li') : [];
    return Array.from(lis).find(li => (li.innerText || '').trim() === ${JSON.stringify(text)}) || null;
  })()`;
  if (granular) {
    await clickRect(send, pickCol(0, hh), label + " 小时");
    await sleep(700);
    await clickRect(send, pickCol(1, mm), label + " 分钟");
    await sleep(900);
  } else {
    // 非 15 分钟粒度：退回键入 + Enter
    await send("Input.insertText", { text: value });
    await sleep(300);
    for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await sleep(600);
  }
  // 面板可能残留：按可见性检测，点击页头空白触发外部点击关闭
  const open = await evaluate(send, `(() => {
    const ps = document.querySelectorAll('.ant-time-picker-panel, .ant-calendar-picker-container');
    for (const p of ps) {
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      const r = p.getBoundingClientRect();
      if (r.width > 20 && r.height > 20) return true;
    }
    return false;
  })()`);
  if (open) {
    const vp = await evaluate(send, "JSON.stringify({ w: window.innerWidth })");
    let v = { w: 1200 };
    try { v = JSON.parse(vp); } catch {}
    const px = Math.round(v.w * 0.55), py = 28;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: px, y: py });
    await sleep(120);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: px, y: py, button: "left", buttons: 1, clickCount: 1 });
    await sleep(80);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: px, y: py, button: "left", buttons: 0, clickCount: 1 });
    await sleep(500);
    console.log("面板已收合（点击页头空白）");
  }
  const got = await read();
  if (got !== value) throw new Error(label + " 写入失败: 期望 " + value + "，实际 " + got);
}

// 附件：通过 CDP 直接给 input[type=file] 塞文件（学工系统用 antd Upload，隐藏 input）
async function attachToForm(send, filePath) {
  await send("DOM.enable");
  const doc = await send("DOM.getDocument", { depth: 1 });
  const rootId = doc && doc.root && doc.root.nodeId;
  if (!rootId) throw new Error("DOM.getDocument 失败: " + JSON.stringify(doc).slice(0, 120));
  const q = await send("DOM.querySelector", { nodeId: rootId, selector: ".ant-tabs-tabpane-active input[type=file]" });
  const nid = q && q.nodeId;
  if (!nid) throw new Error("页面没有附件上传控件");

  const state = await evaluate(send, `(() => {
    const i = document.querySelector('.ant-tabs-tabpane-active input[type=file]');
    if (!i) return 'no-input';
    const up = i.closest('.ant-upload');
    return JSON.stringify({ disabled: !!i.disabled, cls: up ? (up.className || '').toString().slice(0, 60) : '' });
  })()`);
  console.log("  附件控件:", state);

  await send("DOM.setFileInputFiles", { files: [filePath], nodeId: nid });
  // 兜底：某些情况下 CDP 设置 files 不触发 React 的 change，手动补发
  await sleep(500);
  await evaluate(send, `(() => {
    const i = document.querySelector('.ant-tabs-tabpane-active input[type=file]');
    if (i) i.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  // 轮询确认 antd 生成了上传条目（.ant-upload-list-item），否则视为失败
  let ok = false;
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    ok = await evaluate(send, "!!document.querySelector('.ant-tabs-tabpane-active .ant-upload-list-item')");
    if (ok) break;
    const err = await evaluate(send, "(() => { const m = document.querySelector('.ant-message'); return m ? m.innerText : ''; })()");
    if (err && /不能上传|失败|错误/.test(err)) throw new Error("附件被拒绝: " + err);
  }
  if (!ok) throw new Error("附件上传未生效（可能类型不支持或控件禁用）");
}

async function shot(send, name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  mkdirSync(SHOT_DIR, { recursive: true });
  const p = join(SHOT_DIR, name + ".png");
  writeFileSync(p, Buffer.from(r.data, "base64"));
  return p;
}

async function selectStudent(send, rec) {
  await clickRect(send, `Array.from(document.querySelectorAll('button')).find(b => ${norm}(b) === '添加' && b.offsetParent)`, "添加");
  // 按手动验证的时间轴：新标签页渲染完成约需 10–12 秒，等够了再操作，抢跑会点到半渲染的表单
  await sleep(12000);
  let ok = false;
  for (let i = 0; i < 8 && !ok; i++) {
    ok = await evaluate(send, "!!window.__pane().querySelector('#XM')");
    if (!ok) await sleep(1000);
  }
  if (!ok) throw new Error("新表单的姓名输入框未出现");
  await clickRect(send, `${PANE}.querySelector('#XM')`, "姓名输入框");
  await sleep(1500);

  const hasModal = await evaluate(send, `Array.from(document.querySelectorAll('.ant-modal')).filter(m => m.offsetParent).some(m => /学生选择器/.test(m.innerText))`);
  if (!hasModal) throw new Error("学生选择器未出现");

  const MF = `Array.from(document.querySelectorAll('.ant-modal')).filter(m => m.offsetParent).find(m => /学生选择器/.test(m.innerText))`;
  const keyword = rec.xh || rec.xm;
  // 弹窗可能残留上一条的查询状态：先清空再写入关键字
  await evaluate(send, `(() => { const m = ${MF}; if (!m) return 'no modal';
    const inp = m.querySelector('input.ant-input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    inp.focus(); set.call(inp, ''); inp.dispatchEvent(new Event('input',{bubbles:true}));
    set.call(inp, ${JSON.stringify(keyword)}); inp.dispatchEvent(new Event('input',{bubbles:true})); return inp.value; })()`);
  await sleep(400);
  // 关键：查询必须用键盘 Enter 触发——鼠标点击查询按钮会误触遮罩把弹窗关掉（2026-10-28 实测）
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await sleep(5000);

  const rows = await evaluate(send, `(() => { const m = ${MF}; if (!m) return [];
    return Array.from(m.querySelectorAll('tbody tr')).filter(r => r.getBoundingClientRect().width > 0).map(r => r.innerText.replace(/\\s+/g,' ').trim()).slice(0,10); })()`);
  if (!rows.length) throw new Error("学生选择器没有结果: " + keyword);
  if (rows.length > 1) throw new Error("检索到多个学生，需要学号消歧: " + JSON.stringify(rows));

  // 关键：结果是单选列表，必须点 label.ant-radio-wrapper 才会选中——点 td 无效（2026-10-28 实测）
  let checked = "";
  for (let a = 0; a < 3 && !checked; a++) {
    await clickRect(send, `(() => { const m = ${MF}; if (!m) return null;
      return Array.from(m.querySelectorAll('label.ant-radio-wrapper')).find(w => w.getBoundingClientRect().width > 0); })()`, "学生单选");
    await sleep(800);
    checked = await evaluate(send, `(() => { const m = ${MF}; return (m && m.querySelector('input[type=radio]:checked')) ? 'ok' : ''; })()`);
  }
  if (!checked) throw new Error("点选学生未生效（radio 未选中）");
  await clickRect(send, `(() => { const m = ${MF}; if (!m) return null; return Array.from(m.querySelectorAll('button')).find(b => /保\\s*存/.test(b.innerText)); })()`, "保存");
  await sleep(2500);

  const bound = await evaluate(send, `(() => { const pane = ${PANE}; const xm = pane && (pane || document).querySelector('#XM'); return xm ? xm.value : ''; })()`);
  if (bound !== rec.xm) throw new Error("绑定学生不符: 期望 " + rec.xm + "，实际 " + bound);
  return bound;
}

// 新标签页的选项区（radio/checkbox）渲染比输入框慢，必须等到挂载完成再填
async function waitOptionRows(send, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const n = await evaluate(send, `(() => {
      const pane = ${PANE};
      const cells = (pane || document).querySelectorAll('.ant-descriptions-item-label');
      let row = null;
      for (const c of cells) { if (${norm}(c) === '谈话方式') { row = c.nextElementSibling; break; } }
      if (!row) return 0;
      const n = row.querySelectorAll('.ant-radio-wrapper, .ant-checkbox-wrapper').length;
      if (!n) row.scrollIntoView({ block: 'center' }); // 滚动可触发懒渲染
      return n;
    })()`);
    if (Number(n) > 0) return true;
    await sleep(1000);
  }
  throw new Error("选项区未渲染完成: 谈话方式行无 radio");
}

async function fillForm(send, rec) {
  await sleep(3000); // 等标签页渲染稳定（手动时间轴）
  await waitOptionRows(send);
  await setPicker(send, ".ant-calendar-picker-input", rec.thrq, "谈话日期");
  await setTimePicker(send, "#KSSJ", rec.kssj, "开始时间");
  await setByLabel(send, "谈话时长(分钟)", String(rec.thsc));
  await setByLabel(send, "谈话地点", rec.thdd || "104");   // 地点缺省按 104，和手机端保持一致
  await setByLabel(send, "谈话关键词", rec.guanjianci || "");
  await setByLabel(send, "谈话要点", rec.yaodian || "");
  await setByLabel(send, "谈话分析", rec.fenxi || "");
  await pick(send, "谈话方式", rec.fangshi);
  await pick(send, "发起人", rec.famaoren);
  await pick(send, "社会工作", rec.shegong || "无"); // 必填，手机表单没这项时缺省「无」
  for (const c of (rec.leibie && rec.leibie.length ? rec.leibie : ["其他"])) await pick(send, "谈话类别", c);
  await pick(send, "辅导员自评", rec.zipin);
  await pick(send, "是否需要跟踪", rec.genzong);
  await sleep(600); // 让 checkbox/radio 的受控状态落定再校验
  await verifyForm(send, rec);
}

// 提交前整表回读校验：任何必填缺失直接报错，杜绝幻影提交
async function verifyForm(send, rec) {
  const st = await evaluate(send, `(() => {
    const pane = ${PANE};
    const row = (label) => { const cells = (pane||document).querySelectorAll('.ant-descriptions-item-label');
      for (const c of cells) { if (${norm}(c) === label) return c.nextElementSibling; } return null; };
    const val = (label) => { const r = row(label); const el = r && r.querySelector('input,textarea'); return el ? el.value : ''; };
    const checked = (label) => { const r = row(label); return r && r.querySelector('.ant-radio-checked, .ant-checkbox-checked') ? 'ok' : ''; };
    return { yd: val("谈话要点"), fx: val("谈话分析"), rq: val("谈话日期"), sj: val("开始时间"), sc: val("谈话时长(分钟)"), dd: val("谈话地点"),
      fs: checked("谈话方式"), fmr: checked("发起人"), sg: checked("社会工作"),
      lb: checked("谈话类别"), zp: checked("辅导员自评"), gz: checked("是否需要跟踪") };
  })()`);
  const miss = [];
  // 字数只做提示，不作为阻断条件——真正是否可提交由系统判定（2026-10-30）
  if ((st.yd || "").trim().length <= 10) console.log("提示: 谈话要点仅 " + (st.yd || "").trim().length + " 字");
  if ((st.yd || "").trim().length < 5) miss.push("谈话要点(至少5字)");
  if ((st.fx || "").trim().length < 5) miss.push("谈话分析(至少5字)");
  if ((st.fx || "").trim().length <= 10) console.log("提示: 谈话分析仅 " + (st.fx || "").trim().length + " 字");
  if (!st.rq) miss.push("谈话日期");
  if (!st.sj) miss.push("开始时间");
  if (!st.sc) miss.push("谈话时长");
  if (!st.dd) miss.push("谈话地点");
  const rows = [["fs","谈话方式"],["fmr","发起人"],["sg","社会工作"],["lb","谈话类别"],["zp","辅导员自评"],["gz","是否需要跟踪"]];
  for (const [k, name] of rows) if (st[k] !== "ok") miss.push(name);
  if (miss.length) throw new Error("表单未填完整，缺: " + miss.join(","));
}

async function runRecord(send, rec, dry) {
  // 入口判据：页面上有可点的「添加」按钮即可直接新建表单。
  // 不能用 .ant-tabs-tabpane-active 判断——标签组未激活时 active=0，但「添加」仍可用（2026-10-29 实测）
  let canAdd = false;
  for (let i = 0; i < 15; i++) {
    canAdd = await evaluate(send, `!!Array.from(document.querySelectorAll('button')).find(b => ${norm}(b) === '添加' && b.offsetParent)`);
    if (canAdd) break;
    await sleep(1000);
  }
  if (!canAdd) {
    await evaluate(send, "location.hash='#/writeManual/write'");
    await sleep(6000);
    const hasCard = await evaluate(send, `!!Array.from(document.querySelectorAll('.item___2lrNx')).find(e => /通用表格/.test(e.innerText))`);
    if (hasCard) {
      await clickRect(send, `Array.from(document.querySelectorAll('.item___2lrNx')).find(e => /通用表格/.test(e.innerText))`, "通用表格卡片");
      await sleep(1200);
      await clickRect(send, `(() => { const c = Array.from(document.querySelectorAll('.item___2lrNx')).find(e => /通用表格/.test(e.innerText)); return c && Array.from(c.querySelectorAll('button,a,span')).find(x => ${norm}(x) === '填写'); })()`, "填写按钮");
      await sleep(4500);
    } else {
      throw new Error("既没有「添加」按钮也没有通用表格卡片，页面状态异常: " + (await evaluate(send, "location.hash")));
    }
  }
  // 每条记录都从「添加」新建表单，绝不复用已有表单（半填/脏数据会污染录入）
  const picked = await selectStudent(send, rec);
  console.log("已选学生:", picked);
  await fillForm(send, rec);
  if (rec.attachment && rec.attachment.path) {
    console.log("上传附件:", rec.attachment.name);
    await attachToForm(send, rec.attachment.path);
  }
  const p = await shot(send, "before_submit_" + rec.id);
  console.log("已填完，截图:", p);
  if (dry) { console.log("--dry 模式，停在提交前"); return { ok: true, dry: true }; }

  await clickRect(send, `Array.from(${PANE}.querySelectorAll('button')).find(b => ${norm}(b) === '提交')`, "提交");
  // 关键：必须验证提交结果——只有出现「提交成功」或表单页消失才算成功（2026-10-28 实测：点击坐标落在视口外会幻影提交）
  let verdict = "";
  for (let i = 0; i < 10; i++) {
    await sleep(1500);
    const st = await evaluate(send, `(() => {
      const m = document.querySelector('.ant-message');
      const txt = m ? m.innerText.replace(/\s+/g, ' ') : '';
      const pane = ${PANE};
      const el = pane && pane.querySelector ? pane.querySelector('#XM') : null;
      return JSON.stringify({ msg: txt, gone: !el });
    })()`);
    const o = JSON.parse(st);
    if (/提交成功/.test(o.msg) || o.gone) { verdict = "ok"; break; }
    if (/请完善|不能为空|失败|错误/.test(o.msg)) { verdict = "bad:" + o.msg; break; }
  }
  const after = await shot(send, "after_submit_" + rec.id);
  if (verdict !== "ok") throw new Error("提交未确认成功: " + (verdict || "无任何提示"));
  console.log("已提交，截图:", after);
  return { ok: true };
}

async function installPane(send) {
  // 关键：必须精确匹配 ant-tabs-tabpane-active —— 用 /active/ 会连 inactive 面板一起命中（2026-10-28 实测）
  // 页面 reload 后 window.__pane 会丢失，所以每条记录开始前都要重新注入
  await evaluate(send, `window.__pane = function () {
    const ps = Array.from(document.querySelectorAll('.ant-tabs-tabpane')).filter(p => p.className.includes('ant-tabs-tabpane-active') && p.querySelector('#XM'));
    return ps[ps.length - 1] || document.querySelector('.ant-tabs-tabpane-active') || document;
  };`);
}

function readQueue() {
  if (!existsSync(QUEUE)) return [];
  // 队列必须是单行 JSONL：逐行解析，且只接受对象——pretty-print 会被解析成碎片（"科研学业" 这类字符串记录）
  return readFileSync(QUEUE, "utf8").split("\n").filter((l) => l.trim())
    .map((l) => { try { const o = JSON.parse(l); return o && typeof o === "object" && !Array.isArray(o) ? o : null; } catch { return null; } })
    .filter(Boolean);
}

function markQueue(id, patch) {
  const rows = readQueue();
  // 必须写单行 JSONL，与 appendFileSync 的入队格式一致；写 pretty-print 会让下一轮解析失败并丢记录
  const out = rows.map((r) => JSON.stringify(r.id === id ? { ...r, ...patch } : r) + "\n").join("");
  writeFileSync(QUEUE, out);
}

async function main() {
  let records = [];
  if (flag("--queue")) {
    records = readQueue().filter((r) => r.status === "queued");
    const lim = Number(opt("--limit")) || records.length;
    records = records.slice(0, lim);
    if (!records.length) { console.log("队列里没有待提交记录"); return; }
  } else {
    const raw = opt("--json");
    if (!raw) throw new Error("用法: --json '<记录JSON>' 或 --queue");
    records = [JSON.parse(raw)];
  }

  const ws = await pageWs();
  const { send, close } = await connect(ws);
  // 页面自愈：SPA 长时间运行后可能白屏（body 为空、无 role_box），此时任何操作都会失败
  await ensurePageHealthy(send);
  // 会话过期时自动用 ~/pw.txt 完成 CAS 登录，再继续
  try {
    await assertLoggedIn(send);
  } catch (e) {
    if (!/会话已过期/.test(e.message || "")) throw e;
    console.log("检测到登录过期，自动登录…");
    try {
      execFileSync(process.execPath, [join(ROOT, "code", "login.mjs")], { stdio: "inherit", timeout: 120000 });
    } catch (le) {
      throw new Error("自动登录失败: " + (le.message || le));
    }
    await sleep(4000);
    await assertLoggedIn(send);
  }
  await ensureCounselor(send);
  // 每次提交前刷新页面：
  // 页面长期挂着会累积标签页，且后端 session 可能已过期——表现为「添加」能创建标签但表单不渲染（#XM 不出现）
  // 2026-11-03 刘倬宇连续 3 次失败即此原因
  console.log("提交前刷新页面");
  try { await evaluate(send, "location.reload(); 'ok'"); } catch {}
  await sleep(11000);
  await ensurePageHealthy(send);
  try {
    await assertLoggedIn(send);
  } catch (e) {
    if (!/会话已过期/.test(e.message || "")) throw e;
    console.log("刷新后发现登录过期，自动登录");
    try {
      execFileSync(process.execPath, [join(ROOT, "code", "login.mjs")], { stdio: "inherit", timeout: 120000 });
    } catch (le) {
      throw new Error("自动登录失败: " + (le.message || le));
    }
    await sleep(5000);
    await assertLoggedIn(send);
  }
  await ensureCounselor(send);
  // 页面辅助函数：定位当前活动表单面板
  await installPane(send);
  const results = [];
  try {
    await send("Page.enable");
    for (let idx = 0; idx < records.length; idx++) {
      const rec = records[idx];
      console.log(`=== [${idx + 1}/${records.length}] 处理: ${rec.xm || rec.id} ===`);
      try {
        await installPane(send);
        const r = await runRecord(send, rec, flag("--dry"));
        if (!flag("--dry")) markQueue(rec.id, { status: "submitted", submittedAt: new Date().toISOString() });
        results.push({ id: rec.id, xm: rec.xm, ok: true, dry: !!flag("--dry") });
      } catch (e) {
        console.error("  失败:", e.message);
        // watcher 自动重试：失败先保持 queued，累计 3 次才判 failed，避免浏览器未就绪时丢记录
        if (!flag("--dry")) {
          const retries = (rec.retries || 0) + 1;
          if (retries >= 3) markQueue(rec.id, { status: "failed", failedAt: new Date().toISOString(), error: e.message, retries });
          else markQueue(rec.id, { status: "queued", lastError: e.message, lastErrorAt: new Date().toISOString(), retries });
        }
        results.push({ id: rec.id, xm: rec.xm, ok: false, error: e.message });
      }
      // 一条录入完成后直接进入下一条：runRecord 会重新点「添加」新建表单，无需刷新页面
      if (idx < records.length - 1) console.log("准备下一条 → 点「添加」新建表单");
      await sleep(1500);
    }
  } finally { close(); }
  console.log("=== 汇总 ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => { console.error("失败:", e.message); process.exit(1); });
