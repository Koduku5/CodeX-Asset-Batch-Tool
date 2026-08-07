import * as React from "react"
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  GitMerge,
  Lock,
  LockOpen,
  LoaderCircle,
  RefreshCw,
  Split,
  Trash2,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

import { PendingAssetAdapter } from "../../services/pending-asset-adapter.mjs"

type JsonRecord = Record<string, any>
type Decision = "independent" | "merge" | "exclude" | ""

const adapter = new PendingAssetAdapter()
const CATEGORY_LABELS: Record<string, string> = {
  characters: "角色",
  creatures: "生物",
  extras: "群演",
  scenes: "场景",
  props: "道具",
}
const SUBJECT_CATEGORIES = new Set(["characters", "creatures", "extras"])

const cloneRecord = (value: JsonRecord | null | undefined) => value
  ? JSON.parse(JSON.stringify(value)) as JsonRecord
  : null

const editableRecord = (value: JsonRecord | null | undefined) => {
  const record = cloneRecord(value)
  if (!record) return null
  delete record.assetId
  record.productionNotes = null
  record.inferenceBasis = null
  return record
}

const normalizeIdentity = (value: unknown) => String(value ?? "")
  .replace(/\s+/gu, "")
  .toLocaleLowerCase()

const independentRecord = (item: JsonRecord, targets: JsonRecord[]) => {
  const record = editableRecord(item.draftAsset)
  if (!record) return null
  const occupied = new Set(targets.flatMap((target) => {
    const targetRecord = target.record ?? {}
    return [targetRecord.assetName, ...(Array.isArray(targetRecord.aliases) ? targetRecord.aliases : [])]
      .map(normalizeIdentity)
      .filter(Boolean)
  }))
  record.aliases = (Array.isArray(record.aliases) ? record.aliases : [])
    .filter((alias: string) => !occupied.has(normalizeIdentity(alias)))
  return record
}

const decisionResolution = (item: JsonRecord, decision: Decision, target?: JsonRecord | null) => {
  if (decision === "independent") return `人工选择独立建档：${item.candidate}`
  if (decision === "merge") return `人工选择合并：${item.candidate} -> ${target?.assetName ?? target?.assetId ?? "未知目标"}`
  return `人工选择排除：${item.candidate}`
}

const safeMessage = (error: unknown, fallback: string) => {
  const message = String((error as JsonRecord)?.message ?? "").trim()
  return message || fallback
}

const compatibleTargets = (item: JsonRecord | null, targets: JsonRecord[]) => {
  if (!item) return []
  const category = String(item.proposedCategory ?? "")
  return targets.filter((target) => SUBJECT_CATEGORIES.has(category)
    ? SUBJECT_CATEGORIES.has(String(target.category))
    : target.category === category)
}

function RecordPreview({ title, category, record, empty }: {
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

function FinalRecordEditor({ record, category, onChange, errorId }: {
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

export function PendingAssetDialog({
  open,
  onOpenChange,
  projectId,
  projectBusy = false,
  onCommitted,
  onFinalized,
  notify,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string | null
  projectBusy?: boolean
  onCommitted: () => void | Promise<void>
  onFinalized?: () => void | Promise<void>
  notify: (message: string, tone?: "good" | "warning" | "error") => void
}) {
  const [state, setState] = React.useState<JsonRecord | null>(null)
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [decision, setDecision] = React.useState<Decision>("")
  const [targetId, setTargetId] = React.useState("")
  const [finalRecord, setFinalRecord] = React.useState<JsonRecord | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState("")

  const items = Array.isArray(state?.items) ? state.items : []
  const current = items.find((item: JsonRecord) => item.pendingId === selectedId)
    ?? items.find((item: JsonRecord) => item.status === "pending")
    ?? items[0]
    ?? null
  const targets = compatibleTargets(current, Array.isArray(state?.targets) ? state.targets : [])
  const selectedTarget = targets.find((target: JsonRecord) => target.assetId === targetId) ?? null

  const resetEditor = React.useCallback((item: JsonRecord | null, nextState: JsonRecord | null) => {
    setDecision("")
    setFinalRecord(null)
    setError("")
    const nextTargets = compatibleTargets(item, Array.isArray(nextState?.targets) ? nextState.targets : [])
    const conflictIds = Array.isArray(item?.conflicts)
      ? item.conflicts.map((conflict: JsonRecord) => String(conflict?.assetId ?? "")).filter(Boolean)
      : []
    setTargetId(nextTargets.find((target: JsonRecord) => conflictIds.includes(target.assetId))?.assetId ?? nextTargets[0]?.assetId ?? "")
  }, [])

  const load = React.useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    setError("")
    try {
      const next = await adapter.getState({ projectId })
      setState(next)
      const nextItem = next.items.find((item: JsonRecord) => item.status === "pending") ?? next.items[0] ?? null
      setSelectedId(nextItem?.pendingId ?? null)
      resetEditor(nextItem, next)
    } catch (loadError) {
      setError(safeMessage(loadError, "待确认资产读取失败"))
    } finally {
      setLoading(false)
    }
  }, [projectId, resetEditor])

  React.useEffect(() => {
    if (open) void load()
    else {
      setState(null)
      setSelectedId(null)
      resetEditor(null, null)
    }
  }, [load, open, resetEditor])

  const selectItem = (item: JsonRecord) => {
    setSelectedId(item.pendingId)
    resetEditor(item, state)
  }

  const chooseDecision = (next: Exclude<Decision, "">) => {
    if (!current || current.status !== "pending") return
    setDecision(next)
    setError("")
    if (next === "independent") {
      setFinalRecord(independentRecord(current, targets))
    } else if (next === "merge") {
      setFinalRecord(editableRecord(selectedTarget?.record))
    } else {
      setFinalRecord(null)
    }
  }

  const changeTarget = (nextId: string) => {
    setTargetId(nextId)
    const target = targets.find((item: JsonRecord) => item.assetId === nextId)
    setFinalRecord(editableRecord(target?.record))
  }

  const validate = () => {
    if (!current || current.status !== "pending") return "请选择尚未处理的待确认项"
    if (!decision) return "请选择独立建档、合并已有或排除"
    if (decision === "merge" && !selectedTarget) return "请选择明确的合并目标"
    if (decision !== "exclude") {
      if (!finalRecord?.assetName?.trim()) return "最终资产名称不能为空"
      if (!finalRecord?.scriptSetting?.trim()) return "最终剧本事实不能为空"
      if (!Number.isSafeInteger(finalRecord?.firstRequiredEpisode) || finalRecord.firstRequiredEpisode < 1) return "首次需求集数必须是正整数"
      if (!Number.isSafeInteger(finalRecord?.firstRequiredOrder) || finalRecord.firstRequiredOrder < 1) return "集内制作顺序必须是正整数"
      if (SUBJECT_CATEGORIES.has(String(decision === "merge" ? selectedTarget?.category : current.proposedCategory))
        && String(finalRecord?.faction ?? "").split("｜").filter((value) => value.trim()).length !== 2) {
        return "角色、生物或群演的阵营必须且只能包含一个“｜”"
      }
      const name = String(finalRecord.assetName).replace(/\s+/gu, "").toLocaleLowerCase()
      const aliases = Array.isArray(finalRecord.aliases) ? finalRecord.aliases : []
      const normalized = aliases.map((value: string) => value.replace(/\s+/gu, "").toLocaleLowerCase())
      if (normalized.includes(name) || new Set(normalized).size !== normalized.length) return "别名不得重复资产名称或彼此重复"
    }
    return ""
  }

  const submit = async () => {
    if (!projectId || !current) return
    const validationError = validate()
    if (validationError) {
      setError(validationError)
      return
    }
    setSubmitting(true)
    setError("")
    try {
      const receipt = await adapter.resolve({
        projectId,
        pendingId: current.pendingId,
        decision,
        resolution: decisionResolution(current, decision, selectedTarget),
        ...(decision === "merge" ? { targetAssetId: targetId } : {}),
        ...(decision !== "exclude" ? { finalAsset: finalRecord } : {}),
      })
      if (receipt.finalized) {
        notify(`全部待确认资产已处理；应用 ${receipt.appliedCount ?? 0} 项决定，整理 ${receipt.renumberedCount ?? 0} 个既有编号。`)
        onOpenChange(false)
        await onCommitted()
        await onFinalized?.()
        return
      }
      const next = await adapter.getState({ projectId })
      setState(next)
      const nextItem = next.items.find((item: JsonRecord) => item.status === "pending") ?? null
      setSelectedId(nextItem?.pendingId ?? null)
      resetEditor(nextItem, next)
      notify(`本项决定已暂存，还剩 ${receipt.remaining ?? next.pendingCount} 项待确认。`)
      await onCommitted()
    } catch (submitError) {
      setError(safeMessage(submitError, "人工确认提交失败"))
    } finally {
      setSubmitting(false)
    }
  }

  const finalCategory = decision === "merge" ? String(selectedTarget?.category ?? "") : String(current?.proposedCategory ?? "")
  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="grid h-[min(92dvh,56rem)] max-w-[min(96vw,80rem)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden p-0 sm:p-0">
        <DialogHeader className="border-b px-5 py-4 sm:px-6">
          <div className="flex flex-wrap items-center gap-2">
            <DialogTitle>人工确认待定资产</DialogTitle>
            {state && <Badge variant={state.ready ? "warning" : "muted"}>{state.pendingCount} 项待确认</Badge>}
          </div>
          <DialogDescription>
            单集分析已经保留候选事实和首次出现顺序。全部确认完成后，固定脚本才会正式纳入并统一整理资产 ID。
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 grid-rows-[10rem_minmax(0,1fr)] overflow-hidden lg:grid-cols-[18rem_minmax(0,1fr)] lg:grid-rows-1">
          <aside className="min-h-0 border-b bg-muted/15 lg:border-r lg:border-b-0" aria-label="待确认资产列表">
            <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
              <div>
                <p className="text-xs font-semibold">处理进度</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">已决定 {state?.decidedCount ?? 0} · 待确认 {state?.pendingCount ?? 0}</p>
              </div>
              <Button variant="ghost" size="icon-sm" onClick={() => void load()} disabled={loading || submitting} aria-label="刷新待确认资产">
                <RefreshCw className={cn(loading && "animate-spin")} />
              </Button>
            </div>
            <ScrollArea className="h-40 lg:h-[calc(min(92dvh,56rem)-9.5rem)]">
              <div className="space-y-1 p-2">
                {items.map((item: JsonRecord, index: number) => (
                  <button
                    key={item.pendingId}
                    type="button"
                    onClick={() => selectItem(item)}
                    aria-current={current?.pendingId === item.pendingId ? "true" : undefined}
                    className={cn(
                      "group flex min-h-16 w-full cursor-pointer select-none items-center gap-2 rounded-lg border border-transparent px-3 py-2 text-left transition-[border-color,background-color,box-shadow] hover:border-primary/25 hover:bg-accent hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring active:bg-accent/80",
                      current?.pendingId === item.pendingId && "border-primary/40 bg-primary/8 shadow-sm",
                    )}
                  >
                    {item.status === "resolved"
                      ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-label="已决定" />
                      : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-label="待确认" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold">{index + 1}. {item.candidate}</span>
                      <span className="mt-1 block truncate text-[10px] text-muted-foreground">第 {item.firstRequiredEpisode} 集 · {CATEGORY_LABELS[item.proposedCategory] ?? item.proposedCategory}</span>
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" aria-hidden="true" />
                  </button>
                ))}
                {!loading && !items.length && <p className="px-3 py-8 text-center text-xs text-muted-foreground">没有需要处理的暂存资产</p>}
              </div>
            </ScrollArea>
          </aside>

          <ScrollArea className="min-h-0 h-full">
            <div className="space-y-5 p-4 sm:p-6">
              {loading && !state ? (
                <div className="grid min-h-72 place-items-center text-sm text-muted-foreground"><LoaderCircle className="mr-2 inline size-4 animate-spin" />正在读取待确认资产…</div>
              ) : !current ? (
                <div className="grid min-h-72 place-items-center text-center"><div><CheckCircle2 className="mx-auto size-10 text-success" /><p className="mt-3 text-sm font-semibold">没有待确认资产</p></div></div>
              ) : (
                <>
                  {!state?.ready && (
                    <div role="status" className="rounded-xl border border-info/35 bg-info/8 px-4 py-3 text-xs">
                      需要等待全部单集分析和世界观总览完成后才能提交决定；当前内容可以先查看。
                    </div>
                  )}
                  {projectBusy && (
                    <div role="status" className="rounded-xl border border-warning/35 bg-warning/8 px-4 py-3 text-xs">
                      流水线正在完成当前步骤。可以先查看内容，待任务安全停止后再提交决定。
                    </div>
                  )}
                  <section aria-labelledby="pending-issue-heading" className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 id="pending-issue-heading" className="text-base font-semibold">{current.candidate}</h3>
                      <Badge variant="outline">第 {current.firstRequiredEpisode} 集 / 顺序 {current.firstRequiredOrder}</Badge>
                      {current.status === "resolved" && <Badge variant="success">决定已暂存</Badge>}
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">{current.issue}</p>
                    <div className="flex flex-wrap gap-2">
                      {(current.conflicts ?? []).map((conflict: JsonRecord, index: number) => (
                        <Badge key={`${conflict.assetId ?? conflict.assetName}-${index}`} variant="warning">
                          与 {conflict.assetName} 共享“{conflict.sharedValue}”
                        </Badge>
                      ))}
                    </div>
                  </section>

                  <fieldset className="space-y-3" disabled={current.status !== "pending" || submitting || !state?.ready || projectBusy}>
                    <legend className="text-sm font-semibold">选择处理方式</legend>
                    <div className="grid gap-2 sm:grid-cols-3">
                      <Button variant={decision === "independent" ? "default" : "outline"} className="h-auto min-h-16 justify-start whitespace-normal px-3 py-3 text-left" aria-pressed={decision === "independent"} onClick={() => chooseDecision("independent")}>
                        <Split className="size-4" /><span><span className="block font-semibold">独立建档</span><span className="mt-0.5 block text-[10px] opacity-75">按候选草稿建立新资产</span></span>
                      </Button>
                      <Button variant={decision === "merge" ? "default" : "outline"} className="h-auto min-h-16 justify-start whitespace-normal px-3 py-3 text-left" aria-pressed={decision === "merge"} onClick={() => chooseDecision("merge")}>
                        <GitMerge className="size-4" /><span><span className="block font-semibold">合并已有</span><span className="mt-0.5 block text-[10px] opacity-75">沿用既有资产身份锚点</span></span>
                      </Button>
                      <Button variant={decision === "exclude" ? "destructive" : "outline"} className="h-auto min-h-16 justify-start whitespace-normal px-3 py-3 text-left" aria-pressed={decision === "exclude"} onClick={() => chooseDecision("exclude")}>
                        <Trash2 className="size-4" /><span><span className="block font-semibold">排除</span><span className="mt-0.5 block text-[10px] opacity-75">不建立独立制作资产</span></span>
                      </Button>
                    </div>
                  </fieldset>

                  {decision === "merge" && (
                    <div className="space-y-2">
                      <Label htmlFor="pending-merge-target">合并目标</Label>
                      <Select value={targetId} onValueChange={changeTarget} disabled={submitting || current.status !== "pending"}>
                        <SelectTrigger id="pending-merge-target"><SelectValue placeholder="选择已有正式资产" /></SelectTrigger>
                        <SelectContent>
                          {targets.map((target: JsonRecord) => (
                            <SelectItem key={target.assetId} value={target.assetId}>{target.assetId} · {target.assetName} · {CATEGORY_LABELS[target.category]}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {decision === "merge" ? (
                    <div className="grid gap-3 xl:grid-cols-2">
                      <RecordPreview title="已有正式资产" category={selectedTarget?.category} record={selectedTarget?.record} empty="请先选择合并目标" />
                      <RecordPreview title="待确认候选草稿" category={current.proposedCategory} record={current.draftAsset} />
                    </div>
                  ) : (
                    <RecordPreview title="待确认候选草稿" category={current.proposedCategory} record={current.draftAsset} />
                  )}

                  {decision !== "exclude" && finalRecord && (
                    <FinalRecordEditor key={`${current.pendingId}:${decision}:${targetId}`} record={finalRecord} category={finalCategory} onChange={setFinalRecord} errorId={error ? "pending-decision-error" : undefined} />
                  )}

                  {current.status === "resolved" && (
                    <div className="rounded-xl border border-success/35 bg-success/8 px-4 py-3 text-xs leading-relaxed">
                      本项决定已暂存。
                    </div>
                  )}
                </>
              )}
            </div>
          </ScrollArea>
        </div>

        <DialogFooter className="relative z-10 border-t bg-background px-5 py-3 sm:px-6">
          <div className="min-w-0 flex-1" aria-live="polite">
            {error && <p id="pending-decision-error" role="alert" className="break-words text-xs text-destructive">{error}</p>}
          </div>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>稍后处理</Button>
          <Button onClick={() => void submit()} disabled={!current || current.status !== "pending" || !state?.ready || projectBusy || submitting}>
            {submitting && <LoaderCircle className="animate-spin" />}
            {state?.pendingCount === 1 ? "提交并正式纳入" : "提交本项决定"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
