import * as React from "react"
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  Database,
  FileOutput,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react"

import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { PendingAssetDialog } from "@/features/pending-assets/pending-asset-dialog"
import { AgentChatCard } from "@/features/workbench/agent-chat-card"
import { WorkbenchPipelineOverview } from "@/features/workbench/workbench-pipeline-overview"
import { WorkbenchProjectPanel } from "@/features/workbench/workbench-project-panel"
import { AssetOverview, PendingAssetBanner, PromptStudioLauncher } from "@/features/workbench/workbench-project-summary"
import { WorkbenchProjectDialogs } from "@/features/workbench/workbench-project-dialogs"
import { CodexStatusCard, WorkbenchStatusBar } from "@/features/workbench/workbench-status-bar"
import { WorkbenchTaskActivity } from "@/features/workbench/workbench-task-activity"
import { useWorkbenchCodex } from "@/features/workbench/use-workbench-codex"
import { useWorkbenchProjects } from "@/features/workbench/use-workbench-projects"
import { useWorkbenchStageTimings } from "@/features/workbench/use-workbench-stage-timings"
import { useWorkbenchTasks } from "@/features/workbench/use-workbench-tasks"

import {
  JsonRecord,
  ToastState,
  controlAdapter,
  PHASE_LABELS,
  CURRENT_STAGE_LABELS,
  TASK_STAGE_BY_ACTION,
  safeMessage,
  percent,
} from "@/features/workbench/workbench-foundation"

import { MemoPromptStudioDrawer } from "@/features/prompt-studio/prompt-studio-drawer"

export default function App() {
  const { resolvedTheme, setTheme } = useTheme()
  const [motionMode, setMotionMode] = React.useState<"full" | "reduced">(() =>
    localStorage.getItem("ka-prompt-studio.motion") === "reduced" ? "reduced" : "full",
  )
  const [drawerOpen, setDrawerOpen] = React.useState(false)
  const [drawerMounted, setDrawerMounted] = React.useState(false)
  const [drawerTab, setDrawerTab] = React.useState("batch")
  const [pendingAssetDialogOpen, setPendingAssetDialogOpen] = React.useState(false)
  const [busyAction, setBusyAction] = React.useState<string | null>(null)
  const [toast, setToast] = React.useState<ToastState | null>(null)
  const toastSequence = React.useRef(0)
  const drawerPhase = React.useRef<"closed" | "opening" | "open" | "closing">("closed")
  const drawerReturnFocus = React.useRef<HTMLElement | null>(null)
  const batchStudioButtonRef = React.useRef<HTMLButtonElement>(null)
  const promptedPendingStates = React.useRef(new Set<string>())

  const notify = React.useCallback((message: string, tone: ToastState["tone"] = "good") => {
    const id = ++toastSequence.current
    setToast({ id, message, tone })
    if (tone !== "error") {
      window.setTimeout(
        () => setToast((current) => current?.id === id ? null : current),
        tone === "warning" ? 6500 : 3600,
      )
    }
  }, [])

  const {
    activeProject,
    activeProjectId,
    createProject,
    createProjectFromScreenplay,
    deleteCurrentProject,
    deleteProjectOpen,
    desktopHost,
    fileInputRef,
    focusProjectFromKey,
    newProjectName,
    newProjectOpen,
    openDirectory,
    projectButtonRefs,
    projects,
    projectsLoading,
    refreshActiveProjectState,
    refreshProjects,
    renameCurrentProject,
    renameProjectName,
    renameProjectOpen,
    selectProject,
    setDeleteProjectOpen,
    setNewProjectName,
    setNewProjectOpen,
    setRenameProjectName,
    setRenameProjectOpen,
    snapshot,
  } = useWorkbenchProjects({ drawerOpen, notify, setBusyAction })

  const {
    activeProjectHasRunningTask,
    activeTask,
    activeTaskActuallyRunning,
    copyTaskLog,
    dismissedFailureTaskIds,
    pauseCurrentTask,
    recordProjectTask,
    removeProjectTask,
    setDismissedFailureTaskIds,
    setTaskLogOpen,
    taskLogOpen,
    tasks,
    watchTask,
  } = useWorkbenchTasks({ activeProjectId, notify, refreshProjects, setBusyAction })

  const rawPipelinePhase = snapshot?.pipeline?.phase ?? activeProject?.statusSummary?.phase ?? "split"
  const activeTaskStageId = activeProjectHasRunningTask
    ? activeTask?.action === "run-full-pipeline" || activeTask?.action === "build-scoped-workbook"
      ? rawPipelinePhase === "waiting-generation" || rawPipelinePhase === "complete" ? "excel" : rawPipelinePhase
      : TASK_STAGE_BY_ACTION[activeTask?.action]
    : null

  const {
    activeStageElapsedSeconds,
    getProjectStageTimings,
    projectElapsedSeconds,
    removeProjectStageTimings,
    resetProjectStageTimings,
    stageElapsedSeconds,
  } = useWorkbenchStageTimings({
    activeProjectId,
    activeTask,
    activeTaskActuallyRunning,
    activeTaskStageId,
    notify,
  })

  const {
    activeDraft: activeAgentChatDraft,
    activeSession: activeAgentChat,
    authorize: authorizeCodex,
    cancelSession: cancelAgentChat,
    checkStatus: checkCodexStatus,
    codexAuthorizing,
    codexChecking,
    codexStatus,
    confirmedProposalIds: confirmedAgentProposalIds,
    connected: codexConnected,
    markProposalConfirmed,
    newConversation: newAgentConversation,
    refreshRuntimeConfig: refreshCodexRuntimeConfig,
    runtimeConfig: codexRuntimeConfig,
    runtimeConfigLocked: codexRuntimeConfigLocked,
    runtimeConfigSaving: codexRuntimeConfigSaving,
    sendMessage: sendAgentChatMessage,
    setActiveDraft: setActiveAgentChatDraft,
    updateRuntimeConfig: updateCodexRuntimeConfig,
  } = useWorkbenchCodex({ activeProjectHasRunningTask, activeProjectId, notify })

  const removeDeletedProjectState = React.useCallback((projectId: string) => {
    removeProjectTask(projectId)
    removeProjectStageTimings(projectId)
  }, [removeProjectStageTimings, removeProjectTask])

  React.useEffect(() => {
    void checkCodexStatus({ quiet: true })
    void refreshCodexRuntimeConfig()
  }, [checkCodexStatus, refreshCodexRuntimeConfig])

  React.useEffect(() => {
    setPendingAssetDialogOpen(false)
  }, [activeTask?.taskId])

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      React.startTransition(() => setDrawerMounted(true))
    }, 350)
    return () => window.clearTimeout(timer)
  }, [])

  React.useEffect(() => {
    document.documentElement.dataset.motion = motionMode
    localStorage.setItem("ka-prompt-studio.motion", motionMode)
  }, [motionMode])

  const setStudioOpen = React.useCallback((open: boolean, tab = drawerTab) => {
    if (open && drawerPhase.current === "open") {
      setDrawerTab(tab)
      return
    }
    if (!open && drawerPhase.current === "closed") return

    drawerPhase.current = open ? "open" : "closed"
    if (open) {
      setDrawerTab(tab)
      drawerReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setDrawerMounted(true)
      setDrawerOpen(true)
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => document.getElementById("prompt-studio-drawer")?.focus())
      })
    } else {
      setDrawerOpen(false)
      const returnTarget = drawerReturnFocus.current?.isConnected ? drawerReturnFocus.current : batchStudioButtonRef.current
      window.requestAnimationFrame(() => returnTarget?.focus())
      drawerReturnFocus.current = null
    }
  }, [drawerTab])

  const closeStudio = React.useCallback(() => {
    void setStudioOpen(false)
  }, [setStudioOpen])

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      const eventTarget = event.target instanceof HTMLElement ? event.target : null
      const editingText = Boolean(eventTarget?.closest('input, textarea, select, [contenteditable="true"]'))
      const nestedDialog = document.querySelector('[role="dialog"]:not(#prompt-studio-drawer), [role="alertdialog"]')
      if (!editingText && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault()
        void setStudioOpen(!drawerOpen, "batch")
      }
      if (!editingText && (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault()
        void setStudioOpen(true, "routes")
      }
      if (event.key === "Tab" && drawerOpen && !nestedDialog) {
        const drawer = document.getElementById("prompt-studio-drawer")
        const focusable = drawer
          ? [...drawer.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
              .filter((element) => element.getClientRects().length > 0)
          : []
        if (!drawer || !focusable.length) {
          event.preventDefault()
          drawer?.focus()
        } else {
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          const active = document.activeElement
          if (!drawer.contains(active) || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
            event.preventDefault()
            ;(event.shiftKey ? last : first).focus()
          }
        }
      }
      if (event.key === "Escape" && drawerOpen && !nestedDialog) {
        setStudioOpen(false)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [drawerOpen, setStudioOpen])

  const runTask = React.useCallback(async (
    action: string,
    workbookScope: {
      workbookEpisodeStart?: number | null
      workbookEpisodeEnd?: number | null
      workbookAssetTypes?: string[]
    } = {},
  ) => {
    if (!activeProjectId || activeProjectHasRunningTask) return false
    setBusyAction(action)
    try {
      const savedProjectTiming = await getProjectStageTimings(activeProjectId)
      const task = await controlAdapter.startTask({
        projectId: activeProjectId,
        action,
        workbookEpisodeStart: workbookScope.workbookEpisodeStart ?? null,
        workbookEpisodeEnd: workbookScope.workbookEpisodeEnd ?? null,
        workbookAssetTypes: workbookScope.workbookAssetTypes ?? [],
      })
      const pipelinePhase = String(snapshot?.pipeline?.phase ?? activeProject?.statusSummary?.phase ?? "")
      const resumesAfterDesktopRestart = Object.keys(savedProjectTiming).length > 0
        && !["complete", "waiting-generation"].includes(pipelinePhase)
      const resumesInterruptedRun = ["paused", "failed"].includes(String(activeTask?.status))
        || resumesAfterDesktopRestart
      if (!resumesInterruptedRun && ["run-full-pipeline", "build-scoped-workbook", "analyze-screenplay", "split"].includes(action)) {
        resetProjectStageTimings(activeProjectId)
      }
      recordProjectTask(activeProjectId, task)
      notify("任务已进入当前项目的独立队列")
      void watchTask(activeProjectId, task)
      return true
    } catch (error) {
      notify(safeMessage(error, "任务启动失败"), "error")
      return false
    } finally {
      setBusyAction(null)
    }
  }, [activeProject?.statusSummary?.phase, activeProjectHasRunningTask, activeProjectId, activeTask?.status, getProjectStageTimings, notify, recordProjectTask, resetProjectStageTimings, snapshot?.pipeline?.phase, watchTask])

  const confirmAgentProposal = React.useCallback(async (message: JsonRecord) => {
    const proposal = message?.proposal
    const messageId = String(message?.messageId ?? "")
    if (!proposal || !messageId || confirmedAgentProposalIds.includes(messageId)) return
    let completed = false
    if (proposal.action === "pause-current-task") {
      if (!activeProjectHasRunningTask) {
        notify("当前项目没有可暂停的任务", "warning")
        return
      }
      completed = await pauseCurrentTask()
    }
    else if (proposal.action === "refresh-project") {
      await refreshProjects()
      completed = true
    } else {
      if (activeProjectHasRunningTask) {
        notify("当前项目已有任务运行，请先暂停后再确认新操作", "warning")
        return
      }
      completed = await runTask(proposal.action, {
        workbookEpisodeStart: proposal.workbookEpisodeStart ?? null,
        workbookEpisodeEnd: proposal.workbookEpisodeEnd ?? null,
        workbookAssetTypes: proposal.workbookAssetTypes ?? [],
      })
    }
    if (completed) markProposalConfirmed(messageId)
  }, [activeProjectHasRunningTask, confirmedAgentProposalIds, markProposalConfirmed, notify, pauseCurrentTask, refreshProjects, runTask])

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

  React.useEffect(() => {
    if (!activeProjectId) return
    if (pendingAssetCount === 0) {
      promptedPendingStates.current.delete(activeProjectId)
      return
    }
    if (!pendingAssetsReady || activeProjectHasRunningTask || promptedPendingStates.current.has(activeProjectId)) return
    promptedPendingStates.current.add(activeProjectId)
    setPendingAssetDialogOpen(true)
  }, [activeProjectHasRunningTask, activeProjectId, pendingAssetCount, pendingAssetsReady])

  return (
    <div className={cn("relative isolate flex h-dvh min-w-0 overflow-hidden text-foreground transition-colors duration-150", drawerOpen ? "bg-muted/70" : "bg-background")}>
      <section
        inert={drawerOpen}
        className={cn(
          "relative h-dvh min-w-0 flex-1 overflow-hidden bg-background",
          drawerOpen && "rounded-2xl shadow-panel",
        )}
      >
        <div className="flex h-full min-h-0 flex-col bg-muted/25">
          <WorkbenchStatusBar
            summary={summary}
            projectElapsedSeconds={projectElapsedSeconds}
            motionMode={motionMode}
            resolvedTheme={resolvedTheme}
            toggleMotion={() => setMotionMode((value) => value === "full" ? "reduced" : "full")}
            toggleTheme={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          />

          <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-6xl space-y-4 p-4 sm:p-5">
              <header className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <CodexStatusCard
                    checking={codexChecking}
                    connected={codexConnected}
                    message={codexStatus?.message}
                    authorizing={codexAuthorizing}
                    authorize={() => void authorizeCodex()}
                    check={() => void checkCodexStatus()}
                  />
                  <AgentChatCard
                    projectId={activeProjectId}
                    connected={codexConnected}
                    runtimeConfig={codexRuntimeConfig}
                    session={activeAgentChat}
                    draft={activeAgentChatDraft}
                    confirmedProposalIds={confirmedAgentProposalIds}
                    onDraftChange={setActiveAgentChatDraft}
                    onSend={() => void sendAgentChatMessage()}
                    onCancel={() => void cancelAgentChat()}
                    onNewConversation={newAgentConversation}
                    onRuntimeConfigChange={(next) => void updateCodexRuntimeConfig(next)}
                    runtimeConfigSaving={codexRuntimeConfigSaving}
                    runtimeConfigLocked={codexRuntimeConfigLocked}
                    onConfirmProposal={(message) => void confirmAgentProposal(message)}
                  />
                  <div className="min-w-0">
                    <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground"><Activity className="size-3.5" />生产监听</div>
                    <h1 className="truncate text-2xl font-semibold tracking-tight">{activeProject?.displayName ?? "选择一个项目"}</h1>
                    <p className="mt-1 text-xs text-muted-foreground">当前项目独立使用目录、Cache、输出、队列与锁。</p>
                  </div>
                <div className="flex shrink-0 flex-wrap gap-2 sm:self-end" aria-label="当前项目目录操作">
                  <Button variant="outline" size="sm" onClick={() => void openDirectory("project")} disabled={!activeProject}><FolderOpen />项目文件夹</Button>
                  <Button variant="outline" size="sm" onClick={() => void openDirectory("output")} disabled={!activeProject}><FileOutput />输出文件夹</Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => void refreshProjects()} disabled={projectsLoading} aria-label="刷新项目"><RefreshCw className={cn(projectsLoading && "animate-spin")} /></Button>
                </div>
              </header>

              <WorkbenchProjectPanel
                studio={{
                  activeAgentChatRunning: activeAgentChat?.status === "running",
                  activeProject,
                  activeProjectHasRunningTask,
                  activeProjectId,
                  activeProjectIsIsolated,
                  busyAction,
                  createFromScreenplay: (file) => void createProjectFromScreenplay(file),
                  fileInputRef,
                  focusFromKey: focusProjectFromKey,
                  openCreate: () => setNewProjectOpen(true),
                  openDelete: () => setDeleteProjectOpen(true),
                  openRename: (name) => {
                    setRenameProjectName(name)
                    setRenameProjectOpen(true)
                  },
                  projectButtonRefs,
                  projects,
                  projectsLoading,
                  selectProject: (projectId) => void selectProject(projectId),
                  tasks,
                }}
              />

              <WorkbenchPipelineOverview
                studio={{
                  activeProjectAvailable: Boolean(activeProject),
                  activeProjectHasRunningTask,
                  activeProjectId,
                  activeStageElapsedSeconds,
                  activeTaskActuallyRunning,
                  activeTaskStageId,
                  busyAction,
                  currentStageLabel,
                  displayPipelineStages,
                  pause: () => void pauseCurrentTask(),
                  pendingAssetsReady,
                  projectElapsedSeconds,
                  screenplaySource,
                  showSummaryProgressPercent,
                  showVisualSpecsCard,
                  stageElapsedSeconds,
                  start: () => void runTask(startTaskAction),
                  startTaskAction,
                  summaryProgress,
                  visualSpecsTask,
                }}
              />

              <PendingAssetBanner
                count={pendingAssetCount}
                projectAvailable={Boolean(activeProject)}
                open={() => setPendingAssetDialogOpen(true)}
              />

              <AssetOverview counts={snapshot?.assetCounts?.byType} />

              <PromptStudioLauncher
                buttonRef={batchStudioButtonRef}
                drawerOpen={drawerOpen}
                activeProject={Boolean(activeProject)}
                pendingAssetCount={pendingAssetCount}
                snapshot={snapshot}
                batchCounts={batchCounts}
                toggle={() => void setStudioOpen(!drawerOpen, activeProject ? "batch" : "templates")}
              />

              <WorkbenchTaskActivity
                studio={{
                  activeTask,
                  copyLog: () => void copyTaskLog(),
                  dismissFailure: () => {
                    if (activeTask) {
                      setDismissedFailureTaskIds((ids) => [...new Set([...ids, String(activeTask.taskId)])])
                    }
                  },
                  failureDismissed: activeTask
                    ? dismissedFailureTaskIds.includes(String(activeTask.taskId))
                    : false,
                  open: taskLogOpen,
                  setOpen: setTaskLogOpen,
                }}
              />

              <div className="flex items-center gap-2 rounded-lg border border-info/25 bg-info/8 px-3 py-2 text-[11px] text-muted-foreground"><Database className="size-3.5 text-info" /><span>项目隔离已启用；切换项目不会混用 Cache、输出、队列或锁。</span></div>
            </div>
          </main>
        </div>
      </section>

      {drawerMounted && (
        <button
          type="button"
          className={cn(
            "group fixed inset-0 z-30 bg-black/10 text-foreground transition-opacity duration-150 ease-standard motion-reduce:transition-none focus-visible:outline-none",
            drawerOpen ? "opacity-100" : "pointer-events-none opacity-0",
          )}
          aria-label="返回主监听窗口"
          aria-hidden={!drawerOpen}
          tabIndex={-1}
          onClick={closeStudio}
        >
          <span className="absolute left-2 top-1/2 flex w-12 -translate-y-1/2 flex-col items-center gap-0.5 rounded-xl border bg-card/95 px-1 py-2 shadow-panel transition-transform group-hover:-translate-x-0.5 group-focus-visible:ring-2 group-focus-visible:ring-ring sm:left-3">
            <ChevronLeft className="size-4" />
            <span className="text-[9px] font-medium leading-tight">返回<br />监听</span>
          </span>
        </button>
      )}
      {drawerMounted && (
        <MemoPromptStudioDrawer
          className={cn(
            "prompt-studio-stage fixed right-3 bottom-3 z-40 rounded-2xl border shadow-overlay",
            "top-10 left-12 sm:top-14 sm:left-56 lg:left-60",
            !drawerOpen && "pointer-events-none",
          )}
          open={drawerOpen}
          projectId={activeProject?.projectId ?? null}
          projectName={activeProject?.displayName ?? null}
          tab={drawerTab}
          setTab={setDrawerTab}
          runTask={runTask}
          notify={notify}
          onClose={closeStudio}
        />
      )}

      <PendingAssetDialog
        open={pendingAssetDialogOpen}
        onOpenChange={setPendingAssetDialogOpen}
        projectId={activeProjectId}
        projectBusy={activeProjectHasRunningTask}
        onCommitted={refreshActiveProjectState}
        notify={notify}
      />

      <WorkbenchProjectDialogs
        studio={{
          busyAction,
          create: {
            open: newProjectOpen,
            name: newProjectName,
            setOpen: setNewProjectOpen,
            setName: setNewProjectName,
            submit: () => void createProject(),
          },
          rename: {
            open: renameProjectOpen,
            name: renameProjectName,
            setOpen: setRenameProjectOpen,
            setName: setRenameProjectName,
            submit: () => void renameCurrentProject(),
          },
          remove: {
            open: deleteProjectOpen,
            projectName: activeProject?.displayName ?? "",
            projectIsIsolated: activeProjectIsIsolated,
            projectHasRunningTask: activeProjectHasRunningTask,
            setOpen: setDeleteProjectOpen,
            submit: () => void deleteCurrentProject({
              agentChatRunning: activeAgentChat?.status === "running",
              onDeleted: removeDeletedProjectState,
            }),
          },
        }}
      />

      {toast && (
        <div role={toast.tone === "error" ? "alert" : "status"} aria-live={toast.tone === "error" ? "assertive" : "polite"} className={cn(
          "fixed top-14 right-4 z-[80] flex w-[min(calc(100vw-2rem),520px)] items-start gap-3 rounded-xl border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-overlay animate-popover-in",
          toast.tone === "error" && "border-destructive/45",
          toast.tone === "warning" && "border-warning/45",
          toast.tone === "good" && "border-success/35",
        )}>
          {toast.tone === "good" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : <AlertTriangle className={cn("mt-0.5 size-4 shrink-0", toast.tone === "error" ? "text-destructive" : "text-warning")} />}
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{toast.tone === "error" ? "操作失败" : toast.tone === "warning" ? "请注意" : "操作完成"}</p>
            <p className="mt-0.5 break-words text-xs leading-relaxed text-muted-foreground">{toast.message}</p>
          </div>
          <Button variant="ghost" size="icon-sm" className="-mr-2 -mt-1" onClick={() => setToast(null)} aria-label="关闭提示"><X /></Button>
        </div>
      )}
    </div>
  )
}
