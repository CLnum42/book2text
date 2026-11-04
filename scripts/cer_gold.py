#!/usr/bin/env python
"""对 40 页实跑做金标准 CER 测量（2026-11-04，Chief 派）。

读「导出 txt」与金标准整本拼接版 → 按 `core/ocr/compare.py` 的归一化口径算 CER。
**只认不分页的整本拼接版**（`…_金标准文本.txt`）：分页草稿的文件头自己写着
「未经逐页确认前不要当作金标准使用」，拿它做页级 CER 会把草稿的错算到识别头上。

口径（照 compare.py，不重新发明）：
- 归一化 = `normalize_for_comparison(keep_newlines=False)`：空白统一、全角↔半角标点归一、
  等价符号归一、中日韩字符之间的空格删除；换行位置不同不算错。
- 分母 = `len(归一化后的金标准)`；CER = 编辑距离 / 分母（单位代价的 Levenshtein）。
- 标点算字符（归一化之后按字符算），书眉/页码/页脚**在导出时就排除**：
  工具读导出清单的 `rules.exclude_header_footer`，为假就拒绝测量（fail closed），
  不自己猜哪些行是书眉。
- 主列 = 上面的口径；「忽略空白」列只作对照（删掉**全部**空白再算，见
  `normalize_whitespace_insensitive` 的说明），不是判据。

编辑距离为什么不用 `compare.score_text`：它内部是纯 Python 的 O(n·m) 双层循环，
20k 字×20k 字实测约 10 分钟。本工具用 numpy 反对角线实现**同一个**单位代价 Levenshtein
（`--self-test` 里对随机短串与 `compare.levenshtein` 逐例对拍），CER 公式与 `score_text`
逐字相同。`--self-test` 的小样例直接走 `compare.score_text`，算式本身用官方实现验。

用法::

    PYTHONPATH=backend .venv/bin/python scripts/cer_gold.py \
        --project /tmp/b2t-qa4/lib/b2t_T7JH61 \
        --gold gold_standard/红楼梦第一卷_正文前40页_金标准文本.txt \
        --out docs/qa/2026-11-04-gold40p.json

    # 自检（三条判据，红则退出码 1）
    PYTHONPATH=backend .venv/bin/python scripts/cer_gold.py --self-test
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
import tempfile
from difflib import SequenceMatcher
from pathlib import Path

import numpy as np

from book2text.core.ocr import compare

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_GOLD = REPO_ROOT / "gold_standard" / "红楼梦第一卷_正文前40页_金标准文本.txt"

#: 回目标题：行首「第N回」，后面可以紧跟回目（OCR 常把回目合到同一行，金标准是分开的）。
#: 不要求整行 —— 要求整行会让「第二回贾夫人仙逝…」这种合并行漏掉。
CHAPTER_RE = re.compile(r"^第\s*([0-9〇零一二三四五六七八九十百]+)\s*回", re.MULTILINE)

_DIGITS = {"〇": 0, "零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
           "六": 6, "七": 7, "八": 8, "九": 9}


def chapter_number(token: str) -> int | None:
    """「1」「一」「十二」「二十一」→ 整数；认不出返回 None（不猜）。"""
    token = unicodedata.normalize("NFKC", token).strip()
    if token.isdigit():
        return int(token)
    total = 0
    current = 0
    for char in token:
        if char in _DIGITS:
            current = _DIGITS[char]
        elif char == "十":
            total += (current or 1) * 10
            current = 0
        elif char == "百":
            total += (current or 1) * 100
            current = 0
        else:
            return None
    return total + current


# ---------------------------------------------------------------- 编辑距离


def levenshtein_numpy(reference: str, hypothesis: str) -> int:
    """单位代价 Levenshtein，按反对角线并发算（结果与 `compare.levenshtein` 相同）。

    反对角线 k = i + j 上的格子互不依赖（依赖都在 k-1 / k-2），所以一条对角线可以做一次
    向量化；逐行算不行——同一行里 `D[i][j]` 依赖 `D[i][j-1]`。
    """
    n, m = len(reference), len(hypothesis)
    if reference == hypothesis:
        return 0
    if n == 0:
        return m
    if m == 0:
        return n
    ref = np.frombuffer(reference.encode("utf-32-le"), dtype=np.uint32)
    hyp = np.frombuffer(hypothesis.encode("utf-32-le"), dtype=np.uint32)
    inf = n + m + 1

    prev2 = np.zeros(0, dtype=np.int32)   # 对角线 k-2
    prev2_lo, prev2_hi = 0, -1
    prev1 = np.zeros(1, dtype=np.int32)   # 对角线 k-1：D[0][0] = 0
    prev1_lo, prev1_hi = 0, 0

    for k in range(1, n + m + 1):
        lo, hi = max(0, k - m), min(n, k)
        idx = np.arange(lo, hi + 1)
        js = k - idx

        left = np.full(idx.size, inf, dtype=np.int32)   # D[i-1][j] + 1
        hit = (idx - 1 >= prev1_lo) & (idx - 1 <= prev1_hi)
        left[hit] = prev1[idx[hit] - 1 - prev1_lo] + 1

        up = np.full(idx.size, inf, dtype=np.int32)     # D[i][j-1] + 1
        hit = (idx >= prev1_lo) & (idx <= prev1_hi)
        up[hit] = prev1[idx[hit] - prev1_lo] + 1

        diag = np.full(idx.size, inf, dtype=np.int32)   # D[i-1][j-1] + cost
        hit = (idx - 1 >= prev2_lo) & (idx - 1 <= prev2_hi)
        cost = np.ones(idx.size, dtype=np.int32)
        both = hit & (idx >= 1) & (js >= 1)
        if both.any():
            cost[both] = (ref[idx[both] - 1] != hyp[js[both] - 1]).astype(np.int32)
        diag[hit] = prev2[idx[hit] - 1 - prev2_lo] + cost[hit]

        cur = np.minimum(np.minimum(left, up), diag)
        prev2, prev2_lo, prev2_hi = prev1, prev1_lo, prev1_hi
        prev1, prev1_lo, prev1_hi = cur, lo, hi

    return int(prev1[-1])


def distance(reference: str, hypothesis: str) -> int:
    """短文本走 compare.py 的原实现（顺带保证口径一致），长文本走 numpy。"""
    if max(len(reference), len(hypothesis)) <= 2000:
        return compare.levenshtein(reference, hypothesis)
    return levenshtein_numpy(reference, hypothesis)


def score(reference: str, hypothesis: str) -> dict[str, object]:
    """与 `compare.score_text` 同式：CER = distance / len(reference)。"""
    dist = distance(reference, hypothesis)
    return {
        "reference_chars": len(reference),
        "hypothesis_chars": len(hypothesis),
        "distance": dist,
        "cer": (dist / len(reference)) if reference else 0.0,
    }


def edit_ops(reference: str, hypothesis: str) -> dict[str, object]:
    """删除 / 替换 / 插入分项（difflib 的匹配块对齐，不是最小编辑脚本）。

    **它不是 CER 的来源**：CER 用上面的 Levenshtein。difflib 找的是最长匹配块，
    分项之和可能比最小距离大；输出里同时给 `sum` 与 `minimal_distance`，差值即口径差。
    """
    sub = dele = ins = 0
    matcher = SequenceMatcher(None, reference, hypothesis, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            continue
        if tag == "replace":
            n_ref, n_hyp = i2 - i1, j2 - j1
            paired = min(n_ref, n_hyp)
            sub += paired
            dele += n_ref - paired
            ins += n_hyp - paired
        elif tag == "delete":
            dele += i2 - i1
        else:  # insert
            ins += j2 - j1
    return {"substitutions": sub, "deletions": dele, "insertions": ins, "sum": sub + dele + ins}


# ---------------------------------------------------------------- 导出 / 金标准


class MeasureError(RuntimeError):
    """输入不满足测量前提（不是崩，是把原因说清楚后退出）。"""


def resolve_project(project: str, library: str | None) -> Path:
    path = Path(project).expanduser()
    if path.is_dir() and (path / "exports").is_dir():
        return path
    if library:
        candidate = Path(library).expanduser() / project
        if candidate.is_dir():
            return candidate
    raise MeasureError(f"找不到项目目录：{project}（要么给项目目录，要么给 --library + 项目 id）")


def pick_export(project_dir: Path, export: str | None) -> Path:
    exports = project_dir / "exports"
    if export:
        candidate = Path(export).expanduser()
        if not candidate.is_dir():
            candidate = exports / export
        if not candidate.is_dir():
            raise MeasureError(f"找不到导出目录：{export}")
        return candidate
    candidates = []
    for item in exports.iterdir() if exports.is_dir() else []:
        manifest = item / "manifest.json"
        if item.is_dir() and (item / "body.txt").is_file() and manifest.is_file():
            try:
                rules = json.loads(manifest.read_text(encoding="utf-8")).get("rules", {})
            except json.JSONDecodeError:
                continue
            if rules.get("format") == "txt":
                candidates.append(item)
    if not candidates:
        raise MeasureError(f"{exports} 下没有 txt 导出（先导出一次 txt）")
    return sorted(candidates, key=lambda p: p.name)[-1]


def load_export(project_dir: Path, export: str | None) -> tuple[Path, dict, str]:
    export_dir = pick_export(project_dir, export)
    manifest = json.loads((export_dir / "manifest.json").read_text(encoding="utf-8"))
    rules = manifest.get("rules", {})
    if rules.get("format") != "txt":
        raise MeasureError(f"{export_dir} 不是 txt 导出（format={rules.get('format')}）")
    if not rules.get("exclude_header_footer"):
        raise MeasureError(
            f"{export_dir} 的导出清单里 exclude_header_footer 不是 true：书眉/页码/页脚会混进正文，"
            "这一份不能拿来算 CER。请用默认设置（勾选「排除书眉/页码/页脚」）重新导出。"
        )
    body = (export_dir / "body.txt").read_text(encoding="utf-8-sig")
    return export_dir, manifest, body


def load_gold(path: Path) -> str:
    if not path.is_file():
        raise MeasureError(f"找不到金标准：{path}")
    text = path.read_text(encoding="utf-8-sig")
    if "未经逐页确认" in text[:500]:
        raise MeasureError(
            f"{path.name} 的文件头写着「未经逐页确认」——分页草稿不能当金标准；"
            "用不分页的整本拼接版（…_金标准文本.txt）。"
        )
    return text


# ---------------------------------------------------------------- 按回汇总


def per_chapter(gold: str, hyp: str) -> list[dict[str, object]]:
    """按回汇总：两侧各自定位「第N回」行首标题，**按回号配对**（不是按出现顺序）。

    为什么按回号：金标准写「第1回」、OCR 常写「第一回」，且回目可能与标题合行
    （「第二回贾夫人仙逝扬州城…」）。按顺序配对会在 OCR 漏掉一个标题时把后面几回
    整体错位，算出来的分段 CER 全是假的。
    一侧缺这一回 → 那行标 null（不猜、不拿别人的段顶）。

    标题要在**保留换行**的归一化文本上定位（`keep_newlines=True`），否则整篇压成一行；
    切出来的段再按整篇同一口径（`keep_newlines=False`）压平比对。
    """
    gold_lines = compare.normalize_for_comparison(gold, keep_newlines=True)
    hyp_lines = compare.normalize_for_comparison(hyp, keep_newlines=True)

    def marks(text: str) -> list[tuple[int | None, int, str]]:
        out = []
        for match in CHAPTER_RE.finditer(text):
            out.append((chapter_number(match.group(1)), match.start(), match.group(1)))
        return out

    gold_marks = marks(gold_lines)
    # 同一回号出现多次（目录/引用）时取第一次，后面的不参与分段
    hyp_by_number: dict[int, int] = {}
    for number, pos, _ in marks(hyp_lines):
        if number is not None:
            hyp_by_number.setdefault(number, pos)
    ordered_hyp = sorted(((pos, number) for number, pos in hyp_by_number.items()))

    rows: list[dict[str, object]] = []
    for index, (number, start, raw) in enumerate(gold_marks):
        gold_end = gold_marks[index + 1][1] if index + 1 < len(gold_marks) else len(gold_lines)
        ref_seg = compare.normalize_for_comparison(gold_lines[start:gold_end], keep_newlines=False)
        row: dict[str, object] = {"chapter": f"第{raw}回", "gold_chars": len(ref_seg)}
        hyp_start = hyp_by_number.get(number) if number is not None else None
        if hyp_start is None:
            row.update({"hypothesis_chars": 0, "distance": None, "cer": None,
                        "note": "导出文本里定位不到这一回的回目，未计入"})
            rows.append(row)
            continue
        following = [pos for pos, _ in ordered_hyp if pos > hyp_start]
        hyp_end = following[0] if following else len(hyp_lines)
        hyp_seg = compare.normalize_for_comparison(hyp_lines[hyp_start:hyp_end], keep_newlines=False)
        row.update(score(ref_seg, hyp_seg))
        rows.append(row)
    return rows


# ---------------------------------------------------------------- 主流程


def measure(project: str, gold_path: Path, library: str | None, export: str | None) -> dict[str, object]:
    project_dir = resolve_project(project, library)
    export_dir, manifest, body = load_export(project_dir, export)
    gold = load_gold(gold_path)

    ref = compare.normalize_for_comparison(gold, keep_newlines=False)
    hyp = compare.normalize_for_comparison(body, keep_newlines=False)
    main = score(ref, hyp)

    ws_ref = compare.normalize_whitespace_insensitive(ref)
    ws_hyp = compare.normalize_whitespace_insensitive(hyp)
    ignore_ws = score(ws_ref, ws_hyp)

    ops = edit_ops(ref, hyp)
    ops["minimal_distance"] = main["distance"]

    return {
        "schema": "book2text.cer-gold.v1",
        # 只记 id / 文件名，不写绝对路径（AGENTS 1.3：个人绝对路径不进项目数据）
        "project": {
            "id": project_dir.name,
            "name": (manifest.get("project") or {}).get("name"),
            "source_file_name": (manifest.get("project") or {}).get("source_file_name"),
        },
        "export": {
            "id": export_dir.name,
            "exported_at": manifest.get("exported_at"),
            "pages": (manifest.get("stats") or {}).get("page_count"),
            "rules": {
                key: (manifest.get("rules") or {}).get(key)
                for key in ("format", "exclude_header_footer", "page_types", "margin_judgement")
            },
        },
        "gold": {
            "file": gold_path.name,
            "sha256": hashlib.sha256(gold.encode("utf-8")).hexdigest(),
            "chars": len(gold),
        },
        "cer": main["cer"],
        "reference_chars": main["reference_chars"],
        "hypothesis_chars": main["hypothesis_chars"],
        "distance": main["distance"],
        "edit_ops": ops,
        "ignore_whitespace": {
            "cer": ignore_ws["cer"],
            "reference_chars": ignore_ws["reference_chars"],
            "distance": ignore_ws["distance"],
            "note": "对照列：删掉全部空白再算（含中文/拉丁边界空格），不是判据",
        },
        "per_chapter": per_chapter(gold, body),
        "method": "normalize_for_comparison(keep_newlines=False) + 单位代价 Levenshtein（numpy 与 compare.py 对拍）",
    }


# ---------------------------------------------------------------- 自检


def self_test() -> int:
    """三条判据：① 相同文本 CER 0 ② 3 处替换 = 3/len ③ 归一化三项各自断言。"""
    failures: list[str] = []

    def check(label: str, condition: bool, detail: str = "") -> None:
        print(("✔ " if condition else "✖ ") + label + (f"（{detail}）" if detail else ""))
        if not condition:
            failures.append(label)

    # ⓪ 先证明 numpy 距离与官方实现是同一个数（自检本身的可信前提）
    rng = np.random.default_rng(20261104)
    alphabet = list("甲乙丙丁戊己庚辛壬癸的了在是有")
    mismatch = 0
    for _ in range(64):
        a = "".join(rng.choice(alphabet, size=int(rng.integers(0, 48))))
        b = "".join(rng.choice(alphabet, size=int(rng.integers(0, 48))))
        if levenshtein_numpy(a, b) != compare.levenshtein(a, b):
            mismatch += 1
    check("⓪ numpy Levenshtein 与 compare.levenshtein 逐例一致（64 例）", mismatch == 0, f"不一致 {mismatch}")

    # ① 完全相同的文本 → CER 0
    same = "却说那女娲氏炼石补天之时，于大荒山无稽崖炼成高十二丈的顽石。"
    assert0 = compare.score_text(
        compare.normalize_for_comparison(same, keep_newlines=False),
        compare.normalize_for_comparison(same, keep_newlines=False),
    )
    check("① 相同文本 CER = 0", assert0.cer == 0.0, f"cer={assert0.cer}")

    # ② 已知 3 处替换 → CER 精确等于 3 / len(reference)
    ref = compare.normalize_for_comparison("甲乙丙丁戊己庚辛壬癸", keep_newlines=False)
    hyp = compare.normalize_for_comparison("甲乙丙X戊己庚Y壬Z", keep_newlines=False)
    scored = score(ref, hyp)
    check("② 3 处替换 CER = 3/len(reference)", scored["distance"] == 3 and abs(scored["cer"] - 3 / len(ref)) < 1e-12,
          f"cer={scored['cer']} expected={3 / len(ref)}")

    # ③ 三项归一化各一条：全角标点 / 中日韩间空格 / 书眉块（由导出规则排除）
    full = compare.normalize_for_comparison("他说：“好。”", keep_newlines=False)
    half = compare.normalize_for_comparison('他说:"好."', keep_newlines=False)
    check("③a 全角↔半角标点归一后是同一串", full == half, f"{full!r} vs {half!r}")

    spaced = compare.normalize_for_comparison("这是 一段 中文 文字", keep_newlines=False)
    tight = compare.normalize_for_comparison("这是一段中文文字", keep_newlines=False)
    check("③b 中日韩字符之间空格被删（两侧同一串）", spaced == tight, f"{spaced!r} vs {tight!r}")

    with tempfile.TemporaryDirectory() as tmp:
        export_dir = Path(tmp) / "exports" / "20260101-0000_txt"
        export_dir.mkdir(parents=True)
        (export_dir / "body.txt").write_text("正文", encoding="utf-8")
        (export_dir / "manifest.json").write_text(
            json.dumps({"rules": {"format": "txt", "exclude_header_footer": False}}), encoding="utf-8"
        )
        try:
            load_export(Path(tmp), None)
            leaked = False
        except MeasureError:
            leaked = True
    check("③c 导出含书眉/页码/页脚（exclude_header_footer=false）时拒绝测量", leaked)

    print()
    if failures:
        print(f"自检红：{len(failures)} 条（{'、'.join(failures)}）")
        return 1
    print("自检全绿：3 组判据（含 numpy 对拍）")
    return 0


# ---------------------------------------------------------------- CLI


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="金标准 CER 测量（40 页实跑用）")
    parser.add_argument("--self-test", action="store_true", help="跑三条自检后退出")
    parser.add_argument("--project", help="项目目录（含 exports/），或项目 id（配 --library）")
    parser.add_argument("--library", help="库目录（--project 给项目 id 时用）")
    parser.add_argument("--export", help="指定导出目录（默认取最新一次 txt 导出）")
    parser.add_argument("--gold", default=str(DEFAULT_GOLD), help="金标准整本拼接版路径")
    parser.add_argument("--out", help="输出 JSON 路径")
    args = parser.parse_args(argv)

    if args.self_test:
        return self_test()
    if not args.project or not args.out:
        parser.error("需要 --project 与 --out（或用 --self-test）")

    try:
        result = measure(args.project, Path(args.gold).expanduser(), args.library, args.export)
    except MeasureError as error:
        print(f"✖ {error}", file=sys.stderr)
        return 2

    out = Path(args.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"CER = {result['cer']:.6f}（距离 {result['distance']} / 金标准 {result['reference_chars']} 字）")
    print(f"  删除/替换/插入 = {result['edit_ops']['deletions']} / {result['edit_ops']['substitutions']} / {result['edit_ops']['insertions']}")
    print(f"  忽略空白对照 = {result['ignore_whitespace']['cer']:.6f}（仅对照，不是判据）")
    print(f"  按回 {len(result['per_chapter'])} 段 → {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
