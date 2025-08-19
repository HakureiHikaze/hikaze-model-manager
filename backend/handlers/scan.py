# -*- coding: utf-8 -*-
from __future__ import annotations

from http.server import BaseHTTPRequestHandler
from typing import Any, Optional

from ..utils import json_dumps_bytes


def get_status(handler: BaseHTTPRequestHandler, scanner) -> None:
    status = scanner.status() if scanner else {"running": False}
    handler._set_headers(200)  # type: ignore[attr-defined]
    handler.wfile.write(json_dumps_bytes(status))


essential_scan_payload_keys = ("paths", "full")


def start(handler: BaseHTTPRequestHandler, scanner, data: dict) -> None:
    paths = data.get("paths")
    full = bool(data.get("full", False))
    started = scanner.start(paths=paths, full=full) if scanner else False
    handler._set_headers(200)  # type: ignore[attr-defined]
    handler.wfile.write(json_dumps_bytes({"started": started}))


def stop(handler: BaseHTTPRequestHandler, scanner) -> None:
    stopped = scanner.stop() if scanner else False
    handler._set_headers(200)  # type: ignore[attr-defined]
    handler.wfile.write(json_dumps_bytes({"stopped": stopped}))

