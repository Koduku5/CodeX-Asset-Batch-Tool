namespace KA.PromptStudio.Desktop;

internal sealed partial class MainWindow
{
    private const string DesktopBridgeScript = """
        (() => {
          const pending = new Map();
          let sequence = 0;
          window.chrome.webview.addEventListener('message', event => {
            const message = event.data;
            if (!message || message.jsonrpc !== '2.0' || !pending.has(message.id)) return;
            const waiter = pending.get(message.id);
            pending.delete(message.id);
            clearTimeout(waiter.timer);
            if (message.error) {
              const error = new Error(message.error.message || '桌面操作失败');
              error.code = message.error.code;
              waiter.reject(error);
            } else waiter.resolve(message.result);
          });
          const call = (method, params = {}, timeoutMs = 15000) => new Promise((resolve, reject) => {
            const id = `desktop-${Date.now()}-${++sequence}`;
            const timer = setTimeout(() => {
              pending.delete(id);
              reject(new Error('桌面操作超时'));
            }, timeoutMs);
            pending.set(id, { resolve, reject, timer });
            window.chrome.webview.postMessage({ jsonrpc: '2.0', id, method, params });
          });
          Object.defineProperty(window, 'kaDesktop', {
            value: Object.freeze({ call }), configurable: false, enumerable: false, writable: false
          });
          Object.defineProperty(window, 'kaDesktopBridge', {
            value: Object.freeze({
              selectProject: input => call('selectProject', input).then(
                data => ({ ok: true, data }),
                error => ({ ok: false, error: { code: 'DESKTOP_BRIDGE_ERROR', message: error.message || '桌面操作失败' } })
              ),
              openProjectDirectory: input => call('openProjectDirectory', input).then(
                data => ({ ok: true, data }),
                error => ({ ok: false, error: { code: 'DESKTOP_BRIDGE_ERROR', message: error.message || '桌面操作失败' } })
              ),
              openApiBatchSettings: input => call('openApiBatchSettings', input).then(
                data => ({ ok: true, data }),
                error => ({ ok: false, error: { code: 'DESKTOP_BRIDGE_ERROR', message: error.message || '无限画板 API 配置窗口打开失败' } })
              ),
              loadApiCatalog: input => call('loadApiCatalog', input, 60000).then(
                data => ({ ok: true, data }),
                error => ({ ok: false, error: { code: 'DESKTOP_BRIDGE_ERROR', message: error.message || '无限画板登录失败' } })
              ),
              selectApiDirectory: input => call('selectApiDirectory', input, 300000).then(
                data => ({ ok: true, data }),
                error => ({ ok: false, error: { code: 'DESKTOP_BRIDGE_ERROR', message: error.message || '文件夹选择失败' } })
              ),
              startApiBatch: input => call('startApiBatch', input, 60000).then(
                data => ({ ok: true, data }),
                error => ({ ok: false, error: { code: 'DESKTOP_BRIDGE_ERROR', message: error.message || '无限画板任务启动失败' } })
              ),
              prepareBuiltinImagegen: input => call('prepareBuiltinImagegen', input).then(
                data => ({ ok: true, data }),
                error => ({ ok: false, error: { code: 'DESKTOP_BRIDGE_ERROR', message: error.message || '内置 ImageGen 交接失败' } })
              ),
              authorizeCodex: () => call('authorizeCodex', {}).then(
                data => ({ ok: true, data }),
                error => ({ ok: false, error: { code: 'DESKTOP_BRIDGE_ERROR', message: error.message || 'Codex 授权界面打开失败' } })
              ),
              setStudioDrawerOpen: input => call('setStudioDrawerOpen', input).then(
                data => ({ ok: true, data }),
                error => ({ ok: false, error: { code: 'DESKTOP_BRIDGE_ERROR', message: error.message || '桌面窗口调整失败' } })
              ),
              saveJsonFile: input => call('saveJsonFile', input, 300000).then(
                data => ({ ok: true, data }),
                error => ({ ok: false, error: { code: 'DESKTOP_BRIDGE_ERROR', message: error.message || 'JSON 文件导出失败' } })
              )
            }),
            configurable: false, enumerable: false, writable: false
          });
        })();
        """;
}

