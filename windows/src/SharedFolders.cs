// (Windows app 1.18, Beam 1.26) Shared folders: folders on this PC that some of the user's other devices may look in and
// copy files from (the user, 2026-10-15: "being able to browser folders on other devices, like from my laptop, look at my
// desktops downloads folder and then copy from that to my laptop", "maybe being able to choose which folders to share with
// what devices"; "Copy from only"). Chosen only here, in SharedFoldersForm (Settings → This PC → Shared folders…): the
// folders and, for each, the devices that may see it. The server relays another device's request (`files-request`,
// `files-copy`) only for a trusted sign-in and says who asks (`by`); this PC checks that against the folder's devices and
// answers (POST /api/devices/me/files). A copy is an ordinary send to that device (SendFiles, the original never deleted).
// Never reachable: anything outside the folder; hidden or system entries; names starting with "." (.beam holds the update
// key, .ssh…); links and junctions (of reparse points only OneDrive's placeholders and Windows' compressed or deduplicated
// files, which are a file's own data). A folder can't be a whole drive, the profile folder or above it, a network folder,
// or inside AppData, Windows or Program Files. Every listing and copy goes in beam.log; a copy also shows a notice here.
// (1.20) Icons, thumbnails, a preview, a search and whole folders: SharedFoldersMore.cs.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Beam
{
    class SharedFolder
    {
        public string Id, Name, Path;
        public List<string> Devices = new List<string>(); // the devices that may see it

        public static SharedFolder Parse(Dictionary<string, object> d)
        {
            if (d == null) return null;
            var f = new SharedFolder();
            f.Id = Json.Str(d, "id");
            f.Path = Json.Str(d, "path");
            f.Name = Json.Str(d, "name");
            if (f.Id == null || !Regex.IsMatch(f.Id, "^[a-f0-9]{8}$") || string.IsNullOrWhiteSpace(f.Path)) return null;
            if (string.IsNullOrWhiteSpace(f.Name)) f.Name = Shares.DefaultName(f.Path);
            foreach (var id in Json.StrList(d, "devices")) if (Config.ValidId(id) && !f.Devices.Contains(id)) f.Devices.Add(id);
            return f;
        }

        public Dictionary<string, object> ToJson()
        {
            var d = new Dictionary<string, object>();
            d["id"] = Id;
            d["name"] = Name;
            d["path"] = Path;
            d["devices"] = Devices.Cast<object>().ToArray();
            return d;
        }

        public SharedFolder Copy()
        {
            var f = new SharedFolder();
            f.Id = Id; f.Name = Name; f.Path = Path;
            f.Devices = new List<string>(Devices);
            return f;
        }
    }

    static partial class Shares
    {
        public const int MaxEntries = 2000, MaxNames = 100;
        static readonly string[] Reserved = { "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9" };
        static readonly Dictionary<string, long> noticed = new Dictionary<string, long>(); // device -> its last copy's notice here
        static readonly Random random = new Random();

        public static string DefaultName(string path)
        {
            string n = null;
            try { n = System.IO.Path.GetFileName((path ?? "").TrimEnd('\\')); } catch { }
            return string.IsNullOrEmpty(n) ? "Shared folder" : n;
        }

        public static string NewId(IEnumerable<SharedFolder> existing)
        {
            for (;;)
            {
                string id = random.Next(0x10000000, int.MaxValue).ToString("x8");
                if (!existing.Any(f => f.Id == id)) return id;
            }
        }

        static bool Within(string path, string root)
        {
            return path.Equals(root, StringComparison.OrdinalIgnoreCase) || path.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase);
        }

        // Why `path` can't be a shared folder, or null when it can. (A test instance may share inside its own folder.)
        public static string Refusal(string path, Config cfg)
        {
            string full;
            try { full = System.IO.Path.GetFullPath(path ?? "").TrimEnd('\\'); }
            catch { return "that isn't a folder"; }
            if (full.StartsWith(@"\\")) return "a network folder can't be shared";
            if (!Directory.Exists(full)) return "that folder isn't there";
            string root = (System.IO.Path.GetPathRoot(full) ?? "").TrimEnd('\\');
            if (full.Equals(root, StringComparison.OrdinalIgnoreCase)) return "a whole drive can't be shared: pick a folder on it";
            if (cfg != null && cfg.CustomPath && !string.IsNullOrEmpty(cfg.Dir) && Within(full, cfg.Dir.TrimEnd('\\'))) return null;
            string profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile).TrimEnd('\\');
            if (profile.Length > 0 && Within(profile, full)) return "your whole user folder can't be shared: pick a folder in it, like Downloads";
            foreach (var sf in new[] { Environment.SpecialFolder.ApplicationData, Environment.SpecialFolder.LocalApplicationData, Environment.SpecialFolder.CommonApplicationData,
                Environment.SpecialFolder.Windows, Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86 })
            {
                string p = Environment.GetFolderPath(sf).TrimEnd('\\');
                if (p.Length > 0 && (Within(full, p) || Within(p, full))) return "Windows' and apps' own folders can't be shared";
            }
            foreach (var part in full.Substring(root.Length).Split(new[] { '\\' }, StringSplitOptions.RemoveEmptyEntries))
                if (part.StartsWith(".")) return "a folder whose name starts with \".\" can't be shared";
            return null;
        }

        // ------------------------------------------------------------------ what's in a folder

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct FindData
        {
            public uint Attributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
            public uint SizeHigh, SizeLow, Reserved0, Reserved1;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string ShortName;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr FindFirstFileExW(string name, int level, out FindData data, int op, IntPtr filter, int flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool FindNextFileW(IntPtr h, out FindData data);
        [DllImport("kernel32.dll")]
        static extern bool FindClose(IntPtr h);
        static readonly IntPtr Invalid = new IntPtr(-1);
        const int InfoBasic = 1, LargeFetch = 2;
        const uint Hidden = 0x2, SystemFile = 0x4, Directory_ = 0x10, ReparsePoint = 0x400;
        static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        class Entry
        {
            public string Name;
            public bool Dir;
            public long Size, Mtime, Ctime;
            public uint Attributes, Tag;
        }

        static string Long(string path) { return path.StartsWith(@"\\?\") ? path : @"\\?\" + path; }

        static Entry FromData(FindData d)
        {
            var e = new Entry();
            e.Name = d.Name;
            e.Attributes = d.Attributes;
            e.Dir = (d.Attributes & Directory_) != 0;
            e.Size = ((long)d.SizeHigh << 32) | d.SizeLow;
            long ft = ((long)(uint)d.Written.dwHighDateTime << 32) | (uint)d.Written.dwLowDateTime;
            try { e.Mtime = (long)(DateTime.FromFileTimeUtc(ft) - Epoch).TotalMilliseconds; } catch { }
            long ct = ((long)(uint)d.Created.dwHighDateTime << 32) | (uint)d.Created.dwLowDateTime;
            try { e.Ctime = (long)(DateTime.FromFileTimeUtc(ct) - Epoch).TotalMilliseconds; } catch { }
            e.Tag = (d.Attributes & ReparsePoint) != 0 ? d.Reserved0 : 0; // (FindFirstFile gives the reparse tag here)
            return e;
        }

        // Every entry of a folder (but . and ..), with its reparse tag.
        static List<Entry> Read(string dir)
        {
            var list = new List<Entry>();
            FindData d;
            IntPtr h = FindFirstFileExW(Long(dir) + "\\*", InfoBasic, out d, 0, IntPtr.Zero, LargeFetch);
            if (h == Invalid) return list;
            try
            {
                do { if (d.Name != "." && d.Name != "..") list.Add(FromData(d)); } while (FindNextFileW(h, out d));
            }
            finally { FindClose(h); }
            return list;
        }

        // One entry by its path (no wildcards: a name that passed NameOk has none), or null.
        static Entry One(string path)
        {
            FindData d;
            IntPtr h = FindFirstFileExW(Long(path), InfoBasic, out d, 0, IntPtr.Zero, 0);
            if (h == Invalid) return null;
            FindClose(h);
            return FromData(d);
        }

        // Reparse points that are a file's own data, not a way elsewhere: OneDrive's placeholders (the cloud tags), and
        // deduplicated or compressed (WOF) files. Links, junctions, mount points and any other kind: never shown or followed.
        static bool DataTag(uint tag)
        {
            return (tag & 0xFFFF0FFF) == 0x9000001A || tag == 0x80000013 || tag == 0x80000017;
        }

        static bool Shown(Entry e)
        {
            if ((e.Attributes & (Hidden | SystemFile)) != 0) return false;
            if ((e.Attributes & ReparsePoint) != 0 && !DataTag(e.Tag)) return false;
            return NameOk(e.Name);
        }

        // A name as one step: nothing starting with "." (hidden here, as elsewhere), no characters Windows doesn't allow
        // (separators, ":" of streams, wildcards), no trailing dot or space (Windows drops them), not a device's name.
        static bool NameOk(string s)
        {
            if (string.IsNullOrEmpty(s) || s.Length > 255 || s[0] == '.' || s.EndsWith(".") || s.EndsWith(" ")) return false;
            if (s.IndexOfAny(System.IO.Path.GetInvalidFileNameChars()) >= 0) return false;
            return Array.IndexOf(Reserved, s.Split('.')[0].TrimEnd().ToUpperInvariant()) < 0;
        }

        // The folder `rel` (steps split by / or \) inside the shared one, each step a folder that's shown; norm: the
        // steps as they're named on disk, joined with /. Null when there's no such folder (or it isn't to be seen).
        static string Resolve(SharedFolder f, string rel, out string norm)
        {
            norm = "";
            string cur = System.IO.Path.GetFullPath(f.Path).TrimEnd('\\');
            var steps = new List<string>();
            foreach (var step in (rel ?? "").Split(new[] { '/', '\\' }, StringSplitOptions.RemoveEmptyEntries))
            {
                if (!NameOk(step)) return null;
                var e = One(cur + "\\" + step);
                if (e == null || !e.Dir || !Shown(e)) return null;
                cur = cur + "\\" + e.Name;
                steps.Add(e.Name);
            }
            if (!Directory.Exists(cur)) return null;
            norm = string.Join("/", steps);
            return cur;
        }

        static List<SharedFolder> Visible(App app, string by)
        {
            return app.Cfg.SharedFolders.Where(f => !string.IsNullOrEmpty(by) && f.Devices.Contains(by) && Refusal(f.Path, app.Cfg) == null).ToList();
        }

        // ------------------------------------------------------------------ the requests

        // `files-request`: the folders shared with the asking device, or what's in one of them.
        public static async void OnRequest(App app, Dictionary<string, object> d)
        {
            string id = Json.Str(d, "id"), by = Json.Str(d, "by"), byName = Json.Str(d, "byName") ?? "A device";
            string share = Json.Str(d, "share") ?? "", rel = Json.Str(d, "path") ?? "";
            if (app.Api == null || string.IsNullOrEmpty(id)) return;
            var answer = new Dictionary<string, object>();
            answer["id"] = id;
            try
            {
                var mine = Visible(app, by);
                if (share.Length == 0)
                {
                    answer["ok"] = true;
                    answer["shares"] = mine.Select(f => { var o = new Dictionary<string, object>(); o["id"] = f.Id; o["name"] = f.Name; return (object)o; }).ToArray();
                    Log.Write("Shared folders: " + byName + " asked which folders it may see (" + mine.Count + ")");
                }
                else
                {
                    var f = mine.FirstOrDefault(x => x.Id == share);
                    if (f == null)
                    {
                        No(answer, "not-shared", "That folder isn't shared with " + byName);
                        Log.Write("Shared folders: " + byName + " asked for a folder that isn't shared with it");
                    }
                    else
                    {
                        string norm = "", dir = null;
                        List<Entry> entries = null;
                        await Task.Run(() =>
                        {
                            dir = Resolve(f, rel, out norm);
                            if (dir != null) entries = Read(dir).Where(Shown).OrderBy(e => e.Dir ? 0 : 1).ThenBy(e => e.Name, StringComparer.CurrentCultureIgnoreCase).ToList();
                        });
                        if (dir == null) No(answer, "not-found", "That folder isn't there");
                        else
                        {
                            answer["ok"] = true;
                            answer["share"] = f.Id;
                            answer["name"] = f.Name;
                            answer["path"] = norm;
                            answer["entries"] = entries.Take(MaxEntries).Select(e =>
                            {
                                var o = new Dictionary<string, object>();
                                o["n"] = e.Name;
                                if (e.Dir) o["dir"] = true;
                                o["s"] = e.Dir ? 0 : e.Size;
                                o["m"] = e.Mtime;
                                o["c"] = e.Ctime; // (1.20)
                                return (object)o;
                            }).ToArray();
                            if (entries.Count > MaxEntries) answer["more"] = true;
                            Log.Write("Shared folders: " + byName + " looked in " + f.Name + (norm.Length > 0 ? "\\" + norm.Replace('/', '\\') : "") + " (" + entries.Count + ")");
                        }
                    }
                }
            }
            catch (Exception ex) { No(answer, "error", "This PC couldn't read that folder"); Log.Error("Shared folders", ex); }
            await Answer(app, answer);
        }

        // `files-copy`: those files sent to the asking device, the way this PC sends anything. (1.20) A name may be inside a
        // folder ("2026/a.jpg", from a search), and a folder goes as a .zip of what it shows (ZipShown).
        public static async void OnCopy(App app, Dictionary<string, object> d)
        {
            string id = Json.Str(d, "id"), by = Json.Str(d, "by"), byName = Json.Str(d, "byName") ?? "A device";
            string share = Json.Str(d, "share") ?? "", rel = Json.Str(d, "path") ?? "";
            var names = Json.StrList(d, "names").Take(MaxNames).Distinct().ToList();
            if (app.Api == null || string.IsNullOrEmpty(id)) return;
            var answer = new Dictionary<string, object>();
            answer["id"] = id;
            try
            {
                var f = Visible(app, by).FirstOrDefault(x => x.Id == share);
                if (f == null || by == app.Me)
                {
                    No(answer, "not-shared", "That folder isn't shared with " + byName);
                    Log.Write("Shared folders: " + byName + " asked for files from a folder that isn't shared with it");
                }
                else
                {
                    string norm = "", dir = null;
                    var paths = new List<string>();
                    var folders = new List<string>();
                    var skipped = new List<object>();
                    long total = 0;
                    string outgoing = app.Cfg.OutgoingFolder;
                    await Task.Run(() =>
                    {
                        dir = Resolve(f, rel, out norm);
                        if (dir == null) return;
                        foreach (var n in names)
                        {
                            Entry e;
                            string full = Inside(dir, n, out e);
                            if (full == null) { skipped.Add(Skip(n, "not there")); continue; }
                            if (!e.Dir) { paths.Add(full); total += e.Size; continue; }
                            string why = ZipRefusal(full, outgoing);
                            if (why != null) skipped.Add(Skip(n, why));
                            else folders.Add(full);
                        }
                    });
                    if (dir == null) No(answer, "not-found", "That folder isn't there");
                    else
                    {
                        var to = new List<string> { by };
                        int sending = paths.Count > 0 ? app.SendFiles(paths, to, false, "shared folder", null, false) : 0;
                        if (folders.Count > 0) sending += app.SendFiles(folders, to, false, "shared folder", null, false, ZipShown);
                        paths.AddRange(folders);
                        answer["ok"] = true;
                        answer["sending"] = sending;
                        answer["skipped"] = skipped.ToArray();
                        if (sending > 0)
                        {
                            Log.Write("Shared folders: " + byName + " copies " + string.Join(", ", paths.Select(p => System.IO.Path.GetFileName(p))) + " (" + Fmt.Size(total) + ") from " + f.Name);
                            Notice(app, by, byName, sending, f.Name);
                        }
                    }
                }
            }
            catch (Exception ex) { No(answer, "error", "This PC couldn't send those files"); Log.Error("Shared folders", ex); }
            await Answer(app, answer);
        }

        static void Notice(App app, string by, string byName, int count, string folder)
        {
            long now = Fmt.NowMs(), last;
            if (noticed.TryGetValue(by, out last) && now - last < 30000) return;
            noticed[by] = now;
            app.Notify(byName + " is copying " + (count == 1 ? "a file" : count + " files"), "From " + folder + " (shared folders: Settings → This PC)");
        }

        static void No(Dictionary<string, object> a, string reason, string error)
        {
            a["ok"] = false;
            a["reason"] = reason;
            a["error"] = error;
        }

        static object Skip(string n, string why)
        {
            var o = new Dictionary<string, object>();
            o["n"] = n;
            o["why"] = why;
            return o;
        }

        static async Task Answer(App app, Dictionary<string, object> body)
        {
            try { await app.Api.Call(HttpMethod.Post, "/api/devices/me/files", body, 30, CancellationToken.None); }
            catch (Exception ex) { Log.Write("Shared folders: the answer wasn't sent (" + Api.Describe(ex) + ")"); }
        }
    }

    // Settings → This PC → Shared folders…: the folders other devices may copy from, and which devices see each. Only this
    // window adds a folder or a device: never the page, the server or another device (and not while this PC is controlled).
    class SharedFoldersForm : DialogBase
    {
        readonly App app;
        readonly List<SharedFolder> shares;
        readonly Dictionary<string, List<KeyValuePair<string, FlatCheck>>> checks = new Dictionary<string, List<KeyValuePair<string, FlatCheck>>>();
        readonly Panel body, footer;

        public SharedFoldersForm(App app) : base("Shared folders", 560)
        {
            this.app = app;
            shares = app.Cfg.SharedFolders.Select(f => f.Copy()).ToList();
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
            save.Click += (s, e) => { Collect(); app.SetSharedFolders(shares, "Settings on this PC"); Close(); };
            cancel.Click += (s, e) => Close();
            add.Click += (s, e) => AddFolder();
            int footerH = Ui.S(36) + Pad;
            save.SetBounds(ClientSize.Width - Pad - save.Width, Ui.S(8), save.Width, save.Height);
            cancel.SetBounds(save.Left - Ui.S(10) - cancel.Width, Ui.S(8), cancel.Width, cancel.Height);
            add.SetBounds(Pad, Ui.S(8), add.Width, add.Height);
            footer.Tag = footerH;
            Render();
        }

        // The ticks so far into the folders (before drawing again, and on Save).
        void Collect()
        {
            foreach (var f in shares)
            {
                List<KeyValuePair<string, FlatCheck>> list;
                if (!checks.TryGetValue(f.Id, out list)) continue;
                f.Devices = list.Where(kv => kv.Value.Checked).Select(kv => kv.Key).ToList();
            }
        }

        void Render()
        {
            body.SuspendLayout();
            foreach (Control c in body.Controls.Cast<Control>().ToList()) { body.Controls.Remove(c); c.Dispose(); }
            checks.Clear();
            Y = Pad;
            AddLabel("Shared folders", Ui.Title, false, Ui.S(10));
            AddLabel("Folders on this PC that the devices ticked under each can look in and copy files from, through Beam. " +
                "They can't change or delete anything here, and see nothing else on this PC: no hidden files, nothing starting " +
                "with \".\", no shortcuts to other folders. Each copy shows a notice here.", Ui.Font, true, Ui.S(14));
            var devices = app.Devices.Where(x => x.Id != app.Me && !x.Temporary).OrderBy(x => x.Name, StringComparer.CurrentCultureIgnoreCase).ToList();
            if (shares.Count == 0) AddLabel("Nothing is shared yet: Add a folder… below.", Ui.Font, false, Ui.S(8));
            foreach (var f in shares.ToList())
            {
                Section(f.Name.ToUpperInvariant());
                AddLabel(f.Path, Ui.Small, true, Ui.S(6));
                var list = new List<KeyValuePair<string, FlatCheck>>();
                foreach (var dev in devices) list.Add(new KeyValuePair<string, FlatCheck>(dev.Id, AddCheck(dev.Name, null, f.Devices.Contains(dev.Id), 0, Ui.S(4))));
                if (devices.Count == 0) AddLabel("No other devices yet.", Ui.Font, true, Ui.S(6));
                checks[f.Id] = list;
                var remove = new FlatButton("Stop sharing " + f.Name, null);
                remove.DangerStyle = true;
                remove.BackColor = Theme.Bg;
                remove.Size = new Size(Math.Max(Ui.S(96), remove.Preferred().Width), Ui.S(32));
                remove.SetBounds(X0, Y + Ui.S(4), remove.Width, remove.Height);
                var gone = f;
                remove.Click += (s, e) => { Collect(); shares.Remove(gone); Render(); };
                body.Controls.Add(remove);
                Y += remove.Height + Ui.S(12);
            }
            int contentH = Y + Ui.S(8), footerH = (int)footer.Tag;
            int max = Screen.FromPoint(Cursor.Position).WorkingArea.Height - Ui.S(80);
            int h = Math.Min(Math.Max(contentH, Ui.S(240)) + footerH, max);
            ClientSize = new Size(ClientSize.Width, h);
            footer.SetBounds(0, h - footerH, ClientSize.Width, footerH);
            body.SetBounds(0, 0, ClientSize.Width, h - footerH);
            body.ResumeLayout();
        }

        void AddFolder()
        {
            using (var pick = new FolderBrowserDialog())
            {
                pick.Description = "A folder your other devices may copy files from";
                pick.ShowNewFolderButton = false;
                if (pick.ShowDialog(this) != DialogResult.OK) return;
                string path = pick.SelectedPath;
                string why = Shares.Refusal(path, app.Cfg);
                if (why != null) { MessageBox.Show(this, "That folder can't be shared: " + why + ".", "Shared folders", MessageBoxButtons.OK, MessageBoxIcon.Information); return; }
                string full = Path.GetFullPath(path).TrimEnd('\\');
                if (shares.Any(f => Path.GetFullPath(f.Path).TrimEnd('\\').Equals(full, StringComparison.OrdinalIgnoreCase))) return;
                Collect();
                var added = new SharedFolder();
                added.Id = Shares.NewId(shares);
                added.Path = full;
                added.Name = Shares.DefaultName(full);
                shares.Add(added);
                Render();
            }
        }

        // (tests) What it shows; the window as drawn, into a PNG; Save.
        public string Describe()
        {
            Collect();
            return shares.Count + " folder(s): " + string.Join("; ", shares.Select(f => f.Name + " with " + f.Devices.Count + " device(s)"));
        }

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
            Collect();
            app.SetSharedFolders(shares, "the test");
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
