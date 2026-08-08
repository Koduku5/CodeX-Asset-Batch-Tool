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
import { saveStageTimingsWithRetry } from "@/services/stage-timing-persistence.mjs"

import {
  JsonRecord,
  ProjectCard,
  ToastState,
  workspaceAdapter,
  controlAdapter,
  codexStatusAdapter,
  codexAgentChatAdapter,
  PHASE_LABELS,
  CURRENT_STAGE_LABELS,
  TASK_STAGE_BY_ACTION,
  ACTIVE_TASK_STATUSES,
  safeMessage,
  taskFailureSummary,
  percent,
  projectNameFromScreenplay,
} from "@/features/workbench/workbench-foundation"

import { MemoPromptStudioDrawer } from "@/features/prompt-studio/prompt-studio-drawer"

type StageTimings = Record<string, number>
type StageElapsedSeconds = Record<string, StageTimings>

export default function App() {
  const { resolvedTheme, setTheme } = useTheme()
  const [motionMode, setMotionMode] = React.useState<"full" | "reduced">(() =>
    localStorage.getItem("ka-prompt-studio.motion") === "reduced" ? "reduced" : "full",
  )
  const [projects, setProjects] = React.useState<ProjectCard[]>([])
  const [activeProjectId, setActiveProjectId] = React.useState<string | null>(null)
  const [selectionRevision, setSelectionRevision] = React.useState(0)
  const [snapshot, setSnapshot] = React.useState<JsonRecord | null>(null)
  const [projectsLoading, setProjectsLoading] = React.useState(true)
  const [drawerOpen, setDrawerOpen] = React.useState(false)
  const [drawerMounted, setDrawerMounted] = React.useState(false)
  const [drawerTab, setDrawerTab] = React.useState("batch")
  const [pendingAssetDialogOpen, setPendingAssetDialogOpen] = React.useState(false)
  const [desktopHost, setDesktopHost] = React.useState(false)
  const [newProjectOpen, setNewProjectOpen] = React.useState(false)
  const [newProjectName, setNewProjectName] = React.useState("")
  const [renameProjectOpen, setRenameProjectOpen] = React.useState(false)
  const [renameProjectName, setRenameProjectName] = React.useState("")
  const [deleteProjectOpen, setDeleteProjectOpen] = React.useState(false)
  const [busyAction, setBusyAction] = React.useState<string | null>(null)
  const [tasks, setTasks] = React.useState<Record<string, JsonRecord>>({})
  const [clockNow, setClockNow] = React.useState(() => Date.now())
  const [activeStageTiming, setActiveStageTiming] = React.useState<{
    key: string
    projectId: string
    stageId: string
    startedAt: number
    accumulatedSeconds: number
  } | null>(null)
  const [stageElapsedSeconds, setStageElapsedSeconds] = React.useState<StageElapsedSeconds>({})
  const [taskLogOpen, setTaskLogOpen] = React.useState(false)
  const [dismissedFailureTaskIds, setDismissedFailureTaskIds] = React.useState<string[]>([])
  const [codexStatus, setCodexStatus] = React.useState<JsonRecord | null>(null)
  const [codexChecking, setCodexChecking] = React.useState(true)
  const [codexRuntimeConfig, setCodexRuntimeConfig] = React.useState<JsonRecord | null>(null)
  const [codexRuntimeConfigSaving, setCodexRuntimeConfigSaving] = React.useState(false)
  const [agentChatSessions, setAgentChatSessions] = React.useState<Record<string, JsonRecord>>({})
  const [agentChatDrafts, setAgentChatDrafts] = React.useState<Record<string, string>>({})
  const [confirmedAgentProposalIds, setConfirmedAgentProposalIds] = React.useState<string[]>([])
  const [toast, setToast] = React.useState<ToastState | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const projectButtonRefs = React.useRef(new Map<string, HTMLButtonElement>())
  const toastSequence = React.useRef(0)
  const drawerPhase = React.useRef<"closed" | "opening" | "open" | "closing">("closed")
  const drawerReturnFocus = React.useRef<HTMLElement | null>(null)
  const batchStudioButtonRef = React.useRef<HTMLButtonElement>(null)
  const watchedTaskIds = React.useRef(new Set<string>())
  const watchedAgentChatIds = React.useRef(new Set<string>())
  const promptedPendingStates = React.useRef(new Set<string>())
  const loadedStageTimingProjectIds = React.useRef(new Set<string>())
  const stageTimingLoadPromises = React.useRef(new Map<string, Promise<StageTimings>>())
  const savedStageTimingSignatures = React.useRef(new Map<string, string>())
  const stageTimingSaveQueues = React.useRef(new Map<string, Promise<unknown>>())
  const stageTimingSaveWarningProjectIds = React.useRef(new Set<string>())

  const activeProject = projects.find((project) => project.projectId === activeProjectId) ?? null
  const activeTask = activeProjectId ? tasks[activeProjectId] ?? null : null
  const activeProjectHasRunningTask = ACTIVE_TASK_STATUSES.has(String(activeTask?.status))
  const activeTaskActuallyRunning = ["running", "pausing"].includes(String(activeTask?.status))
    && Number.isFinite(Date.parse(String(activeTask?.startedAt ?? "")))
  const codexConnected = codexStatus?.connected === true
  const activeAgentChat = activeProjectId ? agentChatSessions[activeProjectId] ?? null : null
  const activeAgentChatDraft = activeProjectId ? agentChatDrafts[activeProjectId] ?? "" : ""
  const codexRuntimeConfigLocked = activeProjectHasRunningTask || activeAgentChat?.status === "running"

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

  const loadStageTimings = React.useCallback((projectId: string) => {
    const existing = stageTimingLoadPromises.current.get(projectId)
    if (existing) return existing
    const current = controlAdapter.getStageTimings({ projectId }).then((result) => {
      const stages = { ...result.stages }
      loadedStageTimingProjectIds.current.add(projectId)
      savedStageTimingSignatures.current.set(projectId, JSON.stringify(stages))
      setStageElapsedSeconds((items) => ({ ...items, [projectId]: stages }))
      return stages
    }).finally(() => {
      if (stageTimingLoadPromises.current.get(projectId) === current) {
        stageTimingLoadPromises.current.delete(projectId)
      }
    })
    stageTimingLoadPromises.current.set(projectId, current)
    return current
  }, [])

  const checkCodexStatus = React.useCallback(async ({ quiet = false } = {}) => {
    setCodexChecking(true)
    try {
      const status = await codexStatusAdapter.getStatus()
      setCodexStatus(status)
      if (!quiet) notify(status.connected ? "Codex SDK 授权有效" : status.message, status.connected ? "good" : "warning")
    } catch (error) {
      setCodexStatus(null)
      if (!quiet) notify(safeMessage(error, "Codex SDK 状态检测失败"), "error")
    } finally {
      setCodexChecking(false)
    }
  }, [notify])

  const refreshCodexRuntimeConfig = React.useCallback(async () => {
    try {
      setCodexRuntimeConfig(await codexAgentChatAdapter.getRuntimeConfig())
    } catch {
      setCodexRuntimeConfig(null)
    }
  }, [])

  const authorizeCodex = React.useCallback(async () => {
    setBusyAction("authorize-codex")
    setCodexChecking(true)
    try {
      const login = await codexStatusAdapter.startLogin()
      if (!login.alreadyConnected) notify("已打开内置 Codex CLI 登录，请在浏览器中完成授权", "warning")
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, 1500))
        const status = await codexStatusAdapter.getStatus()
        setCodexStatus(status)
        if (status.connected) {
          void refreshCodexRuntimeConfig()
          notify(login.alreadyConnected ? "Codex SDK 授权有效" : "Codex 登录成功，后续启动将复用本机登录状态", "good")
          return
        }
      }
      notify("尚未完成 Codex 登录；完成浏览器授权后可点击重新检测", "warning")
    } catch (error) {
      notify(safeMessage(error, "内置 Codex CLI 登录启动失败"), "error")
    } finally {
      setCodexChecking(false)
      setBusyAction(null)
    }
  }, [notify, refreshCodexRuntimeConfig])

  const refreshProjects = React.useCallback(async (quiet = false) => {
    if (!quiet) setProjectsLoading(true)
    try {
      const result = await workspaceAdapter.listProjects()
      const next = result.projects as ProjectCard[]
      setProjects((current) => {
        const unchanged = current.length === next.length && current.every((project, index) => {
          const candidate = next[index]
          if (!candidate) return false
          return project.projectId === candidate.projectId
            && project.displayName === candidate.displayName
            && project.availability === candidate.availability
            && project.storageMode === candidate.storageMode
            && JSON.stringify(project.statusSummary) === JSON.stringify(candidate.statusSummary)
        })
        return unchanged ? current : next
      })
      setActiveProjectId((current) => current && next.some((project) => project.projectId === current)
        ? current
        : next[0]?.projectId ?? null)
    } catch (error) {
      if (!quiet) notify(safeMessage(error, "项目列表读取失败"), "error")
    } finally {
      if (!quiet) setProjectsLoading(false)
    }
  }, [notify])

  React.useEffect(() => {
    setDesktopHost(typeof window.kaDesktopBridge?.setStudioDrawerOpen === "function")
    void checkCodexStatus({ quiet: true })
    void refreshCodexRuntimeConfig()
  }, [checkCodexStatus, refreshCodexRuntimeConfig])

  React.useEffect(() => {
    setTaskLogOpen(false)
    setPendingAssetDialogOpen(false)
  }, [activeTask?.taskId])

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      React.startTransition(() => setDrawerMounted(true))
    }, 350)
    return () => window.clearTimeout(timer)
  }, [])

  React.useEffect(() => {
    if (drawerOpen) return
    let interval = 0
    const resume = window.setTimeout(() => {
      void refreshProjects()
      interval = window.setInterval(() => void refreshProjects(true), 3000)
    }, 220)
    return () => {
      window.clearTimeout(resume)
      window.clearInterval(interval)
    }
  }, [drawerOpen, refreshProjects])

  React.useEffect(() => {
    document.documentElement.dataset.motion = motionMode
    localStorage.setItem("ka-prompt-studio.motion", motionMode)
  }, [motionMode])

  React.useEffect(() => {
    if (!activeProjectId) {
      setSnapshot(null)
      return
    }
    if (drawerOpen) return
    let cancelled = false
    let timer = 0
    const poll = async () => {
      try {
        const result = await workspaceAdapter.getSnapshot({ projectId: activeProjectId, selectionRevision })
        if (!cancelled) setSnapshot(result.snapshot)
        const delay = Math.max(750, Math.min(5000, Number(result.snapshot.pollAfterMs) || 1500))
        if (!cancelled) timer = window.setTimeout(poll, delay)
      } catch (error) {
        if (!cancelled) {
          notify(safeMessage(error, "项目状态读取失败"), "warning")
          timer = window.setTimeout(poll, 4000)
        }
      }
    }
    timer = window.setTimeout(poll, 220)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [activeProjectId, drawerOpen, notify, selectionRevision])

  const selectProject = async (projectId: string) => {
    if (projectId === activeProjectId) return
    if (desktopHost) {
      try {
        const result = await workspaceAdapter.selectProject({ projectId, expectedRevision: selectionRevision })
        setSelectionRevision(result.selectionRevision)
      } catch (error) {
        notify(safeMessage(error, "切换项目失败"), "error")
        return
      }
    } else {
      setSelectionRevision((value) => value + 1)
    }
    setActiveProjectId(projectId)
    setSnapshot(null)
  }

  const focusProjectFromKey = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const lastIndex = projects.length - 1
    const nextIndex = event.key === "ArrowRight" || event.key === "ArrowDown"
      ? Math.min(lastIndex, index + 1)
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? Math.max(0, index - 1)
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? lastIndex
            : null
    if (nextIndex == null || nextIndex === index) return
    event.preventDefault()
    projectButtonRefs.current.get(projects[nextIndex].projectId)?.focus()
  }

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

  const createProject = async () => {
    if (!newProjectName.trim()) return
    setBusyAction("create-project")
    try {
      const created = await controlAdapter.createProject({ displayName: newProjectName })
      setNewProjectOpen(false)
      setNewProjectName("")
      await refreshProjects()
      await selectProject(created.projectId)
      notify(`项目“${created.displayName}”已创建`)
    } catch (error) {
      notify(safeMessage(error, "新建项目失败"), "error")
    } finally {
      setBusyAction(null)
    }
  }

  const renameCurrentProject = async () => {
    if (!activeProject || !renameProjectName.trim()) return
    setBusyAction("rename-project")
    try {
      const renamed = await controlAdapter.renameProject({ projectId: activeProject.projectId, displayName: renameProjectName })
      setProjects((items) => items.map((project) => project.projectId === renamed.projectId
        ? { ...project, displayName: renamed.displayName }
        : project))
      setRenameProjectOpen(false)
      notify(`当前项目已重命名为“${renamed.displayName}”`)
    } catch (error) {
      notify(safeMessage(error, "项目重命名失败"), "error")
    } finally {
      setBusyAction(null)
    }
  }

  const deleteCurrentProject = async () => {
    if (!activeProject) return
    if (activeAgentChat?.status === "running") {
      notify("请先停止当前项目的 Agent 对话，再删除项目", "warning")
      return
    }
    const projectId = activeProject.projectId
    const projectName = activeProject.displayName
    setBusyAction("delete-project")
    try {
      await controlAdapter.deleteProject({ projectId })
      const remaining = projects.filter((project) => project.projectId !== projectId)
      setProjects(remaining)
      setTasks((items) => {
        const next = { ...items }
        delete next[projectId]
        return next
      })
      setStageElapsedSeconds((items) => {
        const next = { ...items }
        delete next[projectId]
        return next
      })
      setActiveProjectId((current) => current === projectId ? remaining[0]?.projectId ?? null : current)
      setSnapshot(null)
      setDeleteProjectOpen(false)
      notify(`项目“${projectName}”已删除`, "warning")
      void refreshProjects(true)
    } catch (error) {
      notify(safeMessage(error, "项目删除失败"), "error")
    } finally {
      setBusyAction(null)
    }
  }

  const createProjectFromScreenplay = async (file: File) => {
    setBusyAction("screenplay-project")
    let created: JsonRecord | null = null
    let uploaded = false
    try {
      const baseName = projectNameFromScreenplay(file.name)
      for (let attempt = 1; attempt <= 99; attempt += 1) {
        const displayName = attempt === 1 ? baseName : `${baseName.slice(0, 75)} (${attempt})`
        try {
          created = await controlAdapter.createProject({ displayName })
          break
        } catch (error) {
          if ((error as JsonRecord)?.code !== "PROJECT_EXISTS" || attempt === 99) throw error
        }
      }
      if (!created) throw new Error("无法创建剧本项目")
      const result = await controlAdapter.uploadScreenplay({ projectId: created.projectId, file, overwrite: false })
      uploaded = true
      await refreshProjects()
      await selectProject(created.projectId)
      notify(`已为“${result.filename}”新建独立项目`)
    } catch (error) {
      if (created && !uploaded) {
        try { await controlAdapter.deleteProject({ projectId: created.projectId }) }
        catch { /* Keep the original import error as the user-facing failure. */ }
        void refreshProjects(true)
      }
      notify(safeMessage(error, "剧本导入或项目创建失败"), "error")
    } finally {
      setBusyAction(null)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  const watchTask = React.useCallback(async (projectId: string, task: JsonRecord) => {
    if (watchedTaskIds.current.has(task.taskId)) return
    watchedTaskIds.current.add(task.taskId)
    let current = task
    try {
      while (ACTIVE_TASK_STATUSES.has(String(current.status))) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000))
        current = await controlAdapter.getTask({ projectId, taskId: current.taskId })
        setTasks((items) => ({ ...items, [projectId]: current }))
      }
      if (current.status === "succeeded") notify("任务已完成", "good")
      else if (current.status === "paused") notify("任务已暂停，可以重新开始流水线", "warning")
      else notify(`任务执行失败：${taskFailureSummary(current)}`, "error")
      await refreshProjects(true)
    } catch (error) {
      notify(safeMessage(error, "任务状态跟踪中断，请刷新后重试"), "error")
    } finally {
      watchedTaskIds.current.delete(task.taskId)
    }
  }, [notify, refreshProjects])

  const runTask = React.useCallback(async (
    action: string,
    workbookScope: {
      workbookEpisodeStart?: number | null
      workbookEpisodeEnd?: number | null
      workbookAssetTypes?: string[]
    } = {},
  ) => {
    if (!activeProjectId || ACTIVE_TASK_STATUSES.has(String(activeTask?.status))) return false
    setBusyAction(action)
    try {
      const savedProjectTiming = loadedStageTimingProjectIds.current.has(activeProjectId)
        ? stageElapsedSeconds[activeProjectId] ?? {}
        : await loadStageTimings(activeProjectId)
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
        setStageElapsedSeconds((items) => ({ ...items, [activeProjectId]: {} }))
      }
      setTasks((items) => ({ ...items, [activeProjectId]: task }))
      notify("任务已进入当前项目的独立队列")
      void watchTask(activeProjectId, task)
      return true
    } catch (error) {
      notify(safeMessage(error, "任务启动失败"), "error")
      return false
    } finally {
      setBusyAction(null)
    }
  }, [activeProject?.statusSummary?.phase, activeProjectId, activeTask?.status, loadStageTimings, notify, snapshot?.pipeline?.phase, stageElapsedSeconds, watchTask])

  const pauseCurrentTask = React.useCallback(async () => {
    if (!activeProjectId || !activeTask?.taskId || !["queued", "running"].includes(activeTask.status)) return false
    setBusyAction("pause-task")
    try {
      const paused = await controlAdapter.pauseTask({ projectId: activeProjectId, taskId: activeTask.taskId })
      setTasks((items) => ({ ...items, [activeProjectId]: paused }))
      setTaskLogOpen(false)
      notify("暂停请求已发送，后台执行进程正在停止", "warning")
      void watchTask(activeProjectId, paused)
      await refreshProjects(true)
      return true
    } catch (error) {
      notify(safeMessage(error, "暂停任务失败"), "error")
      return false
    } finally {
      setBusyAction(null)
    }
  }, [activeProjectId, activeTask, notify, refreshProjects, watchTask])

  const watchAgentChat = React.useCallback(async (projectId: string, session: JsonRecord) => {
    const sessionId = String(session.sessionId ?? "")
    if (!sessionId || watchedAgentChatIds.current.has(sessionId)) return
    watchedAgentChatIds.current.add(sessionId)
    let current = session
    try {
      while (current.status === "running") {
        await new Promise((resolve) => window.setTimeout(resolve, 650))
        current = await codexAgentChatAdapter.getSession({ projectId, sessionId })
        setAgentChatSessions((items) => ({ ...items, [projectId]: current }))
      }
      if (current.status === "failed") notify(current.error || "Agent 对话失败", "error")
    } catch (error) {
      notify(safeMessage(error, "Agent 对话状态跟踪中断"), "error")
    } finally {
      watchedAgentChatIds.current.delete(sessionId)
    }
  }, [notify])

  const sendAgentChatMessage = React.useCallback(async () => {
    if (!activeProjectId || !codexConnected || activeAgentChat?.status === "running") return
    const message = activeAgentChatDraft.trim()
    if (!message) return
    try {
      const session = await codexAgentChatAdapter.sendMessage({
        projectId: activeProjectId,
        sessionId: activeAgentChat?.sessionId ?? null,
        message,
      })
      setAgentChatSessions((items) => ({ ...items, [activeProjectId]: session }))
      setAgentChatDrafts((items) => ({ ...items, [activeProjectId]: "" }))
      setCodexRuntimeConfig(session.runtimeConfig)
      void watchAgentChat(activeProjectId, session)
    } catch (error) {
      notify(safeMessage(error, "Agent 消息发送失败"), "error")
    }
  }, [activeAgentChat, activeAgentChatDraft, activeProjectId, codexConnected, notify, watchAgentChat])

  const cancelAgentChat = React.useCallback(async () => {
    if (!activeProjectId || !activeAgentChat?.sessionId || activeAgentChat.status !== "running") return
    try {
      const session = await codexAgentChatAdapter.cancelSession({
        projectId: activeProjectId,
        sessionId: activeAgentChat.sessionId,
      })
      setAgentChatSessions((items) => ({ ...items, [activeProjectId]: session }))
    } catch (error) {
      notify(safeMessage(error, "Agent 对话停止失败"), "error")
    }
  }, [activeAgentChat, activeProjectId, notify])

  const newAgentConversation = React.useCallback(() => {
    if (!activeProjectId || activeAgentChat?.status === "running") return
    setAgentChatSessions((items) => {
      const next = { ...items }
      delete next[activeProjectId]
      return next
    })
    setAgentChatDrafts((items) => ({ ...items, [activeProjectId]: "" }))
  }, [activeAgentChat?.status, activeProjectId])

  const updateCodexRuntimeConfig = React.useCallback(async (next: { model: string; reasoningEffort: string }) => {
    if (codexRuntimeConfigSaving || activeProjectHasRunningTask || activeAgentChat?.status === "running") return
    setCodexRuntimeConfigSaving(true)
    try {
      const updated = await codexAgentChatAdapter.updateRuntimeConfig(next)
      setCodexRuntimeConfig(updated)
      if (activeProjectId) {
        setAgentChatSessions((items) => {
          const nextSessions = { ...items }
          delete nextSessions[activeProjectId]
          return nextSessions
        })
      }
      notify("Codex 模型配置已保存；新对话和新任务将使用此配置")
    } catch (error) {
      notify(safeMessage(error, "Codex 模型配置保存失败"), "error")
    } finally {
      setCodexRuntimeConfigSaving(false)
    }
  }, [activeAgentChat?.status, activeProjectHasRunningTask, activeProjectId, codexRuntimeConfigSaving, notify])

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
    if (completed) setConfirmedAgentProposalIds((items) => [...items, messageId].slice(-256))
  }, [activeProjectHasRunningTask, confirmedAgentProposalIds, notify, pauseCurrentTask, refreshProjects, runTask])

  React.useEffect(() => {
    if (!activeProjectId || loadedStageTimingProjectIds.current.has(activeProjectId)) return
    let cancelled = false
    void loadStageTimings(activeProjectId).catch((error) => {
      if (!cancelled) notify(safeMessage(error, "阶段用时读取失败"), "warning")
    })
    return () => { cancelled = true }
  }, [activeProjectId, loadStageTimings, notify])

  React.useEffect(() => {
    if (!activeProjectId) return
    let cancelled = false
    void controlAdapter.listTasks({ projectId: activeProjectId }).then(({ tasks: projectTasks }) => {
      if (cancelled) return
      const latest = projectTasks.at(-1) ?? null
      setTasks((items) => {
        const next = { ...items }
        if (latest) next[activeProjectId] = latest
        else delete next[activeProjectId]
        return next
      })
      if (latest && ACTIVE_TASK_STATUSES.has(String(latest.status))) void watchTask(activeProjectId, latest)
    }).catch((error) => {
      if (!cancelled) notify(safeMessage(error, "任务历史恢复失败"), "warning")
    })
    return () => { cancelled = true }
  }, [activeProjectId, notify, watchTask])

  const copyTaskLog = React.useCallback(async () => {
    const text = String(activeTask?.log?.text ?? "")
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      notify("任务日志已复制")
    } catch (error) {
      notify(safeMessage(error, "任务日志复制失败"), "warning")
    }
  }, [activeTask?.log?.text, notify])

  const openDirectory = async (kind: "project" | "output") => {
    if (!activeProjectId) return
    try {
      await workspaceAdapter.openProjectDirectory({ projectId: activeProjectId, kind })
      notify(kind === "project" ? "项目文件夹已打开" : "输出文件夹已打开")
    } catch (error) {
      notify(safeMessage(error, "目录打开失败"), "warning")
    }
  }

  const refreshActiveProjectState = React.useCallback(async () => {
    const projectId = activeProjectId
    await refreshProjects(true)
    if (!projectId) return
    try {
      const result = await workspaceAdapter.getSnapshot({ projectId, selectionRevision })
      setSnapshot(result.snapshot)
    } catch (error) {
      notify(safeMessage(error, "人工确认后的项目状态刷新失败"), "warning")
    }
  }, [activeProjectId, notify, refreshProjects, selectionRevision])

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
  const rawPipelinePhase = snapshot?.pipeline?.phase ?? summary.phase ?? "split"
  const startTaskAction = pendingAssetCount === 0 && rawPipelinePhase === "asset-visual-specs"
    ? "finalize-after-confirmation"
    : "run-full-pipeline"
  const activeTaskStageId = activeProjectHasRunningTask
    ? activeTask?.action === "run-full-pipeline" || activeTask?.action === "build-scoped-workbook"
      ? rawPipelinePhase === "waiting-generation" || rawPipelinePhase === "complete" ? "excel" : rawPipelinePhase
      : TASK_STAGE_BY_ACTION[activeTask?.action]
    : null
  const projectStageElapsedSeconds = activeProjectId ? stageElapsedSeconds[activeProjectId] : null
  const projectElapsedSeconds = activeProjectId && loadedStageTimingProjectIds.current.has(activeProjectId)
    ? Object.values(projectStageElapsedSeconds ?? {}).reduce((total, seconds) => total + seconds, 0)
    : undefined
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
    if (!activeTaskActuallyRunning) return
    setClockNow(Date.now())
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [activeTaskActuallyRunning, activeTask?.taskId])

  React.useEffect(() => {
    if (!activeStageTiming) return
    const isSameStageStillRunning = activeTaskActuallyRunning
      && activeProjectId === activeStageTiming.projectId
      && activeTaskStageId === activeStageTiming.stageId
      && activeTask?.taskId
      && activeStageTiming.key === `${activeTask.taskId}:${activeTaskStageId}`
    if (isSameStageStillRunning) return

    const elapsedSeconds = activeStageTiming.accumulatedSeconds
      + Math.max(0, Math.floor((Date.now() - activeStageTiming.startedAt) / 1000))
    setStageElapsedSeconds((items) => ({
      ...items,
      [activeStageTiming.projectId]: {
        ...items[activeStageTiming.projectId],
        [activeStageTiming.stageId]: elapsedSeconds,
      },
    }))
  }, [activeProjectId, activeStageTiming, activeTask?.taskId, activeTaskActuallyRunning, activeTaskStageId])

  React.useEffect(() => {
    if (!activeProjectId
      || !loadedStageTimingProjectIds.current.has(activeProjectId)
      || !activeTaskActuallyRunning
      || !activeTaskStageId
      || !activeTask?.taskId) {
      setActiveStageTiming(null)
      return
    }
    const key = `${activeTask.taskId}:${activeTaskStageId}`
    setActiveStageTiming((current) => {
      const stageId = String(activeTaskStageId)
      const savedElapsedSeconds = stageElapsedSeconds[activeProjectId]?.[stageId] ?? 0
      if (current?.key === key) {
        const currentElapsedSeconds = current.accumulatedSeconds
          + Math.max(0, Math.floor((Date.now() - current.startedAt) / 1000))
        return savedElapsedSeconds > currentElapsedSeconds
          ? { ...current, startedAt: Date.now(), accumulatedSeconds: savedElapsedSeconds }
          : current
      }
      return {
        key,
        projectId: activeProjectId,
        stageId,
        startedAt: Date.now(),
        accumulatedSeconds: savedElapsedSeconds,
      }
    })
  }, [activeProjectId, activeTask?.taskId, activeTaskActuallyRunning, activeTaskStageId, stageElapsedSeconds])

  const activeStageElapsedSeconds = activeStageTiming
    ? activeStageTiming.accumulatedSeconds
      + Math.max(0, Math.floor((clockNow - activeStageTiming.startedAt) / 1000))
    : null

  React.useEffect(() => {
    if (!activeStageTiming) return
    const elapsedSeconds = activeStageTiming.accumulatedSeconds
      + Math.max(0, Math.floor((clockNow - activeStageTiming.startedAt) / 1000))
    setStageElapsedSeconds((items) => {
      if (items[activeStageTiming.projectId]?.[activeStageTiming.stageId] === elapsedSeconds) return items
      return {
        ...items,
        [activeStageTiming.projectId]: {
          ...items[activeStageTiming.projectId],
          [activeStageTiming.stageId]: elapsedSeconds,
        },
      }
    })
  }, [activeStageTiming, clockNow])

  React.useEffect(() => {
    for (const [projectId, stages] of Object.entries(stageElapsedSeconds)) {
      if (!loadedStageTimingProjectIds.current.has(projectId)) continue
      const signature = JSON.stringify(stages)
      if (savedStageTimingSignatures.current.get(projectId) === signature) continue
      savedStageTimingSignatures.current.set(projectId, signature)
      const prior = stageTimingSaveQueues.current.get(projectId) ?? Promise.resolve()
      const current = prior.catch(() => undefined)
        .then(() => saveStageTimingsWithRetry(controlAdapter, projectId, stages))
        .then(() => { stageTimingSaveWarningProjectIds.current.delete(projectId) })
        .catch((error) => {
          if (savedStageTimingSignatures.current.get(projectId) === signature) {
            savedStageTimingSignatures.current.delete(projectId)
          }
          if (!stageTimingSaveWarningProjectIds.current.has(projectId)) {
            stageTimingSaveWarningProjectIds.current.add(projectId)
            notify(safeMessage(error, "阶段用时保存失败"), "warning")
          }
        })
        .finally(() => {
          if (stageTimingSaveQueues.current.get(projectId) === current) stageTimingSaveQueues.current.delete(projectId)
        })
      stageTimingSaveQueues.current.set(projectId, current)
    }
  }, [notify, stageElapsedSeconds])

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
                    authorizing={busyAction === "authorize-codex"}
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
                    onDraftChange={(value) => {
                      if (activeProjectId) setAgentChatDrafts((items) => ({ ...items, [activeProjectId]: value }))
                    }}
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
            submit: () => void deleteCurrentProject(),
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
