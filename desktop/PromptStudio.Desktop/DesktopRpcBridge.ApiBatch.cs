using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Windows;

namespace KA.PromptStudio.Desktop;

internal sealed partial class DesktopRpcBridge
{
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

}

