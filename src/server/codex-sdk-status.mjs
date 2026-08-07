import { spawn as nodeSpawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_STATUS_OUTPUT = 4096;
const SAFE_ENVIRONMENT_KEYS = Object.freeze([
  'ALLUSERSPROFILE', 'APPDATA', 'CODEX_CA_CERTIFICATE', 'CODEX_HOME', 'COMSPEC',
  'HOMEDRIVE', 'HOMEPATH', 'HTTPS_PROXY', 'HTTP_PROXY', 'LOCALAPPDATA', 'NO_PROXY',
  'PATH', 'PATHEXT', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'SSL_CERT_FILE', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR'
]);

export class CodexSdkStatusError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = 'CodexSdkStatusError';
    this.code = code;
    this.cause = cause;
  }
}

const childEnvironment = (environment) => Object.fromEntries(
  SAFE_ENVIRONMENT_KEYS.flatMap((name) => {
    const matched = Object.keys(environment).find((key) => key.toUpperCase() === name);
    return matched && typeof environment[matched] === 'string' ? [[matched, environment[matched]]] : [];
  })
);

const publicStatus = ({ connected, sdkAvailable, message, checkedAt }) => Object.freeze({
  connected,
  sdkAvailable,
  authorization: connected ? 'connected' : 'not_connected',
  message,
  checkedAt
});

const collectLoginStatus = ({ spawnImpl, nodeExecutable, cliPath, timeoutMs, environment }) => new Promise((resolveStatus) => {
  let child;
  try {
    child = spawnImpl(nodeExecutable, [cliPath, 'login', 'status'], {
      env: environment,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch {
    resolveStatus({ exitCode: null, output: '' });
    return;
  }
  if (!child || typeof child.once !== 'function') {
    resolveStatus({ exitCode: null, output: '' });
    return;
  }
  let output = '';
  const append = (chunk) => {
    if (output.length >= MAX_STATUS_OUTPUT) return;
    output += String(chunk ?? '').slice(0, MAX_STATUS_OUTPUT - output.length);
  };
  child.stdout?.setEncoding?.('utf8');
  child.stderr?.setEncoding?.('utf8');
  child.stdout?.on?.('data', append);
  child.stderr?.on?.('data', append);
  let settled = false;
  const finish = (exitCode) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolveStatus({ exitCode: Number.isInteger(exitCode) ? exitCode : null, output });
  };
  const timer = setTimeout(() => {
    try { child.kill?.('SIGTERM'); } catch { /* timeout result remains disconnected */ }
    finish(null);
  }, timeoutMs);
  child.once('error', () => finish(null));
  child.once('close', (code) => finish(code));
});

export function createCodexSdkStatusService({
  spawnImpl = nodeSpawn,
  loadSdk = () => import('@openai/codex-sdk'),
  resolveCliPath = () => require.resolve('@openai/codex/bin/codex.js'),
  nodeExecutable = process.execPath,
  environment = process.env,
  now = () => new Date(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cacheMs = 3000
} = {}) {
  if (typeof spawnImpl !== 'function' || typeof loadSdk !== 'function' || typeof resolveCliPath !== 'function') {
    throw new TypeError('Codex status dependencies must be functions');
  }
  let cached = null;
  let cachedAt = 0;
  let pending = null;
  let loginChild = null;
  const safeEnvironment = childEnvironment(environment);

  const invalidate = () => {
    cached = null;
    cachedAt = 0;
  };

  const inspect = async () => {
    const checkedAt = now().toISOString();
    try {
      const sdk = await loadSdk();
      if (typeof sdk?.Codex !== 'function') throw new Error('Codex export missing');
      new sdk.Codex();
      const cliPath = resolveCliPath();
      const result = await collectLoginStatus({
        spawnImpl,
        nodeExecutable,
        cliPath,
        timeoutMs,
        environment: safeEnvironment
      });
      const connected = result.exitCode === 0 && /(?:^|\n)\s*logged in\b/iu.test(result.output);
      return publicStatus({
        connected,
        sdkAvailable: true,
        message: connected ? '已连接 Codex SDK' : '未连接 Codex SDK',
        checkedAt
      });
    } catch {
      return publicStatus({
        connected: false,
        sdkAvailable: false,
        message: 'Codex SDK 未安装或无法载入',
        checkedAt
      });
    }
  };

  const getStatus = async ({ force = false } = {}) => {
    const timestamp = Date.now();
    if (!force && cached && timestamp - cachedAt < cacheMs) return cached;
    if (pending) return pending;
    pending = inspect().then((status) => {
      cached = status;
      cachedAt = Date.now();
      return status;
    }).finally(() => { pending = null; });
    return pending;
  };

  const startLogin = async () => {
    if (loginChild) {
      return Object.freeze({ started: false, alreadyConnected: false, loginInProgress: true });
    }
    const current = await getStatus({ force: true });
    if (current.connected) {
      return Object.freeze({ started: false, alreadyConnected: true, loginInProgress: false });
    }
    let cliPath;
    let child;
    try {
      cliPath = resolveCliPath();
      child = spawnImpl(nodeExecutable, [cliPath, 'login'], {
        env: safeEnvironment,
        shell: false,
        windowsHide: true,
        stdio: 'ignore'
      });
    } catch (error) {
      throw new CodexSdkStatusError('CODEX_LOGIN_START_FAILED', '无法启动内置 Codex CLI 登录', error);
    }
    if (!child || typeof child.once !== 'function') {
      throw new CodexSdkStatusError('CODEX_LOGIN_START_FAILED', '无法启动内置 Codex CLI 登录');
    }
    loginChild = child;
    return new Promise((resolveLogin, rejectLogin) => {
      let started = false;
      const clear = () => {
        if (loginChild === child) loginChild = null;
        invalidate();
      };
      child.once('spawn', () => {
        started = true;
        resolveLogin(Object.freeze({ started: true, alreadyConnected: false, loginInProgress: true }));
      });
      child.once('error', (error) => {
        clear();
        if (!started) rejectLogin(new CodexSdkStatusError(
          'CODEX_LOGIN_START_FAILED',
          '无法启动内置 Codex CLI 登录',
          error
        ));
      });
      child.once('close', () => {
        clear();
        if (!started) rejectLogin(new CodexSdkStatusError(
          'CODEX_LOGIN_START_FAILED',
          '内置 Codex CLI 登录未能启动'
        ));
      });
    });
  };

  return Object.freeze({ getStatus, startLogin });
}
