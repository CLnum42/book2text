# LibraryView.notify：提示跨视图存活 — 2026-10-29

被测：`ed66c3d`（origin/main，library 模块未落盘）
命令：`qa.py library_notice`（正向）/ `qa.py library_notice --selftest`（负向自检）
探针：`driver.mjs: libraryNoticeProbe`

## 为什么这条必须 e2e

`LibraryView.enter()` 里写一句 `innerHTML = ""` 是**完全合法的写操作**：

- 静态门（`node --check` / 导出计数 / R1）不红
- `?checktext=1` 自检不红
- 控制台不报错

用户看到的是"提示不见了"，而所有检查都是绿的。这正是今晚反复栽的那一类。

## 判据（锁文案，不锁 hidden）

- **A 跨视图存活**：在「页面确认」造 error 提示 → 切「目录确认」→ 文案**一字不差**还在
- **B 自己的操作能覆盖**：在目录页造 warning → `loadLibrary()`（刷新项目库）→ 提示被收掉

只断言 `hidden === false` 会漏掉"文案被换成空字符串"——那是同一种"东西不见了"。

## 现在的结果（4/4 通过）

```
PASS [A] 在「页面确认」视图下提示已写入
     via=['showError(library-error)']；文案='QA 跨视图提示 1793240382781'；hidden=False
PASS [A] 切到「目录确认」后文案一字不差
     视图=['view-pages'] → ['view-index']；文案='QA 跨视图提示 1793240382781'
PASS [B] 在目录页写下 warning 提示
     文案='QA 覆盖提示 1793240382781'；hidden=False
PASS [B] 刷新项目库后提示被收掉
     load={'ok': True}；之后 hidden=True
```

## 负向自检（证明探针能红）

`--selftest` 在切视图之后手动清空 `#library-error` 的文案，模拟"`enter()` 里加了一句清空"：

```
PASS [负向自检] 清空文案后「文案一字不差」必须报 FAIL
     清空前='QA 跨视图提示 1793240377576'，清空后=''
```

没有这一步，4/4 只证明"今天没人清"，不证明"明天有人清时能抓到"。

## 模块落盘后会自动切到真接口

探针写入时按优先级选：`LibraryView.notify(kind, text)` 存在就用它，否则 fallback
`showError(el("library-error"), new Error(text))`。今天走的是 fallback（`via` 字段会写出来），
模块落盘后 `via` 变成 `LibraryView.notify`，断言不变。

**这也是这条探针的回归闸**：谁在 `enter()` 里加清空，A 当场红。

## 文件

- `report-normal.json`：正向 4/4
- `report-selftest.json`：负向自检（A2 必须 FAIL）
