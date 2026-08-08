# 模块化完成审计

本文件记录“模块化完成”的可验证标准。它不是按文件数量判断完成，而是检查入口厚度、职责边界、依赖方向、测试覆盖和发布验证是否同时成立。

## 完成标准

1. 可执行入口只负责参数、依赖装配、事务编排和退出码，不重新实现领域规则。
2. 稳定兼容门面继续保留原导入路径；实现模块不得反向依赖门面。
3. 单个源码模块不超过 550 行；公开入口使用更严格的逐文件上限。
4. React、Node、Python、PowerShell 与 WPF 的边界均有自动测试或编译门禁。
5. `npm ci`、类型检查、生产构建、Node/Python 全量测试、PowerShell AST 检查全部通过。
6. WPF 必须在装有 .NET 10 SDK 的环境执行 `npm run check:desktop`；本机缺少 SDK 时不得伪报为已编译。

上述 1–4 由 `tests/modular-architecture.test.mjs` 和 `tests/project-structure.test.mjs` 自动执行，后续代码一旦把职责堆回入口会直接使测试失败。

## 当前领域分区

- API 出图：队列校验、队列新鲜度、文件安全、单项恢复状态、远端传输、批次锁、并发调度分别位于 `engine/scripts/lib/api_batch/`。
- 待确认资产：输入/前置条件、编号沿革、单集回写、最终事务编排分别位于 `pending_asset_contracts.py`、`pending_asset_identity.py`、`pending_asset_episode.py`、`pending_asset_resolution.py`。
- 交付校验：稳定输入快照、阅读/单集分析校验、累计资产规则、校验入口分离。
- Node 工作区：配置、路径安全、项目元数据、共享资产、剧本导入、运行时物化分别独立；主类只保留生命周期与项目操作。
- React 工作台：项目、任务、Codex、阶段计时、窗口壳层、流水线视图模型和页面编排分别独立。
- PowerShell API 窗口：契约、状态、无头模式、布局、事件编排、执行窗和进程启动分别独立。
- WPF：窗口舞台、桥接脚本、API 批次 RPC 与通用 RPC 契约通过 partial class 分区。

## 保留的长模块

少数模块接近但不超过 550 行，它们保留的原因是内部仍是一个不可分割的事务或规则域，而不是混合职责：

- `api_batch/item_runner.py`：一个远端图片任务从提交、轮询、下载到可恢复失败的完整状态机。
- `batch_generate_images.py`：批次级锁、恢复选择和结果汇总的 CLI 编排。
- `build_workbook.mjs`：一个工作簿的锁内读取、填充、校验和原子替换事务。
- `asset_record_validation.py`：资产、单集分析和待确认记录共享的纯校验规则。

若这些文件继续增长，550 行总门禁会要求先抽取新的明确子域。

## 本次验收结果（2026-08-08）

- `npm ci` 成功，`npm audit` 为 0 个漏洞。
- `npm run check` 整体退出码为 0。
- Node 测试共 246 项：244 通过、0 失败、2 项因当前 Windows 环境不允许创建符号链接而跳过。
- Python 测试共 14 项：14 通过、0 失败。
- React/TypeScript 类型检查和 Vite 生产构建通过。
- PowerShell 全量 AST 语法检查通过。
- 使用官方 .NET SDK 10.0.302 编译 `PromptStudio.Desktop.csproj`：0 警告、0 错误。

## 已发现但不属于模块化的功能缺口

Prompt Studio 的单条条件模块调试仍依赖宿主注入的 `promptStudioClassifierBridge.classifyConditionModule`；项目级批量分类已接入正式 Agent 流程，但单条调试没有服务端回退。后续若要统一体验，建议增加项目绑定的只读分类预览 API，并复用现有分类请求/响应契约，避免另建一套判断逻辑。
