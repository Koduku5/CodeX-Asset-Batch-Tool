import * as React from "react"
import { AlertTriangle, CheckCircle2, X } from "lucide-react"

import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ToastState } from "@/features/workbench/workbench-types"


export function useWorkbenchShell() {
  const { resolvedTheme, setTheme } = useTheme()
  const [motionMode, setMotionMode] = React.useState<"full" | "reduced">(() =>
    localStorage.getItem("ka-prompt-studio.motion") === "reduced" ? "reduced" : "full",
  )
  const [drawerOpen, setDrawerOpen] = React.useState(false)
  const [drawerMounted, setDrawerMounted] = React.useState(false)
  const [drawerTab, setDrawerTab] = React.useState("batch")
  const [toast, setToast] = React.useState<ToastState | null>(null)
  const toastSequence = React.useRef(0)
  const drawerPhase = React.useRef<"closed" | "opening" | "open" | "closing">("closed")
  const drawerReturnFocus = React.useRef<HTMLElement | null>(null)
  const batchStudioButtonRef = React.useRef<HTMLButtonElement>(null)

  const notify = React.useCallback((message: string, tone: ToastState["tone"] = "good") => {
    const id = ++toastSequence.current
    setToast({ id, message, tone })
    if (tone !== "error") {
      window.setTimeout(
        () => setToast((current) => current?.id === id ? null : current),
        tone === "warning" ? 6500 : 3600,
      )
    }
  }, [])

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      React.startTransition(() => setDrawerMounted(true))
    }, 350)
    return () => window.clearTimeout(timer)
  }, [])

  React.useEffect(() => {
    document.documentElement.dataset.motion = motionMode
    localStorage.setItem("ka-prompt-studio.motion", motionMode)
  }, [motionMode])

  const setStudioOpen = React.useCallback((open: boolean, tab = drawerTab) => {
    if (open && drawerPhase.current === "open") {
      setDrawerTab(tab)
      return
    }
    if (!open && drawerPhase.current === "closed") return

    drawerPhase.current = open ? "open" : "closed"
    if (open) {
      setDrawerTab(tab)
      drawerReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setDrawerMounted(true)
      setDrawerOpen(true)
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => document.getElementById("prompt-studio-drawer")?.focus())
      })
    } else {
      setDrawerOpen(false)
      const returnTarget = drawerReturnFocus.current?.isConnected
        ? drawerReturnFocus.current
        : batchStudioButtonRef.current
      window.requestAnimationFrame(() => returnTarget?.focus())
      drawerReturnFocus.current = null
    }
  }, [drawerTab])

  const closeStudio = React.useCallback(() => {
    setStudioOpen(false)
  }, [setStudioOpen])

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      const eventTarget = event.target instanceof HTMLElement ? event.target : null
      const editingText = Boolean(eventTarget?.closest('input, textarea, select, [contenteditable="true"]'))
      const nestedDialog = document.querySelector('[role="dialog"]:not(#prompt-studio-drawer), [role="alertdialog"]')
      if (!editingText && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "b") {
        event.preventDefault()
        setStudioOpen(!drawerOpen, "batch")
      }
      if (!editingText && (event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault()
        setStudioOpen(true, "routes")
      }
      if (event.key === "Tab" && drawerOpen && !nestedDialog) {
        const drawer = document.getElementById("prompt-studio-drawer")
        const focusable = drawer
          ? [...drawer.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
              .filter((element) => element.getClientRects().length > 0)
          : []
        if (!drawer || !focusable.length) {
          event.preventDefault()
          drawer?.focus()
        } else {
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          const active = document.activeElement
          if (!drawer.contains(active) || (event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
            event.preventDefault()
            ;(event.shiftKey ? last : first).focus()
          }
        }
      }
      if (event.key === "Escape" && drawerOpen && !nestedDialog) {
        setStudioOpen(false)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [drawerOpen, setStudioOpen])

  return {
    batchStudioButtonRef,
    closeStudio,
    drawerMounted,
    drawerOpen,
    drawerTab,
    motionMode,
    notify,
    resolvedTheme,
    setDrawerTab,
    setStudioOpen,
    setToast,
    toast,
    toggleMotion: () => setMotionMode((value) => value === "full" ? "reduced" : "full"),
    toggleTheme: () => setTheme(resolvedTheme === "dark" ? "light" : "dark"),
  }
}


export function WorkbenchToast({ toast, close }: { toast: ToastState | null; close: () => void }) {
  if (!toast) return null
  return (
    <div role={toast.tone === "error" ? "alert" : "status"} aria-live={toast.tone === "error" ? "assertive" : "polite"} className={cn(
      "fixed top-14 right-4 z-[80] flex w-[min(calc(100vw-2rem),520px)] items-start gap-3 rounded-xl border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-overlay animate-popover-in",
      toast.tone === "error" && "border-destructive/45",
      toast.tone === "warning" && "border-warning/45",
      toast.tone === "good" && "border-success/35",
    )}>
      {toast.tone === "good" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : <AlertTriangle className={cn("mt-0.5 size-4 shrink-0", toast.tone === "error" ? "text-destructive" : "text-warning")} />}
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{toast.tone === "error" ? "操作失败" : toast.tone === "warning" ? "请注意" : "操作完成"}</p>
        <p className="mt-0.5 break-words text-xs leading-relaxed text-muted-foreground">{toast.message}</p>
      </div>
      <Button variant="ghost" size="icon-sm" className="-mr-2 -mt-1" onClick={close} aria-label="关闭提示"><X /></Button>
    </div>
  )
}
