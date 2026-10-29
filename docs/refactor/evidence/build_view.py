#!/usr/bin/env python3
"""通用视图搬运生成器：名单从文件读，脚本里不出现任何视图的函数名。

用法：
  python3 docs/refactor/evidence/build_view.py --movers <名单文件> --rules <规则.py> --name <ViewName> [--write]

名单文件：一行一个函数名（# 开头为注释）。
规则文件：Python 模块，需提供
  IDENT        [(旧, 新)]        标识符替换（读侧：状态 → injected.getX()、常量 → injected.NAME）
  MOVED_STATES [名字]            写点全在 movers 的状态：**声明搬进模块、app.js 删掉**（否则两份状态）
  SETTERS      [(名字, setter)]  写点跨区的状态：`x = v;` 改 `injected.setX(v);`
  SET_REWRITES {旧行: 新行}      单行但是自引用（`x = !x`）的逐行点名单改
  SET_BLOCKS   [{"match","head","after"}]  多行赋值：先算局部再 `injected.setX(局部);`
  LIT / FORWARDERS / INIT_ANCHOR / INTERFACE 同前

自检（任一不过就 exit 1 / 2，**不落盘**）：
  ① 残余接缝 = 0（范围**含状态**，不只函数）；
  ② 三个反证：搬走的状态在 app.js 里声明消失、注入的状态在模块正文里裸引用 = 0、被 set 的状态在模块里 `名字 =` = 0；
  ③ SETTERS 里有改不动的行 → 原样报行号 + 原文，**不许猜**（上一轮就是死在"只替换括号内写法"）。
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
    for entry in getattr(rules, 'IDENT_FULL', rules.IDENT):   # (旧, 新) 或 (旧, 新, 形态)
        old, new = entry[0], entry[1]
        text = sub_checked(text, r'(?<![\w$.])' + re.escape(old) + r'\b', new)
    return text


def declaration_bounds(lines, name):
    """顶层状态声明：返回 (起始行, 结束行, 原文)。单行声明返回同一行；多行（未闭合括号）向后收。"""
    for i, line in enumerate(lines):
        if not re.match(r'^(?:const|let|var)\s+%s\s*=' % re.escape(name), line):
            continue
        depth = line.count("(") + line.count("[") + line.count("{") - line.count(")") - line.count("]") - line.count("}")
        end = i
        while depth > 0 and end + 1 < len(lines):
            end += 1
            depth += lines[end].count("(") + lines[end].count("[") + lines[end].count("{")
            depth -= lines[end].count(")") + lines[end].count("]") + lines[end].count("}")
        return i, end, "\n".join(lines[i:end + 1])
    return None


#: 装配代码的标记：`init({ getX: () => …, setX: (v) => { X = v; return v; } })` 里的 get/set 键行。
#: **这些行永远不进改写器**（HANDOFF §9⑮）。三次同型事故：多行块被当写点、重名把声明改成
#: `function injected.X()`、这次 deps 里的 `setX: (value) => { X = value; … }` 被当成"改不动的写点"。
#: 形态上的共同点：生成的产物又被自己的规则检了一遍——那不是健壮性，是在给自己制造假故障。
DEPS_KEY_LINE = re.compile(r'^\s*(?:get|set)[A-Z][A-Za-z0-9_$]*\s*:\s*\(')


def apply_set_blocks(text, rules):
    """多行赋值：`x = f({ … });` → 先算到局部，再 `injected.setX(局部);`。

    **两个必须**（2026-10-29，两次踩在同一处）：
    1. **先在同一份原文上把所有块的行范围算完，再从后往前一次性替换**。
       「边改边重新 split + 边算 depth」这个形态本身就是 bug 源——后处理的块会看见前一次插入的行，
       结果同一个块被插两次（实测：源里 2 处 → 模块里 4 次 setter 调用，而 anti / node --check 全绿）。
    2. 同一 match 出现 N 次就替换 N 次，临时名带序号：`__name1` / `__name2` …… 名字一眼看出对应哪个状态。
    """
    lines = text.split("\n")
    for block in getattr(rules, "SET_BLOCKS", []):
        base = re.search(r"__([A-Za-z_$][\w$]*)", block["head"])
        base_name = base.group(1) if base else "__tmp"
        # ① 先在原文上把所有匹配块的范围算完
        ranges = []
        for i, ln in enumerate(lines):
            if block["match"] not in ln or DEPS_KEY_LINE.match(ln):
                continue
            depth, end = 0, None
            for j in range(i, len(lines)):
                depth += lines[j].count("(") + lines[j].count("[") + lines[j].count("{")
                depth -= lines[j].count(")") + lines[j].count("]") + lines[j].count("}")
                if depth <= 0:
                    end = j
                    break
            if end is None:
                raise SystemExit(f"✗ SET_BLOCKS 的括号没配对：{block['match']}")
            ranges.append((i, end))
        # ② 再从后往前一次性替换
        for n, (start, end) in reversed(list(enumerate(ranges, start=1))):
            suffix = str(n)
            head = block["head"].replace("__" + base_name, "__" + base_name + suffix)
            after = block["after"].replace("__" + base_name, "__" + base_name + suffix)
            indent = re.match(r"^(\s*)", lines[start]).group(1)
            lines[start] = indent + head
            lines.insert(end + 1, indent + after)
    return "\n".join(lines)


def rewrite_writes(text, rules):
    """把 `状态名 = 值;` 改成 `injected.setX(值);`。

    **改不动的行一律报出来**（返回 problems），不许静默漏：多行 RHS、`x = !x` 这种自引用、
    复合赋值（`+=`/`++`）都算改不动——它们必须由 SET_REWRITES 逐行点名。
    """
    setters = dict(getattr(rules, "SETTERS", []))
    overrides = dict(getattr(rules, "SET_REWRITES", {}))
    out_lines, problems = [], []
    for line in text.split("\n"):
        if DEPS_KEY_LINE.match(line):                     # 装配代码：原样保留，不报、不改（§9⑮）
            out_lines.append(line); continue
        if line.strip() in overrides:                     # 缩进不参与匹配：同一个写点在不同层深
            indent = re.match(r"^(\s*)", line).group(1)
            out_lines.append(indent + overrides[line.strip()]); continue
        hit = None
        for name in setters:
            if re.search(r'(?<![\w$.])' + re.escape(name) + r'\s*=(?!=)', line):
                hit = name; break
        if hit is None:
            out_lines.append(line); continue
        simple = re.match(r'^(\s*)' + re.escape(hit) + r'\s*=\s*(.+?);\s*$', line)
        if simple and not re.search(r'(?<![\w$.])' + re.escape(hit) + r'\b', simple.group(2)):
            out_lines.append(f"{simple.group(1)}injected.{setters[hit]}({simple.group(2)});")
        else:
            problems.append(line.strip()[:100])
            out_lines.append(line)
    return "\n".join(out_lines), problems


def count_checks(module_code, app_source, rules):
    """数量自检（anti 证明不了这个）：模块里 setter 调用数 == 源里该赋值出现次数。

    「形态对得上」与「数量对得上」是两件事——今天三次栽在这上面。
    """
    problems = []
    # 只核对**这一刀真的用到的**规则：源文本（改写前）里没有该 match 就跳过，
    # 否则「别的刀的规则」会被当成漏改（刀一只搬部分函数，很多规则的写点不在本刀）。
    for block in getattr(rules, "SET_BLOCKS", []):
        if block["match"] not in app_source:
            continue
        name = re.search(r"injected\.(set[A-Za-z_$][\w$]*)\(", block["after"]).group(1)
        want = len(re.findall(re.escape(block["match"]), app_source))
        # 只数**块改写**的次数（临时名声明），不要数所有 setX 调用——
        # 同一状态还可能有 `x = null;` 这类单行写点，由 SETTERS 改写，混在一起会误报。
        base = re.search(r"__([A-Za-z_$][\w$]*)", block["head"]).group(1)
        got = len(re.findall(r"const __" + base + r"\d+ =", module_code))
        if want != got:
            problems.append(f"SET_BLOCKS {name}：源里 {want} 处，模块里 {got} 次调用（数量不符 = 重复插入或漏改）")
    for old, _new in [(k, v) for k, v in getattr(rules, "SET_REWRITES", {}).items()]:
        if old.strip() not in app_source:
            continue
        got = len(re.findall(re.escape(old.strip()), module_code))
        if got != 1:
            problems.append(f"SET_REWRITES「{old.strip()[:40]}」：模块里 {got} 次（应为 1）")
    return problems


def anti_checks(module_code, app_text, rules):
    """三个反证（都要求 0）。返回问题列表。"""
    problems = []
    masked = mask_mod.strip_code(module_code)
    for name in getattr(rules, "MOVED_STATES", []):
        if re.search(r'(?m)^(?:const|let|var)\s+%s\s*=' % re.escape(name), app_text):
            problems.append(f"搬走的状态 {name} 在 app.js 里还有声明——两份状态")
    for entry in getattr(rules, "IDENT_FULL", getattr(rules, "IDENT", [])):
        name = entry[0]                       # 规则表允许 (旧, 新) 或 (旧, 新, 形态) 两种写法
        if re.search(r'(?<![\w$.])' + re.escape(name) + r'\b', masked):
            problems.append(f"{name} 判注入，但模块正文里仍裸引用它")
    bad_assign = re.findall(r'injected\.get[A-Za-z0-9_$]*\(\)\s*=(?!=)', masked)
    if bad_assign:
        problems.append(f"给 getter 赋值 {len(bad_assign)} 处（{bad_assign[0]}）——写点没走 setter，这是 SETTERS 漏项")
    for name, _setter in getattr(rules, "SETTERS", []):
        if re.search(r'(?<![\w$.])' + re.escape(name) + r'\s*=(?!=)', masked):
            problems.append(f"{name} 判走 setter，但模块正文里还有 `{name} =`——改写漏了")
    return problems


def deps_literal(rules):
    """从规则表生成 `init({...})` 的依赖对象：getter / setter / 函数，键名与模块里的 `injected.xxx` 对齐。"""
    keys = []
    seen = set()
    for entry in getattr(rules, "IDENT_FULL", getattr(rules, "IDENT", [])):
        expr = entry[1]
        hit = re.match(r"injected\.([A-Za-z_$][\w$]*)", expr)
        if not hit:
            continue
        key = hit.group(1)
        if key in seen:
            continue
        seen.add(key)
        if expr == "injected." + key:                      # 函数 / 常量值
            keys.append(f"    {key}: {entry[0]},")
        elif expr == f"injected.get{key[3:]}()" or key.startswith("get"):
            name = entry[0]
            keys.append(f"    {key}: () => {name},")
        elif key.startswith("set"):
            name = entry[0]
            keys.append(f"    {key}: (value) => {{ {name} = value; return value; }},")
    for name, setter in getattr(rules, "SETTERS", []):
        if setter not in seen:
            seen.add(setter)
            keys.append(f"    {setter}: (value) => {{ {name} = value; return value; }},")
    return "\n".join(keys)


def forwarders_of(movers, lines, name_of_module):
    """把每个 mover 的函数体换成一转发行，返回 {函数名: 新函数源码}（保住 async）。"""
    out = {}
    for n in movers:
        s, e = bounds_of(lines, n)
        head = lines[s]
        is_async = head.lstrip().startswith("async")
        prefix = "async " if is_async else ""
        out[n] = (s, e, f"{prefix}function {n}() {{ return window.{name_of_module}.{n}.apply(window.{name_of_module}, arguments); }}")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--movers", required=True)
    ap.add_argument("--rules", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--out", default="/tmp/b2t-gen")
    ap.add_argument("--app", default=APP)
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()

    if a.movers.endswith(".json"):
        data = json.load(open(a.movers, encoding="utf-8"))
        mv = data["movers"] if isinstance(data, dict) else data
        movers = [m if isinstance(m, str) else m.get("name") or m.get("fn") for m in mv]
    else:
        movers = [ln.strip() for ln in open(a.movers, encoding="utf-8")
                  if ln.strip() and not ln.strip().startswith("#")]
    rules = load_rules(a.rules)
    app_source = open(a.app, encoding="utf-8").read()
    lines = app_source.split("\n")
    app_lines_before = len(lines) - (1 if lines and lines[-1] == "" else 0)

    # ⓪a movers 名单不许有重名：搬移按名字执行，重名必然复制两份真实现（R4-dup 会红，但那是落盘后才发现）
    dupes = sorted({n for n in movers if movers.count(n) > 1})
    if dupes:
        print("✗ movers 名单里有重名（会复制两份真实现）：", "、".join(dupes))
        return 2

    # ⓪0 增量三条守卫（fail-closed）：模块已存在时，不许"整份重写"把已有内容抹掉。
    # 形态：读现有模块 → 追加新函数 → 增量更新 api。守卫是这一步的前提，先落守卫再落增量写入。
    module_path = os.path.join(ROOT, "backend/book2text/static", f"{a.name.lower()}-view.js")
    if os.path.exists(module_path):
        existing = open(module_path, encoding="utf-8").read()
        have_fns = set(re.findall(r'(?m)^  function ([A-Za-z_$][\w$]*)\s*\(', existing))
        dup = sorted(set(movers) & have_fns)
        if dup:
            print("✗ 守卫①重名：这些函数在现有模块里已存在（增量不许覆盖）：", "、".join(dup))
            return 2
        have_states = set(re.findall(r'(?m)^  (?:let|const) ([A-Za-z_$][\w$]*)\s*=', existing))
        dup_state = sorted(set(getattr(rules, "MOVED_STATES", [])) & have_states)
        if dup_state:
            print("✗ 守卫②声明重复：这些状态模块里已有声明（再声明就是两份）：", "、".join(dup_state))
            return 2
        want = set(getattr(rules, "EXPECTED_API_KEYS", None) or [])
        if want:
            # 守卫③比较的是「INTERFACE 准备写出的 api 键」与「预期键集合」——
            # 不是「现有键 ∪ movers」：搬进来的 setup* / PageTile 函数不是导出，用那个公式会全判成多余。
            m = re.search(r"const api = \{(.*?)\};", getattr(rules, "INTERFACE", ""), re.S) or \
                re.search(r"const api = \{(.*?)\};", existing, re.S)
            will = {k.strip().rstrip(",") for k in (m.group(1).split("\n") if m else []) if k.strip()}
            if will != want:
                print("✗ 守卫③api 键集合：多", sorted(will - want), "少", sorted(want - will))
                return 2

    # ⓪ movers ∩ IDENT 必须为空：渲染函数要么搬进模块、要么注入，不能两者都是。
    # （2026-10-29 真实事故：renderMarginPanel 同时在两处 → 替换把函数声明写成
    #  `function injected.renderMarginPanel()`；dry run 全绿，--write 才崩在 node --check。）
    ident_names = {entry[0] for entry in getattr(rules, "IDENT_FULL", getattr(rules, "IDENT", []))}
    both = sorted(set(movers) & ident_names)
    if both:
        print("✗ 这些名字同时出现在 movers 与 IDENT 里（要么搬进模块、要么注入，不能两者都是）：")
        for n in both:
            print(f"   - {n}")
        return 2

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
    # 搬走的状态：声明随搬（模块里声明，app.js 里删）——判据是"app.js 声明消失"
    moved_states = []
    for name in getattr(rules, "MOVED_STATES", []):
        found = declaration_bounds(lines, name)
        if not found:
            print(f"!! MOVED_STATES 里的 {name} 在 app.js 找不到声明"); return 2
        start, end, text = found
        moved_states.append(text)
        for i in range(start, end + 1):
            lines[i] = ""
    out = "\n\n".join(moved_states + ["\n\n".join(body)])
    pre_rewrite = out
    out = apply_set_blocks(out, rules)
    out, tune_problems = rewrite_writes(out, rules)
    if tune_problems:
        print("!! 这些写点改不动（多行 RHS / 自引用 / 复合赋值），先用 SET_REWRITES 逐行点名再跑：")
        for item in tune_problems:
            print("   " + item)
        return 2
    out = forward(out, rules)

    top_names = set(re.findall(r'(?m)^(?:async\s+)?function ([A-Za-z_$][\w$]*)', "\n".join(lines)))
    top_names |= set(re.findall(r'(?m)^(?:let|const|var) ([A-Za-z_$][\w$]*)', "\n".join(lines)))
    code = mask_mod.strip_code(out)
    declared = set(re.findall(r'(?m)^(?:async\s+)?function ([A-Za-z_$][\w$]*)', code))
    declared |= set(re.findall(r'(?m)^(?:let|const|var) ([A-Za-z_$][\w$]*)', code))
    declared |= set(movers) | set(getattr(rules, "MOVED_STATES", [])) | set(getattr(rules, "RESIDUE_OK", [])) | {"el"}
    residue = sorted(n for n in top_names - declared
                     if re.search(r'(?<![\w$.])' + re.escape(n) + r'\b', code))

    module = ("(function () {\n  \"use strict\";\n  let injected = {};\n"
              "  const el = (id) => document.getElementById(id);\n\n" + out + "\n" +
              getattr(rules, "INTERFACE", "") + "})();\n")

    if getattr(rules, "FORWARDERS", False):
        fw = forwarders_of(movers, lines, f"{a.name}View")
        for n, (start, end, text) in sorted(fw.items(), key=lambda kv: -kv[1][0]):
            lines[start:end + 1] = [text]
        if getattr(rules, "INIT_ANCHOR", ""):
            anchor = next((i for i, ln in enumerate(lines) if rules.INIT_ANCHOR in ln), None)
            if anchor is None:
                print(f"!! INIT_ANCHOR 找不到：{rules.INIT_ANCHOR}"); return 2
            indent = re.match(r"^(\s*)", lines[anchor]).group(1)
            init_lines = (f"{indent}window.{a.name}View?.init({{\n"
                          + deps_literal(rules) + f"\n{indent}}});").split("\n")
            lines[anchor + 1:anchor + 1] = init_lines   # 插在锚点**之后**：锚点是 boot() 里的 `setupLibrary();`

    os.makedirs(a.out, exist_ok=True)
    open(os.path.join(a.out, "module.js"), "w", encoding="utf-8").write(module)

    # --write：只有上面全部自检通过（残余 0、反证 0）才走到这里。落盘前再验一次语法，红就不写。
    if a.write:
        anti = anti_checks(module, "\n".join(lines), rules)      # 落盘前再跑一次反证（这里 anti 还没算）
        if residue or anti:
            print("✗ 自检没过，拒绝 --write（宁可不写，也不留一个带未定义标识符的 app.js）"); return 1
        MODULE_OUT = os.path.join(ROOT, "backend/book2text/static", f"{a.name.lower()}-view.js")
        for path, text in ((MODULE_OUT, module), (a.app, "\n".join(lines))):
            tmp = path + ".tmp.js"   # 后缀必须是 .js：node --check 认扩展名
            open(tmp, "w", encoding="utf-8").write(text)
            check = subprocess.run(["node", "--check", tmp], capture_output=True, text=True)
            if check.returncode != 0:
                os.unlink(tmp)
                print(f"✗ node --check 失败：{path}\n{check.stderr[:400]}"); return 1
            os.replace(tmp, path)
        app_lines_after = len(lines) - (1 if lines and lines[-1] == "" else 0)
        print(json.dumps({"written": [os.path.relpath(MODULE_OUT, ROOT), os.path.relpath(a.app, ROOT)],
                          "app_lines_after": app_lines_after, "app_lines_before": app_lines_before,
                          "net": app_lines_before - app_lines_after}, ensure_ascii=False))

    lines_text = "\n".join(lines)
    anti = anti_checks(module, lines_text, rules) + count_checks(module, pre_rewrite, rules)
    print(json.dumps({"movers": len(movers), "moved_lines": moved, "moved_states": len(moved_states),
                      "module_lines": module.count("\n"),
                      "residue": residue, "anti": anti,
                      "injected_keys": len(set(re.findall(r"injected\.([A-Za-z_$][\w$]*)", code)))},
                     ensure_ascii=False, indent=1))
    return 0 if not residue and not anti else 1


if __name__ == "__main__":
    sys.exit(main())
