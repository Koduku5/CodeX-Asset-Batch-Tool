const TEMPLATE_DRAFT_STORAGE_KEY = "ka-prompt-studio.template-drafts.v1"

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value)
const templateDraftKey = (style, asset, referenceMode) => `${style}|${asset}|${referenceMode}`

export function readLegacyTemplateDrafts(storage) {
  try {
    const records = JSON.parse((storage ?? globalThis.localStorage).getItem(TEMPLATE_DRAFT_STORAGE_KEY) || "{}")
    return isRecord(records) ? records : {}
  } catch {
    return {}
  }
}

export function templateDraftRecords(templates) {
  return isRecord(templates) ? templates : {}
}

export function readTemplateDraft(templates, style, asset, referenceMode) {
  const draft = templateDraftRecords(templates)[templateDraftKey(style, asset, referenceMode)]
  return draft && Array.isArray(draft.promptFields) ? draft : null
}

export function withTemplateDraft(templates, style, asset, referenceMode, promptFields, updatedAt = new Date().toISOString()) {
  const records = JSON.parse(JSON.stringify(templateDraftRecords(templates)))
  records[templateDraftKey(style, asset, referenceMode)] = { promptFields, updatedAt }
  return records
}
