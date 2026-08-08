import * as React from "react"
import {
  Copy,
  Download,
  FileText,
  LoaderCircle,
  Route,
  TestTube2,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { BatchApiWorkspace } from "@/features/prompt-studio/batch-api-workspace"
import { BatchBuiltinWorkspace } from "@/features/prompt-studio/batch-builtin-workspace"
import { BatchStudioToolbar } from "@/features/prompt-studio/batch-studio-toolbar"
import { RouteClassificationWorkspace } from "@/features/prompt-studio/route-classification-workspace"
import { RouteModuleList } from "@/features/prompt-studio/route-module-list"
import { RouteModuleSettings } from "@/features/prompt-studio/route-module-settings"
import { RouteOperationsWorkspace } from "@/features/prompt-studio/route-operations-workspace"
import { RoutePresetsPanel } from "@/features/prompt-studio/route-presets-panel"
import { RouteStudioDialogs } from "@/features/prompt-studio/route-studio-dialogs"
import { TemplateStudio } from "@/features/prompt-studio/template-studio"
import { useBatchStudio } from "@/features/prompt-studio/use-batch-studio"
import { useRouteStudio } from "@/features/prompt-studio/use-route-studio"
import { ValidationStudio } from "@/features/prompt-studio/validation-studio"

import {
  RoutePreset,
  ToastState,
  ACTIVE_PRESET_STORAGE_KEY,
  readStoredPresets,
  savePresets,
  PromptPresetContextValue,
  PromptPresetContext,
  readActivePresetId,
  EmptyState,
} from "@/features/workbench/workbench-foundation"

type DrawerProps = {
  className?: string
  open: boolean
  projectId: string | null
  projectName: string | null
  tab: string
  setTab: (tab: string) => void
  runTask: (action: string) => Promise<boolean>
  notify: (message: string, tone?: ToastState["tone"]) => void
  onClose: () => void
}

export const MemoPromptStudioDrawer = React.memo(PromptStudioDrawer)
const MemoBatchStudio = React.memo(BatchStudio)
const MemoRouteStudio = React.memo(RouteStudio)
const MemoTemplateStudio = React.memo(TemplateStudio)
const MemoValidationStudio = React.memo(ValidationStudio)

export function PromptStudioDrawer({ className, open, projectId, projectName, tab, setTab, runTask, notify, onClose }: DrawerProps) {
  const [presets, setPresets] = React.useState<RoutePreset[]>(() => readStoredPresets([]))
  const [activePresetId, setActivePresetId] = React.useState(readActivePresetId)
  const activePreset = presets.find((preset) => preset.id === activePresetId) ?? presets[0] ?? null
  React.useEffect(() => {
    if (presets.length && !presets.some((preset) => preset.id === activePresetId)) setActivePresetId(presets[0].id)
  }, [activePresetId, presets])
  React.useEffect(() => { if (presets.length) savePresets(presets) }, [presets])
  React.useEffect(() => {
    try { localStorage.setItem(ACTIVE_PRESET_STORAGE_KEY, activePreset?.id ?? "") } catch { /* keep session state */ }
  }, [activePreset?.id])
  const presetContext = React.useMemo<PromptPresetContextValue>(() => ({
    presets,
    setPresets,
    activePresetId: activePreset?.id ?? activePresetId,
    setActivePresetId,
    activePreset,
  }), [activePreset, activePresetId, presets])
  const modes = [
    { id: "batch", label: "本次批量", description: "出图范围与参考图", icon: WandSparkles },
    { id: "templates", label: "基础提示词", description: "查看通用字段", icon: FileText },
    { id: "routes", label: "路由 / 分支", description: "维护判断与追加词", icon: Route },
    { id: "validation", label: "单项检查", description: "解析并预览 Prompt", icon: TestTube2 },
  ]
  return (
    <PromptPresetContext.Provider value={presetContext}>
    <aside
      id="prompt-studio-drawer"
      role="dialog"
      aria-modal={open}
      aria-hidden={!open}
      data-open={open ? "true" : "false"}
      inert={!open}
      aria-label="Prompt Studio 工作区"
      tabIndex={-1}
      className={cn("flex min-w-0 flex-col overflow-visible bg-background outline-none", className)}
    >
      <div className="flex h-16 shrink-0 items-center justify-between gap-4 border-b px-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2"><WandSparkles className="size-4 text-primary" /><h2 className="truncate text-sm font-semibold">Prompt Studio</h2></div>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{projectName ?? "未选择项目"} · 开发者调试版</p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭 Prompt Studio"><X /></Button>
      </div>
      <Tabs value={tab} onValueChange={setTab} orientation="vertical" className="relative min-h-0 flex-1 gap-0 overflow-visible">
        <TabsList className="absolute top-4 -left-3 z-50 h-auto w-12 -translate-x-full justify-start gap-2 overflow-visible rounded-none bg-transparent p-0 shadow-none">
          {modes.map(({ id, label, description, icon: Icon }, index) => (
            <div key={id} className="group/nav-item relative h-12 w-12 flex-none">
              <TabsTrigger
                value={id}
                aria-label={`${label}：${description}`}
                className="absolute inset-y-0 right-0 h-12 min-h-12 w-12 justify-end gap-2 overflow-hidden rounded-xl border bg-popover px-2 py-2 text-right whitespace-normal shadow-panel transition-[width,color,box-shadow,background-color,border-color] duration-200 ease-standard sm:group-hover/nav-item:z-20 sm:group-hover/nav-item:w-52 sm:group-focus-within/nav-item:z-20 sm:group-focus-within/nav-item:w-52"
              >
                <span className="min-w-0 max-w-0 overflow-hidden opacity-0 transition-[max-width,opacity] duration-200 sm:group-hover/nav-item:max-w-36 sm:group-hover/nav-item:opacity-100 sm:group-focus-within/nav-item:max-w-36 sm:group-focus-within/nav-item:opacity-100">
                  <span className="block truncate text-xs font-semibold">{label}</span>
                  <span className="mt-0.5 block truncate text-[10px] font-normal text-muted-foreground">0{index + 1} · {description}</span>
                </span>
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"><Icon className="size-4" /></span>
              </TabsTrigger>
            </div>
          ))}
        </TabsList>
        <TabsContent value="batch" className="h-full min-h-0 overflow-hidden">
          <MemoBatchStudio projectId={projectId} runTask={runTask} notify={notify} />
        </TabsContent>
        <TabsContent value="templates" className="h-full min-h-0 overflow-hidden">
          <MemoTemplateStudio notify={notify} />
        </TabsContent>
        <TabsContent value="routes" className="h-full min-h-0 overflow-hidden">
          <MemoRouteStudio notify={notify} />
        </TabsContent>
        <TabsContent value="validation" className="h-full min-h-0 overflow-hidden">
          <MemoValidationStudio projectName={projectName} notify={notify} />
        </TabsContent>
      </Tabs>
    </aside>
    </PromptPresetContext.Provider>
  )
}

function BatchStudio({ projectId, runTask, notify }: { projectId: string | null; runTask: (action: string) => Promise<boolean>; notify: DrawerProps["notify"] }) {
  const studio = useBatchStudio({ notify, projectId, runTask })
  const {
    apiStudio, backend, builtinStudio, changeStyle, generationLimit, handoff, loading,
    setBackend, setGenerationLimit, style,
  } = studio

  return (
    <ScrollArea className="h-full">
      <div className="space-y-5 p-5">
        <BatchStudioToolbar
          backend={backend}
          generationLimit={generationLimit}
          handoff={handoff}
          onBackendChange={setBackend}
          onGenerationLimitChange={setGenerationLimit}
          onStyleChange={changeStyle}
          style={style}
        />

        {backend === "builtin"
          ? <BatchBuiltinWorkspace studio={builtinStudio} />
          : <BatchApiWorkspace loading={loading} projectId={projectId} studio={apiStudio} />}
      </div>

    </ScrollArea>
  )
}

function RouteStudio({ notify }: { notify: DrawerProps["notify"] }) {
  const controller = useRouteStudio({ notify })
  const {
    busy, catalogStatus, classificationStudio, commitModule, dialogStudio, duplicateBranch,
    exportCurrentBranch, module, moduleListStudio, presetsPanelStudio, preview, resolvePreview,
    saveFormal, setDeleteBranchOpen, validateBranch,
  } = controller

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <RoutePresetsPanel studio={presetsPanelStudio} />
      <div className="grid min-h-0 grid-cols-[210px_minmax(0,1fr)]">
        <RouteModuleList studio={moduleListStudio} />
        <ScrollArea className="h-full">
          {module ? (
            <div className="space-y-5 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><h3 className="text-base font-semibold">{module.displayName}</h3><p className="mt-1 font-mono text-[10px] text-muted-foreground">唯一编号：{module.id}</p></div>
                <div className="flex gap-2"><Button variant="outline" size="sm" onClick={duplicateBranch}><Copy />复制当前分支来改</Button><Button variant="outline" size="sm" onClick={() => void exportCurrentBranch()}><Download />导出当前分支</Button><Button variant="destructive" size="sm" onClick={() => setDeleteBranchOpen(true)}><Trash2 />删除</Button></div>
              </div>

              <RouteModuleSettings module={module} commitModule={commitModule} />

              <RouteOperationsWorkspace
                busy={busy}
                commitModule={commitModule}
                module={module}
                preview={preview}
                resolvePreview={resolvePreview}
              />

              <RouteClassificationWorkspace
                busy={busy}
                module={module}
                notify={notify}
                studio={classificationStudio}
              />

              <div className="sticky bottom-0 -mx-5 flex justify-end gap-2 border-t bg-background px-5 py-4"><Button variant="outline" onClick={validateBranch}>校验分支</Button><Button onClick={() => void saveFormal()} disabled={busy || !catalogStatus || catalogStatus.readOnly}>{busy && <LoaderCircle className="animate-spin" />}写入正式提示词库</Button></div>
            </div>
          ) : <div className="grid h-full place-items-center p-8"><EmptyState icon={Route}>新建或导入一个路由分支后开始编辑</EmptyState></div>}
        </ScrollArea>
      </div>

      <RouteStudioDialogs studio={dialogStudio} />
    </div>
  )
}
