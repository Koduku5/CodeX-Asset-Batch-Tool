import * as React from "react"

import {
  codexAgentChatAdapter,
  codexStatusAdapter,
} from "@/features/workbench/workbench-adapters"
import {
  safeMessage,
} from "@/features/workbench/workbench-utils"
import {
  type JsonRecord,
  type ToastState,
} from "@/features/workbench/workbench-types"

type Notify = (message: string, tone?: ToastState["tone"]) => void

type WorkbenchCodexOptions = {
  activeProjectHasRunningTask: boolean
  activeProjectId: string | null
  notify: Notify
}

export function useWorkbenchCodex({
  activeProjectHasRunningTask,
  activeProjectId,
  notify,
}: WorkbenchCodexOptions) {
  const [codexStatus, setCodexStatus] = React.useState<JsonRecord | null>(null)
  const [codexChecking, setCodexChecking] = React.useState(true)
  const [codexAuthorizing, setCodexAuthorizing] = React.useState(false)
  const [runtimeConfig, setRuntimeConfig] = React.useState<JsonRecord | null>(null)
  const [runtimeConfigSaving, setRuntimeConfigSaving] = React.useState(false)
  const [sessions, setSessions] = React.useState<Record<string, JsonRecord>>({})
  const [drafts, setDrafts] = React.useState<Record<string, string>>({})
  const [confirmedProposalIds, setConfirmedProposalIds] = React.useState<string[]>([])
  const watchedSessionIds = React.useRef(new Set<string>())

  const connected = codexStatus?.connected === true
  const activeSession = activeProjectId ? sessions[activeProjectId] ?? null : null
  const activeDraft = activeProjectId ? drafts[activeProjectId] ?? "" : ""
  const runtimeConfigLocked = activeProjectHasRunningTask || activeSession?.status === "running"

  const checkStatus = React.useCallback(async ({ quiet = false } = {}) => {
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

  const refreshRuntimeConfig = React.useCallback(async () => {
    try {
      setRuntimeConfig(await codexAgentChatAdapter.getRuntimeConfig())
    } catch {
      setRuntimeConfig(null)
    }
  }, [])

  const authorize = React.useCallback(async () => {
    setCodexAuthorizing(true)
    setCodexChecking(true)
    try {
      const login = await codexStatusAdapter.startLogin()
      if (!login.alreadyConnected) notify("已打开内置 Codex CLI 登录，请在浏览器中完成授权", "warning")
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, 1500))
        const status = await codexStatusAdapter.getStatus()
        setCodexStatus(status)
        if (status.connected) {
          void refreshRuntimeConfig()
          notify(login.alreadyConnected ? "Codex SDK 授权有效" : "Codex 登录成功，后续启动将复用本机登录状态", "good")
          return
        }
      }
      notify("尚未完成 Codex 登录；完成浏览器授权后可点击重新检测", "warning")
    } catch (error) {
      notify(safeMessage(error, "内置 Codex CLI 登录启动失败"), "error")
    } finally {
      setCodexChecking(false)
      setCodexAuthorizing(false)
    }
  }, [notify, refreshRuntimeConfig])

  const watchSession = React.useCallback(async (projectId: string, session: JsonRecord) => {
    const sessionId = String(session.sessionId ?? "")
    if (!sessionId || watchedSessionIds.current.has(sessionId)) return
    watchedSessionIds.current.add(sessionId)
    let current = session
    try {
      while (current.status === "running") {
        await new Promise((resolve) => window.setTimeout(resolve, 650))
        current = await codexAgentChatAdapter.getSession({ projectId, sessionId })
        setSessions((items) => ({ ...items, [projectId]: current }))
      }
      if (current.status === "failed") notify(current.error || "Agent 对话失败", "error")
    } catch (error) {
      notify(safeMessage(error, "Agent 对话状态跟踪中断"), "error")
    } finally {
      watchedSessionIds.current.delete(sessionId)
    }
  }, [notify])

  const sendMessage = React.useCallback(async () => {
    if (!activeProjectId || !connected || activeSession?.status === "running") return
    const message = activeDraft.trim()
    if (!message) return
    try {
      const session = await codexAgentChatAdapter.sendMessage({
        projectId: activeProjectId,
        sessionId: activeSession?.sessionId ?? null,
        message,
      })
      setSessions((items) => ({ ...items, [activeProjectId]: session }))
      setDrafts((items) => ({ ...items, [activeProjectId]: "" }))
      setRuntimeConfig(session.runtimeConfig)
      void watchSession(activeProjectId, session)
    } catch (error) {
      notify(safeMessage(error, "Agent 消息发送失败"), "error")
    }
  }, [activeDraft, activeProjectId, activeSession, connected, notify, watchSession])

  const cancelSession = React.useCallback(async () => {
    if (!activeProjectId || !activeSession?.sessionId || activeSession.status !== "running") return
    try {
      const session = await codexAgentChatAdapter.cancelSession({
        projectId: activeProjectId,
        sessionId: activeSession.sessionId,
      })
      setSessions((items) => ({ ...items, [activeProjectId]: session }))
    } catch (error) {
      notify(safeMessage(error, "Agent 对话停止失败"), "error")
    }
  }, [activeProjectId, activeSession, notify])

  const newConversation = React.useCallback(() => {
    if (!activeProjectId || activeSession?.status === "running") return
    setSessions((items) => {
      const next = { ...items }
      delete next[activeProjectId]
      return next
    })
    setDrafts((items) => ({ ...items, [activeProjectId]: "" }))
  }, [activeProjectId, activeSession?.status])

  const updateRuntimeConfig = React.useCallback(async (next: { model: string; reasoningEffort: string }) => {
    if (runtimeConfigSaving || activeProjectHasRunningTask || activeSession?.status === "running") return
    setRuntimeConfigSaving(true)
    try {
      const updated = await codexAgentChatAdapter.updateRuntimeConfig(next)
      setRuntimeConfig(updated)
      if (activeProjectId) {
        setSessions((items) => {
          const nextSessions = { ...items }
          delete nextSessions[activeProjectId]
          return nextSessions
        })
      }
      notify("Codex 模型配置已保存；新对话和新任务将使用此配置")
    } catch (error) {
      notify(safeMessage(error, "Codex 模型配置保存失败"), "error")
    } finally {
      setRuntimeConfigSaving(false)
    }
  }, [activeProjectHasRunningTask, activeProjectId, activeSession?.status, notify, runtimeConfigSaving])

  const setActiveDraft = React.useCallback((value: string) => {
    if (activeProjectId) setDrafts((items) => ({ ...items, [activeProjectId]: value }))
  }, [activeProjectId])

  const markProposalConfirmed = React.useCallback((messageId: string) => {
    setConfirmedProposalIds((items) => [...items, messageId].slice(-256))
  }, [])

  return {
    activeDraft,
    activeSession,
    authorize,
    cancelSession,
    checkStatus,
    codexAuthorizing,
    codexChecking,
    codexStatus,
    confirmedProposalIds,
    connected,
    markProposalConfirmed,
    newConversation,
    refreshRuntimeConfig,
    runtimeConfig,
    runtimeConfigLocked,
    runtimeConfigSaving,
    sendMessage,
    setActiveDraft,
    updateRuntimeConfig,
  }
}
