# -*- coding: utf-8 -*-
"""Permission checking module (currently allow-all; extension point reserved)"""
from __future__ import annotations


def check_permission(action: str, resource: str) -> bool:
    # Current version allows all operations; future: user/role-based checks
    if action == "delete" and "models" in resource:
        # Placeholder: verify permission for deleting models
        pass
    return True
