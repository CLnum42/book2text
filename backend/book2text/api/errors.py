"""统一错误格式（说明书第 11 节）。

所有接口的错误响应形状固定为::

    {"error": {"code": "...", "message": "...", "detail": "...", "correlation_id": "..."}}

`message` 面向用户，`detail` 面向排查，`correlation_id` 用于把界面上的报错
和日志里的记录对上。
"""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


class AppError(Exception):
    """核心层抛出的业务错误，由 API 层转成统一格式。"""

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        detail: str = "",
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.detail = detail


def error_payload(code: str, message: str, detail: str = "") -> dict[str, Any]:
    return {
        "error": {
            "code": code,
            "message": message,
            "detail": detail,
            "correlation_id": uuid.uuid4().hex[:12],
        }
    }


def error_response(
    status_code: int, code: str, message: str, detail: str = ""
) -> JSONResponse:
    return JSONResponse(
        status_code=status_code, content=error_payload(code, message, detail)
    )


async def app_error_handler(_: Request, exc: AppError) -> JSONResponse:
    return error_response(exc.status_code, exc.code, exc.message, exc.detail)


async def http_exception_handler(
    _: Request, exc: StarletteHTTPException
) -> JSONResponse:
    return error_response(
        exc.status_code,
        "http_error",
        str(exc.detail) if exc.detail else "请求失败",
    )


async def validation_exception_handler(
    _: Request, exc: RequestValidationError
) -> JSONResponse:
    return error_response(
        422,
        "invalid_request",
        "请求参数不合法",
        detail=str(exc.errors())[:500],
    )


async def unhandled_exception_handler(_: Request, exc: Exception) -> JSONResponse:
    # 说明书 1.3：不吞掉异常、不用空结果伪装成功。这里把真实原因放进 detail。
    return error_response(
        500,
        "internal_error",
        "服务内部错误",
        detail=f"{type(exc).__name__}: {exc}",
    )
