# 真机验收 runbook：不在主树里跑

> 适用：需要真人点界面、看真实读数、做一次"这台机器上到底行不行"的验收。
> 不适用：自动化测试（`pytest` / `node tests/js/run.mjs` / `qa.py` 各有自己的隔离）。

## 0. 一句话

真机验收 = **在你自己的 worktree 里起一个只服务这棵树的进程**；主树只做集成与推送。

## 1. 为什么不能在主树里跑

三个理由，按事故严重度排：

1. **主树是共享的。** 四个人共用一棵集成树，工作区随时有别人未提交的改动。你在主树点出来的"通过"，可能测的是别人半小时前的半成品。
2. **复制一份 `.venv` 并不能隔离。** 本项目是 editable 安装，`site-packages/_editable_impl_book2text.pth` 里写的是**绝对路径**，指向主树的 `backend`。实测：`worktrees/builder/.venv` 里的同名 `.pth` **也指向主树**。所以"用 worktree 自己的 venv"不等于"用 worktree 的代码"。
3. **已经出过一次假绿。** 被测进程实际 import 的是主树代码，对照实验读到的是干净的原工作区，于是"改前改后一样"——看起来通过，其实两边跑的都是老代码。

第 2 条的解法是第 2.2 步的 `PYTHONPATH="$PWD/backend"`：PYTHONPATH 排在 `.pth` 之前，先命中你这棵树的包。第 2.3 步的静态自检就是这条解法的证据。

**推论：不必复制 `.venv`。** 用主树的 venv 跑、靠 `PYTHONPATH` 把关，比复制一份更可靠——复制出来的那份 `.pth` 照样指向主树，只会让人误以为已经隔离。

## 2. 六个步骤

### 2.1 进自己的 worktree

```bash
cd ../worktrees/<你的>        # 从主树根目录出发：worktree 在仓库外的同级目录
git status --porcelain        # 应当看到你自己的改动 + ?? .venv
```

判据：`git status` 里出现的改动**必须都是你这次要验的**。看到不认识的改动 → 你在别人的树里（或仍在主树），停。

### 2.2 起服务：PYTHONPATH 指向本棵树

```bash
PYTHONPATH="$PWD/backend" \
  /Users/chenlin/DeepSeek Bot/book2text/.venv/bin/python -c \
  "from book2text.main import main; raise SystemExit(main(['--port','9500','--no-browser','--library','/tmp/b2t-<task>-lib','--token','qa-<task>']))"
```

**同一件事也管 pytest**（2026-10-30，AGENTS.md §1.5 有完整条目）：worktree 里不带 `PYTHONPATH` 跑
`pytest`，读的是主树的 `backend/book2text/static`——测试文件取你的树、被测前端代码取主树的，
结果往往是一套**自洽的绿**而不是红。自检一行：

```bash
PYTHONPATH="$PWD/backend" .venv/bin/python -c "from book2text import paths; print(paths.STATIC_DIR)"
# 必须打印你这棵 worktree 里的 backend/book2text/static
```

参数的理由（`--no-browser` 字面即意：不自动打开浏览器）：

- `--library /tmp/b2t-<task>-lib`：项目库写到 `/tmp`，**不碰真项目库**，验完整个删掉。
- `--token qa-<task>`：默认令牌每次启动随机生成（`secrets.token_urlsafe(32)`）；固定成短令牌后可以直接拼 URL、重启复用同一个地址、脚本不用每次抓日志。
- `--port 9500`：**端口可任选**（示例 9500，走 95 段，各人错开）；**被占会自动往后试**，所以实际端口**一律以日志为准**：

```text
界面地址：http://127.0.0.1:<实际端口>/?token=qa-<task>
```

### 2.3 隔离自检（这一步不能跳）

```bash
curl -s "http://127.0.0.1:<实际端口>/static/<你改动的文件>.js?token=qa-<task>" \
  | grep -c "<你这次新增的符号>"
# 期望 >= 1
```

为什么查"新增符号"而不是"文件能打开"：文件能打开只证明服务活着；**只有你刚写进这棵树、主树还没有的符号**，才能证明服务读的是你的树。返回 0 → 立刻停，先查 `PYTHONPATH` 和 `cd`——这时所有读数都不可信。

> **待脚本化（到期点：刀 9 开工前）**：第 2.3 步将来做成 `scripts/verify_isolation.sh`（`curl | grep -c`，计数 0 就非 0 退出）。归 DevLead / Builder 定；到期没做就删掉这句，不留陈账。

### 2.4 失败注入：用计数器，不用肉眼

```js
// 只拦目标端点，其它请求原样放行
const realFetch = window.fetch;
window.__stubHits = 0;
window.fetch = (input, init) => {
  const url = String(input);
  if (url.includes("/api/<目标端点>")) {
    window.__stubHits += 1;
    return Promise.resolve(new Response(
      JSON.stringify({ error: "stubbed" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    ));
  }
  return realFetch(input, init);
};
```

判据：**同一次失败注入里，计数从 0 变成 1，且只命中目标端点**（其它端点计数不变）。
计数器名字自定——示例叫 `__stubHits`，换成什么都行；**别依赖仓库里有这个变量**（它是验收的人当场装的）。

反例：界面上出现红色错误条，**不能**证明走的是你要验的那条路——红可能来自别的端点、上一条缓存、或一个早就存在的 500。**红是"发生了错误"，计数器是"你拦的那次请求真的发生了"，两者不是一回事。**

收尾时把 `window.fetch` 还原，否则下一页的读数全被污染。

### 2.5 收尾（全做）

- [ ] 停服务（`Ctrl-C` / kill 进程；确认端口已释放）
- [ ] `rm -rf /tmp/b2t-<task>-lib`
- [ ] `ego-browser finish({ keep: [] })`——**保留页面是例外，必须在报告里写明理由**（团队漏过一次 9 个 space）
- [ ] `git status --porcelain`：**理想是只剩 `?? .venv`**（改动已提交）；如果故意留着未提交的改动继续验，在报告里点名它，别让它混进下一轮验收
- [ ] 报告里贴：实际端口 / 静态自检计数 / 失败注入的计数 / `git status`

### 2.6 主树只做集成与推送

主树不拿来跑真机。要合的时候再回主树 merge / push。

## 3. 常见失败

| 症状 | 原因 | 处理 |
|---|---|---|
| 静态自检 = 0 | 没设 `PYTHONPATH`，或没 `cd` 到本 worktree | 重起，先只做 2.2 + 2.3 |
| 端口连不上 | 起始端口被占，服务自动 +1 | 读日志里的实际端口 |
| 页面 401 `invalid_token` | URL 里的 token 与启动参数不一致 | 用你启动时给的 `--token` |
| 界面还是旧样子 | 浏览器缓存 | 硬刷新；静态自检通过说明服务侧没问题 |
| 收尾后 `git status` 还有别的改动 | 你在主树或别人的 worktree 里 | 立刻停，别提交 |
| 界面上什么都不出现，但闸全绿 | 状态指向了**不可见的元素**——引用的节点还在，但被隐藏、或已不在当前 DOM 里 | 先打印状态指向的 id / 元素，查它的 `hidden` 与父链可见性。闸绿只证明逻辑走到了，**不证明人看得见**（完整样例见 4.1 的 C 行） |

## 4. 样例：一次真机验收长什么样

> 真实样例，不是示意：Builder 验「刀 7 · 识别失败时错误条写哪儿」时产出的表。

### 4.1 判据表

| # | 场景 | 前置状态（必须实测） | 动作 | 期望 DOM 变化 | 不期望的变化 | 失败注入计数 |
|---|---|---|---|---|---|---|
| A | 审校详情开着 | `detailPageNo` 非空 · 当前视图 `#view-review` | 点「⋯ → 重新识别」 | `#page-detail-error`：`hidden` true→false，`textContent` ""→错误文本 | `#pages-error` 保持 `hidden=true` | 0→1 |
| B | 页面视图，没开过详情 | `detailPageNo === null` · `#view-pages` | 点页块「识别」 | `#pages-error`：`hidden` true→false，`display` none→block，`textContent`→错误文本 | `#page-detail-error` 保持 `hidden=true` | 0→1 |
| C | stale：开过详情又离开审校 | 开详情到第 2 页 → 点步骤条「页面确认」→ 实测 `detailPageNo` 已 null、`lastDetailPageNo` 仍 2 | 点页块「识别」 | `#pages-error`：`hidden` true→false，`display` none→block | `#page-detail-error` **仍 `hidden=true`** | 0→1（本场景内） |
| D | 伴生状态生效 | 开详情到第 2 页 → 回「页面确认」 | 点步骤条「目录确认」 | `#index-page-no` = 「第 2 页」 | — | 不涉及 |

### 4.2 三件必须点出来的事

**① 判"通过"看的是元素上的三个字段**——`hidden` / `display` / `textContent`，不是"界面上看起来有提示"。同一个元素可能 `hidden=false` 但父链不可见，也可能文本正确但写在另一个视图的错误条里。

**② "修前会是什么样"这个对照，是本表最值钱的部分。** C 场景在修复前是：`#pages-error` 保持 `hidden`，错误被写进另一个视图里隐藏的错误条 ⇒ **屏幕上什么都不出现**。所以——**只量"修后对了"证明不了修好，只能证明现在如此**。这条是通用要求：每条判据都要能回答"如果它坏了，我会看到什么"。

**③ 前置状态必须实测**（A 要 `detailPageNo` 非空、B 要它为空、C 要它刚被清）。不实测就会**在错误的场景里验了一条通过的路径**——A 和 B 只差这一个变量，量错了，两行会同时"通过"。

### 4.3 这次用的是

```text
脚本路径仅供复现，别人不必照抄：/tmp/ego-k7/round-50/51/52.mjs
环境：PYTHONPATH=worktrees/<你的>/backend + 独立 --library /tmp/b2t-* + 固定 --token
fixture：fixtures/pdf/synthetic-smoke-3pages.pdf；跑完 finish({ keep: [] }) 并删临时库
```

## 5. 报告模板

```text
真机验收 <任务>：<结论>
- 树：worktrees/<你的>（分支 wt/<你的>，HEAD <sha>）
- 服务：实际端口 <port>，库 /tmp/b2t-<task>-lib
- 隔离自检：/static/<file>.js 含 <符号> × <计数>
- 失败注入：<端点> 计数 0→<n>
- 对照：修前 <症状> / 修后 <字段变化>（有对照才写）
- 收尾：服务已停 / tmp 库已删 / ego-browser 已 finish / git status 只剩 ?? .venv
```


## 6. 版心检测进度条（真机验收 runbook + 2026-11-01 实测）

要验的东西：布局检测任务（`job_type = "layout"`）运行时，`#margin-fit-progress` /
`#margin-fit-fill` / `#margin-fit-text` 三个元素要**跟着 `job.done` 真增长**。

> **前提更正（2026-11-01 实测）**：`GET /api/app/info` 里
> `engines.by_role.layout` 的两项（`rapid_layout` / `pp_doclayout`）本机都是 `available: false`，
> 但**这条链路不走它们**：生产引擎是 `default_layout_engine()` = `RapidOcrDetAdapter`
> （`params.engine_id = "rapidocr_det"`，来自已装的 rapidocr）。
> 本机实测 `POST /jobs/layout` → HTTP 200 建任务、`succeeded 1/1`、页拿到 `layout_lines 44` 与版心框。
> **所以这条在本机可验**，不需要先装那两个可选包。

### 6.1 怎么做（入口 + 采样）

```text
① 先造够大的范围（M ≥ 20，否则几百毫秒跑完采不到中间态）：
   页面确认 → 范围输入（例如 134-173）→ 选中 40 页
② 版心确认步 → 右上角「⋯」→「检测版面…」(#layout-detect-open)
   → 对话框 #layout-detect-plan 应显示「正文页 40 / 这次要检测 40 / 预计耗时 约 15 秒」
   → 点 #layout-detect-start「开始检测（40 页）」
③ 每 1 秒采一次（同一 tick 里读 DOM + 拉一次 jobs，别分两次读）：
   #margin-fit-progress.hidden / #margin-fit-fill.style.width / #margin-fit-text.textContent
   GET /api/projects/<id>/jobs?limit=1 → 那条 layout 的 done / failed / total / status
```

### 6.2 判据（每条都能红）

```text
J1 起跑：文本 ==「正在检测版面… 0 / M 页」，#margin-fit-progress hidden=false
J2 单调：文本里的 N 不回退
J3 同步：同一 tick 里 N 与 job.done(+failed) 一致（允许 ±2：前端按 1 秒轮询，DOM 会晚一拍）
J4 增长：M ≥ 20 时至少采到 3 个不同的 N
J5 宽度：style.width == round(N / M * 100)%（允许 ±1 取整）
J6 收尾：任务结束后文本变「检测：M / M 页」，5 秒后 #margin-fit-progress hidden=true
        （cancelled / interrupted 时是「检测：done / total 页」）
J7 暂停：暂停 → 文本含「（已暂停）」、N 冻结、job.status=paused；继续后恢复增长
J8 单一写者（**新增，2026-11-01 实测发现必须加**）：
    检测任务运行期间，同一元素只能出现检测文案；出现「正在为 M 页自动拟合版心…」即判红。
    自动拟合的分母在运行中必须不变；百分比不得回跳。
```

**反例（任一出现即判红，不是"看起来在涨"就算过）**：
`job.done` 涨而 N 不动 / 同一采样点 N 与 done 差得越来越多 / N 回退 /
任务在跑而进度条 hidden / 结束后 5 秒仍在 / 检测与拟合两组文案在同一元素上来回翻。

### 6.3 证据格式（能复算，不靠"我看见了"）

```text
t(s)  #margin-fit-text                            文本N  done  failed  status     fill%  hidden
1     正在检测版面… 0 / 40 页                       0      0     0       running    0%     false
2     正在检测版面… 13 / 40 页 · 还需约 17 秒       13     13    0       running    33%    false
...（结束时）
26    检测：40 / 40 页                             40     40    0       succeeded  100%   false → 5s 后 true
```

同时贴原始 JSON（不要只贴界面文本），并配 3 张截图（0/M、中间、结束后）：

```bash
curl -s "$BASE/api/projects/<id>/jobs?limit=3" -H "X-B2T-Token: $TOKEN" | python3 -m json.tool
curl -s "$BASE/api/projects/<id>/layout/plan"  -H "X-B2T-Token: $TOKEN" | python3 -m json.tool
```

### 6.4 在什么环境下这一条才算过

```text
过：任意能跑 detection 的环境（本机即可，引擎 = rapidocr_det）；
    按 6.1 起一个 M ≥ 20 的检测任务，J1–J8 全绿，按 6.3 贴采样表。
不过：J8 不绿时不要写"进度条可用"——用户在检测期间会看到另一组数字。
```

### 6.5 2026-11-01 本机实测（M=40，采样 23 次）

```text
通过：J1（0 / 40 页）· J2（检测侧 N 单调）· J3（13/13、26/26、28/28、39/39，差 1 是轮询晚一拍）
      J4（0→1→13→14→26→28→39 共 6 个不同值）· J5（13→33%、14→35%、26→65%、28→70%、39→98%）
不通过：J6 与 J8
```

**不通过现场（J8，两个写者抢同一元素）**：23 次采样里 8 次显示检测文案、15 次被自动拟合文案覆盖：

```text
t=3s   正在为 376 页自动拟合版心… 40 / 376
t=4s   正在为 473 页自动拟合版心… 140 / 473
t=10s  正在为 1042 页自动拟合版心… 720 / 1042
t=17s  正在为 1689 页自动拟合版心… 1380 / 1689
t=23s  正在为 2238 页自动拟合版心… 1940 / 2238
```

分母 376 → 473 → 571 → 669 → 767 → 1042 → … → 3078 **在运行中一路变大**，
进度条宽度也跟着回跳（85% → 87% → 65% → 70%）。代码事实：
`ensureMarginFitted` 每批 20 页后调 `showMarginFitProgress(attempted, attempted + remaining)`，
而 `remaining` 是"全书还缺框的页数"，检测还在产出新行时会继续增加，于是
`total = attempted + remaining` 越算越大。

**不通过现场（J6，收尾文案看不到）**：检测 `succeeded 40/40` 后 6 秒，
`#margin-fit-text` 仍是「正在为 3078 页自动拟合版心… 2780 / 3078」，
没有出现「检测：40 / 40 页」——被拟合进度覆盖。（`#margin-status` 的
「版面检测完成：40 页。还有 317 页这次没检出正文行…」是对的。）

### 6.6 别和「自动拟合版心」混淆

同一组元素被两处写（这就是 J8 的由来）：

```text
检测任务（job_type=layout）  运行时「正在检测版面… N / M 页」      结束「检测：N / M 页」
自动拟合（marginFitRunning） 运行时「正在为 M 页自动拟合版心… N / M」 结束「自动拟合完成：M 页」
```

判 J1–J7 前先确认 `job_type=layout` 且文案是检测那种；出现拟合文案就按 J8 记。
`N = job.done + job.failed`——失败页也计入，所以一页 40MP 超限失败时 N 会跳一格而 total 不变，属预期。

### 6.7 现有用例有没有假定进度条可用（2026-11-01 核）

```text
tests/integration/test_ui_assets.py:619   只断言页面里有 id="margin-fit-progress"（静态存在性）
tests/e2e/browser/driver.mjs:1225         只把 #margin-fit-text 收进 DOM 快照文本，无断言
tests/e2e/qa.py（margin 相关）            读"版心已定 / 未定"汇总，不看进度条
⇒ 没有用例假定它"会增长"：0 红、0 skip（test_ui_assets.py 实测 47 passed / 0 skipped）
```

所以这条**目前没有任何自动防线**，而且实测已经查出 J6/J8 两处不通过。
建议把 J1/J3/J5/J8 固化成脚本（读 job + 读三个元素 + 断言文案形态，不需要截图）。
