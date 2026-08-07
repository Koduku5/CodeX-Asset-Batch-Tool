import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const REASONING_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh']);
const REASONING_EFFORT_SET = new Set(REASONING_EFFORTS);
const SETTINGS_VERSION = 1;
const MAX_SETTINGS_BYTES = 4096;

export const CODEX_MODEL_CHOICES = Object.freeze(['gpt-5.6-sol', 'gpt-5.6-terra']);
export const CODEX_REASONING_EFFORT_CHOICES = REASONING_EFFORTS;

export class CodexRuntimeConfigError extends Error {
  constructor(code, message, { status = 400, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CodexRuntimeConfigError';
    this.code = code;
    this.status = status;
  }
}

const configError = (code, message, options) => new CodexRuntimeConfigError(code, message, options);

const topLevelTomlString = (content, key, validator) => {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']\\s*(?:#.*)?$`, 'u');
  for (const line of String(content).split(/\r?\n/gu)) {
    if (/^\s*\[/u.test(line)) break;
    const match = line.match(pattern);
    const value = match?.[1]?.trim();
    if (value && validator(value)) return value;
  }
  return null;
};

const validModel = (value) => typeof value === 'string' && MODEL_NAME.test(value);
const validReasoningEffort = (value) => typeof value === 'string' && REASONING_EFFORT_SET.has(value);

export const normalizeCodexRuntimeSelection = (value, { nullable = false } = {}) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configError('INVALID_CODEX_RUNTIME_CONFIG', 'Codex 模型配置必须是对象');
  }
  const allowed = ['model', 'reasoningEffort'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw configError('INVALID_CODEX_RUNTIME_CONFIG', 'Codex 模型配置包含不允许的字段');
  }
  const model = value.model === null && nullable ? null : value.model;
  const reasoningEffort = value.reasoningEffort === null && nullable ? null : value.reasoningEffort;
  if ((model !== null && !validModel(model)) || (reasoningEffort !== null && !validReasoningEffort(reasoningEffort))) {
    throw configError('INVALID_CODEX_RUNTIME_CONFIG', 'Codex 模型或思考等级无效');
  }
  if (!nullable && (model === null || reasoningEffort === null)) {
    throw configError('INVALID_CODEX_RUNTIME_CONFIG', '请选择模型和思考等级');
  }
  return Object.freeze({ model, reasoningEffort });
};

const publicConfig = ({ model, reasoningEffort, source }) => Object.freeze({
  model,
  reasoningEffort,
  modelLabel: model ?? 'Codex 默认',
  reasoningEffortLabel: reasoningEffort ?? 'Codex 默认',
  source
});

export const codexThreadRuntimeOptions = (value) => {
  const selected = normalizeCodexRuntimeSelection({
    model: value?.model ?? null,
    reasoningEffort: value?.reasoningEffort ?? null
  }, { nullable: true });
  return Object.freeze({
    ...(selected.model ? { model: selected.model } : {}),
    ...(selected.reasoningEffort ? { modelReasoningEffort: selected.reasoningEffort } : {})
  });
};

export const readCodexRuntimeConfig = async ({
  environment = process.env,
  homeDirectory = homedir(),
  readConfig = (filename) => readFile(filename, 'utf8')
} = {}) => {
  const configuredHome = typeof environment.CODEX_HOME === 'string' && environment.CODEX_HOME.trim()
    ? environment.CODEX_HOME.trim()
    : join(homeDirectory, '.codex');
  let model = null;
  let reasoningEffort = null;
  try {
    const content = await readConfig(join(configuredHome, 'config.toml'));
    model = topLevelTomlString(content, 'model', validModel);
    reasoningEffort = topLevelTomlString(content, 'model_reasoning_effort', validReasoningEffort);
  } catch {
    // The bundled CLI will fall back to its own defaults when config.toml is absent or unreadable.
  }
  return publicConfig({ model, reasoningEffort, source: 'local-codex-config' });
};

const readStoredSelection = async (settingsPath) => {
  let info;
  try {
    info = await lstat(settingsPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw configError('CODEX_RUNTIME_CONFIG_UNAVAILABLE', 'Codex 模型配置暂时无法读取', { status: 503, cause: error });
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size <= 0 || info.size > MAX_SETTINGS_BYTES) {
    throw configError('CODEX_RUNTIME_CONFIG_UNSAFE', 'Codex 模型配置文件不安全', { status: 409 });
  }
  let document;
  try {
    document = JSON.parse(await readFile(settingsPath, 'utf8'));
  } catch (error) {
    throw configError('CODEX_RUNTIME_CONFIG_INVALID', 'Codex 模型配置文件无效', { status: 409, cause: error });
  }
  const keys = document && typeof document === 'object' && !Array.isArray(document)
    ? Object.keys(document).sort()
    : [];
  if (keys.join(',') !== 'model,reasoningEffort,version' || document.version !== SETTINGS_VERSION) {
    throw configError('CODEX_RUNTIME_CONFIG_INVALID', 'Codex 模型配置文件版本或字段无效', { status: 409 });
  }
  return normalizeCodexRuntimeSelection({
    model: document.model,
    reasoningEffort: document.reasoningEffort
  });
};

export const createCodexRuntimeConfigStore = ({
  softwareRoot,
  readFallback = readCodexRuntimeConfig
} = {}) => {
  if (typeof softwareRoot !== 'string' || !isAbsolute(softwareRoot) || typeof readFallback !== 'function') {
    throw new TypeError('softwareRoot must be an absolute path and readFallback must be a function');
  }
  const root = resolve(softwareRoot);
  const settingsRoot = join(root, 'settings');
  const settingsPath = join(settingsRoot, 'codex-runtime-config.json');
  let mutations = Promise.resolve();

  const get = async () => {
    await mutations;
    const selected = await readStoredSelection(settingsPath);
    if (!selected) return readFallback();
    return publicConfig({ ...selected, source: 'software-settings' });
  };

  const writeSelection = async (input) => {
    const selected = normalizeCodexRuntimeSelection(input);
    await mkdir(settingsRoot, { recursive: true });
    const [rootInfo, settingsInfo] = await Promise.all([lstat(root), lstat(settingsRoot)]);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()
      || settingsInfo.isSymbolicLink() || !settingsInfo.isDirectory()) {
      throw configError('CODEX_RUNTIME_CONFIG_UNSAFE', 'Codex 模型配置目录不安全', { status: 409 });
    }
    const temporaryPath = join(settingsRoot, `.codex-runtime-${randomUUID()}.tmp`);
    const backupPath = join(settingsRoot, `.codex-runtime-${randomUUID()}.bak`);
    let hasBackup = false;
    try {
      await writeFile(temporaryPath, `${JSON.stringify({ version: SETTINGS_VERSION, ...selected }, null, 2)}\n`, {
        encoding: 'utf8', flag: 'wx', mode: 0o600
      });
      let current = null;
      try {
        current = await lstat(settingsPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (current) {
        if (current.isSymbolicLink() || !current.isFile()) {
          throw configError('CODEX_RUNTIME_CONFIG_UNSAFE', 'Codex 模型配置文件不安全', { status: 409 });
        }
        await rename(settingsPath, backupPath);
        hasBackup = true;
      }
      await rename(temporaryPath, settingsPath);
      if (hasBackup) await rm(backupPath, { force: true });
      return publicConfig({ ...selected, source: 'software-settings' });
    } catch (error) {
      if (hasBackup) {
        try {
          await lstat(settingsPath);
        } catch (targetError) {
          if (targetError?.code === 'ENOENT') await rename(backupPath, settingsPath).catch(() => {});
        }
      }
      if (error instanceof CodexRuntimeConfigError) throw error;
      throw configError('CODEX_RUNTIME_CONFIG_WRITE_FAILED', 'Codex 模型配置保存失败', { status: 503, cause: error });
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
      await rm(backupPath, { force: true }).catch(() => {});
    }
  };

  const update = (input) => {
    const operation = mutations.then(() => writeSelection(input));
    mutations = operation.catch(() => {});
    return operation;
  };

  return Object.freeze({ get, update, settingsPath });
};

export const readCodexModelLabel = async (options) => {
  const config = await readCodexRuntimeConfig(options);
  return config.model ?? 'Codex 默认模型';
};
