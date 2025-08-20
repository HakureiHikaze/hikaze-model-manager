"""
HikazePowerLoraLoader - Multiple LoRA stacking loader (with bypass)
- Inputs: optional MODEL/CLIP
- Outputs: MODEL, CLIP
- Widgets: dynamic rows (lora_N, lora_N_on, lora_N_strength_model, lora_N_strength_clip) and top-level bypass
- Execution: apply LoRA rows in order where on=true; when no CLIP input, clip strength is treated as 0; bypass=True passes through
"""
from __future__ import annotations

from typing import Any, Dict, List

from nodes import LoraLoader  # type: ignore
import folder_paths  # type: ignore
import os


# Lightweight implementation: FlexibleOptionalInputType and AnyType (inspired by rgthree)
class _AnyType(str):
    def __ne__(self, __value: object) -> bool:  # always unequal, to relax type comparison
        return False


class FlexibleOptionalInputType(dict):
    def __init__(self, type, data: Dict[str, Any] | None = None):
        self.type = type
        self.data = data or {}
        for k, v in self.data.items():
            self[k] = v

    def __getitem__(self, key):  # return (self.type,) for any undeclared key
        if key in self.data:
            return self.data[key]
        return (self.type,)

    def __contains__(self, key):  # always contains any key
        return True


_any_type = _AnyType("*")


class HikazePowerLoraLoader:
    @classmethod
    def INPUT_TYPES(cls):
        # Use FlexibleOptionalInputType to accept arbitrary dynamic keys (including lora_* and bypass)
        return {
            "required": {},
            "optional": FlexibleOptionalInputType(type=_any_type, data={
                "model": ("MODEL",),
                "clip": ("CLIP",),
            }),
        }

    RETURN_TYPES = ("MODEL", "CLIP")
    RETURN_NAMES = ("MODEL", "CLIP")
    FUNCTION = "load_loras"
    CATEGORY = "hikaze/loaders"
    DESCRIPTION = "批量加载多条 LoRA；支持旁路，行序叠加；无 CLIP 输入时 clip 强度自动为 0"

    @staticmethod
    def _collect_rows(kwargs: Dict[str, Any]) -> List[Dict[str, Any]]:
        # Aggregate kwargs lora_i_* into rows; sort by i
        import re

        groups: Dict[int, Dict[str, Any]] = {}
        pat = re.compile(r"^lora_(\d+)(?:_(on|strength_model|strength_clip))?$")
        for k, v in kwargs.items():
            m = pat.match(str(k))
            if not m:
                continue
            idx = int(m.group(1))
            sub = m.group(2)
            row = groups.setdefault(idx, {"idx": idx, "lora": None, "on": True, "strength_model": 1.0, "strength_clip": 1.0})
            if sub is None:
                row["lora"] = v
            elif sub == "on":
                row["on"] = bool(v)
            elif sub == "strength_model":
                try:
                    row["strength_model"] = float(v)
                except Exception:
                    pass
            elif sub == "strength_clip":
                try:
                    row["strength_clip"] = float(v)
                except Exception:
                    pass
        rows = list(groups.values())
        rows.sort(key=lambda r: r.get("idx", 0))
        return rows

    @staticmethod
    def _resolve_lora_name(name: str) -> str | None:
        try:
            loras = folder_paths.get_filename_list('loras')
        except Exception:
            loras = []
        if not loras:
            return None
        # direct match
        if name in loras:
            return name
        # match without extension (path or filename)
        name_noext = os.path.splitext(name)[0]
        loras_noext = [os.path.splitext(x)[0] for x in loras]
        if name_noext in loras_noext:
            return loras[loras_noext.index(name_noext)]
        # match by basename
        base = os.path.basename(name)
        loras_base = [os.path.basename(x) for x in loras]
        if base in loras_base:
            return loras[loras_base.index(base)]
        # match basename without extension
        base_noext = os.path.splitext(base)[0]
        loras_base_noext = [os.path.splitext(os.path.basename(x))[0] for x in loras]
        if base_noext in loras_base_noext:
            return loras[loras_base_noext.index(base_noext)]
        # fuzzy contains
        for i, p in enumerate(loras):
            if name in p:
                return loras[i]
        return None

    def load_loras(self, model=None, clip=None, **kwargs):
        # Bypass: support frontend-injected boolean 'bypass'
        bypass = bool(kwargs.get("bypass", False))
        if bypass:
            return (model, clip)

        rows = self._collect_rows(kwargs)
        if not rows:
            return (model, clip)

        loader = LoraLoader()
        for row in rows:
            if not row.get("on", True):
                continue
            lora_name_in = row.get("lora")
            if not lora_name_in or not isinstance(lora_name_in, str):
                continue
            lora_name = self._resolve_lora_name(lora_name_in) or lora_name_in
            sm = row.get("strength_model", 1.0)
            sc = row.get("strength_clip", 1.0)
            # When no CLIP input, force clip strength to 0
            sc_eff = 0.0 if clip is None else float(sc)
            try:
                model, clip = loader.load_lora(model, clip, lora_name, float(sm), sc_eff)
            except Exception as e:
                # Log error for debugging, but continue processing other LoRAs
                print(f"[HikazePowerLoraLoader] Failed to load LoRA '{lora_name}': {e}")
                continue
        return (model, clip)


NODE_CLASS_MAPPINGS = {
    "HikazePowerLoraLoader": HikazePowerLoraLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "HikazePowerLoraLoader": "Power LoRA Loader",
}
