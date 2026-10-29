"""library 后半：改写 app.js（干跑，只写 /tmp）。四条判据全过才允许 --write。"""
import os, re, sys, shutil, subprocess, importlib.util

HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import rules
spec = importlib.util.spec_from_file_location("b", os.path.join(HERE, "build.py"))
build = importlib.util.module_from_spec(spec); spec.loader.exec_module(build)

ROOT = build.ROOT; APP = build.APP; OUT = build.OUT
STATIC = os.path.dirname(APP)
NODE = shutil.which("node") or "/opt/homebrew/bin/node"

def bounds_of(lines, name):
    for i, ln in enumerate(lines):
        if re.match(r'^(?:async\s+)?function\s+%s\s*\(' % name, ln):
            end = next(j for j in range(i, len(lines)) if lines[j] == "}")
            return i, end
    return None

def main(write=False):
    src = open(APP, encoding="utf-8").read()
    lines = src.split("\n")

    # ---- 1. 生成模块（含 loadLibrary 搬入，它变成 enter 的实现）----
    mod, residue, moved = build.generate(lines)   # 复用前半
    if residue:
        print("!! 残余接缝 %d：%s" % (len(residue), ", ".join(residue))); return 1

    # ---- 2. 删掉 17 个函数 + loadLibrary ----
    dels = []
    for n in rules.MOVERS + ["loadLibrary"]:
        b = bounds_of(lines, n)
        if not b: print("!! 找不到", n); return 1
        a, e = b
        top = a
        while top - 1 >= 0 and (lines[top-1].lstrip().startswith("*") or lines[top-1].lstrip().startswith("/**")
                                or lines[top-1].startswith("//")):
            top -= 1
        dels.append((top, e))
    new = [ln for i, ln in enumerate(lines) if not any(a <= i <= e for a, e in dels)]

    # ---- 3. shell 侧 7 处写点 → notify ----
    txt = "\n".join(new)
    conv = 0
    warn_pat = re.compile(
        r'const warning = el\("library-warning"\);\n(\s*)warning\.textContent =([^;]+);\n\s*warning\.hidden = false;')
    def warn_rep(m):
        nonlocal conv; conv += 1
        return 'window.LibraryView?.notify({ kind: "warning", text: String(%s).trim() });' % m.group(2).strip()
    txt = warn_pat.sub(warn_rep, txt)
    err_pat = re.compile(r'showError\(el\("library-error"\), (\w+)\)')
    def err_rep(m):
        nonlocal conv; conv += 1
        return 'window.LibraryView?.notify({ kind: "error", text: String(%s && %s.message || %s) })' % (
            m.group(1), m.group(1), m.group(1))
    txt = err_pat.sub(err_rep, txt)


    # 两处特例（干跑抓到的）：① 单独清空 ② showError 的第一个参数是个 || 表达式
    txt = txt.replace('el("library-error").hidden = true;',
                      'window.LibraryView?.notify({ kind: "error", text: "" });')
    txt = txt.replace('showError(el("package-result-files") || el("library-error"), error);',
                      'const box = el("package-result-files");\n'
                      '    if (box) showError(box, error);\n'
                      '    else window.LibraryView?.notify({ kind: "error", text: String(error && error.message || error) });')

    # ---- 4. loadLibrary 转发 + boot 里 init ----
    fwd = ('async function loadLibrary() {\n'
           '  // 任务 library 切片：实现在 library-view.js（enter 就是"取项目库并渲染"）。\n'
           '  await window.LibraryView?.enter();\n'
           '}')
    txt = re.sub(r'async function loadLibrary\(\) \{.*?\n\}', fwd, txt, count=1, flags=re.S)

    # ---- 3.5 boot 里补 LibraryView.init(deps)（键从模块正文的 injected.* 抽取）----
    keys = sorted(set(re.findall(r"injected\.([A-Za-z_$][\w$]*)", mod)))
    if not keys:
        print("!! 模块里没有 injected.* 键"); return 1
    deps = []
    for k in keys:
        if k == "navigate":
            deps.append('    navigate: (name) => showView(name),')
        elif k == "projectId":
            deps.append('    projectId: projectId(),')
        elif k == "lastViewLabels":
            deps.append('    lastViewLabels: LAST_VIEW_LABELS,')   # 常量按值注入，不是函数
        elif k.startswith("get") and len(k) > 3 and k[3].isupper():
            state = k[3].lower() + k[4:]
            deps.append('    %s: () => %s,' % (k, state))
        elif k.startswith("set") and len(k) > 3 and k[3].isupper():
            state = k[3].lower() + k[4:]
            deps.append('    %s: (v) => { %s = v; return v; },' % (k, state))
        else:
            deps.append('    %s: (...args) => %s(...args),' % (k, k))
    init_block = "  window.LibraryView?.init({\n" + "\n".join(deps) + "\n  });\n\n"
    marker = "  window.PreviewView?.init({"
    if marker not in txt:
        print("!! boot 里找不到 PreviewView.init 插入点"); return 1
    txt = txt.replace(marker, init_block + marker, 1)

    os.makedirs(OUT, exist_ok=True)
    open(os.path.join(OUT, "app.js"), "w", encoding="utf-8").write(txt)
    open(os.path.join(OUT, "library-view.js"), "w", encoding="utf-8").write(mod)

    left = {x: len(re.findall(r'"%s"' % re.escape(x), txt))
            for x in ["library-error", "library-warning", "create-progress",
                      "library-empty", "library-path", "project-list"]}
    left = {k: v for k, v in left.items() if v}
    print("搬走 %d 个函数 / %d 行" % (len(rules.MOVERS), moved))
    print("模块 %d 行 · 残余接缝 %d · notify 转换 %d 处 · 注入键 %d" % (
        mod.count("\n"), len(residue), conv, len(keys)))
    print("app.js %d → %d 行（净减 %d）" % (len(lines), txt.count("\n"), len(lines) - txt.count("\n")))
    print("残留 id 字面量：%s" % (left or "0 处 ✅"))

    # 四条判据：模块生成 ∧ app.js 改写 ∧ 两个文件 node --check ∧ 残余接缝 0
    ok = True
    for label, path in (("app.js", os.path.join(OUT, "app.js")),
                        ("library-view.js", os.path.join(OUT, "library-view.js"))):
        r = subprocess.run([NODE, "--check", path], capture_output=True, text=True)
        print("node --check %s：%s" % (label, "PASS" if r.returncode == 0 else "FAIL"))
        if r.returncode != 0:
            ok = False; print(r.stderr[-1200:])
    if residue or left:
        ok = False
    if not ok:
        print("!! 四条判据未全过，不落盘"); return 1
    if write:
        shutil.copyfile(os.path.join(OUT, "app.js"), APP)
        shutil.copyfile(os.path.join(OUT, "library-view.js"), os.path.join(STATIC, "library-view.js"))
        print("已落盘：app.js + library-view.js")
    else:
        print("（干跑，未落盘；加 --write 才写仓库）")
    return 0

if __name__ == "__main__":
    sys.exit(main("--write" in sys.argv))
