import * as React from "react"
import { Pencil, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import {
  agentRequirementIsValid,
  applyAgentRequirements,
  extractAgentPlaceholders,
  removeAgentPlaceholders,
} from "@/features/prompt-studio/agent-placeholder-tags.mjs"

type PromptField = {
  label: string
  value: string
}

type PromptFieldListProps = {
  fields: PromptField[]
  idPrefix: string
  editable?: boolean
  onChange?: (index: number, value: string) => void
  onRemove?: (index: number) => void
  isRemovable?: (field: PromptField, index: number) => boolean
  onReorder?: (fromIndex: number, toIndex: number) => void
  isReorderLocked?: (field: PromptField, index: number) => boolean
  agentDecisionTags?: boolean
  emptyMessage?: string
}

type PendingRowDrag = {
  index: number
  pointerId: number
  startX: number
  startY: number
  row: HTMLDivElement
}

const ROW_DRAG_HOLD_MS = 180
const ROW_DRAG_CANCEL_DISTANCE = 6

type AgentPlaceholder = {
  marker: string
  start: number
  end: number
  requirement: string
}

type AgentEditorState = {
  index: number
  field: PromptField
  placeholders: AgentPlaceholder[]
  requirements: string[]
}

export function PromptFieldList({
  fields,
  idPrefix,
  editable = false,
  onChange,
  onRemove,
  isRemovable,
  onReorder,
  isReorderLocked,
  agentDecisionTags = false,
  emptyMessage = "当前没有可展示的提示词字段",
}: PromptFieldListProps) {
  const [agentEditor, setAgentEditor] = React.useState<AgentEditorState | null>(null)
  const agentEditorTriggerRef = React.useRef<HTMLButtonElement | null>(null)
  const pendingRowDragRef = React.useRef<PendingRowDrag | null>(null)
  const rowDragHoldTimerRef = React.useRef<number | null>(null)
  const pointerDragIndexRef = React.useRef<number | null>(null)
  const activePointerIdRef = React.useRef<number | null>(null)
  const activeDragRowRef = React.useRef<HTMLDivElement | null>(null)
  const activeDragLabelRef = React.useRef<string | null>(null)
  const rowElementsRef = React.useRef(new Map<string, HTMLDivElement>())
  const pendingFlipRectsRef = React.useRef<Map<string, DOMRect> | null>(null)
  const rowFlipFrameRef = React.useRef(new Map<string, number>())
  const rowFlipTimerRef = React.useRef(new Map<string, number>())
  const dragSettleTimerRef = React.useRef<number | null>(null)
  const dragSettleRowRef = React.useRef<HTMLDivElement | null>(null)
  const dragGrabOffsetYRef = React.useRef(0)
  const dragTranslateYRef = React.useRef(0)
  const latestPointerYRef = React.useRef<number | null>(null)
  const suppressNextClickRef = React.useRef(false)
  const [dragOverIndex, setDragOverIndex] = React.useState<number | null>(null)
  const [draggedLabel, setDraggedLabel] = React.useState<string | null>(null)
  const [reduceMotion, setReduceMotion] = React.useState(() => (
    typeof window !== "undefined"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ))

  React.useEffect(() => {
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)")
    const syncMotionPreference = () => setReduceMotion(motionQuery.matches)
    motionQuery.addEventListener("change", syncMotionPreference)
    return () => motionQuery.removeEventListener("change", syncMotionPreference)
  }, [])

  const cancelPendingRowDrag = React.useCallback(() => {
    if (rowDragHoldTimerRef.current != null) {
      window.clearTimeout(rowDragHoldTimerRef.current)
      rowDragHoldTimerRef.current = null
    }
    pendingRowDragRef.current = null
  }, [])

  const canReorderField = React.useCallback((fromIndex: number, toIndex: number) => {
    if (
      fromIndex === toIndex
      || fromIndex < 0
      || toIndex < 0
      || fromIndex >= fields.length
      || toIndex >= fields.length
      || isReorderLocked?.(fields[fromIndex], fromIndex)
    ) return false
    const lowerIndex = Math.min(fromIndex, toIndex)
    const upperIndex = Math.max(fromIndex, toIndex)
    return !fields.some((field, index) => (
      index >= lowerIndex
      && index <= upperIndex
      && index !== fromIndex
      && Boolean(isReorderLocked?.(field, index))
    ))
  }, [fields, isReorderLocked])

  const updateDraggedRowVisual = React.useCallback((clientY: number) => {
    const row = activeDragRowRef.current
    if (!row) return
    latestPointerYRef.current = clientY
    const rect = row.getBoundingClientRect()
    const layoutTop = rect.top - dragTranslateYRef.current
    const nextTranslateY = clientY - dragGrabOffsetYRef.current - layoutTop
    dragTranslateYRef.current = nextTranslateY
    row.style.setProperty("--prompt-field-drag-y", `${nextTranslateY}px`)
  }, [])

  React.useLayoutEffect(() => {
    const beforeRects = pendingFlipRectsRef.current
    pendingFlipRectsRef.current = null
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    if (beforeRects && !reduceMotion) {
      for (const [label, row] of rowElementsRef.current) {
        if (label === activeDragLabelRef.current) continue
        const beforeRect = beforeRects.get(label)
        if (!beforeRect) continue
        const previousFrame = rowFlipFrameRef.current.get(label)
        const previousTimer = rowFlipTimerRef.current.get(label)
        if (previousFrame != null) window.cancelAnimationFrame(previousFrame)
        if (previousTimer != null) window.clearTimeout(previousTimer)
        rowFlipFrameRef.current.delete(label)
        rowFlipTimerRef.current.delete(label)
        row.style.transition = "none"
        row.style.transform = ""
        const deltaY = beforeRect.top - row.getBoundingClientRect().top
        if (Math.abs(deltaY) < 0.5) {
          row.style.removeProperty("transition")
          continue
        }
        row.style.transform = `translate3d(0, ${deltaY}px, 0)`
        row.getBoundingClientRect()
        const frame = window.requestAnimationFrame(() => {
          row.style.transition = "transform 320ms cubic-bezier(0.22, 1, 0.36, 1)"
          row.style.transform = "translate3d(0, 0, 0)"
          const timer = window.setTimeout(() => {
            row.style.removeProperty("transition")
            row.style.removeProperty("transform")
            rowFlipTimerRef.current.delete(label)
          }, 340)
          rowFlipTimerRef.current.set(label, timer)
          rowFlipFrameRef.current.delete(label)
        })
        rowFlipFrameRef.current.set(label, frame)
      }
    }
    if (latestPointerYRef.current != null) updateDraggedRowVisual(latestPointerYRef.current)
  }, [fields, updateDraggedRowVisual])

  React.useEffect(() => () => {
    cancelPendingRowDrag()
    for (const frame of rowFlipFrameRef.current.values()) window.cancelAnimationFrame(frame)
    for (const timer of rowFlipTimerRef.current.values()) window.clearTimeout(timer)
    if (dragSettleTimerRef.current != null) window.clearTimeout(dragSettleTimerRef.current)
    for (const row of rowElementsRef.current.values()) {
      row.style.removeProperty("transition")
      row.style.removeProperty("transform")
      row.style.removeProperty("--prompt-field-drag-y")
      row.style.removeProperty("pointer-events")
    }
    const activeRow = activeDragRowRef.current
    const activePointerId = activePointerIdRef.current
    if (activeRow && activePointerId != null && activeRow.hasPointerCapture(activePointerId)) {
      activeRow.releasePointerCapture(activePointerId)
    }
    activeDragRowRef.current = null
    activeDragLabelRef.current = null
    activePointerIdRef.current = null
    pointerDragIndexRef.current = null
    dragSettleRowRef.current = null
  }, [cancelPendingRowDrag])

  React.useEffect(() => {
    const continuePointerDrag = (event: PointerEvent) => {
      const pending = pendingRowDragRef.current
      if (pending && pointerDragIndexRef.current == null) {
        if (event.pointerId !== pending.pointerId) return
        if (Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY) > ROW_DRAG_CANCEL_DISTANCE) {
          cancelPendingRowDrag()
        }
        return
      }
      const fromIndex = pointerDragIndexRef.current
      if (
        !editable
        || !onReorder
        || fromIndex == null
        || event.pointerId !== activePointerIdRef.current
      ) return
      event.preventDefault()
      updateDraggedRowVisual(event.clientY)
      const draggedRow = activeDragRowRef.current
      const previousPointerEvents = draggedRow?.style.pointerEvents ?? ""
      if (draggedRow) draggedRow.style.pointerEvents = "none"
      const targetRow = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest("[data-prompt-field-index]") as HTMLElement | null
      if (draggedRow) draggedRow.style.pointerEvents = previousPointerEvents
      const toIndex = Number(targetRow?.dataset.promptFieldIndex)
      if (!Number.isInteger(toIndex) || !canReorderField(fromIndex, toIndex)) return
      pendingFlipRectsRef.current = new Map(
        [...rowElementsRef.current].map(([label, row]) => [label, row.getBoundingClientRect()]),
      )
      onReorder(fromIndex, toIndex)
      pointerDragIndexRef.current = toIndex
      setDragOverIndex(toIndex)
    }
    const finishPointerDrag = (event: PointerEvent) => {
      const pendingPointerId = pendingRowDragRef.current?.pointerId
      const activePointerId = activePointerIdRef.current
      if (
        (pendingPointerId != null || activePointerId != null)
        && event.pointerId !== (activePointerId ?? pendingPointerId)
      ) return
      cancelPendingRowDrag()
      const activeRow = activeDragRowRef.current
      if (activeRow && activePointerId != null && activeRow.hasPointerCapture(activePointerId)) {
        activeRow.releasePointerCapture(activePointerId)
      }
      let settleWithMotion = false
      if (activeRow) {
        const currentTransform = window.getComputedStyle(activeRow).transform
        settleWithMotion = currentTransform !== "none"
          && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
        if (settleWithMotion) {
          activeRow.style.transition = "transform 280ms cubic-bezier(0.22, 1, 0.36, 1)"
          activeRow.style.transform = currentTransform
          activeRow.getBoundingClientRect()
        }
        activeRow.style.removeProperty("--prompt-field-drag-y")
      }
      pointerDragIndexRef.current = null
      activePointerIdRef.current = null
      activeDragRowRef.current = null
      activeDragLabelRef.current = null
      latestPointerYRef.current = null
      dragTranslateYRef.current = 0
      pendingFlipRectsRef.current = null
      setDragOverIndex(null)
      setDraggedLabel(null)
      if (activeRow && settleWithMotion) {
        if (dragSettleTimerRef.current != null) window.clearTimeout(dragSettleTimerRef.current)
        dragSettleRowRef.current = activeRow
        dragSettleTimerRef.current = window.setTimeout(() => {
          activeRow.style.removeProperty("transition")
          activeRow.style.removeProperty("transform")
          dragSettleTimerRef.current = null
          dragSettleRowRef.current = null
        }, 300)
      }
      if (suppressNextClickRef.current) {
        window.setTimeout(() => { suppressNextClickRef.current = false }, 0)
      }
    }
    document.addEventListener("pointermove", continuePointerDrag, { passive: false })
    document.addEventListener("pointerup", finishPointerDrag)
    document.addEventListener("pointercancel", finishPointerDrag)
    return () => {
      document.removeEventListener("pointermove", continuePointerDrag)
      document.removeEventListener("pointerup", finishPointerDrag)
      document.removeEventListener("pointercancel", finishPointerDrag)
    }
  }, [cancelPendingRowDrag, canReorderField, editable, onReorder, updateDraggedRowVisual])

  if (!fields.length) {
    return (
      <div className="rounded-xl border border-dashed px-4 py-8 text-center text-xs text-muted-foreground">
        {emptyMessage}
      </div>
    )
  }

  const saveAgentRequirements = () => {
    if (!agentEditor || !agentEditor.requirements.every(agentRequirementIsValid)) return
    onChange?.(
      agentEditor.index,
      applyAgentRequirements(
        agentEditor.field.value,
        agentEditor.placeholders,
        agentEditor.requirements,
      ),
    )
    setAgentEditor(null)
  }

  return (
    <>
      {editable && agentDecisionTags && onChange ? (
        <div className="mb-1 flex justify-end pr-3 text-[10px] font-medium text-muted-foreground">
          <span className="whitespace-nowrap text-right">是否启用 AI 判断</span>
        </div>
      ) : null}
      <div className="rounded-xl border bg-background px-3 py-2">
        {fields.map((field, index) => {
          const inputId = `${idPrefix}-${index}`
          const removable = Boolean(editable && onRemove && isRemovable?.(field, index))
          const agentPlaceholders = agentDecisionTags
            ? extractAgentPlaceholders(field.value) as AgentPlaceholder[]
            : []
          const agentDecisionActive = agentPlaceholders.length > 0
          const reorderLocked = Boolean(editable && onReorder && isReorderLocked?.(field, index))
          const reorderable = Boolean(editable && onReorder && !reorderLocked)
          const rowIsDragging = draggedLabel === field.label
          return (
          <div
            key={field.label}
            ref={(row) => {
              if (row) rowElementsRef.current.set(field.label, row)
              else rowElementsRef.current.delete(field.label)
            }}
            data-prompt-field-index={index}
            data-prompt-field-reorderable={reorderable ? "true" : undefined}
            data-prompt-field-reorder-locked={reorderLocked ? "true" : undefined}
            data-prompt-field-dragging={rowIsDragging ? "true" : undefined}
            style={rowIsDragging ? {
              transform: `translate3d(0, var(--prompt-field-drag-y, 0px), 0) scale(${reduceMotion ? 1 : 1.012})`,
              transformOrigin: "center center",
            } : undefined}
            title={reorderLocked ? "固定在顶部，不参与拖动排序" : reorderable ? "按住整行后拖动排序；按 Alt + 上下方向键也可移动" : undefined}
            onPointerDown={reorderable ? (event) => {
              if (event.button !== 0 || !event.isPrimary) return
              if ((event.target as HTMLElement).closest("button, [role='switch']")) return
              cancelPendingRowDrag()
              const pending: PendingRowDrag = {
                index,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                row: event.currentTarget,
              }
              pendingRowDragRef.current = pending
              rowDragHoldTimerRef.current = window.setTimeout(() => {
                if (pendingRowDragRef.current !== pending) return
                pendingRowDragRef.current = null
                rowDragHoldTimerRef.current = null
                pointerDragIndexRef.current = index
                activePointerIdRef.current = pending.pointerId
                activeDragRowRef.current = pending.row
                activeDragLabelRef.current = field.label
                const pendingFrame = rowFlipFrameRef.current.get(field.label)
                const pendingTimer = rowFlipTimerRef.current.get(field.label)
                if (pendingFrame != null) window.cancelAnimationFrame(pendingFrame)
                if (pendingTimer != null) window.clearTimeout(pendingTimer)
                rowFlipFrameRef.current.delete(field.label)
                rowFlipTimerRef.current.delete(field.label)
                if (dragSettleTimerRef.current != null) {
                  window.clearTimeout(dragSettleTimerRef.current)
                  dragSettleTimerRef.current = null
                  dragSettleRowRef.current?.style.removeProperty("transition")
                  dragSettleRowRef.current?.style.removeProperty("transform")
                  dragSettleRowRef.current = null
                }
                pending.row.style.removeProperty("transition")
                pending.row.style.removeProperty("transform")
                const rowRect = pending.row.getBoundingClientRect()
                dragGrabOffsetYRef.current = pending.startY - rowRect.top
                dragTranslateYRef.current = 0
                latestPointerYRef.current = pending.startY
                pending.row.style.setProperty("--prompt-field-drag-y", "0px")
                try {
                  pending.row.setPointerCapture(pending.pointerId)
                } catch {
                  // Document-level pointer listeners remain the fallback.
                }
                suppressNextClickRef.current = true
                setDragOverIndex(index)
                setDraggedLabel(field.label)
              }, ROW_DRAG_HOLD_MS)
            } : undefined}
            onClickCapture={reorderable ? (event) => {
              if (!suppressNextClickRef.current) return
              suppressNextClickRef.current = false
              event.preventDefault()
              event.stopPropagation()
            } : undefined}
            onContextMenu={reorderable ? (event) => {
              if (pointerDragIndexRef.current == null) return
              event.preventDefault()
            } : undefined}
            onKeyDownCapture={reorderable ? (event) => {
              if ((event.target as HTMLElement).closest("button, [role='switch']")) return
              if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return
              const targetIndex = event.key === "ArrowUp" ? index - 1 : index + 1
              if (!canReorderField(index, targetIndex)) return
              event.preventDefault()
              onReorder?.(index, targetIndex)
            } : undefined}
            className={cn(
              "grid min-w-0 grid-cols-[minmax(6.5rem,8rem)_minmax(0,1fr)] items-start gap-2 py-1 text-xs leading-relaxed sm:grid-cols-[10.5rem_minmax(0,1fr)]",
              editable && agentDecisionTags && "grid-cols-[minmax(6.5rem,8rem)_minmax(0,1fr)_6.75rem] sm:grid-cols-[10.5rem_minmax(0,1fr)_6.75rem]",
              editable && onRemove && !agentDecisionTags && "grid-cols-[minmax(6.5rem,8rem)_minmax(0,1fr)_2rem] sm:grid-cols-[10.5rem_minmax(0,1fr)_2rem]",
              editable && agentDecisionTags && onRemove && "grid-cols-[minmax(6.5rem,8rem)_minmax(0,1fr)_2rem_6.75rem] sm:grid-cols-[10.5rem_minmax(0,1fr)_2rem_6.75rem]",
              editable && "py-0.5",
              rowIsDragging && dragOverIndex === index && "relative z-20 touch-none select-none cursor-grabbing rounded-lg bg-background/95 shadow-overlay ring-1 ring-primary/30 will-change-transform transition-[box-shadow,background-color,border-radius] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
            )}
          >
            <div className="flex min-w-0 items-start justify-end gap-1">
              <label
                htmlFor={editable ? inputId : undefined}
                className="flex min-w-0 items-start justify-end gap-0.5 py-1 font-semibold text-primary"
              >
                <span className="min-w-0 text-right">{field.label}</span>
                <span aria-hidden="true" className="shrink-0">:</span>
              </label>
            </div>
            {editable ? (
              <Textarea
                id={inputId}
                rows={1}
                value={field.value}
                onChange={(event) => onChange?.(index, event.target.value)}
                className="min-h-7 min-w-0 flex-1 resize-y rounded-sm border-0 bg-transparent px-1 py-1 text-xs leading-relaxed shadow-none focus-visible:bg-accent/25 focus-visible:ring-1"
              />
            ) : (
              <p className="min-w-0 flex-1 whitespace-pre-wrap break-words py-1 text-muted-foreground">
                {field.value || "（空）"}
              </p>
            )}
            {editable && onRemove ? (
              removable ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={`删除自定义字段“${field.label}”`}
                  title={`删除自定义字段“${field.label}”`}
                  onClick={() => onRemove(index)}
                >
                  <Trash2 />
                </Button>
              ) : <span aria-hidden="true" className="size-8" />
            ) : null}
            {editable && agentDecisionTags && onChange ? (
              <div className="flex min-h-8 items-center justify-end gap-1">
                <Switch
                  checked={agentDecisionActive}
                  aria-label={`是否启用“${field.label}”的 AI 判断`}
                  aria-haspopup={agentDecisionActive ? undefined : "dialog"}
                  aria-controls={agentDecisionActive ? undefined : `${idPrefix}-agent-dialog`}
                  aria-expanded={agentEditor?.index === index}
                  onClick={(event) => { agentEditorTriggerRef.current = event.currentTarget }}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      setAgentEditor({
                        index,
                        field: { ...field },
                        placeholders: agentPlaceholders,
                        requirements: [""],
                      })
                      return
                    }
                    onChange(index, removeAgentPlaceholders(field.value, agentPlaceholders))
                  }}
                />
                {agentDecisionActive ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-7 text-muted-foreground"
                    aria-label={`编辑“${field.label}”的 AI 判断需求`}
                    title={`编辑“${field.label}”的 AI 判断需求`}
                    aria-haspopup="dialog"
                    aria-controls={`${idPrefix}-agent-dialog`}
                    aria-expanded={agentEditor?.index === index}
                    onClick={(event) => {
                      agentEditorTriggerRef.current = event.currentTarget
                      setAgentEditor({
                        index,
                        field: { ...field },
                        placeholders: agentPlaceholders,
                        requirements: agentPlaceholders.map(({ requirement }) => requirement),
                      })
                    }}
                  >
                    <Pencil />
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          )
        })}
      </div>
      <Dialog open={Boolean(agentEditor)} onOpenChange={(open) => !open && setAgentEditor(null)}>
        <DialogContent
          id={`${idPrefix}-agent-dialog`}
          className="sm:max-w-lg"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            agentEditorTriggerRef.current?.focus()
          }}
        >
          <DialogHeader>
            <DialogTitle>{agentEditor ? `设置“${agentEditor.field.label}”的 AI 判断` : "设置 AI 判断"}</DialogTitle>
            <DialogDescription>
              {agentEditor?.placeholders.length
                ? "这里只修改已有占位符的判断需求；字段中的其他固定文字会原样保留。关闭开关即可取消该字段的 AI 判断。"
                : "填写具体判断需求；保存后系统会用标准占位符替换该字段当前值，开关会显示为启用。"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-1">
            {agentEditor?.requirements.map((requirement, index) => {
              const requirementId = `${idPrefix}-agent-requirement-${index}`
              const missing = !requirement.trim()
              const invalid = !agentRequirementIsValid(requirement)
              return (
                <div key={requirementId} className="space-y-2">
                  <Label htmlFor={requirementId}>
                    具体判断需求{agentEditor.requirements.length > 1 ? ` ${index + 1}` : ""}
                    <span className="text-destructive">（必填）</span>
                  </Label>
                  <Textarea
                    id={requirementId}
                    autoFocus={index === 0}
                    rows={3}
                    value={requirement}
                    required
                    aria-invalid={invalid}
                    aria-describedby={`${requirementId}-help`}
                    placeholder="例如：根据制作说明判断室内、室外或地标场景；无法判断时使用普通环境概念图"
                    onChange={(event) => setAgentEditor((current) => current ? {
                      ...current,
                      requirements: current.requirements.map((item, itemIndex) => (
                        itemIndex === index ? event.target.value.replace(/\r?\n/gu, " ") : item
                      )),
                    } : current)}
                  />
                  <p id={`${requirementId}-help`} className={cn(
                    "text-xs text-muted-foreground",
                    invalid && "text-destructive",
                  )}>
                    {missing
                      ? "请填写具体判断需求；此项为必填。"
                      : invalid
                        ? "需求必须是单行文字，且不能包含【】。"
                        : "系统会自动保存为规范的 AI 判断占位符。"}
                  </p>
                </div>
              )
            })}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAgentEditor(null)}>取消</Button>
            <Button
              type="button"
              onClick={saveAgentRequirements}
              disabled={!agentEditor?.requirements.every(agentRequirementIsValid)}
            >
              保存需求
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
