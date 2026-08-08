import * as React from "react"
import {
  Bot,
  Check,
  LoaderCircle,
  Play,
  Plus,
  Send,
  Square,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  CODEX_MODEL_OPTIONS,
  CODEX_REASONING_OPTIONS,
} from "@/features/workbench/workbench-constants"
import {
  type JsonRecord,
} from "@/features/workbench/workbench-types"
import { cn } from "@/lib/utils"

export function AgentChatCard({
  projectId,
  connected,
  runtimeConfig,
  session,
  draft,
  confirmedProposalIds,
  onDraftChange,
  onSend,
  onCancel,
  onNewConversation,
  onRuntimeConfigChange,
  runtimeConfigSaving,
  runtimeConfigLocked,
  onConfirmProposal,
}: {
  projectId: string | null
  connected: boolean
  runtimeConfig: JsonRecord | null
  session: JsonRecord | null
  draft: string
  confirmedProposalIds: string[]
  onDraftChange: (value: string) => void
  onSend: () => void
  onCancel: () => void
  onNewConversation: () => void
  onRuntimeConfigChange: (next: { model: string; reasoningEffort: string }) => void
  runtimeConfigSaving: boolean
  runtimeConfigLocked: boolean
  onConfirmProposal: (message: JsonRecord) => void
}) {
  const chatScrollRef = React.useRef<HTMLDivElement>(null)
  const running = session?.status === "running"
  const canSend = Boolean(projectId && connected && draft.trim() && !running)
  const messages = Array.isArray(session?.messages) ? session.messages : []
  const activities = Array.isArray(session?.activities) ? session.activities : []
  const latestActivities = activities.slice(-4)
  const selectedRuntimeConfig = runtimeConfig ?? session?.runtimeConfig ?? null
  const selectedModel = String(selectedRuntimeConfig?.model ?? CODEX_MODEL_OPTIONS[0].value)
  const selectedReasoning = String(selectedRuntimeConfig?.reasoningEffort ?? "medium")
  const modelOptions = CODEX_MODEL_OPTIONS.some((option) => option.value === selectedModel)
    ? CODEX_MODEL_OPTIONS
    : [{ value: selectedModel, label: selectedModel }, ...CODEX_MODEL_OPTIONS]
  const configDisabled = !selectedRuntimeConfig || runtimeConfigSaving || runtimeConfigLocked

  React.useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const viewport = chatScrollRef.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')
      if (viewport) viewport.scrollTop = viewport.scrollHeight
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activities.length, messages.length, running, session?.error])

  return (
    <Card className="z-10 w-[320px] max-w-full gap-0 py-0 shadow-panel sm:absolute sm:top-[calc(50%+3.25rem)] sm:right-[calc(100%+1rem)]" aria-label="Codex Agent 对话">
      <CardHeader className="gap-2 px-4 pt-3 pb-2.5">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-primary"><Bot className="size-4" aria-hidden="true" /></span>
            <div className="min-w-0">
              <CardTitle className="truncate text-xs">Agent 对话</CardTitle>
              <p className="mt-0.5 text-[9px] text-muted-foreground">只读讨论 · 操作需确认</p>
            </div>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" className="size-7" variant="ghost" size="icon-sm" onClick={onNewConversation} disabled={running || !session} aria-label="新建 Agent 对话">
                <Plus aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>新建对话</TooltipContent>
          </Tooltip>
        </div>
      </CardHeader>
      <CardContent className="flex h-[440px] min-h-0 flex-col gap-2.5 px-4 pb-4">
        <ScrollArea ref={chatScrollRef} className="min-h-0 flex-1 rounded-lg border bg-muted/15" viewportClassName="p-3" aria-label="Agent 对话消息">
          <div className="space-y-2" aria-live="polite">
            {!messages.length && (
              <div className="px-1 py-5 text-center text-[10px] leading-relaxed text-muted-foreground">
                可以询问当前阶段、卡顿原因或后续流程。聊天不会直接修改监听状态。
              </div>
            )}
            {messages.map((message: JsonRecord) => {
              const isUser = message.role === "user"
              const proposal = message.proposal
              const confirmed = confirmedProposalIds.includes(String(message.messageId))
              return (
                <div key={message.messageId} className={cn("flex", isUser ? "justify-end" : "justify-start")}>
                  <div className={cn(
                    "max-w-[92%] rounded-lg px-2.5 py-2 text-[11px] leading-relaxed whitespace-pre-wrap break-words",
                    isUser ? "bg-primary text-primary-foreground" : "border bg-background text-foreground",
                  )}>
                    {message.text}
                    {proposal && (
                      <div className="mt-2 space-y-1.5 border-t border-current/15 pt-1.5">
                        <p className="font-medium">建议：{proposal.label}</p>
                        <p className="text-[9px] opacity-75">{proposal.reason}</p>
                        <Button type="button" size="sm" variant={confirmed ? "outline" : "default"} className="h-6 w-full px-2 text-[9px]" onClick={() => onConfirmProposal(message)} disabled={confirmed || running}>
                          {confirmed ? <Check aria-hidden="true" /> : <Play aria-hidden="true" />}
                          {confirmed ? "已确认" : "确认执行"}
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
            {latestActivities.map((activity: JsonRecord) => (
              <div key={activity.activityId} className={cn(
                "rounded-md border px-2 py-1.5 text-[9px] leading-relaxed text-muted-foreground",
                activity.kind === "error" && "border-destructive/35 bg-destructive/5 text-destructive",
                activity.kind === "network" && "border-warning/35 bg-warning/5",
              )}>
                <span className="mr-1 inline-block size-1.5 rounded-full bg-current align-middle" aria-hidden="true" />
                {activity.text}
              </div>
            ))}
            {running && <div className="flex items-center gap-1.5 px-1 text-[9px] text-muted-foreground"><LoaderCircle className="size-3 animate-spin" />Agent 正在回复…</div>}
            {session?.error && <p role="alert" className="rounded-md border border-destructive/35 bg-destructive/5 px-2 py-1.5 text-[9px] leading-relaxed text-destructive">{session.error}</p>}
          </div>
        </ScrollArea>
        <div className="space-y-1.5">
          <Label htmlFor="agent-chat-message" className="sr-only">输入 Agent 消息</Label>
          <Textarea
            id="agent-chat-message"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                if (canSend) onSend()
              }
            }}
            placeholder={connected ? projectId ? "询问当前项目…" : "请先选择项目" : "请先授权 Codex SDK"}
            disabled={!projectId || !connected || running}
            maxLength={4000}
            className="min-h-20 max-h-32 resize-none px-2.5 py-2 text-[11px]"
            aria-describedby="agent-chat-safety"
          />
          <p id="agent-chat-safety" className="truncate text-[8px] text-muted-foreground">
            {runtimeConfigSaving ? "正在保存配置…" : "Enter 发送 · Shift+Enter 换行"}
          </p>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-1.5" aria-label="Agent 输入配置与发送">
            <Select
              value={selectedModel}
              onValueChange={(model) => onRuntimeConfigChange({ model, reasoningEffort: selectedReasoning })}
              disabled={configDisabled}
            >
              <SelectTrigger size="sm" className="h-7 w-full min-w-0 px-2 text-[9px]" aria-label="选择 Codex 模型">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modelOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select
              value={selectedReasoning}
              onValueChange={(reasoningEffort) => onRuntimeConfigChange({ model: selectedModel, reasoningEffort })}
              disabled={configDisabled}
            >
              <SelectTrigger size="sm" className="h-7 w-full min-w-0 px-2 text-[9px]" aria-label="选择 Codex 思考等级">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CODEX_REASONING_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
              </SelectContent>
            </Select>
            {running ? (
              <Button type="button" size="sm" variant="outline" className="h-7 px-2 text-[9px]" onClick={onCancel}><Square className="size-3" />停止</Button>
            ) : (
              <Button type="button" size="sm" className="h-7 px-2 text-[9px]" onClick={onSend} disabled={!canSend}><Send className="size-3" />发送</Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
