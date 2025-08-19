# -*- coding: utf-8 -*-
from __future__ import annotations

from http.server import BaseHTTPRequestHandler
from typing import Iterable, Literal, Optional

from .. import db
from ..utils import json_dumps_bytes


def list_all(handler: BaseHTTPRequestHandler) -> None:
    handler._set_headers(200)  # type: ignore[attr-defined]
    handler.wfile.write(json_dumps_bytes(db.list_tags()))


def list_by_type(handler: BaseHTTPRequestHandler, type_: Optional[str]) -> None:
    if not type_:
        handler._set_headers(200)  # type: ignore[attr-defined]
        handler.wfile.write(json_dumps_bytes([]))
        return
    handler._set_headers(200)  # type: ignore[attr-defined]
    handler.wfile.write(json_dumps_bytes(db.list_tags_by_type(type_)))


def facets(handler: BaseHTTPRequestHandler, *, type_: Optional[str], q: Optional[str], selected: Optional[Iterable[str]], mode: Literal['all', 'any']) -> None:
    try:
        res = db.tag_facets(type_=type_, q=q, selected=list(selected) if selected else None, mode=mode)
    except Exception:
        res = []
    handler._set_headers(200)  # type: ignore[attr-defined]
    handler.wfile.write(json_dumps_bytes(res))


def create(handler: BaseHTTPRequestHandler, *, name: str, color: Optional[str]) -> None:
    name = (name or '').strip()
    if not name:
        handler._set_headers(400)  # type: ignore[attr-defined]
        handler.wfile.write(json_dumps_bytes({"error": {"code": "VALIDATION_ERROR", "message": "name required"}}))
        return
    try:
        tag = db.create_tag(name, color)
    except Exception as e:
        handler._set_headers(400)  # type: ignore[attr-defined]
        handler.wfile.write(json_dumps_bytes({"error": {"code": "VALIDATION_ERROR", "message": str(e)}}))
        return
    handler._set_headers(200)  # type: ignore[attr-defined]
    handler.wfile.write(json_dumps_bytes(tag))


def update(handler: BaseHTTPRequestHandler, tid: int, *, name: Optional[str], color: Optional[str]) -> None:
    try:
        tag = db.update_tag(tid, name=name, color=color)
    except KeyError:
        handler._set_headers(404)  # type: ignore[attr-defined]
        handler.wfile.write(json_dumps_bytes({"error": {"code": "NOT_FOUND", "message": "tag not found"}}))
        return
    handler._set_headers(200)  # type: ignore[attr-defined]
    handler.wfile.write(json_dumps_bytes(tag))


def delete(handler: BaseHTTPRequestHandler, tid: int) -> None:
    try:
        db.delete_tag(tid)
    except KeyError:
        handler._set_headers(404)  # type: ignore[attr-defined]
        handler.wfile.write(json_dumps_bytes({"error": {"code": "NOT_FOUND", "message": "tag not found"}}))
        return
    handler._set_headers(200)  # type: ignore[attr-defined]
    handler.wfile.write(json_dumps_bytes({"deleted": True}))

