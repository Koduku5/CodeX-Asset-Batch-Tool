# Desktop Bridge Contract

## 原则

WebView 只拿到项目 ID 和脱敏 DTO，不拿绝对路径、凭据、完整 Prompt、队列内容、锁令牌或进程控制能力。所有正式写入都通过固定业务接口完成；不存在 `execute(command)`、`writeFile(path)` 或任意参数脚本入口。

桌面宿主是 .NET 10 WPF + WebView2，不是 WinForms。WebView 中运行 React 19 + Vite 8 构建产物，使用 Tailwind CSS 4、仓库内 shadcn 风格组件、Radix UI 交互原语和 Lucide 图标。上述前端实现不会扩大 Bridge 权限。

## WebView JSON-RPC

```js
window.kaDesktopBridge = {
  selectProject({ projectId, expectedRevision }),
  openProjectDirectory({ projectId, kind }),
  prepareBuiltinImagegen({ projectId }),
  setStudioDrawerOpen({ open, width? })
};
```

- `projectId` 必须是已登记隔离项目的稳定 ID。
- `kind` 只能是 `project` 或 `output`。
- `prepareBuiltinImagegen` 只返回 `{ ok: true, data: { projectId, copied: true } }`；包含 canonical 项目根和软件级 Skill 路径的交接文本只进入 .NET 剪贴板。
- `setStudioDrawerOpen` 的 `open` 必须是布尔值；`width` 可省略，提供时必须是 240–960 之间的有限数字。省略宽度时 WPF 使用 760。
- 成功打开返回 `{ ok: true, data: { open: true, expandedBy } }`；成功关闭返回 `{ ok: true, data: { open: false, restored } }`。返回值不包含窗口句柄、屏幕坐标或其他系统信息。

## Prompt Studio 窗口扩展

桌面版打开 Prompt Studio 时，WPF 会先保存窗口的边界和 `WindowState`，再按请求宽度扩展宿主窗口：

1. 优先保持窗口左边界不变，从当前窗口右侧向外增宽；
2. 如果显示器右侧工作区不够，才向左补足剩余宽度；
3. 总宽度不会超过当前显示器工作区，重复打开不会重复累加；
4. 关闭抽屉时恢复打开前的位置、尺寸和最大化/普通状态。

因此桌面版抽屉使用新增的真实窗口空间，不是向内覆盖或压缩原主窗口。普通浏览器预览没有此 RPC，会自动降级为网页覆盖层。

## 双令牌

- WebView token：由 .NET 注入同源 HTTP 请求，用于普通 `/api/`、`/health`、`/shutdown` 和桌面端点的第一层校验。
- Native token：仅保存在 .NET 与 Node sidecar 进程环境中，不注入 WebView。`POST /desktop/projects/<id>/prepare-imagegen-handoff` 必须同时通过两枚令牌和精确 Origin 校验。

错误响应不得包含交接文本、绝对路径、Skill 路径、队列项或 Prompt。

## 业务 HTTP

| 接口 | 方法 | 用途 |
| --- | --- | --- |
| `/api/projects` | `GET` / `POST` | 列出或新建隔离项目。 |
| `/api/projects/<id>/screenplay` | `PUT` | 导入一个 TXT/DOCX 剧本。 |
| `/api/projects/<id>/tasks` | `POST` | 启动固定白名单任务。 |
| `/api/projects/<id>/tasks/<taskId>` | `GET` | 读取脱敏、有界任务状态。 |
| `/api/projects/<id>/workbench/snapshot` | `GET` | 读取当前项目生产快照。 |
| `/api/projects/<id>/references` | `GET` | 列出当前项目参考图摘要。 |
| `/api/projects/<id>/references/<style>/<sheet>` | `PUT` | 按固定风格/类别导入参考图。 |
| `/api/projects/<id>/references/<refId>` | `DELETE` | 删除当前项目参考图。 |
| `/api/projects/<id>/builtin-batch` | `GET` / `POST` | 读取或保存正式内置批次。 |
| `/api/projects/<id>/imagegen-handoff` | `GET` | 返回无路径的 ImageGen 交接就绪状态。 |
| `/api/prompt/status` | `GET` | 返回 Catalog 指纹、版本与分支摘要。 |
| `/api/prompt/resolve` | `POST` | 解析模板和已选条件分支。 |
| `/api/prompt/condition-modules/validate` | `POST` | 校验一个条件分支模块。 |
| `/api/prompt/condition-modules/<id>` | `PUT` / `DELETE` | 使用 Catalog CAS 保存或删除正式分支。 |

这些接口已经为项目列表与创建、剧本导入、流水线任务、生产快照、参考图、内置批次、提示词解析、正式分支保存/删除和 ImageGen 交接提供真实后端能力。IntinifyCanvas API provider 仍未接通：前端输入只保留在当前窗口，不落盘、不通过 Bridge 传输，也不会启动 API 出图任务。

## 前端本机配置

预设卡片是 Prompt Studio 开发者工作台的本机配置，不新增通用文件系统 RPC：

- 支持重命名、删除、导出和一次选择多个文件导入；
- 预设按名称或稳定 ID 检测冲突，分支按稳定 ID 检测冲突；
- 有冲突时先显示覆盖确认，取消不会写入任何导入内容，确认后才覆盖本机版本；
- 删除预设卡片只删除本机工作台预设，不会隐式删除正式 Prompt Catalog 分支；正式分支删除仍走带 Catalog 指纹的业务接口。

标准界面动效默认开启；用户可切换“减少动效”，使动画与过渡缩短到近乎即时。动效偏好只保存在 WebView 本机存储中，不经过 Bridge。

## 固定项目任务

允许动作：

- `environment-check`
- `split`
- `analyze-screenplay`
- `build-world-overview`
- `validate-and-build-workbook`
- `build-builtin-queue`
- `classify-prompt-branches`

领取图片和生成图片不是 SDK task action。`claim-next-builtin-image` 与 `generate-next-builtin-image` 必须拒绝。

SDK Agent 固定读取软件级 `ka-script-pipeline` Skill，只能在选定项目根中写入。项目根中的 `SKILL.md` 不可信，也不会被读取。`classify-prompt-branches` 先建立受控候选，Agent 只返回候选稳定 ID，服务端校验后原子写入匹配并重建最终队列。

## ImageGen 交接

```text
WebView 点击
  → GET 安全状态
  → JSON-RPC prepareBuiltinImagegen(projectId)
  → .NET 使用 native token 请求 sidecar
  → sidecar 只读复核队列/批次/进度/锁及公共 Skill SHA-256
  → .NET 复制交接文本
  → 用户在新的可见 Codex 任务中粘贴
  → ka-builtin-imagegen Skill 每次 claim 一项、调用内置 image_gen、回写一项
```

.NET、Node sidecar、Codex SDK 和浏览器都不得调用或模拟内置 `image_gen`，也不得在交接前 claim、建锁、改进度。只有新的可见 Codex 任务具备工具能力。

## 多项目

每个项目拥有独立剧本、Cache、输出、运行时快照、队列和锁。任务运行器只限制“同一项目同时一个流水线动作”；不同项目可以并发分析、制表、建队或由不同可见 Codex 任务出图。项目卡切换仅改变当前视图。

## 永久禁止

- 网页提交绝对路径、命令、脚本路径、模型覆盖、API 凭据或锁参数。
- 网页读取 handoffText、完整队列、完整 Prompt 或参考图磁盘路径。
- SDK Agent 调用 `image_gen`、领取内置图片任务或伪造完成回执。
- 导入同名预设或冲突分支时未经用户确认覆盖。
- 通过通用 shell、任意文件读写或任意网络桥实现业务动作。
