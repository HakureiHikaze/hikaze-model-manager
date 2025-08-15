# -*- coding: utf-8 -*-
from __future__ import annotations

import hashlib
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional

try:
    from . import db  # type: ignore
    from .config import AppConfig  # type: ignore
except Exception:
    # fallback for script-run context
    import importlib.util, sys as _sys
    _BDIR = os.path.dirname(__file__)

    def _load_local(mod_name: str, rel_path: str):
        spec = importlib.util.spec_from_file_location(mod_name, os.path.join(_BDIR, rel_path))
        if spec is None or spec.loader is None:
            raise ImportError(f"cannot load {rel_path}")
        mod = importlib.util.module_from_spec(spec)
        _sys.modules[mod_name] = mod
        spec.loader.exec_module(mod)
        return mod

    _config = _load_local("hikaze_mm_config", "config.py")
    db = _load_local("hikaze_mm_db", "db.py")
    AppConfig = _config.AppConfig


SUPPORTED_EXTS = {
    "checkpoint": {".ckpt", ".safetensors", ".pth"},
    "lora": {".safetensors"},
    "embedding": {".pt", ".bin"},
    "vae": {".pt", ".safetensors"},
    "upscale": {".pth", ".pt"},
    "ultralytics": {".pt"},
}

KEYWORDS = [
    ("embedding", ("embedding", "embeddings")),
    ("lora", ("lora", "loras")),
    ("vae", ("vae", "vaes")),
    ("controlnet", ("controlnet", "control_nets")),
    ("upscale", ("upscale", "esrgan", "realesr")),
    ("ultralytics", ("ultralytics",)),
    ("checkpoint", ("checkpoint", "checkpoints", "stable-diffusion", "sd", "sdxl")),
]


def infer_type(path: str) -> str:
    p = path.replace("\\", "/").lower()
    # 专规则：models/sams 下的模型归为 other
    if "/sams/" in p:
        return "other"
    for t, keys in KEYWORDS:
        if any(f"/{k}/" in p for k in keys):
            return t
    ext = os.path.splitext(path)[1].lower()
    # fall back by ext
    for t, exts in SUPPORTED_EXTS.items():
        if ext in exts:
            return t
    return "other"


@dataclass
class ScanStats:
    total: int = 0
    processed: int = 0
    added: int = 0
    updated: int = 0
    skipped: int = 0
    errors: int = 0
    by_type: Dict[str, int] = field(default_factory=dict)


class Scanner:
    def __init__(self, cfg: AppConfig):
        self._cfg = cfg
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._running = False
        self._stats = ScanStats()
        self._last_error: Optional[str] = None
        self._last_started_ms: Optional[int] = None

    # public status API
    def status(self) -> Dict[str, object]:
        with self._lock:
            return {
                "running": self._running,
                "progress": 0 if self._stats.total == 0 else int(self._stats.processed * 100 / max(1, self._stats.total)),
                "stats": self._stats.__dict__,
                "last_error": self._last_error,
                "last_started": self._last_started_ms,
            }

    def start(self, paths: Optional[List[str]] = None, full: bool = False) -> bool:
        with self._lock:
            if self._running:
                return False
            self._running = True
            self._stop.clear()
            self._stats = ScanStats()
            self._last_error = None
            self._last_started_ms = int(time.time() * 1000)
        if paths is None:
            paths = self._cfg.model_roots or []
        # normalize
        paths = [os.path.abspath(p) for p in paths if p and os.path.isdir(p)]
        self._thread = threading.Thread(target=self._run, args=(paths, full), daemon=True)
        self._thread.start()
        return True

    def stop(self) -> bool:
        self._stop.set()
        return True

    def refresh_one(self, path: str) -> bool:
        """Public API: 刷新单个文件（重算哈希并入库）。返回是否成功。"""
        try:
            if not os.path.isfile(path):
                return False
            self._process_file(path, full=True)
            return True
        except Exception:
            return False

    # core
    def _run(self, roots: List[str], full: bool):
        try:
            # pre-count files
            files = list(self._iter_files(roots))
            with self._lock:
                self._stats.total = len(files)
            for path in files:
                if self._stop.is_set():
                    break
                try:
                    self._process_file(path, full)
                except Exception:
                    with self._lock:
                        self._stats.errors += 1
                finally:
                    with self._lock:
                        self._stats.processed += 1
        except Exception as e:
            with self._lock:
                self._last_error = str(e)
        finally:
            with self._lock:
                self._running = False

    def _iter_files(self, roots: Iterable[str]) -> Iterable[str]:
        exts = {e for s in SUPPORTED_EXTS.values() for e in s}
        exts.update({".safetensors", ".ckpt", ".pth", ".pt", ".bin"})
        for root in roots:
            for dirpath, _dirnames, filenames in os.walk(root):
                for fn in filenames:
                    ext = os.path.splitext(fn)[1].lower()
                    if ext in exts:
                        yield os.path.join(dirpath, fn)

    def _sha256_file(self, path: str) -> str:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()

    def _process_file(self, path: str, full: bool):
        st = os.stat(path)
        dir_path = os.path.dirname(path)
        name = os.path.basename(path)
        mtime_ns = int(st.st_mtime_ns)
        size_bytes = int(st.st_size)
        type_ = infer_type(path)
        # We always compute sha256 for civitai compatibility; future: use cache table
        hash_hex = self._sha256_file(path)
        model_id = db.upsert_model(
            path=path,
            dir_path=dir_path,
            name=name,
            type_=type_,
            size_bytes=size_bytes,
            mtime_ns=mtime_ns,
            hash_algo="sha256",
            hash_hex=hash_hex,
            created_at_ms=int(time.time() * 1000),
            meta_json=None,
        )
        with self._lock:
            self._stats.by_type[type_] = self._stats.by_type.get(type_, 0) + 1
