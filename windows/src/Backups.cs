// This PC's Beam settings, kept on the server too (Beam 1.8.1; the user: "we should definetly have a way to backup
// setting and everything and restore them if needed for all computers"): sent whenever they change, never the sign-in
// or the device key (those stay sealed on this PC). After a reinstall or a reset of Beam: once, an offer to put back
// what an earlier install of Beam on this PC kept there. Settings → This PC → "Restore settings…" does it any time,
// also from another PC's backup. Remote control comes back on only through its own confirmation here (the devices it
// had ticked again), never by itself.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Timer = System.Windows.Forms.Timer;

namespace Beam
{
    class BackupChoice
    {
        public string Device, Name, Install;
        public long At;
        public bool Here;                         // this PC's own (an earlier install of Beam on it)
        public Dictionary<string, object> Settings;
    }

    class SettingsBackups
    {
        // What a backup holds besides the hotkeys and remote control: what ApplySettings takes.
        static readonly string[] Keys = { "deviceName", "autoCopy", "clipboardHistory", "autoSave", "maxSaveMB", "saveFolder", "openLinks", "autoOpenLinks",
            "sendToMenu", "outbox", "outboxFolder", "autostart", "autoUpdate", "phonePopupText" };
        static readonly string[] HotkeyIds = { "picker", "lastTarget", "copyLatest", "screenshot" };

        readonly App app;
        readonly Timer soon = new Timer();
        string lastSent;                          // the settings last sent (this run)
        bool checking;
        RestoreForm form;

        public SettingsBackups(App app)
        {
            this.app = app;
            soon.Interval = 10000; // (changes in a row go as one)
            soon.Tick += (s, e) => Send();
        }

        bool Ready { get { return app.Api != null && app.ServerHas("backups") && app.Cfg.RestoreChecked; } }

        // A setting changed (here, from the page, the tray, a restore): sent in 10 s.
        public void Changed()
        {
            if (!Ready) return;
            soon.Stop();
            soon.Interval = 10000;
            soon.Start();
        }

        public Dictionary<string, object> Current()
        {
            var cfg = app.Cfg;
            var all = app.SettingsObject();
            var s = new Dictionary<string, object>();
            foreach (var k in Keys) { object v; if (all.TryGetValue(k, out v) && v != null) s[k] = v; }
            s["saveFolder"] = cfg.SaveFolder ?? "";     // (a folder that was chosen; the default follows the PC)
            s["outboxFolder"] = cfg.OutboxFolder ?? "";
            var hk = new Dictionary<string, object>();
            foreach (var id in HotkeyIds) { string v; if (cfg.Hotkeys.TryGetValue(id, out v)) hk[id] = v ?? ""; }
            s["hotkeys"] = hk;
            s["allowRemoteControl"] = cfg.AllowRemoteControl;
            s["remoteControlDevices"] = cfg.RemoteControlDevices.Select(a =>
            {
                var o = new Dictionary<string, object>();
                o["id"] = a.Id;
                o["name"] = a.Name;
                return (object)o;
            }).ToArray();
            return s;
        }

        public async void Send()
        {
            soon.Stop();
            if (!Ready) return;
            var settings = Current();
            string text = Json.Stringify(settings);
            if (text == lastSent) return;
            var body = new Dictionary<string, object>();
            body["install"] = app.Cfg.InstallId;
            body["app"] = "windows";
            body["version"] = AppVersion.Text;
            body["settings"] = settings;
            try
            {
                await app.Api.Call(HttpMethod.Put, "/api/devices/me/backup", body, 15, CancellationToken.None);
                if (lastSent == null) Log.Write("Settings: this PC's are kept on the server too (a backup), and again whenever they change");
                lastSent = text;
            }
            catch (Exception ex)
            {
                Log.Write("Settings backup: not sent (" + Api.Describe(ex) + "); again in 5 minutes");
                soon.Interval = 5 * 60000;
                soon.Start();
            }
        }

        // After connecting: once per install, what an earlier install of Beam on this PC kept is offered back; then this
        // install's own go up. Not while another device controls this PC (it waits for the next connection).
        public async void Check()
        {
            if (checking || app.Api == null || !app.ServerHas("backups")) return;
            if (app.Cfg.RestoreChecked) { Changed(); return; }
            checking = true;
            try
            {
                var earlier = (await Fetch(null, true)).Where(c => c.Install != app.Cfg.InstallId).ToList();
                if (earlier.Count == 0) { Checked(); return; }
                if (app.Rc != null && app.Rc.Active) return;
                Log.Write("Settings: an earlier install of Beam on this PC kept its settings on the server (" + When(earlier[0].At) + "); offering them");
                Show(earlier.Take(1).ToList(), true);
            }
            catch (Exception ex) { Log.Write("Settings backup: couldn't look for an earlier install's (" + Api.Describe(ex) + ")"); }
            finally { checking = false; }
        }

        void Checked()
        {
            if (!app.Cfg.RestoreChecked) { app.Cfg.RestoreChecked = true; app.Cfg.Save(); }
            Changed();
        }

        // Settings → This PC → "Restore settings…": this PC's earlier installs' backups, and the newest of each other PC's.
        public async void ShowChoices()
        {
            if (app.Api == null || !app.ServerHas("backups")) { app.Notify("Restore settings", "This needs Beam server 1.8.1 or later."); return; }
            if (app.RcBlocks("restoring settings")) return;
            var choices = new List<BackupChoice>();
            try
            {
                choices.AddRange((await Fetch(null, true)).Where(c => c.Install != app.Cfg.InstallId));
                foreach (var d in app.Devices.Where(x => x.Id != app.Me && x.Platform == "windows" && !x.Temporary).ToList())
                {
                    try { choices.AddRange((await Fetch(d.Id, false)).Take(1)); } catch { }
                }
            }
            catch (Exception ex) { app.Notify("Restore settings", "Beam couldn't get the backups: " + Api.Describe(ex)); return; }
            if (choices.Count == 0) { app.Notify("Restore settings", "No backup of a PC's settings is kept on your Beam yet."); return; }
            Show(choices.Take(8).ToList(), false);
        }

        async Task<List<BackupChoice>> Fetch(string device, bool here)
        {
            var r = Json.Obj(await app.Api.Call(HttpMethod.Get, "/api/devices/" + (device ?? "me") + "/backups", null, 15, CancellationToken.None));
            var list = new List<BackupChoice>();
            var arr = Json.Get(r, "backups") as object[];
            if (arr == null) return list;
            foreach (var o in arr)
            {
                var b = Json.Obj(o);
                var settings = Json.Obj(Json.Get(b, "settings"));
                if (b == null || settings == null || Json.Str(b, "app") != "windows") continue;
                var c = new BackupChoice();
                c.Device = Json.Str(r, "device");
                c.Name = Json.Str(r, "name") ?? "a PC";
                c.Install = Json.Str(b, "install");
                c.At = Json.Long(b, "at", 0);
                c.Here = here;
                c.Settings = settings;
                list.Add(c);
            }
            return list;
        }

        void Show(List<BackupChoice> choices, bool offer)
        {
            if (form != null && !form.IsDisposed) { form.Activate(); return; }
            form = new RestoreForm(choices, offer, chosen =>
            {
                if (chosen != null) Apply(chosen);
                if (offer) Checked();
            });
            Ui.PlaceForTest(form);
            form.FormClosed += (s, e) => form = null;
            form.Show();
            if (!Ui.TestOffscreen) { form.Activate(); Native.SetForegroundWindow(form.Handle); }
        }

        static bool SafeExists(string folder)
        {
            try { return System.IO.Directory.Exists(folder); } catch { return false; }
        }

        public void Apply(BackupChoice c)
        {
            var s = c.Settings;
            var apply = new Dictionary<string, object>();
            foreach (var k in Keys) if (s.ContainsKey(k) && s[k] != null) apply[k] = s[k];
            if (!c.Here) apply.Remove("deviceName"); // (another PC's name stays its own)
            // (audit B-12) ...and its folders only where this PC has them (D:\Beam on a PC without a D: would make every
            // automatic save fail); otherwise this PC keeps its own.
            if (!c.Here)
                foreach (var k in new[] { "saveFolder", "outboxFolder" })
                {
                    string f = apply.ContainsKey(k) ? (Json.Str(apply, k) ?? "").Trim() : "";
                    if (f.Length > 0 && !SafeExists(f)) { apply.Remove(k); Log.Write("Settings backup: kept this PC's " + k + " (" + f + " isn't here)"); }
                }
            string err = app.ApplySettings(apply);
            var hk = Json.Obj(Json.Get(s, "hotkeys"));
            bool keys = false;
            if (hk != null)
            {
                foreach (var id in HotkeyIds)
                {
                    string v = Json.Str(hk, id);
                    uint mods, vk;
                    if (v == null || (v.Length > 0 && !Hotkeys.TryParse(v, out mods, out vk))) continue;
                    string had;
                    if (app.Cfg.Hotkeys.TryGetValue(id, out had) && had == v) continue;
                    app.Cfg.Hotkeys[id] = v;
                    keys = true;
                }
            }
            if (keys) app.HotkeysChanged();
            Log.Write("Settings: put back " + (c.Here ? "this PC's settings from an earlier install's" : c.Name + "'s settings from its") + " backup of " + When(c.At) + (err != null ? " (" + err + ")" : ""));
            app.Notify("Settings restored", (c.Here ? "This PC's settings" : c.Name + "'s settings") + " from " + When(c.At) + " are back.");
            // Remote control: on again only through its own confirmation here, with the same devices ticked.
            if (Json.Bool(s, "allowRemoteControl", false) && !app.Cfg.AllowRemoteControl && app.ServerHas("remote-control"))
            {
                var ids = new List<string>();
                var list = Json.Get(s, "remoteControlDevices") as object[];
                if (list != null) foreach (var o in list) { string id = Json.Str(Json.Obj(o), "id"); if (Config.ValidId(id)) ids.Add(id); }
                app.ShowRcAllow(null, ids);
            }
        }

        public static string When(long at)
        {
            if (at <= 0) return "an unknown time";
            var t = DateTimeOffset.FromUnixTimeMilliseconds(at).LocalDateTime;
            return t.ToString("d MMM yyyy, HH:mm", CultureInfo.CurrentCulture);
        }

        // Tests (custom --config only): check | send | answer:restore|skip | state
        public void TestCommand(string cmd)
        {
            switch (cmd)
            {
                case "check": app.Cfg.RestoreChecked = false; Check(); break;
                case "send": lastSent = null; Send(); break;
                case "choices": ShowChoices(); break;
                case "answer:restore": if (form != null) form.Answer(true); else Log.Write("Settings: (test) no restore offer open"); break;
                case "answer:skip": if (form != null) form.Answer(false); else Log.Write("Settings: (test) no restore offer open"); break;
                case "state": Log.Write("Settings: (test) " + (form != null && !form.IsDisposed ? "the restore offer is open: " + form.Describe() : "no restore offer open") + "; checked " + app.Cfg.RestoreChecked); break;
                default: Log.Write("Settings: (test) unknown " + cmd); break;
            }
        }
    }

    // The offer (one backup) or the choice (several): which to put back.
    class RestoreForm : DialogBase
    {
        readonly List<BackupChoice> choices;
        readonly List<FlatCheck> checks = new List<FlatCheck>();
        readonly Action<BackupChoice> done;
        bool finished, ticking;

        public RestoreForm(List<BackupChoice> choices, bool offer, Action<BackupChoice> done) : base(offer ? "Restore this PC's settings?" : "Restore settings", 540)
        {
            this.choices = choices;
            this.done = done;
            Host = this;
            HostWidth = ClientSize.Width;
            AddLabel(offer ? "Restore this PC's settings?" : "Restore settings from a backup", Ui.Title, false, Ui.S(10));
            AddLabel(offer
                ? "Beam was set up on this PC before, and its settings are kept on your Beam. Put them back? Its name, where files are saved, hotkeys, Send to, the outbox and the rest. Turning remote control back on asks here, separately."
                : "Put back settings kept on your Beam: where files are saved, hotkeys, Send to, the outbox and the rest (this PC's own backup: its name too). Turning remote control back on asks here, separately.",
                Ui.Font, true, Ui.S(14));
            for (int i = 0; i < choices.Count; i++)
            {
                var c = choices[i];
                var box = AddCheck(c.Here ? "This PC (" + c.Name + "): an earlier install of Beam" : c.Name, "Backed up " + SettingsBackups.When(c.At) + Summary(c.Settings), i == 0, 0, Ui.S(6));
                box.CheckedChanged += (s, e) => Pick((FlatCheck)s);
                checks.Add(box);
            }
            Y += Ui.S(8);
            var ok = Button(offer ? "Restore" : "Restore these", true);
            var no = Button(offer ? "Not now" : "Cancel", false);
            ok.SetBounds(ClientSize.Width - Pad - ok.Width, Y, ok.Width, ok.Height);
            no.SetBounds(ok.Left - Ui.S(10) - no.Width, Y, no.Width, no.Height);
            ok.Click += (s, e) => Answer(true);
            no.Click += (s, e) => Answer(false);
            Y += ok.Height + Pad;
            ClientSize = new Size(ClientSize.Width, Y);
        }

        static string Summary(Dictionary<string, object> s)
        {
            var parts = new List<string>();
            string folder = Json.Str(s, "saveFolder");
            if (!string.IsNullOrEmpty(folder)) parts.Add("saves to " + folder);
            if (Json.Bool(s, "sendToMenu", false)) parts.Add("Send to");
            if (Json.Bool(s, "allowRemoteControl", false))
            {
                var list = Json.Get(s, "remoteControlDevices") as object[];
                int n = list != null ? list.Length : 0;
                parts.Add("remote control on (" + n + " device" + (n == 1 ? "" : "s") + ")");
            }
            return parts.Count > 0 ? " · " + string.Join(" · ", parts) : "";
        }

        // One ticked at a time (a choice, not a list).
        void Pick(FlatCheck box)
        {
            if (ticking) return;
            ticking = true;
            try
            {
                if (box.Checked) { foreach (var c in checks) if (c != box) c.Checked = false; }
                else if (!checks.Any(c => c.Checked)) box.Checked = true;
            }
            finally { ticking = false; }
        }

        public void Answer(bool restore)
        {
            if (finished) return;
            finished = true;
            int i = checks.FindIndex(c => c.Checked);
            var chosen = restore && i >= 0 ? choices[i] : null;
            Close();
            done(chosen);
        }

        public string Describe()
        {
            return string.Join(" | ", choices.Select((c, i) => (checks[i].Checked ? "[x] " : "[ ] ") + (c.Here ? "this PC" : c.Name) + " " + c.Install));
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            base.OnFormClosed(e);
            if (!finished) { finished = true; done(null); } // (closed with its X or Esc: as Not now)
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
