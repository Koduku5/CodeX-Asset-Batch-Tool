import * as React from "react"
import {
  AlertTriangle,
  Boxes,
  ChevronRight,
  PanelRightOpen,
  WandSparkles,
  X,
} from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import {
  ASSETS,
  SectionHeading,
  formatCount,
  type JsonRecord,
} from "@/features/workbench/workbench-foundation"

export function PendingAssetBanner({ count, projectAvailable, open }: {
  count: number
  projectAvailable: boolean
  open: () => void
}) {
  if (count <= 0) return null
  return (
    <button type="button" onClick={open} disabled={!projectAvailable} className="group flex w-full flex-col gap-4 rounded-xl border border-warning/55 bg-warning/8 p-4 text-left transition-[border-color,background-color,box-shadow] hover:border-warning hover:bg-warning/12 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50 sm:flex-row sm:items-center sm:justify-between" aria-label={`打开 ${count} 项待确认资产`}>
      <div className="flex min-w-0 gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
        <div className="min-w-0">
          <p className="text-sm font-semibold">有 {count} 项资产需要人工确认</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            其他集数和世界观总览可以继续完成；确认结束后才会统一整理资产 ID、生成资产设定和 Excel。
          </p>
        </div>
      </div>
      <ChevronRight className="size-5 shrink-0 text-warning transition-transform group-hover:translate-x-1" aria-hidden="true" />
    </button>
  )
}

export function AssetOverview({ counts }: { counts: JsonRecord | null | undefined }) {
  return (
    <section>
      <SectionHeading title="资产拆分概览" description="当前项目 Cache 中的真实数量" />
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {ASSETS.map((asset) => <Card key={asset.id} className="min-h-20"><CardContent className="flex h-full items-center gap-3 p-3"><span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><Boxes className="size-4" /></span><div><p className="text-xl font-semibold tabular-nums">{formatCount(counts?.[asset.countKey])}</p><p className="text-[11px] text-muted-foreground">{asset.label}</p></div></CardContent></Card>)}
      </div>
    </section>
  )
}

export function PromptStudioLauncher({
  buttonRef,
  drawerOpen,
  activeProject,
  pendingAssetCount,
  snapshot,
  batchCounts,
  toggle,
}: {
  buttonRef: React.RefObject<HTMLButtonElement | null>
  drawerOpen: boolean
  activeProject: boolean
  pendingAssetCount: number
  snapshot: JsonRecord | null
  batchCounts: JsonRecord
  toggle: () => void
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={toggle}
      disabled={Boolean(activeProject && pendingAssetCount > 0)}
      aria-expanded={drawerOpen}
      aria-controls="prompt-studio-drawer"
      aria-label={drawerOpen ? "关闭 Prompt Studio" : "打开 Prompt Studio"}
      className="group w-full overflow-hidden rounded-2xl border border-primary/35 bg-gradient-to-br from-primary/14 via-card to-card p-5 text-left shadow-panel transition-all hover:border-primary/60 hover:shadow-overlay disabled:opacity-50"
    >
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4"><span className="grid size-12 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm"><WandSparkles className="size-6" /></span><div><p className="text-[10px] font-semibold tracking-[0.18em] text-primary">BATCH GENERATION</p><h2 className="mt-1 text-xl font-semibold">{drawerOpen ? "批量出图 · 关闭 Prompt Studio" : "批量出图 · 打开 Prompt Studio"}</h2><p className="mt-1 text-xs text-muted-foreground">配置风格、类别、参考图、提示词路由与出图后端</p></div></div>
        {drawerOpen ? <X className="size-6 text-primary transition-transform group-hover:rotate-90" /> : <PanelRightOpen className="size-6 text-primary transition-transform group-hover:translate-x-1" />}
      </div>
      <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {[["当前批次", snapshot?.batch?.scope === "none" ? "等待配置" : "资产出图"], ["后端", snapshot?.batch?.backend || "尚未运行"], ["成功", formatCount(batchCounts.completed)], ["失败", formatCount(batchCounts.failed)], ["当前项", snapshot?.batch?.activeTask?.label || `${formatCount(batchCounts.pending)} 项待处理`]].map(([label, value]) => <div key={String(label)} className="rounded-lg border border-border/70 bg-background/55 px-3 py-2"><p className="text-[10px] text-muted-foreground">{label}</p><p className="mt-1 truncate text-xs font-medium">{value}</p></div>)}
      </div>
    </button>
  )
}
