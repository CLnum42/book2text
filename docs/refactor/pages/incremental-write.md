# 增量落盘：`build_view.py --write` 的刀 1 形态与正确拼法

> **警告**：`build_view.py --write` 目前仍是**刀 1 形态**——它把 `pages-view.js` 整份替换成
> 「IIFE 头 + 本刀函数体 + INTERFACE」（`build_view.py` 里 `module = header + out + INTERFACE`）。
> 从刀 3 起，模块里已经有刀 1/2.5 的 1,511 行，整份替换会**冲掉它们**，而 `node --check` 照样过。
> 另一处：`FORWARDERS` 分支会在 `INIT_ANCHOR`（`  setupLibrary();`）后再插一次
> `window.PagesView?.init({…})`，刀 3 之后就会**出现第二个 init 调用**——语法合法、运行时把 deps 覆盖成半套。

## 一、三段各自往哪去（照这个拼，不要整份替换）

```
① 本刀函数体（生成器产物 /tmp/k3-dry/module.js 里 INTERFACE 之前的那一段）
   → 追加到**现有** pages-view.js 的 `function wireAll() {…}` 之后、`function init(deps)` 之前
   → 不要碰已有的 IIFE 头、`let injected = {}`、`const el = …`、`wireAll`、`init`、`api`
② INTERFACE 里的 `const api = { … }` 新增键
   → **只往现有 api 对象里补 14 个键**（顺序跟在最后一个键后，逗号别漏）
   → 不要整块替换 api：现有 16 个键里有刀 1/2.5 仍在用的
③ init 的 deps 字面量（在 **app.js** 的 `window.PagesView?.init({…})` 里，不在模块里）
   → 把本刀新增的 deps 键插进那个对象的**内部**（`}` 之前），别在 init 之后再拼第二段
```

## 二、判据（拼完立刻能验，都是机检）

```
· 模块里 `function init(` 只出现 1 次；`window.PagesView?.init(` 在 app.js 里只出现 1 次
  （第二个出现 = 踩了刀 1 形态的坑）
· 模块行数 = 旧行数 + 本刀函数体行数（刀 3：1,511 + 470 ≈ 1,981，不是 550）
· `api` 键数 = 16 + 本刀新增（刀 3：16 + 14 = 30）
· deps 键数 = dry run 的 injected_keys（刀 3：46），且 app.js 里 `init({` 内实际列出的键数一致
· residue [] / anti []（生成器 dry run）
· node 闸（不是 node --check）152/0
```

## 三、给生成器加 `--append` 的最小改法（下一刀前做，别在搬函数时顺手改）

```
① 读现有 pages-view.js，定位 `function init(` 起点；新函数体插在它之前
② api 对象按名字合并：新键追加，已存在的键不重复、不改顺序
③ 本刀 movers 里若已有同名函数 → 拒绝写（重名守卫，已有）
④ 干跑时打印「旧行数 + 追加行数 = 新行数」与「api 16 → N」，与 dry run 的 injected_keys 对账
```

**在 `--append` 落地之前：手工拼，按上面三段 + 五条判据。** 别用 `--write`。
