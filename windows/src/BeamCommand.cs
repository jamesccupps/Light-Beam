// The beam command on this PC, for Claude Code (Beam 1.41.1 + this app 1.33; the user, 2026-11-23: "make this all easy
// to do in the app itself on each device"). Settings → This PC → Logs and Claude Code → Set up: the command (Beam for
// Linux's signed build of cli/beam.js, which runs on Windows too) from this Beam, checked against its SHA-256 and this
// app's update key, into %LOCALAPPDATA%\Beam\cli with beam.cmd; that folder on this user's PATH; the command signed in
// as a device of its own ("<this PC> (beam command)") with a pairing link this app makes, so approved like this app
// (no password, no code); and a note in Claude Code's own CLAUDE.md (%USERPROFILE%\.claude, only where Claude Code is)
// saying how a session uses it. Needs Node.js 20 or later. Kept up to date with Beam's own builds. Remove undoes it all
// (the device forgotten too). A test instance does it all inside its own folder (a home of its own, no PATH change).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace Beam
{
    class BeamCommand
    {
        readonly App app;
        volatile bool busy;
        string lastError;
        string nodePath, nodeVersion;
        DateTime nodeLooked = DateTime.MinValue;

        public const string NoteStart = "<!-- Beam: the beam command (written by Beam's Settings on this PC; its Remove takes this out) -->";
        public const string NoteEnd = "<!-- /Beam -->";

        public BeamCommand(App app) { this.app = app; }

        string Root { get { return app.Cfg.CustomPath ? Path.Combine(app.Cfg.Dir, "cli") : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Beam", "cli"); } }
        string Home { get { return app.Cfg.CustomPath ? Path.Combine(app.Cfg.Dir, "home") : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile); } }
        string ConfigFile { get { return Path.Combine(Home, ".beam.json"); } }
        string ClaudeDir { get { return Path.Combine(Home, ".claude"); } }
        string ClaudeFile { get { return Path.Combine(ClaudeDir, "CLAUDE.md"); } }
        string Js { get { return Path.Combine(Root, "beam.js"); } }
        public string Cmd { get { return Path.Combine(Root, "beam.cmd"); } }
        public bool Installed { get { return File.Exists(Js) && File.Exists(Cmd); } }

        // ------------------------------------------------------------------ what's there

        // Node.js: on this app's PATH, or where its installer puts it (looked at once a minute at most).
        void LookForNode()
        {
            if (DateTime.UtcNow - nodeLooked < TimeSpan.FromMinutes(1)) return;
            nodeLooked = DateTime.UtcNow;
            string found = null;
            foreach (var raw in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
            {
                string dir = raw.Trim().Trim('"');
                if (dir.Length == 0) continue;
                try { string p = Path.Combine(dir, "node.exe"); if (File.Exists(p)) { found = p; break; } } catch { }
            }
            if (found == null)
                foreach (var sf in new[] { Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86 })
                {
                    string p = Path.Combine(Environment.GetFolderPath(sf), "nodejs", "node.exe");
                    if (File.Exists(p)) { found = p; break; }
                }
            nodePath = found;
            nodeVersion = null;
            if (found == null) return;
            string output;
            if (Run(found, "--version", null, 5000, out output) == 0) nodeVersion = output.Trim().TrimStart('v');
        }

        static int Major(string version)
        {
            int n;
            return int.TryParse((version ?? "").Split('.')[0], out n) ? n : 0;
        }

        string InstalledVersion()
        {
            try
            {
                using (var f = new StreamReader(Js, Encoding.UTF8))
                {
                    var buf = new char[4096];
                    int n = f.Read(buf, 0, buf.Length);
                    var m = Regex.Match(new string(buf, 0, n), @"\nconst VERSION = '(\d+\.\d+\.\d+)';");
                    return m.Success ? m.Groups[1].Value : null;
                }
            }
            catch { return null; }
        }

        Dictionary<string, object> ReadConfig()
        {
            try { return Json.ParseObject(File.ReadAllText(ConfigFile, Encoding.UTF8)); } catch { return null; }
        }

        string ServerUrl { get { return (app.Cfg.Server ?? "").TrimEnd('/'); } }

        // Signed in to this Beam (its address and a key in ~/.beam.json).
        bool SignedInHere(Dictionary<string, object> c)
        {
            return c != null && !string.IsNullOrEmpty(Json.Str(c, "key")) && string.Equals((Json.Str(c, "url") ?? "").TrimEnd('/'), ServerUrl, StringComparison.OrdinalIgnoreCase);
        }

        bool NoteThere()
        {
            try { return File.Exists(ClaudeFile) && File.ReadAllText(ClaudeFile, Encoding.UTF8).Contains(NoteStart); } catch { return false; }
        }

        // For Settings: { node, nodeOk, installed, version, signedIn, device, claude, note, busy, error, path }.
        public Dictionary<string, object> StatusObject()
        {
            LookForNode();
            var c = ReadConfig();
            var d = new Dictionary<string, object>();
            d["node"] = nodeVersion;
            d["nodeOk"] = Major(nodeVersion) >= 20;
            d["installed"] = Installed;
            d["version"] = Installed ? InstalledVersion() : null;
            d["signedIn"] = SignedInHere(c);
            d["device"] = SignedInHere(c) ? Json.Str(c, "device") : null;
            d["claude"] = Directory.Exists(ClaudeDir);
            d["note"] = NoteThere();
            d["busy"] = busy;
            d["error"] = lastError;
            d["path"] = Cmd;
            return d;
        }

        // ------------------------------------------------------------------ set up, update, remove

        public async Task<string> SetUp(bool note)
        {
            if (busy) return "It's being set up already";
            busy = true;
            lastError = null;
            app.CommandToolChanged();
            try
            {
                nodeLooked = DateTime.MinValue;
                LookForNode();
                if (nodePath == null) return Fail("Node.js isn't on this PC: install it (nodejs.org, version 20 or later), then Set up");
                if (Major(nodeVersion) < 20) return Fail("Node.js " + nodeVersion + " is too old here: version 20 or later is needed (nodejs.org)");
                string got = await Fetch();
                if (got != null) return Fail(got);
                WriteCmd();
                var c = ReadConfig();
                if (!SignedInHere(c))
                {
                    string key = await app.Api.PairKey();
                    if (string.IsNullOrEmpty(key) || !key.StartsWith("bp_")) return Fail("Beam didn't give a sign-in for it");
                    c = c ?? new Dictionary<string, object>();
                    c["url"] = ServerUrl;
                    c["key"] = key;
                    c["device"] = app.Cfg.DeviceName + " (beam command)";
                    c["deviceId"] = NewId();
                    c.Remove("app");
                    c.Remove("serverId");
                    WriteConfig(c);
                }
                // The sign-in checked once (it also turns the pairing link into the command's own key).
                string output = null;
                int code = await Task.Run(() => Run(nodePath, "\"" + Js + "\" status --json", Home, 30000, out output));
                if (code != 0) return Fail("the beam command couldn't reach Beam: " + OneLine(output));
                if (!app.Cfg.CustomPath) AddToPath(Root);
                if (note && Directory.Exists(ClaudeDir)) WriteNote(); else if (!note) RemoveNote();
                c = ReadConfig();
                Log.Write("beam command: set up (" + InstalledVersion() + ", signed in as " + (c != null ? Json.Str(c, "device") : "?") + (NoteThere() ? ", Claude Code's note written" : "") + ")");
                return null;
            }
            catch (Exception ex) { return Fail(Api.Describe(ex)); }
            finally
            {
                busy = false;
                app.CommandToolChanged();
            }
        }

        string Fail(string why)
        {
            lastError = why;
            Log.Write("beam command: not set up (" + why + ")");
            return why;
        }

        // The build from this Beam into Root, checked: its size, SHA-256 and this app's update key ("beam-linux-update").
        async Task<string> Fetch()
        {
            var ups = Json.Obj(await app.Api.Call(HttpMethod.Get, "/api/updates"));
            var lx = Json.Obj(Json.Get(ups, "linux"));
            if (lx == null) return "this Beam has no build of the beam command to give (it's built with Beam for Linux)";
            string version = Json.Str(lx, "version"), sha = (Json.Str(lx, "sha256") ?? "").ToLowerInvariant(), sig = Json.Str(lx, "sig");
            long size = Json.Long(lx, "size", -1);
            if (string.IsNullOrEmpty(version) || sha.Length != 64 || size <= 0 || size > 8L * 1024 * 1024) return "this Beam's build of the beam command isn't complete";
            byte[] data;
            using (var req = app.Api.Request(HttpMethod.Get, "/download/linux"))
            using (var resp = await app.Api.Send(req, 120, CancellationToken.None, HttpCompletionOption.ResponseContentRead))
            {
                if (!resp.IsSuccessStatusCode) throw await Api.ErrorFrom(resp);
                data = await resp.Content.ReadAsByteArrayAsync();
            }
            string hash;
            using (var s = SHA256.Create()) hash = Transfers.Hex(s.ComputeHash(data));
            if (data.Length != size || hash != sha) return "the beam command arrived damaged (its SHA-256 isn't the one Beam gave)";
            string why = UpdateSignature.Check(version, hash, size, sig, "linux");
            if (why != null) return "the beam command can't be used: " + why;
            Directory.CreateDirectory(Root);
            string tmp = Js + ".tmp";
            File.WriteAllBytes(tmp, data);
            if (File.Exists(Js)) File.Replace(tmp, Js, null); else File.Move(tmp, Js);
            return null;
        }

        void WriteCmd()
        {
            var sb = new StringBuilder();
            sb.Append("@echo off\r\n");
            sb.Append("rem The beam command (Beam for Windows wrote this: Settings on this PC, Logs and Claude Code)\r\n");
            if (app.Cfg.CustomPath) sb.Append("set \"USERPROFILE=" + Home + "\"\r\nset \"HOME=" + Home + "\"\r\n");
            sb.Append("\"" + nodePath + "\" \"%~dp0beam.js\" %*\r\n");
            File.WriteAllText(Cmd, sb.ToString(), new UTF8Encoding(false));
        }

        void WriteConfig(Dictionary<string, object> c)
        {
            Directory.CreateDirectory(Home);
            string tmp = ConfigFile + ".tmp";
            File.WriteAllText(tmp, Json.Stringify(c), new UTF8Encoding(false));
            if (File.Exists(ConfigFile)) File.Replace(tmp, ConfigFile, null); else File.Move(tmp, ConfigFile);
        }

        static string NewId()
        {
            var b = new byte[12];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(b);
            return Transfers.Hex(b);
        }

        static string OneLine(string s)
        {
            s = Regex.Replace(s ?? "", @"\s+", " ").Trim();
            return s.Length > 200 ? s.Substring(0, 200) + "…" : s;
        }

        // A newer build of it on the server (GET /api/updates, the app-update event): fetched and checked as at Set up.
        public async void UpdateIfOld(Dictionary<string, object> updates)
        {
            if (busy || !Installed || app.Api == null) return;
            var lx = Json.Obj(Json.Get(updates, "linux"));
            string latest = lx != null ? Json.Str(lx, "version") : null;
            string mine = InstalledVersion();
            if (latest == null || latest == mine || (mine != null && !Updater.IsNewerVersion(latest, mine))) return;
            busy = true;
            try
            {
                LookForNode();
                string why = await Fetch();
                if (why == null && nodePath != null) WriteCmd();
                Log.Write("beam command: " + (why == null ? "updated to " + latest : "not updated to " + latest + " (" + why + ")"));
            }
            catch (Exception ex) { Log.Write("beam command: not updated (" + Api.Describe(ex) + ")"); }
            finally { busy = false; app.CommandToolChanged(); }
        }

        public async Task<string> Remove()
        {
            if (busy) return "It's busy: try again in a moment";
            busy = true;
            lastError = null;
            try
            {
                var c = ReadConfig();
                string id = c != null ? Json.Str(c, "deviceId") : null;
                if (SignedInHere(c) && Config.ValidId(id) && id != app.Me)
                {
                    try { await app.Api.Call(HttpMethod.Delete, "/api/devices/" + id); } // (forgotten: its sign-in ends)
                    catch (Exception ex) { Log.Write("beam command: its device wasn't removed from Beam (" + Api.Describe(ex) + ")"); }
                }
                if (c != null)
                {
                    foreach (var k in new[] { "url", "key", "device", "deviceId", "serverId" }) c.Remove(k);
                    if (c.Count == 0) { try { File.Delete(ConfigFile); } catch { } } else WriteConfig(c);
                }
                RemoveNote();
                if (!app.Cfg.CustomPath) RemoveFromPath(Root);
                try { if (Directory.Exists(Root)) Directory.Delete(Root, true); } catch (Exception ex) { Log.Write("beam command: its folder stays (" + ex.Message + ")"); }
                Log.Write("beam command: removed");
                return null;
            }
            catch (Exception ex) { return Fail(Api.Describe(ex)); }
            finally { busy = false; app.CommandToolChanged(); }
        }

        // ------------------------------------------------------------------ Claude Code's note

        public string SetNote(bool on)
        {
            try
            {
                if (on)
                {
                    if (!Installed) return "Set up the beam command first";
                    if (!Directory.Exists(ClaudeDir)) return "Claude Code isn't on this PC (no .claude folder in your user folder)";
                    WriteNote();
                }
                else RemoveNote();
                Log.Write("beam command: Claude Code's note " + (on ? "written" : "taken out"));
                return null;
            }
            catch (Exception ex) { return ex.Message; }
            finally { app.CommandToolChanged(); }
        }

        string NoteText()
        {
            string cmd = Cmd;
            return NoteStart + "\n" +
                "## Getting logs and info from the user's other PCs: `beam collect` (Beam)\n\n" +
                "When work here needs something from another of the user's PCs (a program's log on the PC it runs on, Windows' event\n" +
                "log there, what runs there), ask Beam for it, read only. The command is `beam` (on the PATH in new terminals), or\n" +
                "`& \"" + cmd + "\"` in PowerShell:\n\n" +
                "```powershell\n" +
                "beam devices                                                    # the PCs (● online)\n" +
                "beam collect \"<PC>\" events --log Application --since 2h --level error\n" +
                "beam collect \"<PC>\" folders                                     # the log folders chosen at that PC\n" +
                "beam collect \"<PC>\" files \"<folder>\"                            # newest first\n" +
                "beam collect \"<PC>\" file \"<folder>/<path>\" --tail 300\n" +
                "beam collect \"<PC>\" processes --name <part>                     # also: services, system\n" +
                "beam collect \"<PC>\" beam-log --tail 200                         # that PC's own Beam log\n" +
                "```\n\n" +
                "- `--json` on any of them; `events` takes `--log` (System by default), `--since` (30m, 2h, 3d), `--level`\n" +
                "  (critical, error, warning, info, all), `--source`, `--event`, `--max`. `beam --help` lists everything.\n" +
                "- It works only on a PC where the user turned on \"Let approved devices collect logs\" (its Beam: Settings → This PC\n" +
                "  → Logs and Claude Code), and a program's own files only from the log folders chosen there. If it says it's off, or\n" +
                "  there's no such log folder, ask the user to turn it on or add the folder at that PC; never try another way in.\n" +
                "- Read only: nothing is run or changed there. Beam doesn't run commands from here (the user chose that).\n" +
                NoteEnd + "\n";
        }

        static string WithoutNote(string text)
        {
            int a = text.IndexOf(NoteStart, StringComparison.Ordinal);
            if (a < 0) return text;
            int b = text.IndexOf(NoteEnd, a, StringComparison.Ordinal);
            int end = b < 0 ? text.Length : b + NoteEnd.Length;
            while (end < text.Length && (text[end] == '\r' || text[end] == '\n')) end++;
            return text.Substring(0, a) + text.Substring(end);
        }

        void WriteNote()
        {
            string text = File.Exists(ClaudeFile) ? File.ReadAllText(ClaudeFile, Encoding.UTF8) : "";
            text = WithoutNote(text).TrimEnd();
            text = (text.Length > 0 ? text + "\n\n" : "") + NoteText();
            File.WriteAllText(ClaudeFile, text, new UTF8Encoding(false));
        }

        void RemoveNote()
        {
            if (!File.Exists(ClaudeFile)) return;
            string text = File.ReadAllText(ClaudeFile, Encoding.UTF8);
            if (!text.Contains(NoteStart)) return;
            string rest = WithoutNote(text).TrimEnd();
            if (rest.Length == 0) File.Delete(ClaudeFile);
            else File.WriteAllText(ClaudeFile, rest + "\n", new UTF8Encoding(false));
        }

        // ------------------------------------------------------------------ this user's PATH (HKCU\Environment)

        [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);

        static void PathChanged()
        {
            UIntPtr r;
            SendMessageTimeout(new IntPtr(0xffff), 0x001A, UIntPtr.Zero, "Environment", 0x0002, 3000, out r); // WM_SETTINGCHANGE, abort if hung
        }

        static List<string> PathParts(string value)
        {
            return (value ?? "").Split(';').Where(p => p.Trim().Length > 0).ToList();
        }

        static void AddToPath(string dir)
        {
            using (var k = Registry.CurrentUser.CreateSubKey("Environment"))
            {
                string cur = k.GetValue("Path", "", RegistryValueOptions.DoNotExpandEnvironmentNames) as string ?? "";
                var parts = PathParts(cur);
                if (parts.Any(p => string.Equals(Environment.ExpandEnvironmentVariables(p).TrimEnd('\\'), dir.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))) return;
                parts.Add(dir);
                k.SetValue("Path", string.Join(";", parts), RegistryValueKind.ExpandString);
            }
            PathChanged();
            Log.Write("beam command: its folder is on this user's PATH now (new terminals see it)");
        }

        static void RemoveFromPath(string dir)
        {
            using (var k = Registry.CurrentUser.OpenSubKey("Environment", true))
            {
                if (k == null) return;
                string cur = k.GetValue("Path", "", RegistryValueOptions.DoNotExpandEnvironmentNames) as string ?? "";
                var parts = PathParts(cur);
                var kept = parts.Where(p => !string.Equals(Environment.ExpandEnvironmentVariables(p).TrimEnd('\\'), dir.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)).ToList();
                if (kept.Count == parts.Count) return;
                var kind = k.GetValueKind("Path");
                k.SetValue("Path", string.Join(";", kept), kind == RegistryValueKind.String ? RegistryValueKind.String : RegistryValueKind.ExpandString);
            }
            PathChanged();
        }

        // ------------------------------------------------------------------ running node

        int Run(string exe, string args, string home, int timeoutMs, out string output)
        {
            output = "";
            try
            {
                var psi = new ProcessStartInfo(exe, args);
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = Encoding.UTF8;
                psi.StandardErrorEncoding = Encoding.UTF8;
                if (home != null && app.Cfg.CustomPath) { psi.EnvironmentVariables["USERPROFILE"] = home; psi.EnvironmentVariables["HOME"] = home; }
                using (var p = Process.Start(psi))
                {
                    var o = p.StandardOutput.ReadToEndAsync();
                    var e = p.StandardError.ReadToEndAsync();
                    if (!p.WaitForExit(timeoutMs)) { try { p.Kill(); } catch { } output = "it didn't answer in time"; return -1; }
                    output = (o.Result + "\n" + e.Result).Trim();
                    return p.ExitCode;
                }
            }
            catch (Exception ex) { output = ex.Message; return -1; }
        }
    }
}
