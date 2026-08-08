import * as React from "react"
import { PackageOpen } from "lucide-react"

import { cn } from "@/lib/utils"

export function StatusDot({ state }: { state?: string | null }) {
  const active = state === "active"
  const good = state === "complete"
  const warning = state === "warning" || state === "error"
  return (
    <span className="relative flex size-2.5 shrink-0" aria-hidden="true">
      <span className={cn(
        "relative inline-flex size-2.5 rounded-full bg-muted-foreground/45",
        active && "bg-info",
        good && "bg-success",
        warning && "bg-warning",
      )} />
    </span>
  )
}

export function SectionHeading({ title, description, action, titleClassName }: { title: string; description?: string; action?: React.ReactNode; titleClassName?: string }) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-4">
      <div className="min-w-0">
        <h3 className={cn("text-sm font-semibold tracking-tight", titleClassName)}>{title}</h3>
        {description && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  )
}

export function EmptyState({ icon: Icon = PackageOpen, children }: { icon?: React.ElementType; children: React.ReactNode }) {
  return (
    <div className="flex min-h-28 flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/25 px-5 py-6 text-center text-sm text-muted-foreground">
      <Icon className="size-5" aria-hidden="true" />
      <span>{children}</span>
    </div>
  )
}
