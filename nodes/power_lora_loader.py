"""
HikazePowerLoraLoader - Multi-LoRA loader that mirrors ComfyUI's LoraLoader behavior
but supports multiple LoRAs in a single node. Frontend injects dynamic inputs as
lora_0, lora_0_on, lora_0_strength_model, lora_0_strength_clip, lora_1, ... etc.

Contract:
- Inputs (required): MODEL, CLIP
- Inputs (optional): up to MAX_LORAS groups named as above
- Behavior: apply LoRAs in ascending index order, skipping disabled or zero-strength ones.
- Outputs: patched MODEL, patched CLIP

Notes:
- All comments and docs are in English for open source policy compliance.
- The frontend normalizes the LoRA "key" to a relative name under the loras folder.
- We resolve actual file path via folder_paths.get_full_path_or_raise("loras", name).
"""
from __future__ import annotations

from typing import Dict, Tuple, Any

import folder_paths  # type: ignore
import numbers
import json
from nodes import LoraLoader  # type: ignore


class HikazePowerLoraLoader:
    # Upper bound of simultaneously-declared optional inputs.
    # The frontend can create any number of widgets; declaring a generous
    # maximum on the backend keeps graph validation simple.
    MAX_LORAS = 16

    def __init__(self) -> None:
        # No longer need LoRA cache since we use ComfyUI's standard loader
        pass

    @classmethod
    def INPUT_TYPES(cls):  # noqa: N802 (ComfyUI convention)
        # Build optional inputs for many LoRA slots.
        optional: Dict[str, Tuple[Any, Dict[str, Any]]] = {}
        for i in range(int(cls.MAX_LORAS)):  # type: ignore[call-overload]
            # Name as free string; frontend supplies normalized relative path
            optional[f"lora_{i}"] = (
                "STRING",
                {
                    "multiline": False,
                    "tooltip": f"LoRA file (relative under 'loras') for slot {i}",
                },
            )
            # On/off switch
            optional[f"lora_{i}_on"] = (
                "BOOLEAN",
                {"default": True, "tooltip": f"Enable LoRA slot {i}"},
            )
            # Strengths
            optional[f"lora_{i}_strength_model"] = (
                "FLOAT",
                {
                    "default": 1.0,
                    "min": -100.0,
                    "max": 100.0,
                    "step": 0.01,
                    "tooltip": f"Model strength for slot {i}",
                },
            )
            optional[f"lora_{i}_strength_clip"] = (
                "FLOAT",
                {
                    "default": 1.0,
                    "min": -100.0,
                    "max": 100.0,
                    "step": 0.01,
                    "tooltip": f"CLIP strength for slot {i}",
                },
            )

        return {
            "required": {
                "model": ("MODEL", {"tooltip": "The diffusion model to patch."}),
                "clip": ("CLIP", {"tooltip": "The CLIP model to patch."}),
            },
            "optional": optional,
        }

    RETURN_TYPES = ("MODEL", "CLIP")
    OUTPUT_TOOLTIPS = (
        "The modified diffusion model.",
        "The modified CLIP model.",
    )
    FUNCTION = "apply_loras"

    CATEGORY = "hikaze/loaders"
    DESCRIPTION = (
        "Apply multiple LoRAs to MODEL and CLIP in one node. Order matters: lower indices are applied first."
    )

    # --- helpers ---
    def _resolve_lora_name(self, name: str) -> str:
        """Resolve a LoRA relative name to a valid LoRA name for ComfyUI.
        Accepts subfolder paths like "subdir/file.safetensors".
        Returns the LoRA name that ComfyUI can find, not the full path.
        """
        try:
            # First try to verify the name exists by getting the full path
            folder_paths.get_full_path_or_raise("loras", name)
            # If successful, return the name as-is
            return name
        except Exception:
            # Fallback: case-insensitive search over known lora filenames
            try:
                target_norm = str(name).replace("\\", "/").strip().lower()
                if not target_norm:
                    raise
                all_names = folder_paths.get_filename_list("loras")
                match_actual = None
                for n in all_names:
                    n_norm = str(n).replace("\\", "/").strip().lower()
                    if n_norm == target_norm:
                        match_actual = n
                        break
                if match_actual is None:
                    # Try basename-only match as last resort
                    import os
                    target_base = os.path.basename(target_norm)
                    for n in all_names:
                        if os.path.basename(str(n)).lower() == target_base:
                            match_actual = n
                            break
                if match_actual is None:
                    raise FileNotFoundError(f"LoRA not found: {name}")
                return match_actual
            except Exception:
                # Re-raise with original name if all fails
                raise FileNotFoundError(f"LoRA not found: {name}")


    # --- utilities ---
    @staticmethod
    def _to_float(val: Any, default: float = 1.0) -> float:
        try:
            if isinstance(val, numbers.Real):
                return float(val)
            # fallback: try string conversion
            return float(str(val))
        except Exception:
            return default

    def _parse_slot(self, idx: int, kwargs: Dict[str, Any]) -> Tuple[str | None, bool, float, float]:
        """Parse one LoRA slot from kwargs.
        Supports multiple formats:
        - New UI: lora_{i} is a dict or JSON string with keys {key, sm, sc, label}
        - Old UI: lora_{i} (string), lora_{i}_on (bool), lora_{i}_strength_model (float), lora_{i}_strength_clip (float)
        Returns: (key or None, enabled, sm, sc)
        """
        raw = kwargs.get(f"lora_{idx}")
        enabled = True
        sm = self._to_float(kwargs.get(f"lora_{idx}_strength_model", 1.0), 1.0)
        sc = self._to_float(kwargs.get(f"lora_{idx}_strength_clip", 1.0), 1.0)
        if f"lora_{idx}_on" in kwargs:
            try:
                enabled = bool(kwargs.get(f"lora_{idx}_on", True))
            except Exception:
                enabled = True

        # If raw is a mapping from the new widget
        try:
            if isinstance(raw, dict):
                key = str(raw.get("key") or "").strip()
                # Prefer strengths from the object if provided
                sm = self._to_float(raw.get("sm", sm), sm)
                sc = self._to_float(raw.get("sc", sc), sc)
                # Support optional on flag in object (future-proof)
                if "on" in raw:
                    try:
                        enabled = bool(raw.get("on"))
                    except Exception:
                        pass
                return (key or None, enabled, sm, sc)
        except Exception:
            pass

        # If raw is a JSON string from the new widget
        try:
            if isinstance(raw, str) and raw.strip().startswith("{"):
                obj = json.loads(raw)
                if isinstance(obj, dict):
                    key = str(obj.get("key") or "").strip()
                    sm = self._to_float(obj.get("sm", sm), sm)
                    sc = self._to_float(obj.get("sc", sc), sc)
                    if "on" in obj:
                        try:
                            enabled = bool(obj.get("on"))
                        except Exception:
                            pass
                    return (key or None, enabled, sm, sc)
        except Exception:
            # fallthrough to treat as plain string
            pass

        # Old behavior: raw is the string key
        try:
            key = str(raw).strip() if raw is not None else ""
        except Exception:
            key = ""
        if not key:
            return (None, enabled, sm, sc)
        return (key, enabled, sm, sc)

    # --- main function ---
    def apply_loras(self, model, clip, **kwargs):  # type: ignore[override]
        """Apply enabled LoRAs in ascending slot order.
        Inputs come both from declared optional inputs and potential future dynamic ones
        (the frontend ensures matching names).
        """
        patched_model = model
        patched_clip = clip

        # Create a LoraLoader instance to use ComfyUI's standard LoRA loading method
        loader = LoraLoader()

        for i in range(int(self.MAX_LORAS)):  # type: ignore[call-overload]
            key_str, enabled, sm, sc = self._parse_slot(i, kwargs)
            if not key_str:
                continue
            if key_str.lower() in {"none", "null", ""}:
                continue
            if (not enabled) or (sm == 0.0 and sc == 0.0):
                continue

            # Resolve LoRA name and apply using ComfyUI's standard method
            lora_name = self._resolve_lora_name(key_str)
            try:
                patched_model, patched_clip = loader.load_lora(
                    patched_model, patched_clip, lora_name, float(sm), float(sc)
                )
            except Exception:
                # Skip on single-row failure to avoid failing the whole node
                continue

        return (patched_model, patched_clip)


NODE_CLASS_MAPPINGS = {
    "HikazePowerLoraLoader": HikazePowerLoraLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "HikazePowerLoraLoader": "Power LoRA Loader",
}
