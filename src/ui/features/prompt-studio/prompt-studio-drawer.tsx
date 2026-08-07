import * as React from "react"
import {
  Boxes,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  CloudCog,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  ImagePlus,
  LoaderCircle,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Route,
  Save,
  Sparkles,
  TestTube2,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { RouteFieldPreview } from "@/features/prompt-studio/route-field-preview"
import { TemplateStudio } from "@/features/prompt-studio/template-studio"
import { ValidationStudio } from "@/features/prompt-studio/validation-studio"
import {
  normalizeTemplateFieldOrder,
} from "@/features/prompt-studio/template-field-order.mjs"
import {
  readTemplateDraft,
  templateDraftRecords,
} from "@/features/prompt-studio/template-drafts.mjs"

import {
  formatPromptText,
} from "@/services/catalog-adapter.mjs"
import { paginateAssets } from "@/services/list-model.mjs"
import {
  DEFAULT_ALLOWED_TARGET_FIELDS,
  DEFAULT_CONTROL_DIMENSIONS,
  applyModuleOperationsPreview,
  buildClassificationRequest,
  createRouteBranchFile,
  createRoutePresetPackage,
  normalizeRouteModule,
  parseRouteExchangeArtifact,
  routeModulesEqual,
  validateRouteModule,
} from "@/services/route-module-workbench.mjs"

import {
  JsonRecord,
  RouteModule,
  RoutePreset,
  PendingRouteImport,
  ToastState,
  batchAdapter,
  catalogAdapter,
  imagegenAdapter,
  routeAdminAdapter,
  routeClassifierAdapter,
  STYLES,
  ASSETS,
  SHEETS,
  REFERENCE_MODES,
  OPERATION_LABELS,
  ACTIVE_PRESET_STORAGE_KEY,
  ROUTE_LIST_PAGE_SIZE,
  nowIso,
  safeMessage,
  styleLabel,
  assetLabel,
  formatCount,
  uniqueId,
  clone,
  routeModulesFromCatalogSummary,
  withoutRetiredCatalogEnhancers,
  readStoredPresets,
  savePresets,
  blankReferenceSelections,
  blankReferenceModes,
  blankCustomReferenceFields,
  readBatchCustomFields,
  writeBatchCustomFields,
  routePresetModulesEqual,
  routePresetNameKey,
  PromptPresetContextValue,
  PromptPresetContext,
  usePromptPresets,
  readActivePresetId,
  downloadJson,
  StatusDot,
  SectionHeading,
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
  const { activePreset } = usePromptPresets()
  const [style, setStyle] = React.useState("anime")
  const [backend, setBackend] = React.useState("builtin")
  const [generationLimit, setGenerationLimit] = React.useState("5")
  const [enabledSheets, setEnabledSheets] = React.useState<string[]>([...SHEETS])
  const [activeSheet, setActiveSheet] = React.useState<string>("角色")
  const [referenceModeBySheet, setReferenceModeBySheet] = React.useState<Record<string, string>>(blankReferenceModes)
  const [references, setReferences] = React.useState<JsonRecord[]>([])
  const [selectedReferenceIdsBySheet, setSelectedReferenceIdsBySheet] = React.useState<Record<string, string[]>>(blankReferenceSelections)
  const [customFieldsBySheet, setCustomFieldsBySheet] = React.useState<JsonRecord>(blankCustomReferenceFields)
  const [previewReferenceId, setPreviewReferenceId] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [apiAccessDialogOpen, setApiAccessDialogOpen] = React.useState(false)
  const [apiAccessUsername, setApiAccessUsername] = React.useState("")
  const [apiAccessPassword, setApiAccessPassword] = React.useState("")
  const [apiAccessError, setApiAccessError] = React.useState("")
  const [apiDialogOpen, setApiDialogOpen] = React.useState(false)
  const [apiPasswordVisible, setApiPasswordVisible] = React.useState(false)
  const [apiDraft, setApiDraft] = React.useState({
    baseUrl: "https://canvas.dopamine.video",
    username: "",
    password: "",
    maxWorkers: "2",
    aspectRatio: "1:1",
    imageSize: "1K",
  })
  const [apiCatalog, setApiCatalog] = React.useState<{ baseUrl: string; projects: JsonRecord[]; models: JsonRecord[] } | null>(null)
  const [apiRemoteProjectId, setApiRemoteProjectId] = React.useState("")
  const [apiModelId, setApiModelId] = React.useState("")
  const [apiOperation, setApiOperation] = React.useState<"generate" | "directory_redraw">("generate")
  const [apiSourceFolder, setApiSourceFolder] = React.useState<{ selectionToken: string; name: string } | null>(null)
  const [apiOutputFolder, setApiOutputFolder] = React.useState<{ selectionToken: string; name: string } | null>(null)
  const [apiRedrawPrompt, setApiRedrawPrompt] = React.useState("")
  const [apiPromptTemplates, setApiPromptTemplates] = React.useState<Record<string, string> | null>(null)
  const [activeApiPromptSheet, setActiveApiPromptSheet] = React.useState<string>("角色")
  const [handoff, setHandoff] = React.useState<JsonRecord | null>(null)
  const uploadRef = React.useRef<HTMLInputElement>(null)
  const uploadInFlightRef = React.useRef(false)
  const uploadContextRef = React.useRef({ projectId, style, activeSheet })

  React.useEffect(() => {
    uploadContextRef.current = { projectId, style, activeSheet }
  }, [activeSheet, projectId, style])

  React.useEffect(() => {
    setApiCatalog(null)
    setApiRemoteProjectId("")
    setApiModelId("")
  }, [apiDraft.baseUrl, apiDraft.password, apiDraft.username])

  React.useEffect(() => {
    if (backend !== "api" || apiPromptTemplates) return
    void catalogAdapter.getApiDefaultTemplates()
      .then((templates: JsonRecord) => setApiPromptTemplates(Object.fromEntries(SHEETS.map((sheet) => [sheet, String(templates[sheet] ?? "")]))))
      .catch((error: unknown) => notify(safeMessage(error, "API 提示词模板读取失败"), "error"))
  }, [apiPromptTemplates, backend, notify])

  const reloadReferences = React.useCallback(async () => {
    if (!projectId) return
    try {
      setReferences(await batchAdapter.listReferences({ projectId }))
    } catch (error) {
      notify(safeMessage(error, "参考图读取失败"), "error")
    }
  }, [notify, projectId])

  const reloadHandoff = React.useCallback(async () => {
    if (!projectId) return
    try { setHandoff(await imagegenAdapter.getStatus({ projectId })) }
    catch { setHandoff(null) }
  }, [projectId])

  const reloadSavedBatch = React.useCallback(async () => {
    if (!projectId) return
    try {
      const saved = await batchAdapter.getBuiltinBatch({ projectId })
      if (!saved) return
      setStyle(saved.styleId)
      setGenerationLimit(String(saved.generationLimit))
      setEnabledSheets(saved.enabledSheets)
      const restoredSelections = { ...blankReferenceSelections(), ...(saved.selectedReferenceIdsBySheet ?? {}) }
      setSelectedReferenceIdsBySheet(restoredSelections)
      setReferenceModeBySheet(Object.fromEntries(SHEETS.map((sheet) => [
        sheet,
        restoredSelections[sheet]?.length
          ? String(saved.referenceModeBySheet[sheet] ?? "style").replaceAll("_", "-")
          : "none",
      ])))
      setCustomFieldsBySheet(readBatchCustomFields(projectId, saved.styleId))
    } catch (error) {
      notify(safeMessage(error, "已保存的批次配置读取失败"), "warning")
    }
  }, [notify, projectId])

  React.useEffect(() => {
    setSelectedReferenceIdsBySheet(blankReferenceSelections())
    setReferenceModeBySheet(blankReferenceModes())
    setCustomFieldsBySheet(readBatchCustomFields(projectId, style))
    setPreviewReferenceId(null)
    void reloadReferences()
    void reloadHandoff()
  }, [projectId, reloadHandoff, reloadReferences])
  React.useEffect(() => { void reloadSavedBatch() }, [reloadSavedBatch])
  React.useEffect(() => {
    if (projectId) writeBatchCustomFields(projectId, style, customFieldsBySheet)
  }, [customFieldsBySheet, projectId, style])

  const visibleReferences = references.filter((entry) => entry.styleId === style && entry.sheetName === activeSheet)
  const selectedReferenceIds = selectedReferenceIdsBySheet[activeSheet] ?? []
  const activePreviewReference = visibleReferences.find((entry) => entry.referenceId === previewReferenceId)
    ?? visibleReferences.find((entry) => selectedReferenceIds.includes(entry.referenceId))
    ?? visibleReferences[0]
    ?? null
  const changeStyle = (value: string) => {
    setStyle(value)
    setSelectedReferenceIdsBySheet(blankReferenceSelections())
    setReferenceModeBySheet(blankReferenceModes())
    setCustomFieldsBySheet(readBatchCustomFields(projectId, value))
    setPreviewReferenceId(null)
  }
  const changeReferenceMode = (value: string) => {
    setReferenceModeBySheet((current) => ({ ...current, [activeSheet]: value }))
    if (value === "none") {
      setSelectedReferenceIdsBySheet((current) => ({ ...current, [activeSheet]: [] }))
    }
  }
  const toggleSheet = (sheet: string, checked: boolean) => {
    setEnabledSheets((current) => checked ? SHEETS.filter((item) => current.includes(item) || item === sheet) : current.filter((item) => item !== sheet))
  }
  const toggleReferenceSelection = (referenceId: string, checked: boolean) => {
    const nextIds = checked
      ? [...new Set([...selectedReferenceIds, referenceId])]
      : selectedReferenceIds.filter((id) => id !== referenceId)
    setSelectedReferenceIdsBySheet((current) => ({
      ...current,
      [activeSheet]: nextIds,
    }))
    if (checked && referenceModeBySheet[activeSheet] === "none") {
      setReferenceModeBySheet((current) => ({ ...current, [activeSheet]: "style" }))
    } else if (!nextIds.length) {
      setReferenceModeBySheet((current) => ({ ...current, [activeSheet]: "none" }))
    }
    if (checked) setPreviewReferenceId(referenceId)
  }

  const uploadReferences = async (files: FileList | File[]) => {
    const pendingFiles = Array.from(files)
    if (!projectId || !pendingFiles.length) return
    if (uploadInFlightRef.current) {
      notify("上一批参考图仍在上传，请稍候", "warning")
      return
    }
    uploadInFlightRef.current = true
    const context = { projectId, style, activeSheet }
    const uploaded: JsonRecord[] = []
    const failed: { file: File; error: unknown }[] = []
    setLoading(true)
    try {
      for (const file of pendingFiles) {
        try {
          uploaded.push(await batchAdapter.uploadReference({
            projectId: context.projectId,
            styleId: context.style,
            sheetName: context.activeSheet,
            file,
          }))
        } catch (error) {
          failed.push({ file, error })
        }
      }
      const latestContext = uploadContextRef.current
      if (latestContext.projectId !== context.projectId) return
      await reloadReferences()
      if (uploaded.length && latestContext.style === context.style) {
        const uploadedIds = uploaded.map((entry) => entry.referenceId)
        setReferenceModeBySheet((current) => ({
          ...current,
          [context.activeSheet]: current[context.activeSheet] === "none" ? "style" : current[context.activeSheet],
        }))
        setSelectedReferenceIdsBySheet((current) => ({
          ...current,
          [context.activeSheet]: [...new Set([...(current[context.activeSheet] ?? []), ...uploadedIds])],
        }))
        if (latestContext.activeSheet === context.activeSheet) setPreviewReferenceId(uploaded.at(-1)!.referenceId)
      }
      if (failed.length) {
        const details = failed.slice(0, 3).map(({ file, error }) => `${file.name}（${safeMessage(error, "上传失败")}）`).join("、")
        const suffix = failed.length > 3 ? `等 ${failed.length} 张` : ""
        notify(`参考图成功 ${uploaded.length} 张，失败 ${failed.length} 张：${details}${suffix}`, uploaded.length ? "warning" : "error")
      } else {
        notify(`${pendingFiles.length} 张参考图已添加到${context.activeSheet}`)
      }
    } finally {
      uploadInFlightRef.current = false
      setLoading(false)
      if (uploadRef.current) uploadRef.current.value = ""
    }
  }

  const removeReference = async (referenceId: string) => {
    if (!projectId) return
    const removedSheet = references.find((entry) => entry.referenceId === referenceId)?.sheetName
    const removesLastSelected = Boolean(removedSheet)
      && (selectedReferenceIdsBySheet[removedSheet] ?? []).includes(referenceId)
      && (selectedReferenceIdsBySheet[removedSheet] ?? []).length === 1
    setLoading(true)
    try {
      await batchAdapter.removeReference({ projectId, referenceId })
      setSelectedReferenceIdsBySheet((current) => Object.fromEntries(Object.entries(current).map(([sheet, ids]) => [sheet, ids.filter((id) => id !== referenceId)])))
      if (removedSheet && removesLastSelected) {
        setReferenceModeBySheet((current) => ({ ...current, [removedSheet]: "none" }))
      }
      setPreviewReferenceId((current) => current === referenceId ? null : current)
      await reloadReferences()
      notify("参考图已删除")
    } catch (error) {
      notify(safeMessage(error, "参考图删除失败"), "error")
    } finally { setLoading(false) }
  }

  const saveBatch = async () => {
    if (!projectId || !enabledSheets.length) return false
    if (backend !== "builtin") return false
    setLoading(true)
    try {
      const referenceIdsBySheet = Object.fromEntries(SHEETS.map((sheet) => [sheet, references
        .filter((entry) => referenceModeBySheet[sheet] !== "none" && entry.styleId === style && entry.sheetName === sheet && (selectedReferenceIdsBySheet[sheet] ?? []).includes(entry.referenceId))
        .map((entry) => entry.referenceId)]))
      const normalizedReferenceModeBySheet = Object.fromEntries(SHEETS.map((sheet) => [
        sheet,
        referenceIdsBySheet[sheet].length ? referenceModeBySheet[sheet] : "style",
      ]))
      for (const sheet of enabledSheets) {
        const count = referenceIdsBySheet[sheet].length
        const mode = normalizedReferenceModeBySheet[sheet]
        if (mode === "visual-consistency" && count < 2) {
          throw new Error(`【${sheet}】视觉一致至少需要选择两张参考图`)
        }
        if (mode === "custom" && count > 0) {
          const custom = customFieldsBySheet[sheet]
          if (!custom?.inputImages?.trim() || !custom?.primaryRequest?.trim()) {
            throw new Error(`【${sheet}】自定义参考图方式必须填写 Input images 和 Primary request`)
          }
        }
      }
      const promptOverridesBySheet = Object.fromEntries(await Promise.all(SHEETS.map(async (sheet) => {
        const assetId = ASSETS.find((entry) => entry.label === sheet)?.id ?? ""
        const count = referenceIdsBySheet[sheet].length
        const mode = count ? normalizedReferenceModeBySheet[sheet] : "none"
        const draft = readTemplateDraft(activePreset?.templates, style, assetId, mode)
        const hasCustomFields = mode === "custom" && count > 0
        if (!draft && !hasCustomFields) return [sheet, null]
        const resolved = await catalogAdapter.resolve({ style, asset: assetId, referenceMode: mode, referenceCount: count })
        const formalLabels = new Set(resolved.promptFields.map((field: JsonRecord) => String(field.label)))
        const orderedFields = normalizeTemplateFieldOrder(resolved.promptFields, draft?.promptFields)
        const customFields = orderedFields.filter((field: JsonRecord) => !formalLabels.has(String(field.label)))
        const custom = customFieldsBySheet[sheet]
        const promptFields = orderedFields.map((field: JsonRecord) => ({
          ...field,
          value: hasCustomFields && field.label === "Input images"
            ? custom.inputImages
            : hasCustomFields && field.label === "Primary request"
              ? custom.primaryRequest
              : field.value,
        }))
        return [sheet, {
          routeMode: count ? "reference" : "default",
          promptText: promptFields.map((field: JsonRecord) => `${field.label}: ${field.value}`).join("\n"),
          ...(customFields.length ? { customFieldLabels: customFields.map((field: JsonRecord) => field.label) } : {}),
        }]
      })))
      const configuration = {
        version: 1,
        styleId: style,
        generationLimit: Number(generationLimit),
        enabledSheets,
        referenceModeBySheet: normalizedReferenceModeBySheet,
        referenceIdsBySheet,
        promptOverridesBySheet,
      }
      await batchAdapter.saveBuiltinBatch({ projectId, configuration })
      notify("批量出图配置已写入当前项目")
      await reloadHandoff()
      return true
    } catch (error) {
      notify(safeMessage(error, "批量配置保存失败"), "error")
      return false
    } finally { setLoading(false) }
  }

  const saveAndBuildFinalQueue = async () => {
    if (await saveBatch()) await runTask("classify-prompt-branches")
  }

  const connectApiCatalog = async () => {
    if (!projectId) return
    const loadCatalog = window.kaDesktopBridge?.loadApiCatalog
    if (typeof loadCatalog !== "function") {
      notify("当前桌面版本没有接入无限画板登录能力", "warning")
      return
    }
    const baseUrl = apiDraft.baseUrl.trim()
    const username = apiDraft.username.trim()
    if (!baseUrl || !username || !apiDraft.password) {
      notify("请先填写服务地址、登录账号和密码", "warning")
      return
    }
    setLoading(true)
    try {
      const response = await loadCatalog({
        projectId,
        baseUrl,
        username,
        password: apiDraft.password,
      })
      const projects = Array.isArray(response?.data?.projects) ? response.data.projects : []
      const models = Array.isArray(response?.data?.models) ? response.data.models : []
      if (response?.ok !== true || response?.data?.projectId !== projectId || !projects.length || !models.length) {
        throw new Error(response?.error?.message || "没有读取到可用项目或生图模型")
      }
      setApiCatalog({ baseUrl: response.data.baseUrl, projects, models })
      setApiRemoteProjectId(String(projects[0].id))
      setApiModelId(String(models[0].id))
      notify(`连接成功：读取到 ${projects.length} 个项目、${models.length} 个生图模型`)
    } catch (error) {
      notify(safeMessage(error, "无限画板登录失败"), "error")
    } finally {
      setLoading(false)
    }
  }

  const chooseApiDirectory = async (purpose: "source" | "output") => {
    const chooseDirectory = window.kaDesktopBridge?.selectApiDirectory
    if (typeof chooseDirectory !== "function") {
      notify("当前桌面版本没有文件夹选择能力", "warning")
      return
    }
    try {
      const response = await chooseDirectory({ purpose })
      if (response?.ok !== true) throw new Error(response?.error?.message || "文件夹选择失败")
      if (response.data?.canceled) return
      const selected = {
        selectionToken: String(response.data?.selectionToken || ""),
        name: String(response.data?.name || "已选择文件夹"),
      }
      if (!selected.selectionToken) throw new Error("文件夹选择结果无效")
      if (purpose === "source") setApiSourceFolder(selected)
      else setApiOutputFolder(selected)
    } catch (error) {
      notify(safeMessage(error, "文件夹选择失败"), "error")
    }
  }

  const startApiBatch = async () => {
    if (!projectId || !apiCatalog) {
      notify("请先连接账号并读取项目与模型", "warning")
      return
    }
    const startBatch = window.kaDesktopBridge?.startApiBatch
    if (typeof startBatch !== "function") {
      notify("当前桌面版本没有无限画板后台执行能力", "warning")
      return
    }
    const maxWorkers = Number.parseInt(apiDraft.maxWorkers, 10)
    if (!apiRemoteProjectId || !apiModelId) {
      notify("请选择目标项目和生图模型", "warning")
      return
    }
    if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 16) {
      notify("并发数量必须是 1–16", "warning")
      return
    }
    if (apiOperation === "directory_redraw" && (!apiSourceFolder || !apiOutputFolder || !apiRedrawPrompt.trim())) {
      notify("批量修改需要选择原图、输出文件夹并填写统一修改要求", "warning")
      return
    }
    if (apiOperation === "generate" && (!apiPromptTemplates || SHEETS.some((sheet) => !apiPromptTemplates[sheet]?.trim()))) {
      notify("五类 API 提示词模板必须全部填写", "warning")
      return
    }
    setLoading(true)
    try {
      const response = await startBatch({
        projectId,
        baseUrl: apiCatalog.baseUrl,
        username: apiDraft.username.trim(),
        password: apiDraft.password,
        remoteProjectId: apiRemoteProjectId,
        modelId: apiModelId,
        maxWorkers,
        aspectRatio: apiDraft.aspectRatio,
        imageSize: apiDraft.imageSize,
        operation: apiOperation,
        ...(apiOperation === "generate" ? { promptTemplates: apiPromptTemplates! } : {}),
        ...(apiOperation === "directory_redraw" ? {
          sourceSelectionToken: apiSourceFolder!.selectionToken,
          outputSelectionToken: apiOutputFolder!.selectionToken,
          redrawPrompt: apiRedrawPrompt.trim(),
        } : {}),
      })
      if (response?.ok !== true || response?.data?.projectId !== projectId || response?.data?.started !== true) {
        throw new Error(response?.error?.message || "任务没有成功启动")
      }
      setBackend("api")
      setApiDialogOpen(false)
      notify(apiOperation === "directory_redraw" ? "文件夹批量修改已在后台启动" : "Infinite Canvas API 批量出图已在后台启动")
    } catch (error) {
      notify(safeMessage(error, "无限画板任务启动失败"), "error")
    } finally {
      setLoading(false)
    }
  }

  const prepareImagegen = async () => {
    if (!projectId) return
    setLoading(true)
    try {
      const prepared = await imagegenAdapter.prepare({ projectId })
      notify(prepared.codexOpened
        ? "Codex 已打开；在任意新任务中粘贴交接指令，调度 Skill 会自动新建或复用项目出图任务"
        : "交接指令已复制；请手动打开 Codex，并在任意新任务中粘贴")
      await reloadHandoff()
    } catch (error) {
      notify(safeMessage(error, "请先建立队列，并在桌面版中执行 ImageGen 交接"), "warning")
    } finally { setLoading(false) }
  }

  const changeBackend = (nextBackend: string) => {
    if (nextBackend !== "api") {
      setBackend(nextBackend)
      return
    }
    setApiAccessUsername("")
    setApiAccessPassword("")
    setApiAccessError("")
    setApiAccessDialogOpen(true)
  }

  const confirmApiBackendAccess = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (apiAccessUsername.trim() !== "admin" || apiAccessPassword !== "123") {
      setApiAccessError("账号或密码错误，无法使用 Infinite Canvas API。")
      return
    }
    setBackend("api")
    setApiAccessPassword("")
    setApiAccessError("")
    setApiAccessDialogOpen(false)
  }

  return (
    <ScrollArea className="h-full">
      <div className="space-y-5 p-5">
        <Card>
          <CardContent className="space-y-3 p-3">
            <div className="flex min-w-0 flex-wrap items-center gap-x-8 gap-y-2">
              <div className="flex items-center gap-2"><Label className="shrink-0 whitespace-nowrap">制作风格</Label><Select value={style} onValueChange={changeStyle}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent>{STYLES.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></div>
              {backend === "builtin" && <div className="flex items-center gap-2"><Label className="shrink-0 whitespace-nowrap">出图限制数量</Label><Select value={generationLimit} onValueChange={setGenerationLimit}><SelectTrigger className="w-32"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="5">最多 5 张</SelectItem><SelectItem value="10">最多 10 张</SelectItem><SelectItem value="0">全部资产</SelectItem></SelectContent></Select></div>}
              <div className="flex items-center gap-2"><Label className="shrink-0 whitespace-nowrap">出图后端</Label><Select value={backend} onValueChange={changeBackend}><SelectTrigger className="w-52"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="builtin">Codex 内置 ImageGen</SelectItem><SelectItem value="api">Infinite Canvas API</SelectItem></SelectContent></Select></div>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 text-xs">
              <span className="font-medium">队列状态</span>
              <StatusDot state={handoff?.status === "active" ? "active" : handoff?.status === "ready" ? "complete" : "waiting"} />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{handoff?.message ?? "等待批次配置与队列"}</span>
              <Badge variant="outline" className="shrink-0">{formatCount(handoff?.counts?.pending)} 待处理</Badge>
            </div>
          </CardContent>
        </Card>

        {backend === "builtin" ? (<>
        <section>
          <SectionHeading title="本次生成类别" description="勾选是否生成；点击类别名称切换该类参考图。" />
          <div className="mt-3 flex flex-wrap gap-2">
            {SHEETS.map((sheet) => (
              <div key={sheet} className={cn("flex items-center rounded-lg border bg-background transition-colors", activeSheet === sheet && "border-primary/55 bg-primary/7 ring-2 ring-primary/10")}>
                <Checkbox className="ml-3" checked={enabledSheets.includes(sheet)} onCheckedChange={(checked) => toggleSheet(sheet, checked === true)} aria-label={`${enabledSheets.includes(sheet) ? "取消" : "启用"}${sheet}出图`} />
                <button type="button" onClick={() => { setActiveSheet(sheet); setPreviewReferenceId(null) }} className="px-2.5 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{sheet}</button>
              </div>
            ))}
          </div>
        </section>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div><CardTitle className="text-sm">参考图 · {activeSheet}</CardTitle><p className="mt-1 text-xs text-muted-foreground">每个资产类别独立保存自己的参考图。</p></div>
              <div className="flex items-center gap-2"><Label className="whitespace-nowrap">参考图方式</Label><Select value={referenceModeBySheet[activeSheet]} onValueChange={changeReferenceMode}><SelectTrigger className="w-40"><SelectValue /></SelectTrigger><SelectContent>{REFERENCE_MODES.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select><Badge variant="secondary">{selectedReferenceIds.length} 张已选</Badge></div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <input ref={uploadRef} type="file" accept="image/png,image/jpeg,image/webp,image/bmp" multiple className="sr-only" aria-label={`上传${activeSheet}参考图`} onChange={(event) => void uploadReferences(event.currentTarget.files ?? [])} />
            <div className="grid min-w-0 gap-3 lg:grid-cols-[15rem_minmax(0,1fr)]">
              <div className="space-y-2">
                <div className="max-h-72 space-y-1 overflow-y-auto rounded-lg border bg-muted/10 p-1.5">
                  {visibleReferences.map((entry) => {
                    const selected = selectedReferenceIds.includes(entry.referenceId)
                    return (
                      <div key={entry.referenceId} className={cn("flex items-center gap-1 rounded-md border border-transparent px-1.5 py-1", activePreviewReference?.referenceId === entry.referenceId && "border-border bg-background")}>
                        <Checkbox checked={selected} onCheckedChange={(checked) => toggleReferenceSelection(entry.referenceId, checked === true)} aria-label={`${selected ? "取消选择" : "选择"}${entry.sourceName}`} />
                        <button type="button" onClick={() => setPreviewReferenceId(entry.referenceId)} className="min-w-0 flex-1 truncate px-1 py-1 text-left text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{entry.sourceName}</button>
                        <Button variant="ghost" size="icon-sm" onClick={() => void removeReference(entry.referenceId)} aria-label={`删除 ${entry.sourceName}`}><Trash2 /></Button>
                      </div>
                    )
                  })}
                  {!visibleReferences.length && <p className="px-2 py-8 text-center text-[11px] text-muted-foreground">{styleLabel(style)} · {activeSheet} 暂无文件</p>}
                </div>
              </div>
              <button type="button" onClick={() => uploadRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void uploadReferences(event.dataTransfer.files) }} disabled={loading || !projectId} className="group relative grid min-h-64 place-items-center overflow-hidden rounded-xl border border-dashed bg-muted/20 text-muted-foreground transition-colors hover:border-primary/55 hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-55">
                {activePreviewReference && projectId
                  ? <img src={batchAdapter.referenceContentUrl({ projectId, referenceId: activePreviewReference.referenceId })} alt={activePreviewReference.sourceName} className="max-h-80 size-full object-contain" />
                  : <div className="px-6 text-center text-xs"><ImagePlus className="mx-auto mb-2 size-6" />点击可多选图片，或一次拖入多张参考图</div>}
                {activePreviewReference && <span className="pointer-events-none absolute right-2 bottom-2 rounded-md bg-background/90 px-2 py-1 text-[10px] opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">点击多选，或拖入多张新参考图</span>}
              </button>
            </div>
            {referenceModeBySheet[activeSheet] === "custom" && (
              <div className="grid gap-3 rounded-xl border border-primary/25 bg-primary/5 p-3 sm:grid-cols-2">
                <div className="space-y-2"><Label htmlFor={`custom-input-images-${activeSheet}`}>Input images</Label><Textarea id={`custom-input-images-${activeSheet}`} rows={4} value={customFieldsBySheet[activeSheet]?.inputImages ?? ""} onChange={(event) => setCustomFieldsBySheet((current: JsonRecord) => ({ ...current, [activeSheet]: { ...current[activeSheet], inputImages: event.target.value } }))} placeholder={selectedReferenceIds.length ? selectedReferenceIds.map((_, index) => `图像 ${index + 1}：`).join("\n") : "先添加参考图，再说明每张图片的用途"} /></div>
                <div className="space-y-2"><Label htmlFor={`custom-primary-request-${activeSheet}`}>Primary request</Label><Textarea id={`custom-primary-request-${activeSheet}`} rows={4} value={customFieldsBySheet[activeSheet]?.primaryRequest ?? ""} onChange={(event) => setCustomFieldsBySheet((current: JsonRecord) => ({ ...current, [activeSheet]: { ...current[activeSheet], primaryRequest: event.target.value } }))} placeholder="说明 ImageGen 应如何使用这些参考图" /></div>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="sticky bottom-0 -mx-5 flex flex-wrap items-center justify-end gap-2 border-t bg-background px-5 py-4">
          <Button variant="outline" onClick={() => void saveBatch()} disabled={loading || !projectId || !enabledSheets.length}><Save />保存批次配置</Button>
          <Button variant="secondary" onClick={() => void saveAndBuildFinalQueue()} disabled={loading || !projectId}><Boxes />判断分支并建立最终队列</Button>
          <Button onClick={() => void prepareImagegen()} disabled={loading || !projectId}><Sparkles />交给内置 ImageGen</Button>
        </div>
        </>) : (<>
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
                <div className="flex items-end"><Button type="button" className="w-full lg:w-auto" variant={apiCatalog ? "secondary" : "default"} onClick={() => void connectApiCatalog()} disabled={loading || !projectId}>{loading ? <LoaderCircle className="animate-spin" /> : apiCatalog ? <RefreshCw /> : <CloudCog />}{apiCatalog ? "刷新列表" : "连接账号"}</Button></div>
              </div>
              <details className="rounded-lg border bg-muted/15 px-3 py-2">
                <summary className="cursor-pointer text-xs font-medium">高级：服务地址</summary>
                <div className="mt-3"><Input type="url" autoComplete="url" value={apiDraft.baseUrl} onChange={(event) => setApiDraft((value) => ({ ...value, baseUrl: event.target.value }))} /></div>
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
        </>)}
      </div>

      <Dialog open={apiAccessDialogOpen} onOpenChange={(open) => {
        setApiAccessDialogOpen(open)
        if (!open) {
          setApiAccessPassword("")
          setApiAccessError("")
        }
      }}>
        <DialogContent className="sm:max-w-sm">
          <form className="space-y-4" onSubmit={confirmApiBackendAccess}>
            <DialogHeader>
              <DialogTitle>验证 Infinite Canvas API 使用权限</DialogTitle>
              <DialogDescription>这是软件内的后端使用权限验证，不是 Infinite Canvas 服务账号。</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="api-access-username">账号</Label>
              <Input id="api-access-username" autoComplete="username" autoFocus value={apiAccessUsername} onChange={(event) => { setApiAccessUsername(event.target.value); setApiAccessError("") }} aria-invalid={Boolean(apiAccessError)} aria-describedby={apiAccessError ? "api-access-error" : undefined} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="api-access-password">密码</Label>
              <Input id="api-access-password" type="password" autoComplete="current-password" value={apiAccessPassword} onChange={(event) => { setApiAccessPassword(event.target.value); setApiAccessError("") }} aria-invalid={Boolean(apiAccessError)} aria-describedby={apiAccessError ? "api-access-error" : undefined} />
            </div>
            {apiAccessError && <p id="api-access-error" role="alert" className="text-xs text-destructive">{apiAccessError}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setApiAccessDialogOpen(false)}>取消</Button>
              <Button type="submit">验证并使用</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={apiDialogOpen} onOpenChange={setApiDialogOpen}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader><DialogTitle>Infinite Canvas API</DialogTitle><DialogDescription>登录、选择真实项目与模型、启动任务都在这里完成。密码和 JWT 只保留在本次进程内。</DialogDescription></DialogHeader>

          <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/20 p-1">
            <Button type="button" variant={apiOperation === "generate" ? "default" : "ghost"} onClick={() => setApiOperation("generate")}>资产批量出图</Button>
            <Button type="button" variant={apiOperation === "directory_redraw" ? "default" : "ghost"} onClick={() => setApiOperation("directory_redraw")}>文件夹批量修改</Button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2"><Label htmlFor="api-base-url">服务地址</Label><Input id="api-base-url" type="url" autoComplete="url" value={apiDraft.baseUrl} onChange={(event) => setApiDraft((value) => ({ ...value, baseUrl: event.target.value }))} /></div>
            <div className="space-y-2"><Label htmlFor="api-username">登录账号</Label><Input id="api-username" autoComplete="username" value={apiDraft.username} onChange={(event) => setApiDraft((value) => ({ ...value, username: event.target.value }))} /></div>
            <div className="space-y-2"><Label htmlFor="api-password">登录密码</Label><div className="relative"><Input id="api-password" type={apiPasswordVisible ? "text" : "password"} autoComplete="current-password" className="pr-10" value={apiDraft.password} onChange={(event) => setApiDraft((value) => ({ ...value, password: event.target.value }))} /><Button type="button" variant="ghost" size="icon-sm" className="absolute right-1 top-1" onClick={() => setApiPasswordVisible((visible) => !visible)} aria-label={apiPasswordVisible ? "隐藏密码" : "显示密码"}>{apiPasswordVisible ? <EyeOff /> : <Eye />}</Button></div></div>
            <Button type="button" variant={apiCatalog ? "secondary" : "default"} className="sm:col-span-2" onClick={() => void connectApiCatalog()} disabled={loading || !projectId}>
              {loading ? <LoaderCircle className="animate-spin" /> : apiCatalog ? <RefreshCw /> : <CloudCog />}
              {apiCatalog ? "重新连接并刷新列表" : "连接账号并读取项目 / 模型"}
            </Button>
          </div>

          {apiCatalog && (
            <div className="space-y-4 rounded-xl border border-primary/25 bg-primary/5 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-primary"><CheckCircle2 className="size-4" />已读取 {apiCatalog.projects.length} 个项目、{apiCatalog.models.length} 个生图模型</div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2"><Label>目标项目</Label><Select value={apiRemoteProjectId} onValueChange={setApiRemoteProjectId}><SelectTrigger className="w-full"><SelectValue placeholder="选择项目" /></SelectTrigger><SelectContent>{apiCatalog.projects.map((entry) => <SelectItem key={String(entry.id)} value={String(entry.id)}>{String(entry.name)}</SelectItem>)}</SelectContent></Select></div>
                <div className="space-y-2"><Label>生图模型</Label><Select value={apiModelId} onValueChange={setApiModelId}><SelectTrigger className="w-full"><SelectValue placeholder="选择模型" /></SelectTrigger><SelectContent>{apiCatalog.models.map((entry) => <SelectItem key={String(entry.id)} value={String(entry.id)}>{String(entry.name)}</SelectItem>)}</SelectContent></Select></div>
              </div>
            </div>
          )}

          {apiOperation === "directory_redraw" && (
            <div className="space-y-4 rounded-xl border p-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Button type="button" variant="outline" className="justify-start" onClick={() => void chooseApiDirectory("source")}><FolderOpen />{apiSourceFolder ? `原图：${apiSourceFolder.name}` : "选择原图文件夹"}</Button>
                <Button type="button" variant="outline" className="justify-start" onClick={() => void chooseApiDirectory("output")}><FolderOpen />{apiOutputFolder ? `输出：${apiOutputFolder.name}` : "选择结果保存文件夹"}</Button>
              </div>
              <div className="space-y-2"><Label htmlFor="api-redraw-prompt">本批次统一修改要求</Label><Textarea id="api-redraw-prompt" rows={4} value={apiRedrawPrompt} onChange={(event) => setApiRedrawPrompt(event.target.value)} placeholder="例如：保留主体构图，将整体材质调整为写实金属，并统一冷色灯光。" /></div>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2"><Label htmlFor="api-workers">并发数量</Label><Input id="api-workers" type="number" min={1} max={16} inputMode="numeric" value={apiDraft.maxWorkers} onChange={(event) => setApiDraft((value) => ({ ...value, maxWorkers: event.target.value }))} /></div>
            <div className="space-y-2"><Label>画面比例</Label><Select value={apiDraft.aspectRatio} onValueChange={(aspectRatio) => setApiDraft((value) => ({ ...value, aspectRatio }))}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{["21:9", "16:9", "5:4", "4:3", "3:2", "1:1", "2:3", "3:4", "4:5", "9:16"].map((ratio) => <SelectItem key={ratio} value={ratio}>{ratio}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-2"><Label>图片尺寸</Label><Select value={apiDraft.imageSize} onValueChange={(imageSize) => setApiDraft((value) => ({ ...value, imageSize }))}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{["1K", "2K"].map((size) => <SelectItem key={size} value={size}>{size}</SelectItem>)}</SelectContent></Select></div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setApiDialogOpen(false)}>取消</Button>
            <Button onClick={() => void startApiBatch()} disabled={loading || !apiCatalog || !apiRemoteProjectId || !apiModelId}>
              {loading ? <LoaderCircle className="animate-spin" /> : <Play />}
              {apiOperation === "directory_redraw" ? "开始文件夹批量修改" : "开始 API 批量出图"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ScrollArea>
  )
}

function RouteStudio({ notify }: { notify: DrawerProps["notify"] }) {
  const { presets, setPresets, activePresetId, setActivePresetId, activePreset } = usePromptPresets()
  const [catalogStatus, setCatalogStatus] = React.useState<JsonRecord | null>(null)
  const [presetsOpen, setPresetsOpen] = React.useState(false)
  const [selectedModuleId, setSelectedModuleId] = React.useState<string | null>(null)
  const [module, setModule] = React.useState<RouteModule | null>(null)
  const [preview, setPreview] = React.useState<JsonRecord | null>(null)
  const [testStyle, setTestStyle] = React.useState("cg")
  const [testAsset, setTestAsset] = React.useState("scene")
  const [testReferenceMode, setTestReferenceMode] = React.useState("none")
  const [testAssetId, setTestAssetId] = React.useState("")
  const [testNotes, setTestNotes] = React.useState("")
  const [classificationRequest, setClassificationRequest] = React.useState<JsonRecord | null>(null)
  const [classificationReceipt, setClassificationReceipt] = React.useState<JsonRecord | null>(null)
  const [classificationPreview, setClassificationPreview] = React.useState<JsonRecord | null>(null)
  const [simulatedDecision, setSimulatedDecision] = React.useState("__null__")
  const [classificationMessage, setClassificationMessage] = React.useState("尚未开始判断")
  const [busy, setBusy] = React.useState(false)
  const [deletePresetId, setDeletePresetId] = React.useState<string | null>(null)
  const [deleteBranchOpen, setDeleteBranchOpen] = React.useState(false)
  const [renameOpen, setRenameOpen] = React.useState(false)
  const [renameValue, setRenameValue] = React.useState("")
  const [newPresetOpen, setNewPresetOpen] = React.useState(false)
  const [newPresetValue, setNewPresetValue] = React.useState("")
  const [exportOpen, setExportOpen] = React.useState(false)
  const [exportValue, setExportValue] = React.useState("")
  const [pendingImport, setPendingImport] = React.useState<PendingRouteImport | null>(null)
  const [routeFilter, setRouteFilter] = React.useState("")
  const [routePage, setRoutePage] = React.useState(0)
  const presetImportRef = React.useRef<HTMLInputElement>(null)
  const branchImportRef = React.useRef<HTMLInputElement>(null)

  const modules = activePreset?.modules ?? []
  const scopeFilteredModules = React.useMemo(() => {
    if (!module) return modules
    return modules.filter((entry) =>
      entry.scope.assets.some((value: string) => module.scope.assets.includes(value))
      && entry.scope.styles.some((value: string) => module.scope.styles.includes(value))
      && entry.scope.referenceModes.some((value: string) => module.scope.referenceModes.includes(value)))
  }, [module, modules])
  const filteredModules = React.useMemo(() => {
    const query = routeFilter.trim().toLocaleLowerCase("zh-CN")
    if (!query) return scopeFilteredModules
    return scopeFilteredModules.filter((entry) => `${entry.displayName} ${entry.id}`.toLocaleLowerCase("zh-CN").includes(query))
  }, [routeFilter, scopeFilteredModules])
  const routePageCount = Math.max(1, Math.ceil(filteredModules.length / ROUTE_LIST_PAGE_SIZE))
  const visibleModules = React.useMemo(
    () => paginateAssets(filteredModules, routePage, ROUTE_LIST_PAGE_SIZE),
    [filteredModules, routePage],
  )

  const refreshCatalog = React.useCallback(async () => {
    try {
      const status = await catalogAdapter.getStatus()
      setCatalogStatus(status)
      const registered = routeModulesFromCatalogSummary(status.catalogSummary)
      setPresets((current) => {
        const base = current.length ? current : readStoredPresets(registered)
        return base.map((preset) => {
          if (preset.id !== "workspace") return preset
          const retained = withoutRetiredCatalogEnhancers(preset.modules)
          const currentIds = new Set(retained.map((entry) => entry.id))
          return { ...preset, modules: [...retained, ...registered.filter((entry) => !currentIds.has(entry.id))] }
        })
      })
    } catch (error) {
      notify(safeMessage(error, "正式提示词注册表读取失败"), "error")
    }
  }, [notify])

  React.useEffect(() => { void refreshCatalog() }, [refreshCatalog])
  React.useEffect(() => { setRoutePage(0) }, [activePresetId, routeFilter])
  React.useEffect(() => {
    const selected = modules.find((item) => item.id === selectedModuleId) ?? modules[0] ?? null
    setSelectedModuleId(selected?.id ?? null)
    setModule(selected ? clone(selected) : null)
    setPreview(null)
    setClassificationRequest(null)
    setClassificationReceipt(null)
    setClassificationPreview(null)
  }, [activePresetId, modules.length])

  const commitModule = (next: RouteModule) => {
    const normalized = normalizeRouteModule(next)
    setModule(normalized)
    setPreview(null)
    setPresets((items) => items.map((preset) => preset.id === activePresetId
      ? { ...preset, revision: preset.revision + 1, updatedAt: nowIso(), modules: preset.modules.map((entry) => entry.id === selectedModuleId ? normalized : entry) }
      : preset))
  }

  const selectModule = (entry: RouteModule) => {
    setSelectedModuleId(entry.id)
    setModule(clone(entry))
    setPreview(null)
    setClassificationRequest(null)
    setClassificationReceipt(null)
    setClassificationPreview(null)
  }

  const newBranch = () => {
    const next = normalizeRouteModule({
      id: uniqueId("branch"), displayName: "新路由分支", family: "scene-environment", revision: 1,
      scope: { styles: ["cg"], assets: ["scene"], referenceModes: ["none", "style"] },
      classifier: { definition: "", selectionPolicy: "single-dominant", controlDimensions: [...DEFAULT_CONTROL_DIMENSIONS], tieBreak: "", noDefault: true },
      operations: [{ op: "append", field: "Scene/backdrop", value: "" }], tests: [], origin: { kind: "session-draft" },
    })
    setPresets((items) => items.map((preset) => preset.id === activePresetId ? { ...preset, revision: preset.revision + 1, updatedAt: nowIso(), modules: [...preset.modules, next] } : preset))
    setSelectedModuleId(next.id)
    setModule(next)
  }

  const duplicateBranch = () => {
    if (!module) return
    const next = normalizeRouteModule({ ...clone(module), id: uniqueId(`${module.id}-copy`), displayName: `${module.displayName} 副本`, revision: 1, origin: { kind: "session-draft" } })
    setPresets((items) => items.map((preset) => preset.id === activePresetId ? { ...preset, revision: preset.revision + 1, modules: [...preset.modules, next], updatedAt: nowIso() } : preset))
    setSelectedModuleId(next.id)
    setModule(next)
  }

  const deleteBranch = async () => {
    if (!module) return
    setBusy(true)
    try {
      const formal = (catalogStatus?.catalogSummary?.conditionModules ?? []).some((entry: RouteModule) => entry.id === module.id)
      if (formal && catalogStatus) {
        await routeAdminAdapter.remove(module.id, { expectedCatalogFingerprint: catalogStatus.catalogFingerprint })
        await refreshCatalog()
      }
      setPresets((items) => items.map((preset) => preset.id === activePresetId ? { ...preset, revision: preset.revision + 1, modules: preset.modules.filter((entry) => entry.id !== module.id), updatedAt: nowIso() } : preset))
      setSelectedModuleId(null)
      setModule(null)
      notify(formal ? "正式分支已从注册表删除" : "当前预设中的分支已删除")
    } catch (error) { notify(safeMessage(error, "分支删除失败"), "error") }
    finally { setBusy(false); setDeleteBranchOpen(false) }
  }

  const saveFormal = async () => {
    if (!module || !catalogStatus) return
    const validation = validateRouteModule(module)
    if (!validation.valid) {
      notify(validation.errors[0]?.message || "请先补全分支条件和提示词修改", "error")
      return
    }
    setBusy(true)
    try {
      await routeAdminAdapter.save(validation.module, { expectedCatalogFingerprint: catalogStatus.catalogFingerprint })
      await refreshCatalog()
      notify("分支已写入正式提示词注册表")
    } catch (error) { notify(safeMessage(error, "正式分支保存失败"), "error") }
    finally { setBusy(false) }
  }

  const resolvePreview = async () => {
    if (!module) return
    setBusy(true)
    try {
      const base = await catalogAdapter.resolve({
        style: module.scope.styles[0] || "cg",
        asset: module.scope.assets[0] || "scene",
        referenceMode: module.scope.referenceModes[0] || "none",
        referenceCount: module.scope.referenceModes[0] === "visual-consistency" ? 2 : module.scope.referenceModes[0] === "none" ? 0 : 1,
        ...(testNotes.trim() ? { productionNotes: testNotes.trim() } : {}),
      })
      setPreview({ base, applied: applyModuleOperationsPreview(base.promptFields, module) })
    } catch (error) { notify(safeMessage(error, "提示词预览生成失败"), "error") }
    finally { setBusy(false) }
  }

  const createPreset = () => {
    const name = newPresetValue.trim()
    if (!name) return
    if (presets.some((preset) => routePresetNameKey(preset.name) === routePresetNameKey(name))) {
      notify("已有同名预设，请换一个名称", "error")
      return
    }
    const next: RoutePreset = {
      id: uniqueId("preset"),
      name,
      revision: 1,
      source: "本机新建",
      updatedAt: nowIso(),
      templates: {},
      modules: [],
    }
    setPresets((items) => [...items, next])
    setActivePresetId(next.id)
    setSelectedModuleId(null)
    setModule(null)
    setNewPresetOpen(false)
    setNewPresetValue("")
    notify(`已新建独立预设“${name}”`)
  }

  const deletePreset = () => {
    if (!deletePresetId || presets.length <= 1) return
    const deleting = presets.find((preset) => preset.id === deletePresetId)
    const next = presets.filter((preset) => preset.id !== deletePresetId)
    setPresets(next)
    if (activePresetId === deletePresetId) setActivePresetId(next[0].id)
    setDeletePresetId(null)
    notify(`预设“${deleting?.name ?? ""}”已删除`)
  }

  const renamePreset = () => {
    const name = renameValue.trim()
    if (!name || !activePreset) return
    if (presets.some((preset) => preset.id !== activePreset.id && preset.name.trim().toLocaleLowerCase("zh-CN") === name.toLocaleLowerCase("zh-CN"))) {
      notify("已有同名预设，请换一个名称", "error")
      return
    }
    setPresets((items) => items.map((preset) => preset.id === activePreset.id ? { ...preset, name, revision: preset.revision + 1, updatedAt: nowIso() } : preset))
    setRenameOpen(false)
    notify("预设已重命名")
  }

  const exportPreset = async () => {
    if (!activePreset) return
    const name = exportValue.trim() || activePreset.name
    try {
      const artifact = createRoutePresetPackage({
        preset: { id: activePreset.id, name, revision: activePreset.revision },
        modules: activePreset.modules,
        templates: activePreset.templates as any,
        source: { app: "KA Prompt Studio" },
      })
      const result = await downloadJson(`${name}.ka-prompt-preset.json`, artifact)
      if (!result.saved) {
        notify("已取消导出", "warning")
        return
      }
      setExportOpen(false)
      notify(`当前预设已导出：${result.fileName}`)
    } catch (error) {
      notify(safeMessage(error, "当前预设导出失败"), "error")
    }
  }

  const exportCurrentBranch = async () => {
    if (!module) return
    try {
      const result = await downloadJson(
        `${module.displayName}.ka-route-branch.json`,
        createRouteBranchFile({ module, source: { app: "KA Prompt Studio" } }),
      )
      if (result.saved) notify(`当前分支已导出：${result.fileName}`)
      else notify("已取消导出", "warning")
    } catch (error) {
      notify(safeMessage(error, "当前分支导出失败"), "error")
    }
  }

  const applyImportedArtifacts = (incoming: PendingRouteImport) => {
    if (incoming.mode === "preset" && incoming.presets.length) {
      setPresets((current) => {
        const next = [...current]
        for (const preset of incoming.presets) {
          const conflict = next.findIndex((entry) => entry.id === preset.id || entry.name.toLocaleLowerCase("zh-CN") === preset.name.toLocaleLowerCase("zh-CN"))
          if (conflict >= 0) next[conflict] = preset
          else next.push(preset)
        }
        return next
      })
      setActivePresetId(incoming.presets.at(-1)!.id)
      notify(`已导入 ${incoming.presets.length} 个预设${incoming.sameNames.length ? `，跳过 ${incoming.sameNames.length} 个相同项` : ""}${incoming.conflictNames.length ? "，冲突项已按确认覆盖" : ""}`)
    }
    if (incoming.mode === "branch" && incoming.modules.length && incoming.targetPresetId) {
      setPresets((current) => current.map((preset) => preset.id === incoming.targetPresetId ? {
        ...preset,
        revision: preset.revision + 1,
        updatedAt: nowIso(),
        modules: [...new Map([...preset.modules, ...incoming.modules].map((entry) => [entry.id, entry])).values()],
      } : preset))
      setActivePresetId(incoming.targetPresetId)
      setSelectedModuleId(incoming.modules[0].id)
      setModule(incoming.modules[0])
      notify(`已导入 ${incoming.modules.length} 个分支${incoming.sameNames.length ? `，跳过 ${incoming.sameNames.length} 个相同项` : ""}${incoming.conflictNames.length ? "，相同唯一编号已按确认覆盖" : ""}`)
    }
    setPendingImport(null)
  }

  const importArtifacts = async (files: FileList, mode: "preset" | "branch") => {
    try {
      const selectedFiles = Array.from(files)
      if (!selectedFiles.length) return
      const parsed = [] as { fileName: string; artifact: ReturnType<typeof parseRouteExchangeArtifact> }[]
      for (const file of selectedFiles) {
        if (file.size > 5 * 1024 * 1024) throw new Error(`${file.name} 超过 5 MB，未执行本次导入`)
        parsed.push({ fileName: file.name, artifact: parseRouteExchangeArtifact(await file.text()) })
      }
      if (mode === "preset" && parsed.some(({ artifact }) => artifact.type !== "preset-package")) {
        throw new Error("导入预设只能选择预设文件；本次没有写入任何内容")
      }
      if (mode === "branch" && parsed.some(({ artifact }) => artifact.type === "preset-package")) {
        throw new Error("导入分支只能选择分支文件；预设文件请从上方“导入预设”进入")
      }

      const conflictNames = new Set<string>()
      const newNames = new Set<string>()
      const sameNames = new Set<string>()
      const incomingPresets: RoutePreset[] = []
      const incomingModules: RouteModule[] = []

      if (mode === "preset") {
        const consolidated: RoutePreset[] = []
        for (const { fileName, artifact } of parsed) {
          if (artifact.type !== "preset-package") continue
          const candidate = {
            id: artifact.value.preset.id,
            name: artifact.value.preset.name,
            revision: artifact.value.preset.revision,
            source: fileName,
            updatedAt: nowIso(),
            templates: clone(artifact.value.templates),
            modules: artifact.value.modules.map(normalizeRouteModule),
          }
          const duplicateIndex = consolidated.findIndex((entry) => entry.id === candidate.id || routePresetNameKey(entry.name) === routePresetNameKey(candidate.name))
          if (duplicateIndex >= 0) {
            const earlier = consolidated[duplicateIndex]
            if (routePresetModulesEqual(earlier, candidate)) sameNames.add(candidate.name)
            else conflictNames.add(`${candidate.name}（所选文件中有不同版本）`)
            consolidated[duplicateIndex] = candidate
          } else consolidated.push(candidate)
        }
        for (const candidate of consolidated) {
          const current = presets.find((entry) => entry.id === candidate.id || routePresetNameKey(entry.name) === routePresetNameKey(candidate.name))
          if (!current) {
            newNames.add(candidate.name)
            incomingPresets.push(candidate)
          } else if (routePresetModulesEqual(current, candidate)) {
            sameNames.add(candidate.name)
          } else {
            conflictNames.add(candidate.name)
            incomingPresets.push(candidate)
          }
        }
      } else {
        const grouped = new Map<string, { fileName: string; module: RouteModule }[]>()
        for (const { fileName, artifact } of parsed) {
          const entries = artifact.type === "branch-file" ? [artifact.value.module] : artifact.value.modules
          for (const entry of entries.map(normalizeRouteModule)) {
            grouped.set(entry.id, [...(grouped.get(entry.id) ?? []), { fileName, module: entry }])
          }
        }
        for (const entries of grouped.values()) {
          const chosen = entries.at(-1)!.module
          const distinctVersions = entries.filter((entry, index) => !entries.slice(0, index).some((earlier) => routeModulesEqual(earlier.module, entry.module)))
          const current = activePreset?.modules.find((entry) => entry.id === chosen.id)
          if (distinctVersions.length > 1) {
            conflictNames.add(`${chosen.displayName}（所选文件中有 ${distinctVersions.length} 个版本）`)
            incomingModules.push(chosen)
          } else if (!current) {
            newNames.add(chosen.displayName)
            incomingModules.push(chosen)
          } else if (routeModulesEqual(current, chosen)) {
            sameNames.add(chosen.displayName)
          } else {
            conflictNames.add(chosen.displayName)
            incomingModules.push(chosen)
          }
        }
      }
      const batch: PendingRouteImport = {
        mode,
        presets: incomingPresets,
        modules: incomingModules,
        conflictNames: [...conflictNames],
        newNames: [...newNames],
        sameNames: [...sameNames],
        targetPresetId: activePreset?.id ?? null,
      }
      if (mode === "branch" && !activePreset) throw new Error("请先选择一个预设，再导入分支")
      if (!incomingPresets.length && !incomingModules.length) {
        notify(`未写入：所选${mode === "preset" ? "预设" : "分支"}与本机内容相同`, "warning")
        return
      }
      if (conflictNames.size) setPendingImport(batch)
      else applyImportedArtifacts(batch)
    } catch (error) { notify(safeMessage(error, "文件不是有效的路由预设或分支文件"), "error") }
  }

  const availableForScope = React.useMemo(() => modules
    .map(normalizeRouteModule)
    .filter((entry) => entry.scope.styles.includes(testStyle)
      && entry.scope.assets.includes(testAsset)
      && entry.scope.referenceModes.includes(testReferenceMode)
      && validateRouteModule(entry).valid), [modules, testAsset, testReferenceMode, testStyle])
  const formalModuleIds = React.useMemo(() => new Set<string>(
    (catalogStatus?.catalogSummary?.conditionModules ?? []).map((entry: RouteModule) => entry.id),
  ), [catalogStatus])

  const invalidateClassification = () => {
    setClassificationRequest(null)
    setClassificationReceipt(null)
    setClassificationPreview(null)
    setClassificationMessage("测试条件已变化，请重新开始智能判断")
  }

  const applyClassificationReceipt = async (
    selectedId: string | null,
    { source, reason = "", request = classificationRequest }: { source: string; reason?: string; request?: JsonRecord | null },
  ) => {
    if (!request) {
      setClassificationMessage("请先生成智能判断任务")
      return
    }
    const selected = selectedId ? modules.find((entry) => entry.id === selectedId) ?? null : null
    if (selectedId && (!selected || !request.candidates.some((entry: JsonRecord) => entry.id === selectedId))) {
      setClassificationMessage("回执不在本次候选分支范围内")
      return
    }
    setBusy(true)
    try {
      const base = await catalogAdapter.resolve({
        style: testStyle,
        asset: testAsset,
        referenceMode: testReferenceMode,
        referenceCount: testReferenceMode === "visual-consistency" ? 2 : testReferenceMode === "none" ? 0 : 1,
        productionNotes: testNotes.trim(),
      })
      const operations = selected
        ? [...(selected.origin?.sharedOperations ?? []), ...selected.operations]
        : []
      const applied = selected
        ? applyModuleOperationsPreview(base.promptFields, { ...selected, operations })
        : { fields: base.promptFields, diff: [], deferred: [] }
      const receipt = { selectedId, source, reason }
      setClassificationReceipt(receipt)
      setClassificationPreview({ base, applied, selected })
      setClassificationMessage(selected ? `命中：${selected.displayName}` : "本次不命中任何分支")
    } catch (error) {
      setClassificationMessage(safeMessage(error, "无法预演 Agent 判断结果"))
    } finally {
      setBusy(false)
    }
  }

  const startClassification = async () => {
    try {
      const request = buildClassificationRequest({
        style: testStyle,
        asset: testAsset,
        referenceMode: testReferenceMode,
        assetId: testAssetId,
        productionNotes: testNotes,
        candidates: modules,
      })
      setClassificationRequest(request)
      setClassificationReceipt(null)
      setClassificationPreview(null)
      setClassificationMessage(`已生成任务：Agent 只能从 ${request.candidates.length} 个候选中返回唯一编号或“不命中”`)
      if (!routeClassifierAdapter.getCapabilities().classify) return
      setBusy(true)
      const receipt = await routeClassifierAdapter.classify(request)
      await applyClassificationReceipt(receipt.selectedId, { source: receipt.source, reason: receipt.reason, request })
    } catch (error) {
      setClassificationMessage(safeMessage(error, "智能判断任务生成失败"))
      setClassificationRequest(null)
      setClassificationReceipt(null)
      setClassificationPreview(null)
    } finally {
      setBusy(false)
    }
  }

  const saveClassificationTest = () => {
    if (!module || classificationReceipt?.selectedId !== module.id) {
      notify("只有 Agent 回执明确命中当前编辑分支时，才能保存为这个分支的测试样例", "warning")
      return
    }
    const nextTest = {
      id: uniqueId("case"),
      assetId: testAssetId,
      style: testStyle,
      asset: testAsset,
      productionNotes: testNotes.trim(),
      expectedConditionId: module.id,
    }
    commitModule({ ...module, tests: [...module.tests, nextTest] })
    notify("测试样例已保存到当前分支；导出时会一并携带")
  }

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <section id="route-presets-panel" className="border-b bg-muted/15">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 px-5 py-2.5 text-left transition-colors hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          aria-expanded={presetsOpen}
          aria-controls="route-presets-content"
          onClick={() => setPresetsOpen((open) => !open)}
        >
          <span className="flex min-w-0 items-center gap-2">
            <ChevronRight className={cn("size-4 text-muted-foreground transition-transform", presetsOpen && "rotate-90")} />
            <span className="text-sm font-semibold">路由预设</span>
            <Badge variant="muted" className="shrink-0">{presets.length}</Badge>
          </span>
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">当前：<span className="font-medium text-foreground">{activePreset?.name ?? "未选择"}</span></span>
        </button>
        {presetsOpen && <div id="route-presets-content" className="border-t px-5 py-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-[11px] text-muted-foreground">点击卡片直接切换；卡片可横向滚动，数量不限。</p>
            <div className="flex gap-2">
              <input ref={presetImportRef} type="file" accept=".json" multiple className="sr-only" aria-label="导入预设文件" onChange={(event) => { const files = event.currentTarget.files; if (files) void importArtifacts(files, "preset").finally(() => { event.currentTarget.value = "" }) }} />
              <Button variant="outline" size="sm" onClick={() => { setNewPresetValue(""); setNewPresetOpen(true) }}><Plus />新建预设</Button>
              <Button variant="outline" size="sm" onClick={() => presetImportRef.current?.click()}><Upload />导入预设（可多选）</Button>
              <Button variant="outline" size="sm" onClick={() => { if (activePreset) { setExportValue(activePreset.name); setExportOpen(true) } }} disabled={!activePreset}><Download />导出当前预设</Button>
            </div>
          </div>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {presets.map((preset) => {
              const active = preset.id === activePresetId
              return (
                <div key={preset.id} className={cn("group relative min-w-52 rounded-xl border bg-card p-3 text-left transition-all hover:-translate-y-0.5 hover:shadow-panel", active && "border-primary/55 bg-primary/5 ring-2 ring-primary/10")}>
                  <button type="button" className="absolute inset-0 z-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" onClick={() => setActivePresetId(preset.id)} aria-label={`使用预设 ${preset.name}`} aria-pressed={active} />
                  <div className="pointer-events-none relative z-[1] flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-sm font-semibold">{preset.name}</p><p className="mt-1 text-[11px] text-muted-foreground">{preset.modules.length} 个分支 · {Object.keys(templateDraftRecords(preset.templates)).length} 套基础字段 · {preset.source}</p></div>{active && <Badge variant="success">使用中</Badge>}</div>
                  <div className="relative z-[2] mt-3 flex justify-end gap-1 opacity-70 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <Button variant="ghost" size="icon-sm" onClick={(event) => { event.stopPropagation(); setActivePresetId(preset.id); setRenameValue(preset.name); setRenameOpen(true) }} aria-label={`重命名 ${preset.name}`}><Pencil /></Button>
                    <Button variant="ghost" size="icon-sm" onClick={(event) => { event.stopPropagation(); setDeletePresetId(preset.id) }} disabled={presets.length <= 1} aria-label={`删除 ${preset.name}`}><Trash2 /></Button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>}
      </section>

      <div className="grid min-h-0 grid-cols-[210px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col border-r bg-muted/15">
          <div className="flex items-center justify-between border-b px-3 py-3"><span className="text-xs font-medium">路由分支</span><Button variant="ghost" size="icon-sm" onClick={newBranch} aria-label="新建分支"><Plus /></Button></div>
          <div className="space-y-1.5 border-b p-2">
            <Input value={routeFilter} onChange={(event) => setRouteFilter(event.target.value)} placeholder="搜索名称或唯一编号" aria-label="搜索路由分支" className="h-8 text-xs" />
            <p className="px-1 text-[10px] text-muted-foreground">当前条件 {filteredModules.length} 个分支 · 每页最多 {ROUTE_LIST_PAGE_SIZE} 个</p>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-1 p-2">
              {visibleModules.map((entry: RouteModule) => {
                const effective = formalModuleIds.has(entry.id)
                return <button key={entry.id} type="button" onClick={() => selectModule(entry)} className={cn("w-full rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors hover:bg-accent", selectedModuleId === entry.id && "border-border bg-background shadow-sm")}><div className="flex items-center gap-2"><StatusDot state={effective ? "complete" : "waiting"} /><span className="min-w-0 flex-1 truncate text-xs font-medium">{entry.displayName}</span></div><div className="mt-1 flex items-end justify-between gap-2 pl-4.5"><span className="min-w-0 truncate text-[10px] text-muted-foreground">{styleLabel(entry.scope.styles[0])} · {assetLabel(entry.scope.assets[0])}</span><span className={cn("shrink-0 text-[9px] font-medium", effective ? "text-success" : "text-muted-foreground")}>{effective ? "已生效" : "草稿"}</span></div></button>
              })}
              {!filteredModules.length && <EmptyState icon={Route}>{modules.length ? "没有匹配的分支" : "当前预设还没有分支"}</EmptyState>}
            </div>
          </ScrollArea>
          <div className="space-y-2 border-t p-3">
            {routePageCount > 1 && <div className="flex items-center justify-between"><Button variant="ghost" size="icon-sm" aria-label="上一页分支" disabled={routePage === 0} onClick={() => setRoutePage((page) => Math.max(0, page - 1))}><ChevronLeft /></Button><span className="text-[10px] text-muted-foreground">{routePage + 1} / {routePageCount}</span><Button variant="ghost" size="icon-sm" aria-label="下一页分支" disabled={routePage >= routePageCount - 1} onClick={() => setRoutePage((page) => Math.min(routePageCount - 1, page + 1))}><ChevronRight /></Button></div>}
            <input ref={branchImportRef} type="file" accept=".json" multiple className="sr-only" aria-label="导入分支文件" onChange={(event) => { const files = event.currentTarget.files; if (files) void importArtifacts(files, "branch").finally(() => { event.currentTarget.value = "" }) }} />
            <Button variant="outline" size="sm" className="w-full" onClick={() => branchImportRef.current?.click()}><Upload />导入分支（可多选）</Button>
          </div>
        </aside>

        <ScrollArea className="h-full">
          {module ? (
            <div className="space-y-5 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div><h3 className="text-base font-semibold">{module.displayName}</h3><p className="mt-1 font-mono text-[10px] text-muted-foreground">唯一编号：{module.id}</p></div>
                <div className="flex gap-2"><Button variant="outline" size="sm" onClick={duplicateBranch}><Copy />复制当前分支来改</Button><Button variant="outline" size="sm" onClick={() => void exportCurrentBranch()}><Download />导出当前分支</Button><Button variant="destructive" size="sm" onClick={() => setDeleteBranchOpen(true)}><Trash2 />删除</Button></div>
              </div>

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

              <Card>
                <CardHeader className="pb-3"><SectionHeading title="用制作说明测试分支" description="这是单项、只读的开发调试工作台；不会启动项目级批量判断，也不会改写正式队列。" action={<Badge variant="info">{availableForScope.length} 个候选分支</Badge>} /></CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <div className="space-y-2"><Label>制作风格</Label><Select value={testStyle} onValueChange={(value) => { setTestStyle(value); invalidateClassification() }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{STYLES.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></div>
                    <div className="space-y-2"><Label>资产类型</Label><Select value={testAsset} onValueChange={(value) => { setTestAsset(value); invalidateClassification() }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{ASSETS.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></div>
                    <div className="space-y-2"><Label>参考图方式</Label><Select value={testReferenceMode} onValueChange={(value) => { setTestReferenceMode(value); invalidateClassification() }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{REFERENCE_MODES.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></div>
                    <div className="space-y-2"><Label>资产 ID / 名称</Label><Input aria-label="测试资产 ID 或名称" value={testAssetId} onChange={(event) => { setTestAssetId(event.target.value); invalidateClassification() }} placeholder="SCENE-014 · 雨林遗迹" /></div>
                  </div>
                  <div className="space-y-2"><Label>完整制作说明</Label><Textarea aria-label="测试完整制作说明" rows={5} value={testNotes} onChange={(event) => { setTestNotes(event.target.value); invalidateClassification() }} placeholder="例如：巨型板根与湿润树冠控制主要空间，林间道路延伸至遗迹入口……" /></div>
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-3">
                    <div className="min-w-0"><p className="text-[10px] text-muted-foreground">Agent 判断结果</p><p className="mt-1 truncate text-sm font-semibold">{classificationMessage}</p></div>
                    <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={saveClassificationTest} disabled={!classificationReceipt || classificationReceipt.selectedId !== module.id}><Save />保存为测试样例</Button><Button onClick={() => void startClassification()} disabled={busy || !testNotes.trim() || !availableForScope.length}>{busy ? <LoaderCircle className="animate-spin" /> : <Sparkles />}开始智能判断</Button></div>
                  </div>

                  {!routeClassifierAdapter.getCapabilities().classify && <div className="rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-[11px] text-muted-foreground">正式单项 Agent bridge 尚未接入桌面壳；“开始智能判断”会先生成严格候选任务。可在下方开发调试区模拟 Agent 回执验证字段变化。项目级正式批量判断只从“本次批量”执行。</div>}

                  <details className="rounded-lg border bg-muted/10 p-3">
                    <summary className="cursor-pointer text-xs font-medium">开发调试：模拟 Agent 回执</summary>
                    <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
                      <div className="min-w-0 flex-1 space-y-2"><Label>模拟判断结果</Label><Select value={availableForScope.some((entry) => entry.id === simulatedDecision) ? simulatedDecision : "__null__"} onValueChange={setSimulatedDecision}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="__null__">不命中任何分支</SelectItem>{availableForScope.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.displayName}</SelectItem>)}</SelectContent></Select></div>
                      <Button variant="secondary" onClick={() => void applyClassificationReceipt(simulatedDecision === "__null__" ? null : simulatedDecision, { source: "debug", reason: "开发者模拟回执" })} disabled={!classificationRequest || busy}>应用模拟回执</Button>
                    </div>
                  </details>

                  <details className="rounded-lg border bg-muted/10 p-3">
                    <summary className="cursor-pointer text-xs font-medium">智能判断任务详情</summary>
                    <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/45 p-3 font-mono text-[10px] leading-relaxed text-muted-foreground">{classificationRequest ? JSON.stringify(classificationRequest, null, 2) : "尚未生成任务。填写条件与制作说明后点击“开始智能判断”。"}</pre>
                  </details>

                  {classificationPreview && <div className="rounded-xl border bg-muted/15 p-4">
                    <div className="mb-3 flex items-center justify-between"><span className="text-xs font-medium">最终提示词变化</span><Button variant="outline" size="sm" onClick={() => navigator.clipboard.writeText(formatPromptText({ ...classificationPreview.base, promptFields: classificationPreview.applied.fields })).then(() => notify("最终 Prompt 已复制")).catch(() => notify("复制失败", "error"))}><ClipboardCopy />复制最终 Prompt</Button></div>
                    {classificationPreview.applied.diff.length ? <div className="space-y-3">{classificationPreview.applied.diff.map((diff: JsonRecord) => <div key={diff.field} className="rounded-lg border bg-background p-3"><Badge variant="outline">{diff.field}</Badge><div className="mt-3 grid gap-3 sm:grid-cols-2"><div><p className="mb-1 text-[10px] text-muted-foreground">修改前</p><p className="text-xs leading-relaxed text-muted-foreground">{diff.before || "（空）"}</p></div><div><p className="mb-1 text-[10px] text-primary">修改后</p><p className="text-xs leading-relaxed">{diff.after || "（空）"}</p></div></div></div>)}</div> : <p className="text-xs text-muted-foreground">本次不命中分支，最终 Prompt 保持基础解析结果。</p>}
                    {classificationPreview.applied.deferred?.length > 0 && <p className="mt-3 rounded-md border border-warning/30 bg-warning/8 px-3 py-2 text-[11px] text-muted-foreground">包含需要正式 Resolver 重新解析的基础路由替换操作；这里不会伪造替换结果。</p>}
                  </div>}
                </CardContent>
              </Card>

              <div className="sticky bottom-0 -mx-5 flex justify-end gap-2 border-t bg-background px-5 py-4"><Button variant="outline" onClick={() => { const result = validateRouteModule(module); notify(result.valid ? "分支结构校验通过" : result.errors[0]?.message || "校验失败", result.valid ? "good" : "error") }}>校验分支</Button><Button onClick={() => void saveFormal()} disabled={busy || !catalogStatus || catalogStatus.readOnly}>{busy && <LoaderCircle className="animate-spin" />}写入正式提示词库</Button></div>
            </div>
          ) : <div className="grid h-full place-items-center p-8"><EmptyState icon={Route}>新建或导入一个路由分支后开始编辑</EmptyState></div>}
        </ScrollArea>
      </div>

      <AlertDialog open={Boolean(deletePresetId)} onOpenChange={(open) => !open && setDeletePresetId(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>删除这个预设？</AlertDialogTitle><AlertDialogDescription>只删除本机 Prompt Studio 中的预设卡片，不会删除正式注册表里的分支。此操作无法撤销。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={deletePreset}>删除预设</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
      <AlertDialog open={Boolean(pendingImport)} onOpenChange={(open) => !open && setPendingImport(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>发现同一{pendingImport?.mode === "preset" ? "预设" : "分支"}的不同版本</AlertDialogTitle><AlertDialogDescription>新增 {pendingImport?.newNames.length ?? 0} 项，相同并跳过 {pendingImport?.sameNames.length ?? 0} 项，冲突 {pendingImport?.conflictNames.length ?? 0} 项：{pendingImport?.conflictNames.join("、")}。确认后，冲突项会采用所选文件中靠后的版本并覆盖本机版本；取消则整批不写入。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消导入</AlertDialogCancel><AlertDialogAction onClick={() => pendingImport && applyImportedArtifacts(pendingImport)}>确认覆盖并导入</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
      <AlertDialog open={deleteBranchOpen} onOpenChange={setDeleteBranchOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>删除“{module?.displayName}”？</AlertDialogTitle><AlertDialogDescription>{(catalogStatus?.catalogSummary?.conditionModules ?? []).some((entry: RouteModule) => entry.id === module?.id) ? "这是已写入正式注册表的分支，确认后会从正式提示词库删除。" : "这只会删除当前预设中的分支草稿。"}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => void deleteBranch()}>确认删除</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
      <Dialog open={newPresetOpen} onOpenChange={setNewPresetOpen}><DialogContent><DialogHeader><DialogTitle>新建预设</DialogTitle><DialogDescription>创建一张独立的空预设卡；它拥有自己的基础提示词草稿和路由分支，不会修改当前预设。</DialogDescription></DialogHeader><div className="space-y-2"><Label htmlFor="new-preset">预设名称</Label><Input id="new-preset" autoFocus value={newPresetValue} onChange={(event) => setNewPresetValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") createPreset() }} placeholder="例如：CG 场景测试组 A" /></div><DialogFooter><Button variant="outline" onClick={() => setNewPresetOpen(false)}>取消</Button><Button onClick={createPreset} disabled={!newPresetValue.trim()}><Plus />创建预设</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}><DialogContent><DialogHeader><DialogTitle>重命名当前预设</DialogTitle><DialogDescription>名称只用于团队识别，预设和分支的稳定编号不会改变。</DialogDescription></DialogHeader><div className="space-y-2"><Label htmlFor="rename-preset">预设名称</Label><Input id="rename-preset" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} /></div><DialogFooter><Button variant="outline" onClick={() => setRenameOpen(false)}>取消</Button><Button onClick={renamePreset}>保存名称</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={exportOpen} onOpenChange={setExportOpen}><DialogContent><DialogHeader><DialogTitle>导出当前预设</DialogTitle><DialogDescription>打包当前卡片的基础提示词、全部路由分支、判断条件、修改内容和测试样例，交给其他成员导入使用。</DialogDescription></DialogHeader><div className="space-y-2"><Label htmlFor="export-preset">导出名称</Label><Input id="export-preset" value={exportValue} onChange={(event) => setExportValue(event.target.value)} /></div><DialogFooter><Button variant="outline" onClick={() => setExportOpen(false)}>取消</Button><Button onClick={() => void exportPreset()}><Download />导出文件</Button></DialogFooter></DialogContent></Dialog>
    </div>
  )
}
