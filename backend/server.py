#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from http.server import HTTPServer, SimpleHTTPRequestHandler
from typing import Any, List, Optional, Literal
from urllib.parse import parse_qs, urlparse

try:
    from .config import AppConfig, PLUGIN_DIR  # type: ignore
    from . import db  # type: ignore
    from .scanner import Scanner  # type: ignore
except Exception:
    # Fallback: load local modules when run as a plain script
    import importlib.util

    _BDIR = os.path.dirname(__file__)

    def _load_local(mod_name: str, rel_path: str):
        spec = importlib.util.spec_from_file_location(mod_name, os.path.join(_BDIR, rel_path))
        if spec is None or spec.loader is None:
            raise ImportError(f"cannot load {rel_path}")
        mod = importlib.util.module_from_spec(spec)
        # 注册到 sys.modules 以便 dataclass 等装饰器获取正确的模块上下文
        sys.modules[mod_name] = mod
        spec.loader.exec_module(mod)
        return mod

    _config = _load_local("hikaze_mm_config", "config.py")
    db = _load_local("hikaze_mm_db", "db.py")
    _scanner_mod = _load_local("hikaze_mm_scanner", "scanner.py")
    AppConfig = _config.AppConfig
    PLUGIN_DIR = _config.PLUGIN_DIR
    Scanner = _scanner_mod.Scanner

VERSION = "0.2.0"

# Derive WEB_DIR at runtime to avoid import cycle
WEB_DIR = os.path.join(os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir)), "web")

_cfg: Optional[AppConfig] = None
_scanner: Optional[Scanner] = None


def _json_dumps(obj: Any) -> bytes:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _json_loads(data: bytes) -> Any:
    if not data:
        return None
    return json.loads(data.decode("utf-8"))


class ApiHandler(SimpleHTTPRequestHandler):
    server_version = f"HikazeMM/{VERSION}"

    def _set_headers(self, code: int, content_type: str = "application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type,Accept")
        self.end_headers()

    def _serve_web_file(self, rel: str) -> None:
        # sanitize rel
        rel = rel.replace("\\", "/").lstrip("/")
        if not rel:
            rel = "index.html"
        # prevent path traversal
        safe_rel = os.path.normpath(rel)
        if safe_rel.startswith(".."):
            self._set_headers(404)
            self.wfile.write(_json_dumps({"error": {"code": "NOT_FOUND", "message": "file not found"}}))
            return
        full_path = os.path.join(WEB_DIR, safe_rel)
        if os.path.isdir(full_path):
            full_path = os.path.join(full_path, "index.html")
        if not (os.path.exists(full_path) and os.path.commonpath([WEB_DIR, os.path.abspath(full_path)]) == WEB_DIR):
            self._set_headers(404)
            self.wfile.write(_json_dumps({"error": {"code": "NOT_FOUND", "message": "file not found"}}))
            return
        # simple content-type mapping
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
            self._set_headers(200, ct)
            self.wfile.write(data)
        except Exception:
            self._set_headers(500)
            self.wfile.write(_json_dumps({"error": {"code": "READ_ERROR", "message": "cannot read file"}}))

    def do_OPTIONS(self):  # noqa: N802
        self._set_headers(204)

    def do_GET(self):  # noqa: N802
        global _cfg, _scanner
        parsed = urlparse(self.path)
        path = parsed.path or "/"

        if path == "/health":
            payload = {
                "status": "ok",
                "version": VERSION,
                "db": {"ready": True},
                "scanning": _scanner.status() if _scanner else {"running": False, "progress": 0},
            }
            self._set_headers(200)
            self.wfile.write(_json_dumps(payload))
            return

        if path == "/version":
            payload = {"version": VERSION, "schema": 1}
            self._set_headers(200)
            self.wfile.write(_json_dumps(payload))
            return

        if path == "/scan/status":
            self._set_headers(200)
            self.wfile.write(_json_dumps(_scanner.status() if _scanner else {"running": False}))
            return

        # New: list all types with counts
        if path == "/types":
            self._set_headers(200)
            self.wfile.write(_json_dumps(db.types_with_counts()))
            return

        # New: list tags by type (exclude the type tag itself)
        if path == "/tags/by-type":
            qs = parse_qs(parsed.query)
            type_ = qs.get("type", [None])[0]
            if not type_:
                self._set_headers(400)
                self.wfile.write(_json_dumps({"error": {"code": "VALIDATION_ERROR", "message": "type required"}}))
                return
            self._set_headers(200)
            self.wfile.write(_json_dumps(db.list_tags_by_type(type_)))
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
            try:
                facets = db.tag_facets(type_=type_, q=q, selected=selected or None, mode=mode_l)
            except Exception as e:
                self._set_headers(400)
                self.wfile.write(_json_dumps({"error": {"code": "BAD_REQUEST", "message": str(e)}}))
                return
            self._set_headers(200)
            self.wfile.write(_json_dumps(facets))
            return

        # /models list or single
        if path == "/models":
            qs = parse_qs(parsed.query)
            q = qs.get("q", [None])[0]
            type_ = qs.get("type", [None])[0]
            dir_path = qs.get("dir", [None])[0]
            tags_param = qs.get("tags", [])
            tags_list: List[str] = []
            for t in tags_param:
                # support comma-separated and repeated
                parts = [p for p in t.split(",") if p]
                tags_list.extend(parts)
            tags_mode_str = (qs.get("tags_mode", ["all"]) or ["all"])[0]
            tm: Literal['all', 'any'] = 'any' if tags_mode_str == 'any' else 'all'
            limit = int(qs.get("limit", ["50"])[0])
            offset = int(qs.get("offset", ["0"])[0])
            sort = qs.get("sort", ["created"])[0]
            order_str = qs.get("order", ["desc"])[0]
            ordv: Literal['asc', 'desc'] = 'asc' if order_str == 'asc' else 'desc'

            items, total = db.query_models(
                q=q, type_=type_, dir_path=dir_path, tags=tags_list or None, tags_mode=tm, limit=limit, offset=offset, sort=sort, order=ordv
            )
            # enrich with tags and parsed json
            out = []
            for m in items:
                try:
                    meta = json.loads(m.get("meta_json") or "null")
                except Exception:
                    meta = None
                try:
                    extra = json.loads(m.get("extra_json") or "null")
                except Exception:
                    extra = None
                tags = db.list_model_tags(int(m["id"]))
                out.append({
                    "id": m["id"],
                    "path": m["path"],
                    "dir_path": m["dir_path"],
                    "name": m.get("name"),
                    "type": m.get("type"),
                    "size_bytes": m.get("size_bytes"),
                    "mtime_ns": m.get("mtime_ns"),
                    "hash_algo": m.get("hash_algo"),
                    "hash_hex": m.get("hash_hex"),
                    "created_at": m.get("created_at"),
                    "updated_at": m.get("updated_at"),
                    "tags": tags,
                    "meta": meta,
                    "extra": extra,
                    "images": (extra or {}).get("images") if isinstance(extra, dict) else None,
                })
            self._set_headers(200)
            self.wfile.write(_json_dumps({"items": out, "total": total}))
            return

        m = re.match(r"^/models/(\d+)$", path)
        if m:
            mid = int(m.group(1))
            model = db.get_model_by_id(mid)
            if not model:
                self._set_headers(404)
                self.wfile.write(_json_dumps({"error": {"code": "NOT_FOUND", "message": "model not found"}}))
                return
            try:
                meta = json.loads(model.get("meta_json") or "null")
            except Exception:
                meta = None
            try:
                extra = json.loads(model.get("extra_json") or "null")
            except Exception:
                extra = None
            tags = db.list_model_tags(mid)
            out = {**model, "tags": tags, "meta": meta, "extra": extra}
            # remove internal json text
            out.pop("meta_json", None)
            out.pop("extra_json", None)
            self._set_headers(200)
            self.wfile.write(_json_dumps(out))
            return

        m = re.match(r"^/models/(\d+)/extra$", path)
        if m:
            mid = int(m.group(1))
            model = db.get_model_by_id(mid)
            if not model:
                self._set_headers(404)
                self.wfile.write(_json_dumps({"error": {"code": "NOT_FOUND", "message": "model not found"}}))
                return
            try:
                extra = json.loads(model.get("extra_json") or "{}")
            except Exception:
                extra = {}
            self._set_headers(200)
            self.wfile.write(_json_dumps(extra))
            return

        m = re.match(r"^/models/(\d+)/params$", path)
        if m:
            mid = int(m.group(1))
            model = db.get_model_by_id(mid)
            if not model:
                self._set_headers(404)
                self.wfile.write(_json_dumps({"error": {"code": "NOT_FOUND", "message": "model not found"}}))
                return
            try:
                meta = json.loads(model.get("meta_json") or "{}")
            except Exception:
                meta = {}
            try:
                extra = json.loads(model.get("extra_json") or "{}")
            except Exception:
                extra = {}
            params = {}
            if isinstance(extra, dict):
                if "params" in extra and isinstance(extra["params"], dict):
                    params.update(extra["params"])  # 优先用户扩展
                if "prompts" in extra and isinstance(extra["prompts"], dict):
                    params.update(extra["prompts"])  # 包含 prompt/negative
            if isinstance(meta, dict) and "params" in meta and isinstance(meta["params"], dict):
                for k, v in meta["params"].items():
                    params.setdefault(k, v)
            self._set_headers(200)
            self.wfile.write(_json_dumps(params))
            return

        if path == "/tags":
            self._set_headers(200)
            self.wfile.write(_json_dumps(db.list_tags()))
            return

        # static: /web/*
        if path == "/":
            self.send_response(301)
            self.send_header("Location", "/web/")
            self.end_headers()
            return
        if path == "/web":
            self._serve_web_file("index.html")
            return
        if path == "/web/":
            self._serve_web_file("")
            return
        if path.startswith("/web/"):
            rel = path[len("/web/"):]
            self._serve_web_file(rel)
            return

        self._set_headers(404)
        self.wfile.write(_json_dumps({"error": {"code": "NOT_FOUND", "message": "not found"}}))

    def do_POST(self):  # noqa: N802
        global _cfg, _scanner
        parsed = urlparse(self.path)
        path = parsed.path or "/"
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length > 0 else b""
        data = _json_loads(body) or {}

        if path == "/scan/start":
            paths = data.get("paths")
            full = bool(data.get("full", False))
            started = _scanner.start(paths=paths, full=full)
            self._set_headers(200)
            self.wfile.write(_json_dumps({"started": started}))
            return

        if path == "/scan/stop":
            stopped = _scanner.stop()
            self._set_headers(200)
            self.wfile.write(_json_dumps({"stopped": stopped}))
            return

        if path == "/tags":
            name = (data.get("name") or "").strip()
            color = data.get("color")
            if not name:
                self._set_headers(400)
                self.wfile.write(_json_dumps({"error": {"code": "VALIDATION_ERROR", "message": "name required"}}))
                return
            try:
                tag = db.create_tag(name, color)
            except Exception as e:
                self._set_headers(400)
                self.wfile.write(_json_dumps({"error": {"code": "VALIDATION_ERROR", "message": str(e)}}))
                return
            self._set_headers(200)
            self.wfile.write(_json_dumps(tag))
            return

        if path == "/models/refresh":
            mid = data.get("id")
            mpath = data.get("path")
            if mid is not None and not mpath:
                m = db.get_model_by_id(int(mid))
                if not m:
                    self._set_headers(404)
                    self.wfile.write(_json_dumps({"error": {"code": "NOT_FOUND", "message": "model not found"}}))
                    return
                mpath = m.get("path")
            if not mpath:
                self._set_headers(400)
                self.wfile.write(_json_dumps({"error": {"code": "VALIDATION_ERROR", "message": "id or path required"}}))
                return
            ok = _scanner.refresh_one(mpath)
            self._set_headers(200)
            self.wfile.write(_json_dumps({"refreshed": bool(ok)}))
            return

        m = re.match(r"^/models/(\d+)/tags$", path)
        if m:
            mid = int(m.group(1))
            model = db.get_model_by_id(mid)
            if not model:
                self._set_headers(404)
                self.wfile.write(_json_dumps({"error": {"code": "NOT_FOUND", "message": "model not found"}}))
                return
            ensure_type = model.get("type")
            add = data.get("add") or []
            remove = data.get("remove") or []
            try:
                tags = db.set_model_tags(mid, add, remove, ensure_type=ensure_type)
            except ValueError as e:
                self._set_headers(400)
                self.wfile.write(_json_dumps({"error": {"code": "VALIDATION_ERROR", "message": str(e)}}))
                return
            self._set_headers(200)
            self.wfile.write(_json_dumps({"id": mid, "tags": tags}))
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
            tid = int(m.group(1))
            try:
                tag = db.update_tag(tid, name=data.get("name"), color=data.get("color"))
            except KeyError:
                self._set_headers(404)
                self.wfile.write(_json_dumps({"error": {"code": "NOT_FOUND", "message": "tag not found"}}))
                return
            self._set_headers(200)
            self.wfile.write(_json_dumps(tag))
            return

        m = re.match(r"^/models/(\d+)/extra$", path)
        if m:
            mid = int(m.group(1))
            model = db.get_model_by_id(mid)
            if not model:
                self._set_headers(404)
                self.wfile.write(_json_dumps({"error": {"code": "NOT_FOUND", "message": "model not found"}}))
                return
            try:
                current = json.loads(model.get("extra_json") or "{}")
            except Exception:
                current = {}
            if not isinstance(current, dict) or not isinstance(data, dict):
                current = {}
            current.update(data)
            with db.get_conn():
                db.get_conn().execute("UPDATE models SET extra_json=? WHERE id=?", (json.dumps(current, ensure_ascii=False), mid))
            self._set_headers(200)
            self.wfile.write(_json_dumps(current))
            return

        self._set_headers(404)
        self.wfile.write(_json_dumps({"error": {"code": "NOT_FOUND", "message": "not found"}}))

    def do_PUT(self):  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path or "/"
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length) if length > 0 else b""
        data = _json_loads(body) or {}

        m = re.match(r"^/models/(\d+)/extra$", path)
        if m:
            mid = int(m.group(1))
            model = db.get_model_by_id(mid)
            if not model:
                self._set_headers(404)
                self.wfile.write(_json_dumps({"error": {"code": "NOT_FOUND", "message": "model not found"}}))
                return
            if not isinstance(data, dict):
                data = {}
            with db.get_conn():
                db.get_conn().execute("UPDATE models SET extra_json=? WHERE id=?", (json.dumps(data, ensure_ascii=False), mid))
            self._set_headers(200)
            self.wfile.write(_json_dumps(data))
            return

        self._set_headers(404)
        self.wfile.write(_json_dumps({"error": {"code": "NOT_FOUND", "message": "not found"}}))

    def do_DELETE(self):  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path or "/"

        m = re.match(r"^/tags/(\d+)$", path)
        if m:
            tid = int(m.group(1))
            try:
                db.delete_tag(tid)
            except Exception:
                pass
            self._set_headers(200)
            self.wfile.write(_json_dumps({"ok": True}))
            return

        m = re.match(r"^/models/(\d+)/extra/keys$", path)
        if m:
            mid = int(m.group(1))
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length) if length > 0 else b""
            data = _json_loads(body) or {}
            model = db.get_model_by_id(mid)
            if not model:
                self._set_headers(404)
                self.wfile.write(_json_dumps({"error": {"code": "NOT_FOUND", "message": "model not found"}}))
                return
            keys = data.get("keys") or []
            try:
                extra = json.loads(model.get("extra_json") or "{}")
            except Exception:
                extra = {}
            if isinstance(extra, dict):
                for k in list(keys):
                    extra.pop(k, None)
                with db.get_conn():
                    db.get_conn().execute("UPDATE models SET extra_json=? WHERE id=?", (json.dumps(extra, ensure_ascii=False), mid))
            self._set_headers(200)
            self.wfile.write(_json_dumps(extra if isinstance(extra, dict) else {}))
            return

        self._set_headers(404)
        self.wfile.write(_json_dumps({"error": {"code": "NOT_FOUND", "message": "not found"}}))

    def log_message(self, format, *args):  # noqa: A003 - keep signature
        sys.stderr.write("[backend] " + (format % args) + "\n")


def run_server(host: str, port: int, tries: int = 10):
    httpd = None
    bound_port = port
    for i in range(tries):
        try:
            httpd = HTTPServer((host, bound_port), ApiHandler)
            break
        except OSError:
            bound_port += 1
    if httpd is None:
        raise RuntimeError(f"cannot bind http server after {tries} tries from {port}")
    print(f"Hikaze Model Manager backend listening on http://{host}:{bound_port}")
    print(f"Serving web root: {WEB_DIR}")
    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


def main(argv: Optional[List[str]] = None) -> int:
    global _cfg, _scanner
    parser = argparse.ArgumentParser(description="Hikaze Model Manager backend")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--tries", type=int, default=10)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--no-scan", action="store_true", help="do not start scan on boot")
    args = parser.parse_args(argv)

    # init config & db
    _cfg = AppConfig.load()
    if args.host:
        _cfg.host = args.host
    if args.port:
        _cfg.port = args.port
    db.init_db()
    _scanner = Scanner(_cfg)

    if args.check:
        print(json.dumps({
            "version": VERSION,
            "host": _cfg.host,
            "port": _cfg.port,
            "model_roots": _cfg.model_roots,
            "web_dir": WEB_DIR,
            "data_root": os.path.join(PLUGIN_DIR, "data"),
        }, indent=2, ensure_ascii=False))
        return 0

    # optionally kick off a scan
    if not args.no_scan and _cfg.model_roots:
        _scanner.start(paths=None, full=False)

    run_server(_cfg.host, _cfg.port, tries=args.tries)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
