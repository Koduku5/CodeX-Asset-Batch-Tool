import * as React from "react"
import { Download, Plus } from "lucide-react"

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
import type { JsonRecord, PendingRouteImport, RouteModule } from "@/features/workbench/workbench-foundation"

export type RouteDialogStudio = {
  applyImportedArtifacts: (incoming: PendingRouteImport) => void
  catalogStatus: JsonRecord | null
  createPreset: () => void
  deleteBranch: () => Promise<void>
  deleteBranchOpen: boolean
  deletePreset: () => void
  deletePresetId: string | null
  exportOpen: boolean
  exportPreset: () => Promise<void>
  exportValue: string
  module: RouteModule | null
  newPresetOpen: boolean
  newPresetValue: string
  pendingImport: PendingRouteImport | null
  renameOpen: boolean
  renamePreset: () => void
  renameValue: string
  setDeleteBranchOpen: React.Dispatch<React.SetStateAction<boolean>>
  setDeletePresetId: React.Dispatch<React.SetStateAction<string | null>>
  setExportOpen: React.Dispatch<React.SetStateAction<boolean>>
  setExportValue: React.Dispatch<React.SetStateAction<string>>
  setNewPresetOpen: React.Dispatch<React.SetStateAction<boolean>>
  setNewPresetValue: React.Dispatch<React.SetStateAction<string>>
  setPendingImport: React.Dispatch<React.SetStateAction<PendingRouteImport | null>>
  setRenameOpen: React.Dispatch<React.SetStateAction<boolean>>
  setRenameValue: React.Dispatch<React.SetStateAction<string>>
}

export function RouteStudioDialogs({ studio }: { studio: RouteDialogStudio }) {
  const {
    applyImportedArtifacts, catalogStatus, createPreset, deleteBranch, deleteBranchOpen, deletePreset,
    deletePresetId, exportOpen, exportPreset, exportValue, module, newPresetOpen, newPresetValue,
    pendingImport, renameOpen, renamePreset, renameValue, setDeleteBranchOpen, setDeletePresetId,
    setExportOpen, setExportValue, setNewPresetOpen, setNewPresetValue, setPendingImport,
    setRenameOpen, setRenameValue,
  } = studio
  const formalBranch = (catalogStatus?.catalogSummary?.conditionModules ?? []).some((entry: RouteModule) => entry.id === module?.id)

  return <>
    <AlertDialog open={Boolean(deletePresetId)} onOpenChange={(open) => !open && setDeletePresetId(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>删除这个预设？</AlertDialogTitle><AlertDialogDescription>只删除本机 Prompt Studio 中的预设卡片，不会删除正式注册表里的分支。此操作无法撤销。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={deletePreset}>删除预设</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <AlertDialog open={Boolean(pendingImport)} onOpenChange={(open) => !open && setPendingImport(null)}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>发现同一{pendingImport?.mode === "preset" ? "预设" : "分支"}的不同版本</AlertDialogTitle><AlertDialogDescription>新增 {pendingImport?.newNames.length ?? 0} 项，相同并跳过 {pendingImport?.sameNames.length ?? 0} 项，冲突 {pendingImport?.conflictNames.length ?? 0} 项：{pendingImport?.conflictNames.join("、")}。确认后，冲突项会采用所选文件中靠后的版本并覆盖本机版本；取消则整批不写入。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消导入</AlertDialogCancel><AlertDialogAction onClick={() => pendingImport && applyImportedArtifacts(pendingImport)}>确认覆盖并导入</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <AlertDialog open={deleteBranchOpen} onOpenChange={setDeleteBranchOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>删除“{module?.displayName}”？</AlertDialogTitle><AlertDialogDescription>{formalBranch ? "这是已写入正式注册表的分支，确认后会从正式提示词库删除。" : "这只会删除当前预设中的分支草稿。"}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => void deleteBranch()}>确认删除</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <Dialog open={newPresetOpen} onOpenChange={setNewPresetOpen}><DialogContent><DialogHeader><DialogTitle>新建预设</DialogTitle><DialogDescription>创建一张独立的空预设卡；它拥有自己的基础提示词草稿和路由分支，不会修改当前预设。</DialogDescription></DialogHeader><div className="space-y-2"><Label htmlFor="new-preset">预设名称</Label><Input id="new-preset" autoFocus value={newPresetValue} onChange={(event) => setNewPresetValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") createPreset() }} placeholder="例如：CG 场景测试组 A" /></div><DialogFooter><Button variant="outline" onClick={() => setNewPresetOpen(false)}>取消</Button><Button onClick={createPreset} disabled={!newPresetValue.trim()}><Plus />创建预设</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={renameOpen} onOpenChange={setRenameOpen}><DialogContent><DialogHeader><DialogTitle>重命名当前预设</DialogTitle><DialogDescription>名称只用于团队识别，预设和分支的稳定编号不会改变。</DialogDescription></DialogHeader><div className="space-y-2"><Label htmlFor="rename-preset">预设名称</Label><Input id="rename-preset" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} /></div><DialogFooter><Button variant="outline" onClick={() => setRenameOpen(false)}>取消</Button><Button onClick={renamePreset}>保存名称</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={exportOpen} onOpenChange={setExportOpen}><DialogContent><DialogHeader><DialogTitle>导出当前预设</DialogTitle><DialogDescription>打包当前卡片的基础提示词、全部路由分支、判断条件、修改内容和测试样例，交给其他成员导入使用。</DialogDescription></DialogHeader><div className="space-y-2"><Label htmlFor="export-preset">导出名称</Label><Input id="export-preset" value={exportValue} onChange={(event) => setExportValue(event.target.value)} /></div><DialogFooter><Button variant="outline" onClick={() => setExportOpen(false)}>取消</Button><Button onClick={() => void exportPreset()}><Download />导出文件</Button></DialogFooter></DialogContent></Dialog>
  </>
}
