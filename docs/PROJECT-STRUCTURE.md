# 项目结构约束

本仓库是一个桌面软件源码项目，不再把另一个“安装包目录”当作执行层。

## 所有权边界

- `engine/`：正式流水线资源。只放 `assets/`、`scripts/`、`references/`；不得放项目 Cache、输出、测试副本或桌面构建产物。
- `skills/`：软件级公共 Skills。Skill 可以引用 `engine/references/`，但不得复制到用户项目。
- `src/ui/`：React 页面。界面组件、主题、交互和布局放在这里；HTTP/native 调用统一经过 `src/ui/services/`。
- `src/server/`：本地 API、项目隔离、任务调度和原生桥服务端。不得依赖任何仓库外固定路径。
- `desktop/`：WPF/WebView2 宿主，只负责窗口、进程、安全令牌、剪贴板和固定系统动作。
- `.local/`：网页开发模式的可写项目数据，以及桌面 WebView2 的可再生用户 profile。桌面源码运行和发行版都在软件根的 `workspace/` 保存正式项目、Cache 与输出。
- `packaging/`：只维护可重复的发行目录与安装包脚本；生成物统一进入被忽略的 `artifacts/`。

## 新功能放置规则

- 新页面或布局：`src/ui/features/<feature>/`。
- 可复用 UI 原语：`src/ui/components/ui/`。
- 前端数据适配器：`src/ui/services/`。
- 新本地 API：`src/server/`，并在对应 adapter 与测试中声明固定 DTO。
- 新流水线动作：`engine/scripts/`，由 `src/server/pipeline-task-runner.mjs` 固定注册；禁止接受网页传入任意命令或路径。
- 新提示词资源：`engine/assets/图片生成/prompts/`，继续遵守 Catalog schema、版本、指纹和迁移契约。

## 禁止事项

- 不从外部安装包目录动态读取执行代码。
- 不把 `node_modules/`、`dist/`、`.local/`、`bin/`、`obj/` 当作源码。
- 不把 `workspace/` 或测试项目打进发行目录与安装包。
- 不在 React 组件中直接拼接项目路径或执行命令。
- 不把完整 Prompt、剧本、绝对路径或凭据返回网页。
- 不用复制一整套旧页面的方式开发新功能。
