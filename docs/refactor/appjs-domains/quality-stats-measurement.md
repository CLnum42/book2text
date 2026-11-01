# 质量统计域：独立测量附录（刀 A）

> **这是测量附录，不是施工书。** 施工以 `docs/refactor/appjs-domains/first-batch.md` §2 为准（Architect，`8983c53`）。
> 本文只记 DevLead 的**独立测量**与「与施工书对不上的 5 处」；其中第 1、2 条 Chief 已认，Builder 按修正版落。
> 量数树：`main@72a8535`，后续树 `4676772`（app.js **12,755** / **505** 顶层函数 / pages-view **3,952** /
> deps **173** / PagesView 导出 **36** / R3 pages **0 种 0 处**）。行号实测于 `4676772`。

**写作过程里被自己推翻的一版（留痕，免得下一个人再走一遍）**：我最早按「为谁存在」把 `percentText` 判成
「工具」（3 函数 / 98 行），Architect 判它归本域（4 函数 / 101 行）。**以 Architect 的判法为准**：pages 只是
借它显示分歧率、不拥有它；让它留在本域、由外壳转发，模块内部就不必为 3 行格式化函数再开一条注入。

## 一、边界：4 函数 / 101 行，151 的分解对得平

| 函数 | 行 | 行数 | 归属判定 |
|---|---|---:|---|
| `statsRow` | 2557–2564 | 8 | 本域（只被 `renderSummary` 调，6 处全是展开调用） |
| `percentText` | 2566–2568 | 3 | 本域（pages-view:415 只借显示）；导出给 pages deps 转发 |
| `loadSummary` | 2570–2581 | 12 | 本域 |
| `renderSummary` | 2583–2660 | 78 | 本域 |
| **合计** | | **101** | 与施工书一致 |

`151` 的完整分解：本域函数体 **101** + `statsRow` 的 doc 1 = **102**；夹带 **41**
（`renderProject` 12 + `renderProjectMeta` 24 + 它的 doc 5）；空行 **7**；段头 **1**。102 + 41 + 7 + 1 = **151**。

删除预算：`2556–2661` 共 **106 行**（doc + 4 个函数 + 之间 3 个空行）⇒ app.js **12,755 → 12,649**。
段头 2554 与 2555 空行留给 `renderProject` / `renderProjectMeta`。

## 二、扫法：同一个 `statsRow`，三种口径三种结果

```
...statsRow(   在 2595 / 2607 / 2613 / 2629 / 2632 / 2649（+ 定义位 2557）
grep "statsRow("          → 7   能看见（"statsRow(" 是子串）
grep -E "^\s*statsRow\("  → 0   看不见——按"调用位起头"扫时，`...` 把它挡在行首之外
grep -w "statsRow"        → 7
```

⇒ 判据用 `\b名字\b` 再扣掉定义位。书 §7 已把这条写成纪律（定义位 / 值位 / 调用位三栏各扫一遍），
**但书 §2 自己的调用点清单还是漏了一个值位引用**（下条）。

## 三、夹带：2 个函数 / 41 行，都不进

```
renderProject  2662–2673 (12)  写 #project-title / #package-chip、调 PagesView.onPageListChanged、
                               决定打开项目后切到哪个视图 ⇒ 项目信息 / 外壳
renderProjectMeta 2680–2703 (24 + 5 行注释)  填设置对话框「当前项目」一节
                               callers：refreshPageStates:5015、pages-view:1175/1982/2948
```

副作用：搬完这 4 个函数，段头「质量统计」下面只剩这两个函数，**名不副实**。建议同批把段头改成
「项目头与项目信息」（纯注释改动，不影响行数、不影响任何判据）。

## 四、调用点：4 个，不是 3 个（其中 1 个是值位）

| 行 | 宿主 | 形态 | 改成 |
|---|---|---|---|
| 1099 | `openStatsPanel` | `loadSummary();` | `window.QualityStats?.load()` |
| 2546 | `refreshProject` | `queueAfterSteps(() => loadSummary())` | `…?.load()` |
| 4949 | `pollTask` | `await loadSummary()` | `await …?.load()` |
| **10994** | **`setupLibrary`** | **`addEventListener("click", loadSummary)`（值位）** | **`() => …?.load()`** |

`percentText` 的值位在 pages deps 表 `:12480`（施工书已列，改成转发 lambda）。

**第 4 条为什么致命**：`setupLibrary()` 在 `boot:12397` 调用；`loadSummary` 一旦从 app.js 删掉而这一行不改，
求值 `loadSummary` 就抛 `ReferenceError`，**启动即失败**。这是「只看调用位会漏」的第三次复现
（9.5 的 rAF / 10b 的 setTimeout / 这个 addEventListener）。

## 五、对施工书的 5 处修正

1. **第 4 个调用点（:10994）**——施工书只列了 3 处。Chief 已认，Builder 按修正版落。
2. **deps 是 173，不是 186**——186 是刀 10b 的数，刀 11 删了 13 条死键。复现：同一段数键
   `b61634d = 186` / `20049f9 = 173` / `4676772 = 173`。判据写 **173 → 173**。
3. **判据②（模块 DOM 面 0）现在没有闸**——仓库里没有任何测试锁「模块不许 `el(` / `getElementById`」或
   「`el("stats-list")` 全仓 0」。要写成 `tests/js` 断言 + 一条变异，才算机检；否则只是人工 grep。
4. **root 可能为 null**——单测的合成 DOM 没有 `#stats-panel`（`tests/js/load-app.mjs` 的
   `getElementById` 恒 `null`），`preloadModules` 也不传 root。`init` 要 `root = deps.root || null`，
   `render` 开头 `if (!root) return;`。
5. **`render(data)` 导出要有真调用点**——没有测试真调就别导出（preview 的 `exit` 前例：0 调用点被删）。

一条免写的好消息：`quality-stats.js` 暴露 `window.QualityStats`，**R7b 自动要求它的 `<script>` 在 app.js
之前**（漏了红）——这条不用新写闸。R3 只扫 `*-view.js`，所以非视图模块不受 R3 约束；它的 DOM 纪律靠第 3 条那个新断言。

## 六、落盘后我按这张表验（不是施工步骤，是验收判据）

```
① 函数名集合相减：app.js 顶层函数名 before/after 的差集 == {statsRow, percentText, loadSummary, renderSummary}
   505 → 501（不数总数）；两边各出一份名单，comm -23 对集
② deps 173 → 173（不是 186）
③ PagesView 导出 36（vm 载模块取 Object.keys）
④ R3 pages：total 0 / ids 0
⑤ 模块 DOM 面：剥注释后 quality-stats.js 的 `el(` = 0、`document.getElementById` = 0；
   全仓 `el("stats-list")` = 0、`el("stats-note")` = 0
⑥ 四闸 + audit：node / pytest 1035 / accept [0] / registry 0 不合格 / audit 会假红 0
⑦ 变异：模块副本塞一句 `el("stats-list")` → ⑤ 的新闸必须红；换回 `root.querySelector` 必须绿
⑧ 真机：#stats-list 的 dt/dd 文本 + #stats-note 的 hidden/text 与改前**逐字相同**（打开 / 刷新 / 任务结束三条路径）
```

## 七、复现命令

```bash
# 边界（本文件每个行号）
git show 4676772:backend/book2text/static/app.js | sed -n '2554,2704p'

# 三种扫法
grep -c "statsRow("            backend/book2text/static/app.js   # 7
grep -cE "^\s*statsRow\("      backend/book2text/static/app.js   # 0
grep -wc "statsRow"            backend/book2text/static/app.js   # 7

# 调用点（含值位）
grep -n "loadSummary\|percentText" backend/book2text/static/app.js backend/book2text/static/pages-view.js

# deps 三个 sha 的键数
for sha in b61634d 20049f9 4676772; do
  git show $sha:backend/book2text/static/app.js > /tmp/app-$sha.js
  node -e '
    const fs=require("fs"),sha=process.argv[1];
    const s=fs.readFileSync("/tmp/app-"+sha+".js","utf8").split("\n");
    const a=s.findIndex(l=>l.includes("window.PagesView?.init({"));
    const b=s.findIndex((l,i)=>i>a && /window\.[A-Za-z]+\?\.init\(/.test(l));
    const k=[...s.slice(a,b).join("\n").matchAll(/^\s{4}([A-Za-z_$][\w$]*):/gm)];
    console.log(sha,"deps =",k.length);
  ' $sha
done

# 基线
node scripts/r3_pages_count.mjs --json
node tests/js/run.mjs
PYTHONPATH="$PWD/backend" .venv/bin/python -m pytest -q
python3 scripts/accept_pages.py --stage 2
node tests/js/contract-registry.mjs
python3 scripts/audit_ui_asset_literals.py
```
