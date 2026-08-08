import * as React from "react"

import {
  type JsonRecord,
  type ToastState,
} from "@/features/workbench/workbench-types"
import {
  catalogAdapter,
} from "@/features/workbench/workbench-adapters"
import {
  safeMessage,
} from "@/features/workbench/workbench-utils"
import {
  SHEETS,
} from "@/features/workbench/workbench-constants"

type UseBatchApiStudioOptions = {
  backend: string
  notify: (message: string, tone?: ToastState["tone"]) => void
  onBackendChange: (backend: string) => void
  projectId: string | null
  setLoading: React.Dispatch<React.SetStateAction<boolean>>
}

export function useBatchApiStudio({ backend, notify, onBackendChange, projectId, setLoading }: UseBatchApiStudioOptions) {
  const [apiPasswordVisible, setApiPasswordVisible] = React.useState(false)
  const [apiDraft, setApiDraft] = React.useState({
    baseUrl: "https://canvas.dopamine.video",
    username: "",
    password: "",
    maxWorkers: "2",
    aspectRatio: "1:1",
    imageSize: "1K",
  })
  const [apiCatalog, setApiCatalog] = React.useState<{ baseUrl: string; projects: JsonRecord[]; models: JsonRecord[] } | null>(null)
  const [apiRemoteProjectId, setApiRemoteProjectId] = React.useState("")
  const [apiModelId, setApiModelId] = React.useState("")
  const [apiOperation, setApiOperation] = React.useState<"generate" | "directory_redraw">("generate")
  const [apiSourceFolder, setApiSourceFolder] = React.useState<{ selectionToken: string; name: string } | null>(null)
  const [apiOutputFolder, setApiOutputFolder] = React.useState<{ selectionToken: string; name: string } | null>(null)
  const [apiRedrawPrompt, setApiRedrawPrompt] = React.useState("")
  const [apiPromptTemplates, setApiPromptTemplates] = React.useState<Record<string, string> | null>(null)
  const [activeApiPromptSheet, setActiveApiPromptSheet] = React.useState<string>("角色")

  React.useEffect(() => {
    setApiCatalog(null)
    setApiRemoteProjectId("")
    setApiModelId("")
  }, [apiDraft.baseUrl, apiDraft.password, apiDraft.username])

  React.useEffect(() => {
    if (backend !== "api" || apiPromptTemplates) return
    void catalogAdapter.getApiDefaultTemplates()
      .then((templates: JsonRecord) => setApiPromptTemplates(Object.fromEntries(SHEETS.map((sheet) => [sheet, String(templates[sheet] ?? "")]))))
      .catch((error: unknown) => notify(safeMessage(error, "API 提示词模板读取失败"), "error"))
  }, [apiPromptTemplates, backend, notify])

  const connectApiCatalog = async () => {
    if (!projectId) return
    const loadCatalog = window.kaDesktopBridge?.loadApiCatalog
    if (typeof loadCatalog !== "function") {
      notify("当前桌面版本没有接入无限画板登录能力", "warning")
      return
    }
    const baseUrl = apiDraft.baseUrl.trim()
    const username = apiDraft.username.trim()
    if (!baseUrl || !username || !apiDraft.password) {
      notify("请先填写服务地址、登录账号和密码", "warning")
      return
    }
    setLoading(true)
    try {
      const response = await loadCatalog({ projectId, baseUrl, username, password: apiDraft.password })
      const projects = Array.isArray(response?.data?.projects) ? response.data.projects : []
      const models = Array.isArray(response?.data?.models) ? response.data.models : []
      if (response?.ok !== true || response?.data?.projectId !== projectId || !projects.length || !models.length) {
        throw new Error(response?.error?.message || "没有读取到可用项目或生图模型")
      }
      setApiCatalog({ baseUrl: response.data.baseUrl, projects, models })
      setApiRemoteProjectId(String(projects[0].id))
      setApiModelId(String(models[0].id))
      notify(`连接成功：读取到 ${projects.length} 个项目、${models.length} 个生图模型`)
    } catch (error) {
      notify(safeMessage(error, "无限画板登录失败"), "error")
    } finally {
      setLoading(false)
    }
  }

  const chooseApiDirectory = async (purpose: "source" | "output") => {
    const chooseDirectory = window.kaDesktopBridge?.selectApiDirectory
    if (typeof chooseDirectory !== "function") {
      notify("当前桌面版本没有文件夹选择能力", "warning")
      return
    }
    try {
      const response = await chooseDirectory({ purpose })
      if (response?.ok !== true) throw new Error(response?.error?.message || "文件夹选择失败")
      if (response.data?.canceled) return
      const selected = { selectionToken: String(response.data?.selectionToken || ""), name: String(response.data?.name || "已选择文件夹") }
      if (!selected.selectionToken) throw new Error("文件夹选择结果无效")
      if (purpose === "source") setApiSourceFolder(selected)
      else setApiOutputFolder(selected)
    } catch (error) {
      notify(safeMessage(error, "文件夹选择失败"), "error")
    }
  }

  const startApiBatch = async () => {
    if (!projectId || !apiCatalog) {
      notify("请先连接账号并读取项目与模型", "warning")
      return
    }
    const startBatch = window.kaDesktopBridge?.startApiBatch
    if (typeof startBatch !== "function") {
      notify("当前桌面版本没有无限画板后台执行能力", "warning")
      return
    }
    const maxWorkers = Number.parseInt(apiDraft.maxWorkers, 10)
    if (!apiRemoteProjectId || !apiModelId) {
      notify("请选择目标项目和生图模型", "warning")
      return
    }
    if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 16) {
      notify("并发数量必须是 1–16", "warning")
      return
    }
    if (apiOperation === "directory_redraw" && (!apiSourceFolder || !apiOutputFolder || !apiRedrawPrompt.trim())) {
      notify("批量修改需要选择原图、输出文件夹并填写统一修改要求", "warning")
      return
    }
    if (apiOperation === "generate" && (!apiPromptTemplates || SHEETS.some((sheet) => !apiPromptTemplates[sheet]?.trim()))) {
      notify("五类 API 提示词模板必须全部填写", "warning")
      return
    }
    setLoading(true)
    try {
      const response = await startBatch({
        projectId,
        baseUrl: apiCatalog.baseUrl,
        username: apiDraft.username.trim(),
        password: apiDraft.password,
        remoteProjectId: apiRemoteProjectId,
        modelId: apiModelId,
        maxWorkers,
        aspectRatio: apiDraft.aspectRatio,
        imageSize: apiDraft.imageSize,
        operation: apiOperation,
        ...(apiOperation === "generate" ? { promptTemplates: apiPromptTemplates! } : {}),
        ...(apiOperation === "directory_redraw" ? {
          sourceSelectionToken: apiSourceFolder!.selectionToken,
          outputSelectionToken: apiOutputFolder!.selectionToken,
          redrawPrompt: apiRedrawPrompt.trim(),
        } : {}),
      })
      if (response?.ok !== true || response?.data?.projectId !== projectId || response?.data?.started !== true) {
        throw new Error(response?.error?.message || "任务没有成功启动")
      }
      onBackendChange("api")
      notify(apiOperation === "directory_redraw" ? "文件夹批量修改已在后台启动" : "Infinite Canvas API 批量出图已在后台启动")
    } catch (error) {
      notify(safeMessage(error, "无限画板任务启动失败"), "error")
    } finally {
      setLoading(false)
    }
  }

  return {
    activeApiPromptSheet, apiCatalog, apiDraft, apiModelId, apiOperation, apiOutputFolder,
    apiPasswordVisible, apiPromptTemplates, apiRedrawPrompt, apiRemoteProjectId, apiSourceFolder,
    chooseApiDirectory, connectApiCatalog, setActiveApiPromptSheet, setApiDraft, setApiModelId,
    setApiOperation, setApiPasswordVisible, setApiPromptTemplates, setApiRedrawPrompt,
    setApiRemoteProjectId, startApiBatch,
  }
}

export type BatchApiStudio = ReturnType<typeof useBatchApiStudio>
