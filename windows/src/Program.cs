// Entry point: command line, single instance (named mutex + pipe forwarding), self-install, update
// hand-over and crash-loop rollback, global settings.
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Beam")]
[assembly: AssemblyDescription("Send text and files between your own devices")]
[assembly: AssemblyProduct("Beam")]
[assembly: AssemblyCompany("Beam")]
[assembly: AssemblyCopyright("Beam")]
[assembly: TargetFramework(".NETFramework,Version=v4.8", FrameworkDisplayName = ".NET Framework 4.8")]

namespace Beam
{
    // Beam.exe [--config <path>] [--background] [--show] [--hide] [--settings] [--add-device] [--approve] [--quit]
    //          [--send [--to <id|name|all>[,…]] <file|folder>...] [--pick-clipboard] [--screenshot] [--copy-latest]
    //          [--portable] [--install] [--devtools] [--family]
    // Internal: --finish-update <exe> <pid> (1.1.0's updater), --updated <v>, --update-from <v>, --update-failed <v>,
    //           --health <nonce>, --installed, --test-capture <png>, --test-offscreen, --test-path </page> (custom --config only)
    class Options
    {
        public string Config;
        public bool Send;
        public string To;
        public List<string> Files = new List<string>();
        public bool Background;
        public bool Show;
        public bool Hide;
        public bool Family;     // (1.10) Beam Family's window
        public bool TestPoke;   // tests: check the event stream as after waking up
        public string TestMode; // tests: switch the stream to "foreground" or "background" (as the tray menu does)
        public string TestTransfer; // tests: "<action>:<transfer id>", as the page's transfer buttons (retry, cancel…)
        public string TestPhone;    // tests: "on" or "off", as the tray's "Show phone notifications"
        public bool TestClickBalloon; // tests: what a click on the last balloon does
        public string TestEventName, TestEventData; // tests: an event as if it came on the stream
        public string TestRc;        // tests: remote control ("allow[:ids]", "off", "devices:ids", "repin:id", "lock:on|off", "kill", "stop", "probe")
        public string TestBackups;   // tests (1.8.1): settings backups ("check", "send", "choices", "answer:restore|skip", "state")
        public string TestHistory;   // tests (1.13): the PC's history ("send", "read")
        public string TestKvm;       // tests (1.12): keyboard and mouse across PCs ("on:ids", "off", "edge[:h]", "move:dx,dy", "btn:b:down|up", "wheel:d", "key:vk,scan,ext:down|up", "where")
        public string TestBridge;    // tests: a host bridge message as if the chat page sent it (the reply goes to beam.log)
        public string TestOpenRemote; // tests: the viewer window for that device, as the page's "Control" opens it
        public string TestFamily;    // tests (1.10): the Family window "minimize", "restore" or "close", as the user would
        public string TestApps;      // tests (1.16): apps ("answer:<id>:install|always|notnow", "allow:on|off", "state")
        public string RemoveApp;     // (1.16) Windows' Installed apps → Uninstall of an app Beam installed: its id
        public bool AddDevice;
        public bool Settings;
        public bool Approve;
        public bool Quit;
        public bool PickClipboard;
        public bool Screenshot;
        public bool CopyLatest;
        public bool Portable;
        public bool Install;
        public bool Installed;
        public bool DevTools;
        public string FinishTarget;
        public int FinishPid;
        public string Updated;
        public string UpdateFrom;
        public string UpdateFailed;
        public string Health;
        public string TestCapture;
        public string TestPath;
        public bool TestOffscreen;

        public static Options Parse(string[] args)
        {
            var o = new Options();
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                if (a == null) continue;
                string lower = a.ToLowerInvariant();
                bool more = i + 1 < args.Length;
                if (lower == "--config" && more) o.Config = args[++i];
                else if (lower == "--to" && more) { o.To = args[++i]; o.Send = true; }
                else if (lower == "--send") o.Send = true;
                else if (lower == "--background" || lower == "--hidden") o.Background = true;
                else if (lower == "--show") o.Show = true;
                else if (lower == "--hide") o.Hide = true;
                else if (lower == "--family") o.Family = true;
                else if (lower == "--test-poke") o.TestPoke = true;
                else if (lower == "--test-mode" && more) o.TestMode = args[++i];
                else if (lower == "--test-transfer" && more) o.TestTransfer = args[++i];
                else if (lower == "--test-phone" && more) o.TestPhone = args[++i];
                else if (lower == "--test-click-balloon") o.TestClickBalloon = true;
                else if (lower == "--test-event" && i + 2 < args.Length) { o.TestEventName = args[++i]; o.TestEventData = args[++i]; }
                else if (lower == "--test-rc" && more) o.TestRc = args[++i];
                else if (lower == "--test-backups" && more) o.TestBackups = args[++i];
                else if (lower == "--test-history" && more) o.TestHistory = args[++i];
                else if (lower == "--test-kvm" && more) o.TestKvm = args[++i];
                else if (lower == "--test-bridge" && more) o.TestBridge = args[++i];
                else if (lower == "--test-open-remote" && more) o.TestOpenRemote = args[++i];
                else if (lower == "--test-family" && more) o.TestFamily = args[++i];
                else if (lower == "--test-apps" && more) o.TestApps = args[++i];
                else if (lower == "--remove-app" && more) { o.RemoveApp = args[++i]; o.Background = true; }
                else if (lower == "--add-device") o.AddDevice = true;
                else if (lower == "--settings") o.Settings = true;
                else if (lower == "--approve") o.Approve = true;
                else if (lower == "--quit") o.Quit = true;
                else if (lower == "--pick-clipboard") o.PickClipboard = true;
                else if (lower == "--screenshot") o.Screenshot = true;
                else if (lower == "--copy-latest") o.CopyLatest = true;
                else if (lower == "--portable") o.Portable = true;
                else if (lower == "--install") o.Install = true;
                else if (lower == "--installed") o.Installed = true;
                else if (lower == "--devtools") o.DevTools = true;
                else if (lower == "--finish-update" && i + 2 < args.Length)
                {
                    o.FinishTarget = args[++i];
                    int.TryParse(args[++i], out o.FinishPid);
                }
                else if (lower == "--updated" && more) o.Updated = args[++i];
                else if (lower == "--update-from" && more) o.UpdateFrom = args[++i];
                else if (lower == "--update-failed" && more) o.UpdateFailed = args[++i];
                else if (lower == "--health" && more) o.Health = args[++i];
                else if (lower == "--test-capture" && more) o.TestCapture = args[++i];
                else if (lower == "--test-offscreen") o.TestOffscreen = true;
                else if (lower == "--test-path" && more) o.TestPath = args[++i];
                else if (a == "%1" || a == "\"%1\"" || a.Trim().Length == 0) continue;
                else if (!a.StartsWith("--")) o.Files.Add(a);
            }
            // Files dropped on Beam.exe (or passed without --send) are sent too.
            if (o.Files.Count > 0) o.Send = true;
            return o;
        }

        public void ResolvePaths()
        {
            for (int i = 0; i < Files.Count; i++)
            {
                try { Files[i] = Path.GetFullPath(Files[i].Trim('"')); } catch { }
            }
            if (TestCapture != null) { try { TestCapture = Path.GetFullPath(TestCapture); } catch { } }
        }

        // What a second Beam.exe forwards to the running one.
        public string[] ToArgs()
        {
            var list = new List<string>();
            if (Show) list.Add("--show");
            if (Hide) list.Add("--hide");
            if (Family) list.Add("--family");
            if (TestPoke) list.Add("--test-poke");
            if (TestMode != null) { list.Add("--test-mode"); list.Add(TestMode); }
            if (TestTransfer != null) { list.Add("--test-transfer"); list.Add(TestTransfer); }
            if (TestPhone != null) { list.Add("--test-phone"); list.Add(TestPhone); }
            if (TestClickBalloon) list.Add("--test-click-balloon");
            if (TestEventName != null) { list.Add("--test-event"); list.Add(TestEventName); list.Add(TestEventData ?? "{}"); }
            if (TestRc != null) { list.Add("--test-rc"); list.Add(TestRc); }
            if (TestBackups != null) { list.Add("--test-backups"); list.Add(TestBackups); }
            if (TestHistory != null) { list.Add("--test-history"); list.Add(TestHistory); }
            if (TestKvm != null) { list.Add("--test-kvm"); list.Add(TestKvm); }
            if (TestBridge != null) { list.Add("--test-bridge"); list.Add(TestBridge); }
            if (TestOpenRemote != null) { list.Add("--test-open-remote"); list.Add(TestOpenRemote); }
            if (TestFamily != null) { list.Add("--test-family"); list.Add(TestFamily); }
            if (TestApps != null) { list.Add("--test-apps"); list.Add(TestApps); }
            if (RemoveApp != null) { list.Add("--remove-app"); list.Add(RemoveApp); }
            if (AddDevice) list.Add("--add-device");
            if (Settings) list.Add("--settings");
            if (Approve) list.Add("--approve");
            if (Background) list.Add("--background");
            if (Quit) list.Add("--quit");
            if (PickClipboard) list.Add("--pick-clipboard");
            if (Screenshot) list.Add("--screenshot");
            if (CopyLatest) list.Add("--copy-latest");
            if (Updated != null) { list.Add("--updated"); list.Add(Updated); }
            if (Send) list.Add("--send");
            if (To != null) { list.Add("--to"); list.Add(To); }
            list.AddRange(Files);
            return list.ToArray();
        }

        public bool Interactive
        {
            get { return !Background && !Quit; }
        }
    }

    static class Program
    {
        public static string InstanceId;
        public static Handoff Handoff; // set by App when an update takes over
        static Mutex mutex;

        [STAThread]
        static int Main(string[] args)
        {
            Embedded.Register();
            var opts = Options.Parse(args);
            opts.ResolvePaths();
            bool custom = opts.Config != null;
            // A test run (scratch server in BEAM_TEST_PEERS) must never reach the installed Beam's instance: without
            // --config it would forward its command line to it.
            if (!custom && !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("BEAM_TEST_PEERS"))) return 3;
            string configPath = custom ? Path.GetFullPath(opts.Config) : Config.DefaultPath();
            InstanceId = Hash(UserSid() + "|" + configPath.ToLowerInvariant());

            Directory.CreateDirectory(Path.GetDirectoryName(configPath));
            Log.FilePath = Path.Combine(Path.GetDirectoryName(configPath), "beam.log");
            // X-Beam-Profile: this Windows account on this PC. It survives reinstalls and updates; another account
            // (and, for tests, another --config) gets another one, so the server never merges those devices.
            Api.Profile = Hash(UserSid() + "|" + MachineGuid() + (custom ? "|" + configPath.ToLowerInvariant() : ""));
            // Beam 1.1.0's updater runs the new exe like this.
            if (opts.FinishTarget != null) return Updater.FinishLegacy(opts.FinishTarget, opts.FinishPid, custom ? configPath : null);

            bool created;
            mutex = new Mutex(true, "Local\\Beam-" + InstanceId, out created);
            if (!created) return Forward(opts);

            var cfg = Config.Load(configPath, custom);
            DeviceKey.Load(cfg.Dir); // Beam 1.6: this install's key (DPAPI, this Windows account)
            Health.Start(cfg, opts.Health);
            if (Health.BadStarts >= 3 && Updater.RollBackSelf(cfg, args)) { ReleaseLock(); return 1; }
            if (Install.SelfInstall(opts, cfg, args, ReleaseLock)) { Health.MarkCleanExit(); return 0; }
            if (opts.Quit) { Health.MarkCleanExit(); return 0; }

            Log.Write("Beam " + AppVersion.Text + " starting (" + string.Join(" ", ForLog(args)) + ")");

            // HTTP defaults: TLS 1.2+, enough parallel connections (events + transfers + API), no 100-continue.
            if (ServicePointManager.SecurityProtocol != SecurityProtocolType.SystemDefault)
                ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
            ServicePointManager.DefaultConnectionLimit = 16;
            ServicePointManager.Expect100Continue = false;
            // Requests go out as headers + body in separate writes: with Nagle on, the body of a small POST (an ack,
            // a text) can sit waiting for the server's delayed ACK (up to 200 ms on a real network).
            ServicePointManager.UseNagleAlgorithm = false;

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += (s, e) => Log.Write("UI error: " + e.Exception);
            AppDomain.CurrentDomain.UnhandledException += (s, e) => { Log.Write("Fatal: " + e.ExceptionObject); RcPointer.Emergency(); }; // (1.12.6: the pointer back)
            System.Threading.Tasks.TaskScheduler.UnobservedTaskException += (s, e) => { Log.Error("Task", e.Exception); e.SetObserved(); };
            SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());

            Application.Run(new App(opts, cfg));
            Pending.Wait(3000); // e.g. taking back an open sign-in request
            if (Handoff != null)
            {
                // An update: free the instance lock so the new version can start, then watch it.
                ReleaseLock();
                Health.MarkCleanExit();
                return Updater.HandOver(Handoff, cfg);
            }
            Health.MarkCleanExit();
            Log.Write("Beam stopped");
            GC.KeepAlive(mutex);
            return 0;
        }

        static void ReleaseLock()
        {
            try { mutex.ReleaseMutex(); } catch { }
            try { mutex.Dispose(); } catch { }
        }

        // Already running: hand our command line to that instance and let it take the foreground.
        static int Forward(Options opts)
        {
            Log.Write("Already running; forwarding: " + string.Join(" | ", ForLog(opts.ToArgs())));
            Native.AllowSetForegroundWindow(-1);
            if (!opts.Send && !opts.Quit && !opts.Background && !opts.Settings && !opts.Approve && !opts.AddDevice
                && !opts.PickClipboard && !opts.Screenshot && !opts.CopyLatest && !opts.Hide && !opts.TestPoke && opts.TestMode == null && opts.Updated == null
                && opts.TestTransfer == null && opts.TestPhone == null && !opts.TestClickBalloon && opts.TestEventName == null
                && opts.TestRc == null && opts.TestBackups == null && opts.TestHistory == null && opts.TestKvm == null && opts.TestBridge == null && opts.TestOpenRemote == null
                && opts.TestApps == null && opts.RemoveApp == null) opts.Show = true;
            for (int i = 0; i < 6; i++)
            {
                if (IpcServer.Send(PipeName(), opts.ToArgs(), 1000)) return 0;
                Thread.Sleep(300);
            }
            Log.Write("The running Beam didn't answer");
            if (opts.Interactive && opts.Config == null) // not for test instances: no dialogs on the desktop
                MessageBox.Show("Beam is running but isn't answering right now. Try again in a moment.\n\nIf this keeps happening, end Beam in Task Manager and start it again.", "Beam", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 1;
        }

        public static string PipeName()
        {
            return "Beam-" + InstanceId;
        }

        // A command line for beam.log: a test event's data is left out (it may carry made-up notification content).
        static string[] ForLog(string[] args)
        {
            var copy = (string[])args.Clone();
            for (int i = 0; i + 2 < copy.Length; i++)
                if (string.Equals(copy[i], "--test-event", StringComparison.OrdinalIgnoreCase)) copy[i + 2] = "(data)";
            for (int i = 0; i + 1 < copy.Length; i++)
                if (string.Equals(copy[i], "--test-bridge", StringComparison.OrdinalIgnoreCase)) copy[i + 1] = "(message)";
            return copy;
        }

        static string UserSid()
        {
            try { return WindowsIdentity.GetCurrent().User.Value; }
            catch { return Environment.UserName; }
        }

        // Windows' per-installation id (HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid), read from the 64-bit
        // registry view (a 32-bit view has no such value). Read-only; empty if it can't be read.
        static string MachineGuid()
        {
            try
            {
                var view = Environment.Is64BitOperatingSystem ? RegistryView.Registry64 : RegistryView.Default;
                using (var hklm = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view))
                using (var key = hklm.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography"))
                {
                    var value = key != null ? key.GetValue("MachineGuid") as string : null;
                    if (!string.IsNullOrEmpty(value)) return value.Trim();
                }
            }
            catch (Exception ex) { Log.Error("MachineGuid", ex); }
            return "";
        }

        // First 16 hex digits of SHA-256.
        static string Hash(string s)
        {
            using (var sha = SHA256.Create())
            {
                var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(s));
                var sb = new StringBuilder();
                for (int i = 0; i < 8; i++) sb.Append(bytes[i].ToString("x2"));
                return sb.ToString();
            }
        }
    }
}
