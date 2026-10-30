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
