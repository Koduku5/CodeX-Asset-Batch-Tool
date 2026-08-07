import { spawn } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';

import { createPrototypeServer } from './server.mjs';
import { createIntinifyCanvasService } from './intinify-canvas-service.mjs';

const READY_TYPE = 'ka-prompt-studio-ready';
const READY_PROTOCOL_VERSION = 1;

const requiredPath = (name) => {
  const value = String(process.env[name] ?? '').trim();
  if (!value || !isAbsolute(value)) throw new Error(`${name} 必须是明确的绝对路径`);
  return resolve(value);
};

const requiredToken = (name) => {
  const value = String(process.env[name] ?? '');
  if (Buffer.byteLength(value, 'utf8') < 32 || Buffer.byteLength(value, 'utf8') > 256) {
    throw new Error(`${name} 必须是 32 到 256 字节的随机令牌`);
  }
  return value;
};

const softwareRoot = requiredPath('KA_DESKTOP_SOFTWARE_ROOT');
const engineRoot = requiredPath('KA_DESKTOP_ENGINE_ROOT');
const skillsRoot = requiredPath('KA_DESKTOP_SKILLS_ROOT');
const staticDirectory = process.env.KA_DESKTOP_STATIC_ROOT
  ? requiredPath('KA_DESKTOP_STATIC_ROOT')
  : undefined;
const capabilityToken = requiredToken('KA_DESKTOP_TOKEN');
const nativeCapabilityToken = requiredToken('KA_DESKTOP_NATIVE_TOKEN');

const SAFE_CHILD_ENVIRONMENT_KEYS = Object.freeze([
  'ALLUSERSPROFILE', 'APPDATA', 'COMSPEC', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA',
  'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
  'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMDRIVE', 'SYSTEMROOT',
  'TEMP', 'TMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'
]);

const safeChildEnvironment = () => Object.fromEntries(
  SAFE_CHILD_ENVIRONMENT_KEYS.flatMap((name) => {
    const matched = Object.keys(process.env).find((key) => key.toUpperCase() === name);
    return matched && typeof process.env[matched] === 'string' ? [[matched, process.env[matched]]] : [];
  })
);

const openProjectFolder = async (projectRoot) => {
  if (process.platform !== 'win32') throw new Error('当前系统不支持打开项目文件夹');
  const child = spawn('explorer.exe', [projectRoot], {
    detached: true,
    stdio: 'ignore'
  });
  await new Promise((resolveSpawn, rejectSpawn) => {
    child.once('spawn', resolveSpawn);
    child.once('error', rejectSpawn);
  });
  child.unref();
};

const openApiSettings = async ({ projectRoot, scriptPath, configuration }) => {
  if (process.platform !== 'win32') throw new Error('当前系统不支持打开无限画板 API 配置');
  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath
  ], {
    cwd: projectRoot,
    detached: true,
    stdio: 'ignore',
    env: {
      ...safeChildEnvironment(),
      KA_API_BASE_URL: configuration.baseUrl,
      KA_API_USERNAME: configuration.username,
      KA_API_PASSWORD: configuration.password,
      KA_API_MAX_WORKERS: String(configuration.maxWorkers),
      KA_API_ASPECT_RATIO: configuration.aspectRatio,
      KA_API_IMAGE_SIZE: configuration.imageSize
    }
  });
  await new Promise((resolveSpawn, rejectSpawn) => {
    child.once('spawn', resolveSpawn);
    child.once('error', rejectSpawn);
  });
  child.unref();
};

const canvasService = createIntinifyCanvasService();

const startApiBatch = async ({ projectRoot, scriptPath, configuration }) => {
  if (process.platform !== 'win32') throw new Error('当前系统不支持无限画板 API 批量任务');
  const redrawConfiguration = configuration.operation === 'directory_redraw'
    ? Buffer.from(JSON.stringify({
      sourceRoot: configuration.sourceRoot,
      outputRoot: configuration.outputRoot,
      prompt: configuration.redrawPrompt
    }), 'utf8').toString('base64')
    : '';
  const promptTemplates = configuration.operation === 'generate'
    ? Buffer.from(JSON.stringify(configuration.promptTemplates), 'utf8').toString('base64')
    : '';
  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-Headless',
    '-Operation',
    configuration.operation
  ], {
    cwd: projectRoot,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...safeChildEnvironment(),
      KA_API_BASE_URL: configuration.baseUrl,
      KA_API_USERNAME: configuration.username,
      KA_API_PASSWORD: configuration.password,
      KA_API_PROJECT_ID: configuration.remoteProjectId,
      KA_API_MODEL_ID: configuration.modelId,
      KA_API_MAX_WORKERS: String(configuration.maxWorkers),
      KA_API_ASPECT_RATIO: configuration.aspectRatio,
      KA_API_IMAGE_SIZE: configuration.imageSize,
      ...(promptTemplates ? { KA_API_PROMPT_TEMPLATES_B64: promptTemplates } : {}),
      ...(redrawConfiguration ? { KA_REDRAW_CONFIG_B64: redrawConfiguration } : {})
    }
  });
  await new Promise((resolveSpawn, rejectSpawn) => {
    child.once('spawn', resolveSpawn);
    child.once('error', rejectSpawn);
  });
  child.unref();
};

let exiting = false;
const exitCleanly = () => {
  if (exiting) return;
  exiting = true;
  process.exitCode = 0;
  setImmediate(() => process.exit(0));
};

const server = createPrototypeServer({
  desktopMode: true,
  capabilityToken,
  nativeCapabilityToken,
  softwareMode: true,
  softwareRoot,
  engineRoot,
  skillsRoot,
  ...(staticDirectory ? { staticDirectory } : {}),
  desktopOpenDirectory: openProjectFolder,
  desktopOpenApiSettings: openApiSettings,
  desktopLoadApiCatalog: (configuration) => canvasService.loadCatalog(configuration),
  desktopStartApiBatch: startApiBatch,
  onShutdown: exitCleanly
});

server.on('error', (error) => {
  const payload = JSON.stringify({ type: 'ka-prompt-studio-error', code: error?.code || 'SERVER_ERROR' });
  process.stderr.write(`${payload.slice(0, 512)}\n`);
  process.exitCode = 1;
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('桌面服务没有获得本地端口');
  const ready = JSON.stringify({
    type: READY_TYPE,
    protocolVersion: READY_PROTOCOL_VERSION,
    origin: `http://127.0.0.1:${address.port}`,
    pid: process.pid
  });
  if (Buffer.byteLength(ready, 'utf8') > 512) throw new Error('桌面服务 ready 消息超出限制');
  process.stdout.write(`${ready}\n`);
});

const closeForSignal = () => {
  if (exiting) return;
  exiting = true;
  const forceExit = setTimeout(() => process.exit(0), 1500);
  forceExit.unref();
  void Promise.resolve(server.shutdownTasks?.()).finally(() => {
    server.close(() => process.exit(0));
    server.closeIdleConnections?.();
  });
};

process.once('SIGINT', closeForSignal);
process.once('SIGTERM', closeForSignal);
