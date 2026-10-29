# preview-p2 证据（任务 94 · Slice P2：预览视图整段迁入）

三个脚本 + 一份记录。**只读**仓库与 git 历史，不写产品代码、不碰 `tests/`。

| 文件 | 验证什么 | 怎么跑 |
|---|---|---|
| `rules.py` | 迁移的替换口径：26 个标识符 + `currentView` + 4 个写点整句 + 2 个跨子树 DOM 句柄；另含**模板感知**的去注释器（保留 `${…}` 表达式，补 R1 的模板盲区） | 被下面两个脚本 import，不单独跑 |
| `verify.py` | **逐字节**：43/43 函数「正变换后与基线逐字节相同 + 逆变换逐字节还原」、27 个状态声明行原样、每个函数只定义一次、模板感知的 R1 镜像、R3 id 归属、`window` 接口对象个数 | `python3 docs/refactor/evidence/preview-p2/verify.py` |
| `runtime.mjs` | **运行时等价 9/9**：旧（基线里的内联实现）vs 新（`preview-view.js` + `init` 注入），同一假 DOM、同一批 stub，比「调用序列 + 命名节点快照」 | `node docs/refactor/evidence/preview-p2/runtime.mjs` |

**基线（原像）默认 `7125dd5`** —— P1 之前最后一版，43 个函数还全在 `app.js` 里；
P1 之后 `HEAD` 少了 6 个联动函数，不能当原像。换基线用 `B2T_BASELINE=<sha>`。
两个脚本都用 `git show <sha>:backend/book2text/static/app.js` 取原像，**不读工作区里被改过的文件**。

退出码：`0` = 全部通过；`1` = 有失败（打印首个差异）。
依赖：python3（仅标准库）+ node（仅内置模块）。`runtime.mjs` 只读复用 `tests/js/load-app.mjs`，
不复制、不改测试——旧侧与 `tests/js` 是同一套 vm 加载口径。

复跑：

```bash
python3 docs/refactor/evidence/preview-p2/verify.py
node docs/refactor/evidence/preview-p2/runtime.mjs
```

两份输出原样贴在 [`NOTES.md`](NOTES.md) 末尾。
