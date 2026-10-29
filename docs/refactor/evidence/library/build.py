"""library 切片：生成模块正文（干跑，只写 /tmp）。

第一阶段只做"生成模块"，不改 app.js——按 Chief 2026-10-29 的拆法。
用 index 那套 code_mask（模板感知）做替换，替换后自检"残余接缝标识符"。
"""
import os, re, sys, importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import rules

# 复用 index 的 code_mask（注释/字符串/模板文本不可替换，保留 ${…}）
spec = importlib.util.spec_from_file_location(
    "idx", os.path.join(HERE, "..", "index", "rules.py"))
idx = importlib.util.module_from_spec(spec); spec.loader.exec_module(idx)

ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
APP = os.path.join(ROOT, "backend", "book2text", "static", "app.js")
OUT = "/tmp/b2t-library"

def sub_checked(text, pattern, rep):
    mask = idx.code_mask(text)
    out, last = [], 0
    for m in re.finditer(pattern, text):
        if m.start() < len(mask) and mask[m.start()]:
            out.append(text[last:m.start()]); out.append(rep); last = m.end()
    out.append(text[last:])
    return "".join(out)

# 跨子树 DOM 句柄（§22.2 ④）：这些 id 不在 view-library 子树里（全局 modal / 别的视图），
# R3 对模块零豁免，所以一个字面量都不许留——一律换成注入的 getter，由 app.js 那边返还节点。
FOREIGN_DOM = [
    ("new-project-file", "injected.getNewProjectPicker()"),
    ("new-project-name", "injected.getNewProjectName()"),
    ("new-project-modal-error", "injected.getNewProjectError()"),
    ("new-project-mask", "injected.getNewProjectMask()"),
    ("export-include-notes", "injected.getExportIncludeNotes()"),
    ("pages-overlay-toggle", "injected.getPagesOverlayToggle()"),
    ("pages-margin-toggle", "injected.getPagesMarginToggle()"),
    ("review-margin-toggle", "injected.getReviewMarginToggle()"),
]

def forward(text):
    # 状态写点：整句替换（必须带上分号，否则少一个右括号——2026-10-29 干跑抓到）
    def stmt(text, name, setter):
        mask = idx.code_mask(text); out = []; last = 0
        for m in re.finditer(r'(?<![\w$.])' + name + r' = ([^;\n]+);', text):
            if m.start() < len(mask) and mask[m.start()]:
                out.append(text[last:m.start()]); out.append("%s(%s);" % (setter, m.group(1))); last = m.end()
        out.append(text[last:]); return "".join(out)
    for state, setter in rules.SETTERS.items():
        text = stmt(text, state, setter)
    # project_id 只替换"函数调用"形态（对象字面量的键不能替换：`{ project_id: x }`）
    text = sub_checked(text, r'(?<![\w$.])project_id\s*\(', 'injected.projectId(')
    for ident, rep in rules.IDENT:
        text = sub_checked(text, r'(?<![\w$.])' + re.escape(ident) + r'\b', rep)
    # 跨子树 DOM：`el("new-project-name")` → `injected.getNewProjectName()`
    for dom_id, rep in FOREIGN_DOM:
        text = sub_checked(text, r'el\(\s*"' + re.escape(dom_id) + r'"\s*\)', rep)
    return text

def generate(lines):
    bounds = {}
    for i, ln in enumerate(lines):
        m = re.match(r'^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(', ln)
        if not m: continue
        end = next((j for j in range(i, len(lines)) if lines[j] == "}"), None)
        if end: bounds[m.group(1)] = (i, end)
    body, moved = [], 0
    for n in rules.MOVERS:
        a, b = bounds[n]; top = a
        while top - 1 >= 0 and (lines[top-1].lstrip().startswith("*") or lines[top-1].lstrip().startswith("/**") or lines[top-1].startswith("//")):
            top -= 1
        body.append("\n".join(lines[top:b+1])); moved += b - a + 1
    a, b = bounds["loadLibrary"]
    body.append("\n".join(lines[a:b+1]))
    out = forward("\n\n".join(body))
    top_names = set(re.findall(r'(?m)^(?:async\s+)?function ([A-Za-z_$][\w$]*)', "\n".join(lines)))
    top_names |= set(re.findall(r'(?m)^(?:let|const|var) ([A-Za-z_$][\w$]*)', "\n".join(lines)))
    code = idx.strip_code(out)
    declared = set(re.findall(r'(?m)^(?:async\s+)?function ([A-Za-z_$][\w$]*)', code))
    declared |= set(re.findall(r'(?m)^(?:let|const|var) ([A-Za-z_$][\w$]*)', code))
    declared |= set(rules.MOVERS) | {"el", "project_id"}   # el 骨架自带；project_id 是对象字面量的键，不是引用
    residue = sorted(n for n in top_names - declared if re.search(r'(?<![\w$.])' + re.escape(n) + r'\b', code))
    iface = """
  // ---------------------------------------------------------------- 对外接口
  /**
   * 挂上目录页自己的 DOM 接线（2026-10-29 Chief 裁定 B）。
   * 上传建项目是目录页的域操作：外壳不再调 createProjectFromFile——
   * 它写 `#create-progress`（在 view-library 子树里），外壳留着就撞 R3。
   * 列表点击 / 删除的接线本来就在 renderProjectList 里，随模块走。
   */
  const init = (deps) => {
    injected = { ...injected, ...(deps || {}) };
    const picker = injected.getNewProjectPicker();
    if (picker && !picker.dataset.b2tLibraryBound) {
      picker.dataset.b2tLibraryBound = "1";
      picker.addEventListener("change", () => {
        if (picker.files && picker.files[0]) createProjectFromFile(picker.files[0]);
        picker.value = "";
      });
    }
  };

  /** 进入/刷新目录页：取项目库并渲染（原 loadLibrary 的全部实现）。 */
  const enter = async () => { await loadLibrary(); };

  /** 域操作（D-100）：打开一个项目。外壳的锁冲突确认 / 任务包打开 / 备份还原走这里。 */
  const open = async (projectId, options) => await openProject(projectId, options);

  /**
   * 外壳流程往目录页写一句话（任务包导入/备份还原/重跑）。
   * - `text` 为空 = 收起；
   * - `error` 有值 = **按外壳的 showError 渲染**（含"错误编号"与 detail）。
   *   这条不能省：外壳原本就是 `showError(el("library-error"), error)`，只用 text
   *   会把错误编号丢掉，那是行为变化，不是搬运。
   */
  const notify = (payload) => {
    const { kind, text, error } = payload || {};
    const node = kind === "warning" ? el("library-warning") : el("library-error");
    if (!node) return;
    if (error) { injected.showError(node, error); return; }
    if (!text) { node.hidden = true; return; }
    node.textContent = String(text);
    node.hidden = false;
  };

  window.LibraryView = {
    init,
    enter,
    notify,
    open,
  };
"""
    module = ("(function () {\n  \"use strict\";\n  let injected = {};\n  const el = (id) => document.getElementById(id);\n\n" + out + "\n" + iface + "})();\n")
    return module, residue, moved

def main():
    lines = open(APP, encoding="utf-8").read().split("\n")
    bounds = {}
    for i, ln in enumerate(lines):
        m = re.match(r'^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(', ln)
        if not m: continue
        end = next((j for j in range(i, len(lines)) if lines[j] == "}"), None)
        if end: bounds[m.group(1)] = (i, end)

    missing = [n for n in rules.MOVERS if n not in bounds]
    if missing:
        print("!! 找不到函数:", missing); return 1

    body, moved = [], 0
    for n in rules.MOVERS:
        a, b = bounds[n]
        # 带上紧邻其上的 doc 注释块（如果有）
        top = a
        while top - 1 >= 0 and (lines[top-1].startswith(" *") or lines[top-1].startswith("/**")
                                or lines[top-1].startswith("//")):
            top -= 1
        body.append("\n".join(lines[top:b+1]))
        moved += b - a + 1
    src = "\n\n".join(body)
    out = forward(src)

    # 残余接缝：app.js 顶层符号里还有裸着出现的
    top = set(re.findall(r'(?m)^(?:async\s+)?function ([A-Za-z_$][\w$]*)', "\n".join(lines)))
    top |= set(re.findall(r'(?m)^(?:let|const|var) ([A-Za-z_$][\w$]*)', "\n".join(lines)))
    code = idx.strip_code(out)
    declared = set(re.findall(r'(?m)^(?:async\s+)?function ([A-Za-z_$][\w$]*)', code))
    declared |= set(re.findall(r'(?m)^(?:let|const|var) ([A-Za-z_$][\w$]*)', code))
    declared |= set(rules.MOVERS) | {"el", "project_id"}   # el 骨架自带；project_id 是对象字面量的键，不是引用
    residue = sorted(n for n in top - declared
                     if re.search(r'(?<![\w$.])' + re.escape(n) + r'\b', code))

    module = ("(function () {\n  \"use strict\";\n  let injected = {};\n"
              "  const el = (id) => document.getElementById(id);\n\n" + out + "\n})();\n")

    os.makedirs(OUT, exist_ok=True)
    open(os.path.join(OUT, "library-view.js"), "w", encoding="utf-8").write(module)

    print("搬走函数 %d 个 / 正文 %d 行" % (len(rules.MOVERS), moved))
    print("模块文件 %d 行（含骨架 %d 行）" % (module.count("\n"), module.count("\n") - moved))
    print("残余接缝 %d 个" % len(residue))
    if residue: print("   ", ", ".join(residue))
    print("injected 键 %d 个" % len(set(re.findall(r"injected\.([A-Za-z_$][\w$]*)", code))))
    return 0 if not residue else 1

if __name__ == "__main__":
    sys.exit(main())
