using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace KA.PromptStudio.Desktop;

internal sealed partial class DesktopRpcBridge : IDisposable
{
    private const int MaxJsonTextBytes = 4 * 1024 * 1024;
    private const int MaxControlMessageBytes = 16 * 1024;
    private const int MaxJsonExportMessageBytes = (MaxJsonTextBytes * 2) + (64 * 1024);
    private const int MaxResponseBytes = 1024 * 1024;
    private const int MaxSuggestedNameLength = 160;
    private readonly DesktopSidecar _sidecar;
    private readonly CoreWebView2 _webView;
    private readonly Func<bool, double?, object> _setStudioDrawerOpen;
    private readonly Func<string, string, Task<object>> _saveJsonFile;
    private readonly Dictionary<string, (string Purpose, string Path)> _apiDirectorySelections = new(StringComparer.Ordinal);
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    public DesktopRpcBridge(
        DesktopSidecar sidecar,
        CoreWebView2 webView,
        Func<bool, double?, object> setStudioDrawerOpen,
        Func<string, string, Task<object>> saveJsonFile)
    {
        _sidecar = sidecar;
        _webView = webView;
        _setStudioDrawerOpen = setStudioDrawerOpen;
        _saveJsonFile = saveJsonFile;
    }

    public async Task HandleAsync(string message)
    {
        JsonElement id = NullId();
        try
        {
            if (string.IsNullOrWhiteSpace(message))
                throw new RpcException(-32600, "桌面消息无效或过大。");
            int messageBytes;
            try
            {
                messageBytes = StrictUtf8.GetByteCount(message);
            }
            catch (EncoderFallbackException)
            {
                throw new RpcException(-32600, "桌面消息包含无效字符。");
            }
            if (messageBytes > MaxJsonExportMessageBytes)
                throw new RpcException(-32600, "桌面消息无效或过大。");
            using var document = JsonDocument.Parse(message, new JsonDocumentOptions { MaxDepth = 8 });
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw new RpcException(-32600, "桌面消息必须是对象。");
            foreach (var property in root.EnumerateObject())
            {
                if (property.Name is not ("jsonrpc" or "id" or "method" or "params"))
                    throw new RpcException(-32600, "桌面消息包含未知字段。");
            }
            if (!root.TryGetProperty("jsonrpc", out var version) || version.GetString() != "2.0")
                throw new RpcException(-32600, "仅支持 JSON-RPC 2.0。");
            if (!root.TryGetProperty("id", out var idValue)
                || idValue.ValueKind is not (JsonValueKind.String or JsonValueKind.Number))
                throw new RpcException(-32600, "桌面消息需要字符串或数字 id。");
            id = idValue.Clone();
            if (!root.TryGetProperty("method", out var methodValue) || methodValue.ValueKind != JsonValueKind.String)
                throw new RpcException(-32600, "桌面消息缺少 method。");
            var method = methodValue.GetString();
            if (method is not ("saveJsonFile" or "startApiBatch") && messageBytes > MaxControlMessageBytes)
                throw new RpcException(-32600, "普通桌面消息不能超过 16 KiB。");
            object result = method switch
            {
                "selectProject" => await SelectProjectAsync(root).ConfigureAwait(true),
                "openProjectDirectory" => await OpenProjectDirectoryAsync(root).ConfigureAwait(true),
                "openApiBatchSettings" => await OpenApiBatchSettingsAsync(root).ConfigureAwait(true),
                "loadApiCatalog" => await LoadApiCatalogAsync(root).ConfigureAwait(true),
                "selectApiDirectory" => SelectApiDirectory(root),
                "startApiBatch" => await StartApiBatchAsync(root).ConfigureAwait(true),
                "prepareBuiltinImagegen" => await PrepareBuiltinImagegenAsync(root).ConfigureAwait(true),
                "authorizeCodex" => AuthorizeCodex(root),
                "setStudioDrawerOpen" => SetStudioDrawerOpen(root),
                "saveJsonFile" => await SaveJsonFileAsync(root).ConfigureAwait(true),
                _ => throw new RpcException(-32601, "不支持此桌面操作。")
            };
            Post(new RpcSuccess("2.0", id, result));
        }
        catch (RpcException error)
        {
            Post(new RpcFailure("2.0", id, new RpcError(error.Code, error.Message)));
        }
        catch
        {
            Post(new RpcFailure("2.0", id, new RpcError(-32603, "桌面操作暂时无法完成。")));
        }
    }

    private async Task<object> SelectProjectAsync(JsonElement root)
    {
        var parameters = ReadParameters(root);
        foreach (var property in parameters.EnumerateObject())
        {
            if (property.Name is not ("projectId" or "expectedRevision"))
                throw new RpcException(-32602, "selectProject params 包含未知字段。");
        }
        var projectId = ReadProjectId(parameters);
        if (!parameters.TryGetProperty("expectedRevision", out var revisionValue)
            || revisionValue.ValueKind != JsonValueKind.Number
            || !revisionValue.TryGetInt32(out var expectedRevision)
            || expectedRevision < 0
            || expectedRevision == int.MaxValue)
            throw new RpcException(-32602, "expectedRevision 必须是可递增的非负整数。");
        await EnsureProjectExistsAsync(projectId).ConfigureAwait(false);
        return new { projectId, selectionRevision = expectedRevision + 1 };
    }

    private async Task<object> OpenProjectDirectoryAsync(JsonElement root)
    {
        var parameters = ReadParameters(root);
        foreach (var property in parameters.EnumerateObject())
        {
            if (property.Name is not ("projectId" or "kind"))
                throw new RpcException(-32602, "openProjectDirectory params 包含未知字段。");
        }
        var projectId = ReadProjectId(parameters);
        if (!parameters.TryGetProperty("kind", out var kindValue) || kindValue.ValueKind != JsonValueKind.String)
            throw new RpcException(-32602, "缺少目录类型。");
        var kind = kindValue.GetString();
        if (kind is not ("project" or "output")) throw new RpcException(-32602, "目录类型无效。");
        await EnsureProjectExistsAsync(projectId).ConfigureAwait(false);
        using var request = _sidecar.CreateRequest(
            HttpMethod.Post,
            $"/desktop/projects/{Uri.EscapeDataString(projectId)}/open-directory/{kind}");
        using var response = await _sidecar.HttpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead)
            .ConfigureAwait(false);
        if (!response.IsSuccessStatusCode) throw new RpcException(-32002, "项目文件夹暂时无法打开。");
        return new { projectId, kind, opened = true };
    }

    private async Task<object> PrepareBuiltinImagegenAsync(JsonElement root)
    {
        var parameters = ReadParameters(root);
        foreach (var property in parameters.EnumerateObject())
        {
            if (property.Name != "projectId")
                throw new RpcException(-32602, "prepareBuiltinImagegen params 包含未知字段。");
        }
        var projectId = ReadProjectId(parameters);
        await EnsureProjectExistsAsync(projectId);
        using var request = _sidecar.CreateNativeRequest(
            HttpMethod.Post,
            $"/desktop/projects/{Uri.EscapeDataString(projectId)}/prepare-imagegen-handoff");
        using var response = await _sidecar.HttpClient.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead);
        if (!response.IsSuccessStatusCode)
            throw new RpcException(-32005, "当前项目尚不能交给 Codex 内置 ImageGen。");
        var bytes = await response.Content.ReadAsByteArrayAsync();
        if (bytes.Length is < 1 or > MaxResponseBytes)
            throw new RpcException(-32005, "内置 ImageGen 交接响应无效。");
        using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 8 });
        var responseRoot = document.RootElement;
        if (!responseRoot.TryGetProperty("ok", out var ok)
            || ok.ValueKind != JsonValueKind.True
            || !responseRoot.TryGetProperty("data", out var data)
            || data.ValueKind != JsonValueKind.Object
            || !data.TryGetProperty("projectId", out var responseProjectId)
            || responseProjectId.GetString() != projectId
            || !data.TryGetProperty("handoffText", out var textValue)
            || textValue.ValueKind != JsonValueKind.String)
            throw new RpcException(-32005, "内置 ImageGen 交接响应格式无效。");
        var handoffText = textValue.GetString() ?? string.Empty;
        if (handoffText.Length is < 1 or > 256 * 1024 || handoffText.IndexOf('\0') >= 0)
            throw new RpcException(-32005, "内置 ImageGen 交接内容无效。");
        Clipboard.SetText(handoffText, TextDataFormat.UnicodeText);
        var codexOpened = TryOpenCodexApp();
        return new { projectId, copied = true, codexOpened };
    }

}
