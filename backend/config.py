# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import os
import importlib.util
from dataclasses import dataclass, field
from typing import List, Dict, Optional, Tuple


PLUGIN_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
DATA_ROOT = os.path.join(PLUGIN_DIR, "data")
DB_PATH = os.path.join(DATA_ROOT, "hikaze_mm.sqlite3")
IMAGES_ROOT = os.path.join(DATA_ROOT, "images")
CONFIG_PATH = os.path.join(DATA_ROOT, "config.json")


def _find_repo_root(start_dir: str) -> str:
    cur = start_dir
    for _ in range(6):
        if os.path.exists(os.path.join(cur, "folder_paths.py")) and os.path.isdir(os.path.join(cur, "models")):
            return cur
        nxt = os.path.abspath(os.path.join(cur, os.pardir))
        if nxt == cur:
            break
        cur = nxt
    return start_dir  # fallback


REPO_ROOT = _find_repo_root(PLUGIN_DIR)
DEFAULT_MODEL_ROOTS = [os.path.join(REPO_ROOT, "models")]

# 常见类型别名归一
_NAME_ALIASES = {
    "checkpoints": "checkpoint",
    "loras": "lora",
    "embeddings": "embedding",
    "upscale_models": "upscale",
}

SYSTEM_TAGS = {"checkpoint", "lora", "embedding", "vae", "upscale", "ultralytics", "other"}
DEFAULT_PORT = 8789
DEFAULT_HOST = "127.0.0.1"


def _load_folder_paths_module(repo_root: str):
    """尝试从仓库根加载 folder_paths.py，返回模块或 None。"""
    try:
        fp = os.path.join(repo_root, "folder_paths.py")
        if not os.path.exists(fp):
            return None
        spec = importlib.util.spec_from_file_location("comfy_folder_paths", fp)
        if spec is None or spec.loader is None:
            return None
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    except Exception:
        return None


def _normalize_type_name(name: str) -> str:
    n = (name or "").strip().lower()
    return _NAME_ALIASES.get(n, n)


@dataclass
class AppConfig:
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    model_roots: List[str] = None
    # 运行时计算：根路径 -> 类型名 的映射（当根目录即为类型目录时使用）
    root_type_map: Dict[str, str] = field(default_factory=dict)

    @staticmethod
    def load() -> "AppConfig":
        os.makedirs(DATA_ROOT, exist_ok=True)
        os.makedirs(IMAGES_ROOT, exist_ok=True)
        if os.path.exists(CONFIG_PATH):
            try:
                with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                    cfg = json.load(f)
            except Exception:
                cfg = {}
        else:
            cfg = {}
        host = cfg.get("host", DEFAULT_HOST)
        port = int(cfg.get("port", DEFAULT_PORT))
        roots_cfg = cfg.get("model_roots")
        if not roots_cfg:
            roots_cfg = [p for p in DEFAULT_MODEL_ROOTS if os.path.isdir(p)]

        # 合并 ComfyUI 的额外路径（如 extra_model_paths.yaml 中定义的）
        extra_roots: List[Tuple[str, str]] = []  # (abs_path, type)
        fp_mod = _load_folder_paths_module(REPO_ROOT)
        if fp_mod is not None:
            try:
                # folder_names_and_paths: {type_name: ([paths], recursiveFlag)}
                mapping = getattr(fp_mod, "folder_names_and_paths", {})
                if isinstance(mapping, dict):
                    for tname, val in mapping.items():
                        try:
                            # 兼容 (paths, recursive) 或 (paths, recursive, _) 形式
                            paths = val[0] if isinstance(val, (list, tuple)) and val else []
                            for p in paths or []:
                                if not isinstance(p, str):
                                    continue
                                ap = os.path.abspath(p)
                                if os.path.isdir(ap):
                                    extra_roots.append((ap, _normalize_type_name(str(tname))))
                        except Exception:
                            continue
            except Exception:
                pass

        # 统一去重&规范化
        all_roots_set = {os.path.abspath(p) for p in roots_cfg if isinstance(p, str)}
        # 并入额外路径
        for ap, _ in extra_roots:
            all_roots_set.add(ap)
        all_roots: List[str] = sorted(all_roots_set)

        # 生成 root->type 映射（仅对直接为类型目录的根路径设置）
        rmap: Dict[str, str] = {}
        for ap, t in extra_roots:
            base = os.path.basename(ap).strip().lower()
            # 如果该根目录名与类型名一致，认为它是类型目录，建立映射
            if _normalize_type_name(base) == t:
                rmap[os.path.normcase(ap)] = t
        # 注意：默认的 REPO_ROOT/models 不设置映射，仍按一级子目录推断

        return AppConfig(host=host, port=port, model_roots=all_roots, root_type_map=rmap)

    def save(self) -> None:
        data = {"host": self.host, "port": self.port, "model_roots": self.model_roots}
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
