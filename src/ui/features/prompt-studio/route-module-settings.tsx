import { Checkbox } from "@/components/ui/checkbox"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  ASSETS,
  REFERENCE_MODES,
  STYLES,
} from "@/features/workbench/workbench-constants"
import {
  SectionHeading,
} from "@/features/workbench/workbench-primitives"
import {
  type RouteModule,
} from "@/features/workbench/workbench-types"

export function RouteModuleSettings({ commitModule, module }: {
  commitModule: (next: RouteModule) => void
  module: RouteModule
}) {
  return (
    <Card>
      <CardHeader className="pb-3"><SectionHeading title="分支基本信息" description="Agent 会先按风格、资产类型和参考图方式筛选，再阅读下面的日常语言说明进行判断。" /></CardHeader>
      <CardContent className="space-y-4">
        <div className="max-w-xs space-y-2"><Label>资产类型</Label><Select value={module.scope.assets[0] || "scene"} onValueChange={(value) => commitModule({ ...module, scope: { ...module.scope, assets: [value] } })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{ASSETS.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-2"><Label>适用风格</Label><div className="flex flex-wrap gap-2">{STYLES.map((item) => <label key={item.id} className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs"><Checkbox checked={module.scope.styles.includes(item.id)} onCheckedChange={(checked) => commitModule({ ...module, scope: { ...module.scope, styles: checked ? [...new Set([...module.scope.styles, item.id])] : module.scope.styles.filter((value: string) => value !== item.id) } })} />{item.label}</label>)}</div></div>
        <div className="space-y-2"><Label>参考图方式</Label><div className="flex flex-wrap gap-2">{REFERENCE_MODES.map((item) => <label key={item.id} className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs"><Checkbox checked={module.scope.referenceModes.includes(item.id)} onCheckedChange={(checked) => commitModule({ ...module, scope: { ...module.scope, referenceModes: checked ? [...new Set([...module.scope.referenceModes, item.id])] : module.scope.referenceModes.filter((value: string) => value !== item.id) } })} />{item.label}</label>)}</div></div>
        <div className="space-y-2"><Label>分支名称</Label><Input aria-label="分支名称" value={module.displayName} onChange={(event) => commitModule({ ...module, displayName: event.target.value })} /></div>
        <div className="space-y-2"><Label>什么情况下使用这个分支（给 Agent 看）</Label><Textarea aria-label="分支使用条件" rows={4} value={module.classifier.definition} onChange={(event) => commitModule({ ...module, classifier: { ...module.classifier, definition: event.target.value } })} placeholder="例如：制作说明明确以树林、密集植被、林间路径或树冠层为主要场景……" /></div>
        <details className="rounded-lg border bg-muted/15 p-3"><summary className="cursor-pointer text-xs font-medium">高级判断设置</summary><div className="mt-4 grid gap-4 sm:grid-cols-2"><div className="space-y-2"><Label>同类分支组</Label><Input aria-label="同类分支组" value={module.family} onChange={(event) => commitModule({ ...module, family: event.target.value })} /><p className="text-[11px] text-muted-foreground">只用于告诉系统哪些分支在争夺同一个主要位置。</p></div><div className="space-y-2"><Label>多个分支都合适时</Label><Select value={module.classifier.selectionPolicy} onValueChange={(value) => commitModule({ ...module, classifier: { ...module.classifier, selectionPolicy: value } })}><SelectTrigger aria-label="多个分支都合适时"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="single-dominant">只选最主要分支</SelectItem><SelectItem value="stack-allowed">允许多个共同生效</SelectItem></SelectContent></Select></div><div className="space-y-2 sm:col-span-2"><Label>同时符合时如何选择</Label><Textarea aria-label="同时符合时如何选择" rows={3} value={module.classifier.tieBreak} onChange={(event) => commitModule({ ...module, classifier: { ...module.classifier, tieBreak: event.target.value } })} /></div><label className="flex items-center justify-between gap-3 rounded-lg border p-3 text-xs sm:col-span-2"><span><span className="block font-medium">没有明确命中时不使用</span><span className="mt-0.5 block text-muted-foreground">防止 Agent 为了凑答案强行选择分支。</span></span><Switch checked={module.classifier.noDefault} onCheckedChange={(checked) => commitModule({ ...module, classifier: { ...module.classifier, noDefault: checked } })} /></label></div></details>
      </CardContent>
    </Card>
  )
}
