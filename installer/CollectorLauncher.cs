using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

internal static class CollectorLauncher
{
    private static void ShowLoginNotification()
    {
        // A notification has its own message loop; it never blocks Node output
        // or opens a dialog behind the browser the user is signing into.
        var thread = new Thread(() =>
        {
            using (var notification = new NotifyIcon())
            using (var timer = new System.Windows.Forms.Timer())
            {
                notification.Icon = System.Drawing.SystemIcons.Information;
                notification.Text = "TraceLens";
                notification.Visible = true;
                notification.BalloonTipTitle = "TraceLens 로그인 안내";
                notification.BalloonTipText = "로그인 후 수집용 브라우저 창을 모두 닫으세요. 로그인 상태를 저장하고 대시보드가 다시 열립니다. 개인 브라우저는 닫지 않아도 됩니다.";
                notification.BalloonTipIcon = ToolTipIcon.Info;
                timer.Interval = 30000;
                timer.Tick += (sender, args) => Application.ExitThread();
                timer.Start();
                notification.ShowBalloonTip(20000);
                Application.Run();
                notification.Visible = false;
            }
        });
        thread.IsBackground = true;
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
    }

    private delegate bool WindowCallback(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    private static string OpenBrowser()
    {
        string preference = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TraceLens", "collector-browser.txt");
        try
        {
            string saved = File.ReadAllText(preference).Trim();
            if (saved == "edge" || saved == "chrome") return saved;
        }
        catch (IOException) { }
        string browser = "auto";
        // Prefer a supported browser with a visible window rather than Edge
        // background startup processes.
        EnumWindows((window, parameter) =>
        {
            if (!IsWindowVisible(window)) return true;
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            try
            {
                using (var process = Process.GetProcessById((int)processId))
                {
                    string name = process.ProcessName;
                    if (name == "msedge") browser = "edge";
                    else if (name == "chrome") browser = "chrome";
                    else return true;
                }
                return false;
            }
            catch (ArgumentException) { return true; }
            catch (System.ComponentModel.Win32Exception) { return true; }
        }, IntPtr.Zero);
        return browser;
    }

    [STAThread]
    private static int Main()
    {
        bool created;
        using (var instance = new Mutex(true, "Local\\TraceLensPCCollector", out created))
        {
            if (!created)
            {
                MessageBox.Show("수집기가 이미 실행 중입니다. 열려 있는 TraceLens 브라우저를 사용하세요.", "TraceLens");
                return 0;
            }
            string directory = AppDomain.CurrentDomain.BaseDirectory;
            string logDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TraceLens", "logs");
            string logPath = Path.Combine(logDirectory, "collector.log");
            try
            {
                Directory.CreateDirectory(logDirectory);
                using (var log = new StreamWriter(logPath, false, new UTF8Encoding(false)))
                using (var process = new Process())
                {
                    log.AutoFlush = true;
                    object logLock = new object();
                    DataReceivedEventHandler write = (sender, args) =>
                    {
                        if (args.Data != null) lock (logLock) log.WriteLine(args.Data);
                        if (args.Data == "TRACELENS_LOGIN_HELP")
                            ShowLoginNotification();
                    };
                    process.StartInfo = new ProcessStartInfo
                    {
                        FileName = Path.Combine(directory, "runtime", "node.exe"),
                        Arguments = "\"" + Path.Combine(directory, "local_collector", "index.mjs") + "\" --browser=" + OpenBrowser(),
                        WorkingDirectory = directory,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        StandardOutputEncoding = Encoding.UTF8,
                        StandardErrorEncoding = Encoding.UTF8
                    };
                    process.OutputDataReceived += write;
                    process.ErrorDataReceived += write;
                    process.Start();
                    process.BeginOutputReadLine();
                    process.BeginErrorReadLine();
                    process.WaitForExit();
                    if (process.ExitCode != 0)
                    {
                        MessageBox.Show("수집기를 실행하지 못했습니다. 서버가 실행 중인지, Edge 또는 Chrome이 설치되어 있는지 확인하세요.\n\n로그: " + logPath, "TraceLens", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    }
                    return process.ExitCode;
                }
            }
            catch (Exception error)
            {
                MessageBox.Show("수집기 실행 오류: " + error.Message + "\n\n로그: " + logPath, "TraceLens", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
        }
    }
}
