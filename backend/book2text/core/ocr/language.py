"""按页判定识别语言（任务 64）。

用户拍板：**以后一律用第二引擎（Apple Vision）识别，不用文字层**。Vision 的语言
必须按页给——实测同一本双语书里，英文页开中文模型时撇号和 `I` 大量出错
（F1 0.47），只开 en-US 是 0.90；中文页反过来。

判定只看**主引擎识别出来的正文文本**（不是页面图像、也不是用户设置）：

- CJK（汉字）字数与拉丁字母数的比例；
- 拉丁占绝对多（≥ 0.9 的字母是拉丁）→ `en-US`；
- CJK 占绝对多（≥ 0.9）→ `zh-Hans`；
- 中间地带 → `mixed`（两个模型都开，Vision 自己选）。

这本书实测中文页 218 / 英文页 218、没有一个混合页，所以在这本书上就是干净的一分为二。
判错代价大（0.47 vs 0.90），所以结果**落到 `page.ocr_language`**，界面可查可覆盖。
"""

from __future__ import annotations

ZH = "zh-Hans"
EN = "en-US"
MIXED = "mixed"

#: 一个方向占到 90% 就认为"单语页"；更均衡时两个模型都开
DOMINANCE = 0.9
#: 太短的文本判不出来（一行两个字不足以下结论），返回 None 让调用方用项目设置
MIN_LETTERS = 12


def count_script(text: str) -> tuple[int, int]:
    """返回 (CJK 字数, 拉丁字母数)。"""
    cjk = latin = 0
    for char in text or "":
        code = ord(char)
        if (
            0x4E00 <= code <= 0x9FFF
            or 0x3400 <= code <= 0x4DBF
            or 0xF900 <= code <= 0xFAFF
            or 0x3040 <= code <= 0x30FF
        ):
            cjk += 1
        elif char.isascii() and char.isalpha():
            latin += 1
    return cjk, latin


def detect(text: str) -> str | None:
    """正文文本 → `zh-Hans` / `en-US` / `mixed`；判不出来返回 None。"""
    cjk, latin = count_script(text)
    total = cjk + latin
    if total < MIN_LETTERS:
        return None
    if cjk <= 1:
        return EN
    if latin <= 1:
        return ZH
    ratio = latin / total
    if ratio >= DOMINANCE:
        return EN
    if ratio <= 1 - DOMINANCE:
        return ZH
    return MIXED


def vision_language_set(language: str) -> tuple[str, ...]:
    """`page.ocr_language` → Vision 的 BCP-47 列表。"""
    if language == EN:
        return (EN,)
    if language == ZH:
        return (ZH,)
    return (ZH, EN)


def label(language: str | None) -> str:
    return {ZH: "中文 zh-Hans", EN: "英文 en-US", MIXED: "中英混合"}.get(
        language or "", "自动（按页判断）"
    )
