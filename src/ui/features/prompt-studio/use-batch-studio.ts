import * as React from "react"

import { buildBuiltinBatchConfiguration } from "@/features/prompt-studio/batch-configuration.mjs"
import { useBatchApiStudio } from "@/features/prompt-studio/use-batch-api-studio"
import {
  ASSETS,
  JsonRecord,
  SHEETS,
  ToastState,
  batchAdapter,
  blankCustomReferenceFields,
  blankReferenceModes,
  blankReferenceSelections,
  catalogAdapter,
  imagegenAdapter,
  readBatchCustomFields,
  safeMessage,
  usePromptPresets,
  writeBatchCustomFields,
} from "@/features/workbench/workbench-foundation"

type UseBatchStudioOptions = {
  notify: (message: string, tone?: ToastState["tone"]) => void
  projectId: string | null
  runTask: (action: string) => Promise<boolean>
}

export function useBatchStudio({ notify, projectId, runTask }: UseBatchStudioOptions) {
  const { activePreset } = usePromptPresets()
  const [style, setStyle] = React.useState("anime")
  const [backend, setBackend] = React.useState("builtin")
  const [generationLimit, setGenerationLimit] = React.useState("5")
  const [enabledSheets, setEnabledSheets] = React.useState<string[]>([...SHEETS])
  const [activeSheet, setActiveSheet] = React.useState<string>("角色")
  const [referenceModeBySheet, setReferenceModeBySheet] = React.useState<Record<string, string>>(blankReferenceModes)
  const [references, setReferences] = React.useState<JsonRecord[]>([])
  const [selectedReferenceIdsBySheet, setSelectedReferenceIdsBySheet] = React.useState<Record<string, string[]>>(blankReferenceSelections)
  const [customFieldsBySheet, setCustomFieldsBySheet] = React.useState<JsonRecord>(blankCustomReferenceFields)
  const [previewReferenceId, setPreviewReferenceId] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [handoff, setHandoff] = React.useState<JsonRecord | null>(null)
  const uploadRef = React.useRef<HTMLInputElement>(null)
  const uploadInFlightRef = React.useRef(false)
  const uploadContextRef = React.useRef({ projectId, style, activeSheet })
  const apiStudio = useBatchApiStudio({ backend, notify, onBackendChange: setBackend, projectId, setLoading })

  React.useEffect(() => {
    uploadContextRef.current = { projectId, style, activeSheet }
  }, [activeSheet, projectId, style])

  const reloadReferences = React.useCallback(async () => {
    if (!projectId) return
    try {
      setReferences(await batchAdapter.listReferences({ projectId }))
    } catch (error) {
      notify(safeMessage(error, "参考图读取失败"), "error")
    }
  }, [notify, projectId])

  const reloadHandoff = React.useCallback(async () => {
    if (!projectId) return
    try { setHandoff(await imagegenAdapter.getStatus({ projectId })) }
    catch { setHandoff(null) }
  }, [projectId])

  const reloadSavedBatch = React.useCallback(async () => {
    if (!projectId) return
    try {
      const saved = await batchAdapter.getBuiltinBatch({ projectId })
      if (!saved) return
      setStyle(saved.styleId)
      setGenerationLimit(String(saved.generationLimit))
      setEnabledSheets(saved.enabledSheets)
      const restoredSelections = { ...blankReferenceSelections(), ...(saved.selectedReferenceIdsBySheet ?? {}) }
      setSelectedReferenceIdsBySheet(restoredSelections)
      setReferenceModeBySheet(Object.fromEntries(SHEETS.map((sheet) => [
        sheet,
        restoredSelections[sheet]?.length
          ? String(saved.referenceModeBySheet[sheet] ?? "style").replaceAll("_", "-")
          : "none",
      ])))
      setCustomFieldsBySheet(readBatchCustomFields(projectId, saved.styleId))
    } catch (error) {
      notify(safeMessage(error, "已保存的批次配置读取失败"), "warning")
    }
  }, [notify, projectId])

  React.useEffect(() => {
    setSelectedReferenceIdsBySheet(blankReferenceSelections())
    setReferenceModeBySheet(blankReferenceModes())
    setCustomFieldsBySheet(readBatchCustomFields(projectId, style))
    setPreviewReferenceId(null)
    void reloadReferences()
    void reloadHandoff()
  }, [projectId, reloadHandoff, reloadReferences])
  React.useEffect(() => { void reloadSavedBatch() }, [reloadSavedBatch])
  React.useEffect(() => {
    if (projectId) writeBatchCustomFields(projectId, style, customFieldsBySheet)
  }, [customFieldsBySheet, projectId, style])

  const visibleReferences = references.filter((entry) => entry.styleId === style && entry.sheetName === activeSheet)
  const selectedReferenceIds = selectedReferenceIdsBySheet[activeSheet] ?? []
  const activePreviewReference = visibleReferences.find((entry) => entry.referenceId === previewReferenceId)
    ?? visibleReferences.find((entry) => selectedReferenceIds.includes(entry.referenceId))
    ?? visibleReferences[0]
    ?? null

  const changeStyle = (value: string) => {
    setStyle(value)
    setSelectedReferenceIdsBySheet(blankReferenceSelections())
    setReferenceModeBySheet(blankReferenceModes())
    setCustomFieldsBySheet(readBatchCustomFields(projectId, value))
    setPreviewReferenceId(null)
  }
  const changeReferenceMode = (value: string) => {
    setReferenceModeBySheet((current) => ({ ...current, [activeSheet]: value }))
    if (value === "none") setSelectedReferenceIdsBySheet((current) => ({ ...current, [activeSheet]: [] }))
  }
  const toggleSheet = (sheet: string, checked: boolean) => {
    setEnabledSheets((current) => checked ? SHEETS.filter((item) => current.includes(item) || item === sheet) : current.filter((item) => item !== sheet))
  }
  const toggleReferenceSelection = (referenceId: string, checked: boolean) => {
    const nextIds = checked
      ? [...new Set([...selectedReferenceIds, referenceId])]
      : selectedReferenceIds.filter((id) => id !== referenceId)
    setSelectedReferenceIdsBySheet((current) => ({ ...current, [activeSheet]: nextIds }))
    if (checked && referenceModeBySheet[activeSheet] === "none") {
      setReferenceModeBySheet((current) => ({ ...current, [activeSheet]: "style" }))
    } else if (!nextIds.length) {
      setReferenceModeBySheet((current) => ({ ...current, [activeSheet]: "none" }))
    }
    if (checked) setPreviewReferenceId(referenceId)
  }

  const uploadReferences = async (files: FileList | File[]) => {
    const pendingFiles = Array.from(files)
    if (!projectId || !pendingFiles.length) return
    if (uploadInFlightRef.current) {
      notify("上一批参考图仍在上传，请稍候", "warning")
      return
    }
    uploadInFlightRef.current = true
    const context = { projectId, style, activeSheet }
    const uploaded: JsonRecord[] = []
    const failed: { file: File; error: unknown }[] = []
    setLoading(true)
    try {
      for (const file of pendingFiles) {
        try {
          uploaded.push(await batchAdapter.uploadReference({
            projectId: context.projectId,
            styleId: context.style,
            sheetName: context.activeSheet,
            file,
          }))
        } catch (error) {
          failed.push({ file, error })
        }
      }
      const latestContext = uploadContextRef.current
      if (latestContext.projectId !== context.projectId) return
      await reloadReferences()
      if (uploaded.length && latestContext.style === context.style) {
        const uploadedIds = uploaded.map((entry) => entry.referenceId)
        setReferenceModeBySheet((current) => ({
          ...current,
          [context.activeSheet]: current[context.activeSheet] === "none" ? "style" : current[context.activeSheet],
        }))
        setSelectedReferenceIdsBySheet((current) => ({
          ...current,
          [context.activeSheet]: [...new Set([...(current[context.activeSheet] ?? []), ...uploadedIds])],
        }))
        if (latestContext.activeSheet === context.activeSheet) setPreviewReferenceId(uploaded.at(-1)!.referenceId)
      }
      if (failed.length) {
        const details = failed.slice(0, 3).map(({ file, error }) => `${file.name}（${safeMessage(error, "上传失败")}）`).join("、")
        const suffix = failed.length > 3 ? `等 ${failed.length} 张` : ""
        notify(`参考图成功 ${uploaded.length} 张，失败 ${failed.length} 张：${details}${suffix}`, uploaded.length ? "warning" : "error")
      } else {
        notify(`${pendingFiles.length} 张参考图已添加到${context.activeSheet}`)
      }
    } finally {
      uploadInFlightRef.current = false
      setLoading(false)
      if (uploadRef.current) uploadRef.current.value = ""
    }
  }

  const removeReference = async (referenceId: string) => {
    if (!projectId) return
    const removedSheet = references.find((entry) => entry.referenceId === referenceId)?.sheetName
    const removesLastSelected = Boolean(removedSheet)
      && (selectedReferenceIdsBySheet[removedSheet] ?? []).includes(referenceId)
      && (selectedReferenceIdsBySheet[removedSheet] ?? []).length === 1
    setLoading(true)
    try {
      await batchAdapter.removeReference({ projectId, referenceId })
      setSelectedReferenceIdsBySheet((current) => Object.fromEntries(Object.entries(current).map(([sheet, ids]) => [sheet, ids.filter((id) => id !== referenceId)])))
      if (removedSheet && removesLastSelected) setReferenceModeBySheet((current) => ({ ...current, [removedSheet]: "none" }))
      setPreviewReferenceId((current) => current === referenceId ? null : current)
      await reloadReferences()
      notify("参考图已删除")
    } catch (error) {
      notify(safeMessage(error, "参考图删除失败"), "error")
    } finally { setLoading(false) }
  }

  const saveBatch = async () => {
    if (!projectId || !enabledSheets.length || backend !== "builtin") return false
    setLoading(true)
    try {
      const configuration = await buildBuiltinBatchConfiguration({
        assets: ASSETS,
        customFieldsBySheet,
        enabledSheets,
        generationLimit,
        promptTemplates: activePreset?.templates,
        referenceModeBySheet,
        references,
        resolvePrompt: catalogAdapter.resolve,
        selectedReferenceIdsBySheet,
        sheets: SHEETS,
        style,
      })
      await batchAdapter.saveBuiltinBatch({ projectId, configuration })
      notify("批量出图配置已写入当前项目")
      await reloadHandoff()
      return true
    } catch (error) {
      notify(safeMessage(error, "批量配置保存失败"), "error")
      return false
    } finally { setLoading(false) }
  }

  const saveAndBuildFinalQueue = async () => {
    if (await saveBatch()) await runTask("classify-prompt-branches")
  }
  const prepareImagegen = async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const prepared = await imagegenAdapter.prepare({ projectId })
      notify(prepared.codexOpened
        ? "Codex 已打开；在任意新任务中粘贴交接指令，调度 Skill 会自动新建或复用项目出图任务"
        : "交接指令已复制；请手动打开 Codex，并在任意新任务中粘贴")
      await reloadHandoff()
    } catch (error) {
      notify(safeMessage(error, "请先建立队列，并在桌面版中执行 ImageGen 交接"), "warning")
    } finally { setLoading(false) }
  }

  const builtinStudio = {
    activePreviewReference, activeSheet, changeReferenceMode, customFieldsBySheet, enabledSheets,
    loading, prepareImagegen, projectId, referenceModeBySheet, removeReference, saveAndBuildFinalQueue,
    saveBatch, selectedReferenceIds, setActiveSheet, setCustomFieldsBySheet, setPreviewReferenceId,
    style, toggleReferenceSelection, toggleSheet, uploadRef, uploadReferences, visibleReferences,
  }

  return {
    apiStudio, backend, builtinStudio, changeStyle, generationLimit, handoff, loading,
    setBackend, setGenerationLimit, style,
  }
}

export type BatchStudioController = ReturnType<typeof useBatchStudio>
