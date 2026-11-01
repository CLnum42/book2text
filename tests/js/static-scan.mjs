// 共享的纯文本扫描工具（闸 B / 测试共用；不加载 app.js、不碰 DOM）。
//
// 只做三件事：去注释与字符串（正则字面量要单独认，否则 `/["']/` 会吞掉后半个文件）、
// 取函数体（花括号配对）、数某个标识符在文本里出现几次。

/**
 * **三个剥离器，各自适用什么**（别再加第四把尺子）：
 *
 * - `stripCommentsAndStrings`：注释 + 字符串 + 正则**全抹掉**。用于"按标识符判依赖/引用"的判据
 *   （R1/R9 那类：只关心代码里的标识符，字符串里的同一串文字不算引用）。
 * - `stripPreservingTemplateExpressions`：同上，但**保留模板字符串 `${…}` 里的表达式**。
 *   用于"模板里拼的调用点也要看得见"的判据（R11 边棘轮的 `showView(\`…\`)`）。
 * - `codeOnly`（本函数）：**只剥注释**，字符串原样保留、正则字面量按语法跳过并抹成空格。
 *   用于"某个 id / 某个注入键在代码里到底出不出现"的判据（R3 的 id 归属、域模块闸的 `el(`、
 *   注入键是否被读）。这类判据两个方向都会被注释骗：注释里写一句禁用 id ⇒ 假红；
 *   注释里写一句 `injected.deadKey` ⇒ **假绿**（一个真死注入被一句注释混过闸）。
 *
 * 为什么不能只做"字符串状态机"（2026-11-02 修的真 bug）：遇到正则字面量里的引号
 * （`/[&<>"']/g`）会错进字符串状态，后面的整行注释就不再被剥——于是上面两个方向同时出错。
 * 正则必须先按语法认出来（前一个有效字符是 `([{=,:;!&|?+-*%~^<>` 之类才算字面量），
 * 再连字符类 `[…]` 一起跳到收尾的 `/`。
 */
export function codeOnly(source) {
  const text = String(source || "");
  const out = text.split("");
  const n = text.length;
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  const REGEX_PRECEDERS = "([{=,:;!&|?+-*%~^<>";
  const looksLikeRegex = (at) => {
    let k = at - 1;
    while (k >= 0 && /\s/.test(text[k])) k -= 1;
    if (k < 0) return true;
    return REGEX_PRECEDERS.includes(text[k]);
  };
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop); i = stop;
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop); i = stop;
    } else if (ch === "/" && looksLikeRegex(i)) {
      let k = i + 1; let inClass = false;
      while (k < n) {
        const cur = text[k];
        if (cur === "\\") { k += 2; continue; }
        if (cur === "[") inClass = true;
        else if (cur === "]") inClass = false;
        else if (cur === "/" && !inClass) { k += 1; break; }
        else if (cur === "\n") break;
        k += 1;
      }
      blank(i, k); i = k;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch; let k = i + 1;
      while (k < n) {
        if (text[k] === "\\") { k += 2; continue; }
        if (text[k] === quote) { k += 1; break; }
        k += 1;
      }
      i = k;   // 字符串保留
    } else i += 1;
  }
  return out.join("");
}

/** 把注释、字符串、正则字面量抹成空格；保持长度与换行，行号列号仍然准。 */
export function stripCommentsAndStrings(source) {
  const out = source.split("");
  const n = source.length;
  let i = 0;
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  const REGEX_PRECEDERS = "([{=,:;!&|?+-*%~^<>";
  const KEYWORD_BEFORE_REGEX = /(?:^|[^\w$])(?:return|typeof|instanceof|case|in|of|void|delete|new|throw)\s*$/;
  const looksLikeRegex = (at) => {
    let k = at - 1;
    while (k >= 0 && /\s/.test(source[k])) k -= 1;
    if (k < 0) return true;
    if (REGEX_PRECEDERS.includes(source[k])) return true;
    return KEYWORD_BEFORE_REGEX.test(source.slice(Math.max(0, k - 12), k + 1));
  };
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
    } else if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
    } else if (ch === "/" && looksLikeRegex(i)) {
      let k = i + 1;
      let inClass = false;
      while (k < n) {
        const cur = source[k];
        if (cur === "\\") {
          k += 2;
          continue;
        }
        if (cur === "[") inClass = true;
        else if (cur === "]") inClass = false;
        else if (cur === "/" && !inClass) {
          k += 1;
          break;
        } else if (cur === "\n") break;
        k += 1;
      }
      blank(i, k);
      i = k;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let k = i + 1;
      while (k < n) {
        if (source[k] === "\\") {
          k += 2;
          continue;
        }
        if (source[k] === quote) {
          k += 1;
          break;
        }
        k += 1;
      }
      blank(i, k);
      i = k;
    } else {
      i += 1;
    }
  }
  return out.join("");
}

/** 取名为 `name` 的函数体（去注释/字符串后的文本，不含花括号本身）；找不到返回 null。 */
export function functionBody(stripped, name) {
  const head = new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = head.exec(stripped);
  if (!match) return null;
  const openParen = stripped.indexOf("(", match.index);
  let depth = 0;
  let cursor = openParen;
  for (; cursor < stripped.length; cursor += 1) {
    if (stripped[cursor] === "(") depth += 1;
    else if (stripped[cursor] === ")") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const bodyStart = stripped.indexOf("{", cursor);
  if (bodyStart === -1) return null;
  let braces = 0;
  let bodyEnd = bodyStart;
  for (; bodyEnd < stripped.length; bodyEnd += 1) {
    if (stripped[bodyEnd] === "{") braces += 1;
    else if (stripped[bodyEnd] === "}") {
      braces -= 1;
      if (braces === 0) break;
    }
  }
  return stripped.slice(bodyStart + 1, bodyEnd);
}

/** 文本里 `word` 作为独立标识符出现几次（`obj.word` 也算，因为那仍是同名引用）。 */
export function countWord(text, word) {
  const pattern = new RegExp(`(?<![\\w$])${word}(?![\\w$])`, "g");
  return (text.match(pattern) || []).length;
}

/**
 * 同 `stripCommentsAndStrings`，但**保留模板字面量里 `${…}` 的表达式**，只抹掉字面文本。
 *
 * 为什么需要单独一份：整段模板一起抹掉，`` `${readingTreeOpen.has(1)}` `` 里的标识符就隐形了。
 * no-undef（R9）必须看得见这一类引用——R9 自检里就有这个样例（喂进去必须红）。
 *
 * 只给 R9 用；闸 B 的计数仍用 `stripCommentsAndStrings`，否则函数体里模板插值的同名标识符
 * 会被算成"又一处调用"，把棘轮变成误报。
 */
export function stripPreservingTemplateExpressions(source) {
  const out = source.split("");
  const n = source.length;
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== "\n") out[k] = " ";
  };
  const REGEX_PRECEDERS = "([{=,:;!&|?+-*%~^<>";
  const KEYWORD_BEFORE_REGEX = /(?:^|[^\w$])(?:return|typeof|instanceof|case|in|of|void|delete|new|throw)\s*$/;
  const looksLikeRegex = (at) => {
    let k = at - 1;
    while (k >= 0 && /\s/.test(source[k])) k -= 1;
    if (k < 0) return true;
    if (REGEX_PRECEDERS.includes(source[k])) return true;
    return KEYWORD_BEFORE_REGEX.test(source.slice(Math.max(0, k - 12), k + 1));
  };
  // 跳过一段字符串（含转义），返回引号之后的位置
  const skipString = (k, quote) => {
    k += 1;
    while (k < n) {
      if (source[k] === "\\") { k += 2; continue; }
      if (source[k] === quote) return k + 1;
      k += 1;
    }
    return k;
  };
  const skipRegex = (k) => {
    k += 1;
    let inClass = false;
    while (k < n) {
      const cur = source[k];
      if (cur === "\\") { k += 2; continue; }
      if (cur === "[") inClass = true;
      else if (cur === "]") inClass = false;
      else if (cur === "/" && !inClass) return k + 1;
      else if (cur === "\n") return k;
      k += 1;
    }
    return k;
  };
  // 模板：抹文本、保留 `${…}`；插值内部按普通代码继续（可嵌套模板）
  const skipTemplate = (k) => {
    blank(k, k + 1);      // 起始反引号
    k += 1;
    while (k < n) {
      const ch = source[k];
      if (ch === "\\") { blank(k, Math.min(k + 2, n)); k += 2; continue; }
      if (ch === "`") { blank(k, k + 1); return k + 1; }
      if (ch === "$" && source[k + 1] === "{") {
        blank(k, k + 2);  // `${` 也抹掉：留着 `$` 会被当成一个标识符（`$` 是合法名字）
        k += 2;
        let depth = 1;
        while (k < n && depth > 0) {
          const cur = source[k];
          if (cur === "{") { depth += 1; k += 1; continue; }
          if (cur === "}") { depth -= 1; k += 1; continue; }
          if (cur === "'" || cur === '"') { const end = skipString(k, cur); blank(k, end); k = end; continue; }
          if (cur === "`") { k = skipTemplate(k); continue; }
          if (cur === "/" && source[k + 1] === "/") {
            const end = source.indexOf("\n", k); const stop = end === -1 ? n : end; blank(k, stop); k = stop; continue;
          }
          if (cur === "/" && source[k + 1] === "*") {
            const end = source.indexOf("*/", k + 2); const stop = end === -1 ? n : end + 2; blank(k, stop); k = stop; continue;
          }
          k += 1;
        }
        continue;
      }
      blank(k, k + 1); k += 1;
    }
    return k;
  };

  let i = 0;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      const end = source.indexOf("\n", i); const stop = end === -1 ? n : end; blank(i, stop); i = stop;
    } else if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2); const stop = end === -1 ? n : end + 2; blank(i, stop); i = stop;
    } else if (ch === "/" && looksLikeRegex(i)) {
      const end = skipRegex(i); blank(i, end); i = end;
    } else if (ch === "'" || ch === '"') {
      const end = skipString(i, ch); blank(i, end); i = end;
    } else if (ch === "`") {
      i = skipTemplate(i);
    } else {
      i += 1;
    }
  }
  return out.join("");
}
