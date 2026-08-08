import { ASSETS, REFERENCE_MODES, STYLES } from "@/features/workbench/workbench-constants"
import type { JsonRecord } from "@/features/workbench/workbench-types"

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
