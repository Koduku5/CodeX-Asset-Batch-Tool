import { ClipboardCopy, LoaderCircle, Save, Sparkles } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { RouteClassificationStudio } from "@/features/prompt-studio/use-route-classification"
import {
  ASSETS,
  JsonRecord,
  REFERENCE_MODES,
  STYLES,
  SectionHeading,
  routeClassifierAdapter,
  type RouteModule,
  type ToastState,
} from "@/features/workbench/workbench-foundation"
import { formatPromptText } from "@/services/catalog-adapter.mjs"

export function RouteClassificationWorkspace({ busy, module, notify, studio }: {
  busy: boolean
  module: RouteModule
  notify: (message: string, tone?: ToastState["tone"]) => void
  studio: RouteClassificationStudio
}) {
  const {
    applyClassificationReceipt, availableForScope, classificationMessage, classificationPreview,
    classificationReceipt, classificationRequest, invalidateClassification, saveClassificationTest,
    setSimulatedDecision, setTestAsset, setTestAssetId, setTestNotes, setTestReferenceMode,
    setTestStyle, simulatedDecision, startClassification, testAsset, testAssetId, testNotes,
    testReferenceMode, testStyle,
  } = studio

  return (
    <Card>
      <CardHeader className="pb-3"><SectionHeading title="用制作说明测试分支" description="这是单项、只读的开发调试工作台；不会启动项目级批量判断，也不会改写正式队列。" action={<Badge variant="info">{availableForScope.length} 个候选分支</Badge>} /></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="space-y-2"><Label>制作风格</Label><Select value={testStyle} onValueChange={(value) => { setTestStyle(value); invalidateClassification() }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{STYLES.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-2"><Label>资产类型</Label><Select value={testAsset} onValueChange={(value) => { setTestAsset(value); invalidateClassification() }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{ASSETS.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-2"><Label>参考图方式</Label><Select value={testReferenceMode} onValueChange={(value) => { setTestReferenceMode(value); invalidateClassification() }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{REFERENCE_MODES.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></div>
          <div className="space-y-2"><Label>资产 ID / 名称</Label><Input aria-label="测试资产 ID 或名称" value={testAssetId} onChange={(event) => { setTestAssetId(event.target.value); invalidateClassification() }} placeholder="SCENE-014 · 雨林遗迹" /></div>
        </div>
        <div className="space-y-2"><Label>完整制作说明</Label><Textarea aria-label="测试完整制作说明" rows={5} value={testNotes} onChange={(event) => { setTestNotes(event.target.value); invalidateClassification() }} placeholder="例如：巨型板根与湿润树冠控制主要空间，林间道路延伸至遗迹入口……" /></div>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-3">
          <div className="min-w-0"><p className="text-[10px] text-muted-foreground">Agent 判断结果</p><p className="mt-1 truncate text-sm font-semibold">{classificationMessage}</p></div>
          <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={saveClassificationTest} disabled={!classificationReceipt || classificationReceipt.selectedId !== module.id}><Save />保存为测试样例</Button><Button onClick={() => void startClassification()} disabled={busy || !testNotes.trim() || !availableForScope.length}>{busy ? <LoaderCircle className="animate-spin" /> : <Sparkles />}开始智能判断</Button></div>
        </div>

        {!routeClassifierAdapter.getCapabilities().classify && <div className="rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-[11px] text-muted-foreground">正式单项 Agent bridge 尚未接入桌面壳；“开始智能判断”会先生成严格候选任务。可在下方开发调试区模拟 Agent 回执验证字段变化。项目级正式批量判断只从“本次批量”执行。</div>}

        <details className="rounded-lg border bg-muted/10 p-3">
          <summary className="cursor-pointer text-xs font-medium">开发调试：模拟 Agent 回执</summary>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1 space-y-2"><Label>模拟判断结果</Label><Select value={availableForScope.some((entry) => entry.id === simulatedDecision) ? simulatedDecision : "__null__"} onValueChange={setSimulatedDecision}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__null__">不命中任何分支</SelectItem>{availableForScope.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.displayName}</SelectItem>)}</SelectContent></Select></div>
            <Button variant="secondary" onClick={() => void applyClassificationReceipt(simulatedDecision === "__null__" ? null : simulatedDecision, { source: "debug", reason: "开发者模拟回执" })} disabled={!classificationRequest || busy}>应用模拟回执</Button>
          </div>
        </details>

        <details className="rounded-lg border bg-muted/10 p-3">
          <summary className="cursor-pointer text-xs font-medium">智能判断任务详情</summary>
          <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/45 p-3 font-mono text-[10px] leading-relaxed text-muted-foreground">{classificationRequest ? JSON.stringify(classificationRequest, null, 2) : "尚未生成任务。填写条件与制作说明后点击“开始智能判断”。"}</pre>
        </details>

        {classificationPreview && <div className="rounded-xl border bg-muted/15 p-4">
          <div className="mb-3 flex items-center justify-between"><span className="text-xs font-medium">最终提示词变化</span><Button variant="outline" size="sm" onClick={() => navigator.clipboard.writeText(formatPromptText({ ...classificationPreview.base, promptFields: classificationPreview.applied.fields })).then(() => notify("最终 Prompt 已复制")).catch(() => notify("复制失败", "error"))}><ClipboardCopy />复制最终 Prompt</Button></div>
          {classificationPreview.applied.diff.length ? <div className="space-y-3">{classificationPreview.applied.diff.map((diff: JsonRecord) => <div key={diff.field} className="rounded-lg border bg-background p-3"><Badge variant="outline">{diff.field}</Badge><div className="mt-3 grid gap-3 sm:grid-cols-2"><div><p className="mb-1 text-[10px] text-muted-foreground">修改前</p><p className="text-xs leading-relaxed text-muted-foreground">{diff.before || "（空）"}</p></div><div><p className="mb-1 text-[10px] text-primary">修改后</p><p className="text-xs leading-relaxed">{diff.after || "（空）"}</p></div></div></div>)}</div> : <p className="text-xs text-muted-foreground">本次不命中分支，最终 Prompt 保持基础解析结果。</p>}
          {classificationPreview.applied.deferred?.length > 0 && <p className="mt-3 rounded-md border border-warning/30 bg-warning/8 px-3 py-2 text-[11px] text-muted-foreground">包含需要正式 Resolver 重新解析的基础路由替换操作；这里不会伪造替换结果。</p>}
        </div>}
      </CardContent>
    </Card>
  )
}
