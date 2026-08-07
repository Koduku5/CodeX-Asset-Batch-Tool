import { ChevronRight, FileText } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  EmptyState,
  JsonRecord,
  OPERATION_LABELS,
  RouteModule,
} from "@/features/workbench/workbench-foundation"

export function RouteFieldPreview({ module, preview }: { module: RouteModule; preview: JsonRecord | null }) {
  const previewDiffs: JsonRecord[] = Array.isArray(preview?.applied?.diff) ? preview.applied.diff : []
  const diffByField = new Map(previewDiffs.map((diff) => [String(diff.field || ""), diff]))
  const plannedFields: string[] = [...new Set<string>(
    (module.operations as JsonRecord[])
      .filter((operation: JsonRecord) => operation.op !== "replaceWith")
      .map((operation: JsonRecord) => String(operation.field || "").trim())
      .filter(Boolean),
  )]
  const visibleFields: string[] = preview
    ? [...new Set<string>(previewDiffs.map((diff) => String(diff.field || "").trim()).filter(Boolean))]
    : plannedFields

  if (!visibleFields.length) {
    return (
      <EmptyState icon={FileText}>
        {preview ? "刷新完成：当前设置没有产生字段变化" : "请先在下方添加要修改的字段"}
      </EmptyState>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-[10px] text-muted-foreground">{visibleFields.length} 个字段将被修改 · 点击字段查看详情</p>
      {visibleFields.map((field) => {
        const diff = diffByField.get(field)
        const fieldOperations = module.operations.filter((operation: JsonRecord) => operation.op !== "replaceWith" && operation.field === field)
        return (
          <details key={field} className="group overflow-hidden rounded-lg border bg-background">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 px-3 py-2.5 outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
              <span className="min-w-0 flex-1 truncate text-xs font-medium">{field}</span>
              <Badge variant={diff ? "success" : "secondary"}>{diff ? "已生成预览" : "将被修改"}</Badge>
            </summary>
            <div className="border-t p-3">
              {diff ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-md bg-muted/35 p-3"><p className="mb-1 text-[10px] text-muted-foreground">修改前</p><p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">{diff.before || "（空）"}</p></div>
                  <div className="rounded-md bg-primary/5 p-3"><p className="mb-1 text-[10px] text-primary">修改后</p><p className="whitespace-pre-wrap break-words text-xs leading-relaxed">{diff.after || "（空）"}</p></div>
                </div>
              ) : (
                <div className="space-y-2">
                  {fieldOperations.map((operation: JsonRecord, index: number) => (
                    <div key={`${field}-${index}`} className="rounded-md bg-muted/35 p-3">
                      <Badge variant="outline">{OPERATION_LABELS[operation.op] || operation.op}</Badge>
                      <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed">{operation.value || "（尚未填写内容）"}</p>
                    </div>
                  ))}
                  <p className="text-[10px] text-muted-foreground">点击右上角“刷新预览”，读取这个字段真实的修改前与修改后。</p>
                </div>
              )}
            </div>
          </details>
        )
      })}
    </div>
  )
}
