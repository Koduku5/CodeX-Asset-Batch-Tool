import { ChevronRight, ClipboardCopy, LoaderCircle, Sparkles, TestTube2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { PromptFieldList } from "@/features/prompt-studio/prompt-field-list"
import { useValidationStudio } from "@/features/prompt-studio/use-validation-studio"
import { ValidationImageDropzone } from "@/features/prompt-studio/validation-image-dropzone"
import { formatPromptText, makeRouteTrace } from "@/services/catalog-adapter.mjs"
import {
  ASSETS,
  REFERENCE_MODES,
  STYLES,
} from "@/features/workbench/workbench-constants"
import {
  SectionHeading,
} from "@/features/workbench/workbench-primitives"
import {
  ToastState,
} from "@/features/workbench/workbench-types"

type ValidationStudioProps = {
  projectName: string | null
  notify: (message: string, tone?: ToastState["tone"]) => void
}

export function ValidationStudio({ projectName, notify }: ValidationStudioProps) {
  const {
    asset, assetId, loading, prepareImageTest, productionNotes, receiveTestImage,
    referenceMode, result, setAsset, setAssetId, setProductionNotes, setReferenceMode,
    setStyle, style, testImage, testStatus, validateOne,
  } = useValidationStudio(notify)

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-4xl space-y-5 p-5">
        <div>
          <h3 className="text-base font-semibold">单项检查</h3>
          <p className="mt-1 text-xs text-muted-foreground">不修改项目、不建立队列；只把一条真实制作说明交给正式提示词解析器，检查最终 Prompt。</p>
        </div>
        <Card>
          <CardHeader className="pb-3"><SectionHeading title="解析条件" description={projectName ? `当前项目：${projectName}` : "请先在主窗口选择项目"} /></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-2"><Label>制作风格</Label><Select value={style} onValueChange={setStyle}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{STYLES.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-2"><Label>资产类型</Label><Select value={asset} onValueChange={setAsset}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{ASSETS.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-2"><Label>参考图方式</Label><Select value={referenceMode} onValueChange={setReferenceMode}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{REFERENCE_MODES.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></div>
            </div>
            <div className="space-y-2"><Label htmlFor="validation-asset-id">资产 ID / 名称</Label><Input id="validation-asset-id" value={assetId} onChange={(event) => setAssetId(event.target.value)} placeholder="例如：SCENE-014 · 雨林遗迹" /></div>
            <div className="space-y-2"><Label htmlFor="validation-production-notes">完整制作说明</Label><Textarea id="validation-production-notes" rows={6} value={productionNotes} onChange={(event) => setProductionNotes(event.target.value)} placeholder="粘贴 Excel 中这一项的完整制作说明；系统会据此解析基础路由和正式提示词。" /></div>
            <div className="flex justify-end"><Button onClick={() => void validateOne()} disabled={loading || !productionNotes.trim()}>{loading ? <LoaderCircle className="animate-spin" /> : <TestTube2 />}校验解析</Button></div>
          </CardContent>
        </Card>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(18rem,.65fr)] xl:items-start">
          <Card>
            <CardHeader className="pb-3"><SectionHeading title="最终 Prompt" description={result ? `${assetId || "未填写资产名"} · ${result.promptFields.length} 个固定字段` : "完成解析后集中显示全部字段"} action={<div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => result && navigator.clipboard.writeText(formatPromptText(result)).then(() => notify("最终 Prompt 已复制")).catch(() => notify("复制失败", "error"))} disabled={!result}><ClipboardCopy />复制</Button><Button size="sm" onClick={() => void prepareImageTest()} disabled={!result}><Sparkles />出图测试</Button></div>} /></CardHeader>
            <CardContent className="space-y-3">
              {result && <details className="group overflow-hidden rounded-lg border bg-muted/10"><summary className="flex h-9 cursor-pointer list-none items-center gap-2 px-3 text-xs font-medium outline-none hover:bg-accent/45 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden"><ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />本次解析轨迹<Badge variant="success" className="ml-auto">正式注册表</Badge></summary><div className="flex flex-wrap gap-2 border-t px-3 py-2.5">{makeRouteTrace(result).map((item: string) => <Badge key={item} variant="outline" className="font-mono text-[10px]">{item}</Badge>)}</div></details>}
              <PromptFieldList idPrefix="validation-field" fields={(result?.promptFields ?? []) as { label: string; value: string }[]} emptyMessage="填写制作说明并点击“校验解析”，这里会显示真实最终 Prompt" />
            </CardContent>
          </Card>
          <ValidationImageDropzone image={testImage} status={testStatus} onReceive={receiveTestImage} />
        </div>
      </div>
    </ScrollArea>
  )
}
