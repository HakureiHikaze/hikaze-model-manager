# -*- coding: utf-8 -*-
"""Path constants and resolution"""
from __future__ import annotations

import os

# Compute project base directory based on this module file
_BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))

# Web static assets directory
WEB_DIR = os.path.join(_BASE_DIR, "web")

# Media assets directory
MEDIA_DIR = os.path.join(_BASE_DIR, "data", "images")
