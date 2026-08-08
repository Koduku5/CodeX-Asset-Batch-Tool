import { LoaderCircle } from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
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

export type WorkbenchProjectDialogsStudio = {
  busyAction: string | null
  create: {
    open: boolean
    name: string
    setOpen: (open: boolean) => void
    setName: (name: string) => void
    submit: () => void
  }
  rename: {
    open: boolean
    name: string
    setOpen: (open: boolean) => void
    setName: (name: string) => void
    submit: () => void
  }
  remove: {
    open: boolean
    projectName: string
    projectIsIsolated: boolean
    projectHasRunningTask: boolean
    setOpen: (open: boolean) => void
    submit: () => void
  }
}

export function WorkbenchProjectDialogs({ studio }: { studio: WorkbenchProjectDialogsStudio }) {
  const { busyAction, create, rename, remove } = studio

  return (
    <>
      <Dialog open={create.open} onOpenChange={create.setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建独立项目</DialogTitle>
            <DialogDescription>软件会创建独立目录、Cache、输出、队列和锁。</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="new-project-name">项目名称</Label>
            <Input id="new-project-name" value={create.name} onChange={(event) => create.setName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && create.submit()} autoFocus />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => create.setOpen(false)}>取消</Button>
            <Button onClick={create.submit} disabled={!create.name.trim() || busyAction === "create-project"}>{busyAction === "create-project" && <LoaderCircle className="animate-spin" />}创建项目</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rename.open} onOpenChange={rename.setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名当前项目</DialogTitle>
            <DialogDescription>只修改项目显示名称，不改变项目唯一编号、目录、Cache、输出或队列位置。</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="rename-project-name">新的项目名称</Label>
            <Input
              id="rename-project-name"
              value={rename.name}
              onChange={(event) => rename.setName(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && rename.submit()}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => rename.setOpen(false)}>取消</Button>
            <Button onClick={rename.submit} disabled={!rename.name.trim() || busyAction === "rename-project"}>
              {busyAction === "rename-project" && <LoaderCircle className="animate-spin" />}
              确认重命名
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={remove.open} onOpenChange={remove.setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除项目“{remove.projectName}”？</AlertDialogTitle>
            <AlertDialogDescription>
              这会永久删除该项目的独立目录，以及其中的剧本、Cache、输出和队列。此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyAction === "delete-project"}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => { event.preventDefault(); remove.submit() }}
              disabled={!remove.projectIsIsolated || remove.projectHasRunningTask || busyAction === "delete-project"}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busyAction === "delete-project" && <LoaderCircle className="animate-spin" />}
              永久删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
