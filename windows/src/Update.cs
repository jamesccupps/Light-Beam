// Self-update (docs/API.md, "App updates"). The newer Beam.exe the server offers is downloaded next to the
// installed exe as Beam.new.exe and its SHA-256 checked. Then the running exe is renamed to Beam.old.exe,
// the new one takes its name, and the old process hands over: it frees the single-instance lock, starts the new
// version and waits for it to report that it runs properly. If it doesn't (it crashed, antivirus killed it),
// the old version is put back, the bad version is remembered and skipped, and Beam keeps running.
// Health also tracks crash loops that start later: three unhealthy starts in a row roll back to Beam.old.exe.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Beam
{
    class UpdateInfo
    {
        public string Version;
        public string Url;
        public long Size;
        public string Sha256;
        public string Sig; // (1.7.3) the build's signature: UpdateSignature
    }

    // What the old version does after its UI has shut down (see Program.Main).
    class Handoff
    {
        public string Exe;
        public string NewVersion;
        public string OldVersion;
        public bool Show;
        public bool Family; // (1.10) Beam Family's window was open: the new version opens it again
    }

    static class Health
    {
        static string file;
        static string nonce;
        static bool marked;
        public static int BadStarts;

        public static string EventName(string n)
        {
            return "Local\\Beam-" + Program.InstanceId + "-ok-" + n;
        }

        // Called early at every start: counts starts that never became healthy and didn't exit cleanly.
        public static void Start(Config cfg, string healthNonce)
        {
            file = Path.Combine(cfg.Dir, "health.json");
            nonce = healthNonce;
            var d = Json.ParseObject(Read()) ?? new Dictionary<string, object>();
            string version = Json.Str(d, "version");
            int bad = (int)Json.Long(d, "badStarts", 0);
            bool running = Json.Bool(d, "running", false), healthy = Json.Bool(d, "healthy", false);
            if (version != AppVersion.Text) bad = 0;
            else if (running && !healthy) bad++;
            BadStarts = bad;
            Write(false, true, bad);
        }

        // Connected and caught up, or simply ran for a while without crashing.
        public static void MarkHealthy()
        {
            if (marked || file == null) return;
            marked = true;
            Write(true, true, 0);
            BadStarts = 0;
            if (nonce == null) return;
            try
            {
                EventWaitHandle ev;
                if (EventWaitHandle.TryOpenExisting(EventName(nonce), out ev)) using (ev) ev.Set();
                Log.Write("Update: reported healthy to the previous version");
            }
            catch (Exception ex) { Log.Error("Update: health signal", ex); }
        }

        public static void MarkCleanExit()
        {
            if (file == null) return;
            Write(marked, false, BadStarts);
        }

        static string Read()
        {
            try { return File.Exists(file) ? File.ReadAllText(file) : null; } catch { return null; }
        }

        static void Write(bool healthy, bool running, int bad)
        {
            try
            {
                var d = new Dictionary<string, object>();
                d["version"] = AppVersion.Text;
                d["healthy"] = healthy;
                d["running"] = running;
                d["badStarts"] = bad;
                Config.AtomicWrite(file, Json.Stringify(d));
            }
            catch (Exception ex) { Log.Error("health.json", ex); }
        }
    }

    static class Updater
    {
        public static Version Current
        {
            get { return Norm(typeof(Updater).Assembly.GetName().Version); }
        }

        static Version Norm(Version v)
        {
            return new Version(v.Major, v.Minor, Math.Max(0, v.Build), Math.Max(0, v.Revision));
        }

        public static bool TryParse(string s, out Version v)
        {
            v = null;
            Version parsed;
            if (string.IsNullOrEmpty(s) || !System.Version.TryParse(s.Trim().TrimStart('v', 'V'), out parsed)) return false;
            v = Norm(parsed);
            return true;
        }

        public static Version FileVersion(string exe)
        {
            try
            {
                Version v;
                return TryParse(FileVersionInfo.GetVersionInfo(exe).FileVersion, out v) ? v : null;
            }
            catch { return null; }
        }

        // The "windows" entry of GET /api/updates or the SSE app-update event.
        public static UpdateInfo FromUpdates(Dictionary<string, object> d)
        {
            var w = Json.Obj(Json.Get(d, "windows"));
            if (w == null) return null;
            var u = new UpdateInfo();
            u.Version = Json.Str(w, "version");
            u.Url = Json.Str(w, "url") ?? "/download/windows";
            u.Size = Json.Long(w, "size", 0);
            u.Sha256 = Json.Str(w, "sha256");
            u.Sig = Json.Str(w, "sig");
            return u.Version == null || string.IsNullOrEmpty(u.Sha256) ? null : u;
        }

        public static bool IsNewer(UpdateInfo u)
        {
            Version v;
            return u != null && TryParse(u.Version, out v) && v > Current;
        }

        public static string StagedPath(string exe) { return Path.Combine(Path.GetDirectoryName(exe), "Beam.new.exe"); }
        public static string BackupPath(string exe) { return Path.Combine(Path.GetDirectoryName(exe), "Beam.old.exe"); }

        // Can we write next to the running exe (e.g. %LOCALAPPDATA%\Programs\Beam)?
        public static bool CanReplace(string exe)
        {
            try
            {
                if ((File.GetAttributes(exe) & FileAttributes.ReadOnly) != 0) return false;
                string probe = Path.Combine(Path.GetDirectoryName(exe), ".beam-update-test-" + Guid.NewGuid().ToString("N"));
                File.WriteAllText(probe, "");
                File.Delete(probe);
                return true;
            }
            catch { return false; }
        }

        // Leftovers of earlier updates: staged downloads, rolled-back versions, 1.1.0's update folder.
        public static void CleanUp(string exe, Config cfg)
        {
            try
            {
                string dir = Path.GetDirectoryName(exe);
                foreach (var f in Directory.GetFiles(dir, "Beam.new.exe*")) FileUtil.TryDelete(f);
                foreach (var f in Directory.GetFiles(dir, "Beam.bad-*.exe")) FileUtil.TryDelete(f);
                foreach (var f in Directory.GetFiles(dir, ".beam-update-test-*")) FileUtil.TryDelete(f);
                if (Directory.Exists(cfg.LegacyUpdateFolder))
                    foreach (var f in Directory.GetFiles(cfg.LegacyUpdateFolder, "Beam-*")) FileUtil.TryDelete(f);
            }
            catch { }
        }

        // Downloads the update with the key into Beam.new.exe next to the exe and checks its SHA-256 and size.
        // Gives up after 60 s without data or 10 minutes in total.
        public static async Task<string> Download(Api api, UpdateInfo u, string exe, CancellationToken outer)
        {
            // (1.7.3) Signed with this Beam's key, before a byte is downloaded: the signature covers the version,
            // SHA-256 and size offered, and the download must then have exactly that SHA-256 and size.
            string refused = UpdateSignature.Check(u.Version, u.Sha256, u.Size, u.Sig);
            if (refused != null) throw new InvalidDataException(refused);
            string path = u.Url;
            Uri abs;
            if (Uri.TryCreate(path, UriKind.Absolute, out abs))
            {
                // Never send the key to another host.
                if (!Discovery.SameUrl(abs.GetLeftPart(UriPartial.Authority), api.Base)) throw new InvalidDataException("The update is offered from another server (" + abs.Host + ")");
                path = abs.PathAndQuery;
            }
            if (!path.StartsWith("/")) path = "/" + path;
            string final = StagedPath(exe);
            string part = final + ".part";
            string hex;
            using (var total = CancellationTokenSource.CreateLinkedTokenSource(outer))
            {
                total.CancelAfter(TimeSpan.FromMinutes(10));
                var ct = total.Token;
                var idle = Stopwatch.StartNew();
                using (var watchdog = new System.Threading.Timer(_ => { if (idle.Elapsed.TotalSeconds > 60) { try { total.Cancel(); } catch { } } }, null, 5000, 5000))
                using (var req = api.Request(HttpMethod.Get, path))
                using (var resp = await api.Send(req, 60, ct, HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false))
                {
                    if (!resp.IsSuccessStatusCode) throw await Api.ErrorFrom(resp).ConfigureAwait(false);
                    using (ct.Register(() => { try { resp.Dispose(); } catch { } }))
                    using (var sha = SHA256.Create())
                    using (var input = await resp.Content.ReadAsStreamAsync().ConfigureAwait(false))
                    using (var file = new FileStream(part, FileMode.Create, FileAccess.Write, FileShare.None))
                    {
                        var buf = new byte[81920];
                        int n;
                        try
                        {
                            while ((n = await input.ReadAsync(buf, 0, buf.Length, ct).ConfigureAwait(false)) > 0)
                            {
                                idle.Restart();
                                sha.TransformBlock(buf, 0, n, null, 0);
                                await file.WriteAsync(buf, 0, n, ct).ConfigureAwait(false);
                            }
                        }
                        catch (ObjectDisposedException) { throw new TimeoutException("The update download stalled"); }
                        catch (OperationCanceledException)
                        {
                            if (outer.IsCancellationRequested) throw;
                            throw new TimeoutException("The update download stalled");
                        }
                        sha.TransformFinalBlock(new byte[0], 0, 0);
                        hex = BitConverter.ToString(sha.Hash).Replace("-", "").ToLowerInvariant();
                    }
                }
            }
            if (!string.Equals(hex, u.Sha256.Trim(), StringComparison.OrdinalIgnoreCase))
            {
                FileUtil.TryDelete(part);
                throw new InvalidDataException("the download doesn't match its checksum (expected " + u.Sha256 + ", got " + hex + ")");
            }
            long got = new FileInfo(part).Length;
            if (u.Size > 0 && got != u.Size)
            {
                FileUtil.TryDelete(part);
                throw new InvalidDataException("the download isn't the size offered (" + got + " bytes, not " + u.Size + ")");
            }
            FileUtil.TryDelete(final);
            File.Move(part, final);
            Version staged = FileVersion(final);
            Version want;
            if (staged == null || !TryParse(u.Version, out want) || staged != want)
            {
                FileUtil.TryDelete(final);
                throw new InvalidDataException("the download isn't Beam " + u.Version);
            }
            return final;
        }

        // Beam.exe -> Beam.old.exe, Beam.new.exe -> Beam.exe (a running exe can be renamed, not overwritten).
        // Retries for 20 s (antivirus may hold the new file while it scans it) and undoes everything on failure.
        public static bool Swap(string exe, out string error)
        {
            error = null;
            string staged = StagedPath(exe), backup = BackupPath(exe);
            var sw = Stopwatch.StartNew();
            while (true)
            {
                bool moved = false;
                try
                {
                    if (File.Exists(backup))
                    {
                        try { File.Delete(backup); }
                        catch { File.Move(backup, Path.Combine(Path.GetDirectoryName(exe), "Beam.bad-old-" + DateTime.Now.Ticks + ".exe")); }
                    }
                    File.Move(exe, backup);
                    moved = true;
                    File.Move(staged, exe);
                    return true;
                }
                catch (Exception ex)
                {
                    if (moved) { try { File.Move(backup, exe); } catch (Exception undo) { Log.Error("Update: undoing the swap", undo); } }
                    if (sw.Elapsed.TotalSeconds > 20)
                    {
                        error = ex.Message;
                        Log.Error("Update: couldn't swap the exe", ex);
                        return false;
                    }
                    Thread.Sleep(500);
                }
            }
        }

        // Puts Beam.old.exe back as Beam.exe; the failed version is kept aside as Beam.bad-<version>.exe.
        public static bool Restore(string exe, string badVersion)
        {
            string backup = BackupPath(exe);
            if (!File.Exists(backup)) return false;
            for (int i = 0; i < 40; i++)
            {
                try
                {
                    if (File.Exists(exe))
                    {
                        string bad = Path.Combine(Path.GetDirectoryName(exe), "Beam.bad-" + FileUtil.SafeName(badVersion ?? "x") + ".exe");
                        FileUtil.TryDelete(bad);
                        File.Move(exe, bad);
                    }
                    File.Move(backup, exe);
                    return true;
                }
                catch (Exception ex)
                {
                    if (i == 39) Log.Error("Update: couldn't restore the previous version", ex);
                    Thread.Sleep(500);
                }
            }
            return false;
        }

        static string ConfigArg(Config cfg)
        {
            return cfg != null && cfg.CustomPath ? " --config " + Quote(cfg.FilePath) : "";
        }

        public static string Quote(string s)
        {
            return "\"" + s + "\"";
        }

        static Process Start(string exe, string args)
        {
            var psi = new ProcessStartInfo(exe, args);
            psi.UseShellExecute = false;
            psi.WorkingDirectory = Path.GetDirectoryName(exe);
            return Process.Start(psi);
        }

        // Waits for the health signal. Gives up early once the started process has exited and no Beam holds
        // the instance lock for a few seconds (a crash at startup), instead of waiting the whole time.
        static bool Watch(EventWaitHandle ev, Process p, int seconds)
        {
            var sw = Stopwatch.StartNew();
            int deadFor = 0;
            while (sw.Elapsed.TotalSeconds < seconds)
            {
                if (ev.WaitOne(500)) return true;
                bool exited;
                try { exited = p == null || p.HasExited; } catch { exited = true; }
                deadFor = exited && !InstanceRunning() ? deadFor + 1 : 0;
                if (deadFor >= 6) return ev.WaitOne(0);
            }
            return false;
        }

        static bool InstanceRunning()
        {
            Mutex m;
            if (!Mutex.TryOpenExisting("Local\\Beam-" + Program.InstanceId, out m)) return false;
            m.Dispose();
            return true;
        }

        // Runs in the *old* process after its UI has shut down and it has released the instance lock.
        public static int HandOver(Handoff h, Config cfg)
        {
            string nonce = Api.NewNonce();
            using (var ev = new EventWaitHandle(false, EventResetMode.ManualReset, Health.EventName(nonce)))
            {
                string mode = (h.Show ? " --show" : " --background") + (h.Family ? " --family" : "");
                try
                {
                    var p = Start(h.Exe, "--updated " + h.NewVersion + " --update-from " + h.OldVersion + " --health " + nonce + mode + ConfigArg(cfg));
                    Log.Write("Update: started " + h.NewVersion + ", waiting for it to report healthy");
                    if (Watch(ev, p, 90)) { Log.Write("Update: " + h.NewVersion + " is running"); return 0; }
                    if (InstanceRunning()) { Log.Write("Update: " + h.NewVersion + " runs but didn't report; leaving it"); return 0; }
                }
                catch (Exception ex) { Log.Error("Update: starting the new version", ex); }
                Log.Write("Update: " + h.NewVersion + " didn't start properly; going back to " + h.OldVersion);
                Restore(h.Exe, h.NewVersion);
                cfg.BadUpdateVersion = h.NewVersion;
                cfg.Save();
                try { Start(h.Exe, "--update-failed " + h.NewVersion + mode + ConfigArg(cfg)); }
                catch (Exception ex) { Log.Error("Update: restarting the previous version", ex); }
                return 1;
            }
        }

        // Crash loop after an update that passed its first health check: put Beam.old.exe back.
        public static bool RollBackSelf(Config cfg, string[] args)
        {
            string exe = Application.ExecutablePath;
            string backup = BackupPath(exe);
            Version old = FileVersion(backup);
            if (old == null || old >= Current) return false;
            Log.Write("Update: Beam " + AppVersion.Text + " failed to start " + Health.BadStarts + " times; going back to " + old);
            if (!Restore(exe, AppVersion.Text)) return false;
            cfg.BadUpdateVersion = AppVersion.Text;
            cfg.Save();
            try { Start(exe, "--update-failed " + AppVersion.Text + " --background" + ConfigArg(cfg)); }
            catch (Exception ex) { Log.Error("Update: restarting the previous version", ex); }
            return true;
        }

        // Beam 1.1.0 installs updates by running the new exe as: Beam.exe --finish-update "<old exe>" <pid>.
        // Replace the old exe once it has exited (keeping it as Beam.old.exe), start the new one and watch it.
        public static int FinishLegacy(string target, int pid, string configPath)
        {
            Log.Write("Update: replacing " + target + " once process " + pid + " exits");
            try
            {
                using (var p = Process.GetProcessById(pid))
                    if (!p.WaitForExit(60000)) Log.Write("Update: the old Beam is still running after 60 s");
            }
            catch (ArgumentException) { } // already gone
            catch (Exception ex) { Log.Error("Update: waiting", ex); }

            string self = Application.ExecutablePath;
            string backup = BackupPath(target);
            try { if (File.Exists(target)) File.Copy(target, backup, true); } catch (Exception ex) { Log.Error("Update: backup", ex); }
            bool copied = false;
            for (int i = 0; i < 40 && !copied; i++)
            {
                try
                {
                    File.Copy(self, target, true);
                    copied = true;
                }
                catch (Exception ex)
                {
                    if (i == 39) Log.Error("Update: couldn't replace " + target, ex);
                    Thread.Sleep(500);
                }
            }
            string exe = copied ? target : self;
            string cfgArg = configPath != null ? " --config " + Quote(configPath) : "";
            string nonce = Api.NewNonce();
            using (var ev = new EventWaitHandle(false, EventResetMode.ManualReset, Health.EventName(nonce)))
            {
                try
                {
                    Log.Write("Update: " + (copied ? "replaced, starting " : "couldn't replace, starting the new copy from ") + exe);
                    var p = Start(exe, "--updated " + AppVersion.Text + " --health " + nonce + " --background" + cfgArg);
                    if (Watch(ev, p, 90) || InstanceRunning()) return 0;
                }
                catch (Exception ex) { Log.Error("Update: restart", ex); }
                if (!copied || !File.Exists(backup)) return 1;
                Log.Write("Update: " + AppVersion.Text + " didn't start properly; putting the previous version back");
                try
                {
                    File.Copy(backup, target, true);
                    var cfg = Config.Load(configPath ?? Config.DefaultPath(), configPath != null);
                    cfg.BadUpdateVersion = AppVersion.Text;
                    cfg.Save();
                    Start(target, "--background" + cfgArg);
                }
                catch (Exception ex) { Log.Error("Update: restoring", ex); }
                return 1;
            }
        }
    }
}
