using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows;

namespace KA.PromptStudio.Desktop;

internal sealed partial class DesktopRpcBridge
{
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

