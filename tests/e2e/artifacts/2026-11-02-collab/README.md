# 2026-11-02 协作刀真机验收（main e0dce3d）

环境：基线 `e0dce3d`（`HEAD = origin`）。按 runbook **不在主树起服务**：独立 worktree `/tmp/b2t-wt-collab`（detached e0dce3d），
`PYTHONPATH=<worktree>/backend`，服务 8871，库 `/tmp/b2t-qa4/lib`，token `qa4`，视口 1423×900（@2x）。

**§0.6 静态判定**：`62868c7..e0dce3d` 的 static 变化 = `app.js -888`、`collab.js +538`（新文件）、
`suggestion-flow.js +392`（新文件）、`export-panel.js ±30`、`index.html +2`、`pages-view.js ±15`。本轮验的就是这棵树。

**本轮产生的持久化副作用（都在 QA 库，未碰其它项目）**

```
b2t_T7JH61：新增分派「QA协作刀 · p9-10」（已作废）、「QA协作刀2 · p11-12」（已发出）
b2t_T7JH61：page 100 被「确认本页版面」+ 跑了一次第二引擎（为了试自动通过；仍未 eligible，出现 divergence）
新项目 b2t_C2MQ9A：由 task.b2tpkg 导入的审校任务包（4 页：10/11/12/13；kind=package）
b2t_C2MQ9A：导出结果包 结果1 / 结果2（各 4 KB）
```

## 结论

| # | 判据 | 结果 | 读数 |
|---|---|---|---|
| **①** | 指派面板：打开 → 预览 → 建分派 → 列表刷新 → 取消分派 | **过** | 打开：meta「第 9–10 页（2 页）」、预览「可派 2 页 ＋ 只读上下文 2 页；约 0.4 MB」、未填名时生成按钮 disabled；填名后可点。建分派：列表 1→2、save「任务包已生成：…」、页 9/10 徽标出现「QA协作刀 · 审校中」；「下载任务包」真实点击 → download 事件 → `path()` 落盘 413,760 B 的合法 zip（package.json/data.json/source/subset.pdf），save「任务包已下载」。取消：列表项变「已作废」、按钮只剩 [下载任务包, 导入结果]、save「任务包已作废」、页 9/10 徽标同步消失；「重新导出」→ save「已重新导出：…p9-10…b2tpkg」、列表不增 |
| **②** | 任务包模式：横幅 · 隐藏 structure-open / finish-open-review · 能导出结果包 | **过**（导出/列表）；**下载另计见 ④** | 导入后：标题「《识别进度测试 · 审校任务（第 11–12）》」、chip「审校任务」可见、横幅「审校任务：第 11、12 页（另附只读上下文第 10、13 页） · 来自 QA · 说明：协作刀导入用」、`package-open` 可见；`structure-open.hidden=true`（父 `#export-panel`）、`finish-open-review.hidden=true`（父 `#view-review`）；页 4 张、2 个「只读上下文」标记。导出结果包：结果1（4 KB）出现；再导出 → 结果2（4 KB），名字不同、无重复条目 |
| **③** | 包文件导入：选 .b2tpkg → 新项目 → 横幅与列表正确 | **过** | `#open-package-file` 选 `task.b2tpkg` → 新项目 `b2t_C2MQ9A`（kind=package，4 页：10、11、12、13）→ 自动切进项目；横幅/chip/页列表/2 个上下文页都对；库列表新增该项目（API 前后对比） |
| **④** | 结果包：导出 → 列表 → **下载落盘** · 重建/再导出不重复 | **未过（下载 404）** | 列表出现正常、再导出不重复（结果1/结果2 两个不同名）；点「下载」→ 请求 **`/api/projects/b2t_C2MQ9A/package/result/<name>`（单数）→ 404**，save 变「下载失败」，无下载事件、无文件 |
| **⑤** | console 0（含 unhandledrejection） | **过** | 9 个探针全部 0 |

### DevLead 加的四条

| # | 判据 | 结果 | 读数 |
|---|---|---|---|
| A | 两个顶层 mask 的关闭路径（Esc / 遮罩空白 / 右上 X），关后无孤儿 mask | **过**（附一条副作用） | `#assign-panel`：三条路径 hidden=true、`.mask:not([hidden])` 都回到 `[]`；**Esc 同时把页面选择清空了**（已选 2 页 → 未选择页面，`#assign-open` 变 disabled）——点遮罩/点 X 不会。`#package-result`：三条路径 hidden=true、masks `[]` |
| B | 坏文件走「任务包 → 导入结果」：面板内报错、列表不增 | **过** | 扩展名不对：`这不是结果包 错误编号 347eb0902f73 结果包的扩展名是 .b2tres`；扩展名对但内容不是 zip：`结果包导入失败 错误编号 4b60fe60dd1c 这不是一个结果包（zip 读不开）`；两次 list 3→3、console 0。副作用：save 状态停在「正在导入结果包…」（未复位） |
| C | 包模式两个外壳 id 显隐、进出两轮 | **过** | normal-1：`structure_open_hidden=false`、`finish_open_review_hidden=false`；package-1：true/true；normal-2：false/false；package-2：true/true |
| D | 取消分派 / 撤销自动通过后列表与页头徽标同步 | **取消分派：过；撤销自动通过：未验** | 取消：列表项「已作废」+ 按钮组变化 + 页 9/10「QA协作刀 · 审校中」徽标消失（refreshPageStates 生效）。自动通过：全库没有 eligible 页（扫描 1–490：只有 page 7 差 layout+margin，其余都带 divergences/suggestions/single_engine/unrecognized），无法在不造数据的前提下走到「已自动通过」再撤销；对 page 100 尝试确认版面+跑第二引擎后，反而多出 `divergence`，仍不 eligible |

## ④ 的根因（代码层）

```
collab.js:441   `/api/projects/${projectId}/package/result/${encodeURIComponent(fileName)}`   ← 单数
backend         GET /projects/{id}/package/results/{name}                                    ← 复数（routes_packages.py:108）
搬进模块前 62868c7 的 app.js:8584 是 `/package/results/…`（复数，正确）⇒ 是本刀搬写时丢了一个 s
实测：点「下载」→ 404，save「下载失败」；结果列表本身由 `/package/results` 正常返回
```

## 其它小问题（不升级为阻断）

```
· `#package-result-meta` 导出成功后停在「导出中…」（成功路径没有复位文案；重开面板才恢复）
· 导入失败后 save 状态停在「正在导入结果包…」（错误写进了面板，但 save 没复位）
· Esc 关分派面板会顺带清空页面多选（shell 与 pages-view 两个 keydown 处理器同一事件内都执行）
· 下载结果包失败时 save 文案是「下载失败」，但 class 只有 `save`（未见错误态样式）
```

## 未验（单列）

- **撤销自动通过 → 徽标同步**：没有 eligible 页；见上表 D 的原因。要验需要先在一页上满足
  `layout_confirmed + margin set + aux checked + 无 divergence/suggestion/ink-gap`（会大量改数据）。
- 分派「导入结果」的成功路径（助手回传 `.b2tres` → 合并审阅）：本轮没有真实助手结果包；
  只验了失败路径（坏扩展名 / 坏 zip）。
- 任务包模式下 pages 面板另外 ~10 个入口、审校面板另外 2 个入口的单独显隐（只验了 Chief 指定的
  `structure-open` / `finish-open-review` 与 `package-open`/banner/chip）。
- 未测导出结果包的内容正确性（只验列出/命名/下载路径）。

## 文件

```
assign-panel.jpg   211,207 B  1423×900 分派面板（3 条分派 + 预览 + 坏包报错）——键帧 1
package-mode.jpg   138,206 B  1423×900 任务包项目（横幅 + chip + 4 页 + 2 个只读上下文）——键帧 2
masks.json           1,133 B  A：两个 mask 三条关闭路径 + 孤儿检查
create2.json         1,921 B  ① 建分派（QA协作刀2/p11-12）+ 任务包下载（fetch 兜底）+ 坏扩展名导入
cancel.json          2,974 B  ① 重新导出 + 作废 + 列表/页头徽标同步
taskdl.json            241 B  ① 「下载任务包」真实点击 → download 事件 → path() → 413,760 B
package.json         5,509 B  ②③④ 导入新项目 + 包模式隐藏位 + 结果包导出两次 + mask 关闭路径
toggle.json          4,679 B  C：普通 ↔ 包 两轮 + 隐藏位恢复 + 结果下载尝试
download-bug.json      457 B  ④ 点下载 → 请求 `/package/result/…`（单数）→ 404、save「下载失败」
badzip.json            320 B  B：坏 zip（.b2tres 扩展名对）→ 面板报错、list 不变
autopass.json          893 B  D：page 100 确认版面 + 第二引擎后仍不 eligible（divergence）
task.b2tpkg        413,760 B  导入用任务包（zip：package.json/data.json/source/subset.pdf）
task-dl.b2tpkg     413,760 B  「下载任务包」真实下载落盘的同一份包
bad.b2tpkg / bad.b2tres       B 用的坏文件
```

## 复现

```bash
cd "/Users/chenlin/DeepSeek Bot/book2text"
git worktree add --detach /tmp/b2t-wt-collab e0dce3d
cd /tmp/b2t-wt-collab && PYTHONPATH="$PWD/backend" "/Users/chenlin/DeepSeek Bot/book2text/.venv/bin/python" -c \
  "from book2text.main import main; raise SystemExit(main(['--port','8871','--no-browser','--library','/tmp/b2t-qa4/lib','--token','qa4']))"

# 探针（ego-browser nodejs，每个都 finish({keep:[]})）
#   /tmp/b2t-probe/collab_assign.mjs   （首轮，含 Esc 清选择的现象）
#   /tmp/b2t-probe/collab_masks.mjs    A 关闭路径
#   /tmp/b2t-probe/collab_cancel.mjs   D 取消 + 重新导出
#   /tmp/b2t-probe/collab_create2.mjs  ① 建分派 + 下载 + 坏包
#   /tmp/b2t-probe/collab_package.mjs  ②③④ 导入 + 包模式 + 结果包
#   /tmp/b2t-probe/collab_toggle.mjs   C 进出两轮
#   /tmp/b2t-probe/collab_dl_bug.mjs   ④ 下载 404 取证
#   /tmp/b2t-probe/collab_badzip.mjs   B 坏 zip
#   /tmp/b2t-probe/collab_autopass.mjs D 自动通过尝试（未达成）
#   /tmp/b2t-probe/collab_taskdl.mjs   ① 任务包下载落盘
```
