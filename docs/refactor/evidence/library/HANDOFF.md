# `library` 切片交接（2026-10-29，DevLead）

**状态**：生成器已跑通并全绿，**只剩落盘前的两处接线**。`/tmp` 的两个产物是可用的，不是半成品。

> **2026-10-29 裁定 B（Chief）改了下文三处**：① 接口是 **4 个**导出（`init/enter/notify/open`），
> 不是 3 个；② `showLockConflict` + 4 个 lock 文案**留外壳**，所以搬 12 个 / 311 行，不是 17 / 371；
> ③ `createProjectFromFile` 的上传接线搬进模块 `init`，外壳不再调它。落地记录见
> [`../../../library-slice.md`](../../../library-slice.md) §11。

## 1. 剩下的两步

### ① `boot` 里的 `LibraryView.init(deps)` 字面量（38 键）

- 位置：`app.js` 的 `boot()` 内，插在 `window.PreviewView?.init({` **之前**（与 `IndexView.init` 同一位置）。
- 键从哪来：**`rules.py` 的 `IDENT` 列表**（`("xxx", "injected.yyy")` 第二段就是键名）。
  再加上 `build.py` 运行时从模块正文抽的 `injected\.([A-Za-z_$][\w$]*)`——**两者应一致，不一致以运行时抽取为准**。
- 生成规则：
  - `getXxx()` / `getXxx` → `getXxx: () => xxx`（`xxx` 是 `app.js` 里的同名状态）
  - `setXxx(v)` → `setXxx: (v) => { xxx = v; return v; }`
  - 纯函数 `fn` → `fn: (...args) => fn(...args)`
  - `navigate` → `navigate: (name) => showView(name)`
  - `projectId` → `projectId: projectId()`（它是函数）
- **不写这步的后果**：页面一打开就 `injected.apiJson is not a function`——静态门全绿、页面直接崩。

### ② 三张登记表（`tests/js/boundary.test.mjs`）

| 表 | 加什么 |
|---|---|
| `OWNERS` | `libraryProjects` / `lockConflictTarget` 等模块顶层状态 → `library-view.js` |
| `VIEW_STATE_PREFIXES` | `"library-view.js": /^(library\|LIBRARY_)/`（注意 `lockConflictTarget` 不带前缀，要单独一条） |
| `VIEW_EXPORTS` | `"library-view.js": { names: ["init", "enter", "notify"] }` |

**只能动这三块**（`move:` 笔类判据，块边界从源码派生）。

## 2. `/tmp/b2t-library/` 里现在有什么

| 文件 | 状态 |
|---|---|
| `app.js` | **可用**：16,162 → 15,765（净减 397），`node --check` 过，6 个 id 字面量归零 |
| `library-view.js` | **可用**：434 行，`node --check` 过，`Object.keys === ["init","enter","notify"]` |

**但两者都缺第 1 节的①**（deps 未接）——**当前这版不能直接用**，必须补 deps 后重跑 `build2.py`。

产物由两条命令生成（可重跑，幂等）：

```bash
python3 docs/refactor/evidence/library/build.py    # 只为自检，不落盘
python3 docs/refactor/evidence/library/build2.py   # 生成 /tmp 的两个文件（写仓库要加 --write，尚未接）
```

## 3. 脚本抓到的 6 个坑（**每条都附"怎么被发现的"**）

| # | 坑 | 怎么被发现的 |
|---|---|---|
| ① | 状态写点整句替换少一个右括号：`injected.setLockConflictTarget({…};` | `node --check` 报 `missing ) after argument list` |
| ② | 占位循环把字面量 `\g<0>` 写进了源码 | `node --check` 报 `Invalid or unexpected token` |
| ③ | `project_id` 被替换成 `injected.projectId` → `{ injected.projectId: … }` | `node --check` 报 `Unexpected token '.'` |
| ④ | `currentProjectName` 的自映射把**函数声明**也改了 → `function injected.currentProjectName(` | `node --check` 报 `Identifier 'injected' has already been declared` |
| ⑤ | `showError(el("package-result-files") \|\| el("library-error"), error)` 正则只认 `\w+` → 漏 2 处字面量 | **"残留 id 字面量 = 0"自检**报 `{'library-error': 2}` |
| ⑥ | `loadLibrary` 只做了转发、正文没搬进模块 → `enter()` 会是空实现 | 上一条修完后**重新推到 `--check` 才发现模块里没有 `loadLibrary` 函数体** |

**⑥ 最贵**：落盘后页面不报错、不崩，只是"目录页永远空着"，**而所有静态门全绿**。
**⑤⑥ 都是"按 id 集合归零"抓到的**，按清单改齐抓不到。

## 4. 38 个 `injected.*` 键从哪读

```
docs/refactor/evidence/library/rules.py → IDENT（57 条，第二段是注入键）
`build.py` 运行时另抽：re.findall(r"injected\.([A-Za-z_$][\w$]*)", code)  → 38 键
```

**两者不一致时，以运行时抽取的 38 键为准**（`IDENT` 里含"搬走函数"和"常量"两类，后者不进 deps）。

## 5. 落盘判据（脚本里写死，四条全过才 `--write`）

```
模块生成成功 ∧ app.js 改写成功 ∧ node --check 两个文件都过 ∧ 残余接缝 = 0
```

落盘后**立刻**跑 `python3 scripts/accept_library.py`（TestDev 写的，三态 2/1/0），**exit 0 才算这一刀成立**。
