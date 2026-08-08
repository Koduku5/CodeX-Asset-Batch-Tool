# 项目结构约束

本仓库是一个桌面软件源码项目，不再把另一个“安装包目录”当作执行层。

## 所有权边界

- `engine/`：正式流水线资源。只放 `assets/` 和 `scripts/`；不得放说明文档、项目 Cache、输出、测试副本或桌面构建产物。
- `skills/`：软件级公共 Skills。运行期必须读取的补充协议放在对应 Skill 自己的 `references/`，但不得复制到用户项目。
- `docs/reference/`：只供开发者查阅的数据结构、资产规则、提示词写法和外部 API 说明，不参与运行，也不进入桌面 sidecar。
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

## 模块化边界

- 可执行入口保持薄层：解析参数、装配依赖、调用领域模块并映射退出码；业务校验不得重新堆回入口。
- `engine/scripts/lib/api_batch/` 分别负责队列契约、远端传输、文件安装安全、单项状态机、批次锁与并发调度。
- `pipeline_protocol.py` 与 `pipeline_runtime.mjs` 是稳定兼容门面；新增实现进入各自领域模块，不扩大门面。
- Node 服务由 `server.mjs`、`server-services.mjs`、`server-http.mjs` 和 `routes/` 组合；领域服务不得反向依赖 HTTP 路由。
- WPF 使用 partial class 按窗口舞台、桥接脚本、API 批次 RPC 和通用 RPC 契约分离；原生互操作只留在桌面层。
- React 根入口不保存业务逻辑；工作台副作用进入 hook/controller，视图进入对应 feature，协议校验进入 service adapter。

## 验证门禁

- `npm run check:engine-python`：编译全部 Python 领域模块与薄入口。
- `npm run check:engine-powershell`：使用 PowerShell AST 解析全部命令脚本，防止 dot-source 模块边界破坏语法。
- `npm run check:server`：检查 Node 领域模块、门面与适配器语法。
- `npm run typecheck` 与 `npm run build`：验证 React/TypeScript 和生产 bundle。
- `npm test`：验证服务、流水线、UI、桌面、安全、打包与性能契约。
- `npm run check:desktop`：在安装 .NET 10 SDK 的开发机或 CI 中编译 WPF 宿主。

## 禁止事项

- 不从外部安装包目录动态读取执行代码。
- 不把 `node_modules/`、`dist/`、`.local/`、`bin/`、`obj/` 当作源码。
- 不把 `workspace/` 或测试项目打进发行目录与安装包。
- 不在 React 组件中直接拼接项目路径或执行命令。
- 不把完整 Prompt、剧本、绝对路径或凭据返回网页。
- 不用复制一整套旧页面的方式开发新功能。
