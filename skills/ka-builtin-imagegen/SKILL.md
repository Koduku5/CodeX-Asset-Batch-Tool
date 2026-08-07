---
name: ka-builtin-imagegen
description: 在 Codex App 中调度或执行 KA Asset Batch 的内置 ImageGen 队列。调度模式为一个软件项目新建或复用独立的用户可见任务，不依赖任何外部 Codex 项目；执行模式从该软件项目的独立队列逐项领取资产，应用正式 Prompt Catalog 与参考图，生成 PNG 并回写可恢复进度。不用于 SDK、CLI 或 API 出图。
---

# KA 内置 ImageGen 执行器

只在 Codex Desktop 或其他确实暴露内置 `image_gen` 工具的用户可见任务中执行。Codex SDK、Codex CLI、Node sidecar 和 .NET Bridge 都不得代替该工具。

## 模式判定

本 Skill 只有以下三种模式，先根据交接文本中的明确标记选择，禁止自行切换：

- `dispatch`：当前任务只是启动器。读取 Codex App 任务列表，为交接单中的一个软件项目新建或复用 projectless 主出图任务。不得领取队列，不得调用 `image_gen`。
- `worker`：当前任务是一个软件项目的长期主出图任务。只处理交接单锁定的项目根，可连续处理该项目后续批次。不得再创建另一个主出图任务。
- `retry-worker`：只处理交接单锁定的一个重复生成 Key，完成或失败后停止。不得调度其他项目或其他 Key。

缺少模式、唯一项目根或软件项目编号时立即停止，不得扫描目录猜测项目。

## 调度模式

只有用户提交的交接文本明确写出 `模式：dispatch` 并明确授权新建或复用任务时才能执行。按以下顺序操作：

1. 完整保留交接文本中的 `KA_IMAGEGEN_WORKER_PAYLOAD`，不得改写项目编号、项目根、Skill 路径、任务标题、独立任务目录名或安全约束。
2. 使用 Codex App 的任务列表能力查找标题与交接文本完全相同、且 backing kind 为 projectless、独立任务目录名也完全相同的主出图任务。零个候选才可新建；一个候选则复用；多个候选必须停止并请用户处理重复任务。不得复用同名的 Codex 项目任务。
3. 复用时，通过向现有任务发送消息的能力原样发送 `KA_IMAGEGEN_WORKER_PAYLOAD`。新建时，通过新建任务能力创建 `{ type: "projectless", directoryName: <交接单中的独立任务目录名> }` 任务，并把该 Payload 作为初始指令。不得先读取或注册 Codex 项目，不得创建 worktree，也不得把任务建到任何外部项目。
4. 新任务创建成功后，将标题设置为交接文本指定的精确标题并固定在任务列表；复用时保持原任务。随后切换到该任务。创建、发送或切换失败时报告失败，不得在调度任务中退回执行出图。

调度任务绝不能调用 `image_gen`、`get_next_image_job.mjs` 或 `update_image_progress.mjs`，也不能创建、删除或修改任何流水线锁。Codex App 未提供任务列表、新建任务或发送消息能力时，只显示完整 Worker Payload，供用户在任意新建的独立任务中粘贴。

## 强制前置

- `worker` 和 `retry-worker` 只接受原生 Bridge 校验后交付的一个项目根。剧本、`cache`、`输出`、队列和锁均必须在该项目内。
- 队列未建立、内置批次未确认、指纹过期或其他后端正在运行时，立即停止，不自动修改队列。
- 完整读取 [asset-type-rules.md](../../engine/references/asset-type-rules.md) 和 [builtin-prompt-field-contract.md](../../engine/references/builtin-prompt-field-contract.md) 一次。
- 不整体加载队列，不一次读取全部 Prompt，不提前 claim 下一项。

## 单项循环

1. 在项目根运行固定领取脚本：

   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/commands/node.ps1 scripts/pipeline/get_next_image_job.mjs <项目根>`

   定向测试时只可由交付信息附加 `--only-key <精确 Key>`；恢复已领取项时只可使用 `--resume`。
2. 领取结果 `done=true` 时停止。否则只使用返回的单项 `productionNotes`、`promptSpec`、`referenceImages`、输出路径与指纹。
3. 以 `promptSpec.promptText` 和 `promptSpec.fields` 为用户确认后的唯一基础模板。禁止改名、新增、删除或重排字段，禁止改用队列中的 API Prompt。
4. 依据完整制作说明和资产类型规则填充现有字段。没有原文依据的光线、颜色、材质和约束留空；不新增剧情事实。任何 `【由 Agent……】` 或判断说明占位都不得发送给 `image_gen`。
5. 无参考图时确认 `routeMode=default`、`referenceMode=none`、11 字段且无 `Input images`。有参考图时确认 `routeMode=reference`、12 字段及参考方式，按原顺序将所有绝对路径传给 `referenced_image_paths`。
6. 每个队列 Key 的首次生成单独调用一次内置 `image_gen`。调用成功后将有效 PNG 放到该任务的精确输出路径。
7. 用 `scripts/pipeline/update_image_progress.mjs` 将该 Key 写为 `completed`；失败时写为 `failed` 并提供非空错误。脚本必须校验 PNG、路径、输入指纹和锁释放令牌。
8. 一项终态回写完成后才能领取下一项。用户要求暂停时立即停止新领取。

## 重试与新任务

同一 Key 的第二次或后续独立生成必须在新的用户可见 Codex 任务中执行。若用户要求重做，或领取结果显示 `attempts > 1`：

- 当前任务不得再调用 `image_gen`。
- 使用产品提供的新建可见任务能力创建 `retry-worker`，移交项目根、Key、资产名、输出目标、Prompt 指纹、参考图和 `--only-key`/`--resume` 要求。重试任务不得进入 `dispatch`，也不得创建新的主出图任务。
- 移交中不包含任何密码、令牌或 API 凭据。
- 无法新建可见任务时停止并请用户手动新建，禁止退回当前任务重试。

## 完成条件

只有领取脚本返回队列完成或额度到达，且没有待回写的已领取任务时，才报告本轮结束。
