# 两个口径互不包含（`r3_pages_count.mjs` vs `accept_pages.py`）

> 2026-10-29 实测定稿。**禁止交叉相减**——两边各按自己的口径报，落盘时各打各的数。

| 口径 | 取法 | 现状总数 | 只搬 11 个 wire 后 |
|---|---|---:|---:|
| 闸 / `r3_pages_count.mjs` | `el(id)` / `getElementById(id)` / `querySelector(All)("#id")` | **193** | **158** |
| `accept_pages.py` | **完整引号字面量**（id 是整个引号字符串） | **198** | **164** |

**差 6 = 总差 5（193 vs 198）+ 组差 1**。差的那 1 处实证：

```
app.js:3271  document.querySelectorAll('#rec-dpi input[type="radio"]')
  → 闸口径算 1 处（rec-dpi）；accept 口径不算（不是完整字面量）
```

**两个集合互不包含**：
- 闸认 `#id` 前缀选择器，accept 不认 → 闸多算；
- accept 对整份 app.js 全量数（**没有 mover 概念**），闸也全量数——差别只在“取法”。

**`cap` 一律用落盘后实测**（`r3_pages_count.mjs --json` 的 `total`）；`158` / `164` 都只作**预估**，
且必须注明是哪个口径的预估。**预估数不许当 cap，也不许互减。**

**历史教训**：曾用 accept 的**组数**（34）去减闸的**总数**（193）得 159，再说“158 不成立”——
**组数与总数相减 = 两个对象一个桶**。
