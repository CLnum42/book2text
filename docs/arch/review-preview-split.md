# 审校页 / 预览页拆分 · 架构

- 日期：2026-11-05
- 树：`worktrees/architect` @ main `c17631d` + 本笔（2026-11-05 rebase 到 main；核树口令见 §1 末尾）
- 状态：**方案，未落代码**。施工顺序归 DevLead；产品边界归 PM；本文件只定结构、接口与可机检判据。

---

## 0. 结论（先给可执行的 7 条）

1. **目标是两个视图 + 一个共享服务**：审校页 = 演进 `#view-reading`；预览页 = 新 `#view-preview`（2026-11-04 被 L-117 删过一次，这次是不同用途，见 §2.6）。共享服务只有一个新的 `text-flow.js`，它独占"成品"的取数。
2. **审校页不读 segments**。它要的三样数据都有现成来源：队列顺序 `/review/next-lines`、差异文本与行框 `/review/marks?page=`、自己的连续页列（`readingTiles`）。读 segments 只是为了今天那条"整本连续流"，而用户要的是"只呈现差异"——那条流正是要退役的东西。
3. **预览页只读 segments，不读 marks 的草稿态**。成品仍由 `build_segments` 唯一生成（D-106）；前端唯一调用点从 2 处收到 1 处（§5 R14）。
4. **预览页"改成品"不新增存储层**：用户的每次改动都翻译成已有原语——行文本 `submit-drafts`、块文本 `PATCH /blocks/{id}`、合并 `merge-prev`、拆分 `split`、段落延续 `continues_to_next`。**不建 segment 覆盖表**，理由与代价见 §3.3。
5. **装配产生的字符在成品上只读**：英文行合并插入的空格、断词还原删掉的连字符，都不属于任何 `line_span`，成品页不许直接改它们（实测样例 43 字 / span 覆盖 41 / 派生 2，见 §3.4）。
6. **同名能力只留一处**：`export-panel.js` 的"生成预览/对照"（`#export-compare`）退役，被预览页取代；审校页的整段流渲染（`renderReading` 一族）退役。判定方式沿用"清洗刀"归零表（§5.3）。
7. **两个"审校"视图的入口必须分开**：`#view-review`（按页改版面/块）与 `#view-reading`（判差异）可以都留，但步骤条上"正文审校"只能指向一个（现在 `autoWorkflowStep` 把两者都算 `review`，app.js:450）。这是本次设计必须先定死的一条，否则拆完还是两个都叫审校的页面。
8. **手改一行必须落一个 ack，否则这条会回到队列**（2026-11-05 实测：`kept` 带文本会丢文本；只改文本不写 ack，这条下一次「下一处未审」又出现）。建议加第三个 ack 值 `edited`：不动数据库（TEXT 列无 CHECK），只动枚举、一处统计键与文案。详见 §3.6。
9. **Jev 分数加在 `next-lines` 的 items，不加在 marks**：`include_scores=1` 时才附 `jev_score`（默认关，保住"没开排序时响应逐字不变"）；实测成本 ~7 ms / +20 KB。分数在文本改动后是过期的，方案见 §3.7。

---

## 1. 现状核实（读数，不是印象）

```
VIEWS = library, pages, index, review, reading, merge          app.js:116（无 preview；app.js 5,687 行 = main）
#view-review   index.html:487–649   #view-reading index.html:650–749
reading-view.js  3,872 行（与 main 同）；模块级状态 66 个 let reading* + 5 个 let jev*；reading* 标识符 702 次
                 导出 5 键：init / enter / getCurrent / toggleFollow / reload（文件末尾 api）
                 app.js 对 reading*/jev* 的引用：仅注释一处（4847），无真引用
reading 取数     /export/preview?segments_only=1      reading-view.js:1027（唯一处）
                 /review/next-lines                   reading-view.js:1293
                 /review/marks?page=                  reading-view.js:1508–1509
                 /review/submit-drafts（写）          reading-view.js:924
export-panel     取 /export/preview（全量，非 segments_only） export-panel.js:311 → renderCompare:322
                 导出选项真值 = 面板 DOM 复选框             export-panel.js:35（exportOptions）
后端              build_segments            core/export/segments.py:178（D-106 唯一入口）
                 preview_segments_json     core/export/project.py:709
                 PREVIEW_CACHE_VERSION=2   core/export/project.py:670
                 段记录字段                core/export/jsonl.py:34（text/pages/block_ids/line_spans/review）
                 ack 随文本变化自动失效     core/project/blocks.py:767（diff_ack_text 对不上 → ack=None）
                 marks 缓存版本=3          core/project/reading_marks.py:47
                 /export/preview 要主项目  api/routes_exports.py:117（_require_main）
测试基线          node tests/js/boundary.test.mjs    116 pass（约 46 s）
                 node tests/js/edge-ratchet.mjs     7/13 归零、模块 showView=0（未全绿，见 §5.2）
```

开发副本实测（`b2t-cjk-copy/b2t_YV1P2Y`，只读；不碰用户真库）：

```
segments 1,145 段 / 多块段 312 / 派生字符 0（中文合并不插空格）
审校队列 1,623 条 = 汉字 899 + 标点 724；版心外 45；非正文块类型 6
marks items 1,623；tree.stats.unacked 1,623 —— 今天三处相等
```

复现命令（本 worktree，node 用绝对路径，PATH 里没有）：

```bash
cd "/Users/chenlin/DeepSeek Bot/worktrees/architect"
grep -rn "/export/preview" backend/book2text/static/*.js
# 今天 = 2 处：export-panel.js:311、reading-view.js:1027
PYTHONPATH="$PWD/backend" .venv/bin/python -c "from book2text import paths; print(paths.STATIC_DIR)"
# 必须打印本 worktree；打印主仓库 = 读数作废（rules #33）
```

---

## 2. 模块地图：接 / 新开 / 退役

### 2.1 现有模块怎么处置（接 / 不接）

| 模块 | 现状职责 | 本次接法 | 判据 |
|---|---|---|---|
| `reading-view.js` | `#view-reading` 全部；队列 / 草稿 / Jev / PDF / 高亮 | **演进成审校页**（不新开视图文件）；右栏由"整段流"换成"当前差异的版本对照"，复用 `readingDiffWindow`(±6 字，:1753) 与 `openReadingPanel`(:1810) 的渲染 | 目标态该文件不含 `/export/preview`、不含 `renderReading` 一族（§5.3） |
| `page-tile.js` | 页图唯一句柄（一页一档一个 `<img>`） | **预览页中栏直接用**；审校页今天是自己一套连续页列管线（`readingTiles` / `readingImageQueue`，:2154–2330），本次不迁移 | 酸测试 `tests/js/page-tile-acid.mjs`。注意 `page-tile.js` 头注释还写着 reading/preview 是消费者，那是 L-117 之前的旧话，别按注释接线 |
| `overlay-registry.js` | 块框图层（mount/append，不查询宿主） | 两页各自 mount 到自己的页元素 | 契约 `docs/refactor/overlay-registry-contract.md` |
| `page-media.js` | 缩放档 / 图档 / 宽度测量 | 两页共用 | 纯函数 + 注入 |
| `export-panel.js` | 导出动作 / 预检 / 历史 / 选项真值 | **只留导出与选项**；`compare-*` 预览对照退役 | 退役 id 归零（§5.3） |
| `review-tree.js` | `#view-review` 左树（6 个 id，页级差异点 + 只看未完成） | **不接给审校页**：审校页左栏是章节/页/差异计数，由 `renderReadingTree`（reading-view.js:1919）自己画。今天 reading 经 `noteReviewAcks` 反向刷这棵树（app.js:4891），随 `#view-review` 降级退役 | 两个树不共用组件、不互写 DOM |
| `page-detail-drawer.js` / `page-detail-editor.js` | `#view-review` 的看图 + 块列表编辑（21 + 30 个 id 的 owner 表） | **本批不接**。它们绑死 `#view-review` root；若 PM 决定把"改版面/块类型"并进审校页，那是整组搬进 `#view-reading` 子树 + 重写 owner 表，属于第二批 | 不为预览页复制它们任何渲染代码（预览页只读 bbox） |
| `page-index`（后端 `routes_page_numbers.py:62`） | 印刷页号 + 章节（回目） | 预览页左栏书籍目录；审校页左栏继续用 `/review/tree` | 两处目录**不共用组件**：内容不同（一个带差异计数，一个带印刷页号） |

### 2.2 要新开的

| 模块 | 唯一职责 | 宿主 | 对外接口（先给最小面） |
|---|---|---|---|
| `text-flow.js`（`window.TextFlow`） | **成品段的唯一取数与失效**：读 options → `POST /export/preview?segments_only=1` → 交给视图；前端不跨进入缓存（后端已有两级缓存） | 无 DOM（服务模块） | `load()` / `signature()` / `invalidate()` |
| `preview-view.js`（`window.PreviewView`） | 预览页视图：左目录 / 中 PDF / 右成品 | `#view-preview` | `init(deps)` / `enter(projectId)` / `getCurrent()` |

### 2.3 要退役的

| 退役对象 | 位置 | 为什么 | 归零判据 |
|---|---|---|---|
| 整本连续正文流渲染 | `reading-view.js:1601` `renderReading`、（分块在 1620–1626）、:2146 `jumpReadingTo`、:2428 `scrollStreamToPage`、:2449 `verifyReadingPageSync` 等 | 用户要"只呈现差异"；这条流同时是"审校页读 segments"的唯一理由 | 审校页文件里 `renderReading` / `readingVisibleSegments` / `readingRendered` 0 次 |
| `#reading-stream` DOM 与 `.reading-seg` 样式 | index.html / app.css | 同上 | id / class 归零 |
| 导出面板的预览对照 | `export-panel.js:311–443`（`renderCompare` / `selectSegment` / `loadComparePage` / `drawCompareOverlay`）、`#export-compare` 子树、`compare-*` id | 同一"成品"两个显示处 = 两个口径，D-106 的同类 | `#export-compare` / `renderCompare` / `compareSegments` 0 次 |

**一条"看起来像要退役、但不能删"的边**：审校页 → `ReviewTree.noteAcks`（app.js:4891）。`ensureReviewTree` 在项目没变时**不重取**（review-tree.js:56–58），页级树靠这条边把 ack 数同步过来。它走的是对方模块的公开接口，不是异步重绘，**保留**并登记为唯一允许的"审校页写别的视图"边；只有 `#view-review` 整体退役时才随它删。

### 2.4 依赖方向规则（每句都可判定）

1. `preview-view.js` **不得**出现 `reading*` / `jev*` 标识符（预览页对审校页状态 0 引用）。
2. `reading-view.js` **不得**出现 `PreviewView` / `TextFlow`（审校页不依赖成品页）。
3. 视图模块**不得**出现 `fetch(` / `apiJson(` 里的 `/export/preview` 字面量；成品只经 `TextFlow`。
4. 视图模块**不得**出现 `showView(`（既有规则，模块只能走注入 `navigate()`；`edge-ratchet.mjs` 已守）。
5. 一个 `pageNo` 同时只允许一个视图持有 `<img>`；切视图先 `release` 再 `create`（PageTile §21.10）。
6. `#view-*` 子树之外的节点，模块只能经注入写（既有 owner 表规则，`boundary.test.mjs` ③ 组已守）。

### 2.5 视图与步骤的对应（必须先拍板）

现状：`autoWorkflowStep()` 把 `review` 和 `reading` 都映射成"正文审校"（app.js:450），步骤条上写"正文审校"时你可能在按页改版面。

建议：

- "正文审校"这一步 → **只到 `#view-reading`（新审校页）**；
- `#view-review`（页级版面/块编辑）→ 降为"页面"视图的子流程（从页砖进入），步骤条不把它算成正文审校；
- 预览页 → 新步骤或挂在"文件导出"前的子页（PM 定；D-090 的原则是**预览不设完成态**，见 §6）。

判据（可机检）：`autoWorkflowStep` 的 `currentView === "review"` 分支不得再返回 `"review"`；或改写成 `VIEW_TO_STEP` 一张表，一个步骤最多一个视图。

### 2.6 为什么可以重开 `#view-preview`（不是重犯 L-117）

L-117 的定性是"**死 UI**"：`preview-view.js`（1,112 行）当时工作正常，但 `WORKFLOW_STEPS` 里没有任何步骤 id 是 `preview`，用户走不到，所以 2026-11-04 连模块带 DOM 带样式一起删了（`06fdf4e` + 一笔清理，known-limitations.md:1938）。

这次不同，两条都成立才允许重开：

1. **有真实入口**：预览页是用户点名的第二页（审校 → 预览），步骤条/审校完成后的跳转给出唯一入口；
2. **它承担唯一职责**：成品段的唯一读入口（`text-flow`），删掉它，成品就没有显示处；而导出面板的 compare 同时退役——**不会出现两个预览**。

判据：`VIEWS` 里 `preview` 有且仅有一处入口；`#view-preview` 子树无第二个 owner。

---

## 3. 预览页的"成品"从哪来（先证明够，再证明缺）

### 3.1 供给链（全部现成）

```
ExportOptions（唯一真值：导出面板复选框，export-panel.js:35）
        │  TextFlow.load()
        ▼
POST /export/preview?segments_only=1              routes_exports.py:105
        │  preview_segments_json  project.py:709（内存 + 磁盘两级缓存，签名 = db mtime + options + 版本号）
        ▼
segments[] = { seq, type, text, pages[{page_no,page_label}], block_ids[], line_spans[{page_no,block_id,line_index,start,end}], review{} }
        │                    │                          │
        │ 左栏目录          │ 中栏来源页                │ 右栏成品 / 编辑映射
        ▼                    ▼                          ▼
GET /page-index       /pages/{n}/image?size=…     行级写：submit-drafts
（章节+印刷页）        /pages/{n}/blocks（bbox）    块级写：PATCH /blocks/{id}
```

字段够不够，逐项核过（不是"看起来够"）：

| 预览页需要 | 现有字段 / 接口 | 够不够 |
|---|---|---|
| 成品文本（该合并的已合并） | `segments[].text`（`build_segments` + `_join_block`） | 够 |
| 每段来自哪些页 / 哪些块 | `pages[]` / `block_ids[]` | 够 |
| 点到成品某字 → 哪一行 | `line_spans[].start/end` + `block_id/line_index` | 够（纯前端换算） |
| 中栏 PDF 定位到来源块 | `block.bbox`（`/pages/{n}/blocks`） | 够（`drawCompareOverlay` 已这么做，export-panel.js:424） |
| 书籍目录 | `/page-index`（chapters + printed_page） | 够 |
| 编辑后保存 | `submit-drafts`（行）/ `PATCH /blocks/{id}`（块/类型/延续）/ `merge-prev` / `split` | 够 |
| 保存冲突检测 | `block.revision` + `expected_revision`（PATCH 支持） | 够（需从 `/pages/{n}/blocks` 读 revision） |

**结论：不新增接口。** 唯一"缺"的是前端的两个纯函数和一条产品规则：

1. `offsetToSpan(segment, offset)` → `{block_id, line_index, offset_in_line}`；命中不了 = 派生字符（§3.4）。
2. 跨 span 编辑的翻译策略（§3.3）。
3. 产品规则：成品上的编辑范围只许落在单个行 span 内；跨行/跨块必须走结构操作（合并 / 拆分），不许"整段覆盖写"。

### 3.2 "段落合并 / 标点统一"这两件事的真相

- **段落合并**只由 `block.continues_to_next` + 说明书 9.1 第 2/3 条决定（`segments.py:244–248`）。**没有**"看句末没句号就自动合并"的逻辑（D-090 第 3 条明确禁止前端猜）。预览页要表达"这两段该合"，动作是写 `continues_to_next=true`（PATCH 已支持），不是改文本。
- **标点统一**：`cleanup.py` 的规则表只有五项（排除页眉页脚 / 行合并 / 断词还原 / 换行规范化 / 去首尾空白），**明文禁止**全局替换引号、破折号、全角半角、拼写纠正（`cleanup.py:28`，测试锁字段集合）。所以用户说的"标点该统一的统一"在现有产品定义里**不存在**；预览页只能如实呈现。要加就是改说明书 9.3 + 改导出，不是改页面。

### 3.3 两种"人工编辑"的语义（PM 问的核心难题，架构判断）

| | 审校页"改这一行文本" | 预览页"改成品" |
|---|---|---|
| 数据落点 | `block_line.text`（`submit-drafts` 带 `new_line_text`） | 同一个 `block_line.text`（行内编辑）；结构变化走块原语 |
| 单位 | 行（OCR 单位，有 bbox、有 aux_text） | 段（排版单位，跨块、含派生字符） |
| ack 失效 | **自动**：`blocks.py:767` 用 `diff_ack_text` 与当前行文本比对，文本一变 ack 即不计 | 同左（同一次写入） |
| 会不会改装配结果 | 会（段文本由行文本重算） | 会（同左，且下一次进入预览就是新成品） |
| 允许的编辑范围 | 整行（可以全改） | **只允许落在单个 `line_span` 内**；跨行 → 合并/拆分原语；派生字符 → 拒绝并提示 |
| 撤销 | 一次 batch 全退（`/undo`） | 同左（同一套事件/撤销栈） |

**架构判断：预览页不引入"成品覆盖层"。** 理由：

1. 覆盖层 = 第二个"成品定义"。导出必须也应用它，否则预览 ≠ 导出（D-106 的复现路径）；而导出侧要应用它，就得把覆盖层塞进 `build_segments` 的输入——那等于承认 `build_segments` 不是唯一入口。
2. "用户改了成品，上游又变了"这个问题在覆盖层方案里**没有解**：上游重识别改了块文本，覆盖层记的是旧段文本，两者只能二选一（覆盖丢失或上游丢失），没有判据。
3. 写回原语后，"上游变了"就是同一个数据被改了一次，天然只有一份真值，重新装配即可。

**原语选择（这一条要写死，不然施工会选错）**：

- "这两段该连成一段" → `PATCH /blocks/{上一块}` 的 `continues_to_next=true`。它只改一个布尔，块、行、bbox、行下标全不变，segments 下一次装配自动合并。
- **不要用 `merge-prev` 做这件事**。它把两个块合成一个块：文本以 `\n` 连接、下一块的行搬进上一块并 `line_index + offset` 重排、下一块软删除（editing.py:1283–1330）。任何按 `(block_id, line_index)` 记的游标 / 裁决定位都会跟着变，只适合"版面本来就该是一块"的修正。
- "这一段该拆成两段" → `split`（`offset` = 块文本里的字符位置）或把 `continues_to_next` 置回 false（拆开的是两个块时）。两者语义不同，界面动作要分开。

代价（必须写进验收，不然会被当成 bug）：**成品上的跨行编辑不能像 Word 那样直接删换行**。用户要从预览页合并两段，界面必须先把它翻译成"合并块"（一个动作、可撤销），而不是悄悄改一段派生文本。

### 3.4 派生字符：成品上有不可编辑的接缝

`_finish_segment` 的记录方式：先 `join_pair` 拼接，再按拼接后的偏移记录 `line_spans`（`segments.py:318`）。于是：

- 英文行合并会**插入一个空格**（`joining.py:196`），这个空格不属于任何 span；
- 断词还原会**删掉行尾连字符**，那段位置也不属于任何 span。

实测（本 worktree，合成数据，可复跑）：

```
块内三行 "The quick brown" / "fox jumps" / "over the lazy dog"
→ 段文本 43 字，span 覆盖 41 字，派生 2 字（两个合并空格）
```

真实英文书全书的派生字数**未实测**（不碰用户真库）；CJK 开发副本 `b2t-cjk-copy/b2t_YV1P2Y` 实测 1,145 段、312 个多块段、派生 0 字（中文合并不插空格）。

产品含义：预览页的光标在接缝上时不能静默吞掉用户输入，必须能显示"这处空白是拼装产生的，要改请改原文行"。这是 Designer 的硬约束（§4.3）。

### 3.5 持久化与"上游又变了"的顺序问题

因为只写原语，落盘顺序固定为：**写库（一个 batch）→ 后端回写 block/line → 项目 mtime 变 → segments 签名变 → 下次取成品必是新结果**。没有"覆盖层要不要重放"的问题。

要钉住的只有两件：

1. `PREVIEW_CACHE_VERSION`（project.py:670）：**改段记录字段或语义就 +1**，否则旧磁盘快照会按签名命中、前端读到旧形状（D-107 的教训：不 bump 等于修复对用户没生效）。
2. 前端 `TextFlow` **不自造新鲜度判断**：payload 里没有签名（project.py:762–771 的键只有 segments/segment_count/preflight/text/jsonl/truncated），前端再算一个就是第二份失效判定。做法是**每次进入预览页重取**（后端命中磁盘缓存实测 ~40 ms，project.py:662），内存只在同一次进入期间复用。

### 3.6 改完一行之后，这条差异怎么关掉（2026-11-05 实测：今天关不掉）

三条路径在同一份开发副本（`/tmp` 上复制，不碰真库）上跑出来的结果：

| 路径 | 调用 | 实测 |
|---|---|---|
| A `kept` + 文本 | `ack_diff_line(..., ack="kept", text=<新文本>)` | `block.text` **没改**；`diff_ack_text` 记的是**旧文本**。`editing.py:877` 起只有 `adopted` 分支读 `text`，`kept` 分支取 `current_lines` |
| B 只改文本（今天审校页的手改路径） | `update_block(text=…)` + `sync_line_text(…)`，不写 ack（`reading-view.js:911–912` 发的就是 `ack: null`） | 这一条**仍在 marks 里、`ack=None`**；`next-lines` 的过滤是 `if item.get("ack"): continue`（`routes_review.py:426–427`）⇒ 下一次「下一处未审」又出现它 |
| C 先写文本、再补一个 `kept` | 同上两步 + `ack_diff_line(ack="kept")`（不带文本） | `diff_ack_text` = **新文本**，`ack=kept` ⇒ 这条退出队列（marks 里留一行审计，ack 非空即不进队列） |

复现命令（先复制开发副本到 `/tmp`，可重复跑）：

```bash
cd "/Users/chenlin/DeepSeek Bot/worktrees/architect"
rm -rf /tmp/b2t-arch-verify && cp -a "/Users/chenlin/DeepSeek Bot/b2t-cjk-copy" /tmp/b2t-arch-verify
PYTHONPATH="$PWD/backend" .venv/bin/python - <<'SNAP'
from pathlib import Path
from book2text.core.project import reading_marks, blocks, editing
lib = Path("/tmp/b2t-arch-verify"); pid = "b2t_YV1P2Y"
items = [i for i in reading_marks.marks_data(pid, library=lib)["items"]
         if i["level"] == "differs_chars" and not i.get("ack")][:3]
def lines_of(i):
    return blocks.get_block(pid, i["block_id"], library=lib).text.split("\n")
a, c, d = items
before = blocks.get_block(pid, a["block_id"], library=lib).text
_, la, _ = editing.ack_diff_line(pid, a["block_id"], a["line_index"], "kept",
                                 text="手改后的文本", library=lib)
print("A:", la["diff_ack"], repr(la["diff_ack_text"]),
      "block未改 =", before == blocks.get_block(pid, a["block_id"], library=lib).text)
ls = lines_of(c); ls[c["line_index"]] += "x"
editing.update_block(pid, c["block_id"], text="\n".join(ls), library=lib)
editing.sync_line_text(pid, c["block_id"], c["line_index"], ls[c["line_index"]], library=lib)
now = [i for i in reading_marks.marks_data(pid, library=lib)["items"]
       if i["block_id"] == c["block_id"] and i["line_index"] == c["line_index"]]
print("B: 还在 marks 里 =", bool(now), "ack =", now[0]["ack"] if now else None)
ls = lines_of(d); ls[d["line_index"]] += "y"
editing.update_block(pid, d["block_id"], text="\n".join(ls), library=lib)
editing.sync_line_text(pid, d["block_id"], d["line_index"], ls[d["line_index"]], library=lib)
_, ld, _ = editing.ack_diff_line(pid, d["block_id"], d["line_index"], "kept", library=lib)
print("C:", ld["diff_ack"], repr(ld["diff_ack_text"]))
SNAP
```

实测输出（2026-11-05，本树）：

```
A: kept '王熙凤效戏彩斑衣' block未改 = True
B: 还在 marks 里 = True ack = None
C: kept '他二人跪下，都一溜跪下。宝玉也忙跪y'
```

修法两条，语义不同（**必须二选一，不能不管**）：

| | F1 复用 `kept`（C 的顺序） | F2 新增 `edited`（Chief 提议） |
|---|---|---|
| 改法 | `submit-drafts` 对"手改"项先写文本、再 ack kept | 新枚举值；`ack_diff_line` 的 edited 分支必须带文本（照 adopted 的校验） |
| 代码面 | 一处顺序（`routes_review.py:614` 的循环） | `editing.py:732`、`routes_review.py:332`（DiffAckRequest）/`:604`（DraftItem）、`review_status.py:459–480` + 测试的键表、`reading-view.js` 草稿 chip 与面板、`page-detail-editor.js:590/672` 标签 |
| 数据库 | 无 | 无（`diff_ack` 是 TEXT、无 CHECK，migration_0018 不用动） |
| 语义 | `kept` 变宽成"保留我确认的文本"，`diff_kept` 与事件 `diff_ack_kept` 把手改也算进去 | 三种决策分得清：保留原文 / 采纳候选 / 人工改写 |
| 风险 | 审计与统计说"保留原文"，实际文本被改过 | 枚举与一处统计键的口径变更（`workflow_status` 多一个 `diff_edited`） |

**我建议 F2**，还多一条 F1 给不了的理由：预览页改**一行本来没有差异的**行也必须落 ack。行文本一变，它和第二路的旧文本就出现了新差异（`blocks.py:767` 用当前行文本与 `aux_text` 比较），不写 ack 就会凭空多出一条未审差异——正是用户约束 1（数字与点下去的事对齐）要挡的那种。这条新差异的准确语义是"人工改出来的差异"，只有 `edited` 写得清；记成 `kept`/`adopted` 都是错记。

**要钉的判据**：改一行（无论原来有没有差异）必须同时满足三件——`block.text` 变了、`block_line.text` 同步了、该行 `diff_ack` 非空且 `diff_ack_text` 等于新文本。缺一条就是今天的 A 或 B。

### 3.7 Jev 分数怎么到卡片上（payload 增量，不是新接口）

Designer 的卡片要显示 `可疑 0.03`，但分数不在 `/review/marks` 里，也不该在那里：

- **加在 `POST /review/next-lines` 的 `lines[]`**：每项一个 `jev_score: float | null`。队列是"下一处"的数据源，卡片正好从它渲染；marks 是差异明细，两页都不需要它带分数。
- **触发方式：查询参数 `include_scores=1`，默认关**。理由：`routes_review.py:453–455` 现在只在 `jev_sorted || jev_suspicious_only` 时才算分数；默认关能保住"没开排序时响应逐字不变"（验收 ⑧c 的机器形态）。开 `include_scores=1` 时，即使不排序也附分数。
- **增量形状**：

```json
{"lines": [{"block_id": "01M5…", "line_index": 1, "page_no": 11, "jev_score": 0.0321}],
 "jev": {"requested": true, "enabled": true, "threshold": 0.05, "scored_lines": 1623}}
```

- **成本实测**（开发副本 394 页 / `block_line` 10,575 行 / 差异行 1,623 条有分数）：`line_scores()` 中位 **7.0 ms**（30 次：min 6.5 / max 13.1）。SQL 没有 `jev_score` 索引 ⇒ 全表扫，1,623 与 10,575 两种规模都是 7–9 ms。payload 只给返回的未审行加字段（该书 899 条汉字差异），约 **+20 KB**。
- **分数会过期**：文本改了分数还留着（只有 `clear_scores` 全清，`jev_priority.py:446`）。卡片上写 `可疑 0.03` 必须能解释这个数是什么时候的。建议在写行文本的同一批里把该行 `jev_score` 置空（一次 UPDATE），或文案写"打分时 0.03"；前者更符合"数字与真实状态对齐"，代价是一次 UPDATE。
- **排序仍是档内按文流**：`_tier` 返回 `(tier, order)`（`routes_review.py:461–474`）。要"档内按分数"就改第二元——那是另一条决定（§6 第 2 条），不在本条增量里。

---

## 4. 两页共用什么 / 绝不共用什么

### 4.1 共享（只有这四样）

| 资源 | 归属 | 两页怎么拿 | 失效 |
|---|---|---|---|
| 当前项目 | 外壳 | 注入 `getProject()` | 切项目 |
| 导出选项 | 导出面板（临时：`ExportPanel.exportOptions`） | 外壳注入 `getExportOptions()` → `TextFlow` | 用户勾选 → options 签名变 |
| 成品段 | `TextFlow` | `TextFlow.load()` | 后端：db mtime / options 签名 / `PREVIEW_CACHE_VERSION`；前端：每次 `enter()` 重取，不跨进入缓存 |
| 完成态数字 | 后端 finish-summary | 只读，不缓存 | 每次进入重取 |

### 4.2 绝不共享（写清楚，防止"顺手读一下"）

| 状态 | 归属 | 为什么不能共享 |
|---|---|---|
| `readingDrafts` / `readingInlineEdits`（localStorage） | 审校页 | 预览页的编辑是"改成品"，语义不同；共用草稿会出现"预览里的修改出现在审校未提交里" |
| `readingPanelKey` / `readingEntries` / `readingPageNo` | 审校页 | 审校页的游标；预览页有自己的 `segmentIndex` |
| `readingMarks*` 窗口 | 审校页 | 预览页不需要差异标记；"这一段有未审差异"用段自带的 `review.unreviewed/uncertain`（jsonl.py:56–61），不读 marks |
| `jev*` 5 份 | 审校页 | 预览页不排序 |
| 编辑会话（未提交的成品编辑） | 预览页 | 切段/离开页面必须提示或丢弃，不许过继 |
| 断点/滚动位置 | 各自 | 互不相关 |
| 页图管线 | 审校页 = `readingTiles`（连续列）；预览页 = `PageTile` | 两页不同屏，各自 mount/release；同一 `pageNo` 不许两页同时持有 `<img>`（PageTile §21.10） |

### 4.3 给 Designer 的三条硬约束（来自数据形状）

1. **成品上的接缝不可编辑**（§3.4）：光标进入接缝要么跳过、要么给一句"拼装产生，不可改"。不能表现为"改了没保存"。
2. **点成品 → 中栏定位**：段可跨页（`pages.length > 1`），中栏要能表达跨页段（至少给两个页签或标"跨页续"）。D-090 第 3 条的判据就是 `pages.length > 1`，别在前端另判。
3. **数字只有一个来源，而且要分三个分母**。实测（开发副本 `b2t-cjk-copy/b2t_YV1P2Y`）：队列 1,623 条 = 汉字 899 + 标点 724；另有 **版心外 45 条**（不进队列）与**非正文块类型 6 条**（`queue_items` totals）。所以界面上任何一句"还剩 N 处"都必须说明是哪一桶：汉字段 / 标点段 / 版心外。四件事不许混：① 顶部剩多少 ② 左栏合计 ③ 标点徽章 ④ 版心外提示。判据：同一屏上任意两个"总数"要么相等、要么文案写明口径不同；预览页的"N 段 / N 字"只来自 `TextFlow` 的同一次 payload。

### 4.4 切页语义（两页互不推送，进入即最新）

- 两页都在 `VIEWS` 里，切走只是 `hidden`，模块内存与 DOM 不销毁（app.js:110–111 的既有约定）。切回来不重建，**但要重新取数**：审校页 `enter()` 重取 marks 窗口与计数，预览页 `enter()` 走 `TextFlow.load()`（命中磁盘缓存 ~40 ms，`project.py:662` 的实测注释）。
- **不做跨视图推送**：预览页写库后不主动去刷审校页（异步重绘吃掉界面的反模式 #2 就是这么来的）。两页不同屏，靠"进入即最新"就够；刷新点只有一个，就是各自的 `enter()`。
- 未提交的编辑会话在切页时**必须用户决定**（提交 / 丢弃），不许静默丢弃（决策优先级第 1 条：不丢用户数据）。审校页的草稿已在 localStorage，跨页不丢；预览页的编辑会话只在内存，必须提示。
- 缓存失效靠签名，不靠事件：任何写库 → db mtime 变 → 两个后端的签名都变（`preview_segments_json` / `marks_data`），下一次取数自动是新结果。

### 4.5 任务包（package）模式

`/export/preview`、`/review/tree`、`/jev-priority` 全部 `_require_main`（routes_exports.py:117、routes_jev.py:54（_require_main 在 57）、routes_review_status.py:109 的树接口）。所以：

- 预览页在包项目里**不可达**（与"文件导出"同等处理：步骤条不显示、`showView` 守住）；
- 审校页在包项目里只能做页级审校（今天已经是这样：包项目不发树请求）。

---

## 5. 可机检（每条结论给命令或判据）

### 5.1 一条最关键的规则：R14 · 成品单一入口（棘轮）

**判据（可判定）**：`backend/book2text/static/*.js` 里字面量 `/export/preview` 的**出现点集合** ⊆ 例外表；例外表每行带 owner + 到期切片；**只降不升**。非 `export-panel.js` 的调用点必须带 `segments_only=1`。

```
今天（实测）：{ export-panel.js:311, reading-view.js:1027 }   ← 2 处
目标（切片落地后）：{ text-flow.js }                            ← 1 处，例外表清空
```

**为什么是这一条**：它直接对应反模式 #1（每个视图各算一遍正文流）。多一个调用点 = 多一份 options = 迟早两个段数；而只要唯一入口是服务模块，视图就无法"顺手自己拉一份"。

**实现**（照 `edge-ratchet.mjs` 的 `BRIDGE_EXCEPTIONS` 形态，TestDev 落地）：

```js
// exceptions: [{ file, line, owner, expires }]，数组长度上限单独一个常量（只降不升）
const SEGMENTS_CALLERS = [
  { file: "export-panel.js", owner: "DevLead", expires: "预览对照退役时" },
  { file: "reading-view.js", owner: "DevLead", expires: "审校页去掉流渲染时" },
];
// 断言 1：每个出现点都能在 SEGMENTS_CALLERS 找到文件
// 断言 2：数组里每条都真的还有出现点（过期 = 红）
// 断言 3：非 export-panel.js 的出现点，同一行/同一模板串含 segments_only=1
```

**喂坏必红**（原型验证要贴证据）：在 `preview-view.js` 里写一行 ``apiJson(`/api/projects/${id}/export/preview?segments_only=1`)`` → 断言 1 红；把 `reading-view.js` 那行改成不带 `segments_only=1` → 断言 3 红。

**命令**：

```bash
grep -rn "/export/preview" backend/book2text/static/*.js   # 出现点；目标输出 1 行
node tests/js/edge-ratchet.mjs                              # 现状 7/13（见下）
```

### 5.2 现状闸的代价（别把 R14 加进一个已经红的闸里当噪音）

`edge-ratchet.mjs` 现在 7/13 归零、6 条仍红（未完成的搬迁目标）。R14 应加在**同一个文件但独立成条**，读数按条输出，不能"混进 13 条总数"——否则 R14 红了会被误读成"搬迁没完成"。这是 2026-11-05 的事故同类（一个闸里混两种口径，读数就没人信）。

### 5.3 其余结论的机检状态

| 结论 | 能机检？ | 判据 / 命令 |
|---|---|---|
| 成品 = 导出正文（逐字节） | ✅ 已有 | `tests/integration/test_preview_api.py:132`：段文本 `"\n\n".join` == `body.txt` |
| 段记录字段变了必须 bump 版本 | ⚠ 可做 | 锁 `segment_to_record` 的键集合（jsonl.py:44–61）的契约测试；改键集 → 红 → 逼 bump `PREVIEW_CACHE_VERSION` |
| 审校页不读 segments | ✅ 可做 | 文件级断言：`reading-view.js` 里 `/export/preview` 0 次、`readingVisibleSegments` 0 次 |
| 预览页不读审校状态 | ✅ 可做 | `preview-view.js` 里 `reading*` / `jev*` 标识符 0 次 |
| 派生接缝可算出 | ✅ 已有函数 | `_join_block` + span 覆盖差（§3.4 实测 43/41/2）；前端 `offsetToSpan` 单测：接缝返回 `null` |
| ack 随文本失效 | ✅ 已有代码 | blocks.py:767；补一条 integration：改行文本后该行不再计入 acked |
| 退役 id 归零 | ✅ 已有模式 | 照 `boundary.test.mjs:6769` 的 `DEAD_REVIEW_NAMES`，加 `export-compare / compare-* / reading-stream` |
| 两个"审校"视图只一个入口 | ✅ 可做 | `autoWorkflowStep` 的 `review` 分支不得返回 `review`（§2.5） |
| 数字三桶不混 | ⚠ 需 e2e | 审校页：汉字 899 / 标点 724 / 版心外 45（开发副本实测）各自标口径；预览页段数与字数来自同一 payload |
| 接缝在 UI 上"不可编辑" | ❌ 人工 | 真机截图 + 交互验收（Designer/QA） |
| 跨行编辑必须走结构原语 | ❌ 人工 | 代码评审判据：预览页保存路径不得出现"整段 text 覆盖写" |
| 真实英文书的派生字数 | ❌ 未实测 | 需在副本上跑 §3.4 的统计（不碰真库） |
| 手改后不再回队列 | ✅ 可做 | integration：改行文本 + `ack=edited` → 该行退出 `next-lines`（现状必红：ack 为 null） |
| 改一行三件齐 | ✅ 可做 | integration：`block.text` 变 + `block_line.text` 同步 + `diff_ack_text` == 新行文本；缺一红 |
| jev_score 只加 next-lines | ✅ 可做 | marks payload 里 `jev_score` 键 0 次；`next-lines?include_scores=1` 每项有该键（可空） |

---

## 6. 需要别人拍板的五个口子（我只给结构后果）

1. **"标点该统一的统一"**（用户原话）与说明书 9.3 的禁令冲突。结构后果：要"统一"就得新增清理规则 + 改导出 + 改说明书；否则预览页只能如实呈现，界面不能暗示会统一。
2. **Jev 排序的文案与真实排序不一致**：服务端只把可疑行**按页码**提到前面（`routes_review.py:455–481`，tier 在 461），不按分数排；界面写"按 Jev 可疑度重排"、提示条写"可疑行按页码排，不按分数排"（reading-view.js:361–362）。要按分数排就是新产品行为（队列会跳页），须 PM/Chief 定。
3. **预览页的完成态**：D-090 定的是"预览不设完成态、不进 k/6"。现在预览页可编辑，是否要"没预览过不能导出"的闸？结构后果：要闸就得加后端完成判定（新口径），不加就仍是"可跳过"。
4. **版心外那 45 条要不要进审校页的分母**：它们今天"看得见但不进队列"（`queue_items` totals.outside；开发副本实测 45）。新审校页只呈现差异，用户会以为把它们判完就该完成；按现有定义判完也不影响 `r.complete`。二选一：界面明确标"不进完成度"，或改完成后端判定（会动 finish-summary 与步骤条，属于口径变更）。
5. **ack 枚举要不要加 `edited`**：不加就只能在 F1（复用 kept、语义变宽）与 F2（新值、口径变更）之间选。我建议 F2（§3.6），它同时解决"预览页改干净行会凭空多出一条未审差异"。这是本轮唯一动枚举的地方，不动数据库。

---

## 7. 与 PM / Designer 的接口

- 给 PM：§3.3 的编辑语义表就是你要的"两种人工编辑"答案；§3.5 回答"上游变了怎么办"；§3.6 是"改一行 = 确认这一行"的落法（今天落不了）；§6 五条是产品开口。
- 给 Designer：§4.3 三条硬约束（接缝、跨页段、数字口径）。PDF 列：审校页是连续列、预览页是单页，**不要新增第三套取图实现**；预览页走 `PageTile`。
- 给 DevLead：切片顺序由你定，但 R14 的例外表必须在**第一刀**就加（否则新视图一写就多一个调用点）；`text-flow.js` 与预览页可以独立于审校页改造先行（它只依赖现有后端）。
