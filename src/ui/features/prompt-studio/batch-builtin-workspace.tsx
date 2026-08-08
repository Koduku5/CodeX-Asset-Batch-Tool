import * as React from "react"
import { Boxes, ImagePlus, Save, Sparkles, Trash2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import {
  type JsonRecord,
  REFERENCE_MODES,
  SHEETS,
  SectionHeading,
  batchAdapter,
  styleLabel,
} from "@/features/workbench/workbench-foundation"

export type BatchBuiltinStudio = {
  activePreviewReference: JsonRecord | null
  activeSheet: string
  changeReferenceMode: (value: string) => void
  customFieldsBySheet: JsonRecord
  enabledSheets: string[]
  loading: boolean
  prepareImagegen: () => Promise<void>
  projectId: string | null
  referenceModeBySheet: Record<string, string>
  removeReference: (referenceId: string) => Promise<void>
  saveAndBuildFinalQueue: () => Promise<void>
  saveBatch: () => Promise<boolean>
  selectedReferenceIds: string[]
  setActiveSheet: React.Dispatch<React.SetStateAction<string>>
  setCustomFieldsBySheet: React.Dispatch<React.SetStateAction<JsonRecord>>
  setPreviewReferenceId: React.Dispatch<React.SetStateAction<string | null>>
  style: string
  toggleReferenceSelection: (referenceId: string, checked: boolean) => void
  toggleSheet: (sheet: string, checked: boolean) => void
  uploadRef: React.RefObject<HTMLInputElement | null>
  uploadReferences: (files: FileList | File[]) => Promise<void>
  visibleReferences: JsonRecord[]
}

export function BatchBuiltinWorkspace({ studio }: { studio: BatchBuiltinStudio }) {
  const {
    activePreviewReference, activeSheet, changeReferenceMode, customFieldsBySheet, enabledSheets,
    loading, prepareImagegen, projectId, referenceModeBySheet, removeReference, saveAndBuildFinalQueue,
    saveBatch, selectedReferenceIds, setActiveSheet, setCustomFieldsBySheet, setPreviewReferenceId,
    style, toggleReferenceSelection, toggleSheet, uploadRef, uploadReferences, visibleReferences,
  } = studio

  return <>
    <section>
      <SectionHeading title="本次生成类别" description="勾选是否生成；点击类别名称切换该类参考图。" />
      <div className="mt-3 flex flex-wrap gap-2">
        {SHEETS.map((sheet) => (
          <div key={sheet} className={cn("flex items-center rounded-lg border bg-background transition-colors", activeSheet === sheet && "border-primary/55 bg-primary/7 ring-2 ring-primary/10")}>
            <Checkbox className="ml-3" checked={enabledSheets.includes(sheet)} onCheckedChange={(checked) => toggleSheet(sheet, checked === true)} aria-label={`${enabledSheets.includes(sheet) ? "取消" : "启用"}${sheet}出图`} />
            <button type="button" onClick={() => { setActiveSheet(sheet); setPreviewReferenceId(null) }} className="px-2.5 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{sheet}</button>
          </div>
        ))}
      </div>
    </section>

    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><CardTitle className="text-sm">参考图 · {activeSheet}</CardTitle><p className="mt-1 text-xs text-muted-foreground">每个资产类别独立保存自己的参考图。</p></div>
          <div className="flex items-center gap-2"><Label className="whitespace-nowrap">参考图方式</Label><Select value={referenceModeBySheet[activeSheet]} onValueChange={changeReferenceMode}><SelectTrigger className="w-40"><SelectValue /></SelectTrigger><SelectContent>{REFERENCE_MODES.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select><Badge variant="secondary">{selectedReferenceIds.length} 张已选</Badge></div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <input ref={uploadRef} type="file" accept="image/png,image/jpeg,image/webp,image/bmp" multiple className="sr-only" aria-label={`上传${activeSheet}参考图`} onChange={(event) => void uploadReferences(event.currentTarget.files ?? [])} />
        <div className="grid min-w-0 gap-3 lg:grid-cols-[15rem_minmax(0,1fr)]">
          <div className="space-y-2">
            <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border bg-muted/10 p-1.5">
              {visibleReferences.map((entry) => {
                const selected = selectedReferenceIds.includes(entry.referenceId)
                return <div key={entry.referenceId} className={cn("flex items-center gap-1 rounded-md border border-transparent px-1.5 py-1", activePreviewReference?.referenceId === entry.referenceId && "border-border bg-background")}>
                  <Checkbox checked={selected} onCheckedChange={(checked) => toggleReferenceSelection(entry.referenceId, checked === true)} aria-label={`${selected ? "取消选择" : "选择"}${entry.sourceName}`} />
                  <button type="button" onClick={() => setPreviewReferenceId(entry.referenceId)} className="min-w-0 flex-1 truncate px-1 py-1 text-left text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{entry.sourceName}</button>
                  <Button variant="ghost" size="icon-sm" onClick={() => void removeReference(entry.referenceId)} aria-label={`删除 ${entry.sourceName}`}><Trash2 /></Button>
                </div>
              })}
              {!visibleReferences.length && <p className="px-2 py-8 text-center text-[11px] text-muted-foreground">{styleLabel(style)} · {activeSheet} 暂无文件</p>}
            </div>
          </div>
          <button type="button" onClick={() => uploadRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void uploadReferences(event.dataTransfer.files) }} disabled={loading || !projectId} className="group relative grid min-h-64 place-items-center overflow-hidden rounded-xl border border-dashed bg-muted/20 text-muted-foreground transition-colors hover:border-primary/55 hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-55">
            {activePreviewReference && projectId
              ? <img src={batchAdapter.referenceContentUrl({ projectId, referenceId: activePreviewReference.referenceId })} alt={activePreviewReference.sourceName} className="max-h-80 size-full object-contain" />
              : <div className="px-6 text-center text-xs"><ImagePlus className="mx-auto mb-2 size-6" />点击可多选图片，或一次拖入多张参考图</div>}
            {activePreviewReference && <span className="pointer-events-none absolute right-2 bottom-2 rounded-md bg-background/90 px-2 py-1 text-[10px] opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">点击多选，或拖入多张新参考图</span>}
          </button>
        </div>
        {referenceModeBySheet[activeSheet] === "custom" && <div className="grid gap-3 rounded-xl border border-primary/25 bg-primary/5 p-3 sm:grid-cols-2">
          <div className="space-y-2"><Label htmlFor={`custom-input-images-${activeSheet}`}>Input images</Label><Textarea id={`custom-input-images-${activeSheet}`} rows={4} value={customFieldsBySheet[activeSheet]?.inputImages ?? ""} onChange={(event) => setCustomFieldsBySheet((current) => ({ ...current, [activeSheet]: { ...current[activeSheet], inputImages: event.target.value } }))} placeholder={selectedReferenceIds.length ? selectedReferenceIds.map((_, index) => `图像 ${index + 1}：`).join("\n") : "先添加参考图，再说明每张图片的用途"} /></div>
          <div className="space-y-2"><Label htmlFor={`custom-primary-request-${activeSheet}`}>Primary request</Label><Textarea id={`custom-primary-request-${activeSheet}`} rows={4} value={customFieldsBySheet[activeSheet]?.primaryRequest ?? ""} onChange={(event) => setCustomFieldsBySheet((current) => ({ ...current, [activeSheet]: { ...current[activeSheet], primaryRequest: event.target.value } }))} placeholder="说明 ImageGen 应如何使用这些参考图" /></div>
        </div>}
      </CardContent>
    </Card>

    <div className="sticky bottom-0 -mx-5 flex flex-wrap items-center justify-end gap-2 border-t bg-background px-5 py-4">
      <Button variant="outline" onClick={() => void saveBatch()} disabled={loading || !projectId || !enabledSheets.length}><Save />保存批次配置</Button>
      <Button variant="secondary" onClick={() => void saveAndBuildFinalQueue()} disabled={loading || !projectId}><Boxes />判断分支并建立最终队列</Button>
      <Button onClick={() => void prepareImagegen()} disabled={loading || !projectId}><Sparkles />交给内置 ImageGen</Button>
    </div>
  </>
}
