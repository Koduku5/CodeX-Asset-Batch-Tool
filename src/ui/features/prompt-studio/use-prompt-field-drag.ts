import * as React from "react"

export type PromptField = {
  label: string
  value: string
}

type PendingRowDrag = {
  index: number
  pointerId: number
  startX: number
  startY: number
  row: HTMLDivElement
}

type UsePromptFieldDragOptions = {
  editable: boolean
  fields: PromptField[]
  isReorderLocked?: (field: PromptField, index: number) => boolean
  onReorder?: (fromIndex: number, toIndex: number) => void
}

const ROW_DRAG_HOLD_MS = 180
const ROW_DRAG_CANCEL_DISTANCE = 6

export function usePromptFieldDrag({ editable, fields, isReorderLocked, onReorder }: UsePromptFieldDragOptions) {
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
        if (Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY) > ROW_DRAG_CANCEL_DISTANCE) cancelPendingRowDrag()
        return
      }
      const fromIndex = pointerDragIndexRef.current
      if (!editable || !onReorder || fromIndex == null || event.pointerId !== activePointerIdRef.current) return
      event.preventDefault()
      updateDraggedRowVisual(event.clientY)
      const draggedRow = activeDragRowRef.current
      const previousPointerEvents = draggedRow?.style.pointerEvents ?? ""
      if (draggedRow) draggedRow.style.pointerEvents = "none"
      const targetRow = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-prompt-field-index]") as HTMLElement | null
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
      if ((pendingPointerId != null || activePointerId != null) && event.pointerId !== (activePointerId ?? pendingPointerId)) return
      cancelPendingRowDrag()
      const activeRow = activeDragRowRef.current
      if (activeRow && activePointerId != null && activeRow.hasPointerCapture(activePointerId)) activeRow.releasePointerCapture(activePointerId)
      let settleWithMotion = false
      if (activeRow) {
        const currentTransform = window.getComputedStyle(activeRow).transform
        settleWithMotion = currentTransform !== "none" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches
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
      if (suppressNextClickRef.current) window.setTimeout(() => { suppressNextClickRef.current = false }, 0)
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

  const registerRow = (label: string, row: HTMLDivElement | null) => {
    if (row) rowElementsRef.current.set(label, row)
    else rowElementsRef.current.delete(label)
  }

  const startRowDrag = (event: React.PointerEvent<HTMLDivElement>, index: number, label: string) => {
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
      activeDragLabelRef.current = label
      const pendingFrame = rowFlipFrameRef.current.get(label)
      const pendingTimer = rowFlipTimerRef.current.get(label)
      if (pendingFrame != null) window.cancelAnimationFrame(pendingFrame)
      if (pendingTimer != null) window.clearTimeout(pendingTimer)
      rowFlipFrameRef.current.delete(label)
      rowFlipTimerRef.current.delete(label)
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
      setDraggedLabel(label)
    }, ROW_DRAG_HOLD_MS)
  }

  const captureRowClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!suppressNextClickRef.current) return
    suppressNextClickRef.current = false
    event.preventDefault()
    event.stopPropagation()
  }

  const blockDragContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    if (pointerDragIndexRef.current == null) return
    event.preventDefault()
  }

  const reorderWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>, index: number) => {
    if ((event.target as HTMLElement).closest("button, [role='switch']")) return
    if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return
    const targetIndex = event.key === "ArrowUp" ? index - 1 : index + 1
    if (!canReorderField(index, targetIndex)) return
    event.preventDefault()
    onReorder?.(index, targetIndex)
  }

  return {
    blockDragContextMenu, captureRowClick, dragOverIndex, draggedLabel, reduceMotion,
    registerRow, reorderWithKeyboard, startRowDrag,
  }
}

export type PromptFieldDragController = ReturnType<typeof usePromptFieldDrag>
