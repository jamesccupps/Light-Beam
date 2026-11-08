// Commands on this PC (Beam 1.32 + this app 1.25; the user, 2026-11-06: "being able to remotely run powershell or other
// commands through beam"). Another of the user's devices runs a PowerShell or Command Prompt command here and sees its
// output while it runs. Only when "Commands too" is on here (turned on only at this PC, through a confirmation; off from
// anywhere at once; remote control off turns it off too) and only from a device that may control this PC: the same
// checks as a remote control request (RemoteControl.Vouch: on this PC's list, from the Tailscale machine it's pinned to,
// of this PC's Tailscale owner). It runs as this PC's signed-in user, in a hidden window, never as administrator and
// never as a service: a command that needs more gets Windows' own answer (access denied).
// - PowerShell (Windows PowerShell 5.1) gets the command on its standard input, never on its command line (no quoting,
//   and nothing of it in the process list), runs it as a script block, UTF-8 both ways. Command Prompt takes one line
//   (cmd /d /s /c), its output read in the console's code page, as a Command Prompt window shows it.
// - Stop ends the command's whole process tree (a job object); one that ends by itself leaves what it started running.
// - The output goes to the server in posts of at most 64 K characters, a few a second (each counted, sent again on a
//   network error); at most 16 M characters a command (then it says so and the rest is dropped; it keeps running).
// - beam.log says who ran one, which shell, how long, the exit code and how much output: never the command or its output
//   (commands can hold passwords). A notice here the first time a device runs one in 10 minutes.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Beam
{
    class CommandRunner
    {
        public const int MaxRunning = 4;
        const int MaxCommandChars = 8000;
        const int PostChars = 64 * 1024;
        const long MaxOutputChars = 16L * 1024 * 1024;
        const int SendEveryMs = 150;
        const int BeatMs = 30000;
        static readonly TimeSpan NoticeEvery = TimeSpan.FromMinutes(10);

        // PowerShell: UTF-8 both ways, no progress records, the command from standard input as a script block. The last
        // line of the script block keeps whether its last statement went well ($?), so the exit code is PowerShell's
        // own: an `exit` of the command's, a failing program's code, 1 for a failed cmdlet, else 0. No double quotes in
        // here: the whole of it is one argument.
        const string PsHost =
            "$ProgressPreference='SilentlyContinue';$e=New-Object System.Text.UTF8Encoding $false;[Console]::InputEncoding=$e;[Console]::OutputEncoding=$e;$OutputEncoding=$e;Remove-Variable e;" +
            "$command=[ScriptBlock]::Create([Console]::In.ReadToEnd()+[Environment]::NewLine+'$global:BeamLastOk=$?');$global:LASTEXITCODE=0\n" +
            "& $command\n" +
            "if($global:BeamLastOk -eq $false){if($global:LASTEXITCODE){exit $global:LASTEXITCODE}exit 1}exit 0";

        readonly App app;
        readonly Dictionary<string, Run> runs = new Dictionary<string, Run>();
        readonly HashSet<string> seen = new HashSet<string>();
        readonly Dictionary<string, DateTime> noticed = new Dictionary<string, DateTime>();

        public const string OnlyHere = "Commands are allowed only at this PC: Beam's tray menu (Allow commands too) or its Settings on this PC";

        public CommandRunner(App app) { this.app = app; }

        public bool Allowed { get { return app.Cfg.CommandsAllowed && app.Cfg.AllowRemoteControl; } }
        public int Running { get { lock (runs) return runs.Count; } }

        // ------------------------------------------------------------------ the switch

        public void SetAllowed(bool on, string from)
        {
            if (on && !app.Cfg.AllowRemoteControl) on = false; // (they go to the devices that may control it)
            if (app.Cfg.CommandsAllowed == on) return;
            if (on && app.RcBlocks("turning commands on")) return;
            app.Cfg.CommandsAllowed = on;
            app.Cfg.Save();
            Log.Write("Commands: " + (on ? "the devices that may control this PC may run commands on it" : "turned off on this PC") + " (" + from + ")");
            if (!on) StopAll("commands were turned off (" + from + ")");
            app.CommandsChanged(on ? "turned on" : "turned off");
        }

        // The tray's and Settings' "Commands too": on through a confirmation here, off at once.
        public void Toggle(string from)
        {
            if (app.Cfg.CommandsAllowed) { SetAllowed(false, from); return; }
            if (!app.Cfg.AllowRemoteControl)
            {
                MessageBox.Show("Commands go only to the devices that may control this PC: turn on \"Allow remote control\" first.", "Beam", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (app.RcBlocks("turning commands on")) return;
            string who = string.Join(", ", app.Cfg.RemoteControlDevices.Select(a => a.Name));
            var r = MessageBox.Show("Let the devices that may control this PC run commands on it?\n\n" + (who.Length > 0 ? who : "No devices yet") +
                " could then run PowerShell and Command Prompt commands here and see what they print, without seeing the screen. They run as " +
                Environment.UserName + ", never as administrator. Turn it off here, in Beam's menu, or by turning off remote control.",
                "Beam", MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
            if (r == DialogResult.OK) SetAllowed(true, from);
        }

        // ------------------------------------------------------------------ events from the server

        public void OnEvent(string name, Dictionary<string, object> d)
        {
            if (name == "command-run") OnRun(d);
            else if (name == "command-stop") { var run = Find(Json.Str(d, "id")); if (run != null) Stop(run, "asked from " + run.By); }
        }

        async void OnRun(Dictionary<string, object> d)
        {
            string id = Json.Str(d, "id"), from = Json.Str(d, "from"), shell = Json.Str(d, "shell"), command = Json.Str(d, "command");
            var api = app.Api;
            if (api == null || !ValidId(id)) return;
            lock (runs) { if (seen.Contains(id)) return; if (seen.Count > 500) seen.Clear(); seen.Add(id); }
            var dev = app.DeviceById(from);
            string name = dev != null ? dev.Name : "an unknown device";
            string why = null, reason = "declined";
            if (!app.Cfg.CommandsAllowed) { why = "commands are off on this PC"; reason = "off"; }
            else if (shell != "powershell" && shell != "cmd") why = "it asked for a shell this PC doesn't have";
            else if (string.IsNullOrEmpty(command) || command.Length > MaxCommandChars || command.IndexOf('\0') >= 0 || (shell == "cmd" && command.IndexOfAny(new[] { '\r', '\n' }) >= 0))
                why = "the command isn't one this PC runs";
            else if (Running >= MaxRunning) { why = "this PC is already running " + MaxRunning + " commands"; reason = "busy"; }
            Log.Write("Commands: " + name + " asks to run a " + ShellName(shell) + " command here (" + (command ?? "").Length + " characters)");
            if (why == null)
            {
                why = await app.Rc.Vouch(from, Json.Obj(Json.Get(d, "viewer")));
                if (why == RemoteControl.NotListedText) reason = "not-listed";
                if (why == null && !Allowed) { why = "commands were turned off meanwhile"; reason = "off"; }
            }
            if (why != null)
            {
                Log.Write("Commands: refused " + name + ": " + why);
                await Refuse(api, id, why, reason);
                return;
            }
            Notice(from, name, shell);
            Start(api, id, from, name, shell, command);
        }

        static async Task Refuse(Api api, string id, string why, string reason)
        {
            var body = new Dictionary<string, object>();
            body["id"] = id;
            body["seq"] = 1;
            body["error"] = Capitalized(why);
            body["reason"] = reason;
            try { await api.Call(HttpMethod.Post, "/api/devices/me/commands", body, 20, CancellationToken.None); }
            catch (Exception ex) { Log.Write("Commands: the refusal didn't reach the server (" + Api.Describe(ex) + ")"); }
        }

        void Notice(string from, string name, string shell)
        {
            DateTime last;
            if (from != null && noticed.TryGetValue(from, out last) && DateTime.UtcNow - last < NoticeEvery) return;
            if (from != null) noticed[from] = DateTime.UtcNow;
            app.Notify(name + " runs a command on this PC", ShellName(shell) + ", as " + Environment.UserName +
                ". Turn commands off in Beam's menu in the taskbar corner, or in Settings → Security.");
        }

        // ------------------------------------------------------------------ running one

        class Run
        {
            public string Id, From, By, Shell;
            public Api Api;
            public Process Proc;
            public IntPtr Job = IntPtr.Zero;
            public readonly object Gate = new object();
            public readonly List<KeyValuePair<string, string>> Pending = new List<KeyValuePair<string, string>>(); // ("o"|"e", text)
            public int PendingChars;
            public long OutChars;
            public bool Cut, Stopped, Exited, Ended; // (Ended: its end went out)
            public int Code;
            public int Seq;
            public int ReadersLeft = 2;
            public readonly Stopwatch Clock = Stopwatch.StartNew();
            public readonly ManualResetEventSlim Wake = new ManualResetEventSlim(false);
            public readonly ManualResetEventSlim ReadersDone = new ManualResetEventSlim(false);
        }

        Run Find(string id)
        {
            if (id == null) return null;
            lock (runs) { Run r; return runs.TryGetValue(id, out r) ? r : null; }
        }

        void Start(Api api, string id, string from, string name, string shell, string command)
        {
            var run = new Run { Id = id, From = from, By = name, Shell = shell, Api = api };
            string sys = Environment.GetFolderPath(Environment.SpecialFolder.System);
            var psi = new ProcessStartInfo();
            Encoding enc;
            if (shell == "powershell")
            {
                psi.FileName = Path.Combine(sys, "WindowsPowerShell", "v1.0", "powershell.exe");
                psi.Arguments = "-NoLogo -NoProfile -NonInteractive -Command \"" + PsHost + "\"";
                enc = new UTF8Encoding(false);
            }
            else
            {
                psi.FileName = Path.Combine(sys, "cmd.exe");
                psi.Arguments = "/d /s /c \"" + command + "\"";
                enc = Oem();
            }
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardInput = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var p = new Process();
            p.StartInfo = psi;
            try
            {
                p.Start();
            }
            catch (Exception ex)
            {
                Log.Write("Commands: " + ShellName(shell) + " didn't start (" + ex.Message + ")");
                var _ = Refuse(api, id, ShellName(shell) + " didn't start here: " + ex.Message, "failed");
                p.Dispose();
                return;
            }
            run.Proc = p;
            run.Job = JobFor(p);
            lock (runs) runs[id] = run;
            Log.Write("Commands: running " + name + "'s " + ShellName(shell) + " command (run " + id + ", process " + p.Id + ")");
            app.CommandsChanged(null);
            // The command (PowerShell) and then the end of input: a command that asks for input gets nothing.
            byte[] input = shell == "powershell" ? new UTF8Encoding(false).GetBytes(command) : null;
            Task.Run(() =>
            {
                try
                {
                    var s = p.StandardInput.BaseStream;
                    if (input != null) s.Write(input, 0, input.Length);
                    s.Close();
                }
                catch (Exception ex) { Log.Write("Commands: run " + id + ": its input didn't go in (" + ex.Message + ")"); }
            });
            StartReader(run, p.StandardOutput.BaseStream, "o", enc);
            StartReader(run, p.StandardError.BaseStream, "e", enc);
            Task.Run(() => Wait(run));
            Task.Run(() => Send(run));
        }

        void StartReader(Run run, Stream s, string which, Encoding enc)
        {
            var t = new Thread(() =>
            {
                var dec = enc.GetDecoder();
                var buf = new byte[16384];
                var chars = new char[enc.GetMaxCharCount(buf.Length) + 2];
                bool first = true;
                try
                {
                    for (;;)
                    {
                        int n = s.Read(buf, 0, buf.Length);
                        if (n <= 0) break;
                        int c = dec.GetChars(buf, 0, n, chars, 0, false);
                        int at = 0;
                        if (first && c > 0 && chars[0] == '﻿') at = 1; // (a byte order mark, should one come)
                        first = false;
                        if (c > at) Add(run, which, new string(chars, at, c - at));
                    }
                    int end = dec.GetChars(buf, 0, 0, chars, 0, true);
                    if (end > 0) Add(run, which, new string(chars, 0, end));
                }
                catch (Exception) { } // (the pipe closed under it: a stopped command)
                finally
                {
                    if (Interlocked.Decrement(ref run.ReadersLeft) == 0) run.ReadersDone.Set();
                    run.Wake.Set();
                }
            });
            t.IsBackground = true;
            t.Name = "Beam command " + which;
            t.Start();
        }

        static void Add(Run run, string which, string text)
        {
            lock (run.Gate)
            {
                if (run.Cut || run.Ended) return; // (what's past the limit, or after the end, is read and dropped: never a full pipe)
                if (run.OutChars + run.PendingChars + text.Length > MaxOutputChars)
                {
                    run.Cut = true;
                    text = "\r\n[Beam: more than " + (MaxOutputChars / 1024 / 1024) + " M characters of output; the rest isn't shown. The command keeps running.]\r\n";
                    which = "e";
                }
                if (run.Pending.Count > 0 && run.Pending[run.Pending.Count - 1].Key == which)
                {
                    var lastPart = run.Pending[run.Pending.Count - 1];
                    run.Pending[run.Pending.Count - 1] = new KeyValuePair<string, string>(which, lastPart.Value + text);
                }
                else run.Pending.Add(new KeyValuePair<string, string>(which, text));
                run.PendingChars += text.Length;
            }
            run.Wake.Set();
        }

        void Wait(Run run)
        {
            try
            {
                run.Proc.WaitForExit();
                // What it started may hold its output open: a moment for the pipes, then it's done.
                run.ReadersDone.Wait(2000);
                run.Code = run.Proc.ExitCode;
            }
            catch (Exception ex) { Log.Write("Commands: run " + run.Id + ": " + ex.Message); run.Code = -1; }
            lock (run.Gate) run.Exited = true;
            run.Wake.Set();
        }

        // Posts what came, a few times a second; every 30 s anyway while it runs; the end once it's over.
        async Task Send(Run run)
        {
            bool started = false, ended = false, gone = false;
            var quiet = Stopwatch.StartNew();
            try
            {
                while (!ended)
                {
                    if (started)
                    {
                        if (run.Wake.Wait(SendEveryMs)) await Task.Delay(50); // (a moment for more to come with it)
                        run.Wake.Reset();
                    }
                    if (gone)
                    {
                        // The server no longer has it (stopped there, Beam restarted): nothing more goes out; it's over
                        // once the stopped command has exited (or, should it not, after 10 s).
                        lock (run.Gate) { run.Pending.Clear(); run.PendingChars = 0; if (run.Exited) break; }
                        if (quiet.ElapsedMilliseconds > 10000) break;
                        continue;
                    }
                    var body = new Dictionary<string, object>();
                    body["id"] = run.Id;
                    var parts = new List<object>();
                    bool exited;
                    lock (run.Gate)
                    {
                        int room = PostChars;
                        while (run.Pending.Count > 0 && room > 0)
                        {
                            var part = run.Pending[0];
                            string t = part.Value;
                            if (t.Length > room)
                            {
                                int cut = room;
                                if (char.IsHighSurrogate(t[cut - 1])) cut--; // (never half a character)
                                if (cut <= 0) break;
                                run.Pending[0] = new KeyValuePair<string, string>(part.Key, t.Substring(cut));
                                t = t.Substring(0, cut);
                            }
                            else run.Pending.RemoveAt(0);
                            run.PendingChars -= t.Length;
                            run.OutChars += t.Length;
                            room -= t.Length;
                            var o = new Dictionary<string, object>();
                            o["s"] = part.Key;
                            o["t"] = t;
                            parts.Add(o);
                        }
                        exited = run.Exited && run.Pending.Count == 0;
                    }
                    if (!started) { body["running"] = true; started = true; }
                    if (parts.Count > 0) body["out"] = parts.ToArray();
                    if (exited)
                    {
                        var end = new Dictionary<string, object>();
                        end["code"] = run.Code;
                        end["ms"] = run.Clock.ElapsedMilliseconds;
                        if (run.Stopped) end["stopped"] = true;
                        if (run.Cut) end["cut"] = true;
                        body["end"] = end;
                        ended = true;
                    }
                    if (parts.Count == 0 && !exited && body.Count == 1 && quiet.ElapsedMilliseconds < BeatMs) continue;
                    body["seq"] = ++run.Seq;
                    var answer = await Post(run, body);
                    quiet.Restart();
                    if (ended) { lock (run.Gate) run.Ended = true; }
                    if (answer == null)
                    {
                        if (ended) break;
                        Stop(run, "the server no longer has it");
                        gone = true;
                        continue;
                    }
                    if (Json.Bool(answer, "stop", false) && !ended) Stop(run, "asked from " + run.By);
                }
            }
            catch (Exception ex) { Log.Error("Commands: sending run " + run.Id, ex); Stop(run, "its output couldn't be sent"); }
            finally { Finish(run); }
        }

        // One post, sent again on a network error (the same seq: the server counts it once) for up to a minute. Null when
        // the server says the command is gone (stopped there, or Beam restarted) or it can't be reached.
        static async Task<Dictionary<string, object>> Post(Run run, Dictionary<string, object> body)
        {
            var deadline = DateTime.UtcNow.AddSeconds(60);
            int wait = 1000;
            for (;;)
            {
                Exception failed = null;
                try
                {
                    return Json.Obj(await run.Api.Call(HttpMethod.Post, "/api/devices/me/commands", body, 30, CancellationToken.None)) ?? new Dictionary<string, object>();
                }
                catch (Exception ex) { failed = ex; }
                var api = failed as ApiException;
                if (api != null && (api.Status == 404 || api.Status == 403 || api.Status == 400))
                {
                    Log.Write("Commands: run " + run.Id + ": the server said " + api.Status + " (" + api.Message + ")");
                    return null;
                }
                if (DateTime.UtcNow > deadline) { Log.Write("Commands: run " + run.Id + ": the server can't be reached (" + Api.Describe(failed) + ")"); return null; }
                await Task.Delay(wait);
                wait = Math.Min(wait * 2, 8000);
            }
        }

        void Finish(Run run)
        {
            lock (runs) runs.Remove(run.Id);
            long chars;
            lock (run.Gate) chars = run.OutChars + run.PendingChars;
            Log.Write("Commands: run " + run.Id + " (" + run.By + ", " + ShellName(run.Shell) + ") " + (run.Stopped ? "was stopped" : "ended") + ": exit code " +
                run.Code + " after " + (run.Clock.ElapsedMilliseconds / 1000.0).ToString("0.0", CultureInfo.InvariantCulture) + " s, " + chars + " characters of output" + (run.Cut ? " (cut)" : ""));
            bool exited;
            lock (run.Gate) exited = run.Exited;
            if (exited)
            {
                if (run.Job != IntPtr.Zero) { CloseHandle(run.Job); run.Job = IntPtr.Zero; }
                try { run.Proc.Dispose(); } catch { }
            }
            app.Post(() => app.CommandsChanged(null));
        }

        // Ends the command's whole process tree (its job), or the command alone where it has no job.
        void Stop(Run run, string why)
        {
            lock (run.Gate)
            {
                if (run.Stopped || run.Exited) return;
                run.Stopped = true;
            }
            Log.Write("Commands: stopping run " + run.Id + " (" + why + ")");
            try
            {
                if (run.Job == IntPtr.Zero || !TerminateJobObject(run.Job, 1)) run.Proc.Kill();
            }
            catch (Exception ex) { Log.Write("Commands: run " + run.Id + " couldn't be stopped (" + ex.Message + ")"); }
        }

        // Waits (at most `ms`) until every command has ended and said so to the server: Beam quitting.
        public void WaitIdle(int ms)
        {
            var clock = Stopwatch.StartNew();
            while (Running > 0 && clock.ElapsedMilliseconds < ms) Thread.Sleep(50);
        }

        public void StopAll(string why)
        {
            List<Run> all;
            lock (runs) all = runs.Values.ToList();
            foreach (var r in all) Stop(r, why);
        }

        // ------------------------------------------------------------------ helpers

        public static string ShellName(string shell) { return shell == "cmd" ? "Command Prompt" : "PowerShell"; }

        static string Capitalized(string s) { return string.IsNullOrEmpty(s) ? s : char.ToUpperInvariant(s[0]) + s.Substring(1); }

        static bool ValidId(string id)
        {
            if (id == null || id.Length != 16) return false;
            foreach (char c in id) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
            return true;
        }

        // The console's code page (Command Prompt's output, redirected): 437 on an English Windows.
        static Encoding Oem()
        {
            try { return Encoding.GetEncoding(CultureInfo.CurrentCulture.TextInfo.OEMCodePage); }
            catch { return Encoding.GetEncoding(437); }
        }

        static IntPtr JobFor(Process p)
        {
            try
            {
                IntPtr job = CreateJobObject(IntPtr.Zero, null);
                if (job == IntPtr.Zero) return IntPtr.Zero;
                if (AssignProcessToJobObject(job, p.Handle)) return job;
                CloseHandle(job);
            }
            catch (Exception ex) { Log.Write("Commands: no job for process " + p.Id + " (" + ex.Message + "): Stop ends it alone"); }
            return IntPtr.Zero;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool TerminateJobObject(IntPtr job, uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CloseHandle(IntPtr handle);
    }
}
