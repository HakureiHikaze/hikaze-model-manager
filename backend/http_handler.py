#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations

import os
import re
import sys
from http.server import SimpleHTTPRequestHandler
from typing import Literal
from urllib.parse import parse_qs, urlparse

# Runtime context, injected by server.py via set_context
_cfg = None  # type: ignore
_scanner = None  # type: ignore
_version: str = "unknown"

try:
    # Running in package environment
    from .utils import (
        json_dumps_bytes as _json_dumps,
        json_loads_bytes as _json_loads,
    )  # type: ignore
    from .handlers.static import (
        serve_web_file as _serve_web_file,
        serve_media_file as _serve_media_file,
    )  # type: ignore
    from .handlers import system as h_system, scan as h_scan, tags as h_tags, models as h_models  # type: ignore
    from .permissions import check_permission as _check_permission  # type: ignore
except Exception:
    # Local imports fallback when running as a plain script
    import importlib.util

    _BDIR = os.path.dirname(__file__)

    def _load_local(mod_name: str, rel_path: str):
        spec = importlib.util.spec_from_file_location(mod_name, os.path.join(_BDIR, rel_path))
        if spec is None or spec.loader is None:
            raise ImportError(f"cannot load {rel_path}")
        mod = importlib.util.module_from_spec(spec)
        sys.modules[mod_name] = mod
        spec.loader.exec_module(mod)
        return mod

    _utils = _load_local("hikaze_mm_utils", "utils.py")
    _handlers_static = _load_local("hikaze_mm_handlers_static", os.path.join("handlers", "static.py"))
    _handlers_system = _load_local("hikaze_mm_handlers_system", os.path.join("handlers", "system.py"))
    _handlers_scan = _load_local("hikaze_mm_handlers_scan", os.path.join("handlers", "scan.py"))
    _handlers_tags = _load_local("hikaze_mm_handlers_tags", os.path.join("handlers", "tags.py"))
    _handlers_models = _load_local("hikaze_mm_handlers_models", os.path.join("handlers", "models.py"))
    _perms = _load_local("hikaze_mm_permissions", "permissions.py")

    _json_dumps = _utils.json_dumps_bytes
    _json_loads = _utils.json_loads_bytes
    _serve_web_file = _handlers_static.serve_web_file
    _serve_media_file = _handlers_static.serve_media_file
    h_system = _handlers_system
    h_scan = _handlers_scan
    h_tags = _handlers_tags
    h_models = _handlers_models
    _check_permission = _perms.check_permission


def set_context(cfg, scanner, version: str = "unknown") -> None:
    """Injected by server.py to set runtime context.

    Args:
        cfg: AppConfig instance
        scanner: Scanner instance
        version: version string
    """
    global _cfg, _scanner, _version
    _cfg = cfg
    _scanner = scanner
    _version = version or "unknown"
    # Sync to handler's server_version
    ApiHandler.server_version = f"HikazeMM/{_version}"


class ApiHandler(SimpleHTTPRequestHandler):
    # Will be updated in set_context
    server_version = "HikazeMM/unknown"

    def _set_headers(self, code: int, content_type: str = "application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type,Accept,X-Filename")
        self.end_headers()

    def do_OPTIONS(self):  # noqa: N802
        self._set_headers(204)

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path or "/"

        if path == "/health":
            h_system.health(self, _version, _scanner)
            return

        if path == "/version":
            h_system.version(self, _version)
            return

        if path == "/scan/status":
            h_scan.get_status(self, _scanner)
            return

        # New: list all types with counts
        if path == "/types":
            h_models.types_with_counts(self)
            return

        # New: list tags by type (exclude the type tag itself)
        if path == "/tags/by-type":
            qs = parse_qs(parsed.query)
            type_ = qs.get("type", [None])[0]
            h_tags.list_by_type(self, type_)
            return

        # New: tag facets for current filter
        if path == "/tags/facets":
            qs = parse_qs(parsed.query)
            type_ = qs.get("type", [None])[0]
            q = qs.get("q", [None])[0]
            selected_raw = qs.get("selected", [None])[0]
            selected = []
            if selected_raw:
                for part in selected_raw.split(","):
                    part = part.strip()
                    if part:
                        selected.append(part)
            mode = qs.get("mode", ["all"])[0]
            mode_l: Literal['all','any'] = 'any' if mode == 'any' else 'all'
            h_tags.facets(self, type_=type_, q=q, selected=selected or None, mode=mode_l)
            return

        # /models list or single
        if path == "/models":
            h_models.list_models(self, parsed.query)
            return

        m = re.match(r"^/models/(\d+)$", path)
        if m:
            h_models.get_model(self, int(m.group(1)))
            return

        m = re.match(r"^/models/(\d+)/extra$", path)
        if m:
            h_models.get_extra(self, int(m.group(1)))
            return

        m = re.match(r"^/models/(\d+)/params$", path)
        if m:
            h_models.get_params(self, int(m.group(1)))
            return

        if path == "/tags":
            h_tags.list_all(self)
            return

        # static: /web/*
        if path == "/":
            self.send_response(301)
            self.send_header("Location", "/web/")
            self.end_headers()
            return
        if path == "/web":
            _serve_web_file(self, "index.html")
            return
        if path == "/web/":
            _serve_web_file(self, "")
            return
        if path.startswith("/web/"):
            rel = path[len("/web/"):]
            _serve_web_file(self, rel)
            return
        if path.startswith("/media/"):
            rel = path[len("/media/"):]
            _serve_media_file(self, rel)
            return

        self._set_headers(404)
        self.wfile.write(_json_dumps({"error": {"code": "NOT_FOUND", "message": "not found"}}))

    def do_POST(self):  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path or "/"
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length > 0 else b""
        data = _json_loads(body) or {}

        if path == "/scan/start":
            h_scan.start(self, _scanner, data)
            return

        if path == "/scan/stop":
            h_scan.stop(self, _scanner)
            return

        if path == "/tags":
            h_tags.create(self, name=data.get("name"), color=data.get("color"))
            return

        if path == "/models/refresh":
            h_models.refresh(self, _scanner, data)
            return

        m = re.match(r"^/models/(\d+)/tags$", path)
        if m:
            h_models.set_tags(self, int(m.group(1)), data)
            return

        self._set_headers(404)
        self.wfile.write(_json_dumps({"error": {"code": "NOT_FOUND", "message": "not found"}}))

    def do_PATCH(self):  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path or "/"
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length > 0 else b""
        data = _json_loads(body) or {}

        m = re.match(r"^/tags/(\d+)$", path)
        if m:
            h_tags.update(self, int(m.group(1)), name=data.get("name"), color=data.get("color"))
            return

        m = re.match(r"^/models/(\d+)/extra$", path)
        if m:
            h_models.update_extra(self, int(m.group(1)), data)
            return

        self._set_headers(404)
        self.wfile.write(_json_dumps({"error": {"code": "NOT_FOUND", "message": "not found"}}))

    def do_PUT(self):  # noqa: N802
        """Handle image upload for a model: PUT /models/{id}/image"""
        parsed = urlparse(self.path)
        path = parsed.path or "/"
        m = re.match(r"^/models/(\d+)/image$", path)
        if not m:
            self._set_headers(404)
            self.wfile.write(_json_dumps({"error": {"code": "NOT_FOUND", "message": "not found"}}))
            return
        h_models.upload_image(self, int(m.group(1)))

    def do_DELETE(self):  # noqa: N802
        """
        Handle DELETE requests with a reserved hook for permission checks.
        """
        parsed = urlparse(self.path)
        path = parsed.path or "/"

        # Permission check hook (reserved)
        if not _check_permission("delete", path):
            self._set_headers(403)
            self.wfile.write(_json_dumps({"error": {"code": "PERMISSION_DENIED", "message": "insufficient permissions"}}))
            return

        # Delete a tag
        m = re.match(r"^/tags/(\d+)$", path)
        if m:
            h_tags.delete(self, int(m.group(1)))
            return

        # Delete a model (remove record from DB only; keep file intact)
        m = re.match(r"^/models/(\d+)$", path)
        if m:
            h_models.delete_model(self, int(m.group(1)))
            return

        self._set_headers(404)
        self.wfile.write(_json_dumps({"error": {"code": "NOT_FOUND", "message": "not found"}}))
