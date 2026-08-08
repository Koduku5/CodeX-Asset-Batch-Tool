import { Check, LoaderCircle, Pause, Play, Timer } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import {
  STATE_LABELS,
} from "@/features/workbench/workbench-constants"
import {
  StatusDot,
} from "@/features/workbench/workbench-primitives"
import {
  formatDuration,
} from "@/features/workbench/workbench-utils"
import {
  type JsonRecord,
} from "@/features/workbench/workbench-types"
import { cn } from "@/lib/utils"

export type WorkbenchPipelineOverviewStudio = {
  activeProjectAvailable: boolean
  activeProjectId: string | null
  activeProjectHasRunningTask: boolean
  activeTaskActuallyRunning: boolean
  activeTaskStageId: string | null | undefined
  activeStageElapsedSeconds: number | null
  busyAction: string | null
  currentStageLabel: string
  displayPipelineStages: JsonRecord[]
  pendingAssetsReady: boolean
  projectElapsedSeconds: number | undefined
  screenplaySource: string
  showSummaryProgressPercent: boolean
  showVisualSpecsCard: boolean
  stageElapsedSeconds: Record<string, Record<string, number>>
  startTaskAction: string
  summaryProgress: number
  visualSpecsTask: JsonRecord | null
  pause: () => void
  start: () => void
}

export function WorkbenchPipelineOverview({ studio }: { studio: WorkbenchPipelineOverviewStudio }) {
  const {
    activeProjectAvailable,
    activeProjectHasRunningTask,
    activeProjectId,
    activeStageElapsedSeconds,
    activeTaskActuallyRunning,
    activeTaskStageId,
    busyAction,
    currentStageLabel,
    displayPipelineStages,
    pause,
    pendingAssetsReady,
    projectElapsedSeconds,
    screenplaySource,
    showSummaryProgressPercent,
    showVisualSpecsCard,
    stageElapsedSeconds,
    start,
    startTaskAction,
    summaryProgress,
    visualSpecsTask,
  } = studio

  return (
    <>
      <div className="flex flex-wrap justify-end gap-2 px-1" aria-label="流水线任务操作">
        <Button onClick={start} disabled={!activeProjectAvailable || activeProjectHasRunningTask || pendingAssetsReady || busyAction === startTaskAction}>
          {busyAction === startTaskAction ? <LoaderCircle className="animate-spin" /> : <Play />}{startTaskAction === "finalize-after-confirmation" ? "继续任务" : "开始任务"}
        </Button>
        <Button variant="destructive" onClick={pause} disabled={!activeProjectHasRunningTask || busyAction === "pause-task"}>
          {busyAction === "pause-task" ? <LoaderCircle className="animate-spin" /> : <Pause />}暂停任务
        </Button>
      </div>

      <Card className="gap-2.5 overflow-hidden border-border/80 py-4 shadow-panel">
        <CardHeader className="px-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <CardTitle className="truncate text-xl" aria-live="polite">当前阶段：{currentStageLabel}</CardTitle>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">当前剧本来源：“{screenplaySource}”</p>
            </div>
            <Badge variant="muted" className="shrink-0">项目用时 {formatDuration(projectElapsedSeconds)}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 px-4">
          <div className="flex items-center gap-3">
            <Progress
              value={summaryProgress}
              aria-label="当前流水线真实总进度"
              aria-valuetext={showSummaryProgressPercent ? `${Math.round(summaryProgress)}%` : "当前阶段正在运行，总进度暂不可精确计算"}
              className="h-2.5 flex-1"
            />
            {showSummaryProgressPercent && (
              <span className="w-10 shrink-0 text-right text-[11px] font-medium tabular-nums text-muted-foreground">{Math.round(summaryProgress)}%</span>
            )}
          </div>
          {showVisualSpecsCard && (
            <div className="rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-xs" aria-live="polite">
              <p className="font-semibold text-foreground">当前阶段：资产设定生成中</p>
              <p className="mt-1 text-muted-foreground">
                正在处理：{visualSpecsTask?.assetId
                  ? `当前${visualSpecsTask.sheetName ?? "资产"} ${visualSpecsTask.assetId}`
                  : "正在准备下一项资产"}
              </p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-6">
            {displayPipelineStages.map((stage: JsonRecord) => {
              const isRunning = stage.id === activeTaskStageId
                && stage.state === "active"
                && activeTaskActuallyRunning
              const completedElapsedSeconds = activeProjectId
                ? stageElapsedSeconds[activeProjectId]?.[String(stage.id)] ?? null
                : null
              const displayedElapsedSeconds = isRunning
                ? activeStageElapsedSeconds
                : stage.state === "complete" ? completedElapsedSeconds : null

              return (
                <div
                  key={stage.id}
                  className={cn(
                    "flex min-h-[84px] min-w-0 flex-col rounded-xl border bg-muted/20 px-3 py-3 transition-[border-color,background-color,box-shadow] duration-300",
                    stage.state === "active" && "border-info/55 bg-info/8 shadow-sm",
                    stage.state === "complete" && "border-success/60 bg-success/8",
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2 text-xs font-semibold leading-5 text-foreground">
                    {isRunning
                      ? <LoaderCircle className="stage-running-spinner size-4 shrink-0 text-info" aria-label="运行中" />
                      : <StatusDot state={stage.state} />}
                    <span className="min-w-0 truncate">{stage.label}</span>
                  </div>
                  <div className="mt-auto flex min-w-0 items-center gap-2 text-[11px] leading-none text-muted-foreground">
                    <span className="min-w-0 flex-1 truncate">{STATE_LABELS[stage.state] ?? "未开始"}</span>
                    {displayedElapsedSeconds !== null && (
                      <span
                        className={cn(
                          "flex shrink-0 items-center gap-1 font-medium tabular-nums",
                          isRunning ? "text-info" : "text-muted-foreground",
                        )}
                        aria-label={`${stage.label}${isRunning ? "已运行" : "用时"} ${formatDuration(displayedElapsedSeconds)}`}
                      >
                        <Timer className="size-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                        {formatDuration(displayedElapsedSeconds)}
                      </span>
                    )}
                    {stage.state === "complete" && (
                      <span className="grid size-4.5 shrink-0 place-items-center rounded-full border border-success/70 text-success" aria-label="此阶段已完成">
                        <Check className="size-2.5" strokeWidth={2} aria-hidden="true" />
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>
    </>
  )
}
