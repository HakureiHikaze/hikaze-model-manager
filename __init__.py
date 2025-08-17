"""
Hikaze Model Manager - ComfyUI 插件
提供模型管理功能，包括自动启动后端服务和前端界面集成。
"""
from __future__ import annotations

import os
import threading
import time
from typing import Optional

# 插件对外暴露的节点映射（ComfyUI 约定）。
NODE_CLASS_MAPPINGS: dict[str, type] = {}
NODE_DISPLAY_NAME_MAPPINGS: dict[str, str] = {}

# Web扩展文件路径 - 确保ComfyUI能找到前端文件
WEB_DIRECTORY = os.path.join(os.path.dirname(__file__), "web")

# 后端服务实例
_server_thread: Optional[threading.Thread] = None
_server_started = False

def start_backend_server():
    """启动后端HTTP服务"""
    global _server_thread, _server_started

    if _server_started:
        return True

    try:
        from .backend.server import main as server_main
        from .backend.config import AppConfig

        # 加载配置
        config = AppConfig.load()

        def run_server():
            try:
                print(f"[Hikaze Model Manager] Starting server on {config.host}:{config.port}")
                server_main(host=config.host, port=config.port)
            except Exception as e:
                print(f"[Hikaze Model Manager] Server error: {e}")

        # 在后台线程中启动服务器
        _server_thread = threading.Thread(target=run_server, daemon=True)
        _server_thread.start()
        _server_started = True

        # 等待一段时间确保服务启动
        time.sleep(2)
        print(f"[Hikaze Model Manager] Server started successfully")
        return True

    except Exception as e:
        print(f"[Hikaze Model Manager] Failed to start server: {e}")
        return False

# 插件加载时自动启动后端服务
print("[Hikaze Model Manager] Plugin loading...")
try:
    success = start_backend_server()
    if success:
        print("[Hikaze Model Manager] Backend server initialization completed")
    else:
        print("[Hikaze Model Manager] Backend server initialization failed")
except Exception as e:
    print(f"[Hikaze Model Manager] Error during initialization: {e}")

# 注册自定义节点
try:
    from .nodes.checkpoint_selector import (
        NODE_CLASS_MAPPINGS as _CS_NODE_CLASS_MAPPINGS,
        NODE_DISPLAY_NAME_MAPPINGS as _CS_NODE_DISPLAY_NAME_MAPPINGS,
    )
    NODE_CLASS_MAPPINGS.update(_CS_NODE_CLASS_MAPPINGS)
    NODE_DISPLAY_NAME_MAPPINGS.update(_CS_NODE_DISPLAY_NAME_MAPPINGS)
    print("[Hikaze Model Manager] Nodes registered: ", list(_CS_NODE_CLASS_MAPPINGS.keys()))
except Exception as e:
    print(f"[Hikaze Model Manager] Failed to register nodes: {e}")

# 新增注册：Power LoRA Loader
try:
    from .nodes.power_lora_loader import (
        NODE_CLASS_MAPPINGS as _PL_NODE_CLASS_MAPPINGS,
        NODE_DISPLAY_NAME_MAPPINGS as _PL_NODE_DISPLAY_NAME_MAPPINGS,
    )
    NODE_CLASS_MAPPINGS.update(_PL_NODE_CLASS_MAPPINGS)
    NODE_DISPLAY_NAME_MAPPINGS.update(_PL_NODE_DISPLAY_NAME_MAPPINGS)
    print("[Hikaze Model Manager] Nodes registered: ", list(_PL_NODE_CLASS_MAPPINGS.keys()))
except Exception as e:
    print(f"[Hikaze Model Manager] Failed to register Power LoRA Loader: {e}")

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]
