import * as React from "react"
import { ChevronLeft, ChevronRight, Plus, Route, Upload } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import {
  EmptyState,
  ROUTE_LIST_PAGE_SIZE,
  StatusDot,
  assetLabel,
  styleLabel,
  type RouteModule,
} from "@/features/workbench/workbench-foundation"

export type RouteModuleListStudio = {
  branchImportRef: React.RefObject<HTMLInputElement | null>
  filteredModules: RouteModule[]
  formalModuleIds: Set<string>
  importArtifacts: (files: FileList, mode: "preset" | "branch") => Promise<void>
  modules: RouteModule[]
  newBranch: () => void
  routeFilter: string
  routePage: number
  routePageCount: number
  selectModule: (entry: RouteModule) => void
  selectedModuleId: string | null
  setRouteFilter: React.Dispatch<React.SetStateAction<string>>
  setRoutePage: React.Dispatch<React.SetStateAction<number>>
  visibleModules: RouteModule[]
}

export function RouteModuleList({ studio }: { studio: RouteModuleListStudio }) {
  const {
    branchImportRef, filteredModules, formalModuleIds, importArtifacts, modules, newBranch,
    routeFilter, routePage, routePageCount, selectModule, selectedModuleId, setRouteFilter,
    setRoutePage, visibleModules,
  } = studio

  return (
    <aside className="flex min-h-0 flex-col border-r bg-muted/15">
      <div className="flex items-center justify-between border-b px-3 py-3"><span className="text-xs font-medium">路由分支</span><Button variant="ghost" size="icon-sm" onClick={newBranch} aria-label="新建分支"><Plus /></Button></div>
      <div className="space-y-1.5 border-b p-2">
        <Input value={routeFilter} onChange={(event) => setRouteFilter(event.target.value)} placeholder="搜索名称或唯一编号" aria-label="搜索路由分支" className="h-8 text-xs" />
        <p className="px-1 text-[10px] text-muted-foreground">当前条件 {filteredModules.length} 个分支 · 每页最多 {ROUTE_LIST_PAGE_SIZE} 个</p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 p-2">
          {visibleModules.map((entry) => {
            const effective = formalModuleIds.has(entry.id)
            return <button key={entry.id} type="button" onClick={() => selectModule(entry)} className={cn("w-full rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors hover:bg-accent", selectedModuleId === entry.id && "border-border bg-background shadow-sm")}><div className="flex items-center gap-2"><StatusDot state={effective ? "complete" : "waiting"} /><span className="min-w-0 flex-1 truncate text-xs font-medium">{entry.displayName}</span></div><div className="mt-1 flex items-end justify-between gap-2 pl-4.5"><span className="min-w-0 truncate text-[10px] text-muted-foreground">{styleLabel(entry.scope.styles[0])} · {assetLabel(entry.scope.assets[0])}</span><span className={cn("shrink-0 text-[9px] font-medium", effective ? "text-success" : "text-muted-foreground")}>{effective ? "已生效" : "草稿"}</span></div></button>
          })}
          {!filteredModules.length && <EmptyState icon={Route}>{modules.length ? "没有匹配的分支" : "当前预设还没有分支"}</EmptyState>}
        </div>
      </ScrollArea>
      <div className="space-y-2 border-t p-3">
        {routePageCount > 1 && <div className="flex items-center justify-between"><Button variant="ghost" size="icon-sm" aria-label="上一页分支" disabled={routePage === 0} onClick={() => setRoutePage((page) => Math.max(0, page - 1))}><ChevronLeft /></Button><span className="text-[10px] text-muted-foreground">{routePage + 1} / {routePageCount}</span><Button variant="ghost" size="icon-sm" aria-label="下一页分支" disabled={routePage >= routePageCount - 1} onClick={() => setRoutePage((page) => Math.min(routePageCount - 1, page + 1))}><ChevronRight /></Button></div>}
        <input ref={branchImportRef} type="file" accept=".json" multiple className="sr-only" aria-label="导入分支文件" onChange={(event) => { const files = event.currentTarget.files; if (files) void importArtifacts(files, "branch").finally(() => { event.currentTarget.value = "" }) }} />
        <Button variant="outline" size="sm" className="w-full" onClick={() => branchImportRef.current?.click()}><Upload />导入分支（可多选）</Button>
      </div>
    </aside>
  )
}
