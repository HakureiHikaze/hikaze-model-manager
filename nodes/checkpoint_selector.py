"""
HikazeCheckpointSelector - 自定义Checkpoint加载器（官方风格下拉 + 选择器按钮）
- 外观：无输入端口；一个下拉小部件 ckpt_name（官方风格），外加“读取”按钮（由前端注入）
- 输出：MODEL, CLIP, VAE（与官方 CheckpointLoaderSimple 一致）
- 行为：用户可通过下拉或“读取”按钮选择；按钮回填同样写入 ckpt_name
"""
from __future__ import annotations

from typing import Tuple

import comfy.sd  # type: ignore
import folder_paths  # type: ignore


class HikazeCheckpointSelector:
    @classmethod
    def INPUT_TYPES(cls):
        # 与官方一致：直接提供 checkpoints 列表作为下拉
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

    @staticmethod
    def _resolve_ckpt_path(ckpt_name: str) -> str:
        return folder_paths.get_full_path_or_raise("checkpoints", ckpt_name)

    @classmethod
    def VALIDATE_INPUTS(cls, ckpt_name: str):  # noqa: N802 (ComfyUI约定)
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
        return out[:3]


NODE_CLASS_MAPPINGS = {
    "HikazeCheckpointSelector": HikazeCheckpointSelector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "HikazeCheckpointSelector": "Checkpoint Selector",
}
