# 数字原生 PDF 的前置页建议（任务 80）

> 2026-10-28。《安乐哲 译本处理》662 页副本。真书库没动数据（只读跑建议）。

## 问题：662 页全被判成 body

建议逻辑**本身在跑**，只是对这本书只命中 5 条（第 1 页 front、第 6 页 toc、37 back、两页空白），
而前置页（封面 / 版权 / 编目 / 序 / 目录，共 1–37 页）大部分**没有任何信号**：

| 页 | 实际内容 | 为什么没建议 |
|---:|---|---|
| 1 | `title: author: publisher: isbn10…` | 命中"第 1 页 → 前置" ✅ |
| 2 | 书名页 | 无关键词 |
| 3 | `Published by … All rights reserved` | 关键词表里没有这些英文词 |
| 4 | `Library of Congress Cataloging-in-Publication Data` | 只认 `cip` 这个缩写，长写不认 |
| 5 | 空白 | 墨迹 0.11% → body_excluded ✅ |
| 6 | `Contents` | 命中"contents" ✅ |
| 7–37 | 序 / 目录续 / 前言（页眉 `Page viii` 等罗马数字） | **无任何规则** |
| 37 | 引用体例说明（正文里出现 "Sinological Index Series"） | 被 `index` 关键词**误判成 back** |

## 改了三处

1. **补英文前置关键词**：`library of congress` / `cataloging-in-publication` /
   `all rights reserved` / `copyright` / `published by` / `printed in`。
2. **结构规则：正文从"第一个印阿拉伯页码的页"开始**。之前都是前置。
   - 页眉页码从**前 4 个块**里找（这本书第 38 页第一个块是章号 `1`，`Page 1` 在后面一个块里，
     只看第一个块会漏）；
   - 只对**有文字层**的页用（扫描件常常没有页眉页码，否则会全判成前置）；
   - 标 `medium` 置信度，理由写「在第一个印刷页码（阿拉伯数字）之前 —— 前置页」。
3. **英文 `index` / `appendix` / `references` 只在"首行就是标题"时才算**
   （第 37 页正文里出现 "Sinological Index Series" 就被误判成索引页）。

## 结果（这本书）

原分布：`body 662`。跑完建议：

| 类型 | 页数 |
|---|---:|
| `front` | **34**（1–4、7–37） |
| `toc` | **1**（第 6 页） |
| `body_excluded` | **2**（第 5、29 页空白） |
| `back` | 0 |
| `body` | **625** |

共 **37 条建议**，都是 `medium`/`high`，用户一次批量确认即可。

## 应用之后导出会变成什么（在副本上模拟，没动用户库）

| | 应用前 | 应用后 |
|---|---:|---:|
| 段数 | 4827 | **4570** |
| 正文字符 | 758,207 | **718,917**（−39,290） |
| 首段 | `title: author: publisher: isbn10 \| asin: …` | **`Philosophy of History`**（第一章标题） |
| 含 `lcc::pp` / `All rights reserved` / `Library of Congress` | 有 | **全无** |

## 顺带修的一条：整块就是页码的块

第 38 页的 `Page 1` 是**独立块**、但不是该页第一个块，靠"首块首行"规则漏掉了，
应用前置页之后它变成了导出第一段的第二行。

现在：**任何位置上、整块只有一行页码的块**都直接丢掉（目录页那种
`Page viii 153 155…` 不是整行匹配，不会误删）。应用建议后导出里 **`Page N` 段数 = 0**。

## 测试

`pytest -q` → **981 passed**（页面建议相关 25 条全过）。
