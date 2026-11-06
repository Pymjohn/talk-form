#!/usr/bin/env node
// 重点关注 · 按自然周周期考核
//
// 口径（与学工「学生谈话考核统计」一致，2026-11-05 核实）：
//   一个考核周期 = 2 个自然周（周一 ~ 隔周周日），固定切分，不随上次谈话日期滚动
//   例：2026-09-28(周一) ~ 2026-10-11(周日) 为第 0 周期，之后每 14 天一个周期
//   该页「在库周数 52 / 应完成考核周期数 26」= 每 2 周一次，印证了这个切分
//   周期内至少谈话 1 次 → 本周期达标
//
// 数据来源：
//   data/focus_students.json —— 关注名单（focus.mjs 抓取）
//   data/queue.jsonl         —— 我们录入的谈话记录
//   data/plan.json           —— 名单里已完成项
//
// 用法：
//   node code/focus_cycle.mjs            # 打印
//   node code/focus_cycle.mjs --json
//   node code/focus_cycle.mjs --warn 4   # 只列本周期未谈且剩 <= 4 天
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ROOT = (process.env.TALK_ROOT || join(homedir(), "talk-form"));
const DATA = join(ROOT, "data");
const PERIOD_DAYS = 14;
const ANCHOR = "2026-09-28";          // 周期起点（周一），来自学工考核口径
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const warnIdx = args.indexOf("--warn");
const warnDays = warnIdx >= 0 ? Number(args[warnIdx + 1]) : null;

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const day = (s) => { const d = new Date(String(s).slice(0, 10) + "T00:00:00"); return isNaN(d) ? null : d; };
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
function readJson(p, fb) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fb; } }

function periodOf(d) {
  const a = day(ANCHOR);
  const k = Math.floor((d - a) / 86400000 / PERIOD_DAYS);
  const start = addDays(a, k * PERIOD_DAYS);
  const end = addDays(start, PERIOD_DAYS - 1);
  return { idx: k, start: ymd(start), end: ymd(end), startDate: start, endDate: end };
}

function main() {
  const focusFile = join(DATA, "focus_students.json");
  if (!existsSync(focusFile)) { console.error("缺少 data/focus_students.json，先跑 node code/focus.mjs"); process.exit(1); }
  const focus = readJson(focusFile, { items: [] });

  const talks = [];
  if (existsSync(join(DATA, "queue.jsonl"))) {
    readFileSync(join(DATA, "queue.jsonl"), "utf8").split("\n").filter(Boolean).forEach((l) => {
      try { const r = JSON.parse(l); if (r.thrq) talks.push({ xm: r.xm, xh: r.xh || "", thrq: String(r.thrq).slice(0, 10) }); } catch {}
    });
  }
  (readJson(join(DATA, "plan.json"), []) || []).forEach((p) => {
    if (p.status === "done" && p.thrq) talks.push({ xm: p.xm, xh: p.xh || "", thrq: String(p.thrq).slice(0, 10) });
  });

  const today = day(ymd(new Date()));
  const cur = periodOf(today);
  const prev = periodOf(addDays(today, -PERIOD_DAYS));
  const daysLeft = Math.ceil((cur.endDate - today) / 86400000);

  const rows = (focus.items || []).map((s) => {
    const isActive = String(s.state || "").trim() === "关注中";
    const mine = talks.filter((t) => (s.xh && t.xh === s.xh) || t.xm === s.name);
    const dates = mine.map((t) => t.thrq).sort();
    const inCur = dates.filter((d) => d >= cur.start && d <= cur.end);
    const inPrev = dates.filter((d) => d >= prev.start && d <= prev.end);
    const lastTalk = dates.length ? dates[dates.length - 1] : "";
    let status;
    if (!isActive) status = "inactive";
    else if (inCur.length) status = "done";
    else status = daysLeft <= 4 ? "urgent" : "pending";
    return {
      name: s.name, xh: s.xh, cls: s.cls, level: s.level, state: String(s.state || "").trim(),
      talksThis: inCur.length, talksPrev: inPrev.length, talks14: s.talks14,
      lastTalk, daysLeft, status,
    };
  });

  const rank = { urgent: 0, pending: 1, done: 2, inactive: 3 };
  rows.sort((a, b) => (rank[a.status] - rank[b.status]) || ((a.lastTalk || "") > (b.lastTalk || "") ? 1 : -1));
  const active = rows.filter((r) => r.status !== "inactive");
  const doneN = active.filter((r) => r.status === "done").length;

  const out = {
    generatedAt: new Date().toISOString(),
    period: { idx: cur.idx, start: cur.start, end: cur.end, daysLeft },
    prevPeriod: { idx: prev.idx, start: prev.start, end: prev.end },
    activeCount: active.length, doneCount: doneN,
    rows,
  };
  writeFileSync(join(DATA, "focus_status.json"), JSON.stringify(out, null, 1));

  if (asJson) { console.log(JSON.stringify(out, null, 1)); return; }

  const pick = warnDays == null ? rows : rows.filter((r) => r.status !== "inactive" && (r.status !== "done" || warnDays >= 99) && r.daysLeft <= warnDays);
  const LAB = { urgent: "未谈紧迫", pending: "未谈", done: "已谈", inactive: "已撤销" };
  console.log("周期 #" + cur.idx + "  " + cur.start + " ~ " + cur.end + "  剩 " + daysLeft + " 天");
  console.log("关注中 " + active.length + " 人，本周期已谈 " + doneN + " 人，未谈 " + (active.length - doneN) + " 人");
  console.log("");
  pick.forEach((r) => {
    console.log(" " + (LAB[r.status] || r.status).padEnd(5) + " " + r.name.padEnd(4) + " " + (r.xh || "").padEnd(12) +
      " " + (r.cls || "").padEnd(8) + " 本周期 " + r.talksThis + " 次 | 上周期 " + r.talksPrev + " 次 | 上次 " + (r.lastTalk || "—"));
  });
}

main();
