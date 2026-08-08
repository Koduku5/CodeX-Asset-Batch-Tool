import * as React from "react"

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
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import { agentRequirementIsValid } from "@/features/prompt-studio/agent-placeholder-tags.mjs"
import type { PromptField } from "@/features/prompt-studio/use-prompt-field-drag"

export type AgentPlaceholder = {
  marker: string
  start: number
  end: number
  requirement: string
}

export type AgentEditorState = {
  index: number
  field: PromptField
  placeholders: AgentPlaceholder[]
  requirements: string[]
}

export function PromptFieldAgentDialog({ editor, idPrefix, onSave, setEditor, triggerRef }: {
  editor: AgentEditorState | null
  idPrefix: string
  onSave: () => void
  setEditor: React.Dispatch<React.SetStateAction<AgentEditorState | null>>
  triggerRef: React.RefObject<HTMLButtonElement | null>
}) {
  return (
    <Dialog open={Boolean(editor)} onOpenChange={(open) => !open && setEditor(null)}>
      <DialogContent
        id={`${idPrefix}-agent-dialog`}
        className="sm:max-w-lg"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          triggerRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{editor ? `设置“${editor.field.label}”的 AI 判断` : "设置 AI 判断"}</DialogTitle>
          <DialogDescription>
            {editor?.placeholders.length
              ? "这里只修改已有占位符的判断需求；字段中的其他固定文字会原样保留。关闭开关即可取消该字段的 AI 判断。"
              : "填写具体判断需求；保存后系统会用标准占位符替换该字段当前值，开关会显示为启用。"}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-1">
          {editor?.requirements.map((requirement, index) => {
            const requirementId = `${idPrefix}-agent-requirement-${index}`
            const missing = !requirement.trim()
            const invalid = !agentRequirementIsValid(requirement)
            return (
              <div key={requirementId} className="space-y-2">
                <Label htmlFor={requirementId}>
                  具体判断需求{editor.requirements.length > 1 ? ` ${index + 1}` : ""}
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
                  onChange={(event) => setEditor((current) => current ? {
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
          <Button type="button" variant="outline" onClick={() => setEditor(null)}>取消</Button>
          <Button
            type="button"
            onClick={onSave}
            disabled={!editor?.requirements.every(agentRequirementIsValid)}
          >
            保存需求
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
