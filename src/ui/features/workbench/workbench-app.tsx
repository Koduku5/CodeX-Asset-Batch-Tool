import * as React from "react"
import {
  Activity,
  AlertTriangle,
  Boxes,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Database,
  FileOutput,
  FileText,
  FolderOpen,
  LoaderCircle,
  Moon,
  Network,
  PanelRightOpen,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Sparkles,
  Sun,
  Timer,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from "lucide-react"

import { useTheme } from "@/components/theme-provider"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { PendingAssetDialog } from "@/features/pending-assets/pending-asset-dialog"
import { saveStageTimingsWithRetry } from "@/services/stage-timing-persistence.mjs"

import {
  JsonRecord,
  ProjectCard,
  ToastState,
  workspaceAdapter,
  controlAdapter,
  codexStatusAdapter,
  codexAgentChatAdapter,
  ASSETS,
  PHASE_LABELS,
  CURRENT_STAGE_LABELS,
  TASK_STAGE_BY_ACTION,
  STATE_LABELS,
  TASK_STATUS_LABELS,
  ACTIVE_TASK_STATUSES,
  safeMessage,
  taskFailureSummary,
  percent,
  formatCount,
  formatTime,
  formatDuration,
  projectNameFromScreenplay,
  StatusDot,
  SectionHeading,
  AgentChatCard,
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
          <header className="flex h-11 shrink-0 items-center gap-4 border-b bg-card px-4 text-[11px] text-muted-foreground">
            <div className="flex shrink-0 items-center gap-2 font-semibold text-foreground"><Boxes className="size-4 text-primary" />KA Asset Batch</div>
            <Separator orientation="vertical" className="h-5" />
            <div className="flex min-w-0 flex-1 items-center gap-5 overflow-hidden">
              <span className="flex shrink-0 items-center gap-2"><StatusDot state={summary.state} />{PHASE_LABELS[summary.phase] ?? "等待开始"}</span>
              <span className="hidden shrink-0 sm:inline">项目用时 {formatDuration(projectElapsedSeconds)}</span>
              <span className="hidden shrink-0 xl:inline">刷新 {formatTime(summary.observedAt)}</span>
              <span className="hidden shrink-0 xl:inline">提示词库 正式注册表</span>
            </div>
            <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" onClick={() => setMotionMode((value) => value === "full" ? "reduced" : "full")} aria-label={motionMode === "full" ? "减少界面动效" : "开启动效"}><Sparkles className={cn(motionMode === "reduced" && "opacity-40")} /></Button></TooltipTrigger><TooltipContent>{motionMode === "full" ? "当前：标准动效" : "当前：减少动效"}</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")} aria-label="切换主题">{resolvedTheme === "dark" ? <Sun /> : <Moon />}</Button></TooltipTrigger><TooltipContent>切换明暗主题</TooltipContent></Tooltip>
          </header>

          <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-6xl space-y-4 p-4 sm:p-5">
              <header className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <Card className={cn(
                    "z-10 w-[320px] max-w-full shrink-0 gap-0 py-0 shadow-panel transition-colors sm:absolute sm:top-1/2 sm:right-[calc(100%+1rem)] sm:-translate-y-1/2",
                    !codexChecking && codexConnected && "border-success/70 bg-success/5",
                    !codexChecking && !codexConnected && "border-destructive/55 bg-destructive/5",
                  )}>
                    <CardContent className="flex items-center gap-1.5 px-2.5 py-3">
                      <div className="flex min-w-0 flex-1 items-center gap-1.5" aria-live="polite">
                        <span className={cn(
                          "grid size-7 shrink-0 place-items-center rounded-full border-2 bg-background",
                          codexChecking ? "border-muted-foreground/35 text-muted-foreground" : codexConnected ? "border-success text-success" : "border-destructive text-destructive",
                        )}>
                          {codexChecking ? <LoaderCircle className="size-4 animate-spin" aria-label="正在检测" /> : codexConnected ? <Check className="size-4" aria-label="已连接" /> : <X className="size-4" aria-label="未连接" />}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-[11px] font-semibold">Codex SDK 授权状态检测</p>
                          {!codexChecking && !codexConnected ? (
                            <Button className="mt-0.5 h-5 gap-1 px-1.5 text-[10px]" size="sm" onClick={() => void authorizeCodex()} disabled={busyAction === "authorize-codex"}>
                              {busyAction === "authorize-codex" ? <LoaderCircle className="size-3 animate-spin" /> : <Network className="size-3" />}
                              授权 Codex SDK
                            </Button>
                          ) : (
                            <p className={cn("mt-0.5 truncate text-[10px]", codexConnected ? "text-success" : "text-muted-foreground")}>
                              {codexChecking ? "正在检查 Codex SDK 与登录状态…" : codexStatus?.message ?? "Codex SDK 状态暂不可用"}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button className="size-7" variant="ghost" size="icon-sm" onClick={() => void checkCodexStatus()} disabled={codexChecking} aria-label={codexConnected ? "重新检测 Codex SDK" : "检测 Codex SDK 连接"}>
                              <RefreshCw className={cn(codexChecking && "animate-spin")} />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{codexConnected ? "重新检测" : "检测连接"}</TooltipContent>
                        </Tooltip>
                      </div>
                    </CardContent>
                  </Card>
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

              <Card className="gap-3 py-4 shadow-panel">
                <CardHeader className="px-4">
                  <SectionHeading
                    title="项目任务"
                    titleClassName="text-lg"
                    action={(
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => setNewProjectOpen(true)}><Plus />新建项目</Button>
                        <Button size="sm" variant="outline" onClick={() => { if (activeProject) { setRenameProjectName(activeProject.displayName); setRenameProjectOpen(true) } }} disabled={!activeProjectIsIsolated}><Pencil />重命名当前项目</Button>
                        <Button size="sm" variant="destructive" onClick={() => setDeleteProjectOpen(true)} disabled={!activeProjectIsIsolated || activeProjectHasRunningTask || activeAgentChat?.status === "running"}><Trash2 />删除当前项目</Button>
                      </div>
                    )}
                  />
                </CardHeader>
                <CardContent className="space-y-3 px-4">
                  <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_17rem]">
                    <div className="min-w-0">
                      <div className="flex gap-3 overflow-x-auto pb-1" role="listbox" aria-label="项目任务">
                        {projectsLoading && !projects.length && Array.from({ length: 3 }).map((_, index) => <div key={index} className="h-24 min-w-56 animate-pulse-soft rounded-xl bg-muted" />)}
                        {projects.map((project, index) => {
                          const selected = project.projectId === activeProjectId
                          const projectTask = tasks[project.projectId]
                          const state = ACTIVE_TASK_STATUSES.has(String(projectTask?.status))
                            ? "active"
                            : projectTask?.status === "paused" ? "warning" : project.statusSummary?.state
                          return (
                            <button key={project.projectId} ref={(node) => { if (node) projectButtonRefs.current.set(project.projectId, node); else projectButtonRefs.current.delete(project.projectId) }} type="button" role="option" aria-selected={selected} onClick={() => void selectProject(project.projectId)} onKeyDown={(event) => focusProjectFromKey(event, index)} className={cn("min-h-24 min-w-56 flex-1 rounded-xl border bg-muted/20 p-3 text-left transition-all hover:border-primary/35 hover:bg-primary/5", selected && "border-primary/45 bg-primary/8 shadow-sm")}>
                              <div className="flex items-center gap-2"><StatusDot state={state} /><span className="min-w-0 flex-1 truncate text-sm font-semibold">{project.displayName}</span>{selected && <Badge variant="info">当前</Badge>}</div>
                              <p className="mt-3 truncate text-xs text-muted-foreground">{PHASE_LABELS[project.statusSummary?.phase] ?? "等待剧本"}</p>
                              <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground"><span>{project.storageMode === "isolated-project" ? "独立项目" : "兼容项目"}</span><span>{formatCount(project.statusSummary?.assetTotal)} 项资产</span></div>
                            </button>
                          )
                        })}
                        {!projectsLoading && !projects.length && <div className="grid min-h-24 min-w-56 place-items-center rounded-xl border border-dashed px-4 text-center text-xs text-muted-foreground">拖入右侧剧本即可自动新建项目</div>}
                      </div>
                    </div>
                    <div>
                      <input ref={fileInputRef} className="sr-only" type="file" accept=".txt,.docx" aria-label="导入剧本文件" onChange={(event) => event.target.files?.[0] && void createProjectFromScreenplay(event.target.files[0])} />
                      <button type="button" disabled={busyAction === "screenplay-project"} onClick={() => fileInputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files?.[0]; if (file) void createProjectFromScreenplay(file) }} className="flex min-h-24 w-full items-center gap-3 rounded-xl border border-dashed bg-muted/15 px-4 text-left transition-colors hover:border-primary/45 hover:bg-primary/5 disabled:opacity-50">
                        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-background shadow-sm ring-1 ring-border">{busyAction === "screenplay-project" ? <LoaderCircle className="size-4 animate-spin text-primary" /> : <Upload className="size-4 text-primary" />}</span>
                        <span className="min-w-0"><span className="block text-sm font-medium">拖入 TXT / DOCX 剧本</span><span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">自动以剧本名新建独立项目</span></span>
                      </button>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <div className="flex flex-wrap justify-end gap-2 px-1" aria-label="流水线任务操作">
                <Button onClick={() => void runTask(startTaskAction)} disabled={!activeProject || activeProjectHasRunningTask || pendingAssetsReady || busyAction === startTaskAction}>
                  {busyAction === startTaskAction ? <LoaderCircle className="animate-spin" /> : <Play />}{startTaskAction === "finalize-after-confirmation" ? "继续任务" : "开始任务"}
                </Button>
                <Button variant="destructive" onClick={() => void pauseCurrentTask()} disabled={!activeProjectHasRunningTask || busyAction === "pause-task"}>
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

              {pendingAssetCount > 0 && (
                <button type="button" onClick={() => setPendingAssetDialogOpen(true)} disabled={!activeProject} className="group flex w-full flex-col gap-4 rounded-xl border border-warning/55 bg-warning/8 p-4 text-left transition-[border-color,background-color,box-shadow] hover:border-warning hover:bg-warning/12 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50 sm:flex-row sm:items-center sm:justify-between" aria-label={`打开 ${pendingAssetCount} 项待确认资产`}>
                  <div className="flex min-w-0 gap-3">
                    <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">有 {pendingAssetCount} 项资产需要人工确认</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        其他集数和世界观总览可以继续完成；确认结束后才会统一整理资产 ID、生成资产设定和 Excel。
                      </p>
                    </div>
                  </div>
                  <ChevronRight className="size-5 shrink-0 text-warning transition-transform group-hover:translate-x-1" aria-hidden="true" />
                </button>
              )}

              <section>
                <SectionHeading title="资产拆分概览" description="当前项目 Cache 中的真实数量" />
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
                  {ASSETS.map((asset) => <Card key={asset.id} className="min-h-20"><CardContent className="flex h-full items-center gap-3 p-3"><span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><Boxes className="size-4" /></span><div><p className="text-xl font-semibold tabular-nums">{formatCount(snapshot?.assetCounts?.byType?.[asset.countKey])}</p><p className="text-[11px] text-muted-foreground">{asset.label}</p></div></CardContent></Card>)}
                </div>
              </section>

              <button
                ref={batchStudioButtonRef}
                type="button"
                onClick={() => void setStudioOpen(!drawerOpen, activeProject ? "batch" : "templates")}
                disabled={Boolean(activeProject && pendingAssetCount > 0)}
                aria-expanded={drawerOpen}
                aria-controls="prompt-studio-drawer"
                aria-label={drawerOpen ? "关闭 Prompt Studio" : "打开 Prompt Studio"}
                className="group w-full overflow-hidden rounded-2xl border border-primary/35 bg-gradient-to-br from-primary/14 via-card to-card p-5 text-left shadow-panel transition-all hover:border-primary/60 hover:shadow-overlay disabled:opacity-50"
              >
                <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-4"><span className="grid size-12 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm"><WandSparkles className="size-6" /></span><div><p className="text-[10px] font-semibold tracking-[0.18em] text-primary">BATCH GENERATION</p><h2 className="mt-1 text-xl font-semibold">{drawerOpen ? "批量出图 · 关闭 Prompt Studio" : "批量出图 · 打开 Prompt Studio"}</h2><p className="mt-1 text-xs text-muted-foreground">配置风格、类别、参考图、提示词路由与出图后端</p></div></div>
                  {drawerOpen ? <X className="size-6 text-primary transition-transform group-hover:rotate-90" /> : <PanelRightOpen className="size-6 text-primary transition-transform group-hover:translate-x-1" />}
                </div>
                <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-5">
                  {[["当前批次", snapshot?.batch?.scope === "none" ? "等待配置" : "资产出图"], ["后端", snapshot?.batch?.backend || "尚未运行"], ["成功", formatCount(batchCounts.completed)], ["失败", formatCount(batchCounts.failed)], ["当前项", snapshot?.batch?.activeTask?.label || `${formatCount(batchCounts.pending)} 项待处理`]].map(([label, value]) => <div key={String(label)} className="rounded-lg border border-border/70 bg-background/55 px-3 py-2"><p className="text-[10px] text-muted-foreground">{label}</p><p className="mt-1 truncate text-xs font-medium">{value}</p></div>)}
                </div>
              </button>

              <Card className="gap-0 py-0 shadow-panel">
                <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start px-1" onClick={() => setTaskLogOpen((open) => !open)} aria-expanded={taskLogOpen} aria-controls="active-task-log">
                    {activeTask && ACTIVE_TASK_STATUSES.has(String(activeTask.status))
                      ? <LoaderCircle className="size-4 animate-spin text-primary" />
                      : activeTask?.status === "succeeded"
                        ? <CheckCircle2 className="size-4 text-success" />
                        : activeTask?.status === "paused"
                          ? <Pause className="size-4 text-warning" />
                          : activeTask?.status === "failed"
                            ? <AlertTriangle className="size-4 text-destructive" />
                            : <FileText className="size-4 text-muted-foreground" />}
                    <span className="truncate text-xs font-semibold">开发者日志</span>
                    <ChevronDown className={cn("ml-auto size-4 transition-transform", taskLogOpen && "rotate-180")} />
                  </Button>
                  <Badge variant={activeTask?.status === "succeeded" ? "success" : activeTask?.status === "failed" ? "destructive" : ["paused", "pausing"].includes(String(activeTask?.status)) ? "warning" : activeTask ? "info" : "muted"}>
                    {activeTask ? TASK_STATUS_LABELS[activeTask.status] ?? activeTask.status : "暂无任务"}
                  </Badge>
                  {taskLogOpen && <Button variant="outline" size="sm" onClick={() => void copyTaskLog()} disabled={!activeTask?.log?.text}><ClipboardCopy />复制日志</Button>}
                </div>
                {taskLogOpen && (
                  <CardContent id="active-task-log" className="space-y-2 border-t px-3 py-3">
                    {activeTask ? (
                      <>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
                          <span>任务号 {activeTask.taskId}</span>
                          <span>退出码 {activeTask.exitCode ?? "—"}</span>
                          {activeTask.log?.truncated && <span className="text-warning">早期日志已截断</span>}
                        </div>
                        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/55 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">{activeTask.log?.text || "任务已启动，等待日志…"}</pre>
                      </>
                    ) : (
                      <p className="py-2 text-xs text-muted-foreground">暂无任务日志，开始任务后将在这里显示。</p>
                    )}
                  </CardContent>
                )}
              </Card>

              {activeTask?.status === "failed" && !dismissedFailureTaskIds.includes(String(activeTask.taskId)) && (
                <div role="alert" className="flex flex-col gap-3 rounded-xl border border-destructive/55 bg-destructive/8 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 gap-3">
                    <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-destructive">流水线执行失败</p>
                      <p className="mt-1 break-words text-xs text-foreground">{taskFailureSummary(activeTask)}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button variant="outline" size="sm" className="border-destructive/35" onClick={() => setTaskLogOpen(true)}>展开任务日志</Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => setDismissedFailureTaskIds((ids) => [...new Set([...ids, String(activeTask.taskId)])])} aria-label="关闭错误提示"><X /></Button>
                  </div>
                </div>
              )}

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

      <Dialog open={newProjectOpen} onOpenChange={setNewProjectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建独立项目</DialogTitle>
            <DialogDescription>软件会创建独立目录、Cache、输出、队列和锁。</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="new-project-name">项目名称</Label>
            <Input id="new-project-name" value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void createProject()} autoFocus />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewProjectOpen(false)}>取消</Button>
            <Button onClick={() => void createProject()} disabled={!newProjectName.trim() || busyAction === "create-project"}>{busyAction === "create-project" && <LoaderCircle className="animate-spin" />}创建项目</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameProjectOpen} onOpenChange={setRenameProjectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名当前项目</DialogTitle>
            <DialogDescription>只修改项目显示名称，不改变项目唯一编号、目录、Cache、输出或队列位置。</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="rename-project-name">新的项目名称</Label>
            <Input
              id="rename-project-name"
              value={renameProjectName}
              onChange={(event) => setRenameProjectName(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void renameCurrentProject()}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameProjectOpen(false)}>取消</Button>
            <Button onClick={() => void renameCurrentProject()} disabled={!renameProjectName.trim() || busyAction === "rename-project"}>
              {busyAction === "rename-project" && <LoaderCircle className="animate-spin" />}
              确认重命名
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteProjectOpen} onOpenChange={setDeleteProjectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除项目“{activeProject?.displayName ?? ""}”？</AlertDialogTitle>
            <AlertDialogDescription>
              这会永久删除该项目的独立目录，以及其中的剧本、Cache、输出和队列。此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyAction === "delete-project"}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => { event.preventDefault(); void deleteCurrentProject() }}
              disabled={!activeProjectIsIsolated || activeProjectHasRunningTask || busyAction === "delete-project"}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busyAction === "delete-project" && <LoaderCircle className="animate-spin" />}
              永久删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
