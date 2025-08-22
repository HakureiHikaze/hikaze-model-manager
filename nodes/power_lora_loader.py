"""
HikazePowerLoraLoader - Multiple LoRA stacking loader (with bypass)
- Inputs: MODEL, CLIP (必填) + 动态可选 lora_* 参数
- Outputs: MODEL, CLIP
"""
from __future__ import annotations

from typing import Any, Dict, List

from nodes import LoraLoader  # type: ignore
import folder_paths  # type: ignore
import os


# Lightweight implementation: FlexibleOptionalInputType and AnyType (inspired by rgthree)
class _AnyType(str):
    def __ne__(self, __value: object) -> bool:
        return False


class FlexibleOptionalInputType(dict):
    def __contains__(self, item):
        return True

    def __getitem__(self, item):
        return (_AnyType("*"), {"default": None})


_any_type = _AnyType("*")


class HikazePowerLoraLoader:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
            },
            # 关键修复：允许前端序列化注入任意 lora_* 动态参数
            "optional": FlexibleOptionalInputType(),
            "hidden": {},
        }

    RETURN_TYPES = ("MODEL", "CLIP")
    RETURN_NAMES = ("MODEL", "CLIP")
    FUNCTION = "load_loras"
    CATEGORY = "hikaze/loaders"
    DESCRIPTION = "批量加载多条 LoRA；模型与 CLIP 现在为必填输入；行序叠加；bypass=True 时直接透传"

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
                # 修正：显式识别 0 / '0' / False / 'false' 为关闭
                row["on"] = not (v in (0, "0", False, "false", "False", None))
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

    def load_loras(self, model, clip, **kwargs):
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
            except Exception:
                # Skip on single-row failure to avoid failing the whole node
                continue
        return (model, clip)


NODE_CLASS_MAPPINGS = {
    "HikazePowerLoraLoader": HikazePowerLoraLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "HikazePowerLoraLoader": "Power LoRA Loader",
}
