// 共享的纯文本扫描工具（闸 B / 测试共用；不加载 app.js、不碰 DOM）。
//
// 只做三件事：去注释与字符串（正则字面量要单独认，否则 `/["']/` 会吞掉后半个文件）、
// 取函数体（花括号配对）、数某个标识符在文本里出现几次。

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
