# -*- coding: utf-8 -*-
from __future__ import annotations

import os
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler
from typing import Dict, Optional, List

try:
    from .. import db  # type: ignore
    from ..config import AppConfig  # type: ignore
except Exception:  # pragma: no cover - fallback
    import importlib.util, sys as _sys
    _BDIR = os.path.dirname(__file__)
    def _load_local(mod_name: str, rel_path: str):
        spec = importlib.util.spec_from_file_location(mod_name, os.path.join(_BDIR, os.pardir, rel_path))
        if spec is None or spec.loader is None:
            raise ImportError(f"cannot load {rel_path}")
        mod = importlib.util.module_from_spec(spec)
        _sys.modules[mod_name] = mod
        spec.loader.exec_module(mod)
        return mod
    db = _load_local("hikaze_mm_db", "db.py")  # type: ignore
    config = _load_local("hikaze_mm_config", "config.py")  # type: ignore
    AppConfig = config.AppConfig  # type: ignore

from ..utils import json_dumps_bytes

# In-memory job registry (simple; non-persistent)
_jobs_lock = threading.Lock()
_jobs: Dict[str, Dict[str, object]] = {}
_current_quick_tag_running = threading.Event()


def _register_job(job: Dict[str, object]):
    with _jobs_lock:
        _jobs[job['id']] = job


def _update_job(job_id: str, **fields):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if not job:
            return
        job.update(fields)


def _get_job(job_id: str) -> Optional[Dict[str, object]]:
    with _jobs_lock:
        j = _jobs.get(job_id)
        return dict(j) if j else None


# --- Settings CRUD ---

def get_settings(handler: BaseHTTPRequestHandler):
    payload = db.list_settings()
    handler._set_headers(200)  # type: ignore[attr-defined]
    handler.wfile.write(json_dumps_bytes({"settings": payload}))


def update_settings(handler: BaseHTTPRequestHandler, data: Dict[str, object]):
    lang = data.get('language')
    if isinstance(lang, str) and lang.strip():
        db.set_setting('language', lang.strip())
    payload = db.list_settings()
    handler._set_headers(200)  # type: ignore[attr-defined]
    handler.wfile.write(json_dumps_bytes({"settings": payload}))


# --- Quick Tag Task ---

def _find_models_root(path: str, roots: List[str]) -> Optional[str]:
    path_norm = os.path.normcase(os.path.abspath(path))
    best = None
    for r in roots:
        try:
            rabs = os.path.normcase(os.path.abspath(r))
            if path_norm.startswith(rabs + os.sep) or path_norm == rabs:
                # prefer the longest (most specific) root
                if not best or len(rabs) > len(os.path.normcase(best)):
                    best = r
        except Exception:
            continue
    return best


def _extract_tags(model_path: str, roots: List[str]) -> List[str]:
    r = _find_models_root(model_path, roots)
    if not r:
        # fallback: locate '/models/' segment
        lower = model_path.replace('\\','/').lower()
        idx = lower.find('/models/')
        if idx != -1:
            r = model_path[: idx + len('/models/') - 1]
        else:
            return []
    try:
        rel = os.path.relpath(model_path, r)
    except ValueError:
        return []
    parts = [p for p in rel.replace('\\','/').split('/') if p and p not in ('.','..')]
    if not parts:
        return []
    # remove filename
    if '.' in parts[-1]:
        parts = parts[:-1]
    cleaned = []
    seen = set()
    for seg in parts:
        tag = seg.strip().replace(' ', '_')
        if not tag:
            continue
        key = tag.lower()
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(tag)
    return cleaned


def _quick_tag_worker(job_id: str, roots: List[str]):
    try:
        _update_job(job_id, status='running', started_at=int(time.time()*1000))
        conn = db.get_conn()
        cur = conn.execute("SELECT id, path FROM models")
        rows = list(cur.fetchall())
        total = len(rows)
        _update_job(job_id, total=total)
        processed = 0
        updated = 0
        for row in rows:
            if _get_job(job_id) is None:
                # job removed (cancelled)
                break
            mid = int(row['id'])
            path = row['path']
            try:
                tags = _extract_tags(path, roots)
                if tags:
                    # fetch current tags
                    cur2 = conn.execute("SELECT t.name FROM model_tags mt JOIN tags t ON mt.tag_id=t.id WHERE mt.model_id=?", (mid,))
                    current = {r2['name'] for r2 in cur2.fetchall()}
                    # Only add new tags
                    add = [t for t in tags if t.lower() not in {c.lower() for c in current}]
                    if add:
                        db.set_model_tags(mid, add_names=add)
                        updated += 1
            except Exception:
                pass
            processed += 1
            if processed % 20 == 0 or processed == total:
                _update_job(job_id, processed=processed, updated=updated, progress=0 if total==0 else int(processed*100/max(1,total)))
        _update_job(job_id, processed=processed, updated=updated, progress=100, status='success', finished_at=int(time.time()*1000))
    except Exception as e:  # pragma: no cover
        _update_job(job_id, status='failed', error=str(e), finished_at=int(time.time()*1000))
    finally:
        _current_quick_tag_running.clear()


def start_quick_tag(handler: BaseHTTPRequestHandler, cfg: AppConfig):
    if _current_quick_tag_running.is_set():
        handler._set_headers(409)  # type: ignore[attr-defined]
        handler.wfile.write(json_dumps_bytes({"error": {"code": "JOB_RUNNING", "message": "quick_tag already running"}}))
        return
    job_id = uuid.uuid4().hex
    job = {
        'id': job_id,
        'type': 'quick_tag',
        'status': 'queued',
        'created_at': int(time.time()*1000),
        'started_at': None,
        'finished_at': None,
        'processed': 0,
        'total': 0,
        'updated': 0,
        'progress': 0,
    }
    _register_job(job)
    _current_quick_tag_running.set()
    roots = list(cfg.model_roots or [])
    th = threading.Thread(target=_quick_tag_worker, args=(job_id, roots), daemon=True)
    th.start()
    handler._set_headers(202)  # type: ignore[attr-defined]
    handler.wfile.write(json_dumps_bytes({"job": job}))


def get_job_status(handler: BaseHTTPRequestHandler, job_id: str):
    job = _get_job(job_id)
    if not job:
        handler._set_headers(404)  # type: ignore[attr-defined]
        handler.wfile.write(json_dumps_bytes({"error": {"code": "NOT_FOUND", "message": "job not found"}}))
        return
    handler._set_headers(200)  # type: ignore[attr-defined]
    handler.wfile.write(json_dumps_bytes({"job": job}))


def cancel_job(handler: BaseHTTPRequestHandler, job_id: str):
    with _jobs_lock:
        job = _jobs.pop(job_id, None)
    if not job:
        handler._set_headers(404)  # type: ignore[attr-defined]
        handler.wfile.write(json_dumps_bytes({"error": {"code": "NOT_FOUND", "message": "job not found"}}))
        return
    handler._set_headers(200)  # type: ignore[attr-defined]
    handler.wfile.write(json_dumps_bytes({"canceled": job_id}))

