"""只读校验：70 个种子做调用闭包，能不能复算到 106？"""
import re, os, json, collections
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
APP = os.path.join(ROOT, "backend/book2text/static/app.js")
EXCLUDE = set(open(os.path.join(os.path.dirname(__file__), "exclude.txt")).read().split()) if os.path.exists(
    os.path.join(os.path.dirname(__file__), "exclude.txt")) else set("""finishRunAutoPass finishRunLayout revertContinuation
markContinuation onContinuationKeydown loadContinuationReview finishRevokeAutoPass undoLastCleanup
loadLanguageSummary afterCleanupApplied advanceContinuation openFinishPanel pausePageThumbnails
afterContinuationChange continuationRemaining closeFinishPanel renderContinuationPanel""".split())
lines = open(APP, encoding="utf-8").read().split("\n")
fns = {}
for i, ln in enumerate(lines):
    m = re.match(r'^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(', ln)
    if not m: continue
    end = next((j for j in range(i, len(lines)) if lines[j] == "}"), None)
    if end: fns[m.group(1)] = (i, end)
names = set(fns)
callees = {n: {c for c in names if c != n and re.search(r'(?<![\w$.])' + re.escape(c) + r'\s*\(', "\n".join(lines[a:b+1]))}
           for n, (a, b) in fns.items()}
callers = collections.defaultdict(set)
for n, cs in callees.items():
    for c in cs: callers[c].add(n)
seeds = set(json.load(open(os.path.join(os.path.dirname(__file__), "movers.json"))))
S = set(seeds); ch = True
while ch:
    ch = False
    for n in list(S):
        for c in callees[n]:
            if c in S or c in EXCLUDE or c not in callers: continue
            if callers[c] <= S: S.add(c); ch = True
print("种子 %d → 闭包 %d 个 / %d 行" % (len(seeds), len(S), sum(fns[n][1]-fns[n][0]+1 for n in S)))
added = sorted(S - seeds)
print("闭包扩展了 %d 个，前 10：%s" % (len(added), ", ".join(added[:10])))
