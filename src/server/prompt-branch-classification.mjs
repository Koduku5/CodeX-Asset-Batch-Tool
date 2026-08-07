import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const CLASSIFICATION_VERSION = 1;
const PAGE_SIZE = 40;
const MAX_QUEUE_ITEMS = 50_000;
const MAX_JSON_BYTES = 512 * 1024 * 1024;
const VALID_SHEETS = new Set(['角色', '生物', '群演', '场景', '道具']);
const SHA256 = /^[a-f0-9]{64}$/u;

export class PromptBranchClassificationError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = 'PromptBranchClassificationError';
    this.code = code;
    this.cause = cause;
  }
}

const fail = (code, message, cause = null) => {
  throw new PromptBranchClassificationError(code, message, cause);
};

const outside = (root, candidate) => {
  const offset = relative(root, candidate);
  return offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset);
};

const safeTarget = (root, ...segments) => {
  const target = resolve(root, ...segments);
  if (outside(root, target)) fail('UNSAFE_PROJECT_PATH', '提示词分支分类路径越出项目根');
  return target;
};

const lstatOrNull = async (target) => {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};

const assertPlain = async (root, target, kind, label) => {
  if (outside(root, target)) fail('UNSAFE_PROJECT_PATH', `${label} 越出项目根`);
  const offset = relative(root, target);
  let cursor = root;
  for (const part of offset ? offset.split(sep) : []) {
    cursor = join(cursor, part);
    const info = await lstatOrNull(cursor);
    if (info === null) fail('REQUIRED_FILE_MISSING', `${label} 不存在`);
    if (info.isSymbolicLink()) fail('UNSAFE_PROJECT_PATH', `${label} 路径中含有符号链接或目录联接`);
  }
  const info = await lstatOrNull(target);
  if (info === null) fail('REQUIRED_FILE_MISSING', `${label} 不存在`);
  if (kind === 'file' && !info.isFile()) fail('INVALID_PROJECT_FILE', `${label} 不是普通文件`);
  if (kind === 'directory' && !info.isDirectory()) fail('INVALID_PROJECT_FILE', `${label} 不是普通目录`);
  return info;
};

const readJsonBounded = async (root, target, label) => {
  const info = await assertPlain(root, target, 'file', label);
  if (info.size <= 0 || info.size > MAX_JSON_BYTES) fail('INVALID_PROJECT_FILE', `${label} 大小无效`);
  try {
    return JSON.parse(await readFile(target, 'utf8'));
  } catch (error) {
    fail('INVALID_PROJECT_FILE', `${label} 不是有效 JSON`, error);
  }
};

const writeJsonAtomic = async (root, target, value, token) => {
  if (outside(root, target)) fail('UNSAFE_PROJECT_PATH', '提示词分支分类写入路径越出项目根');
  const parent = resolve(target, '..');
  await assertPlain(root, parent, 'directory', '提示词分支分类写入目录');
  const temporary = `${target}.tmp-${token}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
};

const safeEnvironment = (source) => {
  const allowed = new Set([
    'ALLUSERSPROFILE', 'APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA',
    'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
    'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMDRIVE', 'SYSTEMROOT',
    'TEMP', 'TMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'
  ]);
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => allowed.has(key.toUpperCase()) && typeof value === 'string'));
};

const runFixedBuildQueue = async ({ projectRoot, nodeRunner, buildScript, signal, spawnImpl = nodeSpawn }) => {
  await new Promise((resolveRun, rejectRun) => {
    let child;
    try {
      child = spawnImpl('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        nodeRunner,
        buildScript,
        projectRoot
      ], {
        cwd: projectRoot,
        env: safeEnvironment(process.env),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal
      });
    } catch (error) {
      rejectRun(new PromptBranchClassificationError('QUEUE_BUILD_START_FAILED', '无法启动正式建队脚本', error));
      return;
    }
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      if (error) rejectRun(error);
      else resolveRun();
    };
    child?.stdout?.resume?.();
    child?.stderr?.resume?.();
    child?.once?.('error', (error) => finish(new PromptBranchClassificationError(
      signal?.aborted ? 'CLASSIFICATION_INTERRUPTED' : 'QUEUE_BUILD_FAILED',
      signal?.aborted ? '提示词分支分类已中断' : '正式建队脚本执行失败',
      error
    )));
    child?.once?.('close', (code) => finish(code === 0 ? null : new PromptBranchClassificationError(
      'QUEUE_BUILD_FAILED',
      '正式建队脚本未通过校验'
    )));
    if (!child || typeof child.once !== 'function') {
      finish(new PromptBranchClassificationError('QUEUE_BUILD_START_FAILED', '无法启动正式建队脚本'));
    }
  });
};

const loadProjectCatalog = async ({ projectRoot, promptCatalogModule, catalogPath, token }) => {
  let api;
  try {
    api = await import(`${pathToFileURL(promptCatalogModule).href}?branch-classification=${token}`);
  } catch (error) {
    fail('PROMPT_CATALOG_UNAVAILABLE', '无法载入项目 Prompt Catalog 解析器', error);
  }
  for (const name of [
    'loadPromptCatalog',
    'makeCatalogFingerprint',
    'makeConditionModuleRegistryFingerprint',
    'resolveSelectedConditionModules'
  ]) {
    if (typeof api[name] !== 'function') fail('PROMPT_CATALOG_UNAVAILABLE', '项目 Prompt Catalog 解析器接口不完整');
  }
  let loaded;
  try {
    loaded = await api.loadPromptCatalog(catalogPath);
  } catch (error) {
    fail('PROMPT_CATALOG_INVALID', '项目 Prompt Catalog 未通过正式校验', error);
  }
  return {
    loaded,
    catalogFingerprint: api.makeCatalogFingerprint(loaded),
    conditionRegistryFingerprint: api.makeConditionModuleRegistryFingerprint(loaded),
    resolveSelectedConditionModules: api.resolveSelectedConditionModules
  };
};

const exactKeys = (value, keys) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));

const normalizeEnum = (value, allowed, legacy = {}) => {
  const text = String(value ?? '').trim().replaceAll('_', '-');
  if (allowed.includes(text)) return text;
  return Object.entries(legacy).find(([, label]) => label === text)?.[0] ?? null;
};

const validateBaseQueue = (queue, catalog) => {
  if (!queue || typeof queue !== 'object' || Array.isArray(queue) || queue.version !== 4 || !Array.isArray(queue.items)) {
    fail('BASE_QUEUE_INVALID', '基础出图队列结构无效');
  }
  if (queue.operation === 'reference_redraw') fail('UNSUPPORTED_QUEUE_MODE', '目录重绘队列不执行提示词分支分类');
  if (queue.conditionMatching || queue.items.some((item) => Object.hasOwn(item ?? {}, 'selectedConditionModuleIds'))) {
    fail('BASE_QUEUE_NOT_REFRESHED', '基础队列没有在无分支匹配状态下完成刷新');
  }
  if (queue.items.length > MAX_QUEUE_ITEMS) fail('CLASSIFICATION_TOO_LARGE', '提示词分支分类项超过 50000 条限制');
  const batch = queue.builtinPromptBatch;
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) {
    fail('BUILTIN_PROMPT_BATCH_REQUIRED', '请先确认内置提示词风格、生成类型与参考图方式');
  }
  const style = normalizeEnum(batch.styleId, catalog.enums.styles, catalog.legacyNames.styles);
  if (!style) fail('BUILTIN_PROMPT_BATCH_INVALID', '内置提示词批次风格无效');
  const keys = new Set();
  const items = queue.items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('BASE_QUEUE_INVALID', `基础队列第 ${index + 1} 项无效`);
    const key = String(item.key ?? '').trim();
    const sheetName = String(item.sheetName ?? '').trim();
    const assetName = String(item.assetName ?? '').trim();
    const productionNotes = String(item.productionNotes ?? '').trim();
    if (!key || key.length > 200 || /[\\/\u0000-\u001f\u007f]/u.test(key) || keys.has(key)) {
      fail('BASE_QUEUE_INVALID', `基础队列第 ${index + 1} 项 key 无效或重复`);
    }
    if (!VALID_SHEETS.has(sheetName) || !assetName || !productionNotes) {
      fail('BASE_QUEUE_INVALID', `基础队列第 ${index + 1} 项缺少资产或制作说明`);
    }
    keys.add(key);
    const asset = normalizeEnum(sheetName, catalog.enums.assets, catalog.legacyNames.assets);
    const references = batch.referencesBySheet?.[sheetName];
    if (!Array.isArray(references)) fail('BUILTIN_PROMPT_BATCH_INVALID', `内置提示词批次缺少 ${sheetName} 参考图配置`);
    const configuredMode = normalizeEnum(
      batch.referenceModeBySheet?.[sheetName],
      catalog.enums.referenceModes,
      catalog.legacyNames.referenceModes
    );
    const referenceMode = references.length === 0 ? 'none' : configuredMode;
    if (!asset || !referenceMode) fail('BUILTIN_PROMPT_BATCH_INVALID', `内置提示词批次的 ${sheetName} 路由无效`);
    return { key, sheetName, assetName, productionNotes, style, asset, referenceMode };
  });
  return { items, batch };
};

const candidateForRequest = (module) => ({
  id: module.id,
  displayName: module.displayName,
  family: module.family,
  definition: module.classifier.definition,
  selectionPolicy: module.classifier.selectionPolicy,
  controlDimensions: [...module.classifier.controlDimensions],
  tieBreak: module.classifier.tieBreak,
  noDefault: module.classifier.noDefault
});

const pageSchema = (pageItems) => {
  const candidateIds = [...new Set(pageItems.flatMap((item) => item.candidates.map(({ id }) => id)))];
  return {
    type: 'object',
    properties: {
      completed: { type: 'boolean' },
      action: { type: 'string', enum: ['classify-prompt-branches'] },
      summary: { type: 'string', minLength: 1, maxLength: 240 },
      assignments: {
        type: 'array',
        minItems: pageItems.length,
        maxItems: pageItems.length,
        items: {
          type: 'object',
          properties: {
            key: { type: 'string', enum: pageItems.map(({ key }) => key) },
            selectedConditionModuleIds: {
              type: 'array',
              items: candidateIds.length ? { type: 'string', enum: candidateIds } : { type: 'string' }
            }
          },
          required: ['key', 'selectedConditionModuleIds'],
          additionalProperties: false
        }
      }
    },
    required: ['completed', 'action', 'summary', 'assignments'],
    additionalProperties: false
  };
};

const replaceFromBackup = async (root, backup, target, token) => {
  const temporary = `${target}.restore-${token}`;
  const displaced = `${target}.displaced-${token}`;
  await copyFile(backup, temporary, fsConstants.COPYFILE_EXCL);
  let hasDisplaced = false;
  try {
    const current = await lstatOrNull(target);
    if (current) {
      if (!current.isFile() || current.isSymbolicLink()) fail('ROLLBACK_UNSAFE', '提示词分支分类回滚目标不安全');
      await rename(target, displaced);
      hasDisplaced = true;
    }
    await rename(temporary, target);
    if (hasDisplaced) {
      await rm(displaced, { force: true });
      hasDisplaced = false;
    }
  } catch (error) {
    if (hasDisplaced && !(await lstatOrNull(target))) await rename(displaced, target).catch(() => {});
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
    if (hasDisplaced) await rm(displaced, { force: true }).catch(() => {});
  }
};

export async function createPromptBranchClassificationSession(projectRootInput, {
  signal = null,
  spawnImpl = nodeSpawn,
  runBuildQueue = null,
  loadCatalog = null,
  createToken = () => randomUUID(),
  onProgress = () => {}
} = {}) {
  if (typeof createToken !== 'function' || typeof onProgress !== 'function') throw new TypeError('classification dependencies are invalid');
  if (typeof projectRootInput !== 'string' || !isAbsolute(projectRootInput)) {
    fail('INVALID_PROJECT_ROOT', '提示词分支分类项目根必须是绝对路径');
  }
  const requestedRoot = resolve(projectRootInput);
  const rootInfo = await lstatOrNull(requestedRoot);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) fail('INVALID_PROJECT_ROOT', '提示词分支分类项目根不可用');
  const projectRoot = await realpath(requestedRoot);
  const token = createToken();
  if (typeof token !== 'string' || !/^[A-Za-z0-9-]{8,80}$/u.test(token)) throw new TypeError('createToken returned an invalid token');
  const cacheRoot = safeTarget(projectRoot, 'cache');
  await assertPlain(projectRoot, cacheRoot, 'directory', '项目 cache');
  const lockPath = safeTarget(projectRoot, 'cache', '.提示词分支分类.lock');
  const stageRoot = safeTarget(projectRoot, 'cache', `.提示词分支分类-${token}`);
  const paths = {
    matching: safeTarget(projectRoot, 'cache', '提示词分支匹配.json'),
    queue: safeTarget(projectRoot, 'cache', '出图队列.json'),
    progress: safeTarget(projectRoot, 'cache', '出图进度.json')
  };
  const runtime = {
    nodeRunner: safeTarget(projectRoot, 'scripts', 'commands', 'node.ps1'),
    buildScript: safeTarget(projectRoot, 'scripts', 'pipeline', 'build_image_queue.mjs'),
    promptCatalogModule: safeTarget(projectRoot, 'scripts', 'lib', 'prompt_catalog.mjs'),
    catalogPath: safeTarget(projectRoot, 'assets', '图片生成', 'prompts', 'catalog.json')
  };
  for (const [label, target] of Object.entries(runtime)) await assertPlain(projectRoot, target, 'file', label);

  let lockHandle;
  try {
    lockHandle = await open(lockPath, 'wx', 0o600);
    await lockHandle.writeFile(`${JSON.stringify({ version: 1, token, startedAt: new Date().toISOString() })}\n`, 'utf8');
    await lockHandle.sync();
    await lockHandle.close();
    lockHandle = null;
  } catch (error) {
    await lockHandle?.close?.().catch(() => {});
    if (error?.code === 'EEXIST') fail('CLASSIFICATION_BUSY', '该项目已有提示词分支分类正在运行');
    throw error;
  }

  try {
    await mkdir(stageRoot, { recursive: false });
  } catch (error) {
    await rm(lockPath, { force: true }).catch(() => {});
    throw error;
  }
  const snapshots = {};
  let closed = false;
  let committed = false;

  const releaseLock = async () => {
    const lock = await readJsonBounded(projectRoot, lockPath, '提示词分支分类锁');
    if (lock?.token !== token) fail('CLASSIFICATION_LOCK_CHANGED', '提示词分支分类锁已变化，禁止释放');
    await rm(lockPath, { force: true });
  };

  const snapshot = async (name, target) => {
    const info = await lstatOrNull(target);
    snapshots[name] = { existed: info !== null, backup: join(stageRoot, `${name}.backup.json`) };
    if (info === null) return;
    if (!info.isFile() || info.isSymbolicLink()) fail('UNSAFE_PROJECT_PATH', `项目 ${name} 状态文件不安全`);
    await copyFile(target, snapshots[name].backup, fsConstants.COPYFILE_EXCL);
  };

  const restore = async () => {
    if (closed) return;
    const errors = [];
    for (const name of ['queue', 'progress', 'matching']) {
      const state = snapshots[name];
      if (!state) continue;
      try {
        if (state.existed) await replaceFromBackup(projectRoot, state.backup, paths[name], token);
        else await rm(paths[name], { force: true });
      } catch (error) {
        errors.push(error);
      }
    }
    try { await rm(stageRoot, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    try { await releaseLock(); } catch (error) { errors.push(error); }
    closed = true;
    if (errors.length) throw new AggregateError(errors, '提示词分支分类回滚失败');
  };

  const buildQueue = runBuildQueue ?? ((input) => runFixedBuildQueue({ ...input, spawnImpl }));
  let catalogApi;
  let base;
  let pages;
  const automaticAssignments = new Map();
  try {
    await snapshot('matching', paths.matching);
    await snapshot('queue', paths.queue);
    await snapshot('progress', paths.progress);
    await rm(paths.matching, { force: true });
    onProgress('正在建立无分支的基础队列候选');
    await buildQueue({ projectRoot, ...runtime, signal });
    if (signal?.aborted) fail('CLASSIFICATION_INTERRUPTED', '提示词分支分类已中断');
    const baseQueue = await readJsonBounded(projectRoot, paths.queue, '基础出图队列');
    catalogApi = loadCatalog
      ? await loadCatalog({ projectRoot, ...runtime, token })
      : await loadProjectCatalog({ projectRoot, ...runtime, token });
    if (!catalogApi?.loaded?.catalog || !catalogApi?.loaded?.conditionModules) {
      fail('PROMPT_CATALOG_UNAVAILABLE', '项目 Prompt Catalog 分类接口不完整');
    }
    if (!SHA256.test(catalogApi.catalogFingerprint) || !SHA256.test(catalogApi.conditionRegistryFingerprint)) {
      fail('PROMPT_CATALOG_INVALID', '项目 Prompt Catalog 指纹无效');
    }
    base = validateBaseQueue(baseQueue, catalogApi.loaded.catalog);
    const modules = catalogApi.loaded.conditionModules.modules;
    if (!Array.isArray(modules)) fail('PROMPT_CATALOG_INVALID', '条件分支注册表缺少 modules');
    const semanticItems = [];
    for (const item of base.items) {
      const candidates = modules.filter((module) =>
        module.scope.styles.includes(item.style)
        && module.scope.assets.includes(item.asset)
        && module.scope.referenceModes.includes(item.referenceMode));
      if (!candidates.length) {
        automaticAssignments.set(item.key, { selectedConditionModuleIds: [] });
        continue;
      }
      semanticItems.push({
        ...item,
        candidates: candidates.map(candidateForRequest)
      });
    }
    pages = [];
    for (let offset = 0; offset < semanticItems.length; offset += PAGE_SIZE) {
      const items = semanticItems.slice(offset, offset + PAGE_SIZE);
      const pageNumber = pages.length + 1;
      const requestPath = join(stageRoot, `request-${String(pageNumber).padStart(5, '0')}.json`);
      await writeJsonAtomic(projectRoot, requestPath, {
        version: CLASSIFICATION_VERSION,
        page: pageNumber,
        totalPages: Math.ceil(semanticItems.length / PAGE_SIZE),
        catalogFingerprint: catalogApi.catalogFingerprint,
        conditionRegistryFingerprint: catalogApi.conditionRegistryFingerprint,
        items
      }, token);
      pages.push(Object.freeze({
        page: pageNumber,
        count: items.length,
        relativeRequestPath: relative(projectRoot, requestPath).split(sep).join('/'),
        items: Object.freeze(items),
        outputSchema: pageSchema(items)
      }));
    }
  } catch (error) {
    await restore().catch((rollbackError) => {
      throw new AggregateError([error, rollbackError], '提示词分支分类准备失败且回滚失败');
    });
    throw error;
  }

  const validatePageResult = (page, value) => {
    if (!pages.includes(page)) fail('INVALID_CLASSIFICATION_PAGE', '提示词分支分类分页无效');
    if (!exactKeys(value, ['completed', 'action', 'summary', 'assignments'])
      || value.completed !== true
      || value.action !== 'classify-prompt-branches'
      || typeof value.summary !== 'string'
      || !value.summary.trim()
      || value.summary.length > 240
      || !Array.isArray(value.assignments)
      || value.assignments.length !== page.items.length) {
      fail('INVALID_CLASSIFICATION_RESULT', '提示词分支分类回执结构无效');
    }
    const byKey = new Map(page.items.map((item) => [item.key, item]));
    const seen = new Set();
    return value.assignments.map((assignment) => {
      if (!exactKeys(assignment, ['key', 'selectedConditionModuleIds'])
        || typeof assignment.key !== 'string'
        || !byKey.has(assignment.key)
        || seen.has(assignment.key)
        || !Array.isArray(assignment.selectedConditionModuleIds)) {
        fail('INVALID_CLASSIFICATION_RESULT', '提示词分支分类项结构无效');
      }
      seen.add(assignment.key);
      const item = byKey.get(assignment.key);
      const candidates = new Set(item.candidates.map(({ id }) => id));
      if (assignment.selectedConditionModuleIds.some((id) => typeof id !== 'string' || !candidates.has(id))
        || new Set(assignment.selectedConditionModuleIds).size !== assignment.selectedConditionModuleIds.length) {
        fail('INVALID_CLASSIFICATION_RESULT', `提示词分支分类为 ${assignment.key} 选择了无效分支`);
      }
      let resolvedModules;
      try {
        resolvedModules = catalogApi.resolveSelectedConditionModules(
          catalogApi.loaded,
          assignment.selectedConditionModuleIds,
          { style: item.style, asset: item.asset, referenceMode: item.referenceMode }
        );
      } catch (error) {
        fail('INVALID_CLASSIFICATION_RESULT', `提示词分支分类为 ${assignment.key} 选择了冲突分支`, error);
      }
      return Object.freeze({
        key: assignment.key,
        selectedConditionModuleIds: resolvedModules.map(({ id }) => id)
      });
    });
  };

  const commit = async (pageResults = []) => {
    if (closed) fail('CLASSIFICATION_SESSION_CLOSED', '提示词分支分类会话已结束');
    try {
      const assignments = new Map(automaticAssignments);
      for (const group of pageResults) {
        if (!Array.isArray(group)) fail('INVALID_CLASSIFICATION_RESULT', '提示词分支分类分页结果无效');
        for (const item of group) {
          if (assignments.has(item.key)) fail('INVALID_CLASSIFICATION_RESULT', `提示词分支分类 key 重复：${item.key}`);
          assignments.set(item.key, {
            selectedConditionModuleIds: [...item.selectedConditionModuleIds]
          });
        }
      }
      if (assignments.size !== base.items.length || base.items.some(({ key }) => !assignments.has(key))) {
        fail('INVALID_CLASSIFICATION_RESULT', '提示词分支分类没有与基础队列逐项对应');
      }
      const items = Object.fromEntries(base.items.map(({ key }) => [key, assignments.get(key)]));
      const matching = {
        version: CLASSIFICATION_VERSION,
        catalogFingerprint: catalogApi.catalogFingerprint,
        conditionRegistryFingerprint: catalogApi.conditionRegistryFingerprint,
        items
      };
      await writeJsonAtomic(projectRoot, paths.matching, matching, token);
      onProgress('正在用正式建队脚本校验并应用提示词分支匹配');
      await buildQueue({ projectRoot, ...runtime, signal });
      if (signal?.aborted) fail('CLASSIFICATION_INTERRUPTED', '提示词分支分类已中断');
      const finalQueue = await readJsonBounded(projectRoot, paths.queue, '最终出图队列');
      if (finalQueue.conditionMatching?.catalogFingerprint !== catalogApi.catalogFingerprint
        || finalQueue.conditionMatching?.conditionRegistryFingerprint !== catalogApi.conditionRegistryFingerprint
        || !Array.isArray(finalQueue.items)
        || finalQueue.items.length !== base.items.length) {
        fail('FINAL_QUEUE_VALIDATION_FAILED', '最终队列没有绑定当前提示词分支匹配');
      }
      const finalByKey = new Map(finalQueue.items.map((item) => [item?.key, item]));
      for (const [key, expected] of Object.entries(items)) {
        const actual = finalByKey.get(key);
        if (!actual
          || JSON.stringify(actual.selectedConditionModuleIds) !== JSON.stringify(expected.selectedConditionModuleIds)) {
          fail('FINAL_QUEUE_VALIDATION_FAILED', `最终队列的提示词分支匹配不一致：${key}`);
        }
      }
      await releaseLock();
      closed = true;
      committed = true;
      await rm(stageRoot, { recursive: true, force: true }).catch(() => {});
      return Object.freeze({ processedCount: base.items.length, semanticPageCount: pages.length });
    } catch (error) {
      await restore().catch((rollbackError) => {
        throw new AggregateError([error, rollbackError], '提示词分支分类提交失败且回滚失败');
      });
      throw error;
    }
  };

  return Object.freeze({
    projectRoot,
    pages: Object.freeze(pages),
    totalItems: base.items.length,
    automaticCount: automaticAssignments.size,
    validatePageResult,
    commit,
    rollback: restore,
    get committed() { return committed; }
  });
}
