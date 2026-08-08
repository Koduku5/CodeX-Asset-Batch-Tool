import * as React from "react"

import { useRouteClassification } from "@/features/prompt-studio/use-route-classification"
import { useRoutePresetActions } from "@/features/prompt-studio/use-route-preset-actions"
import { paginateAssets } from "@/services/list-model.mjs"
import {
  DEFAULT_CONTROL_DIMENSIONS,
  applyModuleOperationsPreview,
  createRouteBranchFile,
  normalizeRouteModule,
  validateRouteModule,
} from "@/services/route-module-workbench.mjs"
import {
  JsonRecord,
  RouteModule,
  ToastState,
} from "@/features/workbench/workbench-types"
import {
  ROUTE_LIST_PAGE_SIZE,
} from "@/features/workbench/workbench-constants"
import {
  catalogAdapter,
  routeAdminAdapter,
} from "@/features/workbench/workbench-adapters"
import {
  clone,
  downloadJson,
  nowIso,
  safeMessage,
  uniqueId,
} from "@/features/workbench/workbench-utils"
import {
  readStoredPresets,
  routeModulesFromCatalogSummary,
  usePromptPresets,
  withoutRetiredCatalogEnhancers,
} from "@/features/prompt-studio/prompt-preset-store"

type UseRouteStudioOptions = {
  notify: (message: string, tone?: ToastState["tone"]) => void
}

// Route Studio controller.
export function useRouteStudio({ notify }: UseRouteStudioOptions) {
  const { presets, setPresets, activePresetId, setActivePresetId, activePreset } = usePromptPresets()
  const [catalogStatus, setCatalogStatus] = React.useState<JsonRecord | null>(null)
  const [presetsOpen, setPresetsOpen] = React.useState(false)
  const [selectedModuleId, setSelectedModuleId] = React.useState<string | null>(null)
  const [module, setModule] = React.useState<RouteModule | null>(null)
  const [preview, setPreview] = React.useState<JsonRecord | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [deleteBranchOpen, setDeleteBranchOpen] = React.useState(false)
  const [routeFilter, setRouteFilter] = React.useState("")
  const [routePage, setRoutePage] = React.useState(0)
  const branchImportRef = React.useRef<HTMLInputElement>(null)
  const presetActions = useRoutePresetActions({
    activePreset, activePresetId, notify, presets, setActivePresetId, setModule, setPresets,
    setSelectedModuleId,
  })
  const {
    applyImportedArtifacts, createPreset, deletePreset, deletePresetId, exportOpen, exportPreset,
    exportValue, importArtifacts, newPresetOpen, newPresetValue, pendingImport, presetImportRef,
    renameOpen, renamePreset, renameValue, setDeletePresetId, setExportOpen, setExportValue,
    setNewPresetOpen, setNewPresetValue, setPendingImport, setRenameOpen, setRenameValue,
  } = presetActions

  const modules = activePreset?.modules ?? []
  const scopeFilteredModules = React.useMemo(() => {
    if (!module) return modules
    return modules.filter((entry) =>
      entry.scope.assets.some((value: string) => module.scope.assets.includes(value))
      && entry.scope.styles.some((value: string) => module.scope.styles.includes(value))
      && entry.scope.referenceModes.some((value: string) => module.scope.referenceModes.includes(value)))
  }, [module, modules])
  const filteredModules = React.useMemo(() => {
    const query = routeFilter.trim().toLocaleLowerCase("zh-CN")
    if (!query) return scopeFilteredModules
    return scopeFilteredModules.filter((entry) => `${entry.displayName} ${entry.id}`.toLocaleLowerCase("zh-CN").includes(query))
  }, [routeFilter, scopeFilteredModules])
  const routePageCount = Math.max(1, Math.ceil(filteredModules.length / ROUTE_LIST_PAGE_SIZE))
  const visibleModules = React.useMemo(
    () => paginateAssets(filteredModules, routePage, ROUTE_LIST_PAGE_SIZE),
    [filteredModules, routePage],
  )

  const refreshCatalog = React.useCallback(async () => {
    try {
      const status = await catalogAdapter.getStatus()
      setCatalogStatus(status)
      const registered = routeModulesFromCatalogSummary(status.catalogSummary)
      setPresets((current) => {
        const base = current.length ? current : readStoredPresets(registered)
        return base.map((preset) => {
          if (preset.id !== "workspace") return preset
          const retained = withoutRetiredCatalogEnhancers(preset.modules)
          const currentIds = new Set(retained.map((entry) => entry.id))
          return { ...preset, modules: [...retained, ...registered.filter((entry) => !currentIds.has(entry.id))] }
        })
      })
    } catch (error) {
      notify(safeMessage(error, "正式提示词注册表读取失败"), "error")
    }
  }, [notify])

  const commitModule = React.useCallback((next: RouteModule) => {
    const normalized = normalizeRouteModule(next)
    setModule(normalized)
    setPreview(null)
    setPresets((items) => items.map((preset) => preset.id === activePresetId
      ? { ...preset, revision: preset.revision + 1, updatedAt: nowIso(), modules: preset.modules.map((entry) => entry.id === selectedModuleId ? normalized : entry) }
      : preset))
  }, [activePresetId, selectedModuleId, setPresets])

  const classificationStudio = useRouteClassification({ catalogStatus, commitModule, module, modules, notify, setBusy })
  const {
    formalModuleIds, setClassificationPreview, setClassificationReceipt, setClassificationRequest,
    testNotes,
  } = classificationStudio

  React.useEffect(() => { void refreshCatalog() }, [refreshCatalog])
  React.useEffect(() => { setRoutePage(0) }, [activePresetId, routeFilter])
  React.useEffect(() => {
    const selected = modules.find((item) => item.id === selectedModuleId) ?? modules[0] ?? null
    setSelectedModuleId(selected?.id ?? null)
    setModule(selected ? clone(selected) : null)
    setPreview(null)
    setClassificationRequest(null)
    setClassificationReceipt(null)
    setClassificationPreview(null)
  }, [activePresetId, modules.length])

  const selectModule = (entry: RouteModule) => {
    setSelectedModuleId(entry.id)
    setModule(clone(entry))
    setPreview(null)
    setClassificationRequest(null)
    setClassificationReceipt(null)
    setClassificationPreview(null)
  }

  const newBranch = () => {
    const next = normalizeRouteModule({
      id: uniqueId("branch"), displayName: "新路由分支", family: "scene-environment", revision: 1,
      scope: { styles: ["cg"], assets: ["scene"], referenceModes: ["none", "style"] },
      classifier: { definition: "", selectionPolicy: "single-dominant", controlDimensions: [...DEFAULT_CONTROL_DIMENSIONS], tieBreak: "", noDefault: true },
      operations: [{ op: "append", field: "Scene/backdrop", value: "" }], tests: [], origin: { kind: "session-draft" },
    })
    setPresets((items) => items.map((preset) => preset.id === activePresetId ? { ...preset, revision: preset.revision + 1, updatedAt: nowIso(), modules: [...preset.modules, next] } : preset))
    setSelectedModuleId(next.id)
    setModule(next)
  }

  const duplicateBranch = () => {
    if (!module) return
    const next = normalizeRouteModule({ ...clone(module), id: uniqueId(`${module.id}-copy`), displayName: `${module.displayName} 副本`, revision: 1, origin: { kind: "session-draft" } })
    setPresets((items) => items.map((preset) => preset.id === activePresetId ? { ...preset, revision: preset.revision + 1, modules: [...preset.modules, next], updatedAt: nowIso() } : preset))
    setSelectedModuleId(next.id)
    setModule(next)
  }

  const deleteBranch = async () => {
    if (!module) return
    setBusy(true)
    try {
      const formal = (catalogStatus?.catalogSummary?.conditionModules ?? []).some((entry: RouteModule) => entry.id === module.id)
      if (formal && catalogStatus) {
        await routeAdminAdapter.remove(module.id, { expectedCatalogFingerprint: catalogStatus.catalogFingerprint })
        await refreshCatalog()
      }
      setPresets((items) => items.map((preset) => preset.id === activePresetId ? { ...preset, revision: preset.revision + 1, modules: preset.modules.filter((entry) => entry.id !== module.id), updatedAt: nowIso() } : preset))
      setSelectedModuleId(null)
      setModule(null)
      notify(formal ? "正式分支已从注册表删除" : "当前预设中的分支已删除")
    } catch (error) { notify(safeMessage(error, "分支删除失败"), "error") }
    finally { setBusy(false); setDeleteBranchOpen(false) }
  }

  const saveFormal = async () => {
    if (!module || !catalogStatus) return
    const validation = validateRouteModule(module)
    if (!validation.valid) {
      notify(validation.errors[0]?.message || "请先补全分支条件和提示词修改", "error")
      return
    }
    setBusy(true)
    try {
      await routeAdminAdapter.save(validation.module, { expectedCatalogFingerprint: catalogStatus.catalogFingerprint })
      await refreshCatalog()
      notify("分支已写入正式提示词注册表")
    } catch (error) { notify(safeMessage(error, "正式分支保存失败"), "error") }
    finally { setBusy(false) }
  }

  const resolvePreview = async () => {
    if (!module) return
    setBusy(true)
    try {
      const base = await catalogAdapter.resolve({
        style: module.scope.styles[0] || "cg",
        asset: module.scope.assets[0] || "scene",
        referenceMode: module.scope.referenceModes[0] || "none",
        referenceCount: module.scope.referenceModes[0] === "visual-consistency" ? 2 : module.scope.referenceModes[0] === "none" ? 0 : 1,
        ...(testNotes.trim() ? { productionNotes: testNotes.trim() } : {}),
      })
      setPreview({ base, applied: applyModuleOperationsPreview(base.promptFields, module) })
    } catch (error) { notify(safeMessage(error, "提示词预览生成失败"), "error") }
    finally { setBusy(false) }
  }

  const exportCurrentBranch = async () => {
    if (!module) return
    try {
      const result = await downloadJson(
        `${module.displayName}.ka-route-branch.json`,
        createRouteBranchFile({ module, source: { app: "KA Prompt Studio" } }),
      )
      if (result.saved) notify(`当前分支已导出：${result.fileName}`)
      else notify("已取消导出", "warning")
    } catch (error) {
      notify(safeMessage(error, "当前分支导出失败"), "error")
    }
  }

  const validateBranch = () => {
    if (!module) return
    const result = validateRouteModule(module)
    notify(result.valid ? "分支结构校验通过" : result.errors[0]?.message || "校验失败", result.valid ? "good" : "error")
  }

  const dialogStudio = {
    applyImportedArtifacts, catalogStatus, createPreset, deleteBranch, deleteBranchOpen, deletePreset,
    deletePresetId, exportOpen, exportPreset, exportValue, module, newPresetOpen, newPresetValue,
    pendingImport, renameOpen, renamePreset, renameValue, setDeleteBranchOpen, setDeletePresetId,
    setExportOpen, setExportValue, setNewPresetOpen, setNewPresetValue, setPendingImport,
    setRenameOpen, setRenameValue,
  }
  const presetsPanelStudio = {
    activePreset, activePresetId, importArtifacts, presetImportRef, presets, presetsOpen,
    setActivePresetId, setDeletePresetId, setExportOpen, setExportValue, setNewPresetOpen,
    setNewPresetValue, setPresetsOpen, setRenameOpen, setRenameValue,
  }
  const moduleListStudio = {
    branchImportRef, filteredModules, formalModuleIds, importArtifacts, modules, newBranch,
    routeFilter, routePage, routePageCount, selectModule, selectedModuleId, setRouteFilter,
    setRoutePage, visibleModules,
  }

  return {
    busy, catalogStatus, classificationStudio, commitModule, dialogStudio, duplicateBranch,
    exportCurrentBranch, module, moduleListStudio, presetsPanelStudio, preview, resolvePreview,
    saveFormal, setDeleteBranchOpen, validateBranch,
  }
}

export type RouteStudioController = ReturnType<typeof useRouteStudio>
