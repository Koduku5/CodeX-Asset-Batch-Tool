import * as React from "react"
import {
  Activity,
  AlertTriangle,
  Bot,
  Boxes,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  CloudCog,
  Copy,
  Database,
  Download,
  Eye,
  EyeOff,
  FileOutput,
  FileText,
  FolderOpen,
  ImagePlus,
  Layers3,
  LoaderCircle,
  Moon,
  MoreHorizontal,
  Network,
  PackageOpen,
  PanelRightOpen,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Route,
  Save,
  Send,
  Sparkles,
  Square,
  Sun,
  TestTube2,
  Timer,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from "lucide-react"

import { useTheme } from "@/components/theme-provider"
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
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { PromptFieldList } from "@/features/prompt-studio/prompt-field-list"
import {
  readLegacyTemplateDrafts,
  readTemplateDraft,
  templateDraftRecords,
  withTemplateDraft,
} from "@/features/prompt-studio/template-drafts.mjs"
import { PendingAssetDialog } from "@/features/pending-assets/pending-asset-dialog"

import { BatchControlAdapter } from "./services/batch-control-adapter.mjs"
import {
  CatalogResolverAdapter,
  formatPromptText,
  makeRouteTrace,
} from "./services/catalog-adapter.mjs"
import { ImagegenHandoffAdapter } from "./services/imagegen-handoff-adapter.mjs"
import { paginateAssets } from "./services/list-model.mjs"
import { ProjectControlAdapter } from "./services/project-control-adapter.mjs"
import { ProjectWorkspaceAdapter } from "./services/project-workspace.mjs"
import { CodexStatusAdapter } from "./services/codex-status-adapter.mjs"
import { CodexAgentChatAdapter } from "./services/codex-agent-chat-adapter.mjs"
import {
  DEFAULT_ALLOWED_TARGET_FIELDS,
  DEFAULT_CONTROL_DIMENSIONS,
  RouteModuleAdminAdapter,
  RouteClassifierAdapter,
  applyModuleOperationsPreview,
  buildClassificationRequest,
  createRouteBranchFile,
  createRoutePresetPackage,
  normalizeRouteModule,
  parseRouteExchangeArtifact,
  routeModulesEqual,
  validateRouteModule,
} from "./services/route-module-workbench.mjs"

declare global {
  interface Window {
    kaDesktopBridge?: {
      setStudioDrawerOpen?: (input: { open: boolean; width?: number }) => Promise<JsonRecord>
      openProjectDirectory?: (input: { projectId: string; kind: "project" | "output" }) => Promise<unknown>
      openApiBatchSettings?: (input: {
        projectId: string
        baseUrl: string
        username: string
        password: string
        maxWorkers: number
        aspectRatio: string
        imageSize: string
      }) => Promise<JsonRecord>
      loadApiCatalog?: (input: {
        projectId: string
        baseUrl: string
        username: string
        password: string
      }) => Promise<JsonRecord>
      selectApiDirectory?: (input: { purpose: "source" | "output" }) => Promise<JsonRecord>
      startApiBatch?: (input: {
        projectId: string
        baseUrl: string
        username: string
        password: string
        remoteProjectId: string
        modelId: string
        maxWorkers: number
        aspectRatio: string
        imageSize: string
        operation: "generate" | "directory_redraw"
        promptTemplates?: Record<string, string>
        sourceSelectionToken?: string
        outputSelectionToken?: string
        redrawPrompt?: string
      }) => Promise<JsonRecord>
      prepareBuiltinImagegen?: (input: { projectId: string }) => Promise<unknown>
      authorizeCodex?: () => Promise<JsonRecord>
      saveJsonFile?: (input: { suggestedName: string; jsonText: string }) => Promise<JsonRecord>
      selectProject?: (input: { projectId: string; expectedRevision: number }) => Promise<unknown>
    }
  }
}

type JsonRecord = Record<string, any>
type ProjectCard = {
  projectId: string
  displayName: string
  availability: string
  storageMode: string
  statusSummary: JsonRecord
}
type RouteModule = JsonRecord
type RoutePreset = {
  id: string
  name: string
  revision: number
  source: string
  updatedAt: string
  templates: unknown
  modules: RouteModule[]
}
type PendingRouteImport = {
  mode: "preset" | "branch"
  presets: RoutePreset[]
  modules: RouteModule[]
  conflictNames: string[]
  newNames: string[]
  sameNames: string[]
  targetPresetId: string | null
}
type ToastState = { id: number; tone: "good" | "warning" | "error"; message: string }
const workspaceAdapter = new ProjectWorkspaceAdapter()
const controlAdapter = new ProjectControlAdapter()
const codexStatusAdapter = new CodexStatusAdapter()
const codexAgentChatAdapter = new CodexAgentChatAdapter()
const batchAdapter = new BatchControlAdapter()
const catalogAdapter = new CatalogResolverAdapter()
const imagegenAdapter = new ImagegenHandoffAdapter()
const routeAdminAdapter = new RouteModuleAdminAdapter()
const routeClassifierAdapter = new RouteClassifierAdapter()

const STYLES = [
  { id: "anime", label: "二次元" },
  { id: "cg", label: "CG" },
  { id: "live-action", label: "真人" },
] as const
const ASSETS = [
  { id: "character", label: "角色", countKey: "characters" },
  { id: "creature", label: "生物", countKey: "creatures" },
  { id: "crowd", label: "群演", countKey: "crowds" },
  { id: "scene", label: "场景", countKey: "scenes" },
  { id: "prop", label: "道具", countKey: "props" },
] as const
const SHEETS = ["角色", "生物", "群演", "场景", "道具"] as const
const REFERENCE_MODES = [
  { id: "none", label: "不使用参考图" },
  { id: "style", label: "风格参考" },
  { id: "visual-consistency", label: "视觉一致" },
  { id: "custom", label: "自定义" },
] as const
const OPERATION_LABELS: Record<string, string> = {
  append: "追加到字段末尾",
  prepend: "添加到字段开头",
  set: "替换字段内容",
  replaceWith: "切换基础路由",
}
const PHASE_LABELS: Record<string, string> = {
  split: "剧本切分",
  analysis: "资产分析",
  "world-overview": "世界观总览",
  "asset-visual-specs": "资产设定",
  excel: "Excel 制表",
  generation: "批量出图",
  "waiting-generation": "等待出图配置",
  complete: "全部完成",
}
const CURRENT_STAGE_LABELS: Record<string, string> = {
  split: "剧本切分中",
  analysis: "剧本分析与累计",
  "world-overview": "世界观总览生成中",
  "asset-visual-specs": "资产设定生成中",
  excel: "Excel 制表中",
  generation: "资产生成中",
  "waiting-generation": "等待资产生成",
  complete: "流水线已完成",
}
const TASK_STAGE_BY_ACTION: Record<string, string> = {
  "environment-check": "split",
  split: "split",
  "analyze-screenplay": "analysis",
  "build-scoped-workbook": "analysis",
  "build-world-overview": "world-overview",
  "complete-asset-visual-specs": "asset-visual-specs",
  "finalize-after-confirmation": "asset-visual-specs",
  "validate-and-build-workbook": "excel",
  "build-builtin-queue": "generation",
  "claim-next-builtin-image": "generation",
  "classify-prompt-branches": "generation",
}
const STATE_LABELS: Record<string, string> = {
  active: "运行中",
  complete: "已完成",
  waiting: "等待",
  warning: "需处理",
  idle: "未开始",
  stale: "待刷新",
  error: "不可用",
}
const TASK_STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  pausing: "正在暂停",
  succeeded: "已完成",
  failed: "执行失败",
  paused: "已暂停",
}
const ACTIVE_TASK_STATUSES = new Set(["queued", "running", "pausing"])
const CODEX_MODEL_OPTIONS = [
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
] as const
const CODEX_REASONING_OPTIONS = [
  { value: "minimal", label: "最低 · minimal" },
  { value: "low", label: "低 · low" },
  { value: "medium", label: "中 · medium" },
  { value: "high", label: "高 · high" },
  { value: "xhigh", label: "极高 · xhigh" },
] as const
const PRESET_STORAGE_KEY = "ka-prompt-studio.route-presets.v3"
const LEGACY_PRESET_STORAGE_KEY = "ka-prompt-studio.route-presets.v2"
const ACTIVE_PRESET_STORAGE_KEY = "ka-prompt-studio.active-route-preset.v1"
const BATCH_CUSTOM_FIELDS_STORAGE_KEY = "ka-prompt-studio.batch-custom-fields.v1"
const ROUTE_LIST_PAGE_SIZE = 100

const nowIso = () => new Date().toISOString()
const safeMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback
const taskFailureSummary = (task: JsonRecord | null) => {
  const lines = String(task?.log?.text ?? "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
  const detail = lines.at(-1)
  if (detail) return detail.length > 220 ? `${detail.slice(0, 217)}…` : detail
  return Number.isInteger(task?.exitCode)
    ? `任务进程异常退出（退出码 ${task?.exitCode}）`
    : "任务未能正常完成，请展开开发者日志查看详情。"
}
const styleLabel = (id: string) => STYLES.find((item) => item.id === id)?.label ?? id
const assetLabel = (id: string) => ASSETS.find((item) => item.id === id)?.label ?? id
const referenceLabel = (id: string) => REFERENCE_MODES.find((item) => item.id === id)?.label ?? id
const percent = (done: unknown, total: unknown) =>
  Number.isFinite(done) && Number.isFinite(total) && Number(total) > 0
    ? Math.min(100, Math.max(0, (Number(done) / Number(total)) * 100))
    : null
const formatCount = (value: unknown) => (Number.isInteger(value) ? Number(value).toLocaleString("zh-CN") : "—")
const formatTime = (value: unknown) => {
  const parsed = Date.parse(String(value ?? ""))
  return Number.isFinite(parsed)
    ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(parsed)
    : "—"
}
const formatDuration = (value: unknown) => {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds < 0) return "—"
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = Math.floor(seconds % 60)
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
}
const uniqueId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const projectNameFromScreenplay = (filename: string) => {
  const withoutExtension = filename.replace(/\.(?:txt|docx)$/iu, "")
  const safe = withoutExtension
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/gu, "-")
    .replace(/[. ]+$/gu, "")
    .trim()
    .slice(0, 80)
  return safe || `剧本项目 ${new Date().toLocaleDateString("zh-CN")}`
}

function makeInitialPresets(registered: RouteModule[]): RoutePreset[] {
  const legacyTemplates = readLegacyTemplateDrafts()
  return [
    { id: "workspace", name: "本机工作设置", revision: 1, source: "本机", updatedAt: nowIso(), templates: legacyTemplates, modules: clone(registered) },
  ]
}

function routeModulesFromCatalogSummary(summary: JsonRecord | null | undefined): RouteModule[] {
  if (!summary) return []
  return (summary.conditionModules ?? []).map(normalizeRouteModule)
}

function withoutRetiredCatalogEnhancers(modules: RouteModule[]) {
  return modules.filter((entry) => entry.origin?.kind !== "catalog-enhancer")
}

const RETIRED_STARTER_PRESET_IDS = new Set(["highway-a", "highway-b"])

function withoutRetiredStarterPresets(presets: RoutePreset[]) {
  return presets.filter((preset) => !RETIRED_STARTER_PRESET_IDS.has(preset.id))
}

function readStoredPresets(registered: RouteModule[]): RoutePreset[] {
  try {
    const raw = localStorage.getItem(PRESET_STORAGE_KEY) || localStorage.getItem(LEGACY_PRESET_STORAGE_KEY)
    if (!raw) return makeInitialPresets(registered)
    const parsed = JSON.parse(raw)
    if (![2, 3].includes(parsed?.version) || !Array.isArray(parsed.presets) || !parsed.presets.length) return makeInitialPresets(registered)
    const legacyTemplates = readLegacyTemplateDrafts()
    const retainedPresets = withoutRetiredStarterPresets(parsed.presets)
    if (!retainedPresets.length) return makeInitialPresets(registered)
    return retainedPresets.map((preset: RoutePreset) => ({
      ...preset,
      revision: Math.max(1, Number.parseInt(String(preset.revision || 1), 10) || 1),
      templates: preset.templates ?? (preset.id === "workspace" ? legacyTemplates : {}),
      modules: Array.isArray(preset.modules)
        ? withoutRetiredCatalogEnhancers(preset.modules.map(normalizeRouteModule))
        : [],
    }))
  } catch {
    return makeInitialPresets(registered)
  }
}

function savePresets(presets: RoutePreset[]) {
  try {
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify({ version: 3, presets }))
  } catch {
    // Presets remain usable for this session if storage is unavailable.
  }
}

const blankReferenceSelections = () => Object.fromEntries(SHEETS.map((sheet) => [sheet, [] as string[]]))
const blankReferenceModes = () => Object.fromEntries(SHEETS.map((sheet) => [sheet, "none"]))
const blankCustomReferenceFields = () => Object.fromEntries(SHEETS.map((sheet) => [sheet, { inputImages: "", primaryRequest: "" }]))

function readBatchCustomFields(projectId: string | null, style: string) {
  if (!projectId) return blankCustomReferenceFields()
  try {
    const records = JSON.parse(localStorage.getItem(BATCH_CUSTOM_FIELDS_STORAGE_KEY) || "{}")
    return { ...blankCustomReferenceFields(), ...(records[`${projectId}|${style}`] ?? {}) }
  } catch {
    return blankCustomReferenceFields()
  }
}

function writeBatchCustomFields(projectId: string, style: string, fields: JsonRecord) {
  const records = (() => {
    try { return JSON.parse(localStorage.getItem(BATCH_CUSTOM_FIELDS_STORAGE_KEY) || "{}") }
    catch { return {} }
  })()
  records[`${projectId}|${style}`] = fields
  localStorage.setItem(BATCH_CUSTOM_FIELDS_STORAGE_KEY, JSON.stringify(records))
}

function routePresetModulesEqual(left: RoutePreset, right: RoutePreset) {
  if (left.modules.length !== right.modules.length) return false
  const leftModules = [...left.modules].sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const rightModules = [...right.modules].sort((a, b) => String(a.id).localeCompare(String(b.id)))
  return leftModules.every((entry, index) => routeModulesEqual(entry, rightModules[index]))
    && JSON.stringify(canonicalJson(left.templates)) === JSON.stringify(canonicalJson(right.templates))
}

function canonicalJson(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]))
}

function routePresetNameKey(value: string) {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN")
}

type PromptPresetContextValue = {
  presets: RoutePreset[]
  setPresets: React.Dispatch<React.SetStateAction<RoutePreset[]>>
  activePresetId: string
  setActivePresetId: React.Dispatch<React.SetStateAction<string>>
  activePreset: RoutePreset | null
}

const PromptPresetContext = React.createContext<PromptPresetContextValue | null>(null)

function usePromptPresets() {
  const context = React.useContext(PromptPresetContext)
  if (!context) throw new Error("Prompt preset context is unavailable")
  return context
}

function readActivePresetId() {
  try {
    return localStorage.getItem(ACTIVE_PRESET_STORAGE_KEY) || "workspace"
  } catch {
    return "workspace"
  }
}

async function downloadJson(filename: string, value: unknown) {
  const safeFilename = filename.replace(/[\\/:*?"<>|]+/g, "-")
  const jsonText = `${JSON.stringify(value, null, 2)}\n`
  const nativeSave = window.kaDesktopBridge?.saveJsonFile
  if (nativeSave) {
    const response = await nativeSave({ suggestedName: safeFilename, jsonText })
    if (response?.ok === false) throw new Error(response.error?.message || "桌面文件保存失败")
    const result = response?.ok === true ? response.data : response
    if (!result || typeof result.saved !== "boolean") throw new Error("桌面文件保存回执无效")
    return { saved: result.saved, fileName: typeof result.fileName === "string" ? result.fileName : safeFilename }
  }
  const blob = new Blob([jsonText], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = safeFilename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
  return { saved: true, fileName: safeFilename }
}

function StatusDot({ state }: { state?: string | null }) {
  const active = state === "active"
  const good = state === "complete"
  const warning = state === "warning" || state === "error"
  return (
    <span className="relative flex size-2.5 shrink-0" aria-hidden="true">
      <span className={cn(
        "relative inline-flex size-2.5 rounded-full bg-muted-foreground/45",
        active && "bg-info",
        good && "bg-success",
        warning && "bg-warning",
      )} />
    </span>
  )
}

function SectionHeading({ title, description, action, titleClassName }: { title: string; description?: string; action?: React.ReactNode; titleClassName?: string }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-4">
      <div className="min-w-0">
        <h3 className={cn("text-sm font-semibold tracking-tight", titleClassName)}>{title}</h3>
        {description && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  )
}

function EmptyState({ icon: Icon = PackageOpen, children }: { icon?: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="flex min-h-28 flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/25 px-5 py-6 text-center text-sm text-muted-foreground">
      <Icon className="size-5" aria-hidden="true" />
      <span>{children}</span>
    </div>
  )
}

function AgentChatCard({
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

export default function App() {
  const { resolvedTheme, setTheme } = useTheme()
  const [motionMode, setMotionMode] = React.useState<"full" | "reduced">(() =>
    localStorage.getItem("ka-prompt-studio.motion") === "reduced" ? "reduced" : "full",
  )
  const [projects, setProjects] = React.useState<ProjectCard[]>([])
  const [activeProjectId, setActiveProjectId] = React.useState<string | null>(null)
  const [selectionRevision, setSelectionRevision] = React.useState(0)
  const [snapshot, setSnapshot] = React.useState<JsonRecord | null>(null)
  const [projectsLoading, setProjectsLoading] = React.useState(true)
  const [drawerOpen, setDrawerOpen] = React.useState(false)
  const [drawerMounted, setDrawerMounted] = React.useState(false)
  const [drawerTab, setDrawerTab] = React.useState("batch")
  const [pendingAssetDialogOpen, setPendingAssetDialogOpen] = React.useState(false)
  const [desktopHost, setDesktopHost] = React.useState(false)
  const [newProjectOpen, setNewProjectOpen] = React.useState(false)
  const [newProjectName, setNewProjectName] = React.useState("")
  const [renameProjectOpen, setRenameProjectOpen] = React.useState(false)
  const [renameProjectName, setRenameProjectName] = React.useState("")
  const [deleteProjectOpen, setDeleteProjectOpen] = React.useState(false)
  const [busyAction, setBusyAction] = React.useState<string | null>(null)
  const [tasks, setTasks] = React.useState<Record<string, JsonRecord>>({})
  const [clockNow, setClockNow] = React.useState(() => Date.now())
  const [activeStageTiming, setActiveStageTiming] = React.useState<{ key: string; startedAt: number } | null>(null)
  const [taskLogOpen, setTaskLogOpen] = React.useState(false)
  const [dismissedFailureTaskIds, setDismissedFailureTaskIds] = React.useState<string[]>([])
  const [codexStatus, setCodexStatus] = React.useState<JsonRecord | null>(null)
  const [codexChecking, setCodexChecking] = React.useState(true)
  const [codexRuntimeConfig, setCodexRuntimeConfig] = React.useState<JsonRecord | null>(null)
  const [codexRuntimeConfigSaving, setCodexRuntimeConfigSaving] = React.useState(false)
  const [agentChatSessions, setAgentChatSessions] = React.useState<Record<string, JsonRecord>>({})
  const [agentChatDrafts, setAgentChatDrafts] = React.useState<Record<string, string>>({})
  const [confirmedAgentProposalIds, setConfirmedAgentProposalIds] = React.useState<string[]>([])
  const [toast, setToast] = React.useState<ToastState | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const projectButtonRefs = React.useRef(new Map<string, HTMLButtonElement>())
  const toastSequence = React.useRef(0)
  const drawerPhase = React.useRef<"closed" | "opening" | "open" | "closing">("closed")
  const drawerReturnFocus = React.useRef<HTMLElement | null>(null)
  const batchStudioButtonRef = React.useRef<HTMLButtonElement>(null)
  const watchedTaskIds = React.useRef(new Set<string>())
  const watchedAgentChatIds = React.useRef(new Set<string>())
  const promptedPendingStates = React.useRef(new Set<string>())

  const activeProject = projects.find((project) => project.projectId === activeProjectId) ?? null
  const activeTask = activeProjectId ? tasks[activeProjectId] ?? null : null
  const activeProjectHasRunningTask = ACTIVE_TASK_STATUSES.has(String(activeTask?.status))
  const activeTaskActuallyRunning = ["running", "pausing"].includes(String(activeTask?.status))
    && Number.isFinite(Date.parse(String(activeTask?.startedAt ?? "")))
  const codexConnected = codexStatus?.connected === true
  const activeAgentChat = activeProjectId ? agentChatSessions[activeProjectId] ?? null : null
  const activeAgentChatDraft = activeProjectId ? agentChatDrafts[activeProjectId] ?? "" : ""
  const codexRuntimeConfigLocked = activeProjectHasRunningTask || activeAgentChat?.status === "running"

  const notify = React.useCallback((message: string, tone: ToastState["tone"] = "good") => {
    const id = ++toastSequence.current
    setToast({ id, message, tone })
    if (tone !== "error") {
      window.setTimeout(
        () => setToast((current) => current?.id === id ? null : current),
        tone === "warning" ? 6500 : 3600,
      )
    }
  }, [])

  const checkCodexStatus = React.useCallback(async ({ quiet = false } = {}) => {
    setCodexChecking(true)
    try {
      const status = await codexStatusAdapter.getStatus()
      setCodexStatus(status)
      if (!quiet) notify(status.connected ? "Codex SDK 授权有效" : status.message, status.connected ? "good" : "warning")
    } catch (error) {
      setCodexStatus(null)
      if (!quiet) notify(safeMessage(error, "Codex SDK 状态检测失败"), "error")
    } finally {
      setCodexChecking(false)
    }
  }, [notify])

  const refreshCodexRuntimeConfig = React.useCallback(async () => {
    try {
      setCodexRuntimeConfig(await codexAgentChatAdapter.getRuntimeConfig())
    } catch {
      setCodexRuntimeConfig(null)
    }
  }, [])

  const authorizeCodex = React.useCallback(async () => {
    setBusyAction("authorize-codex")
    setCodexChecking(true)
    try {
      const login = await codexStatusAdapter.startLogin()
      if (!login.alreadyConnected) notify("已打开内置 Codex CLI 登录，请在浏览器中完成授权", "warning")
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, 1500))
        const status = await codexStatusAdapter.getStatus()
        setCodexStatus(status)
        if (status.connected) {
          void refreshCodexRuntimeConfig()
          notify(login.alreadyConnected ? "Codex SDK 授权有效" : "Codex 登录成功，后续启动将复用本机登录状态", "good")
          return
        }
      }
      notify("尚未完成 Codex 登录；完成浏览器授权后可点击重新检测", "warning")
    } catch (error) {
      notify(safeMessage(error, "内置 Codex CLI 登录启动失败"), "error")
    } finally {
      setCodexChecking(false)
      setBusyAction(null)
    }
  }, [notify, refreshCodexRuntimeConfig])

  const refreshProjects = React.useCallback(async (quiet = false) => {
    if (!quiet) setProjectsLoading(true)
    try {
      const result = await workspaceAdapter.listProjects()
      const next = result.projects as ProjectCard[]
      setProjects((current) => {
        const unchanged = current.length === next.length && current.every((project, index) => {
          const candidate = next[index]
          if (!candidate) return false
          return project.projectId === candidate.projectId
            && project.displayName === candidate.displayName
            && project.availability === candidate.availability
            && project.storageMode === candidate.storageMode
            && JSON.stringify(project.statusSummary) === JSON.stringify(candidate.statusSummary)
        })
        return unchanged ? current : next
      })
      setActiveProjectId((current) => current && next.some((project) => project.projectId === current)
        ? current
        : next[0]?.projectId ?? null)
    } catch (error) {
      if (!quiet) notify(safeMessage(error, "项目列表读取失败"), "error")
    } finally {
      if (!quiet) setProjectsLoading(false)
    }
  }, [notify])

  React.useEffect(() => {
    setDesktopHost(typeof window.kaDesktopBridge?.setStudioDrawerOpen === "function")
    void checkCodexStatus({ quiet: true })
    void refreshCodexRuntimeConfig()
  }, [checkCodexStatus, refreshCodexRuntimeConfig])

  React.useEffect(() => {
    setTaskLogOpen(false)
    setPendingAssetDialogOpen(false)
  }, [activeTask?.taskId])

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      React.startTransition(() => setDrawerMounted(true))
    }, 350)
    return () => window.clearTimeout(timer)
  }, [])

  React.useEffect(() => {
    if (drawerOpen) return
    let interval = 0
    const resume = window.setTimeout(() => {
      void refreshProjects()
      interval = window.setInterval(() => void refreshProjects(true), 3000)
    }, 220)
    return () => {
      window.clearTimeout(resume)
      window.clearInterval(interval)
    }
  }, [drawerOpen, refreshProjects])

  React.useEffect(() => {
    document.documentElement.dataset.motion = motionMode
    localStorage.setItem("ka-prompt-studio.motion", motionMode)
  }, [motionMode])

  React.useEffect(() => {
    if (!activeProjectId) {
      setSnapshot(null)
      return
    }
    if (drawerOpen) return
    let cancelled = false
    let timer = 0
    const poll = async () => {
      try {
        const result = await workspaceAdapter.getSnapshot({ projectId: activeProjectId, selectionRevision })
        if (!cancelled) setSnapshot(result.snapshot)
        const delay = Math.max(750, Math.min(5000, Number(result.snapshot.pollAfterMs) || 1500))
        if (!cancelled) timer = window.setTimeout(poll, delay)
      } catch (error) {
        if (!cancelled) {
          notify(safeMessage(error, "项目状态读取失败"), "warning")
          timer = window.setTimeout(poll, 4000)
        }
      }
    }
    timer = window.setTimeout(poll, 220)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [activeProjectId, drawerOpen, notify, selectionRevision])

  const selectProject = async (projectId: string) => {
    if (projectId === activeProjectId) return
    if (desktopHost) {
      try {
        const result = await workspaceAdapter.selectProject({ projectId, expectedRevision: selectionRevision })
        setSelectionRevision(result.selectionRevision)
      } catch (error) {
        notify(safeMessage(error, "切换项目失败"), "error")
        return
      }
    } else {
      setSelectionRevision((value) => value + 1)
    }
    setActiveProjectId(projectId)
    setSnapshot(null)
  }

  const focusProjectFromKey = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const lastIndex = projects.length - 1
    const nextIndex = event.key === "ArrowRight" || event.key === "ArrowDown"
      ? Math.min(lastIndex, index + 1)
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? Math.max(0, index - 1)
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? lastIndex
            : null
    if (nextIndex == null || nextIndex === index) return
    event.preventDefault()
    projectButtonRefs.current.get(projects[nextIndex].projectId)?.focus()
  }

  const setStudioOpen = React.useCallback((open: boolean, tab = drawerTab) => {
    if (open && drawerPhase.current === "open") {
      setDrawerTab(tab)
      return
    }
    if (!open && drawerPhase.current === "closed") return

    drawerPhase.current = open ? "open" : "closed"
    if (open) {
      setDrawerTab(tab)
      drawerReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setDrawerMounted(true)
      setDrawerOpen(true)
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => document.getElementById("prompt-studio-drawer")?.focus())
      })
    } else {
      setDrawerOpen(false)
      const returnTarget = drawerReturnFocus.current?.isConnected ? drawerReturnFocus.current : batchStudioButtonRef.current
      window.requestAnimationFrame(() => returnTarget?.focus())
      drawerReturnFocus.current = null
    }
  }, [drawerTab])

  const closeStudio = React.useCallback(() => {
    void setStudioOpen(false)
  }, [setStudioOpen])

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      const eventTarget = event.target instanceof HTMLElement ? event.target : null
      const editingText = Boolean(eventTarget?.closest('input, textarea, select, [contenteditable="true"]'))
      const nestedDialog = document.querySelector('[role="dialog"]:not(#prompt-studio-drawer), [role="alertdialog"]')
      if (!editingText && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault()
        void setStudioOpen(!drawerOpen, "batch")
      }
      if (!editingText && (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault()
        void setStudioOpen(true, "routes")
      }
      if (event.key === "Tab" && drawerOpen && !nestedDialog) {
        const drawer = document.getElementById("prompt-studio-drawer")
        const focusable = drawer
          ? [...drawer.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
              .filter((element) => element.getClientRects().length > 0)
          : []
        if (!drawer || !focusable.length) {
          event.preventDefault()
          drawer?.focus()
        } else {
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          const active = document.activeElement
          if (!drawer.contains(active) || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
            event.preventDefault()
            ;(event.shiftKey ? last : first).focus()
          }
        }
      }
      if (event.key === "Escape" && drawerOpen && !nestedDialog) {
        setStudioOpen(false)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [drawerOpen, setStudioOpen])

  const createProject = async () => {
    if (!newProjectName.trim()) return
    setBusyAction("create-project")
    try {
      const created = await controlAdapter.createProject({ displayName: newProjectName })
      setNewProjectOpen(false)
      setNewProjectName("")
      await refreshProjects()
      await selectProject(created.projectId)
      notify(`项目“${created.displayName}”已创建`)
    } catch (error) {
      notify(safeMessage(error, "新建项目失败"), "error")
    } finally {
      setBusyAction(null)
    }
  }

  const renameCurrentProject = async () => {
    if (!activeProject || !renameProjectName.trim()) return
    setBusyAction("rename-project")
    try {
      const renamed = await controlAdapter.renameProject({ projectId: activeProject.projectId, displayName: renameProjectName })
      setProjects((items) => items.map((project) => project.projectId === renamed.projectId
        ? { ...project, displayName: renamed.displayName }
        : project))
      setRenameProjectOpen(false)
      notify(`当前项目已重命名为“${renamed.displayName}”`)
    } catch (error) {
      notify(safeMessage(error, "项目重命名失败"), "error")
    } finally {
      setBusyAction(null)
    }
  }

  const deleteCurrentProject = async () => {
    if (!activeProject) return
    if (activeAgentChat?.status === "running") {
      notify("请先停止当前项目的 Agent 对话，再删除项目", "warning")
      return
    }
    const projectId = activeProject.projectId
    const projectName = activeProject.displayName
    setBusyAction("delete-project")
    try {
      await controlAdapter.deleteProject({ projectId })
      const remaining = projects.filter((project) => project.projectId !== projectId)
      setProjects(remaining)
      setTasks((items) => {
        const next = { ...items }
        delete next[projectId]
        return next
      })
      setActiveProjectId((current) => current === projectId ? remaining[0]?.projectId ?? null : current)
      setSnapshot(null)
      setDeleteProjectOpen(false)
      notify(`项目“${projectName}”已删除`, "warning")
      void refreshProjects(true)
    } catch (error) {
      notify(safeMessage(error, "项目删除失败"), "error")
    } finally {
      setBusyAction(null)
    }
  }

  const createProjectFromScreenplay = async (file: File) => {
    setBusyAction("screenplay-project")
    let created: JsonRecord | null = null
    let uploaded = false
    try {
      const baseName = projectNameFromScreenplay(file.name)
      for (let attempt = 1; attempt <= 99; attempt += 1) {
        const displayName = attempt === 1 ? baseName : `${baseName.slice(0, 75)} (${attempt})`
        try {
          created = await controlAdapter.createProject({ displayName })
          break
        } catch (error) {
          if ((error as JsonRecord)?.code !== "PROJECT_EXISTS" || attempt === 99) throw error
        }
      }
      if (!created) throw new Error("无法创建剧本项目")
      const result = await controlAdapter.uploadScreenplay({ projectId: created.projectId, file, overwrite: false })
      uploaded = true
      await refreshProjects()
      await selectProject(created.projectId)
      notify(`已为“${result.filename}”新建独立项目`)
    } catch (error) {
      if (created && !uploaded) {
        try { await controlAdapter.deleteProject({ projectId: created.projectId }) }
        catch { /* Keep the original import error as the user-facing failure. */ }
        void refreshProjects(true)
      }
      notify(safeMessage(error, "剧本导入或项目创建失败"), "error")
    } finally {
      setBusyAction(null)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  const watchTask = React.useCallback(async (projectId: string, task: JsonRecord) => {
    if (watchedTaskIds.current.has(task.taskId)) return
    watchedTaskIds.current.add(task.taskId)
    let current = task
    try {
      while (ACTIVE_TASK_STATUSES.has(String(current.status))) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000))
        current = await controlAdapter.getTask({ projectId, taskId: current.taskId })
        setTasks((items) => ({ ...items, [projectId]: current }))
      }
      if (current.status === "succeeded") notify("任务已完成", "good")
      else if (current.status === "paused") notify("任务已暂停，可以重新开始流水线", "warning")
      else notify(`任务执行失败：${taskFailureSummary(current)}`, "error")
      await refreshProjects(true)
    } catch (error) {
      notify(safeMessage(error, "任务状态跟踪中断，请刷新后重试"), "error")
    } finally {
      watchedTaskIds.current.delete(task.taskId)
    }
  }, [notify, refreshProjects])

  const runTask = React.useCallback(async (
    action: string,
    workbookScope: {
      workbookEpisodeStart?: number | null
      workbookEpisodeEnd?: number | null
      workbookAssetTypes?: string[]
    } = {},
  ) => {
    if (!activeProjectId || ACTIVE_TASK_STATUSES.has(String(activeTask?.status))) return false
    setBusyAction(action)
    try {
      const task = await controlAdapter.startTask({
        projectId: activeProjectId,
        action,
        workbookEpisodeStart: workbookScope.workbookEpisodeStart ?? null,
        workbookEpisodeEnd: workbookScope.workbookEpisodeEnd ?? null,
        workbookAssetTypes: workbookScope.workbookAssetTypes ?? [],
      })
      setTasks((items) => ({ ...items, [activeProjectId]: task }))
      notify("任务已进入当前项目的独立队列")
      void watchTask(activeProjectId, task)
      return true
    } catch (error) {
      notify(safeMessage(error, "任务启动失败"), "error")
      return false
    } finally {
      setBusyAction(null)
    }
  }, [activeProjectId, activeTask?.status, notify, watchTask])

  const pauseCurrentTask = React.useCallback(async () => {
    if (!activeProjectId || !activeTask?.taskId || !["queued", "running"].includes(activeTask.status)) return false
    setBusyAction("pause-task")
    try {
      const paused = await controlAdapter.pauseTask({ projectId: activeProjectId, taskId: activeTask.taskId })
      setTasks((items) => ({ ...items, [activeProjectId]: paused }))
      setTaskLogOpen(false)
      notify("暂停请求已发送，后台执行进程正在停止", "warning")
      void watchTask(activeProjectId, paused)
      await refreshProjects(true)
      return true
    } catch (error) {
      notify(safeMessage(error, "暂停任务失败"), "error")
      return false
    } finally {
      setBusyAction(null)
    }
  }, [activeProjectId, activeTask, notify, refreshProjects, watchTask])

  const watchAgentChat = React.useCallback(async (projectId: string, session: JsonRecord) => {
    const sessionId = String(session.sessionId ?? "")
    if (!sessionId || watchedAgentChatIds.current.has(sessionId)) return
    watchedAgentChatIds.current.add(sessionId)
    let current = session
    try {
      while (current.status === "running") {
        await new Promise((resolve) => window.setTimeout(resolve, 650))
        current = await codexAgentChatAdapter.getSession({ projectId, sessionId })
        setAgentChatSessions((items) => ({ ...items, [projectId]: current }))
      }
      if (current.status === "failed") notify(current.error || "Agent 对话失败", "error")
    } catch (error) {
      notify(safeMessage(error, "Agent 对话状态跟踪中断"), "error")
    } finally {
      watchedAgentChatIds.current.delete(sessionId)
    }
  }, [notify])

  const sendAgentChatMessage = React.useCallback(async () => {
    if (!activeProjectId || !codexConnected || activeAgentChat?.status === "running") return
    const message = activeAgentChatDraft.trim()
    if (!message) return
    try {
      const session = await codexAgentChatAdapter.sendMessage({
        projectId: activeProjectId,
        sessionId: activeAgentChat?.sessionId ?? null,
        message,
      })
      setAgentChatSessions((items) => ({ ...items, [activeProjectId]: session }))
      setAgentChatDrafts((items) => ({ ...items, [activeProjectId]: "" }))
      setCodexRuntimeConfig(session.runtimeConfig)
      void watchAgentChat(activeProjectId, session)
    } catch (error) {
      notify(safeMessage(error, "Agent 消息发送失败"), "error")
    }
  }, [activeAgentChat, activeAgentChatDraft, activeProjectId, codexConnected, notify, watchAgentChat])

  const cancelAgentChat = React.useCallback(async () => {
    if (!activeProjectId || !activeAgentChat?.sessionId || activeAgentChat.status !== "running") return
    try {
      const session = await codexAgentChatAdapter.cancelSession({
        projectId: activeProjectId,
        sessionId: activeAgentChat.sessionId,
      })
      setAgentChatSessions((items) => ({ ...items, [activeProjectId]: session }))
    } catch (error) {
      notify(safeMessage(error, "Agent 对话停止失败"), "error")
    }
  }, [activeAgentChat, activeProjectId, notify])

  const newAgentConversation = React.useCallback(() => {
    if (!activeProjectId || activeAgentChat?.status === "running") return
    setAgentChatSessions((items) => {
      const next = { ...items }
      delete next[activeProjectId]
      return next
    })
    setAgentChatDrafts((items) => ({ ...items, [activeProjectId]: "" }))
  }, [activeAgentChat?.status, activeProjectId])

  const updateCodexRuntimeConfig = React.useCallback(async (next: { model: string; reasoningEffort: string }) => {
    if (codexRuntimeConfigSaving || activeProjectHasRunningTask || activeAgentChat?.status === "running") return
    setCodexRuntimeConfigSaving(true)
    try {
      const updated = await codexAgentChatAdapter.updateRuntimeConfig(next)
      setCodexRuntimeConfig(updated)
      if (activeProjectId) {
        setAgentChatSessions((items) => {
          const nextSessions = { ...items }
          delete nextSessions[activeProjectId]
          return nextSessions
        })
      }
      notify("Codex 模型配置已保存；新对话和新任务将使用此配置")
    } catch (error) {
      notify(safeMessage(error, "Codex 模型配置保存失败"), "error")
    } finally {
      setCodexRuntimeConfigSaving(false)
    }
  }, [activeAgentChat?.status, activeProjectHasRunningTask, activeProjectId, codexRuntimeConfigSaving, notify])

  const confirmAgentProposal = React.useCallback(async (message: JsonRecord) => {
    const proposal = message?.proposal
    const messageId = String(message?.messageId ?? "")
    if (!proposal || !messageId || confirmedAgentProposalIds.includes(messageId)) return
    let completed = false
    if (proposal.action === "pause-current-task") {
      if (!activeProjectHasRunningTask) {
        notify("当前项目没有可暂停的任务", "warning")
        return
      }
      completed = await pauseCurrentTask()
    }
    else if (proposal.action === "refresh-project") {
      await refreshProjects()
      completed = true
    } else {
      if (activeProjectHasRunningTask) {
        notify("当前项目已有任务运行，请先暂停后再确认新操作", "warning")
        return
      }
      completed = await runTask(proposal.action, {
        workbookEpisodeStart: proposal.workbookEpisodeStart ?? null,
        workbookEpisodeEnd: proposal.workbookEpisodeEnd ?? null,
        workbookAssetTypes: proposal.workbookAssetTypes ?? [],
      })
    }
    if (completed) setConfirmedAgentProposalIds((items) => [...items, messageId].slice(-256))
  }, [activeProjectHasRunningTask, confirmedAgentProposalIds, notify, pauseCurrentTask, refreshProjects, runTask])

  React.useEffect(() => {
    if (!activeProjectId) return
    let cancelled = false
    void controlAdapter.listTasks({ projectId: activeProjectId }).then(({ tasks: projectTasks }) => {
      if (cancelled) return
      const latest = projectTasks.at(-1) ?? null
      setTasks((items) => {
        const next = { ...items }
        if (latest) next[activeProjectId] = latest
        else delete next[activeProjectId]
        return next
      })
      if (latest && ACTIVE_TASK_STATUSES.has(String(latest.status))) void watchTask(activeProjectId, latest)
    }).catch((error) => {
      if (!cancelled) notify(safeMessage(error, "任务历史恢复失败"), "warning")
    })
    return () => { cancelled = true }
  }, [activeProjectId, notify, watchTask])

  const copyTaskLog = React.useCallback(async () => {
    const text = String(activeTask?.log?.text ?? "")
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      notify("任务日志已复制")
    } catch (error) {
      notify(safeMessage(error, "任务日志复制失败"), "warning")
    }
  }, [activeTask?.log?.text, notify])

  const openDirectory = async (kind: "project" | "output") => {
    if (!activeProjectId) return
    try {
      await workspaceAdapter.openProjectDirectory({ projectId: activeProjectId, kind })
      notify(kind === "project" ? "项目文件夹已打开" : "输出文件夹已打开")
    } catch (error) {
      notify(safeMessage(error, "目录打开失败"), "warning")
    }
  }

  const refreshActiveProjectState = React.useCallback(async () => {
    const projectId = activeProjectId
    await refreshProjects(true)
    if (!projectId) return
    try {
      const result = await workspaceAdapter.getSnapshot({ projectId, selectionRevision })
      setSnapshot(result.snapshot)
    } catch (error) {
      notify(safeMessage(error, "人工确认后的项目状态刷新失败"), "warning")
    }
  }, [activeProjectId, notify, refreshProjects, selectionRevision])

  const summary = activeProject?.statusSummary ?? {}
  const batchCounts = snapshot?.batch?.counts ?? {}
  const activeProjectIsIsolated = activeProject?.storageMode === "isolated-project"
  const pendingAssetCount = snapshot?.pending?.known === true
    ? Math.max(0, Number(snapshot.pending.count) || 0)
    : 0
  const pipelineStages = snapshot?.pipeline?.stages ?? [
    { id: "split", label: "剧本切分", state: "idle" },
    { id: "analysis", label: "分析与累计", state: "idle" },
    { id: "world-overview", label: "世界观总览", state: "idle" },
    { id: "asset-visual-specs", label: "资产设定", state: "idle" },
    { id: "excel", label: "Excel 制表", state: "idle" },
    { id: "generation", label: "资产出图", state: "idle" },
  ]
  const pendingAssetsReady = pendingAssetCount > 0
    && pipelineStages.find((stage: JsonRecord) => stage.id === "analysis")?.state === "complete"
    && pipelineStages.find((stage: JsonRecord) => stage.id === "world-overview")?.state === "complete"
  const rawPipelinePhase = snapshot?.pipeline?.phase ?? summary.phase ?? "split"
  const activeTaskStageId = activeProjectHasRunningTask
    ? activeTask?.action === "run-full-pipeline" || activeTask?.action === "build-scoped-workbook"
      ? rawPipelinePhase === "waiting-generation" || rawPipelinePhase === "complete" ? "excel" : rawPipelinePhase
      : TASK_STAGE_BY_ACTION[activeTask?.action]
    : null
  const activeTaskStartedAtMs = Date.parse(String(activeTask?.startedAt ?? ""))
  const activeTaskFinishedAtMs = Date.parse(String(activeTask?.finishedAt ?? ""))
  const projectElapsedSeconds = Number.isFinite(activeTaskStartedAtMs)
    ? Math.max(0, Math.floor(((activeTaskActuallyRunning
      ? clockNow
      : Number.isFinite(activeTaskFinishedAtMs) ? activeTaskFinishedAtMs : activeTaskStartedAtMs) - activeTaskStartedAtMs) / 1000))
    : null
  const displayPipelineStages = pipelineStages.map((stage: JsonRecord) => {
    if (activeTask?.status === "paused" && stage.state === "active") return { ...stage, state: "warning" }
    if (!activeTaskActuallyRunning && stage.state === "active") return { ...stage, state: "waiting" }
    if (activeTaskActuallyRunning && activeTaskStageId === stage.id) return { ...stage, state: "active" }
    return stage
  })
  const currentPipelinePhase = activeTaskStageId ?? rawPipelinePhase
  const analysisStage = pipelineStages.find((stage: JsonRecord) => stage.id === "analysis")
  const currentAnalysisEpisode = typeof analysisStage?.currentEpisode === "number"
    && Number.isInteger(analysisStage.currentEpisode)
    && analysisStage.currentEpisode > 0
      ? analysisStage.currentEpisode
      : null
  const currentStageLabel = pendingAssetsReady && !activeTaskActuallyRunning
    ? "等待人工确认"
    : activeTask?.status === "paused"
      ? "流水线已暂停"
    : activeTask?.status === "pausing"
      ? "流水线正在暂停"
      : activeTask?.status === "queued"
        ? "任务已排队"
      : !activeTaskActuallyRunning && currentPipelinePhase !== "complete"
        ? currentPipelinePhase === "analysis" && currentAnalysisEpisode !== null
          ? `剧本分析 - 第 ${currentAnalysisEpisode} 集（未运行）`
          : `${PHASE_LABELS[currentPipelinePhase] ?? "流水线"}（未运行）`
      : currentPipelinePhase === "analysis" && currentAnalysisEpisode !== null
        ? `剧本分析 - 第 ${currentAnalysisEpisode} 集分析中`
        : CURRENT_STAGE_LABELS[currentPipelinePhase] ?? `${PHASE_LABELS[currentPipelinePhase] ?? "流水线"}中`
  const visualSpecsStage = pipelineStages.find((stage: JsonRecord) => stage.id === "asset-visual-specs")
  const visualSpecsTask = snapshot?.pipeline?.currentTask?.scope === "asset-visual-specs"
    ? snapshot.pipeline.currentTask
    : null
  const showVisualSpecsCard = activeTaskActuallyRunning && (currentPipelinePhase === "asset-visual-specs"
    || visualSpecsStage?.state === "active")
  const screenplaySource = snapshot?.screenplay?.label
    ?? snapshot?.screenplay?.filename
    ?? "尚未导入剧本"
  const completedStageCount = displayPipelineStages.filter((stage: JsonRecord) => stage.state === "complete").length
  const activePipelineStage = displayPipelineStages.find((stage: JsonRecord) => stage.state === "active")
  const activeStageProgress = activePipelineStage?.progress?.mode === "determinate"
    ? percent(activePipelineStage.progress.done, activePipelineStage.progress.total)
    : null
  const summaryProgress = currentPipelinePhase === "complete"
    ? 100
    : displayPipelineStages.length
      ? Math.min(100, ((completedStageCount + (activeStageProgress ?? 0) / 100) / displayPipelineStages.length) * 100)
      : 0
  const showSummaryProgressPercent = currentPipelinePhase === "complete"
    || !activePipelineStage
    || activeStageProgress !== null

  React.useEffect(() => {
    if (!activeTaskActuallyRunning) return
    setClockNow(Date.now())
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [activeTaskActuallyRunning, activeTask?.taskId])

  React.useEffect(() => {
    if (!activeTaskActuallyRunning || !activeTaskStageId || !activeTask?.taskId) {
      setActiveStageTiming(null)
      return
    }
    const key = `${activeTask.taskId}:${activeTaskStageId}`
    setActiveStageTiming((current) => current?.key === key ? current : { key, startedAt: Date.now() })
  }, [activeTask?.taskId, activeTaskActuallyRunning, activeTaskStageId])

  const activeStageElapsedSeconds = activeStageTiming
    ? Math.max(0, Math.floor((clockNow - activeStageTiming.startedAt) / 1000))
    : null

  React.useEffect(() => {
    if (!activeProjectId) return
    if (pendingAssetCount === 0) {
      promptedPendingStates.current.delete(activeProjectId)
      return
    }
    if (!pendingAssetsReady || activeProjectHasRunningTask || promptedPendingStates.current.has(activeProjectId)) return
    promptedPendingStates.current.add(activeProjectId)
    setPendingAssetDialogOpen(true)
  }, [activeProjectHasRunningTask, activeProjectId, pendingAssetCount, pendingAssetsReady])

  return (
    <div className={cn("relative isolate flex h-dvh min-w-0 overflow-hidden text-foreground transition-colors duration-150", drawerOpen ? "bg-muted/70" : "bg-background")}>
      <section
        inert={drawerOpen}
        className={cn(
          "relative h-dvh min-w-0 flex-1 overflow-hidden bg-background",
          drawerOpen && "rounded-2xl shadow-panel",
        )}
      >
        <div className="flex h-full min-h-0 flex-col bg-muted/25">
          <header className="flex h-11 shrink-0 items-center gap-4 border-b bg-card px-4 text-[11px] text-muted-foreground">
            <div className="flex shrink-0 items-center gap-2 font-semibold text-foreground"><Boxes className="size-4 text-primary" />KA Asset Batch</div>
            <Separator orientation="vertical" className="h-5" />
            <div className="flex min-w-0 flex-1 items-center gap-5 overflow-hidden">
              <span className="flex shrink-0 items-center gap-2"><StatusDot state={summary.state} />{PHASE_LABELS[summary.phase] ?? "等待开始"}</span>
              <span className="hidden shrink-0 sm:inline">项目用时 {formatDuration(projectElapsedSeconds)}</span>
              <span className="hidden shrink-0 xl:inline">刷新 {formatTime(summary.observedAt)}</span>
              <span className="hidden shrink-0 xl:inline">提示词库 正式注册表</span>
            </div>
            <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" onClick={() => setMotionMode((value) => value === "full" ? "reduced" : "full")} aria-label={motionMode === "full" ? "减少界面动效" : "开启动效"}><Sparkles className={cn(motionMode === "reduced" && "opacity-40")} /></Button></TooltipTrigger><TooltipContent>{motionMode === "full" ? "当前：标准动效" : "当前：减少动效"}</TooltipContent></Tooltip>
            <Tooltip><TooltipTrigger asChild><Button variant="ghost" size="icon-sm" onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")} aria-label="切换主题">{resolvedTheme === "dark" ? <Sun /> : <Moon />}</Button></TooltipTrigger><TooltipContent>切换明暗主题</TooltipContent></Tooltip>
          </header>

          <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-6xl space-y-4 p-4 sm:p-5">
              <header className="relative flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <Card className={cn(
                    "z-10 w-[320px] max-w-full shrink-0 gap-0 py-0 shadow-panel transition-colors sm:absolute sm:top-1/2 sm:right-[calc(100%+1rem)] sm:-translate-y-1/2",
                    !codexChecking && codexConnected && "border-success/70 bg-success/5",
                    !codexChecking && !codexConnected && "border-destructive/55 bg-destructive/5",
                  )}>
                    <CardContent className="flex items-center gap-1.5 px-2.5 py-3">
                      <div className="flex min-w-0 flex-1 items-center gap-1.5" aria-live="polite">
                        <span className={cn(
                          "grid size-7 shrink-0 place-items-center rounded-full border-2 bg-background",
                          codexChecking ? "border-muted-foreground/35 text-muted-foreground" : codexConnected ? "border-success text-success" : "border-destructive text-destructive",
                        )}>
                          {codexChecking ? <LoaderCircle className="size-4 animate-spin" aria-label="正在检测" /> : codexConnected ? <Check className="size-4" aria-label="已连接" /> : <X className="size-4" aria-label="未连接" />}
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-[11px] font-semibold">Codex SDK 授权状态检测</p>
                          {!codexChecking && !codexConnected ? (
                            <Button className="mt-0.5 h-5 gap-1 px-1.5 text-[10px]" size="sm" onClick={() => void authorizeCodex()} disabled={busyAction === "authorize-codex"}>
                              {busyAction === "authorize-codex" ? <LoaderCircle className="size-3 animate-spin" /> : <Network className="size-3" />}
                              授权 Codex SDK
                            </Button>
                          ) : (
                            <p className={cn("mt-0.5 truncate text-[10px]", codexConnected ? "text-success" : "text-muted-foreground")}>
                              {codexChecking ? "正在检查 Codex SDK 与登录状态…" : codexStatus?.message ?? "Codex SDK 状态暂不可用"}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button className="size-7" variant="ghost" size="icon-sm" onClick={() => void checkCodexStatus()} disabled={codexChecking} aria-label={codexConnected ? "重新检测 Codex SDK" : "检测 Codex SDK 连接"}>
                              <RefreshCw className={cn(codexChecking && "animate-spin")} />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{codexConnected ? "重新检测" : "检测连接"}</TooltipContent>
                        </Tooltip>
                      </div>
                    </CardContent>
                  </Card>
                  <AgentChatCard
                    projectId={activeProjectId}
                    connected={codexConnected}
                    runtimeConfig={codexRuntimeConfig}
                    session={activeAgentChat}
                    draft={activeAgentChatDraft}
                    confirmedProposalIds={confirmedAgentProposalIds}
                    onDraftChange={(value) => {
                      if (activeProjectId) setAgentChatDrafts((items) => ({ ...items, [activeProjectId]: value }))
                    }}
                    onSend={() => void sendAgentChatMessage()}
                    onCancel={() => void cancelAgentChat()}
                    onNewConversation={newAgentConversation}
                    onRuntimeConfigChange={(next) => void updateCodexRuntimeConfig(next)}
                    runtimeConfigSaving={codexRuntimeConfigSaving}
                    runtimeConfigLocked={codexRuntimeConfigLocked}
                    onConfirmProposal={(message) => void confirmAgentProposal(message)}
                  />
                  <div className="min-w-0">
                    <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground"><Activity className="size-3.5" />生产监听</div>
                    <h1 className="truncate text-2xl font-semibold tracking-tight">{activeProject?.displayName ?? "选择一个项目"}</h1>
                    <p className="mt-1 text-xs text-muted-foreground">当前项目独立使用目录、Cache、输出、队列与锁。</p>
                  </div>
                <div className="flex shrink-0 flex-wrap gap-2 sm:self-end" aria-label="当前项目目录操作">
                  <Button variant="outline" size="sm" onClick={() => void openDirectory("project")} disabled={!activeProject}><FolderOpen />项目文件夹</Button>
                  <Button variant="outline" size="sm" onClick={() => void openDirectory("output")} disabled={!activeProject}><FileOutput />输出文件夹</Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => void refreshProjects()} disabled={projectsLoading} aria-label="刷新项目"><RefreshCw className={cn(projectsLoading && "animate-spin")} /></Button>
                </div>
              </header>

              <Card className="gap-3 py-4 shadow-panel">
                <CardHeader className="px-4">
                  <SectionHeading
                    title="项目任务"
                    titleClassName="text-lg"
                    action={(
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => setNewProjectOpen(true)}><Plus />新建项目</Button>
                        <Button size="sm" variant="outline" onClick={() => { if (activeProject) { setRenameProjectName(activeProject.displayName); setRenameProjectOpen(true) } }} disabled={!activeProjectIsIsolated}><Pencil />重命名当前项目</Button>
                        <Button size="sm" variant="destructive" onClick={() => setDeleteProjectOpen(true)} disabled={!activeProjectIsIsolated || activeProjectHasRunningTask || activeAgentChat?.status === "running"}><Trash2 />删除当前项目</Button>
                      </div>
                    )}
                  />
                </CardHeader>
                <CardContent className="space-y-3 px-4">
                  <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_17rem]">
                    <div className="min-w-0">
                      <div className="flex gap-3 overflow-x-auto pb-1" role="listbox" aria-label="项目任务">
                        {projectsLoading && !projects.length && Array.from({ length: 3 }).map((_, index) => <div key={index} className="h-24 min-w-56 animate-pulse-soft rounded-xl bg-muted" />)}
                        {projects.map((project, index) => {
                          const selected = project.projectId === activeProjectId
                          const projectTask = tasks[project.projectId]
                          const state = ACTIVE_TASK_STATUSES.has(String(projectTask?.status))
                            ? "active"
                            : projectTask?.status === "paused" ? "warning" : project.statusSummary?.state
                          return (
                            <button key={project.projectId} ref={(node) => { if (node) projectButtonRefs.current.set(project.projectId, node); else projectButtonRefs.current.delete(project.projectId) }} type="button" role="option" aria-selected={selected} onClick={() => void selectProject(project.projectId)} onKeyDown={(event) => focusProjectFromKey(event, index)} className={cn("min-h-24 min-w-56 flex-1 rounded-xl border bg-muted/20 p-3 text-left transition-all hover:border-primary/35 hover:bg-primary/5", selected && "border-primary/45 bg-primary/8 shadow-sm")}>
                              <div className="flex items-center gap-2"><StatusDot state={state} /><span className="min-w-0 flex-1 truncate text-sm font-semibold">{project.displayName}</span>{selected && <Badge variant="info">当前</Badge>}</div>
                              <p className="mt-3 truncate text-xs text-muted-foreground">{PHASE_LABELS[project.statusSummary?.phase] ?? "等待剧本"}</p>
                              <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground"><span>{project.storageMode === "isolated-project" ? "独立项目" : "兼容项目"}</span><span>{formatCount(project.statusSummary?.assetTotal)} 项资产</span></div>
                            </button>
                          )
                        })}
                        {!projectsLoading && !projects.length && <div className="grid min-h-24 min-w-56 place-items-center rounded-xl border border-dashed px-4 text-center text-xs text-muted-foreground">拖入右侧剧本即可自动新建项目</div>}
                      </div>
                    </div>
                    <div>
                      <input ref={fileInputRef} className="sr-only" type="file" accept=".txt,.docx" aria-label="导入剧本文件" onChange={(event) => event.target.files?.[0] && void createProjectFromScreenplay(event.target.files[0])} />
                      <button type="button" disabled={busyAction === "screenplay-project"} onClick={() => fileInputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files?.[0]; if (file) void createProjectFromScreenplay(file) }} className="flex min-h-24 w-full items-center gap-3 rounded-xl border border-dashed bg-muted/15 px-4 text-left transition-colors hover:border-primary/45 hover:bg-primary/5 disabled:opacity-50">
                        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-background shadow-sm ring-1 ring-border">{busyAction === "screenplay-project" ? <LoaderCircle className="size-4 animate-spin text-primary" /> : <Upload className="size-4 text-primary" />}</span>
                        <span className="min-w-0"><span className="block text-sm font-medium">拖入 TXT / DOCX 剧本</span><span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">自动以剧本名新建独立项目</span></span>
                      </button>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <div className="flex flex-wrap justify-end gap-2 px-1" aria-label="流水线任务操作">
                <Button onClick={() => void runTask("run-full-pipeline")} disabled={!activeProject || activeProjectHasRunningTask || pendingAssetsReady || busyAction === "run-full-pipeline"}>
                  {busyAction === "run-full-pipeline" ? <LoaderCircle className="animate-spin" /> : <Play />}开始任务
                </Button>
                <Button variant="destructive" onClick={() => void pauseCurrentTask()} disabled={!activeProjectHasRunningTask || busyAction === "pause-task"}>
                  {busyAction === "pause-task" ? <LoaderCircle className="animate-spin" /> : <Pause />}暂停任务
                </Button>
              </div>

              <Card className="gap-2.5 overflow-hidden border-border/80 py-4 shadow-panel">
                <CardHeader className="px-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <CardTitle className="truncate text-xl" aria-live="polite">当前阶段：{currentStageLabel}</CardTitle>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">当前剧本来源：“{screenplaySource}”</p>
                    </div>
                    <Badge variant="muted" className="shrink-0">项目用时 {formatDuration(projectElapsedSeconds)}</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 px-4">
                  <div className="flex items-center gap-3">
                    <Progress
                      value={summaryProgress}
                      aria-label="当前流水线真实总进度"
                      aria-valuetext={showSummaryProgressPercent ? `${Math.round(summaryProgress)}%` : "当前阶段正在运行，总进度暂不可精确计算"}
                      className="h-2.5 flex-1"
                    />
                    {showSummaryProgressPercent && (
                      <span className="w-10 shrink-0 text-right text-[11px] font-medium tabular-nums text-muted-foreground">{Math.round(summaryProgress)}%</span>
                    )}
                  </div>
                  {showVisualSpecsCard && (
                    <div className="rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-xs" aria-live="polite">
                      <p className="font-semibold text-foreground">当前阶段：资产设定生成中</p>
                      <p className="mt-1 text-muted-foreground">
                        正在处理：{visualSpecsTask?.assetId
                          ? `当前${visualSpecsTask.sheetName ?? "资产"} ${visualSpecsTask.assetId}`
                          : "正在准备下一项资产"}
                      </p>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
                    {displayPipelineStages.map((stage: JsonRecord) => (
                      <div
                        key={stage.id}
                        className={cn(
                          "relative min-h-16 rounded-lg border bg-muted/20 px-3 py-2.5 transition-[border-color,background-color,box-shadow] duration-300",
                          stage.state === "active" && "border-info/55 bg-info/8 shadow-sm",
                          stage.state === "complete" && "border-success/60 bg-success/8",
                        )}
                      >
                        <div className="flex items-center gap-2 text-[11px] font-medium">
                          {stage.state === "active" && activeTaskActuallyRunning
                            ? <LoaderCircle className="stage-running-spinner size-3.5 shrink-0 text-info" aria-label="运行中" />
                            : <StatusDot state={stage.state} />}
                          <span className="truncate">{stage.label}</span>
                        </div>
                        <div className="mt-1 flex items-center justify-between gap-2 pl-[18px] text-[10px] text-muted-foreground">
                          <span>{STATE_LABELS[stage.state] ?? "未开始"}</span>
                          {stage.id === activeTaskStageId && activeTaskActuallyRunning && activeStageElapsedSeconds !== null && (
                            <span className="flex shrink-0 items-center gap-1 font-medium tabular-nums text-info" aria-label={`${stage.label}已运行 ${formatDuration(activeStageElapsedSeconds)}`}>
                              <Timer className="size-3" aria-hidden="true" />{formatDuration(activeStageElapsedSeconds)}
                            </span>
                          )}
                        </div>
                        {stage.state === "complete" && (
                          <span className="absolute right-2 bottom-2 grid size-5 place-items-center rounded-full bg-success text-success-foreground" aria-label="此阶段已完成">
                            <Check className="size-3.5" aria-hidden="true" />
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>

              {pendingAssetCount > 0 && (
                <button type="button" onClick={() => setPendingAssetDialogOpen(true)} disabled={!activeProject} className="group flex w-full flex-col gap-4 rounded-xl border border-warning/55 bg-warning/8 p-4 text-left transition-[border-color,background-color,box-shadow] hover:border-warning hover:bg-warning/12 hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-50 sm:flex-row sm:items-center sm:justify-between" aria-label={`打开 ${pendingAssetCount} 项待确认资产`}>
                  <div className="flex min-w-0 gap-3">
                    <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">有 {pendingAssetCount} 项资产需要人工确认</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        其他集数和世界观总览可以继续完成；确认结束后才会统一整理资产 ID、生成资产设定和 Excel。
                      </p>
                    </div>
                  </div>
                  <ChevronRight className="size-5 shrink-0 text-warning transition-transform group-hover:translate-x-1" aria-hidden="true" />
                </button>
              )}

              <section>
                <SectionHeading title="资产拆分概览" description="当前项目 Cache 中的真实数量" />
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-5">
                  {ASSETS.map((asset) => <Card key={asset.id} className="min-h-20"><CardContent className="flex h-full items-center gap-3 p-3"><span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary"><Boxes className="size-4" /></span><div><p className="text-xl font-semibold tabular-nums">{formatCount(snapshot?.assetCounts?.byType?.[asset.countKey])}</p><p className="text-[11px] text-muted-foreground">{asset.label}</p></div></CardContent></Card>)}
                </div>
              </section>

              <button
                ref={batchStudioButtonRef}
                type="button"
                onClick={() => void setStudioOpen(!drawerOpen, "batch")}
                disabled={!activeProject || pendingAssetCount > 0}
                aria-expanded={drawerOpen}
                aria-controls="prompt-studio-drawer"
                aria-label={drawerOpen ? "关闭 Prompt Studio" : "打开 Prompt Studio"}
                className="group w-full overflow-hidden rounded-2xl border border-primary/35 bg-gradient-to-br from-primary/14 via-card to-card p-5 text-left shadow-panel transition-all hover:border-primary/60 hover:shadow-overlay disabled:opacity-50"
              >
                <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-4"><span className="grid size-12 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm"><WandSparkles className="size-6" /></span><div><p className="text-[10px] font-semibold tracking-[0.18em] text-primary">BATCH GENERATION</p><h2 className="mt-1 text-xl font-semibold">{drawerOpen ? "批量出图 · 关闭 Prompt Studio" : "批量出图 · 打开 Prompt Studio"}</h2><p className="mt-1 text-xs text-muted-foreground">配置风格、类别、参考图、提示词路由与出图后端</p></div></div>
                  {drawerOpen ? <X className="size-6 text-primary transition-transform group-hover:rotate-90" /> : <PanelRightOpen className="size-6 text-primary transition-transform group-hover:translate-x-1" />}
                </div>
                <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-5">
                  {[["当前批次", snapshot?.batch?.scope === "none" ? "等待配置" : "资产出图"], ["后端", snapshot?.batch?.backend || "尚未运行"], ["成功", formatCount(batchCounts.completed)], ["失败", formatCount(batchCounts.failed)], ["当前项", snapshot?.batch?.activeTask?.label || `${formatCount(batchCounts.pending)} 项待处理`]].map(([label, value]) => <div key={String(label)} className="rounded-lg border border-border/70 bg-background/55 px-3 py-2"><p className="text-[10px] text-muted-foreground">{label}</p><p className="mt-1 truncate text-xs font-medium">{value}</p></div>)}
                </div>
              </button>

              <Card className="gap-0 py-0 shadow-panel">
                <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start px-1" onClick={() => setTaskLogOpen((open) => !open)} aria-expanded={taskLogOpen} aria-controls="active-task-log">
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
                    <ChevronDown className={cn("ml-auto size-4 transition-transform", taskLogOpen && "rotate-180")} />
                  </Button>
                  <Badge variant={activeTask?.status === "succeeded" ? "success" : activeTask?.status === "failed" ? "destructive" : ["paused", "pausing"].includes(String(activeTask?.status)) ? "warning" : activeTask ? "info" : "muted"}>
                    {activeTask ? TASK_STATUS_LABELS[activeTask.status] ?? activeTask.status : "暂无任务"}
                  </Badge>
                  {taskLogOpen && <Button variant="outline" size="sm" onClick={() => void copyTaskLog()} disabled={!activeTask?.log?.text}><ClipboardCopy />复制日志</Button>}
                </div>
                {taskLogOpen && (
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

              {activeTask?.status === "failed" && !dismissedFailureTaskIds.includes(String(activeTask.taskId)) && (
                <div role="alert" className="flex flex-col gap-3 rounded-xl border border-destructive/55 bg-destructive/8 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 gap-3">
                    <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-destructive">流水线执行失败</p>
                      <p className="mt-1 break-words text-xs text-foreground">{taskFailureSummary(activeTask)}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button variant="outline" size="sm" className="border-destructive/35" onClick={() => setTaskLogOpen(true)}>展开任务日志</Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => setDismissedFailureTaskIds((ids) => [...new Set([...ids, String(activeTask.taskId)])])} aria-label="关闭错误提示"><X /></Button>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2 rounded-lg border border-info/25 bg-info/8 px-3 py-2 text-[11px] text-muted-foreground"><Database className="size-3.5 text-info" /><span>项目隔离已启用；切换项目不会混用 Cache、输出、队列或锁。</span></div>
            </div>
          </main>
        </div>
      </section>

      {drawerMounted && (
        <button
          type="button"
          className={cn(
            "group fixed inset-0 z-30 bg-black/10 text-foreground transition-opacity duration-150 ease-standard motion-reduce:transition-none focus-visible:outline-none",
            drawerOpen ? "opacity-100" : "pointer-events-none opacity-0",
          )}
          aria-label="返回主监听窗口"
          aria-hidden={!drawerOpen}
          tabIndex={-1}
          onClick={closeStudio}
        >
          <span className="absolute left-2 top-1/2 flex w-12 -translate-y-1/2 flex-col items-center gap-0.5 rounded-xl border bg-card/95 px-1 py-2 shadow-panel transition-transform group-hover:-translate-x-0.5 group-focus-visible:ring-2 group-focus-visible:ring-ring sm:left-3">
            <ChevronLeft className="size-4" />
            <span className="text-[9px] font-medium leading-tight">返回<br />监听</span>
          </span>
        </button>
      )}
      {drawerMounted && (
        <MemoPromptStudioDrawer
          className={cn(
            "prompt-studio-stage fixed right-3 bottom-3 z-40 rounded-2xl border shadow-overlay",
            "top-10 left-12 sm:top-14 sm:left-56 lg:left-60",
            !drawerOpen && "pointer-events-none",
          )}
          open={drawerOpen}
          projectId={activeProject?.projectId ?? null}
          projectName={activeProject?.displayName ?? null}
          tab={drawerTab}
          setTab={setDrawerTab}
          runTask={runTask}
          notify={notify}
          onClose={closeStudio}
        />
      )}

      <PendingAssetDialog
        open={pendingAssetDialogOpen}
        onOpenChange={setPendingAssetDialogOpen}
        projectId={activeProjectId}
        projectBusy={activeProjectHasRunningTask}
        onCommitted={refreshActiveProjectState}
        onFinalized={async () => { await runTask("finalize-after-confirmation") }}
        notify={notify}
      />

      <Dialog open={newProjectOpen} onOpenChange={setNewProjectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建独立项目</DialogTitle>
            <DialogDescription>软件会创建独立目录、Cache、输出、队列和锁。</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="new-project-name">项目名称</Label>
            <Input id="new-project-name" value={newProjectName} onChange={(event) => setNewProjectName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void createProject()} autoFocus />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewProjectOpen(false)}>取消</Button>
            <Button onClick={() => void createProject()} disabled={!newProjectName.trim() || busyAction === "create-project"}>{busyAction === "create-project" && <LoaderCircle className="animate-spin" />}创建项目</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renameProjectOpen} onOpenChange={setRenameProjectOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名当前项目</DialogTitle>
            <DialogDescription>只修改项目显示名称，不改变项目唯一编号、目录、Cache、输出或队列位置。</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="rename-project-name">新的项目名称</Label>
            <Input
              id="rename-project-name"
              value={renameProjectName}
              onChange={(event) => setRenameProjectName(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void renameCurrentProject()}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameProjectOpen(false)}>取消</Button>
            <Button onClick={() => void renameCurrentProject()} disabled={!renameProjectName.trim() || busyAction === "rename-project"}>
              {busyAction === "rename-project" && <LoaderCircle className="animate-spin" />}
              确认重命名
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteProjectOpen} onOpenChange={setDeleteProjectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除项目“{activeProject?.displayName ?? ""}”？</AlertDialogTitle>
            <AlertDialogDescription>
              这会永久删除该项目的独立目录，以及其中的剧本、Cache、输出和队列。此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyAction === "delete-project"}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => { event.preventDefault(); void deleteCurrentProject() }}
              disabled={!activeProjectIsIsolated || activeProjectHasRunningTask || busyAction === "delete-project"}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busyAction === "delete-project" && <LoaderCircle className="animate-spin" />}
              永久删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {toast && (
        <div role={toast.tone === "error" ? "alert" : "status"} aria-live={toast.tone === "error" ? "assertive" : "polite"} className={cn(
          "fixed top-14 right-4 z-[80] flex w-[min(calc(100vw-2rem),520px)] items-start gap-3 rounded-xl border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-overlay animate-popover-in",
          toast.tone === "error" && "border-destructive/45",
          toast.tone === "warning" && "border-warning/45",
          toast.tone === "good" && "border-success/35",
        )}>
          {toast.tone === "good" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : <AlertTriangle className={cn("mt-0.5 size-4 shrink-0", toast.tone === "error" ? "text-destructive" : "text-warning")} />}
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{toast.tone === "error" ? "操作失败" : toast.tone === "warning" ? "请注意" : "操作完成"}</p>
            <p className="mt-0.5 break-words text-xs leading-relaxed text-muted-foreground">{toast.message}</p>
          </div>
          <Button variant="ghost" size="icon-sm" className="-mr-2 -mt-1" onClick={() => setToast(null)} aria-label="关闭提示"><X /></Button>
        </div>
      )}
    </div>
  )
}

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

const MemoPromptStudioDrawer = React.memo(PromptStudioDrawer)
const MemoBatchStudio = React.memo(BatchStudio)
const MemoRouteStudio = React.memo(RouteStudio)
const MemoTemplateStudio = React.memo(TemplateStudio)
const MemoValidationStudio = React.memo(ValidationStudio)

function PromptStudioDrawer({ className, open, projectId, projectName, tab, setTab, runTask, notify, onClose }: DrawerProps) {
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
        const draftValues = new Map((draft?.promptFields ?? []).map((field: JsonRecord) => [field.label, field.value]))
        const custom = customFieldsBySheet[sheet]
        const promptFields = resolved.promptFields.map((field: JsonRecord) => ({
          ...field,
          value: hasCustomFields && field.label === "Input images"
            ? custom.inputImages
            : hasCustomFields && field.label === "Primary request"
              ? custom.primaryRequest
              : draftValues.has(field.label)
                ? draftValues.get(field.label)
                : field.value,
        }))
        return [sheet, {
          routeMode: count ? "reference" : "default",
          promptText: promptFields.map((field: JsonRecord) => `${field.label}: ${field.value}`).join("\n"),
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

function RouteFieldPreview({ module, preview }: { module: RouteModule; preview: JsonRecord | null }) {
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

function TemplateStudio({ notify }: { notify: DrawerProps["notify"] }) {
  const { activePreset, setPresets } = usePromptPresets()
  const [style, setStyle] = React.useState("anime")
  const [asset, setAsset] = React.useState("prop")
  const [referenceMode, setReferenceMode] = React.useState("none")
  const [result, setResult] = React.useState<JsonRecord | null>(null)
  const [draftFields, setDraftFields] = React.useState<JsonRecord[]>([])
  const [hasSavedDraft, setHasSavedDraft] = React.useState(false)
  const [loading, setLoading] = React.useState(false)

  const resolve = React.useCallback(async () => {
    setLoading(true)
    try {
      const resolved = await catalogAdapter.resolve({ style, asset, referenceMode, referenceCount: referenceMode === "visual-consistency" ? 2 : referenceMode === "none" ? 0 : 1 })
      const saved = readTemplateDraft(activePreset?.templates, style, asset, referenceMode)
      setResult(resolved)
      setDraftFields(clone(saved?.promptFields ?? resolved.promptFields))
      setHasSavedDraft(Boolean(saved))
    } catch (error) { notify(safeMessage(error, "基础模板读取失败"), "error") }
    finally { setLoading(false) }
  }, [activePreset?.id, asset, notify, referenceMode, style])

  React.useEffect(() => { const timer = window.setTimeout(() => void resolve(), 180); return () => window.clearTimeout(timer) }, [resolve])

  const saveDraft = () => {
    if (!activePreset || !result || !draftFields.length) return
    const templates = withTemplateDraft(activePreset.templates, style, asset, referenceMode, draftFields)
    setPresets((items) => items.map((preset) => preset.id === activePreset.id ? {
      ...preset,
      revision: preset.revision + 1,
      updatedAt: nowIso(),
      templates,
    } : preset))
    setHasSavedDraft(true)
    notify(`基础提示词草稿已保存到预设“${activePreset.name}”；保存批次时会写入对应资产类别`)
  }

  const restoreFormal = () => {
    if (!result) return
    setDraftFields(clone(result.promptFields))
    notify("已恢复为正式注册表解析值；点击“保留当前草稿”后才会覆盖已保存草稿")
  }

  return (
    <ScrollArea className="h-full"><div className="space-y-4 p-5">
      <Card><CardContent className="flex flex-wrap items-center gap-x-5 gap-y-2 p-3">
        <div className="flex items-center gap-2"><Label className="whitespace-nowrap">制作风格</Label><Select value={style} onValueChange={setStyle}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent>{STYLES.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></div>
        <div className="flex items-center gap-2"><Label className="whitespace-nowrap">资产类型</Label><Select value={asset} onValueChange={setAsset}><SelectTrigger className="w-28"><SelectValue /></SelectTrigger><SelectContent>{ASSETS.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></div>
        <div className="flex items-center gap-2"><Label className="whitespace-nowrap">参考图方式</Label><Select value={referenceMode} onValueChange={setReferenceMode}><SelectTrigger className="w-40"><SelectValue /></SelectTrigger><SelectContent>{REFERENCE_MODES.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></div>
        <Badge variant={referenceMode === "none" ? "muted" : "info"} className="ml-auto">{referenceMode === "none" ? "无参考图基础模板" : "有参考图基础模板"} · {draftFields.length || (referenceMode === "none" ? 11 : 12)} 字段</Badge>
      </CardContent></Card>
      <Card>
        <CardHeader className="pb-3"><SectionHeading title="基础字段编辑" description="当前组合的全部固定字段集中显示在一个栏目中。" action={loading ? <LoaderCircle className="size-4 animate-spin text-primary" /> : <Badge variant={hasSavedDraft ? "warning" : "success"}>{hasSavedDraft ? "已保留草稿" : "正式注册表"}</Badge>} /></CardHeader>
        <CardContent className="space-y-3">
          <details className="group overflow-hidden rounded-lg border bg-muted/10">
            <summary className="flex h-9 cursor-pointer list-none items-center gap-2 px-3 text-xs font-medium outline-none hover:bg-accent/45 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden"><ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />路由轨迹<span className="ml-auto text-[10px] text-muted-foreground">{result ? makeRouteTrace(result).length : 0} 项</span></summary>
            <div className="flex flex-wrap gap-2 border-t px-3 py-2.5">{result ? makeRouteTrace(result).map((item: string) => <Badge key={item} variant="outline" className="font-mono text-[10px]">{item}</Badge>) : <span className="text-xs text-muted-foreground">读取中…</span>}</div>
          </details>
          <PromptFieldList idPrefix="template-field" fields={draftFields as { label: string; value: string }[]} editable onChange={(index, value) => setDraftFields((items) => items.map((entry, itemIndex) => itemIndex === index ? { ...entry, value } : entry))} />
        </CardContent>
      </Card>
      <div className="sticky bottom-0 -mx-5 flex flex-wrap justify-end gap-2 border-t bg-background px-5 py-4"><Button variant="outline" onClick={restoreFormal} disabled={!result}><RefreshCw />恢复正式解析值</Button><Button variant="outline" onClick={() => navigator.clipboard.writeText(draftFields.map(({ label, value }) => `${label}: ${value}`).join("\n")).then(() => notify("当前字段已复制")).catch(() => notify("复制失败", "error"))} disabled={!draftFields.length}><ClipboardCopy />复制当前字段</Button><Button onClick={saveDraft} disabled={!result || loading}><Save />保留当前草稿</Button></div>
    </div></ScrollArea>
  )
}

function ValidationStudio({ projectName, notify }: { projectName: string | null; notify: DrawerProps["notify"] }) {
  const [style, setStyle] = React.useState("cg")
  const [asset, setAsset] = React.useState("scene")
  const [referenceMode, setReferenceMode] = React.useState("none")
  const [assetId, setAssetId] = React.useState("")
  const [productionNotes, setProductionNotes] = React.useState("")
  const [result, setResult] = React.useState<JsonRecord | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [testImage, setTestImage] = React.useState<{ url: string; name: string } | null>(null)
  const [testStatus, setTestStatus] = React.useState("先完成解析，再点击出图测试")
  const testImageInputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => () => {
    if (testImage?.url) URL.revokeObjectURL(testImage.url)
  }, [testImage?.url])

  const validateOne = async () => {
    if (!productionNotes.trim()) {
      notify("请先填写这个资产的完整制作说明", "warning")
      return
    }
    setLoading(true)
    setTestImage(null)
    setTestStatus("正在解析最终 Prompt…")
    try {
      const resolved = await catalogAdapter.resolve({
        style,
        asset,
        referenceMode,
        referenceCount: referenceMode === "visual-consistency" ? 2 : referenceMode === "none" ? 0 : 1,
        productionNotes,
      })
      setResult(resolved)
      setTestStatus("解析完成，可以点击出图测试")
      notify("单项解析校验完成")
    } catch (error) {
      setResult(null)
      setTestStatus("解析失败，修正条件后重新校验")
      notify(safeMessage(error, "单项解析失败"), "error")
    } finally {
      setLoading(false)
    }
  }

  const prepareImageTest = async () => {
    if (!result) return
    try {
      const handoff = [
        "请使用 Codex 内置 image_gen 生成 1 张单项测试图；这是 Prompt Studio 的只读测试，不要改动批量队列。",
        `制作风格：${styleLabel(style)}`,
        `资产类型：${assetLabel(asset)}`,
        `资产：${assetId || "未命名测试项"}`,
        "最终 Prompt：",
        formatPromptText(result),
      ].join("\n")
      await navigator.clipboard.writeText(handoff)
      setTestStatus("最终 Prompt 已复制；交给 Codex 内置 ImageGen 后，将生成图片拖回右侧窗口")
      notify("单项出图测试 Prompt 已复制")
    } catch {
      setTestStatus("无法访问剪贴板，请先复制最终 Prompt 再交给 Codex 内置 ImageGen")
      notify("出图测试 Prompt 复制失败", "error")
    }
  }

  const receiveTestImage = (file: File) => {
    if (!file.type.startsWith("image/")) {
      notify("图片返回窗口只接受图片文件", "warning")
      return
    }
    const url = URL.createObjectURL(file)
    setTestImage((current) => {
      if (current?.url) URL.revokeObjectURL(current.url)
      return { url, name: file.name }
    })
    setTestStatus(`已收到测试图：${file.name}`)
  }

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-4xl space-y-5 p-5">
        <div>
          <h3 className="text-base font-semibold">单项检查</h3>
          <p className="mt-1 text-xs text-muted-foreground">不修改项目、不建立队列；只把一条真实制作说明交给正式提示词解析器，检查最终 Prompt。</p>
        </div>
        <Card>
          <CardHeader className="pb-3"><SectionHeading title="解析条件" description={projectName ? `当前项目：${projectName}` : "请先在主窗口选择项目"} /></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-2"><Label>制作风格</Label><Select value={style} onValueChange={setStyle}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{STYLES.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-2"><Label>资产类型</Label><Select value={asset} onValueChange={setAsset}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{ASSETS.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></div>
              <div className="space-y-2"><Label>参考图方式</Label><Select value={referenceMode} onValueChange={setReferenceMode}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{REFERENCE_MODES.map((item) => <SelectItem key={item.id} value={item.id}>{item.label}</SelectItem>)}</SelectContent></Select></div>
            </div>
            <div className="space-y-2"><Label htmlFor="validation-asset-id">资产 ID / 名称</Label><Input id="validation-asset-id" value={assetId} onChange={(event) => setAssetId(event.target.value)} placeholder="例如：SCENE-014 · 雨林遗迹" /></div>
            <div className="space-y-2"><Label htmlFor="validation-production-notes">完整制作说明</Label><Textarea id="validation-production-notes" rows={6} value={productionNotes} onChange={(event) => setProductionNotes(event.target.value)} placeholder="粘贴 Excel 中这一项的完整制作说明；系统会据此解析基础路由和正式提示词。" /></div>
            <div className="flex justify-end"><Button onClick={() => void validateOne()} disabled={loading || !productionNotes.trim()}>{loading ? <LoaderCircle className="animate-spin" /> : <TestTube2 />}校验解析</Button></div>
          </CardContent>
        </Card>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(18rem,.65fr)] xl:items-start">
          <Card>
            <CardHeader className="pb-3"><SectionHeading title="最终 Prompt" description={result ? `${assetId || "未填写资产名"} · ${result.promptFields.length} 个固定字段` : "完成解析后集中显示全部字段"} action={<div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => result && navigator.clipboard.writeText(formatPromptText(result)).then(() => notify("最终 Prompt 已复制")).catch(() => notify("复制失败", "error"))} disabled={!result}><ClipboardCopy />复制</Button><Button size="sm" onClick={() => void prepareImageTest()} disabled={!result}><Sparkles />出图测试</Button></div>} /></CardHeader>
            <CardContent className="space-y-3">
              {result && <details className="group overflow-hidden rounded-lg border bg-muted/10"><summary className="flex h-9 cursor-pointer list-none items-center gap-2 px-3 text-xs font-medium outline-none hover:bg-accent/45 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden"><ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />本次解析轨迹<Badge variant="success" className="ml-auto">正式注册表</Badge></summary><div className="flex flex-wrap gap-2 border-t px-3 py-2.5">{makeRouteTrace(result).map((item: string) => <Badge key={item} variant="outline" className="font-mono text-[10px]">{item}</Badge>)}</div></details>}
              <PromptFieldList idPrefix="validation-field" fields={(result?.promptFields ?? []) as { label: string; value: string }[]} emptyMessage="填写制作说明并点击“校验解析”，这里会显示真实最终 Prompt" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3"><SectionHeading title="图片返回窗口" description={testStatus} /></CardHeader>
            <CardContent>
              <input ref={testImageInputRef} type="file" accept="image/*" className="sr-only" aria-label="上传单项测试参考图" onChange={(event) => event.target.files?.[0] && receiveTestImage(event.target.files[0])} />
              <button type="button" onClick={() => testImageInputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files?.[0]; if (file) receiveTestImage(file) }} className="grid aspect-square min-h-64 w-full place-items-center overflow-hidden rounded-xl border border-dashed bg-muted/15 text-muted-foreground transition-colors hover:border-primary/45 hover:bg-primary/5">
                {testImage ? <img src={testImage.url} alt={testImage.name} className="size-full object-contain" /> : <span className="px-5 text-center text-xs"><ImagePlus className="mx-auto mb-2 size-6" />生成后将图片拖到这里，或点击选择返回图片</span>}
              </button>
            </CardContent>
          </Card>
        </div>
      </div>
    </ScrollArea>
  )
}
