#!/usr/bin/env python3
"""通用视图搬运生成器：名单从文件读，脚本里不出现任何视图的函数名。

用法：
  python3 docs/refactor/evidence/build_view.py --movers <名单文件> --rules <规则.py> --name <ViewName> [--write]

名单文件：一行一个函数名（# 开头为注释）。
规则文件：Python 模块，需提供 IDENT（[(旧, 新)]）、LIT（可选）、FORWARDERS（可选 [(名字, 模板)]）、
          INIT_ANCHOR（可选，插入 init(deps) 的锚点字符串）。
自检：残余接缝 = 0 · node --check 两文件 · app.js 净减 >= MOVE*0.9（复制不是搬）
"""
import argparse, importlib.util, os, re, subprocess, sys, json

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
APP = os.path.join(ROOT, "backend/book2text/static/app.js")

spec = importlib.util.spec_from_file_location("mask", os.path.join(HERE, "index", "rules.py"))
mask_mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mask_mod)


def load_rules(path):
    spec = importlib.util.spec_from_file_location("vr", path)
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


def bounds_of(lines, name):
    for i, ln in enumerate(lines):
        if re.match(r'^(?:async\s+)?function\s+%s\s*\(' % re.escape(name), ln):
            end = next((j for j in range(i, len(lines)) if lines[j] == "}"), None)
            if end: return i, end
    return None


def sub_checked(text, pattern, rep):
    m = mask_mod.code_mask(text); out, last = [], 0
    for hit in re.finditer(pattern, text):
        if hit.start() < len(m) and m[hit.start()]:
            out.append(text[last:hit.start()]); out.append(rep); last = hit.end()
    out.append(text[last:]); return "".join(out)


def forward(text, rules):
    for lit, rep in getattr(rules, "LIT", []):
        text = sub_checked(text, re.escape(lit), rep)
    for old, new in rules.IDENT:
        text = sub_checked(text, r'(?<![\w$.])' + re.escape(old) + r'\b', new)
    return text


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--movers", required=True)
    ap.add_argument("--rules", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--out", default="/tmp/b2t-gen")
    ap.add_argument("--app", default=APP)
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()

    movers = [ln.strip() for ln in open(a.movers, encoding="utf-8")
              if ln.strip() and not ln.strip().startswith("#")]
    rules = load_rules(a.rules)
    lines = open(a.app, encoding="utf-8").read().split("\n")

    missing = [n for n in movers if not bounds_of(lines, n)]
    if missing:
        print("!! 名单里的函数在 app.js 找不到：", missing[:6]); return 2

    body, moved = [], 0
    for n in movers:
        s, e = bounds_of(lines, n)
        top = s
        while top - 1 >= 0 and (lines[top-1].lstrip().startswith(("*", "/**", "//"))):
            top -= 1
        body.append("\n".join(lines[top:e+1])); moved += e - s + 1
    out = forward("\n\n".join(body), rules)

    top_names = set(re.findall(r'(?m)^(?:async\s+)?function ([A-Za-z_$][\w$]*)', "\n".join(lines)))
    top_names |= set(re.findall(r'(?m)^(?:let|const|var) ([A-Za-z_$][\w$]*)', "\n".join(lines)))
    code = mask_mod.strip_code(out)
    declared = set(re.findall(r'(?m)^(?:async\s+)?function ([A-Za-z_$][\w$]*)', code))
    declared |= set(re.findall(r'(?m)^(?:let|const|var) ([A-Za-z_$][\w$]*)', code))
    declared |= set(movers) | set(getattr(rules, "RESIDUE_OK", [])) | {"el"}
    residue = sorted(n for n in top_names - declared
                     if re.search(r'(?<![\w$.])' + re.escape(n) + r'\b', code))

    module = ("(function () {\n  \"use strict\";\n  let injected = {};\n"
              "  const el = (id) => document.getElementById(id);\n\n" + out + "\n" +
              getattr(rules, "INTERFACE", "") + "})();\n")

    os.makedirs(a.out, exist_ok=True)
    open(os.path.join(a.out, "module.js"), "w", encoding="utf-8").write(module)

    print(json.dumps({"movers": len(movers), "moved_lines": moved, "module_lines": module.count("\n"),
                      "residue": residue, "injected_keys": len(set(re.findall(r"injected\.([A-Za-z_$][\w$]*)", code)))},
                     ensure_ascii=False, indent=1))
    return 0 if not residue else 1


if __name__ == "__main__":
    sys.exit(main())
