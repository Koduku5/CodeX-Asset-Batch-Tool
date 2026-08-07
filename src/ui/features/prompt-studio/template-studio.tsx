import { ChevronRight, ClipboardCopy, LoaderCircle, RefreshCw, Save } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PromptFieldList } from "@/features/prompt-studio/prompt-field-list"
import { TemplateCustomFieldDialog } from "@/features/prompt-studio/template-custom-field-dialog"
import { useTemplateStudio } from "@/features/prompt-studio/use-template-studio"
import { makeRouteTrace } from "@/services/catalog-adapter.mjs"
import {
  ASSETS,
  REFERENCE_MODES,
  SectionHeading,
  STYLES,
  ToastState,
} from "@/features/workbench/workbench-foundation"

type TemplateStudioProps = {
  notify: (message: string, tone?: ToastState["tone"]) => void
}

export function TemplateStudio({ notify }: TemplateStudioProps) {
  const {
    addCustomField, asset, customFieldCount, draftFields, formalFieldLabels,
    hasSavedDraft, hasUnsavedChanges, isReorderLocked, loading, referenceMode,
    removeCustomField, reorderField, restoreFormal, result, saveDraft, setAsset,
    setReferenceMode, setStyle, style, updateField,
  } = useTemplateStudio(notify)

  return (
    <ScrollArea className="h-full"><div className="space-y-4 p-5">
      <Card><CardContent className="flex flex-wrap items-center gap-x-5 gap-y-2 p-3">
        <div className="flex items-center gap-2"><Label className="whitespace-nowrap">制作风格</Label><Select value={style} onValueChange={setStyle}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent>{STYLES.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></div>
        <div className="flex items-center gap-2"><Label className="whitespace-nowrap">资产类型</Label><Select value={asset} onValueChange={setAsset}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent>{ASSETS.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></div>
        <div className="flex items-center gap-2"><Label className="whitespace-nowrap">参考图方式</Label><Select value={referenceMode} onValueChange={setReferenceMode}><SelectTrigger className="w-40"><SelectValue /></SelectTrigger><SelectContent>{REFERENCE_MODES.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></div>
        <Badge variant={referenceMode === "none" ? "muted" : "info"} className="ml-auto">{referenceMode === "none" ? "无参考图基础模板" : "有参考图基础模板"} · {draftFields.length || (referenceMode === "none" ? 11 : 12)} 字段{customFieldCount ? `（${customFieldCount} 个自定义）` : ""}</Badge>
      </CardContent></Card>
      <Card>
        <CardHeader className="pb-3"><SectionHeading title="基础字段编辑" description="按住可排序字段的整行即可拖动；Use case 与 Asset type 始终固定在顶部。自定义字段会随预设进入最终 Prompt。" action={<div className="flex items-center gap-2">{loading ? <LoaderCircle className="size-4 animate-spin text-primary" /> : <Badge variant={hasUnsavedChanges || hasSavedDraft ? "warning" : "success"}>{hasUnsavedChanges ? "有未保存修改" : hasSavedDraft ? "已保留草稿" : "正式注册表"}</Badge>}<TemplateCustomFieldDialog fields={draftFields} customFieldCount={customFieldCount} disabled={!result || loading} onAdd={addCustomField} /></div>} /></CardHeader>
        <CardContent className="space-y-3">
          <details className="group overflow-hidden rounded-lg border bg-muted/10">
            <summary className="flex h-9 cursor-pointer list-none items-center gap-2 px-3 text-xs font-medium outline-none hover:bg-accent/45 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden"><ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />路由轨迹<span className="ml-auto text-[10px] text-muted-foreground">{result ? makeRouteTrace(result).length : 0} 项</span></summary>
            <div className="flex flex-wrap gap-2 border-t px-3 py-2.5">{result ? makeRouteTrace(result).map((item: string) => <Badge key={item} variant="outline" className="font-mono text-[10px]">{item}</Badge>) : <span className="text-xs text-muted-foreground">读取中…</span>}</div>
          </details>
          <p className="rounded-md border border-dashed bg-muted/20 px-3 py-2 text-xs leading-5 text-muted-foreground">打开字段旁的“AI 判断”开关，只填写具体需求；系统会自动保存为 <code>【由agent 具体判断说明：…】</code>。普通文字和空值仍按固定配置处理。</p>
          <PromptFieldList idPrefix="template-field" fields={draftFields as { label: string; value: string }[]} editable agentDecisionTags onChange={updateField} onRemove={removeCustomField} isRemovable={(field) => !formalFieldLabels.has(field.label)} onReorder={reorderField} isReorderLocked={isReorderLocked} />
        </CardContent>
      </Card>
      <div className="sticky bottom-0 -mx-5 flex flex-wrap justify-end gap-2 border-t bg-background px-5 py-4"><Button variant="outline" onClick={restoreFormal} disabled={!result}><RefreshCw />恢复正式解析值</Button><Button variant="outline" onClick={() => navigator.clipboard.writeText(draftFields.map(({ label, value }) => `${label}: ${value}`).join("\n")).then(() => notify("当前字段已复制")).catch(() => notify("复制失败", "error"))} disabled={!draftFields.length}><ClipboardCopy />复制当前字段</Button><Button onClick={saveDraft} disabled={!result || loading}><Save />保留当前草稿</Button></div>
    </div></ScrollArea>
  )
}
