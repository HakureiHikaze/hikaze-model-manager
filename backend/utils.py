# -*- coding: utf-8 -*-
"""通用工具：JSON 编解码与路径计算等"""
from __future__ import annotations

import json
import os
from typing import Any, Optional


def json_dumps_bytes(obj: Any) -> bytes:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def json_loads_bytes(data: bytes) -> Any:
    if not data:
        return None
    return json.loads(data.decode("utf-8"))


# 计算 checkpoints 相对路径（ckpt_name），以兼容 ComfyUI 官方加载器

def calc_ckpt_name(abs_path: str) -> Optional[str]:
    try:
        import folder_paths  # type: ignore
    except Exception:
        return None
    try:
        ap = os.path.abspath(abs_path)
        roots = list(folder_paths.get_folder_paths("checkpoints"))  # type: ignore
        for r in roots:
            try:
                rabs = os.path.abspath(r)
                common = os.path.commonpath([os.path.normcase(rabs), os.path.normcase(ap)])
                if common == os.path.normcase(rabs):
                    rel = os.path.relpath(ap, rabs).replace("\\", "/")
                    return rel
            except Exception:
                continue
        # 未命中任何根：返回文件名做保底
        return os.path.basename(ap)
    except Exception:
        return None


# 计算相对路径的通用函数

def calc_rel_in_domain(abs_path: str, domain: str) -> Optional[str]:
    try:
        import folder_paths  # type: ignore
    except Exception:
        return None
    try:
        ap = os.path.abspath(abs_path)
        roots = list(folder_paths.get_folder_paths(domain))  # type: ignore
        for r in roots:
            try:
                rabs = os.path.abspath(r)
                common = os.path.commonpath([os.path.normcase(rabs), os.path.normcase(ap)])
                if common == os.path.normcase(rabs):
                    rel = os.path.relpath(ap, rabs).replace("\\", "/")
                    return rel
            except Exception:
                continue
        return os.path.basename(ap)
    except Exception:
        return None


def is_checkpoint_type(name: Optional[str]) -> bool:
    n = (name or "").strip().lower()
    return n in ("checkpoint", "checkpoints")

