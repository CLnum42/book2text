# 页码污染正文 + 进度显示 + 审校页糊 + 三处交互（任务 74–76）

> 2026-10-28。《安乐哲 译本处理》662 页（副本 `/tmp/b2t-hd`）。真书库只读，没重跑。

## P0-1 页码污染正文：已剔除 277 页的页眉行

**问题**：页眉 `Page 28` 被识别成普通 `paragraph` 块，既进导出正文，也被当成"顶边那一行"。

**做法**（新模块 `core/export/header_cleanup.py`，窄规则）：

- **只看"每页第一个块的第一行"**，不做全书行级正则（正文里真有整行是"红楼梦"的）；
- 整行匹配 `Page 28` / `P. 28` / `- 28 -` / `28` / 罗马数字 `Page viii` → 整行摘掉；
  摘完为空的块（整块就是页码）直接不进正文；
- 行首是页码、后面还跟着 >=12 字正文（OCR 把页眉并进首段）→ 只摘前缀。

**实测（这本书）**：

| | 数量 |
|---|---:|
| 删掉整块（整块就一行页码） | **16 块** |
| 删掉一行（块里还有别的行） | **261 行** |
| 首块字符 | 756,247 → **753,887**（少 **2,360** 字） |
| 导出段数 | 4829 → **4827** |

**误报检查**：全书正文块里"整行匹配页码模式"的行有 308 处，我们只摘了 277 处；
剩下 31 处在**非首块**里（目录页的 "Page viii 153 155…"、书末索引的 "Page 165"），
按窄规则**不动**——它们是真内容。修完导出里再没有整段是页码的段（剩 6 处全是 TOC / 索引条目）。

**版心拟合**：`suggest_margin_box` 现在也会把"每页首块首行的页眉框"排除。
但实测这本书的顶边**没有变化**（0.1032，正文首行 0.107，页眉在 0.120）——
页眉本来就在框内，是"框包含页眉带"，不是拟合错。真正的问题就是**没被排除**，已在上面解决。

## P0-2 第二引擎进度 0/457（快照 vs 实时打架）

识别期间收尾面板返回快照（`engine.checked` 还是 0），抽屉是实时 job 进度 → 两个数打架、还随快照刷新闪。

**改**：识别步的"第二引擎"进度**改读实时任务**（`liveAuxProgress()`，来自抽屉的轮询数据），
快照只留给统计数字（字数、差异数）。没在跑时才回落 `engine.checked`。

## P0-3 审校页糊：量的是 `<img>` 自己（加载前宽度 0）

`pageProfileFor(image, pageNo)` 量图片自己的 `getBoundingClientRect().width`——图加载前是隐藏的，
宽度 **0** → need=0 → 永远拿 `view`（150 DPI）。目录确认量的是外层 wrap，所以那边是好的。

**改**：量**外层页块**，量不到再 `offsetWidth` / 父元素 / 视口估算。

**实测（1423 CSS px / dpr 2）**：

| 页块宽 | 请求 | naturalWidth | 比例 |
|---:|---|---:|---:|
| 384px | view | 1275 | **1.66** |
| **700px**（用户那种宽页列） | **mid** | 1870 | **1.34** ← 改前会是 view(1275) = 0.91 |

## P1-1 版心框太粗：1px 半透明，去掉那圈白边

`border: 1px solid rgba(11,95,88,.42)`（原来 1px 实色 + 1px 白边，白边是"粗"的观感来源），
内外对比仍靠 0.34 的遮罩。**拖动手柄的样式与热区一点没动**。

## P1-2 块高亮改成色块 + 悬停双向联动（**真实鼠标事件验过**）

- 悬停/选中：`background: rgba(22,163,74,.28)` 铺满整块 + 1px 细边（原来只有 outline）；
- 右→左（原有）：悬停右栏段落 → 左侧对应块铺绿；
- 左→右（新增）：`setReadingHoverByBlock()`，悬停 PDF 上的块 → 右侧对应段落加 `is-hover`
  （同一颜色 `rgba(22,163,74,.16)` + 内描边），左侧这一段的所有块一起铺绿。
### 真实鼠标事件验收（CDP `Input.dispatchMouseEvent` / `mouseMoved`，不是 `element.dispatchEvent`）

第一次用真实鼠标测**不亮**，查出两个真原因（都是"看着像功能的死代码"那一类）：

1. **块的元素是 `pointer-events: none`**：叠层为了不挡拖拽默认不吃事件，真实鼠标根本到不了块上。
   `element.dispatchEvent` 能骗过自己，真鼠标不行。→ 只给阅读流的块开 `pointer-events: auto`
   （差异层 / 版心框仍是 none）。
2. **右栏重画把 `is-hover` 冲掉**：切页补 marks 会重建段节点，鼠标还停在块上、右边的绿没了。
   → `renderReading` 里按 `readingHoveredSeq` 把 `is-hover` 补回来。

改完的真实鼠标结果（1423×900）：

| 方向 | 结果 |
|---|---|
| 鼠标移到左侧块中心（387, 299） | 右侧段 `is-hover` ✅、底色 `rgba(22,163,74,0.16)`、左侧 `is-linked` 1 个 |
| 鼠标移到右侧段中心（898, 118） | 左侧块铺 `rgba(22,163,74,0.28)` ✅、该段同时 `is-hover` |
| 鼠标移开（5, 5） | `is-linked` 0、`is-hover` 0（干净退出） |

截图：`docs/screenshots/hover-left-to-right.png`、`hover-right-to-left.png`。

## 页码剔除抽查：10 页首行删前 / 删后

| 页 | 删前首行 | 删后首行 | 残留 |
|---:|---|---|---|
| 30 | `Page xxii` | `Nan Tzu has not only gone generally unnoticed in Western` | 无 |
| 32 | `Page xxiii` | `in its capacity for reconciling selected elements of conflicting` | 无 |
| 34 | `Page xxiv` | `franchise these vassals and consolidate its own power at their` | 无 |
| 36 | `Page xxV` | `for the early Han author; analyzing The Art of Rulership's` | 无 |
| 41 | `Page 2` | `endowment. It is the cultivation of rightness through the dynami` | 无 |
| 43 | `Page 3` | `mines the degree to which a society supports or retards the proj` | 无 |
| 45 | `Page 4` | `forty I was of one mind, at fifty I understood the unfolding of` | 无 |
| 48 | `Page 5` | `Yin, 14 wear the ceremonial cap of Chou, and as for music there` | 无 |
| 50 | `Page 6` | `of Chinese culture had culminated in a sophisticated pattern for` | 无 |
| 52 | `Page 7` | `Have no recourse to use it.` | 无 |

**"页码 + 正文"并成一行的例子**（第 11 页）：原首行
`Page x stakes out a new position that manages to embrace both:` →
摘前缀后 `stakes out a new position that manages to embrace both:`，
**没有啃掉单词**（规则要求数字后面必须有空白分隔，`Page x ` 整段带空格一起摘）。

## P1-3 编辑时左侧标出"正在改的那一行"

右侧点进编辑后，左侧按**行框**画一个琥珀框（`.reading-edit-line`，2px `#d97706` + 20% 底），
所在块给一层很淡的琥珀 + 虚线边（`.is-editing-block`）。退出编辑（`Esc`）两者一起清掉。

实测：`editLineDrawn: true`、边框 `rgb(217, 119, 6)`、框 45×12 px、块标记 1 个、退出后 0 个。

**为什么不复用 `#reading-pdf-box`**：那个节点在重建页列时会被 `wrap.innerHTML = ""` 清掉，
复用它会时有时无；改成每条页块自己挂一个。
