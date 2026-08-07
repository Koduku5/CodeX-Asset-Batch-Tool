import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MODULE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

export class PromptRegistryServiceError extends Error {
  constructor(code, message, { status = 400, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'PromptRegistryServiceError';
    this.code = code;
    this.status = status;
  }
}

const fail = (code, message, options) => {
  throw new PromptRegistryServiceError(code, message, options);
};

const inside = (root, target) => {
  const offset = relative(root, target);
  return offset && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
};

const comparablePath = (value) => resolve(value).replace(/^\\\\\?\\/u, '').replaceAll('/', sep);
const samePath = (left, right) => process.platform === 'win32'
  ? comparablePath(left).toLowerCase() === comparablePath(right).toLowerCase()
  : comparablePath(left) === comparablePath(right);

const assertModuleId = (value) => {
  if (typeof value !== 'string' || !MODULE_ID_PATTERN.test(value)) fail('INVALID_MODULE_ID', '分支唯一编号无效');
  return value;
};

const assertFingerprint = (value) => {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail('CATALOG_FINGERPRINT_REQUIRED', '需要当前正式提示词库版本');
  }
  return value;
};

const candidateLoadedCatalog = (loaded, conditionModules) => {
  const records = new Map(loaded.records);
  records.set(loaded.catalog.paths.conditionModules, conditionModules);
  return { ...loaded, records, conditionModules };
};

const publicModule = (module) => structuredClone(module);

export function createPromptRegistryService({
  sharedAssetsRoot,
  getCatalog,
  invalidateCatalog,
  makeCatalogFingerprint,
  validatePromptCatalog
} = {}) {
  if (typeof sharedAssetsRoot !== 'string' || !isAbsolute(sharedAssetsRoot)) throw new TypeError('sharedAssetsRoot must be an absolute path');
  for (const [name, fn] of Object.entries({ getCatalog, invalidateCatalog, makeCatalogFingerprint, validatePromptCatalog })) {
    if (typeof fn !== 'function') throw new TypeError(`${name} must be a function`);
  }
  let writeTail = Promise.resolve();

  const context = async () => {
    const loaded = await getCatalog();
    const root = await realpath(resolve(sharedAssetsRoot));
    const rawTarget = resolve(loaded.rootDir, loaded.catalog.paths.conditionModules);
    const sourceRoot = resolve(sharedAssetsRoot);
    if (!inside(sourceRoot, rawTarget)) fail('REGISTRY_PATH_UNSAFE', '正式分支注册表路径不安全', { status: 409 });
    const target = resolve(root, relative(sourceRoot, rawTarget));
    if (!inside(root, target)) fail('REGISTRY_PATH_UNSAFE', '正式分支注册表路径不安全', { status: 409 });
    const info = await lstat(target).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!info?.isFile() || info.isSymbolicLink()) fail('REGISTRY_UNAVAILABLE', '正式分支注册表不可用', { status: 503 });
    const canonicalTarget = await realpath(target);
    if (!samePath(canonicalTarget, target)) {
      fail('REGISTRY_PATH_UNSAFE', '正式分支注册表路径不安全', { status: 409 });
    }
    return { loaded, target };
  };

  const validateCandidate = (loaded, registry) => {
    try {
      validatePromptCatalog(candidateLoadedCatalog(loaded, registry));
    } catch (error) {
      fail('INVALID_CONDITION_MODULE', error?.message || '分支设置无法通过正式提示词库校验', { status: 422, cause: error });
    }
  };

  const replaceRegistry = async ({ target, registry, verify }) => {
    const temporary = `${target}.tmp-${randomUUID()}`;
    const backup = `${target}.backup-${randomUUID()}`;
    let hasBackup = false;
    try {
      await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await rename(target, backup);
      hasBackup = true;
      await rename(temporary, target);
      invalidateCatalog();
      const reloaded = await getCatalog();
      await verify(reloaded);
      await rm(backup, { force: true });
      hasBackup = false;
      return reloaded;
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      if (hasBackup) {
        await rm(target, { force: true }).catch(() => {});
        await rename(backup, target).catch(() => {});
        invalidateCatalog();
      }
      if (error instanceof PromptRegistryServiceError) throw error;
      fail('REGISTRY_WRITE_FAILED', '正式分支注册表写入失败', { status: 503, cause: error });
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
      if (!hasBackup) await rm(backup, { force: true }).catch(() => {});
    }
  };

  const withWrite = (operation) => {
    const current = writeTail.catch(() => {}).then(operation);
    writeTail = current;
    return current;
  };

  const validateModule = async (module) => {
    const { loaded } = await context();
    if (!module || typeof module !== 'object' || Array.isArray(module)) fail('INVALID_CONDITION_MODULE', '分支设置必须是对象', { status: 422 });
    assertModuleId(module.id);
    const registry = structuredClone(loaded.conditionModules);
    const index = registry.modules.findIndex(({ id }) => id === module.id);
    if (index >= 0) registry.modules[index] = structuredClone(module);
    else registry.modules.push(structuredClone(module));
    registry.modules.sort((left, right) => left.id.localeCompare(right.id));
    validateCandidate(loaded, registry);
    return { valid: true, module: publicModule(module) };
  };

  const saveModule = ({ module, expectedCatalogFingerprint }) => withWrite(async () => {
    const { loaded, target } = await context();
    const expected = assertFingerprint(expectedCatalogFingerprint);
    if (makeCatalogFingerprint(loaded) !== expected) fail('CATALOG_CONFLICT', '正式提示词库已被其他人更新，请刷新后再保存', { status: 409 });
    if (!module || typeof module !== 'object' || Array.isArray(module)) fail('INVALID_CONDITION_MODULE', '分支设置必须是对象', { status: 422 });
    const id = assertModuleId(module.id);
    const registry = structuredClone(loaded.conditionModules);
    const existingIndex = registry.modules.findIndex((candidate) => candidate.id === id);
    const saved = structuredClone(module);
    if (existingIndex >= 0) saved.revision = Math.max(registry.modules[existingIndex].revision + 1, Number(saved.revision) || 1);
    if (existingIndex >= 0) registry.modules[existingIndex] = saved;
    else registry.modules.push(saved);
    registry.modules.sort((left, right) => left.id.localeCompare(right.id));
    validateCandidate(loaded, registry);
    const reloaded = await replaceRegistry({
      target,
      registry,
      verify: async (catalog) => {
        const match = catalog.conditionModules.modules.find((candidate) => candidate.id === id);
        if (!match || match.revision !== saved.revision) fail('REGISTRY_VERIFY_FAILED', '正式分支写入后校验失败', { status: 503 });
      }
    });
    return { saved: id, module: publicModule(saved), catalogFingerprint: makeCatalogFingerprint(reloaded) };
  });

  const deleteModule = ({ id, expectedCatalogFingerprint }) => withWrite(async () => {
    const moduleId = assertModuleId(id);
    const { loaded, target } = await context();
    const expected = assertFingerprint(expectedCatalogFingerprint);
    if (makeCatalogFingerprint(loaded) !== expected) fail('CATALOG_CONFLICT', '正式提示词库已被其他人更新，请刷新后再删除', { status: 409 });
    if (!loaded.conditionModules.modules.some((module) => module.id === moduleId)) fail('MODULE_NOT_FOUND', '要删除的已生效分支不存在', { status: 404 });
    const registry = structuredClone(loaded.conditionModules);
    registry.modules = registry.modules.filter((module) => module.id !== moduleId);
    validateCandidate(loaded, registry);
    const reloaded = await replaceRegistry({
      target,
      registry,
      verify: async (catalog) => {
        if (catalog.conditionModules.modules.some((module) => module.id === moduleId)) {
          fail('REGISTRY_VERIFY_FAILED', '正式分支删除后校验失败', { status: 503 });
        }
      }
    });
    return { deleted: moduleId, catalogFingerprint: makeCatalogFingerprint(reloaded) };
  });

  return Object.freeze({ validateModule, saveModule, deleteModule });
}
