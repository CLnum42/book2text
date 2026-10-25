"""版面检测（只检测不识别）。

对应 `docs/workflow.md` 的阶段 2：产出每页的文字行框，不产生任何文本。
入口：

- `create_layout_job()`：校验页面、锁、引擎可用性，建任务（服务进程）；
- `run_layout_job()`：在子进程里逐页检测并落库（`book2text.worker` 调它）。

任务复用现有 `job` / `job_item` / `Supervisor`，所以暂停 / 继续 / 取消 /
重试失败页 / 中断恢复全部照旧。
"""

from . import detection

__all__ = ["detection"]
