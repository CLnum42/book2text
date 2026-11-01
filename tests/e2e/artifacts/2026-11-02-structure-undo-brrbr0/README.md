# 2026-11-02 ⑨ 复核（Builder 的 380/372/8 —— 在它那本项目上，副本运行）

项目 `b2t_BRRBR0`（267 页，1780 块，全部 paragraph）。原库 `~/DeepSeek Bot/tmp-lib`，
`cp -a` 到 `/tmp/b2t-qa9b/lib`，独立服务 `--library /tmp/b2t-qa9b/lib --port 8874 --token qa9b`。
**原库只读**：跑完原件与副件的块类型都是 `paragraph 1780`（逐项相同）。

预览参数（Builder 提供）：`{"top_ratio":0.08,"bottom_ratio":0.08,"left_ratio":0.1,"right_ratio":0.1,"max_chars":20,"page_types":["body"],"detect_page_numbers":true}`，
应用范围：只 high（review 级 8 个不勾）。

## 四步实测

| 步骤 | 读数 |
|---|---|
| 基线块类型 | 1780 块全部 paragraph |
| ① 预览（应用前）N0 | **380**（header 235 / footer 2 / page_number 143；high 372 / review 8） |
| ② 应用（只 high） | changed **372**（header 229 / page_number 143），241 页，撤销栈 undo=1 |
| ② 应用后立刻再预览 N1 | **8**（header 6 / footer 2；high 0 / review 8） ← **Builder 那个 8** |
| ③ 撤销 | `direction=undo`、changed_blocks **372**，撤销栈 undo=0 / redo=1 |
| ③ 撤销后再预览 N2 | **380**（header 235 / footer 2 / page_number 143，与 N0 逐项相同） |
| ④ 逐块对基线 | applied 372 → **restored 372 / not_restored 0**（missing 0） |

## 结论

**Builder 的「撤销后只剩 8」是把"应用态"当成了"撤销后"的读数**：

```
380（应用前） − 372（被应用的 high） = 8（没勾的 review 级）
应用后这 372 块变成 header/page_number，就不再是候选 → 再预览只剩 8
撤销完整（372/372 回到 paragraph）→ 再预览回到 380，by_type 三项与 N0 完全一致
```

所以：**撤销本身没有问题**（与本项目 b2t_T7JH61 副本的 112/112 结论一致）；
`8` 是「应用后、撤销前」的正常读数，不是缺陷。它那次 headless 扫全页按钮、只 sleep 2500ms 就读，
大概率没点中撤销或没等状态落地——这条属**测试方法问题**，不是产品缺陷。

## 文件

- `result.json` — 全量读数：baseline / N0 / apply / N1 / undo（含 241 页清单）/ N2 / compare（372 逐 id 对基线）/ verdict

## 复现

```bash
rm -rf /tmp/b2t-qa9b && mkdir -p /tmp/b2t-qa9b
cp -a "/Users/chenlin/DeepSeek Bot/tmp-lib" /tmp/b2t-qa9b/lib
cd "/Users/chenlin/DeepSeek Bot/book2text"
(PYTHONPATH="$PWD/backend" .venv/bin/book2text --library /tmp/b2t-qa9b/lib --port 8874 --no-browser --token qa9b &)
# 四步：preview → apply(high) → preview（应得 8）→ undo → preview（应回到 380）
curl -s -X POST "http://127.0.0.1:8874/api/projects/b2t_BRRBR0/structure/header-footer/preview?token=qa9b" \
  -H 'Content-Type: application/json' \
  -d '{"top_ratio":0.08,"bottom_ratio":0.08,"left_ratio":0.1,"right_ratio":0.1,"max_chars":20,"page_types":["body"],"detect_page_numbers":true}'
```
