"""FastAPI 应用装配。

令牌与允许的 Origin 由启动入口传入（每次启动都会变），因此这里做成工厂函数，
便于测试时传入固定值。
"""

from __future__ import annotations

import os
import time
from collections.abc import AsyncIterator, Sequence
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from .. import __version__, paths
from ..core.project import executor as executor_module
from ..core.project import jev_health as jev_health_module
from ..core.project import jobs as jobs_module
from ..core.project import lock as lock_module
from ..core.project.library import default_library_dir
from . import (
    errors,
    routes_app,
    routes_aux,
    routes_backups,
    routes_exports,
    routes_jobs,
    routes_jev,
    routes_layout,
    routes_margin,
    routes_page_numbers,
    routes_projects,
    routes_review,
    routes_review_status,
    routes_cleanup,
    routes_collab,
    routes_packages,
    routes_structure,
    routes_trash,
    routes_word_boxes,
    security,
)


REVALIDATE = "no-cache"
"""界面资源一律"每次回源确认"。

本地应用是**就地更新**的（换掉 `static/` 下的文件就是升级），而"界面"由三份文件组成：
`index.html` / `app.css` / `app.js`。只要其中一份来自缓存、另一份是新拉取的，页面就会
半新半旧——2026-10-15 实际发生过一次：浏览器缓存着旧 `app.js`，配上新 `index.html` 后
项目库照旧渲染，点"新建项目"报 `Cannot set properties of null (setting 'hidden')`，
用户只能强制刷新才好（因为旧脚本里引用的节点在新页面里已经没有了）。

`no-cache` 不是"不缓存"，而是"用之前回源确认"：文件没变时服务端回 304（有 ETag /
Last-Modified 兜底），代价可以忽略；文件变了就一定会拿到新的。
"""


class _RevalidatingStaticFiles(StaticFiles):
    """给 `/static` 下的每个响应加 `Cache-Control: no-cache`（见 `REVALIDATE`）。"""

    def file_response(self, *args: object, **kwargs: object) -> Response:
        response = super().file_response(*args, **kwargs)  # type: ignore[arg-type]
        response.headers.setdefault("Cache-Control", REVALIDATE)
        return response
def create_app(
    *,
    session_token: str,
    origins: Sequence[str],
    library_dir: Path | None = None,
) -> FastAPI:
    supervisor = executor_module.Supervisor()
    library = Path(library_dir) if library_dir else default_library_dir()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        # 启动先扫一遍库：清掉**本机死进程**留下的锁（应用被强杀 / 重启后的残留）。
        # 只清本机的，别的电脑的锁要用户确认——见 `core/project/lock.py` 开头那张表。
        app.state.stale_locks = lock_module.clean_stale_locks(library)
        yield
        # Jev：先停打分层（它连着引擎），再停引擎；引擎常驻 3 GB，不能留给下一次启动
        try:
            app.state.jev_runtime.stop()
        finally:
            _shutdown_running_jobs(supervisor)
            lock_module.release_all()

    app = FastAPI(
        title="Book2Text",
        version=__version__,
        lifespan=lifespan,
        # 所有 /api 路由都要求令牌，浏览器的交互式文档页无法带自定义请求头，
        # 因此不挂 /docs；只保留 OpenAPI 描述，可用 curl 带令牌取得。
        # 该描述不含任何项目数据，且跨站读取会被浏览器 CORS 拦下。
        docs_url=None,
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )

    app.state.session_token = session_token
    app.state.allowed_origins = frozenset(origins)
    # 项目库目录：缺省为用户「文稿 / 文档」下的 Book2Text（说明书 12.1）
    app.state.library_dir = library
    # 识别子进程的执行器：本实例起过的任务进程都登记在它这里
    app.state.job_supervisor = supervisor
    # 审校的撤销 / 重做栈：只活在本次运行里（说明书 5.3）
    app.state.review_history = routes_review.ReviewHistory()
    # Jev 的家当：构造不启动任何进程，第一次用（进审校 / 点打分）才懒启动
    app.state.jev_runtime = jev_health_module.JevRuntime()

    # 排查首屏卡顿用的请求计时（`B2T_TIME_REQUESTS=1` 时开）。
    # 只看 /api，输出到标准输出；默认关闭，生产路径没有任何额外开销。
    if os.environ.get("B2T_TIME_REQUESTS"):

        @app.middleware("http")
        async def _timing(request, call_next):  # type: ignore[no-untyped-def]
            started = time.perf_counter()
            response = await call_next(request)
            elapsed = (time.perf_counter() - started) * 1000
            if request.url.path.startswith("/api/"):
                query = f"?{request.url.query}" if request.url.query else ""
                print(
                    f"[timing] {elapsed:8.1f} ms  {request.method} {request.url.path}{query}",
                    flush=True,
                )
            return response

    app.add_exception_handler(errors.AppError, errors.app_error_handler)
    app.add_exception_handler(StarletteHTTPException, errors.http_exception_handler)
    app.add_exception_handler(
        RequestValidationError, errors.validation_exception_handler
    )
    app.add_exception_handler(Exception, errors.unhandled_exception_handler)

    # 令牌与 Origin 校验挂成依赖而不是中间件：中间件会缓冲请求体，
    # 会破坏上传接口的流式读取。
    guarded = [Depends(security.verify_local_request)]
    app.include_router(routes_app.router, dependencies=guarded)
    app.include_router(routes_aux.router, dependencies=guarded)
    app.include_router(routes_backups.router, dependencies=guarded)
    app.include_router(routes_projects.router, dependencies=guarded)
    app.include_router(routes_trash.router, dependencies=guarded)
    app.include_router(routes_margin.router, dependencies=guarded)
    app.include_router(routes_page_numbers.router, dependencies=guarded)
    app.include_router(routes_word_boxes.router, dependencies=guarded)
    app.include_router(routes_jobs.router, dependencies=guarded)
    app.include_router(routes_jev.router, dependencies=guarded)
    app.include_router(routes_layout.router, dependencies=guarded)
    app.include_router(routes_review.router, dependencies=guarded)
    app.include_router(routes_review_status.router, dependencies=guarded)
    app.include_router(routes_exports.router, dependencies=guarded)
    app.include_router(routes_structure.router, dependencies=guarded)
    app.include_router(routes_cleanup.router, dependencies=guarded)
    app.include_router(routes_collab.router, dependencies=guarded)
    app.include_router(routes_packages.router, dependencies=guarded)

    app.mount("/static", _RevalidatingStaticFiles(directory=paths.STATIC_DIR), name="static")

    @app.get("/", include_in_schema=False)
    def index() -> FileResponse:
        # 页面本身不含数据，令牌通过 URL 查询参数交给页面，再由页面放进请求头。
        return FileResponse(
            paths.STATIC_DIR / "index.html",
            media_type="text/html; charset=utf-8",
            # 与静态资源同理：每次回源确认，别让浏览器拿旧页面配新脚本
            headers={"Cache-Control": REVALIDATE},
        )

    return app



def _shutdown_running_jobs(supervisor: executor_module.Supervisor) -> None:
    """服务退出时收掉识别子进程，并把它们的任务结算成"中断"。

    顺序：**先写状态、再杀进程、最后修理**。反过来的话，被杀的进程会留下一堆
    `running` 的记录没人收拾；先写状态则子进程（如果还活着）也会读到中断信号自己收工。

    不这么做的话，应用关了还有进程在写项目数据库——那是明确禁止的
    （说明书 4.2 的单机单用户假设）。
    """
    for job_id, directory in supervisor.live_entries():
        try:
            jobs_module.set_status(directory, job_id, jobs_module.STATUS_INTERRUPTED)
            supervisor.stop(job_id)
            jobs_module.repair_unfinished(
                directory, message=jobs_module.INTERRUPTED_MESSAGE, job_id=job_id
            )
        except jobs_module.JobError:  # pragma: no cover - 项目文件夹被移走等异常
            continue
