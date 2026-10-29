#!/usr/bin/env python3
"""预览 P2 逐字节证明：正变换 / 逆变换 43/43 函数 + 27 状态（原像 = 基线提交里的 app.js）。

用法：
    python3 docs/refactor/evidence/preview-p2/verify.py
    B2T_BASELINE=7125dd5 python3 docs/refactor/evidence/preview-p2/verify.py

基线默认 7125dd5（P1 之前的最后一版）——那是 43 个函数还全在 app.js 里的唯一原像；
P1 之后的 HEAD 里已少了 6 个联动函数，不能当原像。
"""
import os, re, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
sys.path.insert(0, HERE)
from rules import forward, backward

BASELINE = os.environ.get("B2T_BASELINE", "7125dd5")
HEAD = subprocess.run(
    ["git", "-C", ROOT, "show", f"{BASELINE}:backend/book2text/static/app.js"],
    capture_output=True, text=True, check=True,
).stdout
HL = HEAD.split("\n")
MOD = os.path.join(ROOT, "backend/book2text/static/preview-view.js")
MODT = open(MOD, encoding="utf-8").read()

def func_extract(text,name):
    m=re.search(r'^(?:async )?function '+re.escape(name)+r'\(', text, re.M)
    if not m: return None
    p=text.find('(',m.end()); d=0;j=p
    while j<len(text):
        if text[j]=='(':d+=1
        elif text[j]==')':
            d-=1
            if d==0:break
        j+=1
    b=text.find('{',j); d=0;k=b
    while k<len(text):
        if text[k]=='{':d+=1
        elif text[k]=='}':
            d-=1
            if d==0:break
        k+=1
    return text[m.start():k+1]

# 44 个函数名（HEAD 顺序）
region='\n'.join(HL[9358:10275])
names=[m.group(1) for m in re.finditer(r'^(?:async )?function ([A-Za-z_$][\w$]*)', region, re.M)]
names=[n for n in names if n!='setupPageMore']
print("函数数:",len(names))
ok=True; miss=[]
for n in names:
    a=func_extract(HEAD,n); b=func_extract(MODT,n)
    if b is None: miss.append(n); ok=False; continue
    f=forward(a)
    if b!=f:
        ok=False; print("FAIL 正变换",n)
        import difflib; print('\n'.join(list(difflib.unified_diff(f.split('\n'),b.split('\n'),'expected','module'))[:25]))
        continue
    if backward(b)!=a:
        ok=False; print("FAIL 逆变换",n)
print("正/逆变换 43/43:", "PASS" if ok and not miss else f"FAIL missing={miss}")
print("头/尾抽样:", names[0], names[-1])

# 27 个状态：HEAD 9359..9386 原样出现在模块里
states='\n'.join(HL[9358:9386])
print("状态块 27 行逐字节在模块中:", "PASS" if states in MODT else "FAIL")

# 44 个函数名在模块里各出现一次定义
for n in names:
    cnt=len(re.findall(r'(?m)^(?:async )?function '+re.escape(n)+r'\(', MODT))
    if cnt!=1: print("FAIL 定义次数",n,cnt); ok=False

# 模块里不许引用 app.js 顶层名（模板插值也算）
from rules import strip_code
app_top=set(re.findall(r'^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)',HEAD,re.M))|set(re.findall(r'^(?:let|const|var)\s+([A-Za-z_$][\w$]*)',HEAD,re.M))
code=strip_code(MODT)
local=set(re.findall(r'(?:function|let|const|var)\s+([A-Za-z_$][\w$]*)',code))|set(re.findall(r'const ([A-Za-z_$][\w$]*) =',code))
ids=set(re.findall(r'(?<![\w$.])[A-Za-z_$][\w$]*',code))
bad=sorted((ids&app_top)-local)
print("R1 镜像（模板感知）越界:", bad if bad else "无")
ok = ok and not bad and states in MODT

# R3：模块 el("…") 的 id 必须属于 #view-preview
def strip_comments_only(s):
    out=[];i=0;n=len(s)
    while i<n:
        if s[i]=='/' and s[i+1:i+2]=='/':
            j=s.find('\n',i); j=n if j<0 else j; out.append(' '*(j-i)); i=j
        elif s[i]=='/' and s[i+1:i+2]=='*':
            j=s.find('*/',i+2); j=n if j<0 else j+2
            out.append(''.join(c if c=='\n' else ' ' for c in s[i:j])); i=j
        else: out.append(s[i]); i+=1
    return ''.join(out)
html=open(os.path.join(ROOT, "backend/book2text/static/index.html"), encoding="utf-8").read()
sec=re.search(r'<section[^>]*id="view-preview"[^>]*>',html); depth=1;cur=sec.end();end=len(html)
for m in re.finditer(r'</?section\b',html[cur:]):
    depth += -1 if m.group(0)=='</section' else 1
    if depth==0: end=cur+m.start(); break
sec_ids=set(re.findall(r'\bid="([^"]+)"',html[sec.start():end]))
used=set(re.findall(r'el\(\s*"([^"]+)"\s*\)',strip_comments_only(MODT)))
print("模块 el id:", sorted(used), "越界:", sorted(used-sec_ids) or "无")
ok = ok and not (used-sec_ids)

# window 接口
wins=re.findall(r'(?<![\w$.])window\s*\.\s*([A-Za-z_$][\w$]*)\s*=(?!=)',strip_code(MODT))
print("window 赋值:", wins)
print("\n结论:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
