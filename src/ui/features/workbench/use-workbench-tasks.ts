import * as React from "react"

import {
  ACTIVE_TASK_STATUSES,
} from "@/features/workbench/workbench-constants"
import {
  controlAdapter,
} from "@/features/workbench/workbench-adapters"
import {
  safeMessage,
  taskFailureSummary,
} from "@/features/workbench/workbench-utils"
import {
  type JsonRecord,
  type ToastState,
} from "@/features/workbench/workbench-types"

type Notify = (message: string, tone?: ToastState["tone"]) => void

type WorkbenchTaskOptions = {
  activeProjectId: string | null
  notify: Notify
  refreshProjects: (quiet?: boolean) => Promise<void>
  setBusyAction: React.Dispatch<React.SetStateAction<string | null>>
}

export function useWorkbenchTasks({
  activeProjectId,
  notify,
  refreshProjects,
  setBusyAction,
}: WorkbenchTaskOptions) {
  const [tasks, setTasks] = React.useState<Record<string, JsonRecord>>({})
  const [taskLogOpen, setTaskLogOpen] = React.useState(false)
  const [dismissedFailureTaskIds, setDismissedFailureTaskIds] = React.useState<string[]>([])
  const watchedTaskIds = React.useRef(new Set<string>())

  const activeTask = activeProjectId ? tasks[activeProjectId] ?? null : null
  const activeProjectHasRunningTask = ACTIVE_TASK_STATUSES.has(String(activeTask?.status))
  const activeTaskActuallyRunning = ["running", "pausing"].includes(String(activeTask?.status))
    && Number.isFinite(Date.parse(String(activeTask?.startedAt ?? "")))

  const recordProjectTask = React.useCallback((projectId: string, task: JsonRecord) => {
    setTasks((items) => ({ ...items, [projectId]: task }))
  }, [])

  const removeProjectTask = React.useCallback((projectId: string) => {
    setTasks((items) => {
      const next = { ...items }
      delete next[projectId]
      return next
    })
  }, [])

  const watchTask = React.useCallback(async (projectId: string, task: JsonRecord) => {
    if (watchedTaskIds.current.has(task.taskId)) return
    watchedTaskIds.current.add(task.taskId)
    let current = task
    try {
      while (ACTIVE_TASK_STATUSES.has(String(current.status))) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000))
        current = await controlAdapter.getTask({ projectId, taskId: current.taskId })
        recordProjectTask(projectId, current)
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
  }, [notify, recordProjectTask, refreshProjects])

  const pauseCurrentTask = React.useCallback(async () => {
    if (!activeProjectId || !activeTask?.taskId || !["queued", "running"].includes(activeTask.status)) return false
    setBusyAction("pause-task")
    try {
      const paused = await controlAdapter.pauseTask({ projectId: activeProjectId, taskId: activeTask.taskId })
      recordProjectTask(activeProjectId, paused)
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
  }, [activeProjectId, activeTask, notify, recordProjectTask, refreshProjects, setBusyAction, watchTask])

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

  React.useEffect(() => {
    setTaskLogOpen(false)
  }, [activeTask?.taskId])

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

  return {
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
  }
}
