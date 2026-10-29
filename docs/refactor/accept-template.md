# 视图落盘验收 · 模板（`accept_<view>.py`）

> 适用：一个视图从 `app.js` 整段搬进 `<view>-view.js` 之后，**机械地判"搬干净了没有"**。
> 范本：`scripts/accept_library.py`（第一个按这套口径跑的脚本）。
> 本文件写清**哪些话不用重想（不变）、哪些必须每个视图自己填（可变）**——第二刀照着填，别重新发明。

---

## 0. 什么时候**不**该用这个模板

判据是"验收本身有没有可错的空间"，不是"要不要统一"。

- **`merge`（2 个导出 / 9 个函数）可能不值得单独写脚本**：数太小时，人工 `grep` 三行就能对完，
  写一个脚本反而多一处会漂的配置。**那就直说"这个视图用清单人工验"，别为统一而造脚本。**
- **视图的模块形态还没定**（例如 `pages` 可能是 1 个模块，也可能是 5 个）→ **不要提前写**。
  脚本的形状由落盘后的结构决定，提前写基本是写错的东西。
- 只搬了**一部分**（切片中途）→ 用切片自己的读数（DRYRUN）对账，别用"归零"口径：
  本模板判的是"最后归零"，半成品跑它只会得到一堆正确的红。

---

## 1. 不变的部分（每刀都一样，别改判据）

| 项 | 判据 | 为什么是它 |
|---|---|---|
| **退出码三态** | `2` 未落盘（前置不满足）/ `1` 红 / `0` 通过 | 这样"还没到验收的时候"和"验收不过"不会混成一个数；CI 与人都能读 |
| **id 集合** | 从 `index.html` 的 `<section id="view-<view>">` **按标签深度**抽 `id="…"` | 视图里有嵌套 `<section>`，见第一个 `</section>` 就停会漏一半 id |
| **字面量 → 0** | `app.js` 里对上述 id 的 `el("x")` / `getElementById("x")` / `querySelector("#x")` 全部归零 | 这是 R3 的判据；有 `<view>-view.js` 之后，外壳里再写该视图的 DOM 就是旧字面量没清干净 |
| **写点 → 0** | 字面量里属于"往该视图 DOM 写内容"的那几个 id（library 是 `library-error` / `library-warning`） | 留给外壳的函数必须改调 `notify`；**两个数都要报**（总量 ⊃ 写点，拆开才知道断在哪一层） |
| **减量 ≥ 300 行（硬判据）** | `app.js` 行数比搬前少 **≥ 300** | 少于这个数就是"复制不是搬"。**不要用 ±20 容差当红**——容差只用于对账提示 |
| **导出面精确相等** | `window.<View> = { … }` 的 key 集合 **等于**名单 | 多一个=偷偷长上帝对象（R8 按模块建）；少一个=入口断了（不再是 breaking change，是没接上） |
| **每个函数 0/1** | 待搬清单里每个名字：`app.js` 0 处定义、模块 1 处 | "搬了一半"最典型的形态就是两边各留一份定义 |
| **每个数带出处** | 数字旁边写产生它的命令或文件 | 干跑读数不落文件就等于只在对话里，第二天没人知道 24 是怎么来的 |

## 2. 可变的部分（每个视图自己填，改这些不算改判据）

```python
VIEW        = "library"                 # → <section id="view-library">
MODULE      = "library-view.js"         # static/ 下的模块文件名
MOVERS_SRC  = "docs/refactor/evidence/library/rules.py"   # 待搬函数清单从哪读
EXPORTS     = {"init", "enter", "notify"}                 # 期望的导出面
WRITE_IDS   = ("library-error", "library-warning")        # 哪几个 id 属于"写点"
BASELINE    = {...}                     # 搬前读数：app.js 行数、字面量处数、写点处数
```

- **待搬清单别手抄**：library 是从 `rules.py` 的 `MOVERS` 读的。手抄 17 个名字，第二刀就会漏一个。
- **`WRITE_IDS` 要说明"为什么这几个算写点"**（library 的判据：外壳留下的函数里仍然往这两个元素写文案）。
- **`BASELINE` 必须来自 DRYRUN 那种"一行一个数 + 出处命令"的文件**，不是记忆。

## 3. 脚本骨架（照抄，改配置即可）

```python
#!/usr/bin/env python3
"""scripts/accept_<view>.py —— <view> 落盘后的验收。口径见 docs/refactor/accept-template.md。"""
import importlib.util, re, sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parent                      # cwd 无关：按脚本自身位置定位
STATIC = REPO / "backend/book2text/static"

def prereq(msg):                              # 前置不满足 → 2，不是失败
    print(f"[2] 前置不满足：{msg}"); sys.exit(2)

def section_ids(html, view):                  # 按标签深度取子树 id
    ...

def id_literals(source, ids):                 # el / getElementById / querySelector 三形态
    ...

def count_definitions(source, name):          # function NAME( 或 const NAME =
    ...

def main() -> int:
    # ① 前置：app.js / index.html / 读数文件都在；id 集合非空；模块在不在
    # ② 字面量 → 0（逐个 id 点名，别只说"还有残留"）
    # ③ 写点 → 0
    # ④ app.js 减量 ≥ 300（硬判据）
    # ⑤ 导出面精确相等
    # ⑥ 每个待搬函数 app.js 0 / 模块 1
    # 有红 → 打印逐条、return 1；全过 → return 0
```

**定位仓库根的那三行**：复制本模板/`accept_library.py` 的写法（`Path(__file__).resolve().parent.parent`）。
**如果出现第三个脚本要同一段**，就抽 `scripts/lib/repo.py`——**两处重复可以忍，三处重复就是该抽的信号**
（今晚已经重复过一次：`status.sh` 与 `accept_library.py` 各写一遍）。

## 4. 验收流程（顺序别换）

1. **落盘前跑**：必须 `exit 2`，并把"待归零的数"打出来（9 id / 24 处 / 19 写点 / 17 函数）。
   这一步是**自检脚本没瞎**：数字与 DRYRUN 对不上就说明口径错了。
2. **半成品跑**（可选，强烈建议）：临时副本里放一个"多一个导出 / 函数没搬"的模块 → 必须 `exit 1`，
   且逐条红能点名到 id 与函数。
3. **真落盘跑**：要 `exit 0`。

## 5. 三条纪律

- **不改产品文件**。红了只贴红，不顺手"帮我修一下"——那是 DevLead 的回合，改了就没人知道谁动的。
- **红要原样贴**：逐条、带 `文件:行`/`id`/`函数名`，不要分析、不要概括成"还有残留"。
- **别预热没定的视图**（`pages` 今天不开、形态未定）：脚本的形状由落盘后的结构决定。

## 6. 第三消费者的实测输入（`--acid <json>`）

有些判据**只能来自真机**（例如 `pages` 的「同页同档取图只取一次」）——它不在静态源码里，
所以验收器不自己算，而是读一份**固定格式**的实测 JSON。**格式定死，缺字段一律 `exit 2`。**

```json
{
  "imgSrcAssignments": 1,
  "observers": 6,
  "sameImg": true,
  "evidence": "tests/e2e/artifacts/<日期>-<项目>/acid-pages.json"
}
```

| 字段 | 类型 | 判据 | 为什么是它 |
|---|---|---|---|
| `imgSrcAssignments` | 整数 | **必须 = 1** | 同页同档一次取图。**不要去数网络请求**：`/pages/N/image` 带 `max-age=300`，第二次命中缓存会把重复取图盖掉 |
| `observers` | 整数 | **≤ 6** | 调度器不许又分裂成多份；6 是结构上限，不是"现在正好 6" |
| `sameImg` | 布尔 | **必须 `true`** | 同页同档必须是同一张图（URL 参数/缓存键分叉时这里是 `false`） |
| `evidence` | 字符串 | **必须是存在的文件路径** | 证据要能被人打开复核；只写 `"ok"` 不算证据 |

**缺任一字段 → `exit 2`（未验），不是通过、也不是红。**
理由：`aac4568` 那次就是"只有 e2e 实机证据、闸里没有用例"被当成过了——**没验长得像验过，是最坏的绿**。
`evidence` 指向的文件不存在，同样算未验（`exit 2`）。

## 7. 五刀口径（`--stage 1..5`，`pages` 专用）

`pages` 不是一刀归零：`docs/refactor/pages-plan.md` 把它切成 5 个语义操作，**每刀单独验收、单独回滚**。
`accept_pages.py --stage N` 就是按那五刀判，判据**从文档派生**（脚本里不写死行数）：

| 判据 | 第 1–4 刀 | 第 5 刀 | 出处 |
|---|---|---|---|
| 减量下界 | `计划该刀行数 × 0.5` | 同上 | `pages-plan.md` §2「少于一半 = 复制不是搬，停」 |
| R3（`view-pages` 字面量） | **必须低于基线、且不能归零**（其余组还在 app.js 里） | **必须 = 0** | `pages-plan.md` §2 的 R3 阶梯表 |
| R3 豁免 | 条数 ≤ 上限，且**不许出现 pages 的 id** | 同上 | §2「不批只搬接线类靠开豁免过闸」 |
| 名单版本 | `--expect-sha` **必给**（用该刀冻结版名单的 sha），不符 exit 1 | 同上 | §2 |
| 第三消费者 | `--acid` 四字段（缺一 exit 2） | 同上 | §6 |

**用量**：

```bash
python3 scripts/accept_pages.py --stage 3 --expect-sha <该刀名单 sha 前 12 位> --acid /tmp/acid.json
```

**退出码**：`0` 过 / `1` 该刀判据不过 / `2` 未验（模块没落盘、`--acid` 或 `--expect-sha` 没给）/ `64` **调用方式错**（`--stage` 不在 1..5、或透传了不认识的参数）。

64 必须与 2 分开：`land_pages.sh` 会把参数原样透传，**"用法错"被读成"还没验"会让人去查产品**。

**判不了的不进闸**：计划里没列每刀的 movers 归属，所以上界不判（只判下界）；R3 的「逐刀递减」目前只判「低于基线」——要判严格单调，得先给每刀留读数档。
