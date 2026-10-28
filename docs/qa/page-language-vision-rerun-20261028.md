# 按页语言 + Vision 重跑第二引擎（任务 64）

> 2026-10-28。用户拍板：**以后一律用第二引擎（Apple Vision），不用文字层。**
> 验收全在 `b2t_GYM9VE` 的**副本**上做（`/tmp/b2t-idx/lib`），真书库没碰。

## 1. 按页语言

- `core/ocr/language.py`：只看**主引擎识别出的正文**里的汉字数与拉丁字母数；
  拉丁 ≥90% → `en-US`，汉字 ≥90% → `zh-Hans`，中间 → `mixed`；不足 12 个字母判不出来（返回 None）。
- 结果**落到 `page.ocr_language`**（迁移 0022），判定后不再每次现算；界面可单页覆盖
  （`PATCH /pages` 的 `ocr_language`，`auto` = 交回自动判定）。
- `run_auxiliary` 以前给行图传的是 `OcrParams(dpi=0)`——**项目语言根本到不了 Vision**，
  所以英文页也开着中文模型。现在按页传语言，并写进 run 参数。

副本实测（前 60 页，其中 34 页是没识别的前置页）：

```
p35 body → zh-Hans (cjk 489 / latin 0)
p36 body → en-US   (cjk 0 / latin 2119)
p37 body → zh-Hans (cjk 657 / latin 2)
前 60 页：None 34（前置页没识别）· zh-Hans 13 · en-US 13
全书：英文页 218（与用户说的"中文 218 / 英文 218"一致）
```

## 2. 不再用文字层当 aux

- 生产路径（批量复核 / 单页复核）改成 `prefer_text_layer=False`；
  代码保留并注明：实测英文 F1 0.948（Vision(en) 0.979），且文字层的错与 Vision 中文模式同源。
- 界面文案改成「第二引擎（Vision）的语言按页判定」。

## 3. 重跑第二引擎（20 个英文页实测）

接口：`POST /projects/{id}/aux/rerun`（**先备份** → 建 `scope=all, skip_checked=False` 的复核任务，
引擎 Vision、语言 auto）+ `GET /projects/{id}/aux/languages`（每页语言分布）。
已裁决且文本没变的行由 `run_auxiliary` 跳过，不覆盖。

样本：英文页 76–114（步长 2，共 20 页，833 行）。

| 指标 | 重跑前（文字层 aux） | 重跑后（Vision en-US） |
|---|---:|---:|
| 差异行 | **409** | **162**（−60%） |
| 撇号 `'` | 549 | **756** |
| 孤立的 `1`（把 I 认成 1） | 7 | **1** |
| 小写 `i`（把 I 认成 i） | 0 | 1 |

另一组 20 页（36–74）：撇号 577 → **793**，孤立 `1` 7 → **1**。

**耗时：2.7–2.9 s/页**（Vision，行图逐行）；全书 490 页约 **22 分钟**。

**字节对账**：重跑前后对 `block.text / block_type / bbox`、`page.margin_box`、
`block_line.diff_ack / diff_ack_text` 取 SHA-256 → **前后一致**（`f5ab4998cce22e9b`）。
中文页没有参与重跑（只挑了英文页），所以不受影响。

## 4. 没做的

- **全书 490 页没跑**（22 分钟；需要用户点界面上的「重跑第二引擎（Vision）…」，任务可暂停/继续）。
  真书库要先备份——接口里已经做了，但真库的这次跑要用户自己点。
- 「撤销」目前只有**备份文件**这一层（`backups/project-before-…`）；一键"恢复备份"的接口还没做，
  因为恢复要求没有写入方（应用得先关项目）。下一步补一个带确认的恢复入口。
- 界面还没显示"按 en-US 跑了 218 页、zh-Hans 跑了 218 页"这句汇总（`/aux/languages` 已就绪，
  识别完可以接上）。

## 测试

- 语言判定（zh/en/mixed/太短）；页面语言落库；rerun 先备份且引擎是 `apple_vision`；
  语言汇总接口。`pytest` 见下。
