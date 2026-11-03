// 取注释的剥离器：`static-scan.mjs` 那三个剥离器的**互补口径**（2026-11-03 加）。
//
// 为什么需要第四个口径：`stripCommentsAndStrings` / `stripPreservingTemplateExpressions` / `codeOnly`
// 全都在**丢注释**（判据关心的是代码里的标识符）。但有一类判据关心的恰恰是注释本身：
// 「注释里许的到期点是不是一个真刀号」——注释里引用一个不存在的刀号，是**不可执行的承诺**
// （到点该删什么、谁来判，登记表里查不到），而这类判据用前三把尺子拿不到任何输入。
//
// 为什么单独成文件、不并进 `static-scan.mjs`：那个文件的文档写着「三个剥离器（别再加第四把尺子）」，
// 第四把要成立得先改写它的总述与适用范围。这是**注释写进共享判据文件**的改动，
// 按 §18.6 属于「改判据」，要第二人签字——一个剥离器不值得插一轮签字。
// 并进去的时机是：第三把尺子也要改的时候，一起收拾。
//
// 状态机与正则字面量的判定和 `static-scan.mjs` 的 `codeOnly` 逐字一致（那边有详细解释：
// 正则里的引号 `/[&<>"']/g` 会让朴素的字符串状态机错位，之后的注释不再被识别）。
// **改一边要同步另一边**，所以这里保持同一套结构，不去抽象，免得以后没人能对读。
//
// 输出约定：长度与换行不变（注释原样、其余抹成空格）⇒ 行号与真实文件、与 `codeOnly` 完全一致，
// 判据报文里的 `file:line` 可以直接给人看。

/**
 * 只留注释：代码 / 字符串 / 模板 / 正则字面量抹成空格，注释原样留下。
 *
 * 直接后果（写判据的人要知道）：**说明性文字也会被当成承诺**——本文档第一版就写了一句
 * "注释里放一个不存在的到期点当例子"，结果被用它的那条判据自己判红。举例时不要写成承诺形态
 * （`到期点` 后面紧跟号就会被当真），或者把例子放进字符串字面量里。
 */
export function commentOnly(source) {
  const text = String(source || "");
  const out = text.split("");
  const n = text.length;
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  const REGEX_PRECEDERS = "([{=,:;!&|?+-*%~^<>";
  const KEYWORD_BEFORE_REGEX = /(?:^|[^\w$])(?:return|typeof|instanceof|case|in|of|void|delete|new|throw)\s*$/;
  const looksLikeRegex = (at) => {
    let k = at - 1;
    while (k >= 0 && /\s/.test(text[k])) k -= 1;
    if (k < 0) return true;
    if (REGEX_PRECEDERS.includes(text[k])) return true;
    return KEYWORD_BEFORE_REGEX.test(text.slice(Math.max(0, k - 12), k + 1));
  };
  let i = 0;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      i = stop;                       // 注释原样留下
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      i = stop;                       // 块注释原样留下（含其中换行，行号因此不漂）
    } else if (ch === "/" && looksLikeRegex(i)) {
      let k = i + 1;
      let inClass = false;
      while (k < n) {
        const cur = text[k];
        if (cur === "\\") { k += 2; continue; }
        if (cur === "[") inClass = true;
        else if (cur === "]") inClass = false;
        else if (cur === "/" && !inClass) { k += 1; break; }
        else if (cur === "\n") break;
        k += 1;
      }
      blank(i, k);
      i = k;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let k = i + 1;
      while (k < n) {
        if (text[k] === "\\") { k += 2; continue; }
        if (text[k] === quote) { k += 1; break; }
        k += 1;
      }
      blank(i, k);                     // 字符串整段抹掉（含跨行模板：换行保留 ⇒ 行号不漂）
      i = k;
    } else {
      if (ch !== "\n") out[i] = " ";   // 代码抹掉，**行号列**保留
      i += 1;
    }
  }
  return out.join("");
}
