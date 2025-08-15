"""
Hikaze Model Manager - ComfyUI 插件骨架
本插件当前仅提供结构，后续将按需求注册节点。
"""
from __future__ import annotations

# 插件对外暴露的节点映射（ComfyUI 约定）。
# 后续实现后在此注册：{"NodeClassName": NodeClass}。
NODE_CLASS_MAPPINGS: dict[str, type] = {}
NODE_DISPLAY_NAME_MAPPINGS: dict[str, str] = {}

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
]

