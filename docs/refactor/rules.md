# 通则规则表（下一刀照着跑，不是给人读的手册）

> 维护：Architect。只在**真事故**或**某条闸真的落地**时加/改一行；不凑数、不写没有判据的态度声明；满了先合并同类，合并不了 ⇒ 说明该自动化了，把那条变成脚本。
> **开工第一动作**：过一遍本表；施工卡里必须点名"本刀适用第 N 条"（不适用的不用写）。

| # | 规则（一句话） | 判据（机检命哪个脚本/闸；人工写谁看） | 反例 / 来源 | 状态 |
|---|---|---|---|---|
| 1 | 判据看**代码 0**，不看 grep 0 | 扫描先剥注释（`stripCommentsForGates`）；数字取"剥注释后的命中" | 跨视图刀模块头注释里留着已删的 `setLatestAutoApply`，grep 说还有、代码其实没有 | 已机检 |
| 2 | 自检必须**能区分错误实现** | 每条闸带喂坏样本，且样本难度 = 真实难度（层级/嵌套要对） | `id-host-map` 四条样本只有一层祖先，三层嵌套才咬得住 | 已机检（TestDev） |
| 3 | **视图的 span 不是宿主**；先量子树再定 root，量出 0 就写 0 | `node scripts/id-host-map.mjs <id…>` 的输出直接贴进施工书 | 导出刀 `#view-merge` 0 个、跨视图刀同类、协作刀"7 merge"其实是直接子 id 数 | 已机检（id-host-map） |
| 4 | **按归属判，不按段名/字面判** | 函数名单集合相减 + 归属表；三问：谁共用、生命周期跟谁结束、搬走后还读多少别人的状态 | `openPageSetup`（段内 1 行转发器）、`layoutBlockPageRecord`（段名带"页面确认步"）、页面块缓存簇 | 人工：Architect 判、DevLead 核（切片定稿时判、验收时核） |
| 5 | **一个键不许兼两种语义**（含语义布尔） | kinds 表 + 禁 `scope:`/`op:` 字段；动作名按语义取 | `onTaskProgress` 扩成 onTaskEvent 被否；`refreshPreflight({withPreview})` 拆两个具名动作 | 已机检（`terminalExportProblems`） |
| 6 | **动作返回结果，谁拥有节点谁渲染** | 模块 id ⊆ 归属表；扫"动作函数写别人根子树里的 id" | `setMarginJudgement`→`{ok}`；`applyPackageMode`→`{ok,packageMode}`（写 `structure-open` 会把导出面从 5 顶到 6） | 人工：Architect 判（施工卡定稿时）+ id 归属闸 |
| 7 | 状态归"**谁还在读它**"的域；借用的状态**不许在模块里留副本** | 双写扫描 + 借用测试（模块选块 → 外壳读到；外壳复位 → 模块读 null） | S1 三搬五借；刀 C 页面块缓存簇留在壳（B 方案被否） | 已机检（S1 闸） |
| 8 | **一处调度**：同一容器一个调度、重试循环全仓一份 | `attempt < 90` 只许出现在 overlay-registry.js；连调三次只回调一次 | 片 2 前：tile 每画一页都经共享调度器重画审校差异层 | 已机检（片 2 闸） |
| 9 | 版本 = **内容指纹**（输入=即将绘制的那份数据），禁人工 bump | 无 `bumpVersion` 导出；同内容两次版本不变、改一个字段版本必变 | §23.4b；片 1 酸测试①原写法自己跟自己比，恒真 | 已机检 |
| 10 | 重画**不重建节点**（幂等看节点身份） | 酸测试：同数据两次 paint，`firstChild` 是同一个节点 | 片 1；clear+append 是撕裂来源（`renderPageBlocks` 原第一句 `innerHTML=""`） | 已机检 |
| 11 | 判据**描述事实，不追着事实改** | 闸代码不动、数据变，结论跟着翻面 | 死期表：T 归零后空表合法，`EXPORT_DEATH_EXPIRES` 当场删掉 | 已机检 |
| 12 | 写盘动作**内部闭环**，外壳不编排出图顺序 | 静态：动作函数体内 `await apiJson` 之后至少一次写 DOM/状态；壳里不许"调 A 再调 B 重画" | 9.3 把调用挂在无关请求之后；`refreshExportPreflight(); loadExports();` → `reloadPanel()` | 已机检（第二批闸②） |
| 13 | **账按 diff 记，不按清单记** | 提交说明里"删了 N 个"要能对上 `git show --stat` | `3e00037` 说明写 10 个、diff 只删 9 个（实际 10 个分两笔）；协作刀报 −419 用书里"426"解释，实际是删 475 / 加 56 | 人工：验收人核（每次验收时对着 `git show --numstat` 核数字） |
| 14 | **基线不写死**：基线 = 开工树 sha + 现数两数 | 提交说明必须带 sha 与行数/函数数；不准抄书里的数 | 505 / 173 / 186 三组数各白跑一轮 | 人工：DevLead 核（开工前 + 验收时各一次：sha / 行数 / 函数数都从代码取） |
| 15 | deps 只按**PagesView 块**数，别拿总数减 | 脚本数该块的 `key:` 行；别的视图块单列 | `173 − 8 = 165`（8 个里只有 2 个在 173 里，应 171） | 已机检 |
| 16 | **死注入 / 死状态 / 0 引用函数 = 红** | `deadPagesDepProblems` · `zeroRefFunctionProblems` · 只写不读状态扫 | 刀 11 前 deps 22 死键；`latestAutoApply` 只写不读 | 已机检 |
| 17 | 服务模块 **DOM 面 = 0**；root/白名单**三处同批** | `domainDomProblems`（el( / getElementById / querySelector 各 0）+ `ALLOW_QUERY_SELECTOR_WHITELIST` 双向对集 | 刀 A 起；白名单：structure-tools · page-detail-editor · export-panel | 已机检 |
| 18 | 模块**不许直呼别的模块**（`window.X`） | `godDoorProblems`（裸调外壳函数 / 未注入键 / `window.<模块>`） | 片 2 registry 若直呼 PageDetailEditor 就成第二个画家（`buildBoxLabel` 改注入纯构建器） | 已机检 |
| 19 | 新模块"落文件 + 登记"走 **A1 按范围开口子** | 新增 `static/*.js` 且含 `window.X = api` ⇒ 同笔只许改三张登记表的新增行 | 五条路都撞红；`1cf44d0` 实现 | 已机检 |
| 20 | **尺度相关判据不许跨尺寸比 px** | 统一宽度（680px）后比"相对 box 的偏移"；读不到宽度就降级为落位分类（五类） | 片 2 §6.1 原写法必假红：位号是尺度的函数（窄了退回框内） | 人工：QA + DevLead（真机验收时，跨尺寸比对先统一宽度） |
| 21 | 装饰白名单窄到**一个类名 + 一个宿主** | 除 registry 外对 `.box` 的 classList 写入只许 `is-linked`；toggle 后 version 与 firstChild 不变 | reading hover 联动；放宽就等于第二个画家 | 已机检（片 2 闸⑨） |
| 22 | 叙述与表冲突**以表为准，同笔改** | 每处带数字的断言都要与实测表同口径，或标明口径名 | "表改了、叙述没改"（§0 理由段、§1.3 首行各漏一次） | 人工：作者自查（提交前把正文里每个数字对着表看一遍） |
| 23 | **空操作 / 分母为 0 = 假绿**（同一族，两种形态）： ① 测试台架的空实现当"点了"； ② 重算前后对比先看结果不看分母——**"没跑"≠"没变化"** | ① 每个"点按钮"的测试要能指出它走到了哪个函数；台架变更后重报"哪些测试原本是空转的"。 ② 报告必须同时给**两个数**：**分母**（这一轮实际处理了多少对象：`updated`/`processed` + `skipped` 的原因分布）与**结果**（diff / sha）；**分母为 0 的对比不构成证据**——要证明"改动无影响"，分母必须非 0 且结果相同 | ① 协作刀 `collab.test.mjs` 的 `click()` 是空的 ⇒ 下载按钮从未被点过，10 条行为测试全绿。 ② 2026-11-05 双栏取界：清框时 `margin_box_mode='none'` ⇒ `fit_all_pages` 把每页当"用户显式不要框"跳过 ⇒ `updated 0 / skipped_none 40`，导出与 A **逐字节相同**（`008b9bab…`），差点读成"改动无影响"；改 `mode='auto'` 才 `updated 40 / fitted 36 / fallback 4` | 人工：TestDev 判（台架变更时）/ 实验人自查 + 复核人核分母（证据见 `docs/development-log.md` 双栏取界「实验口径」） |
| 24 | **搬写时 URL 路径是隐形接口**：每个 `fetch` / `apiJson` 的路径段必须有断言 | **能机检**：`scripts/route-contract.mjs` 把前端调用点与后端 `@router` 路由对集（方法+路径；`${}`/`{}`→`*`；剥 query；**按括号配对取实参**，缺省 GET）⇒ 对不上红；喂坏样本 `/package/results`→`/result` 必红。原型已验（2026-11-03）：后端 135 路由 / 前端 135 调用 / 0 跳过 / 0 不匹配。非字面量 URL 必须计数上报（否则规则静默缩水）；不验请求体、不判「后端有、前端不用」 | 协作刀把 `/package/results` 写成单数 ⇒ 点下载 404，10 条行为测试唯一没覆盖的正好是它。我第一次用固定 300 字符窗口取 `method:`，把下一个调用的 POST 误算进来、报了一条假红 ⇒ 必须按括号配对取实参 | 已机检（`scripts/route-contract.mjs` + `tests/js/route-contract.test.mjs`，`c558a07`；实测后端 135 路由 / apiJson 154 调用点 / fetch 8 调用点 / 唯一组合 106 / 0 不匹配） |
| 25 | **跨模块转发名必须真实存在**：`window.<模块>?.<键>` 的键必须在该模块的 `api` 里 | 已机检（`tests/js/module-wiring.test.mjs` 闸 A）：在沙箱里**执行**模块取 `Object.keys`，不许正则抠文本；剥注释；喂坏必红 | 抽屉刀 `app.js:8556` 调 `setEditorPackageModeChrome`（真实导出名 `setPackageModeChrome`）、`8557` 调 `showPageDetailError`（当时未导出）——`?.` 让它静默变 no-op，被 catch 吞掉 | 已机检（`f22d3a9`） |
| 26 | **模块能力必须在 `init` 之后调**：boot 里 `X.init(` 早于对 `X` 的其它调用 | 已机检（闸 B）：取 boot 函数体内首次出现行号比大小；含 `=>` 的行是"以后才调"，不算顺序 | 抽屉刀把 `PageDetailDrawer.setupReviewPager()` 放在 `init` 之前（8202 vs 8470）⇒ `part()` 拿到 null root ⇒ boot 崩、首屏项目库 0 卡、应用不可用 | 已机检（`f22d3a9`） |
| 27 | **动 boot / 初始化顺序 / `window.X?.Y` 的改动，提交前必须真机自验** | 人工：提交正文贴自验记录（服务怎么起、走哪几步、`pageerror` 几条）；静态闸不会 boot 应用 | 抽屉刀四闸全绿但打开即白屏；Builder 热修后补做真机自验（首屏 1 卡 → 开项目 → 进审校 → 切块框 → 关抽屉，pageerror 全程 0） | 人工：作者自查（此类改动必做）+ DevLead 验收时核 |
| 28 | **「落在子树里」≠「能在子树里查到自己」**：`querySelector` 只搜后代，根元素自己不在自己子树里 | 已机检（`dom-root-scope` 显式分支）：`part(id)`／`reviewPart(id)` 的 id **等于根自身 id** ⇒ 红，并提示用 `root.hidden` 这类属性判断 | 片 1a 把 `reviewPart("page-number-review-panel")` 当后代查（其实它就是根）⇒ null.hidden 抛错 ⇒ 错误条 + 跳过 `onPageNumberChanged` ⇒ 侧栏停在写入前（server 55 / 面板 55 / 侧栏 60） | 待提交（TestDev 工作区，等热修进主线） |
| 29 | **闸只证"前者"时，后者就是盲区**：判据的语义边界要写成反例 | 每条闸至少给一条"看起来像、但不该过"的样本；修前修后各跑一次 | 跨根闸第一版把根算进子树 ⇒ 对"根自己"判绿；真实路径断了而闸全绿 | 人工：TestDev 自查（每条闸配一条语义边界样本） |
| 30 | **rebase 前后必须对账**：动 `--onto` 这类会丢笔的命令之前先打 `backup/<名字>` ref，之后用 `git log --oneline origin/main..HEAD` 数笔数与 rebase 前对齐 | 人工：作者自查（rebase 后贴两边笔数）；丢了用 `git cherry-pick` 找回并说明"找回"而非"新做" | 片 2 期间 `rebase --onto origin/main a311365` 把 a311365 之前的片 1b 两笔一起丢掉，靠 cherry-pick 找回；下次丢的可能是没有备份的产品笔 | 人工：作者自查（rebase 后）+ DevLead 验收时核 |
| 31 | **历史类闸必须在提交之后跑**：A1 / A3 / A1b / R12 扫的是提交历史，未提交的改动不在里面 | 人工：作者自查（提交后重跑 node 全量，贴的是提交后的数） | 551a366 把"产品改动 + tests/js"放同一笔（不是新模块引入）⇒ 推送时 R12 红；作者报的 317/0/0 是**提交前**跑的，那时这笔还不在历史里 | 人工：作者自查（提交后重跑）+ 提交正文写"哪一次跑是提交后" |
| 32 | **能 fast-forward 就别 cherry-pick**：分支若从 main 直系长出来，集成用 `git merge --ff-only <分支>`，保住全部 sha | 集成前先 `git merge-base --is-ancestor <main> <分支>`；是则 ff，否则才 cherry-pick | cherry-pick 会换 sha ⇒ §18.6 登记行当场过期 ⇒ 再签一轮（今天发生两次：`32917c0`、`a0bba4a`）；用 ff 集成 `ae7b756` 时登记一次生效 | 人工：Chief 集成时判 + 登记人核 sha |
| 33 | **验之前先确认验的是哪个对象**，两种形态： ① 哪棵树（import 路径）；② 测量者是否混进被测集合 | ① 口令（起服务 / 跑测试前各一次）：`PYTHONPATH=<worktree>/backend .venv/bin/python -c "import book2text; print(book2text.__file__)"`；输出不在该 worktree 下 ⇒ 这一步所有读数作废，先修环境再验。 ② 进程级判定**一律 `pgrep -x <进程名>`**（精确匹配进程名），或按 pid / 端口反查；**不许 `pgrep -f <名字>`、不许 `ps\|grep` 自己拼**——命令行里带这个串的任何包装行都会被算进去 | ① Chief 在 `worktrees/builder` 起服务未设 PYTHONPATH：worktree 的 `.venv` 是软链、editable 的 `.pth` 写死主仓库 `/backend` ⇒ 加载 main 的代码，读到旧 CSS（`.42`/`.34`），差点误报"Builder 的边框修复没生效"。**反例（#29）：cwd 在 worktree、`git log` 是分支 sha、只有 `__file__` 指向主仓库——三条证据两条对、一条错**。 ② 2026-11-05 实测两次：`pgrep -f llama-server` 命中 Builder 测量脚本自己的 `bash -c '… llama-server …'` 包装行（真引擎 0 个）⇒ **假红**；反向也成立（包装行退了、引擎还在但命令行不带这个串 ⇒ **假绿**）。Chief 前几轮用 `-f` 量的"收尸 0 残留"同样不干净 | 人工：**验的人**自查（两种形态各一次；写代码那位复现不出来——它只影响验的人） |
