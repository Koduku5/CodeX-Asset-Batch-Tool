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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

type BatchBackendSelectorProps = {
  backend: string
  onBackendChange: (backend: string) => void
}

export function BatchBackendSelector({ backend, onBackendChange }: BatchBackendSelectorProps) {
  const [apiAccessDialogOpen, setApiAccessDialogOpen] = React.useState(false)
  const [apiAccessUsername, setApiAccessUsername] = React.useState("")
  const [apiAccessPassword, setApiAccessPassword] = React.useState("")
  const [apiAccessError, setApiAccessError] = React.useState("")

  const changeBackend = (nextBackend: string) => {
    if (nextBackend !== "api") return onBackendChange(nextBackend)
    setApiAccessUsername("")
    setApiAccessPassword("")
    setApiAccessError("")
    setApiAccessDialogOpen(true)
  }
  const confirmApiBackendAccess = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (apiAccessUsername.trim() !== "admin" || apiAccessPassword !== "123") {
      setApiAccessError("账号或密码错误，无法使用 Infinite Canvas API。")
      return
    }
    onBackendChange("api")
    setApiAccessPassword("")
    setApiAccessError("")
    setApiAccessDialogOpen(false)
  }

  return <>
    <div className="flex items-center gap-2"><Label className="shrink-0 whitespace-nowrap">出图后端</Label><Select value={backend} onValueChange={changeBackend}><SelectTrigger className="w-52"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="builtin">Codex 内置 ImageGen</SelectItem><SelectItem value="api">Infinite Canvas API</SelectItem></SelectContent></Select></div>
    <Dialog open={apiAccessDialogOpen} onOpenChange={(open) => { setApiAccessDialogOpen(open); if (!open) { setApiAccessPassword(""); setApiAccessError("") } }}>
      <DialogContent className="sm:max-w-sm">
        <form className="space-y-4" onSubmit={confirmApiBackendAccess}>
          <DialogHeader><DialogTitle>验证 Infinite Canvas API 使用权限</DialogTitle><DialogDescription>这是软件内的后端使用权限验证，不是 Infinite Canvas 服务账号。</DialogDescription></DialogHeader>
          <div className="space-y-2"><Label htmlFor="api-access-username">账号</Label><Input id="api-access-username" autoComplete="username" autoFocus value={apiAccessUsername} onChange={(event) => { setApiAccessUsername(event.target.value); setApiAccessError("") }} aria-invalid={Boolean(apiAccessError)} aria-describedby={apiAccessError ? "api-access-error" : undefined} /></div>
          <div className="space-y-2"><Label htmlFor="api-access-password">密码</Label><Input id="api-access-password" type="password" autoComplete="current-password" value={apiAccessPassword} onChange={(event) => { setApiAccessPassword(event.target.value); setApiAccessError("") }} aria-invalid={Boolean(apiAccessError)} aria-describedby={apiAccessError ? "api-access-error" : undefined} /></div>
          {apiAccessError && <p id="api-access-error" role="alert" className="text-xs text-destructive">{apiAccessError}</p>}
          <DialogFooter><Button type="button" variant="outline" onClick={() => setApiAccessDialogOpen(false)}>取消</Button><Button type="submit">验证并使用</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </>
}
