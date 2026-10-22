# 开发日志

按说明书 1.2 的报告模板逐条记录每次开发任务。**新的记录追加在最上面。**

模板字段：任务目标 / 当前状态 / 实施计划 / 实现与验证 / 用户操作说明 / 下一步建议。
未在真实环境运行过的测试一律注明，不得把未运行的测试写成通过。

---

## 2026-10-22 — 任务 39：页面确认右栏重排 + 类型常驻列表

### 任务目标

把页面确认右栏从"下拉框 + 一堆平铺按钮"改成：类型常驻列表、三层信息层级、
建议贴着当前页；缩略图用页面类型颜色区分；新增版权 / 前言类型；块框开关按项目记住。
**不**做自动块类型建议、缩略图 Job、虚拟滚动，也不改识别流程。

### 当前状态

- 类型是 `<select>` + "设为该类型"两步；多选混合类型时下拉只能显示其中一个，看不出"混合"。
- 右栏六个 `panel__sec` 平铺，识别 / 第二引擎 / 其他按钮全在第一屏，主操作不突出。
- 页面类型只有 8 个；版权页与前言只能被当成 `front` 或 `body`。
- 自动建议只覆盖空白 / 首页 / 图像页 / 目录 / 索引 / 附录。
- 块框开关是全局内存状态，切项目或刷新就丢。
- 基线：**636 passed**；真书《导读巴赫金》267 页（第 3 页版权页 24 块、第 30 页正文 6 块）。

### 实施计划

1. 页面类型新增 `copyright` / `foreword`，`front` 保留并显示"前置（其他）"；补关键词建议。
2. 右栏改成三层：页面确认（类型列表 / 纳入 / 确认）→ 识别 → 高级 details。
3. 类型列表：颜色点 + 文字、当前高亮 + "当前"、建议淡色圆点、混合显示"混合（N 种）"。
4. 缩略图左缘 4px 类型色条；未确认虚线保留，两者可同时表达。
5. 建议区只对选中页显示，放在类型列表下。
6. 块框开关 localStorage 按项目记住。
7. 两本书真浏览器验收 + 文档。

### 实现与验证

**右栏结构（改前 → 改后）：**

改前：`已选 → 页面类型(下拉+按钮) → 识别 → 第二引擎 → 其他`，六个平铺区块。

改后：

| 层 | 内容 |
|---|---|
| 第一层（卡片，常驻） | 页面确认：`已确认 0/267`、类型 10 按钮、纳入/排除、确认所选 / 确认全部、选中页建议 |
| 第二层（分隔线下） | 识别：跳过已识别、识别所选、识别全部未识别 |
| 第三层（`<details>` 默认折叠） | 第二引擎复核、全选、在审校中打开、分派审校 |

截图：类型面板 [`screenshots/page-confirmation-type-panel.png`](screenshots/page-confirmation-type-panel.png)；
第 3 页版权建议 [`screenshots/page-confirmation-copyright-suggestion.png`](screenshots/page-confirmation-copyright-suggestion.png)。

**类型与颜色：**

- 10 个类型，每个有固定颜色 + 中文标签；按钮/筛选/导出页类型都可选。
- 当前类型：2px 同色边框 + "当前"；建议：右上角淡色圆点（tooltip 写"建议第 N 页"）。
- 多选同类型 → 该类型高亮；多选不同 → `混合（2 种）`，无高亮。
- 缩略图左缘 4px 色条表类型，橙色虚线继续表未确认；两者同时出现（截图里可见）。

**新增类型与建议：**

- `copyright`（版权）/ `foreword`（前言）；`front` 保留，显示"前置（其他）"，**不迁移老数据**。
- 关键词：`图书在版编目` / `ISBN` / `CIP`（英文整词）→ 版权；`前言` / `序言` / `导言` /
  `译者的话` / `凡例` → 前言。关键词判断优先于"首页=封面"。
- 真书第 3 页实测建议"版权（把握中）"，理由"页首文字里出现「图书在版编目」"；
  第 1 页仍建议"封面（把握中）"。

**验收（macOS + Chrome，两本书）：**

- 《导读巴赫金》267 页：右栏第一眼是页面确认；高级区折叠；类型 10 个一屏看全；
  第 30 页选中 → "当前：正文"，缩略图色条 `#2563eb`；第 1 页 → 封面建议圆点 +
  建议条目，点「采用」后该页变封面（紫色、当前：封面）。
- 多选 1–2（封面 + 正文）→ "混合（2 种）"、无高亮；点"正文"→ 两页同类型、正文高亮。
- 第 2 页设 `front` → 状态显示"当前：前置（其他）"，缩略图前缀仍是 `front`。
- 块框开关：单页档打开后刷新、重新打开同一项目 → 开关仍为开、第 30 页 6 个框自动出现；
  localStorage key 只有 `b2t.pagesOverlay.b2t_8AFV96`。
- 第二本书（`b2t_C0WS5D`，20 页）打开、页面视图、类型列表正常，无报错。
- 单页缩放 + 块框仍可用（上一刀功能未回归）。

**测试：** 新增 5 项（total 636 → **641**）：版权 / 前言 / 拉丁词不误命中、新类型 API、
类型列表与颜色静态约定。本地 `.venv/bin/python -m pytest -q` → **641 passed, 1 warning，48.78 秒**。

**未验证：** Windows / Safari 的详情折叠与 localStorage；292px 面板在更窄窗口下的换行。

### 用户操作说明

- 页面视图右栏顶部就是「页面确认」：点类型按钮直接改所选页，当前类型有"当前"字样。
- 建议：选中页有建议时，建议类型右上角有淡色圆点，下面出现建议条目；点「采用」才改。
- 识别在第二层；第二引擎 / 全选 / 分派在「高级操作」里，默认收起。
- 「块框」开关会按项目记住；下次打开同一项目、进入大图档仍保持。
- 回退：`git revert` 本次提交；页面类型只是文本值，新类型不涉及迁移。

### 下一步建议

自动块类型建议（Extractor）之前，先把"类型颜色"接到导出预检与项目库卡片上，
让同一套颜色在三个视图里一致。


### 任务目标

让页面视图像常规 PDF 阅读器一样从网格一路放大到单页，分辨率跟着档位走；
在大图档给一个默认关闭的块框开关，只在可见页渲染，滚动离屏清理。
**不**做缩略图后台 Job、虚拟滚动，也不改识别 / 版面确认。

### 当前状态

- 页面视图固定网格，缩略图一律 `size=thumb`（40 DPI），放大必然糊。
- 块框只在审校视图；页面视图没有 overlay。审校的 `.page-canvas + .page-overlay` 与
  百分比定位（`applyBoxElementRect`）可直接复用。
- `.box__badge` 浮在框外上方，会压住上一行文字（用户报"错位"的观感来源之一）。
- 基线：**635 passed**；真书项目 `b2t_8AFV96`（267 页，已识别 3/9/29/30/31 页）。

### 实施计划

1. 页面视图四档缩放：网格 / 大网格 / 单列 / 单页；CSS 列数 + 页宽切换。
2. 图像按档位切 `thumb / view / zoom`；大图档只给离视口近的页设置 `src`，离屏清掉。
3. 大图档 + 开关打开时，给可见页拉块数据并画只读 overlay；块数据 LRU 40 页。
4. tile 宽高比改成页面真实比例；overlay 与 `<img>` 矩形必须完全一致。
5. 块类型 badge 移到框内左上角、半透明（审校 / 页面视图共用）。
6. 验证多选；真书 267 页测滚动与内存；截图存档；文档。

### 实现与验证

**缩放与渲染档位（D-054）：**

| 档位 | 版式 | 渲染 |
|---|---|---|
| 1 / 4 网格 | 自动填充 | thumb 40 DPI |
| 2 / 4 大网格 | 3 列 | view 150 DPI |
| 3 / 4 单列 | 1 列，页宽 ≤680px | view 150 DPI |
| 4 / 4 单页 | 页宽 = 容器宽度 | zoom 300 DPI |

- 实测单页档：显示宽 1129px，渲染图 1480×2457，仍是缩小显示，不糊。
- 页面 tile 的 `aspect-ratio` 改用 `page.width_pt / page.height_pt`（原固定 1:1.414），
  overlay 与 img 的 `getBoundingClientRect()` 完全一致（第 30 页均为 1129×1874.95）。

**缓存与性能：**

- 不做新缓存层：HTTP 响应仍带 `Cache-Control: private, max-age=300`；DOM 侧只在
  离视口 1400px 内设置大图 `src`，更远的 tile 清掉 `src`，让浏览器释放解码位图。
- 267 页实测：单页档稳定只保留 **2–3 张大图**；JS heap 约 **27–29 MB**；
  激进地用 3 秒从第 1 页扫到第 267 页，rAF 计数 92 帧（约 **30fps**），无卡死；
  正常滚动更轻。**没有虚拟滚动**：267 个 tile 都在 DOM 里。
- 块数据缓存：`pageBlockCache` LRU 40 页；只给当前可见页渲染 overlay，离屏清空。

**块框：**

- 大图档（单列 / 单页）才启用开关；档位退回网格时自动关并清理。
- 复用审校的 `.page-overlay / .box / .box--type-*`；加 `.page-overlay--readonly`
  让整个层 `pointer-events:none`，块框不吃选页点击。
- 第 30 页（正文 6 块）截图见 [`screenshots/page-view-block-frames.png`](screenshots/page-view-block-frames.png)：
  6 个框逐块对照原图，含书眉 "2 谁是巴赫金? 11"；第 3 页（版权页 24 块）见
  [`screenshots/page-view-dense-page.png`](screenshots/page-view-dense-page.png)。
- badge 改成框内左上角、`rgba(255,255,255,.78)`、9.5px；密集页仍会压住行首一两个字，
  但不再浮到框外压上一行。

**多选：** overlay 开着时，点第 30 页图区 → 选中 1 页；Shift 点第 31 页 → 选中 2 页，
「设为该类型」可用。单击 / Shift / ⌘ 逻辑未改。

**测试：** 新增 1 项（total 635 → **636**；另扩展现有页面图片接口测试）：
缩放入口 / 只读 overlay / badge 贴框内的静态约定；图片接口 `thumb < view < zoom` 的宽度关系。本地 `.venv/bin/python -m pytest -q`
→ **636 passed, 1 warning，48.09 秒**。

**CI 实跑（GitHub Actions，真实结果）：** [run #14](https://github.com/CLnum42/book2text/actions/runs/39725941104)
—— **Status: Success**。`全量测试（macOS 14 + OCR）` 2m 30s、`Windows 测试（非 OCR）` 3m 58s，
run 总时长 4m 1s。

**未验证：** Windows 与 Safari 的滚动 / 图片解码差异；性能数字是 macOS + Chrome、
程序化滚动（非真实滚轮手势）；JS heap 不含图片解码内存，只作趋势参考。

### 用户操作说明

- 页面视图右上角「－ / ＋」切换四档；标签显示 `1/4 · 网格`……`4/4 · 单页`。
- 到单列或单页后，「块框」按钮可用；点开后才显示块框，再点关闭。
- 单击选页、Shift 段选、⌘/Ctrl 加减选照旧；块框不会挡住点击。
- 回退：`git revert` 本次提交；纯界面改动，不涉及数据库。

### 下一步建议

把页面视图右栏（页面确认）的重排与类型颜色放到下一刀；块框开关的状态可以顺手记住
（按项目存），避免每次进页面视图都要再点一次。


### 任务目标

把导出从"一条混着页眉页码的正文"改成三条明确的流：正文干净、注释单独、页码与书眉
作为元数据保留，服务双语语料库的页面锚点。**不**改页面确认、识别流程、版面模型、
分组算法与协作任务包。

### 当前状态

- 现有导出只有一条流：`clean.txt` / `segments.jsonl`，页眉 / 页脚 / 页码被"排除"后
  信息直接丢掉；脚注默认不导出；manifest 记录正文统计。
- `block_type` 已有 paragraph / heading / footnote / caption / header / footer /
  page_number / figure / decoration / other；`page.page_label` 只是 PDF 属性，不一定是印刷页码。
- 基线：**622 passed**，导出 19 项集成测试。
- 实测报告第 8 页的失败形态：书眉被 OCR 拆成两行，其中一行可能被分组成 paragraph。

### 实施计划

1. 新模块 `core/export/streams.py`：注释流（footnote → 引用定位）、印刷页码抽取、
   每页元数据；正文流复用 `segments.py`，只允许 body + heading。
2. `project.py`：`Prepared` 增加 blocks / notes / meta；导出写 `body.*`、`notes.*`、
   `meta.json`、`manifest.json`；预检与 manifest 分别统计三条流。
3. 预检界面：三条流的段 / 字 / 条数、页码映射 found/total 与缺失页列表。
4. 文件名固定、下载 / 记录 / 在文件夹中显示沿用 `file_paths`；老记录 `clean.txt` 仍可下载。
5. 测试：三条流边界、注释定位与未定位、印刷页码缺失/冲突、拆行书眉、老记录、manifest。

### 实现与验证

**三条流的边界：**

| 流 | 块类型 | 文件 |
|---|---|---|
| 正文 | `paragraph` + `heading` | `body.txt` / `body.jsonl` |
| 注释 | `footnote` | `notes.txt` / `notes.jsonl` |
| 元数据 | `caption` / `header` / `footer` / `page_number` 原文 + 统计 | `meta.json` |

- 图注进元数据（不是注释流，也不是正文）：它没有"引用到哪段"的语义，但原文不能丢。
- `other` 不进正文；`figure` / `decoration` 本来就不输出文本。
- 正文沿用现有段生成、跨页拼接、断词还原；`segment_count` / `char_count` 接口字段仍指正文。

**注释流：** 每条带 `seq / page / block_id / text / reference`；引用位置取
`(page_no, order_index)` 向前最近的正文块，若能落到某个正文段再写 `segment_id`；
找不到写 `reference.status = "unlocated"`，TXT 写"未定位（前面没有正文块）"，不编造。
**已知边界：** 尾注会全部指向最后一个正文块；脚注符号不在 OCR 文本里时无法精确匹配。

**印刷页码：**

- 优先 `page_number` 块；否则页眉 / 页脚里纯数字或罗马数字的块（`looks_like_a_number`）。
- 多个不同候选且没有明确 page_number 块 → `printed_page = null`，保留
  `printed_page_candidates`；**不拿 PDF 页号 / `page_label` / 上一页 +1 猜**。
- 每页带 `printed_page_source`、`page_label`、`headers` / `footers` / `page_numbers` /
  `captions`、`block_types`、`lines`（assigned / conflict / unassigned）、`edge_texts`。
- `edge_texts` 收页面边缘 ≤20 字的短文本（不论类型），兜住"书眉被拆行、碎片还是 paragraph"。

**文件与兼容：**

- 新目录：`body.txt` / `body.jsonl`、`notes.txt` / `notes.jsonl`、`meta.json`、`manifest.json`；
  选 TXT 时不生成 JSONL，反之亦然；`meta.json` 与 `manifest.json` 总是生成。
- `export_record.file_paths` 存实际列表；下载 / 查看 / 在文件夹中显示沿用现有代码。
- 老记录 `clean.txt` / `segments.jsonl` 仍能打开与下载（新增测试，见下）。
- 旧"内容类型"复选框从界面移除；API 字段保留但不再影响三条流边界。

**测试：** 新增 13 项（total 622 → **635**）：

- 导出集成：脚注只进 notes、引用定位、printed_page 缺失/命中、拆行书眉留痕、
  manifest 三流、正文只含 body+heading、老记录下载、文件集合。
- 单元：页码抽取（page_number / 罗马数字 / 冲突 null）、无前文注释未定位、
  注释 JSONL 一行一条。
- 本地：`.venv/bin/python -m pytest -q` → **635 passed, 1 warning**（50.00 秒，macOS arm64）。

**CI 实跑（GitHub Actions，真实结果）：** 第一次 [run #12](https://github.com/CLnum42/book2text/actions/runs/39718237491)
macOS 绿、**Windows 红**——失败点是新加的老记录下载测试：Windows 文本模式把夹具写成了
`\r\n`，断言按 `\n` 比。顺带发现导出文件本身也没显式指定 LF，因此在 Windows 上会变成 CRLF
（违反说明书第 10 节）。修复：所有导出的 `write_text(..., newline="\n")`，测试夹具也用
`newline="\n"`。第二次 [run #13](https://github.com/CLnum42/book2text/actions/runs/39718646578)
**Status: Success**：macOS 2m 22s、Windows 5m 14s（Windows 在排队）。

**真实导出（已有项目副本 `b2t_KE720H`，第 5 页手工补了书眉 / 脚注 / 页码 / 图注）：**

- `body.txt`：3 段 / 566 字；**不含** `红楼梦/000`、`· 63 ·`、脚注、图注（逐串 grep 确认）。
- `notes.txt`：1 条，`引用：第 5 页 · 块 …223F · 段 …223F`；
- `meta.json`：`printed_page = "63"`、`source = page_number`、headers / captions 原文都在，
  `lines: assigned 26 / conflict 0 / unassigned 0`；
- `manifest.json`：`files = [body.txt, notes.txt, meta.json, manifest.json]`，三流统计齐全。
- 界面预检（导出第 5 页）：正文 3 段 / 566 字、注释 1 条 / 10 字、元数据 1 页、
  页码映射 **1 / 1**；生成后文件列表逐个可下载（HTTP 200）。

**未验证 / 已知边界：** Windows 只跑后端测试；尾注、脚注符号缺失、多栏阅读顺序、
多个页码候选时只能 null——这些都写在 D-053 与下文"哪类书会失效"。

### 用户操作说明

- 导出对话框格式仍是 TXT / JSONL / 两者；`exports/<export_id>/` 下文件名固定。
- 预检里先看"页码映射 K / N 页"；缺的页会在提示里列出，`meta.json` 里是 null。
- 老导出记录照常「查看 / 下载」，不会因为新文件名打不开。

### 哪类书这套会失效（判断）

- **尾注**：注释集中在书末，引用位置会全部落到最后一个正文块——不可信，需要人工；
- **脚注符号不在 OCR 文本里**：只能定位到"最近前文"，不能精确到句；
- **多栏 / 竖排**：`order_index` 是分组时的阅读顺序，跨栏注释的"最近前文"可能是同栏上一段，
  不一定是真正被注的段落；
- **页码不是独立块**（和正文 / 书眉拼在一起）或一页有多个不同页码候选：`printed_page` 为 null；
  此时 `edge_texts` 仍保留原文，但语料对齐要靠人工补；
- **纯图片页 / 没有文本层的页**：book 的 body 流没有内容，元数据仍在（如果页在导出范围内）。

### 下一步建议

先把"页码映射缺失"做成可人工补录的字段（例如在页面视图里直接填 printed_page），
再谈多流导出的其他扩展；否则对齐失败只能靠改 PDF 重识别。


### 任务目标

把已有的"页面类型 + 纳入 / 排除"能力**显式化**：新建项目导入 PDF 后或首次识别前，
出现一个「确认页面」的界面——左边缩略图网格（复用），右边是"正文 / 已排除 / 未确认"汇总，
可以按类型批量设、也能单选 / 多选改；并给出只作建议、不自动应用的自动建议。
**不加识别硬闸门**，不改分组算法与识别执行器。

### 当前状态

- 页面类型（封面 / 目录 / 前置 / 正文 / 附录 / 索引 / 空白 / 其他）与 `include`
  已能批量设置，识别也只跑纳入页（`resolve_pages`）；缺的是"一步"和状态。
- 新建项目后直接落在页面视图，用户看不到"还没确认"这件事；类型与纳入没有确认状态。
- 基线：**604 passed**，7 个迁移；页面视图已有缩略图网格、多选、批量类型 / 纳入面板。
- `docs/region-classification-eval.md` 的结论：自动判定已经准，**不要做硬闸门**；
  自动建议必须只作建议。

### 实施计划

1. 迁移 0007：`page.page_confirmed`；改类型 / 改纳入（值真的变了）自动重置。
2. 新模块 `core/project/page_setup.py`：纯规则的建议（空白 / 首页 / 图像页 / 目录关键词），
   只读、不落库；最多分析 60 页。
3. 接口：`POST /pages/confirm`、`GET /pages/suggestions`，页面载荷带 `page_confirmed`。
4. 界面：页面视图顶部汇总栏 + 右栏确认面板（汇总、确认所选 / 全部、建议列表）；
   新建项目后自动展开；识别前提示未确认页但不阻止；瓷砖显示"已确认 / 待确认"。
5. 测试 + 真浏览器验收 + 老项目副本迁移 + 文档。

### 实现与验证

**数据与状态：**

- 迁移 0007 只加 `page.page_confirmed INTEGER NOT NULL DEFAULT 0`。
- `page.confirmed` 出现在 `Page` 与页面载荷里；老项目打开即升级，全部默认未确认。
- `update_page` / `update_pages`：**只有类型或纳入真的变了**才把 `page_confirmed` 重置为 0；
  批量点"设为正文"而值没变，不会把已确认页打回未确认（有测试）。
- 确认接口 `POST /projects/{id}/pages/confirm` 幂等；响应带更新后的页面载荷与汇总。

**自动建议（`core/project/page_setup.py`）：**

| 信号 | 建议 | 把握 |
|---|---|---|
| 缩略图墨迹占比 < 1% | `blank` | 高 |
| 第 1 页且不是空白 | `cover` | 中 |
| 已识别过、本页 0 块、墨迹 ≥ 45% | `front` | 中 |
| 已识别过、本页 0 块、墨迹 < 5% | `blank` | 低 |
| 页首文字含目录 / 索引 / 附录关键词 | 对应类型 | 中 |

- **新项目（还没识别）只给空白 / 首页建议**——"没有识别行"本身不算证据，否则整本书
  都会被建议成空白 / 前置。
- 最多分析 60 个未确认的纳入页；只对"没有块或首页"的页渲染 50 DPI 缩略图。
- 全部只读：`GET /pages/suggestions` 不写库；"采用建议"是用户单独点的一次 PATCH。

**界面：**

- 页面视图顶部新增汇总栏：`正文 N · 其他类型 X · 已排除 M · 未确认 K`，右侧「确认页面…」。
- 右栏顶部新增确认面板：汇总、`确认所选页面`、`确认全部未确认页`、建议列表
  （页码 / 建议类型 / 把握 / 理由 / 采用建议）。
- 新建项目导入完成后自动展开一次；老项目只显示汇总栏，不自动打扰。
- 缩略图状态：已确认显示"✓ 已确认"，确认模式下未确认显示"待确认"并加橙色虚线框。
- 识别前（单页 / 所选 / 全部未识别）若范围内有未确认页，`window.confirm` 提示一次，
  取消就停、确定就继续；服务端不拦。
- 打开确认界面、以及从别的视图切回页面视图时，都会重新 GET `/pages`，状态以数据库为准。

### 验证

**本地测试：** `.venv/bin/python -m pytest -q` → **622 passed, 1 warning**（49.22 秒，macOS arm64 / Python 3.12.13）。
新增 18 项：建议规则 9、确认 / 重置 / 幂等 4、建议只读 1、排除页不进识别 1、未确认不拦识别 1、迁移 2。

**CI 实跑（GitHub Actions，真实结果）：** [run #11](https://github.com/CLnum42/book2text/actions/runs/39717049597)
—— **Status: Success**（提交 `99a54d7`）。两个 job 都绿：
`全量测试（macOS 14 + OCR）` 2m 37s、`Windows 测试（非 OCR）` 2m 19s，run 总时长 2m 41s。

**真浏览器（macOS + Chrome，临时项目库）：**

1. 新建项目（20 页样本）→ 自动进入页面确认：汇总 **正文 20 · 其他 0 · 已排除 0 · 未确认 20**；
   自动建议给出"第 1 页 → 封面（把握中）"，未改任何页。
2. 批量：1–2 页设为目录、3–4 页排除 → 汇总 **正文 16 · 其他类型 2 · 已排除 2 · 未确认 20**。
3. 点「确认全部未确认页」→ 未确认 **0**；把第 5 页改成"前置" → 该页立即回到未确认，
   汇总变 **正文 15 · 其他类型 3 · 未确认 1**，缩略图上出现"待确认"。
4. 选中第 5 页点「识别所选」→ 弹出提示（原文）：
   "还有 1 页没有确认页面类型……识别所选页仍会按现在的设置继续——未确认不拦人。要现在继续吗？"
   点确定后任务 `ocr` 成功、**total=1**；第 5 页变为已识别，第 3–4 页（已排除）仍未识别——
   排除页没有进识别范围。
5. 老项目副本 `b2t_C0WS5D` 在同一项目库打开：20 页全部 `page_confirmed=false`、类型不变，
   没有迁移错误。

**未验证：** Windows 上的确认界面交互（CI 只跑后端）；超大书（>60 页未确认）只分析前 60 页，
其余页没有建议（界面如实写明）。

### 用户操作说明

- 新建项目导入后会自动展开「确认页面」；老项目点顶部「确认页面…」。
- 选页（单击 / Shift / ⌘）→ 右栏改类型或纳入 → 点「确认所选页面」；
  也可以「确认全部未确认页」。改过类型或纳入的页会自动回到未确认。
- 自动建议只是候选：点「采用建议」才改这一页；建议规则没把握的页不会乱猜。
- 未确认不拦识别：点识别时若还有未确认页，会问一次。
- 回退：`git revert` 本次提交；迁移 0007 只加列，不删数据。

### 界面有没有搞复杂（判断）

没有新增页面，也没有分步向导。加的是**页面视图里的一条汇总栏 + 右栏一段面板**，
选择、批量类型、纳入都复用现有控件；默认只有新项目自动展开一次。
代价是页面视图右栏更长（汇总 + 建议 + 原有类型/识别区），一屏放不下时要滚动。
如果以后要减，优先把"建议列表"收进折叠块，而不是再拆一个新界面。

### 下一步建议

按既定顺序做**多流导出**（正文 / 注释 / 元数据分开）：页面确认已经是块与页的前置状态，
下一刀可以只动导出过滤器，不必再碰识别与页面流程。


### 任务目标

让块的**类型、页内顺序、坐标**在审校视图里看得见、改得动，并让正文组装以它为准。
范围只做"块"这一层：块框拖拽 / 缩放（吸附文字行边界）、改类型、改顺序、
改框后重算「行 → 块」归属（**绝不重跑 OCR**）、块级版面确认。
**不在范围内：** 页面确认步骤（下一包）、多流导出（正文 / 注释 / 元数据分开）、
版面模型、自动刷新版面、启动脚本。

### 当前状态

- 自动分块已经准：`docs/region-classification-eval.md` 在 40 页真书上量过，
  只剔 high 时正文误标 **0/965**、页码 37/37、书眉 37/38；块级比行级好
  （导出路径 CER 0.68% vs 0.71%）。结论是**保持块级判定、不做行级前置剔除、不引入版面模型**。
- 现有 `block` 已具备版面块的全部要素（`block_id / page_id / bbox / block_type /
  order_index / origin / confidence`），`block_line` 已有行级 bbox；缺的是
  「确认状态」与「改框后的行归属」。
- 基线：5 个迁移、**582 passed**；审校视图的块框只用来点击联动，没有拖动与类型着色。
- 说明书 6.4 原文写"不做已有块 bbox 的几何拖拽调整"，本次按新需求改为可编辑，
  已在 D-051 记录为**有意的偏离**。

### 实施计划

1. 迁移 0006：`block.layout_confirmed`、`block_line.layout_status`（只 ADD COLUMN）。
2. 新模块 `core/project/layout.py`：纯函数算行归属（assigned / conflict / unassigned）。
3. `editing.update_block` 接受 bbox 与 layout_confirmed；改框后在同一事务里搬 `block_line`，
   全部记事件、与 `set_bbox` 同 batch、可撤销。
4. 接口：`PATCH /blocks/{bid}` 扩展 bbox / layout_confirmed；页面载荷带上行归属统计。
5. 界面：块框按类型着色 + 常显标签 + 顺序号；拖框 / 拖角缩放吸附文字行；
   改类型 / 上移下移；未归属 / 冲突行画虚线并计数；块级「确认版面」。
6. 导出：figure / decoration 永不输出文本；预检报整本确认数，0 时警告不阻止。
7. 测试 + 真实项目副本迁移 + 手动验收 + 文档。

### 实现与验证

**数据（迁移 0006，只加列、不重建表）：**

- `block.layout_confirmed INTEGER NOT NULL DEFAULT 0`；
- `block_line.layout_status TEXT NOT NULL DEFAULT 'assigned'`
  （CHECK：assigned / conflict / unassigned）。
- 老项目打开即升级，所有块默认"未确认"、所有行默认 assigned；
  确认的人与时间记在 `event` 表，不再加两列。
- **真实项目副本实测：** 复制 `~/Documents/Book2Text/b2t_C0WS5D` 到临时库，
  `schema 5 → 6`，128 个块 / 455 行原样保留，默认值全部正确；随后用这个副本跑完整界面验收。

**行归属（`core/project/layout.py`，纯函数）：**

1. 行与块框有**正面积重叠**才算候选（贴边不算）。
2. 只落一个块 → `assigned`。
3. 落多个块 → `conflict`，归给重叠面积最大的块；面积并列取**面积更小的块**
   （更具体），再并列取页内顺序靠前的块。
4. 都不沾 → `unassigned`，**`block_id` 保持不动**（行不删除、不换块），只改状态。
5. `line_index` 按块内几何顺序重排；无 bbox 的行排块尾。
6. 每一处变化记 `reassign_line` 事件，与 `set_bbox` 同一个 batch——撤销一次整体还原。
7. **不重跑 OCR、不改任何文本**：`Block.text` 仍是导出唯一文本来源。

**接口：**

- `PATCH /projects/{id}/blocks/{bid}` 新增 `bbox`（4 个数、0–1、非退化、最小 0.5%）
  与 `layout_confirmed`；仍走 `expected_revision` 乐观并发。
- 页面载荷新增 `layout_lines`（assigned / conflict / unassigned 计数）、
  `review.layout_confirmed`，每个块多 `layout_confirmed`，每行多 `layout_status`。
- 软删除块的行不再计入页面统计（撤销仍能找回）。

**界面（原生 JS，无构建步骤）：**

- 块框按类型着色（10 种颜色），**标签一直显示**"顺序号 + 类型文字"，
  黑白截图 / 色盲也能读；页眉 / 页脚 / 页码用虚线，插图 / 装饰加斜纹。
- 整框拖动保持大小、四角手柄缩放；拖动时把边吸附到**文字行 bbox 的边**
  （8px 容差）：整体拖动保持大小取最近的一条边，缩放时每条被拖的边各自吸附。
- 改类型、上移 / 下移复用原有接口与菜单；类型改完颜色与标签立即变。
- 未归属行灰色虚线、冲突行黄色虚线；页面标题与横幅给出计数与解释。
- 块操作行新增「✓ 确认版面 / 取消版面确认」，确认后块上出现"✓ 版面已确认"。
- 导出预检多一行"版面已确认 N / M 块"；整本为 0 时给一条警告，**不阻止导出**。

**导出：**

- `figure` / `decoration` 进 `TEXT_FREE_TYPES`，在 `build_segments` 里无条件下线，
  不受"内容类型"开关影响；预检的"排除的块类型"如实列出。
- 正文仍按 `(page_no, order_index)` 组装（现有逻辑），新增"上移后导出顺序跟着变"的测试。

**测试（新增 22 项，总数 582 → 604）：**

- 单元：行归属 6 项（单块 / 多块冲突 / 都不沾 / 并列取小块 / 无 bbox 跳过 / 贴边不算）；
  迁移 2 项（新库列 + 老库默认值）。
- 集成：改框后未归属、跨块搬行、冲突、撤销、非法框 4 种、版面确认与撤销、
  顺序影响导出、figure / decoration 排除、空文本块、页面统计。
- 本地：`.venv/bin/python -m pytest -q` → **604 passed, 1 warning**（80.20 秒，macOS arm64 / Python 3.12.13）。

**CI 实跑（GitHub Actions，真实结果）：** [run #10](https://github.com/CLnum42/book2text/actions/runs/39628786564)
—— **Status: Success**（提交 `f2f2ee4`）。两个 job 都绿：
`全量测试（macOS 14 + OCR）` 2m 21s、`Windows 测试（非 OCR）` 3m 19s；
run 总时长 13m 59s（含 macOS runner 排队）。Actions 页面只有一条
"macOS arm64 可能排队"的容量提示，与代码无关。

**手动验收（真实项目副本，macOS + Chrome）：**

- 打开第 9 页：5 个块框都有"1 段落…5 段落"标签，颜色按类型；
  把第 2 块改成"插图"→ 边框变绿 `rgb(21,128,61)`、标签变"2 插图"，
  导出预览里该块不再出现。
- 拖动第 3 块向下：top 13.66% → 24.49%（高度不变），行归属立即变成
  **冲突 3 行 / 未归属 3 行**，图上黄 / 灰虚线、横幅与块头 chip 同步；
  随后拖右下角缩小：宽 58.73% → 55.43%、高 19.58% → 17.72%，
  四条边**都吸附到文字行边界**（与行 bbox 的 x/y 边逐一比对一致）。
- 改框前后 `ocr_run` 仍为 **21**、`job` 仍为 **3**（没触发重新识别），
  `event` 从 29 条增到 58 条，新增的只有 `set_bbox / reassign_line / set_type / set_layout_confirmed / reorder`。
- 把最后一块上移 → 导出预览的段顺序跟着变；确认第 1 块版面 → 预检从 0/128 变 1/128。
- 老项目默认"未确认"：刚迁移完 128 块全是 `layout_confirmed=0`，界面显示 0/5。

**未验证：** Windows 上的拖拽 / 吸附手感与指针事件（CI 只跑后端测试）；
双栏页面的吸附与冲突判定（真书样本每页单栏）。

### 用户操作说明

- 进「审校」视图：左图块框可拖动、四角可缩放；松手即保存（可撤销）。
- 块类型在右栏下拉框改；"⋯ 更多"里可上移 / 下移；有问题点「✓ 确认版面」。
- 灰色虚线 = 未归属行（行还在，重新拖框收进来）；黄色虚线 = 冲突行（同时落在两个框里）。
- 导出前看预检："版面已确认 N / M 块"；整本 0 也能导，只是给一条警告。
- 回退：`git revert` 本次提交；迁移 0006 只加列，不删数据，老版本代码打开新库会忽略新列。

### 下一步建议

做**页面确认步骤**：把本页所有纳入块的 `layout_confirmed` 聚合成"本页版面确认"，
并作为进入"页面确认"的入口；不改块级数据结构。


### 任务目标

在 40 页真书上量清楚：只靠几何 + 跨页重复 + 文字形态三类信号，把页眉 / 页脚 / 页码的
判断从**块级、分组之后**提前到**行级、分组之前**，判得准不准？
**纯离线实验，不改产品行为**；结论决定下一步做 UI 还是先上版面模型。

### 当前状态

- 产品的页眉页脚是块级判断（`core/project/structure.py`，按页面比例 + 字数 + high/review）。
- 已有的测量口径：`docs/ocr-evaluation.md` 第 6–7 节（行级正文 CER 1.08%、导出路径 0.71%，
  200 DPI），同类脚本写法见 `scripts/measure_divergence.py`。
- 没有行级候选规则，也没有"行级规则准不准"的数字。

### 实施计划

1. 用产品同一条路径（`render_page_image(dpi=200)` + `RapidOcrAdapter`）跑 40 页，缓存行数据。
2. 与分页金标准对齐；匹配不上的 131 行**逐条人工分类**（含 3 处章首回目、插图题字、装饰短线）。
3. 新增 `scripts/region_rules.py`：纯函数判定器（三类信号 + high/review）。
4. 度量检出率 / 误标率 / 漏标率 / 行级与导出路径 CER / 失败清单。
5. 写 `docs/region-classification-eval.md`，加纯函数单测。
   **不碰** `backend/book2text/core/`，不改产品行为。

### 实现与验证

**真跑（本机 macOS arm64，200 DPI，RapidOCR 3.10.0）：**

| 项 | 结果 |
|---|---|
| 40 页识别 | 1064 行，45.5 秒（渲染 + 识别） |
| 金标准对齐 | 933 行（87.7%），131 行人工分类（12.3%） |
| 正文行（含金标准漏收） | 965 行 |
| **正文误标率**（只剔 high / 连 review 也剔） | **0/965（0.00%） / 0/965（0.00%）** |
| 书眉检出 | 37/38 high（97.4%），含 review 38/38（100%） |
| 页码检出 | 37/37 high（100%） |
| 章题 / 回目（9 行） | 0 行 high，9 行 review（**正确**：不能被自动删） |
| 非正文漏标 | 1/75（1.33%）：一段被 OCR 拆开的竖排书眉碎片，3 个字 |
| 行级正文 CER | 2.31% → **1.07%**（剔除 high）；文档基线 1.08%，对上 |
| 导出路径 CER | 2.01% → **0.68%**（块级现状）/ **0.71%**（行级拟改）；文档基线 0.71% |

**结论：规则够用，不引入版面模型；也不建议现在改成行级前置**——导出路径上行级拟改
（0.71%）比块级现状（0.68%）略差，且丢掉了"分组把拆开的书眉并回一块"这个补救；
40 页里没有出现"页眉与正文首行拼进同一块"（42 个块级候选、41 个 high；唯一 review 是
第 37 页那句 18 字的段末正文，零正文误伤）。
详见 `docs/region-classification-eval.md`。

**测试：** 新增 `tests/unit/test_region_rules.py`，10 项全过（合成版面，不依赖 OCR 引擎）：
竖排书眉 → high、页码形态 → high、3 字章题不因相似度过关、段末短行不动、
长行字数保护、书眉拆行碎片只能 review。

**失败与限制（如实记录）：**

- **页脚未测**：这本书没有页脚，`footer` 分支只有合成单测。
- **单本书 / 单 DPI / 单平台**：双栏正文、居中页码、Windows 均未验证。
- **误标率 0% 有构造成分**：正文框取自 OCR 行本身，单栏正文列里的行不可能落在框外；
  真正的风险在多栏正文与章题，章题靠 review 兜住。
- **金标准仍是分页草稿**：缺 48 字回目、第 1 页无标记；行级 CER 受跨页边界影响。
- 顺带发现 `measure_divergence.load_gold_pages` 会丢掉第 1 页（39 个页边界），本次未改它。

### 用户操作说明

```bash
.venv/bin/python scripts/measure_region_classification.py \
    --labels scripts/region-labels-hongloumeng-40p.json \
    --out docs/region-classification-raw.json
.venv/bin/python -m pytest tests/unit/test_region_rules.py -q
```

第一次跑会 OCR 40 页并写审阅清单到系统临时目录；OCR 缓存复用。没有产品行为变化，
回退即 revert 本提交。Windows 未验证（本任务只在 macOS arm64 上跑）。

### 下一步建议

换一本**双栏正文或居中页码 / 带文字页脚**的书，用同一脚本再跑一遍；出现"混合块"或
"居中页脚"的实测失败之前，不改产品、不上版面模型。

---

## 2026-10-21 — 任务 33：加 Windows 非 OCR job，补上 Windows 平台验证的洞

### 任务目标

在 CI 里加一个 `windows-latest` job，跑非 OCR 测试，结束"Windows 平台完全没验证过"。
**不**改产品代码，**不**弱化任何断言，**不**把跳过的测试算成通过。

### 当前状态

- macOS job 已绿（572 项全量，含 OCR）。
- 测试分默认 + `ocr` marker：19 项标记 `ocr`；其中 4 个模块在**导入期**就
  `pytest.skip`（拿不到引擎时），其余 15 项靠 marker 过滤。
- 成本口径更正：Windows runner 私有仓库是 **2 倍**分钟（Linux 1 倍、macOS 10 倍）。

### 实施计划

1. 在 `tests.yml` 加 `pytest-windows` job（只装 `dev`，`-m "not ocr"`）。
2. push 后看真实结果；按失败项区分"测试不跨平台"与"产品 Windows bug"。
3. 测试侧问题修测试；产品问题停下上报。
4. 按 1.2 模板更新文档。

### 实现与验证

**job 配置：**

- `windows-latest`，`timeout-minutes: 20`；只 `uv sync --frozen --group dev`
  （不装 `ocr-eval`，避免 pyobjc 这类平台专属依赖）。
- 跑 `uv run pytest -q -rs -m "not ocr"`，`shell: bash` 以复用同一套守卫。
- **OCR 是 deselect，不是 skip**：macOS job 的"出现 `N skipped` 就失败"守卫原样保留；
  Windows job 另加一条"摘要里必须有 `N deselected`"，证明 marker 过滤确实生效。
- **额外处理：** 4 个 OCR 模块在导入期就 `pytest.skip`，marker 过滤发生在导入之后，
  所以对它们用 `--ignore` 显式排除（写在 workflow 里）。若不排除，摘要会多出
  "4 skipped" 并触发守卫——这是显式排除，不是静默跳过。
- `PYTHONIOENCODING=utf-8` 只改标准输出编码，**不改** `open()` 的默认编码，
  免得掩盖"按本地代码页读写文件"这类真实平台问题。

**CI 实跑（真实结果，两次）：**

| run | 提交 | macOS job | Windows job | 结论 |
|---|---|---|---|---|
| #5 | `ff16e6c` | 572 passed（1m46s） | **11 failed**, 542 passed, 1 deselected（2m41s） | 红 |
| #6 | `f0882b5` | 572 passed, 0 skipped（88.45s / job 1m43s） | **553 passed, 1 deselected, 0 skipped**（107.60s / job 2m14s） | 绿 |

run #5 的 11 个失败，根因只有两类，**都在测试侧，没有产品 bug**：

1. **10 个 `test_collab_round_trip` 用例**：3 处写死 `Path("/tmp")`，Windows 上解析成
   当前盘的 `\tmp`（不存在）→ `FileNotFoundError: '\tmp\....b2tpkg'`。
   判定：测试写得不够跨平台。改为 `tempfile.gettempdir()`。
2. **1 个 `test_auxiliary_needs_a_primary_run_first`**：断言"没识别过的页 → 400"，
   Windows 上拿到 503。查 `run_auxiliary`：第二引擎可用性检查在页状态检查**之前**，
   而 Windows 没有第二引擎 → 先回 503 是**符合设计**的（环境问题优先，不假装能复核）。
   判定：用例隐含依赖"第二引擎可用"，不是产品问题。改为显式注入可用的假第二引擎，
   让"先识别"这道检查在每个平台都能验，而不是把用例从 Windows 上拿掉。

**本地：** `.venv/bin/python -m pytest -q` → **572 passed**，59.28 秒（修完测试后复跑）。

**未验证：** Windows 上的应用层——`scripts/start.bat`、GUI、打包、Windows 系统 OCR
（L-13 / L-31 仍未变）；Linux runner 没加（Apple Vision 不存在，暂没有理由）。

**成本：** run #6 的 run 总时长 8m32s，其中 macOS job 1m43s、Windows job 2m14s，
其余是 Windows runner 排队（不计入执行）。

### 用户操作说明

- 看结果：仓库 **Actions** → `tests`，现在每次 push / PR 有两个 job。
- 本地复现 Windows 那一步：
  `uv sync --group dev && uv run pytest -q -m "not ocr"`（macOS / Linux 上同样可跑）。
- 回退：删掉 `tests.yml` 里的 `pytest-windows` job 即停止 Windows CI。

### 下一步建议

在 Windows 上做一次**应用启动冒烟**（`scripts\start.bat` → 打开界面 → 建项目 →
上传一页），把"测试套件在 Windows 上通过"推进到"应用在 Windows 上能启动"。

---

## 2026-10-21 — 任务 32：清掉"还没做"的过期状态描述，版本号提到 0.1.0

### 任务目标

把代码、接口与界面里六处与实现不符的"未完成"说法改成事实，版本号从 `0.0.0`
提到 **`0.1.0`**（第一个可用完整版），并让所有版本落点一致。
**不改行为逻辑、不改测试、不碰 `.github/`。**

### 当前状态

- 项目已做到 Phase 6：识别（子进程任务）、审校、导出、协作任务包、macOS 打包都已真实跑通；
  代码里却仍有"Phase 0 骨架""审校、导出未完成""现在在做 Phase 8 Step 1（双路 OCR）"等说法。
- 基线：`.venv/bin/python -m pytest -q` → **572 passed**（49.46 秒）。
- 版本号的唯一真源是 `backend/book2text/__init__.py`：`pyproject.toml` 用 hatch `dynamic`
  取它，FastAPI 的 `version`、诊断日志、导出 manifest、协作任务包都读它；
  `packaging/book2text.spec` 的 `CFBundleShortVersionString` 是唯一写死的副本。
- **一条线索与代码不符（按代码纠正）：** `core/pdf/render.py` 的"选型未定"与
  `/api/app/info` 的 `pdf_backend.selected = false` **不是过期描述**。D-009 的状态仍是
  "暂定（Phase 0 第 3 项完成后重新评估）"，`docs/known-limitations.md` 与
  `docs/technical-feasibility.md` 都记着 PyMuPDF 一侧从未安装实测。按 1.6 / 1.7 保留原样。
- **自发现的过期说法（线索没有列出）：** `core/ocr/__init__.py` 说"只有自检、适配器属于
  Phase 2"；`api/routes_projects.py` 说"Job 属于 Phase 2，尚未实现"（任务执行器早已可用，
  只是**缩略图缓存 Job** 还没做）；`core/export/segments.py` 说"存储层尚未实现"；
  `core/storage/streaming.py` 还在提已删除的"Phase 0 临时上传"。
- **自发现的仓库问题：** `packaging/book2text.spec` 被 `.gitignore` 的 `*.spec` 连带忽略，
  从未入库；而 `scripts/build_macos.sh` / `build_windows.bat` 都直接引用它——新克隆无法打包。

### 实施计划

1. 逐条读对应代码与文档，分清"当前状态"与"历史说明"，只改前者。
2. 改六处指定文案 + 自发现的三处；版本号 `0.1.0`，同步打包 spec。
3. `.venv/bin/python -m pytest -q` 全量；手动启动看横幅、curl `/api/app/info` 核对。
4. 更新本日志、CHANGELOG、README、决策记录（D-050）；给 Phase 0 可行性文档加"这是快照"补注。
5. push 后看 Actions 本次 run 是否绿。
   **不在范围内：** `.github/`、任何行为逻辑、测试用例、Windows 打包实测。

### 实现与验证

**逐条对应（以代码为准）：**

| # | 位置 | 原文大意 | 改成 |
|---|---|---|---|
| 1 | `backend/book2text/__init__.py` | "当前处于 Phase 0 骨架，尚无项目、数据库、OCR、审校与导出" | 0.1.0 已具备的能力清单 + 未完成项指向 `known-limitations.md` |
| 2 | 同上 | `__version__ = "0.0.0"` | `"0.1.0"` |
| 3 | `main.py:87` 启动横幅 | "早期版本（识别跑在后台任务里；审校、导出未完成）" | "识别、审校、导出、协作任务包与 macOS 打包已跑通（Windows 打包未验证…）" |
| 4 | `api/routes_app.py:40` `stage` | "Phase 4 已完成；现在在做 Phase 8 Step 1（双路 OCR）" | "Phase 1–6 主流程已跑通；Phase 1 / 3 余项与 Phase 0 对比未完成，Windows 未验证" |
| 5 | `static/app.js:4` 文件头 | "Book2Text Phase 0 骨架的前端……正式前端属于 Phase 1 及以后" | "原生 JS + 一份 CSS，无构建步骤；Vue 3 + TS + Vite 是后续形态（D-046）" |
| 6a | `core/ocr/base.py:12` | "`grouping.py` 尚未实现，所以只提供 lines" | 保留"本层只给 lines"的结论，理由改成 D-012 的分层：块由 `grouping.py` 在识别出口装配 |
| 6b | `core/pdf/render.py:3` | "选型未定" | **不改**：与 D-009 / L（Phase 0 第 3 项未完成）一致，见上 |
| 6c | `core/storage/__init__.py` | "Phase 0 只有骨架用的临时目录" | 列出现状：`project.db`（WAL）、5 个迁移、流式写入、ULID |

**未列出的同类修正：**

- `core/ocr/__init__.py`：改成 base / adapters / selfcheck 三个模块的现状说明。
- `api/routes_projects.py:270`：改成"**缩略图缓存 Job** 还没做（Phase 1 余项）"——
  任务执行器本身是 Phase 2 的成果，不能说成"Job 尚未实现"。
- `core/export/segments.py:15`：`Block` 早已在 `core/project/` 落地，
  改成分层说明（`export/project.py` 从库里读块、装成 `SegmentSource`）。
- `core/storage/streaming.py:3`：临时上传已删除，改成"新建项目导入 PDF 时用"。
- `.gitignore` + `packaging/book2text.spec`：加 `!packaging/book2text.spec` 例外，
  spec 入库并把 `CFBundleShortVersionString` 同步成 `0.1.0`。
- `docs/technical-feasibility.md`：文件头原本写"Phase 0 进行中、只完成第 4 项"，
  而正文第 2 节已有 20/20 页行级坐标等后续实测；改成"Phase 0 实测快照（2026-10-21 补注）"，
  并把"0/7 引擎可用"标注成 2026-10-14 的干净环境结果。

**版本号落点检查：**

- `pyproject.toml`：`dynamic = ["version"]` + `[tool.hatch.version] path = .../__init__.py`，
  **没有**手写版本，未改（`uv.lock` 里 editable 包也不记版本）。
- `api/app.py`（FastAPI `version=`）、`api/diagnostics.py`、`export/project.py`、
  `collab/assignments.py`、`collab/packages.py`：全部读 `__version__`，自动跟随。
- `tests/unit/test_export_jsonl_manifest.py` 里的 `"0.0.0"` 是测试显式传入的样例值，
  不依赖包版本，未改（测试归 QA）。

**本地测试：** `.venv/bin/python -m pytest -q` → **572 passed**，47.83 秒
（全部改完后的最终一次；macOS arm64，Python 3.12.13）。

**手动启动与接口核对（真实输出）：**

```
Book2Text 0.1.0 — 识别、审校、导出、协作任务包与 macOS 打包已跑通（Windows 打包未验证；其余限制见界面「当前限制」）
平台：macOS (arm64)
界面地址：http://127.0.0.1:8919/?token=…（端口 8919，实测可用）
引擎自检：2/7 可用
```

`curl -H "X-B2T-Token: …" http://127.0.0.1:8919/api/app/info` →

```
app: {'name': 'Book2Text', 'version': '0.1.0', 'stage': 'Phase 1–6 主流程已跑通；Phase 1 / 3 余项与 Phase 0 对比未完成，Windows 未验证'}
pdf_backend: {'name': 'pypdfium2', 'version': '5.14.0', 'selected': False}
```

接口的 version / stage 与代码一致；`selected: false` 是 D-009 的真实状态，不是漏改。
看完横幅后已关闭服务。

**CI 实跑（GitHub Actions，真实结果）：** [run #4](https://github.com/CLnum42/book2text/actions/runs/39614046309)
—— **绿**。`全量测试（macOS 14 + OCR）` 耗时 1m 47s，run 总耗时 1m 51s；
测试结果 **572 passed, 1 warning in 89.57s，0 skipped**。同一任务的前一个代码提交
（`bce6d52`）的 [run #3](https://github.com/CLnum42/book2text/actions/runs/39613191107)
也是绿（1m 57s，572 passed / 97.68s）。`0 skipped` 正是 workflow 的防假绿校验
（出现跳过即失败），通过说明识别与 Apple Vision 测试都真跑了。
唯一 annotation 是 runner 容量提示（macOS arm64 可能排队），与代码无关。

**未验证：** Windows 打包与 Windows 平台行为（L-31，本任务不涉及）；
macOS 应用包没有重新打包，`CFBundleShortVersionString` 的新值只做了代码同步。

### 用户操作说明

- 看版本：启动横幅的第一行，或界面「设置 → 环境 → 版本」；接口是 `/api/app/info`。
- 本地复现测试：`cd <仓库> && .venv/bin/python -m pytest -q`。
- 回退：`git revert <本次提交>`。本次只改文字、版本常量与一条 `.gitignore` 例外，
  不涉及数据与接口行为，回退不影响已有项目。

### 下一步建议

补 Phase 0 遗留的**第一引擎对比**（同一批页面上跑 PaddleOCR，补版面组件评估），
把 `render.py` / `pdf_backend` 里"暂用 / 未选定"这类说法一次性变成有结论的状态。

---

## 2026-10-21 — 任务 31：GitHub Actions CI（解除 L-14）

### 任务目标

push 到 `main` 或开 PR 时自动跑全套测试，解除 L-14「没有 CI」。
**不**改应用代码，**不**改测试，**不**碰远端配置。

### 当前状态

- 仓库里没有 `.github/`，从未配过 CI；572 项测试只靠本机 `pytest` 手动跑（48 秒）。
- 测试分两拨：默认 + `ocr` marker。`ocr` 组需要 `uv sync --group ocr-eval`，
  没装时**整组跳过**——CI 若不装这组，识别相关的核心断言等于没跑。
- 第二引擎测试（Apple Vision）darwin-only，模块导入时就判断可用性。

### 实施计划

1. 新建 `.github/workflows/tests.yml`（macOS + dev + ocr-eval）。
2. push 后打开 Actions 看真实结果；红了查原因、修、再推。
3. 按 1.2 模板更新开发日志、README、已知限制、CHANGELOG。
   **不在范围内：** Windows / Ubuntu runner、打包、发布、应用代码。

### 实现与验证

**workflow 要点（[`.github/workflows/tests.yml`](../.github/workflows/tests.yml)）：**

- **触发：** push 到 `main` + `pull_request`；`paths-ignore: docs/**, **/*.md`。
  用"忽略"而不是路径白名单——将来新增目录（`scripts/`、新包）不会漏跑。
- **runner：** `macos-14`，`timeout-minutes: 25`；`concurrency` 同分支新 push 取消旧 run。
- **依赖：** `astral-sh/setup-uv@v10.3.0`，锁 `uv 0.12.3`（生成 `uv.lock` 的版本）
  与 Python 3.12；`uv sync --frozen --group dev --group ocr-eval`。
  `--frozen` 保证 CI 不会偷偷改锁文件。
- **跑什么：** `uv run pytest -q -rs`，不按 marker 排除任何用例。
- **防假绿：** 摘要里出现 `N skipped` 就让 job 失败。跳过 ≠ 通过：
  样本缺失、ocr-eval 没装、平台不支持都会让结果"绿"，但那是假绿。
- **缓存：** uv 缓存（setup-uv 自带）+ RapidOCR 模型
  （`.venv/lib/python3.12/site-packages/rapidocr/models`，约 31 MB，缓存传输约 26 MB，首次识别从 modelscope.cn 下）。
  模型缓存 key 用 `uv.lock` 哈希。**依据：** 私有仓库 macOS runner 按 10 倍分钟计费，
  不能让每次 run 都等一次跨境下载。
- **action 版本：** 首跑用 checkout@v4 / cache@v4 / setup-uv@v6，GitHub 提示这三个
  仍指向 Node 20、被强制跑在 Node 24 上；已升到 checkout@v7 / cache@v6 /
  setup-uv@v10.3.0（输入参数不变），警告消失。

**本地验证：** `.venv/bin/python -m pytest -q` → **572 passed**，48.45 秒
（本机沙箱里 `uv run` 拿不到 uv 缓存，故直接用 venv 里的解释器；CI 上仍用 `uv run`）。

**CI 实跑（GitHub Actions，真实结果）：**

| run | 提交 | 结论 | 测试耗时 | job 耗时 |
|---|---|---|---|---|
| #1 | `373c8cc` | 绿：**572 passed, 0 skipped** | 129.20 s | 2 m 30 s |
| #2 | `106c3ce` | 绿：**572 passed, 0 skipped** | 111.51 s | 2 m 17 s |

- #1：RapidOCR 模型缓存未命中（首次），测试里现下模型；`安装依赖` 步骤 2 s（uv 下载 47 个包）。
- #2：模型缓存**命中**（`Cache restored from key: rapidocr-models-…`，约 26 MB），
  总时长缩短约 14 s；Actions 页只剩一条"macOS arm64 排队"提示，无 Node 20 警告。
- 两次都确认了 `0 skipped`：Apple Vision 第二引擎测试在无图形会话的 runner 上**可用**，
  因此**没有**需要排除的用例，也没有弱化断言。

**未验证：** Windows 与 Linux runner 上的测试（本 workflow 只跑 macOS）；
Windows 平台能力本身仍见 L-31。

### 用户操作说明

- 看结果：仓库 **Actions** → `tests`；每次 push / PR 自动出现。
- 本地复现：`uv sync --group dev --group ocr-eval && uv run pytest -q`。
- 回退：删除 `.github/workflows/tests.yml` 即停止 CI，仓库其他部分不受影响。

### 下一步建议

加一个 Windows runner 的**非 OCR** 测试 job（`-m "not ocr"`），把跨平台问题提前暴露——
Windows 是目前唯一"完全未验证"的平台，而它跑 1 倍分钟，比 macOS 便宜得多。

---

## 2026-10-15 — 任务 30：修"新建项目报错"（界面资源缓存策略）与去掉多余入口

### 任务目标

用户实测反馈两条：

1. **新建项目报错**：项目库里出现红色提示 `Cannot set properties of null (setting 'hidden')`。
2. **项目库列表下方那个"＋ 新建项目"按钮是多余的**（顶栏已经有一个）。

### 当前状态与原因

**报错不是新建流程本身的 bug，是"新页面配旧脚本"。** 证据是截图里的
`（（/Users/chenlin/Documents/Book2Text））`——双括号：外层是**新** `index.html` 里写死的
中文括号，内层是**旧** `app.js` 自己拼的括号。旧脚本里 `renderProject` 会执行
`el("project-card").hidden = false`，而新页面已经把这个节点去掉了，于是抛
"setting 'hidden'"——正是用户看到的那句。

根因：`/` 与 `/static/*` 的响应**没有 `Cache-Control`**，浏览器按启发式规则缓存
`app.js` / `app.css`；界面是**就地更新**的（换掉 `static/` 下的文件就算升级），
三份文件中只要有旧有新，页面就会半新半旧、报出与当下代码无关的错误，用户只能强制刷新。

**新建流程本身是好的**：用真实 PDF 字节直接调用 `createProjectFromFile()`
（对话框里的"选择 PDF…"是系统文件选择框，浏览器自动化点不了，因此绕过它、
走它后面那条完全相同的代码路径）——无任何异常，对话框关闭、项目建出、
自动进入项目、3 页瓷砖都在。

### 实施计划

1. `/` 与 `/static/*` 加 `Cache-Control: no-cache`（回源确认，没变就 304）。
2. 删掉项目库列表下方的"＋ 新建项目"卡片（`#pick-pdf-2`）与它的样式。
3. 加 5 条测试把这套约定钉住（含"脚本引用的 id 必须都存在"这条防回归）。
4. 重启服务实测；更新文档。

### 实现与验证

**改动：**

- `api/app.py`：新增 `REVALIDATE = "no-cache"` 与 `_RevalidatingStaticFiles`
  （给 `/static` 下每个响应补头）；`/` 的 `FileResponse` 直接带头。写清了为什么不用
  `no-store`：本地应用每次刷新都重传三份文件没必要，`no-cache` + ETag 已经能保证一致性。
- `static/index.html` / `app.js` / `app.css`：删掉 `#pick-pdf-2` 卡片及其事件与样式
  （空库时页面那句"点右上角的「＋ 新建项目」"就是唯一入口）。
- 新增 `tests/integration/test_ui_assets.py`（5 条）：三份资源都 `no-cache`、
  没变时仍走 304、`app.js` 用到的 id 必须都在页面里、页面必须有四个视图容器与顶栏两组内容。

**离线测试：** `uv run pytest -q` → **572 passed**（567 + 5）。

**真机验证（macOS · Chrome）：**

| 步骤 | 结果 |
|---|---|
| 响应头 | `/` 与 `/static/app.js`、`/static/app.css` 都是 `Cache-Control: no-cache` + ETag；带 ETag 二次请求 **304** |
| 项目库 | 列表下方不再有重复的"新建项目"按钮（顶栏那个仍在）；空库时显示"点右上角的「＋ 新建项目」导入一本 PDF 开始" |
| 新建项目（绕过系统文件选择框，走同一段代码） | 无异常：对话框关闭、项目建出、自动进入项目、3 页瓷砖、项目库出现该卡片 |
| 打开已有项目 | 无异常；顶栏显示《新建流程实测》、3 页瓷砖 |
| 首次运行对话框 | 顺带实测（任务 29 里列过"未实测"）：给新库填名字 → "已记下名字：界面实测" → 对话框关闭 |

**未验证：** 浏览器**已经**缓存着旧 `app.js` 的老标签页**不会自动变好**——新头只对之后
的请求生效，用户需要**强制刷新一次**（⌘⇧R）才能拿到一致的三件套。这一条是限制，不是 bug。

### 用户操作说明

1. **停掉应用再打开**（你现在跑着的那个进程内存里还是旧代码，不加新响应头）：
   `Ctrl+C` 后重新执行 `./scripts/start.command`。
2. 浏览器里**强制刷新一次**：macOS `⌘ + Shift + R`，Windows `Ctrl + Shift + R`。
   之后新页面 + 新脚本 + 新样式就对齐了，这类"半新半旧"的错误不会再出现。
3. 你新建的那个项目（`b2t_YTA7R0`）本身没坏，刷新后直接点"打开"就行。

**回退：** `git revert <本次提交>`。缓存策略只在响应头上，不涉及数据。

### 下一步建议

**给界面加一个极小的"版本戳"，让"页面与脚本对不上"能被一眼看出来。** 现在虽然不再会
半新半旧（`no-cache` 保证），但如果用户从别处（比如网盘同步的旧副本、打包的旧 `.app`）
打开了旧页面，症状仍是"说不清哪来的报错"。做法：`/api/app/info` 已有 `version` 与
`stage`，页面启动时把它写进 `document.body.dataset.appVersion`，脚本里核对一次，
不一致就在顶栏挂一条提示——成本很低，能把"环境问题"与"代码问题"分开。

---

## 2026-10-15 — 任务 29：按 UI 效果图全面改写界面（单窗口外壳 / 四个视图 / 对话框）

### 任务目标

把界面从"一页到底的卡片堆叠"改成 `docs/ui-mockups/` 六张效果图里的**单窗口应用形态**：
顶栏（项目名 / 页面·审校页签 / 导出 / 保存状态 / 任务 pill）+ 四个视图（项目库 / 页面 /
审校 / 合并审阅）+ 若干对话框（新建项目、结构工具、导出、任务包、质量统计、设置、首次运行）。

**不在范围内：** 说明书第 6 节的 Vue 3 + Vite 正式前端（本次仍是原生 JS、无构建步骤）；
缩略图后台缓存 Job（仍按需渲染）；深色模式与多语言。计划见
[`docs/ui-redesign-plan.md`](ui-redesign-plan.md)。

### 当前状态（开工前）

- 前端是三件套：`backend/book2text/static/index.html`（573 行，长页面）、`app.css`（649 行，
  通用卡片样式）、`app.js`（4193 行，接口与业务逻辑齐全）。
- 效果图是**静态原型**（`docs/ui-mockups/*.html` + 截图），本身不可运行；改写等于把
  它们的版式、组件与信息层级落进真实界面。
- 有一处真实数据缺口：效果图 01 的项目卡要显示"审校进度"，而 `/api/projects` 只有识别计数。
- 测试基线：567 passed（Phase 5 结束时 565 + 本次新增 2）。

### 实施计划（6 个阶段，每阶段一次提交）

1. **A 外壳 + 项目库**：重写 `index.html` / `app.css`，加 `showView()` 视图路由与对话框层；
   项目卡改成"封面 + 识别 / 审校两条进度 + 上次位置 + 打开"；后端补审校计数。
2. **B 页面视图**：筛选栏 + 缩略图网格（悬浮出识别 / 审校）+ 右侧已选面板 + 任务抽屉。
3. **C 审校视图**：左原图（块框牌子、缩放工具栏、框选新增块）+ 右块列表（类型标签、
   状态 chip、编辑框、操作行）+ 底部操作条（撤销 / 重做 / 块 N/M / 确认本页并下一页）。
4. **D 对话框 + 合并视图**：结构工具、导出（预检 + 对照预览）、任务包，合并审阅三列。
5. **E 设置 / 自检 / 诊断**：名字、引擎自检表、环境、当前项目、当前限制、诊断日志。
6. **F 实测与文档**：逐视图与效果图对照，更新文档。

### 实现与验证

**离线测试：** `uv run pytest -q` → **567 passed**。新增 2 条集成测试覆盖项目库的新计数
（`test_listing_shows_review_progress`：识别前 0 → 认完仍 0 → 确认整页才 1 → 标不确定又回到 0；
`test_listing_shows_last_position`：上次位置记到 reviewer 视图与第 N 页）。

**后端改动（唯一的接口改动，纯增量）：** `core/project/library.py` 的 `_PageCounts` 用一次 SQL
现算 `reviewed_pages`（纳入页里"块都已确认"的页）、`uncertain_blocks`、`failed_pages`
（试过但没成功、现在也没有可用结果——与 `blocks.STATUS_FAILED` 同口径）、以及上次停留的
`last_page_no` / `last_page_label`。**理由：** 项目库一屏十几个项目卡，不能为每张卡把整页的
块读进内存；`/api/projects` 的路径与其余字段都没动。

**真机验证（macOS · Chrome · 1440×900，项目库里的 20 页扫描样本）：**

| 视图 | 实测结果 |
|---|---|
| 项目库（效果图 01） | 卡片显示识别 `20 / 20 页`＋"已认完"、审校 `0 / 20 页`、上次位置"审校 · 第 N 页"；被另一个实例占用的项目显示"使用中"并给出只读 / 强制打开；"＋ 新建项目"虚线卡片 |
| 页面视图（02） | 20 个缩略图；单击选中、Shift 选一段（"已选 4 页 · 第 8–11 页"）、⌘ 加减；页码范围 `3-5` → 选中 3 页；筛选（类型 / 识别 / 审校 / 只看纳入）生效；右侧面板批量纳入排除、识别所选、复核所选；任务 pill 点开抽屉显示最近任务与操作按钮 |
| 审校视图（03） | 左原图 + 块框（页眉 / 页码 / "不确定"块挂小牌子）+ 缩放（－／＋／适合宽度）与"显示块框"；右块卡片：类型标签、状态 chip、标记（已修改 / 延续到下页 / 两路不一致 / 无位置信息 / 导出时排除）、编辑框、操作行（只在当前块或鼠标停上去时出现，与效果图一致）；底部 撤销 / 重做 / 块 N/6 / 确认本页并下一页；顶栏翻页"第 2 页"、跳转、按疑难类型翻 |
| 结构工具（04） | 左规则（区域百分比 / 字数上限 / 页码形态 / 只作用正文页）→ 预览"找到 7 个（默认勾选 7 个有把握的）：页眉 7"→ 右侧逐个勾选 → "应用标注（7 个块）" |
| 导出（05） | 左选项（格式 / 范围 / 页面类型 / 内容类型 / 清理规则）→ 右预检摘要（页数、段数、字数、断词还原、未审段数、排除的块类型）与警告 → 对照预览（左原图、右分段，点一段跳来源页并高亮）→ 生成 TXT（第 1–2 页实测：`clean.txt` + `manifest.json`，导出记录可回看、可下载） |
| 合并审阅（06） | 三列：左页列表（`p.1 块级修改 6 💬1`）、中原图 + 改动块高亮（6 个蓝框，图下注明"改动 6 块"）、右逐条变化卡片 + 底部"拒绝本页 / 接受本页"；顶栏 变化 1 页 / 块级修改 1 / 冲突 0 / 💬 备注 1；接受后"已决定：接受本页（可改回来）"→ 提交"已合并 1 页（可撤销）" |
| 设置 | 名字与保存、引擎自检表（7 项中 2 项可用：RapidOCR 3.10.0 与 Apple Vision 12.2.2）、环境与版本、当前项目信息、当前限制、导出诊断日志（实测下载 `book2text-diagnostics-20261015-1323.txt`） |
| 协作链路（复用任务 28 的往返，但全部走新界面） | 分派第 1–3 页 → 助手端打开任务包（横幅、隐藏识别 / 结构工具 / 导出、"导出审校结果"按钮）→ 改文本 / 标不确定 / 加备注 / 确认本页 → 导出结果包 → 负责人导入 → 合并审阅接受 → 提交 |

**实测中抓到并修好的三个真实问题（都不是"样式"问题）：**

1. **块文本自动保存会顶掉光标**：保存后整页重渲染，正在编辑的编辑框被换掉，光标与焦点丢失
   （打字打到一半停 0.7 秒就会触发）。修法：保存前记下"正在改哪一块、光标在哪"，重渲染后
   接回去（`captureEditorFocus` / `restoreEditorFocus`）；实测打字后焦点与光标位都保留（caret 130）。
2. **任务包里的页面被显示成"未识别"**：任务包里的块是随包带进来的快照，没有识别运行记录，
   后端按 `active_run_id` 推导出 `unrecognized`——助手明明有块可审，界面却提示"点重新识别"
   （而任务包里根本没有识别功能）。修法：界面按"已带入 N 块"显示，审校视图的提示改成
   "任务包不做识别，直接审校即可"。
3. **助手端仍能看到"任务包 / 分派审校"入口**：助手不派活给别人，现在隐藏。

另外修了一处布局缺陷（审校视图放大后用 flex 居中会把左边裁掉，改用 `text-align` 居中）、
一处"点缩略图选页被悬浮按钮挡住"的遮挡问题，以及"继续到上次那一页"没生效
（项目载荷给的是 `last_page_id`，而项目库列表给的是页码，两个接口的字段不同——
在项目载荷上按 page_id 反查页码后修复，实测打开项目直接落在审校视图第 1 页）。

**与效果图的有意偏差（都写在计划里，不是漏做）：**

- 缩略图多了一行**悬浮操作**（识别 / 审校）：效果图上没有，但去掉就等于砍掉"单页识别"。
- 结构工具的预览是**候选列表**（页码 · 类型变化 · 文本 + 勾选框），不是效果图里的
  抽样缩略图：列表能一屏看更多、能逐个取消，缩略图只能看三张。
- 合并视图的原图高亮依赖块的 `bbox`；没有位置信息的块会在图上写明"无法圈出来"，不画假框。
- 顶栏不放"平台 / 版本"标签（效果图也没有），这些信息收进设置对话框的「环境」一节。

**未验证项（必须诚实记录）：**

1. **Windows 上一个像素都没看过**：本次全部实测都在 macOS + Chrome（L-33）。
2. **Safari / Edge / Firefox 未验证**。用到的 CSS 里有 `:has()`（导出对话框的小胶囊）、
   `aspect-ratio`、`inset` 等较新的特性，Chrome 118+ 正常，Safari 需要 17.4+；
   未在其他浏览器里打开过（L-33）。
3. **窄屏布局未实测**：审校视图在 <1180px 时改成上下布局、页面视图在 <1120px 时右侧面板
   收到下面，代码写了但没有在那些宽度下真正看过。
4. **合并视图只在"块级修改"这一种分类上跑过**：冲突（两边改同一块）与结构变化
   （助手增删块）的三栏对照没有在新界面里实测，只有后端测试覆盖。
5. **首次运行对话框与"缺令牌"提示**：任务 29 里没实测；首次运行对话框已在任务 30 补测
   （给新项目库填名字 → "已记下名字"），"缺令牌"提示仍未实测。

### 用户操作说明

**看新界面：**

```bash
cd ~/Desktop/软件开发/book2text
./scripts/start.command          # 或 uv run book2text
```

浏览器打开后就是**项目库**；点任意项目进**页面视图**，双击缩略图或点悬浮的"审校"进**审校视图**，
顶栏"导出""结构工具""任务包""质量统计""设置"都在各自的位置上。

**回退：** 本次只改前端三件套（`index.html` / `app.css` / `app.js`）与 `library.py` 的只读计数：

```bash
git log --oneline                      # 找本次三个提交：542a4f8 / 0c655a4 / 1c83b43
git revert 1c83b43 0c655a4 542a4f8     # 或 git checkout 64749ee -- backend/book2text/static
```

数据没有迁移、没有改表结构，回退不会动项目库里的任何项目。

**本次实测在项目库里留下的东西（都已清理）：** 分派给"测试助手"的任务包已**作废**、
合并写入已**撤销**、助手端项目文件夹已删除；主项目里多了两条导出记录
（第 1–2 页的 `clean.txt` 与 `manifest.json`，在 `exports/` 里，是正常产物，保留）。

### 下一步建议

**在 Windows 上打开一次新界面，只做"看"这一步（项目库 → 页面 → 审校 → 导出对话框），
把看到的差异记下来。** 理由：这次改的正是布局与组件（flex 高度、`overflow`、`100vh`、
`aspect-ratio`、`:has()`、中文字体回退），这些恰恰是最容易在两个平台上表现不同的部分；
而说明书第 10 节要求双平台一致，现在只有 macOS 一侧有证据。

---

## 2026-10-14 — 任务 28：Phase 5 审校任务包（分派 → 助手审校 → 回传 → 合并）

### 任务目标

按说明书 6.7 / 7.9 做团队协作：**分派任务包**（`.b2tpkg`）、**助手端审校包模式与权限限制**、
**块备注**、**结果包**（`.b2tres`）、**导入校验与逐页分类**、**合并审阅视图**
（字符级差异 / 冲突 / 整页接受）、**分派状态与作废**。

**验收（说明书 Phase 5）：** "场景 G 在'Mac 负责人 + Windows 助手'和'Windows 负责人 + Mac 助手'
两种组合下都通过"。本机只有 macOS：**在 macOS 上用两个应用实例（两套项目库）跑通了完整往返**，
Windows 侧未验证（与 L-13 / L-31 同一条限制）。

### 实施计划

1. 迁移 0005：`assignment` 表 + `project.kind`（main / package）+ `page.is_context` /
   `page.pdf_page_index`（任务包的 PDF 是子集，页码与下标不再相等）。
2. `core/collab/assignments.py`：预览（哪些页能派 / 为什么跳过 / 估算大小）、建分派、
   基准快照、生成 `.b2tpkg`、作废、重新导出。
3. `core/collab/packages.py`：打开任务包成审校包项目（页 id 沿用）、导出结果包。
4. `core/collab/merge.py`：导入校验、逐页分类（无变化 / 块级 / 结构 / 冲突）、接受写入。
5. 接口：`/assignments*`（负责人）、`/packages/open` 与 `/package/*`（助手）、
   `/results` 与 `/{aid}/merge`（导入与合并）；两道权限守卫。
6. 界面：分派对话框 + 任务包列表；助手端横幅与功能收窄、块备注、「导出审校结果」；
   合并审阅视图（页列表 + 筛选 + 字符级差异 + 冲突三栏 + 接受 / 拒绝 + 提交）。
7. 测试 → 真机往返 → 文档。

### 实现与验证

**离线测试：** `uv run pytest -q` → **565 passed**（原 540 + 25：分派 14 + 往返 10 + 渲染并发 1）。

| 新增覆盖 | 说明 |
|---|---|
| 分派预览 | 未识别 / 已排除 / 已在别的任务包里的页被排除并说明原因；上下文页与体积估算 |
| 任务包内容 | zip 里恰好是 `package.json` + `data.json` + `source/subset.pdf`；页序与 `pdf_index` 对得上；子集 PDF 页数正确 |
| 快照语义 | 重新导出用**原来那份快照**（负责人后来改的正文不混进任务包） |
| 作废 | 页面恢复未分派、可以重新分派；重复作废报错 |
| 权限（服务端） | 审校包里识别 / 复核 / 页面类型与纳入 / 页眉页脚工具 / 导出 TXT 一律 403；**块编辑仍然允许** |
| 只读上下文页 | 改块、新增块都 403（按块找页 / 按页码判两条路都测了） |
| 往返：块级修改 | 文本 + 确认 + 备注 → 分类为块级修改 → 接受 → 主项目文本与状态更新、`reviewed_by=助手`、事件 `actor=reviewer`+`package_id`、整批可撤销 |
| 往返：结构变化 | 助手拆块 → 分类为结构变化、`accept_scope=page` → 整页接受后主项目块数 +1 |
| 往返：冲突 | 两边改同一块 → 冲突 → 三栏给出"分派时 / 我的 / 助手的" → 保留我的则主项目不动、任务包转"部分合并" |
| 导入校验 | 项目不符 / 书不符 / 序号不新（可显式放行）/ 任务包已作废（可显式确认）逐一拒绝并说明 |
| 多次回传 | 第二次导入只显示尚未合并的变化（已合并的块不再提示） |
| 并发渲染 | 12 线程同时渲染同一份 PDF 不失败（pdfium 不是线程安全的，见下） |

**真机验证（macOS，两个应用实例 / 两套项目库，浏览器操作）：**

| 步骤 | 结果 |
|---|---|
| 负责人：分派第 1 页给张三 | 预览"可派 1 页 ＋ 只读上下文 1 页；约 0.2 MB"→ 生成 → 列表显示"张三 · 第 1 页 · 已发出" → 页瓷砖出现"张三 · 审校中" |
| 下载任务包 | `sample-20p-3_p1-1_张三_20261015.b2tpkg` |
| 助手：打开任务包 | 项目库出现"… · 审校任务（第 1–1）"，横幅"审校任务：第 1 页（另附只读上下文第 2 页）· 来自 李四 · 说明：…"；识别 / 结构工具 / 导出卡片全部消失；上下文页瓷砖标"只读上下文" |
| 助手：审校 | 改文本"第二十七回（张三核对）"、加备注、点"✓ 确认"；总览变为"已确认 1 · 已修改 1" |
| 助手：导出结果包 | 2.5 KB 的 `.b2tres`，摘要"已完成 0 页，未完成 1 页 / 不确定 0 / 备注 1 / 改过 1 块" |
| 负责人：导入 | 合并视图"第 1 页 · 结果 1 · 变化 1 页 · 块级修改 1 · 备注 1"；差异里 `ins` 只高亮"（张三核对）"，状态与备注各一行 |
| 负责人：接受并提交 | "已合并 1 页（可撤销）"，任务包状态转"已合并"；打开那一页看到文本、状态"已确认"、💬 备注都在 |
| 撤销 | ⌘Z 之后文本退回"第二十七回"、状态回到未审 |

**真机抓到的三个问题（都已修）：**

1. **pdfium 不是线程安全的**：分派时 `import_pages` 报 "Failed to import pages."，
   同时缩略图接口报 "Failed to load page."（线程池并发渲染）。修法是给 `render.py`
   所有碰 pdfium 的函数套一把进程内锁（`@_serialized`）；这条**在协作之前就潜伏着**
   （缩略图会偶发失败），有并发回归测试。
2. **任务包的子集 PDF 与页码对不上**：图片接口按 `page_no - 1` 渲染，而子集里第 1 页
   可能是原书第 87 页。修法：`page.pdf_page_index` 记下标，图片接口按它渲染；
   子集文件仍叫 `original.pdf`（它就是**这个项目**的源文件），避免到处特判文件名。
3. **合并状态里没有页码**：`assignment` 记录只有页 id，界面要显示"第 N 页"。
   修法：`MergeState.to_dict()` 带上 `page_nos`。

另外还修了两处界面小问题：审校包横幅建好之后没有取消 `hidden`；
"加备注"按钮在没有备注的块上根本没被插进 DOM。

### 用户操作说明

**负责人：**

1. 页面网格里选中要分派的页 → 「分派审校…」→ 填审校人（有历史下拉）/ 截止日期 / 说明
   → 看预览（会跳过未识别、已排除、已在别人任务包里的页）→ 「生成任务包」。
2. 生成后可以「下载任务包」发给助手，或「在文件夹中显示」拷贝给他。
3. 助手回传结果后：任务包列表里点「导入结果」→ 合并审阅视图：左列页列表（可按冲突 /
   结构变化 / 块级修改 / 备注 / 未处理筛选），右侧是差异——文本改动是**字符级**的
   （删除线 + 高亮），冲突项三栏并列（分派时 / 我的 / 助手的）。
4. 「接受本页」/「拒绝本页」，或者「接受所有无冲突的变化」一次处理；处理完点
   「提交 N 页的决定」——整批可 ⌘/Ctrl + Z 撤销。
5. 助手做不下去时点「作废」：页面恢复未分派；之后收到的结果要明确确认才能导入。

**助手：**

1. 项目库点「打开任务包（助手）」选 `.b2tpkg` → 顶部横幅写明任务范围、来源、截止与说明。
2. 审校视图与负责人一样，只是没有识别 / 页眉页脚工具 / 导出 TXT；上下文页只读。
3. 每块可以「💬 加备注」；改完点右上「导出结果包」——允许分多次导出（每天发一次进度）。

### 下一步建议

1. **在 Windows 上把这轮往返再跑一遍**（说明书 Phase 5 的验收就是"两种组合"）：
   与 L-31 的打包验证合并做一次——`scripts\build_windows.bat` → 双击 exe → 打开任务包
   → 审校 → 导出结果包；负责人侧在 macOS 上导入合并。
2. 说明书 7.9.3 还差两处小东西：合并视图的**快捷键**与冲突的**"编辑后确认"**入口
   （现在用"保留我的 → 到审校视图改"代替，见 D-045）。
3. 协作跑通之后，README 的"现在能做什么"要补一段协作流程，两份用户手册也要把
   "现在还不能协作"的说法改掉（**本次已改**）。

## 2026-10-14 — 任务 27：Phase 6 分发与稳定（macOS 打包实测；Windows 备好配置）

### 任务目标

按说明书 Phase 6 做四件事：**PyInstaller 打包**（双击启动、自动开浏览器）、
**首次运行环境检查（含填写"我的名字"）**、**"导出诊断日志"入口**、
**两份简短用户手册**（负责人 / 助手）。

**范围内但做不到的：** Windows x64 的打包与运行验证——本机是 macOS，
没有 Windows 机器。按说明书 1.7 处理：**配置与脚本备好，如实标注"未验证"**，
不写成"Windows 版可用"。

### 实施计划

1. 打包：`packaging/book2text.spec` + `packaging/entry.py` + 两个平台的构建脚本；
   让打包后的可执行文件**兼作识别子进程**（`--b2t-worker`）。
2. 设置：`core/settings.py`（`<项目库>/.settings.json` 里的"我的名字"）+
   `GET/PUT /api/app/settings`；名字作为审校事件的 `actor_name`。
3. 诊断日志：`api/diagnostics.py` + `GET /api/app/diagnostics`（纯文本下载）。
4. 手册：`docs/manual-owner.md`、`docs/manual-assistant.md`。
5. 测试 → 打包 → 在**打包版**里真机走一遍 → 文档。

### 实现与验证

**离线测试：** `uv run pytest -q` → **540 passed**（原 531 + 9）。

| 新增覆盖 | 说明 |
|---|---|
| 首次运行与名字 | 没有设置文件 → `first_run`；存名字 → 落 `<项目库>/.settings.json`；长度与空白都处理 |
| 设置读坏了 | 不报错，当作"没设置"（不能因为一个坏文件挡住用应用） |
| 名字进事件 | 界面不传 `actor_name` 时用设置里的名字；显式传了就用传来的（协作包要用） |
| 诊断日志：不含识别文本 | 先断言确实认出了字，再断言报告里**一个字都没有** |
| 诊断日志：不含家目录 | 报告里不出现 `str(Path.home())`；项目库路径整个略去 |
| 诊断日志：该有的都在 | 版本、平台、引擎自检、项目统计、任务日志末尾、项目 id |

**打包与真机验证（macOS arm64，`dist/Book2Text.app`，290 MB）：**

| 验证项 | 结果 |
|---|---|
| 双击启动 | `.app` 启动，自动打开浏览器（命令行验证用的是包内可执行文件 + `--no-browser`） |
| 首次运行检查 | 卡片列出"平台：macOS (arm64) —— 受支持 / PDF 后端：pypdfium2 5.14.0 —— 可用 / OCR 引擎：2 / 7 项可用 —— 可以开始识别" |
| 填写我的名字 | 保存后卡片消失，设置区显示"现在以「…」的名义记录改动" |
| 建项目 + 识别 | 20 页样本 PDF → 第 1 页识别成功（6 块，"第二十七回"）——**打包环境里 rapidocr + 模型 + 子进程都跑通了** |
| 子进程控制 | 两页识别任务：暂停（"已暂停 · 当前第 3 页"）→ 继续 → 完成 2/2 |
| 第二引擎复核 | 打包版里 Apple Vision（pyobjc）可用：26 行 / 1.7 秒 / 4 处分歧 |
| 导出诊断日志 | 浏览器下载 `book2text-diagnostics-20261014-2240.txt`；报告写着"运行方式：打包运行（PyInstaller）"；**不含识别文本**（grep 为 0） |

**打包过程里修掉的两个真问题（都只有真跑才会暴露）：**

1. **子进程的 `--b2t-worker` 分派放在 argparse 之后** → 子进程以
   "unrecognized arguments: --project-dir / --job" 退出，任务永远停在排队中
   （`logs/ocr-*.log` 里留着证据）。改到 argparse **之前**分派。
2. **PyInstaller 6 的 TOC 是三元组**：事后 `a.datas += collect_all(...)` 的两元组
   会报 "not enough values to unpack"。改成在 `Analysis` **之前**收集。
   （另有一处 `LibraryPageSummary` 没有 `.project_id` 属性——它在真机上被诊断日志撞出来了。）

### 用户操作说明

- **双击 `dist/Book2Text.app`**（首次要右键 →「打开」，未签名）。
- 首次运行会做环境检查并请你填名字；之后在「设置」区可以改。
- 出问题点「导出诊断日志」，把那个 txt 发给开发者——它不含识别文本与你的个人目录路径。
- 两份手册：[`docs/manual-owner.md`](manual-owner.md)（负责人）、
  [`docs/manual-assistant.md`](manual-assistant.md)（助手）。

### 下一步建议

**在 Windows 上把打包跑一遍**（说明书 Phase 6 的另一半）：装 Python 与 uv →
`scripts\build_windows.bat` → 双击 exe 走一遍同样的清单（首次检查、填名字、建项目、
识别、诊断日志）。跑完把结果记进开发日志，并解除 L-31 的前两行。
这是 Phase 5（审校任务包）能开始的前提——负责人在 Mac、助手在 Windows 是
说明书里点名的两种组合之一。

## 2026-10-14 — 任务 26：Phase 3 余项——逐块采用新结果、框选新增块

### 任务目标

补上 Phase 3 剩下的两项（说明书 6.4）：

1. **逐块采用新结果**：整页"采用 / 保留"之外，能在两版之间**取长补短**——只换其中几块；
2. **框选新增块**：新增块时可以**在原图上框选位置**补全 bbox（为 OCR 漏检区域兜底，
   如没被检出的页眉）。此前新增的块只有"无位置信息"这一种。

### 当前状态

- R2 的整页采用 / 保留已做（任务 17）；
- `POST /pages/{n}/blocks` 接口已接受 `bbox`，但界面没有框选入口，插入位置也不看位置；
- 对比面板只是两列文本，右边标"不同"，没有逐块动作。

### 实施计划

1. `blocks.match_candidate_blocks`：候选块与现有块的配对（bbox 重叠 → 序号退化），纯函数；
2. `editing.adopt_run_block`：目标块软删除 + 候选块按原样插回（沿用位置）+ 一个 batch；
3. `editing.create_block`：按框选的**竖直位置**插进阅读顺序（与"在此块后新增"共用移位逻辑）；
4. 接口：`.../runs/{rid}/apply-block`；候选载荷带上配对信息；
5. 界面：对比面板逐块「换这一块 / 加进这一页」；审校视图的「✚ 框选新增块」与
   "无位置信息"徽标；
6. 测试 → 真机验证 → 文档。

### 实现与验证

**离线测试：** `uv run pytest -q` → **531 passed**（原 518 + 13）。

| 新增覆盖 | 说明 |
|---|---|
| 配对：按位置 | 两版块序不同也能配上（IoU > 0.9），不按顺序硬配 |
| 配对：退化与新增 | 没有 bbox 时按序号；一个现有块最多配一次；多出来的候选块 `target_block_id` 为空 |
| 逐块采用 | 只换那一块：块数不变、位置沿用、其余块一个不动、行记录一起重建 |
| 文本来源 | 换过来的 `text` 与 `ocr_text` 都来自那一版结果（不是现有块的） |
| 可撤销 | 撤销后块 id 与人工改过的文本都回位 |
| **整页采用补上行记录** | 采用之后那一页仍有行记录、行框与行文本齐全（旧缺口回归测试） |
| 框选插入位置 | 框在最上面 → 插到第 0 位；框在中间 → 插在中间；`order_index` 连续 |
| 不框选 | 追加到最后且 `bbox` 为空（"无位置信息"） |
| 坐标校验 | 越界框 → 400 `bad_bbox` |
| 框选可撤销 | 框选新增也进撤销栈 |

**真机验证（浏览器，真实引擎）：**

| 验证项 | 结果 |
|---|---|
| 框选新增块 | 点「✚ 框选新增块」→ 在页图上拖出区域（面板写明"横向 10–90%、纵向 2–7%"）→ 填文字 → 创建 |
| 插在正确位置 | 新块排在**第 1 位**（页眉位置），块数 6 → 7，图上多一个块框（overlay 7 个） |
| 新增块的标注 | 徽标显示"● 已修改"（人工新增，没有 OCR 原文——如实标注） |
| 撤销 | 回到 6 块，第一块仍是原来的"第二十七回" |
| 逐块采用 | 改一块造出人工成果 → 重新识别 → 对比面板显示"对应现有 #2（位置重合 100%）" + 「换这一块」 |
| 只换一块 | 换完 #2 变成新结果的文本（人工加的"（人工改过）"消失），面板刷新为"与现有相同"，其余块未动 |
| 撤销 | 人工改过的文本原样回来 |
| **采用之后仍能复核** | 整页采用后立刻点「第二引擎复核」：26 行 / 1.6 秒正常完成（修好了"采用之后没有行可复核"的旧缺口） |
| 无位置信息 | 用「⋯ 更多 → 在此块后新增」建的块徽标显示"无位置信息" |

**真机验证里修掉的两个问题：**

1. **新建块的响应里没有整页载荷**（`{created, blocks, review, history}`），
   框选流程一开始照抄了别的接口的形状去渲染整页 → 报 `Cannot read properties of undefined`。
   改成与「在此块后新增」同一条刷新路径（`loadPageDetail`）。
2. `CreateBlockRequest.page_no` 是必填的，尽管页码已经在路径里。改成可选
   （老界面照旧传，新界面不传）。

### 用户操作说明

- **框选新增块**：审校视图右上角「✚ 框选新增块」→ 在左边页图上拖出区域 → 写文字 → 创建
  （Esc 取消；框太小会当作误点，不弹面板）。
- **逐块采用**：页面有"待选新结果"时点「对比新结果」，右列每块下面写着它**对应现有哪一块**
  （按块框位置配对，附重合度），点「换这一块」只换这一块；多出来的块显示「加进这一页」。
  所有动作都可以 ⌘/Ctrl + Z 撤销。

### 下一步建议

按说明书路线，Phase 3 只剩"页眉页脚预览的图上高亮""说明书 7.5 余下的快捷键""独立审校标签页"
三件小东西；**真正的下一站是 Phase 6（打包分发）**——现在只有启动脚本，
团队里的助手用不了，而 Phase 5（审校任务包）要以它为前提。

---

## 2026-10-14 — 任务 25：把分歧率口径与实测接起来——"什么时候该开第二引擎"

### 任务目标

**纯文档（+ 一个测量脚本）。** 产品里有了分歧率（任务 24）、离线测量里有捕获率与归属
（第 8 节），但两者是两个口径，会被读成两个世界（"产品里 5% 分歧" vs "实测 29% 分歧"）。
任务目标是把它们接起来，写成一份**可操作的判断依据**：什么时候值得开第二引擎、
它能圈进多少错行、哪些场景别指望它。

### 当前状态

- 说明书 8.7 定义的三项指标里，只有"分歧率"在产品内算得出来；
- 第 8 节的"捕获率 17%"与说明书 8.7 的定义**不是一回事**（当时只统计了"改对"的行）；
- 无法回答"按'汉字级'筛页到底有没有用"——这需要在一本书上同时算两边的口径。

### 实施计划

1. `scripts/measure_divergence.py`：用**产品同一套**渲染 + 裁图 + `compare.grade_line`
   在真书上复算分歧率（分等级）、捕获率、改对率、"一致但都错"；
   金标准可选（`--gold`），行级定位用前缀 + 后缀锚点，定不到的单独计数、不进分母。
2. 在 40 页真书上跑一遍，拿到分级后的数字。
3. `docs/ocr-evaluation.md` 新增第 9 节（判断依据），并修正第 8 节的指标口径说明。
4. 按实测**修正界面上被数据推翻的文案**（"汉字级值得看 / 标点级是噪声"）。
5. 同步 README / known-limitations / decisions / CHANGELOG。

### 实现与验证

**新脚本** `scripts/measure_divergence.py`（默认只输出派生统计；逐行明细要显式 `--details`，
且默认写系统临时目录——受版权保护的书不进仓库）。40 页用 136 秒；汇总落 `docs/divergence-raw.json`。

**40 页真书（1064 行 / 915 行可定位 / 200 DPI）的关键数字：**

| 指标 | 数值 | 说明 |
|---|---|---|
| 分歧率（产品口径） | **25.7%**（汉字级 13.3% + 标点级 12.4%） | 分母是能比的 1017 行；另有 47 行"没读出" |
| **捕获率**（说明书 8.7 定义） | **64.6%**（第一引擎 65 个错行里 42 行被标出） | 第 8 节的"17%"其实是**改对率**，口径不同 |
| 改对率 | 24.6%（16/65）；汉字级 11.5% / 标点级 33.3% | 看到分歧行，换成另一路就对的比例 |
| 一致但都错 | **2.5%**（23/915） | 一致处可以快扫、不能免检 |
| 被标出的分歧 | 227 行（可定位），其中 **183 行是第二引擎自己的错（80%）** | 标记只回答"看哪里" |
| 分级信噪比 | 汉字级 13.3% vs 标点级 **23.7%**（基准 7.1%） | **与 D-039 的假设相反** |

**一条被数据推翻的旧结论（已修正）：** 任务 22 按"汉字级 = 第一引擎可能真认错了"的**推测**
把界面与筛选默认指向汉字级。实测表明：**标点级的信噪比反而更高**（3.3× vs 1.9× 于基准），
原因也清楚——第二引擎自己的错以**汉字**错误为主（127 行 vs 105 行），
"汉字级分歧"这一桶里塞满了它自己的错。已改：界面不再把等级当"值不值得看"的判据
（文案写明"两类都看"，并把实测数字放进 tooltip），两条筛选都保留。见 D-042。

**文档产出：** `docs/ocr-evaluation.md` 第 9 节（9.1 两个指标的分野 / 9.2 产品口径下的数字 /
9.3 三条结论 / 9.4 什么时候开与别指望它 / 9.5 未验证事项——含"审校效率提升"**没有测**）。

**离线测试：** `uv run pytest -q` → **518 passed**（本次只改文档与一个脚本，未动产品代码；
界面文案的改动 `node --check` 通过）。

**诚实记录：** 金标准仍是**未经开发者逐页确认**的分页草稿；定位是启发式的
（915/1064 可定位，定不到的 127 行主要是书眉 / 页码与第 1 页，它们本就不在金标准里——
其中若藏着第一引擎的错，会**低估**它的错误率、**高估**捕获率）。只有一本书、一种语言、
一种排版，换书必须复核。

### 用户操作说明

- 想判断"这本书要不要开第二引擎"，读
  [`docs/ocr-evaluation.md` 第 9 节](ocr-evaluation.md)：先跑 10–20 页样本复核，
  再看项目里「质量统计」卡片的**分歧率**与**汉字级 / 标点级**行数。
- 想自己复算：`uv run python scripts/measure_divergence.py --pdf <书页 PDF> [--gold <分页金标准>]`。
- 界面变化：缩略图芯片与块内提示的文案改了（不再说"汉字级值得看"），鼠标悬停能看到实测数字。

### 下一步建议

**按第 9 节的结论调整审校入口的默认行为**（代码）：现在"疑难"筛选的两条分歧条件
并列，但既然实测量过"标记能圈进 2/3 的错行"，可以让"还没审完"这条筛选**顺带把
有分歧的页排在前面**，或在审校视图里把"第二引擎没读出来"的行也标出来
（那 47 行是第二引擎读不出的行，值得单独看一眼——本次测量没算它们的信噪比，属于可做的小实验）。

按说明书路线，剩下的两条大路是 **Phase 3 余项（逐块采用、框选新增块）** 与
**Phase 6 打包分发**（协作阶段 Phase 5 的前提）。

---

## 2026-10-14 — 任务 24：项目质量统计（说明书 8.5 的落点 + 13.4 的指标）

### 任务目标

把说明书 8.5 的最后一条落点补上：**"分歧率与捕获率写入项目的质量统计（第 13.4 节）"**，
并顺带把 13.4 里**产品内算得出来的**那几项一起做出来（人工修改率、不确定块数、任务失败率）。

**关键的一条边界：** 13.4 的九项指标里有四项**产品里算不出来**
（CER / WER、捕获率、"一致但都错"要人工金标准；每页审校时间、恢复成功率没有采集）。
这一条按说明书 1.7 处理——**如实列出并写明原因**，不假装算过、不用"两路互相印证"
之类的办法把捕获率凑出来。

**不在范围内：** 自动建议下一步动作（说明书 7.4 的"建议只是入口"；疑难筛选已经承担了它）。

### 当前状态

- 任务 23 完成：复核能批量跑，分歧逐行标出、能筛页、能换候选；
- 但整本书"复核了多少行、分歧多少、哪些是汉字级"没有汇总的地方（L-30 第 4 条）；
- 块与事件表里已有人工修改、确认、不确定的数据，任务表里有成败数据——都没汇总过。

### 实施计划

1. `core/project/stats.py`：只读聚合（页面 / 审校 / 分歧 / 任务）+ `NOT_MEASURED` 清单。
2. `jobs.count_by_status`：任务失败率的供数口。
3. `blocks`：分歧计数补上 `identical`（分歧率的分母要它），`PageDivergence` 加只读属性。
4. 接口：`GET /projects/{id}/summary`（说明书第 11 节的「摘要」）。
5. 界面：项目视图里的「质量统计」卡片 + 刷新；任务结束后自动刷新。
6. 测试 → 真机验证 → 文档。

### 实现与验证

**离线测试：** `uv run pytest -q` → **518 passed**（原 510 + 8）。

| 新增覆盖 | 说明 |
|---|---|
| 摘要形状 | 页面 / 审校 / 任务三块数字都对得上（3 页合成 PDF：识别 1 页、2 块 3 行、1 个成功任务） |
| 未采集项如实列出 | `not_measured` 里有 CER、捕获率、每页审校时间，每条都带原因 |
| 分歧率口径 | 3 行（一致 1 / 汉字级 1 / 第二引擎没读出来 1）→ 分母 2、分歧率 50%、复核行数仍是 3 |
| 人工修改率 | 改 1 块、确认 1 块 → 修改 1（12.5% 与 50% 两种口径都有断言） |
| 任务失败率 | 取消不算成败：4 个任务（1 成功 1 失败 1 取消 1 进行中）→ 失败率 50% |
| 读模型不写东西 | 连读两次结果相同；读之前与读之后页面状态完全一致 |
| 与逐页数同源 | 汇总数 = 逐页 `page_divergences` 之和（同源，不会出现两个分歧数） |
| 未知项目 | 404，错误格式统一 |

**真机验证（20 页样本，真实 RapidOCR + Apple Vision，浏览器里操作）：**

| 验证项 | 结果 |
|---|---|
| 刚导入 | "识别 已识别 0 / 纳入 20 页 · 未识别 20｜审校 块 0｜两路复核 还没复核过｜任务 共 0 个" |
| 识别 2 页后 | "已识别 2 / 纳入 20 页 · 未识别 18｜块 8（纳入 8）· 未审 8｜任务 共 1 个 · 成功 1（失败率 0.0%）" |
| 批量复核 2 页后 | "两路复核 已复核 2 / 20 页 · 比过 33 行 · 一致 27 · 仅格式 0 · 汉字级 4 · 标点级 2 · 没读出 1 · **分歧率 18.2%**" |
| 改一个块 + 刷新 | "人工修改 1（12.5%）" |
| 任务结束后不点刷新 | 自动刷新到 任务 共 3 个 · 成功 3 |
| 未采集说明 | 卡片底部原文列出四条指标与原因（CER/WER、捕获率、审校时间、恢复成功率） |

真机上那 18.2% 与 Phase 0 的离线实测（28.9% 原始分歧、分级后汉字级约 3%）量级相符——
样本只有 2 页，数字本身不必当结论，但**口径与离线测量一致**。

**顺带发现的一件事（记录备查，不是本次改动引入）：** 验证过程中开发服务器被环境静默杀掉过一次
（日志停在缩略图请求，没有任何 traceback）。改用后台任务方式重启后一切正常——
不影响产品代码，只影响我的验证方式。

### 用户操作说明

打开项目后，在页面上方看到「**质量统计**」卡片，四行数字随实际进度变：
识别（已识别 / 纳入、未识别、失败、待选新结果）、审校（块、已确认、未审、不确定、人工修改率）、
两路复核（已复核页数、比过的行、一致 / 仅格式 / 汉字级 / 标点级、**分歧率**）、
任务（总数、成功、失败、失败率）。任务跑完会自动刷新，也可以点「刷新」。

卡片底部会列出**产品里算不出来的指标**（CER / WER、捕获率、一致但都错、每页审校时间、
恢复成功率）与各自原因——这些在 `docs/ocr-evaluation.md` 里由离线测量回答。

### 下一步建议

**把分歧率口径与实测数据接起来，写一份"什么时候该开第二引擎"的判断依据。**
现在产品里有了分歧率，离线测量里有捕获率（17%）——两者合起来才能回答
"这本书值不值得开第二引擎复核"。这属于文档工作（`docs/ocr-evaluation.md` 加一节 +
README 的"能做什么"补一句），成本低，但比再加一个功能更能帮到实际使用。

代码层面下一步更有价值的是**逐块采用、框选新增块**（Phase 3 余下的两项），
或者按 Phase 6 先做**打包分发**（现在只有启动脚本，团队里的助手用不了）。

---

## 2026-10-14 — 任务 23：第二引擎批量复核（接进任务执行器）

### 任务目标

把第二引擎复核**接进任务执行器**：一次对多页（乃至整本书）跑复核，得到识别任务
那一整套能力——进度、暂停 / 继续 / 取消、重试失败页、中断恢复。

理由是任务 22 留下的那条限制（L-30 第 4 条）：**单页复核要人点一次**，
而第二引擎是"给页加第二意见"，页数是整本书——逐页点等于没有这个功能。

**不在范围内：** 自动把复核结果写进正文（说明书 8.5 明确"不自动采纳任何一方"）；
分歧率 / 捕获率进项目质量统计（第 13.4 节，下一步）。

### 当前状态

- 任务 22 已完成：分歧能逐行标出、能一键换候选、能按分歧筛页；
- 但复核只能逐页点（`POST /pages/{n}/auxiliary` 同步接口），没有批量入口；
- 任务执行器（任务 13）已就位：`job` / `job_item`、子进程、控制信号全都有。

### 实施计划

1. `jobs.py`：新增任务类型 `auxiliary`（与 `ocr` 共用一张表，靠 `job_type` 区分）。
2. `recognition.py`：`resolve_aux_pages`（范围与跳过规则）、`create_auxiliary_job`；
   把 `run_job` 拆成"按类型分派 + 共用的逐单元循环"，复核的每页动作
   **复用同一个 `run_auxiliary`**。
3. 接口：`POST /projects/{id}/jobs/auxiliary`（第二引擎不可用 → 503）。
4. 界面：选择面板加「第二引擎复核所选」「复核全部未复核页」与「跳过已复核的页」；
   任务抽屉按任务类型显示标题与最近任务。
5. 测试 → 真机浏览器验证 → 文档。

### 实现与验证

**离线测试：** `uv run pytest -q` → **510 passed**（原 497 + 13）。

| 新增覆盖 | 说明 |
|---|---|
| 任务类型落库 | `job_type` 建时写入、读回来一致；两种任务共用一张表 |
| 批量复核 | 按页一个单元；每页写一条辅助运行与行级候选；块与审校状态一点不动 |
| 跳过已复核 | 默认跳过（第二次对同一页报"没有需要复核的页面"）；`skip_checked=false` 才重跑 |
| 范围 unchecked | 全部已识别页里只挑没复核过的（复核过第 1 页之后只剩第 2 页） |
| 未识别页 | 明确报错"还没有第一引擎的识别结果"，不静默丢弃 |
| 已排除页 | 明确报错"已排除，不参与复核" |
| 第二引擎不可用 | 503 `secondary_engine_unavailable`，原因原样带出，不建注定失败的任务 |
| 同时只跑一个任务 | 复核任务也占说明书 6.3 的那个名额（有任务在跑时拒绝） |
| 失败原因可见 | 一页失败不影响其余页；原因写进 `job_item.error_message` |
| 重试失败页 | 与识别任务同一套接口；重试后该页有了候选 |
| 暂停 / 取消 | 脚本化决定驱动循环：暂停时不复核任何页、恢复后接着做；取消后已做的保留、继续时只做没做完的 |
| 单页复核并存 | 审校视图的同步按钮没被取代；复核过之后批量会跳过它 |

**真机验证（20 页样本，真实 RapidOCR + 真实 Apple Vision，浏览器里操作）：**

| 验证项 | 结果 |
|---|---|
| 批量复核所选 2 页 | 抽屉标题变成「**第二引擎复核任务**」，排队 → 进行中 → 已完成 2/2 页 |
| 暂停 | 点暂停后抽屉显示"已暂停 · 当前第 3 页"，第 2 页已做完的计数保留（说明书 6.3：当前页完成后停止） |
| 完成后 | 最近任务列出"10-14 13:46 · 第二引擎复核 · 已完成 · 2/2 页" |
| 缩略图标记 | 第 3 页 `≠ 2`、第 2 页 `≈ 标点级`（只标汉字级，悬停看完整数字） |
| 审校视图 | "两路分歧 5 行（汉字级 2 · 标点级 3 · 第二引擎没读出 1 · 仅格式差异 1）"，逐行标记可换候选 |
| 「复核全部未复核页」 | 识别第 1 页后点它 → 只建了 1 页的任务（第 1 页）→ 完成后第 1 页拿到 `≠ 3` |
| 全部复核过之后再点 | 如实报错"没有需要复核的页面（已复核的页会跳过，未识别的页不参与）" |

**真机验证里抓到的一个真 bug（已修）：** 「第二引擎复核所选」第一次点**毫无反应**——
`const body = scope ? { scope } : null;` 然后在 `if (!body)` 分支里给 `body` 赋属性，
抛出的 TypeError 落在 try 之外，界面上既没有任务也没有报错。这是只有真点一次才会暴露的
问题（单元测试与接口测试都覆盖不到 JS）。修好后重跑，两条按钮都通了。

**诚实记录：** 验证用的是临时项目库（`--library /tmp/…`），验证完已删除，没写进真实项目库。

### 用户操作说明

1. 在页面网格里选中几页（都已识别）→「**第二引擎复核所选**」；
   或直接点「**复核全部未复核页**」把整本书补跑一遍。
2. 复核跑在后台任务里，右下角任务抽屉看进度，可以暂停 / 继续 / 取消；
   某页失败时抽屉里列出页号与原因，点「重试失败页」只重做那些页。
3. 跑完看缩略图上的 `≠ N`，或按「疑难 → 有分歧（汉字级）」筛页，逐页审校换候选。
4. 审校视图里的单页「第二引擎复核」仍然可用（改一行、看一行时更快）。

### 下一步建议

**把分歧率写进项目质量统计（说明书 13.4 / 8.5 的最后一条落点）。**
现在复核完只在页面上标出来；整本书"复核了多少行、分歧多少、其中汉字级多少"
没有一个汇总的地方。捕获率需要金标准，属于离线测量（已有 `docs/ocr-evaluation.md` 的口径），
但**分歧率可以在产品里算**：项目卡片或导出预检里加一行"两路复核：N 行 / 分歧 M 行
（汉字级 K）"，成本很小，且能让人一眼看出这本书值不值得细看。

---

## 2026-10-14 — 任务 22：分歧标记进审校视图 + 疑难筛选「有分歧」（说明书 8.5 的 MVP 落点）

### 任务目标

把说明书 8.5 给分歧标记规定的落点补齐：**审校视图里有分歧的行高亮、显示另一路候选、
点一下即可替换为另一路文本（作为对 `text` 的编辑）**，**疑难筛选增加"有分歧"条件**。

同时按任务 21 的实测（L-30）加一道分级：**汉字级 / 标点级**。
不分级就直接按分歧筛选，筛出来七成是第二引擎自己的标点习惯，等于噪声。

**不在范围内：** 整本批量复核（要走任务执行器，见 L-30 第 4 条）、
Windows 侧第二引擎（L-13）、R2 候选的逐块采用（另一件事）。

### 当前状态

- 任务 21 已接入第二引擎：`BlockLine.aux_text` / `diff_status` 会落库，一页可以手动复核；
- 但结果只在一个单独面板里列出来——审校视图的块里看不到，也没有按分歧筛页的入口；
- 块载荷里已有一个 `diff_line_count`，但它是"任何非 `identical` 的行数"，
  混着标点噪声与"第二引擎没读出来"，界面也没有用它。

### 实施计划

1. `core/ocr/compare.py`：`grade_line` —— 在三态之上再分汉字级 / 标点级 / 没读出来。
2. `core/project/blocks.py`：`block_divergence` / `page_divergence_summary` / `page_divergences`，
   **按块里现在的文本现算**，不新增列、不加迁移；块结构改过时标 `stale` 而不是硬标。
3. 接口：块载荷带逐行标记，页面载荷带分级计数（供筛选与缩略图）。
4. 界面：块内逐行标记 + 「换成这一路」；点行号在编辑框里选中该行；疑难筛选两条；
   缩略图芯片；审校横幅汇总。
5. 顺带修正与说明书 R4 的一处出入：拆分时被切开的行要清"分歧信息"（原先只清了 bbox）。
6. 测试 → 真机浏览器验证 → 文档。

### 实现与验证

**离线测试：** `uv run pytest -q` → **497 passed**（原 481 + 16）。

| 新增覆盖 | 说明 |
|---|---|
| 分级（8 项） | 汉字不同 → 汉字级；数字不同 → 汉字级；只差标点 → 标点级；`〈好了歌〉` 与 `<好了歌>` → 标点级（实测里最常见的一处）；格式差异与一致原样透传 |
| 标记跟着文本走 | 采用另一路之后标记消失、页面计数回落；人工改字之后标记从汉字级降为标点级 |
| 没复核过 ≠ 两路一致 | `checked` 为假时计数为 0，不能读成"一致" |
| 三种计数分开 | 汉字级 / 标点级 / 第二引擎没读出来 / 仅格式差异各计各的（`分歧行 = 汉字级 + 标点级`） |
| 行结构改过 | 加一个换行 → `stale=true`、不标、页面级记 1 个"结构改过的块"，不是悄悄算成 0 分歧 |
| 拆分清分歧信息 | R4：被切开的行 `bbox`/`aux_text`/`diff_status` 都清空；后面的行搬到新块且行号重排 |
| 多页汇总 | `page_divergences` 一次给出每页概况，未复核的页是 `checked=false` |

**真机验证（20 页样本，真实 RapidOCR + 真实 Apple Vision，浏览器里操作）：**

| 验证项 | 结果 |
|---|---|
| 复核一页 | 26 行 / 15.5 秒（含首次 5–6 秒框架预热）；一致 22 · 有分歧 4 |
| 横幅 | "两路复核有 4 行不一致（汉字级 3 · 标点级 1）：块里已逐行标出，另一路候选就写在旁边……" |
| 块徽标 | "≠ 两路不一致 1 行"；有汉字级分歧的块左侧一道琥珀色边 |
| 逐行标记 | "第 6 行 · 汉字级 · 第二引擎：望着门洒了几点泪。**自党**无味……"（第一引擎是"自**觉**无味"——确实是第二引擎错，与 L-30 的结论一致） |
| 点行号 | 编辑框里选中了那一行（选区正好是这一行的文本），与"看哪里"对应上 |
| 换成这一路 | 该行换成候选 → 标记消失、块徽标变"● 已修改"、页面分歧 4 → 3 行 |
| 撤销 | 文本与标记一起回到原状（4 行），保存状态显示"已撤销" |
| 缩略图芯片 | 第 1 页 "≠ 3"（只标汉字级）；悬停写着"两路复核：汉字级 3 · 标点级 1" |
| 疑难筛选 | "有分歧（汉字级）"与"有分歧（含标点级）"都只剩第 1 页；恢复"全部"回到 20 页 |
| 行结构改过 | 在块里插一个换行 → 该块的标记换成"这一块的行结构改过……已暂时收起"，不再指错地方 |

**诚实记录：** 上面这次真机验证用的是**验证用的临时项目库**（`--library /tmp/…`），
验证完已删除，没有写进开发者的真实项目库。表里那 4 处分歧**都是第二引擎错**
（自党 / 睛含 / 钱行 / 破折号少一个），这正是 L-30 说的"分歧多数是它的错"。

### 用户操作说明

1. 打开某一页的审校视图，点右上角「第二引擎复核」（一次一页，页少时有意义）。
2. 复核完，块里会多出一块"≠ N 行两路不一致"的区域：
   - 点**第 N 行** → 编辑框里选中那一行（和左边原图对着看）；
   - 「换成这一路」→ 把这一行换成第二引擎的文本（普通编辑，⌘/Ctrl + Z 可撤销）。
3. 页面缩略图上会打 `≠ N`（只标汉字级）；顶部「疑难」筛选里选
   **有分歧（汉字级）** 就能在需要细看的页之间跳。

### 下一步建议

**把第二引擎复核接进任务执行器（批量复核）。** 现在只能逐页点：一页 15 秒（含预热），
一本 400 页的书要人工点 400 次。任务执行器（任务 13）已就位，加一个任务类型即可；
这也是说明书 Phase 8 Step 1 验收里"分歧率与捕获率统计"的前提。

---

## 2026-10-14 — 任务 21：第二引擎（Apple Vision）接入 + Phase 0 第 2 项的实测

> 补记：这次任务的记录原先只落在 `docs/ocr-evaluation.md` 第 8 节、D-038 与
> `CHANGELOG.md` 里，漏了开发日志这一条；任务 22 补写时一并补上（内容据当次实测）。

### 任务目标

按说明书 8.5 / R1b 接入**第二引擎**（macOS 上是 Apple Vision），
并完成说明书 Phase 0 第 2 项要求的实测：**分歧率、捕获率、一致但都错**。

### 实施计划

1. `core/ocr/adapters/apple_vision.py`：适配器（`available()` / `version()` / `recognize()`）。
2. `recognition.run_auxiliary`：按第一引擎切出的行图逐行复核 → 写 `aux_text` / `diff_status`，
   记 `run_type=auxiliary` 的 OCRRun，输出写 `ocr_runs/<run_id>.json`，**不生成块**。
3. 接口 `POST /projects/{id}/pages/{n}/auxiliary`；界面加复核面板与「采用这一路」。
4. 40 页真书实测：分歧率、捕获率、一致但都错；再与金标准逐行对照。
5. 文档：`docs/ocr-evaluation.md` 第 8 节、D-038、L-30、README、CHANGELOG。

### 实现与验证

**离线测试：** 全套 **481 passed**（含 3 项真机 Vision 测试）。

**实测（40 页真书，1064 行）：** 两路一致 69.9% / 仅格式 1.2% / **有分歧 28.9%**；
分歧归属：**第一引擎对、第二引擎错 187 行** vs **第一引擎错、第二引擎对 8 行**（捕获率 **17%**）；
两路都错 39 行（14.7%），集中在**引号 / 破折号 / 校勘符号**；
整页识别正文 CER：Vision **2.16%** vs RapidOCR **1.08%**；速度 0.29 vs 1.94 秒/页。

**两个必须写下来的实现细节：** 固定 `accurate` 级别（`fast` **不支持中文**）；
**关掉语言纠正**（开着会替用户润色，违反说明书 1.5）。

### 结论

功能保留、界面如实标注"实测它比第一引擎弱"（D-038），**不包装成"提高准确率"**。
副产品两条：**"分歧行数"不能直接当筛选依据**（→ 任务 22 做了分级）；
**真正难的是排版符号**，两个引擎都不行（下一步最有价值的改进方向）。

---

## 2026-10-14 — 任务 20：页眉 / 页脚 / 页码批量标注（说明书 6.5）

### 任务目标

解决**厚书审校效率上最挡手的一处**：扫描书的页眉页脚页码每页都有，
在此之前只能逐页手工改类型——一本 400 页的书就是 800 次操作。

说明书 6.5 给了明确的做法：**位置规则**（顶部 / 底部区域高度）+
**文本条件**（纯数字或罗马数字 → 页码；字数少于 N）→ **预览**
（将被标注的块数，可逐个取消）→ **批量应用**（一次 batch 写入 Event，可整体撤销）；
**已被人工修改过类型的块不会被覆盖**。

**不在范围内：** 版面组件（说明书 8.4 的路线未选定）给出的类型建议——
说明书说它只能作为"预填候选"，两种来源都要过预览；当前只有位置规则这一种来源。

### 当前状态

- 任务 19 完成：导出能导整本书、能对照核对；
- 块类型可以手工改（`PATCH /blocks/{id}`），但没有批量工具；
- 事件表已经能回答"这个块的类型是不是人改过的"（`set_type` 事件 + `actor`）。

### 实施计划

1. 读说明书 6.5 与 7.4 的相关处。
2. `core/project/structure.py`：规则、数字判定、预览（不改任何东西）、批量应用。
3. 接口：`POST .../structure/header-footer/preview` 与 `/apply`（说明书第 11 节的路径）。
4. 界面：结构工具面板（规则输入、候选列表可逐个取消、摘要与跳过原因、应用）。
5. 测试与真机验证。

### 实现与验证

**离线测试：** `uv run pytest -q` → **467 passed**（原 435 + 32）。

| 新增覆盖 | 说明 |
|---|---|
| 数字判定 | `62` / `· 62 ·` / `- iv -` / `[12]` 是页码形态；`第三章`、`红楼梦/00000` 不是 |
| 位置规则 | **整块**落在区域内才算（跨界的大段落不当页眉）；顶部 → 页眉、底部 → 页脚 |
| 文本条件 | 字数超过上限的跳过；把上限放开它就会入选（规则的作用可见） |
| 作用范围 | 默认只作用于正文页；换成前置页后同一批块又能标 |
| 预览不改任何东西 | 预览之后块的类型没变、事件表是空的 |
| 不覆盖人工成果 | 人改过类型的块被跳过并说明原因 |
| 整批撤销 | 一次应用共享一个 `batch_id`；撤销一次全部退回 |
| 逐个取消 | 没传回来的块不动（预览里取消掉的就不标） |
| 幂等 | 标过之后它们已经不是段落，第二次预览不再出现 |
| 未知项目 | 顺手补了 7 条路径的 404 回归测试（见下） |

**真机验证（20 页样本 + 浏览器）：**

| 验证项 | 结果 |
|---|---|
| 预览 | "20 页在作用范围内｜会标注 2 个块：页眉 1 · 页码 1"；候选列出"段落 → 页眉 / 页码"与原因 |
| 逐个取消 | 取消一个 → 按钮变"应用标注（1 个块）"；全选回来 → 2 个 |
| 应用 | "已标注 2 个块（页眉 1 · 页码 1），涉及 1 页。这是一次批量操作，可以用「撤销」整体退回去。" |
| 导出的连带效果 | 页眉与页码被 9.3 默认排除：段数 132 → 130、字数 14928 → 14906 |
| 撤销 | 撤销 2 个块；**再预览又能标了**；导出恢复到 132 段 |
| 清理 | 验证时造的临时块用 `DELETE /blocks/{id}` 清掉，导出回到 128 段 / 14884 字 |

**过程中的两个修正（都是真机或真测试暴露的）：**

1. **"标注 → 撤销 → 再预览"标不上了**：撤销也记 `set_type` 事件（历史要线性可追溯），
   而"人工改过"的判定只看事件存在与否——于是撤销一次之后那些块被永久当成"人改过的"。
   现在事件带 `actor`：批量工具自己的改动记 `system`，**只有 `user` 才算人工改过**；
   撤销沿用被撤销那批的 actor。语义因此准确：**"人工改过"= 有人手动改的**。
2. **未知项目会 500 而不是 404**：`library.list_pages` 等函数直接开库，
   对不存在的项目会抛 `sqlite3.OperationalError`。现在统一先过
   `require_project_dir()`（目录与 `project.db` 都在才继续），
   并补了 7 条路径的 404 回归测试（页面 / 块 / 任务 / 批量改页 / 位置 / 结构工具 / 导出预检）。

**未验证 / 待处理项（必须诚实记录）：**

1. **样本里没有真实的页眉页脚**：这 20 页的识别块没有一个整块落在上下 8% 里
   （正文从 y≈0.13 开始，唯一的边缘物是竖排书名的长条伪影，跨越整页高度），
   因此真机验证用的是**按真实书页样式造的**页眉 / 页码块（走的是真接口）。
   在真正带页眉页码的扫描书上效果如何，需要那类样本（`test_books/` 里的两本书）。
2. **版面组件的建议还没接入**：说明书 8.4 允许模型给出页眉 / 页脚 / 页码建议作为预填候选，
   但路线 B / C 未选定（Phase 0 的版面组件评估还没做）。
3. **"抽样展示若干页（原图 + 高亮）"只做了列表形态**：说明书 6.5 第 3 条想要
   抽样看几页原图；现在是"页码 + 类型 + 文本"的候选列表（可逐个取消），
   在图上高亮那一步与导出对照共用同一个渲染思路，属下一步的完善。

### 用户操作说明

1. 打开项目 → **结构工具 · 页眉 / 页脚 / 页码批量标注** 面板。
2. 调规则：顶部 / 底部区域高度（默认各 8%）、字数上限（默认 20）、
   是否把纯数字 / 罗马数字判为页码、是否只作用于正文页。
3. 点**预览**：列出会标注哪些块（第几页、从什么类型变成什么类型、原文），
   以及**哪些块在区域内但没动它**（含原因：类型被人改过 / 字数超限 / 已经不是段落）。
4. 不满意的逐条**取消勾选**（或"全不选"），点**应用标注**。
5. 应用是一次批量操作：**⌘/Ctrl + Z 或"撤销"能整体退回去**；
   标注过的块在导出时会按 9.3 的规则被排除（页眉 / 页脚 / 页码默认不导出）。

### 下一步建议

**补 Phase 0 的人工校对金标准（L-05）。** 理由：现在从导入到导出、从审校到追溯都通了，
**整条链路都能用了**——但"这本书识别得准不准"这个最基础的问题仍然没有答案，
因为缺少人工逐字校对过的 5–10 页作为基准（没有基准就算不出 CER、分歧率、捕获率）。
它只能由你本人对着页面抄录，是纯人工的活；而它一旦存在，
后续每一步优化（分段规则、清理规则、是否值得接版面组件、要不要上第二引擎）
就都有了可量的依据。建议选这本书里**版式有代表性**的几页
（章首页、双栏页、带插图页、脚注页各一），用 `docs/ocr-evaluation.md` 里预留的模板记录。

---

## 2026-10-14 — 任务 19：导出对照模式（段 → 块 → 页溯源）

### 任务目标

把导出的成果**能回头核对**。说明书把"可追溯"当成产品的核心价值之一，
而说明书的 Phase 7 第一项就是"**导出对照模式**：导出预览升级为左侧原图、
右侧导出形态的连续段文本，点击段跳转来源页并高亮来源块"。
在此之前，导出的 TXT 是一份"结果"，但没法回答"这段话来自哪一页、哪个块"。

**不在范围内：** 断词还原的逐处人工校正、把对照视图做成独立视图
（说明书明确"不设独立视图"，它升级的就是导出预览）。

### 当前状态

- 任务 18 完成：导出能导整本书、文件落盘、有记录；
- 溯源的**数据**早就在了（说明书 9.1：段 ID = 首块 block_id，段记录里有 `block_ids` 与 `pages`），
  缺的只是把它摆到界面上。

### 实施计划

1. 预览接口带上**逐段记录**（与 JSONL 的形状一致：段号、页、块 ID、审校状态）。
2. 界面：把"预览"升级成"对照预览"——左原图、右连续段文本。
3. 点一段 → 左图跳到该段第一页、把这个段的来源块高亮（其余块淡显）。
4. 选项变化时收起对照面板（避免用旧设置的结果误导）。
5. 测试与真机验证。

### 实现与验证

**离线测试：** `uv run pytest -q` → **435 passed**（预览接口新增字段，导出测试仍全绿）。

**真机验证（20 页样本，浏览器）：**

| 验证项 | 结果 |
|---|---|
| 打开对照 | 128 段 · 14884 字 · 20 页（按当前导出设置），首段自动选中 |
| 段头信息 | `#1 · p.1 · 已确认`、`#7 · p.2`、`#8 · p.2`；跨块合并的段会标"2 块合并" |
| 点第 8 段 | 左图跳到第 2 页、**只把来源块框成橙色**、本页其它块淡显；右列当前段高亮 |
| 人工成果 | 段落文本里就是改过的内容（"人工改过的第二页开头。"） |

**过程中的一个修正：** 段号显示成了 `#2`——`Segment.seq` 本来就是**从 1 开始**的全书序号，
我又加了 1。改成直接用 `seq`。

**未验证 / 待处理项（必须诚实记录）：**

1. **未识别页在对照里也只是"没有段"**：预检会列出它们（"有 N 个纳入页还没识别"），
   但对照视图里不会为它们显示占位——说明书没要求，但这是下一个可改进的点。
2. **断词还原无法在对照里逐处确认**：manifest 里记着每一处，界面上还没有入口。
3. **对照视图没有快捷键**：只能点；段间跳转的键盘操作（说明书 7.5 未涉及）没做。

### 用户操作说明

1. 打开项目 → 导出面板 → 点 **对照预览**。
2. 左边是来源页图像，右边是**导出形态**的连续段文本（一行一段，按全书顺序）。
3. **点任意一段**：左边立刻跳到它的来源页，并把这一段的来源块框成橙色，
   同页其它块淡显——一眼看出"这段文字来自图上哪一块"。
4. 每一段的头上写着段号、来源页、是否确认 / 未审 / 不确定、是否由多个块合并而来。
5. 改了导出选项（格式以外的范围 / 规则）后面板会收起，重新点对照预览即可。

### 下一步建议

**做页眉页脚批量工具（说明书 6.5）。** 理由：现在整条链路都通了
（导入 → 识别 → 审校 → 导出 → 对照核对），但**厚书审校效率**上最挡手的一处还没解决：
扫描书的页眉页脚页码每页都有，而现在只能逐页手工改类型（L-22 / L-29 都记着这一点）。
说明书 6.5 给了明确的做法：位置规则（顶部 / 底部区域高度）→ 预览（将被标注的块数与抽样页）
→ 批量应用（作为一个 batch 写入 Event，可整体撤销）。它落在已有的机制上
（块类型 + 批量写 + Event + 撤销），做完之后"400 页的书要不要逐页改页眉"这个问题就消失了。

---

## 2026-10-14 — 任务 18：把导出接到项目上，删掉临时上传（Phase 4 主体）

### 任务目标

让成果**出得去**。识别、选页、审校、结构编辑、采用结果都做完了，但导出仍走 Phase 0 的
临时上传流程：客户端把块提交给无状态接口、服务端算完把文本还回来——
项目里已识别的几百页**导不出来**。这次把导出接到项目上（说明书 6.6 / 第 9 节 / 12.1），
并**删掉临时上传那一整块**，结束"两套流程并存"。

**不在范围内：** 导出对照模式（Phase 7 的段→块→页溯源预览）、任务包导出（Phase 5）。

### 当前状态

- 任务 17 完成：识别 → 审校 → 结构编辑 → 采用结果，链路闭合，但成果出不去；
- 第 9 节的规则实现（9.1–9.5）早已完成并有测试，缺的是"从项目取块 + 落盘 + 记录"；
- 界面上还挂着 Phase 0 的"临时上传（Phase 0 遗留）"卡片与无状态导出面板。

### 实施计划

1. 迁移 0004：`export_record`（说明书 5.3）。
2. `core/export/project.py`：读库取块 → 9.2 行合并 → 9.3 清理 → 9.1 段生成 →
   9.4/9.5 渲染 → manifest（9.5）→ 按 12.1 落盘 → 记一条导出记录。
3. 接口：`/export/preflight`、`/export/preview`、`/export`、`GET /exports`、
   `/exports/{eid}/download`、`/exports/{eid}/reveal`（说明书第 11 节的导出一组）。
4. 界面：项目里的导出面板（格式 / 范围 / 页面类型 / 内容类型 / 清理规则 / 预检摘要 /
   预览 / 生成 / 下载 / 在文件夹中显示 / 导出记录）。
5. 删掉临时上传：`api/routes_scratch.py`、`core/storage/scratch.py`、
   无状态 `api/routes_export.py`、界面卡片与约 580 行前端代码、相关测试。
6. 测试与真机验证（真导出 + 下载字节 + 浏览器走一遍）。

### 实现与验证

**离线测试：** `uv run pytest -q` → **435 passed**（删掉临时流程的 54 项、
新增项目导出 18 项；规则本身的单元测试一项没动）。

| 新增覆盖 | 说明 |
|---|---|
| 预检 | 页数 / 段数 / 字数 / 跨块合并 / 断词还原 / 未审与不确定段数 / 排除的块类型；**未识别或失败的纳入页要列出来**（说明书 6.6） |
| 范围选项 | 页面类型（附录默认不导）、页码范围、仅已确认内容 |
| 9.3 规则 | 页眉 / 页脚 / 页码默认排除，关掉规则则原样导出 |
| 内容不可泄漏 | 说明书 13.2：被排除的块不得出现在导出里 |
| 人工成果 | 导出的是**最终文本**（`Block.text`），不是识别原文 |
| 落盘 | 目录按说明书 12.1、文件名 `clean.txt` / `segments.jsonl` / `manifest.json`；同一分钟内连做两次不互相覆盖 |
| 记录 | `export_record` 行、`GET /exports` 列表、下载（含 manifest）、**下载接口不能取记录之外的文件** |
| 空导出 | 一页都没识别时明确拒绝并说明原因，不写空文件 |

**真机验证（20 页真实扫描样本）：**

| 验证项 | 结果 |
|---|---|
| 预检 | 20 页 / 128 块 / 128 段 / 14884 字 / 未审 121 段 / 不确定 1 段 / 排除的块类型 footer、footnote、header、other、page_number |
| 生成（两种格式 + 页码标记） | `exports/20261014-1100_both/` 下 clean.txt（24 KB）、segments.jsonl（66 KB）、manifest.json（2.6 KB） |
| TXT 内容 | 页标记 `〔p.1〕`；9.2 行合并生效（多行块拼成整段）；**人工成果在里面**（"第二十七回（我改过）"、"人工改过的第二页开头。"） |
| manifest | schema / project / scope / rules / files / 断词还原 3 处 / stats 齐全 |
| 下载 | 数据文件与 `?file=manifest.json` 都能取到 |
| 在文件夹中显示 | 调起访达打开导出目录 |
| 界面 | 预检实时算（勾"仅已确认"后 128 段 → 6 段）、生成后面板列出文件与下载链接、导出记录累积 3 次 |
| 临时上传已消失 | 界面上不再有任何上传 / 临时识别入口；服务启动横幅也不再打印临时目录 |

**过程中的三个修正：**

1. **导出用错了文本来源**：最初用 `block_line.text`（行级识别原文）拼段，
   于是**人工改过的字全被丢掉**——测试当场抓住（"人工改过的第三页开头。"不在导出里）。
   现在明确以 `Block.text` 为唯一来源（说明书 5.3：块文本保留行内换行），
   按换行拆回行再做 9.2 的合并。
2. **目录名与 manifest 的 `export_id` 不一致**：目录用 `_txt-jsonl`、manifest 用 `_both`，
   而记录的主键就是目录名——三个地方各说各话。现在同源（都用格式名当后缀）。
3. **假引擎让断言失真**：假引擎每页产出同样的文字，于是"某句不在导出里"这类断言
   会被别的页满足。改成按出现次数断言（这也顺带说明：**测试夹具的重复内容会掩盖错误**）。

**未验证 / 待处理项（必须诚实记录）：**

1. **导出对照模式没做**（Phase 7）：点一段跳到来源页并高亮来源块——段 → 块 → 页的数据
   都已经在库里（9.1 的溯源），缺的是界面。
2. **未识别页在导出里只是"没有内容"**：预检会明确列出它们，但导出文件本身没有标记
   （说明书没要求，但值得在导出对照模式里一并解决）。
3. **断词还原仍无法人工校正**：记录在 manifest 里供抽查，但没有界面去逐处确认。
4. **Windows 未验证**（同前）。

### 用户操作说明

1. 打开项目，滚到**导出**面板。
2. 选格式（TXT / JSONL / 两者）、范围（全书或页码）、页面类型、内容类型、清理规则——
   **预检摘要会实时更新**（页数、段数、字数、未审段数、未识别页）。
3. 点**预览**看开头，点**生成导出文件**写进项目的 `exports/` 目录。
4. 在"本次导出"里下载数据文件或 `manifest.json`，或点**在文件夹中显示**打开目录。
5. 导出记录会累积，可以回看每次导出的统计。

### 下一步建议

**做导出对照模式（Phase 7 的第一项）。** 理由：现在能导出整本书了，
但"导出的这段文字来自哪一页、哪个块"还没有界面——而说明书把"可追溯"当作产品的核心价值之一
（段 → 块 → 页的溯源数据在 9.1 里已经有了，`segment.block_ids` + `pages` 就在 JSONL 与 manifest 里）。
做完它，导出才不只是"一个 TXT"，而是**能回头核对、能定位到原图**的成果。
若想先把 Phase 3 补完，页眉页脚批量工具是审校效率上最靠前的一块（L-29）。

---

## 2026-10-14 — 任务 17：采用 / 保留新识别结果（R2 的后半段）+ 疑难筛选

### 任务目标

把 R2 补完整。R2 的前半段（已有人工成果时不覆盖，只存为"待选结果"）在任务 12 就做了，
但**用户没有出口**：界面提示"有待选新结果"却点不了——既不能采用，也不能丢弃。
这次做说明书 7.4 的对比流程（[对比] → 左右对比 → [采用新结果] / [保留现有]），
顺手补上说明书 6.4 的**疑难筛选**（在需要处理的页之间跳转）。

**不在范围内：** 逐块采用（说明书 R2 只要求整页二选一）、页眉页脚批量工具、
在图上框选位置新增块。

### 当前状态

- 任务 16 完成：审校能改字、能改结构、能撤销；
- `has_candidate` 状态能算出来、能显示，但没有任何操作能把它结束掉。

### 实施计划

1. 读 R2 的原文与 7.4 的对比流程。
2. 让"候选"自足：原始输出文件里连同**分段结果**一起存，采用时原样还原用户对比过的那一份。
3. `editing.adopt_run`（采用：旧块软删除 + 按结果重建 + 换 active run，**全部可撤销**）
   与 `editing.decline_run`（保留：只记一条决定）。
4. 接口：`GET .../candidate`、`POST .../runs/{rid}/apply`（说明书第 11 节）、`.../decline`（本次新增）。
5. 界面：对比面板（左右两列）+ 疑难筛选。
6. 测试与真机验证。

### 实现与验证

**离线测试：** `uv run pytest -q` → **489 passed**（原 480 + 9）。

| 新增覆盖 | 说明 |
|---|---|
| 候选载荷 | 左边是现有块（含人工改动），右边是新结果；用的是**用户对比过的那一份分组**（`regrouped: false`） |
| 采用 | 旧块软删除、按新结果重建块（状态回到未审）、`active_run_id` 换成候选 |
| 采用的撤销 | 说明书 R2 明说"旧块软删除，**可撤销**"：撤销把块与 active run 一起还原，候选提示重新出现 |
| 保留现有 | 块一点不动、提示消失、**不进撤销栈**（它没改任何数据） |
| 决定之后再有运行 | 仍是新候选（"保留现有"不是一劳永逸的封杀） |
| 旧文件兼容 | 早期写下的原始输出没有分段字段：退化成就地重新分段，不 500 |

**真机验证（20 页样本 + 浏览器）：**

| 验证项 | 结果 |
|---|---|
| 造候选 | 人工改第 2 页首块（已确认）→ 重新识别 → 页面变 `has_candidate` |
| 对比载荷 | 候选 2 块（"红楼梦\n62" + 正文）、现有 2 块（人工改过的那块 + 正文） |
| 采用 | active run 换成候选、块换成新结果且状态回到未审、撤销栈 +2 |
| 撤销 | 人工成果回来了、active run 换回去了、**页面重新变成"有待选新结果"** |
| 保留现有 | 页面回到"已识别"、`pending_run_id` 为空、人工成果原样 |
| 事件表 | `apply_run`（块与页面）+ `decline_run`（决定）都在，来源可查 |
| 对比面板（浏览器） | 两列并排、逐块标"不同 / 与现有相同"；采用后提示条与按钮一起收起；撤销后提示条又回来 |
| 疑难筛选 | "有不确定块"筛出 1 页（第 1 页）、"还没审完"筛出全部 20 页 |

**过程中的三个修正：**

1. **单页"识别"按钮悄悄失效了**：加了"批量默认跳过已识别的页"之后，单页按钮没有显式
   传 `skip_recognized: false`，于是重新识别被当成"没什么可做"直接 400。
   界面把错误显示在网格上方的错误条里，而当时人正在下面的审校视图里——**看不见**。
   现在单页按钮显式要求重新识别，并且审校视图开着时错误就显示在手边。
   这一条 API 测试抓不到（测试直接调接口），是真机点出来的。
2. **"采用"与"保留"混用同一个 action**：两者都记 `apply_run`，而状态推导用
   "最近一次决定的时间"压制旧候选——于是"采用之后又撤销"会把候选一起压掉，
   页面停在"已识别"、提示不再出现。现在**采用**记 `apply_run`（不需要压制：
   active run 就是它），**保留**记 `decline_run`（推导只看它），撤销采用后提示正常回来。
3. **对比面板左边那列标着"与现有相同"**：左列是基准，拿它跟自己比当然是"相同"。
   改成右列才标差异。

**未验证 / 待处理项（必须诚实记录）：**

1. **只能整页二选一**：没有"逐块采用"（说明书 R2 也只要求整页），
   因此想在两版之间取长补短，只能先采用再用审校编辑。
2. **候选的分段是"当时那一份"**：采用时用的是运行记录里存下的分段，
   不会因为分段规则的改动而变化——这是有意的（用户对比的就是那一份）。
3. 页眉页脚批量工具、在图上框选位置新增块仍未做（L-29）。

### 用户操作说明

1. 页面显示"这一页有更新的识别结果……"时，点 **对比新结果**。
2. 左边是现在保存的块（含人工改动），右边是这次新识别的结果；
   右列里与现有不同的块会标出来。
3. **采用新结果**：现有块换成新结果（可撤销，⌘/Ctrl + Z 能退回来）。
4. **保留现有**：只记下这个决定，不动任何内容，提示不再出现；
   以后再重新识别，仍会作为新候选出现。
5. 顶部筛选里的 **疑难** 下拉可以在"还没审完 / 有不确定块 / 识别失败 / 有待选新结果"的页之间跳转。

### 下一步建议

**做导出接到项目上（Phase 4）。** 理由：识别 → 选页 → 审校 → 结构编辑 → 采用结果，
这条"把扫描书变成可编辑文本"的链路已经闭合了，但**成果还出不去**——
导出目前仍走 Phase 0 的临时上传流程（把客户端手上的块提交给无状态接口算文本），
项目里已识别的几百页导不出来。第 9 节的规则实现（9.1 段生成 / 9.2 行合并 / 9.3 清理 /
9.4 TXT / 9.5 JSONL + manifest）都已完成并有测试，缺的只是"从项目数据库取块、
按说明书 12.1 写进 `exports/<时间戳>_<格式>/`、配下载与'在文件夹中显示'"。
做完之后临时上传那一整块（连同 `core/storage/scratch.py`）就可以删掉——
两套流程并存的局面到此结束。

---

## 2026-10-14 — 任务 16：结构编辑——合并、拆分、上移下移、新增、删除

### 任务目标

把审校从"只能改字"补成"能改结构"（说明书 6.4 的块操作、5.4 的 R4）。
识别分段是**启发式**的（L-21 记着三类已知失效场景），因此在真实审校里
"把被切碎的块合起来""把一大块拆开"和改字一样高频——没有这两个操作，
用户只能改字、改不了结构。

**不在范围内：** 疑难筛选、新识别结果的对比与采用、页眉页脚批量工具、
"在图上框选位置"新增块（不框选按"无位置信息"处理，说明书允许）、说明书 7.5 的其余快捷键。

### 当前状态

- 任务 15 完成：块能改字、能确认、能撤销，但结构固定——块数、顺序、边界都动不了。

### 实施计划

1. 读说明书 6.4（块操作清单）、5.3（BlockLine 的合并 / 拆分行为、origin 取值）、R4。
2. `editing.py` 增加五个操作：合并到上一块、在光标处拆分、与相邻块换位、新增、软删除。
3. 撤销机制**泛化**：事件可以作用在块内行上（行会被搬来搬去）。
4. 接口：`merge-prev` / `split` / `move` / `POST pages/{n}/blocks` / `DELETE blocks/{id}`。
5. 界面：每个块加"⋯ 更多"菜单；拆分用编辑框里的光标位置。
6. 测试与真机验证。

### 实现与验证

**离线测试：** `uv run pytest -q` → **480 passed**（原 465 + 15）。

| 新增覆盖 | 说明 |
|---|---|
| 合并（R4） | 文本与 `ocr_text` 以 `\n` 连接、bbox 取并集、来源块软删除、**行记录也搬过去**（说明书 5.3：合并时行记录随文本拼接保留原 bbox） |
| 合并的撤销 | 文本、被合并掉的那一块、行记录的归属**三样一起还原** |
| 拆分（R4） | 两块暂沿用原 bbox；行按光标分配；**被从中间切开的行清空坐标**（说明书 5.3） |
| 拆分的撤销 | 文本合回来、行索引复位、后面的块回到原位 |
| 换位 | 上移 / 下移交换顺序；到头了明确拒绝 |
| 新增 | 不框选 → `bbox` 为 NULL、"无位置信息"；`ocr_text` 为空 ⇒ 一直显示"已修改"（如实）；可插在指定块之后 |
| 删除 | 软删除（行还在库里），撤销能恢复 |
| 事件 | 一次合并 = 一批：`merge` + `delete` + 多条 `move_line`，`entity_type` 有 block 与 block_line 两种 |
| 重启 | 合并后的结构与行记录重启后仍在 |

**真机验证（20 页样本 + 浏览器）：**

| 操作 | 结果 |
|---|---|
| 拆分 | 光标放在第 4 块第 8 个字符 → 6 块变 7 块，前块是"紫鹃雪雁素日知道"、后块从"黛玉的情性：无"开始 |
| 合并 | 把刚拆出来的那块与上一块合并 → 回到 6 块，文本与原来一致 |
| 下移 | 第 1 块与第 2 块交换，"滴翠亭杨妃戏彩蝶"排到了最前 |
| 新增 | 多出一个空块并自动聚焦，位置在这一块之后 |
| 删除 | 块数回到 6（软删除） |
| 撤销 | 连撤 4 次，结构一路退回拆分之后的状态（撤销栈显示 5 批） |

**过程中的三个修正：**

1. **拆分时行索引算成负数**：切在行边界时，后半块的第一行应该从 0 开始，
   我按"切在行中间"的公式算，得到 -1。改成按"前块保留几行"统一推导。
2. **新增的块撤销不掉**：新块是用裸 INSERT 建的，事件里没有 `before`，
   通用撤销逻辑直接跳过了它。改成**先以软删除状态插入、再把"恢复可见"记成一条普通事件**——
   于是撤销 / 重做仍然只是"把 `deleted_at` 写回去"，撤销机制里不需要为新块开特例。
3. **"⋯ 更多"菜单点不开**：同时只开一个菜单的循环先把要开的那个也设成了显示，
   接着的取反又把它关掉。改成先记下意图再统一设状态。
   另外"在光标处拆分"原来在渲染时判定可用性——光标随时会变，那个判断立刻过期，改成点击时判断。

**未验证 / 待处理项（必须诚实记录）：**

1. **不能"在图上框选位置"新增块**：说明书 6.4 允许这么做（也允许不框选），
   现在只能不框选，位置靠上下移动调整。
2. 疑难筛选、新结果对比与采用、页眉页脚批量工具都还没做（L-29）。
3. 说明书 7.5 的其余快捷键未实现，也仍未在 Chrome / Edge / Safari 里验证冲突。

### 用户操作说明

1. 双击某一页进入审校视图，每个块右下角有 **⋯ 更多**：
   **与上一块合并** / **在光标处拆分** / **上移** / **下移** / **在此块后新增一块** / **删除这一块**。
2. 拆分前先把光标放到要切开的位置（编辑框里点一下即可）。
3. 所有结构操作都能 **⌘/Ctrl + Z** 撤销；撤销按"批"走，一次操作一次撤销。
4. 合并后的块标注为"合并"、拆出来的块标注为"拆分"——它们的坐标不是引擎量出来的，
   属于**位置近似**。

### 下一步建议

**做"新识别结果的对比与采用"（说明书 7.4）。** 理由：现在页面显示"有待选新结果"
却点不了——R2 已经保证不覆盖人工成果，但用户没有出口：既不能采用新结果，也不能丢弃它。
这条路走通之后，"重新识别"才是一个完整的功能（识别 → 对比 → 采用或保留）。
它需要的材料都已经在库里：候选运行的行数据在 `ocr_runs/<run_id>.json`，
块的现状在 `block` 表，做左右对比 + 整页 / 逐块采用即可。
如果需要更轻的一步，也可以先做**疑难筛选**（在不确定 / 失败 / 有待选结果的页之间跳转），
那是厚书审校时最省时间的导航。

---

## 2026-10-14 — 任务 15：审校（Phase 3 第一步）——块可编辑、有历史、能撤销

### 任务目标

让**块从"能看"变成"能改"**：块文本可编辑并自动保存、可确认 / 标不确定 / 排除 / 改类型 /
标记延续、可"确认本页并跳到下一处未完成"，**每一次修改都记进事件表**，可以撤销 / 重做。

这是说明书反复强调的产品价值所在——"不是 OCR 包装器，核心价值在于人工审校"。
在此之前，识别结果只能看，不能改一个字。

**不在范围内（Phase 3 其余部分）：** 结构编辑（与上一块合并、在光标处拆分、上移 / 下移、
新增块、删除）、疑难筛选（在"含不确定 / 识别失败 / 有待选新结果"的页之间跳转）、
新识别结果的对比与采用、页眉页脚批量工具、快捷键的完整实现（见 7.5 的整张表）。

### 当前状态

- 任务 14 完成：识别与选页都可用，但块的文本是**只读**的；
- 没有 Event 表（说明书 5.1 要求"所有修改写入事件表"），因此没有追溯也没有撤销。

### 实施计划

1. 读说明书 5.1（数据原则）、5.3（Event 与撤销）、5.4（R3 / R5）、6.4（审校功能）、7.4 / 7.5。
2. 迁移 0003：`event` 表。
3. `core/project/editing.py`：改块（带乐观并发检查）、确认整页（R3）、把一批事件反过来应用。
4. 接口：`PATCH /projects/{id}/blocks/{bid}`、`POST /pages/{pid}/confirm`、`/undo`、`/redo`。
5. 界面：把"本页识别结果"面板升级为**审校视图**（可编辑块 + 自动保存 + 快捷键 + 撤销重做）。
6. 测试：事件内容、R3 的两种例外、并发冲突、撤销 / 重做的批次语义、会话级栈。
7. 真机验证与文档。

### 实现与验证

**离线测试：** `uv run pytest -q` → **465 passed**（原 449 + 16）。

| 新增覆盖 | 说明 |
|---|---|
| 事件内容 | 改文本记一条 `edit_text`，`before` / `after` 是**改动字段**（不是整行快照），actor=user |
| R5 文本隔离 | 改 `text` 不动 `ocr_text`；"恢复原文"就是把 `ocr_text` 写回 |
| 乐观并发 | 拿旧 `revision` 去写 → **409** 且不覆盖；值没变则不记事件、不加 revision |
| R3 确认整页 | 只确认"纳入且未审"的块；**不确定的块不动**并报出数量；排除的块不动 |
| 撤销 / 重做 | 撤销写回 `before`、重做再写 `after`；**确认整页是一批**，撤销一次全退回去 |
| 会话级栈 | 重启后撤销栈为空（说明书 5.3），但**成果本身不受影响** |
| 状态推导 | 页面的审校状态由块推导：未开始 → 有疑问 → 审校中 → 已完成 |

**真机验证（20 页样本 + 浏览器）：**

| 验证项 | 结果 |
|---|---|
| 迁移 0003 上老项目 | schema 2 → 3，自动建 `event` 表，**迁移前照例先备份**（备份目录已有 7 份） |
| 编辑 + 自动保存 | 改第 1 页首块 → 700ms 后"已保存 ✓"，页面头显示"已修改 1"、块上出现"● 已修改" |
| 撤销 / 重做 | 撤销后文本回到"第二十七回"、按钮变"重做 (1)"；重做后回到改过的文本 |
| 确认本页（⌘+Enter） | 先把一个块标为不确定 → 确认整页报"已确认 5 块；本页仍有 1 个不确定项"，并把**不确定的块留在原地**，随后**自动跳到第 2 页**（下一个未完成的纳入页） |
| 事件表 | 3 个批次 9 条事件：改文本 3 条（编辑 + 撤销 + 重做共用一个批次）、标不确定 1 条、确认整页 5 条 |
| 库里的块 | 改过的块 `revision=4`（改 → 撤 → 重做 → 确认），`text` 是改后的、`ocr_text` 仍是原文 |

**过程中的两个修正：**

1. **`IN ()` 让"确认整页"一个都不确认**：给 `block_ids` 的可选条件拼出了空的 `IN ()`，
   SQLite 里恒为假。测试立刻抓住了（`confirmed == 0`）。
2. **撤销栈里该放原始批次而不是"撤销产生的新事件"**：最初把撤销产生的反事件压进重做栈，
   结果重做时"再撤销一次"——值回到了原文而不是改后的文本。现在栈里始终是**原始那一批**，
   撤销写 `before`、重做写 `after`，来回搬都不会绕错。

**未验证 / 待处理项（必须诚实记录）：**

1. **结构编辑还没有**：合并 / 拆分 / 上移下移 / 新增 / 删除块都属于下一步。
2. **疑难筛选还没有**：还不能"只在有不确定或识别失败的页之间跳转"。
3. **"有待选新结果"仍不能采用**：R2 的候选结果看得见、点不了（采用要配对比视图）。
4. **审校视图在页面视图里**，没有独立的"审校"标签页；说明书 7.4 的左右分栏比例拖动、
   "⋯ 更多"菜单、折叠页眉页脚都还没做。
5. **快捷键只做了 4 个**（⌘Enter 确认、⌘Z / ⇧⌘Z 撤销重做、Alt+↑↓ 换块）；
   说明书 7.5 的表里还有标记不确定、排除、合并、拆分等，且**没有在 Chrome / Edge / Safari
   里逐个验证过冲突**（说明书要求实现前必须检查）。

### 用户操作说明

1. 在页面网格里**双击**某一页 → 打开审校视图（左图右文）。
2. 直接在右侧编辑块文本，停手约 0.7 秒自动保存（右上角显示"已保存 ✓"）。
3. 每个块下面：**✓ 确认** / **? 不确定** / **排除** / **↪ 延续下页**；
   类型在下拉框里改（页眉 / 页脚 / 页码在导出时默认排除）。
4. 改过的块可以**看原文**、**恢复原文**（OCR 原文一直保留着）。
5. **⌘/Ctrl + Enter**：确认本页并跳到下一个未完成的纳入页。
6. **⌘/Ctrl + Z** / **⇧⌘/Ctrl + Z**：撤销 / 重做（编辑框内是浏览器原生的文字撤销）。
7. **Alt + ↑ / ↓**：在块之间移动焦点。

### 下一步建议

**接着做 Phase 3 的结构编辑：与上一块合并、在光标处拆分、上移 / 下移、新增块、删除。**
理由：编辑与确认已经能用了，但真实审校里最高频的两个动作其实是"把被切碎的块合起来"
和"把一大块拆开"——识别分段是启发式的（L-21 已记录三类失效场景），
没有这两个操作，用户只能改字，改不了结构。它们都落在同一套 Event / 撤销机制上，
做完之后"审校"这件事才算真的能干活。之后再补疑难筛选与新结果对比采用。

---

## 2026-10-14 — 任务 14：挑选页面（选择、批量操作、筛选、样本试识别）

### 任务目标

补上 Phase 1 遗留、也是 Phase 2 最后一项要它支撑的功能：**能挑页面**。
在此之前批量识别只有"全部未识别页 / 全部纳入页"两个按钮——一本 400 页的书里
没法"只识别我关心的那 20 页"，而这恰恰是真实工作流的第一步。

具体做说明书 6.2 的选择方式（单击 / Shift 范围 / Mod 多选 / 页码输入）、
6.2 的批量操作（设置页面类型、纳入 / 排除）、6.2 的页面筛选、
以及 6.3 的样本试识别（选 3–10 页先试）。

**不在范围内：** 虚拟滚动（大书 1000 页以上的渲染优化，仍是 L-25）、
审校状态筛选（审校本身属于 Phase 3）、直接提取文本层。

### 当前状态

- 任务 13 完成：任务执行器可用，但批量只能按"全部"来；
- 界面上的"单击缩略图切换纳入/排除"与说明书 6.2 的"单击 = 选中"冲突；
- 页面类型只有数据与接口（`PATCH .../pages/{id}`），**界面上没有入口**。

### 实施计划

1. 重读说明书 6.2（页面准备）、6.3（识别）、7.3（页面视图的筛选与右侧面板）。
2. 接口：批量 `PATCH /projects/{id}/pages`（说明书第 11 节）+ 批量识别默认跳过已识别页。
3. 界面：选择模型（单击 / Shift / ⌘ / 页码输入）、选择面板（类型 / 纳入排除 / 识别所选 / 样本提示）。
4. 界面：筛选（类型 + 识别状态）+ **就地刷状态**（任务轮询时不再整格重建 400 个瓷砖）。
5. 测试与真机验证，然后更新文档。

### 实现与验证

**离线测试：** `uv run pytest -q` → **449 passed**（原 444 + 5）。

| 新增覆盖 | 说明 |
|---|---|
| 批量 PATCH | 一次改多页的类型 / 纳入、重启后仍在 |
| 整批一个事务 | 批次里有一个页面 id 不存在 → **整批拒绝**，不会出现"改了一半" |
| 参数校验 | 未知类型 / 空 id 列表 / 没给字段 → 明确拒绝 |
| 跳过已识别 | 说明书 6.3 的批量默认行为；全部已识别时如实拒绝并提示"去掉勾选的说明" |

**真机验证（20 页样本 + 浏览器）：**

| 验证项 | 结果 |
|---|---|
| 单击 / Shift / ⌘ | 单击选中 1 页；Shift 选中 3–8 共 6 页；⌘ 加选第 2 页 |
| 页码输入 | `1-3` 选中 3 页；`1-3, 99` 报"这些页码不存在：99"且**不改动已有选择** |
| 样本提示 | 选 5 页时提示"可以先当样本试识别……样本结果不代表整本书"（说明书 6.3） |
| 批量设类型 | 选 1 页设为封面 → 接口 200、瓷砖标签变"1 · 封面"、重启后仍在 |
| 批量排除 / 纳入 | 排除 1–3 → 纳入数 20 → 17，瓷砖半透明 + 删除线；再纳入恢复 |
| 筛选 | 类型=封面 / 识别=未识别 → 网格只剩匹配的页，摘要显示"当前显示 N 页" |
| 识别所选 | 勾着"跳过已识别的页"→ 明确拒绝并说明原因；去掉勾选 → 3 页重新识别，抽屉出现 |
| 就地刷状态 | 轮询时瓷砖 DOM **不重建**（标记存活）；筛选变化时重建（页面集合变了） |

**过程中的两处调整：**

1. **单击的语义改了**：原来是"单击 = 切换纳入/排除"，现在是"单击 = 选中"
   （说明书 6.2 的选择方式），纳入 / 排除移到选择面板上的按钮。这是有意的交互变更，
   记在 `docs/decisions.md` D-028。
2. **抽屉会压住选择面板的按钮**：任务抽屉固定在右下角，而"识别所选"这些按钮
   正好在同一高度。宽屏下抽屉打开时把内容推开（`margin-right`），窄屏保持覆盖。

**未验证 / 待处理项（必须诚实记录）：**

1. **虚拟滚动仍未做**：说明书 6.2 要求缩略图网格支持 1000 页以上，现在是全量渲染
   （靠 `loading="lazy"` 与浏览器缓存扛着）。已就地刷新，不再每次重建，
   但首次渲染 1000 个瓷砖仍然会卡。L-25 保留这一条。
2. **审校状态筛选没做**：审校状态本身要到 Phase 3 才有。
3. **没有 Windows 验证**（同前）。

### 用户操作说明

在项目页面视图里：

1. **单击**选中一页，**Shift + 单击**选一段，**⌘ / Ctrl + 单击**加减一页；
   也可以直接输入页码范围（如 `1-12, 300-310`）后回车。
3. 选择面板上：设类型、纳入 / 排除、**识别所选**（可勾选"跳过已识别的页"）。
4. 选 3–10 页时会提示"可以先当样本试识别"——认完点某一页的"结果"看质量，
   再决定要不要识别整本。
5. 顶部筛选可按**类型**与**识别状态**过滤，**全选（当前筛选）**只选当前可见的页。

### 下一步建议

**做审校视图（Phase 3）。** 现在从"导入"到"批量识别"到"任务控制"这条链路是完整的，
选页也有了，识别这一半已经够用。而说明书反复强调产品不是 OCR 包装器，
核心价值在人工审校——而块现在**只能看，不能改**：不能编辑、不能确认、不能合并拆分、
没有撤销、没有"不确定"标记。Phase 3 的第一块建议是**页面模式的块编辑 + 自动保存 +
确认整页**（含 Event 与撤销的基础），先把"能改"做出来，再做结构编辑与页眉页脚工具。

---

## 2026-10-14 — 任务 13：任务执行器（子进程 + 批量 + 暂停 / 继续 / 取消 / 重试）

### 任务目标

把识别从"一次一页、同步、卡住请求"变成**真正的后台任务**：识别跑在子进程里，
界面能看到进度、能暂停 / 继续 / 取消 / 重试失败页，应用被强杀也不留孤儿进程。
这是说明书 Phase 2 的主体部分，验收标准是"**中断测试通过；重试不产生重复块；
失败原因可见**"。

**不在范围内：** 挑选页面的界面（Shift 范围选择、页码输入——Phase 1 的遗留项 L-25）、
样本试识别（说明书 6.3，需要选页）、第二引擎与分歧检测（说明书 8.5）、
审校（Phase 3）、把导出接到项目上（Phase 4）。

### 当前状态

- 任务 12 完成：识别结果落库、R1 / R2 生效，但**同步执行、一次一页**——
  处理一本 400 页的书要一次点一页，且请求要挂几分钟。

### 实施计划

1. 读说明书 5.3（Job / JobItem）、6.3（批量识别与任务控制）、7.3（任务抽屉）、
   Phase 2 的验收标准。
2. 把任务记录与状态机抽成 `core/project/jobs.py`（按**项目目录**工作，
   这样执行子进程不需要知道项目库在哪）。
3. `recognition.py` 拆成"建任务"与"跑任务"两半：`create_ocr_job()` 在服务进程里校验，
   `run_job()` 在子进程里逐页识别落库。
4. `core/project/executor.py`：子进程监督器（起 / 跟踪 / 终止 / 对账 / 退出时收尾）。
5. `worker.py`：识别子进程入口，含"父进程死了就收工"的看门狗。
6. 接口：批量建任务、四个控制动作、进度轮询。
7. 界面：任务抽屉（进度 / 当前页 / 失败页 / 四个按钮）+ 批量按钮 + 轮询。
8. 测试分三层：任务数据层（快）、执行循环与监督器（快，假命令）、
   真子进程 + 真引擎端到端（慢，但只有它能证明中断与孤儿两条）。

### 实现与验证

**离线测试：**

| 验证项 | 结果 |
|---|---|
| `uv run pytest -q` | **444 passed**（原 387 + 新增 57） |
| 任务数据层（15 项） | 建 / 进度 / 状态机（含"状态不允许就拒绝"）/ 续跑取未成功单元 / 重试重置 / 修理 / 中断清理不误伤自己人 |
| 执行器（8 项） | 起 / 跟踪 / 终止 / 自动清理已退出的子进程 / 对账把"没进程却写着 running"改成中断 |
| 任务控制接口（19 项） | 暂停 → 继续 → 取消 → 重试失败页的状态机；取消保留已认完的页；"有活进程时不许重试" |
| 真子进程 + 真引擎（5 项） | 批量端到端、**杀进程后对账成中断并可继续**、**父进程管子一断子进程自行收工**、坏页不拖垮整批、失败页重试不产生重复块 |

**真机验证（20 页真实扫描样本，macOS arm64）：**

| 验证项 | 结果 |
|---|---|
| 批量识别 | 建任务立即返回（`queued`，17 页），识别在子进程里跑（`ps` 可见，内存 5.7%），进度与当前页实时可见 |
| 暂停 | 状态写 `paused`，**当前页做完后停下**（进度冻结 12 秒不动），**子进程原地等着**（pid 不变） |
| 继续 | 同一个子进程接着做，进度继续推进（3 → 7 页） |
| 取消 | 已认完的 11 页保留、正在认的那页记为失败（原因"任务已取消"）、剩下 5 页保持排队；子进程退出；"继续"起一个新子进程接着做剩下 5 页 |
| **强杀应用（`kill -9`）** | 识别子进程**立刻自行退出**（看门狗读到管子关闭），并把任务结算成"中断"、把没轮到的页留在排队；重启后"继续"完成剩余 3 页 |
| 重启后的清理 | 打开项目时"中断清理"没有误伤任何东西（子进程早已自行结算），日志链完整 |
| 界面端到端 | 批量按钮 → 抽屉出现（进度、"识别中 · 当前第 3 页"、按钮按状态禁用）→ 暂停 → 继续 → 取消 → 失败页卡片可点；缩略图状态实时跟随（识别中 / 排队中 / 已识别 · N 块） |

**过程中的四个修正（都是真机或真进程验证暴露出来的）：**

1. **子进程命令行漏了 `--job`**：识别进程一启动就因缺参数退出，任务一直停在 `queued`。
   假引擎那层测试看不见它——只有真起进程才暴露。已修，并保留真子进程测试盯着。
2. **看门狗用的 `sys.stdin.buffer.read()` 在解释器退出时与 daemon 线程抢缓冲锁**，
   每个识别进程结束时都会留下 `Fatal Python error: _enter_buffered_busy`。
   改成直接 `os.read(0, ...)`（不碰缓冲对象），并且**只在 stdin 是管道时启用**——
   手动在终端里跑不该被当成"父进程死了"（实测 `stdin=/dev/null` 会立刻误判）。
3. **引擎的 INFO 日志（含模型绝对路径）被收进项目的任务日志**：RapidOCR 在构造时用
   配置里的 `Global.log_level` 覆盖 logger 级别，因此在外面 `setLevel(WARNING)` 无效。
   改成构造时传 `params={"Global.log_level": "warning"}`。现在任务日志只有页码、结果与耗时。
4. **单元指向的页面不存在时静默跳过**：任务会显示"成功"但一页都没做（我在手工脚本里
   传了错误的 page_id 才撞上）。现在这种单元如实记为失败，原因是"单元指向的页面不存在"。

5. 另外修了一个 Phase 1 就存在的问题：**同一个服务进程重新打开自己开着的项目会被拒绝**
   （锁的持有者就是自己）。现在锁分"别人持有"与"本进程持有"，自己开的项目在项目卡上
   也不再显示"使用中"。多标签页因此可以正常工作。

**未验证 / 待处理项（必须诚实记录）：**

1. **挑选页面还没有界面**：批量只有"全部未识别页"与"全部纳入页"两种范围，
   说明书 6.3 的"选中页 / 识别样本（3–10 页）"要等 Shift 范围选择与页码输入（L-25）。
2. **并发固定为 1 个识别子进程**：说明书 6.3 说"默认 1 个，设置中可调整"，
   设置项还没做。
3. **暂停的粒度是"页"**：说明书也是这么规定的（"当前页完成后停止"），
   但一页可能要几秒到几十秒，界面上的"暂停"因此不是瞬时的。
4. **没有 Windows 验证**：子进程、`start_new_session`、terminate 的行为都没在 Windows 上跑过；
   看门狗用的是 fd，跨平台但同样未经实测。
5. **任务日志会累积**：每个任务一个 `logs/ocr-<job_id>.log`，没有清理策略。

### 用户操作说明

**跑测试：**

```bash
uv run pytest -q            # 全部（含任务数据层、控制接口、真子进程端到端）
uv run pytest -q -m "not ocr"   # 不装 OCR 依赖时
```

**在界面上走一遍：**

```bash
./scripts/start.command
```

1. 打开项目 → 点"识别全部未识别页" → 右下角出现**任务抽屉**（进度、当前页、按钮）。
2. 点"暂停"：当前页做完后停下；点"继续"接着做。
3. 点"取消"：已认完的页保留；之后点"继续"接着做没做完的。
4. 有失败页时抽屉里会列出来，点一下跳到那页；"重试失败页"只重做失败的页。
5. 识别中直接关掉应用（或强制结束）：不会有进程继续在后台写数据库；
   下次打开项目时那个任务是"中断"状态，点"继续"接着做。

### 下一步建议

**做审校视图（Phase 3）。** 理由：识别这条链路现在完整了——能批量、能控制、能中断恢复，
结果按说明书 5.3 落在库里。而产品价值的下半段（说明书反复强调"不是 OCR 包装器，
核心价值在人工审校"）还没有开始：块现在只能看，不能改、不能确认、不能合并拆分，
也没有撤销。做它之前先确认一件事：**现在要不要先补 Phase 1 的选页界面**
（Shift 范围 / 页码输入）——它很小，但没有它就没法"只识别我关心的那 20 页"，
在一本 400 页的书上这是真实痛点。

---

## 2026-10-14 — 任务 12：把识别接到项目上（Phase 2 的开头）

### 任务目标

让识别结果**落进项目数据库**：识别一次，`job` / `job_item` / `ocr_run` / `block` /
`block_line` 五张表都写好，关掉应用再打开还在。这是说明书 Phase 2 的第一部分，
也是"两套流程并存"（项目能存不能认、临时上传能认不能存）开始合一的那一步。

**最直接的收益：** 识别结果不再"刷新即丢"。在此之前，界面上的识别只在浏览器内存里，
处理一本 400 页的书要一次点一页、且中途不能关。

**不在范围内（下一步）：** 子进程任务执行器、批量识别、暂停 / 继续 / 取消 / 重试失败页、
任务抽屉；第二引擎与按行分歧检测（说明书 8.5）；块的编辑与审校（Phase 3）；
把导出也接到项目上（Phase 4）。因此临时上传那一块**暂时保留**——它现在只剩导出在用。

### 当前状态

- 任务 11 完成：项目与页面已持久化，但**没有块**；识别走 `/api/scratch/*`，刷新即丢。
- `block` / `block_line` / `ocr_run` 三张表不存在（说明书 5.3 的实体尚未建）。

### 实施计划

1. 读说明书 5.3（五张表的字段）、5.4（R1 / R2 / R7）、6.1、第 11 节的接口表、Phase 2 的验收标准。
2. 迁移 0002：`ocr_run` / `block` / `block_line` / `job` / `job_item`。
3. `core/project/blocks.py`：块、行、运行、任务的读取 + **识别状态推导**（说明书 5.3 要求状态不单独存储）。
4. `core/project/recognition.py`：渲染 → 识别 → 分段 → 落库，含 R1 / R2 与原始输出文件。
5. 接口：`POST /projects/{id}/jobs/ocr`、`GET /projects/{id}/jobs[/{jid}]`、
   `GET /projects/{id}/pages/{n}/blocks`、`.../runs`；页面载荷带上识别状态。
6. 界面：缩略图上的识别按钮与状态、本页识别结果面板、项目卡与项目头的识别进度。
7. 测试：假引擎跑通落库与 R1 / R2（快、确定），真引擎跑端到端（真实坐标与真实耗时）。
8. 真机验证：真扫描样本 + 杀进程 + 重启 + 浏览器走一遍。

### 实现与验证

**离线测试：**

| 验证项 | 结果 |
|---|---|
| `uv run pytest -q` | **387 passed**（原 348 + 新增 39） |
| 假引擎集成测试（19 项） | R1 首次识别、R2 替换与"绝不覆盖人工成果"、失败原因可见、中断清理、参数边界、鉴权 |
| 真引擎集成测试（2 项） | 真实 RapidOCR 识别旋转页并落库；重启后逐字节一致 |
| 迁移测试 | 五张表的字段逐项对照说明书 5.3；`ocr_run.status` 的 CHECK 拒绝拼错的状态 |

**真机验证（20 页真实扫描样本 `sample-20p-300dpi.pdf`，300 DPI，macOS arm64）：**

| 验证项 | 结果 |
|---|---|
| 建项目 → 识别第 1 页 | 6 块 / 26 行；任务 succeeded 1/1；耗时 **2.69 秒**（引擎 2.16 秒 + 渲染 + 落库） |
| 原始输出落盘 | `ocr_runs/<run_id>.json` 7.3 KB，含 26 行的文本、归一化坐标与置信度 |
| **杀进程（`kill -9`）→ 重启** | 项目文件夹与库记录完整；第 1 页 6 块、1 次运行、1 个任务**全部还在**；项目卡显示"已识别 1 页" |
| 重新识别（无人工作） | R2 替换：运行记录变 2 条，当前块 6 个、**旧块 6 个软删除**（`deleted_at` 有值），`block_line` 共 52 行 |
| 界面端到端 | 状态徽章（未识别 / 已识别 · N 块）、点识别后出现"识别中…"、完成后徽章与"已识别 N 页"同步更新 |
| 本页识别结果面板 | 原图（view 档）+ 蓝框叠加，实测框与文字对齐；点块 → 图上框高亮，双向联动正确 |
| 排除页 | 识别按钮禁用并提示"已排除，不参与识别"；接口侧同样拒绝（400） |

**真实识别结果的两点观察（如实记录）：**

1. **章首页是双栏版面**（左栏章回标题 + 插图，右栏正文）。分段模块按"横向区间重叠"聚栏、
   左栏在前，得到 6 块，与页面上的 6 个自然段**逐一对应**——这是 8.1 的规则在真实页面上的第一次检验。
2. 第 3 页第 1 块是**插图上装饰文字的误读**（"于撕 / 佔扇 / 十金式笑"）。这不是缺陷：
   说明书 1.5 要求原样保留引擎输出，这类内容正是审校要处理的对象。它同时说明
   **识别结果是候选，不是事实**。

**过程中的修正：**

1. 界面顶栏的"阶段"文字与引擎自检的说明是 **Phase 0 的旧文案**（"未安装任何 OCR 依赖"），
   与事实不符（RapidOCR 3.10.0 已可用）。已改为按当前环境如实生成。
2. `/api/app/info` 的 `limits` 仍写着"没有项目与数据库"，同样过期，已按现状重写。
3. 落库时发现分段当时的"疑似多栏、阅读顺序待确认"提示会丢（块表里没有这个字段），
   已把它写进 `ocr_runs/<run_id>.json` 的 `layout` 段——块本身入库，判断依据不丢。

**未验证 / 待处理项（必须诚实记录）：**

1. **批量识别没有做**：接口一次只接受一页，多页请求明确回 400 并说明原因。
   同步识别一整本书会让请求挂上几小时，不如明确拒绝。
2. **没有任务执行器**：说明书 Phase 2 要求的子进程执行器、暂停 / 继续 / 取消 / 重试失败页、
   断点续跑、任务抽屉都还没有。任务只有 `queued → running → succeeded/failed → interrupted` 这条链。
3. **"有待选新结果"只能看到、不能采用**：R2 的保护分支（已有人工成果时不覆盖）已实现并有测试，
   但采用 / 保留的对比界面属于 Phase 3，因此界面只给出提示。
4. **导出仍走临时上传**：项目里的识别结果暂时无法导出——导出接口是无状态的（D-018），
   接项目属于 Phase 4。因此界面上的"临时上传"卡片**保留**，它现在只剩导出在用。
5. **识别状态推导没有在界面上完整呈现**：`queued` / `has_candidate` 有数据与徽章，
   但没有做"按识别状态筛选页面"（说明书 6.2），也没有任务抽屉。

### 用户操作说明

**跑测试：**

```bash
cd /Users/chenlin/Desktop/软件开发/book2text
uv run pytest -q                 # 全部（含识别落库、R1 / R2）
uv run pytest -q -m ocr          # 只跑需要真实引擎的（uv sync --group ocr-eval）
```

**在界面上走一遍：**

```bash
./scripts/start.command           # 或 uv run book2text
```

1. 项目库里建一个项目（上传扫描 PDF）。
2. 在缩略图上点某一页的**识别**按钮——几秒后徽章变成"已识别 · N 块"。
3. 点**结果**：左边原图带块框，右边是该页的块文本；点块可定位。
4. **关掉应用再打开**，进同一个项目——块、运行记录、任务都还在。

### 下一步建议

**做任务执行器：子进程 + 批量识别 + 任务抽屉。** 理由：现在单页识别的链路已经通了，
挡在"能处理一本书"前面的只剩执行方式——同步、一次一页。执行器要解决的问题是明确的：
子进程跑识别（峰值内存约 2.7 GB，不该占用服务进程）、按页拆 JobItem（说明书 5.3 已经规定了
断点续跑与幂等重试的形状）、进度可见（任务抽屉）、可取消（杀子进程）。
数据模型与接口形状都已按说明书写好，换执行器时接口不变，只是从"同步返回"变成"返回排队中的任务"。

---

## 2026-10-14 — 任务 11：Phase 1 第一步——项目与持久化

### 任务目标

开始 Phase 1（项目库与页面视图）。本轮做**数据基础**：
项目数据库与迁移框架、项目库、新建项目与 PDF 导入、页面记录、上次位置、
项目锁、自动备份。

**为什么这一步最关键：** 在此之前所有成果刷新即丢，导出只能用"本次会话识别过的页面"，
处理一本 400 页的书要几百次点击且中途不能关。这是产品从"能演示"到"能用"的分界。

**不在范围内：** 缩略图 Job（属 Phase 2）、批量页面选择（Shift 范围 / 页码输入）、
页面类型标注的界面、虚拟滚动、把识别接到项目上。

### 当前状态

- 任务 10 完成：导出完整（9.1–9.5），但全部基于临时上传、不持久化。
- 没有数据库、没有项目概念；`core/storage/` 下只有 Phase 0 的临时上传。

### 实施计划

1. 读说明书 6.1（项目管理）、7.2（项目库）、7.6（保存与恢复）、5.1（数据原则）。
2. ULID 与迁移框架（说明书 5.1 要求实体 ID 用 ULID、结构变化必须有迁移）。
3. 项目锁与流式写入。
4. 项目库：创建 / 列举 / 打开 / 关闭 / 页面。
5. 项目接口。
6. 界面：项目库作为入口。
7. 按 Phase 1 的**验收标准**验证。

### 实现与验证

**Phase 1 的三条验收标准逐条验证：**

| 验收标准 | 结果 |
|---|---|
| 创建项目、关闭、**重启后状态完整** | ✅ 界面建项目 → 杀进程 → 重启服务 → 项目《样本扫描书》20 页记录完整、纳入数一致 |
| **原始 PDF 未被修改** | ✅ 哈希与 mtime 完全未变；项目里是**副本**（`resolve()` 路径不同，不是链接） |
| **项目文件夹跨平台拷贝后可以打开** | ✅ 把项目文件夹整个复制到另一个项目库目录，用新装配的应用读它——能列出、能打开 |

**其余验证：**

| 验证项 | 结果 |
|---|---|
| `uv run pytest -q` | **348 passed**（原 296 + 新增 52） |
| 项目目录结构 | 符合说明书 12.1：`project.db`、`.lock`、`source/original.pdf`、`ocr_runs/`、`cache/{thumbs,view,ocr,lines}/`、`exports/`、`backups/`、`logs/` |
| 锁 | 第二次打开被拒并说明原因；**只读打开**可用；**强制打开**附风险提示；关闭后释放 |
| **失效锁检测** | 杀进程后留下的 `.lock` 被正确识别为"本机 + 进程已死"，不挡使用 |
| 备份 | 每次打开生成一份，用 SQLite 在线备份 API（WAL 下不能直接复制文件） |
| 页面记录 | 几何与旋转正确——`/Rotate=90` 的页存的是**显示尺寸**（宽高已交换，说明书 5.2 的坐标基准） |
| 文本层检测 | 原生排版 PDF 三页全部检出并给出"可能已含文本"提示；图像型 PDF 不提示 |
| 界面端到端 | 空库提示 → 建项目 → 打开 → 20 页缩略图全部加载 → 单击切换纳入 → 批量纳入/排除 |

**过程中的三个修正：**

1. `save_position` 的 SQL 少写了 WHERE 却多绑了一个参数——项目表仅一行（说明书 5.3），
   不需要 WHERE，去掉多余的绑定。
2. `StreamError`（空文件 / 非 PDF）没被转成项目层错误，会以 500 冒出来；已在
   `create_project` 里捕获并转成 `ProjectError`，API 回 400。
3. `_print_banner` 加了项目库路径却没接参数，导致启动即崩——已修。

**未验证 / 待处理项：**

1. **识别、分段、导出还没接到项目上**：它们仍走 Phase 0 的临时上传，刷新即丢（L-26）。
   现在是两套并存的流程。
2. **缩略图按需渲染、不缓存**（L-25）：说明书要求由后台 Job 生成，Job 属 Phase 2。
3. **批量页面选择与页面类型标注的界面未做**（L-25）。
4. 服务不跟踪"哪些项目正开着"，强制结束时 `.lock` 会留下（下次打开会被判为失效锁）。
5. 只在 macOS 上验证；**跨平台拷贝那一条是用本机两个目录模拟的**，
   真正的"Mac → Windows 拷贝"未验证。
6. 未在 Windows 上运行任何内容。

### 用户操作说明

```bash
uv run book2text                      # 项目库默认在 ~/Documents/Book2Text
uv run book2text --library /tmp/books # 或指定别的目录
```

界面上：在「项目库」里填书名 → 「选择 PDF 并新建项目」→ 自动打开并显示页面网格 →
单击缩略图切换纳入 / 排除。项目会一直留着，关掉应用再打开还在。

```bash
uv run pytest -q   # 全套 348 项
```

**回退方式：** 删除 `core/storage/{ulid,migration,db,streaming}.py`、
`core/storage/migrations/`、`core/project/`、`api/routes_projects.py`，
撤掉 `app.py` 里的路由注册与 `--library` 选项，以及界面上的项目库区块。
Phase 0 的临时上传流程不受影响。

### 下一步建议

**把识别接到项目上（Phase 2 的开头）。**

理由：现在两套流程并存、各缺一半——项目侧能持久化但不能识别，
临时侧能识别但不持久化。说明书 6.1 要的是"上传后进入页面视图，再从页面视图发起识别"，
即两者合一。做完它：

- 识别结果与块有了归宿（`block` / `block_line` / `ocr_run` 三张表，说明书 5.3）；
- 导出不再限于"本次会话"，能覆盖整本书；
- **临时上传那一块可以整个删掉**，连同 `core/storage/scratch.py`，
  现在是它拖着两套流程。

具体建议先做**单页识别 + 落库 + 最小 Job**（不追批量与暂停/继续），
让"识别 → 存 → 重启还在"这条链路先通，再补批量与任务控制。

---

## 2026-10-14 — 任务 10：JSONL 与 manifest（说明书 9.5）——导出这条路补齐

### 任务目标

实现说明书 9.5 的 JSONL 与 manifest.json，把第 9 节的导出补齐。
做完这一步，导出这条路（9.1–9.5）就完整了。

**不在范围内：** 导出文件落盘到项目 `exports/`（无项目目录）、
"在文件夹中显示"（说明书 4.5）、批量识别、审校状态、持久化。

### 当前状态

- 任务 9 完成：TXT 能导出，manifest 未生成。
- 断词还原记录已产出，但只覆盖块内换行处；跨块拼接处的没有收集，
  块内的也没有进任何 manifest。

### 实施计划

1. 重读说明书 9.5 的字段形状与 12.1 的导出目录命名。
2. 实现 `jsonl.py` 与 `manifest.py`。
3. 补齐断词还原的收集（块内 + 跨块）。
4. 接口加 `/jsonl`，两种格式都附 manifest。
5. 界面加格式切换与两个下载按钮。
6. 端到端验证到"下载出文件并逐字节校验"。

### 实现与验证

| 验证项 | 结果 |
|---|---|
| `uv run pytest -q` | **296 passed**（原 268 + 新增 28） |
| JSONL 单元测试 | 11 项；其中一项按说明书 13.2 校验**每行都是有效 JSON** |
| manifest 单元测试 | 8 项；其中一项逐字段核对说明书 9.5 列出的七项 |
| 接口测试 | 8 项，含"排除内容不出现在导出中"（说明书 13.2）与"数量与预检一致"（13.3） |
| **端到端（真实浏览器 + 真下载）** | 识别前两页 → 标记跨页延续 → 切 JSONL → 生成 → 下载两个文件 |
| `segments.jsonl` 校验 | 0 个 CR、无 BOM、结尾换行、**7/7 行有效 JSON**、字段与 9.5 一致 |
| 跨页合并校验 | 合并段的 `pages=[1,2]`、`block_ids=['p1-b5','p2-b0']`，文本正确衔接 |
| `manifest.json` 校验 | 9.5 要求的七个字段一个不缺；`export_id` 符合 12.1 命名；SHA-256 与上传一致 |

**修掉一个真实缺口：** 第一版 manifest 只收集**跨块拼接处**的断词还原，
**漏掉了块内换行处的**——实测 `self-` + `evident` 没进 manifest，而说明书 9.2
要求的正是"所有被英文断词还原处理过的位置"。现在两条路径都收集，
并补上可抽查的上下文：段号、块号、`scope`（block / segment）、位置、前后片段。
同时把片段从"整行"改成"末尾/开头的词"——manifest 是给人抽查的，
记 `self-` + `evident` 比记两整行有用。

**统一了一处口径不一致（D-019）：** `char_count` 原本在 manifest（内容字数）与
preflight（文件长度）里含义不同，差段间空行数（实测 17 对 20）。
现在两处统一为内容字数——文件长度会随格式变化，不适合做统计口径。

**未验证 / 待处理项：**

1. **导出文件不落盘**：浏览器直接下载，不写 `exports/<时间戳>_<格式>/`，
   也没有"在文件夹中显示"（说明书 4.5 / 12.1）。
2. **导出范围 = 本次会话识别过的页面**（L-24 / D-018）。
3. **"排除页眉页脚页码"当前无效**：块类型全是 `paragraph`（L-22）。
4. **没有审校状态**，因此"仅已确认"范围只在有无 `review_status` 数据时才有意义。
5. **未在 Windows 上运行任何内容。**

### 用户操作说明

界面上：识别若干页 → 在块卡片上按需取消「纳入」或勾选「延续下页」→
选 TXT 或 JSONL → 「生成」→ 「下载数据文件」与「下载 manifest.json」。

```bash
uv run pytest tests/unit/test_export_jsonl_manifest.py -q   # 9.5 的测试
uv run pytest -q                                            # 全套 296 项
```

**回退方式：** 删除 `core/export/jsonl.py`、`manifest.py` 与 `/api/export/jsonl` 路由，
以及界面上的格式切换与 manifest 下载按钮。TXT 导出不受影响（只是会少掉 manifest 字段）。

### 下一步建议

**开始 Phase 1：项目与数据库（持久化）。**

理由：说明书第 9 节的导出已经完整（9.1–9.5 全部实现），但它**受制于没有持久化**：

- 识别结果刷新即丢，导出只能用"本次会话识别过的页面"；
- 块级标记（纳入 / 延续）同样刷新即丢；
- 导出文件不能落盘到项目目录，也没有"在文件夹中显示"；
- 说明书 9.3 的"排除页眉页脚"、9.1 的"仅已确认"，都因为没有数据模型而无法真正生效。

这是当前**最大的短板**：产品能演示完整流程，但还不能真正拿来干活——
处理一本 400 页的书需要几百次点击，中途刷新就前功尽弃。

Phase 1 的内容说明书列得很清楚：项目数据库与迁移框架、项目库、新建项目与 PDF 导入、
缩略图任务、页面视图（选择、类型、纳入 / 排除、筛选）、上次位置、项目锁、自动备份。
验收标准是"创建项目、关闭、重启后状态完整；原始 PDF 未被修改；项目文件夹跨平台拷贝后可以打开"。

---

## 2026-10-14 — 任务 9：段生成 + 清理 + TXT 导出（说明书 9.1 / 9.3 / 9.4）

### 任务目标

按说明书第 9 节打通导出：**9.1 段生成**（跨页拼接）→ **9.3 清理规则** →
**9.4 TXT**。目标是产出第一份真正的导出文件——从"能看见文字"到"能拿到成果"。

**不在范围内：** JSONL 与 manifest（9.5）、导出文件落盘到项目 `exports/`（无项目目录）、
审校状态（Phase 3）、持久化（Phase 1）。

### 当前状态

- 任务 8 完成：行能拼成段落，但只能在界面上看，不能导出。
- 说明书 9.1 的段生成、9.3 的清理规则、9.4 的 TXT 都未实现。

### 实施计划

1. 先确认 `continues_to_next` 是自动检测还是人工标记（决定整个设计）。
2. 实现 `segments.py`（9.1），输入用说明书 5.3 的 Block 字段子集。
3. 实现 `cleanup.py`（9.3）与 `txt.py`（9.4）。
4. 导出接口：**规则只在服务端实现一份**。
5. 界面加块级标记与导出面板，端到端验证到"下载出文件"为止。
6. 逐项校验导出文件的字节与内容。

### 实现与验证

**先确认的关键事实：** `continues_to_next` 在说明书里出现在**块操作**清单中
（6.4 与 7.4 的"标记延续到下一页"），是**人工标记**，说明书**没有**设计自动判断跨页段落。
这符合"结构由人控制、不做静默决策"的产品原则。因此段生成只按标记行事，不猜测。

| 验证项 | 结果 |
|---|---|
| `uv run pytest -q` | **268 passed**（原 198 + 新增 70） |
| 段生成测试 | 29 项，覆盖 9.1 的四条规则与全部筛选条件 |
| 清理与 TXT 测试 | 22 项，含"锁定 CleanupRules 字段集合"的防污染测试 |
| 导出接口测试 | 19 项 |
| **端到端（真实浏览器 + 真下载）** | 识别样本第 3、4 页 → 排除垃圾块 → 标记跨页延续 → 生成 → 下载 TXT |
| 导出文件字节校验 | UTF-8 **无 BOM**、**0 个 CR**、段间恰好一个空行 |
| **跨页拼接校验** | 页边界"…他只当是昨日金钏儿之事，他" + "没好意思的，越发不理他。" **无缝拼接、无空格** |
| 汉字间空格校验 | 全文 **0 处** |

**顺带确认了一个交互问题（值得记录）：** 竖排装饰边栏的 OCR 结果会排在下一页
阅读顺序的最前面，**导致跨页合并挂到错误对象上**——第一次实测时那段正文合并到了
"红楼梦/00000"这个边栏垃圾块。界面上取消该块的"纳入"即可绕过。
这说明 L-22（块类型全是 paragraph）不只影响页眉页脚排除，**还影响跨页拼接的正确性**。

**未验证 / 待处理项：**

1. **JSONL 与 manifest.json 未实现**（9.5），断词还原位置只记录、未写入 manifest。
2. **导出文件不落盘**：由浏览器直接下载，不写项目的 `exports/` 目录，
   也没有"在文件夹中显示"（说明书 4.5）。
3. **导出范围 = 本次会话识别过的页面**，因为没有批量识别与持久化（L-24）。
4. **块级标记刷新即丢**：它们是说明书 5.3 的 `include` / `continues_to_next`，
   但无持久化。
5. **"排除页眉页脚页码"当前无效**：块类型全是 `paragraph`（L-22）。
6. **说明书 9.3 与 9.4 对脚注的默认处理口径不一致**：9.3 的排除清单不含脚注，
   9.4 却说脚注"默认不导出"。本次按 9.4 的默认执行（`include_footnotes=False`），
   已记入文档待开发者裁决。
7. 未在 Windows 上运行任何内容。

### 用户操作说明

1. 上传 PDF，逐页翻到要处理的页，点「识别本页」（**每页都要点一次**）。
2. 在块卡片上按需取消「纳入」（排除装饰边栏、页码等垃圾块），
   或勾选「延续下页」把跨页段落接起来。
3. 点「生成」看预检摘要与预览，点「下载」得到 `book2text-export.txt`。

```bash
uv run pytest tests/unit/test_export_segments.py tests/unit/test_export_cleanup.py -q
uv run pytest -q          # 全套 268 项
```

**回退方式：** 删除 `core/export/segments.py`、`cleanup.py`、`txt.py` 与
`api/routes_export.py`，撤掉 `app.py` 里的路由注册与界面的导出面板。
识别、分段、拼段不受影响。

### 下一步建议

**实现说明书 9.5 的 JSONL 与 manifest.json，把导出这套补齐。**

理由：manifest 是 9.2 明确要求的东西（断词还原位置写入以便抽查），
而 JSONL 的段结构（`pages` / `block_ids` / `review`）**已经在 `Segment` 里算好了**
（`to_dict()` 就是 JSONL 的字段形状），这一节主要是补序列化与文件组织，代价小、收尾干净。

补完之后，导出这条路（9.1–9.5）就完整了，**那时最该做的是 Phase 1 的持久化**：
现在所有成果刷新即丢、导出只能用本次会话的页面，这是当前体验上最大的短板，
也是产品从"能演示"变成"能用"的分界。

---

## 2026-10-14 — 任务 8：行合并规则（说明书 9.2）

### 任务目标

实现说明书 9.2 的行合并规则，把块内的换行拼成连续段落文本。
说明书写明"块内换行和跨块拼接**使用同一规则**"，所以这同时也是 9.1 段生成的基元。

**不在范围内：** 段生成（9.1）、清理规则（9.3）、TXT / JSONL 导出（9.4 / 9.5）、
manifest.json 的写入。

### 当前状态

- 任务 7 完成：行已能组合成块，但块文本**保留行内换行**（说明书 5.3 的规定），
  读起来还是断行的。
- `core/export/` 目录不存在。

### 实施计划

1. 重读说明书 9.2 的规则表与 9.3 的清理规则（确认边界：哪些属于本切片）。
2. 实现 `joining.py`：一个 `join_pair()` 承载规则表，`join_lines()` 供块内与跨块使用。
3. **逐行覆盖规则表的测试**（说明书明确要求）。
4. 接口返回拼段结果，界面加"保留换行 / 拼成段落"切换以肉眼验证。
5. 写明对说明书未覆盖情形的解释。

### 实现与验证

| 验证项 | 结果 |
|---|---|
| `uv run pytest -q` | **198 passed**（原 157 + 新增 41） |
| 规则表覆盖 | 四行各有独立测试（参数化），另有 5 条解释性行为测试 |
| 中文段落 | 样本第 1 页 7 行正文 → 117 字无换行无空格的连续段落 |
| 英文段落 | 样本第 16 页脚注 → 词间空格正确保留 |
| 中英混排 | `他把 Random Forest 和 Gradient` + `Boosting 都试了一遍` → 词间留空格、汉字后不留 |
| 真实浏览器 | 切换"保留换行/拼成段落"生效并可来回切换；块头显示断词还原处数 |

**由测试发现的规则盲区（代码需扩展，不是测试写错）：**

规则表说"拉丁字母 + 行尾连字符 | 小写拉丁字母"，但**没规定连字符后接数字**。
第一版据此实现，结果 `1990-` + `1995`（区间号断行）被规则 3 拼成 `1990- 1995`——明显错误。
因此扩展为"行尾连字符两侧都是拉丁字母或数字时直接连接"，并把判据写成
"该串在下一行继续"。已在模块说明与 D-017 里标注**这是对说明书的扩展**。

**由测试确认的既有约定（我的测试期望写错了，代码是对的）：**
`1971 年` + `summer` 拼成 `1971 年summer`——不加空格。说明书规则 4 明确规定
中日韩↔拉丁"直接连接，不额外加空格"。这看起来别扭，但它是说明书的规定，
我照做并在测试里**如实断言**，同时把这条与 8.7 空格归一化的口径差异写进 D-017。

**未验证 / 待处理项：**

1. **不能导出**：拼出的段落只能在界面上看，没有 TXT / JSONL（9.4 / 9.5）。
2. **manifest.json 未生成**：断词还原位置的记录已经产出，但写入 manifest 属 9.5。
3. **清理规则 9.3 未实现**：其中第 2/3/5 项已在拼接中生效；
   "按块类型排除页眉页脚"做不了（块类型全是 `paragraph`，L-22）。
4. **断词还原可能误处理**：说明书自己也提示 `self-` + `evident` 这类真实连字符
   可能被误删。目前只记录，界面上无法人工校正。
5. **跨块拼接未实测**：`join_pair` 已按"同一规则"设计，但段生成（9.1）没做，
   所以跨页 / 跨块的拼接路径只有单元测试覆盖，没有端到端验证。
6. 未在 Windows 上运行任何内容。

### 用户操作说明

识别后，面板右上角可在**保留换行**与**拼成段落**之间切换——前者是 `Block.text`
的存储形态（说明书 5.3 要求保留换行），后者是按 9.2 拼出的导出形态。
块头会显示"断词还原 N 处"。

```bash
uv run pytest tests/unit/test_line_joining.py -q   # 规则表逐行测试
uv run pytest -q                                   # 全套 198 项
```

**回退方式：** 删除 `core/export/`，撤掉 `routes_scratch.py` 中 `joining` 的调用
与返回字段，以及界面上的文本形态切换。分段与识别不受影响。

### 下一步建议

**实现说明书 9.1 的段生成（跨页段落拼接）。**

理由：9.2 已经提供了拼接基元，9.1 决定**哪些块该拼在一起**——核心是
`continues_to_next` 与"标题块单独成段"。它直接对应产品最看重的场景之一
（样本第 3、4 页就是被页边界断开的同一段，验证材料现成）。
做完它，再加 9.3 的清理规则与 9.4/9.5 的输出格式，就能产出第一份真正的导出文件——
那也才是"能看见文字"到"能拿到成果"的转折点。

---

## 2026-10-14 — 任务 7：行 → 块（`core/structure/grouping.py`）

### 任务目标

实现说明书 8.1 的分段模块：把 OCR 返回的**行**按**行距、缩进、对齐**组合成**块**。
块是产品的操作单位——没有它，审校视图、块类型标注、页眉页脚批量工具、
跨页段落拼接、TXT/JSONL 分段导出全都做不了。

**不在范围内：** 块的人工合并 / 拆分（Phase 3）、块类型标注（6.5 / 版面组件）、
段生成与行合并（9.1 / 9.2，属导出）、持久化（Phase 1）。

### 当前状态

- 任务 6 完成：识别已接进应用并返回行，但没有块。
- `core/structure/` 目录不存在。

### 实施计划

1. 读说明书 8.1（分段规则与阅读顺序）、8.4（版面组件给的是区域不是自然段）、
   5.3（Block 实体）、9.1–9.3（段与导出，确认边界）。
2. 实现 `grouping.py`。
3. **用真实样本页验证**，不只看单元测试。
4. 写规则测试（说明书要求"规则必须有测试"）。
5. 接口返回块、界面按块展示。
6. 记录启发式的失效场景。

### 实现与验证

**规则（说明书 8.1 点名的三条）：** 任一命中即在两行之间断开——
① **行距**超过"常规行距 + 0.6 × 行高"；② **对齐**：本行右边界比版心右边明显短出
2 个字宽（段落末行）；③ **缩进**：下一行左边界右移超过 1.2 个字宽（段首缩进）。

**多栏与阅读顺序：** 按"横向区间是否重叠"把行聚成栏（用区间重叠而不是左边界——
居中标题的左边界远大于正文，用左边界会被误判成独立一栏）。多于 1 栏时按栏排序
并**标记"阅读顺序待检查"**，因为说明书 8.1 明确要求"不假装已正确排序"。

**与版面组件的接法：** 版面组件给的是**区域不是自然段**（说明书 8.4），
所以启用它时**对每个区域调用一次 `group_lines()` 即可**，路线 B 与路线 C 共用同一套规则。

**真实数据验证**（样本页，300 DPI）：

| 样本页 | 形态 | 行 → 块 | 栏 | 结果 |
|---|---|---|---|---|
| 1 | 中文双栏（左标题+右正文） | 26 → 6 | 2 | "第二十七回"独立成块；回目两行成一块；右栏正文切成 7/8/3/5 行 |
| 4 | 中文纯正文 + 竖排装饰边栏 | 28 → 5 | 2 | 边栏+页码单独成"栏"，正文段落切分合理 |
| 16 | 英文脚注密集 | 24 → 11 | 1 | 每条脚注各自成块（末行短规则生效） |
| 20 | 英文索引 | 22 → 9 | 1 | 索引条目分组合理 |

**测试：** 21 项分组测试（三条规则各覆盖"触发"与"不触发"两侧、多栏、阅读顺序、
子集复用、块几何与文本、顺序编号），加 2 项接口集成测试。全套 **157 passed**。

**界面：** 识别后按**块**展示（块头显示类型 / 行数 / 栏号，块内保留行内换行），
图上叠加**块框**，点击块高亮并定位。多栏时显示警告条。

**由测试发现的一件事（测试数据不真实，不是代码错）：** 第一版测试里"正文行"只有
6–7 个字却撑满整行，导致字宽估计成 0.133（真实约 0.08），缩进阈值跟着放大，
规则测不到。改成 10 字长行后通过——这也说明**相对阈值的估计量依赖真实文本的形态**，
短行撑满整行的排版会削弱它。

**未验证 / 待处理项：**

1. **右不齐（ragged-right）英文会被并成一块**：旋转页夹具的 3 行英文被归成 1 块。
   "末行短"规则依赖版心右边界稳定，右不齐时估不准。已记入 L-21。
2. **多行居中标题可能被拆开**，同样是左边界不稳定的问题。
3. **竖排装饰边栏会被判成"第 2 栏"**，于是大量中文页都带"阅读顺序待检查"标记，
   可能形成噪音（但这些页确实需要人工看一眼，标记本身不算错）。
4. **块类型一律是 `paragraph`**，不分页眉页脚——按说明书写明来源应是版面组件建议或
   人工标注，本模块不越权猜测（D-016）。后果是 6.5 与 9.3 暂时没有数据基础。
5. **没有人工兜底**：合并 / 拆分属 Phase 3，现在分错了只能重跑识别。
6. **只在样本的两本书上跑过**，未做跨书籍 / 跨字号的参数验证。
7. 未在 Windows 上运行任何内容。

### 用户操作说明

识别后界面自动显示块；块框可勾选隐藏；点击块定位到图上位置；多栏时顶部有警告条。

```bash
uv run pytest tests/unit/test_grouping.py -q    # 分组规则测试
uv run pytest -q                                # 全套 157 项
```

**结果可信范围：** 坐标与分段在样本上验证过；**分段是启发式的**，
右不齐英文、居中标题、装饰边栏三类场景已知会失效（L-21）。

**回退方式：** 删除 `core/structure/`，撤掉 `routes_scratch.py` 中 `grouping` 的调用
与返回字段，以及前端块展示相关元素。核心识别与渲染不受影响。

### 下一步建议

**实现说明书 9.2 的「行合并规则」，把块内换行拼成真正的段落文本。**

理由：现在块文本**保留行内换行**（说明书 5.3 的规定），所以它还不是可读的段落。
把行拼成连续文本的规则在 9.2，且它**规定了四种字符组合的处理方式并明确要求
"覆盖上表每一行的单元测试"**——是一条边界清楚、可直接验收的规则。
做完它，块才第一次产出"能读的段落"，也才谈得上导出。

之后是 9.1 的段生成（跨页拼接）与 9.3 的清理规则，三者合起来就是 TXT / JSONL 导出的基础。

---

## 2026-10-14 — 任务 6：合成金标准语料 + 准确率测量工具链

### 任务目标

开发者提议："生成一个比较长的文本，转成 PDF，这样就有金标准，可以测准确率。"

我接受的**部分**是：这**不能**替代真实扫描件的人工金标准（合成语料是完美输入，
测不出真实旧书的退化，而引擎选型恰恰要看那个差别）。但它有两个实在的用处：
**① 验证比对工具链本身**（没有已知答案就没法验证 CER 实现是否正确）；
**② 建立上限基线**。因此本轮做它，并在文档里写明适用边界。

**不在范围内：** 真实扫描件的人工金标准（仍需人工抄录）；PaddleOCR 对比。

### 当前状态

- 任务 5 完成：识别已接进应用，但没有任何准确率数据。
- 说明书 8.7 规定的 `core/ocr/compare.py` 尚未实现——它是准确率测量的前提。

### 实施计划

1. 先读说明书 8.7（归一化步骤与顺序）与 13.2（测试要求）、13.4（质量指标）。
2. 实测 reportlab 能否渲染中文（不凭记忆假设）。
3. 实现 `core/ocr/compare.py`。
4. 写语料生成脚本，产出金标准 + 无文本层 PDF。
5. 写测量脚本，跑出 CER / WER。
6. 诊断异常数字，区分"真错误"与"规则覆盖不到"。
7. 测试 + 文档。

### 实现与验证

| 验证项 | 结果 |
|---|---|
| `uv run pytest -q` | **134 passed**（原 83 + 新增 51） |
| 语料 | 82 行 / 2737 字 / 3 页，文本层字符数 0 |
| 内容 CER（忽略空白） | **1.634%** |
| CER（说明书 8.7 归一化） | 5.291% |
| 英文部分 | CER 0.000% / WER 0.000%（92 词 / 572 字） |
| 整行一致 | 严格 32.14%，忽略空白 55.36% |

**诊断过程（本轮最花时间也最有价值的部分）：** 第一次测出严格 CER 5.36%，
在完美合成文字上这个数字**不合常理**。我没有直接写进文档，而是逐行比对，发现两类完全不同的东西：

1. **大量"差异"是排版空格，不是识别错误。** 例如金标准 `是 PDF，编码是 UTF-8`
   被识别成 `是PDF，编码是UTF-8`。说明书 8.7 第 3 步只规定删除
   "**中日韩字符之间**的空格"，**覆盖不到中日韩与拉丁/数字的边界**。
   去掉全部空白后编辑距离从 149 降到 46——**原始数字里约三分之二是排版差异**。
   这暴露了说明书的一处规则空白，已作为待决事项上报（`docs/decisions.md` D-015）。
   **我没有擅自改规则**，而是增加一个明确标注的额外口径，两个数字都报。
2. **真实的识别错误**：生僻字（靰→靳、黢→黔）、形近字符（l→1、O→0、ASCII→ASCⅡ）、
   破折号（—→一）、漏掉成对引号的后半。

**另外两个值得记的发现：**

- **一处单行完全崩溃**：`书名号《红楼梦》、篇名〈葬花吟〉、引号“双”与‘单’。`
  被识别成 `°，《》`——25 个字只剩 4 个。多标号混排是高风险形态。
- **一处整行漏检**：第 3 页页脚 `— 3 —` 完全没被检出（该页 25 行 vs 金标准 26 行）。
  "整行漏检"与"识别错字"是两种不同的失败，对说明书 6.5（批量标注页眉页脚）影响更大——
  页脚检不出来，用户在界面上就选不中它。

**由单元测试发现的一个实现缺陷：** `_is_cjk()` 原本没把弯引号（`“ ”`，U+201C/201D）
算作中日韩上下文，导致 `他说 ： “ 好 ” 。` 的空格删不干净——而中文引号本就紧贴汉字。
已修正，并确认不会误伤英文（判定要求空格两侧都是中日韩上下文，`said “hi”` 不受影响）。

**未验证 / 待处理项：**

1. **合成语料的数字不能外推**。真实旧书的倾斜、噪点、透印会显著抬高错误率。
2. **真实扫描件的金标准仍不存在**，Phase 0 的引擎选型仍被阻塞。
3. **未测 PaddleOCR**，无法对比。
4. **未在 Windows 上运行任何内容。**
5. 语料刻意集中了难例（生僻字、形近字符、多标号行），行级一致率偏低不全是引擎的问题。
6. 语料量（2737 字）下的 CER 分辨率约 0.04%；再细的分类结论会不稳。

### 用户操作说明

```bash
uv run --with reportlab python scripts/make_gold_corpus.py   # 生成语料与金标准（需联网装 reportlab）
uv run python scripts/measure_accuracy.py                    # 测量，输出 docs/accuracy-raw.json
```

结果看 `docs/accuracy-report.md`（结论）与 `docs/accuracy-raw.json`
（逐页逐行原始数据，含完整识别文本，可事后审计而不必重跑 OCR）。

**回退方式：** 删除 `core/ocr/compare.py`、`scripts/make_gold_corpus.py`、
`scripts/measure_accuracy.py`、`fixtures/gold/synthetic-corpus.*`、
`fixtures/pdf/synthetic-corpus.pdf`、`docs/accuracy-report.md` 与 `docs/accuracy-raw.json`。
应用本身不依赖它们。

### 下一步建议

**（需你决定）是否扩展说明书 8.7 第 3 步以覆盖中日韩/拉丁边界的空格。**

理由：不扩展的话，中文书里所有"汉字与拉丁词之间是否留空隙"的排版约定都会被算成
识别错误，分歧率会被系统性高估（说明书 8.6 明确担心这类假分歧）。
扩展的话需要改说明书正文，所以由你定。

**然后：人工校对 5–10 页真实扫描页**，把这套工具链用到真实样本上并跑 PaddleOCR 对比。
测量代码已经通用——换一个金标准文件即可复用，不需要再写代码。

---

## 2026-10-14 — 任务 5：把 OCR 接进应用（上传 → 渲染 → 带坐标的行）

### 任务目标

把 OCR 适配器接进应用，让界面从"能看图像"推进到"能出带坐标的文本行"。
这是"跑通工作流"里最有价值的一段，也就是说明书 8.1 / 5.2 / 8.5 的基础。

**不在范围内：** 行 → 块的组合（`core/structure/grouping.py`）、Job / JobItem 执行器、
OCRRun 持久化、批量识别、审校编辑、导出。

### 当前状态

- 任务 4 完成：RapidOCR 的两个门槛项已实测达标，但引擎没有接进应用。
- `core/ocr/` 下只有 `selfcheck.py`（模块探测），没有适配器。

### 实施计划

1. 先读说明书 5.2（坐标规范）与 8.1（适配器接口）——这两个决定了数据结构。
2. 实测 `/Rotate` 页的渲染行为，因为 5.2 的坐标定义依赖"显示方向"。
3. 写 `core/ocr/base.py`（协议 + 数据类型 + 归一化原语）。
4. 写 RapidOCR 适配器。
5. 识别接口 + 界面行框叠加。
6. 真机验证 + 测试。

### 实现与验证

| 验证项 | 结果 |
|---|---|
| `uv run pytest -q` | **83 passed**（原 57 + 新增 26） |
| 旋转页识别 | 3 行全部识别，文字正确，bbox 全在 0–1 内 |
| 中文双栏页识别 | 26 行；bbox 准确区分左栏标题（x≈0.12）与右栏正文（x≈0.51–0.94） |
| 归一化与 DPI 无关 | 150 与 300 DPI 下同一行的 bbox 偏差 < 0.03（有测试） |
| 界面端到端（真实浏览器） | 上传 → 识别（26 行 / 3.34 秒）→ 26 个行框精确贴合文字 → 点击第 3 行高亮对应框（"第二十七回"） |
| 渲染同源 | `render_page_png` 与 `render_page_image` 尺寸一致（有测试） |

**关键发现与一次误判的纠正（重要）：**

说明书 5.2 要求坐标相对"应用 `/Rotate` 之后的页面显示方向"，且"含旋转页"必须有单元测试。
我实测后**先得出了错误结论**：以为 PDFium 不应用 `/Rotate`，需要手工传
`rotation=(360-r)%360`，并据此改了渲染代码。

**那个结论是基于一个坏夹具得出的。** 用 reportlab 的 `setPageRotation(90)` 生成的 PDF，
在 PDFium 与 macOS PDFKit 里**都渲染不出任何内容**（实测墨迹像素为 0），
看起来像"内容被转到画布外"。我据此推断出"需要补旋转"，但真正的原因是夹具本身是坏文件。

换成正确构造的夹具（横向内容旋转后存进竖向页面 + 写 `/Rotate`，即真实扫描书的存法）后，
真相**相反**：PDFium 已经正确处理 `/Rotate`——`get_size()` 返回显示尺寸（宽高已交换），
`render()` 默认即显示方向，与 PDFKit 的输出一致。**若沿用那个"修正"，真实书籍里所有
带 `/Rotate` 的页都会被重复旋转。**

这个结论已写进 `docs/decisions.md` D-014，夹具陷阱写进 `scripts/make_test_fixtures.py`
与 `fixtures/README.md`，并加了回归测试锁定"默认渲染必须有内容"。

**教训：** 结论与预期不符时，"怀疑库"之前应当先怀疑自己的测试装置。
当时若先验证夹具在别的渲染器里是否正常，就不会绕这一圈。

**一处记录在案的偏离：** 说明书 8.1 的 `OcrResult` 字段是 `blocks`，本次如实只返回
`lines`，因为块要由尚未实现的 `grouping.py` 组合。伪造 `blocks` 会把"未实现"伪装成
"已实现"。见 `docs/decisions.md` D-012。

**未验证 / 待处理项：**

1. **没有块**：行 → 段的组合未实现，审校视图与导出因此还不能做（L-19）。
2. **识别不持久化**：结果只在浏览器内存里缓存，刷新即丢；没有 OCRRun、没有 `ocr_runs/`。
3. **单页同步识别**：没有 Job 执行器，不能批量、不能暂停/继续/取消/重试。
4. **未在 Windows 上运行任何内容。**
5. **未与 PaddleOCR 对比**，选型仍未定（Phase 0 第 1 项）。
6. **准确率仍未测**（缺金标准）。界面上的行框贴合说明坐标对，**不代表文字识别无误**。
7. 识别在 Web 请求里同步执行，长页会占住工作线程（实测单页 2–6 秒）；
   Phase 2 要求放进子进程与 Job 执行器。

### 用户操作说明

```bash
uv sync --group ocr-eval      # 首次使用识别功能需要（约 300 MB）
uv run book2text              # 然后打开界面地址
```

界面上：上传 PDF → 「识别本页」→ 下方列出带坐标的文本行，图上叠加行框；
点击某一行可定位到图上对应位置，取消勾选"在图上标出行框"可隐藏框。

**结果的可信范围：** 行框位置可信（坐标已验证）；**文字准确性未经金标准校验**。

**回退方式：** 删除 `backend/book2text/core/ocr/base.py`、`core/ocr/adapters/`，
撤掉 `routes_scratch.py` 的识别接口与界面相关元素，从 `pyproject.toml` 移除
`ocr-eval` 依赖组。核心功能不受影响。

### 下一步建议

**实现 `core/structure/grouping.py`：把行组合成段。**

理由：这是当前最靠前的一块空白，也是产品操作单位的起点——没有块，审校视图、
块类型标注、页眉页脚批量工具、跨页段落拼接、TXT/JSONL 分段导出**全都做不了**。
说明书 8.1 要求 grouping 的规则"必须有测试"，且要按行距、缩进、对齐来分组。

样本里已经具备验证条件：中文页可验证段落切分与跨页段落（样本第 3、4 页是同一段），
英文页可验证脚注区与正文的分离。

---

## 2026-10-14 — 任务 4：Phase 0 第 1 项的两个门槛项（不等金标准）

### 任务目标

开发者提问："能不能先不管金标准？先跑通工作流比较重要？"

我的判断：**金标准只卡住准确率（CER）**，而 Phase 0 第 1 项里真正的门槛项有两个——
"第一引擎能否返回行级坐标"与"每页耗时"——**这两个都不需要金标准**，跑一遍就有答案。
所以本轮不等金标准，先把项目最大的技术风险探掉。

**不在范围内：** 准确率评估（需金标准）；PaddleOCR 对比；版面组件；第二引擎；
把 OCR 接进应用（属 Phase 2）。

### 当前状态

- 任务 3 完成：20 页无文本层样本可用。
- 未安装任何 OCR 依赖。
- 应用内没有 OCR（L-10）。

### 实施计划

1. 选定候选引擎与依赖组织方式。
2. **按说明书要求先写定门槛，再实测**（避免事后移动标准）。
3. 探明库的 API（不凭记忆假设）。
4. 跑 20 页，测量门槛项与内存等指标。
5. 修正受影响的既有代码，记录结论与未做的事。

### 实现与验证

**依赖组织：** 引擎装进独立的 `ocr-eval` 依赖组，**不进核心依赖**——
选型未定，最终用户不该被强制安装 300 MB 的 OCR 运行时。
`uv sync --group ocr-eval` 后 venv 由 60 MB 增至 323 MB。

**先定门槛：** `docs/ocr-evaluation.md` 第 1 节在实测**之前**写定判据
（G1 行级坐标；G2 ≤ 18 秒/页，取自说明书"400 页 ≤ 2 小时"的示例）。
文中明确标注这是**建议值、需开发者确认**，且不把任何数字称为"达标"直到实测。

**API 实测（说明书 1.1）：** 确认 `rapidocr.RapidOCR()(img)` 返回 `RapidOCROutput`，
含 `boxes`（每行四点框）、`txts`、`scores`、`elapse`。因此行级坐标是**原生返回**的。

| 验证项 | 结果 |
|---|---|
| **G1 行级坐标** | **达标**：20/20 页返回 `(行数, 4, 2)` 四点框，像素坐标 |
| **G2 每页耗时** | **达标**：中位 **2.04 s**、最大 3.67 s、最小 0.84 s（门槛 18 s，余量约 5 倍） |
| 识别耗时合计 | 42.87 s / 20 页；渲染另计 1.01 s |
| 识别行数合计 | 456 行 |
| 模型文件 | `PP-OCRv6_det_small.onnx` 等**随 wheel 内置**，运行时**无需联网** |
| 峰值内存 | **2686.6 MB** |
| 引擎初始化 | 0.01 s |
| 既有测试 | `uv run pytest -q` → **57 passed**（安装 OCR 依赖后仍全过） |

**修正了一个我自己埋的错：** `core/ocr/selfcheck.py` 原本只探测
`rapidocr_onnxruntime`（1.x 的包名），而实际安装的是 `rapidocr`（3.x），
会把已装的引擎**误报成"未安装"**。已改为按候选列表探测，并附带报告推理后端是否存在。
修正后自检正确报出 `RapidOCR 3.10.0 可用`。

**顺带的观察：** 引擎把样本第 2 页的竖排书名「红楼梦」与页脚页码「62」
也识别成了独立文本行。这印证了说明书 6.5「批量标注页眉 / 页脚 / 页码」的必要性——
这些元素在识别阶段就是普通文本行，不处理会混进导出。

**未验证 / 待处理项：**

1. **准确率完全没测。** 文档里的"均分"（0.958–0.996）是引擎自报置信度，**不是准确率**。
   未做任何 CER 计算。
2. **PaddleOCR 部署形态未测**，版面组件未测——所以**选型未定**，
   不能仅凭本轮就说 RapidOCR 是第一引擎。
3. **未在 Windows 上运行任何内容。**
4. **样本是干净栅格化**，真实扫描页会更慢、更难；耗时数字偏乐观。
5. **峰值内存 2.7 GB 只记录、未评级**，整书批量时的内存行为未验证。
6. 只用 300 DPI 测过，说明书 8.2 要求的 DPI 取值（200 / 300 / 400）对比未做。

### 用户操作说明

```bash
uv sync --group ocr-eval                      # 装评估依赖（约 300 MB）
uv run python scripts/evaluate_ocr.py         # 跑 20 页，输出到 docs/ocr-evaluation-raw.json
uv run python scripts/evaluate_ocr.py --dpi 400   # 换 DPI 重测
```

**结果看这里：** `docs/ocr-evaluation.md`（结论与逐页数据）、
`docs/ocr-evaluation-raw.json`（原始数据，可追溯）。

**回退方式：** 删除 `scripts/evaluate_ocr.py`、`docs/ocr-evaluation*.{md,json}`，
并从 `pyproject.toml` 移除 `ocr-eval` 依赖组；应用本身不依赖它。

### 下一步建议

**先补人工校对金标准，然后做 PaddleOCR 对比。**

理由：现在"能不能做"已经有答案了，剩下的是"哪个更好"。而"更好"要靠 CER 判断，
CER 要靠金标准。同时 **PaddleOCR 对比**是 Phase 0 第 1 项明确要求的，
它的行级坐标与耗时判据已经有了，**即使没有金标准也能先比这两项**——
所以如果暂时不想做金标准，可以先跑 PaddleOCR，把耗时、内存、体积、安装难度比出来。

两件事都做完，Phase 0 第 1 项就可以给开发者一份完整的选型建议了。

---

## 2026-10-14 — 任务 3：制作 Phase 0 扫描样本（20 页，无文本层）

### 任务目标

用 `test_books/` 的两本真实书籍制作 Phase 0 的扫描样本：选 20 页，输出无文本层的 PDF。
用途是解锁被卡住的 Phase 0 第 1–3 项（OCR 引擎实测与 PDF 库对比）。

**不在范围内：** 人工校对金标准（需开发者本人对照图像逐字抄录）；OCR 引擎的安装与实测。

### 当前状态

- 任务 2 完成：骨架可运行，57 项测试通过。
- `test_books/` 有两本真实书（369 + 662 页），此前只测出它们**有文本层**，
  未做选页与样本制作。

### 实施计划

1. 先摸清两本书的结构：目录、章节位置、脚注密度、插图、跨页段落位置。
2. 确认源书性质（原生数字 vs 扫描）——它决定样本的真实性。
3. 按说明书 13.1 的覆盖要求选页。
4. 写可复现的生成脚本（选页规则与参数固化），输出 PDF 与逐页清单。
5. 独立验证：页数、文本层字符数、页面对象构成、跨页段落是否承接。
6. 记录覆盖缺口与性质局限。

### 实现与验证

**关键发现一：源书不是扫描件。** 对象分析显示红楼梦每页 20–60 个文本对象、
安乐哲每页 30–60 个，都是**矢量文本**。渲染出来是干净的排版文字。
所以样本是"干净栅格化"，**不含**真实扫描的倾斜、噪点、透印、对比度不均。

**关键发现二：源 PDF 的文本层不可靠。** 红楼梦第三十八回回目渲染出来是
"薛**蘅**芜讽和螃蟹咏"，文本层提取却是"薛**祷**芜讽和螃蟹咏"；第四十回
"三**宣**牙牌令"被提取成"三**宜**牙牌令"。**图像正确、文本层错字**，
说明字体 ToUnicode 映射有问题。

两个后果：① 该文本层**不能**用作金标准；② 反证了产品立论——已有文本层未必可信。

**关键发现三：两本书都不含中英混排。** 安乐哲全书 0 页含汉字（中文只用罗马字转写），
红楼梦该文件 0 页含拉丁字母。说明书 13.1 要求的"中文与中英混排"**无法覆盖**。

| 验证项 | 方式 | 真实结果 |
|---|---|---|
| 选页覆盖 | 按类别检索章节标题（27 处回目）、脚注密集页（31 页）、跨页段落（25 处） | 20 页覆盖 7/9 个要求类别 |
| 生成 | `uv run python scripts/make_scan_samples.py` | 20 页，10.62 MB |
| **文本层已去除** | 逐页 `get_textpage().count_chars()` | **字符总数 0** |
| 结构符合扫描件 | 逐页对象类型统计 | **每页只有 1 个图像对象**（无文本、无矢量路径） |
| 页面尺寸 | 与原书对比 | 447×674 pt / 612×792 pt，与原书一致 |
| 跨页段落承接 | 渲染样本 p3 末 + p4 首拼接查看 | p3 结尾"…他只当是昨日金钏儿之事，他" → p4 开头"没好意思的，越发不理他。"**同一句，正确承接** |
| 体积 | — | 10.62 MB（0.53 MB/页，与真实 300 DPI 扫描书量级相当） |

**未验证 / 待处理项：**

1. **没有金标准**，所以 CER / 分歧率 / 捕获率**一个都还算不出**，Phase 0 第 1–2 项仍不能开工。
2. **两个覆盖类别缺失**：中英混排、低清晰度或倾斜页面。
3. **样本不是真实扫描件**，在它上面测得的识别质量会偏乐观，不能外推到真实旧书。
4. `scripts/make_scan_samples.py` 依赖不入库的 `test_books/`，全新克隆后无法重跑
   （脚本同时作为样本来源的书面记录）。
5. 仍未在 Windows 上验证任何内容。

### 用户操作说明

**样本已就位，可直接用于 Phase 0：**

```bash
ls -lh fixtures/pdf/sample-20p-300dpi.pdf          # 20 页，10.62 MB
uv run python -c "import json;print(json.load(open('fixtures/pdf/sample-20p-300dpi.manifest.json'))['pages'][0])"
uv run python scripts/make_scan_samples.py         # 重新生成（需 test_books/）
```

**逐页来源与类别**见 `docs/scan-sample-set.md` 第 2 节；
**覆盖度对照与全部局限**见同文件第 3、4 节。

**回退方式：** 删除 `fixtures/pdf/sample-20p-300dpi.pdf` 与其 `.manifest.json` 即可。

### 下一步建议

**请开发者制作 5–10 页人工校对金标准。**

理由：样本已经够了，现在**唯一的**瓶颈是金标准。没有它，Phase 0 第 1–2 项算不出任何
CER、分歧率、捕获率，也就无法判断第一引擎是否达标——而"每页耗时"与"行级坐标"
这两个门槛项不实测就不能定方案。

抄录时必须**对照页面图像**，不能用源 PDF 的文本层（它有错字，会把 OCR 的正确输出判成错误）。
建议选取覆盖：中文正文、英文正文、脚注密集页、复杂版面页各 1–2 页。

同时请先定下量化门槛（如 400 页 ≤ 2 小时 → 每页 ≤ 18 秒），写在
`docs/ocr-evaluation.md` 开头，再开始实测——说明书 Phase 0 第 1 项要求先定门槛。

---

## 2026-10-14 — 任务 2：Phase 0 第 4 项「最小骨架」

### 任务目标

按说明书第 14 节 Phase 0 第 4 项，做出可运行的最小骨架：`uv` 环境 + FastAPI 服务 +
一个静态页面，页面可上传 PDF 并显示第一页图像，并带一个"引擎自检"接口
（列出第一 / 第二引擎是否可用、版本、不可用的原因）。

**不在范围内：** Phase 0 第 1–3 项（OCR 引擎实测、PDF 库对比）——被测试样本缺失卡住；
Phase 1 的项目库与数据库；OCR 识别、审校、结构、导出。

### 当前状态

- 任务 1 完成：仓库在 GitHub（私有），身份与 SSH 认证已配置。
- 当时已知环境：Python 3.12.13、uv 0.12.3、Node v26.8.2 **都已安装**
  （更正：任务 0 里写的"尚未安装 Python / uv / Node.js"是未经验证的错误结论，
  见下方"更正"）。
- 无任何应用代码，无 `pyproject.toml`。

### 实施计划

1. 按说明书 1.1 先实测第三方库 API，不凭记忆写代码。
2. 建 uv 项目与依赖。
3. core 层：`platform.py`（平台分支集中于此）、`pdf/render.py`、`ocr/selfcheck.py`、
   `storage/scratch.py`（Phase 0 临时上传）。
4. api 层：令牌与 Origin 校验、上传、页面图像、`app/info` 自检。
5. `main.py` 入口：选端口、生成令牌、打开浏览器。
6. 静态页面 + 双平台启动脚本。
7. 真机验证 + 自动化测试。
8. 更新文档。

### 实现与验证

**先实测再写代码**（说明书 1.1）。探测确认了：`PdfPage.render(scale=…)` 返回的
bitmap 只有 `to_pil()` / `to_numpy()` 两条编码路径，前者需要 Pillow（原本未安装）；
`PdfDocument` 提供 `get_page_size()` 与 **`get_page_label()`**，后者正是说明书
Phase 0 第 3 项要求的"页码标签读取"。

| 验证项 | 命令 / 方式 | 真实结果 |
|---|---|---|
| 依赖安装 | `uv sync` | fastapi 0.143、uvicorn 0.54、pypdfium2 5.14、Pillow 12.3，全部有 arm64 wheel，无编译 |
| API 实测 | 探针脚本 | `len(doc)`=3、`get_page_size`=595.28×841.89 pt、页码标签可读、`to_pil()` 可用 |
| 合成样本 | reportlab（临时环境，不进依赖） | `fixtures/pdf/synthetic-smoke-3pages.pdf`，3 页，3.2 KB |
| 单元 + 集成测试 | `uv run pytest -q` | **57 passed** |
| 安全层 | curl | 无令牌 401、错令牌 401、伪造 Origin 403、正确 200，错误格式含 `correlation_id` |
| 上传链路 | curl | 3 页 PDF → 页数 3、SHA-256 正确；`view` 档 1241×1754 PNG 194 KB |
| 错误路径 | curl | 越界 400、未知档位 400、非 PDF 400、路径穿越 404、删除后 404 |
| 端口回退 | 启两个服务请求同一端口 | 第一个占 8903，第二个自动落到 8904 |
| 启动脚本 | `./scripts/start.command` | 真实跑通，首页与自检接口均 200 |
| **界面端到端** | ego-browser 真实浏览器 | 上传 PDF → 显示首页图像（blob URL，1241×1754）、元数据正确、翻页到 3/3、按钮禁用状态正确、无报错 |
| 渲染耗时 | 5 次取中位 | thumb 3.2 ms / view 25.6 ms / zoom 86.5 ms（**合成文件，非扫描件**） |

**更正一条此前的错误结论：** 任务 0 与 `known-limitations.md` L-04 曾写
"未检测到 Python 3.11+、uv、Node.js"。写下时**我并未实际检查**，属凭假设下结论，
违反说明书 1.7。实测全部早已安装。L-04 已移入"已解除"并注明这次更正。

**本次主动修正的两个问题：**

1. 日志顺序：输出重定向到文件时 stdout 是块缓冲的，uvicorn 的 stderr 日志会跑到启动横幅前面。
   已在 `_print_banner` 后加 `sys.stdout.flush()`。
2. `.gitignore` 原本忽略了 `backend/book2text/static/`（按 D-004 视其为构建产物），
   但 Phase 0 那里放的是手写源文件，必须入库。已修订 D-004 并解除忽略。

**工作期间发现的输入材料：** 开发者在 15:42 放入了 `test_books/`，含两本真实书籍
（《红楼梦》双语对照 369 页、安乐哲译本 662 页）。已用它们取到真实渲染数据（见
`docs/technical-feasibility.md` 1.3 节：`view` 档 30–45 ms/页、PNG 250–415 KB）。

**但这两本书都不是扫描版**：采样 6 页的文本层字符数为 145–1174，说明它们有大量可提取文字，
而本项目针对的是"没有可用文本层的扫描版 PDF"。因此它们**不能**用于 Phase 0 第 1–2 项的
OCR 实测（有文本层就测不出 CER 与识别率），只能用于渲染与性能测试。

`test_books/` **未入库**，已加入 `.gitignore`（版权 + 13MB 体积 + 它是输入材料而非产物）。
详见 `docs/known-limitations.md` L-16。

**未验证 / 待处理项（必须诚实记录）：**

1. **Windows 上什么都没有验证过。** `scripts/start.bat`、`selfcheck.py` 的 Windows OCR
   分支（含语言包检测）、`explorer /select,`、控制台 UTF-8 处理——全部从未在 Windows 上执行。
   代码中已就地标注。
2. **渲染耗时数据来自合成 PDF**（矢量文字），不能外推到真实扫描页。扫描件上的耗时与
   每页缓存占用仍未测。
3. **没有真实扫描样本**，因此无法评估 150 DPI 是否够看清小字。
4. **前端没有自动化测试。** 界面靠浏览器手动跑了一遍，57 项 pytest 全部覆盖后端。
5. **没有 CI**，测试靠手动运行。
6. 测试会出现一条第三方弃用警告（starlette 的 `httpx` → `httpx2`），不影响结果。

### 用户操作说明

**启动（任选一种）：**

```bash
cd /Users/chenlin/Desktop/软件开发/book2text
uv run book2text              # 或双击 scripts/start.command
```

浏览器会自动打开带令牌的地址。若不自动打开，终端里打印的"界面地址"可直接复制使用
（**必须带 `?token=…`**，否则界面会提示缺少令牌）。按 Ctrl+C 停止。

常用参数：`--port 9000`（起始端口）、`--no-browser`（不自动开浏览器）。

**验证：**

```bash
uv run pytest -q                    # 应全部通过
uv run book2text --no-browser       # 然后访问打印出的地址，上传一个 PDF
```

界面上应显示：平台徽章、7 条引擎自检（当前 0 可用）、当前限制清单；
上传 PDF 后显示元数据与首页图像，可翻页。

**回退方式：** 本任务的改动全部是新增文件；删掉 `pyproject.toml`、`uv.lock`、
`backend/`、`scripts/`、`tests/`、`fixtures/`、`.venv/` 即可回到任务 1 的状态。
上传的文件在 `~/Library/Application Support/Book2Text/scratch/`，可直接删除。

### 下一步建议

**先补上 Phase 0 的前置输入：制作 20–40 页测试样本与 5–10 页人工校对金标准。**

理由：Phase 0 剩下的第 1–3 项**全部**依赖这份输入，而它是说明书 13.1 规定由开发者
在 Phase 0 开始前完成的人工工作。骨架（第 4 项）已经把"跑得起来"这件事解决了，
现在瓶颈完全在样本上——继续写代码只会加深"没有实测数据"的空白。

样本到位后，第 1 项的头两件事是：先量化门槛（如 400 页 ≤ 2 小时 → 每页 ≤ 18 秒），
再实测第一引擎**是否返回行级坐标**与每页耗时。这两项不达标就必须立刻报告并调整方案，
不能静默降级（说明书 8.4）。

---

## 2026-10-14 — 任务 1：配置 Git 身份、SSH 认证与 GitHub 远端

### 任务目标

让仓库能在 macOS 上与开发者的 GitHub 账号（`CLnum42`）正常协作：配置提交身份、打通认证、建立远端并推送。不写任何功能代码。

### 当前状态

- 任务 0 已完成：本地仓库 `main` 分支有 1 个提交（`21c5a85`），无远端。
- 本机已安装 `gh` 2.102.0 并登录为 `CLnum42`；全局 Git 身份**未配置**；无 SSH 密钥。
- 首次提交的作者是系统回退值 `陈林 <chenlin@MacBook-Air-2.local>`。

### 实施计划

1. 查清开发者既有提交身份，避免造出第二套身份。
2. 配置全局 `user.name` / `user.email`，并用 `--reset-author` 改写首次提交。
3. 建立 GitHub 远端并推送。
4. 打通认证（优先复用已有凭据，不行再引入 SSH）。
5. 更新文档，记录配置方式与新增限制。

### 实现与验证

| 步骤 | 做法 | 真实结果 |
|---|---|---|
| 身份调研 | `gh api repos/CLnum42/.../commits` 读取历史作者 | 既有身份为 `CLnum42 <CLnum42@users.noreply.github.com>` |
| 邮箱可用性验证 | 检查历史提交的关联账号 | 5 条提交全部正确关联到 `CLnum42`，noreply 格式有效 |
| 写入身份 | `git config --global user.name/user.email` | 生效；`git var GIT_AUTHOR_IDENT` 返回新身份 |
| 改写首次提交 | `git commit --amend --reset-author` | 作者与提交者均变为 `CLnum42 <CLnum42@users.noreply.github.com>`，哈希由 `7da13d0` 变为 `21c5a85` |
| 凭据助手 | `gh auth setup-git` | github.com 与 gist 的 helper 指向 `gh auth git-credential` |
| **HTTPS 路线** | `gh repo create` / `gh api -X POST user/repos` | **失败**：`Resource not accessible by personal access token (createRepository)`。该细粒度 PAT 范围为"仅选定仓库" |
| 仓库创建 | 浏览器网页端（ego-browser）创建 | **成功**，`CLnum42/book2text`，Private |
| PAT 对新仓库 | `gh api repos/CLnum42/book2text` | **404** —— 证实 HTTPS 推送对本仓库也不通 |
| SSH 密钥 | `ssh-keygen -t ed25519` 生成 `~/.ssh/id_ed25519`，写入 `~/.ssh/config` | 成功 |
| 密钥上链 | 浏览器网页端提交公钥 | 触发 GitHub **sudo 模式**，需要密码；由开发者本人完成验证 |
| SSH 认证测试 | `ssh -T git@github.com` | `Hi CLnum42! You've successfully authenticated` |
| 切换远端 | `git remote set-url origin git@github.com:CLnum42/book2text.git` | 成功，fetch/push 均指向 SSH |
| 推送 | `git push -u origin main` | **成功**，`main -> main`，跟踪关系已建立 |
| 网页端复核 | 打开仓库页面检查 | 私有 ✓、22 个文件在列 ✓、提交信息正确 ✓、1 个分支 ✓ |

**未验证 / 待处理项：**

1. **未做任何构建或运行验证**，与任务 0 相同，仓库中仍无应用代码。
2. **推送只在 macOS 上验证过。** Windows 侧从未克隆或推送过本仓库。
3. **`gh` 命令对本仓库会 404**（L-07）。这是 token 范围问题，本次未解决——解决它需要编辑 PAT 权限，有导致 `gh` 登录失效的风险，且不影响 `git` 命令，故暂缓。
4. **SSH 密钥无口令**（L-08）。这是为免交互推送做的取舍，已在文档中记录。
5. **未配置任何 CI。** GitHub Actions 未启用，推送不会触发自动检查。

### 用户操作说明

**日常使用（已可直接工作）：**

```bash
cd /Users/chenlin/Desktop/软件开发/book2text
git add -A && git commit -m "..." && git push     # push.autoSetupRemote 已开启，无需 -u
git pull
```

**验证 SSH 认证：** `ssh -T git@github.com` 应返回 `Hi CLnum42!`

**仓库地址：** https://github.com/CLnum42/book2text （私有，需登录后访问）

**回退方式：** 解除 SSH 只需在 GitHub 设置中删除标题为 `MacBook-Air-2` 的密钥，并删除本地 `~/.ssh/id_ed25519*` 与 `~/.ssh/config`；撤销身份配置用 `git config --global --unset user.name`（`user.email` 同理）。

### 下一步建议

**安装 Python 3.11+ 与 `uv`，开始 Phase 0 第 4 项「最小骨架」。**

理由同任务 0：Phase 0 第 1–3 项依赖尚未制作的测试样本与人工校对金标准，而第 4 项最小骨架是唯一可以立即动手、且是后续所有实测载体的部分。

---

## 2026-10-14 — 任务 0：初始化 Git 仓库

### 任务目标

为 Book2Text 建立 Git 仓库，并让仓库目录布局符合开发说明书 V1.0 第 12.2 节，使后续每个 Phase 都能在版本管理下逐切片推进。本任务不写任何功能代码。

### 当前状态

- 目录中已有两份输入材料：开发说明书 V1.0（1286 行）与 6 个页面的 UI 原型（HTML + PNG）。
- 无 `pyproject.toml`，无任何应用代码。
  （**更正 2026-10-14：** 此处原写"尚未安装 Python / uv / Node.js"，那是**未经验证的假设**，
  违反说明书 1.7。实测这些工具早已安装，详见任务 2 与 `known-limitations.md` L-04。）
- 此前该目录**不是** Git 仓库（`git status` 返回 `fatal: not a git repository`）。

### 实施计划

1. 按说明书 12.2 整理目录：说明书移入 `docs/spec-v1.0.md`，UI 原型移入 `docs/ui-mockups/`。
2. 新建 `.gitignore`：兜底防护运行时数据（`b2t_*/`、`project.db`、缓存、导出、备份、日志），忽略 Python / Node 产物、密钥、编辑器与系统文件。
3. 新建 `.gitattributes`：源码与文档统一 LF，`*.bat` 为 CRLF，二进制文件标记 binary（说明书第 10 节）。
4. 新建 `README.md`（含真实进度表）、`AGENTS.md`（说明书第 1 节同步副本）。
5. 补建 `CHANGELOG.md`、`docs/decisions.md`、`docs/known-limitations.md`，并写入本次决策。
6. `git init -b main`，完成首次提交。
7. **不在范围内：** Python 环境与依赖（`pyproject.toml` / `uv.lock`）、后端与前端骨架、测试样本与金标准——这些属于 Phase 0，按说明书 12.2「不预建空模块」暂不创建。

### 实现与验证

实际执行的命令与真实结果：

| 步骤 | 命令 | 结果 |
|---|---|---|
| 检查工作目录 | `ls -la` | 1 个 .md 说明书 + `ui-mockups/` 目录 |
| 检查 Git 环境 | `git --version` | `git version 2.50.1 (Apple Git-155)` |
| 检查 Git 身份 | `git config --list --show-origin` | 全局**未设置** `user.name` / `user.email`；`init.defaultbranch=main` |
| 测试身份回退 | `git var GIT_AUTHOR_IDENT` | 返回 `陈林 <chenlin@MacBook-Air-2.local>`（见下方"未验证 / 待处理"） |
| 检查文本编码与换行 | `file` + `grep -c $'\r'` | 说明书为 UTF-8、0 个 CR，已是 LF，无需转换 |
| 整理目录 | `mkdir -p docs && mv ...` | 13 个文件全部就位，根目录不再有散落文件 |
| 初始化仓库 | `git init -b main` | 见提交记录 |

**未验证 / 待处理项（必须诚实记录）：**

1. **本任务没有在 Windows 上验证过任何内容。** 换行与路径策略只在 macOS 上检查；Windows 侧的实际检出效果属于 Phase 0 的验收内容。
2. **Git 提交身份是系统默认回退值**（`陈林 <chenlin@MacBook-Air-2.local>`）。该邮箱是主机名回退值，不是真实邮箱。当前仓库无远端，可以接受；**推送到任何远端仓库之前必须修正**，否则提交历史会带上无效邮箱。修正方式见"用户操作说明"。
3. 仓库尚未配置远端（`git remote` 为空），也未决定托管平台。
4. `.gitattributes` 的换行规则**尚未用真实的多平台克隆验证过**——目前仓库里没有需要跨平台检出的代码文件，"两个平台检出结果一致"这个结论要等 Phase 0 在两个平台各自克隆后才能确认。
5. 说明书第 1 节的同步副本为人工抽取，已核对首尾行；但"说明书更新后 `AGENTS.md` 是否仍然一致"没有自动校验机制，需要人工维护。

### 用户操作说明

**验证仓库状态：**

```bash
cd /Users/chenlin/Desktop/软件开发/book2text
git log --oneline          # 应看到首次提交
git status                 # 应为 clean
git ls-files               # 应列出说明书、UI 原型、文档与配置文件
git check-attr text eol -- README.md scripts/start.bat
```

**在推送远端之前修正提交身份（重要）：**

```bash
cd /Users/chenlin/Desktop/软件开发/book2text
git config user.name  "你的名字"
git config user.email "你的邮箱@example.com"
git commit --amend --reset-author --no-edit   # 改写首次提交的作者信息
```

**回退方式：** 本任务只新增文件，未修改、未删除说明书与 UI 原型的任何内容（仅移动路径）。如需完全回退，删除 `.git/` 目录并把 `docs/spec-v1.0.md`、`docs/ui-mockups/` 移回根目录即可。

### 下一步建议

**安装 Python 3.11+ 与 uv，然后开始 Phase 0 第 4 项「最小骨架」。**

理由：Phase 0 的第 1–3 项（第一引擎与版面组件实测、第二引擎逐平台实测、PDF 库选定）都以测试样本与金标准为前置输入，而这两份输入尚未准备；第 4 项最小骨架是唯一立即可以动手的部分，且它能同时验证"两个平台用启动脚本跑通 FastAPI + 静态页面 + 上传 PDF 显示首页图"这条主干路径，是后续所有实测的载体。
