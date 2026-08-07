import { lstat, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export const WORKBENCH_SNAPSHOT_SCHEMA_VERSION = 1;
const POLL_AFTER_MS = 1000;
const RETRIES = 3;
const RETRY_DELAY_MS = 20;
const MAX_SCREENPLAY_FILES = 256;
const RECORD_TYPES = Object.freeze([
  ['characters', '角色记录.json'], ['creatures', '生物记录.json'], ['crowds', '群演记录.json'],
  ['scenes', '场景记录.json'], ['props', '道具记录.json']
]);
const FILES = {
  screenplays: '剧本',
  reading: 'cache/阅读进度.json',
  pending: 'cache/待确认记录.json',
  worldPagination: 'cache/世界观分页进度.json',
  worldOverview: 'cache/世界观总览.json',
  visualSpecsProgress: 'cache/视觉规格回填进度.json',
  workbook: '输出/剧本资产制表.xlsx',
  mainQueue: 'cache/出图队列.json',
  mainProgress: 'cache/出图进度.json',
  redrawQueue: 'cache/批量重绘/队列.json',
  redrawProgress: 'cache/批量重绘/进度.json',
  lock: 'cache/.pipeline.lock',
  worldRecords: 'cache/累计记录/世界观记录.json',
  originals: 'cache/单集原文',
  analyses: 'cache/单集分析'
};
for (const [key, filename] of RECORD_TYPES) FILES[`record_${key}`] = `cache/累计记录/${filename}`;
Object.freeze(FILES);

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const cleanText = (value, maxLength = 160) => typeof value === 'string'
  ? value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, maxLength) : '';
const safeTime = (value) => Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;

/**
 * Builds a read-only, redacted snapshot from the package's fixed progress files.
 * It intentionally has no filesystem mutation, queue, lock, or retry controls.
 */
export function createWorkbenchSnapshotReader(root, {
  now = () => new Date(),
  retryDelayMs = RETRY_DELAY_MS,
  pollAfterMs = POLL_AFTER_MS
} = {}) {
  const rootPath = resolve(root);
  const jsonCache = new Map();
  const directoryCache = new Map();
  const screenplayCache = new Map();

  const absolute = (key) => {
    const candidate = resolve(rootPath, FILES[key]);
    const rel = relative(rootPath, candidate);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`固定来源越界：${key}`);
    return candidate;
  };

  const sourceEntry = async (key, warnings) => {
    try {
      const info = await lstat(absolute(key));
      if (info.isSymbolicLink()) {
        warnings.push(`SOURCE_LINK_REJECTED:${key}`);
        return { state: 'rejected', mtimeMs: null, size: 0 };
      }
      return { state: info.isFile() ? 'present' : info.isDirectory() ? 'directory' : 'rejected', mtimeMs: info.mtimeMs, size: info.size };
    } catch (error) {
      if (error?.code === 'ENOENT') return { state: 'missing', mtimeMs: null, size: 0 };
      warnings.push(`SOURCE_UNREADABLE:${key}`);
      return { state: 'unreadable', mtimeMs: null, size: 0 };
    }
  };

  const readJson = async (key, warnings) => {
    const source = await sourceEntry(key, warnings);
    if (source.state !== 'present') return { value: null, source };
    const cached = jsonCache.get(key);
    if (cached && cached.mtimeMs === source.mtimeMs && cached.size === source.size) return { value: cached.value, source };
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      try {
        const value = JSON.parse(await readFile(absolute(key), 'utf8'));
        jsonCache.set(key, { mtimeMs: source.mtimeMs, size: source.size, value });
        return { value, source };
      } catch (error) {
        if (attempt + 1 < RETRIES) await delay(retryDelayMs);
      }
    }
    warnings.push(`SOURCE_INVALID_JSON:${key}`);
    return { value: null, source: { ...source, state: 'invalid' } };
  };

  const countDirectoryFiles = async (key, warnings) => {
    const source = await sourceEntry(key, warnings);
    if (source.state === 'missing') return { count: 0, known: true, source };
    if (source.state !== 'directory') return { count: null, known: false, source };
    const cached = directoryCache.get(key);
    if (cached && cached.mtimeMs === source.mtimeMs) return { count: cached.count, known: true, source };
    try {
      const entries = await readdir(absolute(key), { withFileTypes: true });
      const unsafe = entries.some((entry) => entry.isSymbolicLink());
      if (unsafe) {
        warnings.push(`SOURCE_LINK_REJECTED:${key}`);
        return { count: null, known: false, source: { ...source, state: 'rejected' } };
      }
      const count = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json')).length;
      directoryCache.set(key, { mtimeMs: source.mtimeMs, count });
      return { count, known: true, source };
    } catch {
      warnings.push(`SOURCE_UNREADABLE:${key}`);
      return { count: null, known: false, source: { ...source, state: 'unreadable' } };
    }
  };

  const readScreenplays = async (warnings, preferredSources = []) => {
    const source = await sourceEntry('screenplays', warnings);
    const unavailable = (state, label, observedSource = source) => ({
      known: state === 'empty',
      state,
      count: state === 'empty' ? 0 : null,
      files: [],
      filename: null,
      label,
      truncated: false,
      source: observedSource
    });
    if (source.state === 'missing') return unavailable('empty', '尚未导入剧本');
    if (source.state !== 'directory') return unavailable('unavailable', '剧本来源不可用');

    let names;
    const cached = screenplayCache.get('screenplays');
    if (cached && cached.mtimeMs === source.mtimeMs) {
      names = cached.names;
      warnings.push(...cached.warnings);
    } else {
      try {
        const entries = await readdir(absolute('screenplays'), { withFileTypes: true });
        names = [];
        const scanWarnings = [];
        for (const entry of entries) {
          const candidate = entry.name;
          if (!/\.(?:txt|docx)$/iu.test(candidate)) continue;
          if (entry.isSymbolicLink()) {
            scanWarnings.push('SOURCE_LINK_REJECTED:screenplays');
            continue;
          }
          if (!entry.isFile()) continue;
          if (
            candidate.length < 1 || candidate.length > 255 ||
            /[\\/\u0000-\u001f\u007f]/u.test(candidate)
          ) {
            scanWarnings.push('SCREENPLAY_FILENAME_REJECTED');
            continue;
          }
          names.push(candidate);
        }
        const verifiedSource = await sourceEntry('screenplays', warnings);
        if (verifiedSource.state !== 'directory') {
          return unavailable('unavailable', '剧本来源不可用', verifiedSource);
        }
        if (verifiedSource.mtimeMs !== source.mtimeMs) {
          warnings.push('SOURCE_CHANGED_DURING_READ:screenplays');
          return unavailable('unavailable', '剧本来源更新中', { ...verifiedSource, state: 'changed' });
        }
        names.sort((left, right) => left.localeCompare(right, 'zh-CN', { numeric: true, sensitivity: 'base' }));
        const cachedWarnings = [...new Set(scanWarnings)];
        warnings.push(...cachedWarnings);
        screenplayCache.set('screenplays', { mtimeMs: verifiedSource.mtimeMs, names, warnings: cachedWarnings });
      } catch {
        warnings.push('SOURCE_UNREADABLE:screenplays');
        return unavailable('unavailable', '剧本来源不可用', { ...source, state: 'unreadable' });
      }
    }

    const actualByFoldedName = new Map(names.map((name) => [name.toLocaleLowerCase('zh-CN'), name]));
    const preferred = [];
    const preferredSet = new Set();
    for (const value of Array.isArray(preferredSources) ? preferredSources : []) {
      if (typeof value !== 'string' || /[\\/\u0000-\u001f\u007f]/u.test(value)) continue;
      const actual = actualByFoldedName.get(value.toLocaleLowerCase('zh-CN'));
      if (actual && !preferredSet.has(actual)) {
        preferred.push(actual);
        preferredSet.add(actual);
      }
      if (preferredSet.size === names.length) break;
    }
    const ordered = [...preferred, ...names.filter((name) => !preferredSet.has(name))];
    const count = ordered.length;
    const files = ordered.slice(0, MAX_SCREENPLAY_FILES);
    const filename = files[0] || null;
    return {
      known: true,
      state: count === 0 ? 'empty' : count === 1 ? 'ready' : 'multiple',
      count,
      files,
      filename,
      label: count === 0 ? '尚未导入剧本' : count === 1 ? filename : `${filename} 等 ${count} 个文件`,
      truncated: count > files.length,
      source
    };
  };

  const statusCounts = (queue, progress, kind, warnings) => {
    if (!isObject(queue) || !Array.isArray(queue.items) || !isObject(progress) || !isObject(progress.items)) {
      if (queue !== null || progress !== null) warnings.push(`BATCH_UNAVAILABLE:${kind}`);
      return { scope: kind, operation: null, mode: 'none', integrity: 'status-only', counts: { known: false }, activeTask: null, backend: 'none', backendCounts: {} };
    }
    const counts = { known: true, total: queue.items.length, completed: 0, active: 0, retryable: 0, failed: 0, pending: 0, finished: 0 };
    const active = [];
    const backendCounts = {};
    for (const item of queue.items) {
      const key = cleanText(item?.key, 128);
      if (!key) { counts.known = false; continue; }
      const state = progress.items[key];
      const status = cleanText(state?.status, 32).toLowerCase();
      const backend = cleanText(state?.backend, 32) || (kind === 'directory-redraw' ? 'api' : 'unknown');
      backendCounts[backend] = (backendCounts[backend] || 0) + 1;
      if (status === 'completed') counts.completed += 1;
      else if (status === 'failed' && state?.terminal === true) counts.failed += 1;
      else if (status === 'failed') counts.retryable += 1;
      else if (status === 'generating') {
        counts.active += 1;
        const identity = kind === 'directory-redraw'
          ? cleanText(item?.sourceRelativePath, 128)
          : [cleanText(item?.assetId, 64), cleanText(item?.assetName, 96)].filter(Boolean).join(' ');
        active.push({
          taskId: key,
          label: identity || key,
          assetId: cleanText(item?.assetId, 64) || null,
          assetName: cleanText(item?.assetName, 96) || null,
          sheetName: cleanText(item?.sheetName, 32) || null,
          backend,
          startedAt: safeTime(Date.parse(state?.startedAt || state?.updatedAt || '')),
          remoteStatus: cleanText(state?.remoteStatus, 48) || null,
          queuePosition: Number.isInteger(state?.queuePosition) ? state.queuePosition : null
        });
      } else counts.pending += 1;
    }
    counts.finished = counts.completed + counts.failed;
    if (!counts.known) warnings.push(`BATCH_INVALID_ITEM:${kind}`);
    if (active.length > 1) {
      warnings.push(`MULTIPLE_ACTIVE_TASKS:${kind}`);
      return { scope: kind, operation: cleanText(queue.operation, 32) || null, mode: 'warning', integrity: 'status-only', counts, activeTask: null, backend: 'multiple', backendCounts };
    }
    if (active.length === 1) {
      return { scope: kind, operation: cleanText(queue.operation, 32) || null, mode: 'active', integrity: 'status-only', counts, backend: active[0].backend, backendCounts, activeTask: { ...active[0], progress: { mode: 'indeterminate' } } };
    }
    const done = counts.total > 0 && counts.finished >= counts.total;
    return { scope: kind, operation: cleanText(queue.operation, 32) || null, mode: done ? (counts.failed ? 'warning' : 'complete') : 'idle', integrity: 'status-only', counts, activeTask: null, backend: 'none', backendCounts };
  };

  const getSnapshot = async () => {
    const warnings = [];
    const sources = {};
    const capture = async (key) => {
      const result = await readJson(key, warnings);
      sources[key] = result.source;
      return result.value;
    };
    const [reading, pending, pagination, overview, visualSpecs, mainQueue, mainProgress, redrawQueue, redrawProgress, worldRecords] = await Promise.all([
      capture('reading'), capture('pending'), capture('worldPagination'), capture('worldOverview'),
      capture('visualSpecsProgress'),
      capture('mainQueue'), capture('mainProgress'), capture('redrawQueue'), capture('redrawProgress'), capture('worldRecords')
    ]);
    const recordResults = await Promise.all(RECORD_TYPES.map(async ([key]) => {
      const value = await capture(`record_${key}`);
      return [key, value];
    }));
    const [originals, analyses, workbookSource, lockSource] = await Promise.all([
      countDirectoryFiles('originals', warnings), countDirectoryFiles('analyses', warnings),
      sourceEntry('workbook', warnings), sourceEntry('lock', warnings)
    ]);
    const screenplay = await readScreenplays(warnings, reading?.sources);
    sources.screenplays = screenplay.source;
    sources.originals = originals.source; sources.analyses = analyses.source; sources.workbook = workbookSource; sources.lock = lockSource;

    const countRecords = (value) => Array.isArray(value) ? value.length
      : Array.isArray(value?.records) ? value.records.length
        : Array.isArray(value?.items) ? value.items.length : null;
    const byType = {};
    let recordsKnown = true;
    for (const [key, value] of recordResults) {
      const count = countRecords(value);
      if (count === null) recordsKnown = false;
      else byType[key] = count;
    }
    const worldFacts = countRecords(worldRecords);
    const assetCounts = recordsKnown
      ? { known: true, total: Object.values(byType).reduce((sum, value) => sum + value, 0), byType, worldFacts }
      : { known: false, byType: {} };
    const pendingItems = Array.isArray(pending) ? pending : Array.isArray(pending?.items) ? pending.items : null;
    const pendingSummary = pendingItems
      ? { known: true, count: pendingItems.filter((item) => !cleanText(item?.status, 32) || cleanText(item?.status, 32).toLowerCase() === 'pending').length }
      : { known: false };

    const mainBatch = statusCounts(mainQueue, mainProgress, 'main', warnings);
    const redrawBatch = statusCounts(redrawQueue, redrawProgress, 'directory-redraw', warnings);
    const activeBatches = [mainBatch, redrawBatch].filter((batch) => batch.mode === 'active');
    let batch;
    if (activeBatches.length > 1) {
      warnings.push('MULTIPLE_ACTIVE_BACKENDS');
      batch = { scope: 'conflict', operation: null, mode: 'warning', integrity: 'status-only', counts: { known: false }, backend: 'multiple', backendCounts: {}, activeTask: null };
    } else if (activeBatches.length === 1) batch = activeBatches[0];
    else if (mainBatch.mode === 'warning' || redrawBatch.mode === 'warning') batch = mainBatch.mode === 'warning' ? mainBatch : redrawBatch;
    else if (redrawBatch.counts.known && redrawBatch.counts.total > 0) batch = redrawBatch;
    else if (mainBatch.counts.known) batch = mainBatch;
    else batch = { scope: 'none', operation: null, mode: 'none', integrity: 'status-only', counts: { known: false }, backend: 'none', backendCounts: {}, activeTask: null };

    const readingStatus = cleanText(reading?.status, 32);
    const discovered = Array.isArray(reading?.discoveredEpisodes)
      ? [...new Set(reading.discoveredEpisodes.map(Number).filter(Number.isInteger))]
      : [];
    const completedEpisodes = Array.isArray(reading?.completedEpisodes)
      ? [...new Set(reading.completedEpisodes.map(Number).filter(Number.isInteger))]
      : [];
    const episodeTotal = discovered.length || (originals.known ? originals.count : 0);
    const splitDone = originals.known ? Math.min(originals.count, episodeTotal || originals.count) : null;
    const analysisDone = completedEpisodes.length || (analyses.known ? Math.min(analyses.count, episodeTotal || analyses.count) : null);
    const splitComplete = episodeTotal > 0 && splitDone === episodeTotal;
    const analysisComplete = episodeTotal > 0 && analysisDone === episodeTotal && readingStatus === 'complete';
    const splitState = splitComplete ? 'complete' : episodeTotal > 0 ? 'active' : 'idle';
    const analysisState = analysisComplete ? 'complete' : readingStatus === 'in_progress' ? 'active' : splitComplete ? 'waiting' : 'idle';
    const overviewComplete = isObject(pagination) && pagination.complete === true && cleanText(overview?.content, 1).length > 0;
    const workbookReady = workbookSource.state === 'present';
    const pageSize = Number.isInteger(pagination?.pageSize) && pagination.pageSize > 0 ? pagination.pageSize : 40;
    const pageTotal = Number.isInteger(pagination?.totalRecords) && pagination.totalRecords >= 0
      ? Math.ceil(pagination.totalRecords / pageSize) : null;
    const pageDone = Array.isArray(pagination?.coveredOffsets) ? pagination.coveredOffsets.length : null;
    const overviewState = overviewComplete ? 'complete' : analysisComplete && pagination ? 'active' : analysisComplete ? 'waiting' : 'idle';
    const visualTotal = Number.isInteger(visualSpecs?.total) && visualSpecs.total >= 0 ? visualSpecs.total : null;
    const visualCompleted = Array.isArray(visualSpecs?.completedAssetIds)
      ? visualSpecs.completedAssetIds.filter((value) => typeof value === 'string' && value.trim()).length
      : null;
    const visualComplete = visualSpecs?.status === 'complete'
      && visualTotal !== null && visualCompleted !== null && visualCompleted === visualTotal;
    const visualActive = visualSpecs?.status === 'in_progress';
    const visualState = visualComplete ? 'complete' : visualActive ? 'active' : overviewComplete ? 'waiting' : 'idle';
    const excelState = workbookReady ? 'complete' : visualComplete ? 'waiting' : 'idle';
    const generationState = batch.mode === 'active' ? 'active' : batch.mode === 'complete' ? 'complete' : batch.mode === 'warning' ? 'warning' : 'waiting';
    const stages = [
      { id: 'split', label: '剧本切分', state: splitState, progress: episodeTotal > 0 && splitDone !== null ? { mode: 'determinate', done: splitDone, total: episodeTotal } : { mode: 'none' } },
      { id: 'analysis', label: '分析与累计', state: analysisState, progress: episodeTotal > 0 && analysisDone !== null ? { mode: 'determinate', done: analysisDone, total: episodeTotal } : { mode: 'none' }, currentEpisode: Number.isInteger(Number(reading?.currentEpisode)) ? Number(reading.currentEpisode) : null },
      { id: 'world-overview', label: '世界观总览', state: overviewState, progress: pageTotal !== null && pageDone !== null ? { mode: 'determinate', done: Math.min(pageDone, pageTotal), total: pageTotal } : { mode: overviewState === 'active' ? 'indeterminate' : 'none' } },
      { id: 'asset-visual-specs', label: '资产设定', state: visualState, progress: visualTotal !== null && visualCompleted !== null ? { mode: 'determinate', done: Math.min(visualCompleted, visualTotal), total: visualTotal } : { mode: visualActive ? 'indeterminate' : 'none' } },
      { id: 'excel', label: 'Excel 制表', state: excelState, progress: { mode: excelState === 'waiting' && overviewComplete ? 'indeterminate' : 'none' } },
      { id: 'generation', label: '资产出图', state: generationState, progress: batch.counts.known && batch.counts.total > 0 ? { mode: 'determinate', done: batch.counts.finished, total: batch.counts.total, integrity: 'status-only' } : { mode: batch.mode === 'active' ? 'indeterminate' : 'none' } }
    ];

    const timestamp = now();
    const nowMs = timestamp instanceof Date ? timestamp.getTime() : new Date(timestamp).getTime();
    const startedAtMs = Date.parse(reading?.pipelineStartedAt || '');
    const analysisTask = readingStatus === 'in_progress' && Number.isInteger(Number(reading?.currentEpisode))
      ? { taskId: `episode:${Number(reading.currentEpisode)}`, label: `第 ${Number(reading.currentEpisode)} 集分析`, scope: 'analysis', backend: null, startedAt: safeTime(Date.parse(reading?.currentStartedAt || '')), progress: { mode: 'indeterminate' } }
      : null;
    const visualCurrent = isObject(visualSpecs?.current) ? visualSpecs.current : null;
    const visualAssetId = cleanText(visualCurrent?.assetId, 64);
    const visualCategoryLabel = cleanText(visualCurrent?.categoryLabel, 32);
    const visualTask = visualActive && visualAssetId
      ? {
          taskId: `visual:${visualAssetId}`,
          label: `${visualCategoryLabel || '资产'} ${visualAssetId}`,
          scope: 'asset-visual-specs',
          backend: 'codex-sdk',
          startedAt: safeTime(Date.parse(visualCurrent?.startedAt || '')),
          progress: { mode: 'indeterminate' },
          assetId: visualAssetId,
          assetName: cleanText(visualCurrent?.assetName, 128) || null,
          sheetName: visualCategoryLabel || null
        }
      : null;
    const currentTask = batch.activeTask ? { ...batch.activeTask, scope: batch.scope } : visualTask ?? analysisTask;
    const phase = batch.mode === 'active' ? 'generation'
      : readingStatus === 'in_progress' ? 'analysis'
        : !splitComplete ? 'split'
          : !analysisComplete ? 'analysis'
            : !overviewComplete ? 'world-overview'
              : !visualComplete ? 'asset-visual-specs'
              : !workbookReady ? 'excel'
                : batch.mode === 'complete' ? 'complete' : 'waiting-generation';
    return {
      schemaVersion: WORKBENCH_SNAPSHOT_SCHEMA_VERSION,
      observedAt: timestamp instanceof Date ? timestamp.toISOString() : new Date(timestamp).toISOString(),
      pollAfterMs,
      pipeline: {
        phase,
        state: currentTask ? 'active' : phase === 'complete' ? 'complete' : 'waiting',
        startedAt: safeTime(startedAtMs),
        elapsedSeconds: Number.isFinite(startedAtMs) ? Math.max(0, Math.floor((nowMs - startedAtMs) / 1000)) : null,
        stages,
        currentTask
      },
      assetCounts,
      screenplay: {
        known: screenplay.known,
        state: screenplay.state,
        count: screenplay.count,
        files: screenplay.files,
        filename: screenplay.filename,
        label: screenplay.label,
        truncated: screenplay.truncated
      },
      batch,
      pending: pendingSummary,
      warnings: [...new Set(warnings)].slice(0, 16),
      source: {
        mode: 'read-only-cache',
        lockPresent: lockSource.state === 'present',
        files: Object.fromEntries(Object.entries(sources).map(([key, value]) => [key, { state: value.state, observedAt: safeTime(value.mtimeMs) }]))
      }
    };
  };
  return Object.freeze({ getSnapshot });
}

export async function getSnapshot(root, options) {
  return createWorkbenchSnapshotReader(root, options).getSnapshot();
}
