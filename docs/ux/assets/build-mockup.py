#!/usr/bin/env python3
"""生成 docs/ux/review-preview-split-mockup.html（三帧样张）。

数据来自真项目 b2t_S79EH0 的第 11 页 / 第 1 页；不写库、不改产品代码。
"""
import base64
import collections
import difflib
import json
from pathlib import Path

from book2text.core.project import library, reading_marks, review_status
from book2text.core.storage import db
from book2text.core.pdf import render
from book2text.core.export import project as pe
from book2text.core.export.project import ExportOptions

ROOT = Path(__file__).resolve().parents[3]
ASSETS = Path(__file__).resolve().parent
LIB = library.default_library_dir()
PID = "b2t_S79EH0"
PDIR = library.project_dir(LIB, PID)
SRC = PDIR / "source" / "original.pdf"
PAGES = {p.page_no: p for p in library.list_pages(PID, library=LIB)}
MARKS = reading_marks.marks_data(PID, library=LIB)
QUEUE = review_status.queue_items(PID, library=LIB)["totals"]
TREE = review_status.review_tree(PID, library=LIB)


def spans_of(a: str, b: str):
    out = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag == "equal":
            continue
        out.append({
            "kind": {"replace": "replace", "delete": "delete", "insert": "insert"}[tag],
            "aStart": i1, "aEnd": i2, "bStart": j1, "bEnd": j2,
        })
    return out


def page_lines(page_no: int):
    page = PAGES[page_no]
    res = {}
    with db.open_database(PDIR, apply_migrations=False) as conn:
        for block in conn.execute(
            "SELECT block_id FROM block WHERE page_id=? AND deleted_at IS NULL", (page.page_id,)
        ).fetchall():
            for row in conn.execute(
                "SELECT line_index,text,bbox,word_boxes FROM block_line WHERE block_id=? ORDER BY line_index",
                (block["block_id"],),
            ).fetchall():
                res.setdefault(block["block_id"], {})[row["line_index"]] = {
                    "text": row["text"] or "",
                    "bbox": json.loads(row["bbox"]) if row["bbox"] else None,
                    "words": json.loads(row["word_boxes"]) if row["word_boxes"] else [],
                }
    return res


def marks_for(page_no: int):
    lines = page_lines(page_no)
    items = []
    for it in MARKS["items"]:
        if it["page_no"] != page_no:
            continue
        line = lines.get(it["block_id"], {}).get(it["line_index"])
        if not line:
            continue
        spans = spans_of(it["current"], it["candidate"])
        words = line["words"]
        starts = []
        concat = sum(len(w["text"]) for w in words)
        if concat == len(it["current"]):
            off = 0
            for w in words:
                starts.append(off)
                off += len(w["text"])
        else:
            cur = 0
            ok = True
            for w in words:
                at = it["current"].find(w["text"], cur)
                if at < 0:
                    ok = False
                    break
                starts.append(at)
                cur = at + len(w["text"])
            if not ok:
                starts = []
        boxes, inserts = [], []
        if words and starts:
            for s in spans:
                if s["kind"] == "insert":
                    idx = min(s["aStart"], len(words) - 1)
                    x = words[s["aStart"] - 1]["bbox"][2] if s["aStart"] > 0 else words[0]["bbox"][0]
                    inserts.append({"x": x, "y0": words[idx]["bbox"][1], "y1": words[idx]["bbox"][3]})
                else:
                    for idx in range(s["aStart"], min(s["aEnd"], len(words))):
                        boxes.append({
                            "k": "delete" if s["kind"] == "delete" else "replace",
                            "b": words[idx]["bbox"],
                        })
        items.append({
            "n": len(items) + 1,
            "level": "punct" if it["level"] == "differs_punct" else "chars",
            "ack": it["ack"] or None,
            "line": it["bbox"],
            "boxes": boxes,
            "ins": inserts,
            "current": it["current"],
            "candidate": it["candidate"],
        })
    return items


def clip(text: str, start: int, end: int, ctx: int = 6):
    pre = text[max(0, start - ctx):start]
    post = text[end:end + ctx]
    if max(0, start - ctx) > 0:
        pre = "…" + pre
    if end + ctx < len(text):
        post = post + "…"
    return pre, text[start:end], post


def card_of(it: dict):
    a, b = it["current"], it["candidate"]
    spans = spans_of(a, b)
    first, last = spans[0], spans[-1]
    a_pre, a_diff, a_post = clip(a, first["aStart"], last["aEnd"])
    b_pre, b_diff, b_post = clip(b, first["bStart"], last["bEnd"])
    kind = it["level"]
    a_start, a_end, b_start, b_end = first["aStart"], last["aEnd"], first["bStart"], last["bEnd"]
    if first["kind"] == "insert":
        a_pre, a_diff, a_post = clip(a, a_start, a_start)
        label = f"另一路多 {max(1, b_end - b_start)} 字"
    elif first["kind"] == "delete":
        b_pre, b_diff, b_post = clip(b, b_start, b_start)
        label = f"这一路多 {max(1, a_end - a_start)} 字"
    elif kind == "punct":
        label = f"标点 {a[a_start:a_end]}→{b[b_start:b_end]}"
    else:
        label = f"替换 {max(1, a_end - a_start)} 字"
    return {
        "label": label, "kind": kind, "ack": it["ack"], "n": it["n"],
        "a_pre": a_pre, "a_diff": a_diff, "a_post": a_post,
        "b_pre": b_pre, "b_diff": b_diff, "b_post": b_post,
        "a_empty": first["kind"] == "insert",
        "b_empty": first["kind"] == "delete",
        "a_cls": "punct" if kind == "punct" else ("del" if first["kind"] == "delete" else ""),
        "b_cls": "punct" if kind == "punct" else ("del" if first["kind"] == "delete" else ""),
        "chg": (f"{a[a_start:a_end]}→{b[b_start:b_end]}" if first["kind"] == "replace" else ""),
        "cx": (sum(x["b"][0] + x["b"][2] for x in it["boxes"]) / (2 * len(it["boxes"]))) if it["boxes"] else (
            it["ins"][0]["x"] if it["ins"] else (it["line"][0] + it["line"][2]) / 2),
        "cy": (sum(x["b"][1] + x["b"][3] for x in it["boxes"]) / (2 * len(it["boxes"]))) if it["boxes"] else (
            (it["ins"][0]["y0"] + it["ins"][0]["y1"]) / 2 if it["ins"] else (it["line"][1] + it["line"][3]) / 2),
    }


P11 = marks_for(11)
CARDS = [card_of(it) for it in P11]
PAGES_TREE = {p["page_no"]: p for p in TREE["pages"]}
CHAPTERS = TREE["chapters"]

# ---------------------------------------------------------------- 预览页数据
SEGS = json.loads(pe.preview_segments_json(PID, library=LIB, options=ExportOptions()))["segments"]
ACTIVE_SEG = SEGS[2]
LINES1 = page_lines(1)
ACTIVE_LINES = []
for sp in ACTIVE_SEG["line_spans"]:
    line = LINES1.get(sp["block_id"], {}).get(int(sp["line_index"]))
    if line and line["bbox"]:
        ACTIVE_LINES.append({"b": line["bbox"]})

# ---------------------------------------------------------------- 页面图
def jpg_b64(name: str) -> str:
    return base64.b64encode((ASSETS / name).read_bytes()).decode()


IMG11 = jpg_b64("review-p11.jpg")
IMG1 = jpg_b64("preview-p1.jpg")


def esc(text: str) -> str:
    return (text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;"))


def mini(card: dict) -> str:
    state = ""
    if card["ack"] == "kept":
        state = '<span class="st ok">已保留</span>'
    elif card["ack"] == "adopted":
        state = '<span class="st ok">已采用</span>'
    chg = f'<span class="chg">{esc(card["chg"])}</span>' if card["chg"] else ""
    cls = "mini acked" if card["ack"] else "mini"
    return (f'<div class="{cls}"><span class="idx">#{card["n"]}</span>'
            f'<span class="k">{esc(card["label"])}</span>{chg}'
            f'<span class="spacer"></span>{state}</div>')


def diff_cell(card, side):
    text = card[f"{side}_diff"]
    empty = card[f"{side}_empty"]
    cls = card[f"{side}_cls"]
    if empty:
        return '<span class="g diff empty ' + ("a" if side == "a" else "b") + '"></span>'
    return (f'<span class="g diff {"a" if side == "a" else "b"} {cls}">{esc(text)}</span>')


def open_card(card: dict) -> str:
    return f'''<div class="card open">
  <div class="chd"><span class="idx">#{card["n"]}</span><span class="k">{esc(card["label"])}</span><span class="spacer"></span><span class="pg">第 11 页</span></div>
  <div class="crop" data-cx="{card["cx"]:.5f}" data-cy="{card["cy"]:.5f}">
    <img src="data:image/jpeg;base64,{IMG11}" alt="">
    <span class="crop__cap">原图 2.5×</span>
  </div>
  <div class="cmp">
    <span class="g gtag">A</span><span class="g pre">{esc(card["a_pre"])}</span>{diff_cell(card, "a")}<span class="g post">{esc(card["a_post"])}</span>
    <span class="g gtag">B</span><span class="g pre">{esc(card["b_pre"])}</span>{diff_cell(card, "b")}<span class="g post">{esc(card["b_post"])}</span>
  </div>
  <div class="cact">
    <button class="btn btn--pri btn--xs">保留原文 <kbd>⏎</kbd></button>
    <button class="btn btn--xs">采用候选 <kbd>A</kbd></button>
    <button class="btn btn--xs btn--ghost">自己改 <kbd>E</kbd></button>
    <span class="spacer"></span><span class="hint">⌘Z 撤销</span>
  </div>
</div>'''


def dir_rows() -> str:
    rows = []
    for n in range(1, 14):
        page = PAGES_TREE[n]
        cnt = page["unacked"]
        cls = "pagerow on" if n == 11 else ("pagerow zero" if cnt == 0 else "pagerow")
        content = f'<span class="pno">第 {n} 页</span><span class="pcnt">{cnt if cnt else "✓"}</span>'
        rows.append(f'<div class="{cls}">{content}</div>')
    return "\n".join(rows)


def chapter_rows() -> str:
    rows = []
    for i, c in enumerate(CHAPTERS):
        un = sum(PAGES_TREE[n]["unacked"] for n in range(c["page_from"], c["page_to"] + 1))
        tot = sum(PAGES_TREE[n]["total"] for n in range(c["page_from"], c["page_to"] + 1))
        if i == 0:
            rows.append(f'<div class="chap open"><span class="caret">▾</span><span class="cname">{esc(c["title"])}</span><span class="cnum">{un} / {tot}</span></div>')
            rows.append(dir_rows())
        else:
            rows.append(f'<div class="chap"><span class="caret">▸</span><span class="cname">{esc(c["title"])}</span><span class="cnum">{un} / {tot}</span></div>')
    return "\n".join(rows)


def toc_rows() -> str:
    rows = []
    for seg in SEGS[1:10]:
        text = seg["text"]
        if seg["seq"] == 2:
            text = "甄士隐梦幻识通灵贾雨村风尘怀闺秀"
        page = seg["pages"][0]["page_no"]
        cls = "segrow on" if seg["seq"] == 3 else "segrow"
        chip = '<span class="sedit">已手改</span>' if seg["seq"] == 4 else ""
        rows.append(f'<div class="{cls}"><span class="stext">{esc(text[:18])}</span>{chip}<span class="spg">p.{page}</span></div>')
    return "\n".join(rows)


def paragraphs() -> str:
    out = []
    for seg in SEGS[:5]:
        seq, text = seg["seq"], seg["text"]
        if seq == 1:
            out.append(f'<p class="para title">{esc(text)}</p>')
        elif seq == 2:
            out.append(f'<p class="para sub">{esc(text)}</p>')
        elif seq == 3:
            out.append(f'<p class="para editing"><span class="gutter">p.1</span>{esc(text[:88])}<span class="caret"></span>{esc(text[88:])}</p>')
        elif seq == 4:
            out.append(f'<p class="para"><span class="gutter edited">已手改</span>{esc(text)}</p>')
        else:
            out.append(f'<p class="para">{esc(text)}</p>')
    return "\n".join(out)


CSS = r"""
:root{
  --bg:#f3f4f6;--surface:#fff;--surface-2:#fafbfc;--surface-3:#f7f8fa;
  --line:#e2e4e8;--line-soft:#eef0f2;--line-strong:#d0d3d9;
  --text:#1f2329;--text-2:#33383f;--muted:#646a73;--faint:#9aa0a8;
  --accent:#2563eb;--accent-soft:#eef4ff;--accent-text:#1d4ed8;
  --ok:#16a34a;--ok-soft:#e9f7ee;--ok-text:#15803d;
  --warn:#d97706;--warn-soft:#fdf3e0;--warn-text:#b45309;
  --bad:#dc2626;--bad-soft:#fdecec;--bad-text:#b91c1c;
  --diff-chars:#b42318;--diff-punct:#b45309;--diff-insert:#0f766e;
  --radius:8px;--shadow-1:0 1px 2px rgba(16,24,40,.05);--shadow-2:0 1px 3px rgba(16,24,40,.10);
}
*{box-sizing:border-box}
html,body{margin:0}
body{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  color:var(--text);background:#e8eaee;-webkit-font-smoothing:antialiased}
a{color:var(--accent-text);text-decoration:none;cursor:pointer}
.docbar{padding:14px 20px 0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.docbar h1{font-size:14px;margin:0 12px 0 0;font-weight:650}
.docbar .fbtn{padding:6px 12px;border:1px solid var(--line-strong);background:#fff;border-radius:6px;font:inherit;font-size:12px;cursor:pointer}
.docbar .fbtn.on{background:var(--accent);border-color:var(--accent);color:#fff}
.docbar .hint{font-size:11.5px;color:var(--muted);margin-left:6px}
.wrap{padding:16px 20px 40px;display:flex;gap:22px;align-items:flex-start}
.notes{width:320px;font-size:12.5px;line-height:1.75;color:var(--muted);flex:none}
.notes h3{font-size:13px;color:var(--text);margin:0 0 6px}
.notes ul{margin:0 0 16px;padding-left:18px}
.notes b{color:var(--text)}
.notes .lg{background:#fff;border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:14px}
.notes .lg div{display:flex;align-items:center;gap:8px;height:22px;font-size:11.5px}
.frame{position:relative;width:1440px;height:900px;background:var(--bg);display:none;flex-direction:column;overflow:hidden;
  box-shadow:0 2px 6px rgba(16,24,40,.06),0 18px 50px rgba(16,24,40,.10)}
.frame.on{display:flex}
.frame--narrow{width:1280px;height:628px}

/* 顶栏 */
.top{height:48px;flex:none;display:flex;align-items:center;gap:8px;padding:0 12px;background:#fff;border-bottom:1px solid var(--line)}
.ibtn{width:28px;height:28px;border:1px solid transparent;background:none;border-radius:6px;font-size:15px;color:var(--muted);cursor:pointer}
.bk{font-weight:600;font-size:13px;letter-spacing:.01em}
.tabs{display:flex;gap:2px;margin-left:10px}
.tab{padding:5px 12px;border-radius:6px;font-size:12.5px;color:var(--muted);cursor:pointer}
.tab.on{background:var(--accent-soft);color:var(--accent-text);font-weight:600}
.spacer{flex:1}
.save{font-size:12px;color:var(--muted);white-space:nowrap}
.save b{color:var(--ok-text);font-weight:600}
.btn{height:28px;padding:0 10px;border:1px solid var(--line-strong);background:#fff;border-radius:6px;font:inherit;font-size:12px;
  color:var(--text-2);display:inline-flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap}
.btn:hover{border-color:#b8bdc6}
.btn--pri{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.btn--pri:hover{background:var(--accent-text);border-color:var(--accent-text)}
.btn--ghost{border-color:transparent;color:var(--muted)}
.btn--sm{height:26px;padding:0 8px;font-size:11.5px}
.btn--xs{height:26px;padding:0 8px;font-size:11.5px}
kbd{font:10px/1 ui-monospace,SFMono-Regular,Menlo,monospace;padding:2px 4px;border:1px solid currentColor;border-radius:3px;opacity:.7}

/* 工具条 */
.rt{height:44px;flex:none;display:flex;align-items:center;gap:10px;padding:0 12px;background:#fff;border-bottom:1px solid var(--line);font-size:12px}
.grp{display:flex;align-items:center;gap:5px}
.num{font-variant-numeric:tabular-nums}
.dim{color:var(--faint)}
.crumb{color:var(--muted);font-size:11.5px}
.bar{width:110px;height:4px;background:#e9ecf1;border-radius:2px;overflow:hidden;margin:0 2px}
.bar i{display:block;height:100%;background:var(--accent);border-radius:2px}
.dot{width:1px;height:16px;background:var(--line);margin:0 4px}
.pchip{height:26px;padding:0 9px;border:1px solid #f0d6a6;background:var(--warn-soft);color:var(--warn-text);
  border-radius:6px;font:inherit;font-size:11.5px;display:inline-flex;align-items:center;gap:5px;cursor:pointer}
.ready{height:36px;flex:none;display:flex;align-items:center;gap:8px;padding:0 14px;background:var(--warn-soft);
  border-bottom:1px solid #f1d9ae;font-size:12px;color:var(--warn-text)}
.ready b{font-weight:600}
.ready a{margin-left:auto;font-weight:600;color:var(--warn-text)}
.ready .ico{width:16px;height:16px;border-radius:50%;background:var(--warn);color:#fff;font:600 11px/16px sans-serif;text-align:center}

/* 分栏 */
.split{flex:1;display:flex;min-height:0}

/* 差异目录 */
.dir{width:240px;flex:none;background:#fff;border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
.dirhd{display:flex;align-items:center;justify-content:space-between;padding:11px 12px 3px;font-weight:600;font-size:12.5px}
.badge{background:var(--warn-soft);color:var(--warn-text);border-radius:10px;padding:1px 7px;font-size:11px;font-weight:600}
.dirsub{padding:0 12px 9px;font-size:10.5px;color:var(--faint);border-bottom:1px solid var(--line-soft);white-space:nowrap}
.seg{display:flex;gap:2px;margin:9px 12px 5px;background:var(--surface-3);border-radius:6px;padding:2px}
.seg span{flex:1;text-align:center;font-size:11.5px;padding:3px 0;border-radius:4px;color:var(--muted);cursor:pointer}
.seg .on{background:#fff;color:var(--text);box-shadow:var(--shadow-1);font-weight:600}
.tree{flex:1;overflow:hidden;padding:2px 0;min-height:0}
.chap{height:30px;display:flex;align-items:center;gap:4px;padding:0 12px;font-size:12.5px;color:var(--text-2);cursor:pointer}
.chap .caret{width:10px;color:var(--faint);font-size:9px}
.chap .cname{font-weight:600}
.chap .cnum{margin-left:auto;font-size:10.5px;color:var(--faint);font-variant-numeric:tabular-nums}
.pagerow{height:24px;display:flex;align-items:center;padding:0 12px 0 34px;font-size:12px;color:var(--text-2);
  border-left:3px solid transparent;font-variant-numeric:tabular-nums;cursor:pointer}
.pagerow .pcnt{margin-left:auto;color:var(--muted)}
.pagerow.on{background:var(--accent-soft);color:var(--accent-text);border-left-color:var(--accent);font-weight:600}
.pagerow.on .pcnt{color:var(--accent-text)}
.pagerow.zero{color:var(--faint)}
.pagerow.zero .pcnt{color:var(--faint)}
.legend{padding:7px 12px 2px;border-top:1px solid var(--line-soft);font-size:10.5px;color:var(--muted);line-height:1.95}
.legend .lgrow{display:flex;align-items:center;gap:7px;height:19px;white-space:nowrap}
.sw{display:inline-block;width:24px;height:0;border-bottom:2px solid var(--diff-chars)}
.sw.punct{border-bottom-style:dashed;border-color:var(--diff-punct)}
.sw.del{border-bottom:3px double;border-color:var(--diff-chars)}
.sw.ins{width:3px;height:12px;border:0;background:var(--diff-insert);border-radius:1px}
.dircap{padding:2px 12px 10px;font-size:10.5px;color:var(--faint)}

/* PDF 列 */
.pdf{flex:1;min-width:340px;background:#e9ebef;display:flex;flex-direction:column;min-height:0;position:relative;padding:0 10px}
.pdfcap{height:24px;flex:none;display:flex;align-items:center;justify-content:center;gap:6px;font-size:11px;color:var(--muted)}
.pdfcap b{color:var(--text-2);font-weight:600}
.pdfbody{flex:1;display:flex;align-items:stretch;justify-content:center;gap:8px;min-height:0;padding-bottom:8px}
.rail{width:22px;flex:none;position:relative}
.paper{height:100%;aspect-ratio:1243/1874;position:relative;background:#fff;flex:none;
  box-shadow:0 1px 3px rgba(16,24,40,.14),0 10px 28px rgba(16,24,40,.12)}
.paper img{width:100%;height:100%;display:block}
.ovl{position:absolute;inset:0;pointer-events:none}
.mk{position:absolute;height:0;border-bottom:3px solid var(--diff-chars);pointer-events:none;border-radius:1px}
.mk.punct{border-bottom:3px dashed var(--diff-punct)}
.mk.del{border-bottom:3px double var(--diff-chars)}
.mk.acked{opacity:.42;border-bottom-width:1.5px}
.mk.caret{height:auto;border:0;width:3px;background:var(--diff-insert);border-radius:1px}
.mk.caret.acked{opacity:.42;width:2px}
.ring{position:absolute;border:2px solid var(--accent);border-radius:2px;pointer-events:none;
  box-shadow:0 0 0 1.5px rgba(255,255,255,.75)}
.ring.teal{border-color:#0f766e}
.tag{position:absolute;right:0;width:18px;height:18px;border-radius:50%;background:#fff;border:1px solid var(--line-strong);
  color:var(--muted);font:600 9.5px/1 ui-monospace,Menlo,monospace;display:flex;align-items:center;justify-content:center;
  transform:translateY(-50%);z-index:2}
.tag.on{width:20px;height:20px;background:var(--accent);border-color:var(--accent);color:#fff;font-size:10px}
.tag.acked{opacity:.5}
.tag::after{content:"";position:absolute;left:100%;top:50%;width:20px;height:1px;background:var(--line-strong);opacity:.8}
.tag.on::after{background:var(--accent);opacity:.55}
.pz{position:absolute;right:16px;bottom:12px;display:flex;align-items:center;gap:2px;background:#fff;border:1px solid var(--line);
  border-radius:8px;padding:2px;box-shadow:var(--shadow-2);font-size:10.5px;color:var(--muted);z-index:3}
.pz button{width:24px;height:22px;border:0;background:none;color:var(--muted);font-size:13px;cursor:pointer}
.pz span{padding:0 5px;font-variant-numeric:tabular-nums}

/* 右侧列表 */
.list{width:540px;flex:none;background:#fff;border-left:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
.listhd{height:34px;flex:none;display:flex;align-items:center;gap:8px;padding:0 12px;border-bottom:1px solid var(--line);
  font-size:11.5px;color:var(--muted);white-space:nowrap}
.listhd b{color:var(--text);font-weight:600}
.sort{height:24px;padding:0 7px;border:1px solid var(--line);background:#fff;border-radius:5px;font:inherit;font-size:11px;color:var(--text-2);cursor:pointer}
.check{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--muted);cursor:pointer}
.check input{width:12px;height:12px;margin:0}
.cards{flex:1;overflow:hidden;padding:10px 12px 4px;min-height:0}
.card{border:1px solid var(--line);border-radius:8px;background:#fff;margin-bottom:8px;overflow:hidden}
.card.open{border-color:#bcd0f7;box-shadow:0 0 0 2px var(--accent-soft);padding-bottom:2px}
.chd{height:30px;display:flex;align-items:center;gap:6px;padding:0 10px;font-size:11.5px;color:var(--muted)}
.idx{font:700 11.5px/1 ui-monospace,Menlo,monospace;color:var(--text)}
.chd .k{color:var(--text-2)}
.chd .pg{margin-left:auto;color:var(--faint);font-size:10.5px}
.crop{position:relative;height:104px;margin:0 10px 8px;border:1px solid var(--line);border-radius:6px;overflow:hidden;background:#f4f2ec}
.crop img{position:absolute;max-width:none;left:0;top:0}
.crop__cap{position:absolute;right:5px;bottom:5px;background:rgba(255,255,255,.92);border:1px solid var(--line);
  border-radius:4px;padding:1px 5px;font-size:9.5px;color:var(--muted)}
.cmp{display:grid;grid-template-columns:15px max-content max-content max-content;justify-content:center;column-gap:3px;row-gap:2px;
  align-items:center;padding:0 10px;font-size:14.5px;line-height:24px}
.g{min-width:0}
.gtag{font:700 9px/1 ui-monospace,Menlo,monospace;color:var(--faint);letter-spacing:.6px}
.pre{text-align:right;color:var(--muted);white-space:nowrap;overflow:hidden}
.post{text-align:left;color:var(--muted);white-space:nowrap;overflow:hidden}
.diff{position:relative;text-align:center;font-weight:700;white-space:nowrap;padding:0 1px;
  border-bottom:2px solid var(--diff-chars);color:var(--text)}
.diff.punct{border-bottom-style:dashed;border-color:var(--diff-punct)}
.diff.del{border-bottom:3px double;border-color:var(--diff-chars)}
.diff.empty{border:1px dashed var(--line-strong);border-radius:3px;height:18px;min-width:18px;display:flex;align-items:center;justify-content:center}
.diff.empty::after{content:"";width:3px;height:3px;border-radius:50%;background:var(--faint)}
.diff.a::after{content:"";position:absolute;left:50%;top:100%;width:1px;height:5px;background:var(--diff-chars);opacity:.55}
.diff.b::after{content:"";position:absolute;left:50%;bottom:100%;width:1px;height:5px;background:var(--diff-chars);opacity:.55}
.diff.a.punct::after,.diff.b.punct::after{background:var(--diff-punct)}
.cact{display:flex;align-items:center;gap:6px;padding:6px 10px 4px}
.hint{margin-left:auto;font-size:10px;color:var(--faint);white-space:nowrap}
.mini{height:42px;display:flex;align-items:center;gap:7px;padding:0 10px;border:1px solid var(--line);border-radius:7px;
  margin-bottom:6px;font-size:11.5px;color:var(--text-2);cursor:pointer;background:#fff}
.mini .k{color:var(--text-2)}
.mini .chg{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--text);background:var(--surface-3);
  border:1px solid var(--line-soft);border-radius:4px;padding:0 4px;line-height:16px}
.mini .st{margin-left:auto;font-size:10.5px;color:var(--muted)}
.mini .st.ok{color:var(--ok-text)}
.mini.acked{opacity:.62}
.lfoot{border-top:1px solid var(--line-soft);padding:7px 12px;font-size:10.5px;color:var(--faint);display:flex;gap:10px;align-items:center}
.lfoot a{color:var(--accent-text)}
.lfoot .spacer{flex:1}

/* 预览 */
.toc{width:240px;flex:none;background:#fff;border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
.tochd{padding:11px 12px 4px;font-weight:600;font-size:12.5px}
.tocsub{padding:0 12px 8px;font-size:10.5px;color:var(--faint);border-bottom:1px solid var(--line-soft)}
.toc .chap{height:28px}
.segrow{height:27px;display:flex;align-items:center;gap:6px;padding:0 12px 0 28px;font-size:11.5px;color:var(--text-2);cursor:pointer}
.segrow .stext{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.segrow .spg{margin-left:auto;color:var(--faint);font-size:10px;flex:none}
.segrow.on{background:var(--accent-soft);color:var(--accent-text);border-left:3px solid var(--accent);font-weight:600}
.segrow .sedit{font-size:9.5px;color:#0f766e;background:#e6f5f2;border-radius:3px;padding:0 3px;flex:none}
.txt{width:600px;flex:none;background:#fff;border-left:1px solid var(--line);display:flex;flex-direction:column;min-height:0}
.txthd{height:32px;flex:none;display:flex;align-items:center;gap:8px;padding:0 16px;border-bottom:1px solid var(--line-soft);font-size:11.5px;color:var(--muted)}
.txthd b{color:var(--text-2);font-weight:600}
.paras{flex:1;overflow:hidden;padding:14px 24px 8px 58px;font-size:16px;line-height:1.95;color:var(--text)}
.para{position:relative;margin:0 0 12px;text-indent:2em}
.para.title{text-indent:0;text-align:center;font-size:20px;font-weight:600;letter-spacing:.1em;margin:24px 0 12px}
.para.sub{text-indent:0;text-align:center;font-size:15px;margin:0 0 20px;color:var(--text-2)}
.para.editing{outline:2px solid var(--accent);outline-offset:5px;border-radius:2px;background:#fff}
.para .gutter{position:absolute;left:-47px;top:3px;font-size:10px;color:var(--faint);white-space:nowrap;text-indent:0}
.para .gutter.edited{color:#0f766e;background:#e6f5f2;border-radius:3px;padding:0 3px;left:-46px}
.caret{display:inline-block;width:1.5px;height:1.05em;background:var(--accent);vertical-align:-2px;margin:0 -1px}
.editbar{height:44px;flex:none;display:flex;align-items:center;gap:9px;padding:0 14px;border-top:1px solid var(--line);
  background:var(--surface-2);font-size:11.5px;color:var(--muted)}
.editbar b{color:var(--text);font-weight:600}
.editbar .ok{color:var(--ok-text)}

/* 窄屏 */
.frame--narrow .dir{width:200px}
.frame--narrow .list{width:500px}
.frame--narrow .dirhd{padding-top:8px}
.frame--narrow .dirsub{padding-bottom:6px}
.frame--narrow .pagerow{height:22px}
.frame--narrow .chap{height:26px}
.frame--narrow .pdfcap{height:20px}
.frame--narrow .crop{height:88px}
.frame--narrow .cards{padding-top:8px}
.frame--narrow .mini{height:38px;margin-bottom:5px}
.frame--narrow .legend .lgrow{height:17px}
.frame--narrow .dircap{display:none}
.frame--narrow .cact{padding-top:4px}
.frame--narrow .top{padding:0 10px}
.frame--narrow .rt{gap:8px;padding:0 10px}
.frame--narrow .bk{font-size:12.5px}
.frame--narrow .tabs{margin-left:6px}
.frame--narrow .tab{padding:4px 9px}
.frame--narrow .para{margin-bottom:9px}
.frame--narrow .paras{font-size:15px;line-height:1.85;padding-top:10px}

body.shot{overflow:hidden}
body.shot .docbar,body.shot .notes{display:none}
body.shot .wrap{padding:0;display:block}
body.shot .frame{display:none;box-shadow:none}
body.shot .frame.on{display:flex}
"""

JS = r"""
const P11 = __P11__;
const P1ACTIVE = __P1ACTIVE__;

function el(tag, cls){ const n=document.createElement(tag); if(cls) n.className=cls; return n; }

function shadePortal(paper){
  const W = paper.clientWidth, H = paper.clientHeight;
  const ovl = paper.querySelector('.ovl');
  const rail = paper.parentElement.querySelector('.rail');
  if(!W || !H) return;
  ovl.innerHTML=''; rail.innerHTML='';
  P11.forEach(it=>{
    const state = it.ack ? ' acked' : '';
    it.boxes.forEach(b=>{
      const [x0,y0,x1,y1]=b.b;
      const m=el('div','mk '+(b.k==='delete'?'del':'')+(it.level==='punct'?' punct':'')+state);
      m.style.left=(x0*W)+'px'; m.style.top=(y1*H+3)+'px'; m.style.width=Math.max(3,(x1-x0)*W)+'px';
      ovl.append(m);
    });
    it.ins.forEach(p=>{
      const m=el('div','mk caret'+state);
      m.style.left=(p.x*W)+'px'; m.style.top=(p.y0*H)+'px'; m.style.height=Math.max(8,(p.y1-p.y0)*H)+'px';
      ovl.append(m);
    });
    const tag=el('div','tag'+state+(it.n===1?' on':''));
    tag.textContent='#'+it.n;
    tag.style.top=(((it.line[1]+it.line[3])/2)*H)+'px';
    rail.append(tag);
  });
  const cur=P11.find(it=>it.n===1);
  if(cur){
    const boxes=cur.boxes.map(b=>b.b);
    if(boxes.length){
      const x0=Math.min(...boxes.map(b=>b[0])), y0=Math.min(...boxes.map(b=>b[1]));
      const x1=Math.max(...boxes.map(b=>b[2])), y1=Math.max(...boxes.map(b=>b[3]));
      const r=el('div','ring');
      r.style.left=(x0*W-3)+'px'; r.style.top=(y0*H-3)+'px';
      r.style.width=((x1-x0)*W+6)+'px'; r.style.height=((y1-y0)*H+6)+'px';
      ovl.append(r);
    }
  }
}

function paintActive(paper){
  const W=paper.clientWidth, H=paper.clientHeight;
  const ovl=paper.querySelector('.ovl');
  if(!W||!H||!P1ACTIVE.length) return;
  const bs=P1ACTIVE.map(l=>l.b);
  const x0=Math.min(...bs.map(b=>b[0])), y0=Math.min(...bs.map(b=>b[1]));
  const x1=Math.max(...bs.map(b=>b[2])), y1=Math.max(...bs.map(b=>b[3]));
  const r=el('div','ring teal');
  r.style.left=(x0*W-3)+'px'; r.style.top=(y0*H-3)+'px';
  r.style.width=((x1-x0)*W+6)+'px'; r.style.height=((y1-y0)*H+6)+'px';
  ovl.append(r);
}

function paintCrops(){
  document.querySelectorAll('.crop').forEach(crop=>{
    const img=crop.querySelector('img');
    const W=crop.clientWidth, Hh=crop.clientHeight;
    const cx=parseFloat(crop.dataset.cx), cy=parseFloat(crop.dataset.cy);
    const w=W*2.5, h=w*1874/1243;
    img.style.width=w+'px';
    img.style.left=(W/2-cx*w)+'px';
    img.style.top=(Hh/2-cy*h)+'px';
  });
}

function layout(){
  document.querySelectorAll('.paper[data-page="11"]').forEach(shadePortal);
  document.querySelectorAll('.paper[data-page="1"]').forEach(paintActive);
  paintCrops();
}

document.querySelectorAll('.fbtn').forEach(b=>b.addEventListener('click',()=>location.hash='#'+b.dataset.f));
function route(){
  const id=(location.hash||'#F1').slice(1);
  document.querySelectorAll('.frame').forEach(f=>f.classList.toggle('on',f.id===id));
  document.querySelectorAll('.fbtn').forEach(b=>b.classList.toggle('on',b.dataset.f===id));
  document.querySelectorAll('.wrap').forEach(w=>{ w.style.display = w.querySelector('.frame.on') ? '' : 'none'; });
  requestAnimationFrame(layout);
}
window.addEventListener('hashchange',route);
if(new URLSearchParams(location.search).get('shot')==='1') document.body.classList.add('shot');
window.addEventListener('load',route);
route();
"""


def frame_top(active: str, save: str = "已保存 ✓ 14:32") -> str:
    tabs = []
    for name in ("页面", "审校", "预览"):
        tabs.append(f'<span class="tab{" on" if name == active else ""}">{name}</span>')
    return (f'<div class="top"><button class="ibtn">←</button>'
            f'<span class="bk">红楼梦第一卷_正文前40页_图像版</span>'
            f'<nav class="tabs">{"".join(tabs)}</nav><span class="spacer"></span>'
            f'<span class="save"><b>{save}</b></span>'
            f'<button class="btn">导出…</button></div>')


def review_toolbar(narrow: bool = False) -> str:
    if narrow:
        return ('<div class="rt"><div class="grp"><button class="btn btn--sm">◀</button>'
                '<span class="num">第 11 页</span><button class="btn btn--sm">▶</button>'
                '<span class="dim num">/ 40</span></div><span class="dot"></span>'
                '<div class="grp"><span class="dim">待判</span><b class="num">85</b><span class="dim">处</span>'
                '<span class="bar"><i style="width:25%"></i></span></div>'
                '<div class="grp"><button class="pchip">标点 66 行 · 32 组</button></div>'
                '<span class="spacer"></span><button class="btn btn--pri btn--sm">下一处 <kbd>⏎</kbd></button>'
                '<button class="btn btn--sm">显示 ▾</button></div>')
    return ('<div class="rt"><div class="grp"><button class="btn btn--sm">◀</button>'
            '<span class="num">第 11 页</span><button class="btn btn--sm">▶</button>'
            '<span class="dim num">/ 40</span><span class="crumb">第一回</span></div><span class="dot"></span>'
            '<div class="grp"><span class="dim">全书待判</span><b class="num">85</b><span class="dim">处</span>'
            '<span class="bar"><i style="width:25%"></i></span></div>'
            '<div class="grp"><button class="pchip">标点 66 行 · 32 组</button></div>'
            '<span class="spacer"></span>'
            '<button class="btn btn--pri btn--sm">下一处未审 <kbd>⏎</kbd></button>'
            '<button class="btn btn--sm">显示 ▾</button></div>')


def directory(narrow: bool = False) -> str:
    return f'''<aside class="dir">
  <div class="dirhd"><span>差异目录</span><span class="badge">待判 151</span></div>
  <div class="dirsub">汉字 85 处 · 标点 66 行（32 组）</div>
  <div class="seg"><span class="on">待判</span><span>全部</span></div>
  <div class="tree">
    {chapter_rows()}
  </div>
  <div class="legend">
    <div class="lgrow"><i class="sw"></i>替换</div>
    <div class="lgrow"><i class="sw punct"></i>只差标点</div>
    <div class="lgrow"><i class="sw ins"></i>另一路多一个字</div>
    <div class="lgrow"><i class="sw del"></i>这一路多一个字</div>
  </div>
  <div class="dircap">字框 100%（1054 / 1054 行）</div>
</aside>'''


def pdf_column(page: int, caption: str, img: str, narrow: bool = False) -> str:
    return f'''<section class="pdf">
  <div class="pdfcap">{caption}</div>
  <div class="pdfbody">
    <div class="rail"></div>
    <div class="paper" data-page="{page}"><img src="data:image/jpeg;base64,{img}" alt=""><div class="ovl"></div></div>
  </div>
  <div class="pz"><button>−</button><span>100%</span><button>+</button><button>⤢</button></div>
</section>'''


def review_list(narrow: bool = False) -> str:
    unacked = [c for c in CARDS if not c["ack"]]
    acked = [c for c in CARDS if c["ack"]]
    current = unacked[0]
    rest = unacked[1:]
    shown = rest[:4] if narrow else rest
    parts = [review_toolbar(narrow)]
    parts.append('<div class="split">')
    parts.append(directory(narrow))
    parts.append(pdf_column(11, '<b>第 11 页</b><span>· 6 处待判</span>', IMG11, narrow))
    parts.append(f'''<aside class="list">
  <div class="listhd"><span><b>本页 8 处</b> · 待判 6</span><span class="spacer"></span>
    <button class="sort">排序：书页顺序 ▾</button>
    <label class="check"><input type="checkbox" checked>仅待判</label></div>
  <div class="cards">
    {open_card(current)}
    {"".join(mini(c) for c in shown)}
  </div>
  <div class="lfoot"><span>另有 {len(acked)} 处已判</span><a>全部 →</a></div>
  <div class="lfoot"><span>Jev 未打分 · 296 行可打分</span><span class="spacer"></span><a>开始打分…</a></div>
</aside>''')
    parts.append('</div>')
    return "".join(parts)


def preview_frame() -> str:
    segs_per_chapter = collections.Counter()
    for seg in SEGS:
        first = min(p["page_no"] for p in seg["pages"])
        segs_per_chapter["c0" if first <= 13 else ("c1" if first <= 24 else "c2")] += 1
    chapters = []
    for i, c in enumerate(CHAPTERS):
        key = f"c{i}"
        cls = "chap open" if i == 0 else "chap"
        caret = "▾" if i == 0 else "▸"
        chapters.append(f'<div class="{cls}"><span class="caret">{caret}</span>'
                        f'<span class="cname">{esc(c["title"])}</span>'
                        f'<span class="cnum">p.{c["page_from"]}–{c["page_to"]} · {segs_per_chapter[key]} 段</span></div>')
        if i == 0:
            chapters.append(toc_rows())
    toc = "".join(chapters)
    return f'''<div class="frame" id="F2">
  {frame_top("预览")}
  <div class="ready"><span class="ico">!</span><span>审校未完成：<b>85 处差异未判</b> · 标点 66 行（32 组）</span><a>去审校 →</a></div>
  <div class="split">
    <aside class="toc">
      <div class="tochd">书籍目录</div>
      <div class="tocsub">146 段 · 3 回 · 已手改 1 段</div>
      {toc}
    </aside>
    {pdf_column(1, "<b>第 1 页</b><span>· 第 3 段（10 行）</span>", IMG1)}
    <aside class="txt">
      <div class="txthd"><b>成品文本</b><span>146 段 · 已手改 1 段</span><span class="spacer"></span><span>自动保存已开</span></div>
      <div class="paras">
        {paragraphs()}
      </div>
      <div class="editbar"><span>正在编辑 · <b>第 3 段</b></span><span class="ok">✓ 已自动保存 14:32</span>
        <span class="spacer"></span><button class="btn btn--sm btn--ghost">取消</button>
        <button class="btn btn--pri btn--sm">完成 <kbd>Esc</kbd></button></div>
    </aside>
  </div>
</div>'''


def notes(kind: str) -> str:
    if kind == "review":
        return '''<aside class="notes">
  <h3>F1 审校页 · 1440×900</h3>
  <ul>
    <li><b>左图只标差异字</b>：没有行框、没有填充；实线=替换、虚线=标点、双线=这一路多字、竖线=另一路多字。</li>
    <li><b>左轨 #1…#8</b> 与右侧卡片同号；当前项蓝框 + 实心号。</li>
    <li><b>右栏一屏只开一条</b>：A/B 两行共享网格，差异字上下对齐，中间 5px 竖线连起来。</li>
    <li><b>卡片里的 2.5× 原图</b>：判断时不用把眼睛移到页面再移回来。</li>
  </ul>
  <div class="lg">
    <div><i class="sw"></i>两路替换（3px 实线）</div>
    <div><i class="sw punct"></i>只差标点（3px 虚线）</div>
    <div><i class="sw ins"></i>另一路多一个字（3px 竖线）</div>
    <div><i class="sw del"></i>这一路多一个字（双线）</div>
  </div>
  <p>样张文字与计数来自真项目 <b>b2t_S79EH0</b> 第 11 页。Jev 未打分是该项目真实状态。</p>
</aside>'''
    if kind == "preview":
        return '''<aside class="notes">
  <h3>F2 预览页 · 1440×900</h3>
  <ul>
    <li><b>成品是干净的</b>：没有红字、没有下划线、没有编号。差异只属于审校页。</li>
    <li><b>未完成只提示一次</b>：顶部一条状态，不下沉到段落。</li>
    <li><b>点段落就地编辑</b>：外扩蓝框，底部编辑条报真实保存状态；没有「提交」。</li>
    <li><b>中栏联动</b>：正在改的段落，其 10 行在原图上青框标出（不填色）。</li>
  </ul>
  <p>段落 3 正在编辑、段落 4 已手改。左侧目录按「回 → 段」组织。样张文字来自真项目第 1 页的组装结果。</p>
</aside>'''
    return '''<aside class="notes">
  <h3>F3 628 · 1280×628</h3>
  <ul>
    <li><b>字号不缩</b>：右栏 14.5/26，与 900 高一致。</li>
    <li><b>页高优先</b>：整页 348px 宽一次看全，不滚动。</li>
    <li><b>放大镜不浮在页面上</b>：2.5× 原图贴在当前卡片里，避免挡住页面。</li>
    <li><b>目录压到 200</b>，图例折成四行短标签；工具条只留页码、待判、标点、下一处。</li>
  </ul>
  <p>628 下判一条的完整链路：页图定位 → 卡片读数 → 2.5× 核对 → 回车。指针可以一直不动。</p>
</aside>'''


def build() -> str:
    narrow_frame = f'''<div class="frame frame--narrow" id="F3">
  {frame_top("审校")}
  {review_list(narrow=True)}
</div>'''
    html = f'''<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>审校页 / 预览页 拆页设计稿（三帧）</title>
<style>{CSS}</style>
</head>
<body>
<div class="docbar">
  <h1>审校 / 预览：拆页设计稿</h1>
  <button class="fbtn" data-f="F1">F1 审校页 1440×900</button>
  <button class="fbtn" data-f="F2">F2 预览页 1440×900</button>
  <button class="fbtn" data-f="F3">F3 628 1280×628</button>
  <span class="hint">数字与文字来自真项目 b2t_S79EH0；设计说明见 docs/ux/review-preview-split.md</span>
</div>
<div class="wrap">
  <div class="frame" id="F1">
    {frame_top("审校")}
    {review_list()}
  </div>
  {notes("review")}
</div>
<div class="wrap">
  {preview_frame()}
  {notes("preview")}
</div>
<div class="wrap">
  {narrow_frame}
  {notes("narrow")}
</div>
<script>
{JS.replace("__P11__", json.dumps(P11, ensure_ascii=False)).replace("__P1ACTIVE__", json.dumps(ACTIVE_LINES, ensure_ascii=False))}
</script>
</body>
</html>
'''
    return html


if __name__ == "__main__":
    out = ROOT / "docs/ux/review-preview-split-mockup.html"
    out.write_text(build(), encoding="utf-8")
    print(out, out.stat().st_size)
