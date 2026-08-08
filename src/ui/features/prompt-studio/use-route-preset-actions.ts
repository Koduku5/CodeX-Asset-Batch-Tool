import * as React from "react"

import { planRouteImport } from "@/features/prompt-studio/route-import-planner"
import { createRoutePresetPackage } from "@/services/route-module-workbench.mjs"
import {
  PendingRouteImport,
  RouteModule,
  RoutePreset,
  ToastState,
  downloadJson,
  nowIso,
  routePresetNameKey,
  safeMessage,
  uniqueId,
} from "@/features/workbench/workbench-foundation"

type UseRoutePresetActionsOptions = {
  activePreset: RoutePreset | null
  activePresetId: string
  notify: (message: string, tone?: ToastState["tone"]) => void
  presets: RoutePreset[]
  setActivePresetId: React.Dispatch<React.SetStateAction<string>>
  setModule: React.Dispatch<React.SetStateAction<RouteModule | null>>
  setPresets: React.Dispatch<React.SetStateAction<RoutePreset[]>>
  setSelectedModuleId: React.Dispatch<React.SetStateAction<string | null>>
}

export function useRoutePresetActions({
  activePreset, activePresetId, notify, presets, setActivePresetId, setModule, setPresets,
  setSelectedModuleId,
}: UseRoutePresetActionsOptions) {
  const [deletePresetId, setDeletePresetId] = React.useState<string | null>(null)
  const [renameOpen, setRenameOpen] = React.useState(false)
  const [renameValue, setRenameValue] = React.useState("")
  const [newPresetOpen, setNewPresetOpen] = React.useState(false)
  const [newPresetValue, setNewPresetValue] = React.useState("")
  const [exportOpen, setExportOpen] = React.useState(false)
  const [exportValue, setExportValue] = React.useState("")
  const [pendingImport, setPendingImport] = React.useState<PendingRouteImport | null>(null)
  const presetImportRef = React.useRef<HTMLInputElement>(null)

  const createPreset = () => {
    const name = newPresetValue.trim()
    if (!name) return
    if (presets.some((preset) => routePresetNameKey(preset.name) === routePresetNameKey(name))) {
      notify("已有同名预设，请换一个名称", "error")
      return
    }
    const next: RoutePreset = {
      id: uniqueId("preset"),
      name,
      revision: 1,
      source: "本机新建",
      updatedAt: nowIso(),
      templates: {},
      modules: [],
    }
    setPresets((items) => [...items, next])
    setActivePresetId(next.id)
    setSelectedModuleId(null)
    setModule(null)
    setNewPresetOpen(false)
    setNewPresetValue("")
    notify(`已新建独立预设“${name}”`)
  }

  const deletePreset = () => {
    if (!deletePresetId || presets.length <= 1) return
    const deleting = presets.find((preset) => preset.id === deletePresetId)
    const next = presets.filter((preset) => preset.id !== deletePresetId)
    setPresets(next)
    if (activePresetId === deletePresetId) setActivePresetId(next[0].id)
    setDeletePresetId(null)
    notify(`预设“${deleting?.name ?? ""}”已删除`)
  }

  const renamePreset = () => {
    const name = renameValue.trim()
    if (!name || !activePreset) return
    if (presets.some((preset) => preset.id !== activePreset.id && preset.name.trim().toLocaleLowerCase("zh-CN") === name.toLocaleLowerCase("zh-CN"))) {
      notify("已有同名预设，请换一个名称", "error")
      return
    }
    setPresets((items) => items.map((preset) => preset.id === activePreset.id ? { ...preset, name, revision: preset.revision + 1, updatedAt: nowIso() } : preset))
    setRenameOpen(false)
    notify("预设已重命名")
  }

  const exportPreset = async () => {
    if (!activePreset) return
    const name = exportValue.trim() || activePreset.name
    try {
      const artifact = createRoutePresetPackage({
        preset: { id: activePreset.id, name, revision: activePreset.revision },
        modules: activePreset.modules,
        templates: activePreset.templates as any,
        source: { app: "KA Prompt Studio" },
      })
      const result = await downloadJson(`${name}.ka-prompt-preset.json`, artifact)
      if (!result.saved) {
        notify("已取消导出", "warning")
        return
      }
      setExportOpen(false)
      notify(`当前预设已导出：${result.fileName}`)
    } catch (error) {
      notify(safeMessage(error, "当前预设导出失败"), "error")
    }
  }

  const applyImportedArtifacts = (incoming: PendingRouteImport) => {
    if (incoming.mode === "preset" && incoming.presets.length) {
      setPresets((current) => {
        const next = [...current]
        for (const preset of incoming.presets) {
          const conflict = next.findIndex((entry) => entry.id === preset.id || entry.name.toLocaleLowerCase("zh-CN") === preset.name.toLocaleLowerCase("zh-CN"))
          if (conflict >= 0) next[conflict] = preset
          else next.push(preset)
        }
        return next
      })
      setActivePresetId(incoming.presets.at(-1)!.id)
      notify(`已导入 ${incoming.presets.length} 个预设${incoming.sameNames.length ? `，跳过 ${incoming.sameNames.length} 个相同项` : ""}${incoming.conflictNames.length ? "，冲突项已按确认覆盖" : ""}`)
    }
    if (incoming.mode === "branch" && incoming.modules.length && incoming.targetPresetId) {
      setPresets((current) => current.map((preset) => preset.id === incoming.targetPresetId ? {
        ...preset,
        revision: preset.revision + 1,
        updatedAt: nowIso(),
        modules: [...new Map([...preset.modules, ...incoming.modules].map((entry) => [entry.id, entry])).values()],
      } : preset))
      setActivePresetId(incoming.targetPresetId)
      setSelectedModuleId(incoming.modules[0].id)
      setModule(incoming.modules[0])
      notify(`已导入 ${incoming.modules.length} 个分支${incoming.sameNames.length ? `，跳过 ${incoming.sameNames.length} 个相同项` : ""}${incoming.conflictNames.length ? "，相同唯一编号已按确认覆盖" : ""}`)
    }
    setPendingImport(null)
  }

  const importArtifacts = async (files: FileList, mode: "preset" | "branch") => {
    try {
      const batch = await planRouteImport({ activePreset, files, mode, presets })
      if (!batch) return
      if (!batch.presets.length && !batch.modules.length) {
        notify(`未写入：所选${mode === "preset" ? "预设" : "分支"}与本机内容相同`, "warning")
        return
      }
      if (batch.conflictNames.length) setPendingImport(batch)
      else applyImportedArtifacts(batch)
    } catch (error) { notify(safeMessage(error, "文件不是有效的路由预设或分支文件"), "error") }
  }

  return {
    applyImportedArtifacts, createPreset, deletePreset, deletePresetId, exportOpen, exportPreset,
    exportValue, importArtifacts, newPresetOpen, newPresetValue, pendingImport, presetImportRef,
    renameOpen, renamePreset, renameValue, setDeletePresetId, setExportOpen, setExportValue,
    setNewPresetOpen, setNewPresetValue, setPendingImport, setRenameOpen, setRenameValue,
  }
}

export type RoutePresetActions = ReturnType<typeof useRoutePresetActions>
