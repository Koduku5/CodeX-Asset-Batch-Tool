import * as React from "react"

import { applyModuleOperationsPreview, buildClassificationRequest, normalizeRouteModule, validateRouteModule } from "@/services/route-module-workbench.mjs"
import {
  type JsonRecord,
  type RouteModule,
  type ToastState,
} from "@/features/workbench/workbench-types"
import {
  catalogAdapter,
  routeClassifierAdapter,
} from "@/features/workbench/workbench-adapters"
import {
  safeMessage,
  uniqueId,
} from "@/features/workbench/workbench-utils"

type UseRouteClassificationOptions = {
  catalogStatus: JsonRecord | null
  commitModule: (next: RouteModule) => void
  module: RouteModule | null
  modules: RouteModule[]
  notify: (message: string, tone?: ToastState["tone"]) => void
  setBusy: React.Dispatch<React.SetStateAction<boolean>>
}

export function useRouteClassification({ catalogStatus, commitModule, module, modules, notify, setBusy }: UseRouteClassificationOptions) {
  const [testStyle, setTestStyle] = React.useState("cg")
  const [testAsset, setTestAsset] = React.useState("scene")
  const [testReferenceMode, setTestReferenceMode] = React.useState("none")
  const [testAssetId, setTestAssetId] = React.useState("")
  const [testNotes, setTestNotes] = React.useState("")
  const [classificationRequest, setClassificationRequest] = React.useState<JsonRecord | null>(null)
  const [classificationReceipt, setClassificationReceipt] = React.useState<JsonRecord | null>(null)
  const [classificationPreview, setClassificationPreview] = React.useState<JsonRecord | null>(null)
  const [simulatedDecision, setSimulatedDecision] = React.useState("__null__")
  const [classificationMessage, setClassificationMessage] = React.useState("尚未开始判断")

  const availableForScope = React.useMemo(() => modules
    .map(normalizeRouteModule)
    .filter((entry) => entry.scope.styles.includes(testStyle)
      && entry.scope.assets.includes(testAsset)
      && entry.scope.referenceModes.includes(testReferenceMode)
      && validateRouteModule(entry).valid), [modules, testAsset, testReferenceMode, testStyle])
  const formalModuleIds = React.useMemo(() => new Set<string>(
    (catalogStatus?.catalogSummary?.conditionModules ?? []).map((entry: RouteModule) => entry.id),
  ), [catalogStatus])

  const invalidateClassification = () => {
    setClassificationRequest(null)
    setClassificationReceipt(null)
    setClassificationPreview(null)
    setClassificationMessage("测试条件已变化，请重新开始智能判断")
  }

  const applyClassificationReceipt = async (
    selectedId: string | null,
    { source, reason = "", request = classificationRequest }: { source: string; reason?: string; request?: JsonRecord | null },
  ) => {
    if (!request) {
      setClassificationMessage("请先生成智能判断任务")
      return
    }
    const selected = selectedId ? modules.find((entry) => entry.id === selectedId) ?? null : null
    if (selectedId && (!selected || !request.candidates.some((entry: JsonRecord) => entry.id === selectedId))) {
      setClassificationMessage("回执不在本次候选分支范围内")
      return
    }
    setBusy(true)
    try {
      const base = await catalogAdapter.resolve({
        style: testStyle,
        asset: testAsset,
        referenceMode: testReferenceMode,
        referenceCount: testReferenceMode === "visual-consistency" ? 2 : testReferenceMode === "none" ? 0 : 1,
        productionNotes: testNotes.trim(),
      })
      const operations = selected ? [...(selected.origin?.sharedOperations ?? []), ...selected.operations] : []
      const applied = selected
        ? applyModuleOperationsPreview(base.promptFields, { ...selected, operations })
        : { fields: base.promptFields, diff: [], deferred: [] }
      setClassificationReceipt({ selectedId, source, reason })
      setClassificationPreview({ base, applied, selected })
      setClassificationMessage(selected ? `命中：${selected.displayName}` : "本次不命中任何分支")
    } catch (error) {
      setClassificationMessage(safeMessage(error, "无法预演 Agent 判断结果"))
    } finally {
      setBusy(false)
    }
  }

  const startClassification = async () => {
    try {
      const request = buildClassificationRequest({
        style: testStyle,
        asset: testAsset,
        referenceMode: testReferenceMode,
        assetId: testAssetId,
        productionNotes: testNotes,
        candidates: modules,
      })
      setClassificationRequest(request)
      setClassificationReceipt(null)
      setClassificationPreview(null)
      setClassificationMessage(`已生成任务：Agent 只能从 ${request.candidates.length} 个候选中返回唯一编号或“不命中”`)
      if (!routeClassifierAdapter.getCapabilities().classify) return
      setBusy(true)
      const receipt = await routeClassifierAdapter.classify(request)
      await applyClassificationReceipt(receipt.selectedId, { source: receipt.source, reason: receipt.reason, request })
    } catch (error) {
      setClassificationMessage(safeMessage(error, "智能判断任务生成失败"))
      setClassificationRequest(null)
      setClassificationReceipt(null)
      setClassificationPreview(null)
    } finally {
      setBusy(false)
    }
  }

  const saveClassificationTest = () => {
    if (!module || classificationReceipt?.selectedId !== module.id) {
      notify("只有 Agent 回执明确命中当前编辑分支时，才能保存为这个分支的测试样例", "warning")
      return
    }
    const nextTest = {
      id: uniqueId("case"),
      assetId: testAssetId,
      style: testStyle,
      asset: testAsset,
      productionNotes: testNotes.trim(),
      expectedConditionId: module.id,
    }
    commitModule({ ...module, tests: [...module.tests, nextTest] })
    notify("测试样例已保存到当前分支；导出时会一并携带")
  }

  return {
    applyClassificationReceipt, availableForScope, classificationMessage, classificationPreview,
    classificationReceipt, classificationRequest, formalModuleIds, invalidateClassification,
    saveClassificationTest, setClassificationPreview, setClassificationReceipt,
    setClassificationRequest, setSimulatedDecision, setTestAsset, setTestAssetId, setTestNotes,
    setTestReferenceMode, setTestStyle, simulatedDecision, startClassification, testAsset,
    testAssetId, testNotes, testReferenceMode, testStyle,
  }
}

export type RouteClassificationStudio = ReturnType<typeof useRouteClassification>
