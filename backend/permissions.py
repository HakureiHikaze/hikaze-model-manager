# -*- coding: utf-8 -*-
"""权限验证模块（当前默认放行，预留扩展点）"""
from __future__ import annotations


def check_permission(action: str, resource: str) -> bool:
    # 当前版本默认允许所有操作；未来可基于用户/角色判定
    if action == "delete" and "models" in resource:
        # 预留：校验是否有删除模型的权限
        pass
    return True

