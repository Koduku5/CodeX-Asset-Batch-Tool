import {
  PROJECT_ID_PATTERN,
  PROJECT_WORKSPACE_SCHEMA_VERSION,
  ProjectWorkspaceError,
  STATE_KEYS,
  VIEW_KEYS,
  cloneDraft,
  deepFreeze,
  exactKeys,
  fail,
  isRecord,
  nonNegativeInteger,
  ownKeys,
  validateErrorDto,
  validateProjectDto,
  validateProjectId,
  validateProjectListDto,
  validateProjectListState,
  validateProjectSnapshotDto,
  validateWorkbenchSnapshot,
} from './project-workspace-contracts.mjs';

const defaultView = () => deepFreeze({
  snapshot: null,
  stale: true,
  error: null,
  batchDraft: null,
  requestSequence: 0,
  refreshing: false
});

const validateView = (value, label) => {
  exactKeys(value, VIEW_KEYS, [], label);
  if (typeof value.stale !== 'boolean' || typeof value.refreshing !== 'boolean') fail('INVALID_WORKSPACE_STATE', `${label} 状态无效`);
  return value;
};

const validateWorkspaceState = (state) => {
  exactKeys(state, STATE_KEYS, [], 'workspace state');
  if (state.schemaVersion !== PROJECT_WORKSPACE_SCHEMA_VERSION || !Array.isArray(state.projects) || !isRecord(state.views)) {
    fail('INVALID_WORKSPACE_STATE', 'workspace state 无效');
  }
  if (state.activeProjectId !== null) validateProjectId(state.activeProjectId, 'workspace.activeProjectId');
  nonNegativeInteger(state.selectionRevision, 'workspace.selectionRevision');
  validateProjectListState(state.projectList);
  for (const project of state.projects) {
    validateProjectId(project.projectId);
    validateView(state.views[project.projectId], `workspace.views.${project.projectId}`);
  }
  return state;
};

const makeState = ({ projects, activeProjectId, selectionRevision, views, projectList }) => deepFreeze({
  schemaVersion: PROJECT_WORKSPACE_SCHEMA_VERSION,
  projects: [...projects],
  activeProjectId,
  selectionRevision,
  views: { ...views },
  projectList: { ...projectList }
});

const resolveActiveId = (projects, candidate) => {
  if (typeof candidate === 'string' && PROJECT_ID_PATTERN.test(candidate) && projects.some(({ projectId }) => projectId === candidate)) {
    return candidate;
  }
  return projects[0]?.projectId ?? null;
};

export function createWorkspaceState({
  projects = [],
  activeProjectId = null,
  selectionRevision = 0
} = {}) {
  const validated = validateProjectListDto({ schemaVersion: PROJECT_WORKSPACE_SCHEMA_VERSION, projects }).projects;
  nonNegativeInteger(selectionRevision, 'selectionRevision');
  const active = resolveActiveId(validated, activeProjectId);
  const views = Object.fromEntries(validated.map(({ projectId }) => [projectId, defaultView()]));
  return makeState({
    projects: validated,
    activeProjectId: active,
    selectionRevision,
    views,
    projectList: { stale: false, error: null, revision: 0 }
  });
}

export function replaceProjects(state, projects) {
  validateWorkspaceState(state);
  const validated = validateProjectListDto({ schemaVersion: PROJECT_WORKSPACE_SCHEMA_VERSION, projects }).projects;
  const activeProjectId = resolveActiveId(validated, state.activeProjectId);
  const views = Object.fromEntries(validated.map(({ projectId }) => [projectId, state.views[projectId] ?? defaultView()]));
  return makeState({
    projects: validated,
    activeProjectId,
    selectionRevision: state.selectionRevision + (activeProjectId !== state.activeProjectId ? 1 : 0),
    views,
    projectList: { stale: false, error: null, revision: state.projectList.revision + 1 }
  });
}

export function failProjectListRequest(state, error) {
  validateWorkspaceState(state);
  const normalized = validateErrorDto(error instanceof ProjectWorkspaceError
    ? { code: error.code, message: error.message }
    : { code: 'PROJECT_LIST_UNAVAILABLE', message: error?.message || '项目列表不可用' }, 'project list error');
  return makeState({
    projects: state.projects,
    activeProjectId: state.activeProjectId,
    selectionRevision: state.selectionRevision,
    views: state.views,
    projectList: { ...state.projectList, stale: true, error: normalized }
  });
}

export function selectProject(state, projectId) {
  validateWorkspaceState(state);
  validateProjectId(projectId);
  const activeProjectId = resolveActiveId(state.projects, projectId);
  return makeState({
    projects: state.projects,
    activeProjectId,
    selectionRevision: state.selectionRevision + (activeProjectId !== state.activeProjectId ? 1 : 0),
    views: state.views,
    projectList: state.projectList
  });
}

export function updateProjectViewState(state, projectId, patch) {
  validateWorkspaceState(state);
  validateProjectId(projectId);
  if (!state.projects.some((project) => project.projectId === projectId)) fail('PROJECT_NOT_FOUND', `项目不存在：${projectId}`);
  const allowed = new Set(VIEW_KEYS);
  if (!isRecord(patch) || ownKeys(patch).some((key) => !allowed.has(key))) {
    fail('INVALID_VIEW_PATCH', '项目视图 patch 含有未知字段');
  }
  const current = state.views[projectId];
  const touchesRequest = Object.hasOwn(patch, 'snapshot') || Object.hasOwn(patch, 'error') || Object.hasOwn(patch, 'stale');
  const requestSequence = Object.hasOwn(patch, 'requestSequence')
    ? nonNegativeInteger(patch.requestSequence, 'requestSequence')
    : touchesRequest ? current.requestSequence + 1 : current.requestSequence;
  if (requestSequence < current.requestSequence) {
    return makeState({ projects: state.projects, activeProjectId: state.activeProjectId, selectionRevision: state.selectionRevision, views: state.views, projectList: state.projectList });
  }
  const next = {
    ...current,
    requestSequence,
    ...(Object.hasOwn(patch, 'snapshot') ? { snapshot: patch.snapshot === null ? null : validateWorkbenchSnapshot(patch.snapshot) } : {}),
    ...(Object.hasOwn(patch, 'stale') ? { stale: Boolean(patch.stale) } : {}),
    ...(Object.hasOwn(patch, 'error') ? { error: patch.error === null ? null : validateErrorDto(patch.error, 'view.error') } : {}),
    ...(Object.hasOwn(patch, 'batchDraft') ? { batchDraft: cloneDraft(patch.batchDraft) } : {}),
    ...(Object.hasOwn(patch, 'refreshing') ? { refreshing: Boolean(patch.refreshing) } : {})
  };
  if (Object.hasOwn(patch, 'snapshot') && patch.snapshot !== null) {
    if (!Object.hasOwn(patch, 'stale')) next.stale = false;
    if (!Object.hasOwn(patch, 'error')) next.error = null;
  }
  return makeState({
    projects: state.projects,
    activeProjectId: state.activeProjectId,
    selectionRevision: state.selectionRevision,
    views: { ...state.views, [projectId]: deepFreeze(next) },
    projectList: state.projectList
  });
}

export function beginProjectSnapshotRequest(state, projectId) {
  validateWorkspaceState(state);
  const current = state.views[validateProjectId(projectId)];
  if (!current) fail('PROJECT_NOT_FOUND', `项目不存在：${projectId}`);
  const requestSequence = current.requestSequence + 1;
  const nextState = updateProjectViewState(state, projectId, { requestSequence, refreshing: true });
  return deepFreeze({
    state: nextState,
    request: { projectId, requestSequence, selectionRevision: state.selectionRevision }
  });
}

const validateRequestToken = (request) => {
  exactKeys(request, ['projectId', 'requestSequence', 'selectionRevision'], [], 'snapshot request token');
  return {
    projectId: validateProjectId(request.projectId),
    requestSequence: nonNegativeInteger(request.requestSequence, 'requestSequence'),
    selectionRevision: nonNegativeInteger(request.selectionRevision, 'selectionRevision')
  };
};

export function completeProjectSnapshotRequest(state, request, result) {
  const token = validateRequestToken(request);
  const data = result?.project && result?.snapshot
    ? validateProjectSnapshotDto({ project: result.project, snapshot: result.snapshot })
    : fail('INVALID_RESPONSE', '项目快照结果无效');
  if (data.project.projectId !== token.projectId) fail('PROJECT_MISMATCH', '项目快照与请求项目不一致');
  return updateProjectViewState(state, token.projectId, {
    requestSequence: token.requestSequence,
    snapshot: data.snapshot,
    stale: false,
    error: null,
    refreshing: false
  });
}

export function failProjectSnapshotRequest(state, request, error) {
  const token = validateRequestToken(request);
  const normalized = error instanceof ProjectWorkspaceError
    ? { code: error.code, message: error.message }
    : { code: 'SNAPSHOT_UNAVAILABLE', message: error?.message || '项目快照不可用' };
  return updateProjectViewState(state, token.projectId, {
    requestSequence: token.requestSequence,
    stale: true,
    error: normalized,
    refreshing: false
  });
}

export function getActiveProject(state) {
  validateWorkspaceState(state);
  const project = state.projects.find(({ projectId }) => projectId === state.activeProjectId);
  return project ? deepFreeze({ ...project, view: state.views[project.projectId] }) : null;
}

const emptySummary = () => ({
  observedAt: null,
  phase: null,
  state: null,
  currentTaskLabel: null,
  progress: { mode: 'none', done: null, total: null },
  assetTotal: null,
  batch: { mode: null, backend: null, completed: null, total: null, failed: null },
  warningCount: null
});

const stageForPhase = (snapshot) => {
  const phase = snapshot.pipeline.phase;
  const mapped = phase === 'waiting-generation' || phase === 'complete' ? 'generation' : phase;
  return snapshot.pipeline.stages.find(({ id }) => id === mapped)
    ?? snapshot.pipeline.stages.find(({ state }) => state === 'active')
    ?? null;
};

export function summarizeProject(projectOrSnapshot) {
  if (projectOrSnapshot?.statusSummary !== undefined && projectOrSnapshot?.projectId) {
    return validateProjectDto(projectOrSnapshot).statusSummary ?? deepFreeze(emptySummary());
  }
  const candidate = projectOrSnapshot?.snapshot ?? projectOrSnapshot;
  if (candidate === null || candidate === undefined) return deepFreeze(emptySummary());
  const snapshot = validateWorkbenchSnapshot(candidate);
  const stage = stageForPhase(snapshot);
  const progress = stage?.progress ?? { mode: 'none' };
  const counts = snapshot.batch.counts;
  return deepFreeze({
    observedAt: snapshot.observedAt,
    phase: snapshot.pipeline.phase,
    state: snapshot.pipeline.state,
    currentTaskLabel: snapshot.pipeline.currentTask?.label ?? null,
    progress: {
      mode: progress.mode,
      done: progress.mode === 'determinate' ? progress.done : null,
      total: progress.mode === 'determinate' ? progress.total : null
    },
    assetTotal: snapshot.assetCounts.known ? snapshot.assetCounts.total : null,
    batch: {
      mode: snapshot.batch.mode,
      backend: snapshot.batch.backend,
      completed: counts.known ? counts.completed : null,
      total: counts.known ? counts.total : null,
      failed: counts.known ? counts.failed : null
    },
    warningCount: snapshot.warnings.length
  });
}

export function deriveProjectStatus(state, projectId) {
  validateWorkspaceState(state);
  const id = validateProjectId(projectId);
  const project = state.projects.find((candidate) => candidate.projectId === id);
  if (!project) fail('PROJECT_NOT_FOUND', `项目不存在：${id}`);
  const view = state.views[id];
  const useSnapshot = id === state.activeProjectId && view.snapshot !== null;
  return deepFreeze({
    summary: useSnapshot ? summarizeProject(view.snapshot) : project.statusSummary,
    stale: useSnapshot ? view.stale : state.projectList.stale,
    error: useSnapshot ? view.error : state.projectList.error,
    source: useSnapshot ? 'snapshot' : 'project-list'
  });
}

const generationEntries = (value) => {
  if (value?.schemaVersion === PROJECT_WORKSPACE_SCHEMA_VERSION && Array.isArray(value.projects) && isRecord(value.views)) {
    validateWorkspaceState(value);
    return value.projects.map((project) => {
      const status = deriveProjectStatus(value, project.projectId);
      return {
        projectId: project.projectId,
        displayName: project.displayName,
        availability: project.availability,
        stale: status.stale,
        error: status.error,
        summary: status.summary
      };
    });
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (item?.projectId && item?.statusSummary !== undefined) {
        const project = validateProjectDto(item, `projects[${index}]`);
        return { ...project, stale: false, error: null, summary: project.statusSummary };
      }
      return { projectId: null, displayName: null, availability: 'available', stale: false, error: null, summary: summarizeProject(item) };
    });
  }
  return [{ projectId: null, displayName: null, availability: 'available', stale: false, error: null, summary: summarizeProject(value) }];
};

export function deriveGenerationGate(value) {
  const entries = generationEntries(value);
  const listUnavailable = value?.schemaVersion === PROJECT_WORKSPACE_SCHEMA_VERSION
    && Array.isArray(value.projects)
    && isRecord(value.views)
    && (value.projectList.stale || value.projectList.error !== null);
  const active = entries.filter(({ summary }) => summary?.batch?.mode === 'active');
  const conflicts = entries.filter(({ summary }) => summary?.batch?.mode === 'warning' || summary?.batch?.backend === 'multiple');
  const unavailable = entries.filter(({ availability, stale, error, summary }) => availability === 'unavailable' || stale || error || !summary);
  let result;
  if (active.length > 1) {
    result = { state: 'active', code: 'CONCURRENT_GENERATION_ACTIVE', message: `${active.length} 个项目正在并行出图`, projectId: null, backend: 'multiple' };
  } else if (conflicts.length) {
    result = { state: 'error', code: 'GENERATION_STATE_CONFLICT', message: '出图通道状态冲突，需要先检查后台任务', projectId: conflicts[0].projectId, backend: conflicts[0].summary?.batch?.backend ?? null };
  } else if (active.length === 1) {
    const item = active[0];
    result = {
      state: 'active',
      code: 'GENERATION_ACTIVE',
      message: `${item.displayName || '当前项目'}正在出图`,
      projectId: item.projectId,
      backend: item.summary.batch.backend
    };
  } else if (listUnavailable) {
    result = { state: 'unknown', code: 'GENERATION_STATE_UNKNOWN', message: '项目列表状态已过期，无法确认并行任务状态', projectId: null, backend: null };
  } else if (!entries.length || unavailable.length === entries.length) {
    result = { state: 'unknown', code: 'GENERATION_STATE_UNKNOWN', message: '尚不能确认项目出图状态', projectId: null, backend: null };
  } else if (unavailable.length) {
    result = { state: 'warning', code: 'PROJECT_STATUS_INCOMPLETE', message: '部分项目状态不可用，并行任务统计可能不完整', projectId: unavailable[0].projectId, backend: null };
  } else {
    result = { state: 'idle', code: 'GENERATION_IDLE', message: '当前没有项目正在出图', projectId: null, backend: null };
  }
  return deepFreeze({ ...result, readOnly: true });
}
