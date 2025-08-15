# Hikaze Model Manager (ComfyUI 插件骨架)

本目录为 ComfyUI 的插件容器，仅提供最小可加载结构，后续将按需求实现并注册节点。

- 插件入口：`__init__.py` 暴露 `NODE_CLASS_MAPPINGS` 与 `NODE_DISPLAY_NAME_MAPPINGS`
- 预留目录：`nodes/` 用于存放具体节点实现（后续补充）

开发约定：
- 避免在顶层导入重量依赖，保持插件在扫描/导入阶段零副作用。
- 节点注册集中在 `__init__.py` 完成，节点类定义放在 `nodes/` 下。
- 如需可选依赖，请做延迟导入并提供清晰错误信息。

