# 2026-11-02 审校左树「未归章」组真机复验（main 223932d）

项目：`b2t_T7JH61`（490 页 / 7 章 / 29 页无章节归属，其中 21 页背全部 90 处待审）

## 复现

```bash
cd "/Users/chenlin/DeepSeek Bot/book2text"
git log -1 --format=%h                      # 223932d
PYTHONPATH="$PWD/backend" .venv/bin/python -c "from book2text import paths; print(paths.STATIC_DIR)"
# 必须是本仓库的 backend/book2text/static
(PYTHONPATH="$PWD/backend" .venv/bin/book2text --library /tmp/b2t-qa4/lib --port 8871 --no-browser --token qa4 &)
curl -s "http://127.0.0.1:8871/api/projects/b2t_T7JH61/review/tree?token=qa4" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d['pages']),len(d['chapters']))"
```

浏览器侧：打开项目 → 页面确认 → 页卡「审校」→ 左树。

## 四项结论（截图 + result.json）

1. **默认模式出现第 8 组**：8 个组 = 7 回目 + 末尾「▾ 未归章 90 处」，29 个页行（第 1–29 页）。
   → `01-default-tree.png`
2. **点「未归章」里的第 20 页**：页号 `第 4 页（印 D）` → `第 20 页（印 T）`，块列表文本跟着变
   （页 4「已修改 未审 …」→ 页 20「未审 …」）。→ `02-jump-to-20.png`
3. **点回目行**：不跳页（符合设计）。
   但**展开/收起不生效**：点「未归章」组行后 29 行不变（caret 仍 ▾）；点「第八十一回」后仍 29 行（caret 仍 ▸）。
   代码事实：`renderReviewTree()` 末尾的 `syncReviewTreeToPage()` 会把展开集合强制重设为
   「当前页所在组」；T0 之前它只对**有章节**的页生效（`treeChapterOfPage` 为 null 就跳过），
   T0 之后判断改成 `group.title`，于是「未归章」也参与强制展开 → 当前页落在未归章时，
   任何回目行的展开/收起都会被下一帧复原。（代码对比，未跑旧树。）
4. **只看未完成**：21 个页行，集合与 `unacked>0` 的 21 页**完全一致**（missing/extra 都为空）；
   树顶「90 处待审」= 数据 `sum(unacked)=90`。→ `04-tree-todo.png`

console 红字 0。原始读数：`result.json`。
