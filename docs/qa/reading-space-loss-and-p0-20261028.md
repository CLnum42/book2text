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
