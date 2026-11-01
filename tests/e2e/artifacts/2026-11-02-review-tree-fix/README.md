# 2026-11-02 审校左树 T0 回归修复复验（main f034c1a）

**修的什么**：T0 把「未归章」做成 id=null 的组之后，`syncReviewTreeToPage()` 用 `group.title`
判断，导致「当前页在未归章」时每次 render 都把展开集合强制清成 `{null}`，用户点回目行立刻被抹掉。
`f034c1a` 改成 `group && group.id !== null …`，未归章不再参与「当前页所在组的自动展开」。

项目：`b2t_T7JH61`（490 页 / 7 章 / 29 页无章节归属，其中 21 页背全部 90 处待审）。
页面状态：进入时第 4 页（未归章），第 400 页属于「第八十三回」。

## 复现（含明确的等待条件，别用固定 sleep 读树）

```bash
cd "/Users/chenlin/DeepSeek Bot/book2text"
git fetch -q origin && git log --oneline -1 origin/main        # f034c1a
PYTHONPATH="$PWD/backend" .venv/bin/python -c "from book2text import paths; print(paths.STATIC_DIR)"
# 必须打印本仓库的 backend/book2text/static
(PYTHONPATH="$PWD/backend" .venv/bin/book2text --library /tmp/b2t-qa4/lib --port 8871 --no-browser --token qa4 &)

# 树的数据基线（应与界面数字对得上）
curl -s "http://127.0.0.1:8871/api/projects/b2t_T7JH61/review/tree?token=qa4" | python3 -c "
import json,sys; d=json.load(sys.stdin)
print('chapters', len(d['chapters']), 'pages', len(d['pages']),
      'nochap', sum(1 for p in d['pages'] if not p.get('chapter')),
      'pend', sum(1 for p in d['pages'] if (p.get('unacked') or 0)>0),
      'unacked', sum(p.get('unacked') or 0 for p in d['pages']))"
# 期望：chapters 7  pages 490  nochap 29  pend 21  unacked 90
```

浏览器侧进入：打开项目 → 页面确认 → 第 4 页页卡「审校」→ 左树。
**等待条件**：`await page.waitForFunction(() => document.querySelectorAll("#review-tree-list > li").length > 0)`
然后**再等两帧/2 秒**确认子节点数稳定（树是异步拉的，读早了会拿到 0 行，本目录第一次跑就踩了这个）。

## 判据与实测（f034c1a）

| # | 操作 | 期望 | 实测 |
|---|---|---|---|
| 默认 | 进树 | 8 个组头、0 个页行、「▸ 未归章 90 处」 | `pageRows 0`、`▸ 未归章 90 处`（组头 8 个）✓ |
| ①a | 当前页在第 4 页（未归章）→ 点「第八十一回」 | 该章展开**它实际页数**、下一帧不被复原 | `0 → 1` 行，caret `▾`；+2s 仍 `1` 行 ✓（该章只有 1 页） |
| ①b | 点「未归章」组头 | 展开 29 行 | `1 → 29` 行（+2s 仍 29）✓ |
| ①b | 再点「未归章」组头 | 收起到 0 行、不被复原 | `29 → 0` 行（+2s 仍 0）✓ |
| ② | 点「未归章」里的「第 20 页」 | 跳页 + 块列表跟着变 | `第 4 页（印 D）` → `第 20 页（印 T）`；块列表从「…已修改 未审…」变「…未审…」✓ |
| ③ | 点「只看未完成」 | 21 行；集合 == `unacked>0` 的 21 页；树顶 90 == sum(unacked) | 21 行；`rows 21 / api 21 / missing [] / extra []`；`stats 90 处待审` = `unacked 90` ✓ |

console 红字：0。

## 一条**既有行为**（不是本次回归，别混进缺陷）

当前页落在某个**有章节**的组里时，`syncReviewTreeToPage()` 仍会强制保持该组展开——
所以「收起当前页所在的那一章」不生效。实测：跳到第 400 页（属「第八十三回」，406 页），
点「第八十三回」组头 → 页行数 `406 → 406`（收不起来），caret 仍 `▾`。

这条在 T0 之前就有（旧实现用 `treeChapterOfPage()`，有章节的页同样会被强制展开），
只有「未归章」这一类在本笔之后恢复成可自由展开/收起。

## 文件

- `result.json` — 全部原始读数（每步 before/after 的 pageRows、caret、组头、页号、块列表片段、API 基线、console）
- `01-default-collapsed.jpg` — 默认折叠态（8 组头、0 页行、「▸ 未归章 90 处」）
- `03-orphan-expanded-29.jpg` — 点开「未归章」后的 29 行
