# UI 资产测试的「源码字面量断言」：怎么重跑体检

> 本文只写**怎么重跑**，不写结论表 —— 这个数是会重新长回来的，任何一次跑出来的数字都会漂。
> 要看现状，跑命令，别引用本文或别人报告里的数。

## 这是什么问题

`tests/integration/test_ui_assets.py` 用静态约定补"界面没有 JS 测试运行器"的缺口，其中一类长这样：

```python
assert "<某段源码原文>" in script              # script = app.js 全文
assert "<某段源码原文>" in _function_body_any("X")
```

这本身是合法手段，但有个已知坑：**断言锁的是「某一行源码」而不是「某个行为」时，函数一搬进视图模块，
这条断言就假红。** 2026-10-30 一晚踩了三次（刀 9.1 的 `pausePageThumbnails`、刀 9.2 的
`refreshRecognizedPages`、更早的 `divergenceCandidatesOn`）——三次都是"产品没坏，测试锁错了东西"。

体检脚本把这件事变成可复算的：它给三个数，并把"会因为搬运假红"的那几条点名。

## 一行命令

```bash
# 在仓库任意位置都行；脚本按自身位置定位仓库，只读，不改任何文件
PYTHONPATH="$PWD/backend" .venv/bin/python scripts/audit_ui_asset_literals.py
```

（`PYTHONPATH` 是 worktree 里的规矩，见 AGENTS.md §1.5；在主树跑可以省略。）

三种输出模式：

```bash
.venv/bin/python scripts/audit_ui_asset_literals.py                # 汇总 + 会假红的那几条（默认）
.venv/bin/python scripts/audit_ui_asset_literals.py --list         # 全量逐条（行号 · 原文 · 目标变量 · 风险）
.venv/bin/python scripts/audit_ui_asset_literals.py --json         # 机读（对集 / 给别的脚本）
.venv/bin/python scripts/audit_ui_asset_literals.py --min-death 9.3   # 只看死期 ≥ 9.3 的待搬键
```

退出码：`0` 跑完了（**不代表"没问题"**，看输出）；`2` 前置不满足（找不到测试文件 / 边界表 / 静态目录）；
`70` 脚本内部异常（`INTERNAL ERROR:` 开头）。

## 期望输出形态（默认模式）

```text
文件：tests/integration/test_ui_assets.py
字面量断言（assert <字面量> in/not in <变量>）：<总数>
  源码片段形态：<N>（其余 <M> 条是 CSS / HTML / 纯名字）
  会因搬运假红：<K>

会因搬运假红的（行号 · 锁的原文 · 命中宿主）：
  <行号> · 'function <待搬函数>(' · <待搬函数>(死期 <刀号>)
  ...

建议改法：`assert "function X(" in script` → `assert _function_body_any("X")`
（或 `in _script_with_view()`）；行为那一栏不变，它本来只验「函数存在」。
```

`会因搬运假红：0` 是唯一"干净"的读法；**有数字不等于要立刻改**——先看它锁的是什么行为（下面第 3 条）。

## 三个数的口径

1. **字面量断言**：`assert <字面量> in <变量>` / `assert <字面量> not in <变量>`，右侧是变量名（或两份拼接）。
   循环里的 `for key in (...): assert key in script` 会把元组里的字面量全部展开算。
2. **源码片段形态**：字面量含源码语法记号（`if (` / `const ` / `await ` / `window.` / `.?.` / `===` …），
   或"整条语句"（含括号且以 `;` `{` `}` 收尾）。其余是 CSS 选择器、HTML id / 属性、纯名字与常量
   —— 它们不随 JS 搬运变红。
3. **会因搬运假红**：现算，不是名单。
   - 待搬键 = `tests/js/boundary.test.mjs` 的 `kinds` 表里 `kind: "T"` 且带 `death` 的导出键
     （= 还要被搬走、或被删掉的函数）。`--min-death N` 可以把范围收到某一刀之后。
   - 一条断言被判"会"，当且仅当：它查的是 **app.js 单份**，且它锁的源码片段在 app.js 里的**每一处出现
     都落在待搬函数体内**（或 app.js 里已经找不到这段源码 = 现在就该红）。
   - 下面四种天然安全，判"不会"：
     - **另有宿主**：同一段源码在 app.js 里还有非待搬函数里的副本；
     - **双份**：断言查 `_script_with_view()`（app.js + 某个视图模块），搬进模块照样命中；
     - **CSS / HTML**：断言查 `styles` / `css` / `page`（app.css、index.html）；
     - **反向断言**：`assert "..." not in ...`，字面量不存在正是它要的。

## 什么时候重跑

- **每一刀 `move(...)` 落盘后**（尤其 9.3–9.6、刀 10 这种"搬一批函数"的刀）：确认没有新增假红。
- **有人新写了一条 `assert "<整行源码>" in script` 之后**：这类断言会静默等待下一次搬运才爆。
- **改 `kinds` 表之后**（`--min-death` 的口径跟着它走）。

## 已知边界（别指望它回答这些）

- 它**不判断行为对不对**，只判断"这一条会不会因为搬运而变红"。行为要靠那个测试自己 docstring + 三栏断言。
- 它**不覆盖 `tests/js/`**（那边是 node 闸，判据形态不同）。
- 它**不解析动态拼出来的字面量**（`f"function {name}("` 这类）：`ast` 只看得到常量。
- 它对**"整行调用点"**这类字面量只给"不会"，但下一刀也许会把那行改写成 `window.PagesView.X(...)`
  —— 那时该断言会红，而它不在本脚本的判据里（"会改写"，不是"会搬运"）。

## 这次体检之后的事

改那几条假红时，**改测试的人和改产品的人不要是同一个**（同一个人既改产品又改测产品的断言，
改松了没人发现）。动作本身很小：`assert "function X(" in script` → `assert _function_body_any("X")`，
或换成 `_script_with_view()`；**行为那一栏不变**，因为它本来就只验"函数存在"。
