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
