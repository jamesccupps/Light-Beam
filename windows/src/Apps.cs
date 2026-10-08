// Apps on every PC (Beam 1.21 + this app 1.16): the user's apps, installed here when one of their devices asks (the
// Apps page: Install on all PCs; the user: "i want to be able to easily install it on all my beam devices"). For this
// Windows user only; Beam never raises itself to administrator (an installer that needs that gets Windows' own prompt
// here); and only once someone at this PC has allowed it: the first request asks (Install / Always allow / Not now: the
// user's choice, "Allow once per PC"). The file comes from the server and must have the SHA-256 it lists (for an app
// from GitHub, the server checked the release's own); a winget app is installed by winget. What Beam installed is kept
// in the config (installedApps) and told to the server at each connect.
//   exe    %LOCALAPPDATA%\Programs\<name>\<file> (a running copy is renamed aside first), a Start menu shortcut, an
//          entry in Windows' Installed apps (its Uninstall asks Beam: --remove-app)
//   zip    unpacked there (nothing outside it); the shortcut to its program: `run`, else its only .exe, else the one
//          named like the app
//   msi    msiexec /i … /passive (for this user where the package allows it); removed by its product code
//   setup  an .exe named like an installer, or one given switches (`args`): run with them; Windows removes it
//   winget winget install --id … --scope user (else as the package wants) --silent
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Beam
{
    // What Beam installed on this PC (config `installedApps`).
    class InstalledApp
    {
        public string Id, Name, Kind, Version, Sha256, Dir, Exe, Shortcut, UninstallKey, ProductCode, Winget;

        public Dictionary<string, object> ToJson()
        {
            var d = new Dictionary<string, object>();
            d["id"] = Id; d["name"] = Name; d["kind"] = Kind; d["version"] = Version; d["sha256"] = Sha256;
            d["dir"] = Dir; d["exe"] = Exe; d["shortcut"] = Shortcut; d["uninstallKey"] = UninstallKey;
            d["productCode"] = ProductCode; d["winget"] = Winget;
            return d;
        }

        public static InstalledApp From(object o)
        {
            var d = Json.Obj(o);
            if (d == null) return null;
            var a = new InstalledApp();
            a.Id = Json.Str(d, "id"); a.Name = Json.Str(d, "name"); a.Kind = Json.Str(d, "kind"); a.Version = Json.Str(d, "version");
            a.Sha256 = Json.Str(d, "sha256"); a.Dir = Json.Str(d, "dir"); a.Exe = Json.Str(d, "exe"); a.Shortcut = Json.Str(d, "shortcut");
            a.UninstallKey = Json.Str(d, "uninstallKey"); a.ProductCode = Json.Str(d, "productCode"); a.Winget = Json.Str(d, "winget");
            return a.Id != null && a.Kind != null ? a : null;
        }
    }

    // A request waiting for someone at this PC.
    class AppAsk
    {
        public string Id, Name, Version, By, Source;
        public DateTime At = DateTime.Now;
    }

    class AppInstaller
    {
        public const string OnlyHere = "Beam installs apps here only once someone at this PC allows it: Beam's tray menu (Let Beam install apps) or the question it asks";
        const string UninstallRoot = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\";
        readonly App app;
        readonly HashSet<string> busy = new HashSet<string>();
        public readonly List<AppAsk> Asks = new List<AppAsk>();
        AppAskForm askForm;

        public AppInstaller(App app)
        {
            this.app = app;
            CleanLeftovers();
        }

        Config Cfg { get { return app.Cfg; } }

        // Where apps go: %LOCALAPPDATA%\Programs (a test instance: its own folder).
        string ProgramsFolder
        {
            get { return Cfg.CustomPath ? Path.Combine(Cfg.Dir, "Programs") : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs"); }
        }

        string DownloadFolder
        {
            get { return Cfg.CustomPath ? Path.Combine(Cfg.Dir, "app-downloads") : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Beam", "app-downloads"); }
        }

        // ------------------------------------------------------------------ requests from the server

        // `app-install { id, by?, update? }`.
        public async void OnInstall(Dictionary<string, object> d)
        {
            string id = Json.Str(d, "id");
            if (!ValidId(id) || app.Api == null || busy.Contains(id)) return;
            Dictionary<string, object> info;
            try { info = await Catalog(id); }
            catch (Exception ex) { Log.Write("Apps: couldn't read Beam's apps (" + Api.Describe(ex) + ")"); return; }
            if (info == null) { Log.Write("Apps: asked to install an app Beam doesn't have any more"); return; }
            string name = Json.Str(info, "name") ?? "an app";
            string by = ByName(Json.Str(d, "by"));
            var have = Cfg.InstalledApps.FirstOrDefault(a => a.Id == id);
            // Already here at that version (an app that updates itself, like Slate, got there first): only say so.
            if (have != null && Present(have) && Same(have, info))
            {
                Log.Write("Apps: " + name + " " + (have.Version ?? "") + " is here already");
                await Report(id, "installed", have.Version, null);
                return;
            }
            if (!Cfg.AppsAllowed)
            {
                Ask(id, info, by);
                return;
            }
            await Install(id, info, by);
        }

        // `app-uninstall { id }`.
        public void OnUninstall(Dictionary<string, object> d)
        {
            if (app.Api != null) Remove(Json.Str(d, "id"), "another of your devices");
        }

        // Windows' Installed apps → Uninstall (Beam.exe --remove-app <id>): removed here at once; the server hears it now,
        // or from the list sent at the next connect.
        public void RemoveFromWindows(string id)
        {
            Remove(id, null);
        }

        async void Remove(string id, string askedFrom)
        {
            if (!ValidId(id) || busy.Contains(id)) return;
            busy.Add(id);
            string state = "removed", version = null, why = null;
            try
            {
                var a = Cfg.InstalledApps.FirstOrDefault(x => x.Id == id);
                if (a != null) // (else not Beam's, or gone already)
                {
                    why = await Task.Run(() => RemoveFiles(a));
                    if (why == null && a.Kind == "msi" && a.ProductCode != null) why = await RunMsi("/x " + a.ProductCode + " /passive /norestart", a.Name);
                    if (why == null && a.Kind == "winget") why = await RunWinget("uninstall --id " + a.Winget + " --exact --silent --disable-interactivity --accept-source-agreements", a.Name, false);
                    if (why == null && a.Kind == "setup") why = "Beam ran its setup program: uninstall it from Windows' Settings → Apps → Installed apps";
                    if (why != null)
                    {
                        Log.Write("Apps: couldn't uninstall " + a.Name + ": " + why);
                        state = "failed";
                        version = a.Version;
                    }
                    else
                    {
                        Forget(a);
                        Log.Write("Apps: " + a.Name + " uninstalled" + (askedFrom != null ? "" : " (from Windows' Installed apps)"));
                        if (askedFrom != null) app.Notify(a.Name + " uninstalled", "Beam removed " + a.Name + " from this PC, as asked from " + askedFrom + ".");
                    }
                }
            }
            catch (Exception ex)
            {
                Log.Error("Apps: uninstalling", ex);
                state = "failed";
                why = ex.Message;
            }
            finally { busy.Remove(id); }
            await Report(id, state, version, why);
        }

        // After each connect: what Beam installed and is still here, at the version it is now (Slate updates itself).
        public async Task ReportInstalled()
        {
            if (app.Api == null || !app.ServerHas("apps")) return;
            var list = new List<object>();
            bool changed = false;
            foreach (var a in Cfg.InstalledApps.ToList())
            {
                if (!Present(a)) { Cfg.InstalledApps.Remove(a); changed = true; Log.Write("Apps: " + a.Name + " isn't on this PC any more"); continue; }
                string v = VersionOf(a) ?? a.Version;
                if (v != a.Version) { a.Version = v; changed = true; }
                var o = new Dictionary<string, object>();
                o["id"] = a.Id;
                o["version"] = v;
                list.Add(o);
            }
            if (changed) Cfg.Save();
            var body = new Dictionary<string, object>();
            body["apps"] = list.ToArray();
            try { await app.Api.Call(HttpMethod.Put, "/api/devices/me/apps", body, 30, CancellationToken.None); }
            catch (Exception ex) { Log.Write("Apps: couldn't tell the server what's installed (" + Api.Describe(ex) + ")"); }
        }

        // ------------------------------------------------------------------ asking someone at this PC

        void Ask(string id, Dictionary<string, object> info, string by)
        {
            string name = Json.Str(info, "name") ?? "an app";
            bool again = Asks.Any(x => x.Id == id); // (asked again, as after a reconnect: the same question, no new window)
            Asks.RemoveAll(x => x.Id == id);
            var ask = new AppAsk();
            ask.Id = id;
            ask.Name = name;
            ask.Version = Json.Str(info, "version");
            ask.By = by;
            ask.Source = SourceText(info);
            Asks.Add(ask);
            Log.Write("Apps: asks whoever is here before installing " + name + (by != null ? " (asked by " + by + ")" : ""));
            var ignored = Report(id, "asked", null, null);
            app.AppsChanged();
            // (1.16.1) The question opens by itself, near the clock and on top: a notification and the tray menu were easy
            // to miss (the user: "thats not a very good place to put notifications"). One at a time, the next once it's
            // answered; Beam's window shows what's waiting too (its bar).
            if (!again) ShowNext();
        }

        // The question for one app, brought up from the tray menu, Beam's window or its Apps page.
        public void ShowAsk(string id)
        {
            ShowAsk(id, true);
        }

        // asked: someone asked for it (it takes the focus); else it came by itself: on top without taking the keyboard,
        // its buttons awake after a moment (a click meant for something else can't answer it).
        void ShowAsk(string id, bool asked)
        {
            var ask = Asks.FirstOrDefault(x => x.Id == id);
            if (ask == null) return;
            if (askForm != null && !askForm.IsDisposed)
            {
                if (askForm.AskId == id) { if (asked) askForm.BringUp(); return; }
                if (!asked) return; // (the next once this one is answered)
                askForm.Close();
            }
            var form = new AppAskForm(this, ask, Environment.UserName, !asked);
            form.FormClosed += (s, e) =>
            {
                if (askForm == form) askForm = null;
                if (form.Answered) app.Post(ShowNext);
            };
            askForm = form;
            Log.Write("Apps: the question about " + ask.Name + " is on the screen" + (asked ? "" : " (by itself)"));
            form.ShowNearTray();
        }

        // The oldest question still waiting, by itself, when none is open (none once Beam may install without asking).
        void ShowNext()
        {
            if (Cfg.AppsAllowed || (askForm != null && !askForm.IsDisposed)) return;
            var next = Asks.OrderBy(x => x.At).FirstOrDefault();
            if (next != null) ShowAsk(next.Id, false);
        }

        // The answer at this PC: "install" (this once), "always" (and every request from now on), "notnow".
        public async void Answer(string id, string choice)
        {
            var ask = Asks.FirstOrDefault(x => x.Id == id);
            if (ask == null) return;
            Asks.Remove(ask);
            // (answered elsewhere, as Not now in Beam's window: its question goes too)
            if (askForm != null && !askForm.IsDisposed && askForm.AskId == id && !askForm.Answered) { askForm.Answered = true; askForm.Close(); }
            app.AppsChanged();
            if (choice == "notnow")
            {
                Log.Write("Apps: not now for " + ask.Name + " (the choice at this PC)");
                await Report(id, "declined", null, null);
                return;
            }
            if (choice == "always") SetAllowed(true, "the question on this PC");
            Dictionary<string, object> info = null;
            string unread = null;
            try { info = await Catalog(id); }
            catch (Exception ex) { unread = "couldn't read Beam's apps: " + Api.Describe(ex); }
            if (unread != null) { await Report(id, "failed", null, unread); return; }
            if (info == null) return;
            await Install(id, info, ask.By);
            // (Always allow: the others waiting go too)
            if (choice == "always") foreach (var other in Asks.ToList()) Answer(other.Id, "install");
        }

        public void SetAllowed(bool on, string from)
        {
            if (Cfg.AppsAllowed == on) return;
            Cfg.AppsAllowed = on;
            Cfg.Save();
            Log.Write("Apps: " + (on ? "Beam may install apps on this PC without asking" : "Beam asks before installing apps on this PC") + " (" + from + ")");
            app.AppsChanged();
        }

        // The tray's "Let Beam install apps": on through a confirmation, off at once.
        public void Toggle(string from)
        {
            if (Cfg.AppsAllowed) { SetAllowed(false, from); return; }
            var r = MessageBox.Show("Let Beam install apps on this PC without asking?\n\nApps you install from Beam's Apps page on another of your devices then go onto this PC for " +
                Environment.UserName + " at once (each one shows a notice). Beam never installs as administrator: an installer that needs that asks here.",
                "Beam", MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
            if (r == DialogResult.OK) SetAllowed(true, from);
        }

        // ------------------------------------------------------------------ installing

        async Task Install(string id, Dictionary<string, object> info, string by)
        {
            if (busy.Contains(id)) return;
            busy.Add(id);
            string name = Json.Str(info, "name") ?? "an app";
            string kind = Json.Str(info, "kind");
            string version = Json.Str(info, "version");
            string why = null;
            InstalledApp done = null;
            try
            {
                await Report(id, "installing", null, null);
                Log.Write("Apps: installing " + name + (version != null ? " " + version : "") + (by != null ? " (asked by " + by + ")" : ""));
                if (kind == "winget") done = await InstallWinget(id, info);
                else done = await InstallFile(id, info);
                done.Version = VersionOf(done) ?? version;
                Cfg.InstalledApps.RemoveAll(x => x.Id == id);
                Cfg.InstalledApps.Add(done);
                Cfg.Save();
                Log.Write("Apps: " + name + " " + (done.Version ?? "") + " installed" + (done.Dir != null ? " in " + done.Dir : ""));
                app.Notify(name + " installed", name + (done.Version != null ? " " + done.Version : "") + " is on this PC now" + (by != null ? ", as asked from " + by : "") +
                    (done.Shortcut != null ? ". It's in the Start menu." : "."));
            }
            catch (Exception ex)
            {
                why = ex is IOException || ex is InvalidDataException || ex is UnauthorizedAccessException || ex is InvalidOperationException ? ex.Message : Api.Describe(ex);
                Log.Write("Apps: couldn't install " + name + ": " + why);
                app.Notify("Couldn't install " + name, why);
            }
            finally { busy.Remove(id); }
            if (why != null) await Report(id, "failed", null, why);
            else await Report(id, "installed", done.Version, null);
        }

        async Task<InstalledApp> InstallFile(string id, Dictionary<string, object> info)
        {
            string name = Json.Str(info, "name") ?? "App";
            var file = Json.Obj(Json.Get(info, "file"));
            if (file == null) throw new InvalidDataException(name + " has no file on the server yet");
            string fileName = SafeName(Json.Str(file, "name"));
            string type = Json.Str(file, "type");
            string sha = Json.Str(file, "sha256");
            long size = Json.Long(file, "size", -1);
            if (string.IsNullOrEmpty(fileName) || sha == null || sha.Length != 64) throw new InvalidDataException(name + "'s file isn't described properly");
            string got = await Download(id, fileName, sha, size);
            try
            {
                string args = Json.Str(info, "args");
                var a = new InstalledApp();
                a.Id = id;
                a.Name = name;
                a.Sha256 = sha;
                if (type == "msi")
                {
                    a.Kind = "msi";
                    a.ProductCode = MsiProductCode(got);
                    string why = await RunMsi("/i \"" + got + "\" /passive /norestart ALLUSERS=2 MSIINSTALLPERUSER=1" + (string.IsNullOrEmpty(args) ? "" : " " + args), name);
                    if (why != null) throw new InvalidOperationException(why);
                    return a;
                }
                if (type == "exe" && (!string.IsNullOrEmpty(args) || IsSetupName(fileName)))
                {
                    a.Kind = "setup";
                    string why = await RunSetup(got, args, name);
                    if (why != null) throw new InvalidOperationException(why);
                    return a;
                }
                string dir = Path.Combine(ProgramsFolder, FolderName(name));
                Directory.CreateDirectory(dir);
                a.Dir = dir;
                if (type == "zip")
                {
                    a.Kind = "zip";
                    await Task.Run(() => Unzip(got, dir));
                    a.Exe = ZipProgram(dir, Json.Str(info, "run"), name);
                }
                else
                {
                    a.Kind = "exe";
                    a.Exe = Path.Combine(dir, fileName);
                    PutInPlace(got, a.Exe);
                }
                if (a.Exe != null)
                {
                    a.Shortcut = Path.Combine(Cfg.StartMenuFolder, FolderName(name) + ".lnk");
                    try { Shortcut.Create(a.Shortcut, a.Exe, "", name); }
                    catch (Exception ex) { Log.Write("Apps: no Start menu shortcut for " + name + " (" + ex.Message + ")"); a.Shortcut = null; }
                }
                a.UninstallKey = Register(a, Json.Str(info, "version"));
                return a;
            }
            finally { FileUtil.TryDelete(got); }
        }

        async Task<InstalledApp> InstallWinget(string id, Dictionary<string, object> info)
        {
            string name = Json.Str(info, "name") ?? "App";
            string pkg = Json.Str(info, "source");
            if (pkg == null || !System.Text.RegularExpressions.Regex.IsMatch(pkg, @"^[A-Za-z0-9][A-Za-z0-9+_-]*(\.[A-Za-z0-9+_-]+)+$")) throw new InvalidDataException(name + " has no winget id Beam can use");
            const string common = " --exact --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity";
            // For this user first; a package with only a machine-wide installer is installed as it wants (Windows asks
            // here for administrator rights if it needs them).
            string why = await RunWinget("install --id " + pkg + common + " --scope user", name, true);
            if (why == NoUserScope) why = await RunWinget("install --id " + pkg + common, name, true);
            if (why != null) throw new InvalidOperationException(why);
            var a = new InstalledApp();
            a.Id = id;
            a.Name = name;
            a.Kind = "winget";
            a.Winget = pkg;
            return a;
        }

        // ------------------------------------------------------------------ the parts

        async Task<Dictionary<string, object>> Catalog(string id)
        {
            var d = Json.Obj(await app.Api.Call(HttpMethod.Get, "/api/apps", null, 30, CancellationToken.None));
            var list = Json.Get(d, "apps") as object[];
            if (list == null) return null;
            foreach (var o in list)
            {
                var a = Json.Obj(o);
                if (a != null && Json.Str(a, "id") == id) return a;
            }
            return null;
        }

        // GET /api/apps/{id}/file into the download folder, checked: exactly `size` bytes with that SHA-256. 60 s without
        // data or 30 minutes in all end it.
        async Task<string> Download(string id, string fileName, string sha, long size)
        {
            Directory.CreateDirectory(DownloadFolder);
            string final = Path.Combine(DownloadFolder, id + "-" + fileName);
            string part = final + ".part";
            string hex;
            using (var total = new CancellationTokenSource(TimeSpan.FromMinutes(30)))
            {
                var ct = total.Token;
                var idle = Stopwatch.StartNew();
                using (var watchdog = new System.Threading.Timer(_ => { if (idle.Elapsed.TotalSeconds > 60) { try { total.Cancel(); } catch { } } }, null, 5000, 5000))
                using (var req = app.Api.Request(HttpMethod.Get, "/api/apps/" + id + "/file"))
                using (var resp = await app.Api.Send(req, 60, ct, HttpCompletionOption.ResponseHeadersRead))
                {
                    if (!resp.IsSuccessStatusCode) throw await Api.ErrorFrom(resp);
                    using (ct.Register(() => { try { resp.Dispose(); } catch { } }))
                    using (var hash = SHA256.Create())
                    using (var input = await resp.Content.ReadAsStreamAsync())
                    using (var output = new FileStream(part, FileMode.Create, FileAccess.Write, FileShare.None))
                    {
                        var buf = new byte[1 << 20];
                        int n;
                        try
                        {
                            while ((n = await input.ReadAsync(buf, 0, buf.Length, ct)) > 0)
                            {
                                idle.Restart();
                                hash.TransformBlock(buf, 0, n, null, 0);
                                await output.WriteAsync(buf, 0, n, ct);
                            }
                        }
                        catch (ObjectDisposedException) { throw new IOException("the download stalled"); }
                        catch (OperationCanceledException) { throw new IOException("the download stalled"); }
                        hash.TransformFinalBlock(new byte[0], 0, 0);
                        hex = BitConverter.ToString(hash.Hash).Replace("-", "").ToLowerInvariant();
                    }
                }
            }
            long got = new FileInfo(part).Length;
            if (!string.Equals(hex, sha, StringComparison.OrdinalIgnoreCase) || (size >= 0 && got != size))
            {
                FileUtil.TryDelete(part);
                throw new InvalidDataException("the download isn't the file Beam has (its SHA-256 or size differs)");
            }
            FileUtil.TryDelete(final);
            File.Move(part, final);
            return final;
        }

        // Into place, also while the old copy runs: Windows lets a running .exe be renamed, not overwritten.
        static void PutInPlace(string from, string to)
        {
            string tmp = to + ".beam-new";
            FileUtil.TryDelete(tmp);
            File.Copy(from, tmp);
            if (File.Exists(to))
            {
                string old = to + ".beam-old-" + Process.GetCurrentProcess().Id;
                FileUtil.TryDelete(old);
                File.Move(to, old);
                try { File.Move(tmp, to); }
                catch { try { File.Move(old, to); } catch { } throw; }
                FileUtil.TryDelete(old); // (stays while it runs; CleanLeftovers takes it later)
            }
            else File.Move(tmp, to);
        }

        // Every entry inside `dir` (a name that would land outside it, or a full path, is refused); files in use are
        // renamed aside first.
        static void Unzip(string zip, string dir)
        {
            string root = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
            using (var archive = ZipFile.OpenRead(zip))
            {
                foreach (var e in archive.Entries)
                {
                    string target = Path.GetFullPath(Path.Combine(root, e.FullName));
                    if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("the .zip has a file that would go outside its folder (" + e.FullName + ")");
                    if (e.FullName.EndsWith("/") || e.FullName.EndsWith("\\")) { Directory.CreateDirectory(target); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    string tmp = target + ".beam-new";
                    e.ExtractToFile(tmp, true);
                    if (File.Exists(target))
                    {
                        string old = target + ".beam-old-" + Process.GetCurrentProcess().Id;
                        FileUtil.TryDelete(old);
                        try { File.Delete(target); } catch { File.Move(target, old); }
                    }
                    File.Move(tmp, target);
                }
            }
        }

        // The program a .zip's shortcut starts: the one named (`run`), else its only .exe, else the one named like the app.
        static string ZipProgram(string dir, string run, string name)
        {
            if (!string.IsNullOrEmpty(run))
            {
                string p = Path.GetFullPath(Path.Combine(dir, run.Replace('/', '\\')));
                if (p.StartsWith(Path.GetFullPath(dir), StringComparison.OrdinalIgnoreCase) && File.Exists(p)) return p;
            }
            var exes = Directory.GetFiles(dir, "*.exe", SearchOption.AllDirectories).Where(f => f.IndexOf(".beam-", StringComparison.OrdinalIgnoreCase) < 0).ToList();
            if (exes.Count == 1) return exes[0];
            string want = FolderName(name).Replace(" ", "").ToLowerInvariant();
            return exes.FirstOrDefault(f => Path.GetFileNameWithoutExtension(f).Replace(" ", "").ToLowerInvariant() == want);
        }

        // Windows' Installed apps lists it, and its Uninstall asks Beam (never for a test instance: nothing in the registry).
        string Register(InstalledApp a, string version)
        {
            if (Cfg.CustomPath) return null;
            string key = UninstallRoot + "BeamApp-" + a.Id;
            try
            {
                using (var k = Registry.CurrentUser.CreateSubKey(key))
                {
                    k.SetValue("DisplayName", a.Name);
                    k.SetValue("DisplayVersion", VersionOf(a) ?? version ?? "");
                    k.SetValue("Publisher", "Installed by Beam");
                    k.SetValue("InstallLocation", a.Dir ?? "");
                    if (a.Exe != null) k.SetValue("DisplayIcon", a.Exe);
                    k.SetValue("UninstallString", "\"" + Application.ExecutablePath + "\" --remove-app " + a.Id);
                    k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                    long bytes = 0;
                    try { bytes = Directory.GetFiles(a.Dir, "*", SearchOption.AllDirectories).Sum(f => new FileInfo(f).Length); } catch { }
                    k.SetValue("EstimatedSize", (int)Math.Min(int.MaxValue, bytes / 1024), RegistryValueKind.DWord);
                }
                return key;
            }
            catch (Exception ex) { Log.Write("Apps: not listed in Installed apps (" + ex.Message + ")"); return null; }
        }

        // What Beam put here goes (the folder, the shortcut, the Installed apps entry). null, or why it couldn't.
        string RemoveFiles(InstalledApp a)
        {
            if (a.Dir != null && Directory.Exists(a.Dir))
            {
                try { Directory.Delete(a.Dir, true); }
                catch (Exception ex) { return a.Name + " is in use on this PC (close it, then uninstall again): " + ex.Message; }
            }
            if (a.Shortcut != null) FileUtil.TryDelete(a.Shortcut);
            if (a.UninstallKey != null && a.UninstallKey.StartsWith(UninstallRoot + "BeamApp-", StringComparison.Ordinal))
            {
                try { Registry.CurrentUser.DeleteSubKeyTree(a.UninstallKey, false); } catch { }
            }
            return null;
        }

        void Forget(InstalledApp a)
        {
            Cfg.InstalledApps.RemoveAll(x => x.Id == a.Id);
            Cfg.Save();
        }

        // msiexec with Windows' own prompt if the package needs administrator rights. null, or why it failed.
        async Task<string> RunMsi(string args, string name)
        {
            int code = await Run("msiexec.exe", args, true, TimeSpan.FromMinutes(30));
            if (code == 0 || code == 3010 || code == 1641) return null; // (3010, 1641: done, a restart finishes it)
            if (code == 1602) return "cancelled at this PC";
            if (code == 1605) return null; // (not installed: nothing to remove)
            if (code == -2) return "the installer didn't finish within 30 minutes";
            return "Windows Installer answered " + code;
        }

        async Task<string> RunSetup(string exe, string args, string name)
        {
            int code = await Run(exe, args ?? "", true, TimeSpan.FromMinutes(30));
            if (code == 0 || code == 3010) return null;
            if (code == -2) return "its setup program didn't finish within 30 minutes";
            if (code == 1223) return "cancelled at this PC (Windows asked for administrator rights)";
            return "its setup program answered " + code;
        }

        const string NoUserScope = "(no installer for one user)";

        // winget, hidden; its own words when it fails. null, or why; NoUserScope when it has no installer for --scope user.
        async Task<string> RunWinget(string args, string name, bool install)
        {
            string exe = Cfg.TestWinget;
            if (string.IsNullOrEmpty(exe))
            {
                exe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\WindowsApps\winget.exe");
                if (!File.Exists(exe)) return "winget isn't on this PC (Windows' App Installer adds it; Windows Server doesn't have it)";
            }
            var output = new StringBuilder();
            int code = await Run(exe, args, false, TimeSpan.FromMinutes(30), output);
            Log.Write("Apps: winget " + args.Split(' ')[0] + " " + name + " answered " + code);
            if (code == 0) return null;
            string text = output.ToString();
            if (code == unchecked((int)0x8A150010) || text.IndexOf("No applicable installer", StringComparison.OrdinalIgnoreCase) >= 0) return NoUserScope;
            if (install && (code == unchecked((int)0x8A15002B) || text.IndexOf("already installed", StringComparison.OrdinalIgnoreCase) >= 0)) return null;
            if (!install && (code == unchecked((int)0x8A150014) || text.IndexOf("No installed package", StringComparison.OrdinalIgnoreCase) >= 0)) return null;
            if (code == -2) return "winget didn't finish within 30 minutes";
            string last = text.Split('\n').Select(l => l.Trim()).Where(l => l.Length > 3 && l.Any(char.IsLetter)).LastOrDefault();
            return "winget answered 0x" + code.ToString("X8") + (last != null ? ": " + (last.Length > 160 ? last.Substring(0, 160) : last) : "");
        }

        // A process, waited for (-2: still running when the time ran out). shell: through the shell, so Windows can ask
        // for administrator rights itself (never asked for by Beam).
        static Task<int> Run(string exe, string args, bool shell, TimeSpan limit, StringBuilder output = null)
        {
            var done = new TaskCompletionSource<int>();
            var psi = new ProcessStartInfo();
            if (exe.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase) || exe.EndsWith(".bat", StringComparison.OrdinalIgnoreCase))
            {
                psi.FileName = Path.Combine(Environment.SystemDirectory, "cmd.exe");
                psi.Arguments = "/d /c \"\"" + exe + "\" " + args + "\"";
            }
            else
            {
                psi.FileName = exe;
                psi.Arguments = args;
            }
            psi.UseShellExecute = shell;
            if (!shell)
            {
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = output != null;
                psi.RedirectStandardError = output != null;
                if (output != null) { psi.StandardOutputEncoding = Encoding.UTF8; psi.StandardErrorEncoding = Encoding.UTF8; }
            }
            Process p;
            try { p = Process.Start(psi); }
            catch (System.ComponentModel.Win32Exception ex) { return Task.FromResult(ex.NativeErrorCode == 1223 ? 1223 : -1); }
            if (p == null) return Task.FromResult(-1);
            if (output != null && !shell)
            {
                p.OutputDataReceived += (s, e) => { if (e.Data != null) lock (output) output.AppendLine(e.Data); };
                p.ErrorDataReceived += (s, e) => { if (e.Data != null) lock (output) output.AppendLine(e.Data); };
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
            }
            Task.Run(() =>
            {
                try
                {
                    if (p.WaitForExit((int)limit.TotalMilliseconds)) { p.WaitForExit(); done.TrySetResult(p.ExitCode); }
                    else done.TrySetResult(-2);
                }
                catch { done.TrySetResult(-1); }
                finally { p.Dispose(); }
            });
            return done.Task;
        }

        // An .msi's ProductCode (to remove it later), through Windows Installer's own reader.
        static string MsiProductCode(string msi)
        {
            try
            {
                Type t = Type.GetTypeFromProgID("WindowsInstaller.Installer");
                object installer = Activator.CreateInstance(t);
                object db = t.InvokeMember("OpenDatabase", System.Reflection.BindingFlags.InvokeMethod, null, installer, new object[] { msi, 0 });
                object view = db.GetType().InvokeMember("OpenView", System.Reflection.BindingFlags.InvokeMethod, null, db, new object[] { "SELECT `Value` FROM `Property` WHERE `Property`='ProductCode'" });
                view.GetType().InvokeMember("Execute", System.Reflection.BindingFlags.InvokeMethod, null, view, null);
                object rec = view.GetType().InvokeMember("Fetch", System.Reflection.BindingFlags.InvokeMethod, null, view, null);
                string code = rec != null ? (string)rec.GetType().InvokeMember("StringData", System.Reflection.BindingFlags.GetProperty, null, rec, new object[] { 1 }) : null;
                view.GetType().InvokeMember("Close", System.Reflection.BindingFlags.InvokeMethod, null, view, null);
                return code != null && System.Text.RegularExpressions.Regex.IsMatch(code, @"^\{[0-9A-Fa-f-]{36}\}$") ? code : null;
            }
            catch { return null; }
        }

        async Task Report(string id, string state, string version, string error)
        {
            if (app.Api == null) return;
            var body = new Dictionary<string, object>();
            body["id"] = id;
            body["state"] = state;
            if (version != null) body["version"] = version;
            if (error != null) body["error"] = error.Length > 300 ? error.Substring(0, 300) : error;
            try { await app.Api.Call(HttpMethod.Post, "/api/devices/me/apps", body, 30, CancellationToken.None); }
            catch (Exception ex) { Log.Write("Apps: couldn't tell the server (" + Api.Describe(ex) + ")"); }
        }

        // ------------------------------------------------------------------ small things

        // The version on the disk (Slate updates itself): the program's own, else what Beam installed.
        static string VersionOf(InstalledApp a)
        {
            if (a.Exe == null || !File.Exists(a.Exe)) return null;
            try
            {
                var v = FileVersionInfo.GetVersionInfo(a.Exe);
                string s = (v.ProductVersion ?? v.FileVersion ?? "").Trim();
                int plus = s.IndexOfAny(new[] { '+', ' ' });
                if (plus > 0) s = s.Substring(0, plus);
                // (1.2.3.0 → 1.2.3)
                while (s.EndsWith(".0") && s.Count(c => c == '.') > 2) s = s.Substring(0, s.Length - 2);
                return s.Length > 0 && char.IsDigit(s[0]) ? (s.Length > 40 ? s.Substring(0, 40) : s) : null;
            }
            catch { return null; }
        }

        // Still here: its program (or folder); a package's own installer keeps no record Beam can check.
        static bool Present(InstalledApp a)
        {
            if (a.Kind == "exe" || a.Kind == "zip") return a.Exe != null ? File.Exists(a.Exe) : a.Dir != null && Directory.Exists(a.Dir);
            return true;
        }

        // Nothing to do: the file Beam installed is the server's, or the program is that file now; or, for an app from
        // GitHub (its version is the release's), the program here is already at that version or newer (Slate updates
        // itself). A file app's version is only a label, so only its file counts.
        static bool Same(InstalledApp a, Dictionary<string, object> info)
        {
            var file = Json.Obj(Json.Get(info, "file"));
            string sha = file != null ? Json.Str(file, "sha256") : null;
            if (sha != null && string.Equals(a.Sha256, sha, StringComparison.OrdinalIgnoreCase)) return true;
            if (a.Kind == "exe" && sha != null && a.Exe != null && File.Exists(a.Exe) && string.Equals(Sha256Of(a.Exe), sha, StringComparison.OrdinalIgnoreCase)) return true;
            if (Json.Str(info, "kind") != "github") return false;
            string want = Json.Str(info, "version");
            string have = VersionOf(a) ?? a.Version;
            return want != null && have != null && VersionAtLeast(have, want);
        }

        static bool VersionAtLeast(string have, string want)
        {
            Version h, w;
            if (Version.TryParse(Pad(have), out h) && Version.TryParse(Pad(want), out w)) return h >= w;
            return have == want;
        }

        static string Pad(string v)
        {
            v = (v ?? "").Trim();
            int dots = v.Count(c => c == '.');
            return dots == 0 ? v + ".0" : v;
        }

        static string Sha256Of(string path)
        {
            try
            {
                using (var s = SHA256.Create())
                using (var f = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                    return BitConverter.ToString(s.ComputeHash(f)).Replace("-", "").ToLowerInvariant();
            }
            catch { return null; }
        }

        // Older copies left by updates (renamed aside while running) and unfinished downloads.
        void CleanLeftovers()
        {
            try
            {
                foreach (var a in Cfg.InstalledApps)
                    if (a.Dir != null && Directory.Exists(a.Dir))
                        foreach (var f in Directory.GetFiles(a.Dir, "*.beam-*", SearchOption.AllDirectories)) FileUtil.TryDelete(f);
                if (Directory.Exists(DownloadFolder)) foreach (var f in Directory.GetFiles(DownloadFolder)) FileUtil.TryDelete(f);
            }
            catch { }
        }

        static bool ValidId(string id)
        {
            return id != null && id.Length == 8 && id.All(c => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'));
        }

        static bool IsSetupName(string name)
        {
            return name.IndexOf("setup", StringComparison.OrdinalIgnoreCase) >= 0 || name.IndexOf("install", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        // A file name as the server keeps it (letters, digits, spaces, . _ - ( ) +).
        static string SafeName(string name)
        {
            if (name == null) return null;
            var sb = new StringBuilder();
            foreach (char c in name) if (char.IsLetterOrDigit(c) && c < 128 || " ._-()+".IndexOf(c) >= 0) sb.Append(c);
            string s = sb.ToString().Trim(' ', '.');
            return s.Length == 0 || s.Length > 100 ? null : s;
        }

        // The folder (and shortcut) name: the app's name without anything Windows refuses.
        static string FolderName(string name)
        {
            var sb = new StringBuilder();
            var bad = Path.GetInvalidFileNameChars();
            foreach (char c in name ?? "") if (Array.IndexOf(bad, c) < 0) sb.Append(c);
            string s = sb.ToString().Trim(' ', '.');
            return s.Length == 0 ? "App" : s;
        }

        static string SourceText(Dictionary<string, object> info)
        {
            string kind = Json.Str(info, "kind"), src = Json.Str(info, "source");
            if (kind == "github") return "from GitHub, " + src;
            if (kind == "winget") return "from winget, " + src;
            var file = Json.Obj(Json.Get(info, "file"));
            return "a file sent to Beam" + (file != null ? " (" + Json.Str(file, "name") + ")" : "");
        }

        string ByName(string id)
        {
            if (id == null) return null;
            var d = app.Devices.FirstOrDefault(x => x.Id == id);
            return d != null ? d.Name : null;
        }

        // Tests (custom --config only): "answer:<id>:install|always|notnow", "allow:on|off", "state".
        public void TestCommand(string cmd)
        {
            string[] p = cmd.Split(':');
            if (p[0] == "answer" && p.Length == 3) Answer(p[1], p[2]);
            else if (p[0] == "allow" && p.Length == 2) SetAllowed(p[1] == "on", "a test");
            else if (p[0] == "state")
                Log.Write("Apps: (test) allowed " + Cfg.AppsAllowed + "; asking " + string.Join(",", Asks.Select(a => a.Id)) + "; installed " +
                    string.Join(",", Cfg.InstalledApps.Select(a => a.Id + "=" + a.Kind + "@" + (a.Version ?? "?"))));
        }
    }

    // "Install <app>?": the question at this PC (Install, Always allow, Not now). (1.16.1) Near the clock and on top, as a
    // sign-in request's; one that came by itself doesn't take the keyboard, and its buttons wake after a second.
    class AppAskForm : DialogBase
    {
        public readonly string AskId;
        public bool Answered;
        readonly bool automatic;
        readonly System.Windows.Forms.Timer arm = new System.Windows.Forms.Timer();

        public AppAskForm(AppInstaller apps, AppAsk ask, string user, bool automatic) : base("Install " + ask.Name + "?", 480)
        {
            AskId = ask.Id;
            this.automatic = automatic;
            TopMost = true;
            ShowInTaskbar = !Ui.TestOffscreen; // (a test's never shows anywhere)
            StartPosition = FormStartPosition.Manual;
            AddLabel("Install " + ask.Name + (ask.Version != null ? " " + ask.Version : "") + "?", Ui.Title, false, Ui.S(10));
            AddLabel((ask.By ?? "One of your devices") + " asks to install " + ask.Name + " on this PC, for " + user + " (" + ask.Source + ").", Ui.Font, true, Ui.S(10));
            AddLabel("Always allow: apps you install from Beam's Apps page then go onto this PC without asking, each with a notice. " +
                "You can turn that off in Beam's tray menu (Let Beam install apps). Beam never installs as administrator: an installer that needs that asks here.", Ui.Small, true, Ui.S(16));
            var install = Button("Install", true);
            var always = Button("Always allow", false);
            var later = Button("Not now", false);
            int y = Y;
            install.SetBounds(ClientSize.Width - Pad - install.Width, y, install.Width, install.Height);
            always.SetBounds(install.Left - Ui.S(10) - always.Width, y, always.Width, always.Height);
            later.SetBounds(Pad, y, later.Width, later.Height);
            // (closed with × or Esc: still waiting, in Beam's window and its tray menu)
            install.Click += (s, e) => Choose(apps, "install");
            always.Click += (s, e) => Choose(apps, "always");
            later.Click += (s, e) => Choose(apps, "notnow");
            ClientSize = new Size(ClientSize.Width, y + install.Height + Pad);
            if (automatic)
            {
                install.Enabled = always.Enabled = later.Enabled = false;
                arm.Interval = 1000;
                arm.Tick += (s, e) => { arm.Stop(); install.Enabled = always.Enabled = later.Enabled = true; };
            }
        }

        void Choose(AppInstaller apps, string choice)
        {
            if (Answered) return;
            Answered = true;
            apps.Answer(AskId, choice);
            Close();
        }

        // Bottom right, above the taskbar.
        public void ShowNearTray()
        {
            var wa = Screen.PrimaryScreen.WorkingArea;
            Location = new Point(Math.Max(wa.Left, wa.Right - Width - Ui.S(16)), Math.Max(wa.Top, wa.Bottom - Height - Ui.S(16)));
            Ui.PlaceForTest(this);
            Show();
            if (automatic) arm.Start(); else BringUp();
        }

        public void BringUp()
        {
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            if (Ui.TestOffscreen) return;
            Activate();
            Native.SetForegroundWindow(Handle);
        }

        protected override bool ShowWithoutActivation { get { return automatic || Ui.TestOffscreen; } }

        protected override void Dispose(bool disposing)
        {
            if (disposing) arm.Dispose();
            base.Dispose(disposing);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Escape) Close();
            base.OnKeyDown(e);
        }
    }
}
