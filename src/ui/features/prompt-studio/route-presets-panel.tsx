import * as React from "react"
import { ChevronRight, Download, Pencil, Plus, Trash2, Upload } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { templateDraftRecords } from "@/features/prompt-studio/template-drafts.mjs"
import type { RoutePreset } from "@/features/workbench/workbench-foundation"

export type RoutePresetsPanelStudio = {
  activePreset: RoutePreset | null
  activePresetId: string
  importArtifacts: (files: FileList, mode: "preset" | "branch") => Promise<void>
  presetImportRef: React.RefObject<HTMLInputElement | null>
  presets: RoutePreset[]
  presetsOpen: boolean
  setActivePresetId: React.Dispatch<React.SetStateAction<string>>
  setDeletePresetId: React.Dispatch<React.SetStateAction<string | null>>
  setExportOpen: React.Dispatch<React.SetStateAction<boolean>>
  setExportValue: React.Dispatch<React.SetStateAction<string>>
  setNewPresetOpen: React.Dispatch<React.SetStateAction<boolean>>
  setNewPresetValue: React.Dispatch<React.SetStateAction<string>>
  setPresetsOpen: React.Dispatch<React.SetStateAction<boolean>>
  setRenameOpen: React.Dispatch<React.SetStateAction<boolean>>
  setRenameValue: React.Dispatch<React.SetStateAction<string>>
}

export function RoutePresetsPanel({ studio }: { studio: RoutePresetsPanelStudio }) {
  const {
    activePreset, activePresetId, importArtifacts, presetImportRef, presets, presetsOpen,
    setActivePresetId, setDeletePresetId, setExportOpen, setExportValue, setNewPresetOpen,
    setNewPresetValue, setPresetsOpen, setRenameOpen, setRenameValue,
  } = studio

  return (
    <section id="route-presets-panel" className="border-b bg-muted/15">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 px-5 py-2.5 text-left transition-colors hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-expanded={presetsOpen}
        aria-controls="route-presets-content"
        onClick={() => setPresetsOpen((open) => !open)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <ChevronRight className={cn("size-4 text-muted-foreground transition-transform", presetsOpen && "rotate-90")} />
          <span className="text-sm font-semibold">路由预设</span>
          <Badge variant="muted" className="shrink-0">{presets.length}</Badge>
        </span>
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">当前：<span className="font-medium text-foreground">{activePreset?.name ?? "未选择"}</span></span>
      </button>
      {presetsOpen && <div id="route-presets-content" className="border-t px-5 py-3">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] text-muted-foreground">点击卡片直接切换；卡片可横向滚动，数量不限。</p>
          <div className="flex gap-2">
            <input ref={presetImportRef} type="file" accept=".json" multiple className="sr-only" aria-label="导入预设文件" onChange={(event) => { const files = event.currentTarget.files; if (files) void importArtifacts(files, "preset").finally(() => { event.currentTarget.value = "" }) }} />
            <Button variant="outline" size="sm" onClick={() => { setNewPresetValue(""); setNewPresetOpen(true) }}><Plus />新建预设</Button>
            <Button variant="outline" size="sm" onClick={() => presetImportRef.current?.click()}><Upload />导入预设（可多选）</Button>
            <Button variant="outline" size="sm" onClick={() => { if (activePreset) { setExportValue(activePreset.name); setExportOpen(true) } }} disabled={!activePreset}><Download />导出当前预设</Button>
          </div>
        </div>
        <div className="flex gap-3 overflow-x-auto pb-1">
          {presets.map((preset) => {
            const active = preset.id === activePresetId
            return (
              <div key={preset.id} className={cn("group relative min-w-52 rounded-xl border bg-card p-3 text-left transition-all hover:-translate-y-0.5 hover:shadow-panel", active && "border-primary/55 bg-primary/5 ring-2 ring-primary/10")}>
                <button type="button" className="absolute inset-0 z-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" onClick={() => setActivePresetId(preset.id)} aria-label={`使用预设 ${preset.name}`} aria-pressed={active} />
                <div className="pointer-events-none relative z-[1] flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-semibold">{preset.name}</p><p className="mt-1 text-[11px] text-muted-foreground">{preset.modules.length} 个分支 · {Object.keys(templateDraftRecords(preset.templates)).length} 套基础字段 · {preset.source}</p></div>{active && <Badge variant="success">使用中</Badge>}</div>
                <div className="relative z-[2] mt-3 flex justify-end gap-1 opacity-70 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                  <Button variant="ghost" size="icon-sm" onClick={(event) => { event.stopPropagation(); setActivePresetId(preset.id); setRenameValue(preset.name); setRenameOpen(true) }} aria-label={`重命名 ${preset.name}`}><Pencil /></Button>
                  <Button variant="ghost" size="icon-sm" onClick={(event) => { event.stopPropagation(); setDeletePresetId(preset.id) }} disabled={presets.length <= 1} aria-label={`删除 ${preset.name}`}><Trash2 /></Button>
                </div>
              </div>
            )
          })}
        </div>
      </div>}
    </section>
  )
}
