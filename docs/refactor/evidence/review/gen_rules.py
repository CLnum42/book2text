"""从"残余接缝"自动生成 rules.py：函数→injected.name；状态→injected.getName()。"""
import re, sys, os, subprocess, json
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
APP = os.path.join(ROOT, "backend/book2text/static/app.js")
src = open(APP, encoding="utf-8").read()
fn_names = set(re.findall(r'(?m)^(?:async\s+)?function ([A-Za-z_$][\w$]*)', src))
st_names = set(re.findall(r'(?m)^(?:let|const|var) ([A-Za-z_$][\w$]*)', src))
cap = lambda n: n[0].upper() + n[1:]
lines = []
names = sys.argv[1:]
for n in names:
    if n in ("el",):
        continue
    if n in fn_names or n not in st_names:
        lines.append('    ("%s", "injected.%s"),' % (n, n))
    else:
        lines.append('    ("%s", "injected.get%s()"),' % (n, cap(n)))
print("IDENT = [\n" + "\n".join(lines) + "\n]\n")
print('RESIDUE_OK = ["el", "project_id"]\n')
