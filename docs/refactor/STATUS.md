# 重构状态板（人工半）

> **这张表只写“意图和阻塞”，不写会漂的数。**
> 行数、SHA、ahead/behind、导出个数、id 引用数——一律用 `scripts/status.sh` 现算，**不抄进这张表**。
> 理由：今晚出现过“三份文档三个数”和“三个 SHA 三个说法”，而**代码是唯一事实**；手工副本早晚要漂。
>
> 规则：每行 40 字以内；**只有当这一行的事实变了才改它**；改完跟下一次提交一起走。
> 时间：2026-10-29（17:30 更新）

| 线 | 状态 | 在等谁 | 下一件 |
|---|---|---|---|
| `reading`/`index`/`preview`/`library`/`merge` | **5/7 已拆，各有验收脚本且 exit 0** | — | 不再动，除非变红 |
| 回放基 tag（`ring-break-base`） | 仍指 `afe20fe`，**不是回放基**；merge 已落 = 可重切 | Architect | 重打 tag + 删 `--allow-transitional-base` + 更新 `replay-base-modules.txt`，三件同批 |
| `page-tile.js` | 模块已写 + 单测，**尚未接入**（`index.html` 无 script） | Builder | 先接一个消费者，再接第二个 |
| `step-timing.js` | 模块已写 + 单测，**尚未接入** | Builder | **接线优先于 UX 改动**——没有它就没有基线 |
| `review` 正文审校 | 切片未开；`docs/ux/review-screen-ux-v3.md` 设计稿已出（三改一推荐） | DevLead | **先实现 UX V3（行为改动），暂不搬代码**——搬了会被重写 |
| `pages` | 归属调查完成（能搬 101 函数 / 2,338 行；接缝 66 函数 / 183 边） | `page-tile` 接线 + 试用数据 | 定 1 个还是 5 个模块 |
| `merge` 页面级验证 | 文件级验收过，**页面级未做** | QA / Builder | 用真项目进「合并审校」走一遍 |
| 闸体系 | 提交（验索引 6s）· 推送（node 15–19s + pytest 82–85s）· 绕过记账 | — | 账本 1 条 `BYPASS` 是 `tmp-mut-a` 变异实验，非真绕过 |
| CI node 闸 | 已配置、**未验证**（Actions 起不来，Billing） | 用户（Billing） | 推一个含违规提交的分支，CI 必须报错；**验证前不许说「CI 挡住了」** |

## 不在这张表里的

- **谁此刻在做什么**（会变，看群和对话，不需要板）；
- **门禁的规则细节**（在 `reading-view-boundary.md` §20.9，一处正文）；
- **导出面、依赖集合、行数**（`scripts/status.sh` 现算，或各自权威源）。
