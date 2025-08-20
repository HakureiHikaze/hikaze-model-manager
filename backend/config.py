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

# Common type-name aliases normalization
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
    """Attempt to load folder_paths.py from the repo root; return module or None."""
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
    # Runtime: mapping from root path to type name (used when a root is exactly a type directory)
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

        # Merge additional paths from ComfyUI (e.g., defined in extra_model_paths.yaml)
        extra_roots: List[Tuple[str, str]] = []  # (abs_path, type)
        fp_mod = _load_folder_paths_module(REPO_ROOT)
        if fp_mod is not None:
            try:
                # folder_names_and_paths: {type_name: ([paths], recursiveFlag)}
                mapping = getattr(fp_mod, "folder_names_and_paths", {})
                if isinstance(mapping, dict):
                    for tname, val in mapping.items():
                        try:
                            # Compatible with (paths, recursive) or (paths, recursive, _) formats
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

        # Normalize and de-duplicate
        all_roots_set = {os.path.abspath(p) for p in roots_cfg if isinstance(p, str)}
        # Include extra roots
        for ap, _ in extra_roots:
            all_roots_set.add(ap)
        all_roots: List[str] = sorted(all_roots_set)

        # Build root->type mapping (only when the root dir name equals the type name)
        rmap: Dict[str, str] = {}
        for ap, t in extra_roots:
            base = os.path.basename(ap).strip().lower()
            # If the root dir name matches the type, treat it as type directory and map it
            if _normalize_type_name(base) == t:
                rmap[os.path.normcase(ap)] = t
        # Note: default REPO_ROOT/models is not mapped; still infer by first-level subdir

        return AppConfig(host=host, port=port, model_roots=all_roots, root_type_map=rmap)

    def save(self) -> None:
        data = {"host": self.host, "port": self.port, "model_roots": self.model_roots}
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
