# 2026-11-02 片 1（preview overlay）与刀 C（目录确认）真机验证 —— **环境阻塞，部分未验**

## 结论先行

| 项 | 状态 | 证据 |
|---|---|---|
| ① 每页 `.overlay-layer` + `page-overlay--readonly` + zIndex "2" | **已验证（真机）** | 490/490 页；`slice1-new-tree.json` 的 `pages.rows` |
| ④-a hits `zIndex` 3 > layer 2 | **已验证（真机）** | 同上 `layers.hits_z="3"`、`layers.layer_z="2"` |
| console 红字 | **已验证（真机）** | 0 条 |
| ② `.box` pointerEvents === "none" | **未验（ego 服务无响应）** | 见"卡点时间线" |
| ③ 类型色 paragraph/heading/figure | **未验（ego 服务无响应）** | 同上 |
| ④-b/c 甲/乙两组 `elementFromPoint` | **未验（ego 服务无响应）** | 同上 |
| ⑤ 关/开块框：图层不可见 → 恢复、数量不增 | **未验（ego 服务无响应）** | 同上 |
| b 块框清单旧树（f722096）vs 新树逐项对比 | **未验（ego 服务无响应）** | 旧树 worktree 已建好：`/tmp/b2t-wt-slice1` |
| a 序号位置（框外空位 → 框内右上角） | **未验（ego 服务无响应）** | — |
| ⑥ 档位 radio → localStorage 键值 → 刷新保持 | **未验（环境阻塞）** | — |
| ⑦ 切换档位后预览页图 `size=` 跟随 | **未验（环境阻塞）** | — |
| ⑧ 目录确认步页索引仍能加载、无 console 红字 | **未验（环境阻塞）** | — |

片 1 的 ②③④⑤ 之所以能延后：`20264a4..b050063` 对 `preview-view.js / page-tile.js / app.css` 的 diff 为空
（刀 C 只动 `app.js / index.html / page-index.js` + 测试），所以上面那份 `slice1-new-tree.json`
对 `b050063` 同样成立。

## 卡点时间线（ego-browser 无响应）

```
01:08  起探针；另一个 Bot 的会话（space "b2t-knife-c"，pid 54940/54941）占住 ego 服务
01:26  该会话已跑 18 分钟仍未退出；我的 preview 探针（旧树那半）挂住 10+ 分钟 → kill
01:31  起最小诊断：taskSpace → about:blank → 读 title，**不返回**
01:43  又一次最小探针：90s 超时；另一处曾观察到 elementFromPoint 返回 `DIV.mask`（页面被遮罩盖住）
01:45  `ego-browser --ego-server-name=b2t-qa-ovl nodejs` → `Failed to connect to ego_cli bootstrap`
01:52  仍无响应（多次重试 75s/90s/120s 全超时）；我的 ego 探针进程已 kill -9 清干净
```

**没有重启 `ego lite`**（Chief 明确：共享 GUI，重启会关掉所有 Bot 的面板与可能的用户标签页）。

## 已验证部分的原始读数（新树，片 1）

```
preview pages: 490
每页 class: "overlay-layer page-overlay page-overlay--readonly"
page-overlay--readonly: true（490/490）
getComputedStyle(layer).zIndex 集合: {"2"}
getComputedStyle(layer).pointerEvents: "none"（490/490）
.preview-page__hits: zIndex "3"、pointerEvents "none"
console 红字: 0
```

## 恢复后要跑的命令（照这个接着验，不要重跑已验证项）

```bash
cd "/Users/chenlin/DeepSeek Bot/book2text"
git fetch -q origin && git log --oneline -1 origin/main      # 先看新 tip
# ① 先判静态文件有没有被别的刀动过（§0.6 判法）
git diff --stat <上次验的sha> origin/main -- backend/book2text/static/preview-view.js \
  backend/book2text/static/page-tile.js backend/book2text/static/app.css

# 新树
(PYTHONPATH="$PWD/backend" .venv/bin/book2text --library /tmp/b2t-qa4/lib --port 8871 --no-browser --token qa4 &)
# 旧树（片 1 前，f722096）；worktree 已存在则直接用
git worktree add /tmp/b2t-wt-slice1 f722096 2>/dev/null || true
(cd /tmp/b2t-wt-slice1 && PYTHONPATH="$PWD/backend" /Users/chenlin/DeepSeek\ Bot/book2text/.venv/bin/book2text \
  --library /tmp/b2t-qa4/lib --port 8872 --no-browser --token qa4 &)
PYTHONPATH=/tmp/b2t-wt-slice1/backend /Users/chenlin/DeepSeek\ Bot/book2text/.venv/bin/python -c \
  "from book2text import paths; print(paths.STATIC_DIR)"   # 必须打印 worktree 里的 static

# 探针（脚本在 /tmp/b2t-probe/overlay_probe.mjs）
{ echo 'globalThis.OVERRIDE={base:"http://127.0.0.1:8871",project:"b2t_T7JH61",tag:"new"}'; \
  cat /tmp/b2t-probe/overlay_probe.mjs; } | ego-browser nodejs
{ echo 'globalThis.OVERRIDE={base:"http://127.0.0.1:8872",project:"b2t_T7JH61",tag:"old"}'; \
  cat /tmp/b2t-probe/overlay_probe.mjs; } | ego-browser nodejs
```

**进入预览视图没有 UI 入口**（实测：`导出的「生成预览」` 只填导出视图的对照面板，`goToWorkflowStep("preview")`
全仓库 0 个调用点），探针用 `window.PreviewView.enter()` 进入——这条单独记，不是本片的缺陷。

## 文件

- `slice1-new-tree.json` — 已验证部分的全量原始读数（490 页 rows / layers / toggle 的 before 快照 / console）
- `new-preview-boxes.jpg` — 预览视图截图（块框清单为空，因为第 1 页无块；②③⑤ 未验）
