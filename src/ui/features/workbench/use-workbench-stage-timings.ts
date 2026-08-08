import * as React from "react"

import { saveStageTimingsWithRetry } from "@/services/stage-timing-persistence.mjs"
import {
  controlAdapter,
} from "@/features/workbench/workbench-adapters"
import {
  safeMessage,
} from "@/features/workbench/workbench-utils"
import {
  type JsonRecord,
  type ToastState,
} from "@/features/workbench/workbench-types"

type StageTimings = Record<string, number>
type StageElapsedSeconds = Record<string, StageTimings>
type ActiveStageTiming = {
  key: string
  projectId: string
  stageId: string
  startedAt: number
  accumulatedSeconds: number
}
type Notify = (message: string, tone?: ToastState["tone"]) => void

type WorkbenchStageTimingOptions = {
  activeProjectId: string | null
  activeTask: JsonRecord | null
  activeTaskActuallyRunning: boolean
  activeTaskStageId: string | null | undefined
  notify: Notify
}

export function useWorkbenchStageTimings({
  activeProjectId,
  activeTask,
  activeTaskActuallyRunning,
  activeTaskStageId,
  notify,
}: WorkbenchStageTimingOptions) {
  const [clockNow, setClockNow] = React.useState(() => Date.now())
  const [activeStageTiming, setActiveStageTiming] = React.useState<ActiveStageTiming | null>(null)
  const [stageElapsedSeconds, setStageElapsedSeconds] = React.useState<StageElapsedSeconds>({})
  const loadedProjectIds = React.useRef(new Set<string>())
  const loadPromises = React.useRef(new Map<string, Promise<StageTimings>>())
  const savedSignatures = React.useRef(new Map<string, string>())
  const saveQueues = React.useRef(new Map<string, Promise<unknown>>())
  const saveWarningProjectIds = React.useRef(new Set<string>())

  const loadStageTimings = React.useCallback((projectId: string) => {
    const existing = loadPromises.current.get(projectId)
    if (existing) return existing
    const current = controlAdapter.getStageTimings({ projectId }).then((result) => {
      const stages = { ...result.stages }
      loadedProjectIds.current.add(projectId)
      savedSignatures.current.set(projectId, JSON.stringify(stages))
      setStageElapsedSeconds((items) => ({ ...items, [projectId]: stages }))
      return stages
    }).finally(() => {
      if (loadPromises.current.get(projectId) === current) loadPromises.current.delete(projectId)
    })
    loadPromises.current.set(projectId, current)
    return current
  }, [])

  const getProjectStageTimings = React.useCallback((projectId: string) => (
    loadedProjectIds.current.has(projectId)
      ? Promise.resolve(stageElapsedSeconds[projectId] ?? {})
      : loadStageTimings(projectId)
  ), [loadStageTimings, stageElapsedSeconds])

  const resetProjectStageTimings = React.useCallback((projectId: string) => {
    setStageElapsedSeconds((items) => ({ ...items, [projectId]: {} }))
  }, [])

  const removeProjectStageTimings = React.useCallback((projectId: string) => {
    loadedProjectIds.current.delete(projectId)
    loadPromises.current.delete(projectId)
    savedSignatures.current.delete(projectId)
    saveQueues.current.delete(projectId)
    saveWarningProjectIds.current.delete(projectId)
    setStageElapsedSeconds((items) => {
      const next = { ...items }
      delete next[projectId]
      return next
    })
  }, [])

  React.useEffect(() => {
    if (!activeProjectId || loadedProjectIds.current.has(activeProjectId)) return
    let cancelled = false
    void loadStageTimings(activeProjectId).catch((error) => {
      if (!cancelled) notify(safeMessage(error, "阶段用时读取失败"), "warning")
    })
    return () => { cancelled = true }
  }, [activeProjectId, loadStageTimings, notify])

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
      || !loadedProjectIds.current.has(activeProjectId)
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
      if (!loadedProjectIds.current.has(projectId)) continue
      const signature = JSON.stringify(stages)
      if (savedSignatures.current.get(projectId) === signature) continue
      savedSignatures.current.set(projectId, signature)
      const prior = saveQueues.current.get(projectId) ?? Promise.resolve()
      const current = prior.catch(() => undefined)
        .then(() => saveStageTimingsWithRetry(controlAdapter, projectId, stages))
        .then(() => { saveWarningProjectIds.current.delete(projectId) })
        .catch((error) => {
          if (savedSignatures.current.get(projectId) === signature) savedSignatures.current.delete(projectId)
          if (!saveWarningProjectIds.current.has(projectId)) {
            saveWarningProjectIds.current.add(projectId)
            notify(safeMessage(error, "阶段用时保存失败"), "warning")
          }
        })
        .finally(() => {
          if (saveQueues.current.get(projectId) === current) saveQueues.current.delete(projectId)
        })
      saveQueues.current.set(projectId, current)
    }
  }, [notify, stageElapsedSeconds])

  const projectStageElapsedSeconds = activeProjectId ? stageElapsedSeconds[activeProjectId] : null
  const projectElapsedSeconds = activeProjectId && loadedProjectIds.current.has(activeProjectId)
    ? Object.values(projectStageElapsedSeconds ?? {}).reduce((total, seconds) => total + seconds, 0)
    : undefined

  return {
    activeStageElapsedSeconds,
    getProjectStageTimings,
    projectElapsedSeconds,
    removeProjectStageTimings,
    resetProjectStageTimings,
    stageElapsedSeconds,
  }
}
