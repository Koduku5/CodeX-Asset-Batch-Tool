import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  PROJECT_DIRECTORY_KINDS,
  ProjectWorkspaceAdapter,
  ProjectWorkspaceError,
  beginProjectSnapshotRequest,
  completeProjectSnapshotRequest,
  createWorkspaceState,
  deriveGenerationGate,
  deriveProjectStatus,
  failProjectListRequest,
  failProjectSnapshotRequest,
  getActiveProject,
  replaceProjects,
  selectProject,
  summarizeProject,
  updateProjectViewState,
  validateProjectListDto,
  validateWorkbenchSnapshot
} from '../src/ui/services/project-workspace.mjs';

const summary = ({
  observedAt = '2026-08-04T00:00:00.000Z',
  phase = 'waiting-generation',
  state = 'waiting',
  batchMode = 'idle',
  backend = 'none',
  completed = 0,
  total = 3,
  failed = 0
} = {}) => ({
  observedAt,
  phase,
  state,
  currentTaskLabel: batchMode === 'active' ? '角色 A' : null,
  progress: { mode: 'none', done: null, total: null },
  assetTotal: 5,
  batch: { mode: batchMode, backend, completed, total, failed },
  warningCount: 0
});

const project = (projectId, options = {}) => ({
  projectId,
  displayName: options.displayName ?? `项目 ${projectId}`,
  storageMode: options.storageMode ?? 'isolated-project',
  availability: options.availability ?? 'available',
  statusSummary: options.statusSummary === undefined ? summary() : options.statusSummary
});

const identity = ({ projectId, displayName, storageMode }) => ({ projectId, displayName, storageMode });

const task = (backend = 'builtin') => ({
  taskId: '角色:CHAR-001',
  label: 'CHAR-001 角色 A',
  scope: 'main',
  backend,
  startedAt: '2026-08-04T00:00:00.000Z',
  progress: { mode: 'indeterminate' },
  assetId: 'CHAR-001',
  assetName: '角色 A',
  sheetName: '角色',
  remoteStatus: null,
  queuePosition: null
});

const snapshot = ({ active = false, warning = false, observedAt = '2026-08-04T00:00:00.000Z', assetTotal = 5 } = {}) => {
  const activeTask = active ? task() : null;
  const batchActiveTask = activeTask === null
    ? null
    : Object.fromEntries(Object.entries(activeTask).filter(([key]) => key !== 'scope'));
  return {
    schemaVersion: 1,
    observedAt,
    pollAfterMs: 1000,
    pipeline: {
      phase: active ? 'generation' : 'waiting-generation',
      state: active ? 'active' : 'waiting',
      startedAt: null,
      elapsedSeconds: null,
      stages: [
        { id: 'split', label: '剧本切分', state: 'complete', progress: { mode: 'determinate', done: 2, total: 2 } },
        { id: 'analysis', label: '分析与累计', state: 'complete', progress: { mode: 'determinate', done: 2, total: 2 }, currentEpisode: null },
        { id: 'world-overview', label: '世界观总览', state: 'complete', progress: { mode: 'none' } },
        { id: 'asset-visual-specs', label: '资产设定', state: 'complete', progress: { mode: 'determinate', done: 5, total: 5 } },
        { id: 'excel', label: 'Excel 制表', state: 'complete', progress: { mode: 'none' } },
        { id: 'generation', label: '资产出图', state: active ? 'active' : 'waiting', progress: { mode: active ? 'indeterminate' : 'none' } }
      ],
      currentTask: activeTask
    },
    assetCounts: {
      known: true,
      total: assetTotal,
      byType: { characters: 1, creatures: 1, crowds: 1, scenes: 1, props: 1 },
      worldFacts: 2
    },
    screenplay: {
      known: true,
      state: 'ready',
      count: 1,
      files: ['测试剧本.txt'],
      filename: '测试剧本.txt',
      label: '测试剧本.txt',
      truncated: false
    },
    batch: {
      scope: 'main',
      operation: 'generate',
      mode: warning ? 'warning' : active ? 'active' : 'idle',
      integrity: 'status-only',
      counts: { known: true, total: 3, completed: active ? 1 : 0, active: active ? 1 : 0, retryable: 0, failed: 0, pending: active ? 1 : 3, finished: active ? 1 : 0 },
      activeTask: batchActiveTask,
      backend: warning ? 'multiple' : active ? 'builtin' : 'none',
      backendCounts: active ? { builtin: 3 } : {}
    },
    pending: { known: true, count: 0 },
    warnings: warning ? ['MULTIPLE_ACTIVE_BACKENDS'] : [],
    source: { mode: 'read-only-cache', lockPresent: active, files: {} }
  };
};

const envelope = (data) => ({ ok: true, data });
const response = (payload, ok = true) => ({ ok, json: async () => payload });

test('workspace falls back to the first valid project and every pure transition returns a new state', () => {
  const alpha = project('alpha');
  const beta = project('beta');
  const initial = createWorkspaceState({ projects: [alpha, beta], activeProjectId: '../stale', selectionRevision: 4 });
  assert.equal(initial.activeProjectId, 'alpha');
  assert.equal(initial.selectionRevision, 4);

  const selected = selectProject(initial, 'beta');
  assert.notEqual(selected, initial);
  assert.equal(selected.activeProjectId, 'beta');
  assert.equal(selected.selectionRevision, 5);
  assert.equal(getActiveProject(selected).projectId, 'beta');
  assert.equal(getActiveProject(selected).view.snapshot, null);

  const sameSelection = selectProject(selected, 'beta');
  assert.notEqual(sameSelection, selected);
  assert.equal(sameSelection.selectionRevision, 5);

  const missingSelection = selectProject(selected, 'missing');
  assert.equal(missingSelection.activeProjectId, 'alpha');
  assert.equal(missingSelection.selectionRevision, 6);
});

test('project views keep independent snapshot, stale, error, and session-only batch drafts across switches', () => {
  const initial = createWorkspaceState({ projects: [project('alpha'), project('beta')], activeProjectId: 'alpha' });
  const alphaDraft = { style: 'anime', categories: ['characters'] };
  const withAlpha = updateProjectViewState(initial, 'alpha', {
    snapshot: snapshot(),
    stale: false,
    error: null,
    batchDraft: alphaDraft,
    requestSequence: 1
  });
  alphaDraft.categories.push('props');
  const betaSelected = selectProject(withAlpha, 'beta');
  const withBeta = updateProjectViewState(betaSelected, 'beta', {
    snapshot: snapshot({ observedAt: '2026-08-04T00:00:01.000Z', assetTotal: 9 }),
    batchDraft: { style: 'cg' },
    requestSequence: 1
  });

  assert.equal(withBeta.activeProjectId, 'beta');
  assert.equal(withBeta.views.alpha.snapshot.assetCounts.total, 5);
  assert.deepEqual(withBeta.views.alpha.batchDraft.categories, ['characters']);
  assert.equal(withBeta.views.beta.snapshot.assetCounts.total, 9);
  assert.equal(withBeta.views.beta.batchDraft.style, 'cg');
  assert.equal(withBeta.views.alpha.error, null);
  assert.equal(withBeta.views.alpha.stale, false);
});

test('late responses stay with their requested project and an older sequence cannot replace a newer snapshot', () => {
  let state = createWorkspaceState({ projects: [project('alpha'), project('beta')], activeProjectId: 'alpha' });
  const alphaFirst = beginProjectSnapshotRequest(state, 'alpha');
  state = alphaFirst.state;
  const alphaSecond = beginProjectSnapshotRequest(state, 'alpha');
  state = selectProject(alphaSecond.state, 'beta');
  const betaRequest = beginProjectSnapshotRequest(state, 'beta');
  state = betaRequest.state;

  state = completeProjectSnapshotRequest(state, betaRequest.request, {
    project: identity(project('beta')),
    snapshot: snapshot({ observedAt: '2026-08-04T00:00:03.000Z', assetTotal: 9 })
  });
  state = completeProjectSnapshotRequest(state, alphaSecond.request, {
    project: identity(project('alpha')),
    snapshot: snapshot({ observedAt: '2026-08-04T00:00:02.000Z', assetTotal: 7 })
  });
  const afterNewer = state;
  state = completeProjectSnapshotRequest(state, alphaFirst.request, {
    project: identity(project('alpha')),
    snapshot: snapshot({ observedAt: '2026-08-04T00:00:01.000Z', assetTotal: 1 })
  });

  assert.equal(state.activeProjectId, 'beta');
  assert.equal(state.views.alpha.snapshot.assetCounts.total, 7);
  assert.equal(state.views.alpha.requestSequence, 2);
  assert.equal(state.views.beta.snapshot.assetCounts.total, 9);
  assert.deepEqual(state.views.alpha.snapshot, afterNewer.views.alpha.snapshot);
});

test('a stale failure cannot overwrite a newer success, while a current failure preserves the last snapshot', () => {
  let state = createWorkspaceState({ projects: [project('alpha')] });
  const first = beginProjectSnapshotRequest(state, 'alpha');
  const second = beginProjectSnapshotRequest(first.state, 'alpha');
  state = completeProjectSnapshotRequest(second.state, second.request, {
    project: identity(project('alpha')),
    snapshot: snapshot({ assetTotal: 8 })
  });
  state = failProjectSnapshotRequest(state, first.request, new Error('old failure'));
  assert.equal(state.views.alpha.error, null);
  assert.equal(state.views.alpha.stale, false);

  const third = beginProjectSnapshotRequest(state, 'alpha');
  state = failProjectSnapshotRequest(third.state, third.request, new ProjectWorkspaceError('OFFLINE', '暂时离线'));
  assert.equal(state.views.alpha.snapshot.assetCounts.total, 8);
  assert.deepEqual(state.views.alpha.error, { code: 'OFFLINE', message: '暂时离线' });
  assert.equal(state.views.alpha.stale, true);
  assert.equal(state.views.alpha.refreshing, false);
});

test('replacing projects preserves matching project state, drops removed views, and repairs an invalid active id', () => {
  let state = createWorkspaceState({ projects: [project('alpha'), project('beta')], activeProjectId: 'beta' });
  state = updateProjectViewState(state, 'beta', { snapshot: snapshot({ assetTotal: 8 }), batchDraft: { style: 'cg' }, requestSequence: 1 });
  const replaced = replaceProjects(state, [project('gamma'), project('beta', { displayName: '项目 B' })]);
  assert.equal(replaced.activeProjectId, 'beta');
  assert.equal(replaced.views.beta.snapshot.assetCounts.total, 8);
  assert.equal(Object.hasOwn(replaced.views, 'alpha'), false);
  assert.equal(replaced.projects.find(({ projectId }) => projectId === 'beta').displayName, '项目 B');

  const repaired = replaceProjects(replaced, [project('gamma')]);
  assert.equal(repaired.activeProjectId, 'gamma');
  assert.equal(repaired.selectionRevision, replaced.selectionRevision + 1);
});

test('card summaries are derived from redacted snapshots and concurrent project generation is reported', () => {
  const activeSnapshot = snapshot({ active: true });
  const card = summarizeProject(activeSnapshot);
  assert.deepEqual(card.progress, { mode: 'indeterminate', done: null, total: null });
  assert.equal(card.phase, 'generation');
  assert.equal(card.currentTaskLabel, 'CHAR-001 角色 A');
  assert.equal(card.assetTotal, 5);
  assert.deepEqual(card.batch, { mode: 'active', backend: 'builtin', completed: 1, total: 3, failed: 0 });

  let state = createWorkspaceState({
    projects: [
      project('alpha', { statusSummary: summary({ batchMode: 'active', backend: 'builtin' }) }),
      project('beta')
    ],
    activeProjectId: 'beta'
  });
  assert.equal(deriveGenerationGate(state).state, 'active', 'fresh validated list summaries cover projects without detail snapshots');
  state = updateProjectViewState(state, 'alpha', { snapshot: snapshot(), requestSequence: 1 });
  state = updateProjectViewState(state, 'beta', { snapshot: snapshot(), requestSequence: 1 });
  const busy = deriveGenerationGate(state);
  assert.deepEqual(busy, {
    state: 'active',
    code: 'GENERATION_ACTIVE',
    message: '项目 alpha正在出图',
    projectId: 'alpha',
    backend: 'builtin',
    readOnly: true
  });
  assert.equal(state.activeProjectId, 'beta', 'gate must not depend on the selected project');

  state = updateProjectViewState(state, 'beta', { snapshot: snapshot({ active: true }), requestSequence: 2 });
  assert.equal(deriveGenerationGate(state).code, 'CONCURRENT_GENERATION_ACTIVE');
  assert.equal(deriveGenerationGate(state).state, 'active');
  assert.equal(deriveGenerationGate(state).message, '2 个项目正在并行出图');
});

test('fresh list summaries replace dormant snapshots while the active project keeps its full snapshot', () => {
  let state = createWorkspaceState({ projects: [project('alpha'), project('beta')], activeProjectId: 'alpha' });
  state = updateProjectViewState(state, 'alpha', { snapshot: snapshot({ active: true }), requestSequence: 1 });
  state = updateProjectViewState(state, 'beta', { snapshot: snapshot({ active: true }), requestSequence: 1 });
  state = replaceProjects(state, [
    project('alpha', { statusSummary: summary({ observedAt: '2026-08-04T00:00:02.000Z' }) }),
    project('beta', { statusSummary: summary({ observedAt: '2026-08-04T00:00:02.000Z' }) })
  ]);

  assert.equal(deriveProjectStatus(state, 'alpha').source, 'snapshot');
  assert.equal(deriveProjectStatus(state, 'alpha').summary.batch.mode, 'active');
  assert.equal(deriveProjectStatus(state, 'beta').source, 'project-list');
  assert.equal(deriveProjectStatus(state, 'beta').summary.batch.mode, 'idle');
  assert.equal(deriveGenerationGate(state).projectId, 'alpha');
});

test('a failed list refresh preserves projects but marks their list status stale until the next success', () => {
  let state = createWorkspaceState({ projects: [project('alpha')] });
  state = replaceProjects(state, [project('alpha')]);
  const preserved = state.projects;
  state = failProjectListRequest(state, new ProjectWorkspaceError('OFFLINE', '项目列表暂时离线'));

  assert.deepEqual(state.projects, preserved);
  assert.deepEqual(state.projectList, { stale: true, error: { code: 'OFFLINE', message: '项目列表暂时离线' }, revision: 1 });
  assert.equal(deriveProjectStatus(state, 'alpha').stale, true);
  assert.equal(deriveGenerationGate(state).state, 'unknown');

  state = replaceProjects(state, [project('alpha')]);
  assert.deepEqual(state.projectList, { stale: false, error: null, revision: 2 });
});

test('real active batch shape may omit scope while pipeline.currentTask still requires it', () => {
  const active = snapshot({ active: true });
  assert.equal(Object.hasOwn(active.batch.activeTask, 'scope'), false);
  const validated = validateWorkbenchSnapshot(active);
  assert.equal(validated.batch.activeTask.scope, 'main');
  assert.equal(validated.pipeline.currentTask.scope, 'main');

  const invalidPipelineTask = structuredClone(active);
  delete invalidPipelineTask.pipeline.currentTask.scope;
  assert.throws(() => validateWorkbenchSnapshot(invalidPipelineTask), { code: 'INVALID_RESPONSE' });
});

test('screenplay snapshot exposes only bounded safe source names and rejects inconsistent metadata', () => {
  const validated = validateWorkbenchSnapshot(snapshot());
  assert.deepEqual(validated.screenplay, {
    known: true,
    state: 'ready',
    count: 1,
    files: ['测试剧本.txt'],
    filename: '测试剧本.txt',
    label: '测试剧本.txt',
    truncated: false
  });

  const unsafe = structuredClone(snapshot());
  unsafe.screenplay.files = ['../越界剧本.txt'];
  unsafe.screenplay.filename = '../越界剧本.txt';
  assert.throws(() => validateWorkbenchSnapshot(unsafe), { code: 'INVALID_RESPONSE' });

  const mismatched = structuredClone(snapshot());
  mismatched.screenplay.count = 2;
  assert.throws(() => validateWorkbenchSnapshot(mismatched), { code: 'INVALID_RESPONSE' });
});

test('bridge methods take priority and all adapter results are validated envelopes', async () => {
  const alpha = project('alpha');
  const calls = [];
  const bridge = {
    listProjects: async () => { calls.push(['list']); return envelope({ schemaVersion: 1, projects: [alpha] }); },
    getWorkbenchSnapshot: async (request) => { calls.push(['snapshot', request]); return envelope({ project: identity(alpha), snapshot: snapshot({ active: true }) }); },
    selectProject: async (request) => { calls.push(['select', request]); return envelope({ projectId: request.projectId, selectionRevision: request.expectedRevision + 1 }); },
    openProjectDirectory: async (request) => { calls.push(['open', request]); return envelope({ ...request, opened: true }); }
  };
  const adapter = new ProjectWorkspaceAdapter({ bridge, fetchImpl: async () => { throw new Error('HTTP must not be used'); } });

  assert.equal((await adapter.listProjects()).source, 'desktop-bridge');
  const activeResult = await adapter.getSnapshot({ projectId: 'alpha', selectionRevision: 3 });
  assert.equal(activeResult.snapshot.assetCounts.total, 5);
  assert.equal(activeResult.snapshot.batch.activeTask.scope, 'main');
  assert.deepEqual(await adapter.selectProject({ projectId: 'alpha', expectedRevision: 3 }), {
    projectId: 'alpha', selectionRevision: 4, source: 'desktop-bridge'
  });
  assert.deepEqual(await adapter.openProjectDirectory({ projectId: 'alpha', kind: 'output' }), {
    projectId: 'alpha', kind: 'output', opened: true, source: 'desktop-bridge'
  });
  assert.deepEqual(calls, [
    ['list'],
    ['snapshot', { projectId: 'alpha', selectionRevision: 3 }],
    ['select', { projectId: 'alpha', expectedRevision: 3 }],
    ['open', { projectId: 'alpha', kind: 'output' }]
  ]);
});

test('HTTP fallback only performs the two documented GET requests and never emulates writes or directory access', async () => {
  const alpha = project('alpha');
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, options]);
    if (url === 'http://127.0.0.1:4174/api/projects') return response(envelope({ schemaVersion: 1, projects: [alpha] }));
    if (url === 'http://127.0.0.1:4174/api/projects/alpha/workbench/snapshot') {
      return response(envelope({ project: identity(alpha), snapshot: snapshot() }));
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  const adapter = new ProjectWorkspaceAdapter({ bridge: null, fetchImpl, baseUrl: 'http://127.0.0.1:4174/' });
  assert.equal((await adapter.listProjects()).source, 'http');
  assert.equal((await adapter.getSnapshot({ projectId: 'alpha' })).source, 'http');
  await assert.rejects(adapter.selectProject({ projectId: 'alpha', expectedRevision: 0 }), { code: 'CAPABILITY_UNAVAILABLE' });
  await assert.rejects(adapter.openProjectDirectory({ projectId: 'alpha', kind: 'project' }), { code: 'CAPABILITY_UNAVAILABLE' });
  assert.equal(calls.length, 2);
  for (const [, options] of calls) {
    assert.equal(options.method, 'GET');
    assert.deepEqual(options.headers, { accept: 'application/json' });
    assert.equal(Object.hasOwn(options, 'body'), false);
  }
});

test('IDs, DTOs, envelopes, project binding, revision results, and directory kinds reject invalid input', async () => {
  const alpha = project('alpha');
  assert.throws(() => validateProjectListDto({ schemaVersion: 1, projects: [{ ...alpha, rootPath: 'D:/secret' }] }), { code: 'INVALID_RESPONSE' });
  assert.throws(() => validateProjectListDto({ schemaVersion: 1, projects: [project('../escape')] }), { code: 'INVALID_PROJECT_ID' });
  assert.throws(() => validateProjectListDto({ schemaVersion: 1, projects: [project('offline', { availability: 'unavailable', statusSummary: null })] }), { code: 'INVALID_RESPONSE' });
  assert.throws(() => validateProjectListDto({ schemaVersion: 1, projects: [project('alpha', { statusSummary: { ...summary(), phase: 'invented' } })] }), { code: 'INVALID_RESPONSE' });
  assert.throws(() => validateWorkbenchSnapshot({ ...snapshot(), prompt: 'never expose this' }), { code: 'INVALID_RESPONSE' });

  const badEnvelope = new ProjectWorkspaceAdapter({
    bridge: { listProjects: async () => ({ ok: true, data: { schemaVersion: 1, projects: [alpha] }, extra: true }) }
  });
  await assert.rejects(badEnvelope.listProjects(), { code: 'INVALID_RESPONSE' });

  const mismatch = new ProjectWorkspaceAdapter({
    bridge: { getWorkbenchSnapshot: async () => envelope({ project: identity(project('beta')), snapshot: snapshot() }) }
  });
  await assert.rejects(mismatch.getSnapshot({ projectId: 'alpha' }), { code: 'PROJECT_MISMATCH' });

  const badRevision = new ProjectWorkspaceAdapter({
    bridge: { selectProject: async () => envelope({ projectId: 'alpha', selectionRevision: 9 }) }
  });
  await assert.rejects(badRevision.selectProject({ projectId: 'alpha', expectedRevision: 2 }), { code: 'INVALID_RESPONSE' });

  const opener = new ProjectWorkspaceAdapter({ bridge: { openProjectDirectory: async () => envelope({}) } });
  assert.deepEqual(PROJECT_DIRECTORY_KINDS, ['project', 'output']);
  await assert.rejects(opener.openProjectDirectory({ projectId: 'alpha', kind: 'cache' }), { code: 'INVALID_DIRECTORY_KIND' });

  let fetched = false;
  const safeHttp = new ProjectWorkspaceAdapter({ bridge: null, fetchImpl: async () => { fetched = true; return response(envelope({})); } });
  await assert.rejects(safeHttp.getSnapshot({ projectId: '../escape' }), { code: 'INVALID_PROJECT_ID' });
  assert.equal(fetched, false);
});

test('the workspace module has no persistence, queue, prompt, credential, path, or object-URL storage channel', async () => {
  const modulePaths = [
    '../src/ui/services/project-workspace.mjs',
    '../src/ui/services/project-workspace-contracts.mjs',
    '../src/ui/services/project-workspace-state.mjs',
    '../src/ui/services/project-workspace-adapter.mjs',
  ];
  const source = (await Promise.all(
    modulePaths.map((modulePath) => readFile(new URL(modulePath, import.meta.url), 'utf8')),
  )).join('\n');
  for (const forbidden of ['localStorage', 'sessionStorage', 'createObjectURL', 'revokeObjectURL', 'writeFile', 'queuePath', 'credential', 'apiToken']) {
    assert.equal(source.includes(forbidden), false, `unexpected persistence capability: ${forbidden}`);
  }
});
