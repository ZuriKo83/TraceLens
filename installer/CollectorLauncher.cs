using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class CollectorLauncher
{
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
                    };
                    process.StartInfo = new ProcessStartInfo
                    {
                        FileName = Path.Combine(directory, "runtime", "node.exe"),
                        Arguments = "\"" + Path.Combine(directory, "local_collector", "index.mjs") + "\" --browser=auto",
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
