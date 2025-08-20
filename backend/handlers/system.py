# -*- coding: utf-8 -*-
from __future__ import annotations

from http.server import BaseHTTPRequestHandler

from ..utils import json_dumps_bytes


SCHEMA_VERSION = 2


def health(handler: BaseHTTPRequestHandler, version: str, scanner) -> None:
    payload = {
        "status": "ok",
        "version": version,
        "db": {"ready": True},
        "scanning": scanner.status() if scanner else {"running": False, "progress": 0},
    }
    handler._set_headers(200)  # type: ignore[attr-defined]
    handler.wfile.write(json_dumps_bytes(payload))


def version(handler: BaseHTTPRequestHandler, version_str: str) -> None:
    payload = {"version": version_str, "schema": SCHEMA_VERSION}
    handler._set_headers(200)  # type: ignore[attr-defined]
    handler.wfile.write(json_dumps_bytes(payload))

