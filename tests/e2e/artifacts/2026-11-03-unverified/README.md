# 2026-11-03 剩余未验项（四组）

**测的树**：`origin/main` = `66bab13`（片 3b 之后）。worktree `/tmp/b2t-wt-unverified`，端口 8871，token `qa4`，
库 `/tmp/b2t-qa4/lib`；`paths.STATIC_DIR = /private/tmp/b2t-wt-unverified/backend/book2text/static`。
项目：`b2t_T7JH61`（490 页真书）+ `b2t_C2MQ9A`（kind=package，任务页 11/12，只读上下文 10/13）。

**结论**：②拆分关闭路径、③导出四选项、④导出正文一致性都通过；①package 只读上下文**没有“跳过”**——
只读在服务端生效，但 review/tree 仍报错、翻页会走进上下文页、只读标签会粘到任务页。

---

## ① package 项目 · 审校抽屉与只读上下文页

| 动作 | 读数 |
|---|---|
| 打开 `b2t_C2MQ9A` | 横幅「审校任务：第 11、12 页（另附只读上下文第 10、13 页）…」；`#structure-open`/`#finish-open-review` hidden |
| 打开抽屉（p.11 任务页） | 图/标题正常；**错误条可见**「审校任务里不能做这个操作 … 只能审校块并导出审校结果」 |
| 同上，网络 | `GET /api/projects/b2t_C2MQ9A/review/tree` → **403**；`review/finish-summary`、`export/preview` 也 403 |
| 抽屉翻页 | p.11 → next → p.12 → next → **p.13（只读上下文页，没跳过）** → prev 回 p.12 |
| p.10（上下文页）改块类型 | `#review-save-state`=「这是只读上下文页」；`PATCH …/blocks/…` → **403**（服务端拒绝，正确）；但下拉框**停在新值**（UI 未回滚，重开抽屉才恢复） |
| p.11（任务页）改块类型 | `PATCH …` → **200** 成功；但标签在从 p.10 跳过来后仍显示「这是只读上下文页」，保存后才变「已保存 ✓」⇒ **只读标签是粘的**（会误导） |

判定：
- 「旧树 review/tree 403 的既有问题」**现在仍是“报错”，没有变成“跳过”**：抽屉每次打开都把 403 送进 `#page-detail-error`。
- 「只读上下文页被正确跳过」**没做到**：翻页不会跳过 10/13；上下文页靠服务端 403 兜底，前端看起来仍可编辑（下拉框不回滚）。
- 只读本身没坏：上下文页 PATCH 403、任务页 PATCH 200。

截图：`package-drawer.jpg`（抽屉 + 错误条）。

## ② 批量拆分面板：三条关闭路径

打开方式：页面视图 → 页面类型 → 拆分书眉页码 → 批量拆分书眉页码…（选 1 页，预览「没有找到需要拆的块（扫了 1 页）」）。

| 路径 | 动作 | `.mask:not([hidden])` | 面板 | 其它 |
|---|---|---|---|---|
| 取消 | `#split-batch-cancel` | 0 | hidden | view 仍 `view-pages`；body overflow 仍 `visible` |
| Esc | `keyboard.press("Escape")` | 0 | hidden | 同上 |
| 点遮罩 | mask 左上 (20,20) 点击（modal 在 455–1015） | 0 | hidden | 同上 |

三条都收干净：无残留 mask、无滚动锁、视图未变。**通过**。

## ③ 导出四选项

| 选项 | 动作 | 读数 |
|---|---|---|
| JSONL | 勾 `jsonl` + `txt` → 导出 | 记录 `20261103-0801_both`：`body.jsonl` **1068 行 / 889,284 B**（`schema=book2text.segment.v1`，字段 `segment_id/seq/type/text`）；`manifest.rules.format="both"`，`files` 含 `body.jsonl` ✓ |
| 仅已确认 | 勾 `#export-confirmed-only` → 导出 | 被拒：「按照当前设置没有任何内容可以导出 …「仅已确认」下没有已确认的块」，错误编号 `3edef48d3b4e`；历史不增 ✓（本项目 1068 段全未审 ⇒ 0 段可导） |
| 页码范围 | `#export-range=4-6` → 导出 | 记录 `20261103-0801_txt`：`body.txt` **24 段**；`manifest.rules.page_numbers=[4,5,6]`、`scope.pages=3` ✓ |
| 注释勾选 | 勾 `#export-include-notes` → 导出 | `rules.include_notes=true`；产物多出 `notes.txt`（**0 B**，因为库里 `comment` 非空的块 = **0**）⇒ 选项接通，**内容差异缺样本** |

截图：`export.jpg`（导出面板选项）。

## ④ 导出正文 vs 审校文本（抽 50 段）

用 `20261103-0801_both/body.jsonl` 的前 50 段，按 `segment_id` 到 `pages/{4..11}/blocks` 找对应块：

```
jsonl 段数          1068
抽样                50
能在块里找到        50 / 50
逐字相等            29 / 50
去空白后相等        48 / 50
去空白仍不同        2  （都是断字合词）
```

两处差异（预期行为，导出规则 `export-rule-hyphen` 合并行尾断词）：

| seq | 页 | 导出文本 | 审校文本 |
|---|---|---|---|
| 1 | 4 | `…Chinese at Oxford.Subsequently he was made…` | `…Chinese at Oxford.Subse-quently he was made…` |
| 6 | 4 | `…dissertation on the translation of The Story…` | `…dissertation on the transla-tion of The Story…` |

结论：抽检范围内导出正文与审校看到的文本一致，差异全部可归因到导出规则。**通过**。

## 未验 / 缺样本

- **注释样本**：库里 `comment` 非空的块 = 0，`notes.txt` 内容（格式、位置）未验，只证明了选项接通与文件生成。
- **仅已确认的“有内容”分支**：需要已审块（本项目 0 段已审），只验了空结果保护。
- **package 只读上下文“跳过”语义**：产品口径未定（翻页是否应跳过 10/13、只读标签是否应清零），等 DevLead 定。
- 片 5–9 的五块面板验收未跑（等切片全部落完，另建 `2026-11-03-batch-5-9/`）。
