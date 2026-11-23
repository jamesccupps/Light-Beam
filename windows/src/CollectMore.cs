// Collecting, read only, the second round (Beam 1.42 + this app 1.35; a Claude Code session's requests after it
// diagnosed Office Desktop, the user's picks: every read-only one, and full command lines only as a switch at each PC):
// CPU over a sample, processes told apart (parent, threads, private and working set, the exe's version, command-line
// flags without their values; the whole command line only where that PC allows it), services' exe and version,
// performance counters, a file filtered at the PC (a regex, a time window, from a byte offset, .gz unpacked), a whole
// file in pieces with its SHA-256, file patterns per log folder, and the PC's time zone with every answer.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

namespace Beam
{
    partial class LogCollector
    {
        // ------------------------------------------------------------------ the time zone with every answer

        static Dictionary<string, object> TimeZoneObject()
        {
            var d = new Dictionary<string, object>();
            d["name"] = TimeZoneInfo.Local.Id;
            d["offset"] = (int)TimeZoneInfo.Local.GetUtcOffset(DateTime.Now).TotalMinutes; // minutes east of UTC
            return d;
        }

        // ------------------------------------------------------------------ processes told apart

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct ProcessEntry32
        {
            public uint Size, Usage, ProcessId;
            public IntPtr DefaultHeapId;
            public uint ModuleId, Threads, ParentProcessId;
            public int PriClassBase;
            public uint Flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string ExeFile;
        }
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool Process32FirstW(IntPtr snap, ref ProcessEntry32 e);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool Process32NextW(IntPtr snap, ref ProcessEntry32 e);
        [DllImport("ntdll.dll")]
        static extern int NtQueryInformationProcess(IntPtr process, int infoClass, IntPtr info, int length, out int returned);
        [DllImport("shell32.dll", SetLastError = true)]
        static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string cmd, out int count);
        [DllImport("kernel32.dll")]
        static extern IntPtr LocalFree(IntPtr mem);

        // pid -> (parent, threads), from one snapshot of the whole list.
        static Dictionary<int, uint[]> ParentsAndThreads()
        {
            var map = new Dictionary<int, uint[]>();
            IntPtr snap = CreateToolhelp32Snapshot(0x2, 0); // TH32CS_SNAPPROCESS
            if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return map;
            try
            {
                var e = new ProcessEntry32();
                e.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry32));
                if (Process32FirstW(snap, ref e))
                    do { map[(int)e.ProcessId] = new[] { e.ParentProcessId, e.Threads }; } while (Process32NextW(snap, ref e));
            }
            finally { CloseHandle(snap); }
            return map;
        }

        // A process's command line (Windows 8.1+: ProcessCommandLineInformation), where Windows lets this account ask.
        static string CommandLineOf(int pid)
        {
            IntPtr h = OpenProcess(0x1000, false, pid);
            if (h == IntPtr.Zero) return null;
            IntPtr buf = IntPtr.Zero;
            try
            {
                int size = 8192, got;
                for (int attempt = 0; attempt < 3; attempt++)
                {
                    buf = Marshal.AllocHGlobal(size);
                    int status = NtQueryInformationProcess(h, 60, buf, size, out got);
                    if (status == 0)
                    {
                        int len = Marshal.ReadInt16(buf) & 0xffff; // UNICODE_STRING: Length (bytes), MaximumLength, then Buffer
                        IntPtr text = Marshal.ReadIntPtr(buf, IntPtr.Size == 8 ? 8 : 4);
                        return len > 0 && text != IntPtr.Zero ? Marshal.PtrToStringUni(text, len / 2) : null;
                    }
                    Marshal.FreeHGlobal(buf);
                    buf = IntPtr.Zero;
                    if (status != unchecked((int)0xC0000004) || got <= size || got > 1 << 20) return null; // only "too small" is tried again
                    size = got;
                }
                return null;
            }
            catch { return null; }
            finally
            {
                if (buf != IntPtr.Zero) Marshal.FreeHGlobal(buf);
                CloseHandle(h);
            }
        }

        // The command line's flags (what starts with "-"), each without its value (after "=" or ":"), but for Chromium's
        // --type and --utility-sub-type, which say what a process is. A value that's its own word never comes (it's not a
        // flag): "--password secret" gives "--password". 40 at most, 80 characters each.
        static readonly string[] KeptValues = { "--type", "--utility-sub-type" };

        static string[] FlagsOf(string cmd)
        {
            if (string.IsNullOrEmpty(cmd)) return null;
            int n;
            IntPtr argv = CommandLineToArgvW(cmd, out n);
            if (argv == IntPtr.Zero) return null;
            var flags = new List<string>();
            try
            {
                for (int i = 1; i < n && flags.Count < 40; i++)
                {
                    string a = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size)) ?? "";
                    if (!a.StartsWith("-") || a.Length < 2) continue;
                    int cut = a.IndexOfAny(new[] { '=', ':' });
                    string name = cut > 0 ? a.Substring(0, cut) : a;
                    if (cut > 0 && KeptValues.Contains(name, StringComparer.OrdinalIgnoreCase)) name = a;
                    flags.Add(name.Length > 80 ? name.Substring(0, 80) : name);
                }
            }
            finally { LocalFree(argv); }
            return flags.ToArray();
        }

        // A file's version: its product version (else its file version), from its version resource; remembered by path.
        static readonly Dictionary<string, string> versions = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        static string VersionOf(string path)
        {
            if (string.IsNullOrEmpty(path)) return null;
            lock (versions)
            {
                string v;
                if (versions.TryGetValue(path, out v)) return v;
                try
                {
                    var info = FileVersionInfo.GetVersionInfo(path);
                    v = (info.ProductVersion ?? info.FileVersion ?? "").Trim();
                    if (v.Length == 0) v = null;
                    else if (v.Length > 40) v = v.Substring(0, 40);
                }
                catch { v = null; }
                versions[path] = v;
                return v;
            }
        }

        static double? CpuSeconds(Process p)
        {
            try { return p.TotalProcessorTime.TotalSeconds; } catch { return null; }
        }

        // What runs: each process with its parent, threads, private bytes and working set, CPU seconds (and, sampled, its
        // share of one core over `sample` seconds), the exe and its version, its flags (the whole command line only when
        // that's allowed here). The most CPU first when sampled, else the most memory.
        Dictionary<string, object> ProcessList(string filter, int sample)
        {
            Func<Process, bool> wanted = p => { try { return string.IsNullOrEmpty(filter) || p.ProcessName.IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0; } catch { return false; } };
            Dictionary<int, double> before = null;
            var clock = Stopwatch.StartNew();
            if (sample > 0)
            {
                before = new Dictionary<int, double>();
                foreach (var p in Process.GetProcesses())
                    using (p) { if (wanted(p)) { var c = CpuSeconds(p); if (c.HasValue) before[p.Id] = c.Value; } }
                clock.Restart();
                Thread.Sleep(sample * 1000);
            }
            double seconds = clock.Elapsed.TotalSeconds;
            var tree = ParentsAndThreads();
            bool whole = app.Cfg.CollectCommandLines;
            var list = new List<Dictionary<string, object>>();
            foreach (var p in Process.GetProcesses())
            {
                using (p)
                {
                    try
                    {
                        if (!wanted(p)) continue;
                        var d = new Dictionary<string, object>();
                        d["name"] = p.ProcessName;
                        d["pid"] = p.Id;
                        uint[] pt;
                        if (tree.TryGetValue(p.Id, out pt)) { d["parent"] = (int)pt[0]; d["threads"] = (int)pt[1]; }
                        long priv = 0, ws = 0;
                        try { priv = p.PrivateMemorySize64; } catch { }
                        try { ws = p.WorkingSet64; } catch { }
                        d["memory"] = priv;
                        d["workingSet"] = ws;
                        var cpu = CpuSeconds(p);
                        d["cpu"] = cpu.HasValue ? (object)Math.Round(cpu.Value, 1) : null;
                        double was;
                        if (before != null && cpu.HasValue && before.TryGetValue(p.Id, out was) && seconds > 0)
                            d["cpuPercent"] = Math.Round((cpu.Value - was) / seconds * 100, 1);
                        try { d["started"] = Ms(p.StartTime); } catch { d["started"] = null; }
                        string path = ImagePath(p.Id);
                        d["path"] = path;
                        string version = VersionOf(path);
                        if (version != null) d["version"] = version;
                        string title = null;
                        try { title = p.MainWindowTitle; } catch { }
                        if (!string.IsNullOrEmpty(title)) d["title"] = title.Length > 200 ? title.Substring(0, 200) : title;
                        try { d["session"] = p.SessionId; } catch { }
                        string cmd = CommandLineOf(p.Id);
                        var flags = FlagsOf(cmd);
                        if (flags != null && flags.Length > 0) d["flags"] = flags;
                        if (whole && cmd != null) d["commandLine"] = cmd.Length > 4000 ? cmd.Substring(0, 4000) : cmd;
                        list.Add(d);
                    }
                    catch { } // (it ended meanwhile)
                }
            }
            var o = new Dictionary<string, object>();
            o["processes"] = (before != null
                ? list.OrderByDescending(x => x.ContainsKey("cpuPercent") ? (double)x["cpuPercent"] : -1)
                : list.OrderByDescending(x => (long)x["memory"])).Cast<object>().ToArray();
            if (before != null) o["sample"] = Math.Round(seconds, 1);
            o["threads"] = Environment.ProcessorCount;
            o["commandLines"] = whole;
            return o;
        }

        // A service's exe: its ImagePath (quoted, or up to ".exe"), environment variables expanded.
        static string ServiceExe(string name)
        {
            try
            {
                using (var k = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\" + name))
                {
                    string raw = k != null ? k.GetValue("ImagePath") as string : null;
                    if (string.IsNullOrEmpty(raw)) return null;
                    raw = Environment.ExpandEnvironmentVariables(raw.Trim());
                    if (raw.StartsWith("\"")) { int end = raw.IndexOf('"', 1); return end > 1 ? raw.Substring(1, end - 1) : null; }
                    int exe = raw.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
                    string path = exe > 0 ? raw.Substring(0, exe + 4) : raw;
                    if (path.StartsWith(@"\SystemRoot\", StringComparison.OrdinalIgnoreCase)) path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), path.Substring(12));
                    if (path.StartsWith(@"System32\", StringComparison.OrdinalIgnoreCase)) path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), path);
                    return path;
                }
            }
            catch { return null; }
        }

        // ------------------------------------------------------------------ performance counters, read only

        static readonly Regex CounterPath = new Regex(@"^\\([^\\(]+)(?:\(([^)]*)\))?\\(.+)$");

        static Regex Wildcard(string pattern)
        {
            return new Regex("^" + Regex.Escape(pattern).Replace("\\*", ".*").Replace("\\?", ".") + "$", RegexOptions.IgnoreCase);
        }

        // Each path (\Category(instance)\Counter, * in the instance for all) read twice, `sample` seconds apart (rates need
        // two), as Windows' Performance Monitor reads them. A GPU instance's process (pid_1234_…) is named.
        static Dictionary<string, object> Counters(List<string> paths, int sample)
        {
            var parsed = new List<KeyValuePair<string, Match>>();
            foreach (var path in paths)
            {
                var m = CounterPath.Match(path ?? "");
                if (!m.Success) throw new CollectRefusal("that isn't a counter's path: " + path + " (like \\Memory\\Available MBytes)", "bad");
                parsed.Add(new KeyValuePair<string, Match>(path, m));
            }
            var categories = parsed.Select(x => x.Value.Groups[1].Value.Trim()).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            var first = new Dictionary<string, InstanceDataCollectionCollection>(StringComparer.OrdinalIgnoreCase);
            var errors = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var c in categories)
            {
                try { first[c] = new PerformanceCounterCategory(c).ReadCategory(); }
                catch (Exception ex) { errors[c] = ex is InvalidOperationException ? "no such counter category here" : ex.Message; }
            }
            Thread.Sleep(Math.Max(1, sample) * 1000);
            var second = new Dictionary<string, InstanceDataCollectionCollection>(StringComparer.OrdinalIgnoreCase);
            foreach (var c in first.Keys.ToList())
            {
                try { second[c] = new PerformanceCounterCategory(c).ReadCategory(); }
                catch (Exception ex) { errors[c] = ex.Message; }
            }
            var names = new Dictionary<int, string>();
            Func<int, string> nameOf = pid =>
            {
                string n;
                if (names.TryGetValue(pid, out n)) return n;
                try { using (var p = Process.GetProcessById(pid)) n = p.ProcessName; } catch { n = null; }
                names[pid] = n;
                return n;
            };
            var results = new List<object>();
            foreach (var item in parsed)
            {
                var r = new Dictionary<string, object>();
                r["path"] = item.Key;
                string cat = item.Value.Groups[1].Value.Trim(), inst = item.Value.Groups[2].Success ? item.Value.Groups[2].Value : null, counter = item.Value.Groups[3].Value.Trim();
                string why;
                if (errors.TryGetValue(cat, out why)) { r["error"] = why; results.Add(r); continue; }
                InstanceDataCollectionCollection a, b;
                if (!first.TryGetValue(cat, out a) || !second.TryGetValue(cat, out b)) { r["error"] = "not read"; results.Add(r); continue; }
                string key = null;
                foreach (string k in b.Keys) if (string.Equals(k, counter, StringComparison.OrdinalIgnoreCase)) { key = k; break; }
                if (key == null) { r["error"] = "no counter named " + counter + " in " + cat; results.Add(r); continue; }
                InstanceDataCollection da = a.Contains(key) ? a[key] : null, db = b[key];
                var like = inst == null ? null : Wildcard(inst);
                var values = new List<object>();
                foreach (string i in db.Keys)
                {
                    if (like != null && !like.IsMatch(i)) continue;
                    if (values.Count >= 3000) break;
                    InstanceData s1 = db[i], s0 = da != null && da.Contains(i) ? da[i] : null;
                    float v;
                    try { v = s0 != null ? CounterSample.Calculate(s0.Sample, s1.Sample) : CounterSample.Calculate(s1.Sample); } catch { continue; }
                    var x = new Dictionary<string, object>();
                    x["instance"] = i == "systemdiagnosticsperfcounterlibsingleinstance" ? "" : i;
                    x["value"] = Math.Round((double)v, 3);
                    var pidMatch = Regex.Match(i, @"\bpid_(\d+)_");
                    int pid;
                    if (pidMatch.Success && int.TryParse(pidMatch.Groups[1].Value, out pid)) { x["pid"] = pid; var pn = nameOf(pid); if (pn != null) x["process"] = pn; }
                    values.Add(x);
                }
                r["values"] = values.ToArray();
                results.Add(r);
            }
            var o = new Dictionary<string, object>();
            o["counters"] = results.ToArray();
            o["sample"] = Math.Max(1, sample);
            return o;
        }
    }

    // A stream that ends after `left` bytes of another (a file read up to its size when opened).
    class Limited : Stream
    {
        readonly Stream inner;
        long left;
        public Limited(Stream inner, long left) { this.inner = inner; this.left = Math.Max(0, left); }
        public override int Read(byte[] buffer, int offset, int count)
        {
            if (left <= 0) return 0;
            int n = inner.Read(buffer, offset, (int)Math.Min(count, left));
            left -= n;
            return n;
        }
        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return false; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { throw new NotSupportedException(); } }
        public override long Position { get { throw new NotSupportedException(); } set { throw new NotSupportedException(); } }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) { throw new NotSupportedException(); }
        public override void SetLength(long value) { throw new NotSupportedException(); }
        public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
    }

    static partial class Shares
    {
        const int PullMaxChunk = 2 * 1024 * 1024;
        const long PullMaxFile = 512L * 1024 * 1024;
        const long ScanMaxBytes = 512L * 1024 * 1024;   // a filtered read looks through this much at most
        const long GunzipMax = 256L * 1024 * 1024;      // ...and a .gz unpacks to this much at most
        const int TextMaxChars = 1024 * 1024;

        // A file in a log folder, by its path inside it: its full path and entry, its folder's patterns allowing its name.
        static string LogFileAt(App app, string folder, string rel, out LogFolder f, out Entry e)
        {
            f = LogFolderNamed(app, folder);
            string full = Inside(System.IO.Path.GetFullPath(f.Path).TrimEnd('\\'), rel, out e);
            if (full == null || e == null || e.Dir || !f.Allows(e.Name)) throw new CollectRefusal("there's no file " + (rel ?? "?") + " in " + f.Name, "not-found");
            return full;
        }

        static string NormPath(string rel) { return string.Join("/", (rel ?? "").Split(new[] { '/', '\\' }, StringSplitOptions.RemoveEmptyEntries)); }

        static FileStream OpenShared(string full)
        {
            try { return new FileStream(full, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16); }
            catch (UnauthorizedAccessException) { throw new CollectRefusal("Windows doesn't let Beam read it", "denied"); }
            catch (IOException ex) { throw new CollectRefusal("it can't be read now (" + ex.Message + ")", "failed"); }
        }

        // ------------------------------------------------------------------ a whole file, in pieces

        // `length` bytes from `offset` (2 MB at most), as base64; at offset 0 also the SHA-256 of its first `size` bytes
        // (the size then), which a copy pulled piece by piece is checked against (a log that only grows keeps them).
        public static Dictionary<string, object> LogPull(App app, string folder, string rel, long offset, int length)
        {
            LogFolder f;
            Entry e;
            string full = LogFileAt(app, folder, rel, out f, out e);
            using (var fs = OpenShared(full))
            {
                long size = fs.Length;
                if (size > PullMaxFile) throw new CollectRefusal("it's " + (size >> 20) + " MB: 512 MB is the most a pull takes", "too-big");
                if (offset < 0 || offset > size) throw new CollectRefusal("that offset is past its end (" + size + " bytes)", "bad");
                var d = new Dictionary<string, object>();
                d["folder"] = f.Name;
                d["path"] = NormPath(rel);
                d["size"] = size;
                d["modified"] = e.Mtime;
                d["offset"] = offset;
                if (offset == 0)
                {
                    using (var sha = SHA256.Create())
                    {
                        var buf = new byte[1 << 20];
                        long left = size;
                        while (left > 0)
                        {
                            int n = fs.Read(buf, 0, (int)Math.Min(buf.Length, left));
                            if (n <= 0) break;
                            sha.TransformBlock(buf, 0, n, null, 0);
                            left -= n;
                        }
                        sha.TransformFinalBlock(buf, 0, 0);
                        d["sha256"] = Transfers.Hex(sha.Hash);
                    }
                }
                int want = (int)Math.Min(Math.Max(1, Math.Min(length, PullMaxChunk)), size - offset);
                var data = new byte[Math.Max(0, want)];
                fs.Seek(offset, SeekOrigin.Begin);
                int got = 0;
                while (got < data.Length) { int n = fs.Read(data, got, data.Length - got); if (n <= 0) break; got += n; }
                d["data"] = Convert.ToBase64String(data, 0, got);
                d["length"] = got;
                return d;
            }
        }

        // ------------------------------------------------------------------ a file filtered at the PC

        // A line's time at its start ("2026-11-23 13:15:01", "2026-11-23T18:15:01Z", "11/23/2026 9:29:49 AM",
        // "11/23/26 09:29:46", in [ ] too), as UTC; null when it has none.
        static readonly Regex IsoTime = new Regex(@"^\s*\[?(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,]\d+)?\s*(Z|[+-]\d{2}:?\d{2})?", RegexOptions.CultureInvariant);
        static readonly Regex UsTime = new Regex(@"^\s*\[?(\d{1,2})/(\d{1,2})/(\d{2,4}),? (\d{1,2}):(\d{2}):(\d{2})(?:[.,]\d+)?(?: ?([AaPp][Mm]))?", RegexOptions.CultureInvariant);

        static DateTime? LineTime(string line)
        {
            try
            {
                var m = IsoTime.Match(line);
                if (m.Success)
                {
                    var t = new DateTime(int.Parse(m.Groups[1].Value), int.Parse(m.Groups[2].Value), int.Parse(m.Groups[3].Value),
                        int.Parse(m.Groups[4].Value), int.Parse(m.Groups[5].Value), int.Parse(m.Groups[6].Value));
                    string z = m.Groups[7].Value;
                    if (z == "Z") return DateTime.SpecifyKind(t, DateTimeKind.Utc);
                    if (z.Length > 0)
                    {
                        z = z.Replace(":", "");
                        int sign = z[0] == '-' ? -1 : 1, hh = int.Parse(z.Substring(1, 2)), mm = int.Parse(z.Substring(3, 2));
                        return DateTime.SpecifyKind(t.AddMinutes(-sign * (hh * 60 + mm)), DateTimeKind.Utc);
                    }
                    return DateTime.SpecifyKind(t, DateTimeKind.Local).ToUniversalTime();
                }
                m = UsTime.Match(line);
                if (m.Success)
                {
                    int year = int.Parse(m.Groups[3].Value);
                    if (year < 100) year += 2000;
                    int hour = int.Parse(m.Groups[4].Value);
                    string ap = m.Groups[7].Value.ToUpperInvariant();
                    if (ap == "PM" && hour < 12) hour += 12;
                    if (ap == "AM" && hour == 12) hour = 0;
                    var t = new DateTime(year, int.Parse(m.Groups[1].Value), int.Parse(m.Groups[2].Value), hour, int.Parse(m.Groups[5].Value), int.Parse(m.Groups[6].Value));
                    return DateTime.SpecifyKind(t, DateTimeKind.Local).ToUniversalTime();
                }
            }
            catch { }
            return null;
        }

        // The file's last lines, picked at the PC: those matching `grep` (a .NET regex, 1 s a line at most), from the last
        // `since` minutes (lines without a time go with the line before), from byte `after` on (with `end` to go on from
        // next time; a file shorter than that was started again: from 0, `rotated`). A .gz is unpacked first. `tail`
        // lines at most (the last ones), 1 MB of text at most.
        public static Dictionary<string, object> LogRead(App app, string folder, string rel, int tail, string grep, int since, long after, bool gunzip)
        {
            LogFolder f;
            Entry e;
            string full = LogFileAt(app, folder, rel, out f, out e);
            bool gz = gunzip || e.Name.EndsWith(".gz", StringComparison.OrdinalIgnoreCase);
            if (!gz && grep == null && since <= 0 && after < 0) return LogTail(app, folder, rel, tail); // (the fast path: its last 1 MB)
            Regex re = null;
            if (grep != null)
            {
                try { re = new Regex(grep, RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1)); }
                catch (ArgumentException ex) { throw new CollectRefusal("that isn't a regular expression (" + ex.Message + ")", "bad"); }
            }
            DateTime? from = since > 0 ? (DateTime?)DateTime.UtcNow.AddMinutes(-since) : null;
            var kept = new Queue<string>();
            long keptChars = 0, matched = 0, lines = 0;
            bool cut = false, rotated = false, sawTime = false, keepNext = from == null;
            long end = -1, scanned = 0;
            var clock = Stopwatch.StartNew();
            using (var fs = OpenShared(full))
            {
                long size = fs.Length;
                Stream source;
                if (gz) source = new GZipStream(fs, CompressionMode.Decompress);
                else
                {
                    // up to its size now, so `end` is exactly where the next read goes on from
                    if (after > size) { rotated = true; after = 0; }
                    long start = Math.Max(0, after);
                    fs.Seek(start, SeekOrigin.Begin);
                    end = size;
                    source = new Limited(fs, size - start);
                }
                using (var reader = new StreamReader(source, new UTF8Encoding(false), true, 1 << 16))
                {
                    string line;
                    while ((line = reader.ReadLine()) != null)
                    {
                        scanned += line.Length + 1;
                        lines++;
                        if ((gz && scanned > GunzipMax) || scanned > ScanMaxBytes || clock.ElapsedMilliseconds > 20000) { cut = true; break; }
                        if (from != null)
                        {
                            var t = LineTime(line);
                            if (t.HasValue) { sawTime = true; keepNext = t.Value >= from.Value; }
                            if (!keepNext) continue;
                        }
                        if (re != null)
                        {
                            bool hit;
                            try { hit = re.IsMatch(line); } catch (RegexMatchTimeoutException) { hit = false; }
                            if (!hit) continue;
                        }
                        matched++;
                        kept.Enqueue(line);
                        keptChars += line.Length + 1;
                        while (kept.Count > tail || keptChars > TextMaxChars) { keptChars -= kept.Dequeue().Length + 1; cut = true; }
                    }
                }
            }
            var d = new Dictionary<string, object>();
            d["folder"] = f.Name;
            d["path"] = NormPath(rel);
            d["size"] = e.Size;
            d["modified"] = e.Mtime;
            d["text"] = kept.Count > 0 ? string.Join("\n", kept) + "\n" : "";
            d["lines"] = kept.Count;
            d["matched"] = matched;
            d["read"] = lines;
            d["cut"] = cut;
            if (gz) d["gunzipped"] = true;
            if (end >= 0) d["end"] = end;
            if (rotated) d["rotated"] = true;
            if (from != null && !sawTime) d["noTimes"] = true; // (no line said its time: every line was left out)
            return d;
        }
    }
}
