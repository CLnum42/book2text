# `pages` 落盘与回滚（LANDING.md）

> 落盘 + 实机验收是**两件事**，中间有一个窗口。今天所有「半落盘」事故都出在这个窗口没人管。
> 这份文件就干一件事：**让回到绿变成 30 秒的机械动作，并且写清回滚后要通知谁。**

## 一、落盘（一条命令）

```bash
sh scripts/land_pages.sh          # 生成 → 语法 → 闸 → 验收，六步都有门
```

脚本**不替你提交**。它最后会打印「下一步」：三张登记表、`move(pages):`、以及
**`Approved-by` 找 Architect**（这一笔由 DevLead 自己执行，所以不能自己签）。

## 二、回滚（30 秒，随时可做）

```bash
git checkout -- backend/book2text/static/app.js backend/book2text/static/index.html
rm -f backend/book2text/static/page-pages.js
node tests/js/run.mjs        # 必须 127 pass / 0 fail
```

判据只有一条：**`node tests/js/run.mjs` 回到 `fail 0`**。
回不去就说明回滚不完整——先 `git status --porcelain` 看清还有哪个文件被改过。

> 为什么这三步够：`pages` 落盘只动三个产品文件（`app.js` / `index.html` / 新建的 `page-pages.js`），
> 三张登记表在 `tests/js/boundary.test.mjs`，但它们不影响运行时——**要回到绿，只需把产品三件复原**。

## 三、回滚后必须通知谁

| 对象 | 说什么 | 在哪说 |
|---|---|---|
| **Builder** | 「pages 已回滚，`page-pages.js` 不存在，**停 acid 实机测量**」 | 开发协调群 |
| **TestDev** | 「pages 已回滚，夹具/闸的改动先别按落盘后的形态调整」 | 开发协调群 |
| **Chief** | 一句话 + 回滚后 `node` 闸的 pass/fail 数 | 开发协调群（带数字） |

**回滚不是失败，是回到上一个可推状态**；但**必须有人知道**，否则下一个人会按"已落盘"继续干活。

## 四、落盘的三个前置（缺一不可）

1. **`index.html` 有 `<script src="/static/page-pages.js">` 且在 `app.js` 之前** —— `R7b` 会拦（2026-10-29 补的闸）；
2. **三张登记表同批**：`OWNERS`（搬进模块的 10 个状态改 owner）/ `VIEW_EXPORTS`（`init,enter`）/ `VIEW_STATE_PREFIXES`；
3. **`Approved-by` 是别人**（Architect）：`move:` 笔的签名不许自己签自己。

## 五、落盘后仍未验的两项（第三消费者）

```
同页同档 <img>.src 赋值次数 = 1     （不许变回 2）
IntersectionObserver 构造数 ≤ 6     （不许回到 11）
```

**只有实机能给**，由 Builder 跑；通过 `python3 scripts/accept_pages.py --acid <json>` 作为第 ⑤ 条喂进来。
**没给数就是「未验」——报告里不许写「已达标」。**

如果这两项不达标：**先回滚，再查 `pages` 有没有走 `PageTile`**（如果走了 `if (window.PageTile)` 的降级分支，取图会回到 2）。
