import * as React from "react"

import {
  controlAdapter,
  projectNameFromScreenplay,
  safeMessage,
  workspaceAdapter,
  type JsonRecord,
  type ProjectCard,
  type ToastState,
} from "@/features/workbench/workbench-foundation"

type Notify = (message: string, tone?: ToastState["tone"]) => void

type WorkbenchProjectOptions = {
  drawerOpen: boolean
  notify: Notify
  setBusyAction: React.Dispatch<React.SetStateAction<string | null>>
}

type DeleteProjectOptions = {
  agentChatRunning: boolean
  onDeleted: (projectId: string) => void
}

export function useWorkbenchProjects({ drawerOpen, notify, setBusyAction }: WorkbenchProjectOptions) {
  const [projects, setProjects] = React.useState<ProjectCard[]>([])
  const [activeProjectId, setActiveProjectId] = React.useState<string | null>(null)
  const [selectionRevision, setSelectionRevision] = React.useState(0)
  const [snapshot, setSnapshot] = React.useState<JsonRecord | null>(null)
  const [projectsLoading, setProjectsLoading] = React.useState(true)
  const [desktopHost, setDesktopHost] = React.useState(false)
  const [newProjectOpen, setNewProjectOpen] = React.useState(false)
  const [newProjectName, setNewProjectName] = React.useState("")
  const [renameProjectOpen, setRenameProjectOpen] = React.useState(false)
  const [renameProjectName, setRenameProjectName] = React.useState("")
  const [deleteProjectOpen, setDeleteProjectOpen] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const projectButtonRefs = React.useRef(new Map<string, HTMLButtonElement>())

  const activeProject = projects.find((project) => project.projectId === activeProjectId) ?? null

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

  const selectProject = React.useCallback(async (projectId: string) => {
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
  }, [activeProjectId, desktopHost, notify, selectionRevision])

  const focusProjectFromKey = React.useCallback((event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
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
  }, [projects])

  const createProject = React.useCallback(async () => {
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
  }, [newProjectName, notify, refreshProjects, selectProject, setBusyAction])

  const renameCurrentProject = React.useCallback(async () => {
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
  }, [activeProject, notify, renameProjectName, setBusyAction])

  const deleteCurrentProject = React.useCallback(async ({ agentChatRunning, onDeleted }: DeleteProjectOptions) => {
    if (!activeProject) return
    if (agentChatRunning) {
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
      onDeleted(projectId)
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
  }, [activeProject, notify, projects, refreshProjects, setBusyAction])

  const createProjectFromScreenplay = React.useCallback(async (file: File) => {
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
  }, [notify, refreshProjects, selectProject, setBusyAction])

  const openDirectory = React.useCallback(async (kind: "project" | "output") => {
    if (!activeProjectId) return
    try {
      await workspaceAdapter.openProjectDirectory({ projectId: activeProjectId, kind })
      notify(kind === "project" ? "项目文件夹已打开" : "输出文件夹已打开")
    } catch (error) {
      notify(safeMessage(error, "目录打开失败"), "warning")
    }
  }, [activeProjectId, notify])

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

  React.useEffect(() => {
    setDesktopHost(typeof window.kaDesktopBridge?.setStudioDrawerOpen === "function")
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

  return {
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
  }
}
