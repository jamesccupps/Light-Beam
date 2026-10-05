// Remote control of this PC (Beam 1.6; plan/rd.md, research §8.5). Another of the owner's devices sees this screen
// and uses its mouse and keyboard over a direct WebRTC connection through Tailscale; the server only introduces them.
// This PC enforces every rule itself, never trusting the viewer or the server:
// - its own switch ("Allow remote control", off by default, only ever turned on here with a native confirmation) and
//   its own list of devices that may control it, each pinned to the Tailscale node (StableID) it had when ticked;
// - this PC's own `tailscale whois` of the viewer's address: a node of the same owner, the pinned one;
// - no banner, no session: the banner ("<device> (<machine> · <ip>) is controlling this PC · Stop") is up before the
//   lease, the capture or anything else, and the capture host only captures while that holds;
// - the lease (every 30 s; anything but 200 ends it), revocation (rc-end, rc-disable, the device removed, sign-out),
//   the lock (ends it: a locked PC is Remote Desktop's job), Ctrl+Alt+Shift+F12 (ends every session at once);
// - once connected, the connection's peer must be the address whois checked; until then no video and no input.
// beam.log gets who, from which machine, when, for how long and how it ended; never keys, text or clipboard content.
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
using Microsoft.Win32;
using Timer = System.Windows.Forms.Timer;

namespace Beam
{
    enum RcState { Checking, Starting, Connecting, Live, Ended }

    class RcSession
    {
        public string Id, ViewerId, ViewerName;
        public string Ip4, Ip6;          // the viewer's Tailscale addresses, as the server saw them
        public string ServerNode;        // the server's word for the viewer's machine (beam.log only)
        public string CheckedIp;         // the address this PC's own whois checked...
        public string Machine, StableId; // ...and the node it named
        public RcState State;
        public Api Api;
        public RcHost Host;
        public RcBanner Banner;
        public bool Verified;            // this connection's peer passed the check: video and input flow
        public bool Clip;                // the viewer turned clipboard sync on
        public int Screen;
        public string Mode = "text";
        public DateTime Asked = DateTime.Now, LiveSince;
        public DateTime LastLease = DateTime.Now, LastPong;
        public bool Leasing;
        public readonly Queue<Dictionary<string, object>> Signals = new Queue<Dictionary<string, object>>();
        public bool Signalling;
        public int Pings;
        public string LastState;         // the last { locked, secure, elevated } sent
        public string Codec;             // what the page reported (beam.log once)
        public RcFitWish Fit;            // Beam 1.8: the viewer wants this screen to suit its own (null: as it was)
        public string FitDone;           // ...the wish last carried out ("" = as it was)
        public bool Fitting;             // ...one is being carried out
        public string FitNote;           // why the last one couldn't be
        public Dictionary<string, object> Settings; // the viewer's picture settings (for the capture page, also a new one)
        public bool VideoOff;            // the viewer is hidden: no frames
        public string PathKey;           // (1.11) how Tailscale reaches the viewer, as last told to it
        public DateTime PathNext;        // ...when to ask Tailscale again
        public bool PathChecking;
        public long RestartedFor;        // (1.11.4) the display change a capture that ended was started again for

        public string Label
        {
            get
            {
                string who = RcPolicy.DisplayName(ViewerName);
                return Machine != null ? who + " (" + Machine + " · " + CheckedIp + ")" : who;
            }
        }
    }

    // The viewer's picture area in physical pixels, and its own scaling. Scale (1.11.4): the viewer's "Bigger text", the
    // only way this PC's scaling changes too (it froze apps here for a second at each change, and closed one).
    class RcFitWish
    {
        public int W, H;
        public double Dpr;
        public bool Scale;
        public string Key { get { return W + "x" + H + "@" + Dpr.ToString("0.###", CultureInfo.InvariantCulture) + (Scale ? "+scale" : ""); } }
    }

    class RemoteControl
    {
        public const string KillKeys = "Ctrl+Alt+Shift+F12";
        public const string OnlyHere = "Remote control is turned on, and its devices chosen, only at this PC: Beam's tray menu (Allow remote control) or its Settings on this PC";
        const string NotListed = "it isn't on this PC's list of devices that may control it";
        readonly App app;
        RcSession current;
        readonly HashSet<string> finished = new HashSet<string>();   // sessions handled here (the server may repeat a request)
        readonly Timer tick, leaseTimer, flushTimer;
        readonly RcWindow window;
        Hotkeys killKeys;
        InputInjector injector;
        bool lockFlag, onConsole = true, testLock;
        bool awake;
        bool closing;
        bool testClickOnShow;          // tests: the next banner gets a click on Stop the moment it appears
        string clipLast;               // the text this PC just took from the viewer (not sent back)
        uint clipSeen;
        readonly TailnetQuery tailnet;
        readonly Stopwatch clock = Stopwatch.StartNew();
        readonly RcDisplay display;
        readonly SemaphoreSlim displayGate = new SemaphoreSlim(1, 1); // one display change at a time, in order

        public RemoteControl(App app)
        {
            this.app = app;
            tailnet = new TailnetQuery(app.Cfg);
            IDisplayBackend screens = app.Cfg.CustomPath ? (IDisplayBackend)new FakeDisplay() : new Win32Display(); // tests: nothing real changes
            display = new RcDisplay(screens, line => Log.Write("Remote control: the shared screen " + line));
            app.Post(RestoreLeftoverDisplay);
            window = new RcWindow(this);
            tick = new Timer();
            tick.Interval = 1000;
            tick.Tick += (s, e) => Tick();
            leaseTimer = new Timer();
            leaseTimer.Interval = Math.Max(1, app.Cfg.CustomPath && app.Cfg.TestRcLeaseSec > 0 ? app.Cfg.TestRcLeaseSec : 30) * 1000;
            leaseTimer.Tick += (s, e) => { if (current != null) { var ignored = Lease(current); } };
            flushTimer = new Timer();
            flushTimer.Interval = InputInjector.AltGrWindowMs + 10;
            flushTimer.Tick += (s, e) => { flushTimer.Stop(); if (injector != null) { injector.Flush(); if (injector.HasPending) flushTimer.Start(); } };
            ReadLockState();
            SystemEvents.PowerModeChanged += OnPower;
            SystemEvents.DisplaySettingsChanged += OnDisplaySettings;
        }

        // ------------------------------------------------------------------ display changes (1.11.4)

        // When this PC's display last changed (UTC ticks): a fit here, or Windows (another resolution or scaling). A
        // capture that ends within a few seconds of one is the change's doing, not Windows' Stop sharing: it starts
        // again, once per change (a second end is a real Stop sharing).
        long displayChanged;
        const int DisplayChangeWindowMs = 6000;

        void NoteDisplayChange() { Interlocked.Exchange(ref displayChanged, DateTime.UtcNow.Ticks); }

        void OnDisplaySettings(object sender, EventArgs e) { NoteDisplayChange(); }

        bool CaptureEndIsTheDisplays(RcSession s)
        {
            long at = Interlocked.Read(ref displayChanged);
            if (at == 0 || s.RestartedFor == at || (DateTime.UtcNow.Ticks - at) / TimeSpan.TicksPerMillisecond > DisplayChangeWindowMs) return false;
            s.RestartedFor = at;
            return true;
        }

        // The capture page takes a fresh capture of the same screen on the same connection (rc-host.js recapture).
        void CaptureAgain(RcSession s, string why)
        {
            if (current != s || s.Host == null || s.State == RcState.Ended) return;
            Log.Write("Remote control: capturing again (" + why + ")");
            var m = new Dictionary<string, object>();
            m["t"] = "recapture";
            s.Host.Post(m);
        }

        // ------------------------------------------------------------------ what others see

        public bool Allowed { get { return app.Cfg.AllowRemoteControl; } }
        public bool Locked { get { return testLock || lockFlag || !onConsole; } }
        public bool Active { get { return current != null; } }

        // For the tray: "Robin Laptop is controlling this PC", or null.
        public string Status
        {
            get
            {
                var s = current;
                if (s == null || s.State == RcState.Checking) return null;
                return RcPolicy.DisplayName(s.ViewerName) + (s.State == RcState.Live ? " is controlling this PC" : " is connecting to this PC");
            }
        }

        public string ViewerName { get { return current != null ? RcPolicy.DisplayName(current.ViewerName) : null; } }

        // ------------------------------------------------------------------ the switch and the list

        // Turned on at this PC (the native confirmation listed the devices; `ids` are the ticked ones). Each is pinned to
        // the Tailscale node this PC's own whois finds at its address now; one that can't be checked now is pinned when
        // it first asks.
        public void Allow(List<string> ids, string from)
        {
            if (app.RcBlocks("turning remote control on")) return;
            var list = Entries(ids, null);
            app.Cfg.AllowRemoteControl = true;
            app.Cfg.RemoteControlDevices = list;
            app.Cfg.Save();
            Log.Write("Remote control: allowed on this PC (" + from + "), for " + Names(list));
            app.RcChanged("allowed");
            Pin(list, list);
        }

        // The devices that may control this PC, changed at this PC (Settings → This PC, the tray menu): the ones that
        // stay keep their pins; ticked ones (newly, or again) are pinned anew.
        public void SetDevices(List<string> ids, List<string> reticked, string from)
        {
            if (!Allowed || app.RcBlocks("changing who may control it")) return;
            var list = Entries(ids, app.Cfg.RemoteControlDevices);
            var repin = list.Where(a => a.Node == null || (reticked != null && reticked.Contains(a.Id))).ToList();
            foreach (var a in repin) { a.Node = null; a.Machine = null; a.At = Fmt.NowMs(); }
            app.Cfg.RemoteControlDevices = list;
            app.Cfg.Save();
            Log.Write("Remote control: the devices that may control this PC are now " + Names(list) + " (" + from + ")");
            app.RcChanged(null);
            if (current != null && !Listed(current.ViewerId)) End(current, "stopped", "its device was taken off this PC's list");
            Pin(repin, list);
        }

        // Off: from here (tray, Settings, the page), from another device (rc-disable), or a test. Sessions end at once.
        public void SetOff(string from)
        {
            bool was = app.Cfg.AllowRemoteControl;
            app.Cfg.AllowRemoteControl = false;
            app.Cfg.RemoteControlDevices = new List<RcAllowed>();
            app.Cfg.Save();
            if (current != null) End(current, "stopped", "remote control was turned off (" + from + ")");
            if (was) Log.Write("Remote control: turned off on this PC (" + from + ")");
            app.RcChanged("turned off");
        }

        // The listed devices for these ids (devices this PC knows, never itself or a session-only sign-in); entries
        // already on `old` keep their pins.
        List<RcAllowed> Entries(IEnumerable<string> ids, List<RcAllowed> old)
        {
            var list = new List<RcAllowed>();
            foreach (var id in ids.Distinct())
            {
                var dev = app.DeviceById(id);
                if (dev == null || id == app.Me || dev.Temporary) continue;
                var had = old != null ? old.FirstOrDefault(a => a.Id == id) : null;
                var a2 = new RcAllowed();
                a2.Id = id;
                a2.Name = dev.Name;
                a2.Node = had != null ? had.Node : null;
                a2.Machine = had != null ? had.Machine : null;
                a2.At = had != null ? had.At : Fmt.NowMs();
                list.Add(a2);
            }
            return list;
        }

        static string Names(List<RcAllowed> list)
        {
            return list.Count == 0 ? "no devices yet" : string.Join(", ", list.Select(a => a.Name));
        }

        // Pins each to the Tailscale node at the address the server lists for it (this PC's own whois). One that can't
        // be checked now is pinned when it first asks (its request must pass the owner check either way).
        async void Pin(List<RcAllowed> which, List<RcAllowed> list)
        {
            foreach (var a in which)
            {
                var dev = app.DeviceById(a.Id);
                string ip = dev != null ? dev.TailscaleIp : null;
                if (!RcPolicy.IsTailscaleIp(ip)) { Log.Write("Remote control: " + a.Name + " has no Tailscale address now; it's pinned to its machine when it first asks"); continue; }
                var check = await tailnet.Check(ip);
                if (!ReferenceEquals(app.Cfg.RemoteControlDevices, list)) return; // changed again meanwhile
                if (check.Refusal != null) { Log.Write("Remote control: couldn't pin " + a.Name + " to its machine now (" + check.Refusal + "); it's pinned when it first asks"); continue; }
                a.Node = check.StableId;
                a.Machine = check.Name;
                app.Cfg.Save();
                Log.Write("Remote control: " + a.Name + " is pinned to the Tailscale machine " + check.Name);
            }
            app.RcChanged(null);
        }

        RcAllowed ListEntry(string id)
        {
            return app.Cfg.RemoteControlDevices.FirstOrDefault(a => a.Id == id);
        }

        bool Listed(string id) { return id != null && ListEntry(id) != null; }

        // ------------------------------------------------------------------ events from the server

        public void OnEvent(string name, Dictionary<string, object> d)
        {
            switch (name)
            {
                case "rc-request": OnRequest(d); break;
                case "rc-signal": OnSignal(d); break;
                case "rc-end": OnEnd(d); break;
                case "rc-disable": OnDisable(d); break;
            }
        }

        // Sessions handled here: a repeated rc-request (a reconnecting stream gets requested ones again) is ignored.
        void Finished(string id)
        {
            if (finished.Count > 500) finished.Clear();
            finished.Add(id);
        }

        static bool ValidId(string id)
        {
            if (id == null || id.Length != 16) return false;
            foreach (char c in id) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
            return true;
        }

        async void OnRequest(Dictionary<string, object> d)
        {
            try { await Request(d); }
            catch (Exception ex)
            {
                Log.Error("Remote control: a request", ex);
                var s = current;
                if (s != null && s.Id == Json.Str(d, "id")) End(s, "failed", "an error here");
            }
        }

        async Task Request(Dictionary<string, object> d)
        {
            string id = Json.Str(d, "id"), from = Json.Str(d, "from");
            if (closing || app.Api == null || !ValidId(id) || finished.Contains(id) || (current != null && current.Id == id)) return; // a repeat
            var viewer = Json.Obj(Json.Get(d, "viewer"));
            string ip4 = Json.Str(viewer, "ip4"), ip6 = Json.Str(viewer, "ip6"), node = Json.Str(viewer, "node"), from_ip = Json.Str(viewer, "ip");
            var dev = app.DeviceById(from);
            string name = dev != null ? dev.Name : "an unknown device";
            var facts = new RcFacts();
            facts.ServerFeature = app.ServerHas("remote-control");
            facts.Allowed = Allowed;
            facts.Locked = Locked;
            facts.Busy = current != null && current.ViewerId != from;
            facts.Me = app.Me;
            facts.ViewerId = from;
            facts.ViewerKnown = dev != null;
            facts.ViewerTemporary = dev != null && dev.Temporary;
            facts.ViewerUser = dev != null ? dev.User : null;
            facts.Ip4 = RcPolicy.IsTailscaleIp(ip4) ? ip4 : null;
            facts.Ip6 = RcPolicy.IsTailscaleIp(ip6) ? ip6 : null;
            string refusal = RcPolicy.Refusal(facts);
            if (refusal == null && !Listed(from)) refusal = NotListed;
            Log.Write("Remote control: " + name + " asks to control this PC (from " + (node ?? "a Tailscale machine") + ", " + (facts.Ip4 ?? facts.Ip6 ?? "no Tailscale address") + ")");
            if (refusal != null) { Refuse(id, app.Api, name, refusal, refusal == NotListed ? "not-listed" : RcPolicy.EndReason(refusal)); return; }
            if (current != null) End(current, null, "the same device asked again"); // its page reloaded: the server ended the old one
            var s = new RcSession();
            s.Id = id;
            s.ViewerId = from;
            s.ViewerName = dev.Name;
            s.Ip4 = facts.Ip4;
            s.Ip6 = facts.Ip6;
            s.ServerNode = node;
            s.Api = app.Api;
            s.State = RcState.Checking;
            current = s;
            app.MarkChanged();
            // This PC's own look at the address the server vouched for: the same Tailscale owner as this PC, and the node
            // this device was pinned to. Nothing shows and nothing is captured before this.
            // The address the request came from (viewer.ip), else either of the viewer's addresses.
            string ip = RcPolicy.IsTailscaleIp(from_ip) && (RcPolicy.SameIp(from_ip, s.Ip4) || RcPolicy.SameIp(from_ip, s.Ip6)) ? from_ip : s.Ip4 ?? s.Ip6;
            var check = await tailnet.Check(ip);
            if (current != s) return;
            string why = check.Refusal;
            var entry = ListEntry(from);
            if (why == null && entry == null) why = NotListed; // taken off the list meanwhile
            if (why == null && entry.Node != null && entry.Node != check.StableId)
                why = "it asked from another Tailscale machine (" + check.Name + ") than the one it was allowed on (" + (entry.Machine ?? entry.Node) + ")";
            if (why != null) { current = null; Refuse(id, s.Api, s.ViewerName, why, why == NotListed ? "not-listed" : "declined"); app.MarkChanged(); return; }
            if (entry.Node == null)
            {
                entry.Node = check.StableId;
                entry.Machine = check.Name;
                app.Cfg.Save();
                Log.Write("Remote control: " + s.ViewerName + " is pinned to the Tailscale machine " + check.Name + " (its first request)");
            }
            s.CheckedIp = ip;
            s.Machine = check.Name;
            s.StableId = check.StableId;
            // No banner, no session.
            RegisterKillSwitch();
            try
            {
                s.Banner = new RcBanner(app, s.Label, () => Stop("the banner's Stop"));
                s.Banner.ShowBanner(DesktopLayout.Current().Primary);
            }
            catch (Exception ex) { Log.Error("Remote control: the banner", ex); }
            if (s.Banner == null || !s.Banner.Up) { End(s, "failed", "the banner couldn't be shown"); return; }
            Log.Write("Remote control: banner up: " + s.Label + " is controlling this PC");
            if (testClickOnShow) { testClickOnShow = false; s.Banner.ClickStopForTest(); } // must be ignored (the 500 ms guard)
            s.State = RcState.Starting;
            app.MarkChanged();
            if (!await Lease(s)) return;
            leaseTimer.Stop();
            leaseTimer.Start();
            tick.Start();
            var layout = DesktopLayout.Current();
            var primary = layout.Primary;
            s.Screen = primary != null ? primary.Id : 0;
            StartHost(s, layout);
        }

        void Refuse(string id, Api api, string name, string why, string reason)
        {
            Finished(id);
            Log.Write("Remote control: refused " + name + ": " + why);
            PostEnd(id, api, reason);
        }

        void OnSignal(Dictionary<string, object> d)
        {
            var s = current;
            if (s == null || Json.Str(d, "id") != s.Id || Json.Str(d, "from") != s.ViewerId) return; // not ours, or not the viewer
            string kind = Json.Str(d, "kind");
            if (kind != "answer" && kind != "candidates" && kind != "restart") return;
            if (s.Host == null) return;
            var m = new Dictionary<string, object>();
            m["t"] = "signal";
            m["kind"] = kind;
            if (kind == "answer") m["sdp"] = Json.Str(d, "sdp");
            if (kind == "candidates") m["candidates"] = Json.Get(d, "candidates");
            s.Host.Post(m);
        }

        void OnEnd(Dictionary<string, object> d)
        {
            string id = Json.Str(d, "id");
            var s = current;
            if (s == null || id != s.Id) { if (ValidId(id)) Finished(id); return; }
            string reason = Json.Str(d, "reason") ?? "stopped", by = Json.Str(d, "by");
            End(s, null, reason + (by != null ? ", by " + by : ""));
        }

        void OnDisable(Dictionary<string, object> d)
        {
            string by = Json.Str(d, "by") ?? "another device";
            bool was = Allowed;
            SetOff("from " + by); // reported at once: that settles the server's pending disable
            if (was) app.Notify("Remote control is off on this PC", "Turned off from " + by + ". Turn it on again from Beam's tray menu on this PC.");
        }

        // The device list changed: a viewer that was removed (or merged away) can't go on.
        public void DevicesChanged()
        {
            var s = current;
            if (s != null && app.DeviceById(s.ViewerId) == null) End(s, "stopped", "its device was removed");
        }

        // Signed out, revoked, another server or another device id: everything ends here (the server already knows, or
        // isn't ours any more).
        public void Reset(string why)
        {
            if (current != null) End(current, null, why);
            RcHost.CloseAll(); // nor is a warm capture host kept for a reconnect
        }

        // ------------------------------------------------------------------ the lease

        async Task<bool> Lease(RcSession s)
        {
            if (s.Leasing || s.State == RcState.Ended) return s.State != RcState.Ended;
            s.Leasing = true;
            try
            {
                await s.Api.Call(HttpMethod.Post, "/api/rc/sessions/" + s.Id + "/lease", null, 15, CancellationToken.None);
                s.LastLease = DateTime.Now;
                return current == s;
            }
            catch (ApiException ex)
            {
                // Anything but 200: over (410 ended, 404 the server forgot it or restarted, 401 signed out).
                if (current == s) End(s, null, "the server ended it (lease answered " + ex.Status + ")");
                return false;
            }
            catch (Exception ex)
            {
                // The server can't be reached: the session goes on for now, but the server ends it after 90 s without a
                // lease, and so does this PC (without the server, nothing could end it otherwise).
                if (current == s && DateTime.Now - s.LastLease > TimeSpan.FromSeconds(75)) { End(s, null, "the server couldn't be reached for over a minute (" + Api.Describe(ex) + ")"); return false; }
                return current == s;
            }
            finally { s.Leasing = false; }
        }

        // ------------------------------------------------------------------ the capture host

        async void StartHost(RcSession s, DesktopLayout layout)
        {
            if (current != s || s.State == RcState.Ended) return;
            var host = RcHost.For(app.Cfg, layout.SourceName(s.Screen), app.DevTools, () => CaptureAllowed(s));
            s.Host = host;
            s.Verified = false;
            host.Message += (h, m) => OnPage(s, h, m);
            if (injector == null) injector = NewInjector();
            injector.Screen = s.Screen;
            injector.NewConnection();
            try { await host.Start(); }
            catch (Exception ex)
            {
                Log.Error("Remote control: the capture host", ex);
                if (current == s && s.Host == host) End(s, "failed", "the capture host didn't start");
                return;
            }
            if (current != s || s.Host != host) { var ignored = host.Close(); return; }
            Log.Write("Remote control: capture host " + (host.Reused ? "reused" : "up") + " (WebView2 " + host.RuntimeVersion + ", " + layout.SourceName(s.Screen) + ")");
            // A capture that hangs (a wrong source name hangs silently) or never connects ends the session.
            var started = DateTime.Now;
            var watch = new Timer();
            watch.Interval = 1000;
            watch.Tick += (o, e) =>
            {
                if (current != s || s.Host != host || s.State == RcState.Ended) { watch.Stop(); watch.Dispose(); return; }
                double secs = (DateTime.Now - started).TotalSeconds;
                if (!host.Captured && secs > 10) { watch.Stop(); watch.Dispose(); End(s, "failed", "the screen capture didn't start"); }
                else if (host.Captured && !s.Verified && secs > 45) { watch.Stop(); watch.Dispose(); End(s, "failed", "the viewer didn't connect"); }
                else if (s.Verified) { watch.Stop(); watch.Dispose(); }
            };
            watch.Start();
        }

        // The gate behind ScreenCaptureStarting: this session's capture host, the session going on, its banner up.
        bool CaptureAllowed(RcSession s)
        {
            return current == s && s.State != RcState.Ended && s.State != RcState.Checking && s.Banner != null && s.Banner.Up && !Locked;
        }

        InputInjector NewInjector()
        {
            IInputBackend backend;
            if (app.Cfg.CustomPath) backend = new RecordingBackend(Path.Combine(app.Cfg.Dir, "rc-input.jsonl")); // tests: never real input
            else backend = new SendInputBackend();
            var inj = new InputInjector(backend, DesktopLayout.Current, () => clock.ElapsedMilliseconds);
            inj.Note = note => Log.Write("Remote control: " + note);
            inj.VirtualKeyOf = InputTarget.VirtualKeyOf; // Win+L by virtual key, in whatever layout this PC uses
            Log.Write("Remote control: input through " + backend.Name);
            return inj;
        }

        // What the capture page says (already checked to come from this session's own page).
        void OnPage(RcSession s, RcHost host, Dictionary<string, object> m)
        {
            if (current != s || s.Host != host || s.State == RcState.Ended) return;
            string t = Json.Str(m, "t");
            switch (t)
            {
                case "ready":
                    host.StartCapture(StartConfig(s));
                    break;
                case "captured":
                    Log.Write("Remote control: capturing " + Json.Long(m, "w", 0) + "×" + Json.Long(m, "h", 0));
                    s.State = s.State == RcState.Live ? RcState.Live : RcState.Connecting;
                    var layout = DesktopLayout.Current();
                    int found = MatchScreen(layout, s.Screen, (int)Json.Long(m, "w", 0), (int)Json.Long(m, "h", 0));
                    if (found != s.Screen) { Log.Write("Remote control: the captured screen looks like screen " + (found + 1) + ", not " + (s.Screen + 1)); s.Screen = found; injector.Screen = found; }
                    break;
                case "signal":
                    QueueSignal(s, m);
                    break;
                case "state":
                    OnConnectionState(s, m);
                    break;
                case "in":
                case "mv":
                    if (!s.Verified) return; // nothing before the peer check
                    var msg = Json.ParseObject(Json.Str(m, "d"));
                    if (msg == null) return;
                    injector.Handle(msg);
                    if (injector.HasPending && !flushTimer.Enabled) flushTimer.Start();
                    break;
                case "ctl":
                    if (s.Verified) OnViewerCtl(s, Json.ParseObject(Json.Str(m, "d")));
                    break;
                case "stats":
                    string codec = Json.Str(m, "codec"), enc = Json.Str(m, "encoder");
                    if (codec != null && codec + "/" + enc != s.Codec) { s.Codec = codec + "/" + enc; Log.Write("Remote control: video " + codec + (enc != null ? " (" + enc + ")" : "")); }
                    break;
                case "recaptured":
                    Log.Write("Remote control: capturing " + Json.Long(m, "w", 0) + "×" + Json.Long(m, "h", 0) + " again");
                    break;
                case "ended":
                    string reason = Json.Str(m, "reason") ?? "";
                    if (reason == "stopped-sharing" && CaptureEndIsTheDisplays(s)) CaptureAgain(s, "the capture ended as the display changed");
                    else if (reason == "stopped-sharing") End(s, "stopped", "Stop sharing on Windows' sharing bar");
                    else if (reason == "connection") End(s, "failed", "the connection failed");
                    else End(s, "failed", "the screen capture failed (" + reason + ")");
                    break;
                case "log":
                    string line = Json.Str(m, "m") ?? "";
                    Log.Write("Remote control page: " + (line.Length > 200 ? line.Substring(0, 200) : line));
                    break;
            }
        }

        Dictionary<string, object> StartConfig(RcSession s)
        {
            var c = new Dictionary<string, object>();
            var peer = new Dictionary<string, object>();
            peer["ip4"] = s.Ip4;
            peer["ip6"] = s.Ip6;
            c["peer"] = peer;
            c["mode"] = s.Mode;
            c["battery"] = OnBattery();
            if (s.Settings != null) c["settings"] = s.Settings; // (a new capture page after a switch of screens: as before)
            c["video"] = !s.VideoOff;
            return c;
        }

        // The captured frame's size, matched to a screen (several monitors: Chromium's "Screen N" order is a best guess).
        static int MatchScreen(DesktopLayout l, int expected, int w, int h)
        {
            var e = l.Screen(expected);
            if (e == null || w <= 0 || (e.W == w && e.H == h)) return expected;
            var same = l.Screens.Where(x => x.W == w && x.H == h).ToList();
            return same.Count == 1 ? same[0].Id : expected;
        }

        void QueueSignal(RcSession s, Dictionary<string, object> m)
        {
            string kind = Json.Str(m, "kind");
            if (kind == "offer")
            {
                string sdp = Json.Str(m, "sdp");
                if (string.IsNullOrEmpty(sdp) || sdp.Length > 64 * 1024) return;
                var body = new Dictionary<string, object>();
                body["kind"] = kind;
                body["sdp"] = sdp;
                s.Signals.Enqueue(body);
            }
            else if (kind == "candidates")
            {
                var list = Json.Get(m, "candidates") as object[];
                if (list == null || list.Length == 0) return;
                for (int i = 0; i < list.Length; i += 20) // the server takes 20 a signal
                {
                    var body = new Dictionary<string, object>();
                    body["kind"] = kind;
                    body["candidates"] = list.Skip(i).Take(20).ToArray();
                    s.Signals.Enqueue(body);
                }
            }
            else return;
            if (!s.Signalling) SendSignals(s);
        }

        // One at a time, in order: the viewer must get the offer before the candidates that follow it.
        async void SendSignals(RcSession s)
        {
            s.Signalling = true;
            try
            {
                while (s.Signals.Count > 0 && current == s && s.State != RcState.Ended)
                {
                    var body = s.Signals.Dequeue();
                    try { await s.Api.Call(HttpMethod.Post, "/api/rc/sessions/" + s.Id + "/signal", body, 15, CancellationToken.None); }
                    catch (ApiException ex)
                    {
                        if (ex.Status == 410 || ex.Status == 404) { if (current == s) End(s, null, "the server ended it (signal answered " + ex.Status + ")"); return; }
                        Log.Write("Remote control: a signal was refused (" + ex.Status + ")");
                    }
                    catch (Exception ex) { Log.Write("Remote control: a signal didn't go out (" + Api.Describe(ex) + ")"); }
                }
            }
            finally { s.Signalling = false; }
        }

        // The connection is up (or its path changed): its peer must be the address this PC's whois checked, or another
        // address of that same node.
        async void OnConnectionState(RcSession s, Dictionary<string, object> m)
        {
            string pc = Json.Str(m, "pc");
            if (pc == "failed") { End(s, "failed", "the connection failed"); return; }
            if (pc != "connected") return;
            string remote = Json.Str(m, "remoteIp");
            var host = s.Host;
            string why = RcPolicy.PeerRefusal(remote, s.Ip4, s.Ip6);
            if (why == null && !RcPolicy.SameIp(remote, s.CheckedIp))
            {
                var other = await tailnet.Check(remote); // the other address family won: it must be the same node
                if (current != s || s.Host != host) return;
                if (other.Refusal != null) why = other.Refusal;
                else if (other.StableId != s.StableId) why = "the peer is another Tailscale machine (" + other.Name + ")";
            }
            if (why != null) { End(s, "failed", "the connection's peer failed the check: " + why + " (a " + (Json.Str(m, "type") ?? "?") + " candidate)"); return; }
            if (s.Verified) return; // a new path to the same peer (an ICE restart)
            s.Verified = true;
            s.LastPong = DateTime.Now;
            var hello = new Dictionary<string, object>();
            hello["t"] = "hello";
            hello["v"] = 1;
            hello["role"] = "host";
            hello["name"] = app.Cfg.DeviceName;
            var layout = DesktopLayout.Current();
            hello["monitors"] = MonitorList(layout);
            hello["monitor"] = s.Screen;
            hello["caps"] = new object[] { "fit", "fit-scale", "settings", "video" }; // Beam 1.8: what this PC does besides 1.6's (fit-scale: 1.11.4)
            hello["fitted"] = display.Fitted;
            // Where this PC's cursor is, when it's on the shared screen: a phone's trackpad pointer starts there (1.6.1).
            var cursor = CursorOn(layout, s.Screen);
            if (cursor != null) hello["cursor"] = cursor;
            var v = new Dictionary<string, object>();
            v["t"] = "verified";
            v["hello"] = hello;
            host.Post(v);
            bool first = s.State != RcState.Live;
            s.State = RcState.Live;
            if (first)
            {
                s.LiveSince = DateTime.Now;
                s.PathNext = DateTime.Now.AddSeconds(2); // (1.11) the path, once it has settled a little
                KeepAwake(true);
                Log.Write("Remote control: " + s.ViewerName + " is controlling this PC (peer " + remote + " is " + s.Machine + ", checked)");
                app.Notify(RcPolicy.DisplayName(s.ViewerName) + " is controlling this PC", "Stop it with the banner at the top of the screen, or " + KillKeys + ".");
            }
            else Log.Write("Remote control: connected again (screen " + (s.Screen + 1) + ")");
            app.MarkChanged();
        }

        static object[] MonitorList(DesktopLayout layout)
        {
            var screens = new List<object>();
            foreach (var x in layout.Screens)
            {
                var o = new Dictionary<string, object>();
                o["id"] = x.Id;
                o["name"] = layout.SourceName(x.Id);
                o["x"] = x.X; o["y"] = x.Y; o["w"] = x.W; o["h"] = x.H;
                o["primary"] = x.Primary;
                o["scale"] = Math.Round(x.Scale, 2);
                screens.Add(o);
            }
            return screens.ToArray();
        }

        // Where the cursor is on screen `screen`, in its own physical pixels (Beam is per-monitor DPI aware); null when
        // it's on another screen or can't be read (a secure desktop).
        static Dictionary<string, object> CursorOn(DesktopLayout layout, int screen)
        {
            CursorPoint p;
            var sc = layout.Screen(screen);
            if (sc == null || !GetCursorPos(out p)) return null;
            if (p.X < sc.X || p.Y < sc.Y || p.X >= sc.X + sc.W || p.Y >= sc.Y + sc.H) return null;
            var c = new Dictionary<string, object>();
            c["x"] = p.X - sc.X;
            c["y"] = p.Y - sc.Y;
            return c;
        }

        // Control messages from the viewer (ctl), after the peer check.
        void OnViewerCtl(RcSession s, Dictionary<string, object> m)
        {
            if (m == null) return;
            switch (Json.Str(m, "t"))
            {
                case "pong":
                    s.LastPong = DateTime.Now;
                    break;
                case "quality":
                {
                    string mode = Json.Str(m, "mode") == "motion" ? "motion" : "text";
                    s.Mode = mode;
                    var q = new Dictionary<string, object>();
                    q["t"] = "quality";
                    q["mode"] = mode;
                    if (s.Host != null) s.Host.Post(q);
                    break;
                }
                case "monitor":
                {
                    int id = (int)Json.Long(m, "id", -1);
                    var layout = DesktopLayout.Current();
                    if (id == s.Screen || layout.Screen(id) == null) break;
                    Log.Write("Remote control: switching to screen " + (id + 1));
                    var old = s.Host;
                    s.Host = null;
                    s.Verified = false;
                    if (injector != null) injector.ReleaseAll("another screen");
                    s.Screen = id;
                    if (old != null) { var closing2 = old.End("monitor"); }
                    // A fitted screen goes back; the viewer asks again for the new one (after its hello).
                    s.FitDone = null;
                    if (display.Fitted) RestoreDisplay("the viewer switched to another screen");
                    StartHost(s, layout);
                    break;
                }
                case "fit":
                    OnFit(s, m);
                    break;
                case "settings":
                    OnSettings(s, m);
                    break;
                case "video":
                {
                    object on;
                    if (!m.TryGetValue("on", out on) || !(on is bool) || s.VideoOff == !(bool)on) break;
                    s.VideoOff = !(bool)on;
                    var vm = new Dictionary<string, object>();
                    vm["t"] = "video";
                    vm["on"] = !s.VideoOff;
                    if (s.Host != null) s.Host.Post(vm);
                    break;
                }
                case "clip":
                    OnViewerClip(s, m);
                    break;
                case "lock":
                    Log.Write("Remote control: " + s.ViewerName + " locks this PC");
                    if (app.Cfg.CustomPath) Log.Write("Remote control: (a test instance doesn't really lock)");
                    else LockWorkStation();
                    break;
                case "hello":
                    Log.Write("Remote control: the viewer is " + (Json.Str(m, "app") ?? "web") + " (protocol " + Json.Long(m, "v", 0) + ")");
                    break;
            }
        }

        void SendCtl(RcSession s, Dictionary<string, object> msg)
        {
            if (s.Host == null || !s.Verified) return;
            var d = new Dictionary<string, object>();
            d["t"] = "send";
            d["ch"] = "ctl";
            d["m"] = msg;
            s.Host.Post(d);
        }

        // ------------------------------------------------------------------ the viewer's screen and picture (Beam 1.8)

        // The viewer asks for this screen to suit its own (`on`: its picture area w×h in physical pixels, its scaling
        // dpr) or to be as it was. The latest wish wins; one change at a time (FitNow).
        void OnFit(RcSession s, Dictionary<string, object> m)
        {
            if (!Json.Bool(m, "on", false)) s.Fit = null;
            else
            {
                long w = Json.Long(m, "w", 0), h = Json.Long(m, "h", 0);
                double dpr = Json.Double(m, "dpr", 1);
                if (w < 200 || h < 200 || w > 16384 || h > 16384 || !(dpr >= 0.5 && dpr <= 8)) return;
                var wish = new RcFitWish();
                wish.W = (int)w;
                wish.H = (int)h;
                wish.Dpr = dpr;
                wish.Scale = Json.Bool(m, "scale", false);
                s.Fit = wish;
            }
            FitNow(s);
        }

        async void FitNow(RcSession s)
        {
            if (s.Fitting) return; // the loop takes the latest wish
            s.Fitting = true;
            try
            {
                for (int round = 0; round < 10 && current == s && s.State != RcState.Ended; round++)
                {
                    var wish = s.Fit;
                    string key = wish != null ? wish.Key + "#" + s.Screen : "";
                    if (key == (s.FitDone ?? "")) break;
                    s.FitDone = key;
                    s.FitNote = null;
                    await displayGate.WaitAsync();
                    bool changed = false;
                    try
                    {
                        if (current != s || s.State == RcState.Ended) break;
                        NoteDisplayChange();
                        if (wish == null) changed = await UndoDisplay("the viewer turned Fit off");
                        else changed = await ApplyFit(s, wish);
                        if (changed) NoteDisplayChange();
                    }
                    catch (Exception ex) { Log.Error("Remote control: fitting the screen", ex); s.FitNote = "Beam couldn't change this screen"; }
                    finally { displayGate.Release(); }
                    if (current == s) SendDisplay(s);
                    // (1.11.4) The capture again after a change: Windows' sharing bar is drawn for the new scaling (it
                    // stayed as it was, cut off), and a capture the change ended goes on.
                    if (changed) CaptureAgain(s, "this screen changed");
                }
            }
            finally { s.Fitting = false; }
        }

        // (inside displayGate) A screen fitted before goes back first; the original is written down before anything
        // changes, so a Beam that is ended meanwhile puts it back at its next start.
        // Whether the screen changed.
        async Task<bool> ApplyFit(RcSession s, RcFitWish wish)
        {
            var sc = DesktopLayout.Current().Screen(s.Screen);
            if (sc == null) { s.FitNote = "Beam can't find this screen"; return false; }
            bool changed = false;
            if (display.Fitted && !string.Equals(display.Original.Device, sc.Device, StringComparison.OrdinalIgnoreCase)) changed = await UndoDisplay("another screen is shared now");
            var plan = display.Plan(sc.Device, wish.W, wish.H, wish.Dpr, wish.Scale);
            if (plan == null) { s.FitNote = "Windows didn't say which sizes this screen can have"; return changed; }
            if (!display.Fitted)
            {
                var left = SavedDisplay.Parse(app.Cfg.RcDisplayRestore); // (not put back yet: that one is the real original)
                if (left != null && string.Equals(left.Device, plan.Device, StringComparison.OrdinalIgnoreCase)) plan.Original = left;
                app.Cfg.RcDisplayRestore = plan.Original.ToString();
                app.Cfg.Save();
            }
            display.Begin(plan);
            s.FitNote = await Task.Run(() => display.Apply(plan));
            if (s.FitNote != null) Log.Write("Remote control: " + s.FitNote);
            await Task.Delay(300); // Windows tells every window first; then the new size is read
            if (injector != null) injector.LayoutChanged();
            return changed || plan.Changed;
        }

        // (inside displayGate) The fitted screen as it was. If Windows refuses, the config keeps it for the next start.
        // Whether anything was fitted.
        async Task<bool> UndoDisplay(string why)
        {
            var saved = display.Original;
            if (saved == null) return false;
            bool ok = await Task.Run(() => display.Undo(saved, why));
            display.End();
            if (ok) { app.Cfg.RcDisplayRestore = null; app.Cfg.Save(); }
            if (injector != null) injector.LayoutChanged();
            return true;
        }

        async void RestoreDisplay(string why)
        {
            await displayGate.WaitAsync();
            try { await UndoDisplay(why); }
            catch (Exception ex) { Log.Error("Remote control: putting the screen back", ex); }
            finally { displayGate.Release(); }
        }

        // A screen still fitted when Beam last closed (ended by force, or Windows shut down first): the resolution went
        // back by itself; its scaling goes back now.
        async void RestoreLeftoverDisplay()
        {
            if (string.IsNullOrEmpty(app.Cfg.RcDisplayRestore)) return;
            var left = SavedDisplay.Parse(app.Cfg.RcDisplayRestore);
            if (left == null) { app.Cfg.RcDisplayRestore = null; app.Cfg.Save(); return; }
            await displayGate.WaitAsync();
            try
            {
                if (display.Fitted) return; // (a session fitted it again meanwhile, and keeps this original)
                bool ok = await Task.Run(() => display.Undo(left, "Beam closed before it could"));
                if (ok && !display.Fitted) { app.Cfg.RcDisplayRestore = null; app.Cfg.Save(); }
            }
            catch (Exception ex) { Log.Error("Remote control: putting the screen back", ex); }
            finally { displayGate.Release(); }
        }

        // After a fit or a restore: the screens' sizes now (input maps to them), and whether this one is fitted.
        void SendDisplay(RcSession s)
        {
            var d = new Dictionary<string, object>();
            d["t"] = "display";
            d["monitors"] = MonitorList(DesktopLayout.Current());
            d["monitor"] = s.Screen;
            d["fitted"] = display.Fitted;
            if (s.FitNote != null) d["note"] = s.FitNote;
            SendCtl(s, d);
        }

        static readonly string[] PictureModes = { "auto", "text", "motion", "saver" };
        static readonly string[] PictureSizes = { "auto", "full", "1080", "720", "window" };
        static readonly string[] PictureCodecs = { "auto", "av1", "h264", "vp9" };
        static string OneOf(string v, string[] allowed) { return v != null && Array.IndexOf(allowed, v) >= 0 ? v : allowed[0]; }

        // The viewer's picture settings, checked, for the capture page (and for a new one after a switch of screens).
        void OnSettings(RcSession s, Dictionary<string, object> m)
        {
            var c = new Dictionary<string, object>();
            c["t"] = "settings";
            c["mode"] = OneOf(Json.Str(m, "mode"), PictureModes);
            c["size"] = OneOf(Json.Str(m, "size"), PictureSizes);
            c["vw"] = Math.Max(0L, Math.Min(16384L, Json.Long(m, "vw", 0)));
            c["vh"] = Math.Max(0L, Math.Min(16384L, Json.Long(m, "vh", 0)));
            long fps = Json.Long(m, "fps", 0), kbps = Json.Long(m, "kbps", 0);
            c["fps"] = fps == 15 || fps == 30 || fps == 60 ? fps : 0L;
            c["kbps"] = kbps >= 500 && kbps <= 100000 ? kbps : 0L;
            c["codec"] = OneOf(Json.Str(m, "codec"), PictureCodecs);
            c["net"] = Json.Str(m, "net") == "cellular" ? "cellular" : "";
            if (s.Settings == null || PictureText(s.Settings) != PictureText(c)) Log.Write("Remote control: the viewer's picture settings: " + PictureText(c));
            s.Settings = c;
            if (s.Host != null) s.Host.Post(c);
        }

        static string PictureText(Dictionary<string, object> c)
        {
            return string.Format(CultureInfo.InvariantCulture, "{0}, size {1}, {2} fps, {3} kbps, codec {4}{5}", c["mode"], c["size"],
                Convert.ToInt64(c["fps"], CultureInfo.InvariantCulture) == 0 ? "auto" : c["fps"], Convert.ToInt64(c["kbps"], CultureInfo.InvariantCulture) == 0 ? "auto" : c["kbps"],
                c["codec"], (string)c["net"] == "cellular" ? ", on mobile data" : "");
        }

        // ------------------------------------------------------------------ every second while a session lasts

        void Tick()
        {
            var s = current;
            if (s == null) { tick.Stop(); return; }
            if (s.State == RcState.Checking) return;
            // No banner, no session: closed by any means (or gone), it ends; otherwise it stays on top.
            if (s.Banner == null || !s.Banner.Up) { End(s, "stopped", "the banner was closed"); return; }
            s.Banner.KeepOnTop();
            if (DateTime.Now - s.LastLease > TimeSpan.FromSeconds(75)) { End(s, null, "no lease for over a minute"); return; }
            if (s.State != RcState.Live || !s.Verified) return;
            // A viewer that stopped answering may have left keys down: let go after 5 s.
            if (injector != null && injector.Holding && DateTime.Now - s.LastPong > TimeSpan.FromSeconds(5)) injector.ReleaseAll("no answer from the viewer for 5 s");
            if (++s.Pings % 2 == 0)
            {
                var ping = new Dictionary<string, object>();
                ping["t"] = "ping";
                ping["n"] = s.Pings / 2;
                ping["at"] = Fmt.NowMs();
                SendCtl(s, ping);
            }
            // What the viewer's input can reach: an elevated window or a secure desktop takes none.
            bool secure = InputTarget.SecureDesktop(), elevated = !secure && InputTarget.ForegroundElevated();
            string state = Locked + "|" + secure + "|" + elevated;
            if (state != s.LastState)
            {
                s.LastState = state;
                var st = new Dictionary<string, object>();
                st["t"] = "state";
                st["locked"] = Locked;
                st["secure"] = secure;
                st["elevated"] = elevated;
                SendCtl(s, st);
            }
            if (s.Clip && ClipPayload.IsolatedDir != null) CheckClipboard(s); // tests: the "clipboard" is a file
            if (!s.PathChecking && s.PathNext != DateTime.MinValue && DateTime.Now >= s.PathNext) CheckPath(s);
        }

        // (1.11) How Tailscale reaches the viewer (this PC's own `tailscale status`): the viewer shows it, since a relay
        // adds delay. Asked 2, 10 and 30 s into the session (a connection often starts relayed and goes direct within
        // seconds), then every 30 s; told to the viewer when it changes.
        async void CheckPath(RcSession s)
        {
            s.PathChecking = true;
            var age = DateTime.Now - s.LiveSince;
            s.PathNext = DateTime.Now.AddSeconds(age < TimeSpan.FromSeconds(9) ? 8 : age < TimeSpan.FromSeconds(29) ? 20 : 30);
            try
            {
                var p = await tailnet.Path(s.CheckedIp);
                if (current != s || p == null || p.Key == s.PathKey) return;
                s.PathKey = p.Key;
                Log.Write("Remote control: Tailscale reaches " + RcPolicy.DisplayName(s.ViewerName) + " " + p.Describe());
                var m = new Dictionary<string, object>();
                m["t"] = "path";
                m["via"] = p.Via;
                m["lan"] = p.Lan;
                if (p.Relay != null) m["relay"] = p.Relay;
                SendCtl(s, m);
            }
            catch (Exception ex) { Log.Error("Remote control: the path", ex); }
            finally { s.PathChecking = false; }
        }

        // ------------------------------------------------------------------ ending

        // The banner's Stop, the tray, a test: this PC ends it.
        public void Stop(string from)
        {
            if (current != null) End(current, "stopped", from);
        }

        // Ctrl+Alt+Shift+F12: every session ends at once.
        public void KillSwitch(string from)
        {
            Log.Write("Remote control: kill switch (" + from + ")");
            if (current != null) End(current, "stopped", "the kill switch");
        }

        // Ends a session here: the viewer hears `bye`, the server `/end` (with reason; null when it already knows), and
        // everything held is let go.
        void End(RcSession s, string reason, string why)
        {
            if (s == null || s.State == RcState.Ended) return;
            bool live = s.State == RcState.Live;
            s.State = RcState.Ended;
            Finished(s.Id);
            if (current == s) current = null;
            if (injector != null) injector.ReleaseAll("the session ended");
            var host = s.Host;
            s.Host = null;
            if (host != null)
            {
                var ignored = host.End(reason ?? "stopped"); // bye to the viewer, the capture stops, then it closes
            }
            if (s.Banner != null) { s.Banner.CloseBanner(); s.Banner = null; }
            ClipWatch(false);
            if (display.Fitted && !closing) RestoreDisplay("the session ended"); // (quitting: Quit puts it back itself)
            if (current == null)
            {
                KeepAwake(false);
                UnregisterKillSwitch();
                leaseTimer.Stop();
                tick.Stop();
                flushTimer.Stop();
            }
            if (reason != null) PostEnd(s.Id, s.Api, reason);
            if (live) Log.Write("Remote control: " + s.ViewerName + " stopped controlling this PC after " + Duration(DateTime.Now - s.LiveSince) + " (" + why + ")");
            else Log.Write("Remote control: " + s.ViewerName + "'s request ended before it was live (" + why + ")");
            app.MarkChanged();
        }

        static string Duration(TimeSpan t)
        {
            if (t.TotalSeconds < 60) return Math.Max(1, (int)Math.Round(t.TotalSeconds)) + " s";
            if (t.TotalMinutes < 60) return (int)Math.Round(t.TotalMinutes) + " min";
            return t.TotalHours.ToString("0.0", CultureInfo.InvariantCulture) + " h";
        }

        // POST /end { reason }. `not-listed` needs a 1.6 server that knows it; an older one gets `declined`.
        async void PostEnd(string id, Api api, string reason)
        {
            if (api == null) return;
            var body = new Dictionary<string, object>();
            body["reason"] = reason;
            bool retry = false;
            try { await api.Call(HttpMethod.Post, "/api/rc/sessions/" + id + "/end", body, 15, CancellationToken.None); }
            catch (ApiException ex) { retry = ex.Status == 400 && reason != "declined" && reason != "stopped"; }
            catch (Exception ex) { Log.Write("Remote control: couldn't tell the server it ended (" + Api.Describe(ex) + ")"); }
            if (!retry) return;
            body["reason"] = "declined";
            try { await api.Call(HttpMethod.Post, "/api/rc/sessions/" + id + "/end", body, 15, CancellationToken.None); } catch { }
        }

        // Quitting: sessions end (the server hears it if it answers within a moment).
        public void Quit()
        {
            closing = true;
            var s = current;
            if (s != null)
            {
                var api = s.Api;
                string id = s.Id;
                End(s, null, "Beam quit");
                var body = new Dictionary<string, object>();
                body["reason"] = "stopped";
                if (api != null) Pending.Add(Task.Run(async () => { try { await api.Call(HttpMethod.Post, "/api/rc/sessions/" + id + "/end", body, 3, CancellationToken.None); } catch { } }));
            }
            // A fitted screen goes back now, on this thread (no other is waiting on it). Should this fail, the
            // resolution goes back as Beam exits, and the scaling at its next start.
            if (display.Fitted)
            {
                try { if (display.Undo(display.Original, "Beam quit")) { app.Cfg.RcDisplayRestore = null; app.Cfg.Save(); } }
                catch (Exception ex) { Log.Error("Remote control: putting the screen back", ex); }
                display.End();
            }
            SystemEvents.PowerModeChanged -= OnPower;
            SystemEvents.DisplaySettingsChanged -= OnDisplaySettings;
            RcHost.CloseAll();
            UnregisterKillSwitch();
            window.DestroyHandle();
        }

        // ------------------------------------------------------------------ the kill switch, keep-awake, power

        void RegisterKillSwitch()
        {
            if (app.Cfg.CustomPath || app.Cfg.Quiet) { Log.Write("Remote control: the kill switch hotkey isn't registered by a test instance"); return; }
            if (killKeys == null) killKeys = new Hotkeys();
            if (killKeys.IsRegistered("kill")) return;
            if (!killKeys.Set("kill", KillKeys, () => KillSwitch(KillKeys))) Log.Write("Remote control: " + KillKeys + " is taken by another app; the banner's Stop still works");
        }

        void UnregisterKillSwitch()
        {
            if (killKeys != null) killKeys.Set("kill", "", null);
        }

        void KeepAwake(bool on)
        {
            if (on == awake) return;
            awake = on;
            // While someone is controlling this PC, neither it nor its display sleeps.
            SetThreadExecutionState(on ? (ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED) : ES_CONTINUOUS);
        }

        static bool OnBattery()
        {
            try
            {
                var ps = SystemInformation.PowerStatus;
                return ps.PowerLineStatus == PowerLineStatus.Offline && (ps.BatteryChargeStatus & BatteryChargeStatus.NoSystemBattery) == 0;
            }
            catch { return false; }
        }

        void OnPower(object sender, PowerModeChangedEventArgs e)
        {
            if (e.Mode != PowerModes.StatusChange) return;
            app.Post(() =>
            {
                var s = current;
                if (s == null || s.Host == null) return;
                var m = new Dictionary<string, object>();
                m["t"] = "battery";
                m["on"] = OnBattery();
                s.Host.Post(m);
            });
        }

        // ------------------------------------------------------------------ from Remote Desktop to this PC's screen

        // Signed in through Remote Desktop, this session isn't on the PC's own screen, so Beam's control sees a locked
        // PC. The tray's "Back to this PC's screen" (Beam 1.7.5, the user's request) moves it there with Windows' tscon.
        // That needs administrator rights, so Windows asks every time; the program has no window and ends at once.
        // Remote Desktop's window on the other computer then closes.
        public static bool InRemoteDesktop { get { return SystemInformation.TerminalServerSession; } }

        public void BackToScreen()
        {
            int session = Process.GetCurrentProcess().SessionId;
            string dir = Environment.Is64BitOperatingSystem && !Environment.Is64BitProcess ? "Sysnative" : "System32";
            var psi = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), dir, "tscon.exe"), session + " /dest:console");
            psi.UseShellExecute = true;
            psi.Verb = "runas";
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            try
            {
                Process.Start(psi);
                Log.Write("Remote Desktop: this session (" + session + ") goes back to this PC's own screen");
            }
            catch (System.ComponentModel.Win32Exception ex)
            {
                if (ex.NativeErrorCode == 1223) Log.Write("Remote Desktop: back to this PC's screen, cancelled at Windows' prompt");
                else Log.Error("Remote Desktop: back to this PC's screen", ex);
            }
        }

        // ------------------------------------------------------------------ lock and console (WTS)

        void ReadLockState()
        {
            try
            {
                IntPtr buf;
                int bytes;
                if (WTSQuerySessionInformation(IntPtr.Zero, -1, 25 /* WTSSessionInfoEx */, out buf, out bytes))
                {
                    // WTSINFOEXW: Level, then (8-aligned) SessionId, SessionState, SessionFlags: 0 = WTS_SESSIONSTATE_LOCK.
                    try { if (bytes >= 20 && Marshal.ReadInt32(buf) == 1) lockFlag = Marshal.ReadInt32(buf, 16) == 0; }
                    finally { WTSFreeMemory(buf); }
                }
                uint mine;
                if (ProcessIdToSessionId((uint)Process.GetCurrentProcess().Id, out mine)) onConsole = WTSGetActiveConsoleSessionId() == mine;
            }
            catch (Exception ex) { Log.Error("Remote control: the session's lock state", ex); }
        }

        // WM_WTSSESSION_CHANGE: locked, unlocked, or the console went elsewhere (Remote Desktop, another user).
        public void OnSessionChange(int what)
        {
            bool before = Locked;
            switch (what)
            {
                case 7: lockFlag = true; break;   // WTS_SESSION_LOCK
                case 8: lockFlag = false; break;  // WTS_SESSION_UNLOCK
                default:
                    if (what >= 1 && what <= 4) ReadLockState(); // console or remote connect / disconnect
                    break;
            }
            LockChanged(before);
        }

        // Tests: as if Windows locked or unlocked this session.
        public void TestLock(bool on)
        {
            bool before = Locked;
            testLock = on;
            Log.Write("Remote control: (test) session " + (on ? "locked" : "unlocked"));
            LockChanged(before);
        }

        void LockChanged(bool before)
        {
            if (Locked == before) return;
            Log.Write("Remote control: this PC is " + (Locked ? "locked" : "unlocked") + (Allowed ? "" : " (remote control is off)"));
            if (Locked && current != null) End(current, "locked", "this PC was locked");
            if (Allowed) app.StatusNow(Locked ? "locked" : "unlocked");
        }

        public void OnDisplayChange()
        {
            if (injector != null) injector.LayoutChanged();
        }

        // ------------------------------------------------------------------ clipboard (text, opt-in per session)

        void OnViewerClip(RcSession s, Dictionary<string, object> m)
        {
            object on;
            if (m.TryGetValue("on", out on) && on is bool)
            {
                s.Clip = (bool)on;
                Log.Write("Remote control: clipboard sync " + (s.Clip ? "on" : "off") + " (the viewer's choice)");
                ClipWatch(s.Clip);
                clipSeen = 0;
                if (s.Clip) CheckClipboard(s); // what's on it now goes too, as with Remote Desktop
                return;
            }
            if (!s.Clip) return;
            string text = Json.Str(m, "text");
            if (string.IsNullOrEmpty(text) || Encoding.UTF8.GetByteCount(text) > 64 * 1024) return;
            clipLast = text.Replace("\r\n", "\n");
            if (ClipPayload.SetRemoteText(text, app.Cfg.ClipboardHistory)) Log.Write("Remote control: the viewer's clipboard text is on this PC's clipboard (" + text.Length + " characters)");
        }

        void ClipWatch(bool on)
        {
            if (ClipPayload.IsolatedDir != null) return; // tests: Tick looks at the file
            window.Clipboard(on);
        }

        // This PC's clipboard changed (WM_CLIPBOARDUPDATE, or the test file): its text goes to a viewer that asked for
        // it, unless it's marked secret (password managers) or too big.
        public void CheckClipboardNow()
        {
            var s = current;
            if (s != null && s.Clip && s.Verified) CheckClipboard(s);
        }

        void CheckClipboard(RcSession s)
        {
            uint seq = ClipPayload.TextSequence();
            if (seq == clipSeen) return;
            clipSeen = seq;
            string text = ClipPayload.ReadSharableText();
            if (text == null) return;
            if (text.Replace("\r\n", "\n") == clipLast) return; // what the viewer just sent
            if (Encoding.UTF8.GetByteCount(text) > 64 * 1024) { Log.Write("Remote control: clipboard text over 64 KB isn't sent"); return; }
            var c = new Dictionary<string, object>();
            c["t"] = "clip";
            c["n"] = (long)seq;
            c["text"] = text;
            SendCtl(s, c);
            Log.Write("Remote control: this PC's clipboard text went to the viewer (" + text.Length + " characters)");
        }

        // ------------------------------------------------------------------ tests (custom --config only)

        public void TestCommand(string cmd)
        {
            string arg = null;
            int colon = cmd.IndexOf(':');
            if (colon > 0) { arg = cmd.Substring(colon + 1); cmd = cmd.Substring(0, colon); }
            switch (cmd)
            {
                case "allow":
                    var ids = arg != null ? arg.Split(',').Where(x => x.Length > 0).ToList()
                        : app.Devices.Where(dv => dv.Id != app.Me && !dv.Temporary).Select(dv => dv.Id).ToList();
                    Allow(ids, "test");
                    break;
                case "devices": SetDevices((arg ?? "").Split(',').Where(x => x.Length > 0).ToList(), null, "test"); break;
                case "repin": SetDevices(app.Cfg.RemoteControlDevices.Select(a => a.Id).ToList(), new List<string> { arg }, "test"); break;
                case "off": SetOff("test"); break;
                case "lock": TestLock(arg == "on"); break;
                case "kill": KillSwitch("test"); break;
                case "trackended": // as if the capture page's track ended just after a display change; :stale = with none lately
                    if (current == null || current.Host == null) { Log.Write("Remote control: (test) no capture"); break; }
                    if (arg == "stale") Interlocked.Exchange(ref displayChanged, 0); else NoteDisplayChange();
                    var te = new Dictionary<string, object>();
                    te["t"] = "ended";
                    te["reason"] = "stopped-sharing";
                    OnPage(current, current.Host, te);
                    break;
                case "stop":
                    if (current != null && current.Banner != null) current.Banner.ClickStopForTest();
                    else Log.Write("Remote control: (test) no banner to click");
                    break;
                case "probe": Probe(); break;
                case "display": // the made-up screen's state and the calls it got (FakeDisplay)
                {
                    var fake = display.Backend as FakeDisplay;
                    Log.Write("Remote control: (test) display " + (fake != null ? fake.State : display.Backend.Name) + (display.Fitted ? " (fitted)" : ""));
                    break;
                }
                case "guard": testClickOnShow = true; break;
                case "banner": // banner[:info|drag:x,y|jump:x,y|hover:on|off|top] (RcBanner.TestCommand)
                    if (current != null && current.Banner != null) current.Banner.TestCommand(arg);
                    else Log.Write("Remote control: (test) no banner");
                    break;
                case "closeviews": app.CloseRemoteViewsForTest(); break;
                case "viewmsg": app.RemoteViewsForTest(arg ?? "{}"); break;
                case "viewreload": app.RemoteViewsForTest(null); break;
                case "showallow": app.ShowRcAllow(null); break;
                case "panel": app.OpenPanelForTest(arg ?? "pair"); break;
            }
        }

        // A capture attempt with no session at all: the gate must refuse it.
        async void Probe()
        {
            var host = new RcHost(app.Cfg, DesktopLayout.Current().SourceName(0), false, () => current != null && CaptureAllowed(current));
            var done = new TaskCompletionSource<string>();
            host.Message += (h, m) =>
            {
                if (Json.Str(m, "t") == "ready") h.Probe();
                if (Json.Str(m, "t") == "probe") done.TrySetResult(Json.Str(m, "result"));
            };
            try
            {
                await host.Start();
                var r = await Task.WhenAny(done.Task, Task.Delay(15000));
                Log.Write("Remote control: (test) a capture without a session: " + (r == done.Task ? done.Task.Result : "no answer"));
            }
            catch (Exception ex) { Log.Error("Remote control: (test) probe", ex); }
            await host.Close();
            Log.Write("Remote control: (test) probe host closed");
        }

        // ------------------------------------------------------------------ native

        const uint ES_CONTINUOUS = 0x80000000, ES_SYSTEM_REQUIRED = 0x00000001, ES_DISPLAY_REQUIRED = 0x00000002;
        [DllImport("kernel32.dll")] static extern uint SetThreadExecutionState(uint flags);
        [DllImport("user32.dll")] static extern bool LockWorkStation();
        [DllImport("user32.dll")] static extern bool GetCursorPos(out CursorPoint point);
        struct CursorPoint { public int X, Y; }
        [DllImport("wtsapi32.dll", EntryPoint = "WTSQuerySessionInformationW", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool WTSQuerySessionInformation(IntPtr server, int session, int infoClass, out IntPtr buffer, out int bytes);
        [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr memory);
        [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
        [DllImport("kernel32.dll")] static extern bool ProcessIdToSessionId(uint pid, out uint session);
    }

    // A hidden top-level window: session changes (lock/unlock), display changes and, while a viewer syncs it, the
    // clipboard.
    class RcWindow : NativeWindow
    {
        readonly RemoteControl rc;
        bool registered, listening;

        public RcWindow(RemoteControl rc)
        {
            this.rc = rc;
            var cp = new CreateParams();
            cp.Caption = "Beam remote control";
            CreateHandle(cp);
            registered = WTSRegisterSessionNotification(Handle, 0 /* NOTIFY_FOR_THIS_SESSION */);
            if (!registered) Log.Write("Remote control: lock notifications aren't available (" + Marshal.GetLastWin32Error() + ")");
        }

        public void Clipboard(bool on)
        {
            if (on == listening || Handle == IntPtr.Zero) return;
            listening = on ? AddClipboardFormatListener(Handle) : !RemoveClipboardFormatListener(Handle);
        }

        protected override void WndProc(ref Message m)
        {
            switch (m.Msg)
            {
                case 0x02B1: rc.OnSessionChange(m.WParam.ToInt32()); break;   // WM_WTSSESSION_CHANGE
                case 0x007E: rc.OnDisplayChange(); break;                    // WM_DISPLAYCHANGE
                case 0x031D: rc.CheckClipboardNow(); break;                  // WM_CLIPBOARDUPDATE
            }
            base.WndProc(ref m);
        }

        public override void DestroyHandle()
        {
            if (Handle != IntPtr.Zero)
            {
                if (registered) WTSUnRegisterSessionNotification(Handle);
                if (listening) RemoveClipboardFormatListener(Handle);
            }
            base.DestroyHandle();
        }

        [DllImport("wtsapi32.dll", SetLastError = true)] static extern bool WTSRegisterSessionNotification(IntPtr hwnd, int flags);
        [DllImport("wtsapi32.dll")] static extern bool WTSUnRegisterSessionNotification(IntPtr hwnd);
        [DllImport("user32.dll", SetLastError = true)] static extern bool AddClipboardFormatListener(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool RemoveClipboardFormatListener(IntPtr hwnd);
    }

    // A device that may control this PC, pinned to the Tailscale node it was on when ticked (or when it first asked).
    class RcAllowed
    {
        public string Id, Name;
        public string Node;      // the node's StableID (this PC's own `tailscale whois`)
        public string Machine;   // its name, for the banner and beam.log
        public long At;

        public static RcAllowed Parse(Dictionary<string, object> d)
        {
            string id = Json.Str(d, "id");
            if (!Config.ValidId(id)) return null;
            var a = new RcAllowed();
            a.Id = id;
            a.Name = Json.Str(d, "name") ?? id;
            a.Node = Json.Str(d, "node");
            a.Machine = Json.Str(d, "machine");
            a.At = Json.Long(d, "at", 0);
            return a;
        }

        public Dictionary<string, object> ToJson()
        {
            var d = new Dictionary<string, object>();
            d["id"] = Id;
            d["name"] = Name;
            d["node"] = Node;
            d["machine"] = Machine;
            d["at"] = At;
            return d;
        }
    }

    // This PC's own view of the tailnet, from the Tailscale CLI (read-only: `status` and `whois`). Tests point a
    // --config instance at a fake CLI.
    class TailnetQuery
    {
        readonly string exe, prefix;

        public class Result
        {
            public string Refusal;   // null: a node of this PC's own Tailscale owner
            public string StableId, Name;
        }

        public TailnetQuery(Config cfg)
        {
            if (cfg.CustomPath && !string.IsNullOrEmpty(cfg.TestTailscaleExe)) { exe = cfg.TestTailscaleExe; prefix = cfg.TestTailscaleArgs ?? ""; }
            else { exe = Discovery.TailscaleExe(); prefix = ""; }
        }

        public async Task<Result> Check(string ip)
        {
            var r = new Result();
            if (!RcPolicy.IsTailscaleIp(ip)) { r.Refusal = "that isn't a Tailscale address"; return r; }
            if (exe == null) { r.Refusal = "Tailscale isn't installed on this PC"; return r; }
            string addr = RcPolicy.Canonical(ip); // a checked address in its plain form: nothing else reaches the command line
            var status = await Run("status --json");
            var whois = await Run("whois --json " + addr);
            if (status == null) { r.Refusal = "Tailscale on this PC didn't answer"; return r; }
            if (whois == null) { r.Refusal = "Tailscale doesn't know that address"; return r; }
            r.Refusal = RcPolicy.OwnerRefusal(whois, status, addr);
            var node = Json.Obj(Json.Get(whois, "Node"));
            r.StableId = Json.Str(node, "StableID");
            string name = Json.Str(node, "ComputedName");
            if (string.IsNullOrEmpty(name)) name = (Json.Str(node, "Name") ?? "").Split('.')[0];
            r.Name = string.IsNullOrEmpty(name) ? addr : RcPolicy.DisplayName(name);
            if (r.Refusal == null && string.IsNullOrEmpty(r.StableId)) r.Refusal = "Tailscale gave no node id";
            return r;
        }

        // (1.11) How Tailscale reaches that address now (RcPolicy.PathOf), or null when it can't tell.
        public async Task<RcPath> Path(string ip)
        {
            if (exe == null || !RcPolicy.IsTailscaleIp(ip)) return null;
            var status = await Run("status --json");
            return status == null ? null : RcPolicy.PathOf(status, RcPolicy.Canonical(ip));
        }

        Task<Dictionary<string, object>> Run(string args)
        {
            string file = exe, line = (prefix.Length > 0 ? prefix + " " : "") + args;
            return Task.Run(() =>
            {
                try
                {
                    var psi = new ProcessStartInfo(file, line);
                    psi.UseShellExecute = false;
                    psi.CreateNoWindow = true;
                    psi.RedirectStandardOutput = true;
                    psi.RedirectStandardError = true;
                    psi.StandardOutputEncoding = Encoding.UTF8;
                    using (var p = Process.Start(psi))
                    {
                        var output = p.StandardOutput.ReadToEndAsync();
                        p.StandardError.ReadToEndAsync();
                        if (!p.WaitForExit(8000)) { try { p.Kill(); } catch { } return null; }
                        if (p.ExitCode != 0) return null;
                        return Json.ParseObject(output.Result);
                    }
                }
                catch { return null; }
            });
        }
    }
}
