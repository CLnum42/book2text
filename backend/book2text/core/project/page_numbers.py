"""印刷页码：位置模板聚类、确认填充、数值校验与异常列表（任务 55）。

用户 2026-10-23 的判断：**大多数页码的坐标在页面上是稳定的**，奇数页 / 偶数页可能
各在一个位置，但会重复。所以不该逐页确认——聚出位置模板 → 确认一次 → 全书自动填充
→ 只把异常页推给人。

**候选从哪来**（只读）：

1. **纯数字短行**：整行去掉装饰后是一个规范页码（阿拉伯 ≤4 位 / 罗马 ≤100），
   字数 ≤6，位置在版心外；没有版心时在页面四周 8% 边带里。
   正文里的数字（在版心内）一律不参与——那是引用编号，不是页码。
2. **书眉里的页码**：版心外、≤40 字的短行里如果**恰好有一个数字等于这一页的
   ``page_label``**，也收作候选。很多书（本测试书就是）把页码和章名排在同一行
   （``2 谁是巴赫金? 11``）；靠 ``page_label`` 对上号，不是按位置猜第几个数字。
   ``page_label`` 为空时不猜。

**模板**：先按最近的页边分带（顶 / 底 / 左 / 右），带内按归一化位置贪心聚类；
同一带上出现两个分别主要落在奇数页 / 偶数页的簇时，合并成"奇偶交替"模板。
中心坐标一律归一化（说明书 5.2），不存像素。

**数值校验**（保证正确性的关键）：

- 阿拉伯页码：相邻已填页之间 ``printed_page`` 的差应等于 ``pdf_page`` 的差；
- 罗马数字先转成数值再按同一规则；
- ``printed_page - pdf_page`` 的偏移在全书应基本恒定，偏离主导偏移 > 1 页 → 偏移突变；
- 异常分类：``no_candidate`` / ``ambiguous`` / ``jump`` / ``offset_break``；
- **不猜**：一个位置上有多个不同候选 → ``printed_page = null``，候选全列出来；
- 未识别的页单独一类（``not_recognized``），不混进异常。

**这一刀不接导出**：写入的 `page.printed_page` 只用于这次的模板 / 校验与界面显示；
`meta.json` 仍走原来的页码抽取（见 `core/export/streams.py`）。
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import statistics
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from ..storage import db as db_module
from ..structure import regions
from . import blocks as blocks_module
from . import library as library_module
from . import margin_box as margin_box_module

TEMPLATE_SCHEMA = "book2text.page-number-template.v1"

BAND_LABELS = {"top": "顶部", "bottom": "底部", "left": "左侧", "right": "右侧"}
MODE_ALL = "all"
MODE_ALTERNATE = "alternate"

# 候选位置：没有版心时用页面四周 8% 边带（任务书写上下；左右也收，
# 否则竖排书的左侧页码会被漏掉——见 D-071 / L-68）。
EDGE_RATIO = 0.08
# 纯数字短行最多几个字符（去掉空白后）
MAX_PURE_CHARS = 6
# 书眉里靠 page_label 对上号的候选：整行最多多长
MAX_LABEL_LINE_CHARS = 40
# 聚类：中心点在这个范围内算同一簇
CLUSTER_TOLERANCE_X = 0.05
CLUSTER_TOLERANCE_Y = 0.05
# 用模板取页时允许的偏差（比聚类略宽一点，容忍 OCR 抖动）
MATCH_TOLERANCE_X = 0.06
MATCH_TOLERANCE_Y = 0.055
# 一个模板至少覆盖几页才值得列出来
MIN_TEMPLATE_PAGES = 3
# 参与"奇偶交替"合并的簇至少各覆盖几页
MIN_ALTERNATE_PAGES = 3
# 奇偶交替合并时，两个中心纵向差太多就不是同一对位置
MAX_ALTERNATE_DY = 0.08
# 数值校验：偏移允许偏离主导偏移多少页
OFFSET_TOLERANCE = 1.0
MAX_TEMPLATES = 4

SOURCE_TEMPLATE = "template"
SOURCE_MANUAL = "manual"
# 导出时"没有新映射、退回块类型抽取"的来源标记（只在 meta.json 里出现）
SOURCE_LEGACY = "legacy"


class PageNumberError(library_module.ProjectError):
    """页码模板参数不合法（接口层转 400）。"""


# ---------------------------------------------------------------- 数据结构

@dataclass(frozen=True)
class Candidate:
    page_no: int
    value: str
    kind: str  # "line"（纯数字行）/ "label_match"（书眉里对上 page_label）
    x: float
    y: float
    text: str
    block_type: str

    def to_dict(self) -> dict[str, object]:
        return {
            "value": self.value,
            "kind": self.kind,
            "x": round(self.x, 4),
            "y": round(self.y, 4),
            "text": self.text,
            "block_type": self.block_type,
        }


@dataclass(frozen=True)
class Cluster:
    band: str
    x: float
    y: float
    members: tuple[Candidate, ...]

    @property
    def pages(self) -> list[int]:
        return sorted({item.page_no for item in self.members})


@dataclass(frozen=True)
class Template:
    template_id: str
    band: str
    label: str
    mode: str
    centers: dict[str, tuple[float, float]]
    parity_basis: str
    coverage: int
    sample_pages: tuple[int, ...]
    values: tuple[dict[str, str], ...]
    reliable: bool
    notes: tuple[str, ...]
    tolerance: dict[str, float]

    def to_dict(self) -> dict[str, object]:
        return {
            "schema": TEMPLATE_SCHEMA,
            "template_id": self.template_id,
            "band": self.band,
            "label": self.label,
            "mode": self.mode,
            "centers": {
                name: [round(value[0], 6), round(value[1], 6)]
                for name, value in self.centers.items()
            },
            "parity_basis": self.parity_basis,
            "coverage": self.coverage,
            "sample_pages": list(self.sample_pages),
            "values": list(self.values),
            "reliable": self.reliable,
            "notes": list(self.notes),
            "tolerance": dict(self.tolerance),
        }


# ---------------------------------------------------------------- 数值工具

def page_number_number(value: str | None) -> int | None:
    """页码文本 → 整数（阿拉伯或规范罗马）；不是页码返回 None。"""
    if not value:
        return None
    candidates = regions.page_number_candidates(value)
    if len(candidates) != 1:
        return None
    return candidates[0].value


def _page_parity(page: library_module.Page, basis: str) -> int:
    if basis == "printed":
        label = regions.canonical_page_value(page.page_label or "")
        number = page_number_number(label)
        if number is not None:
            return number % 2
    return page.page_no % 2


def _parity_basis(pages: list[library_module.Page]) -> str:
    """多数页有可解析的 page_label 时，用**印刷页码**的奇偶；否则用 PDF 页号。"""
    if not pages:
        return "pdf"
    usable = 0
    for page in pages:
        if page_number_number(regions.canonical_page_value(page.page_label or "")) is not None:
            usable += 1
    return "printed" if usable >= max(3, int(len(pages) * 0.8)) else "pdf"


# ---------------------------------------------------------------- 候选收集

def _position_ok(
    x: float, y: float, box: tuple[float, float, float, float] | None
) -> bool:
    if box is not None:
        return not (box[0] <= x <= box[2] and box[1] <= y <= box[3])
    return x <= EDGE_RATIO or x >= 1 - EDGE_RATIO or y <= EDGE_RATIO or y >= 1 - EDGE_RATIO


def _label_value(page: library_module.Page) -> str | None:
    return regions.canonical_page_value(page.page_label or "")


def collect_candidates(
    project_id: str, *, library: Path | None = None
) -> tuple[dict[int, list[Candidate]], list[library_module.Page], dict[str, object]]:
    """读项目里已识别页的行，收集页码候选。

    返回 ``(page_no → candidates, pages, recognition_states)``；只读，不写库。
    """
    target_library = library if library is not None else library_module.default_library_dir()
    project = library_module.load_project(project_id, library=target_library)
    pages = library_module.list_pages(project_id, library=target_library)
    page_by_id = {page.page_id: page for page in pages}
    states = blocks_module.page_recognition_states(project_id, library=target_library)
    recognized = {
        page.page_id
        for page in pages
        if (state := states.get(page.page_id)) is not None
        and state.status in (blocks_module.STATUS_RECOGNIZED, blocks_module.STATUS_HAS_CANDIDATE)
    }

    blocks = blocks_module.list_blocks(project_id, library=target_library)
    # 插图 / 装饰块里的数字不是页码
    block_by_id = {
        block.block_id: block
        for block in blocks
        if block.page_id in recognized and block.block_type not in ("figure", "decoration")
    }
    lines = blocks_module.list_block_lines(project_id, library=target_library)

    candidates: dict[int, list[Candidate]] = {}
    for line in lines:
        block = block_by_id.get(line.block_id)
        if block is None or line.bbox is None:
            continue
        page = page_by_id.get(block.page_id)
        if page is None:
            continue
        bbox = line.bbox
        x = (bbox[0] + bbox[2]) / 2
        y = (bbox[1] + bbox[3]) / 2
        box = margin_box_module.effective_margin_box(project, page)
        if not _position_ok(x, y, box):
            continue
        text = line.text or ""
        compact = "".join(text.split())
        value = regions.canonical_page_value(text)
        kind = ""
        if value is not None and len(compact) <= MAX_PURE_CHARS:
            kind = "line"
        else:
            label = _label_value(page)
            if label is not None and len(text.strip()) <= MAX_LABEL_LINE_CHARS:
                tokens = regions.page_number_candidates(text)
                matched = [
                    token
                    for token in tokens
                    if (token.text.upper() if token.kind == "roman" else token.text)
                    == (label.upper() if label.isalpha() else label)
                ]
                if len(matched) == 1:
                    value = label
                    kind = "label_match"
        if not kind or value is None:
            continue
        candidates.setdefault(page.page_no, []).append(
            Candidate(
                page_no=page.page_no,
                value=value,
                kind=kind,
                x=x,
                y=y,
                text=text.strip(),
                block_type=block.block_type,
            )
        )
    # 任务 71：**数字原生 PDF 的页码在文字层里**，而块级的候选只认"版心外的纯数字行"。
    # 这本书每页页眉印的是 `Page 31`（带词的数字），而且位置在版心框内 ——
    # 两条规则各挡一半，结果 662 页一个候选都没有（真正原因，不是"没有页码"）。
    # 页码是**结构化信息**：文字层里就是准确的那个数字，用它不违反"不拿文字层当第二引擎"。
    text_layer = _text_layer_candidates(project, pages, target_library)
    if text_layer:
        for page_no, items in text_layer.items():
            existing = {(item.value, item.kind) for item in candidates.get(page_no, [])}
            for item in items:
                if (item.value, item.kind) in existing:
                    continue
                candidates.setdefault(page_no, []).append(item)
    return candidates, pages, {
        "states": states,
        "recognized": recognized,
        "text_layer_used": len(text_layer),
    }


#: 页眉 / 页脚里"带词的数字页码"：`Page 31`、`page 31`、`P. 31`、`- 31 -`
_NUMBERED_LABEL = re.compile(r"^(?:page|p\.?)\s*[-–—]?\s*(\d{1,4})\s*[-–—]?$", re.IGNORECASE)
#: 页眉 / 页脚里的裸数字（有些书只印数字，但落在版心框内，块级候选会漏）
_BARE_NUMBER = re.compile(r"^[-–—\s]*(\d{1,4})[-–—\s]*$")
#: 只在这些页里找：正常正文页不会多到离谱
_TEXT_LAYER_MAX_PAGES = 2000


def _digital_native(pages: list[library_module.Page]) -> bool:
    """绝大多数正文页都有文字层 → 数字原生 PDF（不是整页扫描图）。"""
    body = [page for page in pages if page.include]
    if not body:
        return False
    with_layer = sum(1 for page in body if page.has_text_layer)
    return with_layer >= max(1, int(len(body) * 0.8))


def _near_edge(bbox: tuple[float, float, float, float]) -> bool:
    """这一行是不是贴在页边（页眉 / 页脚 / 页边外侧 8% 内）。"""
    x0, y0, x1, y1 = bbox
    return min(y0, 1 - y1, x0, 1 - x1) <= 0.08


def _text_layer_candidates(
    project: object, pages: list[library_module.Page], library: Path
) -> dict[int, list[Candidate]]:
    """从**文字层**的页眉 / 页脚取页码（只给数字原生的书用）。

    为什么直接读文字层而不是继续翻块：页码常在版心框内（`_position_ok` 会排除），
    而且页眉常被识别成 `Page 31` 这种"带词的数字"（`canonical_page_value` 不认）。
    文字层里这一行就是原样的字符串与坐标，取它最可靠。
    """
    from ..pdf import render as render_module

    if not _digital_native(pages):
        return {}
    try:
        source = library_module.project_dir(library, project.project_id) / "source" / "original.pdf"
    except Exception:  # noqa: BLE001 - 拿不到源文件就当没有文字层
        return {}
    if not source.exists():
        return {}
    found: dict[int, list[Candidate]] = {}
    body = [page for page in pages if page.include][:_TEXT_LAYER_MAX_PAGES]
    for page in body:
        if not page.has_text_layer:
            continue
        try:
            lines = render_module.page_text_lines(source, page.page_no - 1) or []
        except Exception:  # noqa: BLE001 - 单页读不了不影响其它页
            continue
        if not lines:
            continue
        # 只看开头两行与结尾两行：页眉 / 页脚就在那里
        edge = list(lines[:2]) + list(lines[-2:])
        seen: set[tuple[str, str]] = set()
        for text, bbox in edge:
            raw = " ".join(str(text).split())
            if not raw or len(raw) > 24:
                continue
            match = _NUMBERED_LABEL.match(raw)
            kind = "text_layer_label"
            if match is None:
                # 裸数字只认**贴边**的（离页边 8% 以内）：`Page N` 本身已足够明确，
                # 而正文里的小标题编号（`3`、`4`）也在页面上部，不贴边，别误收
                if not _near_edge(bbox):
                    continue
                match = _BARE_NUMBER.match(raw)
                kind = "text_layer_bare"
            if match is None:
                continue
            # '②'.isdigit() 是 True 但 int('②') 抛 ValueError（2026-11-05，P0）
            value = str(int(match.group(1))) if match.group(1).isdecimal() else match.group(1)
            if (value, kind) in seen:
                continue
            seen.add((value, kind))
            found.setdefault(page.page_no, []).append(
                Candidate(
                    page_no=page.page_no,
                    value=value,
                    kind=kind,
                    x=(bbox[0] + bbox[2]) / 2,
                    y=(bbox[1] + bbox[3]) / 2,
                    text=raw,
                    block_type="text_layer",
                )
            )
    return found


# ---------------------------------------------------------------- 聚类

def _band(x: float, y: float) -> str:
    distances = {"top": y, "bottom": 1 - y, "left": x, "right": 1 - x}
    return min(distances, key=distances.get)


def _cluster(candidates: list[Candidate]) -> list[Cluster]:
    buckets: dict[str, list[list[Candidate]]] = {}
    for candidate in sorted(candidates, key=lambda item: (item.page_no, item.x, item.y)):
        band = _band(candidate.x, candidate.y)
        groups = buckets.setdefault(band, [])
        best: list[Candidate] | None = None
        best_distance = None
        for group in groups:
            cx = statistics.median(item.x for item in group)
            cy = statistics.median(item.y for item in group)
            if (
                abs(candidate.x - cx) <= CLUSTER_TOLERANCE_X
                and abs(candidate.y - cy) <= CLUSTER_TOLERANCE_Y
            ):
                distance = math.hypot(candidate.x - cx, candidate.y - cy)
                if best is None or distance < best_distance:
                    best, best_distance = group, distance
        if best is None:
            groups.append([candidate])
        else:
            best.append(candidate)
    clusters = []
    for band, groups in buckets.items():
        for group in groups:
            clusters.append(
                Cluster(
                    band=band,
                    x=statistics.median(item.x for item in group),
                    y=statistics.median(item.y for item in group),
                    members=tuple(group),
                )
            )
    return clusters


def _cluster_values(cluster: Cluster) -> tuple[dict[int, str], list[int]]:
    """一簇里每页取一个值；同一页出现多个不同值的页单独列出（不猜）。"""
    by_page: dict[int, set[str]] = {}
    for member in cluster.members:
        by_page.setdefault(member.page_no, set()).add(member.value)
    values = {
        page: next(iter(found))
        for page, found in by_page.items()
        if len(found) == 1
    }
    ambiguous = sorted(page for page, found in by_page.items() if len(found) > 1)
    return values, ambiguous


def _template_label(
    band: str, centers: dict[str, tuple[float, float]], mode: str
) -> str:
    base = BAND_LABELS.get(band, band)
    if mode == MODE_ALTERNATE:
        odd = centers.get("odd")
        even = centers.get("even")
        if odd and even:
            if abs(odd[0] - even[0]) > 0.05:
                return f"{base}外侧 · " + ("奇右偶左" if odd[0] > even[0] else "奇左偶右")
            if abs(odd[1] - even[1]) > 0.05:
                return f"{base} · " + ("奇下偶上" if odd[1] > even[1] else "奇上偶下")
    if band in ("top", "bottom"):
        x = next(iter(centers.values()))[0]
        if x <= 0.35:
            return f"{base}左侧"
        if x >= 0.65:
            return f"{base}右侧"
        return f"{base}居中"
    return base


def _template_reliability(
    values: dict[int, str], coverage: int
) -> tuple[bool, tuple[str, ...], float]:
    """按数值连续性判模板可不可靠；返回 (reliable, notes, 偏移跨度)。"""
    numbered: list[tuple[int, int]] = []
    for page_no, value in sorted(values.items()):
        number = page_number_number(value)
        if number is None:
            continue
        numbered.append((page_no, number))
    notes: list[str] = []
    if coverage < 5:
        notes.append(f"只覆盖 {coverage} 页，样本太少，不建议直接采用。")
    if len(numbered) != coverage:
        notes.append("有候选不是规范阿拉伯 / 罗马数字，无法做数值校验。")
    if len(numbered) < 2:
        return False, tuple(notes + ["可校验的页码太少。"]), 0.0
    offsets = [number - page for page, number in numbered]
    spread = max(offsets) - min(offsets)
    correct = sum(
        1
        for (page_a, number_a), (page_b, number_b) in zip(numbered, numbered[1:])
        if number_b - number_a == page_b - page_a
    )
    consistency = correct / (len(numbered) - 1)
    if spread > OFFSET_TOLERANCE:
        notes.append(
            f"页码与 PDF 页号的偏移不恒定（跨度 {spread:.0f} 页），"
            "可能是双页扫描 / 原书页码 / 每页跳号，不建议采用。"
        )
    if consistency < 0.8:
        notes.append(
            f"只有 {consistency:.0%} 的相邻页满足「页码差 = PDF 页差」，数值不像连续页码。"
        )
    reliable = coverage >= 5 and spread <= OFFSET_TOLERANCE and consistency >= 0.8
    if reliable:
        notes.append(f"偏移稳定（{offsets[0]:+d} 页），相邻页页码连续。")
    return reliable, tuple(notes), spread


def _make_template(
    band: str,
    mode: str,
    centers: dict[str, tuple[float, float]],
    values: dict[int, str],
    *,
    parity_basis: str,
) -> Template:
    coverage = len(values)
    reliable, notes, _ = _template_reliability(values, coverage)
    label = _template_label(band, centers, mode)
    sample_pages = tuple(sorted(values)[: min(5, coverage)])
    payload = json.dumps(
        {
            "band": band,
            "mode": mode,
            "label": label,
            "centers": {name: [round(x, 4), round(y, 4)] for name, (x, y) in centers.items()},
        },
        sort_keys=True,
        ensure_ascii=False,
    )
    template_id = "tpl_" + hashlib.sha1(payload.encode("utf-8")).hexdigest()[:10]
    return Template(
        template_id=template_id,
        band=band,
        label=label,
        mode=mode,
        centers=centers,
        parity_basis=parity_basis,
        coverage=coverage,
        sample_pages=sample_pages,
        values=tuple(
            {"page_no": str(page), "value": value}
            for page, value in sorted(values.items())
        ),
        reliable=reliable,
        notes=notes,
        tolerance={"x": MATCH_TOLERANCE_X, "y": MATCH_TOLERANCE_Y},
    )


def build_templates(
    candidates: dict[int, list[Candidate]], pages: list[library_module.Page]
) -> list[Template]:
    """把候选聚成位置模板（纯函数，测试不必建整本书）。"""
    page_by_no = {page.page_no: page for page in pages}
    all_candidates = [item for items in candidates.values() for item in items]
    clusters = [
        cluster for cluster in _cluster(all_candidates) if len(cluster.pages) >= MIN_TEMPLATE_PAGES
    ]
    templates: list[Template] = []
    used: set[int] = set()

    # 1) 同一带里"奇数页一个位置、偶数页另一个位置"的两个簇 → 奇偶交替模板
    for i, first in enumerate(clusters):
        if i in used:
            continue
        for j in range(i + 1, len(clusters)):
            second = clusters[j]
            if j in used or first.band != second.band:
                continue
            if abs(first.y - second.y) > MAX_ALTERNATE_DY:
                continue
            pair_pages = [
                page_by_no[no] for no in sorted(set(first.pages) | set(second.pages))
                if no in page_by_no
            ]
            if len(pair_pages) < MIN_ALTERNATE_PAGES * 2:
                continue
            basis = _parity_basis(pair_pages)
            first_parities = [
                _page_parity(page_by_no[no], basis)
                for no in first.pages
                if no in page_by_no
            ]
            second_parities = [
                _page_parity(page_by_no[no], basis)
                for no in second.pages
                if no in page_by_no
            ]
            if not first_parities or not second_parities:
                continue
            first_odd = sum(first_parities) / len(first_parities) >= 0.8
            first_even = 1 - sum(first_parities) / len(first_parities) >= 0.8
            second_odd = sum(second_parities) / len(second_parities) >= 0.8
            second_even = 1 - sum(second_parities) / len(second_parities) >= 0.8
            if not ((first_odd and second_even) or (first_even and second_odd)):
                continue
            odd_cluster = first if first_odd else second
            even_cluster = second if first_odd else first
            odd_values, odd_ambiguous = _cluster_values(odd_cluster)
            even_values, even_ambiguous = _cluster_values(even_cluster)
            values = {**odd_values, **even_values}
            ambiguous = set(odd_ambiguous) | set(even_ambiguous)
            values = {page: value for page, value in values.items() if page not in ambiguous}
            template = _make_template(
                first.band,
                MODE_ALTERNATE,
                {
                    "odd": (odd_cluster.x, odd_cluster.y),
                    "even": (even_cluster.x, even_cluster.y),
                },
                values,
                parity_basis=basis,
            )
            templates.append(template)
            used.update({i, j})
            break

    # 2) 剩下的单簇 → "全部页"模板
    for index, cluster in enumerate(clusters):
        if index in used:
            continue
        values, ambiguous = _cluster_values(cluster)
        values = {page: value for page, value in values.items() if page not in ambiguous}
        basis = _parity_basis([page_by_no[no] for no in cluster.pages if no in page_by_no])
        templates.append(
            _make_template(cluster.band, MODE_ALL, {"all": (cluster.x, cluster.y)}, values, parity_basis=basis)
        )

    # 覆盖页多的排前面；同覆盖时可靠的优先
    templates.sort(key=lambda item: (-item.coverage, not item.reliable, item.label))
    return templates[:MAX_TEMPLATES]


# ---------------------------------------------------------------- 模板匹配

def _template_centers(template: dict[str, object]) -> dict[str, tuple[float, float]]:
    raw = template.get("centers") or {}
    if not isinstance(raw, dict):
        raise PageNumberError("模板的 centers 必须是一个对象")
    centers: dict[str, tuple[float, float]] = {}
    for name, value in raw.items():
        if not isinstance(value, (list, tuple)) or len(value) != 2:
            raise PageNumberError(f"模板的中心 {name} 必须是两个数：x、y")
        try:
            x, y = float(value[0]), float(value[1])
        except (TypeError, ValueError) as exc:
            raise PageNumberError(f"模板的中心 {name} 不是数字") from exc
        if not (0 <= x <= 1 and 0 <= y <= 1):
            raise PageNumberError(f"模板的中心 {name} 必须在 0–1 之间")
        centers[name] = (x, y)
    return centers


def normalize_template(raw: dict[str, object]) -> dict[str, object]:
    """校验并规整一个模板（接口收到的 JSON）。"""
    if not isinstance(raw, dict):
        raise PageNumberError("模板必须是一个对象")
    band = raw.get("band")
    if band not in BAND_LABELS:
        raise PageNumberError(f"未知的页码位置带：{band!r}（可选 {' / '.join(BAND_LABELS)}）")
    mode = raw.get("mode")
    if mode not in (MODE_ALL, MODE_ALTERNATE):
        raise PageNumberError(f"未知的奇偶模式：{mode!r}（可选 all / alternate）")
    centers = _template_centers(raw)
    if mode == MODE_ALL and "all" not in centers:
        raise PageNumberError("全部页模板必须给出 all 中心")
    if mode == MODE_ALTERNATE and not ({"odd", "even"} <= set(centers)):
        raise PageNumberError("奇偶交替模板必须给出 odd / even 两个中心")
    parity_basis = raw.get("parity_basis") or "pdf"
    if parity_basis not in ("printed", "pdf"):
        parity_basis = "pdf"
    tolerance = raw.get("tolerance") or {}
    tx = float(tolerance.get("x", MATCH_TOLERANCE_X)) if isinstance(tolerance, dict) else MATCH_TOLERANCE_X
    ty = float(tolerance.get("y", MATCH_TOLERANCE_Y)) if isinstance(tolerance, dict) else MATCH_TOLERANCE_Y
    return {
        "schema": TEMPLATE_SCHEMA,
        "template_id": str(raw.get("template_id") or ""),
        "band": band,
        "mode": mode,
        "centers": {name: [x, y] for name, (x, y) in centers.items()},
        "parity_basis": parity_basis,
        "tolerance": {
            "x": min(max(tx, 0.01), 0.2),
            "y": min(max(ty, 0.01), 0.2),
        },
        "label": str(raw.get("label") or ""),
    }


def _match_page(
    page: library_module.Page,
    candidates: list[Candidate],
    template: dict[str, object],
) -> tuple[str | None, str, list[dict[str, object]]]:
    """一页按模板取页码；返回 (value, 状态, 候选)。状态：ok / none / ambiguous。"""
    centers = _template_centers(template)
    if template.get("mode") == MODE_ALTERNATE:
        basis = str(template.get("parity_basis") or "pdf")
        parity = _page_parity(page, basis)
        center = centers.get("odd" if parity == 1 else "even")
    else:
        center = centers.get("all")
    if center is None:
        return None, "none", []
    tolerance = template.get("tolerance") or {}
    tx = float(tolerance.get("x", MATCH_TOLERANCE_X))  # type: ignore[union-attr]
    ty = float(tolerance.get("y", MATCH_TOLERANCE_Y))  # type: ignore[union-attr]
    matched = [
        item
        for item in candidates
        if abs(item.x - center[0]) <= tx and abs(item.y - center[1]) <= ty
    ]
    values = {item.value for item in matched}
    details = [item.to_dict() for item in matched]
    if not matched:
        return None, "none", details
    if len(values) > 1:
        return None, "ambiguous", details
    return matched[0].value, "ok", details


# ---------------------------------------------------------------- 校验

def _anomaly(page_no: int, value: str | None, reason: str, **extra) -> dict[str, object]:
    item: dict[str, object] = {"page_no": page_no, "value": value, "reason": reason}
    item.update(extra)
    return item


def validate_mapping(
    pages: list[library_module.Page],
    printed: dict[int, tuple[str, str | None]],
    *,
    recognized_pages: set[int],
    ambiguous: dict[int, list[dict[str, object]]] | None = None,
    no_candidate: dict[int, list[dict[str, object]]] | None = None,
) -> dict[str, object]:
    """对已填页码做数值校验；返回异常分组与未识别页。"""
    ambiguous = ambiguous or {}
    no_candidate = no_candidate or {}
    anomalies: dict[str, list[dict[str, object]]] = {
        "no_candidate": [],
        "ambiguous": [],
        "jump": [],
        "offset_break": [],
        "duplicate": [],
    }
    for page_no, details in sorted(no_candidate.items()):
        anomalies["no_candidate"].append(
            _anomaly(page_no, None, "这一页没有落在模板位置上的页码候选", candidates=details)
        )
    for page_no, details in sorted(ambiguous.items()):
        values = sorted({str(item["value"]) for item in details})
        anomalies["ambiguous"].append(
            _anomaly(
                page_no,
                None,
                f"这一页在模板位置有多个不同候选：{' / '.join(values)}（不猜，留空）",
                candidates=details,
            )
        )

    numbered = []
    for page_no, (value, _source) in sorted(printed.items()):
        number = page_number_number(value)
        if number is not None:
            numbered.append((page_no, number, value))
    offsets = {page: number - page for page, number, _ in numbered}
    dominant = statistics.median(offsets.values()) if offsets else 0
    deviant = {
        page for page, offset in offsets.items() if abs(offset - dominant) > OFFSET_TOLERANCE
    }
    for page, number, value in numbered:
        if page in deviant:
            anomalies["offset_break"].append(
                _anomaly(
                    page,
                    value,
                    f"印刷页码与 PDF 页号的偏移是 {offsets[page]:+d}，"
                    f"全书主导偏移是 {dominant:+.0f}，偏离超过 {OFFSET_TOLERANCE:.0f} 页",
                )
            )
    jump_pages: set[int] = set()
    for (page_a, number_a, _), (page_b, number_b, _) in zip(numbered, numbered[1:]):
        if number_b - number_a == page_b - page_a:
            continue
        if page_b in deviant:
            jump_pages.add(page_b)
        elif page_a in deviant:
            jump_pages.add(page_a)
        else:
            jump_pages.add(page_b)
    for page in sorted(jump_pages):
        value = printed.get(page, (None, None))[0]
        anomalies["jump"].append(
            _anomaly(
                page,
                value,
                "页码与相邻页不连续（按 PDF 页差推算，这一页接不上）",
            )
        )

    # 一致性：两页映射到同一个印刷页码 → 警告（不自动改值，只推给人）
    by_value: dict[tuple[str, object], list[tuple[int, str]]] = {}
    for page_no, (value, _source) in sorted(printed.items()):
        number = page_number_number(value)
        key = ("number", number) if number is not None else ("text", value.upper())
        by_value.setdefault(key, []).append((page_no, value))
    for items in by_value.values():
        if len(items) < 2:
            continue
        page_nos = [page_no for page_no, _ in items]
        for page_no, value in items:
            others = [other for other in page_nos if other != page_no]
            anomalies["duplicate"].append(
                _anomaly(
                    page_no,
                    value,
                    f"与第 {'、'.join(str(other) for other in others)} 页映射到同一个印刷页码 {value}",
                    others=others,
                )
            )

    not_recognized = [
        {"page_no": page.page_no}
        for page in sorted(pages, key=lambda item: item.page_no)
        if page.page_no not in recognized_pages
    ]
    return {
        "anomalies": anomalies,
        "not_recognized": {
            "count": len(not_recognized),
            "pages": [item["page_no"] for item in not_recognized],
        },
        "counts": {
            "total": len(pages),
            "filled": sum(1 for page in pages if page.page_no in printed),
            "no_candidate": len(anomalies["no_candidate"]),
            "ambiguous": len(anomalies["ambiguous"]),
            "jump": len(anomalies["jump"]),
            "offset_break": len(anomalies["offset_break"]),
            "duplicate": len(anomalies["duplicate"]),
            "not_recognized": len(not_recognized),
        },
    }


# ---------------------------------------------------------------- 读写

def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def template_label(template: dict[str, object] | None) -> str:
    if not template:
        return "未采用模板"
    return str(template.get("label") or "未命名模板")


def _range_for(page_no: int, ranges: list[dict[str, object]]) -> dict[str, object] | None:
    for item in ranges:
        if int(item["from_page"]) <= page_no <= int(item["to_page"]):
            return item
    return None


def effective_template(
    page_no: int,
    default: dict[str, object] | None,
    ranges: list[dict[str, object]],
) -> dict[str, object] | None:
    """这一页实际用哪套模板：手动值优先（调用方跳过），其次范围模板，最后默认模板。"""
    item = _range_for(page_no, ranges)
    if item is not None:
        template = item.get("template")
        return template if isinstance(template, dict) else None
    return default


def normalize_range(
    raw: dict[str, object],
    template: dict[str, object],
    total_pages: int,
) -> dict[str, object]:
    """校验一段页码范围（含边界），返回可存库的范围记录。"""
    if not isinstance(raw, dict):
        raise PageNumberError("页码范围必须是一个对象")
    try:
        start = int(raw.get("from_page"))
        end = int(raw.get("to_page"))
    except (TypeError, ValueError) as exc:
        raise PageNumberError("页码范围的起止必须是整数") from exc
    if not 1 <= start <= end <= total_pages:
        raise PageNumberError(
            f"页码范围必须在 1–{total_pages} 之间，且起始 ≤ 结束（收到 {start}–{end}）"
        )
    return {
        "from_page": start,
        "to_page": end,
        "template": dict(template),
        "created_at": _now(),
    }


def _overlaps(a: dict[str, object], b: dict[str, object]) -> bool:
    return int(a["from_page"]) <= int(b["to_page"]) and int(b["from_page"]) <= int(a["to_page"])


def _assignment_segments(
    default: dict[str, object] | None,
    ranges: list[dict[str, object]],
    total_pages: int,
) -> list[dict[str, object]]:
    """把"哪几页用哪个模板"展开成互不重叠的段，供界面直接显示。"""
    segments: list[dict[str, object]] = []
    cursor = 1
    for item in sorted(ranges, key=lambda entry: int(entry["from_page"])):
        start = int(item["from_page"])
        if default is not None and cursor < start:
            segments.append(
                {
                    "from_page": cursor,
                    "to_page": start - 1,
                    "kind": "default",
                    "label": template_label(default),
                }
            )
        segments.append(
            {
                "from_page": start,
                "to_page": int(item["to_page"]),
                "kind": "range",
                "label": template_label(item.get("template")),
            }
        )
        cursor = int(item["to_page"]) + 1
    if default is not None and cursor <= total_pages:
        segments.append(
            {
                "from_page": cursor,
                "to_page": total_pages,
                "kind": "default",
                "label": template_label(default),
            }
        )
    return segments


def _recompute_pages(
    conn,
    pages: list[library_module.Page],
    candidates: dict[int, list[Candidate]],
    *,
    default: dict[str, object] | None,
    ranges: list[dict[str, object]],
    recognized_pages: set[int],
) -> int:
    """按"手动 > 范围 > 默认"重算所有模板页；手动值一个都不动。"""
    filled = 0
    for page in pages:
        if page.printed_page_source == SOURCE_MANUAL:
            continue
        if page.page_no not in recognized_pages:
            if page.printed_page_source == SOURCE_TEMPLATE:
                conn.execute(
                    "UPDATE page SET printed_page = NULL, printed_page_source = NULL"
                    " WHERE page_no = ?",
                    (page.page_no,),
                )
            continue
        template = effective_template(page.page_no, default, ranges)
        if template is None:
            if page.printed_page_source == SOURCE_TEMPLATE:
                conn.execute(
                    "UPDATE page SET printed_page = NULL, printed_page_source = NULL"
                    " WHERE page_no = ?",
                    (page.page_no,),
                )
            continue
        value, status, _details = _match_page(
            page, candidates.get(page.page_no, []), template
        )
        if value is not None and status == "ok":
            conn.execute(
                "UPDATE page SET printed_page = ?, printed_page_source = ? WHERE page_no = ?",
                (value, SOURCE_TEMPLATE, page.page_no),
            )
            filled += 1
        else:
            conn.execute(
                "UPDATE page SET printed_page = NULL, printed_page_source = NULL"
                " WHERE page_no = ?",
                (page.page_no,),
            )
    return filled


def analyze(project_id: str, *, library: Path | None = None) -> dict[str, object]:
    """只读分析：候选模板 + 当前映射 + 页码范围 + 异常分组。"""
    target_library = library if library is not None else library_module.default_library_dir()
    project = library_module.load_project(project_id, library=target_library)
    candidates, pages, meta = collect_candidates(project_id, library=target_library)
    templates = build_templates(candidates, pages)
    states = meta["states"]
    recognized_pages = {
        page.page_no
        for page in pages
        if (state := states.get(page.page_id)) is not None
        and state.status in (blocks_module.STATUS_RECOGNIZED, blocks_module.STATUS_HAS_CANDIDATE)
    }

    default = project.page_number_template
    ranges = [dict(item) for item in project.page_number_ranges]
    printed: dict[int, tuple[str, str | None]] = {
        page.page_no: (page.printed_page, page.printed_page_source)
        for page in pages
        if page.printed_page
    }

    ambiguous: dict[int, list[dict[str, object]]] = {}
    no_candidate: dict[int, list[dict[str, object]]] = {}
    for page in pages:
        if page.page_no not in recognized_pages or page.page_no in printed:
            continue
        template = effective_template(page.page_no, default, ranges)
        if template:
            value, status, details = _match_page(
                page, candidates.get(page.page_no, []), template
            )
            if status == "ambiguous":
                ambiguous[page.page_no] = details
            elif value is None:
                no_candidate[page.page_no] = details
        else:
            no_candidate[page.page_no] = [
                item.to_dict() for item in candidates.get(page.page_no, [])
            ]

    validation = validate_mapping(
        pages,
        printed,
        recognized_pages=recognized_pages,
        ambiguous=ambiguous,
        no_candidate=no_candidate,
    )
    validation["counts"]["manual"] = sum(
        1 for page in pages if page.printed_page_source == SOURCE_MANUAL
    )
    return {
        "templates": [template.to_dict() for template in templates],
        "current": {
            # 兼容字段：默认模板
            "template": default,
            "default_template": default,
            "ranges": ranges,
            "assignments": _assignment_segments(default, ranges, len(pages)),
            "filled": validation["counts"]["filled"],
            "total": validation["counts"]["total"],
            "mapping": [
                {
                    "page_no": page.page_no,
                    "printed_page": page.printed_page,
                    "source": page.printed_page_source,
                }
                for page in pages
                if page.printed_page
            ],
            **validation,
        },
    }


def apply_template(
    project_id: str,
    template_payload: dict[str, object],
    *,
    range_payload: dict[str, object] | None = None,
    library: Path | None = None,
) -> dict[str, object]:
    """采用一个模板：整本作为默认，或给一段页码范围作为第二套。

    **重算规则**：手动页永远跳过；页码范围内的页用范围模板，其余页用默认模板；
    范围之间、范围与默认之间互不重叠（范围由这里校验）。
    """
    target_library = library if library is not None else library_module.default_library_dir()
    template = normalize_template(template_payload)
    project = library_module.load_project(project_id, library=target_library)
    pages = library_module.list_pages(project_id, library=target_library)
    default = project.page_number_template
    ranges = [dict(item) for item in project.page_number_ranges]

    if range_payload is not None:
        new_range = normalize_range(range_payload, template, len(pages))
        for index, existing in enumerate(ranges):
            if _overlaps(new_range, existing):
                if (
                    int(existing["from_page"]) == int(new_range["from_page"])
                    and int(existing["to_page"]) == int(new_range["to_page"])
                ):
                    ranges[index] = new_range  # 同一段重设：替换
                    break
                raise PageNumberError(
                    "页码范围与已有范围重叠："
                    f"已有 {existing['from_page']}–{existing['to_page']}，"
                    f"新的 {new_range['from_page']}–{new_range['to_page']}。"
                    "一页只能命中一套模板。"
                )
        else:
            ranges.append(new_range)
        ranges.sort(key=lambda item: int(item["from_page"]))
    else:
        default = template

    candidates, pages, meta = collect_candidates(project_id, library=target_library)
    recognized_pages = {
        page.page_no
        for page in pages
        if (state := meta["states"].get(page.page_id)) is not None
        and state.status in (blocks_module.STATUS_RECOGNIZED, blocks_module.STATUS_HAS_CANDIDATE)
    }
    now = _now()
    directory = library_module.require_project_dir(project_id, library=target_library)
    with db_module.open_database(directory) as conn:
        filled = _recompute_pages(
            conn,
            pages,
            candidates,
            default=default,
            ranges=ranges,
            recognized_pages=recognized_pages,
        )
        if default is not None:
            stored = dict(default)
            stored["applied_at"] = now
            default = stored
        conn.execute(
            "UPDATE project SET page_number_template = ?, page_number_ranges = ?, updated_at = ?",
            (
                json.dumps(default, ensure_ascii=False) if default is not None else None,
                json.dumps(ranges, ensure_ascii=False) if ranges else None,
                now,
            ),
        )
        conn.commit()

    result = analyze(project_id, library=target_library)
    result["applied"] = {
        "filled": filled,
        "applied_at": now,
        "template": template,
        "range": range_payload,
    }
    return result


def remove_range(
    project_id: str,
    *,
    from_page: int,
    to_page: int,
    library: Path | None = None,
) -> dict[str, object]:
    """移除一段页码范围模板，并按默认模板重算那些页（手动页不动）。"""
    target_library = library if library is not None else library_module.default_library_dir()
    project = library_module.load_project(project_id, library=target_library)
    pages = library_module.list_pages(project_id, library=target_library)
    default = project.page_number_template
    ranges = [
        dict(item)
        for item in project.page_number_ranges
        if not (
            int(item["from_page"]) == int(from_page)
            and int(item["to_page"]) == int(to_page)
        )
    ]
    if len(ranges) == len(project.page_number_ranges):
        raise PageNumberError(f"没有 {from_page}–{to_page} 这一段页码范围")

    candidates, pages, meta = collect_candidates(project_id, library=target_library)
    recognized_pages = {
        page.page_no
        for page in pages
        if (state := meta["states"].get(page.page_id)) is not None
        and state.status in (blocks_module.STATUS_RECOGNIZED, blocks_module.STATUS_HAS_CANDIDATE)
    }
    directory = library_module.require_project_dir(project_id, library=target_library)
    now = _now()
    with db_module.open_database(directory) as conn:
        _recompute_pages(
            conn,
            pages,
            candidates,
            default=default,
            ranges=ranges,
            recognized_pages=recognized_pages,
        )
        conn.execute(
            "UPDATE project SET page_number_ranges = ?, updated_at = ?",
            (json.dumps(ranges, ensure_ascii=False) if ranges else None, now),
        )
        conn.commit()
    return analyze(project_id, library=target_library)


def set_manual_page(
    project_id: str,
    page_no: int,
    printed_page: str | None,
    *,
    library: Path | None = None,
) -> dict[str, object]:
    """逐页手动改映射：写 `printed_page_source = manual`，后续模板重算不覆盖。"""
    target_library = library if library is not None else library_module.default_library_dir()
    directory = library_module.require_project_dir(project_id, library=target_library)
    pages = {page.page_no: page for page in library_module.list_pages(project_id, library=target_library)}
    if page_no not in pages:
        raise PageNumberError(f"没有第 {page_no} 页")
    text = (printed_page or "").strip()
    if not text:
        value = None
    else:
        value = regions.canonical_page_value(text)
        if value is None:
            raise PageNumberError(
                "印刷页码只能是规范阿拉伯数字（≤4 位）或罗马数字（≤100），"
                "清空则取消这一页的手动映射。"
            )
    with db_module.open_database(directory) as conn:
        conn.execute(
            "UPDATE page SET printed_page = ?, printed_page_source = ? WHERE page_no = ?",
            (value, SOURCE_MANUAL if value is not None else None, page_no),
        )
        conn.execute("UPDATE project SET updated_at = ?", (_now(),))
        conn.commit()
    if value is None:
        # 取消手动值后，这一页应该能被模板重新填上（手动页在上面的重算里会跳过）。
        project = library_module.load_project(project_id, library=target_library)
        candidates, pages, meta = collect_candidates(project_id, library=target_library)
        recognized_pages = {
            page.page_no
            for page in pages
            if (state := meta["states"].get(page.page_id)) is not None
            and state.status
            in (blocks_module.STATUS_RECOGNIZED, blocks_module.STATUS_HAS_CANDIDATE)
        }
        with db_module.open_database(directory) as conn:
            _recompute_pages(
                conn,
                pages,
                candidates,
                default=project.page_number_template,
                ranges=[dict(item) for item in project.page_number_ranges],
                recognized_pages=recognized_pages,
            )
            conn.commit()
    return analyze(project_id, library=target_library)


def page_number_state(project_id: str, *, library: Path | None = None) -> dict[str, object]:
    """右栏摘要用的小接口（不跑聚类，避免每次打开项目都算一遍）。"""
    project = library_module.load_project(project_id, library=library)
    pages = library_module.list_pages(project_id, library=library)
    filled = sum(1 for page in pages if page.printed_page)
    manual = sum(1 for page in pages if page.printed_page_source == SOURCE_MANUAL)
    return {
        "template": project.page_number_template,
        "ranges": project.page_number_ranges,
        "filled": filled,
        "manual": manual,
        "total": len(pages),
    }
