# 审校右栏丢空格 + 审校页取图 + 悬停不取消（任务 78）

> 2026-10-28。《安乐哲 译本处理》662 页副本。用户窗口 1423 CSS px / dpr 2。

## P0-1 右栏英文丢空格：分隔符从来没被渲染出来

**根因（比"行首空格被折叠"更靠前一步）**：`line_spans` 的区间**不含** `join_lines` 补的
那个空格——空格在两个 span **之间**。实测同一条段：

```
line 0 [0:41]   'The Art of Rulership : A Study of Ancient'   后一个字符 = ' '
line 1 [42:67]  'Chinese Political Thought'                   前一个字符 = ' '
```

渲染时 `readingLineText()` 直接 `slice(start, end)` 再逐行拼起来，**中间那个空格就被跳过了**
→ `prevent` + `the people` = `preventthe people`。所以库和导出都是对的，**只有右栏错了**。

**修法**：渲染时把两个 span 之间的原文（`slice(prev.end, cur.start)`）原样补成一个文本节点。
CJK 的 join 不插空格，gap 为空，行为不变。

**验收（1423×900，审校视图）**：

| 检查 | 结果 |
|---|---|
| 已知粘连词（`doingwhat` / `hepleased` / `subjectto` / `acode` / `theLao` / `theultimate` / `enablepeople` / `withthe`） | **0 处** |
| 逐段比对 DOM 文本 vs `segments[].text` | 32 段中 **31 段完全一致** |
| 剩下 1 处 | 第 1 页元数据块 `lcc::pp` 在 DOM 里多一个空格（多了一个 chip 的空隙，与本 bug 无关，已记录） |

**这条 bug 在质量指标里看不见**：我们所有 CER 都把空格归一化了。建议补一条断言
（导出文本里不许出现"两个英文词直接相连"的模式），这一条还没做。

## P0-2 审校页图仍然糊：图**没有按新宽度重新请求**

先按你说的打 URL：

| 状态 | 页块宽 | 需要 px | 实际请求 | naturalWidth | 比例 |
|---|---:|---:|---|---:|---:|
| 初始 | 384px | 768 | `size=view` | 1275 | **1.66** |
| 页列拉到 760px（原来不重取） | 760px | 1520 | view | 1275 | **0.84 ← 糊** |
| 页列 760px（现在） | 760px | 1520 | **`size=mid`** | **1870** | **1.23** |

也就是说：取档函数是对的（初始 384px 给 view 也够），**问题是页列变宽后没重取**——
左树收起 / 拖宽页列 / 窗口放大都会触发。已加 `ResizeObserver`（250 ms 防抖），
宽度变化时按新像素重算档位，档位变了就作废重取。

## P0-3 鼠标离开后没取消选中

上一单加的"重画后按 `readingHoveredSeq` 补回 `is-hover`"，在离开时没有清状态，所以补回逻辑一直生效。

改了三处：

- 换块时**两侧都先清干净**（原来只清右侧，左边留下旧的绿块）；
- `pointerout` 到块外（含空白区域）立刻 `setReadingHover(null)`；
- 补回逻辑只在 `readingHoveredSeq` 非空时执行（本来就是这样，但状态没清时等于一直非空）。

**实测（真实鼠标）**：

| 动作 | 左侧 `is-linked` | 右侧 `is-hover` | `readingHoveredSeq` |
|---|---:|---:|---|
| 移入第一块 | 1 | 1 | 1 |
| 移到第二块 | 1 | 1 | 2 |
| 移出到空白 | **0** | **0** | **null** |

## 测试

`pytest -q` → **976 passed**。

## 常驻自检（任务 79）：显示 = 导出，每次验收都开

地址栏加 `?checktext=1`（或控制台 `window.__b2tTextCheck = true`）后，
**每渲染完一段就拿 DOM 文本和 `segments[].text` 逐字比对**，不一致打红色警告并给出前后 20 字：

```
[文本自检] 第 5 段右栏显示与导出不一致（第 4 个字符起）
  显示: …lcc: :pp…
  导出: …lcc::pp…
```

默认关闭（`textCheckEnabled()` 只看 URL 参数 / 全局开关）。本次打开后全书只报了 **1 处**
（第 1 页元数据 `lcc::pp`，是 chip 的空隙造成的显示差，与正文无关），
其余 31/32 段逐字一致。

## 空格断言（任务 79）

新增 `tests/unit/test_export_no_glued_words.py`：

- 200 个常见词的词表，把"两词一行"拼 200 行导出，检查**每个 6 字母以上的 token**：
  不是词表里的词、却能拆成两个词表里的词 → 判失败；
- 同时反向确认每对词之间**确实有一个空格**（不是靠"没有粘连"蒙过去）；
- 这本书真实踩过的 4 个粘连点（`prevent the` / `subject to` / `enable people` / `deepest level`）各钉一条。

（这条测的是 `join_lines`——真正加空格的地方；渲染层的丢失由上面的常驻自检盯。）

## 拖动页列时的取图行为（回答"会不会等松手才变清晰"）

模拟拖动：每 100 ms 改一次页列宽度（620→800px），不松手，记录 `src` 变化与图片可见状态：

| 时刻 | 事件 | 请求 | `display≠none` | `is-ready` |
|---:|---|---|---|---|
| 0 ms | 起始 | `size=view` | true | true |
| **576 ms** | 换图 | **`size=mid`** | true | **true**（一直没变 false） |
| 583 ms | 加载完 | `size=mid` | true | true |

- **不是等松手**：最后一次改宽度（300 ms）之后约 **250–280 ms** 就重取（防抖窗口，不是 mouseup）；
- **不闪白**：先在离屏 `Image` 里下完新档再换 `src`，旧图全程可见（改前是"先摘 src 再取"，
  期间 `is-ready=false`，会白一下）。


## 任务 82：连续切片——DOM 文本 = 导出文本（全书 0 不一致）

**问题**：任务 81 把占位空格去掉之后，全书自检仍报 **11 处"重复字符"**：
`laboreefficient` / `Yiwwen` / `nearssynonyms` / `Nansshih` / `ch'uncch'iu`……
比多一个空格更糟——用户会以为 OCR 重复了，去改，**一改就把多余的字母写进库里**。

**结构根源**：每行只切 `[start, end]`，行间空隙用额外的 gap 节点补。这个组合在
`line_spans` 有重叠 / 重复区间时，同一个字符既出现在 gap 里、又出现在相邻行的切片里。

**改法（按 Chief 的建议）**：**行与行首尾相接、无缝无叠的连续切片**。

```js
let cursor = 0;
for (每个 span) {
  const start = Math.max(cursor, span.start);
  const nextStart = 下一行的 start（最后一行 = text.length）;
  const piece = text.slice(start, nextStart);   // 行尾分隔符自然落在这一行末尾
  line = buildReadingLine(segment, span, piece);
  cursor = nextStart;
}
```

- 整段被切成 N 段**连续**切片，拼起来逐字等于 `segment.text`——从结构上不可能丢字或重字；
- 去掉原来那层 gap 节点；
- **编辑仍然基于这一行自己的字**（`dataset.baseText` = 逻辑行文本），保存时去掉行尾分隔符，
  所以不会把 join 空格写进 `block_line.text`（块==行拼接 的校验照旧通过）。

**验收**：

| 项 | 结果 |
|---|---|
| 全书 662 页 / 83 个窗口 / 325 个带差异标记的段 | **不一致 0**（全局自检失败计数 0） |
| 11 个复现点（seq 99 / 741 / 974 / 1066 / 1441 …） | 逐个复查 **same: true** |
| 复制粘贴（选中带标记正文取选区文本） | 与导出**逐字一致**、与 DOM 一致（68 字） |
