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
    # Fallback for script-run context
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
    # Special rule: models/sams/* belongs to 'other'
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

    def _infer_type_by_roots(self, path: str) -> str:
        apath = os.path.abspath(path)
        roots = self._cfg.model_roots or []
        rmap = getattr(self._cfg, 'root_type_map', {}) or {}
        for r in roots:
            try:
                rabs = os.path.abspath(r)
                common = os.path.commonpath([os.path.normcase(rabs), os.path.normcase(apath)])
            except Exception:
                continue
            if common == os.path.normcase(rabs):
                # If the root itself is a typed directory, return mapped type directly
                mt = rmap.get(os.path.normcase(rabs))
                if mt:
                    return mt
                # Otherwise infer by first-level subdirectory name
                rel = os.path.relpath(apath, rabs)
                parts = [p for p in rel.replace('\\','/').split('/') if p and p not in ('.','..')]
                if parts:
                    return parts[0].strip().lower()
        return 'other'

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
        # full=True indicates deep refresh: includes hash recomputation
        self._thread = threading.Thread(target=self._run, args=(paths, full), daemon=True)
        self._thread.start()
        return True

    def stop(self) -> bool:
        self._stop.set()
        return True

    def refresh_one(self, path: str, compute_hash: bool = False) -> bool:
        """Public API: refresh a single file (update indexed props; optionally recompute hash). Return success flag."""
        try:
            if not os.path.isfile(path):
                return False
            self._process_file(path, compute_hash=compute_hash)
            return True
        except Exception:
            return False

    # core
    def _run(self, roots: List[str], full: bool):
        try:
            # Pre-count files
            files = list(self._iter_files(roots))
            with self._lock:
                self._stats.total = len(files)
            for path in files:
                if self._stop.is_set():
                    break
                try:
                    # In full mode compute hashes; default is no hash computation
                    self._process_file(path, compute_hash=full)
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
        visited: set[str] = set()
        for root in roots:
            root_abs = os.path.abspath(root)
            for dirpath, dirnames, filenames in os.walk(root_abs, followlinks=True):
                # De-dup: use realpath to prevent link loops
                try:
                    rp = os.path.realpath(dirpath)
                except Exception:
                    rp = dirpath
                if os.path.normcase(rp) in visited:
                    dirnames[:] = []
                    continue
                visited.add(os.path.normcase(rp))
                # Filter subdirs to traverse: only de-dup (do not constrain leaving the root to support junctions)
                kept = []
                for d in list(dirnames):
                    p = os.path.join(dirpath, d)
                    try:
                        rpd = os.path.realpath(p)
                    except Exception:
                        rpd = p
                    if os.path.normcase(rpd) in visited:
                        continue
                    kept.append(d)
                dirnames[:] = kept
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

    def _process_file(self, path: str, compute_hash: bool):
        st = os.stat(path)
        name = os.path.basename(path)
        size_bytes = int(st.st_size)
        # New classification: first try root mapping or first-level dir under models root
        type_ = self._infer_type_by_roots(path)
        # Lazy: do not compute hash by default; reuse existing when possible
        hash_hex = ""
        if compute_hash:
            hash_hex = self._sha256_file(path)
        else:
            try:
                existing = db.get_model_by_path(path)
            except Exception:
                existing = None
            if existing:
                hash_hex = (existing.get("hash_hex") or "")
        db.upsert_model(
            path=path,
            name=name,
            type_=type_,
            size_bytes=size_bytes,
            hash_hex=hash_hex,
            created_at_ms=int(time.time() * 1000),
            meta_json=None,
        )
        with self._lock:
            self._stats.by_type[type_] = self._stats.by_type.get(type_, 0) + 1
