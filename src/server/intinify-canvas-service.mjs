import { isIP } from 'node:net';

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export class IntinifyCanvasServiceError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'IntinifyCanvasServiceError';
    this.code = code;
  }
}

const privateIpLiteral = (hostname) => {
  const host = hostname.replace(/^\[|\]$/gu, '');
  if (!isIP(host)) return false;
  if (host === '::1' || host === '127.0.0.1') return true;
  if (isIP(host) === 4) {
    const parts = host.split('.').map(Number);
    return parts[0] === 10
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 169 && parts[1] === 254);
  }
  return /^(?:fc|fd|fe8|fe9|fea|feb)/iu.test(host.replaceAll(':', ''));
};

export const normalizeCanvasBaseUrl = (value) => {
  const raw = String(value ?? '').trim();
  let url;
  try { url = new URL(raw); } catch {
    throw new IntinifyCanvasServiceError('INVALID_BASE_URL', '服务地址必须是完整的 HTTP(S) 地址。');
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username || url.password || url.search || url.hash || raw.length > 2048) {
    throw new IntinifyCanvasServiceError('INVALID_BASE_URL', '服务地址格式不符合无限画板 API 要求。');
  }
  if (url.protocol === 'http:' && !privateIpLiteral(url.hostname)) {
    throw new IntinifyCanvasServiceError('INSECURE_BASE_URL', 'API 域名必须使用 HTTPS；HTTP 只允许私网或本机 IP。');
  }
  url.pathname = url.pathname.replace(/\/+$/gu, '').replace(/\/api\/v1$/iu, '') || '/';
  return url.href.replace(/\/$/u, '');
};

const readJson = async (response, label) => {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) {
    throw new IntinifyCanvasServiceError('RESPONSE_TOO_LARGE', `${label}响应过大。`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_JSON_BYTES) {
    throw new IntinifyCanvasServiceError('RESPONSE_TOO_LARGE', `${label}响应过大。`);
  }
  if (!response.ok) {
    throw new IntinifyCanvasServiceError('REMOTE_REQUEST_FAILED', `${label}失败（HTTP ${response.status}）。`);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch {
    throw new IntinifyCanvasServiceError('INVALID_REMOTE_JSON', `${label}没有返回有效 JSON。`);
  }
};

const collectionFrom = (value, keys) => {
  if (Array.isArray(value)) return value;
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key];
  return [];
};

const displayItems = (items, fallback) => items.flatMap((item) => {
  const id = String(item?.id ?? '').trim();
  if (!id || id.length > 512) return [];
  const name = String(item?.display_name ?? item?.name ?? fallback).trim().slice(0, 512) || fallback;
  return [{ id, name }];
});

const hasImageGeneration = (model) => {
  const capability = model?.capability;
  const values = Array.isArray(capability) ? capability : String(capability ?? '').split(',');
  return values.some((value) => String(value).trim() === 'image_generation');
};

export const createIntinifyCanvasService = ({ fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl 必须是函数');
  const request = async (url, init, label) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
      return await readJson(response, label);
    } catch (error) {
      if (error instanceof IntinifyCanvasServiceError) throw error;
      if (error?.name === 'AbortError') {
        throw new IntinifyCanvasServiceError('REMOTE_TIMEOUT', `${label}超时。`, error);
      }
      throw new IntinifyCanvasServiceError('REMOTE_UNAVAILABLE', `${label}无法连接。`, error);
    } finally {
      clearTimeout(timer);
    }
  };

  return Object.freeze({
    async loadCatalog({ baseUrl, username, password }) {
      const normalizedBaseUrl = normalizeCanvasBaseUrl(baseUrl);
      const account = String(username ?? '').trim();
      const secret = typeof password === 'string' ? password : '';
      if (!account || account.length > 160 || /[\u0000-\u001f\u007f]/u.test(account)) {
        throw new IntinifyCanvasServiceError('INVALID_USERNAME', '登录账号无效。');
      }
      if (!secret || secret.length > 4096 || /[\u0000\r\n]/u.test(secret)) {
        throw new IntinifyCanvasServiceError('INVALID_PASSWORD', '登录密码无效。');
      }
      const login = await request(`${normalizedBaseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', accept: 'application/json' },
        body: JSON.stringify({ username: account, password: secret })
      }, '登录');
      const token = String(login?.token ?? '').trim();
      if (!token || token.length > 16_384 || /[\u0000\r\n]/u.test(token)) {
        throw new IntinifyCanvasServiceError('INVALID_LOGIN_RESPONSE', '登录响应中没有有效 token。');
      }
      const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
      const [projectResponse, modelResponse] = await Promise.all([
        request(`${normalizedBaseUrl}/api/v1/projects?owner=me`, { method: 'GET', headers }, '读取项目'),
        request(`${normalizedBaseUrl}/api/v1/models`, { method: 'GET', headers }, '读取模型')
      ]);
      const projects = displayItems(collectionFrom(projectResponse, ['projects', 'data', 'items']), '未命名项目');
      const models = displayItems(
        collectionFrom(modelResponse, ['models', 'data', 'items']).filter(hasImageGeneration),
        '未命名模型'
      );
      if (!projects.length) throw new IntinifyCanvasServiceError('NO_PROJECTS', '当前账号没有可用项目。');
      if (!models.length) throw new IntinifyCanvasServiceError('NO_IMAGE_MODELS', '没有可用的生图模型。');
      return { baseUrl: normalizedBaseUrl, projects, models };
    }
  });
};
