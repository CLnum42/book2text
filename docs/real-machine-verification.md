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

三个参数的理由：

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

> **待脚本化（到期点：刀 9 开工前）**：第 3 步将来做成 `scripts/verify_isolation.sh`（`curl | grep -c`，计数 0 就非 0 退出）。归 DevLead / Builder 定；到期没做就删掉这句，不留陈账。

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
- [ ] `git status --porcelain`：**只剩 `?? .venv`**（你的改动应已提交）；还有未提交改动就在报告里点名，别让它混进下一轮验收
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
| 界面上什么都不出现，但闸全绿 | 状态指向了**不可见的元素**——引用的节点还在，但被隐藏、或已不在当前 DOM 里 | 先打印状态指向的 id / 元素，查它的 `hidden` 与父链可见性。闸绿只证明逻辑走到了，**不证明人看得见** |

## 4. 报告模板

```text
真机验收 <任务>：<结论>
- 树：worktrees/<你的>（分支 wt/<你的>，HEAD <sha>）
- 服务：实际端口 <port>，库 /tmp/b2t-<task>-lib
- 隔离自检：/static/<file>.js 含 <符号> × <计数>
- 失败注入：<端点> 计数 0→<n>
- 收尾：服务已停 / tmp 库已删 / ego-browser 已 finish / git status 只剩 ?? .venv
```
