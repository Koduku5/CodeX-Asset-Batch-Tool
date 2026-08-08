import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ClipboardCopy,
  FileText,
  LoaderCircle,
  Pause,
  X,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  ACTIVE_TASK_STATUSES,
  TASK_STATUS_LABELS,
  taskFailureSummary,
  type JsonRecord,
} from "@/features/workbench/workbench-foundation"
import { cn } from "@/lib/utils"

export type WorkbenchTaskActivityStudio = {
  activeTask: JsonRecord | null
  failureDismissed: boolean
  open: boolean
  copyLog: () => void
  dismissFailure: () => void
  setOpen: (open: boolean) => void
}

export function WorkbenchTaskActivity({ studio }: { studio: WorkbenchTaskActivityStudio }) {
  const { activeTask, copyLog, dismissFailure, failureDismissed, open, setOpen } = studio

  return (
    <>
      <Card className="gap-0 py-0 shadow-panel">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start px-1" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="active-task-log">
            {activeTask && ACTIVE_TASK_STATUSES.has(String(activeTask.status))
              ? <LoaderCircle className="size-4 animate-spin text-primary" />
              : activeTask?.status === "succeeded"
                ? <CheckCircle2 className="size-4 text-success" />
                : activeTask?.status === "paused"
                  ? <Pause className="size-4 text-warning" />
                  : activeTask?.status === "failed"
                    ? <AlertTriangle className="size-4 text-destructive" />
                    : <FileText className="size-4 text-muted-foreground" />}
            <span className="truncate text-xs font-semibold">开发者日志</span>
            <ChevronDown className={cn("ml-auto size-4 transition-transform", open && "rotate-180")} />
          </Button>
          <Badge variant={activeTask?.status === "succeeded" ? "success" : activeTask?.status === "failed" ? "destructive" : ["paused", "pausing"].includes(String(activeTask?.status)) ? "warning" : activeTask ? "info" : "muted"}>
            {activeTask ? TASK_STATUS_LABELS[activeTask.status] ?? activeTask.status : "暂无任务"}
          </Badge>
          {open && <Button variant="outline" size="sm" onClick={copyLog} disabled={!activeTask?.log?.text}><ClipboardCopy />复制日志</Button>}
        </div>
        {open && (
          <CardContent id="active-task-log" className="space-y-2 border-t px-3 py-3">
            {activeTask ? (
              <>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
                  <span>任务号 {activeTask.taskId}</span>
                  <span>退出码 {activeTask.exitCode ?? "—"}</span>
                  {activeTask.log?.truncated && <span className="text-warning">早期日志已截断</span>}
                </div>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/55 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">{activeTask.log?.text || "任务已启动，等待日志…"}</pre>
              </>
            ) : (
              <p className="py-2 text-xs text-muted-foreground">暂无任务日志，开始任务后将在这里显示。</p>
            )}
          </CardContent>
        )}
      </Card>

      {activeTask?.status === "failed" && !failureDismissed && (
        <div role="alert" className="flex flex-col gap-3 rounded-xl border border-destructive/55 bg-destructive/8 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 gap-3">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-destructive">流水线执行失败</p>
              <p className="mt-1 break-words text-xs text-foreground">{taskFailureSummary(activeTask)}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="outline" size="sm" className="border-destructive/35" onClick={() => setOpen(true)}>展开任务日志</Button>
            <Button variant="ghost" size="icon-sm" onClick={dismissFailure} aria-label="关闭错误提示"><X /></Button>
          </div>
        </div>
      )}
    </>
  )
}
