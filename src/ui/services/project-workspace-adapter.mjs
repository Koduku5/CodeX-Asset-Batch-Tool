import {
  DIRECTORY_KINDS,
  PROJECT_DIRECTORY_KINDS,
  ProjectWorkspaceError,
  deepFreeze,
  exactKeys,
  fail,
  nonNegativeInteger,
  unwrapEnvelope,
  validateProjectId,
  validateProjectListDto,
  validateProjectSnapshotDto,
} from './project-workspace-contracts.mjs';

const defaultBridge = () => globalThis.window?.kaDesktopBridge ?? globalThis.kaDesktopBridge;

const normalizeBaseUrl = (value) => {
  if (typeof value !== 'string' || /[\r\n]/u.test(value)) throw new TypeError('baseUrl must be a string without control characters');
  return value.replace(/\/+$/u, '');
};

const validateSelectionInput = (value) => {
  exactKeys(value, ['projectId', 'expectedRevision'], [], 'selectProject input');
  return {
    projectId: validateProjectId(value.projectId),
    expectedRevision: nonNegativeInteger(value.expectedRevision, 'expectedRevision')
  };
};

const validateSelectionResult = (value, request) => {
  exactKeys(value, ['projectId', 'selectionRevision'], [], 'selectProject result');
  const result = {
    projectId: validateProjectId(value.projectId),
    selectionRevision: nonNegativeInteger(value.selectionRevision, 'selectionRevision')
  };
  if (result.projectId !== request.projectId || result.selectionRevision !== request.expectedRevision + 1) {
    fail('INVALID_RESPONSE', 'selectProject 返回的项目或版本不匹配');
  }
  return deepFreeze(result);
};

const validateOpenInput = (value) => {
  exactKeys(value, ['projectId', 'kind'], [], 'openProjectDirectory input');
  const projectId = validateProjectId(value.projectId);
  if (!DIRECTORY_KINDS.has(value.kind)) fail('INVALID_DIRECTORY_KIND', `kind 只允许：${PROJECT_DIRECTORY_KINDS.join(', ')}`);
  return { projectId, kind: value.kind };
};

const validateOpenResult = (value, request) => {
  exactKeys(value, ['projectId', 'kind', 'opened'], [], 'openProjectDirectory result');
  if (typeof value.opened !== 'boolean' || value.projectId !== request.projectId || value.kind !== request.kind) {
    fail('INVALID_RESPONSE', 'openProjectDirectory 返回的项目或目录类型不匹配');
  }
  return deepFreeze({ projectId: validateProjectId(value.projectId), kind: value.kind, opened: value.opened });
};

const asTransportError = (error, fallbackCode, fallbackMessage) => error instanceof ProjectWorkspaceError
  ? error
  : new ProjectWorkspaceError(fallbackCode, error?.message || fallbackMessage, error);

export class ProjectWorkspaceAdapter {
  constructor({
    bridge = defaultBridge(),
    fetchImpl = globalThis.fetch?.bind(globalThis),
    baseUrl = ''
  } = {}) {
    this.bridge = bridge;
    this.fetchImpl = fetchImpl;
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  async listProjects() {
    try {
      if (typeof this.bridge?.listProjects === 'function') {
        const data = unwrapEnvelope(await this.bridge.listProjects(), validateProjectListDto, 'listProjects');
        return deepFreeze({ ...data, source: 'desktop-bridge' });
      }
      const data = await this.getJson('/api/projects', validateProjectListDto, 'listProjects');
      return deepFreeze({ ...data, source: 'http' });
    } catch (error) {
      throw asTransportError(error, 'PROJECT_LIST_UNAVAILABLE', '项目列表不可用');
    }
  }

  async getSnapshot(input) {
    exactKeys(input, ['projectId'], ['selectionRevision'], 'getSnapshot input');
    const projectId = validateProjectId(input.projectId);
    const selectionRevision = Object.hasOwn(input, 'selectionRevision')
      ? nonNegativeInteger(input.selectionRevision, 'selectionRevision')
      : undefined;
    try {
      if (typeof this.bridge?.getWorkbenchSnapshot === 'function') {
        const request = { projectId, ...(selectionRevision !== undefined ? { selectionRevision } : {}) };
        const data = unwrapEnvelope(
          await this.bridge.getWorkbenchSnapshot(request),
          validateProjectSnapshotDto,
          'getWorkbenchSnapshot'
        );
        if (data.project.projectId !== projectId) fail('PROJECT_MISMATCH', '快照项目与请求项目不一致');
        return deepFreeze({ ...data, source: 'desktop-bridge' });
      }
      const data = await this.getJson(
        `/api/projects/${encodeURIComponent(projectId)}/workbench/snapshot`,
        validateProjectSnapshotDto,
        'getWorkbenchSnapshot'
      );
      if (data.project.projectId !== projectId) fail('PROJECT_MISMATCH', '快照项目与请求项目不一致');
      return deepFreeze({ ...data, source: 'http' });
    } catch (error) {
      throw asTransportError(error, 'SNAPSHOT_UNAVAILABLE', '项目快照不可用');
    }
  }

  async selectProject(input) {
    const request = validateSelectionInput(input);
    if (typeof this.bridge?.selectProject !== 'function') {
      fail('CAPABILITY_UNAVAILABLE', '当前只读 HTTP 模式不支持写入项目选择');
    }
    try {
      const data = unwrapEnvelope(
        await this.bridge.selectProject(request),
        (value) => validateSelectionResult(value, request),
        'selectProject'
      );
      return deepFreeze({ ...data, source: 'desktop-bridge' });
    } catch (error) {
      throw asTransportError(error, 'PROJECT_SELECTION_FAILED', '项目选择失败');
    }
  }

  async openProjectDirectory(input) {
    const request = validateOpenInput(input);
    if (typeof this.bridge?.openProjectDirectory !== 'function') {
      fail('CAPABILITY_UNAVAILABLE', '当前只读 HTTP 模式不支持打开本地目录');
    }
    try {
      const data = unwrapEnvelope(
        await this.bridge.openProjectDirectory(request),
        (value) => validateOpenResult(value, request),
        'openProjectDirectory'
      );
      return deepFreeze({ ...data, source: 'desktop-bridge' });
    } catch (error) {
      throw asTransportError(error, 'OPEN_DIRECTORY_FAILED', '打开目录失败');
    }
  }

  async getJson(pathname, validator, label) {
    if (typeof this.fetchImpl !== 'function') fail('CAPABILITY_UNAVAILABLE', '桌面 bridge 与只读 HTTP 均不可用');
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method: 'GET',
        headers: { accept: 'application/json' }
      });
    } catch (error) {
      fail('NETWORK_ERROR', `${label} 请求失败`, error);
    }
    if (!response || typeof response.ok !== 'boolean' || typeof response.json !== 'function') {
      fail('INVALID_RESPONSE', `${label} HTTP 响应无效`);
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      fail('INVALID_RESPONSE', `${label} 未返回有效 JSON`, error);
    }
    if (!response.ok && payload?.ok === true) fail('INVALID_ENVELOPE', `${label} 的 HTTP 状态与信封冲突`);
    return unwrapEnvelope(payload, validator, label);
  }
}
