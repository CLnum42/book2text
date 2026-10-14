"""FastAPI 应用装配。

令牌与允许的 Origin 由启动入口传入（每次启动都会变），因此这里做成工厂函数，
便于测试时传入固定值。
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from .. import __version__, paths
from ..core.project.library import default_library_dir
from . import (
    errors,
    routes_app,
    routes_export,
    routes_projects,
    routes_scratch,
    security,
)


def create_app(
    *,
    session_token: str,
    origins: Sequence[str],
    library_dir: Path | None = None,
) -> FastAPI:
    app = FastAPI(
        title="Book2Text",
        version=__version__,
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
    app.state.library_dir = Path(library_dir) if library_dir else default_library_dir()

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
    app.include_router(routes_scratch.router, dependencies=guarded)
    app.include_router(routes_export.router, dependencies=guarded)
    app.include_router(routes_projects.router, dependencies=guarded)

    app.mount("/static", StaticFiles(directory=paths.STATIC_DIR), name="static")

    @app.get("/", include_in_schema=False)
    def index() -> FileResponse:
        # 页面本身不含数据，令牌通过 URL 查询参数交给页面，再由页面放进请求头。
        return FileResponse(
            paths.STATIC_DIR / "index.html",
            media_type="text/html; charset=utf-8",
        )

    return app
