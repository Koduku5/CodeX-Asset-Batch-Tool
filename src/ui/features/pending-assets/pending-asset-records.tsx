import * as React from "react"
import { Lock, LockOpen } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  CATEGORY_LABELS,
  SUBJECT_CATEGORIES,
  type JsonRecord,
} from "@/features/pending-assets/pending-asset-model"

export function RecordPreview({ title, category, record, empty }: {
  title: string
  category?: string
  record?: JsonRecord | null
  empty?: string
}) {
  return (
    <Card className="min-w-0 gap-3 py-4">
      <CardHeader className="px-4">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <CardTitle className="truncate text-sm">{title}</CardTitle>
          {category && <Badge variant="outline">{CATEGORY_LABELS[category] ?? category}</Badge>}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 px-4 text-xs">
        {!record ? (
          <p className="py-6 text-center text-muted-foreground">{empty ?? "尚未选择记录"}</p>
        ) : (
          <>
            <div>
              <p className="text-[10px] font-medium text-muted-foreground">资产名称</p>
              <p className="mt-1 break-words font-semibold">{record.assetName}</p>
            </div>
            {record.assetId && (
              <div>
                <p className="text-[10px] font-medium text-muted-foreground">当前 ID</p>
                <p className="mt-1 font-mono text-[11px]">{record.assetId}</p>
              </div>
            )}
            <div>
              <p className="text-[10px] font-medium text-muted-foreground">别名</p>
              <p className="mt-1 break-words">{Array.isArray(record.aliases) && record.aliases.length ? record.aliases.join("、") : "无"}</p>
            </div>
            {record.faction && (
              <div>
                <p className="text-[10px] font-medium text-muted-foreground">阵营</p>
                <p className="mt-1 break-words">{record.faction}</p>
              </div>
            )}
            <div>
              <p className="text-[10px] font-medium text-muted-foreground">剧本事实</p>
              <p className="mt-1 whitespace-pre-wrap break-words leading-relaxed">{record.scriptSetting}</p>
            </div>
            <div className="flex flex-wrap gap-2 text-[10px] text-muted-foreground">
              <span>首次第 {record.firstRequiredEpisode} 集</span>
              <span>集内顺序 {record.firstRequiredOrder}</span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

export function FinalRecordEditor({ record, category, onChange, errorId }: {
  record: JsonRecord
  category: string
  onChange: (record: JsonRecord) => void
  errorId?: string
}) {
  const [episodeUnlocked, setEpisodeUnlocked] = React.useState(false)
  const [orderUnlocked, setOrderUnlocked] = React.useState(false)
  const setField = (field: string, value: unknown) => onChange({ ...record, [field]: value })
  const setPositiveInteger = (field: string, value: string) => {
    const parsed = Number(value)
    setField(field, Number.isSafeInteger(parsed) && parsed > 0 ? parsed : value)
  }
  const needsFaction = SUBJECT_CATEGORIES.has(category)
  return (
    <fieldset className="space-y-4 rounded-xl border bg-muted/15 p-4" aria-describedby={errorId}>
      <legend className="px-1 text-sm font-semibold">人工核定最终记录</legend>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="pending-final-name">资产名称</Label>
          <Input id="pending-final-name" value={String(record.assetName ?? "")} onChange={(event) => setField("assetName", event.target.value)} />
        </div>
        {needsFaction && (
          <div className="space-y-2 sm:col-span-2">
            <Label htmlFor="pending-final-faction">阵营（必须包含一个“｜”）</Label>
            <Input id="pending-final-faction" value={String(record.faction ?? "")} onChange={(event) => setField("faction", event.target.value)} />
          </div>
        )}
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="pending-final-setting">完整剧本事实</Label>
          <Textarea id="pending-final-setting" rows={7} value={String(record.scriptSetting ?? "")} onChange={(event) => setField("scriptSetting", event.target.value)} />
        </div>
        {episodeUnlocked ? (
          <div className="space-y-2">
            <Label htmlFor="pending-final-episode" className="text-destructive"><LockOpen className="size-3.5" aria-hidden="true" />首次需求集数</Label>
            <Input
              id="pending-final-episode"
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={String(record.firstRequiredEpisode ?? "")}
              onChange={(event) => setPositiveInteger("firstRequiredEpisode", event.target.value)}
            />
          </div>
        ) : (
          <button type="button" onClick={() => setEpisodeUnlocked(true)} className="group rounded-lg border bg-muted/35 px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow] hover:border-primary/40 hover:bg-primary/5 hover:shadow-sm" aria-label="解锁修改首次需求集数">
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Lock className="size-3 transition-colors group-hover:text-primary" aria-hidden="true" />首次需求集数</span>
            <span className="mt-1 block text-sm font-medium">第 {record.firstRequiredEpisode} 集</span>
          </button>
        )}
        {orderUnlocked ? (
          <div className="space-y-2">
            <Label htmlFor="pending-final-order" className="text-destructive"><LockOpen className="size-3.5" aria-hidden="true" />集内制作顺序</Label>
            <Input
              id="pending-final-order"
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={String(record.firstRequiredOrder ?? "")}
              onChange={(event) => setPositiveInteger("firstRequiredOrder", event.target.value)}
            />
          </div>
        ) : (
          <button type="button" onClick={() => setOrderUnlocked(true)} className="group rounded-lg border bg-muted/35 px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow] hover:border-primary/40 hover:bg-primary/5 hover:shadow-sm" aria-label="解锁修改集内制作顺序">
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Lock className="size-3 transition-colors group-hover:text-primary" aria-hidden="true" />集内制作顺序</span>
            <span className="mt-1 block text-sm font-medium">第 {record.firstRequiredOrder} 顺位</span>
          </button>
        )}
        {(episodeUnlocked || orderUnlocked) && (
          <p role="alert" className="sm:col-span-2 text-xs leading-relaxed text-destructive">
            已解锁身份顺序字段。请先回到原剧本逐集核对首次需求集数和该集制作顺序；修改后会重新整理资产 ID 与后续排序。
          </p>
        )}
      </div>
    </fieldset>
  )
}
