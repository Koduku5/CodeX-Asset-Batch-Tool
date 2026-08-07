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

import { BatchControlAdapter } from "@/services/batch-control-adapter.mjs"
import {
  CatalogResolverAdapter,
  formatPromptText,
  makeRouteTrace,
} from "@/services/catalog-adapter.mjs"
import { ImagegenHandoffAdapter } from "@/services/imagegen-handoff-adapter.mjs"
import { paginateAssets } from "@/services/list-model.mjs"
import { ProjectControlAdapter } from "@/services/project-control-adapter.mjs"
import { ProjectWorkspaceAdapter } from "@/services/project-workspace.mjs"
import { CodexStatusAdapter } from "@/services/codex-status-adapter.mjs"
import { CodexAgentChatAdapter } from "@/services/codex-agent-chat-adapter.mjs"
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
} from "@/services/route-module-workbench.mjs"

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
export type JsonRecord = Record<string, any>
export type ProjectCard = {
  projectId: string
  displayName: string
  availability: string
  storageMode: string
  statusSummary: JsonRecord
}
export type RouteModule = JsonRecord
export type RoutePreset = {
  id: string
  name: string
  revision: number
  source: string
  updatedAt: string
  templates: unknown
  modules: RouteModule[]
}
export type PendingRouteImport = {
  mode: "preset" | "branch"
  presets: RoutePreset[]
  modules: RouteModule[]
  conflictNames: string[]
  newNames: string[]
  sameNames: string[]
  targetPresetId: string | null
}
export type ToastState = { id: number; tone: "good" | "warning" | "error"; message: string }
export const workspaceAdapter = new ProjectWorkspaceAdapter()
export const controlAdapter = new ProjectControlAdapter()
export const codexStatusAdapter = new CodexStatusAdapter()
export const codexAgentChatAdapter = new CodexAgentChatAdapter()
export const batchAdapter = new BatchControlAdapter()
export const catalogAdapter = new CatalogResolverAdapter()
export const imagegenAdapter = new ImagegenHandoffAdapter()
export const routeAdminAdapter = new RouteModuleAdminAdapter()
export const routeClassifierAdapter = new RouteClassifierAdapter()

export const STYLES = [
  { id: "anime", label: "二次元" },
  { id: "cg", label: "CG" },
  { id: "live-action", label: "真人" },
] as const
export const ASSETS = [
  { id: "character", label: "角色", countKey: "characters" },
  { id: "creature", label: "生物", countKey: "creatures" },
  { id: "crowd", label: "群演", countKey: "crowds" },
  { id: "scene", label: "场景", countKey: "scenes" },
  { id: "prop", label: "道具", countKey: "props" },
] as const
export const SHEETS = ["角色", "生物", "群演", "场景", "道具"] as const
export const REFERENCE_MODES = [
  { id: "none", label: "不使用参考图" },
  { id: "style", label: "风格参考" },
  { id: "visual-consistency", label: "视觉一致" },
  { id: "custom", label: "自定义" },
] as const
export const OPERATION_LABELS: Record<string, string> = {
  append: "追加到字段末尾",
  prepend: "添加到字段开头",
  set: "替换字段内容",
  replaceWith: "切换基础路由",
}
export const PHASE_LABELS: Record<string, string> = {
  split: "剧本切分",
  analysis: "资产分析",
  "world-overview": "世界观总览",
  "asset-visual-specs": "资产设定",
  excel: "Excel 制表",
  generation: "批量出图",
  "waiting-generation": "等待出图配置",
  complete: "全部完成",
}
export const CURRENT_STAGE_LABELS: Record<string, string> = {
  split: "剧本切分中",
  analysis: "剧本分析与累计",
  "world-overview": "世界观总览生成中",
  "asset-visual-specs": "资产设定生成中",
  excel: "Excel 制表中",
  generation: "资产生成中",
  "waiting-generation": "等待资产生成",
  complete: "流水线已完成",
}
export const TASK_STAGE_BY_ACTION: Record<string, string> = {
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
export const STATE_LABELS: Record<string, string> = {
  active: "运行中",
  complete: "已完成",
  waiting: "等待",
  warning: "需处理",
  idle: "未开始",
  stale: "待刷新",
  error: "不可用",
}
export const TASK_STATUS_LABELS: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  pausing: "正在暂停",
  succeeded: "已完成",
  failed: "执行失败",
  paused: "已暂停",
}
export const ACTIVE_TASK_STATUSES = new Set(["queued", "running", "pausing"])
export const CODEX_MODEL_OPTIONS = [
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
] as const
export const CODEX_REASONING_OPTIONS = [
  { value: "minimal", label: "最低 · minimal" },
  { value: "low", label: "低 · low" },
  { value: "medium", label: "中 · medium" },
  { value: "high", label: "高 · high" },
  { value: "xhigh", label: "极高 · xhigh" },
] as const
export const PRESET_STORAGE_KEY = "ka-prompt-studio.route-presets.v3"
export const LEGACY_PRESET_STORAGE_KEY = "ka-prompt-studio.route-presets.v2"
export const ACTIVE_PRESET_STORAGE_KEY = "ka-prompt-studio.active-route-preset.v1"
export const BATCH_CUSTOM_FIELDS_STORAGE_KEY = "ka-prompt-studio.batch-custom-fields.v1"
export const ROUTE_LIST_PAGE_SIZE = 100

export const nowIso = () => new Date().toISOString()
export const safeMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback
export const taskFailureSummary = (task: JsonRecord | null) => {
  const lines = String(task?.log?.text ?? "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
  const detail = lines.at(-1)
  if (detail) return detail.length > 220 ? `${detail.slice(0, 217)}…` : detail
  return Number.isInteger(task?.exitCode)
    ? `任务进程异常退出（退出码 ${task?.exitCode}）`
    : "任务未能正常完成，请展开开发者日志查看详情。"
}
export const styleLabel = (id: string) => STYLES.find((item) => item.id === id)?.label ?? id
export const assetLabel = (id: string) => ASSETS.find((item) => item.id === id)?.label ?? id
export const referenceLabel = (id: string) => REFERENCE_MODES.find((item) => item.id === id)?.label ?? id
export const percent = (done: unknown, total: unknown) =>
  Number.isFinite(done) && Number.isFinite(total) && Number(total) > 0
    ? Math.min(100, Math.max(0, (Number(done) / Number(total)) * 100))
    : null
export const formatCount = (value: unknown) => (Number.isInteger(value) ? Number(value).toLocaleString("zh-CN") : "—")
export const formatTime = (value: unknown) => {
  const parsed = Date.parse(String(value ?? ""))
  return Number.isFinite(parsed)
    ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(parsed)
    : "—"
}
export const formatDuration = (value: unknown) => {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds < 0) return "—"
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = Math.floor(seconds % 60)
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
}
export const uniqueId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
export const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
export const projectNameFromScreenplay = (filename: string) => {
  const withoutExtension = filename.replace(/\.(?:txt|docx)$/iu, "")
  const safe = withoutExtension
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/gu, "-")
    .replace(/[. ]+$/gu, "")
    .trim()
    .slice(0, 80)
  return safe || `剧本项目 ${new Date().toLocaleDateString("zh-CN")}`
}

export function makeInitialPresets(registered: RouteModule[]): RoutePreset[] {
  const legacyTemplates = readLegacyTemplateDrafts()
  return [
    { id: "workspace", name: "本机工作设置", revision: 1, source: "本机", updatedAt: nowIso(), templates: legacyTemplates, modules: clone(registered) },
  ]
}

export function routeModulesFromCatalogSummary(summary: JsonRecord | null | undefined): RouteModule[] {
  if (!summary) return []
  return (summary.conditionModules ?? []).map(normalizeRouteModule)
}

export function withoutRetiredCatalogEnhancers(modules: RouteModule[]) {
  return modules.filter((entry) => entry.origin?.kind !== "catalog-enhancer")
}

export const RETIRED_STARTER_PRESET_IDS = new Set(["highway-a", "highway-b"])

export function withoutRetiredStarterPresets(presets: RoutePreset[]) {
  return presets.filter((preset) => !RETIRED_STARTER_PRESET_IDS.has(preset.id))
}

export function readStoredPresets(registered: RouteModule[]): RoutePreset[] {
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

export function savePresets(presets: RoutePreset[]) {
  try {
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify({ version: 3, presets }))
  } catch {
    // Presets remain usable for this session if storage is unavailable.
  }
}

export const blankReferenceSelections = () => Object.fromEntries(SHEETS.map((sheet) => [sheet, [] as string[]]))
export const blankReferenceModes = () => Object.fromEntries(SHEETS.map((sheet) => [sheet, "none"]))
export const blankCustomReferenceFields = () => Object.fromEntries(SHEETS.map((sheet) => [sheet, { inputImages: "", primaryRequest: "" }]))

export function readBatchCustomFields(projectId: string | null, style: string) {
  if (!projectId) return blankCustomReferenceFields()
  try {
    const records = JSON.parse(localStorage.getItem(BATCH_CUSTOM_FIELDS_STORAGE_KEY) || "{}")
    return { ...blankCustomReferenceFields(), ...(records[`${projectId}|${style}`] ?? {}) }
  } catch {
    return blankCustomReferenceFields()
  }
}

export function writeBatchCustomFields(projectId: string, style: string, fields: JsonRecord) {
  const records = (() => {
    try { return JSON.parse(localStorage.getItem(BATCH_CUSTOM_FIELDS_STORAGE_KEY) || "{}") }
    catch { return {} }
  })()
  records[`${projectId}|${style}`] = fields
  localStorage.setItem(BATCH_CUSTOM_FIELDS_STORAGE_KEY, JSON.stringify(records))
}

export function routePresetModulesEqual(left: RoutePreset, right: RoutePreset) {
  if (left.modules.length !== right.modules.length) return false
  const leftModules = [...left.modules].sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const rightModules = [...right.modules].sort((a, b) => String(a.id).localeCompare(String(b.id)))
  return leftModules.every((entry, index) => routeModulesEqual(entry, rightModules[index]))
    && JSON.stringify(canonicalJson(left.templates)) === JSON.stringify(canonicalJson(right.templates))
}

export function canonicalJson(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]))
}

export function routePresetNameKey(value: string) {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN")
}

export type PromptPresetContextValue = {
  presets: RoutePreset[]
  setPresets: React.Dispatch<React.SetStateAction<RoutePreset[]>>
  activePresetId: string
  setActivePresetId: React.Dispatch<React.SetStateAction<string>>
  activePreset: RoutePreset | null
}

export const PromptPresetContext = React.createContext<PromptPresetContextValue | null>(null)

export function usePromptPresets() {
  const context = React.useContext(PromptPresetContext)
  if (!context) throw new Error("Prompt preset context is unavailable")
  return context
}

export function readActivePresetId() {
  try {
    return localStorage.getItem(ACTIVE_PRESET_STORAGE_KEY) || "workspace"
  } catch {
    return "workspace"
  }
}

export async function downloadJson(filename: string, value: unknown) {
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

export function StatusDot({ state }: { state?: string | null }) {
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

export function SectionHeading({ title, description, action, titleClassName }: { title: string; description?: string; action?: React.ReactNode; titleClassName?: string }) {
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

export function EmptyState({ icon: Icon = PackageOpen, children }: { icon?: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="flex min-h-28 flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/25 px-5 py-6 text-center text-sm text-muted-foreground">
      <Icon className="size-5" aria-hidden="true" />
      <span>{children}</span>
    </div>
  )
}

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
