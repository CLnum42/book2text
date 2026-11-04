# Jev 排序验收：产品路径对账（2026-11-05）

**评估人：** OCREval
**主线：** `1cfe51d`（选行对齐 250）+ `50b080d`（可配置）
**项目：** `b2t_H6GXVG` 的**副本**（`/tmp/ocrev/lib/b2t_H6GXVG`，真库未动）
**模型/服务：** `/tmp/ocrev/jev`（Q8_0 + mmproj，llama.cpp 0.8.0 Metal）+ Jev SDK 打分服务 18501
**样本：** 40 页 / 队列 250 行 / 金标准 20060 字

## ① 产品路径跑通

```
--check  → ✔ 环境齐：打分服务 / llama.cpp / 模型文件 / 字体都在
--run    → 结果：succeeded；有分数的行 250 / 分歧行 0
--dump-out → /tmp/jev-orders-250.json（250 行）
```

**产品路径耗时：250 行共 3 分 12 秒（192 s，0.77 s/行，Metal）。**
对照实验脚本 0.674 s/行——产品路径多约 14%，是任务框架与落库开销。

> 注意：`dump_orders` 默认**排除已裁决行**。项目副本里原有 186 行已裁决，
> 第一次 dump 只出 64 行；清掉 `diff_ack` 后才得到 250 行。这与 Builder 说的
> "queue_lines = queue_items 的 total"不符——**实际是 unacked**，建议在契约里写清。

## ② 分数对账（本步重点）

产品路径的 `block_line.jev_score` 与实验脚本的分数，逐行比 250 行：

| 指标 | 结果 |
|---|---|
| 交集行数 | 250 |
| 完全逐位相同 | 0 行 |
| **最大绝对差** | **0.000565** |
| 平均绝对差 | 0.000020 |
| 差 >0.001 的行 | **0 行** |
| **按分数升序的前 50 行集合** | **50/50 完全相同** |
| **Spearman 秩相关** | **0.999995** |

**判：同源。** 差异在 6e-4 以内、排序完全一致，来源是两条路的渲染器不同
（产品走自己的渲染，实验走 PIL + Songti），不是裁剪坐标不一致。
残留差异不影响任何阈值判断（最近的可疑线是 0.05）。

## ③ 命中率（250 行口径）

| 排序 | 前 25 | 前 50 | 前 100 |
|---|---:|---:|---:|
| **基线（正文流原序，25.2%）** | — | — | — |
| **产品路径 `jev_sorted`（档位排序）** | **76.0%** | **68.0%** | 41.0% |
| 纯分数升序（同批分数重排） | 80.0% | **76.0%** | 50.0% |

- 基线精确率 **25.2%**（250 行里 63 条真错；产品自己的 `is_error` 判据给 25.6%，两者 98.8% 一致）。
- **产品路径前 50 = 68.0%，比基线 +42.8 个百分点**，判据是 +10。
- **但档位排序比纯分数排序低 8 个百分点**：`tier_key` 先把 ≤0.05 的行放第一档（43 行），
  档内按页码→块序→行序排，所以前 50 里混进了 7 行非可疑档。纯分数排的话前 50 是 76%。
  这是设计取舍（档内按文流），不是错误；但如果目标是"前 50 命中率最高"，改成档内按分数排能多 8 个点。

## ④ 边界（不许当一般水平引用）

- **单本书、单次测量**：这是《红楼梦》40 页、250 行。换书（如《鹿鼎记》英文版）可能完全不同。
- `is_error` 默认是 `normalized_substring` 代理判据，与人工 GT 逐行对齐 98.8% 一致（250 行里差 3 行）。
- 队列里**只有 1 条结构级错**（漏行/书眉/图注不进差异队列），所以本验收**不能**证明 Jev 对结构级问题有用。
- 未测：Windows；换书；已裁决行是否会被再次排序（本轮清空 ack 才得到 250 行）。

## ⑤ 复算命令

```bash
# 引擎 + 打分服务
llama-server -m /tmp/ocrev/jev/MiniCPM-OCR-Jev-Q8_0.gguf \
  --mmproj /tmp/ocrev/jev/mmproj-model-f16.gguf -ngl 99 -c 32768 --port 18499
cd /tmp/ocrev/MiniCPM-OCR/scripts/minicpm-ocr-jev && \
  JEV_BACKEND_CONFIG=sdk/backends/llamacpp.yaml PATH=/tmp/ocrev/jev-venv/bin:$PATH \
  bash sdk/start_score.sh 18501 http://127.0.0.1:18499

# 验收（产品路径）
cd book2text && PYTHONPATH=backend .venv/bin/python scripts/accept_jev.py --check \
  --project /tmp/ocrev/lib/b2t_H6GXVG --model-dir /tmp/ocrev/jev \
  --engine-url http://127.0.0.1:18499 --score-url http://127.0.0.1:18501 \
  --font /System/Library/Fonts/Supplemental/Songti.ttc
# --run 同上再加 --dump-out /tmp/jev-orders-250.json --gold <金标准>
```
