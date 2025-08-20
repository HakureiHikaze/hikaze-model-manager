# -*- coding: utf-8 -*-
from __future__ import annotations

import os
from http.server import BaseHTTPRequestHandler

from ..paths import WEB_DIR, MEDIA_DIR
from ..utils import json_dumps_bytes


def serve_web_file(handler: BaseHTTPRequestHandler, rel: str) -> None:
    rel = rel.replace("\\", "/").lstrip("/")
    if not rel:
        rel = "index.html"
    safe_rel = os.path.normpath(rel)
    if safe_rel.startswith(".."):
        handler._set_headers(404)  # type: ignore[attr-defined]
        handler.wfile.write(json_dumps_bytes({"error": {"code": "NOT_FOUND", "message": "file not found"}}))
        return
    full_path = os.path.join(WEB_DIR, safe_rel)
    if os.path.isdir(full_path):
        full_path = os.path.join(full_path, "index.html")
    if not (os.path.exists(full_path) and os.path.commonpath([WEB_DIR, os.path.abspath(full_path)]) == WEB_DIR):
        handler._set_headers(404)  # type: ignore[attr-defined]
        handler.wfile.write(json_dumps_bytes({"error": {"code": "NOT_FOUND", "message": "file not found"}}))
        return
    ext = os.path.splitext(full_path)[1].lower()
    ct = {
        ".html": "text/html; charset=utf-8",
        ".htm": "text/html; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".webp": "image/webp",
    }.get(ext, "application/octet-stream")
    try:
        with open(full_path, "rb") as f:
            data = f.read()
        handler._set_headers(200, ct)  # type: ignore[attr-defined]
        handler.wfile.write(data)
    except Exception:
        handler._set_headers(500)  # type: ignore[attr-defined]
        handler.wfile.write(json_dumps_bytes({"error": {"code": "READ_ERROR", "message": "cannot read file"}}))


def serve_media_file(handler: BaseHTTPRequestHandler, rel: str) -> None:
    rel = rel.replace("\\", "/").lstrip("/")
    safe_rel = os.path.normpath(rel)
    if safe_rel.startswith(".."):
        handler._set_headers(404)  # type: ignore[attr-defined]
        handler.wfile.write(json_dumps_bytes({"error": {"code": "NOT_FOUND", "message": "file not found"}}))
        return
    full_path = os.path.join(MEDIA_DIR, safe_rel)
    if os.path.isdir(full_path):
        handler._set_headers(404)  # type: ignore[attr-defined]
        handler.wfile.write(json_dumps_bytes({"error": {"code": "NOT_FOUND", "message": "file not found"}}))
        return
    if not (os.path.exists(full_path) and os.path.commonpath([os.path.abspath(MEDIA_DIR), os.path.abspath(full_path)]) == os.path.abspath(MEDIA_DIR)):
        handler._set_headers(404)  # type: ignore[attr-defined]
        handler.wfile.write(json_dumps_bytes({"error": {"code": "NOT_FOUND", "message": "file not found"}}))
        return
    ext = os.path.splitext(full_path)[1].lower()
    ct = {
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
    }.get(ext, "application/octet-stream")
    try:
        with open(full_path, "rb") as f:
            data = f.read()
        handler._set_headers(200, ct)  # type: ignore[attr-defined]
        handler.wfile.write(data)
    except Exception:
        handler._set_headers(500)  # type: ignore[attr-defined]
        handler.wfile.write(json_dumps_bytes({"error": {"code": "READ_ERROR", "message": "cannot read file"}}))

