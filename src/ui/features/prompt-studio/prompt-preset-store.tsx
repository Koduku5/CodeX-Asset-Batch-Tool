import * as React from "react"

import { readLegacyTemplateDrafts } from "@/features/prompt-studio/template-drafts.mjs"
import {
  ACTIVE_PRESET_STORAGE_KEY,
  LEGACY_PRESET_STORAGE_KEY,
  PRESET_STORAGE_KEY,
} from "@/features/workbench/workbench-constants"
import type {
  JsonRecord,
  PromptPresetContextValue,
  RouteModule,
  RoutePreset,
} from "@/features/workbench/workbench-types"
import { clone, nowIso } from "@/features/workbench/workbench-utils"
import {
  normalizeRouteModule,
  routeModulesEqual,
} from "@/services/route-module-workbench.mjs"

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
