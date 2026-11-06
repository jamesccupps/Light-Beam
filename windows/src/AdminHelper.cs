// Remote control reaches administrator windows and UAC prompts (Windows 1.22, plan Beam-dev\plan\rc-admin.md; the user,
// 2026-11-02: "make the connect work even if something like an admin window appears, it makes it hard to do anything
// from my phone"). Beam runs as the user, so Windows drops its clicks and keys while an administrator's window is in
// front (UIPI), and a UAC prompt is on the secure desktop that no user program reaches. The input helper (helper\
// BeamInput.cs, uiAccess="true") is Windows' own way round that, as Remote Assistance's: Windows grants it UIAccess
// only when it's signed with a certificate in the PC's Trusted Root and runs from Program Files.
// - The setup (once per PC, Settings → Security → This PC, elevated: Windows asks): the helper to
//   %ProgramFiles%\Beam\BeamInput.exe, its certificate into LocalMachine\Root, and with the prompts option
//   PromptOnSecureDesktop = 0 (UAC prompts on the normal desktop: the value before is kept under
//   HKLM\SOFTWARE\Beam\AdminHelper and put back). Remove undoes all of it. Not a service; nothing runs as SYSTEM.
// - During a session (HelperBackend): Beam owns a pipe only this account can open, starts the helper with the pipe's
//   name, its pid and a token, and checks that the client is that process and knows the token. Input goes through it
//   while it's there; before it's connected, and if it ends, the old way.
// Tests: --config with testAdminHelper (a helper built without uiAccess, recording) and testAdminHelperRoot (the setup
// writes "Program Files", the store and the policy as files there: never HKLM or a real store).
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Beam
{
    static class AdminHelper
    {
        public const string ExeName = "BeamInput.exe";
        public const byte Protocol = 1;
        const string BeamKey = @"SOFTWARE\Beam", OwnKey = @"SOFTWARE\Beam\AdminHelper";
        const string PolicyKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System", PolicyValue = "PromptOnSecureDesktop";

        public static string TestRoot; // tests (custom --config only): files instead of Program Files, the store and HKLM

        static string Dir
        {
            get { return TestRoot != null ? Path.Combine(TestRoot, "Program Files", "Beam") : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Beam"); }
        }

        public static string InstalledExe { get { return Path.Combine(Dir, ExeName); } }

        static byte[] EmbeddedExe() { return Embedded.Resource("Beam.helper.BeamInput.exe"); }

        static X509Certificate2 Signer()
        {
            byte[] cer = Embedded.Resource("Beam.helper.signer.cer");
            return cer == null ? null : new X509Certificate2(cer);
        }

        // ------------------------------------------------------------------ what this PC has

        // For Settings: whether this build has the helper, whether it's set up here (and the same as this build's),
        // whether its certificate is trusted, whether UAC prompts are on the normal desktop.
        public static Dictionary<string, object> StatusObject()
        {
            var d = new Dictionary<string, object>();
            var cert = Signer();
            byte[] exe = EmbeddedExe();
            d["available"] = cert != null && exe != null;
            bool installed = File.Exists(InstalledExe);
            d["installed"] = installed;
            d["current"] = installed && exe != null && SameBytes(InstalledExe, exe);
            d["trusted"] = cert != null && Trusted(cert.Thumbprint);
            d["prompts"] = PromptsOnScreen();
            d["ready"] = installed && cert != null && Trusted(cert.Thumbprint);
            return d;
        }

        // The helper to start for a session: set up here and trusted. (null: the old way)
        public static string ReadyExe()
        {
            try
            {
                var cert = Signer();
                return cert != null && File.Exists(InstalledExe) && Trusted(cert.Thumbprint) ? InstalledExe : null;
            }
            catch { return null; }
        }

        public static bool PromptsOnScreen()
        {
            try
            {
                if (TestRoot != null) { var p = TestPolicy(); return p.ContainsKey(PolicyValue) && Json.Long(p, PolicyValue, 1) == 0; }
                using (var k = Registry.LocalMachine.OpenSubKey(PolicyKey))
                {
                    object v = k == null ? null : k.GetValue(PolicyValue);
                    return v is int && (int)v == 0;
                }
            }
            catch { return false; }
        }

        static bool Trusted(string thumbprint)
        {
            if (TestRoot != null) return TestStore().Contains(thumbprint);
            using (var store = new X509Store(StoreName.Root, StoreLocation.LocalMachine))
            {
                store.Open(OpenFlags.ReadOnly | OpenFlags.OpenExistingOnly);
                return store.Certificates.Find(X509FindType.FindByThumbprint, thumbprint, false).Count > 0;
            }
        }

        static bool SameBytes(string path, byte[] want)
        {
            try
            {
                using (var sha = SHA256.Create())
                    return sha.ComputeHash(File.ReadAllBytes(path)).SequenceEqual(sha.ComputeHash(want));
            }
            catch { return false; }
        }

        // ------------------------------------------------------------------ the setup, from Settings

        // Runs this exe as administrator (Windows asks; tests: as is, in the test root) to set up or remove the helper;
        // done(null) or done(why not) on the UI thread.
        public static void Run(App app, string action, bool prompts, Action<string> done)
        {
            string result = Path.Combine(Path.GetTempPath(), "beam-admin-helper-" + Guid.NewGuid().ToString("N") + ".json");
            var args = new StringBuilder("--admin-helper " + (action == "remove" ? "remove" : "setup"));
            if (action != "remove") args.Append(" --prompts " + (prompts ? "on" : "off"));
            args.Append(" --result \"" + result + "\"");
            if (TestRoot != null) args.Append(" --root \"" + TestRoot + "\" --config \"" + Path.Combine(app.Cfg.Dir, "config.json") + "\"");
            var psi = new ProcessStartInfo(Application.ExecutablePath, args.ToString());
            psi.UseShellExecute = true;
            if (TestRoot == null) psi.Verb = "runas";
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            Log.Write("Admin helper: " + (action == "remove" ? "removing it" : "setting it up" + (prompts ? ", with UAC prompts on the normal desktop" : "")) + (TestRoot != null ? " (test)" : " (Windows asks for administrator rights)"));
            Task.Run(() =>
            {
                string err = null;
                try
                {
                    using (var p = Process.Start(psi))
                    {
                        if (p == null || !p.WaitForExit(120000)) err = "Windows didn't finish the setup in time";
                    }
                    if (err == null)
                    {
                        var r = File.Exists(result) ? Json.ParseObject(File.ReadAllText(result, Encoding.UTF8)) : null;
                        if (r == null) err = "the setup didn't say how it went";
                        else if (!Json.Bool(r, "ok", false)) err = Json.Str(r, "error") ?? "the setup failed";
                    }
                }
                catch (Win32Exception ex) { err = ex.NativeErrorCode == 1223 ? "cancelled at Windows' prompt" : ex.Message; }
                catch (Exception ex) { err = ex.Message; }
                try { File.Delete(result); } catch { }
                Log.Write("Admin helper: " + (err == null ? (action == "remove" ? "removed" : "set up") : "not done (" + err + ")"));
                app.Post(() => done(err));
            });
        }

        // ------------------------------------------------------------------ the setup itself (elevated)

        //   Beam.exe --admin-helper setup|remove [--prompts on|off] --result <file> [--root <test dir> --config <test config>]
        // Before the instance lock and the app: it does this one thing and ends.
        public static int RunElevated(string[] args)
        {
            string action = args.Length > 1 ? args[1] : null, prompts = null, result = null, root = null, config = null;
            for (int i = 2; i + 1 < args.Length; i += 2)
            {
                switch (args[i])
                {
                    case "--prompts": prompts = args[i + 1]; break;
                    case "--result": result = args[i + 1]; break;
                    case "--root": root = args[i + 1]; break;
                    case "--config": config = args[i + 1]; break;
                }
            }
            // (1.23, the user's review) With administrator rights a test's stand-ins are refused (any program of this user
            // could run this behind Windows' prompt and point them anywhere), and the log stays in its usual place.
            bool elevated = IsElevated();
            bool testRefused = elevated && (root != null || config != null);
            if (elevated) { root = null; config = null; }
            Log.FilePath = Path.Combine(Path.GetDirectoryName(config != null ? Path.GetFullPath(config) : Config.DefaultPath()), "beam.log");
            TestRoot = root;
            string err = null;
            try
            {
                if (testRefused) err = "a test setup isn't done with administrator rights";
                else if (action == "setup") Install(prompts == "on");
                else if (action == "remove") Remove();
                else err = "unknown action";
            }
            catch (Exception ex) { err = ex.Message; Log.Error("Admin helper (" + action + ")", ex); }
            if (result != null && ResultNameOk(result))
            {
                var r = new Dictionary<string, object>();
                r["ok"] = err == null;
                if (err != null) r["error"] = err;
                // (1.23) a new file only (never one already there, or a link someone put there)
                try
                {
                    using (var f = new FileStream(result, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    {
                        var b = new UTF8Encoding(false).GetBytes(Json.Stringify(r));
                        f.Write(b, 0, b.Length);
                    }
                }
                catch (Exception ex) { Log.Write("Admin helper: no result written (" + ex.Message + ")"); }
            }
            else if (result != null) Log.Write("Admin helper: a result file not named like Beam's own is ignored");
            return err == null ? 0 : 1;
        }

        // The result's name as Run makes it: beam-admin-helper-<32 hex>.json (in the asking user's temp folder).
        static bool ResultNameOk(string path)
        {
            try
            {
                string name = Path.GetFileName(path);
                return Path.IsPathRooted(path) && System.Text.RegularExpressions.Regex.IsMatch(name, "^beam-admin-helper-[0-9a-f]{32}\\.json$");
            }
            catch { return false; }
        }

        static bool IsElevated()
        {
            try
            {
                using (var id = WindowsIdentity.GetCurrent()) return new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator);
            }
            catch { return true; } // (unknown: as if it were)
        }

        static void Install(bool prompts)
        {
            byte[] exe = EmbeddedExe();
            var cert = Signer();
            if (exe == null || cert == null) throw new InvalidOperationException("this build of Beam has no input helper");
            Directory.CreateDirectory(Dir);
            StopRunning();
            foreach (var old in Directory.GetFiles(Dir, ExeName + ".old-*")) { try { File.Delete(old); } catch { } }
            string tmp = InstalledExe + ".new";
            File.WriteAllBytes(tmp, exe);
            if (File.Exists(InstalledExe))
            {
                try { File.Delete(InstalledExe); }
                catch { File.Move(InstalledExe, InstalledExe + ".old-" + DateTime.UtcNow.Ticks); } // (still running: gone next time)
            }
            File.Move(tmp, InstalledExe);
            Log.Write("Admin helper: " + InstalledExe + " in place");

            if (TestRoot != null) { var s = TestStore(); if (!s.Contains(cert.Thumbprint)) { s.Add(cert.Thumbprint); SaveTestStore(s); } }
            else
            {
                using (var store = new X509Store(StoreName.Root, StoreLocation.LocalMachine))
                {
                    store.Open(OpenFlags.ReadWrite);
                    if (store.Certificates.Find(X509FindType.FindByThumbprint, cert.Thumbprint, false).Count == 0) store.Add(cert);
                }
            }
            Log.Write("Admin helper: its certificate (" + cert.Thumbprint + ") is trusted on this PC");

            if (prompts) PromptsOn(); else PromptsBack();
            SetOwn("Version", AppVersion.Text);
            SetOwn("Thumbprint", cert.Thumbprint);
        }

        static void Remove()
        {
            StopRunning();
            if (Directory.Exists(Dir))
            {
                foreach (var f in Directory.GetFiles(Dir, ExeName + "*")) { try { File.Delete(f); } catch { File.Move(f, f + ".old-" + DateTime.UtcNow.Ticks); } }
                try { if (!Directory.EnumerateFileSystemEntries(Dir).Any()) Directory.Delete(Dir); } catch { }
            }
            var cert = Signer();
            string thumb = cert != null ? cert.Thumbprint : GetOwn("Thumbprint") as string;
            if (thumb != null)
            {
                if (TestRoot != null) { var s = TestStore(); s.Remove(thumb); SaveTestStore(s); }
                else
                {
                    using (var store = new X509Store(StoreName.Root, StoreLocation.LocalMachine))
                    {
                        store.Open(OpenFlags.ReadWrite);
                        foreach (var c in store.Certificates.Find(X509FindType.FindByThumbprint, thumb, false)) store.Remove(c);
                    }
                }
            }
            PromptsBack();
            DeleteOwn();
            Log.Write("Admin helper: removed (the helper, its certificate" + (thumb != null ? " " + thumb : "") + ", and the UAC prompts back as they were)");
        }

        // UAC prompts on the normal desktop; the value before is kept (once) to put back.
        static void PromptsOn()
        {
            if (GetOwn("PromptOnSecureDesktopBefore") == null)
            {
                object before = GetPolicy();
                SetOwn("PromptOnSecureDesktopBefore", before is int ? (int)before : -1);
            }
            SetPolicy(0);
            Log.Write("Admin helper: UAC prompts show on the normal desktop now (PromptOnSecureDesktop 0)");
        }

        // Back to how it was before PromptsOn (nothing if it was never changed here).
        static void PromptsBack()
        {
            object before = GetOwn("PromptOnSecureDesktopBefore");
            if (!(before is int)) return;
            SetPolicy((int)before < 0 ? (int?)null : (int)before);
            DeleteOwnValue("PromptOnSecureDesktopBefore");
            Log.Write("Admin helper: UAC prompts back as they were (PromptOnSecureDesktop " + ((int)before < 0 ? "not set" : before.ToString()) + ")");
        }

        // A helper still running from this folder (a session in progress) keeps its file: it's ended first.
        static void StopRunning()
        {
            foreach (var p in Process.GetProcessesByName(Path.GetFileNameWithoutExtension(ExeName)))
            {
                try
                {
                    string path = p.MainModule.FileName;
                    if (string.Equals(Path.GetFullPath(path), Path.GetFullPath(InstalledExe), StringComparison.OrdinalIgnoreCase)) { p.Kill(); p.WaitForExit(3000); }
                }
                catch { }
                finally { p.Dispose(); }
            }
        }

        // ---- HKLM (or the test root's files)

        static object GetPolicy()
        {
            if (TestRoot != null) { var p = TestPolicy(); return p.ContainsKey(PolicyValue) ? (object)(int)Json.Long(p, PolicyValue, 1) : null; }
            using (var k = Registry.LocalMachine.OpenSubKey(PolicyKey)) return k == null ? null : k.GetValue(PolicyValue);
        }

        static void SetPolicy(int? value)
        {
            if (TestRoot != null)
            {
                var p = TestPolicy();
                if (value.HasValue) p[PolicyValue] = (long)value.Value; else p.Remove(PolicyValue);
                SaveTestPolicy(p);
                return;
            }
            using (var k = Registry.LocalMachine.CreateSubKey(PolicyKey))
            {
                if (value.HasValue) k.SetValue(PolicyValue, value.Value, RegistryValueKind.DWord);
                else k.DeleteValue(PolicyValue, false);
            }
        }

        static object GetOwn(string name)
        {
            if (TestRoot != null) { var o = TestOwn(); object v; return o.TryGetValue(name, out v) ? (v is long ? (object)(int)(long)v : v) : null; }
            using (var k = Registry.LocalMachine.OpenSubKey(OwnKey)) return k == null ? null : k.GetValue(name);
        }

        static void SetOwn(string name, object value)
        {
            if (TestRoot != null) { var o = TestOwn(); o[name] = value is int ? (object)(long)(int)value : value; SaveTestOwn(o); return; }
            using (var k = Registry.LocalMachine.CreateSubKey(OwnKey))
                k.SetValue(name, value, value is int ? RegistryValueKind.DWord : RegistryValueKind.String);
        }

        static void DeleteOwnValue(string name)
        {
            if (TestRoot != null) { var o = TestOwn(); o.Remove(name); SaveTestOwn(o); return; }
            using (var k = Registry.LocalMachine.OpenSubKey(OwnKey, true)) if (k != null) k.DeleteValue(name, false);
        }

        static void DeleteOwn()
        {
            if (TestRoot != null) { try { File.Delete(Path.Combine(TestRoot, "own.json")); } catch { } return; }
            Registry.LocalMachine.DeleteSubKeyTree(OwnKey, false);
            using (var k = Registry.LocalMachine.OpenSubKey(BeamKey))
                if (k != null && k.SubKeyCount == 0 && k.ValueCount == 0) { k.Close(); Registry.LocalMachine.DeleteSubKey(BeamKey, false); }
        }

        // ---- tests' stand-ins (the test root only)

        static Dictionary<string, object> ReadTestJson(string name)
        {
            try { return Json.ParseObject(File.ReadAllText(Path.Combine(TestRoot, name), Encoding.UTF8)) ?? new Dictionary<string, object>(); }
            catch { return new Dictionary<string, object>(); }
        }

        static void WriteTestJson(string name, Dictionary<string, object> d)
        {
            Directory.CreateDirectory(TestRoot);
            File.WriteAllText(Path.Combine(TestRoot, name), Json.Stringify(d), new UTF8Encoding(false));
        }

        static Dictionary<string, object> TestPolicy() { return ReadTestJson("policy.json"); }
        static void SaveTestPolicy(Dictionary<string, object> d) { WriteTestJson("policy.json", d); }
        static Dictionary<string, object> TestOwn() { return ReadTestJson("own.json"); }
        static void SaveTestOwn(Dictionary<string, object> d) { WriteTestJson("own.json", d); }
        static List<string> TestStore() { return Json.StrList(ReadTestJson("store.json"), "root") ?? new List<string>(); }

        static void SaveTestStore(List<string> list)
        {
            var d = new Dictionary<string, object>();
            d["root"] = list.Cast<object>().ToArray();
            WriteTestJson("store.json", d);
        }
    }

    // A session's input through the helper (see AdminHelper), the fallback until it's connected and if it ends.
    class HelperBackend : IInputBackend
    {
        const int MaxBatch = 256, RecordSize = 24;
        readonly IInputBackend fallback;
        readonly Func<string> exeSource;   // the helper to start, or null
        readonly string record;            // tests: the helper records here instead of SendInput
        readonly object io = new object();
        NamedPipeServerStream pipe;
        volatile bool ready, uiAccess;
        int generation;

        public HelperBackend(IInputBackend fallback, Func<string> exeSource, string record)
        {
            this.fallback = fallback;
            this.exeSource = exeSource;
            this.record = record;
        }

        public string Name { get { return ready ? (uiAccess ? "the input helper (administrator windows too)" : "the input helper (without UIAccess)") : fallback.Name; } }
        public bool Reaches { get { return ready && uiAccess; } }   // administrator windows (and prompts on the normal desktop)
        public bool Wanted { get { return wanted; } }               // this session started one (set up here), connected or not yet
        volatile bool wanted;

        // A session starts: the helper, if this PC has it (one already connected stays).
        public void Begin()
        {
            if (ready) return;
            string exe;
            try { exe = exeSource(); }
            catch { exe = null; }
            if (exe == null) return;
            End();
            wanted = true;
            int mine;
            lock (io) mine = ++generation;
            string name = "beam-input-" + Hex(RandomBytes(12));
            byte[] token = RandomBytes(32);
            NamedPipeServerStream p;
            try
            {
                var sec = new PipeSecurity();
                sec.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
                sec.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
                p = new NamedPipeServerStream(name, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 4096, 4096, sec);
            }
            catch (Exception ex) { Log.Error("Remote control: the input helper's pipe", ex); return; }
            Process proc;
            try
            {
                string args = "--pipe " + name + " --parent " + Process.GetCurrentProcess().Id + " --token " + Hex(token) + (record != null ? " --record \"" + record + "\"" : "");
                var psi = new ProcessStartInfo(exe, args);
                psi.UseShellExecute = true; // (a UIAccess program starts through Windows' AppInfo)
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                proc = Process.Start(psi);
                if (proc == null) throw new InvalidOperationException("no process");
            }
            catch (Exception ex)
            {
                p.Dispose();
                Log.Write("Remote control: the input helper didn't start (" + ex.Message + "); input goes the usual way");
                return;
            }
            lock (io) pipe = p;
            Task.Run(() => Connect(p, proc, token, mine));
        }

        async Task Connect(NamedPipeServerStream p, Process proc, byte[] token, int mine)
        {
            string why = null;
            try
            {
                var waiting = p.WaitForConnectionAsync();
                if (await Task.WhenAny(waiting, Task.Delay(10000)) != waiting) why = "it didn't connect in 10 s";
                else
                {
                    await waiting;
                    uint client;
                    if (!GetNamedPipeClientProcessId(p.SafePipeHandle.DangerousGetHandle(), out client) || client != (uint)proc.Id) why = "another program connected";
                    else
                    {
                        var hello = new byte[40];
                        var reading = ReadAll(p, hello);
                        if (await Task.WhenAny(reading, Task.Delay(5000)) != reading || !await reading) why = "it didn't say hello";
                        else if (Encoding.ASCII.GetString(hello, 0, 6) != "BEAMIN" || hello[6] != AdminHelper.Protocol || !hello.Skip(8).Take(32).SequenceEqual(token)) why = "it isn't the helper this Beam started";
                        else
                        {
                            lock (io)
                            {
                                if (mine != generation) { why = "the session ended"; }
                                else { uiAccess = hello[7] == 1; ready = true; }
                            }
                        }
                    }
                }
            }
            catch (Exception ex) { why = ex.Message; }
            finally { try { proc.Dispose(); } catch { } }
            if (why == null) Log.Write("Remote control: input through " + Name + (uiAccess ? "" : ": administrator windows stay out of reach (its setup isn't complete here)"));
            else
            {
                Log.Write("Remote control: the input helper isn't used (" + why + "); input goes the usual way");
                lock (io) { if (pipe == p) pipe = null; }
                try { p.Dispose(); } catch { }
            }
        }

        static async Task<bool> ReadAll(Stream s, byte[] buf)
        {
            int got = 0;
            while (got < buf.Length)
            {
                int r = await s.ReadAsync(buf, got, buf.Length - got);
                if (r <= 0) return false;
                got += r;
            }
            return true;
        }

        public int Send(InputRecord[] records)
        {
            if (records.Length == 0) return 0;
            if (ready)
            {
                lock (io)
                {
                    if (ready && pipe != null)
                    {
                        try
                        {
                            int sent = 0;
                            for (int at = 0; at < records.Length; at += MaxBatch)
                            {
                                int n = Math.Min(MaxBatch, records.Length - at);
                                var frame = new byte[2 + n * RecordSize];
                                frame[0] = (byte)(n & 0xFF);
                                frame[1] = (byte)(n >> 8);
                                for (int i = 0; i < n; i++) Encode(records[at + i], frame, 2 + i * RecordSize);
                                pipe.Write(frame, 0, frame.Length);
                                pipe.Flush();
                                var reply = new byte[2];
                                int got = 0;
                                while (got < 2)
                                {
                                    int r = pipe.Read(reply, got, 2 - got);
                                    if (r <= 0) throw new IOException("the helper ended");
                                    got += r;
                                }
                                sent += reply[0] | (reply[1] << 8);
                            }
                            return sent;
                        }
                        catch (Exception ex)
                        {
                            Log.Write("Remote control: the input helper stopped (" + ex.Message + "); input goes the usual way");
                            ready = false;
                            try { pipe.Dispose(); } catch { }
                            pipe = null;
                        }
                    }
                }
            }
            return fallback.Send(records);
        }

        static void Encode(InputRecord r, byte[] b, int o)
        {
            b[o] = (byte)r.Type;
            BitConverter.GetBytes(r.Vk).CopyTo(b, o + 2);
            BitConverter.GetBytes(r.Scan).CopyTo(b, o + 4);
            BitConverter.GetBytes(r.Dx).CopyTo(b, o + 8);
            BitConverter.GetBytes(r.Dy).CopyTo(b, o + 12);
            BitConverter.GetBytes(r.MouseData).CopyTo(b, o + 16);
            BitConverter.GetBytes(r.Flags).CopyTo(b, o + 20);
        }

        // The session ended: the helper is told so and quits.
        public void End()
        {
            NamedPipeServerStream p;
            bool was;
            wanted = false;
            lock (io)
            {
                generation++;
                p = pipe;
                pipe = null;
                was = ready;
                ready = false;
                uiAccess = false;
            }
            if (p == null) return;
            try { if (was) { p.Write(new byte[2], 0, 2); p.Flush(); } } catch { }
            try { p.Dispose(); } catch { }
            if (was) Log.Write("Remote control: the input helper is closed (the session ended)");
        }

        static byte[] RandomBytes(int n)
        {
            var b = new byte[n];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(b);
            return b;
        }

        static string Hex(byte[] b)
        {
            var sb = new StringBuilder(b.Length * 2);
            foreach (byte x in b) sb.Append(x.ToString("x2"));
            return sb.ToString();
        }

        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint pid);
    }
}
