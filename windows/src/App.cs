// The app controller: tray icon, connection, item store, receiving (clipboard, auto-save, notifications,
// acks), sending, transfers, updates and moves. The messenger window is the web app hosted in WebView2
// (WebWindow); everything else is native. All state lives on the UI thread.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.NetworkInformation;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;
using Timer = System.Windows.Forms.Timer;

namespace Beam
{
    enum Conn { Offline, Connecting, Online, Unauthorized }

    class ConvSummary
    {
        public Item Last;
        public int Unread;
    }

    class App : ApplicationContext
    {
        public static App Current;
        public Config Cfg;
        public State St;
        public Api Api;
        public List<Device> Devices = new List<Device>();
        public List<Item> Items = new List<Item>(); // newest first
        readonly Dictionary<string, Item> byId = new Dictionary<string, Item>();
        public readonly List<UploadJob> Uploads = new List<UploadJob>();
        public readonly Dictionary<string, DownloadJob> Downloads = new Dictionary<string, DownloadJob>();
        public Conn Conn = Conn.Offline;
        public string ConnText = "Not connected";
        public Dictionary<string, object> ServerInfo;   // GET /api/info
        public string ServerVersion;
        public int ServerApi = 2;
        public bool? PageBridge;   // does this server's web page speak the host bridge? (null: not seen yet)
        readonly HashSet<string> serverFeatures = new HashSet<string>(); // from the stream's hello (Beam 1.4 flags)
        readonly List<TaskCompletionSource<bool>> pokeWaiters = new List<TaskCompletionSource<bool>>(); // stream checks waiting for the poke's ping
        int liveViews;   // native UI showing who's online is open: the stream runs in foreground mode meanwhile
        string streamMode = "background", modeSent; // the mode the stream should be in, and the last one asked for
        bool modePoking;
        int session;     // bumped when a sign-in session ends: late callbacks from the old one are ignored
        readonly Timer netTimer; // a burst of network changes is checked once, a moment after the last one
        public string UpdateState = "none", UpdateVersion, UpdateError;
        public bool DevTools, TestOffscreen;
        public string TestCapture, TestPath;

        // For the web window: the page mirrors these.
        public event Action Changed;
        public event Action<Job> TransferChanged;
        public event Action<string, string> TransferRemoved;   // transfer id, finished item id
        public event Action<string, bool> LocalFileChanged;    // item id, saved
        public event Action SettingsChanged;
        public event Action UpdateChanged;
        public event Action ConnChanged;

        readonly Control marshal;
        readonly NotifyIcon tray;
        readonly ContextMenuStrip menu;
        readonly Notifier notifier;
        readonly PhoneNotices phone;      // Beam 1.5: the phone's notifications (memory only)
        bool? phoneWanted;                // the value asked for here, shown until the server's device list has it
        bool? phoneSent;                  // ...and the last one the server took
        bool phoneSending;
        int phoneChanges;                 // counts the switch's changes here (a settling list must not be older)
        readonly Timer phoneGrace;        // stops waiting for the device list to confirm (it asks the server instead)
        readonly Hotkeys hotkeys;
        readonly Uploader up;
        readonly Downloader down;
        readonly IpcServer ipc;
        readonly StatusReporter status;
        readonly Ringer ringer;
        public RemoteControl Rc;          // Beam 1.6: this PC being controlled from another device
        readonly Dictionary<string, RemoteViewWindow> remoteViews = new Dictionary<string, RemoteViewWindow>(); // ...and controlling others
        readonly HashSet<string> alertsShown = new HashSet<string>();
        readonly Timer uiTimer, resyncTimer, integrationTimer, rediscoverTimer, updateTimer, updateRetryTimer, healthTimer;
        readonly Dictionary<string, ApproveForm> approvals = new Dictionary<string, ApproveForm>();
        readonly HashSet<string> dismissedLogins = new HashSet<string>();
        bool switchingServer, updateChecked, updating, restored, signInOffered;
        DateTime? offlineSince;
        DateTime lastRediscovery = DateTime.MinValue;
        UpdateInfo pendingUpdate;
        string updateOfferedVersion, updateFailNotified;
        string refusedOffer; // (1.7.3) an offer that failed its checks (signature, checksum): not downloaded again by itself
        bool cleanedUp;
        EventStream events;
        Outbox outbox;
        WebWindow main;
        PairForm pairForm;
        SettingsForm settingsForm;
        bool dirty, trayDot, quitting, catchingUp, catchUpAgain, devicesLoaded;
        volatile bool uiResting;          // the progress timer is stopped (nothing moving): progress starts it again
        HashSet<string> liveDuringCatchUp; // items that came in live while a catch-up's item list was on its way
        readonly HashSet<string> receiving = new HashSet<string>();
        readonly HashSet<string> seenLive = new HashSet<string>();
        readonly HashSet<string> acking = new HashSet<string>();
        Options pending;
        int localIds;

        public string Me { get { return Cfg.DeviceId; } }

        public App(Options opts, Config cfg)
        {
            Current = this;
            Cfg = cfg;
            St = new State(cfg.Dir);
            DevTools = opts.DevTools;
            TestCapture = opts.TestCapture;
            TestOffscreen = (opts.TestOffscreen || cfg.TestOffscreen) && cfg.CustomPath;
            Ui.TestOffscreen = TestOffscreen;
            TestPath = cfg.CustomPath && opts.TestPath != null && opts.TestPath.StartsWith("/") ? opts.TestPath : null;
            if (!string.IsNullOrEmpty(St.ServerId) && !string.IsNullOrEmpty(Cfg.ServerId) && St.ServerId != Cfg.ServerId)
            {
                Log.Write("Local state belongs to another Beam; starting fresh");
                St.Reset(Cfg.ServerId);
            }
            ClipPayload.IsolatedDir = cfg.CustomPath ? cfg.Dir : null;
            marshal = new Control();
            marshal.CreateControl();
            Theme.Load();
            Theme.Watch(marshal);
            Ui.Init();

            tray = new NotifyIcon();
            tray.Icon = AppIcon.Tray(false, Theme.Accent);
            tray.Text = "Beam";
            menu = new ContextMenuStrip();
            menu.Opening += (s, e) => { BuildMenu(); e.Cancel = false; LiveViewOpened(); };
            menu.Closed += (s, e) => LiveViewClosed();
            tray.ContextMenuStrip = menu;
            tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) ToggleMain(); };
            tray.Visible = !cfg.Quiet;
            notifier = new Notifier(tray, () => ShowMain(null, null), cfg.Quiet);
            notifier.OpenItem = OpenItem;
            phone = new PhoneNotices(this, notifier);
            phoneGrace = new Timer();
            phoneGrace.Interval = 10000;
            phoneGrace.Tick += (s, e) => { phoneGrace.Stop(); if (phoneWanted.HasValue && !phoneSending) RefreshDevices(true); };

            hotkeys = new Hotkeys();
            status = new StatusReporter(this);
            ringer = new Ringer(this);
            Rc = new RemoteControl(this);

            up = new Uploader(() => Api, j => { var s = j.State; Post(() => OnUploadChanged(j, s)); }, j => { });
            down = new Downloader(() => Api, j => { var s = j.State; Post(() => OnDownloadChanged(j, s)); }, OnDownloadProgress);

            // Runs only while something changed or a transfer is moving (Tick stops it again).
            uiTimer = new Timer();
            uiTimer.Interval = 250;
            uiTimer.Tick += (s, e) => Tick();
            // A safety net only: the event stream brings every change, and every reconnect catches up.
            resyncTimer = new Timer();
            resyncTimer.Interval = 30 * 60 * 1000;
            resyncTimer.Tick += (s, e) => { if (Conn == Conn.Online) CatchUp(); };
            integrationTimer = new Timer();
            integrationTimer.Interval = 1500;
            integrationTimer.Tick += (s, e) => { integrationTimer.Stop(); SyncIntegrations(); };
            rediscoverTimer = new Timer();
            rediscoverTimer.Interval = Math.Min(60000, Math.Max(5000, Cfg.RediscoverSec * 1000 / 4));
            rediscoverTimer.Tick += (s, e) => MaybeRediscover(); // only while offline (see OnDisconnected)
            updateTimer = new Timer();
            updateTimer.Interval = 6 * 3600 * 1000;
            updateTimer.Tick += (s, e) => CheckForUpdates(false, null);
            updateRetryTimer = new Timer();
            updateRetryTimer.Interval = 30000;
            updateRetryTimer.Tick += (s, e) => { updateRetryTimer.Stop(); TryInstallUpdate(); };
            healthTimer = new Timer();
            healthTimer.Interval = 20000; // running this long without crashing counts as healthy, even offline
            healthTimer.Tick += (s, e) => { healthTimer.Stop(); BecameHealthy(); };
            healthTimer.Start();
            Api.Moved += to => Post(() => OnMoved(to));
            Api.TokenIssued += token => Post(() => AdoptToken(token));
            Api.YouChanged += you => Post(() => AdoptId(you));

            ipc = new IpcServer(Program.PipeName(), args => Post(() => HandleCommand(Options.Parse(args))));
            SystemEvents.PowerModeChanged += (s, e) =>
            {
                if (e.Mode == PowerModes.Resume) Post(() =>
                {
                    Log.Write("Resumed from sleep");
                    CheckStream("waking up");
                    up.KickAll();
                    down.KickAll();
                });
                else if (e.Mode == PowerModes.StatusChange) Post(() => status.CheckBattery()); // plugged in/out, battery level
            };
            // Addresses change in bursts (docking, Wi-Fi off a few seconds after Ethernet comes up, VPN rebinds): the
            // stream is checked 3 s after the last change of a burst, when the routes have settled.
            netTimer = new Timer();
            netTimer.Interval = 3000;
            netTimer.Tick += (s, e) => { netTimer.Stop(); if (events != null) CheckStream("a network change"); };
            NetworkChange.NetworkAddressChanged += (s, e) => Post(() =>
            {
                if (events == null) return;
                if (Conn != Conn.Online) events.Kick();
                netTimer.Stop();
                netTimer.Start();
            });
            Theme.Changed += (s, e) => { SetTrayIcon(trayDot); MarkChanged(); };

            if (!Cfg.AutostartInitialized && Autostart.IsEnabled(Cfg)) { Cfg.AutostartInitialized = true; Cfg.Save(); }
            Autostart.Repair(Cfg);

            if (Cfg.Paired) StartSession();
            pending = opts;
            marshal.BeginInvoke(new Action(() =>
            {
                Perf.Mark("tray ready", Perf.SinceStart);
                if (!Cfg.Paired) { ShowPairing(PairMode.First); return; }
                var o = pending;
                pending = null;
                if (!o.Send && !o.Background && !o.Quit && !o.Settings && !o.Approve && !o.AddDevice && !o.PickClipboard
                    && !o.Screenshot && !o.CopyLatest && o.Updated == null && o.UpdateFailed == null) o.Show = true;
                HandleCommand(o);
            }));
        }

        // ------------------------------------------------------------------ threading & UI refresh

        public void Post(Action a)
        {
            try { if (!marshal.IsDisposed) marshal.BeginInvoke(a); }
            catch (Exception ex) { Log.Error("Post", ex); }
        }

        public void MarkChanged()
        {
            dirty = true;
            if (!uiTimer.Enabled) { uiResting = false; uiTimer.Start(); }
        }

        void Tick()
        {
            // Transfer progress for the page, a few times a second. An early download waiting for its sender has none.
            bool moving = false;
            foreach (var j in Uploads.Where(u => u.Active).Cast<Job>().Concat(Downloads.Values.Where(Busy)))
            {
                moving = true;
                j.SampleRate();
                if (TransferChanged != null) TransferChanged(j);
            }
            if (dirty)
            {
                dirty = false;
                if (Changed != null) Changed();
                UpdateTray();
            }
            else if (!moving) { uiTimer.Stop(); uiResting = true; } // idle: no wakeups until the next change or bytes
        }

        // A download that is moving (or about to): not one that only waits for its sender.
        static bool Busy(DownloadJob d) { return d.Active && !d.Waiting; }

        // Background thread: bytes came in while the progress timer rests (an early download's sender went on).
        void OnDownloadProgress(DownloadJob job)
        {
            if (!uiResting) return;
            uiResting = false;
            Post(MarkChanged);
        }

        void UpdateTray()
        {
            int unread = 0;
            foreach (var kv in Summaries()) unread += kv.Value.Unread;
            bool dot = unread > 0;
            if (dot != trayDot) SetTrayIcon(dot);
            string rc = Rc != null ? Rc.Status : null;
            string text = rc != null ? "Beam – " + rc : "Beam – " + ConnText + (unread > 0 ? " · " + unread + " unread" : "");
            tray.Text = text.Length > 63 ? text.Substring(0, 63) : text;
        }

        void SetTrayIcon(bool dot)
        {
            trayDot = dot;
            var old = tray.Icon;
            tray.Icon = AppIcon.Tray(dot, Theme.Accent);
            if (old != null) old.Dispose();
        }

        void SetConn(Conn c, string text)
        {
            bool changed = c != Conn || text != ConnText;
            Conn = c;
            ConnText = text;
            if (changed && ConnChanged != null) ConnChanged();
            MarkChanged();
        }

        // ------------------------------------------------------------------ session

        void StartSession()
        {
            StartEvents();
            RegisterHotkeys();
            resyncTimer.Start();
            updateTimer.Start();
            MarkChanged();
        }

        void RegisterHotkeys()
        {
            if (Cfg.CustomPath || Cfg.Quiet)
            {
                Log.Write("Hotkeys are off for a custom --config");
                return;
            }
            hotkeys.Set("picker", Cfg.Hotkeys["picker"], SendClipboardPicker);
            hotkeys.Set("lastTarget", Cfg.Hotkeys["lastTarget"], SendClipboardToLast);
            hotkeys.Set("copyLatest", Cfg.Hotkeys["copyLatest"], CopyLatestText);
            hotkeys.Set("screenshot", Cfg.Hotkeys["screenshot"], ScreenshotAndSend);
        }

        public bool HotkeyRegistered(string name) { return hotkeys.IsRegistered(name); }

        // (Re)connects to Cfg.Server: a fresh Api and event stream.
        void StartEvents()
        {
            if (events != null) events.Stop();
            if (Rc != null) Rc.Reset("this PC's sign-in or server changed");
            phone.Clear(); // a new sign-in or server: what the old one sent goes
            // ...and what it said it can do: features come again with the new stream's hello and /api/info.
            serverFeatures.Clear();
            ServerInfo = null;
            Api = new Api(Cfg);
            SetConn(Conn.Connecting, "Connecting…");
            events = new EventStream(Api, Cfg.HeartbeatSec);
            var ev = events;
            events.Connected = () => Post(() => { if (events == ev) OnConnected(); });
            events.Disconnected = reason => Post(() => { if (events == ev) OnDisconnected(reason); });
            events.Received = (name, data) => Post(() => { if (events == ev) OnEvent(name, data); });
            events.Start();
        }

        void StopSession()
        {
            session++;
            if (events != null) events.Stop();
            events = null;
            phone.Clear();
            phoneWanted = null;
            phoneSent = null;
            phoneSending = false;
            phoneGrace.Stop();
            hotkeys.Clear();
            resyncTimer.Stop();
            updateTimer.Stop();
            foreach (var f in approvals.Values.ToList()) f.Close();
            Rc.Reset("signed out");
            CloseRemoteViews();
            foreach (var j in Uploads.ToList()) up.Cancel(j);
            foreach (var j in Downloads.Values.ToList()) down.Cancel(j);
            if (outbox != null) { outbox.Dispose(); outbox = null; }
            status.Stop();
            ringer.Stop("signed out");
            SetConn(Conn.Offline, "Not signed in");
        }

        bool connectedOnce;

        void OnConnected()
        {
            rediscoverTimer.Stop();
            if (!connectedOnce) { connectedOnce = true; Perf.Mark("connected", Perf.SinceStart); }
            offlineSince = null;
            signInOffered = false;
            if (main != null && !main.IsDisposed) main.HideSignedOut();
            SetConn(Conn.Online, "Connected");
            CatchUp();
            status.OnConnected();
        }

        void OnDisconnected(string reason)
        {
            if (offlineSince == null) offlineSince = DateTime.Now;
            if (!rediscoverTimer.Enabled) rediscoverTimer.Start();
            if (events != null && events.Unauthorized)
            {
                SetConn(Conn.Unauthorized, "Sign in again");
                OnUnauthorized();
                return;
            }
            int wait = events != null ? events.NextRetrySeconds : 1;
            SetConn(Conn.Connecting, "Offline – retrying" + (wait > 1 ? " in " + wait + " s" : ""));
            // Nobody at the address (refused, unknown name): the server may have moved; look now, not in 10 minutes.
            if (events != null && events.Unreachable && DateTime.Now - lastRediscovery > TimeSpan.FromMinutes(2)) Rediscover("the server isn't answering at " + HostOf(Cfg.Server));
        }

        // The key was rejected. If a different Beam now answers at this address, ours moved: look for it. If our
        // Beam itself says so (its serverId, from the 401 or from /api/hello), the sign-in is gone: forget what this
        // PC kept for it. Anything else (no answer, not a Beam, no serverId) keeps everything and only asks to sign
        // in again, as 1.3 did.
        async void OnUnauthorized(string serverIdFrom401 = null)
        {
            if (signInOffered || switchingServer) return;
            signInOffered = true;
            string id = serverIdFrom401;
            if (string.IsNullOrEmpty(id) && events != null) id = events.UnauthorizedServerId;
            if (string.IsNullOrEmpty(id))
            {
                try { id = Json.Str(await Api.Hello(Cfg.Server, 8, CancellationToken.None), "serverId"); }
                catch { }
            }
            if (!string.IsNullOrEmpty(Cfg.ServerId) && !string.IsNullOrEmpty(id) && id != Cfg.ServerId)
            {
                Log.Write("A different Beam answers at " + HostOf(Cfg.Server) + "; looking for ours");
                signInOffered = false;
                Rediscover("another Beam answers at " + HostOf(Cfg.Server));
                return;
            }
            bool keyRejected = events != null && events.KeyRejected;
            if (keyRejected) Log.Write("Sign-in refused: this install's device key isn't the one the server has for this PC");
            if (!string.IsNullOrEmpty(Cfg.ServerId) && id == Cfg.ServerId) ForgetRevokedSignIn();
            else Log.Write("Sign-in refused at " + HostOf(Cfg.Server) + ", which didn't say it is this Beam: keeping everything");
            if (main != null && !main.IsDisposed && main.Visible) main.ShowSignedOut();
            if (keyRejected) notifier.Show("This PC's Beam identity doesn't match", "Sign in again. Click to sign in.", SignInAgain, "sign-in needed (device key)");
            else notifier.Show("Beam needs you to sign in again", "This PC isn't signed in any more. Click to sign in again.", SignInAgain, "sign-in needed");
        }

        // This same Beam answered 401: this PC's sign-in is gone (revoked, or the device was removed). Like the web page,
        // forget what was kept for that account: the token, device names (Send to entries, recent targets), pending
        // transfers and Beam's temporary copies for them, cached history and the chat window's stored data. Saved
        // files stay, and so do the server's address and this PC's name and id, so signing in again is one step.
        // Network errors, 5xx, 503 (moving) and 410 (moved) never get here.
        void ForgetRevokedSignIn()
        {
            if (string.IsNullOrEmpty(Cfg.Key)) return;
            Log.Write("Sign-in revoked: clearing the token, device names, pending transfers and cached history on this PC");
            var copies = Uploads.Where(j => j.DeleteWhenDone && j.Path != null).Select(j => j.Path).ToList();
            StopSession();
            foreach (var path in copies) FileUtil.TryDelete(path);
            SendToMenu.Remove(this);
            Cfg.Key = null;
            Cfg.RotateToken = false;
            Cfg.RevokeKey = null;
            Cfg.LastTargets = new List<string>();
            Cfg.Save();
            St.Reset(Cfg.ServerId);
            Items.Clear();
            byId.Clear();
            Devices.Clear();
            Uploads.Clear();
            Downloads.Clear();
            devicesLoaded = false;
            restored = false;
            if (main != null && !main.IsDisposed) main.SignedOut();
            else WebHost.ForgetProfile(Cfg);
            SetConn(Conn.Unauthorized, "Sign in again");
            MarkChanged();
        }

        // After every (re)connect: refresh devices and items, then handle anything missed.
        async void CatchUp()
        {
            if (Api == null) return;
            if (catchingUp) { catchUpAgain = true; return; }
            catchingUp = true;
            try
            {
                var api = Api;
                int mine = session; // a revoke or sign-out meanwhile (state reset) ends this catch-up after its await
                // Know which Beam this is before handling anything: state from another Beam must not replay here.
                if (string.IsNullOrEmpty(Cfg.ServerId) || St.ServerId == null)
                {
                    string id = null;
                    try { id = Json.Str(await Api.Hello(Cfg.Server, 15, CancellationToken.None), "serverId"); }
                    catch (Exception ex) { Log.Error("Identifying the server", ex); }
                    if (api != Api || mine != session) return;
                    if (!string.IsNullOrEmpty(id))
                    {
                        if (string.IsNullOrEmpty(Cfg.ServerId)) { Cfg.ServerId = id; Cfg.Save(); }
                        if (St.ServerId != null && St.ServerId != id && id == Cfg.ServerId) { Log.Write("Local state belongs to another Beam; starting fresh"); St.Reset(id); }
                        else if (St.ServerId == null && St.Initialized && id == Cfg.ServerId) { St.ServerId = id; St.SaveHandled(); }
                    }
                }
                liveDuringCatchUp = new HashSet<string>();
                var devTask = api.Devices();
                var itemsTask = api.Items();
                var devices = await devTask;
                var items = await itemsTask;
                if (api != Api || mine != session) return;
                AdoptId(api.LastYou);
                bool phoneBefore = PhoneNotificationsOn == true;
                Devices = devices;
                devicesLoaded = true;
                PhoneSettingSeen(phoneBefore);
                SetItems(items, liveDuringCatchUp);
                liveDuringCatchUp = null;
                var forMe = Items.Where(IsForMe).OrderBy(i => i.Ts).ToList();
                if (!St.Initialized)
                {
                    // First run after signing in: don't replay old items, only what arrives from now on.
                    var old = forMe.Where(i => !seenLive.Contains(i.Id)).Select(i => i.Id).ToList();
                    St.BaselineTs = Items.Where(i => !seenLive.Contains(i.Id)).Select(i => i.Ts).DefaultIfEmpty(0).Max();
                    St.ServerId = Cfg.ServerId;
                    foreach (var kv in Summaries()) St.LastRead[kv.Key] = kv.Value.Last.Ts;
                    St.Save();
                    St.Initialized = true;
                    St.MarkHandled(old);
                    St.SaveHandled();
                    Log.Write("First sync: " + old.Count + " older item(s) marked as seen");
                }
                // Also re-sends receipts that didn't reach the server (Consider acks handled items not yet delivered).
                foreach (var it in forMe) Consider(it);
                hotkeys.Retry();
                integrationTimer.Stop();
                integrationTimer.Start();
                if (outbox != null) outbox.Rescan();
                MarkChanged();
                LearnServer();
                LoadReadMarkers();
                CheckPendingLogins();
                if (!restored) { restored = true; RestoreTransfers(); }
                SweepPartials();
                BecameHealthy();
                if (!updateChecked) { updateChecked = true; CheckForUpdates(false, null); }
                RenewSignIn(); // once, for a sign-in that was ever kept in clear
            }
            catch (Exception ex) { Log.Error("Catch-up", ex); }
            finally
            {
                liveDuringCatchUp = null;
                catchingUp = false;
                if (catchUpAgain) { catchUpAgain = false; CatchUp(); }
            }
        }

        void BecameHealthy()
        {
            Health.MarkHealthy();
            if (cleanedUp) return;
            cleanedUp = true;
            Updater.CleanUp(Application.ExecutablePath, Cfg);
        }

        void OnEvent(string name, string data)
        {
            var d = Json.ParseObject(data);
            if (d == null) return;
            switch (name)
            {
                case "item":
                    var it = Item.Parse(d);
                    if (it == null) return;
                    seenLive.Add(it.Id);
                    if (liveDuringCatchUp != null) liveDuringCatchUp.Add(it.Id);
                    AddItem(it);
                    Consider(it);
                    break;
                case "delete":
                    if (liveDuringCatchUp != null) liveDuringCatchUp.Remove(Json.Str(d, "id") ?? "");
                    RemoveItem(Json.Str(d, "id"));
                    break;
                case "update":
                    Item existing;
                    string id = Json.Str(d, "id");
                    if (id != null && byId.TryGetValue(id, out existing) && Json.Get(d, "delivered") != null)
                    {
                        existing.Delivered = Json.LongMap(d, "delivered");
                        MarkChanged();
                    }
                    break;
                case "devices":
                {
                    bool phoneBefore = PhoneNotificationsOn == true;
                    Devices = Device.ListFrom(Json.Get(d, "devices"));
                    devicesLoaded = true;
                    PhoneSettingSeen(phoneBefore);
                    Rc.DevicesChanged();
                    if (menu.Visible) RefreshMenuPresence();
                    integrationTimer.Stop();
                    integrationTimer.Start();
                    MarkChanged();
                    break;
                }
                case "notification": // Beam 1.5: a phone notification for the devices showing them (urgent)
                    if (PhoneNotificationsOn == true) phone.OnNotification(d);
                    break;
                case "notification-removed":
                    phone.OnRemoved(d);
                    break;
                case "refresh": // devices were linked: senders/targets changed
                    CatchUp();
                    break;
                case "read":
                    if (Json.Str(d, "device") == Me && St.SetLastRead(FromPageConv(Json.Str(d, "conversation")), Json.Long(d, "ts", 0))) MarkChanged();
                    break;
                case "moved":
                    OnMoved(Json.Str(d, "movedTo"));
                    break;
                case "settings":
                    FetchServerInfo();
                    break;
                case "hello": // v3: the first event on every stream
                    ServerVersion = Json.Str(d, "version") ?? ServerVersion;
                    ServerApi = (int)Json.Long(d, "api", ServerApi);
                    serverFeatures.Clear();
                    foreach (var f in Json.StrList(d, "features")) serverFeatures.Add(f);
                    if (events != null) events.SetStream(Json.Str(d, "stream"), (int)Json.Long(d, "ping", 0));
                    modeSent = Json.Str(d, "mode") ?? "foreground"; // a new stream: the mode it was opened in
                    if (liveViews > 0) PokeMode("foreground"); // a new stream while the menu or picker is open
                    break;
                case "ping":
                    if (Json.Bool(d, "poke", false))
                    {
                        // A poke's ping answers every check waiting (two checks close together share it).
                        foreach (var w in pokeWaiters) w.TrySetResult(true);
                        pokeWaiters.Clear();
                    }
                    break;
                case "login-request":
                    var r = LoginRequest.Parse(d);
                    if (r != null && r.DeviceId != null && r.DeviceId == Me) return; // our own (the sign-in window)
                    OnLoginRequest(r, true);
                    break;
                case "login-request-done":
                    ApproveForm form;
                    string lid = Json.Str(d, "id");
                    if (lid != null && approvals.TryGetValue(lid, out form)) form.Settled(Json.Str(d, "status"));
                    break;
                case "app-update":
                    OnUpdateInfo(d, false, null);
                    break;
                case "ring": // Beam 1.3: only the device being rung reacts
                    if (Json.Str(d, "device") != Me) break;
                    if (Json.Bool(d, "stop", false)) ringer.Stop("stopped from " + ByName(Json.Str(d, "by")));
                    else ringer.Start(ByName(Json.Str(d, "by")));
                    break;
                case "alert":
                    OnAlert(d);
                    break;
                case "upload": // a file still arriving (Beam 1.4 servers can already serve what has arrived)
                    OnUploadProgress(d);
                    break;
                case "upload-cancelled":
                    OnUploadCancelled(Json.Str(d, "id"));
                    break;
                case "rc-request": // Beam 1.6: remote control of this PC (only its parties get these)
                case "rc-signal":
                case "rc-end":
                case "rc-disable":
                    Rc.OnEvent(name, d);
                    break;
            }
        }

        // From the stream's hello, or GET /api/info (both carry the server's `features`).
        public bool ServerHas(string feature)
        {
            return serverFeatures.Contains(feature) || (ServerInfo != null && Json.StrList(ServerInfo, "features").Contains(feature));
        }

        // ------------------------------------------------------------------ phone notifications (Beam 1.5)

        public bool PhoneFeature { get { return Api != null && ServerHas("phone-notifications"); } }

        // This PC's "Show phone notifications": a server-side setting of this device, from the device list (while a
        // change is on its way, the value asked for). Null when the server doesn't have the feature or the list isn't in.
        public bool? PhoneNotificationsOn
        {
            get
            {
                if (!PhoneFeature) return null;
                if (phoneWanted.HasValue) return phoneWanted.Value;
                var me = DeviceById(Me);
                return me != null ? me.PhoneNotifications : (bool?)null;
            }
        }

        // The tray checkbox, Settings (native or the page) and tests. Takes effect at once; changes made quickly one
        // after another go out in order, and the last one wins.
        public void SetPhoneNotifications(bool on, string from)
        {
            if (!PhoneFeature) return;
            if (PhoneNotificationsOn == on) return;
            phoneWanted = on;
            phoneChanges++;
            phoneGrace.Stop();
            Log.Write("Phone notifications " + (on ? "on" : "off") + " for this PC (" + from + ")");
            if (!on) phone.Clear();
            if (SettingsChanged != null) SettingsChanged();
            MarkChanged();
            if (!phoneSending) SendPhoneSetting();
        }

        async void SendPhoneSetting()
        {
            phoneSending = true;
            int mine = session;
            try
            {
                while (phoneWanted.HasValue && phoneSent != phoneWanted && Api != null && mine == session)
                {
                    bool on = phoneWanted.Value;
                    var body = new Dictionary<string, object>();
                    body["phoneNotifications"] = on;
                    try { await Api.SetDeviceSettings("me", body); }
                    catch (Exception ex)
                    {
                        if (mine != session) return;
                        Log.Write("Phone notifications: the server didn't take the change (" + Api.Describe(ex) + ")");
                        phoneWanted = null;
                        phoneSent = null;
                        notifier.Show("Couldn't turn phone notifications " + (on ? "on" : "off"), Api.Describe(ex), null, "phone notifications setting failed");
                        RefreshDevices(false);
                        break;
                    }
                    if (mine != session) return;
                    phoneSent = on;
                }
            }
            finally
            {
                if (mine == session)
                {
                    phoneSending = false;
                    // The value asked for stays until the server's device list shows it: a list held back from before
                    // the change (a background stream gets it with the next urgent event) must not undo it.
                    if (phoneWanted.HasValue) { phoneGrace.Stop(); phoneGrace.Start(); }
                    PhoneConfirm();
                }
                if (SettingsChanged != null) SettingsChanged();
                MarkChanged();
            }
        }

        // The server took the change and its device list now shows it: done waiting.
        void PhoneConfirm()
        {
            if (!phoneWanted.HasValue || phoneSending || phoneSent != phoneWanted) return;
            var me = DeviceById(Me);
            if (me == null || me.PhoneNotifications != phoneWanted.Value) return;
            phoneWanted = null;
            phoneSent = null;
            phoneGrace.Stop();
        }

        // settle: after waiting in vain for the device list to confirm a change, the server's fresh list decides, unless
        // the switch moved again while it was on its way (that list may be older than the new change). If the server
        // can't be asked, the wait goes on and it asks again later.
        async void RefreshDevices(bool settle)
        {
            var api = Api;
            if (api == null) return;
            int changes = phoneChanges;
            try
            {
                var list = await api.Devices();
                if (api != Api) return;
                bool before = PhoneNotificationsOn == true;
                Devices = list;
                if (settle && !phoneSending && changes == phoneChanges) { phoneWanted = null; phoneSent = null; }
                PhoneSettingSeen(before);
                MarkChanged();
            }
            catch (Exception ex)
            {
                Log.Error("Devices", ex);
                if (settle && api == Api && phoneWanted.HasValue) { phoneGrace.Stop(); phoneGrace.Start(); }
            }
        }

        // After a new device list: this PC's setting may have been changed elsewhere (another device's Settings).
        void PhoneSettingSeen(bool before)
        {
            PhoneConfirm();
            bool now = PhoneNotificationsOn == true;
            if (now == before) return;
            if (!phoneWanted.HasValue) Log.Write("Phone notifications are " + (now ? "on" : "off") + " for this PC");
            if (!now) phone.Clear();
            if (SettingsChanged != null) SettingsChanged();
        }

        // The page's Phone panel is on screen (the page says `viewing { conversation: "phone" }`).
        public bool WatchingPhone()
        {
            return main != null && !main.IsDisposed && main.IsShowing(new List<string> { "phone" });
        }

        // A click on a phone notification's balloon: the chat window on the Phone panel, with that notification.
        public void OpenPhoneNotification(string id)
        {
            ShowMain(null, null);
            if (main != null && !main.IsDisposed) main.OpenPhoneNotification(id);
        }

        // The stream holds presence (`devices`) for up to 3 minutes in background mode. While the tray menu or the
        // picker is open it switches to foreground (the poke also delivers what was held, so the dots are fresh).
        public void LiveViewOpened()
        {
            if (liveViews++ == 0) PokeMode("foreground");
        }

        public void LiveViewClosed()
        {
            if (liveViews > 0 && --liveViews == 0) PokeMode("background");
        }

        // Mode pokes go out one at a time; when one returns and the wish changed meanwhile (the menu closed while
        // "foreground" was on its way), the latest wish is sent. A failed switch is retried by the next one, and a
        // new stream starts in background mode anyway.
        async void PokeMode(string mode)
        {
            streamMode = mode;
            if (modePoking) return;
            modePoking = true;
            try
            {
                while (true)
                {
                    var ev = events;
                    var api = Api;
                    string want = streamMode;
                    if (ev == null || api == null || ev.StreamId == null || !ServerHas("stream-modes") || Conn != Conn.Online) return;
                    if (want == modeSent) return;
                    try
                    {
                        var body = new Dictionary<string, object>();
                        body["stream"] = ev.StreamId;
                        body["mode"] = want;
                        var d = Json.Obj(await api.Call(HttpMethod.Post, "/api/events/poke", body, 10, CancellationToken.None));
                        if (events != ev) return;
                        if (!Json.Bool(d, "alive", false)) { ev.Kick(); return; }
                        modeSent = want;
                        // The dead-stream limit stays at the background value (2 × 180 + 20 s) set by the stream's
                        // hello: a foreground spell lasts as long as a menu is open, and a shorter limit would race
                        // the switch back.
                        Log.Write("Events: stream in " + (Json.Str(d, "mode") ?? want) + " mode (ping " + Json.Long(d, "ping", 0) + " s)");
                    }
                    catch (Exception ex)
                    {
                        Log.Write("Events: switching to " + want + " failed (" + Api.Describe(ex) + ")");
                        return;
                    }
                }
            }
            finally { modePoking = false; }
        }

        // Fresh presence arrived while the tray menu is open: update the device entries in place.
        void RefreshMenuPresence()
        {
            foreach (var clip in menu.Items.OfType<ToolStripMenuItem>().Where(i => i.HasDropDownItems))
                foreach (var mi in clip.DropDownItems.OfType<ToolStripMenuItem>())
                {
                    var id = mi.Tag as string;
                    var dev = id != null ? DeviceById(id) : null;
                    if (dev == null) continue;
                    mi.Text = dev.Name + (dev.Online ? "" : "  (offline)");
                    var old = mi.Image;
                    mi.Image = MenuRenderer.Dot(dev.Online ? Theme.Online : Theme.Offline);
                    if (old != null) old.Dispose();
                }
            // The menu's poke also brings a `devices` event held back: "Show phone notifications" follows it.
            var phoneItem = menu.Items.OfType<ToolStripMenuItem>().FirstOrDefault(i => "phone" == i.Tag as string);
            if (phoneItem != null && PhoneNotificationsOn.HasValue) phoneItem.Checked = PhoneNotificationsOn.Value;
        }

        // After waking up or a network change: is the event stream still alive? With a Beam 1.4 server a poke answers
        // that in a round trip (and flushes anything held back) without reconnecting and re-reading everything;
        // otherwise, or when it's gone, reconnect now instead of waiting for the heartbeat to be missed.
        async void CheckStream(string why)
        {
            var ev = events;
            var api = Api;
            if (ev == null || api == null) return;
            string stream = ev.StreamId;
            if (stream == null || !ServerHas("stream-modes") || Conn != Conn.Online) { ev.Kick(); return; }
            var answered = new TaskCompletionSource<bool>();
            pokeWaiters.Add(answered);
            try
            {
                var body = new Dictionary<string, object>();
                body["stream"] = stream;
                var d = Json.Obj(await api.Call(HttpMethod.Post, "/api/events/poke", body, 10, CancellationToken.None));
                if (events != ev) return;
                if (!Json.Bool(d, "alive", false)) { Log.Write("Events: the stream was gone after " + why + ", reconnecting"); ev.Kick(); return; }
                if (await Task.WhenAny(answered.Task, Task.Delay(5000)) != answered.Task)
                {
                    if (events != ev) return;
                    Log.Write("Events: no answer on the stream after " + why + ", reconnecting");
                    ev.Kick();
                }
                else Log.Write("Events: the stream is fine after " + why);
            }
            catch (Exception ex)
            {
                if (events != ev) return;
                Log.Write("Events: checking the stream after " + why + " failed (" + Api.Describe(ex) + "), reconnecting");
                ev.Kick();
            }
            finally { pokeWaiters.Remove(answered); }
        }

        // Big files for this PC start saving while they're still being sent, so they're here moments after the sender
        // finishes (the download trails the upload). Small ones just wait for their item.
        const long SaveWhileArriving = 32L << 20;

        void OnUploadProgress(Dictionary<string, object> d)
        {
            if (!ServerHas("live-download") || !St.Initialized || !Cfg.AutoSave || !devicesLoaded) return;
            var it = Item.Parse(d);
            if (it == null) return;
            it.Kind = "file";
            if (it.Size < SaveWhileArriving || it.Size > Cfg.MaxSaveBytes || !IsForMe(it)) return;
            DownloadJob running;
            if (Downloads.TryGetValue(it.Id, out running))
            {
                if (running.Active) { if (running.Early) running.WakeUp(); return; } // more arrived
                if (!running.Early) return;
                Downloads.Remove(it.Id); // an early download that gave up: its sender is back, so start again
            }
            if (St.IsHandled(it.Id) || receiving.Contains(it.Id)) return;
            if (it.Ts == 0) it.Ts = Fmt.NowMs();
            receiving.Add(it.Id);
            Log.Write("Saving " + it.Id + " while it's still arriving (" + it.Size + " bytes)");
            StartDownload(it, true, null, null, true);
        }

        // The sender cancelled an upload: an early download of it stops, and its partial file goes in any case
        // (also when that download had already failed, or Beam wasn't running when it started).
        void OnUploadCancelled(string id)
        {
            if (id == null || byId.ContainsKey(id)) return;
            DownloadJob job;
            if (Downloads.TryGetValue(id, out job) && job.Early)
            {
                Log.Write("Download " + job.TransferId + ": the sender cancelled it");
                job.SenderCancelled = true;
                if (job.Active) { down.Cancel(job); return; } // the partial file is deleted when it stops
                Downloads.Remove(id);
                if (TransferRemoved != null) TransferRemoved(job.TransferId, null);
                if (job.PartPath != null) FileUtil.TryDelete(job.PartPath);
            }
            DeletePartials(id);
        }

        // Partial files of uploads that will never finish: `<name>.<id>.beampart` in the save folder.
        void DeletePartials(string id)
        {
            try
            {
                string folder = Cfg.SaveFolderPath;
                if (!Directory.Exists(folder)) return;
                foreach (var f in Directory.GetFiles(folder, "*." + id + ".beampart"))
                {
                    FileUtil.TryDelete(f);
                    Log.Write("Removed the partial file of cancelled upload " + id);
                }
            }
            catch (Exception ex) { Log.Error("Partial files", ex); }
        }

        // After a catch-up: partial files whose id is neither an item nor an upload still in progress (the sender
        // cancelled while Beam was off, or the upload expired) are leftovers.
        async void SweepPartials()
        {
            var api = Api;
            if (api == null) return;
            string[] files;
            try
            {
                string folder = Cfg.SaveFolderPath;
                if (!Directory.Exists(folder)) return;
                files = Directory.GetFiles(folder, "*.beampart");
            }
            catch { return; }
            foreach (var f in files.Take(20))
            {
                string name = Path.GetFileNameWithoutExtension(f); // "<name>.<id>"
                int dot = name.LastIndexOf('.');
                string id = dot >= 0 ? name.Substring(dot + 1) : null;
                if (!Config.ValidId(id) || byId.ContainsKey(id) || Downloads.ContainsKey(id)) continue;
                try
                {
                    await api.Call(HttpMethod.Get, "/api/uploads/" + id, null, 15, CancellationToken.None);
                    continue; // still arriving
                }
                catch (ApiException ex)
                {
                    if (ex.Status != 404 || api != Api) continue;
                }
                catch { continue; }
                try { await api.GetItem(id); continue; } // finished meanwhile: the auto-save resumes it
                catch (ApiException ex) { if (ex.Status != 404 || api != Api) continue; }
                catch { continue; }
                FileUtil.TryDelete(f);
                Log.Write("Removed a partial file of an upload that never finished (" + id + ")");
            }
        }

        // A device id -> its name (else the text as given, e.g. when the server already sent a name).
        string ByName(string idOrName)
        {
            if (string.IsNullOrEmpty(idOrName)) return null;
            var dev = DeviceById(idOrName);
            return dev != null ? dev.Name : idOrName;
        }

        // Beam 1.3 alerts (battery/storage low, a device offline, the server's disk). Alerts about this PC itself are
        // left out (it knows), except the server's disk.
        void OnAlert(Dictionary<string, object> d)
        {
            string id = Json.Str(d, "id"), kind = Json.Str(d, "kind") ?? "alert", device = Json.Str(d, "device"), text = Json.Str(d, "text");
            if (string.IsNullOrEmpty(text)) return;
            if (device != null && device == Me && kind != "serverDisk") return;
            if (id != null && !alertsShown.Add(id)) return;
            bool warn = Json.Str(d, "level") == "warn";
            string conv = device != null && device != Me && DeviceById(device) != null ? device : null;
            notifier.Show(warn ? "Beam alert" : "Beam", text, () => ShowMain(conv, null), "alert " + kind, warn ? ToolTipIcon.Warning : ToolTipIcon.Info);
        }

        // The page's "Remote Desktop" action (bridge remoteDesktop): Windows' own client for that computer.
        public string StartRemoteDesktop(string host)
        {
            if (TestOffscreen) { Log.Write("Remote Desktop: not started (test instance)"); return null; }
            try
            {
                string exe = Path.Combine(Environment.SystemDirectory, "mstsc.exe");
                if (!File.Exists(exe)) return "Remote Desktop Connection isn't installed on this PC";
                var psi = new System.Diagnostics.ProcessStartInfo(exe, "/v:" + host);
                psi.UseShellExecute = false;
                System.Diagnostics.Process.Start(psi);
                Log.Write("Remote Desktop started");
                return null;
            }
            catch (Exception ex)
            {
                Log.Error("Remote Desktop", ex);
                return "Couldn't start Remote Desktop Connection";
            }
        }

        // The server says which id it knows us by (e.g. after linking devices on one machine).
        void AdoptId(string you)
        {
            if (!Config.ValidId(you) || you == Cfg.DeviceId) return;
            Log.Write("Server knows this PC as " + you + " (was " + Cfg.DeviceId + "); adopting it");
            Cfg.DeviceId = you;
            Cfg.Save();
            if (main != null) main.IdentityChanged();
            StartEvents();
        }

        // API v3: the server replaced the master key with a device token of our own.
        void AdoptToken(string token)
        {
            if (string.IsNullOrEmpty(token) || token == Cfg.Key) return;
            Cfg.Key = token;
            Cfg.RotateToken = false; // the server's own new token was never in clear
            Cfg.Save();
            Log.Write("Switched to a device token for this PC");
            if (main != null) main.IdentityChanged();
            foreach (var w in remoteViews.Values) w.CookieAgain();
        }

        // Beam 1.6: a sign-in that config.json once kept in clear (before 1.6, or the installer's) is replaced, once, after
        // this install's device key is bound: copies of the old file (backups, a leftover .tmp) then hold a revoked token.
        // The new token is for the same device and bound to the key (POST /api/login with the old one, the app's way of
        // getting a token of its own). Only then is the old one revoked (/api/logout). Anything that fails keeps the
        // current sign-in and tries again at the next start: a failed renewal never signs this PC out.
        bool renewing;

        async void RenewSignIn()
        {
            if (renewing || Api == null || DeviceKey.Value == null || !Cfg.Paired) return;
            renewing = true;
            var api = Api;
            int mine = session;
            try
            {
                if (!string.IsNullOrEmpty(Cfg.RevokeKey) && Cfg.RevokeKey != Cfg.Key)
                {
                    await RevokeOldKey(Cfg.RevokeKey); // a renewal whose revocation didn't get through
                    return;
                }
                if (!Cfg.RotateToken) return;
                string old = Cfg.Key;
                var body = new Dictionary<string, object>();
                body["secret"] = old;
                body["client"] = "app";
                body["platform"] = "windows";
                body["deviceId"] = Cfg.DeviceId;
                Dictionary<string, object> d;
                try { d = await Api.Anon(HttpMethod.Post, Cfg.Server.TrimEnd('/') + "/api/login", body, 20, CancellationToken.None, null); }
                catch (Exception ex) { Log.Write("Sign-in renewal: not now (" + Api.Describe(ex) + "); this PC keeps its sign-in and tries again at the next start"); return; }
                if (api != Api || mine != session || Cfg.Key != old) return; // changed meanwhile: the next start looks again
                string fresh = Json.Str(d, "key"), you = Json.Str(d, "you");
                if (string.IsNullOrEmpty(fresh) || fresh == old || you != Cfg.DeviceId)
                {
                    // Not a token of this same device (no key binding yet?): drop it, keep the current one.
                    if (!string.IsNullOrEmpty(fresh) && fresh != old) { try { await new Api(Cfg.Server, fresh, Cfg).Call(HttpMethod.Post, "/api/logout", null, 15, CancellationToken.None); } catch { } }
                    Log.Write("Sign-in renewal: the server didn't renew it for this device; this PC keeps its sign-in and tries again at the next start");
                    return;
                }
                Cfg.Key = fresh;
                Cfg.RotateToken = false;
                Cfg.RevokeKey = old; // until the server has revoked it
                Cfg.Save();
                if (main != null) main.IdentityChanged();
                foreach (var w in remoteViews.Values) w.CookieAgain();
                if (events != null) events.Kick(); // the stream again, with the new sign-in
                await RevokeOldKey(old);
            }
            catch (Exception ex) { Log.Error("Sign-in renewal", ex); }
            finally { renewing = false; }
        }

        async Task RevokeOldKey(string old)
        {
            try { await new Api(Cfg.Server, old, Cfg).Call(HttpMethod.Post, "/api/logout", null, 15, CancellationToken.None); }
            catch (ApiException ex) { if (ex.Status != 401) { Log.Write("Sign-in renewal: the old sign-in wasn't revoked yet (" + ex.Status + "); tried again at the next start"); return; } }
            catch (Exception ex) { Log.Write("Sign-in renewal: the old sign-in wasn't revoked yet (" + Api.Describe(ex) + "); tried again at the next start"); return; }
            if (Cfg.RevokeKey == old) { Cfg.RevokeKey = null; Cfg.Save(); }
            Log.Write("Sign-in renewed: this PC has a new sign-in bound to its device key, and the old one is revoked");
        }

        async void LoadReadMarkers()
        {
            if (Api == null || ServerApi < 3) return;
            try
            {
                var me = await Api.Me();
                var read = Json.Obj(Json.Get(me, "read"));
                bool changed = false;
                if (read != null)
                    foreach (var kv in read)
                    {
                        long ts;
                        try { ts = Convert.ToInt64(kv.Value); } catch { continue; }
                        changed |= St.SetLastRead(FromPageConv(kv.Key), ts);
                    }
                if (changed) MarkChanged();
            }
            catch (Exception ex) { Log.Error("Read markers", ex); }
        }

        public async void FetchServerInfo()
        {
            if (Api == null) return;
            try
            {
                ServerInfo = await Api.Info();
                if (ServerInfo != null)
                {
                    ServerVersion = Json.Str(ServerInfo, "version") ?? ServerVersion;
                    ServerApi = (int)Json.Long(ServerInfo, "api", ServerApi);
                }
                if (SettingsChanged != null) SettingsChanged();
            }
            catch (Exception ex) { Log.Error("Server info", ex); }
        }

        // ------------------------------------------------------------------ when the server moves

        // Learns the server's permanent id and API version (used to recognise it at a new address).
        async void LearnServer()
        {
            if (Api == null) return;
            try
            {
                var hello = await Api.Hello(Cfg.Server, 15, CancellationToken.None);
                ServerVersion = Json.Str(hello, "version");
                ServerApi = (int)Json.Long(hello, "api", 2);
                string id = Json.Str(hello, "serverId");
                if (!string.IsNullOrEmpty(id) && string.IsNullOrEmpty(Cfg.ServerId))
                {
                    Cfg.ServerId = id;
                    Cfg.Save();
                    Log.Write("Server id " + id);
                }
                if (!string.IsNullOrEmpty(id) && St.ServerId == null) { St.ServerId = id; St.SaveHandled(); }
                var urls = Json.StrList(hello, "urls").Select(Api.NormalizeBase).Where(u => u != null).Distinct().ToList();
                if (urls.Count > 0 && !urls.SequenceEqual(Cfg.KnownUrls)) { Cfg.KnownUrls = urls; Cfg.Save(); }
                string moved = Json.Str(hello, "movedTo");
                if (!string.IsNullOrEmpty(moved)) OnMoved(moved);
                FetchServerInfo();
            }
            catch (Exception ex) { Log.Error("Learning about the server", ex); }
        }

        // A 410 { movedTo } from any call, or a "moved" event: check the new address is the same Beam (and on API v3
        // that it can prove it knows our key), then switch to it.
        async void OnMoved(string movedTo)
        {
            if (switchingServer || !Cfg.Paired || string.IsNullOrEmpty(movedTo)) return;
            string target = Api.NormalizeBase(movedTo);
            if (target == null || Discovery.SameUrl(target, Cfg.Server)) return;
            switchingServer = true;
            try
            {
                string expected = Cfg.ServerId;
                if (string.IsNullOrEmpty(expected))
                {
                    try { expected = Json.Str(await Api.Hello(Cfg.Server, 10, CancellationToken.None), "serverId"); }
                    catch { }
                }
                for (int hop = 0; hop < 3; hop++)
                {
                    string nonce = Api.NewNonce();
                    var hello = await Api.Hello(target, 15, CancellationToken.None, nonce, Cfg.Key);
                    if (!Api.IsOurServer(hello, expected, Cfg.Key, nonce))
                    {
                        Log.Write("Server says it moved to " + target + ", but that isn't our Beam (or it can't prove it); staying");
                        return;
                    }
                    string further = Api.NormalizeBase(Json.Str(hello, "movedTo"));
                    if (further == null || Discovery.SameUrl(further, target)) break;
                    target = further; // moved again
                }
                SwitchServer(target, "Beam moved to " + HostOf(target));
            }
            catch (Exception ex) { Log.Write("Server moved to " + target + " but it isn't reachable yet: " + Api.Describe(ex)); }
            finally { switchingServer = false; }
        }

        void SwitchServer(string url, string message)
        {
            Log.Write("Server: switching from " + Cfg.Server + " to " + url);
            Cfg.Server = url;
            Cfg.Save();
            offlineSince = null;
            PageBridge = null;
            StartEvents();
            integrationTimer.Stop();
            integrationTimer.Start(); // refreshes the Send to shortcuts and outbox folders
            if (main != null) main.ServerChanged();
            notifier.Show(message, "Beam switched over by itself; nothing else to do.", () => ShowMain(null, null), "moved");
            MarkChanged();
        }

        public static string HostOf(string url)
        {
            Uri u;
            return Uri.TryCreate(url ?? "", UriKind.Absolute, out u) ? (u.IsDefaultPort ? u.Host : u.Host + ":" + u.Port) : url;
        }

        // Long offline (timeouts): look for our Beam (same serverId) on the tailnet every RediscoverSec.
        void MaybeRediscover()
        {
            if (!Cfg.Paired || Conn == Conn.Online || offlineSince == null || switchingServer) return;
            if (events != null && events.Unauthorized) return;
            var limit = TimeSpan.FromSeconds(Cfg.RediscoverSec);
            if (DateTime.Now - offlineSince.Value < limit || DateTime.Now - lastRediscovery < limit) return;
            Rediscover("unreachable for " + (int)(DateTime.Now - offlineSince.Value).TotalMinutes + " min");
        }

        async void Rediscover(string why)
        {
            if (switchingServer || string.IsNullOrEmpty(Cfg.ServerId) || !Discovery.CanSeeTailnet()) return;
            lastRediscovery = DateTime.Now;
            switchingServer = true;
            try
            {
                Log.Write("Looking for this Beam on the tailnet (" + why + ")");
                var found = await Discovery.FindOurs(Cfg.ServerId, Cfg.Key, Cfg.Server, Cfg.KnownUrls, CancellationToken.None);
                if (found != null) { switchingServer = false; SwitchServer(found.Url, "Found Beam at " + HostOf(found.Url)); }
                else Log.Write("Rediscovery: not found");
            }
            catch (Exception ex) { Log.Error("Rediscovery", ex); }
            finally { switchingServer = false; }
        }

        // ------------------------------------------------------------------ approving sign-ins

        async void CheckPendingLogins()
        {
            if (Api == null) return;
            try
            {
                foreach (var r in await Api.PendingLogins())
                    if (r.DeviceId == null || r.DeviceId != Me) OnLoginRequest(r, true);
            }
            catch (Exception ex) { Log.Error("Pending sign-ins", ex); }
        }

        void OnLoginRequest(LoginRequest r, bool automatic)
        {
            if (r == null || r.Id == null || approvals.ContainsKey(r.Id) || dismissedLogins.Contains(r.Id)) return;
            Log.Write("Sign-in request " + r.Id + " (" + r.Where + ")");
            var form = new ApproveForm(this, r, automatic);
            TrackApproval(form);
            form.ShowNearTray(approvals.Count - 1);
            if (main == null || !main.IsActive)
                notifier.Show(r.Name + " wants to sign in to Beam", "From " + r.Where + " · code " + r.Code, () => { if (!form.IsDisposed) { form.Activate(); Native.SetForegroundWindow(form.Handle); } }, "sign-in request");
        }

        public void TrackApproval(ApproveForm form)
        {
            string id = form.RequestId;
            if (id == null || approvals.ContainsKey(id)) return;
            approvals[id] = form;
            form.FormClosed += (s, e) =>
            {
                approvals.Remove(id);
                if (!form.Answered) dismissedLogins.Add(id); // closed without answering: don't pop up again
            };
        }

        public bool FocusApproval(string id)
        {
            ApproveForm f;
            if (id == null || !approvals.TryGetValue(id, out f) || f.IsDisposed) return false;
            f.Activate();
            Native.SetForegroundWindow(f.Handle);
            return true;
        }

        public void ShowApproveCode()
        {
            if (RcBlocks("approving a sign-in")) return;
            if (!Cfg.Paired || Api == null) { ShowPairing(PairMode.First); return; }
            var form = new ApproveForm(this, null, false);
            form.ShowNearTray(0);
        }

        public void Notify(string title, string text)
        {
            notifier.Show(title, text, null, title);
        }

        // ------------------------------------------------------------------ updates

        void SetUpdateState(string state, string version, string error)
        {
            UpdateState = state;
            if (version != null) UpdateVersion = version;
            UpdateError = error;
            if (UpdateChanged != null) UpdateChanged();
        }

        public async void CheckForUpdates(bool manual, Action<string> report)
        {
            if (Api == null) { if (report != null) report("Couldn't check: not signed in"); return; }
            try
            {
                var d = Json.Obj(await Api.Call(HttpMethod.Get, "/api/updates"));
                OnUpdateInfo(d, manual, report);
            }
            catch (Exception ex)
            {
                Log.Error("Update check", ex);
                if (report != null) report("Couldn't check for updates: " + Api.Describe(ex));
            }
        }

        void OnUpdateInfo(Dictionary<string, object> d, bool manual, Action<string> report)
        {
            var u = Updater.FromUpdates(d);
            if (!Updater.IsNewer(u))
            {
                SetUpdateState("none", null, null);
                if (report != null) report("Beam " + AppVersion.Text + " is up to date.");
                return;
            }
            if (u.Version == Cfg.BadUpdateVersion && !manual)
            {
                if (report != null) report("Beam " + u.Version + " didn't work on this PC before, so it's skipped.");
                return;
            }
            if (!manual && refusedOffer == u.Version + "|" + u.Sha256) return; // (each reconnect would fetch it again)
            Log.Write("Update available: " + u.Version + " (running " + AppVersion.Text + ")");
            SetUpdateState("available", u.Version, null);
            if (!Cfg.AutoUpdate && !manual)
            {
                if (updateOfferedVersion != u.Version)
                {
                    updateOfferedVersion = u.Version;
                    pendingUpdate = u;
                    notifier.Show("Beam " + u.Version + " is available", "Click to install it now.", InstallUpdateNow, "update available");
                }
                return;
            }
            pendingUpdate = u;
            if (report != null) report("Installing Beam " + u.Version + "…");
            TryInstallUpdate();
        }

        public void InstallUpdateNow()
        {
            if (pendingUpdate == null) { CheckForUpdates(true, null); return; }
            TryInstallUpdate();
        }

        // Early downloads waiting for their sender don't count: their partial file is picked up again after a restart.
        public bool TransfersBusy()
        {
            return Uploads.Any(j => j.Active) || Downloads.Values.Any(Busy);
        }

        async void TryInstallUpdate()
        {
            var u = pendingUpdate;
            if (u == null || updating || quitting || Api == null) return;
            if (TransfersBusy() || Rc.Active || remoteViews.Count > 0)
            {
                Log.Write("Update " + u.Version + " waits until " + (Rc.Active ? "the remote control session ends" : remoteViews.Count > 0 ? "the remote control windows close" : "transfers finish"));
                SetUpdateState("waiting", u.Version, null);
                updateRetryTimer.Interval = 30000;
                updateRetryTimer.Start();
                return;
            }
            string exe = Application.ExecutablePath;
            if (!Updater.CanReplace(exe))
            {
                pendingUpdate = null;
                string link = Cfg.Server.TrimEnd('/') + "/download/windows";
                Log.Write("Update " + u.Version + ": can't write to " + Path.GetDirectoryName(exe));
                SetUpdateState("failed", u.Version, "Beam can't update itself in its folder");
                notifier.Show("Beam " + u.Version + " is available", "Beam can't update itself in this folder. Click to download the new version.", () => FileUtil.OpenUrl(link), "update available");
                return;
            }
            updating = true;
            SetUpdateState("downloading", u.Version, null);
            try
            {
                Log.Write("Downloading update " + u.Version);
                await Updater.Download(Api, u, exe, CancellationToken.None);
                if (TransfersBusy() || Rc.Active || remoteViews.Count > 0) { updating = false; SetUpdateState("waiting", u.Version, null); updateRetryTimer.Interval = 30000; updateRetryTimer.Start(); return; }
                string error;
                if (!Updater.Swap(exe, out error)) throw new IOException("the new version couldn't be put in place (" + error + ")");
                Log.Write("Update " + u.Version + " verified and in place; handing over");
                SetUpdateState("ready", u.Version, null);
                var h = new Handoff();
                h.Exe = exe;
                h.NewVersion = u.Version;
                h.OldVersion = AppVersion.Text;
                h.Show = main != null && main.Visible && main.WindowState != FormWindowState.Minimized;
                Program.Handoff = h;
                Quit(false);
            }
            catch (Exception ex)
            {
                updating = false;
                // A bad download is dropped; anything else (antivirus holding a file, network) is tried again later.
                bool retry = !(ex is InvalidDataException);
                if (!retry) { pendingUpdate = null; refusedOffer = u.Version + "|" + u.Sha256; }
                string why = ex is InvalidDataException || ex is IOException ? ex.Message : Api.Describe(ex);
                Log.Write("Update " + u.Version + " failed: " + why + (retry ? "; trying again in 10 minutes" : ""));
                SetUpdateState("failed", u.Version, why);
                if (updateFailNotified != u.Version)
                {
                    updateFailNotified = u.Version;
                    notifier.Show("Couldn't update Beam", "Update to " + u.Version + ": " + why + (retry ? "\nBeam tries again by itself." : ""), null, "update failed");
                }
                if (retry)
                {
                    updateRetryTimer.Stop();
                    updateRetryTimer.Interval = 10 * 60 * 1000;
                    updateRetryTimer.Start();
                }
            }
        }

        void SyncIntegrations()
        {
            if (!Cfg.Paired || !devicesLoaded) return;
            SendToMenu.Sync(this);
            if (Cfg.Outbox)
            {
                if (outbox == null || outbox.Root != Cfg.OutboxFolderPath)
                {
                    if (outbox != null) outbox.Dispose();
                    outbox = new Outbox(this, Cfg.OutboxFolderPath);
                    outbox.Start();
                }
                else outbox.EnsureFolders();
            }
            else if (outbox != null)
            {
                outbox.Dispose();
                outbox = null;
            }
        }

        // ------------------------------------------------------------------ item store

        // The server's whole list (a catch-up). Items that came in live while it was on its way stay: the list was made
        // before they existed.
        void SetItems(List<Item> list, ICollection<string> cameLive)
        {
            var had = new Dictionary<string, Item>(byId);
            var listed = new HashSet<string>(list.Select(i => i.Id));
            if (cameLive != null)
                foreach (var id in cameLive)
                {
                    Item live;
                    if (!listed.Contains(id) && had.TryGetValue(id, out live)) { list.Add(live); listed.Add(id); }
                }
            Items = list.OrderByDescending(i => i.Ts).ToList();
            byId.Clear();
            foreach (var it in Items) byId[it.Id] = it;
            // An item that was here and isn't any more was deleted: its download stops. A download whose file isn't an
            // item yet (saved while it arrives, also after Retry) is never stopped here: it ends with its upload.
            foreach (var id in Downloads.Keys.ToList())
            {
                var job = Downloads[id];
                if (job.Active && had.ContainsKey(id) && !byId.ContainsKey(id)) { job.ItemDeleted = true; down.Cancel(job); }
            }
            MarkChanged();
        }

        void AddItem(Item it)
        {
            Item old;
            if (byId.TryGetValue(it.Id, out old))
            {
                old.Delivered = it.Delivered;
                MarkChanged();
                return;
            }
            byId[it.Id] = it;
            int idx = 0;
            while (idx < Items.Count && Items[idx].Ts > it.Ts) idx++;
            Items.Insert(idx, it);
            MarkChanged();
        }

        void RemoveItem(string id)
        {
            Item it;
            if (id == null || !byId.TryGetValue(id, out it)) return;
            byId.Remove(id);
            Items.Remove(it);
            DownloadJob job;
            if (Downloads.TryGetValue(id, out job))
            {
                job.ItemDeleted = true;
                down.Cancel(job);
                Downloads.Remove(id);
            }
            MarkChanged();
        }

        public Item ItemById(string id)
        {
            Item it;
            return id != null && byId.TryGetValue(id, out it) ? it : null;
        }

        // ------------------------------------------------------------------ devices & conversations

        public Device DeviceById(string id)
        {
            if (id == null) return null;
            foreach (var d in Devices) if (d.Id == id) return d;
            return null;
        }

        Device DeviceByName(string name)
        {
            if (string.IsNullOrEmpty(name)) return null;
            foreach (var d in Devices) if (string.Equals(d.Name, name, StringComparison.OrdinalIgnoreCase)) return d;
            return null;
        }

        public string NameOf(string id)
        {
            if (id == "*") return "All devices";
            if (id == Me) return Cfg.DeviceName;
            var d = DeviceById(id);
            if (d != null) return d.Name;
            foreach (var it in Items) if (it.From == id) return it.DeviceName;
            return "Removed device";
        }

        public string NamesOf(List<string> to)
        {
            if (to == null || to.Count == 0) return "all devices";
            var names = to.Select(NameOf).ToList();
            return names.Count <= 2 ? string.Join(" and ", names) : names[0] + ", " + names[1] + " +" + (names.Count - 2);
        }

        public string SenderName(Item it)
        {
            if (it.From == Me) return "You";
            var d = DeviceById(it.From);
            return d != null ? d.Name : it.DeviceName;
        }

        public bool IsForMe(Item it)
        {
            return (it.To.Count == 0 || it.To.Contains(Me)) && it.From != Me;
        }

        // Conversations an item belongs to (docs/API.md "Conversations"). "*" is All devices.
        public List<string> ConvsOf(Item it)
        {
            var list = new List<string>(2);
            string me = Me;
            if (it.To.Count == 0)
            {
                list.Add("*");
                if (it.From != null && it.From != me) list.Add(it.From);
                return list;
            }
            if (it.From == me)
            {
                foreach (var t in it.To) if (t != me && !list.Contains(t)) list.Add(t);
                return list;
            }
            if (it.From != null)
            {
                if (it.To.Contains(me)) list.Add(it.From);
                return list;
            }
            // Old item without a sender id: file it under the device(s) it targets.
            foreach (var t in it.To) if (t != me && !list.Contains(t)) list.Add(t);
            if (it.To.Contains(me))
            {
                var d = DeviceByName(it.DeviceName);
                string key = d != null && d.Id != me ? d.Id : "*";
                if (!list.Contains(key)) list.Add(key);
            }
            return list;
        }

        public Dictionary<string, ConvSummary> Summaries()
        {
            var map = new Dictionary<string, ConvSummary>();
            foreach (var it in Items) // newest first
            {
                bool forMe = IsForMe(it);
                foreach (var conv in ConvsOf(it))
                {
                    ConvSummary s;
                    if (!map.TryGetValue(conv, out s)) { s = new ConvSummary(); s.Last = it; map[conv] = s; }
                    if (forMe && it.Ts > St.GetLastRead(conv)) s.Unread++;
                }
            }
            return map;
        }

        // "all" (the web app's name for All devices) <-> "*".
        public static string FromPageConv(string conv) { return conv == null || conv == "all" ? "*" : conv; }
        public static string ToPageConv(string conv) { return conv == null || conv == "*" ? "all" : conv; }

        public void MarkRead(string conv, long ts)
        {
            if (St.SetLastRead(conv, ts)) MarkChanged();
        }

        // Pages that don't report what's read: everything counts as read once the window has been looked at.
        public void MarkAllRead()
        {
            bool changed = false;
            foreach (var kv in Summaries()) changed |= St.SetLastRead(kv.Key, kv.Value.Last.Ts);
            if (changed) MarkChanged();
        }

        public List<Device> OtherDevices()
        {
            return Devices.Where(d => d.Id != Me).OrderByDescending(d => d.Online).ThenBy(d => d.Name, StringComparer.CurrentCultureIgnoreCase).ToList();
        }

        // ------------------------------------------------------------------ receiving

        void Consider(Item it)
        {
            if (!IsForMe(it) || !St.Initialized) return;
            DownloadJob job;
            bool saving = Downloads.TryGetValue(it.Id, out job) && job.Active;
            if (saving && job.Early) job.WakeUp(); // the sender finished: no need to wait out a pause
            if (St.IsHandled(it.Id))
            {
                // Handled but the server doesn't know yet: a file saved while it was still arriving (its receipt
                // went out before the item existed), or an ack lost while offline. Items from before signing in
                // aren't acked. A file still being saved (a retry) is acked once it's saved.
                if (!saving && !it.Delivered.ContainsKey(Me) && it.Ts > St.BaselineTs) Ack(it);
                return;
            }
            if (receiving.Contains(it.Id)) return;
            receiving.Add(it.Id);
            if (it.IsText) ReceiveText(it);
            else ReceiveFile(it);
        }

        bool Watching(Item it)
        {
            return main != null && main.IsShowing(ConvsOf(it));
        }

        async void ReceiveText(Item it)
        {
            string text = it.Text;
            int mine = session;
            if (it.Truncated)
            {
                try { text = await Api.FullText(it.Id) ?? text; }
                catch (Exception ex) { Log.Error("Fetching full text", ex); }
                if (mine != session) return; // signed out meanwhile
            }
            bool copied = Cfg.AutoCopy && ClipPayload.SetText(text, Cfg.ClipboardHistory);
            Log.Write("Received text " + it.Id + " from " + it.DeviceName + (copied ? " (copied)" : ""));
            // "Open links sent to this PC automatically": only a link sent to this PC itself (not to all devices), and
            // only while it's fresh (not a week-old link found when the PC wakes up).
            if (Cfg.AutoOpenLinks && Fmt.IsLink(text) && it.To.Contains(Me) && it.From != Me && Math.Abs(Fmt.NowMs() - it.Ts) < 10 * 60 * 1000)
            {
                FileUtil.OpenUrl(text.Trim());
                Log.Write("Opened the link in " + it.Id);
                if (!Watching(it)) notifier.ShowItem("Opened a link from " + SenderName(it), Fmt.OneLine(text, 180), null, "link opened " + it.Id, it.Id);
                St.MarkHandled(it.Id);
                receiving.Remove(it.Id);
                Ack(it);
                return;
            }
            if (!Watching(it))
            {
                string id = it.Id;
                bool link = Fmt.IsLink(text);
                string body = Fmt.OneLine(text, 180);
                Action click;
                string hint;
                if (link && Cfg.OpenLinks) { string url = text.Trim(); click = () => FileUtil.OpenUrl(url); hint = "Click to open the link"; }
                else if (!copied) { string full = text; click = () => { if (ClipPayload.SetText(full, Cfg.ClipboardHistory)) notifier.Show("Copied", Fmt.OneLine(full, 80), null, "copied"); }; hint = "Click to copy it"; }
                else { click = () => OpenItem(id); hint = "Copied to the clipboard"; }
                notifier.ShowItem((link ? "Link from " : "Text from ") + SenderName(it), body + "\n" + hint, click, "text item " + id, id);
            }
            St.MarkHandled(it.Id);
            receiving.Remove(it.Id);
            Ack(it);
        }

        void ReceiveFile(Item it)
        {
            string from = SenderName(it);
            if (Cfg.AutoSave && it.Size <= Cfg.MaxSaveBytes)
            {
                StartDownload(it, true, null, null);
                return;
            }
            string why = !Cfg.AutoSave ? "Click to save it." : "It's larger than " + Fmt.Size(Cfg.MaxSaveBytes) + ". Click to save it.";
            string id = it.Id;
            if (!Watching(it)) notifier.ShowItem("File from " + from, it.Name + " (" + Fmt.Size(it.Size) + ")\n" + why, () => SaveItemById(id, "reveal", null), "file item " + id, id);
            St.MarkHandled(it.Id);
            receiving.Remove(it.Id);
            Ack(it);
        }

        DownloadJob StartDownload(Item it, bool auto, string then, string saveAs)
        {
            return StartDownload(it, auto, then, saveAs, false);
        }

        DownloadJob StartDownload(Item it, bool auto, string then, string saveAs, bool early)
        {
            DownloadJob job;
            if (Downloads.TryGetValue(it.Id, out job) && job.Active)
            {
                if (then != null) job.Then = then;
                if (job.Early) job.WakeUp(); // e.g. its item came: no need to wait out a pause
                return job;
            }
            job = new DownloadJob();
            job.Session = session;
            job.Early = early;
            job.Item = it;
            job.Size = it.Size;
            job.Folder = Cfg.SaveFolderPath;
            job.SaveAs = saveAs;
            job.Then = then;
            job.Auto = auto;
            job.Referrer = Cfg.Server.TrimEnd('/') + "/";
            job.Ts = Fmt.NowMs();
            Downloads[it.Id] = job;
            if (!auto)
            {
                St.Downloads.RemoveAll(s => s.ItemId == it.Id);
                var saved = new SavedDownload();
                saved.ItemId = it.Id; saved.Folder = job.Folder; saved.SaveAs = saveAs; saved.Then = then;
                St.Downloads.Add(saved);
                St.Save();
            }
            down.Enqueue(job);
            if (TransferChanged != null) TransferChanged(job);
            MarkChanged();
            return job;
        }

        void OnDownloadChanged(DownloadJob job, JobState state)
        {
            if (job.Session != session) return; // from a sign-in session that ended (revoked, signed out)
            MarkChanged();
            if (TransferChanged != null) TransferChanged(job);
            bool final = state == JobState.Done || state == JobState.Failed || state == JobState.Cancelled || state == JobState.Gone;
            if (!final || job.FinalHandled) return;
            job.FinalHandled = true;
            if (pendingUpdate != null && !TransfersBusy()) updateRetryTimer.Start();
            var it = job.Item;
            DownloadJob current;
            bool isCurrent = Downloads.TryGetValue(it.Id, out current) && current == job;
            if (isCurrent && state != JobState.Failed) Downloads.Remove(it.Id);
            if (state != JobState.Failed && St.Downloads.RemoveAll(s => s.ItemId == it.Id) > 0) St.Save();
            if (state != JobState.Failed && TransferRemoved != null) TransferRemoved(job.TransferId, it.Id);
            if (state == JobState.Done)
            {
                St.SetLocalPath(it.Id, job.FinalPath);
                if (LocalFileChanged != null) LocalFileChanged(it.Id, true);
                if (job.Then == "open") FileUtil.Open(job.FinalPath);
                else if (job.Then == "reveal") FileUtil.ShowInFolder(job.FinalPath);
                if (job.Auto)
                {
                    string path = job.FinalPath;
                    string itemId = it.Id;
                    // A picture or a video opens in its conversation (where it can be seen, copied or dragged on, 1.7.1);
                    // other files show in their folder.
                    bool media = it.Mime.StartsWith("image/", StringComparison.OrdinalIgnoreCase) || it.Mime.StartsWith("video/", StringComparison.OrdinalIgnoreCase);
                    if (!Watching(it))
                        notifier.ShowItem("Saved " + it.Name + " from " + SenderName(it), Fmt.Size(it.Size) + (media ? " · Click to see it in Beam" : " · Click to show it in the folder"),
                            media ? (Action)(() => OpenItem(itemId)) : () => FileUtil.ShowInFolder(path), "file item " + it.Id + " saved", it.Id);
                    St.MarkHandled(it.Id);
                    Ack(it);
                }
            }
            else if (job.SenderCancelled) { } // there is no item to mark or ack
            else if (!job.ByUser && !job.ItemDeleted && (state == JobState.Cancelled || (job.Early && state == JobState.Gone)))
            {
                // Neither the user's decision nor deleted on the server: Beam stopped it (or an early download's
                // upload went away). The file may still come and is then saved as usual: nothing to mark or acknowledge.
            }
            else if (job.Auto && (state == JobState.Gone || state == JobState.Cancelled))
            {
                // Deleted on the server, or cancelled by the user.
                St.MarkHandled(it.Id);
                if (state == JobState.Cancelled) Ack(it);
            }
            else if (state == JobState.Failed)
            {
                if (job.Auto || !Watching(it)) notifier.ShowItem("Couldn't save " + it.Name, job.Error ?? "Download failed", () => OpenItem(it.Id), "download failed " + it.Id, it.Id);
                // Network trouble: left unhandled so the next catch-up resumes the partial file.
                // Local problems (folder not writable, disk full): the user was told; Save retries by hand.
                // A refused sign-in isn't about this file: it's saved after signing in again.
                if (job.Auto && job.Permanent && job.ErrorStatus != 401)
                {
                    St.MarkHandled(it.Id);
                    Ack(it);
                }
            }
            if (job.Auto) receiving.Remove(it.Id);
        }

        async void Ack(Item it)
        {
            if (acking.Contains(it.Id) || Api == null) return;
            acking.Add(it.Id);
            try
            {
                for (int i = 0; i < 3; i++)
                {
                    try
                    {
                        var delivered = await Api.Ack(it.Id);
                        it.Delivered = delivered;
                        MarkChanged();
                        return;
                    }
                    catch (ApiException ex)
                    {
                        if (ex.Status == 404) return;
                        Log.Error("Ack", ex);
                    }
                    catch (Exception ex) { Log.Error("Ack", ex); }
                    await Task.Delay(2000 * (i + 1));
                }
            }
            finally { acking.Remove(it.Id); }
        }

        // ------------------------------------------------------------------ sending

        public static List<string> TargetsOf(string conv)
        {
            var to = new List<string>();
            if (conv != null && conv != "*") to.Add(conv);
            return to;
        }

        public async Task<string> SendText(string text, List<string> to)
        {
            if (Api == null) return "Not signed in";
            try
            {
                var it = await Api.SendText(text.Replace("\r\n", "\n"), to);
                if (it != null) AddItem(it);
                return null;
            }
            catch (Exception ex)
            {
                Log.Error("Send text", ex);
                return Api.Describe(ex);
            }
        }

        // Files are uploaded natively (resumable, surviving restarts). Folders are zipped first.
        public int SendFiles(IEnumerable<string> paths, List<string> to, bool notify, string origin, Action<UploadJob> finished)
        {
            int count = 0;
            foreach (var p in paths)
            {
                bool isDir = Directory.Exists(p);
                if (!isDir && !File.Exists(p)) continue;
                var job = new UploadJob();
                job.Session = session;
                job.LocalId = (++localIds).ToString() + "-" + Fmt.NowMs();
                job.To = to == null ? new List<string>() : new List<string>(to);
                job.Ts = Fmt.NowMs();
                job.NotifyWhenDone = notify;
                job.Finished = finished;
                job.Origin = origin;
                Uploads.Add(job);
                count++;
                if (isDir)
                {
                    job.SourceFolder = p;
                    job.Name = FileUtil.SafeName(Path.GetFileName(p.TrimEnd('\\'))) + ".zip";
                    job.State = JobState.Preparing;
                    job.Status = "Zipping the folder…";
                    if (TransferChanged != null) TransferChanged(job);
                    ZipAndSend(job);
                    continue;
                }
                job.Path = p;
                job.Name = Path.GetFileName(p);
                try { var fi = new FileInfo(p); job.Size = fi.Length; job.MtimeTicks = fi.LastWriteTimeUtc.Ticks; } catch { }
                job.Mime = FileUtil.MimeFor(p);
                job.DeleteWhenDone = p.StartsWith(Cfg.OutgoingFolder + "\\", StringComparison.OrdinalIgnoreCase);
                Persist(job);
                up.Enqueue(job);
                if (TransferChanged != null) TransferChanged(job);
            }
            MarkChanged();
            return count;
        }

        void ZipAndSend(UploadJob job)
        {
            string folder = job.SourceFolder, outDir = Cfg.OutgoingFolder;
            Task.Run(() =>
            {
                string zip = null, error = null;
                try { zip = Zip.Folder(folder, outDir); }
                catch (Exception ex) { error = ex.Message; Log.Error("Zipping a folder", ex); }
                Post(() =>
                {
                    if (job.State == JobState.Cancelled) { FileUtil.TryDelete(zip); return; }
                    if (zip == null)
                    {
                        job.State = JobState.Failed;
                        job.Permanent = true;
                        job.Error = "Couldn't zip the folder: " + error;
                        OnUploadChanged(job, JobState.Failed);
                        return;
                    }
                    job.Path = zip;
                    job.Name = Path.GetFileName(zip);
                    try { var fi = new FileInfo(zip); job.Size = fi.Length; job.MtimeTicks = fi.LastWriteTimeUtc.Ticks; } catch { }
                    job.Mime = "application/zip";
                    job.DeleteWhenDone = true;
                    job.Status = null;
                    Persist(job);
                    up.Enqueue(job);
                    if (TransferChanged != null) TransferChanged(job);
                });
            });
        }

        void Persist(UploadJob job)
        {
            var s = St.Uploads.FirstOrDefault(x => x.LocalId == job.LocalId);
            if (s == null) { s = new SavedUpload(); s.LocalId = job.LocalId; St.Uploads.Add(s); }
            s.Path = job.Path; s.Name = job.Name; s.Mime = job.Mime; s.UploadId = job.UploadId; s.Origin = job.Origin;
            s.Size = job.Size; s.MtimeTicks = job.MtimeTicks; s.Ts = job.Ts; s.To = new List<string>(job.To);
            s.DeleteWhenDone = job.DeleteWhenDone; s.Notify = job.NotifyWhenDone;
            St.Save();
        }

        void Unpersist(UploadJob job)
        {
            if (St.Uploads.RemoveAll(x => x.LocalId == job.LocalId) > 0) St.Save();
        }

        void OnUploadChanged(UploadJob job, JobState state)
        {
            if (job.Session != session) return; // from a sign-in session that ended
            MarkChanged();
            if (TransferChanged != null) TransferChanged(job);
            if (job.UploadId != null)
            {
                var s = St.Uploads.FirstOrDefault(x => x.LocalId == job.LocalId);
                if (s != null && s.UploadId != job.UploadId) Persist(job);
            }
            bool final = state == JobState.Done || state == JobState.Failed || state == JobState.Cancelled;
            if (!final || job.FinalHandled) return;
            job.FinalHandled = true;
            if (pendingUpdate != null && !TransfersBusy()) updateRetryTimer.Start();
            string where = NamesOf(job.To);
            if (state == JobState.Done)
            {
                Uploads.Remove(job);
                Unpersist(job);
                if (job.Result != null)
                {
                    AddItem(job.Result);
                    if (Thumbnail.IsImage(job.Name) && job.Path != null && File.Exists(job.Path) && ServerApi >= 3) SendThumb(job.Result.Id, job.Path);
                    if (!job.DeleteWhenDone && job.SourceFolder == null && job.Path != null)
                    {
                        St.SetLocalPath(job.Result.Id, job.Path);
                        if (LocalFileChanged != null) LocalFileChanged(job.Result.Id, true);
                    }
                }
                if (TransferRemoved != null) TransferRemoved(job.TransferId, job.Result != null ? job.Result.Id : null);
                if (job.NotifyWhenDone && (main == null || !main.Visible))
                    notifier.Show("Sent " + job.Name, "To " + where, () => ShowMain(job.To.Count == 1 ? job.To[0] : "*", job.Result != null ? job.Result.Id : null), "sent", true);
            }
            else if (state == JobState.Cancelled)
            {
                Uploads.Remove(job);
                Unpersist(job);
                if (job.DeleteWhenDone) FileUtil.TryDelete(job.Path);
                if (TransferRemoved != null) TransferRemoved(job.TransferId, null);
            }
            else if (state == JobState.Failed)
            {
                Unpersist(job);
                if (main == null || !main.Visible)
                    notifier.Show("Couldn't send " + job.Name, job.Error ?? "Upload failed", () => ShowMain(job.To.Count == 1 ? job.To[0] : "*", null), "send failed");
            }
            if (job.Finished != null)
            {
                try { job.Finished(job); } catch (Exception ex) { Log.Error("Upload finished", ex); }
            }
        }

        // Uploads and saves that were in progress when Beam last stopped carry on where the server has them.
        void RestoreTransfers()
        {
            foreach (var s in St.Uploads.ToList())
            {
                bool same = false;
                try { var fi = new FileInfo(s.Path); same = fi.Exists && fi.Length == s.Size && fi.LastWriteTimeUtc.Ticks == s.MtimeTicks; } catch { }
                if (!same)
                {
                    St.Uploads.Remove(s);
                    if (s.UploadId != null) DropUpload(s.UploadId);
                    Log.Write("Upload " + s.LocalId + " can't resume: the file changed or is gone");
                    notifier.Show("Couldn't finish sending " + s.Name, "The file changed or was removed while Beam was closed.", null, "resume failed");
                    continue;
                }
                var job = new UploadJob();
                job.Session = session;
                job.LocalId = s.LocalId; job.Path = s.Path; job.Name = s.Name; job.Mime = s.Mime; job.UploadId = s.UploadId;
                job.Origin = s.Origin; job.Size = s.Size; job.MtimeTicks = s.MtimeTicks; job.Ts = s.Ts; job.To = new List<string>(s.To);
                job.DeleteWhenDone = s.DeleteWhenDone; job.NotifyWhenDone = s.Notify; job.NeedsResync = s.UploadId != null;
                Uploads.Add(job);
                up.Enqueue(job);
                Log.Write("Resuming upload " + job.TransferId);
                if (TransferChanged != null) TransferChanged(job);
            }
            St.Save();
            foreach (var s in St.Downloads.ToList())
            {
                var it = ItemById(s.ItemId);
                if (it == null) { St.Downloads.Remove(s); continue; }
                StartDownload(it, false, s.Then, s.SaveAs);
            }
            St.Save();
            MarkChanged();
        }

        // A small JPEG preview of an image we sent, so every device can show it without downloading it (v3).
        void SendThumb(string itemId, string path)
        {
            var api = Api;
            Task.Run(async () =>
            {
                try
                {
                    var jpeg = Thumbnail.Jpeg(path, 320, 256 * 1024);
                    if (jpeg != null) await api.PutThumb(itemId, jpeg);
                }
                catch (Exception ex) { Log.Error("Thumbnail", ex); }
            });
        }

        void DropUpload(string uploadId)
        {
            var api = Api;
            if (api == null) return;
            Task.Run(async () => { try { await api.Call(HttpMethod.Delete, "/api/uploads/" + uploadId); } catch { } });
        }

        public UploadJob UploadByTransferId(string id)
        {
            return Uploads.FirstOrDefault(u => u.TransferId == id);
        }

        public DownloadJob DownloadByTransferId(string id)
        {
            return Downloads.Values.FirstOrDefault(d => d.TransferId == id);
        }

        public bool TransferAction(string transferId, string action)
        {
            var u = UploadByTransferId(transferId);
            if (u != null)
            {
                if (action == "cancel")
                {
                    if (u.State == JobState.Preparing) { u.State = JobState.Cancelled; OnUploadChanged(u, JobState.Cancelled); }
                    else up.Cancel(u);
                }
                else if (action == "retry") { u.FinalHandled = false; up.Retry(u); if (u.Path != null) Persist(u); }
                else if (action == "dismiss" && !u.Active) { Uploads.Remove(u); if (TransferRemoved != null) TransferRemoved(u.TransferId, null); }
                MarkChanged();
                return true;
            }
            var d = DownloadByTransferId(transferId);
            if (d != null)
            {
                if (action == "cancel") { d.ByUser = true; down.Cancel(d); }
                else if (action == "retry" && !d.Active)
                {
                    // A file that isn't an item yet is still arriving: the retry trails its sender again (early).
                    var item = ItemById(d.Item.Id);
                    StartDownload(item ?? d.Item, d.Auto, d.Then, d.SaveAs, item == null && d.Early);
                }
                else if (action == "dismiss" && !d.Active) { Downloads.Remove(d.Item.Id); if (TransferRemoved != null) TransferRemoved(d.TransferId, null); }
                MarkChanged();
                return true;
            }
            return false;
        }

        public void SendPayload(ClipPayload p, List<string> to)
        {
            if (p.ImagePath != null) SendFiles(new[] { p.ImagePath }, to, true, "clipboard", null);
            else if (p.Files.Count > 0) SendFiles(p.Files, to, true, "clipboard", null);
            else if (!string.IsNullOrEmpty(p.Text)) SendTextNotify(p.Text, to);
        }

        async void SendTextNotify(string text, List<string> to)
        {
            string err = await SendText(text, to);
            if (err != null) notifier.Show("Couldn't send the text", err, () => ShowMain(null, null), "send failed");
            else if (main == null || !main.Visible) notifier.Show("Sent to " + NamesOf(to), Fmt.OneLine(text, 120), () => ShowMain(to.Count == 1 ? to[0] : "*", null), "sent", true);
        }

        public ClipPayload ReadClipboard()
        {
            return ClipPayload.Read(Cfg.OutgoingFolder);
        }

        // ------------------------------------------------------------------ item actions (from the page)

        public string LocalFile(string itemId)
        {
            string p = St.LocalPath(itemId);
            return p != null && File.Exists(p) ? p : null;
        }

        public Dictionary<string, object> LocalFiles()
        {
            var d = new Dictionary<string, object>();
            foreach (var kv in St.LocalPaths)
                if (byId.ContainsKey(kv.Key) && File.Exists(kv.Value)) d[kv.Key] = true;
            return d;
        }

        // Saves (if needed) and then opens or reveals a file item. Executables are only ever revealed.
        public string OpenItemFile(string itemId, string then)
        {
            string local = LocalFile(itemId);
            if (local != null)
            {
                if (then == "reveal") FileUtil.ShowInFolder(local); else FileUtil.Open(local);
                return null;
            }
            var it = ItemById(itemId);
            if (it == null || !it.IsFile) return "not-found";
            StartDownload(it, false, then, null);
            return null;
        }

        public string SaveItemById(string itemId, string then, string saveAs)
        {
            var it = ItemById(itemId);
            if (it == null || !it.IsFile) return "not-found";
            StartDownload(it, false, then, saveAs);
            return null;
        }

        public async Task<bool> CopyItemText(string itemId, string text)
        {
            if (itemId != null)
            {
                var it = ItemById(itemId);
                if (it == null || !it.IsText) return false;
                text = it.Text;
                if (it.Truncated)
                {
                    try { text = await Api.FullText(it.Id) ?? text; }
                    catch (Exception ex) { Log.Error("Fetching full text", ex); return false; }
                }
            }
            return ClipPayload.SetText(text, Cfg.ClipboardHistory);
        }

        // Copy image in the chat (1.6.2): an http page has no image clipboard, so the app copies the picture, fetched
        // from the server, or [png] from the page (a type Windows can't read, which the page turned into PNG). Null, or
        // why not: "not-found", "too-big", "unsupported" (the page then sends PNG), "failed".
        public async Task<string> CopyItemImage(string itemId, byte[] png)
        {
            byte[] bytes = png;
            if (bytes == null)
            {
                var it = ItemById(itemId);
                if (it == null || !it.IsFile || !it.Mime.StartsWith("image/", StringComparison.OrdinalIgnoreCase)) return "not-found";
                if (it.Size > MaxCopyImageBytes) return "too-big";
                try { bytes = await Api.FileBytes(it.Id, MaxCopyImageBytes); }
                catch (ApiException ex) { return ex.Status == 404 ? "not-found" : ex.Status == 413 ? "too-big" : "failed"; }
                catch (Exception ex) { Log.Error("Fetching an image to copy", ex); return "failed"; }
            }
            byte[] withAlpha = null;
            string why = null;
            Bitmap bmp = await Task.Run(() => ClipPayload.DecodeImage(bytes, out withAlpha, out why));
            if (bmp == null) return why ?? "failed";
            using (bmp) return ClipPayload.SetImage(bmp, withAlpha, Cfg.ClipboardHistory) ? null : "failed";
        }

        public const long MaxCopyImageBytes = 64L << 20;

        // The full text of a long item, opened in the default text editor.
        public async void OpenFullText(string itemId)
        {
            try
            {
                string text = await Api.FullText(itemId);
                string dir = Path.Combine(Cfg.OutgoingFolder, "texts");
                Directory.CreateDirectory(dir);
                string path = Path.Combine(dir, itemId + ".txt");
                File.WriteAllText(path, text ?? "", new System.Text.UTF8Encoding(true));
                FileUtil.Open(path);
            }
            catch (Exception ex) { Log.Error("Opening the full text", ex); }
        }

        void OpenItem(string itemId)
        {
            var it = ItemById(itemId);
            string conv = it == null ? null : ConvsOf(it).FirstOrDefault(c => c != "*") ?? "*";
            ShowMain(conv, itemId);
        }

        // ------------------------------------------------------------------ settings (page or native fallback)

        public Dictionary<string, object> SettingsObject()
        {
            var s = new Dictionary<string, object>();
            s["deviceName"] = Cfg.DeviceName;
            s["autoCopy"] = Cfg.AutoCopy;
            s["clipboardHistory"] = Cfg.ClipboardHistory;
            s["autoSave"] = Cfg.AutoSave;
            s["maxSaveMB"] = Cfg.MaxSaveMB;
            s["saveFolder"] = Cfg.SaveFolderPath;
            s["openLinks"] = Cfg.OpenLinks;
            s["autoOpenLinks"] = Cfg.AutoOpenLinks;
            s["sendToMenu"] = Cfg.SendToMenu;
            s["outbox"] = Cfg.Outbox;
            s["outboxFolder"] = Cfg.OutboxFolderPath;
            s["autostart"] = Autostart.IsEnabled(Cfg);
            s["autoUpdate"] = Cfg.AutoUpdate;
            s["phoneNotifications"] = PhoneNotificationsOn; // null: the server doesn't have phone notifications (or no list yet)
            s["phonePopupText"] = Cfg.PhonePopupText;       // this PC only: balloons show the message, else app and count
            // Beam 1.6 (null: the server has no remote control). The page can turn it off, never on; the list is read-only.
            s["allowRemoteControl"] = ServerHas("remote-control") ? (object)Cfg.AllowRemoteControl : null;
            s["remoteControlDevices"] = Cfg.RemoteControlDevices.Select(a =>
            {
                var o = new Dictionary<string, object>();
                o["id"] = a.Id;
                o["name"] = a.Name;
                o["machine"] = a.Machine;
                return (object)o;
            }).ToArray();
            var keys = new List<object>();
            foreach (var kv in new[] { new[] { "picker", "Send clipboard to…" }, new[] { "lastTarget", "Send clipboard to the last device" }, new[] { "copyLatest", "Copy the latest received text" }, new[] { "screenshot", "Send a screenshot" } })
            {
                var h = new Dictionary<string, object>();
                h["id"] = kv[0];
                h["keys"] = Cfg.Hotkeys[kv[0]];
                h["action"] = kv[1];
                h["registered"] = hotkeys.IsRegistered(kv[0]);
                keys.Add(h);
            }
            s["hotkeys"] = keys.ToArray();
            var server = new Dictionary<string, object>();
            server["url"] = Cfg.Server;
            server["version"] = ServerVersion;
            server["api"] = ServerApi;
            server["serverId"] = Cfg.ServerId;
            server["connected"] = Conn == Conn.Online;
            var storage = ServerInfo != null ? Json.Obj(Json.Get(ServerInfo, "storage")) : null;
            server["storage"] = storage;
            s["server"] = server;
            var app = new Dictionary<string, object>();
            app["version"] = AppVersion.Text;
            app["installed"] = Install.RunningInstalled(Cfg);
            app["path"] = Application.ExecutablePath;
            s["app"] = app;
            return s;
        }

        // Applies a partial settings object. Returns null, or what's wrong.
        public string ApplySettings(Dictionary<string, object> s)
        {
            if (s == null) return "Nothing to change";
            bool nameChanged = false, integrations = false;
            bool? phoneOn = null;
            if (s.ContainsKey("phoneNotifications"))
            {
                var v = Json.Get(s, "phoneNotifications");
                if (!(v is bool)) return "Show phone notifications must be on or off";
                if (!PhoneFeature) return "Phone notifications need Beam server 1.5";
                phoneOn = (bool)v;
            }
            bool rcOff = false;
            if (s.ContainsKey("allowRemoteControl"))
            {
                // Only off from here: it's turned on only at this PC, with the native confirmation (see Bridge).
                var v = Json.Get(s, "allowRemoteControl");
                if (!(v is bool) || (bool)v) return RemoteControl.OnlyHere;
                rcOff = true;
            }
            if (s.ContainsKey("remoteControlDevices")) return RemoteControl.OnlyHere;
            if (s.ContainsKey("deviceName"))
            {
                string n = (Json.Str(s, "deviceName") ?? "").Trim();
                if (n.Length == 0) return "The name can't be empty";
                if (n.Length > 40) n = n.Substring(0, 40);
                if (n != Cfg.DeviceName) { Cfg.DeviceName = n; nameChanged = true; integrations = true; }
            }
            if (s.ContainsKey("maxSaveMB"))
            {
                long mb = Json.Long(s, "maxSaveMB", -1);
                if (mb < 1) return "The size limit must be at least 1 MB";
                Cfg.MaxSaveMB = mb;
            }
            if (s.ContainsKey("saveFolder"))
            {
                string f = (Json.Str(s, "saveFolder") ?? "").Trim();
                if (f.Length > 0 && !Path.IsPathRooted(f)) return "Choose a full folder path";
                Cfg.SaveFolder = f.Length == 0 ? null : f;
            }
            if (s.ContainsKey("outboxFolder"))
            {
                string f = (Json.Str(s, "outboxFolder") ?? "").Trim();
                if (f.Length > 0 && !Path.IsPathRooted(f)) return "Choose a full folder path";
                Cfg.OutboxFolder = f.Length == 0 ? null : f;
                integrations = true;
            }
            if (s.ContainsKey("autoCopy")) Cfg.AutoCopy = Json.Bool(s, "autoCopy", Cfg.AutoCopy);
            if (s.ContainsKey("clipboardHistory")) Cfg.ClipboardHistory = Json.Bool(s, "clipboardHistory", Cfg.ClipboardHistory);
            if (s.ContainsKey("autoSave")) Cfg.AutoSave = Json.Bool(s, "autoSave", Cfg.AutoSave);
            if (s.ContainsKey("openLinks")) Cfg.OpenLinks = Json.Bool(s, "openLinks", Cfg.OpenLinks);
            if (s.ContainsKey("autoOpenLinks")) Cfg.AutoOpenLinks = Json.Bool(s, "autoOpenLinks", Cfg.AutoOpenLinks);
            if (s.ContainsKey("phonePopupText")) Cfg.PhonePopupText = Json.Bool(s, "phonePopupText", Cfg.PhonePopupText);
            if (s.ContainsKey("autoUpdate")) Cfg.AutoUpdate = Json.Bool(s, "autoUpdate", Cfg.AutoUpdate);
            if (s.ContainsKey("sendToMenu")) { bool v = Json.Bool(s, "sendToMenu", Cfg.SendToMenu); integrations |= v != Cfg.SendToMenu; Cfg.SendToMenu = v; }
            if (s.ContainsKey("outbox")) { bool v = Json.Bool(s, "outbox", Cfg.Outbox); integrations |= v != Cfg.Outbox; Cfg.Outbox = v; }
            if (s.ContainsKey("autostart"))
            {
                bool v = Json.Bool(s, "autostart", false);
                if (v != Autostart.IsEnabled(Cfg)) Autostart.Set(v, Cfg);
                Cfg.AutostartInitialized = true;
            }
            Cfg.Save();
            if (nameChanged && Api != null)
            {
                var api = Api;
                Task.Run(async () => { try { await api.Me(); } catch { } });
                if (events != null) events.Kick();
                if (main != null) main.IdentityChanged();
            }
            if (integrations) SyncIntegrations();
            if (phoneOn.HasValue) SetPhoneNotifications(phoneOn.Value, "settings");
            if (rcOff && Cfg.AllowRemoteControl) Rc.SetOff("settings");
            if (SettingsChanged != null) SettingsChanged();
            MarkChanged();
            return null;
        }

        // ------------------------------------------------------------------ remote control (Beam 1.6)

        // The switch or the list changed (here, from another device, or a test): the server hears it at once.
        public void RcChanged(string what)
        {
            if (what != null) status.Now("remote control " + what);
            if (SettingsChanged != null) SettingsChanged();
            MarkChanged();
        }

        public void StatusNow(string why) { status.Now(why); }

        // "Allow remote control" in the tray menu or Settings → This PC: on only through the native confirmation, which
        // lists the devices (ticked: all of them but this PC and session-only sign-ins); off at once.
        public void ToggleRemoteControl(string from)
        {
            if (Cfg.AllowRemoteControl) { Rc.SetOff(from); return; }
            ShowRcAllow(null);
        }

        RcAllowForm rcForm;

        // While another device controls this PC, nothing here widens access to Beam: no remote control changes but
        // turning it off, no adding or approving devices, no switching servers, no controlling another PC from this one
        // (the pages' requests of that kind are refused too: WebGuard). True when `what` is refused.
        public bool RcBlocks(string what)
        {
            if (Rc == null || !Rc.Active) return false;
            Log.Write("Remote control: refused " + what + " while " + Rc.ViewerName + " controls this PC");
            notifier.Show("Stop the remote control session first", "While " + Rc.ViewerName + " controls this PC, " + what + " isn't possible here.", null, "refused during remote control");
            return true;
        }

        // The native confirmation (turning it on) or the device list (when it's on). owner: a window to center on.
        public void ShowRcAllow(Form owner)
        {
            if (!ServerHas("remote-control") || RcBlocks("changing who may control it")) return;
            if (rcForm != null && !rcForm.IsDisposed) { rcForm.Activate(); return; }
            rcForm = new RcAllowForm(this, !Cfg.AllowRemoteControl);
            Ui.PlaceForTest(rcForm);
            rcForm.FormClosed += (s2, e2) => rcForm = null;
            if (owner != null) rcForm.Show(owner); else rcForm.Show();
            if (!Ui.TestOffscreen) { rcForm.Activate(); Native.SetForegroundWindow(rcForm.Handle); }
        }

        // The page's "Control" (bridge openRemote): a window of its own on <server>/#remote=<id>. Null, or what's wrong.
        public string OpenRemote(string device)
        {
            if (!Config.ValidId(device) || device == Me) return "That isn't another of your devices";
            if (RcBlocks("controlling another PC from this one")) return "Not while another device controls this PC";
            var dev = DeviceById(device);
            if (dev == null) return "That isn't another of your devices";
            if (WebHost.RuntimeVersion(Cfg) == null) return "Remote control needs Microsoft Edge WebView2 Runtime";
            RemoteViewWindow w;
            if (remoteViews.TryGetValue(device, out w) && !w.IsDisposed) { w.ShowAndActivate(); return null; }
            w = new RemoteViewWindow(this, device, dev.Name);
            remoteViews[device] = w;
            w.FormClosed += (s2, e2) => { RemoteViewWindow cur; if (remoteViews.TryGetValue(device, out cur) && cur == w) remoteViews.Remove(device); };
            w.ShowAndActivate();
            Log.Write("Remote control: opened the viewer for " + dev.Name);
            return null;
        }

        // Tests: the viewer windows close (as the user closing them).
        public void CloseRemoteViewsForTest()
        {
            foreach (var w in remoteViews.Values.ToList()) { try { w.CloseForGood(); } catch { } }
        }

        // Tests: a message to the viewer windows as if their page sent it, or their pages reloaded.
        public void RemoteViewsForTest(string json)
        {
            foreach (var w in remoteViews.Values.ToList()) { if (json == null) w.ReloadForTest(); else w.MessageForTest(json); }
        }

        // Tests: the chat window's page opens a panel (as the tray's Add a device would, past its own gate).
        public void OpenPanelForTest(string panel)
        {
            ShowMain(null, null, false);
            if (main != null && !main.IsDisposed) main.OpenPanel(panel);
        }

        // Signed out or revoked: viewer windows close, and their profile (it holds the sign-in cookie) goes.
        void CloseRemoteViews()
        {
            foreach (var w in remoteViews.Values.ToList()) { try { w.CloseForGood(); } catch { } }
            remoteViews.Clear();
            RemoteViewWindow.ForgetProfile(Cfg);
        }

        // ------------------------------------------------------------------ commands, windows, tray

        void HandleCommand(Options o)
        {
            if (o.Send || o.Quit) Log.Write("Command: " + (o.Quit ? "quit" : "send " + o.Files.Count + " path(s)"));
            if (o.Quit) { Quit(false); return; }
            if (o.Updated != null)
            {
                Log.Write("Updated to " + o.Updated + (o.UpdateFrom != null ? " from " + o.UpdateFrom : ""));
                if (o.Updated == AppVersion.Text) notifier.Show("Beam updated to " + o.Updated, "You're running the latest version.", null, "updated");
                SetUpdateState("none", null, null);
            }
            if (o.UpdateFailed != null)
            {
                Log.Write("Update to " + o.UpdateFailed + " failed; running " + AppVersion.Text);
                notifier.Show("Beam couldn't update to " + o.UpdateFailed, "It went back to " + AppVersion.Text + " and will try again when a newer version is out.", null, "update failed");
                SetUpdateState("failed", o.UpdateFailed, "The new version didn't start on this PC");
            }
            if (!Cfg.Paired)
            {
                pending = o;
                ShowPairing(PairMode.First);
                return;
            }
            if (o.Send && o.Files.Count > 0)
            {
                var files = o.Files.Where(f => File.Exists(f) || Directory.Exists(f)).ToList();
                if (files.Count == 0) { notifier.Show("Nothing to send", "The file wasn't found.", null, "nothing to send"); return; }
                if (o.To != null)
                {
                    var to = ResolveTargets(o.To);
                    if (to == null) { notifier.Show("Beam", "Unknown device: " + o.To, null, "unknown device"); return; }
                    SendFiles(files, to, true, "send to", null);
                    return;
                }
                string what = files.Count == 1 ? Path.GetFileName(files[0].TrimEnd('\\')) : files.Count + " files";
                TargetPicker.Show(this, "Send to…", what, targets => SendFiles(files, targets, true, "picker", null));
                return;
            }
            if (o.Show && o.Updated != null) ShowMain(null, null, false); // reopened after an update: don't take the focus
            else if (o.Show || o.Send) ShowMain(null, null);
            if (o.Hide && main != null && !main.IsDisposed) main.HideToTray();
            if (o.AddDevice) ShowAddDevice();
            if (o.Settings) ShowSettings();
            if (o.Approve) ShowApproveCode();
            if (o.PickClipboard) SendClipboardPicker();
            if (o.Screenshot) ScreenshotAndSend();
            if (o.CopyLatest) CopyLatestText();
            if (o.TestPoke && Cfg.CustomPath) CheckStream("a test poke");
            if ((o.TestMode == "foreground" || o.TestMode == "background") && Cfg.CustomPath) PokeMode(o.TestMode);
            if (o.TestTransfer != null && o.TestTransfer.IndexOf(':') > 0 && Cfg.CustomPath)
            {
                int colon = o.TestTransfer.IndexOf(':');
                TransferAction(o.TestTransfer.Substring(colon + 1), o.TestTransfer.Substring(0, colon));
            }
            if ((o.TestPhone == "on" || o.TestPhone == "off") && Cfg.CustomPath) SetPhoneNotifications(o.TestPhone == "on", "test");
            if (o.TestClickBalloon && Cfg.CustomPath) notifier.ClickLastForTest();
            if (o.TestEventName != null && Cfg.CustomPath) OnEvent(o.TestEventName, o.TestEventData ?? "{}");
            if (o.TestRc != null && Cfg.CustomPath) Rc.TestCommand(o.TestRc);
            if (o.TestBridge != null && Cfg.CustomPath) TestBridge(o.TestBridge);
            if (o.TestOpenRemote != null && Cfg.CustomPath) { string err = OpenRemote(o.TestOpenRemote); if (err != null) Log.Write("Remote control: (test) " + err); }
        }

        // Tests: a message as if the chat page sent it; the reply goes to beam.log.
        void TestBridge(string json)
        {
            ShowMain(null, null, false);
            if (main != null && !main.IsDisposed) main.TestBridge(json);
        }

        // "all", ids or names, comma-separated. Null if a name is unknown.
        List<string> ResolveTargets(string spec)
        {
            var to = new List<string>();
            foreach (var raw in spec.Split(','))
            {
                string t = raw.Trim();
                if (t.Length == 0) continue;
                if (t == "*" || t.Equals("all", StringComparison.OrdinalIgnoreCase) || t.Equals("everyone", StringComparison.OrdinalIgnoreCase)) return new List<string>();
                if (DeviceById(t) != null) { to.Add(t); continue; }
                var byName = DeviceByName(t);
                if (byName != null) { to.Add(byName.Id); continue; }
                // The device list may not be loaded yet; ids are accepted by the server as they are.
                if (Config.ValidId(t)) { to.Add(t); continue; }
                return null;
            }
            return to;
        }

        public void RememberTargets(List<string> targets)
        {
            Cfg.LastTargets = targets.Count == 0 ? new List<string> { "*" } : new List<string>(targets);
            Cfg.Save();
        }

        // Last picked targets that still exist ([] = all devices), or null if there are none.
        public List<string> LastTargets()
        {
            if (Cfg.LastTargets == null || Cfg.LastTargets.Count == 0) return null;
            if (Cfg.LastTargets.Contains("*")) return new List<string>();
            var ok = Cfg.LastTargets.Where(t => DeviceById(t) != null).ToList();
            return ok.Count > 0 ? ok : null;
        }

        public void SendClipboardPicker()
        {
            if (!Cfg.Paired) { ShowPairing(PairMode.First); return; }
            var payload = ReadClipboard();
            if (payload.Empty)
            {
                notifier.Show("The clipboard is empty", "Copy some text, an image or files first.", null, "clipboard empty");
                return;
            }
            TargetPicker.Show(this, "Send clipboard to…", payload.Describe(), targets => SendPayload(payload, targets));
        }

        public void SendClipboardToLast()
        {
            if (!Cfg.Paired) { ShowPairing(PairMode.First); return; }
            var to = LastTargets();
            if (to == null) { SendClipboardPicker(); return; }
            var payload = ReadClipboard();
            if (payload.Empty) { notifier.Show("The clipboard is empty", "Copy some text, an image or files first.", null, "clipboard empty"); return; }
            SendPayload(payload, to);
        }

        void SendClipboardTo(List<string> to)
        {
            var payload = ReadClipboard();
            if (payload.Empty) { notifier.Show("The clipboard is empty", "Copy some text, an image or files first.", null, "clipboard empty"); return; }
            RememberTargets(to);
            SendPayload(payload, to);
        }

        public void CopyLatestText()
        {
            var it = Items.FirstOrDefault(i => i.IsText && IsForMe(i));
            if (it == null) { notifier.Show("Nothing to copy", "No text has been sent to this PC yet.", null, "copy latest"); return; }
            string from = SenderName(it);
            CopyItemText(it.Id, null).ContinueWith(t => Post(() =>
            {
                if (t.Status == TaskStatus.RanToCompletion && t.Result) notifier.Show("Copied the latest text from " + from, Fmt.OneLine(it.Text, 120), null, "copy latest");
                else notifier.Show("Couldn't copy the latest text", "Try again in a moment.", null, "copy latest");
            }));
        }

        // Opens the Snipping overlay, waits for the snip on the clipboard, then asks where to send it.
        public void ScreenshotAndSend()
        {
            if (!Cfg.Paired) { ShowPairing(PairMode.First); return; }
            uint before = ClipPayload.Sequence();
            try { System.Diagnostics.Process.Start("ms-screenclip:"); }
            catch (Exception ex) { Log.Error("Snipping", ex); notifier.Show("Couldn't start the screenshot", "Use Win+Shift+S, then Ctrl+Alt+B.", null, "screenshot"); return; }
            var poll = new Timer();
            poll.Interval = 300;
            var started = DateTime.Now;
            poll.Tick += (s, e) =>
            {
                bool timedOut = DateTime.Now - started > TimeSpan.FromSeconds(90);
                if (!timedOut && (ClipPayload.Sequence() == before || !ClipPayload.HasImage())) return;
                poll.Stop();
                poll.Dispose();
                if (timedOut) return;
                var payload = ReadClipboard();
                if (payload.ImagePath == null) return;
                TargetPicker.Show(this, "Send screenshot to…", "Screenshot", targets => SendPayload(payload, targets));
            };
            poll.Start();
        }

        void PickAndSendFiles(List<string> to)
        {
            using (var dlg = new OpenFileDialog())
            {
                dlg.Multiselect = true;
                dlg.Title = "Send files with Beam";
                if (dlg.ShowDialog() != DialogResult.OK || dlg.FileNames.Length == 0) return;
                var files = dlg.FileNames.ToList();
                if (to != null) { SendFiles(files, to, true, "pick", null); return; }
                string what = files.Count == 1 ? Path.GetFileName(files[0]) : files.Count + " files";
                TargetPicker.Show(this, "Send to…", what, targets => SendFiles(files, targets, true, "pick", null));
            }
        }

        public void ToggleMain()
        {
            if (main != null && main.Visible && main.WindowState != FormWindowState.Minimized && main.IsActive) main.HideToTray();
            else ShowMain(null, null);
        }

        public void ShowMain(string conv, string itemId)
        {
            ShowMain(conv, itemId, true);
        }

        public void ShowMain(string conv, string itemId, bool activate)
        {
            if (!Cfg.Paired) { ShowPairing(PairMode.First); return; }
            if (WebHost.RuntimeVersion(Cfg) == null)
            {
                if (activate) OpenInBrowser("");
                return;
            }
            if (main == null || main.IsDisposed) main = new WebWindow(this);
            main.ShowAndActivate(conv, itemId, activate);
        }

        // No WebView2 Runtime: the web app in the default browser (it signs in by itself: this PC's app is connected).
        void OpenInBrowser(string hash)
        {
            FileUtil.OpenUrl(Cfg.Server.TrimEnd('/') + "/" + hash);
            if (!Cfg.RuntimeHintShown)
            {
                Cfg.RuntimeHintShown = true;
                Cfg.Save();
                notifier.Show("Beam opened in your browser", "For Beam's own window, install Microsoft Edge WebView2 Runtime. Click for the download page.",
                    () => FileUtil.OpenUrl("https://developer.microsoft.com/microsoft-edge/webview2/"), "webview2 missing");
            }
        }

        // Settings live in the web page's panel (host mode). The native form is the fallback: no WebView2 Runtime,
        // not connected (it has Switch server / Sign in again), or a server whose page doesn't speak the bridge.
        public void ShowSettings()
        {
            bool web = Cfg.Paired && Conn == Conn.Online && WebHost.RuntimeVersion(Cfg) != null
                && (PageBridge ?? ServerApi >= 3);
            if (web)
            {
                ShowMain(null, null);
                if (main != null && !main.IsDisposed) { main.OpenPanel("settings"); return; }
            }
            ShowNativeSettings();
        }

        public void ShowNativeSettings()
        {
            if (settingsForm != null && !settingsForm.IsDisposed) { settingsForm.Activate(); return; }
            settingsForm = new SettingsForm(this);
            Ui.PlaceForTest(settingsForm);
            settingsForm.Show();
            settingsForm.Activate();
        }

        public void ShowAddDevice()
        {
            if (!Cfg.Paired) { ShowPairing(PairMode.First); return; }
            if (RcBlocks("adding a device")) return;
            if (WebHost.RuntimeVersion(Cfg) == null) { OpenInBrowser("#pair"); return; }
            ShowMain(null, null);
            main.OpenPanel("pair");
        }

        void ShowPairing(PairMode mode)
        {
            // Signed out by the server (revoked) but still knowing which Beam: "sign in again" there, no search.
            if (mode == PairMode.First && !string.IsNullOrEmpty(Cfg.Server) && !string.IsNullOrEmpty(Cfg.ServerId)) mode = PairMode.Again;
            if (pairForm != null && !pairForm.IsDisposed) { pairForm.Activate(); return; }
            pairForm = new PairForm(this, mode);
            Ui.PlaceForTest(pairForm);
            pairForm.FormClosed += (s, e) =>
            {
                pairForm = null;
                if (!Cfg.Paired && !quitting) Quit(false);
            };
            pairForm.Show();
            pairForm.Activate();
        }

        public void SignInAgain() { ShowPairing(PairMode.Again); }
        public void SwitchServerDialog() { if (!RcBlocks("switching servers")) ShowPairing(PairMode.Switch); }

        public void OnPageUnauthorized()
        {
            if (events != null && events.Unauthorized) OnUnauthorized();
            else if (Api != null)
            {
                var api = Api;
                Task.Run(async () =>
                {
                    try { await api.Me(); }
                    catch (ApiException ex)
                    {
                        string sid = Json.Str(ex.Body, "serverId");
                        if (ex.Status == 401) Post(() => { signInOffered = false; OnUnauthorized(sid); });
                    }
                    catch { }
                });
            }
        }

        public void PageMoved(string movedTo) { OnMoved(movedTo); }

        // Signed in (first time, again, or to another Beam). A different Beam starts with fresh local state.
        public void Paired(string server, string key, string name, string serverId, string via, string you)
        {
            if (Config.ValidId(you) && you != Cfg.DeviceId) { Log.Write("The server gave this PC the id " + you); Cfg.DeviceId = you; }
            bool otherServer = !string.IsNullOrEmpty(serverId) && serverId != St.ServerId && (St.ServerId != null || St.Initialized);
            if (otherServer || !St.Initialized && St.ServerId == null) St.Reset(serverId);
            Cfg.Server = server;
            Cfg.Key = key;
            Cfg.DeviceName = name;
            PageBridge = null;
            if (!string.IsNullOrEmpty(serverId)) Cfg.ServerId = serverId;
            Cfg.RotateToken = false; // a fresh sign-in, never kept in clear
            Cfg.RevokeKey = null;
            Cfg.Save();
            Log.Write("Signed in to " + server + " as " + name + (via != null ? " (" + via + ")" : ""));
            if (via == "tailscale") notifier.Show("Signed in as " + name, "via Tailscale · " + HostOf(server), null, "signed in");
            if (events == null) StartSession(); else StartEvents();
            if (main != null) main.ServerChanged();
            var o = pending;
            pending = null;
            if (o != null && o.Send) HandleCommand(o);
            else ShowMain(null, null);
        }

        public void Unpair()
        {
            var api = Api;
            if (api != null) Pending.Add(Task.Run(async () => { try { await api.Logout(); } catch { } })); // revokes this PC's token
            StopSession();
            SendToMenu.Remove(this);
            Cfg.Server = null;
            Cfg.Key = null;
            Cfg.ServerId = null;
            Cfg.RotateToken = false;
            Cfg.RevokeKey = null;
            Cfg.Save();
            St.Reset(null);
            Items.Clear();
            byId.Clear();
            Devices.Clear();
            Uploads.Clear();
            Downloads.Clear();
            devicesLoaded = false;
            restored = false;
            Log.Write("Signed out");
            // The window goes, then its whole profile folder (cookies, storage, HTTP cache): clearing inside a web view
            // that is being closed could be cut short.
            if (main != null && !main.IsDisposed) { main.Close(); main.Dispose(); main = null; }
            WebHost.ForgetProfile(Cfg);
            ShowPairing(PairMode.First);
        }

        public string BrowseFolder(string setting, IWin32Window owner)
        {
            using (var dlg = new FolderBrowserDialog())
            {
                dlg.SelectedPath = setting == "outboxFolder" ? Cfg.OutboxFolderPath : Cfg.SaveFolderPath;
                dlg.Description = setting == "outboxFolder" ? "Where should Beam keep the outbox folders?" : "Where should Beam save received files?";
                dlg.ShowNewFolderButton = true;
                if (dlg.ShowDialog(owner) != DialogResult.OK) return null;
                var s = new Dictionary<string, object>();
                s[setting] = dlg.SelectedPath;
                string err = ApplySettings(s);
                return err == null ? dlg.SelectedPath : null;
            }
        }

        public void OpenFolderOf(string which)
        {
            if (which == "outbox") FileUtil.OpenFolder(Cfg.OutboxFolderPath);
            else if (which == "logs") FileUtil.OpenFolder(Cfg.Dir);
            else FileUtil.OpenFolder(Cfg.SaveFolderPath);
        }

        void BuildMenu()
        {
            foreach (ToolStripItem old in menu.Items.Cast<ToolStripItem>().ToList()) { menu.Items.Remove(old); DisposeItem(old); }
            if (!Cfg.Paired)
            {
                menu.Items.Add("Sign in…", null, (s, e) => ShowPairing(PairMode.First));
                menu.Items.Add(new ToolStripSeparator());
                menu.Items.Add("Quit", null, (s, e) => Quit(true));
                MenuRenderer.Apply(menu);
                return;
            }
            var open = new ToolStripMenuItem("Open Beam", null, (s, e) => ShowMain(null, null));
            open.Font = Ui.Bold;
            menu.Items.Add(open);
            var clip = new ToolStripMenuItem("Send clipboard to");
            var last = LastTargets();
            clip.DropDownItems.Add(new ToolStripMenuItem("All devices", MenuRenderer.Dot(Theme.Accent), (s, e) => SendClipboardTo(new List<string>())));
            var others = OtherDevices();
            if (others.Count > 0) clip.DropDownItems.Add(new ToolStripSeparator());
            foreach (var d in others)
            {
                string id = d.Id;
                var mi = new ToolStripMenuItem(d.Name + (d.Online ? "" : "  (offline)"), MenuRenderer.Dot(d.Online ? Theme.Online : Theme.Offline), (s, e) => SendClipboardTo(new List<string> { id }));
                mi.Tag = id;
                clip.DropDownItems.Add(mi);
            }
            menu.Items.Add(clip);
            if (last != null)
            {
                var lastItem = new ToolStripMenuItem("Send clipboard to " + NamesOf(last), null, (s, e) => SendClipboardToLast());
                string keys = hotkeys.IsRegistered("lastTarget") ? Cfg.Hotkeys["lastTarget"] : null;
                if (keys != null) lastItem.ShortcutKeyDisplayString = keys;
                menu.Items.Add(lastItem);
            }
            menu.Items.Add("Send files…", null, (s, e) => PickAndSendFiles(null));
            menu.Items.Add("Send a screenshot…", null, (s, e) => ScreenshotAndSend());
            var copyLatest = new ToolStripMenuItem("Copy latest received text", null, (s, e) => CopyLatestText());
            if (hotkeys.IsRegistered("copyLatest")) copyLatest.ShortcutKeyDisplayString = Cfg.Hotkeys["copyLatest"];
            copyLatest.Enabled = Items.Any(i => i.IsText && IsForMe(i));
            menu.Items.Add(copyLatest);
            menu.Items.Add("Open received folder", null, (s, e) => FileUtil.OpenFolder(Cfg.SaveFolderPath));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Add a device…", null, (s, e) => ShowAddDevice());
            menu.Items.Add("Approve a sign-in…", null, (s, e) => ShowApproveCode());
            menu.Items.Add(new ToolStripSeparator());
            Color dotColor = Conn == Conn.Online ? Theme.Online : Conn == Conn.Unauthorized ? Theme.Danger : Theme.Warning;
            var status = new ToolStripMenuItem(ConnText + " · " + HostOf(Cfg.Server), MenuRenderer.Dot(dotColor));
            status.Tag = "status";
            if (Conn == Conn.Unauthorized) status.Click += (s, e) => SignInAgain();
            else status.Enabled = false;
            menu.Items.Add(status);
            if (UpdateState == "available" && !Cfg.AutoUpdate) menu.Items.Add("Install Beam " + UpdateVersion, null, (s, e) => InstallUpdateNow());
            if (ServerHas("remote-control"))
            {
                // Beam 1.6: on through the native confirmation (with the device list), off at once.
                var allow = new ToolStripMenuItem(Cfg.AllowRemoteControl ? "Allow remote control" : "Allow remote control…", null, (s, e) => ToggleRemoteControl("tray menu"));
                allow.Checked = Cfg.AllowRemoteControl;
                allow.Tag = "rc";
                menu.Items.Add(allow);
                if (Cfg.AllowRemoteControl) menu.Items.Add("Remote control devices…", null, (s, e) => ShowRcAllow(null));
                if (Rc.Active) menu.Items.Add("Stop remote control (" + Rc.ViewerName + ")", null, (s, e) => Rc.Stop("the tray menu"));
                if (Cfg.AllowRemoteControl && RemoteControl.InRemoteDesktop)
                {
                    // Beam 1.7.5: hand a Remote Desktop session back to this PC's own screen, for Beam's control.
                    var back = new ToolStripMenuItem("Back to this PC's screen", null, (s, e) => Rc.BackToScreen());
                    back.ToolTipText = "Moves this session onto the PC's own screen so Beam's remote control can take over. Windows asks for administrator rights; Remote Desktop closes.";
                    menu.Items.Add(back);
                }
            }
            var phoneOn = PhoneNotificationsOn;
            if (phoneOn.HasValue)
            {
                // Beam 1.5: one click turns this PC's "Show phone notifications" on or off (the phone picks the apps).
                var showPhone = new ToolStripMenuItem("Show phone notifications", null, (s, e) => SetPhoneNotifications(!(PhoneNotificationsOn ?? false), "tray menu"));
                showPhone.Checked = phoneOn.Value;
                showPhone.Tag = "phone";
                menu.Items.Add(showPhone);
            }
            menu.Items.Add("Settings", null, (s, e) => ShowSettings());
            menu.Items.Add("Quit", null, (s, e) => Quit(true));
            MenuRenderer.Apply(menu);
        }

        static void DisposeItem(ToolStripItem item)
        {
            var mi = item as ToolStripMenuItem;
            if (mi != null)
            {
                foreach (ToolStripItem child in mi.DropDownItems.Cast<ToolStripItem>().ToList()) DisposeItem(child);
                if (mi.Image != null) { var img = mi.Image; mi.Image = null; img.Dispose(); }
            }
            item.Dispose();
        }

        // userInitiated: from the tray menu (asks first while transfers run; they resume at the next start).
        public void Quit(bool userInitiated)
        {
            if (quitting) return;
            if (userInitiated && TransfersBusy())
            {
                int n = Uploads.Count(j => j.Active) + Downloads.Values.Count(Busy);
                var answer = MessageBox.Show(n + (n == 1 ? " file is" : " files are") + " still being sent or saved. Beam carries on with " + (n == 1 ? "it" : "them") + " the next time it starts.\n\nQuit anyway?",
                    "Quit Beam", MessageBoxButtons.OKCancel, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
                if (answer != DialogResult.OK) return;
            }
            quitting = true;
            Log.Write(Program.Handoff != null ? "Quitting for the update" : "Quitting");
            try
            {
                if (main != null && !main.IsDisposed) main.SaveBounds();
                ringer.Stop("quitting");
                Rc.Quit();
                foreach (var w in remoteViews.Values.ToList()) { try { w.CloseForGood(); } catch { } }
                status.Stop();
                if (events != null) events.Stop();
                hotkeys.Dispose();
                ipc.Stop();
                if (outbox != null) outbox.Dispose();
                uiTimer.Stop();
            }
            catch (Exception ex) { Log.Error("Quit", ex); }
            tray.Visible = false;
            tray.Dispose();
            foreach (Form f in Application.OpenForms.Cast<Form>().ToList())
            {
                try { if (f is PairForm) f.Close(); } catch { } // closing takes back its sign-in request
                try { f.Dispose(); } catch { }
            }
            ExitThread();
        }
    }

    // Balloon notifications (shown as Windows toasts), coalesced when several arrive at once. A click acts on the
    // balloon that is showing; once it has closed, a late click (from the notification center) just opens Beam.
    class Notifier
    {
        readonly NotifyIcon icon;
        readonly Action openMain;
        readonly Timer timer;
        readonly bool quiet;
        readonly List<Note> pending = new List<Note>();
        Action click, lastClick;
        // Opens an item's conversation at that item: a click on several merged notifications about items that came
        // (Beam 1.7.1; it used to just bring Beam up, wherever it was).
        public Action<string> OpenItem;

        class Note
        {
            public string Title, Text, LogLine;
            public Action Click;
            public bool Sent;
            public bool Phone;    // a phone notification's balloon (Beam 1.5)
            public long Newest;   // ...and how new its newest notification is (higher: newer)
            public ToolTipIcon Icon;
            public string ItemId; // about an item that came (1.7.1)
        }

        // A phone notification's balloon. Merged with others due at the same time, a click still opens the Phone panel
        // when every one of them is a phone notification: on the newest notification among them.
        public void ShowPhone(string title, string text, Action onClick, string logLine, long newest)
        {
            Show(title, text, onClick, logLine, false, ToolTipIcon.None);
            pending[pending.Count - 1].Phone = true;
            pending[pending.Count - 1].Newest = newest;
        }

        // Phone notifications were switched off (or signed out): balloons about to show for them don't.
        public void DropPhone()
        {
            pending.RemoveAll(p => p.Phone);
            if (pending.Count == 0) timer.Stop();
        }

        public Notifier(NotifyIcon icon, Action openMain, bool quiet)
        {
            this.icon = icon;
            this.openMain = openMain;
            this.quiet = quiet;
            timer = new Timer();
            timer.Interval = 600;
            timer.Tick += (s, e) => Flush();
            icon.BalloonTipClicked += (s, e) =>
            {
                var a = click ?? openMain;
                click = null;
                if (a != null) a();
            };
            icon.BalloonTipClosed += (s, e) => click = null;
        }

        // Tests (custom --config only): what a click on the last balloon does, also when quiet (nothing was shown).
        public void ClickLastForTest()
        {
            var a = lastClick ?? openMain;
            if (a != null) a();
        }

        // logLine describes the notification for beam.log without any message content.
        public void Show(string title, string text, Action onClick, string logLine)
        {
            Show(title, text, onClick, logLine, false);
        }

        public void Show(string title, string text, Action onClick, string logLine, ToolTipIcon icon)
        {
            Show(title, text, onClick, logLine, false, icon);
        }

        public void Show(string title, string text, Action onClick, string logLine, bool sent)
        {
            Show(title, text, onClick, logLine, sent, ToolTipIcon.None);
        }

        public void Show(string title, string text, Action onClick, string logLine, bool sent, ToolTipIcon icon)
        {
            var n = new Note();
            n.Icon = icon;
            n.Title = title;
            n.Text = text;
            n.Click = onClick;
            n.LogLine = logLine ?? "notification";
            n.Sent = sent;
            pending.Add(n);
            timer.Stop();
            timer.Start();
        }

        // About an item that came: on its own it does onClick; merged with others, a click opens the newest such item.
        public void ShowItem(string title, string text, Action onClick, string logLine, string itemId)
        {
            Show(title, text, onClick, logLine, false, ToolTipIcon.None);
            pending[pending.Count - 1].ItemId = itemId;
        }

        void Flush()
        {
            timer.Stop();
            if (pending.Count == 0) return;
            string title, text;
            var tipIcon = ToolTipIcon.None;
            if (pending.Count == 1)
            {
                title = pending[0].Title;
                text = pending[0].Text;
                click = pending[0].Click;
                tipIcon = pending[0].Icon;
            }
            else if (pending.All(p => p.Phone))
            {
                title = "New on your phone";
                text = string.Join("\n", pending.Take(4).Select(p => p.Title)) + (pending.Count > 4 ? "\n…" : "");
                click = pending.OrderBy(p => p.Newest).Last().Click; // the Phone panel, on the newest notification
            }
            else
            {
                int sent = pending.Count(p => p.Sent);
                title = sent == pending.Count ? "Sent " + sent + " items" : sent == 0 ? pending.Count + " new items" : pending.Count + " updates";
                text = string.Join("\n", pending.Take(4).Select(p => p.Title)) + (pending.Count > 4 ? "\n…" : "");
                // Items that came (photos sent from the phone, say): their conversation, at the newest of them.
                var newest = pending.LastOrDefault(p => p.ItemId != null);
                if (newest != null && OpenItem != null) { string itemId = newest.ItemId; click = () => OpenItem(itemId); }
                else click = openMain;
            }
            Log.Write("Notification: " + string.Join(", ", pending.Select(p => p.LogLine)));
            pending.Clear();
            lastClick = click;
            if (quiet) { click = null; return; }
            if (title.Length > 63) title = title.Substring(0, 62) + "…";
            if (string.IsNullOrEmpty(text)) text = " ";
            if (text.Length > 250) text = text.Substring(0, 249) + "…";
            try { icon.ShowBalloonTip(6000, title, text, tipIcon); }
            catch (Exception ex) { Log.Error("Notification", ex); }
        }
    }
}
