type DesktopBridgeRecord = Record<string, any>

type KaDesktopBridge = {
  setStudioDrawerOpen?: (input: { open: boolean; width?: number }) => Promise<DesktopBridgeRecord>
  openProjectDirectory?: (input: { projectId: string; kind: "project" | "output" }) => Promise<unknown>
  openApiBatchSettings?: (input: {
    projectId: string
    baseUrl: string
    username: string
    password: string
    maxWorkers: number
    aspectRatio: string
    imageSize: string
  }) => Promise<DesktopBridgeRecord>
  loadApiCatalog?: (input: {
    projectId: string
    baseUrl: string
    username: string
    password: string
  }) => Promise<DesktopBridgeRecord>
  selectApiDirectory?: (input: { purpose: "source" | "output" }) => Promise<DesktopBridgeRecord>
  startApiBatch?: (input: {
    projectId: string
    baseUrl: string
    username: string
    password: string
    remoteProjectId: string
    modelId: string
    maxWorkers: number
    aspectRatio: string
    imageSize: string
    operation: "generate" | "directory_redraw"
    promptTemplates?: Record<string, string>
    sourceSelectionToken?: string
    outputSelectionToken?: string
    redrawPrompt?: string
  }) => Promise<DesktopBridgeRecord>
  prepareBuiltinImagegen?: (input: { projectId: string }) => Promise<unknown>
  authorizeCodex?: () => Promise<DesktopBridgeRecord>
  saveJsonFile?: (input: { suggestedName: string; jsonText: string }) => Promise<DesktopBridgeRecord>
  selectProject?: (input: { projectId: string; expectedRevision: number }) => Promise<unknown>
}

declare global {
  interface Window {
    kaDesktopBridge?: KaDesktopBridge
  }
}

export {}
