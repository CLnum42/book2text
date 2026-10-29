# PageTile 酸测试基线（2026-10-29，模块落盘前）

> 目的：给"只发一次图请求"提供对照数。**没有基线，这个断言没有对象。**
> 环境：1423×900 / dpr 2，项目 `b2t_ZAQHGH`，页 **48**，真浏览器（CDP）+ 页面内插桩（`IntersectionObserver` 构造/observe、`HTMLImageElement.prototype.decode` 与 `src` setter 计数）。
> `page-tile.js` **不存在**（`ls static/` 只有 app.css / app.js / index-view.js / index.html / preview-view.js / reading-view.js）。

## 1. 同一页在两个视图里各要一份（今天）

| 步骤 | 页 48 的网络请求 | 档位 |
|---|---:|---|
| ① index 翻到第 48 页 | 1 | `view` |
| ② 切到 preview 翻到第 48 页 | **累计 2（+1）** | `view` |
| ③ 切回 index 第 48 页 | 累计 2（+0，命中 HTTP 缓存 `max-age=300`） | — |
| ④ 再切 preview 第 48 页 | 累计 2（+0，同上） | — |

**基线：同一页、同一档位 `size=view` 被请求 2 次（index 一次、preview 一次）。**

注意：③④ 的 0 是 **HTTP 缓存**造成的，不是模块共享——所以酸测试的"一次"若用网络请求数做判据，**今天就会误判成已经通过**。

## 2. 页面内实际发生的取图/解码

| 视图 | `img.src` 被赋值次数（页 48） | `decode()` 次数 | 同时持有的 `<img>` |
|---|---|---|---:|
| index | thumb **2** / view **1** | view 1 | 0（离开视图后释放） |
| preview | thumb 2 / view **2** | view 1 | 1 |

- index 的页图缓存：`index-view.js:69 let indexLoadedImages = new Set()`；
- reading：`reading-view.js:123 let readingLoadedImages = new Set()`；
- preview：**没有 LoadedImages 集合**，只持有当前一张；
- 三个模块各有一份指标对象：`window.__b2tIndexMetrics` / `__b2tPreviewMetrics` / `__b2tReadingMetrics`。

## 3. IntersectionObserver（今天）

```
构造 7 次 / observe 调用 6,624 次（同一会话内，含 index + preview 两个视图）
```

三个模块各自建观察器，没有共享层——这是 D-109"40 个注入点"的实证之一。

## 4. 酸测试该怎么判（给落盘后重跑用）

网络请求数会被 HTTP 缓存掩盖，所以判据取**页面内**三个数：

1. **接收者数**：同一页同时被两个模块持有时，`<img>` 元素数（今天：index 0 / preview 1，**没有同时持有**的路径）；
2. **取图次数**：`img.src` 赋值次数中 `size=view` 的次数（今天：index 1 + preview 1 = **2**）；
3. **失效传播**：一处 `invalidate(pageNo)` 后，两个消费者的 `img.src` 各变化一次、**且这一页只新增 1 次取图**。

脚手架：`scripts/acid_pagetile.py`（模块不存在时 **exit 2 红**，不空跑成绿）。
