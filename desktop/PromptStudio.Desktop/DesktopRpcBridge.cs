using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
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

    private async Task<object> OpenApiBatchSettingsAsync(JsonElement root)
    {
        var parameters = ReadParameters(root);
        foreach (var property in parameters.EnumerateObject())
        {
            if (property.Name is not ("projectId" or "baseUrl" or "username" or "password"
                or "maxWorkers" or "aspectRatio" or "imageSize"))
                throw new RpcException(-32602, "openApiBatchSettings params 包含未知字段。");
        }
        var projectId = ReadProjectId(parameters);
        var baseUrl = ReadApiText(parameters, "baseUrl", 2048, allowWhitespace: false);
        var username = ReadApiText(parameters, "username", 160, allowWhitespace: false);
        var password = ReadApiText(parameters, "password", 4096, allowWhitespace: true);
        var aspectRatio = ReadApiText(parameters, "aspectRatio", 8, allowWhitespace: false);
        var imageSize = ReadApiText(parameters, "imageSize", 8, allowWhitespace: false);
        if (!parameters.TryGetProperty("maxWorkers", out var workersValue)
            || workersValue.ValueKind != JsonValueKind.Number
            || !workersValue.TryGetInt32(out var maxWorkers)
            || maxWorkers is < 1 or > 16)
            throw new RpcException(-32602, "maxWorkers 必须是 1–16。");
        await EnsureProjectExistsAsync(projectId).ConfigureAwait(false);
        using var request = _sidecar.CreateNativeRequest(
            HttpMethod.Post,
            $"/desktop/projects/{Uri.EscapeDataString(projectId)}/open-api-settings");
        request.Content = new StringContent(JsonSerializer.Serialize(new
        {
            baseUrl,
            username,
            password,
            maxWorkers,
            aspectRatio,
            imageSize
        }, JsonOptions), Encoding.UTF8, "application/json");
        using var response = await _sidecar.HttpClient.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
            throw new RpcException(-32006, "无限画板 API 配置窗口暂时无法打开。");
        return new { projectId, opened = true };
    }

    private async Task<object> LoadApiCatalogAsync(JsonElement root)
    {
        var parameters = ReadParameters(root);
        foreach (var property in parameters.EnumerateObject())
        {
            if (property.Name is not ("projectId" or "baseUrl" or "username" or "password"))
                throw new RpcException(-32602, "loadApiCatalog params 包含未知字段。");
        }
        var projectId = ReadProjectId(parameters);
        var baseUrl = ReadApiText(parameters, "baseUrl", 2048, allowWhitespace: false);
        var username = ReadApiText(parameters, "username", 160, allowWhitespace: false);
        var password = ReadApiText(parameters, "password", 4096, allowWhitespace: true);
        await EnsureProjectExistsAsync(projectId).ConfigureAwait(false);
        using var request = _sidecar.CreateNativeRequest(
            HttpMethod.Post,
            $"/desktop/projects/{Uri.EscapeDataString(projectId)}/api-catalog");
        request.Content = new StringContent(JsonSerializer.Serialize(new
        {
            baseUrl,
            username,
            password
        }, JsonOptions), Encoding.UTF8, "application/json");
        using var response = await _sidecar.HttpClient.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false);
        var bytes = await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
        if (bytes.Length is < 1 or > MaxResponseBytes)
            throw new RpcException(-32006, "无限画板项目与模型响应无效。");
        using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 12 });
        if (!response.IsSuccessStatusCode
            || !document.RootElement.TryGetProperty("ok", out var ok)
            || ok.ValueKind != JsonValueKind.True
            || !document.RootElement.TryGetProperty("data", out var data)
            || data.ValueKind != JsonValueKind.Object)
        {
            var message = document.RootElement.TryGetProperty("error", out var error)
                && error.TryGetProperty("message", out var messageValue)
                ? messageValue.GetString()
                : null;
            throw new RpcException(-32006, message ?? "无限画板登录或项目模型读取失败。");
        }
        return data.Clone();
    }

    private object SelectApiDirectory(JsonElement root)
    {
        var parameters = ReadParameters(root);
        foreach (var property in parameters.EnumerateObject())
        {
            if (property.Name != "purpose")
                throw new RpcException(-32602, "selectApiDirectory params 包含未知字段。");
        }
        var purpose = ReadApiText(parameters, "purpose", 16, allowWhitespace: false);
        if (purpose is not ("source" or "output"))
            throw new RpcException(-32602, "文件夹用途无效。");
        var picker = new Microsoft.Win32.OpenFolderDialog
        {
            Title = purpose == "source" ? "选择原图文件夹" : "选择结果保存文件夹",
            Multiselect = false
        };
        if (picker.ShowDialog() != true || string.IsNullOrWhiteSpace(picker.FolderName))
            return new { canceled = true };
        var token = Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture);
        _apiDirectorySelections[token] = (purpose, Path.GetFullPath(picker.FolderName));
        return new
        {
            canceled = false,
            selectionToken = token,
            name = new DirectoryInfo(picker.FolderName).Name
        };
    }

    private async Task<object> StartApiBatchAsync(JsonElement root)
    {
        var parameters = ReadParameters(root);
        var allowed = new HashSet<string>(StringComparer.Ordinal)
        {
            "projectId", "baseUrl", "username", "password", "remoteProjectId", "modelId",
            "maxWorkers", "aspectRatio", "imageSize", "operation", "sourceSelectionToken",
            "outputSelectionToken", "redrawPrompt", "promptTemplates"
        };
        foreach (var property in parameters.EnumerateObject())
        {
            if (!allowed.Contains(property.Name))
                throw new RpcException(-32602, "startApiBatch params 包含未知字段。");
        }
        var projectId = ReadProjectId(parameters);
        var baseUrl = ReadApiText(parameters, "baseUrl", 2048, allowWhitespace: false);
        var username = ReadApiText(parameters, "username", 160, allowWhitespace: false);
        var password = ReadApiText(parameters, "password", 4096, allowWhitespace: true);
        var remoteProjectId = ReadApiText(parameters, "remoteProjectId", 512, allowWhitespace: false);
        var modelId = ReadApiText(parameters, "modelId", 512, allowWhitespace: false);
        var aspectRatio = ReadApiText(parameters, "aspectRatio", 8, allowWhitespace: false);
        var imageSize = ReadApiText(parameters, "imageSize", 8, allowWhitespace: false);
        var operation = ReadApiText(parameters, "operation", 32, allowWhitespace: false);
        if (operation is not ("generate" or "directory_redraw"))
            throw new RpcException(-32602, "API 任务类型无效。");
        if (!parameters.TryGetProperty("maxWorkers", out var workersValue)
            || workersValue.ValueKind != JsonValueKind.Number
            || !workersValue.TryGetInt32(out var maxWorkers)
            || maxWorkers is < 1 or > 16)
            throw new RpcException(-32602, "maxWorkers 必须是 1–16。");

        string sourceRoot = string.Empty;
        string outputRoot = string.Empty;
        string redrawPrompt = string.Empty;
        Dictionary<string, string>? promptTemplates = null;
        string? sourceToken = null;
        string? outputToken = null;
        if (operation == "directory_redraw")
        {
            sourceToken = ReadApiText(parameters, "sourceSelectionToken", 64, allowWhitespace: false);
            outputToken = ReadApiText(parameters, "outputSelectionToken", 64, allowWhitespace: false);
            redrawPrompt = ReadApiText(parameters, "redrawPrompt", 64 * 1024, allowWhitespace: true);
            if (!_apiDirectorySelections.TryGetValue(sourceToken, out var sourceSelection)
                || sourceSelection.Purpose != "source"
                || !_apiDirectorySelections.TryGetValue(outputToken, out var outputSelection)
                || outputSelection.Purpose != "output")
                throw new RpcException(-32602, "请重新选择原图文件夹和结果保存文件夹。");
            sourceRoot = sourceSelection.Path;
            outputRoot = outputSelection.Path;
        }
        else
        {
            if (!parameters.TryGetProperty("promptTemplates", out var templatesValue)
                || templatesValue.ValueKind != JsonValueKind.Object)
                throw new RpcException(-32602, "五类 API 提示词模板不能为空。");
            var expectedSheets = new[] { "角色", "生物", "群演", "场景", "道具" };
            promptTemplates = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var sheet in expectedSheets)
            {
                if (!templatesValue.TryGetProperty(sheet, out var templateValue)
                    || templateValue.ValueKind != JsonValueKind.String)
                    throw new RpcException(-32602, $"缺少 {sheet} API 提示词模板。");
                var template = templateValue.GetString()?.Trim() ?? string.Empty;
                if (template.Length is < 1 or > 64 * 1024 || template.IndexOf('\0') >= 0)
                    throw new RpcException(-32602, $"{sheet} API 提示词模板无效。");
                promptTemplates[sheet] = template;
            }
            if (templatesValue.EnumerateObject().Count() != expectedSheets.Length)
                throw new RpcException(-32602, "API 提示词模板包含未知类别。");
        }
        await EnsureProjectExistsAsync(projectId).ConfigureAwait(false);
        using var request = _sidecar.CreateNativeRequest(
            HttpMethod.Post,
            $"/desktop/projects/{Uri.EscapeDataString(projectId)}/start-api-batch");
        request.Content = new StringContent(JsonSerializer.Serialize(new
        {
            baseUrl,
            username,
            password,
            remoteProjectId,
            modelId,
            maxWorkers,
            aspectRatio,
            imageSize,
            operation,
            sourceRoot,
            outputRoot,
            redrawPrompt,
            promptTemplates
        }, JsonOptions), Encoding.UTF8, "application/json");
        using var response = await _sidecar.HttpClient.SendAsync(
            request,
            HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false);
        var bytes = await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
        if (bytes.Length is < 1 or > MaxResponseBytes)
            throw new RpcException(-32006, "无限画板任务启动响应无效。");
        using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 8 });
        if (!response.IsSuccessStatusCode
            || !document.RootElement.TryGetProperty("ok", out var ok)
            || ok.ValueKind != JsonValueKind.True
            || !document.RootElement.TryGetProperty("data", out var data)
            || data.ValueKind != JsonValueKind.Object)
        {
            var message = document.RootElement.TryGetProperty("error", out var error)
                && error.TryGetProperty("message", out var messageValue)
                ? messageValue.GetString()
                : null;
            throw new RpcException(-32006, message ?? "无限画板任务启动失败。");
        }
        if (sourceToken is not null) _apiDirectorySelections.Remove(sourceToken);
        if (outputToken is not null) _apiDirectorySelections.Remove(outputToken);
        return data.Clone();
    }

    private static string ReadApiText(
        JsonElement parameters,
        string propertyName,
        int maximumLength,
        bool allowWhitespace)
    {
        if (!parameters.TryGetProperty(propertyName, out var value) || value.ValueKind != JsonValueKind.String)
            throw new RpcException(-32602, $"{propertyName} 必须是字符串。");
        var text = value.GetString() ?? string.Empty;
        if (!allowWhitespace) text = text.Trim();
        if (text.Length is < 1 || text.Length > maximumLength || text.IndexOf('\0') >= 0
            || text.IndexOf('\r') >= 0 || text.IndexOf('\n') >= 0)
            throw new RpcException(-32602, $"{propertyName} 无效。");
        return text;
    }

    private static bool TryOpenCodexApp()
    {
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = "codex:",
                UseShellExecute = true
            });
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static object AuthorizeCodex(JsonElement root)
    {
        var parameters = ReadParameters(root);
        if (parameters.EnumerateObject().Any())
            throw new RpcException(-32602, "authorizeCodex params 必须为空。");
        if (!TryOpenCodexApp())
            throw new RpcException(-32006, "无法打开 Codex 登录界面，请确认已安装 Codex。");
        return new { opened = true };
    }

    private object SetStudioDrawerOpen(JsonElement root)
    {
        var parameters = ReadParameters(root);
        foreach (var property in parameters.EnumerateObject())
        {
            if (property.Name is not ("open" or "width"))
                throw new RpcException(-32602, "setStudioDrawerOpen params 包含未知字段。");
        }
        if (!parameters.TryGetProperty("open", out var openValue)
            || openValue.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new RpcException(-32602, "open 必须是布尔值。");

        double? width = null;
        if (parameters.TryGetProperty("width", out var widthValue))
        {
            if (widthValue.ValueKind != JsonValueKind.Number
                || !widthValue.TryGetDouble(out var parsedWidth)
                || !double.IsFinite(parsedWidth)
                || parsedWidth is < 240 or > 960)
                throw new RpcException(-32602, "width 必须是 240 到 960 之间的数字。");
            width = parsedWidth;
        }

        return _setStudioDrawerOpen(openValue.GetBoolean(), width);
    }

    private async Task<object> SaveJsonFileAsync(JsonElement root)
    {
        var parameters = ReadParameters(root);
        foreach (var property in parameters.EnumerateObject())
        {
            if (property.Name is not ("suggestedName" or "jsonText"))
                throw new RpcException(-32602, "saveJsonFile params 包含未知字段。");
        }
        if (!parameters.TryGetProperty("suggestedName", out var nameValue)
            || nameValue.ValueKind != JsonValueKind.String)
            throw new RpcException(-32602, "suggestedName 必须是 JSON 文件名。");
        if (!parameters.TryGetProperty("jsonText", out var textValue)
            || textValue.ValueKind != JsonValueKind.String)
            throw new RpcException(-32602, "jsonText 必须是 JSON 文本。");

        var suggestedName = nameValue.GetString() ?? string.Empty;
        ValidateSuggestedJsonFileName(suggestedName);
        var jsonText = textValue.GetString() ?? string.Empty;
        int jsonBytes;
        try
        {
            jsonBytes = StrictUtf8.GetByteCount(jsonText);
        }
        catch (EncoderFallbackException)
        {
            throw new RpcException(-32602, "jsonText 包含无效字符。");
        }
        if (jsonBytes is < 1 or > MaxJsonTextBytes)
            throw new RpcException(-32602, "jsonText 为空或超过 4 MiB 限制。");
        try
        {
            using var document = JsonDocument.Parse(jsonText, new JsonDocumentOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = 64
            });
        }
        catch (JsonException)
        {
            throw new RpcException(-32602, "jsonText 不是有效 JSON。");
        }

        return await _saveJsonFile(suggestedName, jsonText).ConfigureAwait(true);
    }

    private static void ValidateSuggestedJsonFileName(string suggestedName)
    {
        var invalid = suggestedName.Length is < 1 or > MaxSuggestedNameLength
            || !string.Equals(suggestedName, suggestedName.Trim(), StringComparison.Ordinal)
            || suggestedName.EndsWith('.')
            || Path.IsPathRooted(suggestedName)
            || !string.Equals(Path.GetFileName(suggestedName), suggestedName, StringComparison.Ordinal)
            || suggestedName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0
            || suggestedName.Any(character => char.IsControl(character)
                || char.GetUnicodeCategory(character) == UnicodeCategory.Format)
            || !string.Equals(Path.GetExtension(suggestedName), ".json", StringComparison.OrdinalIgnoreCase);
        var deviceName = suggestedName.Split('.', 2)[0].TrimEnd(' ', '.');
        if (invalid || string.IsNullOrWhiteSpace(Path.GetFileNameWithoutExtension(suggestedName))
            || ReservedFileNamePattern().IsMatch(deviceName))
            throw new RpcException(-32602, "suggestedName 必须是安全的 .json 文件名，不能包含路径。");
    }

    private static JsonElement ReadParameters(JsonElement root)
    {
        if (!root.TryGetProperty("params", out var parameters) || parameters.ValueKind != JsonValueKind.Object)
            throw new RpcException(-32602, "params 必须是对象。");
        return parameters;
    }

    private static string ReadProjectId(JsonElement parameters)
    {
        if (!parameters.TryGetProperty("projectId", out var value) || value.ValueKind != JsonValueKind.String)
            throw new RpcException(-32602, "缺少项目编号。");
        var projectId = value.GetString() ?? string.Empty;
        if (!ProjectIdPattern().IsMatch(projectId)) throw new RpcException(-32602, "项目编号无效。");
        return projectId;
    }

    private async Task EnsureProjectExistsAsync(string projectId)
    {
        using var request = _sidecar.CreateRequest(HttpMethod.Get, "/api/projects");
        using var response = await _sidecar.HttpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead)
            .ConfigureAwait(false);
        if (!response.IsSuccessStatusCode) throw new RpcException(-32001, "项目列表暂时不可用。");
        var bytes = await response.Content.ReadAsByteArrayAsync().ConfigureAwait(false);
        if (bytes.Length > MaxResponseBytes) throw new RpcException(-32001, "项目列表响应过大。");
        using var document = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 12 });
        if (!document.RootElement.TryGetProperty("data", out var data)
            || !data.TryGetProperty("projects", out var projects)
            || projects.ValueKind != JsonValueKind.Array)
            throw new RpcException(-32001, "项目列表格式无效。");
        var exists = projects.EnumerateArray().Any(project =>
            project.TryGetProperty("projectId", out var id)
            && id.GetString() == projectId
            && (!project.TryGetProperty("availability", out var availability) || availability.GetString() == "available"));
        if (!exists) throw new RpcException(-32004, "项目不存在或当前不可用。");
    }

    private void Post(object payload) => _webView.PostWebMessageAsJson(JsonSerializer.Serialize(payload, JsonOptions));

    private static JsonElement NullId()
    {
        using var document = JsonDocument.Parse("null");
        return document.RootElement.Clone();
    }

    public void Dispose() => _apiDirectorySelections.Clear();

    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$", RegexOptions.CultureInvariant)]
    private static partial Regex ProjectIdPattern();

    [GeneratedRegex("^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ReservedFileNamePattern();

    private sealed class RpcException(int code, string message) : Exception(message)
    {
        public int Code { get; } = code;
    }

    private sealed record RpcSuccess(string Jsonrpc, JsonElement Id, object Result);
    private sealed record RpcFailure(string Jsonrpc, JsonElement Id, RpcError Error);
    private sealed record RpcError(int Code, string Message);
}
