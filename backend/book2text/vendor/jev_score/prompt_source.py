"""提示词模板的**唯一来源**（从上游 `infer_vllm.py` 原样抄来，见 NOTICE.md 第 4 处改动）。

为什么单独抄一份：上游把这几行放在 `infer_vllm.py` 里，而那个文件顺带 import 了渲染器
（Chromium / Node）。打分层只需要**模板本体 + 指纹**，不该把渲染器拖进应用。
这里的每一行都与上游逐字相同，`PROMPT_TEMPLATE_MD5` 在 import 时自检——模板一改就炸，
而不是悄悄把所有分数挪一个刻度。
"""

from __future__ import annotations

import hashlib

IMAGE_PLACEHOLDER = "<|vision_start|><|image_pad|><|vision_end|>"

INSTRUCTION = (
    "第一张图是原图，第二张图是上述 OCR 文本渲染得到的图片。\n"
    "请判断该 OCR 文本及其对应渲染图是否与原图内容一致。\n"
    "这是一个二分类任务：一致标为 1，不一致标为 0。"
)

#: The empty assistant turn the training framework appends for a sequence
#: classifier. It is what the value head actually reads.
ASSISTANT_SUFFIX = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"

PROMPT_TEMPLATE_MD5 = "9aab68e8ba8ab4da17ba9752bddb199c"

#: 两张图：原图 + 候选文本渲染图。
IMAGES_PER_PROMPT = 2

#: Qwen3.5-VL 拒绝极端长宽比（>200:1）。文档行图常常又宽又矮，超出就补白边而不是缩放
#: ——补白保留字迹尺度，缩放会改变模型用来比对的字号。逐字同上游 `infer_vllm.MAX_ASPECT_RATIO`。
MAX_ASPECT_RATIO = 199.0


def build_prompt(text: str) -> str:
    """Assemble the raw prompt string for one candidate."""
    return (
        f"<|im_start|>user\n"
        f"{IMAGE_PLACEHOLDER}\n"
        f"OCR文本：\n{text}\n"
        f"{IMAGE_PLACEHOLDER}\n"
        f"{INSTRUCTION}"
        f"{ASSISTANT_SUFFIX}"
    )


def _assert_prompt_unchanged() -> None:
    fingerprint = hashlib.md5(build_prompt("{text}").encode("utf-8")).hexdigest()
    if fingerprint != PROMPT_TEMPLATE_MD5:
        raise RuntimeError(
            "The prompt template has been modified. Scores produced with a modified "
            f"template are not comparable to published ones.\n"
            f"  expected md5 {PROMPT_TEMPLATE_MD5}\n  got      md5 {fingerprint}\n"
            "If the change is deliberate, update PROMPT_TEMPLATE_MD5."
        )


_assert_prompt_unchanged()
