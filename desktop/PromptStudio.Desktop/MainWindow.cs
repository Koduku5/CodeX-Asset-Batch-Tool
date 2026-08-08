using System.ComponentModel;
using System.IO;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace KA.PromptStudio.Desktop;

internal sealed partial class MainWindow : Window
{
    private static readonly UTF8Encoding JsonFileEncoding = new(false, true);

    private readonly WebView2 _webView;
    private readonly TextBlock _loading;
    private readonly CancellationTokenSource _lifetime = new();
    private DesktopSidecar? _sidecar;
    private DesktopRpcBridge? _bridge;
    private bool _closing;

    public MainWindow()
    {
        Title = "KA Asset Batch";
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        MinWidth = 980;
        MinHeight = 680;
        Width = 1160;
        Height = 820;
        Background = new SolidColorBrush(Color.FromRgb(18, 20, 25));

        var layout = new Grid { Background = Background };
        _webView = new WebView2 { Visibility = Visibility.Collapsed };
        _loading = new TextBlock
        {
            Text = "正在启动正式流水线…",
            HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
            FontFamily = new FontFamily("Microsoft YaHei UI"),
            FontSize = 16,
            Foreground = Brushes.Gainsboro
        };
        layout.Children.Add(_webView);
        layout.Children.Add(_loading);
        Content = layout;

        ContentRendered += OnContentRenderedAsync;
        Closing += OnWindowClosing;
    }

    private async void OnContentRenderedAsync(object? sender, EventArgs eventArgs)
    {
        ContentRendered -= OnContentRenderedAsync;
        try
        {
            var paths = DesktopPaths.Resolve();
            _sidecar = await DesktopSidecar.StartAsync(paths, _lifetime.Token);
            var environment = await CoreWebView2Environment.CreateAsync(null, paths.WebViewDataRoot);
            await _webView.EnsureCoreWebView2Async(environment);
            ConfigureWebView(_webView.CoreWebView2, _sidecar);
            _bridge = new DesktopRpcBridge(
                _sidecar,
                _webView.CoreWebView2,
                SetStudioDrawerOpen,
                SaveJsonFileAsync);
            await _webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(DesktopBridgeScript);
            _webView.Visibility = Visibility.Visible;
            _loading.Visibility = Visibility.Collapsed;
            _webView.CoreWebView2.Navigate(_sidecar.Origin.AbsoluteUri);
        }
        catch (OperationCanceledException) when (_closing)
        {
            // Normal application shutdown while startup is in progress.
        }
        catch (Exception error)
        {
            _loading.Text = "桌面软件启动失败";
            MessageBox.Show(this, error.Message, "KA Asset Batch", MessageBoxButton.OK, MessageBoxImage.Error);
            Close();
        }
    }

    private void ConfigureWebView(CoreWebView2 core, DesktopSidecar sidecar)
    {
        var expectedOrigin = sidecar.Origin.GetLeftPart(UriPartial.Authority);
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.AreDevToolsEnabled = Environment.GetEnvironmentVariable("KA_PROMPT_STUDIO_DEVTOOLS") == "1";
        core.Settings.AreDefaultScriptDialogsEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsPasswordAutosaveEnabled = false;
        core.Settings.IsGeneralAutofillEnabled = false;
        core.Settings.IsWebMessageEnabled = true;

        core.AddWebResourceRequestedFilter($"{expectedOrigin}/*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += (_, args) =>
        {
            if (!HasExactOrigin(args.Request.Uri, expectedOrigin)) return;
            args.Request.Headers.SetHeader("X-KA-Desktop-Token", sidecar.Token);
            args.Request.Headers.SetHeader("Origin", expectedOrigin);
        };
        core.NavigationStarting += (_, args) =>
        {
            if (!HasExactOrigin(args.Uri, expectedOrigin))
            {
                args.Cancel = true;
                return;
            }

            RestoreStageAfterRendererReset();
        };
        core.ProcessFailed += (_, _) => RestoreStageAfterRendererReset();
        core.NewWindowRequested += (_, args) => args.Handled = true;
        core.PermissionRequested += (_, args) => args.State = CoreWebView2PermissionState.Deny;
        core.DownloadStarting += (_, args) => args.Cancel = true;
        core.WebMessageReceived += async (_, args) =>
        {
            if (_bridge is null || !HasExactOrigin(args.Source, expectedOrigin)) return;
            await _bridge.HandleAsync(args.WebMessageAsJson);
        };
    }

    private static bool HasExactOrigin(string value, string expectedOrigin)
    {
        return Uri.TryCreate(value, UriKind.Absolute, out var uri)
            && string.Equals(uri.GetLeftPart(UriPartial.Authority), expectedOrigin, StringComparison.OrdinalIgnoreCase);
    }

    private async Task<object> SaveJsonFileAsync(string suggestedName, string jsonText)
    {
        string? selectedPath;
        if (Dispatcher.CheckAccess())
        {
            selectedPath = ShowJsonSaveDialog(suggestedName);
        }
        else
        {
            selectedPath = await Dispatcher.InvokeAsync(() => ShowJsonSaveDialog(suggestedName));
        }
        if (selectedPath is null) return new { saved = false };
        if (!string.Equals(Path.GetExtension(selectedPath), ".json", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("导出文件必须使用 .json 扩展名。");

        await File.WriteAllTextAsync(selectedPath, jsonText, JsonFileEncoding, _lifetime.Token)
            .ConfigureAwait(false);
        return new { saved = true, fileName = Path.GetFileName(selectedPath) };
    }

    private string? ShowJsonSaveDialog(string suggestedName)
    {
        var dialog = new SaveFileDialog
        {
            Title = "导出 JSON 文件",
            FileName = suggestedName,
            DefaultExt = ".json",
            Filter = "JSON 文件 (*.json)|*.json",
            AddExtension = true,
            CheckPathExists = true,
            OverwritePrompt = true,
            ValidateNames = true
        };
        return dialog.ShowDialog(this) == true ? dialog.FileName : null;
    }

    private object SetStudioDrawerOpen(bool open, double? requestedWidth)
    {
        if (!Dispatcher.CheckAccess())
        {
            return Dispatcher.Invoke(() => SetStudioDrawerOpen(open, requestedWidth));
        }

        return open
            ? ExpandForStudioStage(requestedWidth ?? DefaultStageGrowth)
            : RestoreFromStudioStage();
    }

    private void OnWindowClosing(object? sender, CancelEventArgs eventArgs)
    {
        if (_closing) return;
        _closing = true;
        _lifetime.Cancel();
        _bridge?.Dispose();
        _sidecar?.Dispose();
        _webView.Dispose();
        _lifetime.Dispose();
    }

}
