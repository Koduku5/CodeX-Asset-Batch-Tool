import { LoaderCircle, Plus, TestTube2, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { RouteFieldPreview } from "@/features/prompt-studio/route-field-preview"
import {
  JsonRecord,
  type RouteModule,
} from "@/features/workbench/workbench-types"
import {
  OPERATION_LABELS,
} from "@/features/workbench/workbench-constants"
import {
  SectionHeading,
} from "@/features/workbench/workbench-primitives"
import { DEFAULT_ALLOWED_TARGET_FIELDS } from "@/services/route-module-workbench.mjs"

export function RouteOperationsWorkspace({ busy, commitModule, module, preview, resolvePreview }: {
  busy: boolean
  commitModule: (next: RouteModule) => void
  module: RouteModule
  preview: JsonRecord | null
  resolvePreview: () => Promise<void>
}) {
  return (
    <div className="grid gap-5 xl:grid-cols-2 xl:items-start">
      <Card>
        <CardHeader className="pb-3"><SectionHeading title="命中后怎么修改提示词" description="设置修改方式、目标字段和内容。" /></CardHeader>
        <CardContent className="space-y-3">
          {module.operations.map((operation: JsonRecord, index: number) => (
            <div key={index} className="space-y-2 rounded-xl border p-3">
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_32px] gap-2">
                <Select value={operation.op} onValueChange={(value) => commitModule({ ...module, operations: module.operations.map((item: JsonRecord, itemIndex: number) => itemIndex === index ? value === "replaceWith" ? { op: value, routeId: "" } : { op: value, field: item.field || "Scene/backdrop", value: item.value || "" } : item) })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(OPERATION_LABELS).map(([id, label]) => <SelectItem key={id} value={id}>{label}</SelectItem>)}</SelectContent></Select>
                {operation.op === "replaceWith" ? <Input value={operation.routeId || ""} placeholder="基础路由编号" onChange={(event) => commitModule({ ...module, operations: module.operations.map((item: JsonRecord, itemIndex: number) => itemIndex === index ? { ...item, routeId: event.target.value } : item) })} /> : <Select value={operation.field} onValueChange={(value) => commitModule({ ...module, operations: module.operations.map((item: JsonRecord, itemIndex: number) => itemIndex === index ? { ...item, field: value } : item) })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{DEFAULT_ALLOWED_TARGET_FIELDS.map((field: string) => <SelectItem key={field} value={field}>{field}</SelectItem>)}</SelectContent></Select>}
                <Button variant="ghost" size="icon-sm" aria-label="删除这条修改" onClick={() => commitModule({ ...module, operations: module.operations.filter((_: unknown, itemIndex: number) => itemIndex !== index) })}><Trash2 /></Button>
              </div>
              {operation.op === "replaceWith" ? <div className="rounded-md bg-muted/35 px-3 py-2 text-xs text-muted-foreground">命中后重新加载指定基础路由</div> : <Textarea rows={3} className="w-full resize-y" value={operation.value || ""} placeholder="写入这个字段的提示词内容" onChange={(event) => commitModule({ ...module, operations: module.operations.map((item: JsonRecord, itemIndex: number) => itemIndex === index ? { ...item, value: event.target.value } : item) })} />}
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => commitModule({ ...module, operations: [...module.operations, { op: "append", field: "Scene/backdrop", value: "" }] })}><Plus />添加一条修改</Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-3"><SectionHeading title="对应字段预览" description="只显示这个分支会修改的字段；展开字段查看前后差异。" action={<Button variant="outline" size="sm" onClick={() => void resolvePreview()} disabled={busy}>{busy ? <LoaderCircle className="animate-spin" /> : <TestTube2 />}刷新预览</Button>} /></CardHeader>
        <CardContent><RouteFieldPreview module={module} preview={preview} /></CardContent>
      </Card>
    </div>
  )
}
