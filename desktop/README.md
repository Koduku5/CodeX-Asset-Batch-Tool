# KA Prompt Studio 桌面壳

`PromptStudio.Desktop` 是 .NET 10 WPF + WebView2 薄壳，不使用 WinForms。剧本、Cache、Excel、图片和 WebView2 数据都直接写在软件根：

```text
<软件项目根>\workspace\projects\<projectId>
```

源码运行时，软件项目根就是源码仓库；打包运行时，软件项目根就是 `KA.PromptStudio.exe` 所在目录。不会再创建 C 盘工作区或路径设置。用户明确设置 `KA_PROMPT_STUDIO_DATA_ROOT` 时仍优先使用该目录。旧版 C 盘项目不会自动移动或删除，避免跨盘搬迁中断造成数据损坏。

## 渲染器与交互

WebView2 加载的是 React 19 + Vite 8 构建产物，样式使用 Tailwind CSS 4；仓库内维护 shadcn 风格组件，交互原语来自 Radix UI，图标来自 Lucide。标准动效默认开启，用户可以在生产概览中切换“减少动效”；该选择保存在 WebView 的本机存储中。

“批量出图 / Prompt Studio”仍然只使用一个 WPF 原生窗口。打开时，桌面壳会把普通窗口沿水平和垂直方向扩展为一个接近当前显示器工作区的舞台；已经最大化的窗口会保持最大化，不做意外缩小。React 把原尺寸的主监听页保留为后层卡片，再在舞台中叠放 Prompt Studio。舞台会避开任务栏和工作区边缘，并按当前窗口 DPI 换算；关闭后恢复打开前的精确位置、尺寸和最大化状态。左侧会保留可识别的监听页边缘；点击该边缘、顶部关闭按钮或按 `Esc` 都会返回主监听页。打开和关闭可以重复调用，前景卡继续使用位移、缩放与淡入淡出过渡。

## 启动与安全边界

桌面壳每次启动会：

1. 分别生成 WebView 会话令牌和仅 .NET 持有的 native 令牌；
2. 在 `127.0.0.1` 随机端口启动 `sidecar/src/server/desktop-entry.mjs`；
3. 校验有界 ready 消息与带令牌的 `/health`；
4. 只允许 WebView2 留在本次精确 origin，并为网页请求注入 WebView 令牌；
5. 拒绝外部导航、新窗口、下载、权限请求和默认开发菜单；
6. 退出时先请求 `/shutdown`，再用 Windows Job Object 回收整个 sidecar 进程树。

网页 JSON-RPC 白名单只有：

- `selectProject({ projectId, expectedRevision })`
- `openProjectDirectory({ projectId, kind })`，`kind` 只能是 `project` 或 `output`
- `prepareBuiltinImagegen({ projectId })`
- `setStudioDrawerOpen({ open, width? })`，`width` 是期望的水平舞台增量（DIP），实际尺寸始终受当前显示器工作区约束

`prepareBuiltinImagegen` 会让 .NET 使用单独的 native token 请求调度交接文本，复制到 Windows 剪贴板，并通过固定的 `codex:` 协议尝试拉起 Codex App；返回网页的只有 `{ projectId, copied: true, codexOpened }`。它不会向 URI 传入项目路径、Prompt 或队列内容。调度文本由用户在任意新任务中粘贴后，ImageGen Skill 才会自动新建或复用 `出图｜<软件项目ID>` projectless 独立任务；不需要预先注册其他 Codex 项目。`setStudioDrawerOpen` 只能调整当前宿主窗口，不提供任意窗口句柄或系统命令能力。打开成功会返回 `{ open, originalWidth, originalHeight, windowWidth, windowHeight, expandedBy, expandedHeight }`，全部尺寸均为 WebView 客户区 DIP；关闭结果额外包含 `restored`。网页不会获得窗口位置、窗口句柄、项目路径、公共 Skill 路径、队列项或完整 Prompt。

## 发布布局

```text
<app>/
├─ KA.PromptStudio.exe
├─ Microsoft.Web.WebView2.*
├─ sidecar/
│  ├─ dist/renderer/             # Vite 构建后的 index.html 与哈希资源
│  ├─ src/server/
│  ├─ engine/                    # 软件自有流水线、Prompt 资源和参考规范
│  ├─ skills/
│  │  ├─ ka-script-pipeline/
│  │  └─ ka-builtin-imagegen/
│  ├─ package.json
│  ├─ package-lock.json
│  └─ node_modules/              # 正式发布时按锁文件固定
└─ runtime/node/node.exe         # 正式发布时内置
```

公共 Skill 只在软件运行时中保留一份，不会复制进 `workspace/projects/<projectId>`。

## 开发构建

```powershell
npm install
dotnet restore .\desktop\PromptStudio.Desktop\PromptStudio.Desktop.csproj
dotnet build .\desktop\PromptStudio.Desktop\PromptStudio.Desktop.csproj --nologo
```

项目文件中的 `BuildReactRenderer` 目标会在每次 `dotnet build` 前执行 `npm run build`；随后 `CopyReactRendererToOutput` 会把 `dist/renderer/index.html` 与 `dist/renderer/assets/*` 复制到 `$(OutDir)sidecar/dist/renderer/`。`dotnet publish` 使用同样的构建产物复制规则，因此不需要单独手工同步前端。

开发构建可回退使用 PATH 中的 `node.exe`，并可从源码祖先目录解析已安装的 Codex SDK 依赖。正式发布由 `packaging/build-release.ps1` 内置固定 Node，并依据 `packaging/sidecar/package-lock.json` 安装最小生产依赖；用户首次启动不运行 `npm install`。

## Prompt Studio 能力边界

- 预设卡片支持重命名、删除、导出和多文件导入；发生同名/同 ID 冲突时必须由用户确认后才覆盖。删除本机预设卡片不会删除正式 Prompt Catalog 分支。
- 项目、剧本、流水线任务、参考图、内置批次、正式条件分支及 ImageGen 交接均通过真实后端接口处理。
- 无限画板 API 通过桌面原生桥打开当前项目的正式配置与执行入口：账号密码登录后读取项目和具备 `image_generation` 能力的模型，并设置并发、比例、尺寸及普通资产出图/文件夹批量重绘模式。密码和 JWT 只保留在该次进程中，不写入项目文件。

只有开发/打包诊断才使用这些覆盖：

- `KA_PROMPT_STUDIO_DATA_ROOT`
- `KA_PROMPT_STUDIO_ENGINE_ROOT`
- `KA_PROMPT_STUDIO_SIDECAR`
- `KA_PROMPT_STUDIO_NODE`
- `KA_PROMPT_STUDIO_DEVTOOLS=1`

Web/native 两枚令牌由桌面壳内部随机生成，不接受上述用户覆盖，也不会返回网页。
