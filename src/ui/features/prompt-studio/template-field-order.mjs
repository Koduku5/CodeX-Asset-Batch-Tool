const TEMPLATE_FIELD_REORDER_LOCKED_LABELS = new Set(["use case", "asset type"])
const TEMPLATE_FIELD_REORDER_LOCKED_ORDER = ["use case", "asset type"]
export const MAX_CUSTOM_TEMPLATE_FIELDS = 24

export function templateFieldReorderIsLocked(field) {
  return TEMPLATE_FIELD_REORDER_LOCKED_LABELS.has(String(field?.label || "").trim().toLocaleLowerCase("en-US"))
}

export function customTemplateFieldLabelError(label, fields, customFieldCount) {
  const normalizedLabel = String(label || "").trim()
  if (!normalizedLabel) return "请输入字段名称"
  if (normalizedLabel.length > 80) return "字段名称不能超过 80 个字符"
  if (/[:\r\n]/u.test(normalizedLabel)) return "字段名称不能包含冒号或换行"
  if (fields.some((field) => String(field?.label || "").trim().toLocaleLowerCase("zh-CN") === normalizedLabel.toLocaleLowerCase("zh-CN"))) {
    return "字段名称不能与现有字段重复"
  }
  return customFieldCount >= MAX_CUSTOM_TEMPLATE_FIELDS ? "每套基础提示词最多添加 24 个自定义字段" : ""
}

export function normalizeTemplateFieldOrder(formalFields, draftFields) {
  const formalByLabel = new Map(formalFields.map((field) => [String(field.label), field]))
  const normalizedFormalLabels = new Set([...formalByLabel.keys()].map((label) => label.toLocaleLowerCase("zh-CN")))
  const seenLabels = new Set()
  const orderedFields = []
  let customCount = 0

  for (const draftField of Array.isArray(draftFields) ? draftFields : []) {
    const label = String(draftField?.label || "").trim()
    const normalized = label.toLocaleLowerCase("zh-CN")
    if (!label || label.length > 80 || /[:\r\n]/u.test(label) || seenLabels.has(normalized)) continue
    const formalField = formalByLabel.get(label)
    if (formalField) {
      orderedFields.push({ ...formalField, value: String(draftField.value ?? "") })
      seenLabels.add(normalized)
      continue
    }
    if (normalizedFormalLabels.has(normalized) || customCount >= MAX_CUSTOM_TEMPLATE_FIELDS) continue
    orderedFields.push({ label, value: String(draftField.value ?? "") })
    seenLabels.add(normalized)
    customCount += 1
  }

  for (const formalField of formalFields) {
    const normalized = String(formalField.label).toLocaleLowerCase("zh-CN")
    if (!seenLabels.has(normalized)) orderedFields.push({ ...formalField })
  }

  const movableFields = orderedFields.filter((field) => !templateFieldReorderIsLocked(field))
  const lockedFields = TEMPLATE_FIELD_REORDER_LOCKED_ORDER
    .map((lockedLabel) => orderedFields.find((field) => (
      String(field.label || "").trim().toLocaleLowerCase("en-US") === lockedLabel
    )))
    .filter(Boolean)
  return [...lockedFields, ...movableFields]
}

export function reorderTemplateFields(fields, fromIndex, toIndex) {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= fields.length || toIndex >= fields.length) return fields
  const lowerIndex = Math.min(fromIndex, toIndex)
  const upperIndex = Math.max(fromIndex, toIndex)
  const crossesLockedField = fields.some((field, index) => (
    index >= lowerIndex
    && index <= upperIndex
    && index !== fromIndex
    && templateFieldReorderIsLocked(field)
  ))
  if (templateFieldReorderIsLocked(fields[fromIndex]) || crossesLockedField) return fields
  const reordered = [...fields]
  const [moved] = reordered.splice(fromIndex, 1)
  reordered.splice(toIndex, 0, moved)
  return reordered
}
