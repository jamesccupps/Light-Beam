// Collecting from this PC, read only (Beam 1.41 + this app 1.32; the user, 2026-11-23: "there should be a way to gather
// logs and other things from other devices … the claude code chat on this computer … can utlize beam for some things it
// may need from that computer"; their picks: "Read-only first", "The beam command"). Off until someone at this PC turns
// on "Let approved devices collect logs" (Settings → This PC: Beam's own question here; off from anywhere). The server
// passes on only what an approved, lasting sign-in asked (`collect-request`), and this app answers fixed, read-only
// requests: Windows' event logs, the log folders chosen here (their files and a file's end: never outside them, no
// links followed, nothing hidden or dot-named), its processes, services and system. Never code, never anything written
// or changed. beam.log says who asked for what kind, never what went back. (Beam-dev\plan\collect.md)
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Beam
{
    // A folder whose files approved devices may read (chosen at this PC).
    class LogFolder
    {
        public string Name, Path;
        public bool Auto; // (1.34) found by itself (Windows' own, or a program's folder named log/logs), not chosen here

        public static LogFolder Parse(Dictionary<string, object> d)
        {
            if (d == null) return null;
            var f = new LogFolder();
            f.Path = Json.Str(d, "path");
            f.Name = Json.Str(d, "name");
            if (string.IsNullOrWhiteSpace(f.Path)) return null;
            if (string.IsNullOrWhiteSpace(f.Name)) f.Name = Shares.DefaultName(f.Path);
            return f;
        }

        public Dictionary<string, object> ToJson()
        {
            var d = new Dictionary<string, object>();
            d["name"] = Name;
            d["path"] = Path;
            if (Auto) d["auto"] = true;
            return d;
        }

        public LogFolder Copy()
        {
            var f = new LogFolder();
            f.Name = Name; f.Path = Path;
            return f;
        }
    }

    // Why a request isn't answered, said to the device that asked (reason: a word the server passes on).
    class CollectRefusal : Exception
    {
        public readonly string Reason;
        public CollectRefusal(string message, string reason) : base(message) { Reason = reason; }
    }

    class LogCollector
    {
        readonly App app;
        public const string OnlyHere = "Collecting is turned on only at this PC: Beam's Settings on this PC (Let approved devices collect logs)";
        const int BudgetMs = 25000; // an answer's time at most (the server waits 45 s)
        static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        public LogCollector(App app) { this.app = app; }

        public bool Allowed { get { return app.Cfg.CollectAllowed; } }

        // ------------------------------------------------------------------ the switch

        public void SetAllowed(bool on, string from)
        {
            if (app.Cfg.CollectAllowed == on) return;
            if (on && app.RcBlocks("turning collecting on")) return;
            app.Cfg.CollectAllowed = on;
            app.Cfg.Save();
            Log.Write("Collecting: " + (on ? "approved devices may collect this PC's logs, processes and services (read only)" : "turned off on this PC") + " (" + from + ")");
            app.CollectChanged(on ? "turned on" : "turned off");
        }

        // Settings' "Let approved devices collect logs": on through a question here, off at once.
        public void Toggle(string from)
        {
            if (app.Cfg.CollectAllowed) { SetAllowed(false, from); return; }
            if (app.RcBlocks("turning collecting on")) return;
            var r = MessageBox.Show("Let your approved devices collect logs from this PC?\n\nThey could read Windows' event logs (those " +
                Environment.UserName + " may read), Windows' and programs' own log folders (found by themselves; Log folders… can turn " +
                "that off), the log folders you choose, and which programs and services run. " +
                "Read only: nothing is run or changed here, and nothing else on this PC is shown. Turn it off in Beam's Settings here.",
                "Beam", MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
            if (r == DialogResult.OK) SetAllowed(true, from);
        }

        // ------------------------------------------------------------------ a request

        public async void OnRequest(Dictionary<string, object> d)
        {
            var api = app.Api;
            string id = Json.Str(d, "id");
            if (api == null || string.IsNullOrEmpty(id)) return;
            string what = Json.Str(d, "what") ?? "";
            var p = Json.Obj(Json.Get(d, "params")) ?? new Dictionary<string, object>();
            var by = Json.Obj(Json.Get(d, "by"));
            string byName = by != null ? (Json.Str(by, "name") ?? "a device") : "a device";
            var body = new Dictionary<string, object>();
            body["id"] = id;
            if (!Allowed)
            {
                body["error"] = "collecting is off on this PC";
                body["reason"] = "off";
                Log.Write("Collecting: " + Safe(what) + " for " + byName + " not given (off here)");
            }
            else
            {
                try
                {
                    var clock = Stopwatch.StartNew();
                    body["data"] = await Task.Run(() => Gather(what, p));
                    Log.Write("Collecting: " + what + " for " + byName + " (" + clock.ElapsedMilliseconds + " ms)");
                }
                catch (CollectRefusal ex)
                {
                    body["error"] = ex.Message;
                    body["reason"] = ex.Reason;
                    Log.Write("Collecting: " + Safe(what) + " for " + byName + " not given (" + ex.Reason + ")");
                }
                catch (Exception ex)
                {
                    body["error"] = "it failed here: " + ex.Message;
                    body["reason"] = "failed";
                    Log.Write("Collecting: " + Safe(what) + " for " + byName + " failed (" + ex.GetType().Name + ")");
                }
            }
            try { await api.Call(HttpMethod.Post, "/api/devices/me/collect", body, 60, CancellationToken.None); }
            catch (Exception ex) { Log.Write("Collecting: the answer didn't go (" + Api.Describe(ex) + ")"); }
        }

        static string Safe(string what) { return Regex.IsMatch(what ?? "", "^[a-z-]{1,20}$") ? what : "something"; }

        Dictionary<string, object> Gather(string what, Dictionary<string, object> p)
        {
            switch (what)
            {
                case "events": return Events(p);
                case "folders": return Folders();
                case "files": return Shares.LogFiles(app, Json.Str(p, "folder"), Json.Str(p, "path"));
                case "file": return Shares.LogTail(app, Json.Str(p, "folder"), Json.Str(p, "path"), (int)Clamp(Json.Long(p, "tail", 200), 1, 20000));
                case "processes": return Processes(Json.Str(p, "name"));
                case "services": return Services(Json.Str(p, "name"));
                case "system": return SystemInfo();
            }
            throw new CollectRefusal("this PC's Beam doesn't know that request", "unknown");
        }

        static long Clamp(long v, long min, long max) { return Math.Max(min, Math.Min(max, v)); }

        static long Ms(DateTime t) { return (long)(t.ToUniversalTime() - Epoch).TotalMilliseconds; }

        // ------------------------------------------------------------------ Windows' event logs

        static readonly Dictionary<string, string> LevelQuery = new Dictionary<string, string>
        {
            { "critical", "Level=1" },
            { "error", "(Level=1 or Level=2)" },
            { "warning", "(Level=1 or Level=2 or Level=3)" },
            { "info", "(Level=0 or Level=1 or Level=2 or Level=3 or Level=4)" },
            { "all", null },
        };

        static Dictionary<string, object> Events(Dictionary<string, object> p)
        {
            string log = Json.Str(p, "log") ?? "System";
            if (!Regex.IsMatch(log, @"^[\w .\-/]{1,200}$")) throw new CollectRefusal("that isn't an event log's name", "bad");
            long since = Clamp(Json.Long(p, "since", 60), 1, 43200);
            string level = Json.Str(p, "level") ?? "warning";
            if (!LevelQuery.ContainsKey(level)) throw new CollectRefusal("that isn't a level", "bad");
            string source = Json.Str(p, "source");
            if (source != null && (source.Length > 200 || source.IndexOfAny(new[] { '\'', '"', '<', '>', '&' }) >= 0)) throw new CollectRefusal("that isn't a source's name", "bad");
            long eventId = Json.Long(p, "event", -1);
            int max = (int)Clamp(Json.Long(p, "max", 200), 1, 1000);
            var when = new List<string>();
            when.Add("TimeCreated[timediff(@SystemTime) <= " + (since * 60000L).ToString(CultureInfo.InvariantCulture) + "]");
            if (LevelQuery[level] != null) when.Add(LevelQuery[level]);
            if (!string.IsNullOrEmpty(source)) when.Add("Provider[@Name='" + source + "']");
            if (eventId >= 0 && eventId <= 65535) when.Add("EventID=" + eventId.ToString(CultureInfo.InvariantCulture));
            var q = new EventLogQuery(log, PathType.LogName, "*[System[" + string.Join(" and ", when) + "]]");
            q.ReverseDirection = true; // the newest first
            var list = new List<object>();
            bool more = false, cut = false;
            var clock = Stopwatch.StartNew();
            try
            {
                using (var reader = new EventLogReader(q))
                {
                    for (EventRecord e = reader.ReadEvent(); e != null; e = reader.ReadEvent())
                    {
                        using (e)
                        {
                            if (list.Count >= max) { more = true; break; }
                            if (clock.ElapsedMilliseconds > BudgetMs) { cut = true; break; }
                            list.Add(EventOf(e));
                        }
                    }
                }
            }
            catch (EventLogNotFoundException) { throw new CollectRefusal("there's no event log named " + log + " on this PC", "not-found"); }
            catch (UnauthorizedAccessException) { throw new CollectRefusal("the " + log + " log needs administrator rights to read (Beam never has them)", "denied"); }
            catch (EventLogException ex) { throw new CollectRefusal("Windows couldn't read the " + log + " log (" + ex.Message + ")", "failed"); }
            var d = new Dictionary<string, object>();
            d["log"] = log;
            d["since"] = since;
            d["level"] = level;
            if (!string.IsNullOrEmpty(source)) d["source"] = source;
            d["events"] = list.ToArray();
            d["more"] = more;
            d["cut"] = cut;
            return d;
        }

        static Dictionary<string, object> EventOf(EventRecord e)
        {
            var d = new Dictionary<string, object>();
            d["at"] = e.TimeCreated.HasValue ? (object)Ms(e.TimeCreated.Value) : null;
            int lv = e.Level.HasValue ? e.Level.Value : 4;
            d["level"] = lv == 1 ? "critical" : lv == 2 ? "error" : lv == 3 ? "warning" : lv == 5 ? "verbose" : "info";
            d["source"] = e.ProviderName;
            d["id"] = e.Id;
            string msg = null;
            try { msg = e.FormatDescription(); } catch { }
            if (string.IsNullOrEmpty(msg))
            {
                // the source's own wording isn't on this PC: its values instead
                var parts = new List<string>();
                try { foreach (var v in e.Properties) parts.Add(Convert.ToString(v.Value, CultureInfo.InvariantCulture)); } catch { }
                msg = "(no description on this PC)" + (parts.Count > 0 ? " " + string.Join("; ", parts) : "");
            }
            d["message"] = msg.Length > 4000 ? msg.Substring(0, 4000) + "…" : msg.Trim();
            return d;
        }

        // ------------------------------------------------------------------ the log folders, processes, services, system

        Dictionary<string, object> Folders()
        {
            var d = new Dictionary<string, object>();
            d["folders"] = Shares.AllLogFolders(app.Cfg).Select(f => (object)f.ToJson()).ToArray();
            return d;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool QueryFullProcessImageNameW(IntPtr process, int flags, StringBuilder name, ref int size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CloseHandle(IntPtr h);

        // A program's file, where Windows lets this account ask (not a protected process's).
        static string ImagePath(int pid)
        {
            const uint QueryLimited = 0x1000;
            IntPtr h = OpenProcess(QueryLimited, false, pid);
            if (h == IntPtr.Zero) return null;
            try
            {
                var sb = new StringBuilder(1024);
                int n = sb.Capacity;
                return QueryFullProcessImageNameW(h, 0, sb, ref n) ? sb.ToString(0, n) : null;
            }
            finally { CloseHandle(h); }
        }

        // What runs, the most memory first. No command lines: they can hold passwords.
        static Dictionary<string, object> Processes(string filter)
        {
            var list = new List<Dictionary<string, object>>();
            foreach (var p in Process.GetProcesses())
            {
                using (p)
                {
                    try
                    {
                        string name = p.ProcessName;
                        if (!string.IsNullOrEmpty(filter) && name.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0) continue;
                        var d = new Dictionary<string, object>();
                        d["name"] = name;
                        d["pid"] = p.Id;
                        long mem = 0;
                        try { mem = p.PrivateMemorySize64; } catch { }
                        d["memory"] = mem;
                        try { d["cpu"] = Math.Round(p.TotalProcessorTime.TotalSeconds, 1); } catch { d["cpu"] = null; }
                        try { d["started"] = Ms(p.StartTime); } catch { d["started"] = null; }
                        d["path"] = ImagePath(p.Id);
                        string title = null;
                        try { title = p.MainWindowTitle; } catch { }
                        if (!string.IsNullOrEmpty(title)) d["title"] = title.Length > 200 ? title.Substring(0, 200) : title;
                        try { d["session"] = p.SessionId; } catch { }
                        list.Add(d);
                    }
                    catch { } // (it ended meanwhile)
                }
            }
            var o = new Dictionary<string, object>();
            o["processes"] = list.OrderByDescending(x => (long)x["memory"]).Cast<object>().ToArray();
            return o;
        }

        static string StatusName(ServiceControllerStatus s)
        {
            switch (s)
            {
                case ServiceControllerStatus.Running: return "running";
                case ServiceControllerStatus.Stopped: return "stopped";
                case ServiceControllerStatus.Paused: return "paused";
                case ServiceControllerStatus.StartPending: return "starting";
                case ServiceControllerStatus.StopPending: return "stopping";
                case ServiceControllerStatus.PausePending: return "pausing";
                case ServiceControllerStatus.ContinuePending: return "resuming";
            }
            return s.ToString().ToLowerInvariant();
        }

        static Dictionary<string, object> Services(string filter)
        {
            var list = new List<Dictionary<string, object>>();
            foreach (var s in ServiceController.GetServices())
            {
                using (s)
                {
                    try
                    {
                        if (!string.IsNullOrEmpty(filter) && s.ServiceName.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0
                            && s.DisplayName.IndexOf(filter, StringComparison.OrdinalIgnoreCase) < 0) continue;
                        var d = new Dictionary<string, object>();
                        d["name"] = s.ServiceName;
                        d["display"] = s.DisplayName;
                        d["status"] = StatusName(s.Status);
                        try { d["start"] = s.StartType.ToString().ToLowerInvariant(); } catch { d["start"] = null; }
                        list.Add(d);
                    }
                    catch { }
                }
            }
            var o = new Dictionary<string, object>();
            o["services"] = list.OrderBy(x => (string)x["name"], StringComparer.OrdinalIgnoreCase).Cast<object>().ToArray();
            return o;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct MemoryStatus
        {
            public uint Length, Load;
            public ulong TotalPhys, AvailPhys, TotalPageFile, AvailPageFile, TotalVirtual, AvailVirtual, AvailExtendedVirtual;
        }
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GlobalMemoryStatusEx(ref MemoryStatus m);
        [DllImport("kernel32.dll")]
        static extern ulong GetTickCount64();

        static Dictionary<string, object> SystemInfo()
        {
            var d = new Dictionary<string, object>();
            d["computer"] = Environment.MachineName;
            d["user"] = Environment.UserName;
            var os = new Dictionary<string, object>();
            os["name"] = StatusReporter.OsName();
            os["version"] = Environment.OSVersion.Version.ToString();
            try
            {
                using (var k = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion"))
                {
                    if (k != null)
                    {
                        string build = k.GetValue("CurrentBuildNumber") as string;
                        object ubr = k.GetValue("UBR");
                        if (build != null) os["build"] = build + (ubr is int ? "." + ((int)ubr).ToString(CultureInfo.InvariantCulture) : "");
                    }
                }
            }
            catch { }
            d["os"] = os;
            d["bootedAt"] = Ms(DateTime.UtcNow.AddMilliseconds(-(double)GetTickCount64()));
            var cpu = new Dictionary<string, object>();
            try
            {
                using (var k = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"HARDWARE\DESCRIPTION\System\CentralProcessor\0"))
                    cpu["name"] = k != null ? ((k.GetValue("ProcessorNameString") as string) ?? "").Trim() : null;
            }
            catch { }
            cpu["threads"] = Environment.ProcessorCount;
            d["cpu"] = cpu;
            var m = new MemoryStatus();
            m.Length = (uint)Marshal.SizeOf(typeof(MemoryStatus));
            if (GlobalMemoryStatusEx(ref m))
            {
                var mem = new Dictionary<string, object>();
                mem["total"] = (long)m.TotalPhys;
                mem["free"] = (long)m.AvailPhys;
                d["memory"] = mem;
            }
            var disks = new List<object>();
            foreach (var drive in DriveInfo.GetDrives())
            {
                try
                {
                    if (drive.DriveType != DriveType.Fixed || !drive.IsReady) continue;
                    var x = new Dictionary<string, object>();
                    x["name"] = drive.Name.TrimEnd('\\');
                    x["label"] = drive.VolumeLabel;
                    x["format"] = drive.DriveFormat;
                    x["total"] = drive.TotalSize;
                    x["free"] = drive.AvailableFreeSpace;
                    disks.Add(x);
                }
                catch { }
            }
            d["disks"] = disks.ToArray();
            d["timeZone"] = TimeZoneInfo.Local.Id;
            d["beam"] = AppVersion.Text;
            return d;
        }
    }

    // The log folders: Shared folders' own rules for what's inside one (no links followed, nothing hidden, no dot-names,
    // never outside), and their own for what may be one (logs live under AppData, ProgramData and Program Files, so a
    // folder inside those is fine; never a whole drive, the whole user folder, those folders themselves, a network folder,
    // or Beam's own folder: its sign-in is there).
    static partial class Shares
    {
        const int LogMaxBytes = 1024 * 1024; // a file's text at most
        const int LogMaxEntries = 500;

        public static string LogFolderRefusal(string path, Config cfg)
        {
            string full;
            try { full = System.IO.Path.GetFullPath(path ?? "").TrimEnd('\\'); }
            catch { return "that isn't a folder"; }
            if (full.StartsWith(@"\\")) return "a network folder can't be one";
            if (!Directory.Exists(full)) return "that folder isn't there";
            try { if (new DriveInfo(System.IO.Path.GetPathRoot(full)).DriveType == DriveType.Network) return "a network folder can't be one"; }
            catch { }
            string real = FinalPath(full);
            if (real == null) return "Beam can't tell where that folder really is";
            if (real.StartsWith(@"\\")) return "a network folder can't be one";
            string why = LogRefusalAt(full, cfg);
            if (why == null && !real.Equals(full, StringComparison.OrdinalIgnoreCase)) why = LogRefusalAt(real, cfg);
            return why;
        }

        static string LogRefusalAt(string full, Config cfg)
        {
            string root = (System.IO.Path.GetPathRoot(full) ?? "").TrimEnd('\\');
            if (full.Equals(root, StringComparison.OrdinalIgnoreCase)) return "a whole drive can't be one: pick the folder the logs are in";
            string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile).TrimEnd('\\');
            if (profile.Length > 0 && Within(profile, full)) return "your whole user folder can't be one: pick the folder the logs are in";
            foreach (var sf in new[] { Environment.SpecialFolder.ApplicationData, Environment.SpecialFolder.LocalApplicationData, Environment.SpecialFolder.CommonApplicationData,
                Environment.SpecialFolder.Windows, Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86 })
            {
                string p = Environment.GetFolderPath(sf).TrimEnd('\\');
                if (p.Length > 0 && Within(p, full)) return "that's one of Windows' or all apps' own folders: pick the folder the logs are in, inside it";
            }
            foreach (var b in BeamFolders(cfg)) // (1.34: its data too, not only its settings; after the roots, as for shares)
                if (Within(full, b) || Within(b, full)) return "Beam's own folder (its sign-in is there) can't be one";
            foreach (var part in full.Substring(root.Length).Split(new[] { '\\' }, StringSplitOptions.RemoveEmptyEntries))
                if (part.StartsWith(".")) return "a folder whose name starts with \".\" can't be one";
            return null;
        }

        // (1.34) Log folders found by themselves (the user: "why when i turn on the log access it doesnt automatically add
        // logs from windows too?"): Windows' own (Logs, setup's Panther, crash reports), and every folder named log or logs
        // at most three folders down in ProgramData, Program Files and AppData (not in apps' packages, temp files, caches or
        // browsers' profiles), each named for where it is ("exacqVision Server logs"). Looked for again after 10 minutes.
        static readonly object foundLock = new object();
        static List<LogFolder> found;
        static DateTime foundAt;
        static readonly string[] SkipDirs = { "Packages", "Temp", "Cache", "Caches", "INetCache", "User Data", "Profiles", "node_modules", "CrashDumps" };

        public static List<LogFolder> FoundLogFolders(Config cfg)
        {
            lock (foundLock)
            {
                if (found != null && DateTime.UtcNow - foundAt < TimeSpan.FromMinutes(10)) return found;
                var list = new List<LogFolder>();
                var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                Action<string, string> add = (name, path) =>
                {
                    try
                    {
                        string full = System.IO.Path.GetFullPath(path).TrimEnd('\\');
                        if (!Directory.Exists(full) || list.Any(x => x.Path.Equals(full, StringComparison.OrdinalIgnoreCase))) return;
                        if (LogFolderRefusal(full, cfg) != null) return;
                        string unique = name;
                        for (int i = 2; names.Contains(unique); i++) unique = name + " (" + i + ")";
                        names.Add(unique);
                        var f = new LogFolder();
                        f.Name = unique; f.Path = full; f.Auto = true;
                        list.Add(f);
                    }
                    catch { }
                };
                var roots = new List<KeyValuePair<string, string>>();
                if (cfg.CustomPath && cfg.TestLogRoots.Count > 0)
                    foreach (var r in cfg.TestLogRoots) roots.Add(new KeyValuePair<string, string>(System.IO.Path.GetFileName(r.TrimEnd('\\')), r));
                else
                {
                    string win = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
                    string data = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);
                    add("Windows logs", System.IO.Path.Combine(win, "Logs"));
                    add("Windows setup logs", System.IO.Path.Combine(win, "Panther"));
                    add("Windows crash reports", System.IO.Path.Combine(data, @"Microsoft\Windows\WER\ReportArchive"));
                    foreach (var sf in new[] { Environment.SpecialFolder.CommonApplicationData, Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86,
                        Environment.SpecialFolder.LocalApplicationData, Environment.SpecialFolder.ApplicationData })
                    {
                        string r = Environment.GetFolderPath(sf);
                        if (r.Length > 0 && !roots.Any(x => x.Value.Equals(r, StringComparison.OrdinalIgnoreCase))) roots.Add(new KeyValuePair<string, string>(System.IO.Path.GetFileName(r), r));
                    }
                }
                var clock = System.Diagnostics.Stopwatch.StartNew();
                foreach (var root in roots)
                {
                    var hits = new List<string>();
                    ScanForLogs(root.Value.TrimEnd('\\'), 0, hits, clock);
                    foreach (var hit in hits.OrderBy(h => h, StringComparer.OrdinalIgnoreCase))
                    {
                        var parts = hit.Substring(root.Value.TrimEnd('\\').Length).Split(new[] { '\\' }, StringSplitOptions.RemoveEmptyEntries).ToList();
                        string last = parts[parts.Count - 1];
                        parts.RemoveAt(parts.Count - 1);
                        add((parts.Count > 0 ? string.Join(" ", parts) : root.Key) + " " + last.ToLowerInvariant(), hit);
                    }
                }
                found = list;
                foundAt = DateTime.UtcNow;
                return found;
            }
        }

        static void ScanForLogs(string dir, int depth, List<string> hits, System.Diagnostics.Stopwatch clock)
        {
            if (depth > 3 || hits.Count >= 150 || clock.ElapsedMilliseconds > 4000) return;
            foreach (var e in Read(dir))
            {
                if (!e.Dir || !Shown(e) || (e.Attributes & ReparsePoint) != 0) continue;
                if (SkipDirs.Any(s => string.Equals(s, e.Name, StringComparison.OrdinalIgnoreCase))) continue;
                string full = dir + "\\" + e.Name;
                if (string.Equals(e.Name, "logs", StringComparison.OrdinalIgnoreCase) || string.Equals(e.Name, "log", StringComparison.OrdinalIgnoreCase)) { hits.Add(full); continue; }
                if (depth < 3) ScanForLogs(full, depth + 1, hits, clock);
            }
        }

        // The chosen ones first, then (when that's on) the ones found by themselves.
        public static List<LogFolder> AllLogFolders(Config cfg)
        {
            var all = cfg.CollectFolders.ToList();
            if (cfg.CollectAuto)
                foreach (var f in FoundLogFolders(cfg))
                    if (!all.Any(x => x.Path.Equals(f.Path, StringComparison.OrdinalIgnoreCase) || string.Equals(x.Name, f.Name, StringComparison.OrdinalIgnoreCase))) all.Add(f);
            return all;
        }

        // A log folder by its name (as `folders` lists them), still allowed.
        static LogFolder LogFolderNamed(App app, string name)
        {
            var f = AllLogFolders(app.Cfg).FirstOrDefault(x => string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase));
            if (f == null) throw new CollectRefusal("there's no log folder named " + (name ?? "?") + " here (folders lists them)", "not-found");
            string why = LogFolderRefusal(f.Path, app.Cfg);
            if (why != null) throw new CollectRefusal(f.Name + " can't be read now: " + why, "not-found");
            return f;
        }

        // What's in a log folder (or a folder inside it), the newest first.
        public static Dictionary<string, object> LogFiles(App app, string folder, string rel)
        {
            var f = LogFolderNamed(app, folder);
            var sf = new SharedFolder();
            sf.Path = f.Path;
            string norm;
            string dir = Resolve(sf, rel, out norm);
            if (dir == null) throw new CollectRefusal("there's no folder " + rel + " in " + f.Name, "not-found");
            var all = Read(dir).Where(Shown).OrderByDescending(e => e.Mtime).ToList();
            var d = new Dictionary<string, object>();
            d["folder"] = f.Name;
            d["path"] = norm;
            d["entries"] = all.Take(LogMaxEntries).Select(e =>
            {
                var x = new Dictionary<string, object>();
                x["name"] = e.Name;
                x["dir"] = e.Dir;
                if (!e.Dir) x["size"] = e.Size;
                x["modified"] = e.Mtime;
                return (object)x;
            }).ToArray();
            d["more"] = all.Count > LogMaxEntries;
            return d;
        }

        // A file's last `tail` lines (from its last 1 MB at most), as text: UTF-16 when it starts with that mark, else UTF-8.
        public static Dictionary<string, object> LogTail(App app, string folder, string rel, int tail)
        {
            var f = LogFolderNamed(app, folder);
            Entry e;
            string full = Inside(System.IO.Path.GetFullPath(f.Path).TrimEnd('\\'), rel, out e);
            if (full == null || e == null || e.Dir) throw new CollectRefusal("there's no file " + (rel ?? "?") + " in " + f.Name, "not-found");
            byte[] head = new byte[3], bytes;
            long size, start;
            int headN = 0;
            try
            {
                using (var fs = new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    size = fs.Length;
                    while (headN < 3) { int n = fs.Read(head, headN, 3 - headN); if (n <= 0) break; headN += n; }
                    bool utf16 = headN >= 2 && ((head[0] == 0xFF && head[1] == 0xFE) || (head[0] == 0xFE && head[1] == 0xFF));
                    start = Math.Max(0, size - LogMaxBytes);
                    if (utf16 && start % 2 == 1) start++;
                    fs.Seek(start, SeekOrigin.Begin);
                    bytes = new byte[size - start];
                    int got = 0;
                    while (got < bytes.Length) { int n = fs.Read(bytes, got, bytes.Length - got); if (n <= 0) break; got += n; }
                    if (got < bytes.Length) Array.Resize(ref bytes, got);
                }
            }
            catch (UnauthorizedAccessException) { throw new CollectRefusal("Windows doesn't let Beam read " + rel, "denied"); }
            catch (IOException ex) { throw new CollectRefusal("it can't be read now (" + ex.Message + ")", "failed"); }
            Encoding enc = headN >= 2 && head[0] == 0xFF && head[1] == 0xFE ? Encoding.Unicode
                : headN >= 2 && head[0] == 0xFE && head[1] == 0xFF ? Encoding.BigEndianUnicode : (Encoding)new UTF8Encoding(false);
            int skip = start == 0 ? enc.GetPreamble().Length : 0;
            if (start == 0 && enc is UTF8Encoding && headN == 3 && head[0] == 0xEF && head[1] == 0xBB && head[2] == 0xBF) skip = 3;
            string text = enc.GetString(bytes, Math.Min(skip, bytes.Length), bytes.Length - Math.Min(skip, bytes.Length));
            bool cut = start > 0;
            if (cut)
            {
                int nl = text.IndexOf('\n'); // (a line cut by the 1 MB goes)
                text = nl >= 0 ? text.Substring(nl + 1) : "";
            }
            var lines = text.Split('\n');
            int count = lines.Length - (lines.Length > 0 && lines[lines.Length - 1] == "" ? 1 : 0);
            if (count > tail)
            {
                text = string.Join("\n", lines.Skip(count - tail));
                cut = true;
                count = tail;
            }
            var d = new Dictionary<string, object>();
            d["folder"] = f.Name;
            d["path"] = string.Join("/", (rel ?? "").Split(new[] { '/', '\\' }, StringSplitOptions.RemoveEmptyEntries));
            d["size"] = size;
            d["modified"] = e.Mtime;
            d["text"] = text;
            d["lines"] = count;
            d["cut"] = cut;
            return d;
        }
    }

    // Settings → This PC → Log folders…: the folders whose files approved devices may read (only here).
    class LogFoldersForm : DialogBase
    {
        readonly App app;
        readonly List<LogFolder> folders;
        readonly Panel body, footer;
        bool auto;
        List<LogFolder> foundNow = new List<LogFolder>();

        public LogFoldersForm(App app) : base("Log folders", 560)
        {
            this.app = app;
            folders = app.Cfg.CollectFolders.Select(f => f.Copy()).ToList();
            auto = app.Cfg.CollectAuto;
            try { foundNow = Shares.FoundLogFolders(app.Cfg); } catch { }
            body = new Panel();
            body.BackColor = Theme.Bg;
            body.AutoScroll = true;
            footer = new Panel();
            footer.BackColor = Theme.Bg;
            Controls.Add(body);
            Controls.Add(footer);
            Host = body;
            HostWidth = ClientSize.Width - SystemInformation.VerticalScrollBarWidth;
            var save = new FlatButton("Save", null);
            save.Primary = true;
            var cancel = new FlatButton("Cancel", null);
            var add = new FlatButton("Add a folder…", null);
            foreach (var b in new[] { save, cancel, add }) { b.BackColor = Theme.Bg; b.Size = new Size(Math.Max(Ui.S(96), b.Preferred().Width), Ui.S(36)); footer.Controls.Add(b); }
            save.Click += (s, e) => { app.SetLogFolders(folders, auto, "Settings on this PC"); Close(); };
            cancel.Click += (s, e) => Close();
            add.Click += (s, e) => AddFolder();
            int footerH = Ui.S(36) + Pad;
            save.SetBounds(ClientSize.Width - Pad - save.Width, Ui.S(8), save.Width, save.Height);
            cancel.SetBounds(save.Left - Ui.S(10) - cancel.Width, Ui.S(8), cancel.Width, cancel.Height);
            add.SetBounds(Pad, Ui.S(8), add.Width, add.Height);
            footer.Tag = footerH;
            Render();
        }

        void Render()
        {
            body.SuspendLayout();
            foreach (Control c in body.Controls.Cast<Control>().ToList()) { body.Controls.Remove(c); c.Dispose(); }
            Y = Pad;
            AddLabel("Log folders", Ui.Title, false, Ui.S(10));
            AddLabel("Windows' event logs are always included. Here: the folders whose files your approved devices may read too. " +
                "They see these folders' files and nothing else here (no hidden files, nothing starting with \".\", no shortcuts " +
                "to other folders), and can't change anything.", Ui.Font, true, Ui.S(12));
            var autoCheck = AddCheck("Windows' and programs' own log folders, found by themselves",
                foundNow.Count == 0 ? "None found on this PC right now" : foundNow.Count + " now: " + string.Join(", ", foundNow.Take(10).Select(f => f.Name)) + (foundNow.Count > 10 ? ", and " + (foundNow.Count - 10) + " more" : ""),
                auto, 0, Ui.S(14));
            autoCheck.CheckedChanged += (s, e) => { auto = autoCheck.Checked; };
            Section("CHOSEN HERE");
            if (folders.Count == 0) AddLabel("None yet: Add a folder… below (a path like %APPDATA%\\edvrclient can be typed or pasted in its address bar).", Ui.Font, true, Ui.S(8));
            foreach (var f in folders.ToList())
            {
                Section(f.Name.ToUpperInvariant());
                AddLabel(f.Path, Ui.Small, true, Ui.S(6));
                var remove = new FlatButton("Remove " + f.Name, null);
                remove.DangerStyle = true;
                remove.BackColor = Theme.Bg;
                remove.Size = new Size(Math.Max(Ui.S(96), remove.Preferred().Width), Ui.S(32));
                remove.SetBounds(X0, Y + Ui.S(4), remove.Width, remove.Height);
                var gone = f;
                remove.Click += (s, e) => { folders.Remove(gone); Render(); };
                body.Controls.Add(remove);
                Y += remove.Height + Ui.S(12);
            }
            int contentH = Y + Ui.S(8), footerH = (int)footer.Tag;
            int max = Screen.FromPoint(Cursor.Position).WorkingArea.Height - Ui.S(80);
            int h = Math.Min(Math.Max(contentH, Ui.S(220)) + footerH, max);
            ClientSize = new Size(ClientSize.Width, h);
            footer.SetBounds(0, h - footerH, ClientSize.Width, footerH);
            body.SetBounds(0, 0, ClientSize.Width, h - footerH);
            body.ResumeLayout();
        }

        void AddFolder()
        {
            string path = FolderPicker.Pick(this, "A folder with logs your approved devices may read", Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData));
            if (path == null) return;
            string why = Add(path);
            if (why != null) MessageBox.Show(this, "That folder can't be a log folder: " + why + ".", "Log folders", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        // (tests) the switch, as a click on it would
        public void SetAuto(bool on) { auto = on; Render(); }

        // (also the tests') A folder added, or why not.
        public string Add(string path)
        {
            path = Environment.ExpandEnvironmentVariables(path ?? "");
            string why = Shares.LogFolderRefusal(path, app.Cfg);
            if (why != null) return why;
            string full = System.IO.Path.GetFullPath(path).TrimEnd('\\');
            if (folders.Any(f => System.IO.Path.GetFullPath(f.Path).TrimEnd('\\').Equals(full, StringComparison.OrdinalIgnoreCase))) return null;
            var added = new LogFolder();
            added.Path = full;
            string name = Shares.DefaultName(full), unique = name;
            for (int i = 2; folders.Any(f => string.Equals(f.Name, unique, StringComparison.OrdinalIgnoreCase)); i++) unique = name + " (" + i + ")";
            added.Name = unique;
            folders.Add(added);
            Render();
            return null;
        }

        // (tests) What it shows; the window as drawn, into a PNG; Save.
        public string Describe() { return folders.Count + " folder(s): " + string.Join("; ", folders.Select(f => f.Name + " = " + f.Path)) + "; found by themselves " + (auto ? "on" : "off") + " (" + foundNow.Count + ")"; }

        public void Shot(string file)
        {
            using (var bmp = new Bitmap(Width, Height))
            {
                DrawToBitmap(bmp, new Rectangle(0, 0, Width, Height));
                bmp.Save(file, System.Drawing.Imaging.ImageFormat.Png);
            }
        }

        public void SaveForTest()
        {
            app.SetLogFolders(folders, auto, "the test");
            Close();
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            if (!Ui.TestOffscreen) Native.SetForegroundWindow(Handle);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Escape) Close();
            base.OnKeyDown(e);
        }
    }
}
