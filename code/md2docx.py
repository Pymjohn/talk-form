#!/usr/bin/env python3
"""Markdown → Word(.docx)，用于上传到只接受办公文档的学工系统。

用法: python3 md2docx.py 输入.md 输出.docx
"""
import sys, re
from docx import Document
from docx.shared import Pt
from docx.oxml.ns import qn


def main():
    if len(sys.argv) < 3:
        sys.exit("用法: md2docx.py 输入.md 输出.docx")
    src, dst = sys.argv[1], sys.argv[2]
    lines = open(src, encoding="utf-8").read().split("\n")

    doc = Document()
    st = doc.styles["Normal"]
    st.font.name = "宋体"
    st.font.size = Pt(10.5)
    st._element.rPr.rFonts.set(qn("w:eastAsia"), "宋体")

    for raw in lines:
        line = raw.rstrip()
        if not line:
            continue
        if line.startswith("# "):
            doc.add_heading(line[2:].strip(), level=1)
        elif line.startswith("## "):
            doc.add_heading(line[3:].strip(), level=2)
        elif line.startswith("### "):
            doc.add_heading(line[4:].strip(), level=3)
        elif line.startswith("- "):
            p = doc.add_paragraph(line[2:].strip())
            p.style = doc.styles["List Bullet"]
        elif line.startswith("> "):
            p = doc.add_paragraph(line[2:].strip())
            p.paragraph_format.left_indent = Pt(18)
        elif line.strip() == "---":
            doc.add_paragraph("─" * 30)
        else:
            # 去掉 markdown 强调符号
            t = re.sub(r"[*_]{1,2}([^*_]+)[*_]{1,2}", r"\1", line)
            doc.add_paragraph(t)

    doc.save(dst)
    print("已生成:", dst)


if __name__ == "__main__":
    main()
