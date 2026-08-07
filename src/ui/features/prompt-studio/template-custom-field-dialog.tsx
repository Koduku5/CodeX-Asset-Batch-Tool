import * as React from "react"
import { Plus } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  customTemplateFieldLabelError,
  MAX_CUSTOM_TEMPLATE_FIELDS,
} from "@/features/prompt-studio/template-field-order.mjs"
import { cn } from "@/lib/utils"

type TemplateCustomFieldDialogProps = {
  customFieldCount: number
  disabled: boolean
  fields: Array<{ label?: unknown }>
  onAdd: (label: string, value: string) => void
}

export function TemplateCustomFieldDialog({ customFieldCount, disabled, fields, onAdd }: TemplateCustomFieldDialogProps) {
  const [open, setOpen] = React.useState(false)
  const [label, setLabel] = React.useState("")
  const [value, setValue] = React.useState("")
  const normalizedLabel = label.trim()
  const error = customTemplateFieldLabelError(label, fields, customFieldCount)

  const openDialog = () => {
    setLabel("")
    setValue("")
    setOpen(true)
  }

  const addField = () => {
    if (error) return
    onAdd(normalizedLabel, value)
    setOpen(false)
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={openDialog} disabled={disabled || customFieldCount >= MAX_CUSTOM_TEMPLATE_FIELDS}><Plus />添加字段</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>添加自定义字段</DialogTitle>
            <DialogDescription>字段会先添加到列表末尾，可按住整行拖动调整位置，并随当前风格、资产类型和参考图方式保存。</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="custom-field-label">字段名称</Label>
              <Input id="custom-field-label" autoFocus value={label} maxLength={80} aria-invalid={Boolean(label && error)} aria-describedby="custom-field-label-help" onChange={(event) => setLabel(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !error) addField() }} placeholder="例如：Camera language" />
              <p id="custom-field-label-help" className={cn("text-xs", label && error ? "text-destructive" : "text-muted-foreground")}>{label && error ? error : "名称需唯一，不能包含冒号或换行，最多 80 个字符。"}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="custom-field-value">初始内容</Label>
              <Textarea id="custom-field-value" rows={4} value={value} onChange={(event) => setValue(event.target.value)} placeholder="可留空，稍后在字段列表中继续编辑" />
            </div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>取消</Button><Button onClick={addField} disabled={Boolean(error)}><Plus />添加字段</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
