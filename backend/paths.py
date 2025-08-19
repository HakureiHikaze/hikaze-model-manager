# -*- coding: utf-8 -*-
"""路径常量与解析"""
from __future__ import annotations

import os

# 基于该模块文件计算工程目录
_BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))

# web 静态资源目录
WEB_DIR = os.path.join(_BASE_DIR, "web")

# 媒体资源目录
MEDIA_DIR = os.path.join(_BASE_DIR, "data", "images")

