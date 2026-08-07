using System.Windows;

namespace KA.PromptStudio.Desktop;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        var application = new Application
        {
            ShutdownMode = ShutdownMode.OnMainWindowClose
        };
        application.Run(new MainWindow());
    }
}
