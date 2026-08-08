import * as React from "react"
import { Pencil, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import {
  agentRequirementIsValid,
  applyAgentRequirements,
  extractAgentPlaceholders,
  removeAgentPlaceholders,
} from "@/features/prompt-studio/agent-placeholder-tags.mjs"
import {
  PromptFieldAgentDialog,
  type AgentEditorState,
  type AgentPlaceholder,
} from "@/features/prompt-studio/prompt-field-agent-dialog"
import { usePromptFieldDrag, type PromptField } from "@/features/prompt-studio/use-prompt-field-drag"

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
  const dragController = usePromptFieldDrag({ editable, fields, isReorderLocked, onReorder })
  const {
    blockDragContextMenu, captureRowClick, dragOverIndex, draggedLabel, reduceMotion,
    registerRow, reorderWithKeyboard, startRowDrag,
  } = dragController

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
            ref={(row) => registerRow(field.label, row)}
            data-prompt-field-index={index}
            data-prompt-field-reorderable={reorderable ? "true" : undefined}
            data-prompt-field-reorder-locked={reorderLocked ? "true" : undefined}
            data-prompt-field-dragging={rowIsDragging ? "true" : undefined}
            style={rowIsDragging ? {
              transform: `translate3d(0, var(--prompt-field-drag-y, 0px), 0) scale(${reduceMotion ? 1 : 1.012})`,
              transformOrigin: "center center",
            } : undefined}
            title={reorderLocked ? "固定在顶部，不参与拖动排序" : reorderable ? "按住整行后拖动排序；按 Alt + 上下方向键也可移动" : undefined}
            onPointerDown={reorderable ? (event) => startRowDrag(event, index, field.label) : undefined}
            onClickCapture={reorderable ? captureRowClick : undefined}
            onContextMenu={reorderable ? blockDragContextMenu : undefined}
            onKeyDownCapture={reorderable ? (event) => reorderWithKeyboard(event, index) : undefined}
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
      <PromptFieldAgentDialog
        editor={agentEditor}
        idPrefix={idPrefix}
        onSave={saveAgentRequirements}
        setEditor={setAgentEditor}
        triggerRef={agentEditorTriggerRef}
      />
    </>
  )
}
