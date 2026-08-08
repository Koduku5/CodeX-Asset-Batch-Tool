import {
  CURRENT_STAGE_LABELS,
  PHASE_LABELS,
  TASK_STAGE_BY_ACTION,
} from "@/features/workbench/workbench-constants"
import { JsonRecord, ProjectCard } from "@/features/workbench/workbench-types"
import { percent } from "@/features/workbench/workbench-utils"


export function deriveActivePipelineState({
  snapshot,
  activeProject,
  activeTask,
  activeProjectHasRunningTask,
}: {
  snapshot: JsonRecord | null
  activeProject: ProjectCard | null
  activeTask: JsonRecord | null
  activeProjectHasRunningTask: boolean
}) {
  const rawPipelinePhase = snapshot?.pipeline?.phase ?? activeProject?.statusSummary?.phase ?? "split"
  const activeTaskStageId = activeProjectHasRunningTask
    ? activeTask?.action === "run-full-pipeline" || activeTask?.action === "build-scoped-workbook"
      ? rawPipelinePhase === "waiting-generation" || rawPipelinePhase === "complete" ? "excel" : rawPipelinePhase
      : TASK_STAGE_BY_ACTION[activeTask?.action]
    : null
  return { rawPipelinePhase, activeTaskStageId }
}


export function derivePipelinePresentation({
  snapshot,
  activeProject,
  activeTask,
  activeTaskActuallyRunning,
  activeTaskStageId,
  rawPipelinePhase,
}: {
  snapshot: JsonRecord | null
  activeProject: ProjectCard | null
  activeTask: JsonRecord | null
  activeTaskActuallyRunning: boolean
  activeTaskStageId: string | null | undefined
  rawPipelinePhase: string
}) {
  const summary = activeProject?.statusSummary ?? {}
  const batchCounts = snapshot?.batch?.counts ?? {}
  const activeProjectIsIsolated = activeProject?.storageMode === "isolated-project"
  const pendingAssetCount = snapshot?.pending?.known === true
    ? Math.max(0, Number(snapshot.pending.count) || 0)
    : 0
  const pipelineStages = snapshot?.pipeline?.stages ?? [
    { id: "split", label: "剧本切分", state: "idle" },
    { id: "analysis", label: "分析与累计", state: "idle" },
    { id: "world-overview", label: "世界观总览", state: "idle" },
    { id: "asset-visual-specs", label: "资产设定", state: "idle" },
    { id: "excel", label: "Excel 制表", state: "idle" },
    { id: "generation", label: "资产出图", state: "idle" },
  ]
  const pendingAssetsReady = pendingAssetCount > 0
    && pipelineStages.find((stage: JsonRecord) => stage.id === "analysis")?.state === "complete"
    && pipelineStages.find((stage: JsonRecord) => stage.id === "world-overview")?.state === "complete"
  const startTaskAction = pendingAssetCount === 0 && rawPipelinePhase === "asset-visual-specs"
    ? "finalize-after-confirmation"
    : "run-full-pipeline"
  const displayPipelineStages = pipelineStages.map((stage: JsonRecord) => {
    if (activeTask?.status === "paused" && stage.state === "active") return { ...stage, state: "warning" }
    if (!activeTaskActuallyRunning && stage.state === "active") return { ...stage, state: "waiting" }
    if (activeTaskActuallyRunning && activeTaskStageId === stage.id) return { ...stage, state: "active" }
    return stage
  })
  const currentPipelinePhase = activeTaskStageId ?? rawPipelinePhase
  const analysisStage = pipelineStages.find((stage: JsonRecord) => stage.id === "analysis")
  const currentAnalysisEpisode = typeof analysisStage?.currentEpisode === "number"
    && Number.isInteger(analysisStage.currentEpisode)
    && analysisStage.currentEpisode > 0
      ? analysisStage.currentEpisode
      : null
  const currentStageLabel = pendingAssetsReady && !activeTaskActuallyRunning
    ? "等待人工确认"
    : activeTask?.status === "paused"
      ? "流水线已暂停"
    : activeTask?.status === "pausing"
      ? "流水线正在暂停"
      : activeTask?.status === "queued"
        ? "任务已排队"
        : !activeTaskActuallyRunning && currentPipelinePhase !== "complete"
          ? currentPipelinePhase === "analysis" && currentAnalysisEpisode !== null
            ? `剧本分析 - 第 ${currentAnalysisEpisode} 集（未运行）`
            : `${PHASE_LABELS[currentPipelinePhase] ?? "流水线"}（未运行）`
          : currentPipelinePhase === "analysis" && currentAnalysisEpisode !== null
            ? `剧本分析 - 第 ${currentAnalysisEpisode} 集分析中`
            : CURRENT_STAGE_LABELS[currentPipelinePhase] ?? `${PHASE_LABELS[currentPipelinePhase] ?? "流水线"}中`
  const visualSpecsStage = pipelineStages.find((stage: JsonRecord) => stage.id === "asset-visual-specs")
  const visualSpecsTask = snapshot?.pipeline?.currentTask?.scope === "asset-visual-specs"
    ? snapshot.pipeline.currentTask
    : null
  const showVisualSpecsCard = activeTaskActuallyRunning && (currentPipelinePhase === "asset-visual-specs"
    || visualSpecsStage?.state === "active")
  const screenplaySource = snapshot?.screenplay?.label
    ?? snapshot?.screenplay?.filename
    ?? "尚未导入剧本"
  const completedStageCount = displayPipelineStages.filter((stage: JsonRecord) => stage.state === "complete").length
  const activePipelineStage = displayPipelineStages.find((stage: JsonRecord) => stage.state === "active")
  const activeStageProgress = activePipelineStage?.progress?.mode === "determinate"
    ? percent(activePipelineStage.progress.done, activePipelineStage.progress.total)
    : null
  const summaryProgress = currentPipelinePhase === "complete"
    ? 100
    : displayPipelineStages.length
      ? Math.min(100, ((completedStageCount + (activeStageProgress ?? 0) / 100) / displayPipelineStages.length) * 100)
      : 0
  const showSummaryProgressPercent = currentPipelinePhase === "complete"
    || !activePipelineStage
    || activeStageProgress !== null

  return {
    activeProjectIsIsolated,
    batchCounts,
    currentStageLabel,
    displayPipelineStages,
    pendingAssetCount,
    pendingAssetsReady,
    screenplaySource,
    showSummaryProgressPercent,
    showVisualSpecsCard,
    startTaskAction,
    summary,
    summaryProgress,
    visualSpecsTask,
  }
}
