"""
HikazeCheckpointSelector - Custom checkpoint loader (official-style dropdown + selector button)
- Appearance: no input ports; one dropdown widget `ckpt_name` (official style) plus a "Read" button (injected by frontend)
- Outputs: MODEL, CLIP, VAE (same as official CheckpointLoaderSimple)
- Behavior: users can choose via dropdown or the selector button; the button also writes back to `ckpt_name`
"""
from __future__ import annotations

from typing import Tuple, Optional, Dict, Any, List

import os
import time
import json
import urllib.request
import urllib.parse

import comfy.sd  # type: ignore
import folder_paths  # type: ignore


class HikazeCheckpointSelector:
    @classmethod
    def INPUT_TYPES(cls):
        # Same as official: provide the checkpoints list directly for the dropdown
        return {
            "required": {
                "ckpt_name": (folder_paths.get_filename_list("checkpoints"), {"tooltip": "要加载的模型（checkpoint）"}),
            }
        }

    RETURN_TYPES = ("MODEL", "CLIP", "VAE")
    OUTPUT_TOOLTIPS = (
        "用于对潜空间去噪的模型。",
        "用于编码文本提示的 CLIP 模型。",
        "用于图像与潜空间相互转换的 VAE。",
    )
    FUNCTION = "load_checkpoint"

    CATEGORY = "hikaze/loaders"
    DESCRIPTION = "通过下拉或选择器选择并加载 checkpoint（行为与官方 CheckpointLoaderSimple 对齐）。"

    # --- Helpers for backend integration ---
    @staticmethod
    def _plugin_root_dir() -> str:
        # nodes/ -> plugin root
        return os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))

    @classmethod
    def _load_backend_base_url(cls) -> str:
        """Read plugin data/config.json for backend host/port, default http://127.0.0.1:8789"""
        try:
            cfg_path = os.path.join(cls._plugin_root_dir(), "data", "config.json")
            if os.path.exists(cfg_path):
                with open(cfg_path, "r", encoding="utf-8") as f:
                    cfg = json.load(f) or {}
                host = (cfg.get("host") or "127.0.0.1").strip()
                port = int(cfg.get("port") or 8789)
            else:
                host, port = "127.0.0.1", 8789
        except Exception:
            host, port = "127.0.0.1", 8789
        scheme = "http"
        return f"{scheme}://{host}:{port}"

    @staticmethod
    def _http_get_json(url: str, timeout: float = 2.0) -> Optional[Dict[str, Any]]:
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                if resp.status != 200:
                    return None
                data = resp.read()
                try:
                    return json.loads(data.decode("utf-8", errors="ignore"))
                except Exception:
                    return None
        except Exception:
            return None

    @staticmethod
    def _download_to_temp(image_url: str) -> Optional[Dict[str, str]]:
        """
        Download an image into ComfyUI's temp directory and return {filename, subfolder, type}.
        Supports either /media/ relative path or a full URL.
        """
        try:
            # Normalize URL: if it's relative, the caller must prepend http://host:port
            base_dir = folder_paths.get_temp_directory()
            os.makedirs(base_dir, exist_ok=True)
            # Parse filename and extension
            parsed = urllib.parse.urlparse(image_url)
            if not parsed.scheme:
                # Treat as relative path (caller should pass complete base_url + rel)
                return None
            ext = os.path.splitext(parsed.path)[1] or ".png"
            ts = int(time.time() * 1000)
            fname = f"hikaze_ckpt_preview_{ts}{ext}"
            out_path = os.path.join(base_dir, fname)
            with urllib.request.urlopen(image_url, timeout=3.0) as resp:
                if resp.status != 200:
                    return None
                raw = resp.read()
            with open(out_path, "wb") as f:
                f.write(raw)
            return {"filename": fname, "subfolder": "", "type": "temp"}
        except Exception:
            return None

    @classmethod
    def _find_model_by_ckpt(cls, base_url: str, ckpt_name: str) -> Optional[Dict[str, Any]]:
        # Fuzzy query via /models?q= then match ckpt_name exactly from results
        try:
            q = urllib.parse.quote(ckpt_name)
            url = f"{base_url}/models?q={q}&limit=50"
            data = cls._http_get_json(url)
            if not data or "items" not in data:
                return None
            for item in data.get("items", []) or []:
                try:
                    if (item or {}).get("ckpt_name") == ckpt_name:
                        return item
                except Exception:
                    continue
        except Exception:
            return None
        return None

    @classmethod
    def _get_prompts_text(cls, base_url: str, mid: int) -> Optional[str]:
        try:
            url = f"{base_url}/models/{mid}/params"
            params = cls._http_get_json(url)
            if not isinstance(params, dict):
                return None
            pos = params.get("prompt") or params.get("positive") or ""
            neg = params.get("negative") or params.get("negative_prompt") or ""
            # Only assemble when present
            lines: List[str] = []
            if pos:
                lines.append(f"Positive: {pos}")
            if neg:
                lines.append(f"Negative: {neg}")
            if not lines:
                return None
            return "\n".join(lines)
        except Exception:
            return None

    @classmethod
    def _build_ui_payload(cls, ckpt_name: str) -> Optional[Dict[str, Any]]:
        base_url = cls._load_backend_base_url()
        model = cls._find_model_by_ckpt(base_url, ckpt_name)
        if not model:
            return None
        ui: Dict[str, Any] = {}
        # image
        images = model.get("images") if isinstance(model, dict) else None
        if isinstance(images, list) and images:
            first_url: Optional[str] = None
            for it in images:
                if isinstance(it, str) and it:
                    first_url = it
                    break
            if first_url:
                rel = first_url
                # Build full URL (compatible with already-absolute URLs)
                if rel.startswith("http://") or rel.startswith("https://"):
                    full = rel
                else:
                    if not rel.startswith("/"):
                        rel = "/" + rel
                    full = f"{base_url}{rel}"
                img_entry = cls._download_to_temp(full)
                if img_entry:
                    ui["images"] = [img_entry]
        # prompts
        try:
            mid = int(model.get("id"))
        except Exception:
            mid = None  # type: ignore
        if mid is not None:
            txt = cls._get_prompts_text(base_url, mid)
            if txt:
                ui["text"] = (txt,)
        return ui or None

    @staticmethod
    def _resolve_ckpt_path(ckpt_name: str) -> str:
        return folder_paths.get_full_path_or_raise("checkpoints", ckpt_name)

    @classmethod
    def VALIDATE_INPUTS(cls, ckpt_name: str):  # noqa: N802 (ComfyUI convention)
        if not ckpt_name or not isinstance(ckpt_name, str):
            return "未选择模型（ckpt_name 为空）"
        try:
            cls._resolve_ckpt_path(ckpt_name)
        except Exception as e:
            return f"无效的checkpoint路径: {ckpt_name} ({e})"
        return True

    def load_checkpoint(self, ckpt_name: str) -> Tuple[object, object, object]:
        ckpt_path = self._resolve_ckpt_path(ckpt_name)
        out = comfy.sd.load_checkpoint_guess_config(
            ckpt_path,
            output_vae=True,
            output_clip=True,
            embedding_directory=folder_paths.get_folder_paths("embeddings"),
        )
        # Build UI preview (sample image + prompts); ignore on failure and just return model
        ui_payload = None
        try:
            ui_payload = self._build_ui_payload(ckpt_name)
        except Exception:
            ui_payload = None

        if ui_payload:
            return {"result": out[:3], "ui": ui_payload}  # type: ignore[return-value]
        return out[:3]


NODE_CLASS_MAPPINGS = {
    "HikazeCheckpointSelector": HikazeCheckpointSelector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "HikazeCheckpointSelector": "Checkpoint Selector",
}
