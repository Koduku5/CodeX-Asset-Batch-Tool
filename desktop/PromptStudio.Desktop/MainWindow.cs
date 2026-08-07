using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace KA.PromptStudio.Desktop;

internal sealed class MainWindow : Window
{
    private const double DefaultStageGrowth = 560;
    private const double StageWorkAreaMargin = 20;
    private const double StageMinimumWorkAreaCoverage = 0.88;
    private const uint MonitorDefaultToNearest = 2;
    private const uint SetWindowPosNoActivate = 0x0010;
    private const uint SetWindowPosNoZOrder = 0x0004;
    private static readonly UTF8Encoding JsonFileEncoding = new(false, true);

    private readonly WebView2 _webView;
    private readonly TextBlock _loading;
    private readonly CancellationTokenSource _lifetime = new();
    private DesktopSidecar? _sidecar;
    private DesktopRpcBridge? _bridge;
    private StageWindowState? _stageWindowState;
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

    private object ExpandForStudioStage(double requestedWidth)
    {
        if (_stageWindowState is not null)
        {
            return CreateOpenStageResult(_stageWindowState);
        }

        var handle = new WindowInteropHelper(this).Handle;
        if (handle == IntPtr.Zero)
        {
            throw new InvalidOperationException("桌面窗口尚未准备完成。");
        }

        var original = CaptureWindowState(handle);
        _stageWindowState = original;
        try
        {
            // A maximized window already is the largest safe single-window stage.
            // Keep it maximized instead of briefly shrinking it into an inset normal
            // rectangle; close still round-trips the saved native placement.
            if (original.State == WindowState.Maximized)
            {
                return CreateOpenStageResult(original);
            }

            var monitor = NativeMethods.MonitorFromWindow(handle, MonitorDefaultToNearest);
            var monitorInfo = new NativeMethods.MonitorInfo { Size = Marshal.SizeOf<NativeMethods.MonitorInfo>() };
            if (monitor == IntPtr.Zero || !NativeMethods.GetMonitorInfo(monitor, ref monitorInfo))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "无法取得显示器工作区。");
            }

            var scale = GetWindowDpiScale(handle);
            var target = CalculateStageBounds(
                original.WindowBounds,
                monitorInfo.WorkArea,
                requestedWidth,
                scale);

            if (WindowState != WindowState.Normal)
            {
                WindowState = WindowState.Normal;
                UpdateLayout();
            }

            // Small work areas can be below the normal production minimum. Relax the
            // constraint only while the stage is open so SetWindowPos cannot push the
            // window outside the selected monitor.
            MinWidth = Math.Min(original.MinWidth, target.Width / scale);
            MinHeight = Math.Min(original.MinHeight, target.Height / scale);

            if (!NativeMethods.SetWindowPos(
                    handle,
                    IntPtr.Zero,
                    target.Left,
                    target.Top,
                    target.Width,
                    target.Height,
                    SetWindowPosNoActivate | SetWindowPosNoZOrder))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "桌面窗口无法为 Prompt Studio 展开舞台。");
            }

            UpdateLayout();
            var expanded = MeasureWindow(handle);
            _stageWindowState = original with
            {
                ExpandedBy = Math.Max(0, expanded.Width - original.OriginalWidth),
                ExpandedHeight = Math.Max(0, expanded.Height - original.OriginalHeight),
                ExpandedWindowWidth = expanded.Width,
                ExpandedWindowHeight = expanded.Height
            };
            return CreateOpenStageResult(_stageWindowState);
        }
        catch
        {
            try
            {
                RestoreWindowState(original);
            }
            finally
            {
                _stageWindowState = null;
            }
            throw;
        }
    }

    private object RestoreFromStudioStage()
    {
        var original = _stageWindowState;
        if (original is null)
        {
            var current = TryMeasureWindow();
            return new
            {
                open = false,
                restored = false,
                originalWidth = current.Width,
                originalHeight = current.Height,
                windowWidth = current.Width,
                windowHeight = current.Height,
                expandedBy = 0d,
                expandedHeight = 0d
            };
        }

        if (!RestoreWindowState(original))
        {
            throw new InvalidOperationException("桌面窗口未能精确恢复；可以再次关闭 Prompt Studio 重试。");
        }
        _stageWindowState = null;
        var restored = TryMeasureWindow(original.OriginalWidth, original.OriginalHeight);
        return new
        {
            open = false,
            restored = true,
            originalWidth = original.OriginalWidth,
            originalHeight = original.OriginalHeight,
            windowWidth = restored.Width,
            windowHeight = restored.Height,
            expandedBy = 0d,
            expandedHeight = 0d
        };
    }

    private object CreateOpenStageResult(StageWindowState state)
    {
        var current = TryMeasureWindow(state.ExpandedWindowWidth, state.ExpandedWindowHeight);
        return new
        {
            open = true,
            originalWidth = state.OriginalWidth,
            originalHeight = state.OriginalHeight,
            windowWidth = current.Width,
            windowHeight = current.Height,
            expandedBy = Math.Max(0, current.Width - state.OriginalWidth),
            expandedHeight = Math.Max(0, current.Height - state.OriginalHeight)
        };
    }

    private StageWindowState CaptureWindowState(IntPtr handle)
    {
        if (!NativeMethods.GetWindowRect(handle, out var windowBounds))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "无法取得桌面窗口位置。");
        }

        var placement = new NativeMethods.WindowPlacement
        {
            Length = Marshal.SizeOf<NativeMethods.WindowPlacement>()
        };
        if (!NativeMethods.GetWindowPlacement(handle, ref placement))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "无法保存桌面窗口位置。");
        }

        var fallbackBounds = WindowState == WindowState.Normal
            ? new Rect(Left, Top, Width, Height)
            : RestoreBounds;
        var size = MeasureWindow(handle);
        return new StageWindowState(
            placement,
            fallbackBounds,
            windowBounds,
            WindowState,
            MinWidth,
            MinHeight,
            size.Width,
            size.Height,
            0,
            0,
            size.Width,
            size.Height);
    }

    private bool RestoreWindowState(StageWindowState state)
    {
        // Keep the temporary relaxed minimum until the original native placement is
        // back. WINDOWPLACEMENT preserves the exact normal bounds and maximized flag.
        WindowState = WindowState.Normal;
        var handle = new WindowInteropHelper(this).Handle;
        var placement = state.Placement;
        var restoredNatively = handle != IntPtr.Zero
            && NativeMethods.SetWindowPlacement(handle, ref placement);

        if (!restoredNatively)
        {
            Left = state.FallbackBounds.Left;
            Top = state.FallbackBounds.Top;
            Width = state.FallbackBounds.Width;
            Height = state.FallbackBounds.Height;
        }

        MinWidth = state.MinWidth;
        MinHeight = state.MinHeight;
        if (WindowState != state.State) WindowState = state.State;
        UpdateLayout();
        return VerifyRestoredWindow(handle, state);
    }

    private bool VerifyRestoredWindow(IntPtr handle, StageWindowState state)
    {
        if (WindowState != state.State) return false;
        if (handle == IntPtr.Zero) return true;

        var placement = new NativeMethods.WindowPlacement
        {
            Length = Marshal.SizeOf<NativeMethods.WindowPlacement>()
        };
        if (!NativeMethods.GetWindowPlacement(handle, ref placement)
            || !ApproximatelyEquals(placement.NormalPosition, state.Placement.NormalPosition))
        {
            return false;
        }

        if (state.State != WindowState.Normal) return true;
        return NativeMethods.GetWindowRect(handle, out var bounds)
            && ApproximatelyEquals(bounds, state.WindowBounds);
    }

    private static bool ApproximatelyEquals(
        NativeMethods.NativeRect left,
        NativeMethods.NativeRect right,
        int tolerance = 1)
    {
        return Math.Abs(left.Left - right.Left) <= tolerance
            && Math.Abs(left.Top - right.Top) <= tolerance
            && Math.Abs(left.Right - right.Right) <= tolerance
            && Math.Abs(left.Bottom - right.Bottom) <= tolerance;
    }

    private void RestoreStageAfterRendererReset()
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(new Action(RestoreStageAfterRendererReset));
            return;
        }

        if (_closing || _stageWindowState is not { } original) return;
        if (RestoreWindowState(original)) _stageWindowState = null;
    }

    private WindowSize TryMeasureWindow(double? fallbackWidth = null, double? fallbackHeight = null)
    {
        var handle = new WindowInteropHelper(this).Handle;
        if (handle != IntPtr.Zero)
        {
            try
            {
                return MeasureWindow(handle);
            }
            catch (Win32Exception)
            {
                // The RPC still returns deterministic metadata while the window is
                // being torn down; normal live calls use the native measurement.
            }
        }

        return new WindowSize(
            fallbackWidth ?? Math.Max(0, ActualWidth),
            fallbackHeight ?? Math.Max(0, ActualHeight));
    }

    private WindowSize MeasureWindow(IntPtr handle)
    {
        if (!NativeMethods.GetClientRect(handle, out var clientBounds))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "无法取得桌面窗口客户区尺寸。");
        }

        var scale = GetWindowDpiScale(handle);
        return new WindowSize(clientBounds.Width / scale, clientBounds.Height / scale);
    }

    private double GetWindowDpiScale(IntPtr handle)
    {
        var dpi = NativeMethods.GetDpiForWindow(handle);
        if (dpi > 0) return dpi / 96d;

        var fallback = VisualTreeHelper.GetDpi(this).DpiScaleX;
        return double.IsFinite(fallback) && fallback > 0 ? fallback : 1;
    }

    private static NativeMethods.NativeRect CalculateStageBounds(
        NativeMethods.NativeRect current,
        NativeMethods.NativeRect workArea,
        double requestedGrowth,
        double scale)
    {
        var workWidth = Math.Max(1, workArea.Width);
        var workHeight = Math.Max(1, workArea.Height);
        var requestedMargin = Math.Max(0, (int)Math.Round(StageWorkAreaMargin * scale));
        var horizontalMargin = Math.Min(requestedMargin, Math.Max(0, (workWidth - 1) / 2));
        var verticalMargin = Math.Min(requestedMargin, Math.Max(0, (workHeight - 1) / 2));
        var safeLeft = workArea.Left + horizontalMargin;
        var safeTop = workArea.Top + verticalMargin;
        var safeWidth = Math.Max(1, workWidth - (horizontalMargin * 2));
        var safeHeight = Math.Max(1, workHeight - (verticalMargin * 2));

        var requestedPixels = Math.Max(1, (int)Math.Round(requestedGrowth * scale));
        var minimumStageWidth = Math.Max(1, (int)Math.Round(safeWidth * StageMinimumWorkAreaCoverage));
        var desiredWidth = Math.Max(minimumStageWidth, current.Width + requestedPixels);
        var targetWidth = Math.Min(safeWidth, desiredWidth);
        var targetHeight = safeHeight;

        var currentCenterX = current.Left + (current.Width / 2d);
        var currentCenterY = current.Top + (current.Height / 2d);
        var targetLeft = (int)Math.Round(currentCenterX - (targetWidth / 2d));
        var targetTop = (int)Math.Round(currentCenterY - (targetHeight / 2d));
        targetLeft = Math.Clamp(targetLeft, safeLeft, safeLeft + safeWidth - targetWidth);
        targetTop = Math.Clamp(targetTop, safeTop, safeTop + safeHeight - targetHeight);

        return new NativeMethods.NativeRect
        {
            Left = targetLeft,
            Top = targetTop,
            Right = targetLeft + targetWidth,
            Bottom = targetTop + targetHeight
        };
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

    private sealed record StageWindowState(
        NativeMethods.WindowPlacement Placement,
        Rect FallbackBounds,
        NativeMethods.NativeRect WindowBounds,
        WindowState State,
        double MinWidth,
        double MinHeight,
        double OriginalWidth,
        double OriginalHeight,
        double ExpandedBy,
        double ExpandedHeight,
        double ExpandedWindowWidth,
        double ExpandedWindowHeight);

    private readonly record struct WindowSize(double Width, double Height);

    private static class NativeMethods
    {
        [StructLayout(LayoutKind.Sequential)]
        internal struct NativeRect
        {
            internal int Left;
            internal int Top;
            internal int Right;
            internal int Bottom;

            internal readonly int Width => Math.Max(0, Right - Left);
            internal readonly int Height => Math.Max(0, Bottom - Top);
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct NativePoint
        {
            internal int X;
            internal int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct WindowPlacement
        {
            internal int Length;
            internal int Flags;
            internal int ShowCommand;
            internal NativePoint MinPosition;
            internal NativePoint MaxPosition;
            internal NativeRect NormalPosition;
        }

        [StructLayout(LayoutKind.Sequential)]
        internal struct MonitorInfo
        {
            internal int Size;
            internal NativeRect Monitor;
            internal NativeRect WorkArea;
            internal uint Flags;
        }

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetWindowRect(IntPtr window, out NativeRect rect);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetClientRect(IntPtr window, out NativeRect rect);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetWindowPlacement(IntPtr window, ref WindowPlacement placement);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetWindowPlacement(IntPtr window, ref WindowPlacement placement);

        [DllImport("user32.dll")]
        internal static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);

        [DllImport("user32.dll")]
        internal static extern uint GetDpiForWindow(IntPtr window);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetWindowPos(
            IntPtr window,
            IntPtr insertAfter,
            int x,
            int y,
            int width,
            int height,
            uint flags);
    }

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
