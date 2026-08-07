import * as React from "react"
import { ImagePlus } from "lucide-react"

import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { SectionHeading } from "@/features/workbench/workbench-foundation"

type ValidationImageDropzoneProps = {
  image: { url: string; name: string } | null
  status: string
  onReceive: (file: File) => void
}

export function ValidationImageDropzone({ image, status, onReceive }: ValidationImageDropzoneProps) {
  const inputRef = React.useRef<HTMLInputElement>(null)

  return (
    <Card>
      <CardHeader className="pb-3"><SectionHeading title="图片返回窗口" description={status} /></CardHeader>
      <CardContent>
        <input ref={inputRef} type="file" accept="image/*" className="sr-only" aria-label="上传单项测试参考图" onChange={(event) => event.target.files?.[0] && onReceive(event.target.files[0])} />
        <button type="button" onClick={() => inputRef.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files?.[0]; if (file) onReceive(file) }} className="grid aspect-square min-h-64 w-full place-items-center overflow-hidden rounded-xl border border-dashed bg-muted/15 text-muted-foreground transition-colors hover:border-primary/45 hover:bg-primary/5">
          {image ? <img src={image.url} alt={image.name} className="size-full object-contain" /> : <span className="px-5 text-center text-xs"><ImagePlus className="mx-auto mb-2 size-6" />生成后将图片拖到这里，或点击选择返回图片</span>}
        </button>
      </CardContent>
    </Card>
  )
}
