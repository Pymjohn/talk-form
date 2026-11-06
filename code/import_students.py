#!/usr/bin/env python3
"""把学生信息 Excel / CSV 转成 students.json，支持多表合并去重。

用法：
    # 单表
    python3 code/import_students.py 学生信息.xlsx
    # 多表合并（后面的表补充/覆盖前面的同名字段）
    python3 code/import_students.py 表1.xlsx 表2.xlsx -o data/students.json

合并规则：
- 有学号：按学号合并（同学号视为同一人）
- 无学号：按姓名合并
- 字段冲突时，后加载的表覆盖先加载的非空值；空值不覆盖
- 列取并集（保持首次出现顺序）
"""
import argparse
import json
import os
import re
import sys
import unicodedata
from datetime import datetime

try:
    import pandas as pd
except ImportError:
    sys.exit("需要 pandas：请用装了 pandas 的 python 运行（或设 TALK_PY）")


def norm_header(v):
    s = str(v).replace("\n", "").replace("\r", "").strip()
    s = unicodedata.normalize("NFKC", s)
    s = re.sub(r"\s+", "", s)
    return s


def find_header_row(raw, max_scan=8):
    for i in range(min(max_scan, len(raw))):
        row = [norm_header(x) for x in raw.iloc[i].tolist()]
        if ("姓名" in "".join(row)) or ("学号" in "".join(row)):
            return i
    return None


def pick_col(cols, *keys):
    for k in keys:
        for c in cols:
            if k in c:
                return c
    return None


def read_table(path, sheet=None):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".xlsx", ".xlsm", ".xls"):
        xl = pd.ExcelFile(path)
        sh = sheet or xl.sheet_names[0]
        raw = xl.parse(sh, header=None, dtype=object)
        sheet_name = sh
    elif ext == ".csv":
        raw = pd.read_csv(path, header=None, dtype=object, encoding="utf-8-sig")
        sheet_name = "(csv)"
    else:
        raise ValueError("只支持 .xlsx / .xls / .csv: " + path)

    hdr = find_header_row(raw)
    if hdr is None:
        raise ValueError("没找到表头行（前 8 行无「姓名」或「学号」）: " + path)

    cols, seen = [], {}
    for v in raw.iloc[hdr].tolist():
        name = norm_header(v) if pd.notna(v) else ""
        if not name or name.startswith("Unnamed"):
            cols.append(None)
            continue
        if name in seen:
            seen[name] += 1
            name = name + "_" + str(seen[name])
        else:
            seen[name] = 0
        cols.append(name)

    recs = []
    for _, row in raw.iloc[hdr + 1:].iterrows():
        rec = {}
        for ci, name in enumerate(cols):
            if not name:
                continue
            v = row.iloc[ci] if ci < len(row) else None
            if pd.isna(v):
                continue
            if isinstance(v, float) and v.is_integer():
                v = int(v)
            rec[name] = str(v).strip() if not isinstance(v, (int, float)) else v
        if rec and not all(str(x).strip() == "" for x in rec.values()):
            recs.append(rec)
    return recs, [c for c in cols if c], sheet_name


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", nargs="+", help="一个或多个 Excel/CSV")
    ap.add_argument("--sheet", default=None)
    ap.add_argument("-o", "--out", default=None)
    ap.add_argument("--base-only", action="store_true",
                    help="只保留第一个表的学生，其余表仅补充字段（不新增人）")
    ap.add_argument("--keep-cols", action="store_true", help="保留全部列（默认过滤序号/备注/空列）")
    args = ap.parse_args()

    out = args.out or os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "students.json")
    out = os.path.expanduser(out)
    os.makedirs(os.path.dirname(out), exist_ok=True)

    merged = {}
    order = []
    all_cols = []
    base_keys = None
    xh_col = xm_col = bj_col = None
    per_file = []

    for src in args.src:
        path = os.path.expanduser(src)
        if not os.path.exists(path):
            sys.exit("找不到文件: " + path)
        recs, cols, sheet_name = read_table(path, args.sheet)
        # 每个文件用自己的列名映射，避免后一个表缺列时把前一个表的字段清空
        fxh = pick_col(cols, "学号", "学生编号", "编号", "学籍号")
        fxm = pick_col(cols, "姓名", "学生姓名", "名字")
        fbj = pick_col(cols, "班级", "行政班")
        if not xh_col: xh_col = fxh
        if not xm_col: xm_col = fxm
        if not bj_col: bj_col = fbj
        for c in cols:
            if c not in all_cols:
                all_cols.append(c)
        n_new = n_upd = 0
        for r in recs:
            xh = re.sub(r"\s+", "", re.sub(r"\.0$", "", str(r.get(fxh, "") or "").strip())) if fxh else ""
            xm = str(r.get(fxm, "") or "").strip() if fxm else ""
            if not xh and not xm:
                continue
            key = ("xh:" + xh) if xh else ("xm:" + xm)
            item = {"xh": xh, "xm": xm, "bj": str(r.get(fbj, "") or "").strip() if fbj else ""}
            for c in cols:
                if c in (fxh, fxm, fbj):
                    continue
                item[c] = r.get(c, "")
            if args.base_only and base_keys is not None and key not in base_keys:
                continue
            if key in merged:
                for k, v in item.items():
                    if v not in ("", None):
                        merged[key][k] = v
                n_upd += 1
            else:
                merged[key] = item
                order.append(key)
                n_new += 1
        if base_keys is None:
            base_keys = set(merged.keys())
        per_file.append((os.path.basename(path), sheet_name, len(recs), n_new, n_upd))

    skip = {c for c in (xh_col, xm_col, bj_col) if c}
    students = [merged[k] for k in order]

    # 列过滤：默认去掉「序号/备注」这类无信息列和全空列
    NOISE = {"序号", "备注", "Unnamed"}
    def nonempty(c):
        return sum(1 for s in students if str(s.get(c, "")).strip())
    if args.keep_cols:
        keep = [c for c in all_cols if c not in skip]
    else:
        keep = [c for c in all_cols if c not in skip and c not in NOISE and nonempty(c) > 0]
    columns = ["xh", "xm", "bj"] + keep
    for s in students:
        for c in columns:
            s.setdefault(c, "")

    payload = {
        "meta": {
            "source": " + ".join(os.path.basename(s) for s in args.src),
            "sheets": [x[1] for x in per_file],
            "generatedAt": datetime.now().isoformat(timespec="seconds"),
            "count": len(students),
            "columns": columns,
            "perFile": [{"file": a, "sheet": b, "rows": c, "new": d, "merged": e}
                        for a, b, c, d, e in per_file],
        },
        "students": students,
    }
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=1)

    print("=" * 50)
    for a, b, c, d, e in per_file:
        print(f"  {a} [{b}] 读入 {c} 行 → 新增 {d}，合并 {e}")
    print("=" * 50)
    print("去重后学生数:", len(students))
    print("列数:", len(columns))
    print("学号列:", xh_col, "| 姓名列:", xm_col, "| 班级列:", bj_col)
    miss = sum(1 for x in students if not x.get("xh"))
    if miss:
        print("警告：", miss, " 条缺学号（按姓名合并，重名会有歧义）")
    print("已写入:", out)


if __name__ == "__main__":
    main()
