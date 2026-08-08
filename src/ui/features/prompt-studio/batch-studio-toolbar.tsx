import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { BatchBackendSelector } from "@/features/prompt-studio/batch-backend-selector"
import {
  STYLES,
} from "@/features/workbench/workbench-constants"
import {
  StatusDot,
} from "@/features/workbench/workbench-primitives"
import {
  formatCount,
} from "@/features/workbench/workbench-utils"
import {
  type JsonRecord,
} from "@/features/workbench/workbench-types"

export function BatchStudioToolbar({ backend, generationLimit, handoff, onBackendChange, onGenerationLimitChange, onStyleChange, style }: {
  backend: string
  generationLimit: string
  handoff: JsonRecord | null
  onBackendChange: (value: string) => void
  onGenerationLimitChange: (value: string) => void
  onStyleChange: (value: string) => void
  style: string
}) {
  return (
    <Card>
      <CardContent className="space-y-3 p-3">
        <div className="flex min-w-0 flex-wrap items-center gap-x-8 gap-y-2">
          <div className="flex items-center gap-2"><Label className="shrink-0 whitespace-nowrap">制作风格</Label><Select value={style} onValueChange={onStyleChange}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent>{STYLES.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></div>
          {backend === "builtin" && <div className="flex items-center gap-2"><Label className="shrink-0 whitespace-nowrap">出图限制数量</Label><Select value={generationLimit} onValueChange={onGenerationLimitChange}><SelectTrigger className="w-32"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="5">最多 5 张</SelectItem><SelectItem value="10">最多 10 张</SelectItem><SelectItem value="0">全部资产</SelectItem></SelectContent></Select></div>}
          <BatchBackendSelector backend={backend} onBackendChange={onBackendChange} />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 text-xs">
          <span className="font-medium">队列状态</span>
          <StatusDot state={handoff?.status === "active" ? "active" : handoff?.status === "ready" ? "complete" : "waiting"} />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{handoff?.message ?? "等待批次配置与队列"}</span>
          <Badge variant="outline" className="shrink-0">{formatCount(handoff?.counts?.pending)} 待处理</Badge>
        </div>
      </CardContent>
    </Card>
  )
}
