import type * as React from "react"

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

export type ToastState = {
  id: number
  tone: "good" | "warning" | "error"
  message: string
}

export type PromptPresetContextValue = {
  presets: RoutePreset[]
  setPresets: React.Dispatch<React.SetStateAction<RoutePreset[]>>
  activePresetId: string
  setActivePresetId: React.Dispatch<React.SetStateAction<string>>
  activePreset: RoutePreset | null
}
