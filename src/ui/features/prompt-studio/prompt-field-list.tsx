import * as React from "react"

import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

type PromptField = {
  label: string
  value: string
}

type PromptFieldListProps = {
  fields: PromptField[]
  idPrefix: string
  editable?: boolean
  onChange?: (index: number, value: string) => void
  emptyMessage?: string
}

export function PromptFieldList({
  fields,
  idPrefix,
  editable = false,
  onChange,
  emptyMessage = "当前没有可展示的提示词字段",
}: PromptFieldListProps) {
  if (!fields.length) {
    return (
      <div className="rounded-xl border border-dashed px-4 py-8 text-center text-xs text-muted-foreground">
        {emptyMessage}
      </div>
    )
  }

  return (
    <div className="rounded-xl border bg-background px-3 py-2">
      {fields.map((field, index) => {
        const inputId = `${idPrefix}-${index}`
        return (
          <div
            key={`${field.label}-${index}`}
            className={cn(
              "grid min-w-0 grid-cols-[10.5rem_minmax(0,1fr)] items-start gap-2 py-1 text-xs leading-relaxed",
              editable && "py-0.5",
            )}
          >
            <label
              htmlFor={editable ? inputId : undefined}
              className="flex min-w-0 items-start justify-end gap-0.5 py-1 font-semibold text-primary"
            >
              <span className="min-w-0 text-right">{field.label}</span>
              <span aria-hidden="true" className="shrink-0">:</span>
            </label>
            {editable ? (
              <Textarea
                id={inputId}
                rows={1}
                value={field.value}
                onChange={(event) => onChange?.(index, event.target.value)}
                className="min-h-7 flex-1 resize-y rounded-sm border-0 bg-transparent px-1 py-1 text-xs leading-relaxed shadow-none focus-visible:bg-accent/25 focus-visible:ring-1"
              />
            ) : (
              <p className="min-w-0 flex-1 whitespace-pre-wrap break-words py-1 text-muted-foreground">
                {field.value || "（空）"}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
