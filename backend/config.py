# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import List


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

SYSTEM_TAGS = {"checkpoint", "lora", "embedding", "vae", "upscale", "ultralytics", "other"}
DEFAULT_PORT = 8789
DEFAULT_HOST = "127.0.0.1"


@dataclass
class AppConfig:
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    model_roots: List[str] = None

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
        roots = cfg.get("model_roots")
        if not roots:
            roots = [p for p in DEFAULT_MODEL_ROOTS if os.path.isdir(p)]
        # de-dup and norm
        roots = sorted({os.path.abspath(p) for p in roots if isinstance(p, str)})
        return AppConfig(host=host, port=port, model_roots=roots)

    def save(self) -> None:
        data = {"host": self.host, "port": self.port, "model_roots": self.model_roots}
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

