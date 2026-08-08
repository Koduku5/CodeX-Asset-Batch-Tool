import {
  Boxes,
  Check,
  LoaderCircle,
  Moon,
  Network,
  RefreshCw,
  Sparkles,
  Sun,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  PHASE_LABELS,
  StatusDot,
  formatDuration,
  formatTime,
  type JsonRecord,
} from "@/features/workbench/workbench-foundation"
import { cn } from "@/lib/utils"

export function WorkbenchStatusBar({
  summary,
  projectElapsedSeconds,
  motionMode,
  resolvedTheme,
  toggleMotion,
  toggleTheme,
}: {
  summary: JsonRecord
  projectElapsedSeconds: number | undefined
  motionMode: "full" | "reduced"
  resolvedTheme: string | undefined
  toggleMotion: () => void
  toggleTheme: () => void
}) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-4 border-b bg-card px-4 text-[11px] text-muted-foreground">
      <div className="flex shrink-0 items-center gap-2 font-semibold text-foreground"><Boxes className="size-4 text-primary" />KA Asset Batch</div>
      <Separator orientation="vertical" className="h-5" />
      <div className="flex min-w-0 flex-1 items-center gap-5 overflow-hidden">
        <span className="flex shrink-0 items-center gap-2"><StatusDot state={summary.state} />{PHASE_LABELS[summary.phase] ?? "等待开始"}</span>
        <span className="hidden shrink-0 sm:inline">项目用时 {formatDuration(projectElapsedSeconds)}</span>
        <span className="hidden shrink-0 xl:inline">刷新 {formatTime(summary.observedAt)}</span>
        <span className="hidden shrink-0 xl:inline">提示词库 正式注册表</span>
      </div>
      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" onClick={toggleMotion} aria-label={motionMode === "full" ? "减少界面动效" : "开启动效"}><Sparkles className={cn(motionMode === "reduced" && "opacity-40")} /></Button></TooltipTrigger><TooltipContent>{motionMode === "full" ? "当前：标准动效" : "当前：减少动效"}</TooltipContent></Tooltip>
      <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" onClick={toggleTheme} aria-label="切换主题">{resolvedTheme === "dark" ? <Sun /> : <Moon />}</Button></TooltipTrigger><TooltipContent>切换明暗主题</TooltipContent></Tooltip>
    </header>
  )
}

export function CodexStatusCard({
  checking,
  connected,
  message,
  authorizing,
  authorize,
  check,
}: {
  checking: boolean
  connected: boolean
  message: string | undefined
  authorizing: boolean
  authorize: () => void
  check: () => void
}) {
  return (
    <Card className={cn(
      "z-10 w-[320px] max-w-full shrink-0 gap-0 py-0 shadow-panel transition-colors sm:absolute sm:top-1/2 sm:right-[calc(100%+1rem)] sm:-translate-y-1/2",
      !checking && connected && "border-success/70 bg-success/5",
      !checking && !connected && "border-destructive/55 bg-destructive/5",
    )}>
      <CardContent className="flex items-center gap-1.5 px-2.5 py-3">
        <div className="flex min-w-0 flex-1 items-center gap-1.5" aria-live="polite">
          <span className={cn(
            "grid size-7 shrink-0 place-items-center rounded-full border-2 bg-background",
            checking ? "border-muted-foreground/35 text-muted-foreground" : connected ? "border-success text-success" : "border-destructive text-destructive",
          )}>
            {checking ? <LoaderCircle className="size-4 animate-spin" aria-label="正在检测" /> : connected ? <Check className="size-4" aria-label="已连接" /> : <X className="size-4" aria-label="未连接" />}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[11px] font-semibold">Codex SDK 授权状态检测</p>
            {!checking && !connected ? (
              <Button className="mt-0.5 h-5 gap-1 px-1.5 text-[10px]" size="sm" onClick={authorize} disabled={authorizing}>
                {authorizing ? <LoaderCircle className="size-3 animate-spin" /> : <Network className="size-3" />}
                授权 Codex SDK
              </Button>
            ) : (
              <p className={cn("mt-0.5 truncate text-[10px]", connected ? "text-success" : "text-muted-foreground")}>
                {checking ? "正在检查 Codex SDK 与登录状态…" : message ?? "Codex SDK 状态暂不可用"}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button className="size-7" variant="ghost" size="icon-sm" onClick={check} disabled={checking} aria-label={connected ? "重新检测 Codex SDK" : "检测 Codex SDK 连接"}>
                <RefreshCw className={cn(checking && "animate-spin")} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{connected ? "重新检测" : "检测连接"}</TooltipContent>
          </Tooltip>
        </div>
      </CardContent>
    </Card>
  )
}
