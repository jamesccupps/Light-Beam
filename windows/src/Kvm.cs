// Keyboard and mouse across PCs (Beam 1.12; the user: "my laptop kvm, will actually be for the laptop, shop desktop to
// the left of it and the office desktop to the left of that"): this PC's own keyboard and mouse work the PCs beside it.
// The pointer goes off the left edge of this PC's screen and on across theirs, with the keyboard and the clipboard text,
// and comes back the same way.
// - Each PC is a remote control session of kind kvm (server.js; RemoteControl on that PC): the same rules as remote
//   control, its own switch and list, its whois check, its lease and its banner (which can be folded into its tray), and
//   no picture. The sessions stay up while this is on, so a crossing is instant.
// - Low-level hooks (KvmHooks) on a thread of their own: the mouse hook watches for the pointer at the edge; while the
//   pointer is on another PC, this PC's pointer waits hidden in the middle of its screen (KvmCover) and every move,
//   click, wheel and key goes there instead (the pointer's place there is worked out here: KvmGeometry).
// - The ways back, with no special key (the user: "not every keyboard or device has the home key"): the pointer back
//   over the edge (worked out here, so it works even if the other PC stops answering); "Back to <this PC>" in the other
//   PC's tray; and by itself on any trouble: a link that drops or goes quiet (1.5 s without an answer), an error, this PC
//   locked. Ctrl+Alt+Del always stays here, and Beam ending in any way takes its hooks with it.
// - The clipboard's text goes along to a PC when the pointer does, and what is copied there comes back here.
// beam.log gets which PCs, when they're up, and why the pointer came back by itself; never keys or text.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Timer = System.Windows.Forms.Timer;

namespace Beam
{
    // One PC beside this one, and its kvm session.
    class KvmLink
    {
        public readonly string Device;
        public string Session;               // the server's session id while there is one
        public string Ip4, Ip6;              // the PC's Tailscale addresses as the server attested them
        public string State = "off";         // off | asking | connecting | live | waiting (to ask again) | stopped (at that PC)
        public bool Verified;                // the connection's peer passed the check: input may go
        public bool PageQuiet;               // the page's pings went unanswered, or the connection dropped
        public KvmDesk Desk;                 // its screens (its hello)
        public DateTime Since, LastPing, RetryAt;
        public int Fails;
        public string Why;                   // what happened last (the tray, beam.log)
        public string ClipHad;               // the clipboard text it has from here, or gave here (\n line ends)
        public long LeftAt = long.MinValue;  // (clock ms) when the pointer last left it
        public readonly Queue<Dictionary<string, object>> Signals = new Queue<Dictionary<string, object>>();
        public bool Signalling;

        public KvmLink(string device) { Device = device; }

        // Ready for the pointer: live, checked, its screens known, answering (its Beam pings every 2 s).
        public bool Ready { get { return State == "live" && Verified && Desk != null && !Desk.Empty && !PageQuiet && DateTime.Now - LastPing < TimeSpan.FromMilliseconds(KvmController.QuietPingMs); } }
    }

    class KvmController
    {
        public const int MaxPcs = 3;
        public const int QuietPingMs = 6000;  // its Beam's pings (every 2 s) missing this long: not ready
        const int ClipAfterMs = 2000;         // a PC's clipboard counts this long after the pointer left it
        const int MoveEveryMs = 5;            // at most 200 moves a second to a PC (its Beam takes 250)
        const int ConnectSec = 30;            // from asking to its hello
        const int MaxClip = 64 * 1024;

        readonly App app;
        readonly bool test;                    // a test instance: no hooks, no cover, nothing real moves (--test-kvm)
        KvmPage page;
        KvmHooks hooks;
        readonly List<KvmLink> links = new List<KvmLink>();   // nearest first (Cfg.KvmLeft)
        readonly Timer tick, moveTimer;
        bool started, starting;
        int gen;
        readonly Stopwatch clock = Stopwatch.StartNew();

        // What the hook thread works from, swapped whole (never changed in place).
        sealed class Map { public KvmDesk Here; public KvmDesk[] Desks; public bool[] Ready; }
        volatile Map map;

        // Where the pointer is. The hook thread and the window thread both change it, under `gate`.
        readonly object gate = new object();
        int away = -1;                         // -1: on this PC; else the link (index) it's on
        KvmPoint where;                        // ...and where there (its desktop's pixels)
        int parkX, parkY;                      // this PC's own pointer meanwhile: held here, hidden
        double fromScale = 1;                  // this PC's scaling where the pointer left it
        readonly KvmCarry carry = new KvmCarry();
        int buttonsHere, buttonsThere;         // mouse buttons down here, and sent down there (a bit each)
        readonly HashSet<int> heldHere = new HashSet<int>(); // keys down here as the pointer left: their ups stay here
        long seq;                              // mv numbers (btn and wheel carry the latest)
        int testX = 960, testY = 540;          // tests: where this PC's pointer is

        // What the handlers queue for the window thread.
        enum OutKind { Move, Button, Wheel, Key, Enter, Leave }
        sealed class Out
        {
            public OutKind Kind;
            public int Link;
            public KvmPoint At;
            public long N;
            public int B, Dx, Dy;
            public bool Down, Home;
            public string Code, Why;
        }
        readonly ConcurrentQueue<Out> outbox = new ConcurrentQueue<Out>();
        int drainPosted;
        Out heldMove;
        long lastMoveAt = -1000;             // (clock ms; MinValue would overflow "now - last" and hold the first move)

        // The clipboard text this PC got from a PC (Beam marks it not to be shared again), and the clipboard's sequence
        // right after: while that's unchanged, it's still this PC's clipboard text, and goes on to the next PC.
        string clipSet;
        uint clipSetSeq;

        public KvmController(App app)
        {
            this.app = app;
            test = app.Cfg.CustomPath;
            tick = new Timer();
            tick.Interval = 1000;
            tick.Tick += (s, e) => Tick();
            moveTimer = new Timer();
            moveTimer.Interval = 10;
            moveTimer.Tick += (s, e) => { moveTimer.Stop(); Drain(); };
        }

        // ------------------------------------------------------------------ what others see

        public bool On { get { return started; } }
        public bool Away { get { lock (gate) return away >= 0; } }

        // For the tray's tooltip: "Keyboard and mouse on Shop Desktop", or null.
        public string Status
        {
            get
            {
                int i;
                lock (gate) i = away;
                return i >= 0 && i < links.Count ? "Keyboard and mouse on " + NameOf(links[i]) : null;
            }
        }

        // For the tray's submenu: each PC and how it is.
        public List<KeyValuePair<string, string>> LinkStates()
        {
            var list = new List<KeyValuePair<string, string>>();
            foreach (var l in links)
            {
                string s = l.Ready ? "ready" : l.State == "live" ? "not answering" : l.State == "asking" || l.State == "connecting" ? "connecting…"
                    : l.State == "stopped" ? "stopped at that PC" : l.State == "waiting" ? "trying again soon" + (l.Why != null ? " (" + l.Why + ")" : "") : "off";
                list.Add(new KeyValuePair<string, string>(NameOf(l), s));
            }
            return list;
        }

        public bool Owns(string session)
        {
            return session != null && links.Any(l => l.Session == session);
        }

        string NameOf(KvmLink l)
        {
            var d = app.DeviceById(l.Device);
            return d != null ? RcPolicy.DisplayName(d.Name) : "a PC that's no longer in Beam";
        }

        // ------------------------------------------------------------------ on and off

        // On or off as this PC's settings, its sign-in and its server say: "Keyboard and mouse across PCs" on, PCs chosen,
        // signed in, and a server that knows kvm sessions (1.16).
        public void Apply(string why)
        {
            var ids = app.Cfg.KvmLeft.Where(id => id != app.Me).Distinct().Take(MaxPcs).ToList();
            bool want = app.Cfg.KvmOn && ids.Count > 0 && app.Cfg.Paired && app.Api != null && app.ServerHas("kvm");
            if (!want) { if (started || starting) Stop(why); return; }
            if ((started || starting) && links.Select(l => l.Device).SequenceEqual(ids))
            {
                // (the stream came back: a link that was waiting asks now; one stopped at its PC stays stopped)
                if (started && page != null && page.Ready) foreach (var l in links) if (l.State == "waiting") Connect(l);
                return;
            }
            if (started || starting) Stop("the PCs beside this one changed");
            Start(ids, why);
        }

        async void Start(List<string> ids, string why)
        {
            starting = true;
            int g = ++gen;
            links.Clear();
            foreach (var id in ids) links.Add(new KvmLink(id));
            var p = new KvmPage(app.Cfg, app.DevTools);
            page = p;
            p.Message += OnPage;
            try { await p.Start(); }
            catch (Exception ex)
            {
                Log.Error("Keyboard and mouse: the link page", ex);
                if (g == gen) { starting = false; p.Close(); page = null; links.Clear(); }
                return;
            }
            if (g != gen) { p.Close(); return; } // turned off meanwhile
            starting = false;
            started = true;
            Rebuild();
            if (!test) StartHooks();
            tick.Start();
            Log.Write("Keyboard and mouse: on (" + why + "): " + string.Join(", ", links.Select(NameOf)) + " to the left of this PC, nearest first");
            app.MarkChanged();
            // (the page's "ready" asks each PC)
        }

        void StartHooks()
        {
            hooks = new KvmHooks(OnInput);
            hooks.Lost = Lost;
            if (!hooks.Start()) Log.Write("Keyboard and mouse: this PC's mouse can't be watched (the pointer can't cross over)");
        }

        // (the hook thread) Mouse input reached the cover while the pointer was away: the hook isn't keeping it (gone, or
        // an administrator's window in front). The pointer comes back at once, and the hooks are set again.
        void Lost()
        {
            lock (gate)
            {
                if (away < 0) return;
                HomeLocked(0.5, "this PC's own mouse reached it: its hook wasn't keeping it", map);
            }
            app.Post(() =>
            {
                if (!started || test) return;
                if (hooks != null) hooks.Stop();
                StartHooks();
            });
        }

        public void Stop(string why)
        {
            gen++;
            bool was = started || starting;
            ReturnHome(why);
            Drain(); // (the release goes out before the links close)
            tick.Stop();
            moveTimer.Stop();
            if (hooks != null) { hooks.Stop(); hooks = null; } // (the cover goes with its thread)
            foreach (var l in links) Close(l, "stopped");
            links.Clear();
            if (page != null) { page.Close(); page = null; }
            started = starting = false;
            map = null;
            if (was) Log.Write("Keyboard and mouse: off (" + why + ")");
            app.MarkChanged();
        }

        public void Quit() { Stop("Beam quit"); }

        // The tray's "On" (no PCs chosen yet: the settings).
        public void Toggle(string from)
        {
            if (!app.Cfg.KvmOn && app.Cfg.KvmLeft.Count == 0) { ShowSettings(); return; }
            app.Cfg.KvmOn = !app.Cfg.KvmOn;
            app.Cfg.Save();
            Log.Write("Keyboard and mouse across PCs turned " + (app.Cfg.KvmOn ? "on" : "off") + " (" + from + ")");
            Apply(from);
        }

        KvmForm form;
        public void ShowSettings()
        {
            if (form != null && !form.IsDisposed) { form.Show(); form.Activate(); return; }
            form = new KvmForm(app);
            form.Show();
        }

        // ------------------------------------------------------------------ a link's session

        async void Connect(KvmLink l)
        {
            if (!started || page == null || !page.Ready || l.State == "asking" || l.State == "connecting" || l.State == "live" || l.State == "stopped") return;
            var api = app.Api;
            if (api == null) { Wait(l, 15, "not connected to Beam"); return; }
            l.State = "asking";
            l.Since = DateTime.Now;
            l.Why = null;
            object r;
            try
            {
                var body = new Dictionary<string, object>();
                body["device"] = l.Device;
                body["kind"] = "kvm";
                r = await api.Call(HttpMethod.Post, "/api/rc/sessions", body, 15, CancellationToken.None);
            }
            catch (ApiException ex)
            {
                if (!links.Contains(l) || l.State != "asking") return;
                string reason = Json.Str(ex.Body, "reason") ?? "";
                l.Fails++;
                int wait = reason == "busy" ? 60 : reason == "offline" || reason == "locked" ? 30 : reason == "not-allowed" || reason == "old-app" || reason == "not-owner" ? 300
                    : ex.Status == 429 ? 60 : Backoff(l);
                Wait(l, wait, ex.Message);
                return;
            }
            catch (Exception ex)
            {
                if (!links.Contains(l) || l.State != "asking") return;
                l.Fails++;
                Wait(l, Backoff(l), Api.Describe(ex));
                return;
            }
            var d = Json.Obj(r);
            string id = Json.Str(d, "id");
            var host = Json.Obj(Json.Get(d, "host"));
            string ip4 = Json.Str(host, "ip4"), ip6 = Json.Str(host, "ip6");
            if (!links.Contains(l) || l.State != "asking" || !started)
            {
                if (id != null) PostEnd(api, id, "stopped");
                return;
            }
            if (id == null || id.Length != 16) { l.Fails++; Wait(l, Backoff(l), "the server's answer had no session"); return; }
            l.Session = id;
            l.Ip4 = RcPolicy.IsTailscaleIp(ip4) ? ip4 : null;
            l.Ip6 = RcPolicy.IsTailscaleIp(ip6) ? ip6 : null;
            if (l.Ip4 == null && l.Ip6 == null) { Fail(l, "the server knows no Tailscale address of it"); return; }
            l.State = "connecting";
            l.Verified = false;
            l.PageQuiet = false;
            l.Desk = null;
            var m = new Dictionary<string, object>();
            m["t"] = "open";
            m["link"] = id;
            var peer = new Dictionary<string, object>();
            peer["ip4"] = l.Ip4;
            peer["ip6"] = l.Ip6;
            m["peer"] = peer;
            page.Post(m);
        }

        static int Backoff(KvmLink l) { return (int)Math.Min(300, 5 * Math.Pow(2, Math.Max(0, Math.Min(6, l.Fails - 1)))); }

        void Wait(KvmLink l, int seconds, string why)
        {
            l.State = "waiting";
            l.RetryAt = DateTime.Now.AddSeconds(seconds);
            l.Why = why;
            Log.Write("Keyboard and mouse: " + NameOf(l) + " isn't connected (" + why + "); asking again in " + seconds + " s");
            app.MarkChanged();
        }

        // Its session ends here (told to the server; its page link closes). The pointer comes back first if it's there.
        void Close(KvmLink l, string reason)
        {
            if (AwayOn(l)) { ReturnHome(NameOf(l) + "'s link closed"); Drain(); }
            string sid = l.Session;
            l.Session = null;
            l.Verified = false;
            l.Desk = null;
            l.Signals.Clear();
            if (sid != null)
            {
                if (page != null) { var m = new Dictionary<string, object>(); m["t"] = "close"; m["link"] = sid; page.Post(m); }
                if (reason != null && app.Api != null) PostEnd(app.Api, sid, reason);
            }
            l.State = "off";
            Rebuild();
        }

        // Something went wrong with it: ended, and asked again after a while.
        void Fail(KvmLink l, string why, string reason = "failed")
        {
            Close(l, reason);
            l.Fails++;
            Wait(l, Backoff(l), why);
        }

        static async void PostEnd(Api api, string id, string reason)
        {
            var body = new Dictionary<string, object>();
            body["reason"] = reason;
            try { await api.Call(HttpMethod.Post, "/api/rc/sessions/" + id + "/end", body, 15, CancellationToken.None); }
            catch { } // (the server ends it on its own when the PC's lease stops, or it ended already)
        }

        // rc-signal and rc-end for one of this PC's sessions as the viewer (App sends them here).
        public void OnEvent(string name, Dictionary<string, object> d)
        {
            string id = Json.Str(d, "id");
            var l = links.FirstOrDefault(x => x.Session != null && x.Session == id);
            if (l == null) return;
            if (name == "rc-signal")
            {
                if (Json.Str(d, "from") != l.Device || page == null) return; // only from that PC
                string kind = Json.Str(d, "kind");
                if (kind != "offer" && kind != "candidates") return;
                var m = new Dictionary<string, object>();
                m["t"] = "signal";
                m["link"] = id;
                m["kind"] = kind;
                if (kind == "offer") m["sdp"] = Json.Str(d, "sdp");
                else m["candidates"] = Json.Get(d, "candidates");
                page.Post(m);
            }
            else if (name == "rc-end") OnEnded(l, Json.Str(d, "reason") ?? "stopped", Json.Str(d, "from"), Json.Str(d, "by"));
        }

        void OnEnded(KvmLink l, string reason, string from, string by)
        {
            string who = by != null ? RcPolicy.DisplayName(by) : "another device";
            Close(l, null); // (the server knows)
            if (reason == "stopped" && from == app.Me) { l.State = "off"; return; } // (this PC's own: it asked again, or stopped)
            if (reason == "stopped")
            {
                // Stopped at that PC (its banner or tray), or from another device: not asked again until this is turned
                // off and on.
                l.State = "stopped";
                l.Why = from == l.Device ? "stopped at that PC" : "ended from " + who;
                Log.Write("Keyboard and mouse: " + NameOf(l) + " ended it (" + l.Why + "); it isn't asked again until keyboard and mouse across PCs is turned off and on");
                app.Notify("Keyboard and mouse: " + NameOf(l) + " ended it", "To use it again, turn \"Keyboard and mouse across PCs\" off and on in Beam's menu.");
                app.MarkChanged();
                return;
            }
            l.Fails++;
            if (reason == "busy") Wait(l, 60, who + " is controlling it");
            else if (reason == "revoked") Wait(l, 300, "remote control was turned off on it, or a sign-in was revoked");
            else if (reason == "locked") Wait(l, 30, "it was locked");
            else if (reason == "lease" || reason == "server") Wait(l, 10, reason == "lease" ? "it stopped answering Beam" : "the Beam server restarted");
            else if (reason == "not-listed") Wait(l, 300, "this PC isn't on its list of devices that may control it");
            else Wait(l, Backoff(l), reason);
        }

        // ------------------------------------------------------------------ the page

        void OnPage(Dictionary<string, object> m)
        {
            string t = Json.Str(m, "t");
            if (t == "ready") { foreach (var x in links) Connect(x); return; }
            if (t == "log") { string line = Json.Str(m, "m") ?? ""; Log.Write("Keyboard and mouse page: " + (line.Length > 200 ? line.Substring(0, 200) : line)); return; }
            if (t == "failed")
            {
                Log.Write("Keyboard and mouse: its page stopped (" + Json.Str(m, "why") + "); starting again in 5 s");
                Stop("its page stopped");
                var again = new Timer();
                again.Interval = 5000;
                again.Tick += (s, e) => { again.Stop(); again.Dispose(); Apply("its page stopped"); };
                again.Start();
                return;
            }
            string id = Json.Str(m, "link");
            var l = links.FirstOrDefault(x => x.Session != null && x.Session == id);
            if (l == null) return;
            switch (t)
            {
                case "answer":
                {
                    string sdp = Json.Str(m, "sdp");
                    if (string.IsNullOrEmpty(sdp) || sdp.Length > 64 * 1024) return;
                    var b = new Dictionary<string, object>();
                    b["kind"] = "answer";
                    b["sdp"] = sdp;
                    QueueSignal(l, b);
                    break;
                }
                case "cands":
                {
                    var list = Json.Get(m, "candidates") as object[];
                    if (list == null || list.Length == 0) return;
                    for (int i = 0; i < list.Length; i += 20) // the server takes 20 a signal
                    {
                        var b = new Dictionary<string, object>();
                        b["kind"] = "candidates";
                        b["candidates"] = list.Skip(i).Take(20).ToArray();
                        QueueSignal(l, b);
                    }
                    break;
                }
                case "state": OnState(l, m); break;
                case "ctl": OnCtl(l, Json.ParseObject(Json.Str(m, "d"))); break;
                case "quiet":
                    if (l.PageQuiet) break;
                    l.PageQuiet = true;
                    Log.Write("Keyboard and mouse: " + NameOf(l) + " stopped answering");
                    Rebuild();
                    if (AwayOn(l)) ReturnHome(NameOf(l) + " stopped answering");
                    break;
                case "alive":
                    if (!l.PageQuiet) break;
                    l.PageQuiet = false;
                    Log.Write("Keyboard and mouse: " + NameOf(l) + " answers again");
                    Rebuild();
                    break;
            }
        }

        void QueueSignal(KvmLink l, Dictionary<string, object> body)
        {
            if (l.Signals.Count > 60) return;
            l.Signals.Enqueue(body);
            if (!l.Signalling) SendSignals(l, l.Session);
        }

        // One at a time, in order: the PC must get the answer before the candidates that follow it.
        async void SendSignals(KvmLink l, string sid)
        {
            l.Signalling = true;
            try
            {
                while (l.Signals.Count > 0 && l.Session == sid && sid != null)
                {
                    var body = l.Signals.Dequeue();
                    var api = app.Api;
                    if (api == null) return;
                    try { await api.Call(HttpMethod.Post, "/api/rc/sessions/" + sid + "/signal", body, 15, CancellationToken.None); }
                    catch (ApiException ex)
                    {
                        if ((ex.Status == 410 || ex.Status == 404) && l.Session == sid) { OnEnded(l, Json.Str(ex.Body, "reason") ?? "failed", null, null); return; }
                        Log.Write("Keyboard and mouse: a signal to " + NameOf(l) + " was refused (" + ex.Status + ")");
                    }
                    catch (Exception ex) { Log.Write("Keyboard and mouse: a signal to " + NameOf(l) + " didn't go out (" + Api.Describe(ex) + ")"); }
                }
            }
            finally { l.Signalling = false; }
        }

        // The connection is up (or its path changed): its peer must be one of the PC's attested addresses.
        void OnState(KvmLink l, Dictionary<string, object> m)
        {
            string pc = Json.Str(m, "pc");
            if (pc == "failed" || pc == "closed")
            {
                if (l.State == "connecting" || l.State == "live") Fail(l, "the connection " + pc);
                return;
            }
            if (pc == "disconnected")
            {
                // (the PC starts ICE over after 3 s and offers again; meanwhile not ready)
                if (!l.PageQuiet) { l.PageQuiet = true; Rebuild(); }
                if (AwayOn(l)) ReturnHome("the connection to " + NameOf(l) + " dropped");
                return;
            }
            if (pc != "connected") return;
            string remote = Json.Str(m, "remoteIp");
            string why = RcPolicy.PeerRefusal(remote, l.Ip4, l.Ip6);
            if (why != null)
            {
                Log.Write("Keyboard and mouse: hung up on " + NameOf(l) + ": the connection's peer failed the check (" + why + ", a " + (Json.Str(m, "type") ?? "?") + " candidate)");
                Fail(l, "the connection's peer failed the check");
                return;
            }
            if (l.Verified)
            {
                if (l.PageQuiet) { l.PageQuiet = false; Rebuild(); }
                return; // a new path to the same peer
            }
            l.Verified = true;
            var hello = new Dictionary<string, object>();
            hello["t"] = "hello";
            hello["v"] = 1;
            hello["role"] = "viewer";
            hello["app"] = "windows";
            hello["version"] = AppVersion.Text;
            hello["kvm"] = true;
            var v = new Dictionary<string, object>();
            v["t"] = "verified";
            v["link"] = l.Session;
            v["hello"] = hello;
            page.Post(v);
            // (its own hello, after its own check, has its screens: then it's ready)
        }

        // What a PC says on ctl (already past both checks).
        void OnCtl(KvmLink l, Dictionary<string, object> m)
        {
            if (m == null) return;
            switch (Json.Str(m, "t"))
            {
                case "hello":
                {
                    var desk = DeskOf(Json.Get(m, "monitors"));
                    if (desk.Empty) { Fail(l, "it told no screens"); return; }
                    bool first = l.State != "live";
                    l.Desk = desk;
                    l.State = "live";
                    l.Fails = 0;
                    l.Why = null;
                    l.LastPing = DateTime.Now;
                    l.PageQuiet = false;
                    Rebuild();
                    var clip = new Dictionary<string, object>();
                    clip["t"] = "clip";
                    clip["on"] = true;
                    Send(l, "ctl", clip);
                    if (first) Log.Write("Keyboard and mouse: " + NameOf(l) + " is ready (" + string.Join(", ", desk.Screens.Select(s => s.W + "×" + s.H + (Math.Abs(s.Scale - 1) > 0.01 ? " at " + Math.Round(s.Scale * 100) + "%" : ""))) + ")");
                    app.MarkChanged();
                    break;
                }
                case "display": // (its screens changed)
                {
                    var desk = DeskOf(Json.Get(m, "monitors"));
                    if (desk.Empty) break;
                    l.Desk = desk;
                    Rebuild();
                    Log.Write("Keyboard and mouse: " + NameOf(l) + "'s screens changed");
                    break;
                }
                case "ping":
                    l.LastPing = DateTime.Now;
                    break;
                case "clip":
                    OnClipFrom(l, Json.Str(m, "text"));
                    break;
                case "kvm-back":
                    if (AwayOn(l)) ReturnHome("Back, from " + NameOf(l) + "'s tray");
                    break;
                case "bye":
                    if (!l.PageQuiet) { l.PageQuiet = true; Rebuild(); }
                    if (AwayOn(l)) ReturnHome(NameOf(l) + " ended it");
                    break;
            }
        }

        static KvmDesk DeskOf(object monitors)
        {
            var list = new List<KvmScreen>();
            var arr = monitors as object[];
            if (arr != null)
                foreach (var o in arr.Take(16))
                {
                    var d = Json.Obj(o);
                    if (d == null) continue;
                    var s = new KvmScreen();
                    s.Id = (int)Json.Long(d, "id", -1);
                    s.X = (int)Json.Long(d, "x", 0);
                    s.Y = (int)Json.Long(d, "y", 0);
                    s.W = (int)Json.Long(d, "w", 0);
                    s.H = (int)Json.Long(d, "h", 0);
                    s.Scale = Json.Double(d, "scale", 1);
                    s.Primary = Json.Bool(d, "primary", false);
                    if (s.Id < 0 || s.Id > 63 || Math.Abs(s.X) > 100000 || Math.Abs(s.Y) > 100000 || !(s.Scale >= 0.5 && s.Scale <= 8)) continue;
                    list.Add(s);
                }
            return new KvmDesk(list);
        }

        void Send(KvmLink l, string ch, Dictionary<string, object> msg)
        {
            if (page == null || l.Session == null || !l.Verified) return;
            var d = new Dictionary<string, object>();
            d["t"] = "send";
            d["link"] = l.Session;
            d["ch"] = ch;
            d["m"] = msg;
            page.Post(d);
        }

        // ------------------------------------------------------------------ every second

        void Tick()
        {
            if (!started) return;
            bool changed = false;
            foreach (var l in links.ToList())
            {
                if (l.State == "waiting" && DateTime.Now >= l.RetryAt) Connect(l);
                else if ((l.State == "asking" || l.State == "connecting") && DateTime.Now - l.Since > TimeSpan.FromSeconds(ConnectSec)) Fail(l, "it didn't connect in " + ConnectSec + " s");
                else if (l.State == "live" && DateTime.Now - l.LastPing > TimeSpan.FromSeconds(30)) Fail(l, "it stopped answering");
            }
            // Readiness that went by time (its pings stopped): the pointer comes back from a PC that isn't answering.
            var m = map;
            if (m != null)
                for (int i = 0; i < links.Count && i < m.Ready.Length; i++)
                    if (m.Ready[i] != links[i].Ready) changed = true;
            if (changed)
            {
                Rebuild();
                int a;
                lock (gate) a = away;
                if (a >= 0 && a < links.Count && !links[a].Ready) ReturnHome(NameOf(links[a]) + " stopped answering");
            }
        }

        // ------------------------------------------------------------------ the arrangement (for the hook thread)

        void Rebuild()
        {
            if (!started) { map = null; return; }
            var m = new Map();
            m.Here = DeskHere();
            m.Desks = links.Select(l => l.Desk ?? new KvmDesk(null)).ToArray();
            m.Ready = links.Select(l => l.Ready).ToArray();
            map = m;
            app.MarkChanged();
        }

        // This PC's screens. Tests: one made-up 1920×1080 screen (nothing real is ever looked at or moved).
        KvmDesk DeskHere()
        {
            if (test) return new KvmDesk(new[] { new KvmScreen { Id = 0, X = 0, Y = 0, W = 1920, H = 1080, Scale = 1, Primary = true } });
            var layout = DesktopLayout.Current();
            return new KvmDesk(layout.Screens.Select(s => new KvmScreen { Id = s.Id, X = s.X, Y = s.Y, W = s.W, H = s.H, Scale = s.Scale, Primary = s.Primary }));
        }

        public void OnDisplayChange() { if (started) Rebuild(); }

        // Locked, or the console went to another session: the pointer comes back.
        public void OnSessionChange(int what)
        {
            if (what == 7 /* WTS_SESSION_LOCK */ || (what >= 1 && what <= 4)) ReturnHome("this PC was locked");
        }

        bool AwayOn(KvmLink l)
        {
            int i;
            lock (gate) i = away;
            return i >= 0 && i < links.Count && links[i] == l;
        }

        // ------------------------------------------------------------------ the hook thread (or a test command)

        // Every input event while this is on. True: this PC doesn't get it (it went to another PC).
        bool OnInput(KvmInput e)
        {
            if (e.Injected) return false; // a program's (SendInput, ours included): this PC's
            var m = map;
            if (m == null) return false;
            lock (gate)
            {
                if (e.Key) return KeyAway(e);
                return away < 0 ? MouseHere(e, m) : MouseAway(e, m);
            }
        }

        // Here: buttons are counted (no crossing while one is down: a drag, a window snapping to the edge), and a move to
        // the left edge with the nearest PC ready crosses over.
        bool MouseHere(KvmInput e, Map m)
        {
            int bit = ButtonBit(e);
            if (bit != 0) { if (IsDown(e.Msg)) buttonsHere |= bit; else buttonsHere &= ~bit; return false; }
            // (an up that never came by here, from a press before this was on: Windows says what's down)
            if (buttonsHere != 0 && !test && !AnyButtonDown()) buttonsHere = 0;
            if (e.Msg != KvmHooks.WM_MOUSEMOVE || buttonsHere != 0 || m.Desks.Length == 0 || !m.Ready[0] || m.Here.Empty) return false;
            // The leftmost of this PC's screens at this height; the pointer at (or past) its left edge leaves.
            var s = m.Here.Screens.Where(x => e.Y >= x.Y && e.Y < x.Bottom).OrderBy(x => x.X).FirstOrDefault();
            if (s == null || e.X > s.X || !m.Here.OpenSide(-1, s.X, e.Y)) { if (test) { testX = e.X; testY = e.Y; } return false; }
            fromScale = s.Scale;
            EnterLocked(0, 1, m.Here.ExitHeight(-1, s, e.Y), m, null);
            return true;
        }

        // There: every move goes to the PC it's on (or on to the next PC, or back here), and buttons, the wheel and keys
        // with it.
        bool MouseAway(KvmInput e, Map m)
        {
            if (away >= m.Desks.Length || m.Desks[away].Empty) { HomeLocked(0.5, "its screens aren't known", m); return true; }
            var desk = m.Desks[away];
            int bit = ButtonBit(e);
            if (bit != 0)
            {
                bool down = IsDown(e.Msg);
                if (down) buttonsThere |= bit; else if ((buttonsThere & bit) == 0) return true; else buttonsThere &= ~bit;
                Queue(new Out { Kind = OutKind.Button, Link = away, At = where, N = seq, B = ButtonOf(e), Down = down });
                return true;
            }
            if (e.Msg == KvmHooks.WM_MOUSEWHEEL || e.Msg == KvmHooks.WM_MOUSEHWHEEL)
            {
                if (e.Data == 0) return true;
                // (the browser's sign: down is positive; Windows' forward is) — InputInjector turns it back
                Queue(new Out { Kind = OutKind.Wheel, Link = away, At = where, N = seq, Dx = e.Msg == KvmHooks.WM_MOUSEHWHEEL ? e.Data : 0, Dy = e.Msg == KvmHooks.WM_MOUSEWHEEL ? -e.Data : 0 });
                return true;
            }
            if (e.Msg != KvmHooks.WM_MOUSEMOVE) return true;
            int dx = e.X - parkX, dy = e.Y - parkY;
            if (dx == 0 && dy == 0) return true;
            var scr = desk.Screen(where.Screen);
            int ox, oy;
            carry.Scale(dx, dy, fromScale, scr != null ? scr.Scale : 1, out ox, out oy);
            if (ox == 0 && oy == 0) return true;
            var mv = desk.Move(where, ox, oy);
            if (mv.Exit != 0 && buttonsThere == 0)
            {
                if (mv.Exit > 0)
                {
                    // Its right edge: the PC nearer this one, or this PC.
                    if (away == 0) { HomeLocked(mv.Height, null, m); return true; }
                    if (m.Ready[away - 1]) { SwitchLocked(away - 1, -1, mv.Height, m); return true; }
                }
                else if (away + 1 < m.Desks.Length && m.Ready[away + 1]) { SwitchLocked(away + 1, 1, mv.Height, m); return true; }
            }
            where = mv.At;
            seq++;
            Queue(new Out { Kind = OutKind.Move, Link = away, At = where, N = seq });
            return true;
        }

        bool KeyAway(KvmInput e)
        {
            if (away < 0) return false;
            bool down = e.Msg == KvmHooks.WM_KEYDOWN || e.Msg == KvmHooks.WM_SYSKEYDOWN;
            if (heldHere.Contains(e.Vk))
            {
                if (!down) heldHere.Remove(e.Vk); // (down here before the pointer left: it goes up here, its repeats too)
                return false;
            }
            string code = KeyMap.CodeOf(e.Vk, e.Scan, e.Extended);
            if (code == null && e.Vk == 0x2C) code = "PrintScreen";
            if (code != null) Queue(new Out { Kind = OutKind.Key, Link = away, Code = code, Down = down });
            return true;
        }

        static int ButtonBit(KvmInput e)
        {
            switch (e.Msg)
            {
                case KvmHooks.WM_LBUTTONDOWN: case KvmHooks.WM_LBUTTONUP: return 1;
                case KvmHooks.WM_RBUTTONDOWN: case KvmHooks.WM_RBUTTONUP: return 2;
                case KvmHooks.WM_MBUTTONDOWN: case KvmHooks.WM_MBUTTONUP: return 4;
                case KvmHooks.WM_XBUTTONDOWN: case KvmHooks.WM_XBUTTONUP: return e.Data == 2 ? 16 : 8;
            }
            return 0;
        }

        static int ButtonOf(KvmInput e)
        {
            int bit = ButtonBit(e);
            return bit == 1 ? 0 : bit == 2 ? 2 : bit == 4 ? 1 : bit == 8 ? 3 : 4; // (the browser's numbers: left 0, middle 1, right 2, back 3, forward 4)
        }

        static bool AnyButtonDown()
        {
            foreach (int vk in new[] { 0x01, 0x02, 0x04, 0x05, 0x06 }) if ((GetAsyncKeyState(vk) & 0x8000) != 0) return true;
            return false;
        }

        static bool IsDown(int msg)
        {
            return msg == KvmHooks.WM_LBUTTONDOWN || msg == KvmHooks.WM_RBUTTONDOWN || msg == KvmHooks.WM_MBUTTONDOWN || msg == KvmHooks.WM_XBUTTONDOWN;
        }

        // (under gate) Onto PC `i` through its edge `side` (+1: its right edge, from this PC or a PC to its right; -1: its
        // left edge) at a height. `from`: the PC it was on (null: this PC).
        void EnterLocked(int i, int side, double height, Map m, int? from)
        {
            where = m.Desks[i].Enter(side, height);
            away = i;
            carry.Reset();
            buttonsThere = 0;
            if (from == null)
            {
                // Keys down here as it leaves stay here (their ups come here); this PC's pointer waits, hidden.
                heldHere.Clear();
                for (int vk = 0x08; vk <= 0xFE; vk++) if (!test && (GetAsyncKeyState(vk) & 0x8000) != 0) heldHere.Add(vk);
                if (test) { parkX = 960; parkY = 540; }
                else
                {
                    var p = m.Here.Screens.FirstOrDefault(s => s.X == 0 && s.Y == 0) ?? m.Here.Screens[0];
                    parkX = p.X + p.W / 2;
                    parkY = p.Y + p.H / 2;
                    SetCursorPos(parkX, parkY);
                    if (hooks != null) { hooks.Keys(true); hooks.CoverOn(Bounds(m.Here), parkX, parkY); }
                }
            }
            Queue(new Out { Kind = OutKind.Enter, Link = i, Home = from == null });
            seq++;
            Queue(new Out { Kind = OutKind.Move, Link = i, At = where, N = seq });
        }

        void SwitchLocked(int i, int side, double height, Map m)
        {
            int was = away;
            Queue(new Out { Kind = OutKind.Leave, Link = was });
            EnterLocked(i, side, height, m, was);
        }

        // (under gate) Back to this PC at its left edge, at a height; why: a reason it came back by itself (null: moved).
        void HomeLocked(double height, string why, Map m)
        {
            if (away < 0) return;
            int was = away;
            away = -1;
            buttonsThere = 0;
            heldHere.Clear();
            Queue(new Out { Kind = OutKind.Leave, Link = was, Home = true, Why = why });
            if (m == null || m.Here.Empty) return;
            var p = m.Here.Enter(-1, height);
            int x = p.X + 1, y = p.Y; // (just inside: the next move left crosses again)
            if (test) { testX = x; testY = y; }
            else
            {
                SetCursorPos(x, y);
                if (hooks != null) { hooks.Keys(false); hooks.CoverOff(); }
            }
        }

        // From the window thread: back here at once (trouble, Back from the other PC, this PC locked, turned off).
        public void ReturnHome(string why)
        {
            lock (gate)
            {
                if (away < 0) return;
                var m = map;
                double h = 0.5;
                if (m != null && away < m.Desks.Length && !m.Desks[away].Empty) h = m.Desks[away].ExitHeight(1, m.Desks[away].Screen(where.Screen), where.Y);
                HomeLocked(h, why, m);
            }
            Drain();
        }

        void Queue(Out o)
        {
            outbox.Enqueue(o);
            if (Interlocked.Exchange(ref drainPosted, 1) == 0) app.Post(Drain);
        }

        // ------------------------------------------------------------------ the window thread: what the hooks queued

        void Drain()
        {
            Interlocked.Exchange(ref drainPosted, 0);
            Out move = heldMove;
            heldMove = null;
            Out o;
            while (outbox.TryDequeue(out o))
            {
                if (o.Kind == OutKind.Move) { move = o; continue; }
                if (move != null) { SendMove(move, true); move = null; } // (a click lands where the pointer is)
                Handle(o);
            }
            if (move != null) SendMove(move, false);
        }

        void SendMove(Out o, bool now)
        {
            long t = clock.ElapsedMilliseconds;
            if (!now && t - lastMoveAt < MoveEveryMs) { heldMove = o; moveTimer.Stop(); moveTimer.Start(); return; }
            lastMoveAt = t;
            var l = LinkAt(o.Link);
            if (l == null) return;
            var s = l.Desk != null ? l.Desk.Screen(o.At.Screen) : null;
            if (s == null) return;
            var m = new Dictionary<string, object>();
            m["t"] = "mv";
            m["n"] = o.N;
            m["m"] = s.Id;
            m["x"] = o.At.X - s.X;
            m["y"] = o.At.Y - s.Y;
            Send(l, "mv", m);
        }

        KvmLink LinkAt(int i) { return i >= 0 && i < links.Count ? links[i] : null; }

        void Handle(Out o)
        {
            var l = LinkAt(o.Link);
            if (l == null) return;
            switch (o.Kind)
            {
                case OutKind.Button:
                case OutKind.Wheel:
                {
                    var s = l.Desk != null ? l.Desk.Screen(o.At.Screen) : null;
                    var m = new Dictionary<string, object>();
                    m["t"] = o.Kind == OutKind.Button ? "btn" : "wheel";
                    m["n"] = o.N;
                    if (o.Kind == OutKind.Button) { m["b"] = o.B; m["d"] = o.Down; }
                    else { m["dx"] = o.Dx; m["dy"] = o.Dy; }
                    if (s != null) { m["m"] = s.Id; m["x"] = o.At.X - s.X; m["y"] = o.At.Y - s.Y; }
                    Send(l, "in", m);
                    break;
                }
                case OutKind.Key:
                {
                    var m = new Dictionary<string, object>();
                    m["t"] = "key";
                    m["c"] = o.Code;
                    m["d"] = o.Down;
                    Send(l, "in", m);
                    break;
                }
                case OutKind.Enter:
                {
                    var m = new Dictionary<string, object>();
                    m["t"] = "kvm";
                    m["here"] = true;
                    Send(l, "ctl", m);
                    ClipTo(l);
                    if (test) Log.Write("Keyboard and mouse: (test) on " + NameOf(l));
                    app.MarkChanged();
                    break;
                }
                case OutKind.Leave:
                {
                    var r = new Dictionary<string, object>();
                    r["t"] = "release";
                    Send(l, "in", r); // (whatever is held there goes up)
                    var m = new Dictionary<string, object>();
                    m["t"] = "kvm";
                    m["here"] = false;
                    Send(l, "ctl", m);
                    l.LeftAt = clock.ElapsedMilliseconds;
                    if (o.Why != null) Log.Write("Keyboard and mouse: back on this PC (" + o.Why + ")");
                    else if (test && o.Home) Log.Write("Keyboard and mouse: (test) back on this PC");
                    app.MarkChanged();
                    break;
                }
            }
        }

        // ------------------------------------------------------------------ the clipboard (text)

        static string Norm(string s) { return s == null ? null : s.Replace("\r\n", "\n"); }

        // This PC's clipboard text goes along when the pointer goes to a PC that doesn't have it yet.
        void ClipTo(KvmLink l)
        {
            string text = Norm(ClipNow());
            if (string.IsNullOrEmpty(text) || text == l.ClipHad || Encoding.UTF8.GetByteCount(text) > MaxClip) return;
            l.ClipHad = text;
            var c = new Dictionary<string, object>();
            c["t"] = "clip";
            c["text"] = text;
            Send(l, "ctl", c);
            Log.Write("Keyboard and mouse: this PC's clipboard text went to " + NameOf(l) + " (" + text.Length + " characters)");
        }

        // This PC's clipboard text: what was copied here, or the text it got from a PC last (Beam marks that one as not
        // to share, so it's taken from here while the clipboard hasn't changed since).
        string ClipNow()
        {
            if (clipSet != null && ClipPayload.TextSequence() == clipSetSeq) return clipSet;
            return ClipPayload.ReadSharableText();
        }

        // A PC's clipboard text: taken while the pointer is there (or just left), never what it had before (its first
        // one, when the link comes up).
        void OnClipFrom(KvmLink l, string text)
        {
            text = Norm(text);
            if (string.IsNullOrEmpty(text) || Encoding.UTF8.GetByteCount(text) > MaxClip) return;
            bool recent = AwayOn(l) || clock.ElapsedMilliseconds - l.LeftAt < ClipAfterMs;
            if (!recent || text == l.ClipHad) { l.ClipHad = text; return; }
            l.ClipHad = text;
            if (!ClipPayload.SetRemoteText(text, app.Cfg.ClipboardHistory)) return;
            clipSet = text;
            clipSetSeq = ClipPayload.TextSequence();
            Log.Write("Keyboard and mouse: " + NameOf(l) + "'s clipboard text is on this PC's clipboard (" + text.Length + " characters)");
        }

        // ------------------------------------------------------------------ this PC's screens, whole (the cover over them)

        static Rectangle Bounds(KvmDesk d)
        {
            int l = d.Screens.Min(x => x.X), t = d.Screens.Min(x => x.Y);
            return new Rectangle(l, t, d.Screens.Max(x => x.Right) - l, d.Screens.Max(x => x.Bottom) - t);
        }

        // ------------------------------------------------------------------ tests (--test-kvm, a custom --config only)

        public void TestCommand(string cmd)
        {
            string arg = null;
            int colon = cmd.IndexOf(':');
            if (colon > 0) { arg = cmd.Substring(colon + 1); cmd = cmd.Substring(0, colon); }
            var inv = CultureInfo.InvariantCulture;
            switch (cmd)
            {
                case "on": // on:<id>[,<id>…], nearest first
                    app.Cfg.KvmLeft = (arg ?? "").Split(',').Where(Config.ValidId).Distinct().Take(MaxPcs).ToList();
                    app.Cfg.KvmOn = true;
                    app.Cfg.Save();
                    Apply("test");
                    break;
                case "off":
                    app.Cfg.KvmOn = false;
                    app.Cfg.Save();
                    Apply("test");
                    break;
                case "edge": // the pointer at the left edge of this PC's (made-up) screen, at a height (0..1)
                {
                    double h;
                    if (!double.TryParse(arg ?? "0.5", NumberStyles.Float, inv, out h)) h = 0.5;
                    var e = new KvmInput();
                    e.Msg = KvmHooks.WM_MOUSEMOVE;
                    e.X = -1;
                    e.Y = (int)Math.Round(Math.Max(0, Math.Min(1, h)) * 1079);
                    OnInput(e);
                    break;
                }
                case "move": // move:dx,dy (this PC's pixels)
                {
                    var xy = (arg ?? "").Split(',');
                    int dx, dy;
                    if (xy.Length != 2 || !int.TryParse(xy[0], NumberStyles.Integer, inv, out dx) || !int.TryParse(xy[1], NumberStyles.Integer, inv, out dy)) break;
                    var e = new KvmInput();
                    e.Msg = KvmHooks.WM_MOUSEMOVE;
                    lock (gate)
                    {
                        if (away >= 0) { e.X = parkX + dx; e.Y = parkY + dy; }
                        else { e.X = testX + dx; e.Y = testY + dy; }
                    }
                    OnInput(e);
                    break;
                }
                case "btn": // btn:<0 left|1 middle|2 right|3 back|4 forward>:<down|up>
                {
                    var p = (arg ?? "").Split(':');
                    int b;
                    if (p.Length != 2 || !int.TryParse(p[0], out b) || b < 0 || b > 4) break;
                    bool down = p[1] == "down";
                    var e = new KvmInput();
                    e.Msg = b == 0 ? (down ? KvmHooks.WM_LBUTTONDOWN : KvmHooks.WM_LBUTTONUP) : b == 1 ? (down ? KvmHooks.WM_MBUTTONDOWN : KvmHooks.WM_MBUTTONUP)
                        : b == 2 ? (down ? KvmHooks.WM_RBUTTONDOWN : KvmHooks.WM_RBUTTONUP) : (down ? KvmHooks.WM_XBUTTONDOWN : KvmHooks.WM_XBUTTONUP);
                    e.Data = b == 3 ? 1 : b == 4 ? 2 : 0;
                    OnInput(e);
                    break;
                }
                case "wheel": // wheel:<Windows delta, + is away from you> ; hwheel:<+ is right>
                case "hwheel":
                {
                    int delta;
                    if (!int.TryParse(arg ?? "", NumberStyles.Integer, inv, out delta)) break;
                    var e = new KvmInput();
                    e.Msg = cmd == "wheel" ? KvmHooks.WM_MOUSEWHEEL : KvmHooks.WM_MOUSEHWHEEL;
                    e.Data = delta;
                    OnInput(e);
                    break;
                }
                case "key": // key:<vk>,<scan>,<extended 0|1>:<down|up>
                {
                    var p = (arg ?? "").Split(':');
                    if (p.Length != 2) break;
                    var k = p[0].Split(',');
                    int vk, scan, ext;
                    if (k.Length != 3 || !int.TryParse(k[0], out vk) || !int.TryParse(k[1], out scan) || !int.TryParse(k[2], out ext)) break;
                    var e = new KvmInput();
                    e.Key = true;
                    e.Msg = p[1] == "down" ? KvmHooks.WM_KEYDOWN : KvmHooks.WM_KEYUP;
                    e.Vk = vk;
                    e.Scan = scan;
                    e.Extended = ext == 1;
                    OnInput(e);
                    break;
                }
                case "where":
                {
                    string s;
                    lock (gate)
                    {
                        if (away < 0) s = "here at " + testX + "," + testY;
                        else
                        {
                            var l = LinkAt(away);
                            var sc = l != null && l.Desk != null ? l.Desk.Screen(where.Screen) : null;
                            s = "on " + (l != null ? NameOf(l) : "?") + " screen " + where.Screen + (sc != null ? " (" + sc.W + "x" + sc.H + " at " + Math.Round(sc.Scale * 100) + "%)" : "") +
                                " at " + (sc != null ? (where.X - sc.X) + "," + (where.Y - sc.Y) : where.X + "," + where.Y);
                        }
                    }
                    Log.Write("Keyboard and mouse: (test) " + s + "; " + string.Join("; ", LinkStates().Select(kv => kv.Key + " " + kv.Value)));
                    break;
                }
            }
            Drain();
        }

        [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
    }
}
