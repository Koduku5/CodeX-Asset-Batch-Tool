using System.IO;

namespace KA.PromptStudio.Desktop;

internal sealed record DesktopPaths(
    string NodeExecutable,
    string SidecarEntry,
    string SoftwareRoot,
    string EngineRoot,
    string WebViewDataRoot)
{
    private const string EngineDirectoryName = "engine";

    public static DesktopPaths Resolve()
    {
        var engineRoot = ResolveOptionalDirectory("KA_PROMPT_STUDIO_ENGINE_ROOT")
            ?? FindEngineRoot()
            ?? throw new DirectoryNotFoundException("找不到软件执行引擎。请保留程序旁边的 engine 目录，或设置 KA_PROMPT_STUDIO_ENGINE_ROOT。");
        RequireDirectory(Path.Combine(engineRoot, "assets"), "执行引擎 assets");
        RequireDirectory(Path.Combine(engineRoot, "scripts"), "执行引擎 scripts");

        var softwareRoot = ResolveOptionalDirectory("KA_PROMPT_STUDIO_DATA_ROOT")
            ?? FindApplicationRoot(engineRoot);
        Directory.CreateDirectory(softwareRoot);

        var sidecarEntry = ResolveOptionalFile("KA_PROMPT_STUDIO_SIDECAR")
            ?? FindSidecarEntry(engineRoot)
            ?? throw new FileNotFoundException("找不到 desktop-entry.mjs。请保留程序旁边的 sidecar 目录，或设置 KA_PROMPT_STUDIO_SIDECAR。");
        var nodeExecutable = ResolveOptionalFile("KA_PROMPT_STUDIO_NODE")
            ?? FindNodeExecutable()
            ?? throw new FileNotFoundException("找不到 Node.js 运行时。发行包应在 runtime/node/node.exe 内附带运行时。");

        var webViewDataRoot = Path.Combine(softwareRoot, ".local", "desktop", "WebView2");
        Directory.CreateDirectory(webViewDataRoot);
        return new DesktopPaths(nodeExecutable, sidecarEntry, softwareRoot, engineRoot, webViewDataRoot);
    }

    private static string FindApplicationRoot(string engineRoot)
    {
        for (var cursor = new DirectoryInfo(AppContext.BaseDirectory); cursor is not null; cursor = cursor.Parent)
        {
            var sourceEngine = Path.Combine(cursor.FullName, EngineDirectoryName);
            var sourceServer = Path.Combine(cursor.FullName, "src", "server");
            var sourceDesktopProject = Path.Combine(
                cursor.FullName,
                "desktop",
                "PromptStudio.Desktop",
                "PromptStudio.Desktop.csproj");
            if (Directory.Exists(sourceEngine)
                && Directory.Exists(sourceServer)
                && File.Exists(sourceDesktopProject)
                && File.Exists(Path.Combine(cursor.FullName, "package.json")))
            {
                return cursor.FullName;
            }
        }

        var installedEngine = Path.Combine(AppContext.BaseDirectory, "sidecar", EngineDirectoryName);
        if (Directory.Exists(installedEngine) && SamePath(engineRoot, installedEngine))
        {
            return Path.TrimEndingDirectorySeparator(Path.GetFullPath(AppContext.BaseDirectory));
        }

        foreach (var start in SearchStarts())
        {
            for (var cursor = new DirectoryInfo(start); cursor is not null; cursor = cursor.Parent)
            {
                var candidateEngine = Path.Combine(cursor.FullName, EngineDirectoryName);
                var packageFile = Path.Combine(cursor.FullName, "package.json");
                if (Directory.Exists(candidateEngine)
                    && File.Exists(packageFile)
                    && SamePath(engineRoot, candidateEngine))
                {
                    return cursor.FullName;
                }
            }
        }
        return Path.TrimEndingDirectorySeparator(Path.GetFullPath(AppContext.BaseDirectory));
    }

    private static string? ResolveOptionalDirectory(string variable)
    {
        var value = Environment.GetEnvironmentVariable(variable);
        if (string.IsNullOrWhiteSpace(value)) return null;
        var full = Path.GetFullPath(value);
        RequireDirectory(full, variable);
        return full;
    }

    private static string? ResolveOptionalFile(string variable)
    {
        var value = Environment.GetEnvironmentVariable(variable);
        if (string.IsNullOrWhiteSpace(value)) return null;
        var full = Path.GetFullPath(value);
        if (!File.Exists(full)) throw new FileNotFoundException($"{variable} 指向的文件不存在。", full);
        return full;
    }

    private static string? FindEngineRoot()
    {
        foreach (var start in SearchStarts())
        {
            for (var cursor = new DirectoryInfo(start); cursor is not null; cursor = cursor.Parent)
            {
                var direct = Path.Combine(cursor.FullName, EngineDirectoryName);
                if (Directory.Exists(direct)) return direct;
                var sidecarEmbedded = Path.Combine(cursor.FullName, "sidecar", EngineDirectoryName);
                if (Directory.Exists(sidecarEmbedded)) return sidecarEmbedded;
                if (string.Equals(cursor.Name, EngineDirectoryName, StringComparison.OrdinalIgnoreCase)) return cursor.FullName;
            }
        }
        return null;
    }

    private static string? FindSidecarEntry(string engineRoot)
    {
        var installed = Path.Combine(AppContext.BaseDirectory, "sidecar", "src", "server", "desktop-entry.mjs");
        var installedEngine = Path.Combine(
            AppContext.BaseDirectory,
            "sidecar",
            EngineDirectoryName);
        if (File.Exists(installed) && SamePath(engineRoot, installedEngine)) return installed;

        foreach (var start in SearchStarts())
        {
            for (var cursor = new DirectoryInfo(start); cursor is not null; cursor = cursor.Parent)
            {
                var source = Path.Combine(cursor.FullName, "src", "server", "desktop-entry.mjs");
                if (File.Exists(source)) return source;
            }
        }
        return File.Exists(installed) ? installed : null;
    }

    private static string? FindNodeExecutable()
    {
        var bundled = Path.Combine(AppContext.BaseDirectory, "runtime", "node", "node.exe");
        if (File.Exists(bundled)) return bundled;

        var path = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        foreach (var segment in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            try
            {
                var candidate = Path.Combine(segment.Trim('"'), "node.exe");
                if (File.Exists(candidate)) return Path.GetFullPath(candidate);
            }
            catch (Exception) when (segment.Length > 0)
            {
                // Ignore malformed PATH entries and continue with the fixed candidates.
            }
        }
        return null;
    }

    private static IEnumerable<string> SearchStarts()
    {
        yield return AppContext.BaseDirectory;
        yield return Directory.GetCurrentDirectory();
    }

    private static bool SamePath(string left, string right) => string.Equals(
        Path.TrimEndingDirectorySeparator(Path.GetFullPath(left)),
        Path.TrimEndingDirectorySeparator(Path.GetFullPath(right)),
        StringComparison.OrdinalIgnoreCase);

    private static void RequireDirectory(string path, string label)
    {
        if (!Directory.Exists(path)) throw new DirectoryNotFoundException($"{label} 不存在：{path}");
    }
}
