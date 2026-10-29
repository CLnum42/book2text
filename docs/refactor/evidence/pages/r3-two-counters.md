# R3 有两个计数器：闸 / 豁免表 与 `accept_pages.py`

> **本表的所有上限只有一个来源：落盘后跑 `node scripts/r3_pages_count.mjs --json`，取它的 `total`。**
> 落盘前任何人给的数（157 / 158 / 164 …）一律标「预估，不作 cap」。
> 谁再问「cap 应该是多少」，答案只有一个：**跑脚本**。不许从 193 / 198 减出来。

写这一页的直接原因（2026-10-29）：同一个「落盘后 R3 应剩多少」，三个人给出三个数
（158 / 164 / 157），而其中两个数**路径不同、结果相同**——这正是「两个对象一个桶」的经典形态。
一旦有人照着错的那个继续减，收尾时必然打架。

---

## 1. 两个计数器的形态不同

| | 闸 / 豁免表（`tests/js/boundary.test.mjs` 的 R3、`scripts/r3_pages_count.mjs`） | `accept_pages.py`（`id_literal_count`） |
|---|---|---|
| 数什么 | 三种取法：`el("…")` / `getElementById("…")` / `querySelector(All)("#…")` | **完整引号字面量**：`"id"` 或 `'id'` |
| 带后缀的选择器 | **数到**（取 `#` 后面那段 id） | **数不到**（整个引号串不是纯 id） |
| 纯字符串比较/事件名等 | **数不到**（不是三种取法之一） | **数到**（只要它是完整引号字面量） |
| 是否区分「已搬走的函数」 | 否（全量数 `app.js`） | 否（同上） |
| 代码位置 | `scripts/r3_pages_count.mjs`（口径写死在脚本里） | `scripts/accept_pages.py:289 id_literal_count()` |

两者**互不包含**（不是谁更宽）：

```
accept 有、闸没有 → group("panel-page-settings", pageStep) 这类"把 id 当参数传"的地方
闸有、accept 没有 → document.querySelectorAll('#rec-dpi input[type="radio"]') 这类带后缀的选择器
```

## 2. 互不包含的实证（真树，`main@48210fa`，`app.js` 14,496 行）

**① 闸数到、accept 数不到**

```
app.js:3271
  for (const radio of document.querySelectorAll('#rec-dpi input[type="radio"]')) {
                     ↑ 闸口径算 1 处（id = rec-dpi）· accept 口径 0 处（引号串不是纯 id）
```

**② accept 数到、闸数不到**

```
app.js:573–578（renderStepPanels 里把 id 当参数传给 group()）
  group("panel-page-settings", pageStep);
  group("panel-layout-blocks", pageStep);
  group("panel-pagenum-settings", pageStep);
  group("panel-margin-settings", marginStep);
  group("panel-recognition-status", recognitionStep);
  group("panel-recognition-settings", recognitionStep);
  → accept 口径各算 1 处 · 闸口径 0 处（都不是 el / getElementById / querySelector#）
```

所以：**两套数只能各自与自己的上一版比（自己比自己），绝不能相减、也不能互换着用。**

## 3. 对照表（工作区树，刀 2.5 落盘前的预估）

| 口径 | 现值 | 11 个 `wirePages*` 函数持有 | 只搬 11 个 wire | 再加 PageTile 3 个函数 |
|---|---:|---:|---:|---:|
| 闸 / `r3_pages_count.mjs` | 193 | **35** | **158** | 157 |
| `accept_pages.py` | 198 | **34** | **164** | 163 |

两口径差 6 = 总差 5（193 vs 198）+ 组差 1（就是上面 `#rec-dpi input…` 那一处）。
三个数字的来源各不相同：

```
158 = 193 − 35（闸总 − 闸口径下 11 个 wire 持有的处数）        ← 只减 wire
158 = 193 − 34 − 1（闸总 − 字面量口径的 wire 数 − PageTile）   ← 减 wire + PageTile，也得上 158
164 = 198 − 34（accept 总 − 字面量口径下 11 个 wire 持有的处数）
157 = 193 − 36（闸总 − (wire 35 + PageTile 1)）
```

**同一个 158 有两条路径**：一条减的是"闸口径 35"，另一条减的是"字面量 34 + PageTile 1"。
结果相同纯属巧合——**只要换一批 mover，两条路径就会分叉。** 这就是不准交叉相减的原因。

## 4. 硬规矩（判据）

```
① cap 的唯一来源：落盘后 `node scripts/r3_pages_count.mjs --json` 的 `total`。
   写进 pages-r3-exemptions.mjs 的 PAGES_R3_TOTAL_CAP 的值必须等于它（逐字相等，不是"接近"）。
② accept_pages 的数只服务它自己的判据（它打印的「view-pages 字面量 N 处」），
   不进豁免表、不当 cap、不与闸口径相减。
③ 预估数只用于"对差"：落盘后实测与预估差 >10 → 停，先查是不是 mover 名单变了；
   ≤10 的差不改 mover 名单，直接以实测为准。
④ 报数时**必须带口径**：「闸口径 X 处 / accept 口径 Y 处」，只说"R3 剩 N 处"属于无口径数字。
```

## 5. 复现命令

```sh
# 闸口径（cap 的唯一来源）
node scripts/r3_pages_count.mjs --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["total"], d["ids"], d["appLines"])'

# accept 口径（只用于它自己的判据）
.venv/bin/python scripts/accept_pages.py --stage 1 --movers docs/refactor/evidence/pages/stage1-movers.json \
  --expect-sha "$(shasum -a 256 docs/refactor/evidence/pages/stage1-movers.json | awk '{print $1}')"
```
