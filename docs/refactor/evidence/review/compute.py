"""review 切片：按 id 集合算能搬的函数（不按名字、不按行号）。"""
import re, sys, os, json
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
APP = os.path.join(ROOT, "backend/book2text/static/app.js")
HTML = os.path.join(ROOT, "backend/book2text/static/index.html")
EXCLUDE = set("""finishRunAutoPass finishRunLayout revertContinuation markContinuation onContinuationKeydown
loadContinuationReview finishRevokeAutoPass undoLastCleanup loadLanguageSummary afterCleanupApplied
advanceContinuation openFinishPanel pausePageThumbnails afterContinuationChange continuationRemaining
closeFinishPanel renderContinuationPanel""".split())

html = open(HTML, encoding="utf-8").read().split("\n")
ids, cur = set(), None
for ln in html:
    m = re.search(r'<section[^>]*id="(view-[a-z]+)"', ln)
    if m: cur = m.group(1)
    if cur == "view-review": ids |= set(re.findall(r'id="([a-z0-9-]+)"', ln))
    if cur and "</section>" in ln: cur = None
print("view-review 段内 id：", len(ids))

lines = open(APP, encoding="utf-8").read().split("\n")
fns = {}
for i, ln in enumerate(lines):
    m = re.match(r'^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(', ln)
    if not m: continue
    end = next((j for j in range(i, len(lines)) if lines[j] == "}"), None)
    if end: fns[m.group(1)] = (i, end)
movers, other = [], []
for n, (a, b) in fns.items():
    body = "\n".join(lines[a:b+1])
    touched = set(re.findall(r'(?:el|getElementById)\("([a-z0-9-]+)"\)', body))
    if not touched: continue
    if touched <= ids:
        if n not in EXCLUDE: movers.append((n, b - a + 1))
    elif n not in EXCLUDE: other.append((n, len(touched & ids)))
print("能搬（id 全在段内、非 17 个外部流程）：%d 个 / %d 行" % (len(movers), sum(l for _, l in movers)))
print("碰段内 id 但混了段外 id（需人工判）：%d 个" % len(other))
print("前 8 个能搬：", ", ".join("%s(%d)" % (n, l) for n, l in movers[:8]))
json.dump([n for n, _ in movers], open(os.path.join(os.path.dirname(__file__), "movers.json"), "w"), ensure_ascii=False)
