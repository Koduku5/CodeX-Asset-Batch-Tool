using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace KA.PromptStudio.Desktop;

internal sealed class DesktopSidecar : IDisposable
{
    private readonly Process _process;
    private readonly WindowsJobObject? _job;
    private readonly HttpClient _http;
    private int _disposed;

    private DesktopSidecar(
        Process process,
        WindowsJobObject? job,
        Uri origin,
        string token,
        string nativeToken)
    {
        _process = process;
        _job = job;
        Origin = origin;
        Token = token;
        NativeToken = nativeToken;
        _http = new HttpClient { BaseAddress = origin, Timeout = TimeSpan.FromSeconds(5) };
    }

    public Uri Origin { get; }
    public string Token { get; }
    private string NativeToken { get; }
    public HttpClient HttpClient => _http;

    public static async Task<DesktopSidecar> StartAsync(DesktopPaths paths, CancellationToken cancellationToken)
    {
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var nativeToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var start = new ProcessStartInfo
        {
            FileName = paths.NodeExecutable,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
            WorkingDirectory = Path.GetDirectoryName(paths.SidecarEntry) ?? AppContext.BaseDirectory
        };
        start.ArgumentList.Add(paths.SidecarEntry);
        var sidecarServerRoot = Path.GetDirectoryName(paths.SidecarEntry)
            ?? throw new InvalidOperationException("无法定位 sidecar 服务目录。");
        var skillsRoot = Path.GetFullPath(Path.Combine(sidecarServerRoot, "..", "..", "skills"));
        if (!Directory.Exists(skillsRoot))
            throw new DirectoryNotFoundException("找不到软件级公共 Skills 目录。");
        start.Environment["KA_DESKTOP_SOFTWARE_ROOT"] = paths.SoftwareRoot;
        start.Environment["KA_DESKTOP_ENGINE_ROOT"] = paths.EngineRoot;
        start.Environment["KA_DESKTOP_SKILLS_ROOT"] = skillsRoot;
        start.Environment["KA_DESKTOP_TOKEN"] = token;
        start.Environment["KA_DESKTOP_NATIVE_TOKEN"] = nativeToken;

        var process = new Process { StartInfo = start, EnableRaisingEvents = true };
        var errors = new StringBuilder();
        process.ErrorDataReceived += (_, eventArgs) =>
        {
            if (eventArgs.Data is null || errors.Length >= 4096) return;
            errors.AppendLine(eventArgs.Data.Length > 512 ? eventArgs.Data[..512] : eventArgs.Data);
        };

        WindowsJobObject? job = null;
        try
        {
            if (!process.Start()) throw new InvalidOperationException("Node sidecar 没有启动。");
            process.BeginErrorReadLine();
            job = WindowsJobObject.TryAttach(process);

            var readyLine = await process.StandardOutput.ReadLineAsync()
                .WaitAsync(TimeSpan.FromSeconds(20), cancellationToken)
                .ConfigureAwait(false);
            if (string.IsNullOrWhiteSpace(readyLine) || Encoding.UTF8.GetByteCount(readyLine) > 512)
            {
                throw new InvalidOperationException("Node sidecar 没有返回有效的 ready 消息。");
            }
            using var document = JsonDocument.Parse(readyLine, new JsonDocumentOptions { MaxDepth = 4 });
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("type", out var type)
                || type.GetString() != "ka-prompt-studio-ready"
                || !root.TryGetProperty("protocolVersion", out var protocol)
                || protocol.GetInt32() != 1
                || !root.TryGetProperty("pid", out var pid)
                || pid.GetInt32() != process.Id
                || !root.TryGetProperty("origin", out var originValue))
            {
                throw new InvalidOperationException("Node sidecar ready 协议不匹配。");
            }
            if (!Uri.TryCreate(originValue.GetString(), UriKind.Absolute, out var origin)
                || origin.Scheme != Uri.UriSchemeHttp
                || origin.Host != IPAddress.Loopback.ToString()
                || origin.Port is < 1 or > 65535
                || origin.AbsolutePath != "/")
            {
                throw new InvalidOperationException("Node sidecar 返回了无效的本地来源。");
            }

            var sidecar = new DesktopSidecar(process, job, origin, token, nativeToken);
            job = null;
            await sidecar.VerifyHealthAsync(cancellationToken).ConfigureAwait(false);
            return sidecar;
        }
        catch
        {
            job?.Dispose();
            TryKill(process);
            process.Dispose();
            var diagnostic = errors.ToString().Trim();
            if (diagnostic.Length > 0) Debug.WriteLine(diagnostic);
            throw;
        }
    }

    public HttpRequestMessage CreateRequest(HttpMethod method, string relativePath)
    {
        var request = new HttpRequestMessage(method, relativePath);
        request.Headers.TryAddWithoutValidation("X-KA-Desktop-Token", Token);
        request.Headers.TryAddWithoutValidation("Origin", Origin.GetLeftPart(UriPartial.Authority));
        return request;
    }

    public HttpRequestMessage CreateNativeRequest(HttpMethod method, string relativePath)
    {
        var request = CreateRequest(method, relativePath);
        request.Headers.TryAddWithoutValidation("X-KA-Native-Token", NativeToken);
        return request;
    }

    private async Task VerifyHealthAsync(CancellationToken cancellationToken)
    {
        using var request = CreateRequest(HttpMethod.Get, "/health");
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
            .ConfigureAwait(false);
        if (response.StatusCode != HttpStatusCode.OK) throw new InvalidOperationException("Node sidecar 健康检查失败。");
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        try
        {
            if (!_process.HasExited)
            {
                try
                {
                    using var request = CreateRequest(HttpMethod.Post, "/shutdown");
                    using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(750));
                    _http.SendAsync(request, cancellation.Token).GetAwaiter().GetResult().Dispose();
                    _process.WaitForExit(750);
                }
                catch
                {
                    // The process-tree fallback below is authoritative during application exit.
                }
            }
            if (!_process.HasExited) TryKill(_process);
        }
        finally
        {
            _http.Dispose();
            _job?.Dispose();
            _process.Dispose();
        }
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        catch
        {
            // Closing an attached Job Object remains the primary process-tree cleanup path.
        }
    }
}
