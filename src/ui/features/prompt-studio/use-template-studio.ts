import * as React from "react"

import {
  normalizeTemplateFieldOrder,
  reorderTemplateFields,
  templateFieldReorderIsLocked,
} from "@/features/prompt-studio/template-field-order.mjs"
import { readTemplateDraft, withTemplateDraft } from "@/features/prompt-studio/template-drafts.mjs"
import {
  catalogAdapter,
} from "@/features/workbench/workbench-adapters"
import {
  JsonRecord,
  ToastState,
} from "@/features/workbench/workbench-types"
import {
  nowIso,
  safeMessage,
} from "@/features/workbench/workbench-utils"
import {
  usePromptPresets,
} from "@/features/prompt-studio/prompt-preset-store"

type Notify = (message: string, tone?: ToastState["tone"]) => void

export function useTemplateStudio(notify: Notify) {
  const { activePreset, setPresets } = usePromptPresets()
  const [style, setStyle] = React.useState("anime")
  const [asset, setAsset] = React.useState("prop")
  const [referenceMode, setReferenceMode] = React.useState("none")
  const [result, setResult] = React.useState<JsonRecord | null>(null)
  const [draftFields, setDraftFields] = React.useState<JsonRecord[]>([])
  const [hasSavedDraft, setHasSavedDraft] = React.useState(false)
  const [hasUnsavedChanges, setHasUnsavedChanges] = React.useState(false)
  const [loading, setLoading] = React.useState(false)

  const formalFieldLabels = new Set((Array.isArray(result?.promptFields) ? result.promptFields : []).map((field: JsonRecord) => String(field.label)))
  const customFieldCount = draftFields.filter((field) => !formalFieldLabels.has(String(field.label))).length

  const resolve = React.useCallback(async () => {
    setLoading(true)
    try {
      const resolved = await catalogAdapter.resolve({ style, asset, referenceMode, referenceCount: referenceMode === "visual-consistency" ? 2 : referenceMode === "none" ? 0 : 1 })
      const saved = readTemplateDraft(activePreset?.templates, style, asset, referenceMode)
      setResult(resolved)
      setDraftFields(normalizeTemplateFieldOrder(resolved.promptFields, saved?.promptFields))
      setHasSavedDraft(Boolean(saved))
      setHasUnsavedChanges(false)
    } catch (error) { notify(safeMessage(error, "基础模板读取失败"), "error") }
    finally { setLoading(false) }
  }, [activePreset?.id, asset, notify, referenceMode, style])

  React.useEffect(() => { const timer = window.setTimeout(() => void resolve(), 180); return () => window.clearTimeout(timer) }, [resolve])

  const saveDraft = () => {
    if (!activePreset || !result || !draftFields.length) return
    const templates = withTemplateDraft(activePreset.templates, style, asset, referenceMode, draftFields)
    setPresets((items) => items.map((preset) => preset.id === activePreset.id ? {
      ...preset,
      revision: preset.revision + 1,
      updatedAt: nowIso(),
      templates,
    } : preset))
    setHasSavedDraft(true)
    setHasUnsavedChanges(false)
    notify(`基础提示词草稿已保存到预设“${activePreset.name}”；保存批次时会写入对应资产类别`)
  }

  const restoreFormal = () => {
    if (!result) return
    setDraftFields(normalizeTemplateFieldOrder(result.promptFields, result.promptFields))
    setHasUnsavedChanges(true)
    notify("已恢复为正式注册表解析值；点击“保留当前草稿”后才会覆盖已保存草稿")
  }

  const addCustomField = (label: string, value: string) => {
    setDraftFields((items) => [...items, { label, value }])
    setHasUnsavedChanges(true)
    notify(`已添加自定义字段“${label}”；保留当前草稿后才会写入预设`)
  }

  const removeCustomField = (index: number) => {
    const label = String(draftFields[index]?.label || "")
    if (!label || formalFieldLabels.has(label)) return
    setDraftFields((items) => items.filter((_, itemIndex) => itemIndex !== index))
    setHasUnsavedChanges(true)
    notify(`已移除自定义字段“${label}”；保留当前草稿后才会更新预设`)
  }

  const reorderField = (fromIndex: number, toIndex: number) => {
    if (reorderTemplateFields(draftFields, fromIndex, toIndex) === draftFields) return
    setDraftFields((items) => reorderTemplateFields(items, fromIndex, toIndex))
    setHasUnsavedChanges(true)
  }

  const updateField = (index: number, value: string) => {
    setDraftFields((items) => items.map((entry, itemIndex) => itemIndex === index ? { ...entry, value } : entry))
    setHasUnsavedChanges(true)
  }

  return {
    addCustomField, asset, customFieldCount, draftFields, formalFieldLabels,
    hasSavedDraft, hasUnsavedChanges, isReorderLocked: templateFieldReorderIsLocked,
    loading, referenceMode, removeCustomField, reorderField, restoreFormal, result,
    saveDraft, setAsset, setReferenceMode, setStyle, style, updateField,
  }
}
