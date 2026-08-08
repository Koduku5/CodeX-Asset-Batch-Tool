import { CheckCircle2, CloudCog, Eye, EyeOff, FolderOpen, LoaderCircle, Play, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { BatchApiStudio } from "@/features/prompt-studio/use-batch-api-studio"
import { SHEETS } from "@/features/workbench/workbench-foundation"

type BatchApiWorkspaceProps = {
  loading: boolean
  projectId: string | null
  studio: BatchApiStudio
}

export function BatchApiWorkspace({ loading, projectId, studio }: BatchApiWorkspaceProps) {
  const {
    activeApiPromptSheet, apiCatalog, apiDraft, apiModelId, apiOperation, apiOutputFolder,
    apiPasswordVisible, apiPromptTemplates, apiRedrawPrompt, apiRemoteProjectId, apiSourceFolder,
    chooseApiDirectory, connectApiCatalog, setActiveApiPromptSheet, setApiDraft, setApiModelId,
    setApiOperation, setApiPasswordVisible, setApiPromptTemplates, setApiRedrawPrompt,
    setApiRemoteProjectId, startApiBatch,
  } = studio

  return <>
    <Card>
      <CardHeader className="pb-3"><CardTitle className="text-base">Infinite Canvas API</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/20 p-1">
          <Button type="button" variant={apiOperation === "generate" ? "default" : "ghost"} onClick={() => setApiOperation("generate")}>资产批量出图</Button>
          <Button type="button" variant={apiOperation === "directory_redraw" ? "default" : "ghost"} onClick={() => setApiOperation("directory_redraw")}>文件夹批量修改</Button>
        </div>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
          <div className="space-y-2"><Label htmlFor="api-username">登录账号</Label><Input id="api-username" autoComplete="username" value={apiDraft.username} onChange={(event) => setApiDraft((value) => ({ ...value, username: event.target.value }))} /></div>
          <div className="space-y-2"><Label htmlFor="api-password">登录密码</Label><div className="relative"><Input id="api-password" type={apiPasswordVisible ? "text" : "password"} autoComplete="current-password" className="pr-10" value={apiDraft.password} onChange={(event) => setApiDraft((value) => ({ ...value, password: event.target.value }))} /><Button type="button" variant="ghost" size="icon-sm" className="absolute right-1 top-1" onClick={() => setApiPasswordVisible((visible) => !visible)} aria-label={apiPasswordVisible ? "隐藏密码" : "显示密码"}>{apiPasswordVisible ? <EyeOff /> : <Eye />}</Button></div></div>
          <div className="flex items-end"><Button type="button" className="w-full lg:w-auto" variant={apiCatalog ? "secondary" : "default"} onClick={() => void connectApiCatalog()} disabled={loading || !projectId}>{loading ? <LoaderCircle className="animate-spin" /> : apiCatalog ? <RefreshCw /> : <CloudCog />}{apiCatalog ? "刷新列表" : "连接账号并读取项目 / 模型"}</Button></div>
        </div>
        <details className="rounded-lg border bg-muted/15 px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium">高级：服务地址</summary>
          <div className="mt-3"><Input id="api-base-url" type="url" autoComplete="url" value={apiDraft.baseUrl} onChange={(event) => setApiDraft((value) => ({ ...value, baseUrl: event.target.value }))} /></div>
        </details>
        {apiCatalog ? (
          <div className="space-y-3 rounded-xl border border-primary/25 bg-primary/5 p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2"><Label>目标项目</Label><Select value={apiRemoteProjectId} onValueChange={setApiRemoteProjectId}><SelectTrigger className="w-full"><SelectValue placeholder="选择项目" /></SelectTrigger><SelectContent>{apiCatalog.projects.map((entry) => <SelectItem key={String(entry.id)} value={String(entry.id)}>{String(entry.name)}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-2"><Label>生图模型</Label><Select value={apiModelId} onValueChange={setApiModelId}><SelectTrigger className="w-full"><SelectValue placeholder="选择模型" /></SelectTrigger><SelectContent>{apiCatalog.models.map((entry) => <SelectItem key={String(entry.id)} value={String(entry.id)}>{String(entry.name)}</SelectItem>)}</SelectContent></Select></div>
            </div>
            <div className="flex items-center justify-end gap-1.5 text-xs font-medium text-primary"><CheckCircle2 className="size-3.5" />连接成功 · {apiCatalog.projects.length} 个项目 · {apiCatalog.models.length} 个生图模型</div>
          </div>
        ) : <p className="text-xs text-muted-foreground">连接后，真实项目和具备 image_generation 能力的模型会直接显示在这里。</p>}
      </CardContent>
    </Card>

    {apiOperation === "generate" ? (
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">API 提示词模板</CardTitle><p className="text-xs text-muted-foreground">每个资产实际发送的 prompt = 当前类别模板 + 累计资产中的正式制作说明。路由判断结果随队列记录并参与单项输入指纹。</p></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">{SHEETS.map((sheet) => <Button key={sheet} type="button" size="sm" variant={activeApiPromptSheet === sheet ? "default" : "outline"} onClick={() => setActiveApiPromptSheet(sheet)}>{sheet}</Button>)}</div>
          <div className="space-y-2"><Label htmlFor="api-prompt-template">{activeApiPromptSheet}模板</Label><Textarea id="api-prompt-template" rows={12} value={apiPromptTemplates?.[activeApiPromptSheet] ?? ""} onChange={(event) => setApiPromptTemplates((current) => ({ ...(current ?? Object.fromEntries(SHEETS.map((sheet) => [sheet, ""]))), [activeApiPromptSheet]: event.target.value }))} placeholder="正在从正式提示词注册表读取默认模板……" /></div>
          <div className="rounded-lg border bg-muted/20 px-3 py-2 text-xs text-muted-foreground"><span className="font-medium text-foreground">发送示意：</span>上述模板 + 当前资产制作说明 → POST /api/v1/ai/image-gen 的 prompt 字段。</div>
        </CardContent>
      </Card>
    ) : (
      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">文件夹批量修改</CardTitle><p className="text-xs text-muted-foreground">每张原图上传后，统一修改要求会作为 prompt，原图 URL 会作为 images 一起发送。</p></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Button type="button" variant="outline" className="justify-start" onClick={() => void chooseApiDirectory("source")}><FolderOpen />{apiSourceFolder ? `原图：${apiSourceFolder.name}` : "选择原图文件夹"}</Button>
            <Button type="button" variant="outline" className="justify-start" onClick={() => void chooseApiDirectory("output")}><FolderOpen />{apiOutputFolder ? `输出：${apiOutputFolder.name}` : "选择结果保存文件夹"}</Button>
          </div>
          <div className="space-y-2"><Label htmlFor="api-redraw-prompt">本批次统一修改要求</Label><Textarea id="api-redraw-prompt" rows={7} value={apiRedrawPrompt} onChange={(event) => setApiRedrawPrompt(event.target.value)} placeholder="例如：保留主体构图，将整体材质调整为写实金属，并统一冷色灯光。" /></div>
        </CardContent>
      </Card>
    )}

    <Card>
      <CardContent className="grid gap-4 p-4 sm:grid-cols-3">
        <div className="space-y-2"><Label htmlFor="api-workers">并发数量</Label><Input id="api-workers" type="number" min={1} max={16} inputMode="numeric" value={apiDraft.maxWorkers} onChange={(event) => setApiDraft((value) => ({ ...value, maxWorkers: event.target.value }))} /></div>
        <div className="space-y-2"><Label>画面比例</Label><Select value={apiDraft.aspectRatio} onValueChange={(aspectRatio) => setApiDraft((value) => ({ ...value, aspectRatio }))}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{["21:9", "16:9", "5:4", "4:3", "3:2", "1:1", "2:3", "3:4", "4:5", "9:16"].map((ratio) => <SelectItem key={ratio} value={ratio}>{ratio}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-2"><Label>图片尺寸</Label><Select value={apiDraft.imageSize} onValueChange={(imageSize) => setApiDraft((value) => ({ ...value, imageSize }))}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{["1K", "2K"].map((size) => <SelectItem key={size} value={size}>{size}</SelectItem>)}</SelectContent></Select></div>
      </CardContent>
    </Card>

    <div className="sticky bottom-0 -mx-5 flex items-center justify-between gap-3 border-t bg-background px-5 py-4">
      <p className="text-xs text-muted-foreground">开始后在后台建立并执行正式队列，不弹第二个配置窗口。</p>
      <Button onClick={() => void startApiBatch()} disabled={loading || !apiCatalog || !apiRemoteProjectId || !apiModelId || (apiOperation === "generate" && !apiPromptTemplates)}>{loading ? <LoaderCircle className="animate-spin" /> : <Play />}{apiOperation === "directory_redraw" ? "开始文件夹批量修改" : "开始 API 批量出图"}</Button>
    </div>
  </>
}
