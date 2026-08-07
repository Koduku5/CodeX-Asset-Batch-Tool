import * as React from "react"

import { formatPromptText } from "@/services/catalog-adapter.mjs"
import {
  assetLabel,
  catalogAdapter,
  JsonRecord,
  safeMessage,
  styleLabel,
  ToastState,
} from "@/features/workbench/workbench-foundation"

type Notify = (message: string, tone?: ToastState["tone"]) => void

export function useValidationStudio(notify: Notify) {
  const [style, setStyle] = React.useState("cg")
  const [asset, setAsset] = React.useState("scene")
  const [referenceMode, setReferenceMode] = React.useState("none")
  const [assetId, setAssetId] = React.useState("")
  const [productionNotes, setProductionNotes] = React.useState("")
  const [result, setResult] = React.useState<JsonRecord | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [testImage, setTestImage] = React.useState<{ url: string; name: string } | null>(null)
  const [testStatus, setTestStatus] = React.useState("先完成解析，再点击出图测试")

  React.useEffect(() => () => {
    if (testImage?.url) URL.revokeObjectURL(testImage.url)
  }, [testImage?.url])

  const validateOne = async () => {
    if (!productionNotes.trim()) {
      notify("请先填写这个资产的完整制作说明", "warning")
      return
    }
    setLoading(true)
    setTestImage(null)
    setTestStatus("正在解析最终 Prompt…")
    try {
      const resolved = await catalogAdapter.resolve({
        style,
        asset,
        referenceMode,
        referenceCount: referenceMode === "visual-consistency" ? 2 : referenceMode === "none" ? 0 : 1,
        productionNotes,
      })
      setResult(resolved)
      setTestStatus("解析完成，可以点击出图测试")
      notify("单项解析校验完成")
    } catch (error) {
      setResult(null)
      setTestStatus("解析失败，修正条件后重新校验")
      notify(safeMessage(error, "单项解析失败"), "error")
    } finally {
      setLoading(false)
    }
  }

  const prepareImageTest = async () => {
    if (!result) return
    try {
      const handoff = [
        "请使用 Codex 内置 image_gen 生成 1 张单项测试图；这是 Prompt Studio 的只读测试，不要改动批量队列。",
        `制作风格：${styleLabel(style)}`,
        `资产类型：${assetLabel(asset)}`,
        `资产：${assetId || "未命名测试项"}`,
        "最终 Prompt：",
        formatPromptText(result),
      ].join("\n")
      await navigator.clipboard.writeText(handoff)
      setTestStatus("最终 Prompt 已复制；交给 Codex 内置 ImageGen 后，将生成图片拖回右侧窗口")
      notify("单项出图测试 Prompt 已复制")
    } catch {
      setTestStatus("无法访问剪贴板，请先复制最终 Prompt 再交给 Codex 内置 ImageGen")
      notify("出图测试 Prompt 复制失败", "error")
    }
  }

  const receiveTestImage = (file: File) => {
    if (!file.type.startsWith("image/")) {
      notify("图片返回窗口只接受图片文件", "warning")
      return
    }
    const url = URL.createObjectURL(file)
    setTestImage((current) => {
      if (current?.url) URL.revokeObjectURL(current.url)
      return { url, name: file.name }
    })
    setTestStatus(`已收到测试图：${file.name}`)
  }

  return {
    asset,
    assetId,
    loading,
    prepareImageTest,
    productionNotes,
    receiveTestImage,
    referenceMode,
    result,
    setAsset,
    setAssetId,
    setProductionNotes,
    setReferenceMode,
    setStyle,
    style,
    testImage,
    testStatus,
    validateOne,
  }
}
