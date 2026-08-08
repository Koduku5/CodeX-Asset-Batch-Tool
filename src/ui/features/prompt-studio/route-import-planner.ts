import {
  normalizeRouteModule,
  parseRouteExchangeArtifact,
  routeModulesEqual,
} from "@/services/route-module-workbench.mjs"
import {
  clone,
  nowIso,
  routePresetModulesEqual,
  routePresetNameKey,
  type PendingRouteImport,
  type RouteModule,
  type RoutePreset,
} from "@/features/workbench/workbench-foundation"

type RouteImportMode = "preset" | "branch"
type ParsedRouteArtifact = {
  artifact: ReturnType<typeof parseRouteExchangeArtifact>
  fileName: string
}

async function readRouteArtifacts(files: FileList, mode: RouteImportMode): Promise<ParsedRouteArtifact[]> {
  const selectedFiles = Array.from(files)
  const parsed: ParsedRouteArtifact[] = []
  for (const file of selectedFiles) {
    if (file.size > 5 * 1024 * 1024) throw new Error(`${file.name} 超过 5 MB，未执行本次导入`)
    parsed.push({ fileName: file.name, artifact: parseRouteExchangeArtifact(await file.text()) })
  }
  if (mode === "preset" && parsed.some(({ artifact }) => artifact.type !== "preset-package")) {
    throw new Error("导入预设只能选择预设文件；本次没有写入任何内容")
  }
  if (mode === "branch" && parsed.some(({ artifact }) => artifact.type === "preset-package")) {
    throw new Error("导入分支只能选择分支文件；预设文件请从上方“导入预设”进入")
  }
  return parsed
}

function planPresetImports(parsed: ParsedRouteArtifact[], presets: RoutePreset[]) {
  const conflictNames = new Set<string>()
  const newNames = new Set<string>()
  const sameNames = new Set<string>()
  const incomingPresets: RoutePreset[] = []
  const consolidated: RoutePreset[] = []

  for (const { fileName, artifact } of parsed) {
    if (artifact.type !== "preset-package") continue
    const candidate = {
      id: artifact.value.preset.id,
      name: artifact.value.preset.name,
      revision: artifact.value.preset.revision,
      source: fileName,
      updatedAt: nowIso(),
      templates: clone(artifact.value.templates),
      modules: artifact.value.modules.map(normalizeRouteModule),
    }
    const duplicateIndex = consolidated.findIndex((entry) => entry.id === candidate.id || routePresetNameKey(entry.name) === routePresetNameKey(candidate.name))
    if (duplicateIndex >= 0) {
      const earlier = consolidated[duplicateIndex]
      if (routePresetModulesEqual(earlier, candidate)) sameNames.add(candidate.name)
      else conflictNames.add(`${candidate.name}（所选文件中有不同版本）`)
      consolidated[duplicateIndex] = candidate
    } else consolidated.push(candidate)
  }

  for (const candidate of consolidated) {
    const current = presets.find((entry) => entry.id === candidate.id || routePresetNameKey(entry.name) === routePresetNameKey(candidate.name))
    if (!current) {
      newNames.add(candidate.name)
      incomingPresets.push(candidate)
    } else if (routePresetModulesEqual(current, candidate)) {
      sameNames.add(candidate.name)
    } else {
      conflictNames.add(candidate.name)
      incomingPresets.push(candidate)
    }
  }
  return { conflictNames, incomingPresets, newNames, sameNames }
}

function planBranchImports(parsed: ParsedRouteArtifact[], activePreset: RoutePreset | null) {
  const conflictNames = new Set<string>()
  const newNames = new Set<string>()
  const sameNames = new Set<string>()
  const incomingModules: RouteModule[] = []
  const grouped = new Map<string, { fileName: string; module: RouteModule }[]>()

  for (const { fileName, artifact } of parsed) {
    const entries = artifact.type === "branch-file" ? [artifact.value.module] : artifact.value.modules
    for (const entry of entries.map(normalizeRouteModule)) {
      grouped.set(entry.id, [...(grouped.get(entry.id) ?? []), { fileName, module: entry }])
    }
  }
  for (const entries of grouped.values()) {
    const chosen = entries.at(-1)!.module
    const distinctVersions = entries.filter((entry, index) => !entries.slice(0, index).some((earlier) => routeModulesEqual(earlier.module, entry.module)))
    const current = activePreset?.modules.find((entry) => entry.id === chosen.id)
    if (distinctVersions.length > 1) {
      conflictNames.add(`${chosen.displayName}（所选文件中有 ${distinctVersions.length} 个版本）`)
      incomingModules.push(chosen)
    } else if (!current) {
      newNames.add(chosen.displayName)
      incomingModules.push(chosen)
    } else if (routeModulesEqual(current, chosen)) {
      sameNames.add(chosen.displayName)
    } else {
      conflictNames.add(chosen.displayName)
      incomingModules.push(chosen)
    }
  }
  return { conflictNames, incomingModules, newNames, sameNames }
}

export async function planRouteImport({ activePreset, files, mode, presets }: {
  activePreset: RoutePreset | null
  files: FileList
  mode: RouteImportMode
  presets: RoutePreset[]
}): Promise<PendingRouteImport | null> {
  if (!files.length) return null
  const parsed = await readRouteArtifacts(files, mode)
  if (mode === "branch" && !activePreset) throw new Error("请先选择一个预设，再导入分支")

  const presetPlan = mode === "preset" ? planPresetImports(parsed, presets) : null
  const branchPlan = mode === "branch" ? planBranchImports(parsed, activePreset) : null
  return {
    mode,
    presets: presetPlan?.incomingPresets ?? [],
    modules: branchPlan?.incomingModules ?? [],
    conflictNames: [...(presetPlan?.conflictNames ?? branchPlan?.conflictNames ?? [])],
    newNames: [...(presetPlan?.newNames ?? branchPlan?.newNames ?? [])],
    sameNames: [...(presetPlan?.sameNames ?? branchPlan?.sameNames ?? [])],
    targetPresetId: activePreset?.id ?? null,
  }
}
