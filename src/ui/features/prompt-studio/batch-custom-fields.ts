import {
  BATCH_CUSTOM_FIELDS_STORAGE_KEY,
  SHEETS,
} from "@/features/workbench/workbench-constants"
import type { JsonRecord } from "@/features/workbench/workbench-types"

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
