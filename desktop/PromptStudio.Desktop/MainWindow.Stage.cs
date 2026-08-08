using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;

namespace KA.PromptStudio.Desktop;

internal sealed partial class MainWindow
{
    private const double DefaultStageGrowth = 560;
    private const double StageWorkAreaMargin = 20;
    private const double StageMinimumWorkAreaCoverage = 0.88;
    private const uint MonitorDefaultToNearest = 2;
    private const uint SetWindowPosNoActivate = 0x0010;
    private const uint SetWindowPosNoZOrder = 0x0004;

    private StageWindowState? _stageWindowState;

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

}
