# Hikaze Model Manager
**This document was written by Copilot**
[![中文](https://img.shields.io/badge/README-中文-red)](README_ZH.md)

A comprehensive model management plugin for ComfyUI that provides an intuitive interface for organizing, selecting, and managing AI models with advanced features for workflow integration.

## Overview

Hikaze Model Manager enhances your ComfyUI experience by offering a sophisticated model management system with both selection and management capabilities. Whether you need to quickly select models for your workflow or manage detailed metadata, this plugin provides a seamless solution.

## Features

### 🎯 Dual-Mode Interface
- **Model Selector**: Hidden tab interface with preselection capabilities for workflow integration
- **Model Manager**: Full-featured interface with tabs for comprehensive model metadata management

### 🔧 Enhanced Custom Nodes
- **Checkpoint Selector**: Advanced model selection with visual feedback
- **Power LoRA Loader**: Multi-LoRA stacking with individual strength controls and bypass functionality

### 🖥️ Intelligent Backend
- **Automatic Service**: Self-starting HTTP server (default port 8789) for seamless operation
- **Smart Scanning**: Efficient model discovery and metadata extraction
- **Database Management**: Persistent storage for model information and user customizations

### 🌐 Multi-Language Support
- English and Chinese (Simplified) interface
- Automatic language detection with manual override options

### ⚡ Performance Optimized
- Zero-impact plugin loading with lazy dependency imports
- Threaded backend service for responsive UI
- Efficient model scanning and caching

## Installation

1. Clone or download this repository to your ComfyUI custom nodes directory:
   ```bash
   cd ComfyUI/custom_nodes/
   git clone https://github.com/HakureiHikaze/hikaze-model-manager.git
   ```

2. Restart ComfyUI - the plugin will automatically start its backend service

3. Access the model manager through:
   - **Right-click menu**: "Model Manager" button in the ComfyUI interface
   - **Node buttons**: "Choose Models" buttons on compatible loader nodes

## Usage

### Model Selection Mode
- Opened from loader node buttons with preselected model categories
- Hidden tabs interface focused on quick selection
- Returns selected models directly to the calling node
- Supports multi-selection for LoRA loaders with strength controls

### Model Management Mode
- Opened from the main ComfyUI menu button
- Full tabbed interface for comprehensive model organization
- Edit model metadata, tags, and descriptions
- Upload and manage model preview images
- No selection confirmation - changes are saved automatically

### Power LoRA Loader
- Stack multiple LoRAs with individual strength controls
- Model and CLIP inputs are required connections
- Dynamic parameter injection for flexible workflow design
- Bypass functionality for quick enable/disable

## Architecture

### Backend Service
- **HTTP Server**: RESTful API for model operations
- **Scanner Module**: Intelligent model discovery and processing  
- **Database Layer**: SQLite-based storage for model metadata
- **Configuration System**: Flexible settings management

### Frontend Interface
- **Web Application**: Modern responsive interface
- **ComfyUI Integration**: Seamless workflow integration
- **Real-time Updates**: Live synchronization with backend

### Custom Nodes
- **Modular Design**: Clean separation of concerns
- **Flexible Input Types**: Inspired by rgthree for dynamic parameters
- **UI Enhancements**: Custom widgets for improved user experience

## Configuration

The plugin uses automatic configuration with sensible defaults:
- **Server Host**: 127.0.0.1 (localhost)
- **Server Port**: 8789
- **Model Roots**: Automatically detected from ComfyUI settings
- **Language**: Auto-detected from browser settings

## Development

### Plugin Structure
```
hikaze-model-manager/
├── __init__.py                 # Plugin entry point and node registration
├── backend/                    # Backend service modules
│   ├── server.py              # HTTP server implementation
│   ├── scanner.py             # Model scanning logic
│   ├── db.py                  # Database operations
│   └── config.py              # Configuration management
├── nodes/                      # Custom ComfyUI nodes
│   ├── checkpoint_selector.py # Checkpoint selection node
│   └── power_lora_loader.py   # Enhanced LoRA loader
└── web/                        # Frontend interface
    ├── app.js                 # Main application logic
    ├── comfyui_extension.js   # ComfyUI integration
    └── *.html                 # Interface templates
```

### Design Principles
- **Zero-Impact Loading**: No heavy imports during ComfyUI startup
- **Lazy Initialization**: Components loaded only when needed
- **Error Resilience**: Graceful degradation on component failures
- **Extensible Architecture**: Easy to add new features and nodes

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Inspired by design patterns from the [rgthree ComfyUI plugin](https://github.com/rgthree/rgthree-comfy)
- Built for the ComfyUI community

## Support

For issues, questions, or contributions, please visit the [GitHub repository](https://github.com/HakureiHikaze/hikaze-model-manager).

