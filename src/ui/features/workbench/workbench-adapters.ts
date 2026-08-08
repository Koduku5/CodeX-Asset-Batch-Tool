import { BatchControlAdapter } from "@/services/batch-control-adapter.mjs"
import { CatalogResolverAdapter } from "@/services/catalog-adapter.mjs"
import { CodexAgentChatAdapter } from "@/services/codex-agent-chat-adapter.mjs"
import { CodexStatusAdapter } from "@/services/codex-status-adapter.mjs"
import { ImagegenHandoffAdapter } from "@/services/imagegen-handoff-adapter.mjs"
import { ProjectControlAdapter } from "@/services/project-control-adapter.mjs"
import { ProjectWorkspaceAdapter } from "@/services/project-workspace.mjs"
import { RouteClassifierAdapter, RouteModuleAdminAdapter } from "@/services/route-module-workbench.mjs"

export const workspaceAdapter = new ProjectWorkspaceAdapter()
export const controlAdapter = new ProjectControlAdapter()
export const codexStatusAdapter = new CodexStatusAdapter()
export const codexAgentChatAdapter = new CodexAgentChatAdapter()
export const batchAdapter = new BatchControlAdapter()
export const catalogAdapter = new CatalogResolverAdapter()
export const imagegenAdapter = new ImagegenHandoffAdapter()
export const routeAdminAdapter = new RouteModuleAdminAdapter()
export const routeClassifierAdapter = new RouteClassifierAdapter()
