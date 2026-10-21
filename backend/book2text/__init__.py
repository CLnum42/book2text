"""Book2Text —— 本地网页应用：把没有文本层的扫描版 PDF 图书转成可追溯、经人工审校的结构化文本。

当前为 **0.1.0（第一个可用完整版）**：

- 识别跑在子进程任务里：批量、进度、暂停 / 继续 / 取消、重试失败页、中断恢复；
- 审校能改字与改结构、能采用新识别结果，第二引擎（Apple Vision）的分歧能逐行标出；
- 导出写进项目的 ``exports/``（TXT / JSONL + manifest）；
- 审校任务包能分派、回传、合并；macOS 打包已实测。

仍未完成或未验证的事项（Windows 打包、Phase 3 界面余项、Phase 0 的
PaddleOCR / 版面组件对比等）见 ``docs/known-limitations.md``，不在此重复。
"""

__version__ = "0.1.0"
