export type JsonRecord = Record<string, any>
export type Decision = "independent" | "merge" | "exclude" | ""

export const CATEGORY_LABELS: Record<string, string> = {
  characters: "角色",
  creatures: "生物",
  extras: "群演",
  scenes: "场景",
  props: "道具",
}

export const SUBJECT_CATEGORIES = new Set(["characters", "creatures", "extras"])

export const cloneRecord = (value: JsonRecord | null | undefined) => value
  ? JSON.parse(JSON.stringify(value)) as JsonRecord
  : null

export const editableRecord = (value: JsonRecord | null | undefined) => {
  const record = cloneRecord(value)
  if (!record) return null
  delete record.assetId
  record.productionNotes = null
  record.inferenceBasis = null
  return record
}

const normalizeIdentity = (value: unknown) => String(value ?? "")
  .replace(/\s+/gu, "")
  .toLocaleLowerCase()

export const independentRecord = (item: JsonRecord, targets: JsonRecord[]) => {
  const record = editableRecord(item.draftAsset)
  if (!record) return null
  const occupied = new Set(targets.flatMap((target) => {
    const targetRecord = target.record ?? {}
    return [targetRecord.assetName, ...(Array.isArray(targetRecord.aliases) ? targetRecord.aliases : [])]
      .map(normalizeIdentity)
      .filter(Boolean)
  }))
  record.aliases = (Array.isArray(record.aliases) ? record.aliases : [])
    .filter((alias: string) => !occupied.has(normalizeIdentity(alias)))
  return record
}

export const decisionResolution = (item: JsonRecord, decision: Decision, target?: JsonRecord | null) => {
  if (decision === "independent") return `人工选择独立建档：${item.candidate}`
  if (decision === "merge") return `人工选择合并：${item.candidate} -> ${target?.assetName ?? target?.assetId ?? "未知目标"}`
  return `人工选择排除：${item.candidate}`
}

export const safeMessage = (error: unknown, fallback: string) => {
  const message = String((error as JsonRecord)?.message ?? "").trim()
  return message || fallback
}

export const compatibleTargets = (item: JsonRecord | null, targets: JsonRecord[]) => {
  if (!item) return []
  const category = String(item.proposedCategory ?? "")
  return targets.filter((target) => SUBJECT_CATEGORIES.has(category)
    ? SUBJECT_CATEGORIES.has(String(target.category))
    : target.category === category)
}
