import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (filename) => readFile(path.join(root, filename), 'utf8');

const readUiFiles = async (relativeDirectory = 'src/ui') => {
  const directory = path.join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const sources = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) sources.push(...await readUiFiles(relativePath));
    else if (/\.tsx?$/u.test(entry.name)) sources.push({ relativePath, source: await read(relativePath) });
  }
  return sources;
};

const readUiSource = async () => (await readUiFiles()).map(({ source }) => source).join('\n');

const readWorkbenchSource = async () => (await Promise.all([
  read('src/ui/features/workbench/workbench-foundation.tsx'),
  read('src/ui/features/workbench/workbench-app.tsx'),
  read('src/ui/features/workbench/use-workbench-stage-timings.ts'),
  read('src/ui/features/workbench/workbench-status-bar.tsx'),
  read('src/ui/features/workbench/workbench-project-panel.tsx'),
  read('src/ui/features/workbench/workbench-pipeline-overview.tsx'),
  read('src/ui/features/workbench/workbench-project-summary.tsx'),
  read('src/ui/features/workbench/workbench-task-activity.tsx'),
  read('src/ui/features/workbench/agent-chat-card.tsx'),
  read('src/ui/features/workbench/workbench-project-dialogs.tsx')
])).join('\n');

const readWorkbenchAndStudioSource = async () => (await Promise.all([
  readWorkbenchSource(),
  read('src/ui/features/prompt-studio/prompt-studio-drawer.tsx')
])).join('\n');

const readComponentSource = async (name) => {
  const marker = new RegExp(`^(?:export (?:default )?)?function ${name}\\(`, 'mu');
  for (const { source } of await readUiFiles()) {
    const start = source.search(marker);
    if (start < 0) continue;
    const tail = source.slice(start + 1);
    const next = tail.search(/^(?:export default )?function [A-Z][A-Za-z0-9_]*\(/mu);
    return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
  }
  throw new Error(`UI component source not found: ${name}`);
};

test('React desktop shell preserves the production-first single-column layout', async () => {
  const app = await readWorkbenchSource();
  const appShell = await read('src/ui/features/workbench/workbench-app.tsx');
  const timingPersistence = await read('src/ui/services/stage-timing-persistence.mjs');

  for (const text of [
    '项目任务',
    '项目用时',
    '资产拆分概览',
    '拖入 TXT / DOCX 剧本',
    '自动以剧本名新建独立项目',
    '开始任务',
    'BATCH GENERATION',
    '批量出图 · 打开 Prompt Studio'
  ]) assert.match(app, new RegExp(text, 'u'));

  assert.doesNotMatch(app, /lg:grid-cols-\[220px_minmax\(0,1fr\)_270px\]/u);
  assert.doesNotMatch(app, />流水线操作</u);
  assert.match(app, /runTask\(startTaskAction\)/u);
  assert.ok(app.indexOf('项目任务') < app.indexOf('拖入 TXT / DOCX 剧本'));
  assert.ok(appShell.indexOf('<WorkbenchProjectPanel') < appShell.indexOf('<WorkbenchPipelineOverview'));
  assert.ok(appShell.indexOf('<WorkbenchPipelineOverview') < appShell.indexOf('<AssetOverview'));
  assert.match(app, /createProjectFromScreenplay/u);
  assert.match(app, /controlAdapter\.createProject/u);
  assert.match(app, /controlAdapter\.uploadScreenplay\(\{ projectId: created\.projectId/u);
  assert.match(app, /重命名当前项目/u);
  assert.match(app, /删除当前项目/u);
  assert.match(app, /永久删除该项目的独立目录/u);
  assert.match(app, /Codex SDK 授权状态检测/u);
  assert.ok(appShell.indexOf('<CodexStatusCard') < appShell.indexOf('<AgentChatCard'));
  assert.ok(appShell.indexOf('<AgentChatCard') < appShell.indexOf('{activeProject?.displayName ?? "选择一个项目"}'));
  assert.match(app, /sm:right-\[calc\(100%\+1rem\)\]/u);
  assert.match(app, /sm:absolute sm:top-1\/2/u);
  assert.match(app, /w-\[320px\]/u);
  assert.match(app, /CardContent className="flex items-center gap-1\.5 px-2\.5 py-3/u);
  assert.doesNotMatch(app, /CardContent className="flex flex-wrap items-center gap-2 px-3 py-2"/u);
  assert.match(app, /授权 Codex SDK/u);
  assert.match(app, /codexStatusAdapter\.startLogin\(\)/u);
  assert.doesNotMatch(app, /window\.kaDesktopBridge\.authorizeCodex\(\)/u);
  assert.match(app, /后续启动将复用本机登录状态/u);
  assert.match(app, /pauseCurrentTask/u);
  assert.match(app, /className="flex shrink-0 flex-wrap gap-2 sm:self-end" aria-label="当前项目目录操作"/u);
  assert.match(app, /<header className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">/u);
  assert.match(app, /<Card className="gap-3 py-4 shadow-panel">/u);
  assert.match(app, /titleClassName="text-lg"/u);
  assert.match(app, /activeTaskActuallyRunning/u);
  assert.match(app, /const projectStageElapsedSeconds = activeProjectId \? stageElapsedSeconds\[activeProjectId\] : null[\s\S]*const projectElapsedSeconds = activeProjectId && loadedProjectIds\.current\.has\(activeProjectId\)[\s\S]*Object\.values\(projectStageElapsedSeconds \?\? \{\}\)\.reduce\(\(total, seconds\) => total \+ seconds, 0\)[\s\S]*: undefined/u);
  assert.doesNotMatch(app, /activeTaskStartedAtMs|activeTaskFinishedAtMs/u);
  assert.match(app, /stage\.id === activeTaskStageId[\s\S]*activeStageElapsedSeconds/u);
  assert.match(app, /stageElapsedSeconds[\s\S]*completedElapsedSeconds/u);
  assert.match(app, /controlAdapter\.getStageTimings/u);
  assert.match(app, /loadPromises[\s\S]*getProjectStageTimings[\s\S]*loadStageTimings\(projectId\)/u);
  assert.match(app, /from "@\/services\/stage-timing-persistence\.mjs"/u);
  assert.match(app, /saveStageTimingsWithRetry\(controlAdapter, projectId, stages\)/u);
  assert.match(timingPersistence, /const SAVE_RETRY_DELAYS_MS = \[0, 250, 1000\][\s\S]*export async function saveStageTimingsWithRetry/u);
  assert.match(app, /activeStageTiming\.stageId\]: elapsedSeconds/u);
  assert.match(app, /!loadedProjectIds\.current\.has\(activeProjectId\)[\s\S]*!activeTaskActuallyRunning/u);
  assert.match(app, /resumesAfterDesktopRestart/u);
  assert.match(app, /stage\.state === "complete" \? completedElapsedSeconds/u);
  assert.match(app, /\{isRunning \? "已运行" : "用时"\}/u);
  assert.doesNotMatch(app, /const progressLabel = stage\.progress/u);
  assert.doesNotMatch(app, /border-t border-border\/60/u);
  assert.match(app, /stage-running-spinner/u);
  assert.match(app, /stage\.state === "active"[\s\S]*activeTaskActuallyRunning/u);
  assert.match(app, /!activeTaskActuallyRunning && stage\.state === "active"[\s\S]*state: "waiting"/u);
  assert.match(app, /activeTaskActuallyRunning && \(currentPipelinePhase === "asset-visual-specs"/u);
  const taskActions = app.indexOf('aria-label="流水线任务操作"');
  assert.ok(app.indexOf('title="项目任务"') < taskActions && taskActions < app.indexOf('当前阶段：{currentStageLabel}'));
  assert.doesNotMatch(app, /formatDuration\(snapshot\?\.pipeline\?\.elapsedSeconds\)/u);
  assert.match(app, /startTaskAction = pendingAssetCount === 0 && rawPipelinePhase === "asset-visual-specs"/u);
  assert.match(app, /activeProjectAvailable: Boolean\(activeProject\)/u);
  assert.match(app, /disabled=\{!activeProjectAvailable \|\| activeProjectHasRunningTask \|\| pendingAssetsReady \|\| busyAction === startTaskAction\}/u);
  assert.match(app, /disabled=\{!activeProjectHasRunningTask \|\| busyAction === "pause-task"\}/u);
  assert.match(app, /暂停任务/u);
  assert.match(app, /pausing: "正在暂停"/u);
  assert.match(app, /暂停请求已发送，后台执行进程正在停止/u);
  assert.match(app, /开发者日志/u);
  assert.ok(app.indexOf('BATCH GENERATION') < app.indexOf('<span className="truncate text-xs font-semibold">开发者日志<\/span>'));
  assert.match(app, /aria-controls="active-task-log"/u);
  assert.match(app, /暂无任务日志，开始任务后将在这里显示。/u);
  assert.match(app, /taskLogOpen/u);
  assert.match(app, /aria-label="关闭错误提示"/u);
  assert.match(app, /dismissedFailureTaskIds/u);
  assert.match(appShell, /count=\{pendingAssetCount\}/u);
  assert.match(app, /<PendingAssetDialog/u);
  assert.match(app, /runTask\(startTaskAction\)/u);
  assert.doesNotMatch(app, /onFinalized=.*runTask/u);
  assert.match(app, /role=\{toast\.tone === "error" \? "alert" : "status"\}/u);
  assert.doesNotMatch(app, /summary\.currentTaskLabel/u);
  const authorizationCard = appShell.indexOf('<CodexStatusCard');
  const chatPlacement = appShell.indexOf('<AgentChatCard', authorizationCard);
  const projectTitle = appShell.indexOf('{activeProject?.displayName ?? "选择一个项目"}', chatPlacement);
  assert.ok(authorizationCard >= 0 && authorizationCard < chatPlacement && chatPlacement < projectTitle);
  const chatSource = await readComponentSource('AgentChatCard');
  assert.match(chatSource, /Agent 对话/u);
  assert.match(chatSource, /只读讨论 · 操作需确认/u);
  assert.match(chatSource, /w-\[320px\]/u);
  assert.match(chatSource, /h-\[440px\]/u);
  assert.match(chatSource, /min-h-20/u);
  assert.match(chatSource, /sm:top-\[calc\(50%\+3\.25rem\)\] sm:right-\[calc\(100%\+1rem\)\]/u);
  assert.match(chatSource, /确认执行/u);
  assert.match(chatSource, /Enter 发送 · Shift\+Enter 换行/u);
  assert.match(chatSource, /<Select/u);
  assert.match(chatSource, /Agent 输入配置与发送/u);
  assert.match(chatSource, /选择 Codex 模型/u);
  assert.match(chatSource, /选择 Codex 思考等级/u);
  assert.doesNotMatch(app, /Agent 运行配置/u);
  assert.ok((app.match(/w-\[320px\]/gu) ?? []).length >= 2);
  assert.match(app, /codexAgentChatAdapter\.updateRuntimeConfig/u);
  assert.match(app, /codexAgentChatAdapter\.sendMessage/u);
  assert.match(app, /codexAgentChatAdapter\.getSession/u);
  assert.match(app, /codexAgentChatAdapter\.cancelSession/u);
});

test('pending asset review separates model rules, record editing, and dialog orchestration', async () => {
  const dialog = await read('src/ui/features/pending-assets/pending-asset-dialog.tsx');
  const model = await read('src/ui/features/pending-assets/pending-asset-model.ts');
  const records = await read('src/ui/features/pending-assets/pending-asset-records.tsx');

  assert.match(dialog, /from "@\/features\/pending-assets\/pending-asset-model"/u);
  assert.match(dialog, /from "@\/features\/pending-assets\/pending-asset-records"/u);
  assert.doesNotMatch(dialog, /function RecordPreview|function FinalRecordEditor|const compatibleTargets =/u);
  assert.match(model, /export const compatibleTargets/u);
  assert.match(records, /export function RecordPreview[\s\S]*export function FinalRecordEditor/u);
});

test('workbench separates Agent chat and project dialogs from shared foundation and app orchestration', async () => {
  const app = await read('src/ui/features/workbench/workbench-app.tsx');
  const foundation = await read('src/ui/features/workbench/workbench-foundation.tsx');
  const agentChat = await read('src/ui/features/workbench/agent-chat-card.tsx');
  const pipelineOverview = await read('src/ui/features/workbench/workbench-pipeline-overview.tsx');
  const projectPanel = await read('src/ui/features/workbench/workbench-project-panel.tsx');
  const projectSummary = await read('src/ui/features/workbench/workbench-project-summary.tsx');
  const projectDialogs = await read('src/ui/features/workbench/workbench-project-dialogs.tsx');
  const statusBar = await read('src/ui/features/workbench/workbench-status-bar.tsx');
  const taskActivity = await read('src/ui/features/workbench/workbench-task-activity.tsx');
  const stageTimings = await read('src/ui/features/workbench/use-workbench-stage-timings.ts');

  assert.match(app, /from "@\/features\/workbench\/agent-chat-card"/u);
  assert.match(app, /<WorkbenchProjectPanel/u);
  assert.match(app, /<PromptStudioLauncher/u);
  assert.match(app, /<WorkbenchPipelineOverview/u);
  assert.match(app, /<WorkbenchProjectDialogs/u);
  assert.match(app, /<WorkbenchStatusBar/u);
  assert.match(app, /<WorkbenchTaskActivity/u);
  assert.match(app, /useWorkbenchStageTimings\(\{/u);
  assert.doesNotMatch(foundation, /function AgentChatCard|Agent 输入配置与发送/u);
  assert.doesNotMatch(app, /<Dialog open=|<AlertDialog open=|<Progress|id="active-task-log"|Codex SDK 授权状态检测|title="项目任务"|saveStageTimingsWithRetry|stageTimingSaveQueues/u);
  assert.match(agentChat, /export function AgentChatCard/u);
  assert.match(pipelineOverview, /export function WorkbenchPipelineOverview/u);
  assert.match(projectPanel, /export function WorkbenchProjectPanel/u);
  assert.match(projectSummary, /export function PromptStudioLauncher/u);
  assert.match(projectDialogs, /export function WorkbenchProjectDialogs/u);
  assert.match(statusBar, /export function WorkbenchStatusBar[\s\S]*export function CodexStatusCard/u);
  assert.match(taskActivity, /export function WorkbenchTaskActivity/u);
  assert.match(stageTimings, /export function useWorkbenchStageTimings[\s\S]*saveStageTimingsWithRetry/u);
});

test('pipeline summary follows title, screenplay, total progress, visual detail, then six stage cards', async () => {
  const app = await readWorkbenchSource();
  const title = app.indexOf('当前阶段：{currentStageLabel}');
  const source = app.indexOf('当前剧本来源：“{screenplaySource}”');
  const progress = app.indexOf('aria-label="当前流水线真实总进度"');
  const cards = app.indexOf('displayPipelineStages.map');

  assert.ok(title >= 0 && title < source && source < progress && progress < cards);
  assert.match(app, /剧本切分中/u);
  assert.match(app, /剧本分析与累计/u);
  assert.match(app, /剧本分析 - 第 \$\{currentAnalysisEpisode\} 集分析中/u);
  assert.match(app, /analysisStage\.currentEpisode/u);
  assert.match(app, /当前阶段：资产设定生成中/u);
  assert.match(app, /正在处理：/u);
  assert.match(app, /sm:grid-cols-3 xl:grid-cols-6/u);
  assert.match(app, /Excel 制表中/u);
  assert.match(app, /资产生成中/u);
  assert.match(app, /isRunning[\s\S]*LoaderCircle/u);
  assert.match(app, /stage\.state === "complete"[\s\S]*此阶段已完成/u);
  assert.doesNotMatch(app.slice(title, cards), /等待任务/u);
  assert.doesNotMatch(app, /animate-ping/u);
  assert.doesNotMatch(app, /indicatorClassName=\{activePipelineStage/u);
});

test('Prompt Studio React migration keeps the four left modes and test workbenches', async () => {
  const ui = await readUiSource();
  const batchSource = await readComponentSource('BatchStudio');
  const batchBuiltinSource = await read('src/ui/features/prompt-studio/batch-builtin-workspace.tsx');
  const batchControllerSource = await read('src/ui/features/prompt-studio/use-batch-studio.ts');
  const batchToolbarSource = await read('src/ui/features/prompt-studio/batch-studio-toolbar.tsx');

  for (const text of [
    '本次批量',
    '基础提示词',
    '路由 / 分支',
    '单项检查',
    '用制作说明测试分支',
    '开始智能判断',
    '开发调试：模拟 Agent 回执',
    '智能判断任务详情',
    '最终提示词变化',
    '校验解析'
  ]) assert.match(ui, new RegExp(text, 'u'));

  assert.match(ui, /orientation="vertical"/u);
  assert.match(ui, /group\/nav-item/u);
  assert.match(ui, /group\/nav-item relative h-12 w-12 flex-none/u);
  assert.match(ui, /absolute inset-y-0 right-0/u);
  assert.match(ui, /top-4 -left-3[^"\n]*-translate-x-full/u);
  assert.match(ui, /-translate-x-full/u);
  assert.match(ui, /sm:group-hover\/nav-item:w-52/u);
  assert.match(ui, /sm:group-hover\/nav-item:max-w-36/u);
  assert.doesNotMatch(ui, /group\/nav absolute/u);
  assert.doesNotMatch(ui, /group-hover\/nav-item:[^"\n]*translate-x/u);
  assert.match(ui, /aria-controls="route-presets-content"/u);
  assert.match(ui, /aria-expanded=\{presetsOpen\}/u);
  assert.match(ui, /setPresetsOpen\(\(open\) => !open\)/u);
  assert.doesNotMatch(ui, /hidden=\{!presetsOpen\}/u);
  assert.doesNotMatch(ui, /rounded-b-lg border border-t-0/u);
  assert.match(ui, /buildClassificationRequest/u);
  assert.match(ui, /applyModuleOperationsPreview/u);
  assert.match(ui, /出图限制数量/u);
  assert.match(ui, /Input images/u);
  assert.match(ui, /Primary request/u);
  assert.match(ui, /无参考图基础模板/u);
  assert.match(ui, /PromptFieldList/u);
  assert.match(ui, /图片返回窗口/u);
  assert.match(ui, />出图测试</u);
  assert.match(ui, /blankReferenceModes/u);
  assert.match(ui, /changeReferenceMode/u);
  assert.match(ui, /点击可多选图片，或一次拖入多张参考图/u);
  assert.match(batchBuiltinSource, /type="file"[^>]*multiple[^>]*onChange=\{\(event\) => void uploadReferences/u);
  assert.match(batchBuiltinSource, /uploadReferences\(event\.dataTransfer\.files\)/u);
  assert.doesNotMatch(batchSource, /files\?\.\[0\]/u);
  assert.match(ui, /gap-x-8 gap-y-2/u);
  assert.match(ui, /SelectTrigger className="w-28"/u);
  assert.match(ui, /SelectTrigger className="w-32"/u);
  assert.match(ui, /SelectTrigger className="w-52"/u);
  assert.doesNotMatch(ui, /REFERENCE_MODES\.filter\(\(item\) => item\.id !== "none"\)/u);
  assert.doesNotMatch(ui, />添加参考图</u);
  assert.doesNotMatch(ui, />参考图用于</u);
  assert.doesNotMatch(ui, /当前条件下可选分支/u);
  assert.doesNotMatch(ui, /运行正式 Agent 路由判断/u);
  assert.match(ui, /Infinite Canvas API/u);
  assert.match(ui, /onValueChange=\{changeBackend\}/u);
  assert.match(ui, /apiAccessUsername\.trim\(\) !== "admin" \|\| apiAccessPassword !== "123"/u);
  assert.match(ui, /验证 Infinite Canvas API 使用权限/u);
  assert.match(ui, /账号或密码错误，无法使用 Infinite Canvas API/u);
  assert.match(batchToolbarSource, /<BatchBackendSelector backend=\{backend\} onBackendChange=\{onBackendChange\} \/>/u);
  assert.doesNotMatch(batchSource, /apiAccess(?:DialogOpen|Username|Password|Error)/u);
  assert.match(batchSource, /const studio = useBatchStudio/u);
  assert.match(batchControllerSource, /const apiStudio = useBatchApiStudio/u);
  assert.match(batchSource, /<BatchApiWorkspace loading=\{loading\} projectId=\{projectId\} studio=\{apiStudio\} \/>/u);
  assert.match(batchSource, /<BatchBuiltinWorkspace studio=\{builtinStudio\} \/>/u);
  assert.match(batchSource, /<BatchStudioToolbar/u);
  assert.doesNotMatch(batchSource, /<BatchBackendSelector/u);
  assert.doesNotMatch(batchSource, /队列状态/u);
  assert.doesNotMatch(batchSource, /batchAdapter\.|imagegenAdapter\.|React\.useEffect/u);
  assert.doesNotMatch(batchSource, /const (?:connectApiCatalog|chooseApiDirectory|startApiBatch)/u);
  assert.match(ui, /openApiBatchSettings/u);
  assert.match(ui, /https:\/\/canvas\.dopamine\.video/u);
  assert.match(ui, /id="api-base-url"/u);
  assert.match(ui, /id="api-username"/u);
  assert.match(ui, /id="api-password"/u);
  assert.match(ui, /id="api-workers"/u);
  assert.match(ui, /具备 image_generation 能力的模型/u);
  assert.match(ui, /Infinite Canvas API 批量出图已在后台启动/u);
  assert.doesNotMatch(ui, /API 后端界面已保留|正式 API 任务桥尚未接入|id="api-key"|id="api-endpoint"/u);
});

test('prompt fields remain one continuous document with one aligned value start', async () => {
  const fields = await read('src/ui/features/prompt-studio/prompt-field-list.tsx');
  const templateStudio = await read('src/ui/features/prompt-studio/template-studio.tsx');
  const templateState = await read('src/ui/features/prompt-studio/use-template-studio.ts');
  const batchConfiguration = await read('src/ui/features/prompt-studio/batch-configuration.mjs');
  const select = await read('src/ui/components/ui/select.tsx');

  assert.match(fields, /onReorder\?: \(fromIndex: number, toIndex: number\) => void/u);
  assert.doesNotMatch(fields, /\bGripVertical\b/u);
  assert.match(fields, /grid min-w-0 grid-cols-\[minmax\(6\.5rem,8rem\)_minmax\(0,1fr\)\].*sm:grid-cols-\[10\.5rem_minmax\(0,1fr\)\]/u);
  assert.match(fields, /items-start justify-end gap-0\.5/u);
  assert.match(fields, /text-right/u);
  assert.match(fields, /aria-hidden="true" className="shrink-0">:<\/span>/u);
  assert.match(fields, /是否启用 AI 判断/u);
  assert.match(fields, /<Switch[\s\S]*checked=\{agentDecisionActive\}[\s\S]*onCheckedChange/u);
  assert.match(fields, /mb-1 flex justify-end pr-3/u);
  assert.match(fields, /flex min-h-8 items-center justify-end/u);
  assert.match(fields, /_2rem_6\.75rem/u);
  assert.doesNotMatch(fields, /_6\.75rem_2rem/u);
  assert.doesNotMatch(fields, /<Bot|AI 判断\{agentPlaceholders/u);
  assert.doesNotMatch(fields, /border-b/u);
  assert.match(batchConfiguration, /const orderedFields = normalizeTemplateFieldOrder\(resolved\.promptFields, draft\?\.promptFields\)/u);
  assert.match(templateState, /setDraftFields\(normalizeTemplateFieldOrder\(resolved\.promptFields, saved\?\.promptFields\)\)/u);
  assert.match(templateStudio, /onReorder=\{reorderField\}/u);
  assert.match(templateStudio, /按住可排序字段的整行即可拖动/u);
  assert.match(select, /select-value\]\]:truncate/u);
});

test('prompt field rows use long-press sorting while fixed routing fields stay anchored', async () => {
  const fields = await read('src/ui/features/prompt-studio/prompt-field-list.tsx');
  const fieldDrag = await read('src/ui/features/prompt-studio/use-prompt-field-drag.ts');
  const templateStudio = await read('src/ui/features/prompt-studio/template-studio.tsx');
  const templateState = await read('src/ui/features/prompt-studio/use-template-studio.ts');
  const fieldOrder = await read('src/ui/features/prompt-studio/template-field-order.mjs');

  assert.match(templateState, /from "@\/features\/prompt-studio\/template-field-order\.mjs"/u);
  assert.match(fieldOrder, /const TEMPLATE_FIELD_REORDER_LOCKED_LABELS = new Set\(\["use case", "asset type"\]\)/u);
  assert.match(fieldOrder, /const TEMPLATE_FIELD_REORDER_LOCKED_ORDER = \["use case", "asset type"\]/u);
  assert.match(fieldOrder, /export function templateFieldReorderIsLocked\(field\) \{[\s\S]*TEMPLATE_FIELD_REORDER_LOCKED_LABELS\.has\(String\(field\?\.label \|\| ""\)\.trim\(\)\.toLocaleLowerCase\("en-US"\)\)/u);
  assert.match(templateStudio, /onReorder=\{reorderField\} isReorderLocked=\{isReorderLocked\}/u);
  assert.match(fieldOrder, /export function reorderTemplateFields\(fields, fromIndex, toIndex\) \{[\s\S]*crossesLockedField[\s\S]*templateFieldReorderIsLocked\(fields\[fromIndex\]\) \|\| crossesLockedField/u);
  assert.match(templateState, /isReorderLocked: templateFieldReorderIsLocked/u);
  assert.match(fieldOrder, /const movableFields = orderedFields\.filter\(\(field\) => !templateFieldReorderIsLocked\(field\)\)[\s\S]*const lockedFields = TEMPLATE_FIELD_REORDER_LOCKED_ORDER[\s\S]*\.map\(\(lockedLabel\) => orderedFields\.find\(\(field\) => \([\s\S]*\.toLocaleLowerCase\("en-US"\) === lockedLabel[\s\S]*\.filter\(Boolean\)[\s\S]*return \[\.\.\.lockedFields, \.\.\.movableFields\]/u);
  assert.doesNotMatch(fieldOrder, /formalIndex|anchoredFields\.splice/u);
  assert.match(templateStudio, /Use case 与 Asset type 始终固定在顶部/u);

  assert.match(fields, /isReorderLocked\?: \(field: PromptField, index: number\) => boolean/u);
  assert.match(fields, /const dragController = usePromptFieldDrag/u);
  assert.match(fieldDrag, /const ROW_DRAG_HOLD_MS = \d+/u);
  assert.match(fields, /const reorderLocked = Boolean\(editable && onReorder && isReorderLocked\?\.\(field, index\)\)[\s\S]*const reorderable = Boolean\(editable && onReorder && !reorderLocked\)/u);
  assert.match(fields, /data-prompt-field-index=\{index\}[\s\S]*data-prompt-field-reorderable=\{reorderable \? "true" : undefined\}[\s\S]*data-prompt-field-reorder-locked=\{reorderLocked \? "true" : undefined\}/u);
  assert.match(fields, /onPointerDown=\{reorderable \? \(event\) => startRowDrag\(event, index, field\.label\) : undefined\}/u);
  assert.match(fieldDrag, /pendingRowDragRef\.current = pending[\s\S]*window\.setTimeout\([\s\S]*pointerDragIndexRef\.current = index[\s\S]*ROW_DRAG_HOLD_MS\)/u);
  assert.match(fieldDrag, /\(event\.target as HTMLElement\)\.closest\("button, \[role='switch'\]"\)/u);
  assert.match(fieldDrag, /document\.addEventListener\("pointermove", continuePointerDrag, \{ passive: false \}\)/u);
  assert.match(fieldDrag, /elementFromPoint\(event\.clientX, event\.clientY\)\?\.closest\("\[data-prompt-field-index\]"\)/u);

  assert.match(fieldDrag, /const canReorderField[\s\S]*isReorderLocked\?\.\(fields\[fromIndex\], fromIndex\)[\s\S]*fields\.some\([\s\S]*isReorderLocked\?\.\(field, index\)/u);
  assert.match(fieldDrag, /const reorderWithKeyboard[\s\S]*event\.altKey[\s\S]*\["ArrowUp", "ArrowDown"\][\s\S]*canReorderField\(index, targetIndex\)[\s\S]*onReorder\?\.\(index, targetIndex\)/u);
  assert.doesNotMatch(fields, /pendingRowDragRef|document\.addEventListener\("pointermove"/u);
});

test('prompt field drag motion follows the pointer, shifts neighbors, and settles accessibly', async () => {
  const fields = await read('src/ui/features/prompt-studio/prompt-field-list.tsx');
  const fieldDrag = await read('src/ui/features/prompt-studio/use-prompt-field-drag.ts');

  assert.match(fieldDrag, /style\.setProperty\("--prompt-field-drag-y", `\$\{nextTranslateY\}px`\)/u);
  assert.match(fields, /transform: `translate3d\(0, var\(--prompt-field-drag-y, 0px\), 0\) scale\(\$\{reduceMotion \? 1 : 1\.0\d+\}\)`/u);

  assert.match(fieldDrag, /if \(label === activeDragLabelRef\.current\) continue[\s\S]*const deltaY = beforeRect\.top - row\.getBoundingClientRect\(\)\.top[\s\S]*row\.style\.transform = `translate3d\(0, \$\{deltaY\}px, 0\)`[\s\S]*window\.requestAnimationFrame\(\(\) => \{[\s\S]*row\.style\.transition = "transform 320ms cubic-bezier\(0\.22, 1, 0\.36, 1\)"[\s\S]*row\.style\.transform = "translate3d\(0, 0, 0\)"/u);
  assert.match(fieldDrag, /activeRow\.style\.transition = "transform 280ms cubic-bezier\(0\.22, 1, 0\.36, 1\)"[\s\S]*activeRow\.style\.removeProperty\("--prompt-field-drag-y"\)/u);

  assert.match(fieldDrag, /const reduceMotion = window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches[\s\S]*if \(beforeRects && !reduceMotion\)/u);
  assert.match(fieldDrag, /settleWithMotion = currentTransform !== "none" && !window\.matchMedia\("\(prefers-reduced-motion: reduce\)"\)\.matches/u);
});

test('AI judgment editor restores opener focus and exposes required validation', async () => {
  const fields = await read('src/ui/features/prompt-studio/prompt-field-list.tsx');
  const agentDialog = await read('src/ui/features/prompt-studio/prompt-field-agent-dialog.tsx');

  assert.match(fields, /const agentEditorTriggerRef = React\.useRef<HTMLButtonElement \| null>\(null\)/u);
  assert.match(fields, /onClick=\{\(event\) => \{[\s\S]*agentEditorTriggerRef\.current = event\.currentTarget[\s\S]*setAgentEditor\(/u);
  assert.match(fields, /aria-haspopup=\{agentDecisionActive \? undefined : "dialog"\}/u);
  assert.match(fields, /aria-controls=\{agentDecisionActive \? undefined : `\$\{idPrefix\}-agent-dialog`\}/u);
  assert.match(fields, /aria-expanded=\{agentEditor\?\.index === index\}/u);
  assert.match(fields, /aria-label=\{`编辑“\$\{field\.label\}”的 AI 判断需求`\}[\s\S]*requirements: agentPlaceholders\.map/u);
  assert.match(fields, /<PromptFieldAgentDialog/u);
  assert.match(agentDialog, /这里只修改已有占位符的判断需求；字段中的其他固定文字会原样保留/u);
  assert.match(agentDialog, /onCloseAutoFocus=\{\(event\) => \{[\s\S]*event\.preventDefault\(\)[\s\S]*triggerRef\.current\?\.focus\(\)/u);
  assert.match(agentDialog, /const missing = !requirement\.trim\(\)[\s\S]*const invalid = !agentRequirementIsValid\(requirement\)/u);
  assert.match(agentDialog, /具体判断需求\{editor\.requirements\.length[\s\S]*（必填）/u);
  assert.match(agentDialog, /value=\{requirement\}[\s\S]*required[\s\S]*aria-invalid=\{invalid\}[\s\S]*aria-describedby=\{`\$\{requirementId\}-help`\}/u);
  assert.match(agentDialog, /\{missing[\s\S]*请填写具体判断需求；此项为必填。[\s\S]*需求必须是单行文字，且不能包含【】。/u);
  assert.match(agentDialog, /disabled=\{!editor\?\.requirements\.every\(agentRequirementIsValid\)\}/u);
  assert.doesNotMatch(fields, /<Dialog|onCloseAutoFocus/u);
});

test('route preset and branch exchange uses desktop save and atomic multi-file conflict review', async () => {
  const app = await readUiSource();
  const routeSource = await readComponentSource('RouteStudio');
  const routeDialogs = await read('src/ui/features/prompt-studio/route-studio-dialogs.tsx');
  const routeImportPlanner = await read('src/ui/features/prompt-studio/route-import-planner.ts');
  const routePresetActions = await read('src/ui/features/prompt-studio/use-route-preset-actions.ts');
  const routeController = await read('src/ui/features/prompt-studio/use-route-studio.ts');

  assert.match(app, /saveJsonFile\?:/u);
  assert.match(app, /await nativeSave\(\{ suggestedName: safeFilename, jsonText \}\)/u);
  assert.match(app, /await downloadJson/u);
  assert.match(app, />新建预设</u);
  assert.match(app, /已新建独立预设/u);
  assert.match(app, /templates: activePreset\.templates/u);
  assert.match(app, /templates: clone\(artifact\.value\.templates\)/u);
  assert.match(app, /readTemplateDraft\(activePreset\?\.templates/u);
  assert.match(app, /withTemplateDraft\(activePreset\.templates/u);
  assert.match(app, /导入分支（可多选）/u);
  assert.match(app, /type="file" accept="\.json" multiple/u);
  assert.match(app, /所选文件中有不同版本/u);
  assert.match(app, /所选文件中有 \$\{distinctVersions\.length\} 个版本/u);
  assert.match(app, /相同并跳过/u);
  assert.match(app, /取消则整批不写入/u);
  assert.match(app, /new Map\(\[\.\.\.preset\.modules, \.\.\.incoming\.modules\]/u);
  assert.match(routeSource, /<RouteStudioDialogs studio=\{dialogStudio\} \/>/u);
  assert.match(routeSource, /<RoutePresetsPanel studio=\{presetsPanelStudio\} \/>/u);
  assert.match(routeSource, /<RouteModuleList studio=\{moduleListStudio\} \/>/u);
  assert.match(routeSource, /<RouteModuleSettings module=\{module\} commitModule=\{commitModule\} \/>/u);
  assert.match(routeSource, /<RouteOperationsWorkspace/u);
  assert.match(routeSource, /<RouteClassificationWorkspace/u);
  assert.match(routeDialogs, /export function RouteStudioDialogs/u);
  assert.doesNotMatch(routeSource, /<AlertDialog/u);
  assert.doesNotMatch(routeSource, /<Dialog open=/u);
  assert.doesNotMatch(routeSource, /id="route-presets-panel"/u);
  assert.doesNotMatch(routeSource, /formalModuleIds\.has\(entry\.id\)/u);
  assert.match(routeSource, /const controller = useRouteStudio\(\{ notify \}\)/u);
  assert.match(routeController, /const presetActions = useRoutePresetActions/u);
  assert.match(routeController, /const classificationStudio = useRouteClassification/u);
  assert.doesNotMatch(routeSource, /React\.useState|React\.useEffect|catalogAdapter\.|routeAdminAdapter\./u);
  assert.match(routePresetActions, /planRouteImport\(\{ activePreset, files, mode, presets \}\)/u);
  assert.match(routeImportPlanner, /function planPresetImports/u);
  assert.match(routeImportPlanner, /function planBranchImports/u);
  assert.doesNotMatch(routeSource, /parseRouteExchangeArtifact|distinctVersions|createPresetPackage/u);
});

test('dark route checkboxes keep a high-contrast checked indicator', async () => {
  const checkbox = await read('src/ui/components/ui/checkbox.tsx');
  assert.match(checkbox, /dark:data-\[state=unchecked\]:bg-input\/20/u);
  assert.match(checkbox, /dark:data-\[state=checked\]:bg-primary/u);
  assert.match(checkbox, /dark:data-\[state=checked\]:text-primary-foreground/u);
  assert.match(checkbox, /stroke-\[3\]/u);
  assert.doesNotMatch(checkbox, /(?:^|\s)dark:bg-input\/20/u);
});

test('batch classification stays in the formal batch panel and template drafts feed batch overrides', async () => {
  const app = await readUiSource();
  const batchSource = await readComponentSource('BatchStudio');
  const batchController = await read('src/ui/features/prompt-studio/use-batch-studio.ts');
  const batchConfiguration = await read('src/ui/features/prompt-studio/batch-configuration.mjs');
  const routeSource = await readComponentSource('RouteStudio');

  assert.match(batchController, /runTask\("classify-prompt-branches"\)/u);
  assert.doesNotMatch(routeSource, /runTask\("classify-prompt-branches"\)/u);
  assert.match(batchConfiguration, /readTemplateDraft/u);
  assert.match(batchConfiguration, /promptOverridesBySheet/u);
  assert.match(app, /AI 判断.*【由agent 具体判断说明：…】.*普通文字和空值仍按固定配置处理/u);
  assert.match(app, /agentDecisionTags/u);
  assert.match(app, /保留当前草稿/u);
  assert.match(app, /function RouteFieldPreview/u);
  assert.match(app, /点击字段查看详情/u);
  assert.match(app, /group-open:rotate-90/u);
});

test('Infinite Canvas opens both batch modes and automatically loads authenticated project and model lists', async () => {
  const app = await readUiSource();
  const runner = await read('engine/scripts/commands/start_api_batch.ps1');

  assert.match(app, /连接账号并读取项目 \/ 模型/u);
  assert.match(app, /const loadCatalog = window\.kaDesktopBridge\?\.loadApiCatalog/u);
  assert.match(app, /<Button[^>]*onClick=\{\(\) => void connectApiCatalog\(\)\}[^>]*>[\s\S]*?连接账号/u);
  assert.match(app, /window\.kaDesktopBridge\?\.startApiBatch/u);
  assert.match(runner, /使用文件夹中的图片批量重绘/u);
  assert.match(runner, /开始 API 批量出图/u);
  assert.match(runner, /-Uri "\$baseUrl\/api\/v1\/models" `\s+-Headers \$headers/u);
  assert.match(runner, /\$connectButton\.PerformClick\(\)/u);
  assert.match(runner, /\$parsedWorkers = 0[\s\S]*?TryParse\([^\n]+\[ref\]\$parsedWorkers\)/u);
  assert.match(runner, /无限画板 API 启动失败/u);
});

test('Prompt Studio uses one in-window overlay stage with repeatable open and close', async () => {
  const app = await readWorkbenchAndStudioSource();
  const openStart = app.indexOf('const setStudioOpen');
  const openSource = app.slice(openStart, app.indexOf('React.useEffect', openStart));

  assert.match(app, /"closed" \| "opening" \| "open" \| "closing"/u);
  assert.match(app, /drawerMounted/u);
  assert.match(app, /prompt-studio-stage fixed right-3 bottom-3/u);
  assert.match(app, /setStudioOpen\(!drawerOpen, "batch"\)/u);
  assert.match(openSource, /setDrawerOpen\(true\)/u);
  assert.match(openSource, /setDrawerOpen\(false\)/u);
  assert.doesNotMatch(openSource, /setStudioDrawerOpen|queueNativeStudioStage/u);
  assert.match(app, /aria-expanded=\{drawerOpen\}/u);
  assert.match(app, /id="prompt-studio-drawer"/u);
  assert.match(app, /aria-label="返回主监听窗口"/u);
  assert.match(app, /role="dialog"/u);
  assert.match(app, /event\.key === "Tab" && drawerOpen/u);
  assert.match(app, /"top-10 left-12 sm:top-14 sm:left-56 lg:left-60"/u);
  assert.doesNotMatch(openSource, /width:/u);
});

test('background polling does not repaint heavy Prompt Studio editors while scrolling', async () => {
  const app = await readWorkbenchAndStudioSource();
  const routeClassification = await read('src/ui/features/prompt-studio/use-route-classification.ts');
  const routeModuleList = await read('src/ui/features/prompt-studio/route-module-list.tsx');
  const routeController = await read('src/ui/features/prompt-studio/use-route-studio.ts');

  assert.match(app, /(?:export )?const MemoPromptStudioDrawer = React\.memo\(PromptStudioDrawer\)/u);
  assert.match(app, /const MemoBatchStudio = React\.memo\(BatchStudio\)/u);
  assert.match(app, /const MemoRouteStudio = React\.memo\(/u);
  assert.match(app, /const MemoTemplateStudio = React\.memo\(TemplateStudio\)/u);
  assert.match(app, /const MemoValidationStudio = React\.memo\(/u);
  assert.match(app, /<MemoPromptStudioDrawer\s/u);
  assert.match(app, /<MemoBatchStudio /u);
  assert.match(app, /<MemoRouteStudio /u);
  assert.match(app, /<MemoTemplateStudio /u);
  assert.match(app, /<MemoValidationStudio /u);
  assert.doesNotMatch(app, /backdrop-blur/u);
  assert.doesNotMatch(app, /brightness-\[0\.88\]/u);
  assert.doesNotMatch(app, /transition-\[transform,filter,border-radius\]/u);
  assert.doesNotMatch(app, /snapshotLoading|setSnapshotLoading/u);
  assert.doesNotMatch(app, /<MemoPromptStudioDrawer[\s\S]*?snapshot=\{snapshot\}/u);
  assert.match(app, /if \(drawerOpen\) return[\s\S]*setInterval\(\(\) => void refreshProjects\(true\), 3000\)/u);
  assert.match(app, /if \(drawerOpen\) return[\s\S]*workspaceAdapter\.getSnapshot/u);
  assert.match(app, /return unchanged \? current : next/u);
  assert.match(routeClassification, /const availableForScope = React\.useMemo/u);
  assert.match(routeController, /const classificationStudio = useRouteClassification/u);
  assert.match(routeModuleList, /formalModuleIds\.has\(entry\.id\)/u);
});
