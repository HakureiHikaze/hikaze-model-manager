#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from __future__ import annotations

import argparse
import json
import os
import sys
from http.server import HTTPServer
from typing import Optional

try:
    from .config import AppConfig  # type: ignore
    from . import db  # type: ignore
    from .scanner import Scanner  # type: ignore
    # New: import the split-out HTTP handler
    from .http_handler import ApiHandler, set_context  # type: ignore
except Exception:
    # Fallback: load local modules when run as a plain script
    import importlib.util

    _BDIR = os.path.dirname(__file__)

    def _load_local(mod_name: str, rel_path: str):
        spec = importlib.util.spec_from_file_location(mod_name, os.path.join(_BDIR, rel_path))
        if spec is None or spec.loader is None:
            raise ImportError(f"cannot load {rel_path}")
        mod = importlib.util.module_from_spec(spec)
        # Register into sys.modules so decorators like dataclass get correct module context
        sys.modules[mod_name] = mod
        spec.loader.exec_module(mod)
        return mod

    _config = _load_local("hikaze_mm_config", "config.py")
    db = _load_local("hikaze_mm_db", "db.py")
    _scanner_mod = _load_local("hikaze_mm_scanner", "scanner.py")
    # New: locally load http_handler
    _http_handler = _load_local("hikaze_mm_http_handler", "http_handler.py")

    AppConfig = _config.AppConfig
    Scanner = _scanner_mod.Scanner
    # New: bind http_handler symbols
    ApiHandler = _http_handler.ApiHandler
    set_context = _http_handler.set_context

VERSION = "0.2.0"

_cfg: Optional[AppConfig] = None
_scanner: Optional[Scanner] = None


def _init_server() -> None:
    """Initialize server state"""
    global _cfg, _scanner

    if _cfg is None:
        _cfg = AppConfig.load()
        print(f"[Hikaze MM] Config loaded: {_cfg.model_roots}")

    if _scanner is None:
        db.init_db()
        # Fix: Scanner requires config instance
        _scanner = Scanner(_cfg)
        print("[Hikaze MM] Scanner initialized")

    # Inject context (version, config, scanner) into ApiHandler
    set_context(_cfg, _scanner, VERSION)


def main(host: str = None, port: int = None) -> None:
    """
    Start the HTTP server

    Args:
        host: Server bind address
        port: Server port
    """
    global _cfg

    _init_server()

    if host is None:
        host = _cfg.host
    if port is None:
        port = _cfg.port

    try:
        server = HTTPServer((host, port), ApiHandler)
        print(f"[Hikaze MM] Server running on http://{host}:{port}")
        server.serve_forever()
    except KeyboardInterrupt:
        print("[Hikaze MM] Server stopped by user")
    except OSError as e:
        if "Address already in use" in str(e):
            print(f"[Hikaze MM] Port {port} is already in use")
        else:
            print(f"[Hikaze MM] Server error: {e}")
    except Exception as e:
        print(f"[Hikaze MM] Unexpected server error: {e}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Hikaze Model Manager HTTP Server")
    parser.add_argument("--host", default="127.0.0.1", help="Server host (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8789, help="Server port (default: 8789)")
    parser.add_argument("--config", help="Config file path")

    args = parser.parse_args()

    # If a config file is provided, update the global config accordingly
    if args.config and os.path.exists(args.config):
        try:
            with open(args.config, 'r', encoding='utf-8') as f:
                config_data = json.load(f)
            _cfg = AppConfig(
                host=config_data.get('host', args.host),
                port=config_data.get('port', args.port),
                model_roots=config_data.get('model_roots', [])
            )
        except Exception as e:
            print(f"[Hikaze MM] Warning: Failed to load config file: {e}")

    main(args.host, args.port)
