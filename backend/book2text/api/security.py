"""本地服务安全：会话令牌与 Origin 校验（说明书 4.4）。

- 每次启动生成随机会话令牌；页面从 URL 拿到令牌，在请求头 `X-B2T-Token` 中回传。
- 同时校验 `Origin`，防止其他网页向本地服务发起请求。
- 令牌比较使用 `hmac.compare_digest`，避免逐字符比较带来的时序差异。

**实现方式说明：** 校验写成 FastAPI 依赖而不是 `BaseHTTPMiddleware`。
中间件会缓冲请求体，破坏上传接口的流式读取（说明书 4.5 要求边传边写盘）。
"""

from __future__ import annotations

import hmac
import secrets

from fastapi import Request

from .errors import AppError

TOKEN_HEADER = "X-B2T-Token"


def generate_token() -> str:
    return secrets.token_urlsafe(32)


def allowed_origins(port: int) -> list[str]:
    return [f"http://127.0.0.1:{port}", f"http://localhost:{port}"]


async def verify_local_request(request: Request) -> None:
    """挂在 `/api` 路由上的依赖：先校验来源，再校验令牌。"""
    origin = request.headers.get("origin")
    if origin is not None:
        allowed = getattr(request.app.state, "allowed_origins", ())
        if origin not in allowed:
            raise AppError(
                403,
                "origin_not_allowed",
                "请求来源不被允许",
                detail=f"Origin: {origin}",
            )

    expected = getattr(request.app.state, "session_token", None)
    if not expected:
        # 令牌未装配说明是内部装配错误，不能放行。
        raise AppError(500, "server_not_ready", "服务未正确初始化")

    supplied = request.headers.get(TOKEN_HEADER, "")
    if not hmac.compare_digest(supplied, expected):
        raise AppError(
            401,
            "invalid_token",
            "会话令牌无效或缺失",
            detail=f"缺少或错误的请求头 {TOKEN_HEADER}",
        )
