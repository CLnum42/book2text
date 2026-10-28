# 跨页条目实测（YV1P2Y《红楼梦》中文书 394 页）

> 2026-10-28。**只读实测**：没改产品代码、没碰前端、没动真书库；三份可写副本在 `/tmp/b2t-crosspage/`。
> 所有数字由产品自己的函数现算，没有另写一套段规则。

## 口径（D-105 / D-106）

- **正文流**只有一个定义：`core/export/segments.py::build_segments`，唯一调用路径
  `core/export/project.py::preview_segments_json`；"流内"只认 `segments[].line_spans` 的 `(block_id, line_index)`。
- **差异项所在页** = `mark.page_no`（`core/project/reading_marks.py::marks_data` 的 `items[]`，它是**块的页**）。
- 段记录字段：`pages[]`、`line_spans[]`（每条带 `page_no` / `block_id` / `line_index` / `start` / `end`）。

## 副本（三份都算，不是只挑一个）

| 副本 | 来源 | `continues_to_next` | 段数 | 跨页段 | 跨页涉及页数 |
|---|---|---:|---:|---:|---:|
| **c1** | 真书库 `~/Documents/Book2Text/b2t_YV1P2Y` 新拷 | 315 | 1145 | **312** | 385 |
| c2 | `/tmp/b2t-punct/lib/b2t_YV1P2Y` | 315 | 1145 | **312** | 385 |
| c3 | `/tmp/b2t-final/b2t_YV1P2Y` | 315 | 1145 | **312** | 385 |

三份**结构完全一致**：段 1145、跨页段 312、2 页段 309 + 3 页段 3（28–29–30、218–219–220、370–371–372）、跨 385 页。
marks 条数不同（1623 / 1320 / 1666）是副本识别/复核状态不同（c2 的标点级差异少 303 条，c3 有 4 条已 ack），不是结构差异。

## 一、规模（c1）

| 项 | 数 |
|---|---:|
| 跨页段（`len(segment.pages) ≥ 2`） | **312**（占全部段 1145 的 27.2%） |
| 跨页段涉及的页 | **385 / 394** |
| 有 marks 的跨页段 | 253 / 312 |
| 落在跨页段里的 marks | **667 / 1623**（41.1%） |
| 不在任何段里的 marks | **0**（全部 marks 都能在 `line_spans` 里找到） |

按所在页在段里的位置拆（667 条）：

| 位置 | 条数 | 占跨页段 marks |
|---|---:|---:|
| 段的第一页（`pages[0]`） | 322 | 48.3% |
| 段的最后一页（`pages[-1]`） | 330 | 49.5% |
| 段的中间页（只有 3 页段会出现） | **15** | 2.2% |

## 二、页码口径冲突（"顶部页码该显示哪页"）

| 判据 | 不一致条数（c1） | 占比 |
|---|---:|---:|
| `mark.page_no ≠ segment.pages[0]` | **345 / 667** | **51.7%** |
| `mark.page_no ≠ segment.pages[-1]` | **337 / 667** | **50.5%** |
| 用 `mark.page_no`（D-105） | **0** | 0% |

- 结论：**顶部页码只能用 `mark.page_no`**。若用段首页，跨页段里**一半以上**的差异项会显示上一页的页码；
  用段末页也有一半。用 `mark.page_no` 是 0 冲突。
- 3 页段（3 个）里，中间页的 15 条无论取 `pages[0]` 还是 `pages[-1]` 都差 1–2 页。

## 三、行级归属：**0 条不一致**

对 667 条跨页段 marks，把它 `(block_id, line_index)` 对应的 `line_span.page_no` 与 `mark.page_no` 比：

| 判据 | 不一致 |
|---|---:|
| `line_span.page_no ≠ mark.page_no` | **0 / 667** |

**为什么结构性为 0**：`block` 是**单页**的（`block.page_id`），跨页段只是把"不同页的块"串进同一个 segment，
行永远跟着自己的块。所以"同一行被算到另一页"这件事在当前数据模型里不可能发生。

⚠️ 这条只在"块不跨页"的前提下成立：如果以后允许一个块自己跨页（或允许 `line_spans` 由别处生成），
这个数会立刻变成非 0，届时需要重新测。

## 四、写回风险：**0**

`submit-drafts` 按 `(block_id, line_index)` 改文本，所以查的是"同一行会不会被写两次"：

| 检查 | 结果 |
|---|---:|
| 同一个 `(block_id, line_index)` 出现在 2 个以上 segment | **0** |
| 同一个 `(block_id, line_index)` 在同一 segment 里出现 2 次 | **0** |
| 同一个 `block_id` 的行被拆到 2 个以上 segment | **0** |

三份副本全部为 0。**没有数据损坏风险，也没有"同一行出现两次"。**

（顺带：段是"整块"合并的，一个块的 `line_spans` 只会整段落在一个 segment 里，这是 0 的结构原因。）

## 五、样例（c1 原始值）

| page_no | block_id | line_index | segment.pages | line_span.page_no | 位置 | 说明 |
|---:|---|---:|---|---:|---|---|
| 2 | `01M5W02NRGYHM95JWA22N0AJJS` | 1 | [2, 3] | 2 | first | 段首页与 mark 页一致 |
| 2 | `01M5W02NRGYHM95JWA22N0AJJA` | 9 | [1, 2] | 2 | **last** | `pages[0]=1`，按段首页显示会错成第 1 页 |
| 5 | `01M5W0302Z1VR46WW2K21VQPBZ` | 0 | [4, 5] | 5 | **last** | 同上 |
| 8 | `01M5W03B7NEW2AHCMFS2ZHXFGJ` | 0 | [7, 8] | 8 | **last** | 同上 |
| 29 | `01M5W05RHYT2EFFEHWZXQNJSWF` | 20 | [28, 29, 30] | 29 | **middle** | 3 页段中间页，取首页/末页都差 1–2 页 |
| 29 | `01M5W05RHYT2EFFEHWZXQNJSWF` | 24 | [28, 29, 30] | 29 | **middle** | 同一段，标点级差异 |

每条的 `line_span.page_no` 都等于 `page_no`（第三节的 0 就是这个意思）。

## 六、建议

1. **顶部页码固定用 `mark.page_no`**（已经是 D-105 的口径，实测 0 冲突）；不要为了"段"去取
   `segment.pages[0]`——跨页段里 51.7% 的差异项会显示错页。
2. 段级视图如果要显示页码范围，用 `pages[0]–pages[-1]` 展示（如"第 1–2 页"），但**当前项页码仍取 `mark.page_no`**。
3. **跨页写回不需要额外防护**：0 重复键、0 块被拆段；现有 `(block_id, line_index)` 写回是安全的。
   唯一要守的是"一个块不许拆到两个段"这条不变量，建议加一条回归测试（现在 3 份副本都是 0，正好当基线）。
4. 3 页段只有 3 个、中间页 marks 15 条，占比 2.2%，不需要为它做特例；但如果 UI 用段首页做锚点，这 15 条会是"看起来页码不对"的来源。

## 复现命令

```bash
# 0) 三份可写副本（真书库只读，先把 project.db* + source/ 拷到可写目录）
ROOT=/tmp/b2t-crosspage; PID=b2t_YV1P2Y
mk() { mkdir -p "$ROOT/$1/$PID"; cp "$2/project.db" "$ROOT/$1/$PID/";
       cp "$2/project.db-wal" "$2/project.db-shm" "$ROOT/$1/$PID/" 2>/dev/null || true;
       mkdir -p "$ROOT/$1/$PID/source"; cp "$2/source/"* "$ROOT/$1/$PID/source/" 2>/dev/null || true; }
mk c1 "$HOME/Documents/Book2Text/b2t_YV1P2Y"
mk c2 /tmp/b2t-punct/lib/b2t_YV1P2Y
mk c3 /tmp/b2t-final/b2t_YV1P2Y

# 1) 规模 + 口径冲突 + 行级归属 + 写回风险
cd "/Users/chenlin/DeepSeek Bot/book2text"
.venv/bin/python /tmp/b2t-crosspage/analyze.py     # 输出 stats.json

# 2) 按页位置分类的样例
.venv/bin/python /tmp/b2t-crosspage/samples2.py
```

脚本里的两次调用就是产品路径，没有替代实现：

```python
segs  = json.loads(export_project.preview_segments_json(PID, library=lib, options=ExportOptions()))["segments"]
items = marks_module.marks_data(PID, library=lib)["items"]
```

## 附：三份副本的对照（同一张表）

| 项 | c1 | c2 | c3 |
|---|---:|---:|---:|
| 段数 / 跨页段 | 1145 / 312 | 1145 / 312 | 1145 / 312 |
| 跨页涉及页 | 385 | 385 | 385 |
| marks 总数 | 1623 | 1320 | 1666 |
| 跨页段 marks | 667 | 530 | 675 |
| first / last / middle | 322 / 330 / 15 | 256 / 260 / 14 | 319 / 339 / 17 |
| `≠ pages[0]` | 345 | 274 | 356 |
| `≠ pages[-1]` | 337 | 270 | 336 |
| `line_span.page_no ≠ mark.page_no` | 0 | 0 | 0 |
| 重复 `(block_id,line_index)` | 0 | 0 | 0 |
| 块被拆到多段 | 0 | 0 | 0 |

---

# 英文书对照：《安乐哲 译本处理》（662 页，数字原生 PDF）

同一套口径（D-105 / D-106）、同一批脚本，副本在 `/tmp/b2t-crosspage-en/`。

## 副本

| 副本 | 来源 | 页 | `continues_to_next` | 段数 | 跨页段 |
|---|---|---:|---:|---:|---:|
| e1 | `~/Documents/Book2Text/b2t_4NWHBY` 新拷 | 662 | **0** | 3308 | **0** |
| e2 | `~/Documents/Book2Text/b2t_RHH2AC` 新拷 | 662 | **0** | 3308 | **0** |

两份完全一致。`b2t_ZAQHGH` 和原库都没碰。

## 五个数（e1 = e2）

| 项 | 值 |
|---|---:|
| 跨页段（`len(pages) ≥ 2`） | **0** |
| 跨页涉及页 | **0** |
| 落在跨页段里的 marks | **0 / 390** |
| `mark.page_no ≠ pages[0]` | **N/A（分母 0）** |
| `line_span.page_no ≠ mark.page_no` | **0** |
| 重复 `(block_id, line_index)` / 同段重复 / 块被拆段 | **0 / 0 / 0** |
| 一个段最多跨几页 | **1** |

**判据通过**：`line_span.page_no ≠ mark.page_no` 为 0、写回重复为 0 → **英文书不需要为跨页写回加任何代码**。

但要看清原因：这本书**一个"延续"标记都没有**（`continues_to_next` 全 0），所以跨页段是 0，
不是"有跨页段且安全"。样例一栏因此为空——没有跨页段可举。

## 如果给它套自动续接规则：R3 不适用

中文书的 R3（页末行未走满 = 段落结束）**在英文书上不成立**，因为这本英文是**右不对齐**排版：

| 证据 | 值 |
|---|---|
| 正文行右端 x1 分布（p30 / p100 / p200） | 0.725–0.876 / 0.519–0.862 / 0.491–0.845 |
| 每页"贴近最右"的行数 | 1–2 / 19–20 行 |
| 页末行未走满的距离（字符宽） | p10 6.8、p50 **35.2**、p90 58.3 |
| R3 判为延续的边界 | **11 / 452** |

也就是说：右不对齐让"未走满"几乎处处成立，R3 只会误判成"句句都结束"。

## 换一条规则会得到多长的段（仅模拟，未验证）

用"下页首行缩进 + 上页末行不是句末标点"在副本上模拟（没有写库）：

| 项 | 值 |
|---|---:|
| 判为延续的边界 | 62 / 451 |
| 由此形成的跨页段 | 60（2 页 58、**3 页 2**） |
| 最长 | **3 页** |
| 三页段位置 | 39–41、127–129 |

- **没有 4 页以上的段**：即使按这条偏保守的规则合并，最长也只到 3 页（2 个）。
- 但这条规则**偏漏**（62/451 ≈ 14%，对 3308 段/451 个页边界来说明显偏少），而且首行缩进在这本书上分布很散（p50 3.2 字符宽、p75 61），所以**不能直接上**。英文书要做自动续接，得单独切一小片金标准验证，不能复用中文书的 R3。
- 3 页段数量级：中文书 3 个、英文书（模拟）2 个，都不构成特例需求。

## 复现命令（英文书）

```bash
ROOT=/tmp/b2t-crosspage-en
mk() { local n=$1 s=$2; p=$(sqlite3 "file:$s/project.db?mode=ro&immutable=1" "SELECT project_id FROM project;")
       mkdir -p "$ROOT/$n/$p"; cp "$s/project.db" "$ROOT/$n/$p/"; cp "$s/project.db-wal" "$s/project.db-shm" "$ROOT/$n/$p/" 2>/dev/null || true
       mkdir -p "$ROOT/$n/$p/source"; cp "$s/source/"* "$ROOT/$n/$p/source/" 2>/dev/null || true; }
mk e1 "$HOME/Documents/Book2Text/b2t_4NWHBY"
mk e2 "$HOME/Documents/Book2Text/b2t_RHH2AC"

cd "/Users/chenlin/DeepSeek Bot/book2text"
ROOT=$ROOT PID=b2t_4NWHBY COPIES=e1,e2 .venv/bin/python /tmp/b2t-crosspage-en/analyze_any.py
.venv/bin/python /tmp/b2t-crosspage-en/sim.py     # R3 不适用：11/452
.venv/bin/python /tmp/b2t-crosspage-en/sim2.py    # 缩进规则模拟：最长 3 页
```
