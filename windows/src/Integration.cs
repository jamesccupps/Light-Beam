// Windows integration: global hotkeys, the instance pipe, Explorer "Send to" shortcuts per device,
// outbox folders, start with Windows, the clipboard, zipping folders.
using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Compression;
using System.IO.Pipes;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Beam
{
    // Several global hotkeys on one message-only window. Specs look like "Ctrl+Alt+Shift+B".
    class Hotkeys : NativeWindow, IDisposable
    {
        class Entry
        {
            public int Id;
            public string Spec;
            public Action Action;
            public bool Registered;
        }

        readonly Dictionary<string, Entry> entries = new Dictionary<string, Entry>();
        int nextId = 1;

        public Hotkeys()
        {
            var cp = new CreateParams();
            cp.Parent = new IntPtr(-3); // HWND_MESSAGE
            CreateHandle(cp);
        }

        public static bool TryParse(string spec, out uint mods, out uint vk)
        {
            mods = 0; vk = 0;
            if (string.IsNullOrWhiteSpace(spec)) return false;
            foreach (var raw in spec.Split('+'))
            {
                string t = raw.Trim();
                if (t.Length == 0) return false;
                switch (t.ToLowerInvariant())
                {
                    case "ctrl": case "control": mods |= Native.MOD_CONTROL; continue;
                    case "alt": mods |= Native.MOD_ALT; continue;
                    case "shift": mods |= Native.MOD_SHIFT; continue;
                    case "win": case "windows": mods |= Native.MOD_WIN; continue;
                }
                if (vk != 0) return false;
                if (t.Length == 1 && char.IsDigit(t[0])) t = "D" + t;
                Keys k;
                if (!Enum.TryParse(t, true, out k) || (k & Keys.Modifiers) != 0) return false;
                vk = (uint)k;
            }
            return vk != 0 && mods != 0;
        }

        // (Re)registers a hotkey; an empty spec just removes it. Returns whether it's active.
        public bool Set(string name, string spec, Action action)
        {
            Entry e;
            if (entries.TryGetValue(name, out e))
            {
                if (e.Registered) Native.UnregisterHotKey(Handle, e.Id);
                entries.Remove(name);
            }
            e = new Entry();
            e.Id = nextId++;
            e.Spec = spec ?? "";
            e.Action = action;
            entries[name] = e;
            uint mods, vk;
            if (!TryParse(e.Spec, out mods, out vk)) return false;
            e.Registered = Native.RegisterHotKey(Handle, e.Id, mods | Native.MOD_NOREPEAT, vk);
            if (!e.Registered) Log.Write("Hotkey " + e.Spec + " (" + name + ") is taken by another app (error " + Marshal.GetLastWin32Error() + ")");
            return e.Registered;
        }

        // Tries again the ones another app held (they may have been released since).
        public void Retry()
        {
            foreach (var kv in entries.ToList())
                if (!kv.Value.Registered && kv.Value.Spec.Length > 0) Set(kv.Key, kv.Value.Spec, kv.Value.Action);
        }

        public bool IsRegistered(string name)
        {
            Entry e;
            return entries.TryGetValue(name, out e) && e.Registered;
        }

        public string SpecOf(string name)
        {
            Entry e;
            return entries.TryGetValue(name, out e) ? e.Spec : "";
        }

        public void Clear()
        {
            foreach (var e in entries.Values) if (e.Registered) Native.UnregisterHotKey(Handle, e.Id);
            entries.Clear();
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Native.WM_HOTKEY)
            {
                int id = m.WParam.ToInt32();
                foreach (var e in entries.Values)
                    if (e.Id == id && e.Action != null)
                    {
                        try { e.Action(); } catch (Exception ex) { Log.Error("Hotkey", ex); }
                        break;
                    }
            }
            base.WndProc(ref m);
        }

        public void Dispose()
        {
            Clear();
            DestroyHandle();
        }
    }

    // A second Beam.exe hands its command line to the running one through this pipe (this user only).
    class IpcServer
    {
        readonly string name;
        readonly Action<string[]> onMessage;
        volatile bool stopped;
        NamedPipeServerStream current;

        public IpcServer(string name, Action<string[]> onMessage)
        {
            this.name = name;
            this.onMessage = onMessage;
            var t = new Thread(Loop);
            t.IsBackground = true;
            t.Name = "Beam pipe";
            t.Start();
        }

        static PipeSecurity Security()
        {
            var ps = new PipeSecurity();
            ps.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
            ps.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
            return ps;
        }

        void Loop()
        {
            int failures = 0;
            while (!stopped)
            {
                try
                {
                    using (var pipe = new NamedPipeServerStream(name, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.None, 4096, 4096, Security()))
                    {
                        current = pipe;
                        if (stopped) return;
                        pipe.WaitForConnection();
                        if (stopped) return;
                        var ms = new MemoryStream();
                        var copy = Task.Run(() => pipe.CopyTo(ms));
                        if (!copy.Wait(5000)) { Log.Write("Pipe: a client connected but sent nothing"); continue; }
                        var arr = Json.Parse(Encoding.UTF8.GetString(ms.ToArray())) as object[];
                        if (arr != null) onMessage(arr.Select(o => o == null ? "" : o.ToString()).ToArray());
                    }
                }
                catch (Exception ex)
                {
                    if (stopped) return;
                    // Right after an update the previous version may hold the name for a moment: wait quietly.
                    if (++failures <= 3 || failures % 60 == 0) Log.Error("Pipe", ex);
                    Thread.Sleep(500);
                    continue;
                }
                finally { current = null; }
                failures = 0;
            }
        }

        // Frees the pipe name (before an update hands over to the new version).
        public void Stop()
        {
            stopped = true;
            var p = current;
            if (p != null) { try { p.Dispose(); } catch { } }
        }

        public static bool Send(string name, string[] args, int timeoutMs)
        {
            try
            {
                using (var c = new NamedPipeClientStream(".", name, PipeDirection.Out))
                {
                    c.Connect(timeoutMs);
                    var bytes = Encoding.UTF8.GetBytes(Json.Stringify(args));
                    c.Write(bytes, 0, bytes.Length);
                    c.Flush();
                }
                return true;
            }
            catch { return false; }
        }
    }

    // "Start Beam when I sign in". The real HKCU Run key only for the default config; a custom --config
    // keeps its own marker file so test instances never touch the user's startup entries.
    static class Autostart
    {
        const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        const string ValueName = "Beam";

        static string MarkerFile(Config cfg) { return Path.Combine(cfg.Dir, "autostart.txt"); }

        public static string Command(Config cfg)
        {
            string cmd = "\"" + Install.TargetExe(cfg) + "\" --background";
            if (cfg.CustomPath) cmd += " --config \"" + cfg.FilePath + "\"";
            return cmd;
        }

        static string Current(Config cfg)
        {
            try
            {
                if (cfg.CustomPath) return File.Exists(MarkerFile(cfg)) ? File.ReadAllText(MarkerFile(cfg)).Trim() : null;
                using (var k = Registry.CurrentUser.OpenSubKey(RunKey))
                    return k == null ? null : k.GetValue(ValueName) as string;
            }
            catch { return null; }
        }

        public static bool IsEnabled(Config cfg)
        {
            return Current(cfg) != null;
        }

        public static void Set(bool on, Config cfg)
        {
            try
            {
                if (cfg.CustomPath)
                {
                    if (on) File.WriteAllText(MarkerFile(cfg), Command(cfg));
                    else FileUtil.TryDelete(MarkerFile(cfg));
                    return;
                }
                using (var k = Registry.CurrentUser.CreateSubKey(RunKey))
                {
                    if (on) k.SetValue(ValueName, Command(cfg));
                    else k.DeleteValue(ValueName, false);
                }
            }
            catch (Exception ex) { Log.Error("Autostart", ex); }
        }

        // An existing entry that points somewhere else (an older download, a moved exe) is repointed.
        public static void Repair(Config cfg)
        {
            string cur = Current(cfg);
            if (cur == null) return;
            string want = Command(cfg);
            if (!string.Equals(cur, want, StringComparison.OrdinalIgnoreCase))
            {
                Log.Write("Start with Windows pointed at another Beam.exe; repointing it");
                Set(true, cfg);
            }
        }
    }

    static class Shortcut
    {
        public static void Create(string path, string target, string args, string description)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            Type t = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(t);
            try
            {
                object link = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { path });
                try
                {
                    Type lt = link.GetType();
                    lt.InvokeMember("TargetPath", BindingFlags.SetProperty, null, link, new object[] { target });
                    lt.InvokeMember("Arguments", BindingFlags.SetProperty, null, link, new object[] { args });
                    lt.InvokeMember("Description", BindingFlags.SetProperty, null, link, new object[] { description });
                    lt.InvokeMember("IconLocation", BindingFlags.SetProperty, null, link, new object[] { target + ",0" });
                    lt.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, link, new object[] { Path.GetDirectoryName(target) });
                    lt.InvokeMember("Save", BindingFlags.InvokeMethod, null, link, null);
                }
                finally { Marshal.FinalReleaseComObject(link); }
            }
            finally { Marshal.FinalReleaseComObject(shell); }
        }
    }

    // Explorer "Send to > Beam > <device>" shortcuts, one per device plus "All devices".
    static class SendToMenu
    {
        public static void Sync(App app)
        {
            var cfg = app.Cfg;
            string folder = cfg.SendToFolderPath;
            if (!cfg.SendToMenu || !cfg.Paired)
            {
                Remove(app);
                return;
            }
            try
            {
                string exe = Install.TargetExe(cfg);
                string prefix = cfg.CustomPath ? "--config \"" + cfg.FilePath + "\" " : "";
                var desired = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                desired["All devices"] = prefix + "--send --to all";
                foreach (var d in app.Devices)
                {
                    if (d.Id == app.Me) continue;
                    string name = FileUtil.SafeName(d.Name);
                    if (name.Equals("All devices", StringComparison.OrdinalIgnoreCase)) name += " (device)";
                    string unique = name;
                    for (int i = 2; desired.ContainsKey(unique); i++) unique = name + " (" + i + ")";
                    desired[unique] = prefix + "--send --to " + d.Id;
                }
                Directory.CreateDirectory(folder);
                foreach (var file in Directory.GetFiles(folder, "*.lnk"))
                {
                    string n = Path.GetFileNameWithoutExtension(file);
                    if (!desired.ContainsKey(n))
                    {
                        File.Delete(file);
                        app.St.Shortcuts.Remove(n);
                    }
                }
                bool changed = false;
                foreach (var kv in desired)
                {
                    string lnk = Path.Combine(folder, kv.Key + ".lnk");
                    string record = exe + "|" + kv.Value;
                    string had;
                    if (File.Exists(lnk) && app.St.Shortcuts.TryGetValue(kv.Key, out had) && had == record) continue;
                    Shortcut.Create(lnk, exe, kv.Value, "Send with Beam to " + kv.Key);
                    app.St.Shortcuts[kv.Key] = record;
                    changed = true;
                }
                if (changed)
                {
                    app.St.Save();
                    Log.Write("Send to shortcuts updated in " + folder);
                }
            }
            catch (Exception ex) { Log.Error("Send to shortcuts", ex); }
        }

        public static void Remove(App app)
        {
            string folder = app.Cfg.SendToFolderPath;
            try
            {
                if (Directory.Exists(folder))
                {
                    foreach (var file in Directory.GetFiles(folder, "*.lnk")) File.Delete(file);
                    if (!Directory.EnumerateFileSystemEntries(folder).Any()) Directory.Delete(folder);
                }
                if (app.St.Shortcuts.Count > 0)
                {
                    app.St.Shortcuts.Clear();
                    app.St.Save();
                }
            }
            catch (Exception ex) { Log.Error("Removing Send to shortcuts", ex); }
        }
    }

    // Outbox folders: files or folders put into "<root>\To <device>\" are sent to that device, then moved to "Sent".
    // Everything here runs on the UI thread.
    class Outbox : IDisposable
    {
        readonly App app;
        public readonly string Root;
        FileSystemWatcher watcher;
        readonly System.Windows.Forms.Timer timer;
        readonly Dictionary<string, Candidate> candidates = new Dictionary<string, Candidate>(StringComparer.OrdinalIgnoreCase);
        readonly HashSet<string> sending = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        // Entries that failed for good (too big, unreadable): left alone until they change.
        readonly Dictionary<string, DateTime> failed = new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);
        const string AllFolder = "To All devices";
        const string SentFolder = "Sent";

        class Candidate
        {
            public long Size = -1;
            public DateTime Written;
            public int Stable;
        }

        public Outbox(App app, string root)
        {
            this.app = app;
            Root = root;
            timer = new System.Windows.Forms.Timer();
            timer.Interval = 1000;
            timer.Tick += (s, e) => Check();
        }

        public void Start()
        {
            try
            {
                EnsureFolders();
                watcher = new FileSystemWatcher(Root);
                watcher.IncludeSubdirectories = true;
                watcher.NotifyFilter = NotifyFilters.FileName | NotifyFilters.Size | NotifyFilters.LastWrite | NotifyFilters.DirectoryName;
                FileSystemEventHandler onChange = (s, e) => app.Post(() => Consider(e.FullPath));
                watcher.Created += onChange;
                watcher.Changed += onChange;
                watcher.Renamed += (s, e) => app.Post(() => Consider(e.FullPath));
                watcher.Error += (s, e) => app.Post(Rescan);
                watcher.EnableRaisingEvents = true;
                timer.Start();
                Rescan();
                Log.Write("Outbox watching " + Root);
            }
            catch (Exception ex) { Log.Error("Outbox", ex); }
        }

        public static string FolderName(string deviceName)
        {
            return "To " + FileUtil.SafeName(deviceName);
        }

        // (audit X-3) Each device's folder (folder name -> device id): "To <name>", or with the end of its id when another
        // device's name makes the same folder (two "Laptop"s; "Office PC" and "Office:PC"), or when the name would take
        // the folder for everyone. A folder that used to be shared then sends nothing (TargetOf: null), never a guess.
        Dictionary<string, string> Folders()
        {
            var byName = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
            foreach (var d in app.Devices)
            {
                if (d.Id == app.Me) continue;
                string n = FolderName(d.Name);
                List<string> ids;
                if (!byName.TryGetValue(n, out ids)) byName[n] = ids = new List<string>();
                ids.Add(d.Id);
            }
            var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var kv in byName)
            {
                bool clash = kv.Value.Count > 1 || string.Equals(kv.Key, AllFolder, StringComparison.OrdinalIgnoreCase);
                foreach (var id in kv.Value) map[clash ? kv.Key + " (" + (id.Length > 6 ? id.Substring(id.Length - 6) : id) + ")" : kv.Key] = id;
            }
            return map;
        }

        public void EnsureFolders()
        {
            try
            {
                Directory.CreateDirectory(Path.Combine(Root, AllFolder));
                foreach (var folder in Folders().Keys) Directory.CreateDirectory(Path.Combine(Root, folder));
            }
            catch (Exception ex) { Log.Error("Outbox folders", ex); }
        }

        public void Rescan()
        {
            try
            {
                foreach (var dir in Directory.GetDirectories(Root, "To *"))
                    foreach (var entry in Directory.GetFileSystemEntries(dir)) Consider(entry);
            }
            catch (Exception ex) { Log.Error("Outbox scan", ex); }
        }

        // The entry directly inside an outbox folder that this path belongs to (a file, or a dropped folder).
        string TopEntry(string path)
        {
            string root = Path.GetFullPath(Root).TrimEnd('\\');
            string full;
            try { full = Path.GetFullPath(path); } catch { return null; }
            if (!full.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase)) return null;
            var parts = full.Substring(root.Length + 1).Split('\\');
            if (parts.Length < 2) return null;
            if (parts[1].Equals(SentFolder, StringComparison.OrdinalIgnoreCase)) return null;
            return Path.Combine(root, parts[0], parts[1]);
        }

        // The conversation an outbox folder sends to, or null.
        string TargetOf(string entry)
        {
            string folder = Path.GetFileName(Path.GetDirectoryName(entry));
            if (string.Equals(folder, AllFolder, StringComparison.OrdinalIgnoreCase)) return "*";
            string id;
            return folder != null && Folders().TryGetValue(folder, out id) ? id : null;
        }

        static bool Ignored(string file)
        {
            string name = Path.GetFileName(file);
            string ext = Path.GetExtension(file).ToLowerInvariant();
            if (name.StartsWith("~$") || name.StartsWith(".")) return true;
            if (name.Equals("desktop.ini", StringComparison.OrdinalIgnoreCase) || name.Equals("Thumbs.db", StringComparison.OrdinalIgnoreCase)) return true;
            return ext == ".tmp" || ext == ".part" || ext == ".partial" || ext == ".crdownload" || ext == ".download" || ext == ".beampart";
        }

        void Consider(string path)
        {
            string entry = TopEntry(path);
            if (entry == null || sending.Contains(entry) || Ignored(entry) || TargetOf(entry) == null) return;
            if (!File.Exists(entry) && !Directory.Exists(entry)) return;
            DateTime when;
            if (failed.TryGetValue(entry, out when))
            {
                try { if (File.GetLastWriteTimeUtc(entry) == when) return; } catch { return; }
                failed.Remove(entry);
            }
            Candidate c;
            if (candidates.TryGetValue(entry, out c)) c.Stable = 0;
            else candidates[entry] = new Candidate();
            if (!timer.Enabled) timer.Start();
        }

        static void Measure(string entry, out long size, out DateTime written)
        {
            if (File.Exists(entry))
            {
                var info = new FileInfo(entry);
                size = info.Length;
                written = info.LastWriteTimeUtc;
                return;
            }
            size = 0;
            written = Directory.GetLastWriteTimeUtc(entry);
            foreach (var f in new DirectoryInfo(entry).EnumerateFiles("*", SearchOption.AllDirectories))
            {
                size += f.Length;
                if (f.LastWriteTimeUtc > written) written = f.LastWriteTimeUtc;
            }
        }

        // An entry is sent once its size and write time stop changing and nobody holds it open.
        void Check()
        {
            if (candidates.Count == 0) { timer.Stop(); return; } // nothing arriving: sleep until the watcher sees something
            foreach (var entry in candidates.Keys.ToList())
            {
                var c = candidates[entry];
                try
                {
                    bool isFile = File.Exists(entry);
                    if (!isFile && !Directory.Exists(entry)) { candidates.Remove(entry); continue; }
                    var attr = File.GetAttributes(entry);
                    if ((attr & (FileAttributes.Hidden | FileAttributes.System)) != 0) { candidates.Remove(entry); continue; }
                    long size; DateTime written;
                    Measure(entry, out size, out written);
                    if (size != c.Size || written != c.Written)
                    {
                        c.Size = size;
                        c.Written = written;
                        c.Stable = 0;
                        continue;
                    }
                    if (++c.Stable < (isFile ? 2 : 3)) continue;
                    if (isFile) using (new FileStream(entry, FileMode.Open, FileAccess.Read, FileShare.None)) { }
                }
                catch (IOException) { continue; } // still being written
                catch (UnauthorizedAccessException) { candidates.Remove(entry); continue; }
                candidates.Remove(entry);
                string target = TargetOf(entry);
                if (target == null || !app.Cfg.Paired) continue;
                sending.Add(entry);
                Log.Write("Outbox: sending an entry to " + (target == "*" ? "all devices" : target));
                string path = entry;
                app.SendFiles(new[] { path }, App.TargetsOf(target), true, "outbox", job =>
                {
                    sending.Remove(path);
                    if (job.State == JobState.Done) MoveToSent(path);
                    else if (job.State == JobState.Failed && job.Permanent)
                    {
                        try { failed[path] = File.GetLastWriteTimeUtc(path); } catch { }
                    }
                });
            }
        }

        void MoveToSent(string entry)
        {
            try
            {
                string sent = Path.Combine(Path.GetDirectoryName(entry), SentFolder);
                Directory.CreateDirectory(sent);
                string dest = FileUtil.UniquePath(sent, Path.GetFileName(entry));
                if (File.Exists(entry)) File.Move(entry, dest);
                else if (Directory.Exists(entry)) Directory.Move(entry, dest);
            }
            catch (Exception ex) { Log.Error("Outbox: moving to Sent", ex); }
        }

        public void Dispose()
        {
            timer.Stop();
            timer.Dispose();
            if (watcher != null) watcher.Dispose();
        }
    }

    // What the clipboard holds, captured on the UI thread. For a custom --config the "clipboard" is a few files
    // in the config folder, so tests never read or overwrite the user's real clipboard.
    class ClipPayload
    {
        public static string IsolatedDir; // set for custom configs

        public string Text;
        public List<string> Files = new List<string>();
        public string ImagePath;

        public bool Empty { get { return string.IsNullOrEmpty(Text) && Files.Count == 0 && ImagePath == null; } }

        public string Kind { get { return ImagePath != null ? "image" : Files.Count > 0 ? "files" : "text"; } }

        public string Describe()
        {
            if (ImagePath != null) return "Image from the clipboard";
            if (Files.Count == 1) return Path.GetFileName(Files[0].TrimEnd('\\'));
            if (Files.Count > 1) return Files.Count + " files";
            return "“" + Fmt.OneLine(Text, 60) + "”";
        }

        // Text wins when both text and a picture are offered (Office copies carry both); a picture on its own
        // (screenshots, "Copy image") is sent as a PNG; files copied in Explorer are sent as files (folders zipped).
        public static ClipPayload Read(string imageFolder)
        {
            var p = new ClipPayload();
            if (IsolatedDir != null) return ReadIsolated(imageFolder);
            for (int attempt = 0; attempt < 3; attempt++)
            {
                try
                {
                    if (Clipboard.ContainsFileDropList())
                    {
                        foreach (string f in Clipboard.GetFileDropList()) if (File.Exists(f) || Directory.Exists(f)) p.Files.Add(f);
                    }
                    else if (Clipboard.ContainsText() && Clipboard.GetText().Trim().Length > 0)
                    {
                        p.Text = Clipboard.GetText();
                    }
                    else if (Clipboard.ContainsImage() || Clipboard.ContainsData("PNG"))
                    {
                        p.ImagePath = SaveClipboardImage(imageFolder);
                    }
                    return p;
                }
                catch (ExternalException) { Thread.Sleep(100); }
                catch (Exception ex) { Log.Error("Reading clipboard", ex); return p; }
            }
            return p;
        }

        static ClipPayload ReadIsolated(string imageFolder)
        {
            var p = new ClipPayload();
            try
            {
                string files = Path.Combine(IsolatedDir, "clipboard-in-files.txt");
                string text = Path.Combine(IsolatedDir, "clipboard-in.txt");
                string png = Path.Combine(IsolatedDir, "clipboard-in.png");
                if (File.Exists(files)) foreach (var line in File.ReadAllLines(files)) { string f = line.Trim(); if (File.Exists(f) || Directory.Exists(f)) p.Files.Add(f); }
                if (p.Files.Count == 0 && File.Exists(text)) p.Text = File.ReadAllText(text, Encoding.UTF8);
                if (p.Files.Count == 0 && string.IsNullOrEmpty(p.Text) && File.Exists(png))
                {
                    Directory.CreateDirectory(imageFolder);
                    string dest = FileUtil.UniquePath(imageFolder, "Image " + DateTime.Now.ToString("yyyy-MM-dd HH.mm.ss") + ".png");
                    File.Copy(png, dest);
                    p.ImagePath = dest;
                }
            }
            catch (Exception ex) { Log.Error("Reading the test clipboard", ex); }
            return p;
        }

        public static bool HasImage()
        {
            if (IsolatedDir != null) return File.Exists(Path.Combine(IsolatedDir, "clipboard-in.png"));
            try { return Clipboard.ContainsImage() || Clipboard.ContainsData("PNG"); } catch { return false; }
        }

        public static uint Sequence()
        {
            if (IsolatedDir != null)
            {
                try { return (uint)File.GetLastWriteTimeUtc(Path.Combine(IsolatedDir, "clipboard-in.png")).Ticks; } catch { return 0; }
            }
            return Native.GetClipboardSequenceNumber();
        }

        public static string SaveClipboardImage(string folder)
        {
            Directory.CreateDirectory(folder);
            string path = FileUtil.UniquePath(folder, "Image " + DateTime.Now.ToString("yyyy-MM-dd HH.mm.ss") + ".png");
            var png = Clipboard.GetData("PNG") as Stream;
            if (png != null)
            {
                using (var f = File.Create(path)) png.CopyTo(f);
                return path;
            }
            using (var img = Clipboard.GetImage())
            {
                if (img == null) return null;
                img.Save(path, ImageFormat.Png);
            }
            return path;
        }

        // history=false keeps the text out of Win+V history, cloud clipboard and clipboard managers.
        public static bool SetText(string text, bool history)
        {
            if (string.IsNullOrEmpty(text)) return false;
            // Windows apps expect CRLF line breaks on the clipboard.
            text = System.Text.RegularExpressions.Regex.Replace(text, "(?<!\r)\n", "\r\n");
            if (IsolatedDir != null)
            {
                try { File.WriteAllText(Path.Combine(IsolatedDir, "clipboard.txt"), text, new UTF8Encoding(false)); return true; }
                catch (Exception ex) { Log.Error("Test clipboard", ex); return false; }
            }
            try
            {
                var data = new DataObject();
                data.SetData(DataFormats.UnicodeText, text);
                if (!history)
                {
                    data.SetData("ExcludeClipboardContentFromMonitorProcessing", new MemoryStream(new byte[4]));
                    data.SetData("CanIncludeInClipboardHistory", new MemoryStream(new byte[4]));
                    data.SetData("CanUploadToCloudClipboard", new MemoryStream(new byte[4]));
                }
                Clipboard.SetDataObject(data, true, 10, 100);
                return true;
            }
            catch (Exception ex)
            {
                Log.Error("Clipboard", ex);
                return false;
            }
        }

        // A picture to copy: the bitmap, turned as the photo's EXIF orientation says (as a browser shows it), and PNG
        // bytes when it has transparency (a bitmap on the clipboard has none). Null, with why ("too-big", or
        // "unsupported": a type Windows can't read, such as WebP or HEIC), if it can't. Slow for big photos: not on the
        // UI thread.
        public static Bitmap DecodeImage(byte[] bytes, out byte[] png, out string why)
        {
            png = null;
            why = null;
            try
            {
                using (var ms = new MemoryStream(bytes))
                using (var img = Image.FromStream(ms, true, true))
                {
                    if ((long)img.Width * img.Height > MaxCopyPixels) { why = "too-big"; return null; }
                    var bmp = new Bitmap(img);
                    try
                    {
                        RotateFlipType turn = ExifTurn(img);
                        if (turn != RotateFlipType.RotateNoneFlipNone) bmp.RotateFlip(turn);
                        if (Image.IsAlphaPixelFormat(img.PixelFormat))
                        {
                            using (var p = new MemoryStream())
                            {
                                bmp.Save(p, ImageFormat.Png);
                                png = p.ToArray();
                            }
                        }
                        return bmp;
                    }
                    catch
                    {
                        bmp.Dispose();
                        throw;
                    }
                }
            }
            catch (ArgumentException) { why = "unsupported"; return null; }
            catch (OutOfMemoryException) { why = "unsupported"; return null; } // (GDI+'s answer to some files it can't read)
            catch (ExternalException) { why = "unsupported"; return null; }
        }

        // 100 megapixels: 400 MB as a bitmap.
        const long MaxCopyPixels = 100000000;

        static RotateFlipType ExifTurn(Image img)
        {
            if (Array.IndexOf(img.PropertyIdList, 0x0112) < 0) return RotateFlipType.RotateNoneFlipNone;
            byte[] v = img.GetPropertyItem(0x0112).Value;
            switch (v != null && v.Length > 0 ? v[0] : 1)
            {
                case 2: return RotateFlipType.RotateNoneFlipX;
                case 3: return RotateFlipType.Rotate180FlipNone;
                case 4: return RotateFlipType.Rotate180FlipX;
                case 5: return RotateFlipType.Rotate90FlipX;
                case 6: return RotateFlipType.Rotate90FlipNone;
                case 7: return RotateFlipType.Rotate270FlipX;
                case 8: return RotateFlipType.Rotate270FlipNone;
                default: return RotateFlipType.RotateNoneFlipNone;
            }
        }

        // A picture on the clipboard (Copy image in the chat): as a bitmap, which every app takes, and as PNG when it has
        // transparency. history=false keeps it out of Win+V history and the cloud clipboard, as for text.
        public static bool SetImage(Bitmap bmp, byte[] png, bool history)
        {
            if (IsolatedDir != null)
            {
                try
                {
                    bmp.Save(Path.Combine(IsolatedDir, "clipboard.png"), ImageFormat.Png);
                    File.WriteAllText(Path.Combine(IsolatedDir, "clipboard-image.txt"), (png != null ? "png" : "bitmap") + (history ? "" : " no-history"));
                    return true;
                }
                catch (Exception ex) { Log.Error("Test clipboard", ex); return false; }
            }
            try
            {
                var data = new DataObject();
                data.SetData(DataFormats.Bitmap, true, bmp);
                if (png != null) data.SetData("PNG", false, new MemoryStream(png));
                if (!history)
                {
                    data.SetData("ExcludeClipboardContentFromMonitorProcessing", new MemoryStream(new byte[4]));
                    data.SetData("CanIncludeInClipboardHistory", new MemoryStream(new byte[4]));
                    data.SetData("CanUploadToCloudClipboard", new MemoryStream(new byte[4]));
                }
                Clipboard.SetDataObject(data, true, 10, 100);
                return true;
            }
            catch (Exception ex)
            {
                Log.Error("Clipboard", ex);
                return false;
            }
        }

        // Files on the clipboard as Explorer's Copy puts them (Beam 1.7.1): what a file dragged out of the chat becomes while
        // another device controls this PC, where a drag would hold up that session's own input (see WebWindow.DragOut).
        public static bool SetFiles(IList<string> paths)
        {
            if (paths == null || paths.Count == 0) return false;
            if (IsolatedDir != null)
            {
                try { File.WriteAllLines(Path.Combine(IsolatedDir, "clipboard-files.txt"), paths); return true; }
                catch (Exception ex) { Log.Error("Test clipboard", ex); return false; }
            }
            try
            {
                var data = new DataObject();
                var list = new StringCollection();
                list.AddRange(paths.ToArray());
                data.SetFileDropList(list);
                data.SetData("Preferred DropEffect", new MemoryStream(BitConverter.GetBytes((int)DragDropEffects.Copy))); // copy, not cut
                Clipboard.SetDataObject(data, true, 10, 100);
                return true;
            }
            catch (Exception ex)
            {
                Log.Error("Clipboard", ex);
                return false;
            }
        }

        // Text from a remote control viewer (Beam 1.6): never uploaded to the cloud clipboard, and kept out of Win+V
        // history too when "Keep it in clipboard history" is off.
        public static bool SetRemoteText(string text, bool history)
        {
            if (string.IsNullOrEmpty(text)) return false;
            text = System.Text.RegularExpressions.Regex.Replace(text, "(?<!\r)\n", "\r\n");
            if (IsolatedDir != null)
            {
                try { File.WriteAllText(Path.Combine(IsolatedDir, "clipboard.txt"), text, new UTF8Encoding(false)); return true; }
                catch (Exception ex) { Log.Error("Test clipboard", ex); return false; }
            }
            try
            {
                var data = new DataObject();
                data.SetData(DataFormats.UnicodeText, text);
                data.SetData("CanUploadToCloudClipboard", new MemoryStream(new byte[4]));
                if (!history) data.SetData("CanIncludeInClipboardHistory", new MemoryStream(new byte[4]));
                Clipboard.SetDataObject(data, true, 10, 100);
                return true;
            }
            catch (Exception ex)
            {
                Log.Error("Clipboard", ex);
                return false;
            }
        }

        // The clipboard's text for a remote control viewer, or null: nothing marked as not to be shared (password
        // managers mark secrets with these formats, as does Beam's own copy of remote text), nothing but text.
        public static string ReadSharableText()
        {
            if (IsolatedDir != null)
            {
                try
                {
                    if (File.Exists(Path.Combine(IsolatedDir, "clipboard-in.secret"))) return null;
                    string p = Path.Combine(IsolatedDir, "clipboard-in.txt");
                    return File.Exists(p) ? File.ReadAllText(p, Encoding.UTF8) : null;
                }
                catch { return null; }
            }
            for (int attempt = 0; attempt < 3; attempt++)
            {
                try
                {
                    var data = Clipboard.GetDataObject();
                    if (data == null || data.GetDataPresent("Clipboard Viewer Ignore") || data.GetDataPresent("ExcludeClipboardContentFromMonitorProcessing")) return null;
                    if (Zero(data, "CanIncludeInClipboardHistory") || Zero(data, "CanUploadToCloudClipboard")) return null;
                    if (!data.GetDataPresent(DataFormats.UnicodeText)) return null;
                    return data.GetData(DataFormats.UnicodeText) as string;
                }
                catch (ExternalException) { Thread.Sleep(50); }
                catch { return null; }
            }
            return null;
        }

        // (1.12.4) The clipboard's picture for a remote control viewer or a PC beside, as PNG, or null: as for text, nothing
        // marked as not to be shared (Beam's own copy of a remote picture is), and none over max bytes. Text wins (Office
        // copies carry both): the caller asks for this only when there's no text. A bitmap without PNG is encoded here.
        public static byte[] ReadSharableImage(int max)
        {
            if (IsolatedDir != null)
            {
                try
                {
                    if (File.Exists(Path.Combine(IsolatedDir, "clipboard-in.secret"))) return null;
                    string p = Path.Combine(IsolatedDir, "clipboard-in.png");
                    if (!File.Exists(p) || new FileInfo(p).Length > max) return null;
                    return File.ReadAllBytes(p);
                }
                catch { return null; }
            }
            for (int attempt = 0; attempt < 3; attempt++)
            {
                try
                {
                    var data = Clipboard.GetDataObject();
                    if (data == null || data.GetDataPresent("Clipboard Viewer Ignore") || data.GetDataPresent("ExcludeClipboardContentFromMonitorProcessing")) return null;
                    if (Zero(data, "CanIncludeInClipboardHistory") || Zero(data, "CanUploadToCloudClipboard")) return null;
                    if (data.GetDataPresent("PNG"))
                    {
                        var s = data.GetData("PNG") as Stream;
                        if (s != null)
                            using (var ms = new MemoryStream())
                            {
                                s.CopyTo(ms);
                                if (ms.Length > 0) return ms.Length <= max ? ms.ToArray() : null;
                            }
                    }
                    if (!data.GetDataPresent(DataFormats.Bitmap)) return null;
                    using (var img = data.GetData(DataFormats.Bitmap) as Image)
                    {
                        if (img == null || (long)img.Width * img.Height > MaxCopyPixels) return null;
                        using (var ms = new MemoryStream())
                        {
                            img.Save(ms, ImageFormat.Png);
                            return ms.Length <= max ? ms.ToArray() : null;
                        }
                    }
                }
                catch (ExternalException) { Thread.Sleep(50); }
                catch { return null; }
            }
            return null;
        }

        // (1.12.4) A picture from a viewer or a PC beside, as SetRemoteText: never to the cloud clipboard, out of Win+V
        // history when "Keep it in clipboard history" is off, and (so marked) never sent back. png: the bytes as they came
        // when they're a PNG (kept exactly, transparency too), else null.
        public static bool SetRemoteImage(Bitmap bmp, byte[] png, bool history)
        {
            if (IsolatedDir != null)
            {
                try
                {
                    bmp.Save(Path.Combine(IsolatedDir, "clipboard.png"), ImageFormat.Png);
                    File.WriteAllText(Path.Combine(IsolatedDir, "clipboard-image.txt"), (png != null ? "png" : "bitmap") + " remote" + (history ? "" : " no-history"));
                    return true;
                }
                catch (Exception ex) { Log.Error("Test clipboard", ex); return false; }
            }
            try
            {
                var data = new DataObject();
                data.SetData(DataFormats.Bitmap, true, bmp);
                if (png != null) data.SetData("PNG", false, new MemoryStream(png));
                data.SetData("CanUploadToCloudClipboard", new MemoryStream(new byte[4]));
                if (!history) data.SetData("CanIncludeInClipboardHistory", new MemoryStream(new byte[4]));
                Clipboard.SetDataObject(data, true, 10, 100);
                return true;
            }
            catch (Exception ex)
            {
                Log.Error("Clipboard", ex);
                return false;
            }
        }

        public static bool IsPng(byte[] b)
        {
            return b != null && b.Length > 8 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47 && b[4] == 0x0D && b[5] == 0x0A && b[6] == 0x1A && b[7] == 0x0A;
        }

        // (1.12.4) Changes whenever what the clipboard shares may have, text or picture (tests: the test clipboard's files).
        public static uint ShareSequence()
        {
            if (IsolatedDir != null)
            {
                long t = 0;
                foreach (var f in new[] { "clipboard-in.txt", "clipboard-in.secret", "clipboard-in.png" })
                {
                    try { string p = Path.Combine(IsolatedDir, f); if (File.Exists(p)) t = t * 31 + File.GetLastWriteTimeUtc(p).Ticks + 1; } catch { }
                }
                return (uint)(t ^ (t >> 32));
            }
            return Native.GetClipboardSequenceNumber();
        }

        static bool Zero(IDataObject data, string format)
        {
            if (!data.GetDataPresent(format)) return false;
            var ms = data.GetData(format) as MemoryStream;
            if (ms == null) return false;
            var b = ms.ToArray();
            return b.Length >= 4 && BitConverter.ToInt32(b, 0) == 0;
        }

        // Changes whenever the clipboard's text may have (tests: the test clipboard's files).
        public static uint TextSequence()
        {
            if (IsolatedDir != null)
            {
                long t = 0;
                foreach (var f in new[] { "clipboard-in.txt", "clipboard-in.secret" })
                {
                    try { string p = Path.Combine(IsolatedDir, f); if (File.Exists(p)) t = t * 31 + File.GetLastWriteTimeUtc(p).Ticks + 1; } catch { }
                }
                return (uint)(t ^ (t >> 32));
            }
            return Native.GetClipboardSequenceNumber();
        }
    }

    // (1.12.4) A picture through remote control's or the KVM's clipboard sync (the user: a screenshot pasted "just pasted
    // the text that was already copied"): on the `clip` channel of its own (a big one on `ctl` would hold up the pings
    // the KVM watches), in order, in parts of 48 KB as base64: {t: "img", n, i, of, size, type, d}.
    static class ClipImage
    {
        public const int MaxBytes = 16 * 1024 * 1024, PartBytes = 48 * 1024;
        public const int MaxParts = (MaxBytes + PartBytes - 1) / PartBytes;

        // The parts, each as the JSON text the channel carries.
        public static List<string> Parts(byte[] bytes, long n)
        {
            var list = new List<string>();
            int of = Math.Max(1, (bytes.Length + PartBytes - 1) / PartBytes);
            for (int i = 0; i < of; i++)
            {
                int at = i * PartBytes, len = Math.Min(PartBytes, bytes.Length - at);
                var p = new Dictionary<string, object>();
                p["t"] = "img";
                p["n"] = n;
                p["i"] = (long)i;
                p["of"] = (long)of;
                p["size"] = (long)bytes.Length;
                p["type"] = "image/png";
                p["d"] = Convert.ToBase64String(bytes, at, len);
                list.Add(Json.Stringify(p));
            }
            return list;
        }

        // A picture that came, decoded off the UI thread (a big one takes a while): the bitmap and, if it came as a PNG,
        // its bytes as they were. Null when it isn't one Windows can read.
        public static Bitmap Decode(byte[] bytes, out byte[] png)
        {
            png = null;
            string why;
            byte[] alpha;
            var bmp = ClipPayload.DecodeImage(bytes, out alpha, out why);
            if (bmp != null) png = ClipPayload.IsPng(bytes) ? bytes : alpha;
            return bmp;
        }
    }

    // One picture coming in, part by part; anything out of step (another one started, a part missing) drops it.
    class ClipImageIn
    {
        long n = -1, size;
        int of, next;
        MemoryStream data;

        public long Number { get { return n; } }

        // The whole picture once its last part has come, else null.
        public byte[] Add(Dictionary<string, object> p)
        {
            if (p == null || Json.Str(p, "t") != "img") return null;
            long pn = Json.Long(p, "n", -1), i = Json.Long(p, "i", -1), pof = Json.Long(p, "of", 0), psize = Json.Long(p, "size", -1);
            if (i == 0)
            {
                n = pn;
                of = (int)Math.Min(pof, int.MaxValue);
                size = psize;
                next = 0;
                data = of >= 1 && of <= ClipImage.MaxParts && size >= 1 && size <= ClipImage.MaxBytes ? new MemoryStream() : null;
            }
            if (data == null || pn != n || i != next) { data = null; return null; }
            byte[] chunk;
            try { chunk = Convert.FromBase64String(Json.Str(p, "d") ?? ""); }
            catch { data = null; return null; }
            if (data.Length + chunk.Length > size) { data = null; return null; }
            data.Write(chunk, 0, chunk.Length);
            if (++next < of) return null;
            var all = data.Length == size ? data.ToArray() : null;
            data = null;
            return all;
        }
    }

    static class Zip
    {
        // Folder -> "<folder name>.zip" in the outgoing folder (runs on a worker thread).
        public static string Folder(string dir, string outFolder)
        {
            Directory.CreateDirectory(outFolder);
            string name = FileUtil.SafeName(Path.GetFileName(dir.TrimEnd('\\', '/')));
            if (name.Length == 0) name = "Folder";
            string dest = FileUtil.UniquePath(outFolder, name + ".zip");
            string part = dest + ".part";
            FileUtil.TryDelete(part);
            ZipFile.CreateFromDirectory(dir, part, CompressionLevel.Fastest, true);
            File.Move(part, dest);
            return dest;
        }
    }
}
