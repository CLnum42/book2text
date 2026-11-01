# 三种假绿：判据失效的三种形态

> 来源：TestDev 整理，2026-11-01 实测；每条命令都能直接复制运行。
> 实测树 `223b529`（在 `76bad9e` 上重跑，输出一致）。**行号与数字随版本漂，机制不变**——按命令重跑，别按数字对。
> 三条都不是产品 bug，是**判据自己失去了分辨力**。

## 0. 一句话

**绿只说明"判据没红"，不说明"被判的东西是对的"。** 三种失效形态：恒真、空转、错位。

## 1. 恒真：`or` 里有一支是另一支的子串

**现象**：断言写成 `"A" in s or "B" in s`，而其中一支本身就是**另一支所指文本的子串**。

分支 `PageBlockVersions().get(key)` 是现行代码 `getPageBlockVersions().get(key)` 的**后缀子串**——所以 `"PageBlockVersions().get(key)" in s` 对现行代码也成立。另一支命中的是旧写法（`pageBlockVersions.get(key)`）。

**为什么绿**：`or` 枚举了"好几种都算对"，而且有一支同时覆盖新世界——这条断言从"证明是新形态"退化成"是这几种之一就行"，**对任何一个世界都绿**。

**复现**（Python，2 秒）：

```bash
python3 - <<'PY'
good = 'injected.getPageBlockVersions().get(key)'   # 现行
old_lower = 'pageBlockVersions.get(key)'            # 旧写法（小写）
old_cap = 'PageBlockVersions().get(key)'            # 旧写法（大写带括号）
loose  = lambda s: 'pageBlockVersions.get(key)' in s or 'PageBlockVersions().get(key)' in s
suffix = lambda s: 'PageBlockVersions().get(key)' in s          # 只"收紧"到后缀那一支
tight  = lambda s: 'getPageBlockVersions().get(key)' in s       # 收紧到全串
for name, f in [('旧 or 两支', loose), ('只留后缀那支', suffix), ('收紧成全串', tight)]:
    print(name, '现行=%s 旧(小写)=%s 旧(大写)=%s' % (f(good), f(old_lower), f(old_cap)))
PY
```

实测输出：

```text
旧 or 两支 现行=True 旧(小写)=True 旧(大写)=True
只留后缀那支 现行=True 旧(小写)=False 旧(大写)=True
收紧成全串 现行=True 旧(小写)=False 旧(大写)=False
```

读法：前两行都有"两个以上世界同时绿"。**只把 `or` 砍成"看起来更严"的后缀那一支，仍然收不干净**——后缀本来就是新形态的一部分；必须断言**全串**。

**真实位置**：`tests/integration/test_ui_assets.py:472`（现行只认全串）；它上面 469–471 行的注释记了这段历史。旧形态：`git show fb60051 -- tests/integration/test_ui_assets.py | grep PageBlockVersions`。

**修法**：断言写最具体的那一个串，不写 `or`。兼容期非用不可的，给 `or` 一个到期点，收紧后删掉。

## 2. 空转：判据绿 ≠ 覆盖

**现象**：R5 判"每个视图模块的顶层状态都在 OWNERS 里"，靠 `VIEW_STATE_PREFIXES` 的前缀认模块自己的状态。`pages-view.js` 登记的前缀是 `/^(pages|PAGES_)/`，而它列 0 的 22 个声明**一个都不匹配**。

**为什么绿**：前缀命中 0 → 循环体一次都不进 → `problems` 为空 → 绿。**"没判过"和"判过了没问题"在返回值上长得一模一样。**

**复现**：

```bash
f=backend/book2text/static/pages-view.js
echo "列 0 声明: $(grep -cE '^(const|let|var) ' $f)  前缀命中: $(grep -E '^(const|let|var) ' $f | grep -cE '^(const|let|var) (pages|PAGES_)')"
```

实测输出：

```text
列 0 声明: 22  前缀命中: 0
```

**真实位置**：`tests/js/boundary.test.mjs:3181`（前缀表）、`:3191`（这条已知缺口的注释）；守卫在 `:3120`——「顶层有 N 个声明，但状态前缀一个都没命中——定位失败，这条判据对它是空转」。

**修法**（都已在闸里）：

- **主体数 > 0 而命中数 = 0 → 红**（定位失败，不是"没有违规"）；
- **空名单 / 空模块 → 红**（"没有东西可扫"必须是红，不能是绿）；
- 暂时不判的模块**显式登记**（`VIEW_STATE_IIFE`），并加一条"登记成 IIFE 但已摊平 ⇒ 红"。

## 3. 错位：剥离引号写成 `` `[^`]*` `` 会跨行

**现象**：判"带字母的刀号（`刀 5b`）只许写在引号里"时，先把引号内内容抹掉再扫裸文本。剥离正则写成 `` `[^`]*` `` ——字符类里没有换行，**一对反引号可以跨行配对**。

**为什么同时会漏、会假红**：错的是**配对**，不是行号。上一处的收尾符与下一处的起始符配成一对，中间的裸文本被当成"在引号里"→ **漏真违规**；反过来，本该配对的一对被拆开，剩下的一半让本该合规的内容露在外面 → **假红**。两个方向同时发生。

**复现**（node，2 秒；macOS 上 `node` 可能不在 PATH，用 `/opt/homebrew/bin/node`）：

```bash
node /dev/stdin <<'JS'
const text = [
  "第 1 行 孤立的 ` 反引号",
  "第 2 行 `刀 5b` 合规",
  "第 3 行 刀 5b 裸写",
  "第 4 行 `刀 5b` 合规",
].join("\n");
const bad  = (t) => t.replace(/`[^`]*`/g,  (s) => s.replace(/[^\n]/g, " "));
const good = (t) => t.replace(/`[^`\n]*`/g, (s) => s.replace(/[^\n]/g, " "));
const scan = (t) => t.split("\n").map((l, i) => [i + 1, l])
  .filter(([, l]) => /刀\s*\d+(?:\.\d+)?[a-z]/.test(l));
for (const [name, f] of [["跨行 [^`]*", bad], ["单行 [^`\\n]*", good]]) {
  const hits = scan(f(text)).map(([no]) => `L${no}`);
  console.log(`${name}: ${hits.length ? hits.join(",") : "无命中"}`);
}
JS
```

实测输出：

```text
跨行 [^`]*: L2,L4
单行 [^`\n]*: L3
```

读法：L2 / L4 是**合规的**（假红），真正的裸写在 L3 却被漏掉了——**同一个输入，两个方向同时出现**。

**行号一直是准的**：抹除时替换成**等长空格**、保留换行，所以命中行号从不漂。于是出现"指着一行说违规、人肉看却合规"时，**先怀疑配对，不要怀疑行号**。

**真实位置**：`tests/js/boundary.test.mjs:3289` 的 `stripQuotedSpans`（现在的字符类是 `` `[^`\n]*` ``）。这一条的行号在不同版本上会差十几行，**机制不变**。

**修法**：

- 字符类写死单行边界：`` `[^`\n]*` ``；
- 抹除用**等长空格**（`s.replace(/[^\n]/g, " ")`），行号才不漂；
- 三条自检：**引号内必绿 / 裸写必红 / 行号不漂**。

## 4. 下次写判据的检查单

1. 在**错的树**上红过一次没有？（`git show <旧提交>:…` 或临时回退——红过一次才算判据）
2. 断言里每个 `or`：**逐支自问**"这一支单独能证明什么"？有子串关系的支 = 0 分辨力。
3. **空输入**会红吗？（空列表 / 空模块 / 空文件）
4. **主体数 > 0 而命中 = 0** 判红了吗？这比"有违规"更常见。
5. 剥离 / 替换规则的**换行边界**写死了吗？配三条自检（必绿 / 必红 / 行号不漂）。
6. 期望值别用被测代码自己算出来的常量（那是自证）；**行为断言与预算断言拆开**。
