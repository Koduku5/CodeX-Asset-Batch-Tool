import { readTemplateDraft } from "./template-drafts.mjs"
import { normalizeTemplateFieldOrder } from "./template-field-order.mjs"

export async function buildBuiltinBatchConfiguration({
  assets,
  customFieldsBySheet,
  enabledSheets,
  generationLimit,
  promptTemplates,
  referenceModeBySheet,
  references,
  resolvePrompt,
  selectedReferenceIdsBySheet,
  sheets,
  style,
}) {
  const referenceIdsBySheet = Object.fromEntries(sheets.map((sheet) => [sheet, references
    .filter((entry) => referenceModeBySheet[sheet] !== "none" && entry.styleId === style && entry.sheetName === sheet && (selectedReferenceIdsBySheet[sheet] ?? []).includes(entry.referenceId))
    .map((entry) => entry.referenceId)]))
  const normalizedReferenceModeBySheet = Object.fromEntries(sheets.map((sheet) => [
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

  const promptOverridesBySheet = Object.fromEntries(await Promise.all(sheets.map(async (sheet) => {
    const assetId = assets.find((entry) => entry.label === sheet)?.id ?? ""
    const count = referenceIdsBySheet[sheet].length
    const mode = count ? normalizedReferenceModeBySheet[sheet] : "none"
    const draft = readTemplateDraft(promptTemplates, style, assetId, mode)
    const hasCustomFields = mode === "custom" && count > 0
    if (!draft && !hasCustomFields) return [sheet, null]
    const resolved = await resolvePrompt({ style, asset: assetId, referenceMode: mode, referenceCount: count })
    const formalLabels = new Set(resolved.promptFields.map((field) => String(field.label)))
    const orderedFields = normalizeTemplateFieldOrder(resolved.promptFields, draft?.promptFields)
    const customFields = orderedFields.filter((field) => !formalLabels.has(String(field.label)))
    const custom = customFieldsBySheet[sheet]
    const promptFields = orderedFields.map((field) => ({
      ...field,
      value: hasCustomFields && field.label === "Input images"
        ? custom.inputImages
        : hasCustomFields && field.label === "Primary request"
          ? custom.primaryRequest
          : field.value,
    }))
    return [sheet, {
      routeMode: count ? "reference" : "default",
      promptText: promptFields.map((field) => `${field.label}: ${field.value}`).join("\n"),
      ...(customFields.length ? { customFieldLabels: customFields.map((field) => field.label) } : {}),
    }]
  })))

  return {
    version: 1,
    styleId: style,
    generationLimit: Number(generationLimit),
    enabledSheets,
    referenceModeBySheet: normalizedReferenceModeBySheet,
    referenceIdsBySheet,
    promptOverridesBySheet,
  }
}
