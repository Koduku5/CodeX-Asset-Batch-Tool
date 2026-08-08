import * as React from "react"
import { LoaderCircle, Pencil, Plus, Trash2, Upload } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import {
  ACTIVE_TASK_STATUSES,
  PHASE_LABELS,
  SectionHeading,
  StatusDot,
  formatCount,
  type JsonRecord,
  type ProjectCard,
} from "@/features/workbench/workbench-foundation"
import { cn } from "@/lib/utils"

export type WorkbenchProjectPanelStudio = {
  activeAgentChatRunning: boolean
  activeProject: ProjectCard | null
  activeProjectHasRunningTask: boolean
  activeProjectId: string | null
  activeProjectIsIsolated: boolean
  busyAction: string | null
  fileInputRef: React.RefObject<HTMLInputElement | null>
  projectButtonRefs: React.RefObject<Map<string, HTMLButtonElement>>
  projects: ProjectCard[]
  projectsLoading: boolean
  tasks: Record<string, JsonRecord>
  createFromScreenplay: (file: File) => void
  focusFromKey: (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => void
  openCreate: () => void
  openDelete: () => void
  openRename: (name: string) => void
  selectProject: (projectId: string) => void
}

export function WorkbenchProjectPanel({ studio }: { studio: WorkbenchProjectPanelStudio }) {
  const {
    activeAgentChatRunning,
    activeProject,
    activeProjectHasRunningTask,
    activeProjectId,
    activeProjectIsIsolated,
    busyAction,
    createFromScreenplay,
    fileInputRef,
    focusFromKey,
    openCreate,
    openDelete,
    openRename,
    projectButtonRefs,
    projects,
    projectsLoading,
    selectProject,
    tasks,
  } = studio

  return (
    <Card className="gap-3 py-4 shadow-panel">
      <CardHeader className="px-4">
        <SectionHeading
          title="项目任务"
          titleClassName="text-lg"
          action={(
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" variant="outline" onClick={openCreate}><Plus />新建项目</Button>
              <Button size="sm" variant="outline" onClick={() => activeProject && openRename(activeProject.displayName)} disabled={!activeProjectIsIsolated}><Pencil />重命名当前项目</Button>
              <Button size="sm" variant="destructive" onClick={openDelete} disabled={!activeProjectIsIsolated || activeProjectHasRunningTask || activeAgentChatRunning}><Trash2 />删除当前项目</Button>
            </div>
          )}
        />
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_17rem]">
          <div className="min-w-0">
            <div className="flex gap-3 overflow-x-auto pb-1" role="listbox" aria-label="项目任务">
              {projectsLoading && !projects.length && Array.from({ length: 3 }).map((_, index) => <div key={index} className="h-24 min-w-56 animate-pulse-soft rounded-xl bg-muted" />)}
              {projects.map((project, index) => {
                const selected = project.projectId === activeProjectId
                const projectTask = tasks[project.projectId]
                const state = ACTIVE_TASK_STATUSES.has(String(projectTask?.status))
                  ? "active"
                  : projectTask?.status === "paused" ? "warning" : project.statusSummary?.state
                return (
                  <button key={project.projectId} ref={(node) => { if (node) projectButtonRefs.current.set(project.projectId, node); else projectButtonRefs.current.delete(project.projectId) }} type="button" role="option" aria-selected={selected} onClick={() => selectProject(project.projectId)} onKeyDown={(event) => focusFromKey(event, index)} className={cn("min-h-24 min-w-56 flex-1 rounded-xl border bg-muted/20 p-3 text-left transition-all hover:border-primary/35 hover:bg-primary/5", selected && "border-primary/45 bg-primary/8 shadow-sm")}>
                    <div className="flex items-center gap-2"><StatusDot state={state} /><span className="min-w-0 flex-1 truncate text-sm font-semibold">{project.displayName}</span>{selected && <Badge variant="info">当前</Badge>}</div>
                    <p className="mt-3 truncate text-xs text-muted-foreground">{PHASE_LABELS[project.statusSummary?.phase] ?? "等待剧本"}</p>
                    <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground"><span>{project.storageMode === "isolated-project" ? "独立项目" : "兼容项目"}</span><span>{formatCount(project.statusSummary?.assetTotal)} 项资产</span></div>
                  </button>
                )
              })}
              {!projectsLoading && !projects.length && <div className="grid min-h-24 min-w-56 place-items-center rounded-xl border border-dashed px-4 text-center text-xs text-muted-foreground">拖入右侧剧本即可自动新建项目</div>}
            </div>
          </div>
          <div>
            <input ref={fileInputRef} className="sr-only" type="file" accept=".txt,.docx" aria-label="导入剧本文件" onChange={(event) => event.target.files?.[0] && createFromScreenplay(event.target.files[0])} />
            <button type="button" disabled={busyAction === "screenplay-project"} onClick={() => fileInputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files?.[0]; if (file) createFromScreenplay(file) }} className="flex min-h-24 w-full items-center gap-3 rounded-xl border border-dashed bg-muted/15 px-4 text-left transition-colors hover:border-primary/45 hover:bg-primary/5 disabled:opacity-50">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-background shadow-sm ring-1 ring-border">{busyAction === "screenplay-project" ? <LoaderCircle className="size-4 animate-spin text-primary" /> : <Upload className="size-4 text-primary" />}</span>
              <span className="min-w-0"><span className="block text-sm font-medium">拖入 TXT / DOCX 剧本</span><span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">自动以剧本名新建独立项目</span></span>
            </button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
