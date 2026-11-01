# 2026-11-02 ⑨ 结构工具「应用 → 撤销 → 再预览」验收（副本上跑，不碰 b2t_T7JH61）

来源：Builder 刀 D 实跑观察（应用 372 块后撤销，抽查第 3 页 24/24 回到 paragraph，但撤销后再预览候选只剩 8 个）。
任务：判「这 8 个是不是应用前本来就不是 paragraph 的块」——即撤销是"回到原类型"还是"只回了一部分"。

**做法（Chief 指定）**：把库整份复制到 `/tmp/b2t-qa9/lib`，独立服务 `--port 8873 --token qa9`，
全流程只在副本上做；`b2t_T7JH61` 原件块类型不动，①–⑧（尤其 ③ 类型色）不受影响。

## 判据（比 Builder 的抽样更硬：集合对集合）

```
0) 基线：从副本 project.db 读 block_id → block_type（全部块，未删除）
1) POST /structure/header-footer/preview  → 候选数、by_type、high 数
2) POST /structure/header-footer/apply    → 只应用 confidence=high（与 UI 默认一致）
3) POST /review/undo（撤销栈，按 batch）
4) 应用过的 block_id **逐个**对基线：回到原类型 N 个 / 未回到 M 个（M>0 给清单）
5) 再 preview：候选数应与"应用前"一致；若明显变少 ⇒ 说明大部分块没被撤销回 paragraph
```

## 实测

```
基线：1233 块（未删除），全部 paragraph
预览：pages_scanned 487，候选 121（page_number 45 / header 75 / footer 1），其中 high 112
应用：changed 112（page_number 45 / header 67），涉及 88 页，撤销栈 undo=1
撤销：112 / 112 **全部回到基线类型**，未回到 0（missing 0 / wrong_type 0）
再预览：候选 121（page_number 45 / header 75 / footer 1）—— 与"应用前"逐项相同
```

**结论（本副本项目）**：撤销是完整的，不存在"只回一部分"；撤销后再预览等于应用前。

## 一条口径纠正（重要，写进结论免得后人误判）

结构工具的候选**本来就是**「当前是 paragraph、按位置/文本像页眉页脚页码」的块。
所以撤销完整时，这些块回到 paragraph，**同样的候选会原样重新出现（121 → 121）**。
反过来说：如果撤销后候选明显变少（Builder 的 8 vs 380），那是"被应用过的块没被撤销回 paragraph"
的间接信号——用第 4 步的逐个对基线就能直接定性，不必靠候选数猜。

**本副本复现不出 Builder 那组数字**（本项目候选 121/high 112，不是 380/372/8）——那应是另一本项目的数据；
要在他那本项目上按同一判法（基线 → 应用 → 撤销 → 逐个对基线）再跑一次才能定性。副本做法见上，
`b2t_T7JH61` 不要动。

## 文件

- `result.json` — 全量原始读数（baseline / preview_before / apply_result / undo_result / after_undo_compare / preview_after / verdict_corrected）

## 复现

```bash
rm -rf /tmp/b2t-qa9 && mkdir -p /tmp/b2t-qa9
cp -a /tmp/b2t-qa4/lib /tmp/b2t-qa9/lib
cd "/Users/chenlin/DeepSeek Bot/book2text"
(PYTHONPATH="$PWD/backend" .venv/bin/book2text --library /tmp/b2t-qa9/lib --port 8873 --no-browser --token qa9 &)
# 然后用 result.json 里的四步接口跑：preview → apply(high) → review/undo → preview
# 单条 curl 示例：
curl -s -X POST "http://127.0.0.1:8873/api/projects/b2t_T7JH61/structure/header-footer/preview?token=qa9" \
  -H 'Content-Type: application/json' \
  -d '{"top_ratio":0.08,"bottom_ratio":0.08,"left_ratio":0.10,"right_ratio":0.10,"max_chars":20,"page_types":["body"],"detect_page_numbers":true}'
```
