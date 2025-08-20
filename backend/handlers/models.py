# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import os
import re
import time
from http.server import BaseHTTPRequestHandler
from typing import Iterable, List, Literal, Optional
from urllib.parse import parse_qs

from .. import db
from ..paths import MEDIA_DIR
from ..utils import (
    json_dumps_bytes,
    calc_ckpt_name,
    calc_rel_in_domain,
    is_checkpoint_type,
)


def types_with_counts(handler: BaseHTTPRequestHandler) -> None:
    handler._set_headers(200)  # type: ignore[attr-defined]
    handler.wfile.write(json_dumps_bytes(db.types_with_counts()))


def list_models(handler: BaseHTTPRequestHandler, raw_query: str) -> None:
    qs = parse_qs(raw_query or "")
    q = qs.get("q", [None])[0]
    type_ = qs.get("type", [None])[0]
    tags_param = qs.get("tags", [])
    tags_list: List[str] = []
    for t in tags_param:
        parts = [p for p in t.split(",") if p]
        tags_list.extend(parts)
    tags_mode_vals = qs.get("tags_mode", ["all"]) or ["all"]
    tags_mode_str = str(tags_mode_vals[0]).lower()
    tm: Literal['all', 'any'] = 'any' if tags_mode_str == 'any' else 'all'
    limit = int(qs.get("limit", ["50"])[0])
    offset = int(qs.get("offset", ["0"])[0])
    sort = qs.get("sort", ["created"])[0]
    order_str = qs.get("order", ["desc"])[0]
    ordv: Literal['asc', 'desc'] = 'asc' if order_str == 'asc' else 'desc'

    items, total = db.query_models(
        q=q, type_=type_, dir_path=None, tags=tags_list or None, tags_mode=tm, limit=limit, offset=offset, sort=sort, order=ordv
    )
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
        ckpt_name = None
        lora_name = None
        if is_checkpoint_type(m.get("type")):
            ckpt_name = calc_ckpt_name(m.get("path") or "")
        if (m.get("type") or "").strip().lower() in ("lora", "loras"):
            lora_name = calc_rel_in_domain(m.get("path") or "", "loras")
        out.append({
            "id": m["id"],
            "path": m["path"],
            "name": m.get("name"),
            "type": m.get("type"),
            "size_bytes": m.get("size_bytes"),
            "hash_hex": m.get("hash_hex"),
            "created_at": m.get("created_at"),
            "tags": tags,
            "meta": meta,
            "extra": extra,
            "images": (extra or {}).get("images") if isinstance(extra, dict) else None,
            "ckpt_name": ckpt_name,
            "lora_name": lora_name,
        })
    handler._set_headers(200)  # type: ignore[attr-defined]
    handler.wfile.write(json_dumps_bytes({"items": out, "total": total}))


def get_model(handler: BaseHTTPRequestHandler, mid: int) -> None:
    model = db.get_model_by_id(mid)
    if not model:
        handler._set_headers(404)  # type: ignore[attr-defined]
        handler.wfile.write(json_dumps_bytes({"error": {"code": "NOT_FOUND", "message": "model not found"}}))
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
    try:
        if is_checkpoint_type(out.get("type")):
            out["ckpt_name"] = calc_ckpt_name(out.get("path") or "")
        if (out.get("type") or "").strip().lower() in ("lora", "loras"):
            out["lora_name"] = calc_rel_in_domain(out.get("path") or "", "loras")
    except Exception:
        pass
    out.pop("meta_json", None)
    out.pop("extra_json", None)
    handler._set_headers(200)  # type: ignore[attr-defined]
    handler.wfile.write(json_dumps_bytes(out))


def get_extra(handler: BaseHTTPRequestHandler, mid: int) -> None:
    model = db.get_model_by_id(mid)
    if not model:
        handler._set_headers(404)  # type: ignore[attr-defined]
        handler.wfile.write(json_dumps_bytes({"error": {"code": "NOT_FOUND", "message": "model not found"}}))
        return
    try:
        extra = json.loads(model.get("extra_json") or "{}")
    except Exception:
        extra = {}
    handler._set_headers(200)  # type: ignore[attr-defined]
    handler.wfile.write(json_dumps_bytes(extra))


def get_params(handler: BaseHTTPRequestHandler, mid: int) -> None:
    model = db.get_model_by_id(mid)
    if not model:
        handler._set_headers(404)  # type: ignore[attr-defined]
        handler.wfile.write(json_dumps_bytes({"error": {"code": "NOT_FOUND", "message": "model not found"}}))
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
            params.update(extra["params"])  # prefer user-extended params
        if "prompts" in extra and isinstance(extra["prompts"], dict):
            params.update(extra["prompts"])  # include prompt/negative
    if isinstance(meta, dict) and "params" in meta and isinstance(meta["params"], dict):
        for k, v in meta["params"].items():
            params.setdefault(k, v)
    handler._set_headers(200)  # type: ignore[attr-defined]
    handler.wfile.write(json_dumps_bytes(params))


def refresh(handler: BaseHTTPRequestHandler, scanner, data: dict) -> None:
    mid = data.get("id")
    mpath = data.get("path")
    compute_hash = bool(data.get("compute_hash", False))
    if mid is not None and not mpath:
        m = db.get_model_by_id(int(mid))
        if not m:
            handler._set_headers(404)  # type: ignore[attr-defined]
            handler.wfile.write(json_dumps_bytes({"error": {"code": "NOT_FOUND", "message": "model not found"}}))
            return
        mpath = m.get("path")
    if not mpath:
        handler._set_headers(400)  # type: ignore[attr-defined]
        handler.wfile.write(json_dumps_bytes({"error": {"code": "VALIDATION_ERROR", "message": "id or path required"}}))
        return
    ok = scanner.refresh_one(mpath, compute_hash=compute_hash) if scanner else False
    handler._set_headers(200)  # type: ignore[attr-defined]
    handler.wfile.write(json_dumps_bytes({"refreshed": bool(ok)}))


def set_tags(handler: BaseHTTPRequestHandler, mid: int, data: dict) -> None:
    model = db.get_model_by_id(mid)
    if not model:
        handler._set_headers(404)  # type: ignore[attr-defined]
        handler.wfile.write(json_dumps_bytes({"error": {"code": "NOT_FOUND", "message": "model not found"}}))
        return
    ensure_type = model.get("type")
    add = data.get("add") or []
    remove = data.get("remove") or []
    try:
        tags = db.set_model_tags(mid, add, remove, ensure_type=ensure_type)
    except ValueError as e:
        handler._set_headers(400)  # type: ignore[attr-defined]
        handler.wfile.write(json_dumps_bytes({"error": {"code": "VALIDATION_ERROR", "message": str(e)}}))
        return
    handler._set_headers(200)  # type: ignore[attr-defined]
    handler.wfile.write(json_dumps_bytes({"id": mid, "tags": tags}))


def update_extra(handler: BaseHTTPRequestHandler, mid: int, data: dict) -> None:
    model = db.get_model_by_id(mid)
    if not model:
        handler._set_headers(404)  # type: ignore[attr-defined]
        handler.wfile.write(json_dumps_bytes({"error": {"code": "NOT_FOUND", "message": "model not found"}}))
        return
    try:
        current = json.loads(model.get("extra_json") or "{}")
    except Exception:
        current = {}
    if not isinstance(current, dict) or not isinstance(data, dict):
        current = {}
    current.update(data)
    with db.get_conn():
        db.get_conn().execute("UPDATE models SET extra_json=? WHERE id= ?", (json.dumps(current, ensure_ascii=False), mid))
    handler._set_headers(200)  # type: ignore[attr-defined]
    handler.wfile.write(json_dumps_bytes(current))


def upload_image(handler: BaseHTTPRequestHandler, mid: int) -> None:
    model = db.get_model_by_id(mid)
    if not model:
        handler._set_headers(404)  # type: ignore[attr-defined]
        handler.wfile.write(json_dumps_bytes({"error": {"code": "NOT_FOUND", "message": "model not found"}}))
        return
    try:
        length = int(handler.headers.get("Content-Length", "0"))  # type: ignore[attr-defined]
    except Exception:
        length = 0
    if length <= 0:
        handler._set_headers(400)  # type: ignore[attr-defined]
        handler.wfile.write(json_dumps_bytes({"error": {"code": "VALIDATION_ERROR", "message": "empty body"}}))
        return
    raw = handler.rfile.read(length)  # type: ignore[attr-defined]
    orig_name = handler.headers.get("X-Filename") or "upload.bin"  # type: ignore[attr-defined]
    base = os.path.basename(orig_name)
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", base)
    ts = int(time.time() * 1000)
    try:
        os.makedirs(MEDIA_DIR, exist_ok=True)
    except Exception:
        pass
    out_name = f"model_{mid}_{ts}_{safe}"
    out_path = os.path.join(MEDIA_DIR, out_name)
    try:
        with open(out_path, "wb") as f:
            f.write(raw)
    except Exception as e:
        handler._set_headers(500)  # type: ignore[attr-defined]
        handler.wfile.write(json_dumps_bytes({"error": {"code": "WRITE_ERROR", "message": str(e)}}))
        return
    image_url = f"/media/{out_name}"
    try:
        try:
            current = json.loads(model.get("extra_json") or "{}")
        except Exception:
            current = {}
        if not isinstance(current, dict):
            current = {}
        current.setdefault("images", [])
        if isinstance(current["images"], list):
            current["images"] = [image_url]
        else:
            current["images"] = [image_url]
        with db.get_conn():
            db.get_conn().execute("UPDATE models SET extra_json=? WHERE id= ?", (json.dumps(current, ensure_ascii=False), mid))
    except Exception:
        handler._set_headers(200)  # type: ignore[attr-defined]
        handler.wfile.write(json_dumps_bytes({"image_url": image_url, "file": out_name, "note": "db_update_failed"}))
        return
    handler._set_headers(200)  # type: ignore[attr-defined]
    handler.wfile.write(json_dumps_bytes({"image_url": image_url, "file": out_name}))


def delete_model(handler: BaseHTTPRequestHandler, mid: int) -> None:
    model = db.get_model_by_id(mid)
    if not model:
        handler._set_headers(404)  # type: ignore[attr-defined]
        handler.wfile.write(json_dumps_bytes({"error": {"code": "NOT_FOUND", "message": "model not found"}}))
        return
    with db.get_conn():
        db.get_conn().execute("DELETE FROM models WHERE id= ?", (mid,))
    handler._set_headers(200)  # type: ignore[attr-defined]
    handler.wfile.write(json_dumps_bytes({"deleted": True, "note": "Model record removed from database, file unchanged"}))
