# Book2Text 前端↔后端一致性验收（QA 脚手架）

这套东西只解决一件事：**让"我测过了"变成"这条命令跑出来是这样"**。

它来自三次真实误判，每条纪律都对着一次事故：

| 事故 | 当时怎么错的 | 现在怎么防 |
|---|---|---|
| 测到半加载状态 | 页面没加载完就数标记，报"主界面坏了" | 所有等待都是 `waitForFunction` 等**可观测状态**，没有一处 `sleep` |
| 用被自己污染的副本 | 脚本往行尾追加字符，下一轮报"历史数据不一致" | 每次 `up` 都从源项目**重新复制**一份临时库；`prepare` 还会清掉浏览器里的草稿 |
| 测的窗口和用户不一样 | 940px 下说"85% 缩放清楚"，用户 1423px 下是糊的 | 浏览器视口固定 **1423×900 CSS px、dpr 2**，与用户机器一致 |

## 一条命令起 / 一条命令拆

在仓库根目录：

```bash
.venv/bin/python tests/e2e/qa.py up --project b2t_ZAQHGH   # 复制项目库 + 起独立服务（18765 起）
.venv/bin/python tests/e2e/qa.py prepare                   # 开浏览器（1423×900@2）→ 打开项目（此时已可截图）
.venv/bin/python tests/e2e/qa.py smoke                     # 七步冒烟（含两条底线）
.venv/bin/python tests/e2e/qa.py check                     # 三组一致性断言
.venv/bin/python tests/e2e/qa.py images --selftest         # 只量页图清晰度 + 低清负向自检
.venv/bin/python tests/e2e/qa.py down                      # 关服务 + 删临时库
```

`up` 会打印：项目副本路径、服务地址、**带令牌的界面地址**、日志路径。
所有证据落在 `$TMPDIR/b2t-qa/<run>/`：`report-smoke.json` / `report-check.json` /
`server.log` / `screenshots/*.png`。

## 结构

```
tests/e2e/
  qa.py                   # 唯一的 CLI：up/down/prepare/step/reading/smoke/check
  _env.py                 # 复制库（sqlite backup，不 cp 活动库）+ 起停服务
  _api.py                 # HTTP API 客户端 + 只读 Store（核对"库里真的变了"）
  _browser.py             # 把一条命令交给 ego-browser，收回 JSON
  browser/driver.mjs      # 浏览器侧：真实鼠标、视口、等待条件、抽取 DOM
```

依赖：本机装了 **ego-browser**（团队统一的 Chromium 驱动，支持 `page.cdp`）。
它负责真实鼠标事件（CDP `Input.dispatchMouseEvent`）与视口覆盖。

## 七步冒烟（`smoke`）

| 步骤 | 核心断言 |
|---|---|
| 0 打开项目 | 视口 1423×900@2；步骤条 6 步；页数 662（API） |
| 1 页面确认 | 页面摘要里的页数 = API；纳入集合 = 662 |
| 2 文字识别 | 主引擎 662/662 + `active_run` 662 页；步骤条数字 = API |
| 3 版心确认 | 有文字的页都有版心框（`margin_box` = 662 − 无文字页）；步骤条 662/662 |
| 4 目录确认 | 界面"1 页有印刷页码 / 661 页未识别" = finish-summary；无可信页码时步骤条写「可跳过」；**页图清晰度 ≥ 1.0（目录一屏）** |
| 5 正文审校 | 左树头「队列 N 处」= 各行「N 处」之和 = API `total_items`；顶栏分母 = API `chars_total`；阅读流文本自检 0 失败；**页图清晰度 ≥ 1.0（第 1 屏 + 中间一屏）** |
| 6 导出 | 导出覆盖 662 页；预览段数 = 预检段数；点「导出」真的落盘（`body.txt` / `meta.json` / `manifest.json`） |

## 两条不能破的底线

1. **显示 = 导出**：右栏看到的字，必须逐字等于导出器写出的字。
2. **页图清晰度**：`比例 = img.naturalWidth ÷ (img 的 CSS 宽 × devicePixelRatio) ≥ 1.0`。
   小于 1 就是低清图被放大显示，一定糊（用户为这一条提过四次）。

页图判据同时记录 `size=`（请求档位）、`naturalWidth`、CSS 宽、dpr 四项——
失败时一眼能分出是"请求了低档"（size=thumb/view）还是"占位图没替换"（naturalWidth 很小且仍在）。

## 三组一致性断言（`check`）

1. **显示 = 导出**：阅读流里每个已渲染段落，逐字对比 `/export/preview` 的段文本
   （用**阅读视图自己发出的选项**取预览，避免把"选项差异"误报成 bug）。
2. **提交 → 库**：UI 上真实鼠标点行、键盘改 2 处 → 点「提交 N 处」→ 查库：
   块文本变了、含新输入的行、`revision` 递增。
3. **撤销 → 字节**：点「撤回上次提交」→ 相关块的内容指纹（id + text + ocr_text +
   review_status + include + continues_to_next，不含时间戳）必须回到提交前。

## 规矩

- **"通过"必须附命令和输出**。任何一次改动后的结论，至少要有：
  `qa.py smoke` / `qa.py check` 的完整输出或 `report-*.json` 路径。
- **不许用合成事件当用户操作**：点击一律 `page.click` / `page.mouse.click`。
  块图层 `pointer-events: none` 时合成事件能触发、真鼠标不能，这条已经被骗过一次。
- **不许 `sleep` 当等待**：等的是"marks 加载完 / 元素出现 / 某请求返回 / 进度停止"，
  不是"等 6 秒"。
- **产品问题不改代码**：失败项写进报告（最小复现、期望 vs 实际、影响范围），交 Chief 派给开发。

## 已知边界

- 只在本机 macOS + ego-browser 上跑；Windows/Linux 未验证。
- `up` 复制的是**项目库快照**；源项目在测试期间被别的进程写入时，快照仍是复制那一刻。
- 662 页的项目打开阅读流需要几秒；等待上限按 3 分钟设，不是"卡住"。

---

## 2026-10-28 首次真跑（修复前）—— 抓到 1 个真 bug

命令（逐条可复现）：

```bash
.venv/bin/python tests/e2e/qa.py up --project b2t_ZAQHGH
.venv/bin/python tests/e2e/qa.py prepare
.venv/bin/python tests/e2e/qa.py smoke
.venv/bin/python tests/e2e/qa.py check
```

结果：

| 命令 | 结果 | 说明 |
|---|---|---|
| `smoke` | **19/20** | 唯一 FAIL 是产品 bug（下条）；其余六步的 UI 数字都与 API/库对上 |
| `check` | **4/5** | A（显示=导出）失败 = 同一个 bug；B（提交→库）、C（撤销→字节）通过 |

### 抓到的真 bug（已修复）：空区间差异标记被渲染成一个空格

- **样本**：`b2t_ZAQHGH` 第 1 页，块 `01M609YSCTY9T6D986R8XMC3ZS` 第 1 行，
  `current=":pp"`、`candidate="ddc:"`（差异是"插入"，base 侧区间为空）。
- **实际**：右栏显示 `lcc: :pp`；导出段文本是 `lcc::pp`。
  根因在 `static/app.js` 的 `buildReadingLine`：
  `markEl.textContent = baseText.slice(range.start, range.end) || " "` ——
  空区间用一个空格占位，这个空格进了 `textContent`。
- **规模**：全书 866 条差异标记中，有 **1022 个**这样的空区间（`qa.py` 的 `audit` 命令，
  用应用自己的 `computeCharSpans` 算的）——即最多 1022 处会多显示一个空格。
- **影响**：只影响"看"，不影响导出；但它违反"审的字 = 导出的字"，
  用户会以为原文多一个空格，甚至去"修"一个导出里不存在的问题。
- **期望**：占位不进入文本（如空 `<span>` + `aria-hidden`，或伪元素），
  `textContent` 必须与 `segment.text` 逐字相同。
- 打开 `?checktext=1` 时应用自带的 `[文本自检]` 也会报这一处（`__b2tTextCheckFails=1`）。
- **已修复**：`257c5b5`（占位不进 textContent）+ `f57ec23`（行与行连续切片）；
  修复后 `qa.py check` 的 A 项从 FAIL 变 PASS（32 个已渲染段落逐字相同）。

### 修复后复跑（2026-10-28 15:30）

开发修了 `257c5b5`（空区间不再用空格占位）+ `f57ec23`（行与行连续切片）之后：

| 命令 | 结果 |
|---|---|
| `qa.py smoke` | **23/23 通过**（新增 3 条页图清晰度） |
| `qa.py check` | **5/5 通过**（A：32 个已渲染段落逐字相同） |
| `qa.py images --selftest` | 正常 3/3 通过；负向自检报 FAIL（thumb 比例 0.443） |

页图清晰度实测（`qa.py images --selftest` 的表）：

| 屏 | 页号 | size | naturalWidth | CSS宽 | dpr | 比例 | 结果 |
|---|---|---|---|---|---|---|---|
| 审校第 1 屏 | p1 / p2 | view | 1275 | 384 | 2 | 1.660 | PASS |
| 审校中间一屏 | p331 / p332 / p333 | view | 1275 | 384 | 2 | 1.660 | PASS |
| 目录确认一屏 | p1 | zoom | 2550 | 1076 | 2 | 1.185 | PASS |
| 负向自检（人为 thumb） | p1 | thumb | 340 | 384 | 2 | **0.443** | **FAIL（预期）** |

### 流程卡点（不是 bug，是这本书还没走到的步骤）

- 页面确认：**0/662 页已确认**（步骤条仍是序号 1）。
- 目录确认：1/662 页有印刷页码，后端判定「可跳过」。
- 正文审校：队列 866 处（汉字 573 + 标点 293），已审 0。
