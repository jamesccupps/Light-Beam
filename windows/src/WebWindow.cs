// The messenger window: the web app (public/, served by the Beam server) hosted in WebView2, signed in as
// this PC (cookie + injected identity), talking to the app through the host bridge (docs/HOST-BRIDGE.md).
// The WebView is created when the window opens. Hidden or minimized, the page is told it's hidden (it throttles),
// its memory is trimmed and a few seconds later it's suspended; events for it are held (only the latest of each kind)
// until it shows again. ~3 minutes later the WebView is destroyed, so the tray app stays small while closed.
using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Beam
{
    class WebWindow : Form
    {
        readonly App app;
        readonly Bridge bridge;
        WebView2 web;
        CoreWebView2 core;
        string identityScriptId;
        bool creating, helloSeen, pageLoaded, loadFailed, captured;
        readonly List<string> queued = new List<string>();
        readonly Timer hideTimer, retryTimer, helloTimer, readTimer, suspendTimer;
        bool pageHidden;                                        // hidden or minimized: the page is frozen
        readonly OrderedDictionary held = new OrderedDictionary(); // page events while it's hidden, latest per key
        readonly Panel overlay;
        readonly Label2 overlayTitle, overlayText;
        readonly FlatButton overlayRetry, overlaySwitch, overlaySignIn;
        readonly Spinner spinner;
        bool showRetry, showSwitch, showSignIn, showBusy; // what the overlay shows (Visible is false until the window is)
        string viewingConv;
        bool viewingVisible;
        string navConv, navItem;
        string panelToOpen;
        string phoneToOpen;   // a phone notification to open once the page has said hello
        static readonly Regex FilePath = new Regex(@"^/api/file/([a-f0-9]{8,64})$", RegexOptions.IgnoreCase);
        static readonly Regex TextPath = new Regex(@"^/api/items/([a-f0-9]{8,64})/text$", RegexOptions.IgnoreCase);

        public WebWindow(App app)
        {
            this.app = app;
            bridge = new Bridge(app, this);
            Text = "Beam";
            Ui.StyleForm(this);
            MinimumSize = new Size(Ui.S(420), Ui.S(480));
            BackColor = Theme.Bg;
            KeyPreview = false;

            overlay = new Panel();
            overlay.Dock = DockStyle.Fill;
            overlay.BackColor = Theme.Bg;
            spinner = new Spinner();
            spinner.Size = new Size(Ui.S(28), Ui.S(28));
            overlay.Controls.Add(spinner);
            overlayTitle = new Label2("", Ui.Title, false);
            overlayTitle.TextAlign = ContentAlignment.TopCenter;
            overlayText = new Label2("", Ui.Font, true);
            overlayText.TextAlign = ContentAlignment.TopCenter;
            overlay.Controls.Add(overlayTitle);
            overlay.Controls.Add(overlayText);
            overlayRetry = OverlayButton("Try again", true, () => { Navigate(); });
            overlaySwitch = OverlayButton("Switch server…", false, () => app.SwitchServerDialog());
            overlaySignIn = OverlayButton("Sign in", true, () => app.SignInAgain());
            overlay.Resize += (s, e) => LayoutOverlay();
            Controls.Add(overlay);
            ShowOverlay("", "", false, false, false, true);

            hideTimer = new Timer();
            hideTimer.Interval = app.Cfg.WebViewReleaseSec * 1000;
            hideTimer.Tick += (s, e) => { hideTimer.Stop(); if (!Visible || WindowState == FormWindowState.Minimized) DisposeWeb(); };
            suspendTimer = new Timer();
            suspendTimer.Interval = 5000; // time for the page to react to "hidden" (e.g. switch its stream) before freezing
            suspendTimer.Tick += (s, e) => { suspendTimer.Stop(); if (pageHidden) Suspend(); };
            retryTimer = new Timer();
            retryTimer.Interval = 10000;
            retryTimer.Tick += (s, e) => { if (loadFailed && Visible) Navigate(); };
            helloTimer = new Timer();
            helloTimer.Interval = 15000;
            helloTimer.Tick += (s, e) =>
            {
                helloTimer.Stop();
                if (helloSeen) return;
                Log.Write("Web window: this page doesn't speak the host bridge (an older server?)");
                app.PageBridge = false;
                if (panelToOpen == "settings") { panelToOpen = null; app.ShowNativeSettings(); }
            };
            readTimer = new Timer();
            readTimer.Interval = 2000;
            // Only for pages that don't report what's read (no bridge); started when such a page has loaded.
            readTimer.Tick += (s, e) => { if (pageLoaded && !helloSeen && IsActive) app.MarkAllRead(); else if (helloSeen || !Visible) readTimer.Stop(); };

            RestoreBounds_();
            Theme.Changed += OnTheme;
            app.TransferChanged += OnTransferChanged;
            app.TransferRemoved += OnTransferRemoved;
            app.LocalFileChanged += OnLocalFileChanged;
            app.SettingsChanged += OnSettingsChanged;
            app.UpdateChanged += OnUpdateChanged;
            app.ConnChanged += OnConnChanged;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                Theme.Changed -= OnTheme;
                app.TransferChanged -= OnTransferChanged;
                app.TransferRemoved -= OnTransferRemoved;
                app.LocalFileChanged -= OnLocalFileChanged;
                app.SettingsChanged -= OnSettingsChanged;
                app.UpdateChanged -= OnUpdateChanged;
                app.ConnChanged -= OnConnChanged;
                hideTimer.Dispose();
                suspendTimer.Dispose();
                retryTimer.Dispose();
                helloTimer.Dispose();
                readTimer.Dispose();
                DisposeWeb();
            }
            base.Dispose(disposing);
        }

        // Tests render the window without ever showing it to the user or taking the focus (see ShowWithoutActivation).

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                if (app != null && app.TestOffscreen) cp.ExStyle |= 0x08000000 | 0x00000080; // WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW
                return cp;
            }
        }

        public bool IsActive
        {
            get { return IsHandleCreated && Visible && Native.GetForegroundWindow() == Handle; }
        }

        // Is the user looking at one of these conversations right now?
        public bool IsShowing(List<string> convs)
        {
            if (!Visible || WindowState == FormWindowState.Minimized || !IsActive || !helloSeen || !viewingVisible || viewingConv == null) return false;
            return convs.Contains(App.FromPageConv(viewingConv));
        }

        // ------------------------------------------------------------------ showing & hiding

        // Opening timings for the perf script: from the command to a usable page.
        System.Diagnostics.Stopwatch opening;
        string openingKind;
        bool everCreated;   // the web view existed before in this process (a re-created one isn't a cold start)

        public void ShowAndActivate(string conv, string itemId)
        {
            ShowAndActivate(conv, itemId, true);
        }

        bool quietShow;   // shown without taking the focus (reopened after an update)
        protected override bool ShowWithoutActivation { get { return quietShow || (app != null && app.TestOffscreen); } }

        public void ShowAndActivate(string conv, string itemId, bool activate)
        {
            if (conv != null || itemId != null) { navConv = conv; navItem = itemId; }
            if (!Visible || WindowState == FormWindowState.Minimized)
            {
                opening = System.Diagnostics.Stopwatch.StartNew();
                openingKind = web != null ? "warm" : everCreated ? "recreated" : "cold";
            }
            hideTimer.Stop();
            if (!Visible)
            {
                if (app.TestOffscreen) { StartPosition = FormStartPosition.Manual; Location = new Point(-20000, -20000); }
                quietShow = !activate;
                Show();
                quietShow = false;
            }
            if (WindowState == FormWindowState.Minimized && activate) WindowState = FormWindowState.Normal;
            if (!app.TestOffscreen && activate)
            {
                Activate();
                BringToFront();
                Native.SetForegroundWindow(Handle);
            }
            if (core != null && core.IsSuspended) { try { core.Resume(); } catch { } }
            if (web == null) EnsureWeb();
            else if (loadFailed) Navigate();
            FlushNavigation();
            if (opening != null && openingKind == "warm" && core != null) MarkResponsive();
        }

        // Warm open: the page answers a script call (it's resumed and running).
        async void MarkResponsive()
        {
            var sw = opening;
            try { await core.ExecuteScriptAsync("0"); } catch { return; }
            if (sw != null && opening == sw) { Perf.Mark("open warm: responsive", sw.ElapsedMilliseconds); opening = null; }
        }

        public void HideToTray()
        {
            SaveBounds();
            Hide();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                HideToTray();
                return;
            }
            base.OnFormClosing(e);
        }

        protected override void OnVisibleChanged(EventArgs e)
        {
            base.OnVisibleChanged(e);
            if (Visible)
            {
                hideTimer.Stop();
                if (app.Cfg.WinMax && !app.TestOffscreen && WindowState == FormWindowState.Normal && !shownOnce)
                {
                    // Maximizing activates the window: after a quiet reopen (an update) it waits for the user.
                    if (quietShow) pendingMaximize = true;
                    else WindowState = FormWindowState.Maximized;
                }
                shownOnce = true;
                SetPageHidden(WindowState == FormWindowState.Minimized);
                return;
            }
            viewingVisible = false;
            SetPageHidden(true);
            hideTimer.Start();
        }
        bool shownOnce, pendingMaximize;

        protected override void OnActivated(EventArgs e)
        {
            base.OnActivated(e);
            if (!pendingMaximize) return;
            pendingMaximize = false;
            if (WindowState == FormWindowState.Normal) WindowState = FormWindowState.Maximized;
        }

        // Minimized counts as hidden too (the WebView doesn't notice by itself).
        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            if (!Visible) return;
            bool minimized = WindowState == FormWindowState.Minimized;
            if (minimized == pageHidden) return;
            if (minimized)
            {
                viewingVisible = false;
                SetPageHidden(true);
                hideTimer.Start();
                return;
            }
            hideTimer.Stop();
            SetPageHidden(false);
            if (web == null) EnsureWeb();
        }

        void SetPageHidden(bool hidden)
        {
            if (hidden == pageHidden) return;
            pageHidden = hidden;
            if (hidden)
            {
                if (core != null) Trim();
                suspendTimer.Stop();
                suspendTimer.Start();
                return;
            }
            suspendTimer.Stop();
            if (core != null)
            {
                try { core.MemoryUsageTargetLevel = CoreWebView2MemoryUsageTargetLevel.Normal; } catch { }
                try { if (core.IsSuspended) core.Resume(); } catch { }
                try { web.Visible = true; } catch { }
            }
            if (pageLoaded && !helloSeen) readTimer.Start(); // an old page (no bridge) on screen again
            FlushHeld();
        }

        // The page sees "hidden" (visibilitychange: it throttles its timers) and gives memory back.
        void Trim()
        {
            try { web.Visible = false; } catch { }
            try { core.MemoryUsageTargetLevel = CoreWebView2MemoryUsageTargetLevel.Low; } catch { }
        }

        async void Suspend()
        {
            if (core == null || core.IsSuspended) return;
            try { await core.TrySuspendAsync(); } catch { }
        }

        protected override void OnResizeEnd(EventArgs e)
        {
            base.OnResizeEnd(e);
            SaveBounds();
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Native.WM_DPICHANGED)
            {
                // Per-monitor DPI: take the size Windows suggests for the new monitor.
                var r = (Native.RECT)System.Runtime.InteropServices.Marshal.PtrToStructure(m.LParam, typeof(Native.RECT));
                Native.SetWindowPos(Handle, IntPtr.Zero, r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top, 0x0014 /* NOZORDER | NOACTIVATE */);
                return;
            }
            base.WndProc(ref m);
        }

        public void SaveBounds()
        {
            if (app.TestOffscreen) return;
            var b = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            if (b.Width < 100) return;
            app.Cfg.WinX = b.X;
            app.Cfg.WinY = b.Y;
            app.Cfg.WinW = b.Width;
            app.Cfg.WinH = b.Height;
            app.Cfg.WinMax = WindowState == FormWindowState.Maximized;
            app.Cfg.Save();
        }

        void RestoreBounds_()
        {
            var c = app.Cfg;
            var saved = new Rectangle(c.WinX, c.WinY, c.WinW, c.WinH);
            bool visible = c.WinW >= MinimumSize.Width && c.WinH >= MinimumSize.Height &&
                Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(new Rectangle(saved.X + 40, saved.Y + 10, Math.Max(1, saved.Width - 80), 40)));
            if (visible && !app.TestOffscreen)
            {
                StartPosition = FormStartPosition.Manual;
                Bounds = saved;
            }
            else
            {
                StartPosition = app.TestOffscreen ? FormStartPosition.Manual : FormStartPosition.CenterScreen;
                var wa = Screen.PrimaryScreen.WorkingArea;
                Size = new Size(Math.Min(Ui.S(1040), wa.Width - 40), Math.Min(Ui.S(720), wa.Height - 40));
            }
        }

        void OnTheme(object s, EventArgs e)
        {
            BackColor = Theme.Bg;
            overlay.BackColor = Theme.Bg;
            foreach (Control c in overlay.Controls) c.BackColor = Theme.Bg;
            overlayTitle.ApplyTheme();
            overlayText.ApplyTheme();
            if (web != null) web.DefaultBackgroundColor = Theme.Bg;
            Theme.ApplyTitleBar(this, Theme.Bg);
            Invalidate(true);
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Theme.ApplyTitleBar(this, Theme.Bg);
        }

        // ------------------------------------------------------------------ overlay (loading / can't reach / signed out)

        FlatButton OverlayButton(string text, bool primary, Action click)
        {
            var b = new FlatButton(text, null);
            b.Primary = primary;
            b.BackColor = Theme.Bg;
            b.Size = new Size(Math.Max(Ui.S(120), b.Preferred().Width), Ui.S(36));
            b.Click += (s, e) => click();
            overlay.Controls.Add(b);
            return b;
        }

        void ShowOverlay(string title, string text, bool retry, bool switchServer, bool signIn, bool busy)
        {
            overlayTitle.Text = title;
            overlayText.Text = text;
            showRetry = retry;
            showSwitch = switchServer;
            showSignIn = signIn;
            showBusy = busy;
            overlayRetry.Visible = retry;
            overlaySwitch.Visible = switchServer;
            overlaySignIn.Visible = signIn;
            spinner.Visible = busy;
            spinner.Spinning = busy;
            overlay.Visible = true;
            overlay.BringToFront();
            LayoutOverlay();
        }

        void HideOverlay()
        {
            spinner.Spinning = false;
            overlay.Visible = false;
        }

        void LayoutOverlay()
        {
            int w = Math.Min(overlay.ClientSize.Width - Ui.S(40), Ui.S(460));
            int x = (overlay.ClientSize.Width - w) / 2;
            int y = overlay.ClientSize.Height / 2 - Ui.S(90);
            spinner.Location = new Point((overlay.ClientSize.Width - spinner.Width) / 2, y);
            if (showBusy) y += spinner.Height + Ui.S(16);
            int th = TextRenderer.MeasureText(overlayTitle.Text.Length > 0 ? overlayTitle.Text : " ", Ui.Title, new Size(w, int.MaxValue), Ui.Wrap).Height;
            overlayTitle.SetBounds(x, y, w, th);
            y += th + Ui.S(6);
            int h2 = TextRenderer.MeasureText(overlayText.Text.Length > 0 ? overlayText.Text : " ", Ui.Font, new Size(w, int.MaxValue), Ui.Wrap).Height;
            overlayText.SetBounds(x, y, w, h2 + Ui.S(4));
            y += h2 + Ui.S(20);
            var buttons = new List<FlatButton>();
            if (showSignIn) buttons.Add(overlaySignIn);
            if (showRetry) buttons.Add(overlayRetry);
            if (showSwitch) buttons.Add(overlaySwitch);
            int total = buttons.Sum(b => b.Width) + Math.Max(0, buttons.Count - 1) * Ui.S(10);
            int bx = (overlay.ClientSize.Width - total) / 2;
            foreach (var b in buttons) { b.Location = new Point(bx, y); bx += b.Width + Ui.S(10); }
        }

        // ------------------------------------------------------------------ the WebView

        async void EnsureWeb()
        {
            if (web != null || creating) return;
            creating = true;
            ShowOverlay("", "", false, false, false, true);
            try
            {
                var env = await WebHost.Environment(app.Cfg);
                var w = new WebView2();
                w.DefaultBackgroundColor = Theme.Bg;
                w.Dock = DockStyle.Fill;
                w.AllowExternalDrop = true;
                Controls.Add(w);
                w.SendToBack();
                await w.EnsureCoreWebView2Async(env);
                web = w;
                core = w.CoreWebView2;
                everCreated = true;
                if (opening != null) Perf.Mark("open " + openingKind + ": web view ready", opening.ElapsedMilliseconds);
                Configure();
                await WebHost.ClearLeftovers(core); // a sign-out's data that couldn't be deleted (in use) goes first
                await InjectIdentity();
                SetCookie();
                try { web.ZoomFactor = app.Cfg.Zoom; } catch { }
                web.ZoomFactorChanged += (s, e) => { app.Cfg.Zoom = web.ZoomFactor; app.Cfg.Save(); };
                Navigate();
                if (pageHidden) { Trim(); suspendTimer.Stop(); suspendTimer.Start(); } // closed while it was starting
            }
            catch (Exception ex)
            {
                Log.Error("Web window", ex);
                ShowOverlay("Beam's window couldn't start", "Microsoft Edge WebView2 didn't start (" + ex.Message + "). Beam keeps receiving in the background.", true, false, false, false);
            }
            finally { creating = false; }
        }

        void DisposeWeb()
        {
            if (web == null) return;
            try
            {
                Controls.Remove(web);
                web.Dispose();
            }
            catch (Exception ex) { Log.Error("Closing the web view", ex); }
            web = null;
            core = null;
            identityScriptId = null;
            helloSeen = false;
            pageLoaded = false;
            queued.Clear();
            held.Clear();
            suspendTimer.Stop();
            Log.Write("Web window: released the web view");
            // Give back what the window used now, not at some later collection (once, after minutes of being hidden).
            GC.Collect();
            GC.WaitForPendingFinalizers();
            GC.Collect();
        }

        void Configure()
        {
            var s = core.Settings;
            s.AreDevToolsEnabled = app.DevTools;
            s.AreDefaultContextMenusEnabled = true;
            s.AreDefaultScriptDialogsEnabled = true;
            s.IsStatusBarEnabled = false;
            s.IsZoomControlEnabled = true;
            s.IsBuiltInErrorPageEnabled = false;
            s.AreHostObjectsAllowed = false;
            s.IsGeneralAutofillEnabled = false;
            s.IsPasswordAutosaveEnabled = false;
            s.IsSwipeNavigationEnabled = false;
            s.IsWebMessageEnabled = true;
            core.NavigationStarting += OnNavigationStarting;
            core.NavigationCompleted += OnNavigationCompleted;
            core.NewWindowRequested += OnNewWindowRequested;
            core.DownloadStarting += OnDownloadStarting;
            core.WebMessageReceived += OnWebMessage;
            core.ContextMenuRequested += OnContextMenuRequested;
            core.PermissionRequested += OnPermissionRequested;
            core.ProcessFailed += OnProcessFailed;
            core.NotificationReceived += (s2, e) => { e.Handled = true; }; // Beam notifies natively
            core.LaunchingExternalUriScheme += (s2, e) => { e.Cancel = true; };
            core.WindowCloseRequested += (s2, e) => HideToTray();
            WebGuard.Attach(core, app, () => Origin, false); // remote control requests get the device key; nothing widens access during a session
        }

        string Origin { get { return app.Cfg.Server == null ? "" : app.Cfg.Server.TrimEnd('/'); } }

        bool SameOrigin(string url)
        {
            Uri u, o;
            if (!Uri.TryCreate(url ?? "", UriKind.Absolute, out u) || !Uri.TryCreate(Origin, UriKind.Absolute, out o)) return false;
            return u.Scheme == o.Scheme && string.Equals(u.Host, o.Host, StringComparison.OrdinalIgnoreCase) && u.Port == o.Port;
        }

        string IdentityScript()
        {
            var h = new Dictionary<string, object>();
            h["bridge"] = Bridge.Version;
            h["app"] = "windows";
            h["version"] = AppVersion.Text;
            h["deviceId"] = app.Cfg.DeviceId;
            h["deviceName"] = app.Cfg.DeviceName;
            h["platform"] = "windows";
            h["server"] = Origin;
            h["features"] = Bridge.Features;
            h["debug"] = app.DevTools;
            string json = Json.Stringify(h);
            return "(function(){if(location.origin!==" + Json.Stringify(Origin) + ")return;var h=" + json + ";" +
                "try{Object.defineProperty(window,'beamHost',{value:Object.freeze(h),writable:false,configurable:false});}catch(e){window.beamHost=h;}" +
                "try{localStorage.setItem('beam.deviceId',h.deviceId);localStorage.setItem('beam.device',h.deviceName);}catch(e){}})();";
        }

        async Task InjectIdentity()
        {
            if (core == null) return;
            if (identityScriptId != null) core.RemoveScriptToExecuteOnDocumentCreated(identityScriptId);
            identityScriptId = await core.AddScriptToExecuteOnDocumentCreatedAsync(IdentityScript());
        }

        void SetCookie()
        {
            Uri u;
            if (core == null || app.Cfg.Key == null || !Uri.TryCreate(Origin, UriKind.Absolute, out u)) return;
            try
            {
                var c = core.CookieManager.CreateCookie("beam_key", app.Cfg.Key, u.Host, "/");
                c.IsHttpOnly = true;
                c.IsSecure = u.Scheme == Uri.UriSchemeHttps;
                c.SameSite = CoreWebView2CookieSameSiteKind.Lax;
                c.Expires = DateTime.Now.AddYears(10);
                core.CookieManager.AddOrUpdateCookie(c);
            }
            catch (Exception ex) { Log.Error("Web window: cookie", ex); }
        }

        void Navigate()
        {
            if (core == null) { EnsureWeb(); return; }
            loadFailed = false;
            retryTimer.Stop();
            helloSeen = false;
            pageLoaded = false;
            queued.Clear();
            if (!overlay.Visible || showRetry) ShowOverlay("", "", false, false, false, true);
            try { core.Navigate(Origin + (app.TestPath ?? "/")); }
            catch (Exception ex) { Log.Error("Web window: navigate", ex); }
        }

        // The device id or token changed (reload: the page keeps its identity in memory).
        public async void IdentityChanged()
        {
            if (core == null) return;
            await clearing; // a sign-out's clearing first: it would take the new cookie too
            if (core == null) return;
            await InjectIdentity();
            SetCookie();
            PostEvent("settings", "settings", app.SettingsObject());
        }

        // Signed in to another address (a move, a switch, signing in again): the page must come from there.
        public async void ServerChanged()
        {
            if (core == null) return;
            await clearing; // the reload never races a sign-out's clearing (cookie, storage, cache)
            if (core == null) return;
            await InjectIdentity();
            SetCookie();
            Navigate();
        }

        Task clearing = Task.FromResult(0); // the last sign-out's clearing (never faults)

        // Signed out or revoked: everything the profile kept for that account goes: cookies, storage and the HTTP disk
        // cache (thumbnails, files viewed in the page). The host does it: the page doesn't call /api/clear-cache here.
        public void SignedOut()
        {
            if (core == null) { WebHost.ForgetProfile(app.Cfg); return; }
            clearing = ClearProfile(core);
        }

        static async Task ClearProfile(CoreWebView2 core)
        {
            try { core.CookieManager.DeleteAllCookies(); } catch { }
            try
            {
                // All kinds (DiskCache included). The browser process does it, so it also works while the page is
                // suspended (hidden), where a script would wait until it shows.
                await core.Profile.ClearBrowsingDataAsync();
                Log.Write("Cleared the chat window's data (cookies, storage, HTTP cache)");
            }
            catch (Exception ex) { Log.Error("Clearing the chat window's data", ex); }
            // The open page's own copy of its storage; a suspended page is reloaded before it's used again anyway.
            try { if (!core.IsSuspended) { var ignored = core.ExecuteScriptAsync("try{localStorage.clear()}catch(e){}"); } } catch { }
        }

        // The key was revoked: say so in the window, with a button to sign in again.
        public void ShowSignedOut()
        {
            ShowOverlay("Sign in to Beam again", "This PC isn't signed in to Beam any more. Sign in again to carry on; files already saved stay on this PC.", false, true, true, false);
        }

        public void HideSignedOut()
        {
            if (showSignIn) { HideOverlay(); showSignIn = false; }
        }

        public void OpenPanel(string panel)
        {
            if (helloSeen) { PostEvent("openPanel", "panel", panel); return; }
            panelToOpen = panel;
            if (panel == "pair" && core != null && pageLoaded) core.Navigate(Origin + "/#pair");
        }

        // Beam 1.5: a phone notification's balloon was clicked: the page opens its Phone panel with that one selected
        // and its reply box focused (`openPhoneNotification { id }`; ids carry no content, so the log may name them).
        public void OpenPhoneNotification(string id)
        {
            if (helloSeen) { SendOpenPhone(id); return; }
            phoneToOpen = id;
        }

        void SendOpenPhone(string id)
        {
            PostEvent("openPhoneNotification", "id", id);
            Log.Write("Web window: openPhoneNotification " + id);
        }

        void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            string uri = e.Uri ?? "";
            if (SameOrigin(uri) || uri.StartsWith("about:", StringComparison.OrdinalIgnoreCase)) return;
            e.Cancel = true;
            if (e.IsUserInitiated) FileUtil.OpenUrl(uri);
            Log.Write("Web window: kept a navigation away from Beam out of the window");
        }

        void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (!e.IsSuccess)
            {
                if (e.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled) return;
                loadFailed = true;
                pageLoaded = false;
                Log.Write("Web window: couldn't load the page (" + e.WebErrorStatus + ")");
                ShowOverlay("Can't reach Beam", "Beam at " + App.HostOf(Origin) + " isn't answering. Beam keeps trying, and receives in the background as soon as it's back.", true, true, false, false);
                retryTimer.Start();
                if (panelToOpen == "settings") { panelToOpen = null; app.ShowNativeSettings(); }
                return;
            }
            loadFailed = false;
            pageLoaded = true;
            if (opening != null) Perf.Mark("open " + openingKind + ": page loaded", opening.ElapsedMilliseconds);
            HideOverlay();
            helloTimer.Stop();
            helloTimer.Start();
            if (!helloSeen) readTimer.Start();
            if (panelToOpen == "pair" && !helloSeen) { panelToOpen = null; }
            if (app.TestCapture != null && !captured) CaptureSoon(helloSeen ? 1500 : 5000);
        }

        void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
            string uri = e.Uri ?? "";
            if (SameOrigin(uri))
            {
                var path = new Uri(uri).AbsolutePath;
                var m = FilePath.Match(path);
                if (m.Success) { app.OpenItemFile(m.Groups[1].Value, "open"); return; }
                m = TextPath.Match(path);
                if (m.Success) { app.OpenFullText(m.Groups[1].Value); return; }
                Log.Write("Web window: ignored a new window for " + path);
                return;
            }
            FileUtil.OpenUrl(uri);
        }

        void OnDownloadStarting(object sender, CoreWebView2DownloadStartingEventArgs e)
        {
            e.Cancel = true;
            e.Handled = true;
            string uri = e.DownloadOperation != null ? e.DownloadOperation.Uri : "";
            if (!SameOrigin(uri)) return;
            var m = FilePath.Match(new Uri(uri).AbsolutePath);
            if (m.Success) { app.SaveItemById(m.Groups[1].Value, "reveal", null); return; }
            Log.Write("Web window: a download that isn't a Beam item was blocked");
        }

        void OnPermissionRequested(object sender, CoreWebView2PermissionRequestedEventArgs e)
        {
            bool ours = SameOrigin(e.Uri);
            if (ours && (e.PermissionKind == CoreWebView2PermissionKind.ClipboardRead || e.PermissionKind == CoreWebView2PermissionKind.MultipleAutomaticDownloads))
                e.State = CoreWebView2PermissionState.Allow;
            else e.State = CoreWebView2PermissionState.Deny;
        }

        static readonly HashSet<string> AllowedMenu = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "copy", "cut", "paste", "pasteAndMatchStyle", "selectAll", "copyLinkLocation", "copyImage", "undo", "redo", "emoji"
        };

        void OnContextMenuRequested(object sender, CoreWebView2ContextMenuRequestedEventArgs e)
        {
            if (app.DevTools) return;
            var items = e.MenuItems;
            for (int i = items.Count - 1; i >= 0; i--)
            {
                var it = items[i];
                bool keep = it.Kind == CoreWebView2ContextMenuItemKind.Separator || AllowedMenu.Contains(it.Name) ||
                    it.Name.StartsWith("spell", StringComparison.OrdinalIgnoreCase) || it.Name.StartsWith("addToDictionary", StringComparison.OrdinalIgnoreCase);
                if (!keep) items.RemoveAt(i);
            }
            // No separators at the ends or twice in a row.
            for (int i = items.Count - 1; i >= 0; i--)
            {
                bool sep = items[i].Kind == CoreWebView2ContextMenuItemKind.Separator;
                bool edge = i == 0 || i == items.Count - 1;
                bool dup = i > 0 && items[i - 1].Kind == CoreWebView2ContextMenuItemKind.Separator;
                if (sep && (edge || dup)) items.RemoveAt(i);
            }
            if (items.Count == 0) e.Handled = true;
        }

        void OnProcessFailed(object sender, CoreWebView2ProcessFailedEventArgs e)
        {
            Log.Write("Web window: WebView2 process failed (" + e.ProcessFailedKind + ")");
            if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
            {
                BeginInvoke(new Action(() => { DisposeWeb(); if (Visible) EnsureWeb(); }));
                return;
            }
            if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited || e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
                BeginInvoke(new Action(() => { if (core != null) Navigate(); }));
        }

        void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!SameOrigin(e.Source))
            {
                Log.Write("Web window: ignored a message from another origin");
                return;
            }
            var files = new List<string>();
            try
            {
                var extra = e.AdditionalObjects;
                if (extra != null)
                    foreach (var o in extra)
                    {
                        var f = o as CoreWebView2File;
                        if (f != null && !string.IsNullOrEmpty(f.Path)) files.Add(f.Path);
                    }
            }
            catch (Exception ex) { Log.Error("Web window: dropped files", ex); }
            string json;
            try { json = e.WebMessageAsJson; }
            catch { return; }
            bridge.Handle(json, files);
        }

        // ------------------------------------------------------------------ bridge plumbing

        // Tests (custom --config only): a message as if the page sent it.
        public void TestBridge(string json)
        {
            bridge.Handle(json, new List<string>());
        }

        public void OnHello()
        {
            if (opening != null) { Perf.Mark("open " + openingKind + ": bridge ready", opening.ElapsedMilliseconds); opening = null; }
            helloSeen = true;
            app.PageBridge = true;
            helloTimer.Stop();
        }

        // Called by the bridge right after it replied to hello: queued events, then pending navigation.
        public void AfterHello()
        {
            foreach (var json in queued) Post(json);
            queued.Clear();
            FlushNavigation();
            if (panelToOpen != null) { PostEvent("openPanel", "panel", panelToOpen); panelToOpen = null; }
            if (phoneToOpen != null) { SendOpenPhone(phoneToOpen); phoneToOpen = null; }
            if (app.TestCapture != null && !captured) CaptureSoon(1500);
        }

        void FlushNavigation()
        {
            if (!helloSeen || (navConv == null && navItem == null)) return;
            var d = new Dictionary<string, object>();
            d["type"] = "navigate";
            d["conversation"] = App.ToPageConv(navConv);
            d["itemId"] = navItem;
            d["focusComposer"] = navItem == null;
            navConv = navItem = null;
            Post(Json.Stringify(d));
        }

        public void SetViewing(string conv, bool visible)
        {
            viewingConv = conv;
            viewingVisible = visible;
        }

        public void Post(string json)
        {
            if (core == null) return;
            try { core.PostWebMessageAsJson(json); }
            catch (Exception ex) { Log.Error("Web window: post", ex); }
        }

        public void PostEvent(string type, string field, object value)
        {
            var d = new Dictionary<string, object>();
            d["type"] = type;
            if (field != null) d[field] = value;
            string json = Json.Stringify(d);
            if (!helloSeen) { if (core != null && queued.Count < 200) queued.Add(json); return; }
            Deliver(type, json);
        }

        // While the page is hidden (frozen), keep only the latest event per key and deliver them when it shows, so
        // transfer progress doesn't wake it several times a second.
        void Deliver(string key, string json)
        {
            if (!pageHidden) { Post(json); return; }
            if (held.Contains(key)) held.Remove(key);
            held.Add(key, json);
        }

        void FlushHeld()
        {
            if (held.Count == 0) return;
            var list = held.Values.Cast<string>().ToList();
            held.Clear();
            if (!helloSeen) return; // a page that hasn't said hello gets the whole state with it
            foreach (var json in list) Post(json);
        }

        void OnTransferChanged(Job job)
        {
            if (!helloSeen) return;
            var d = new Dictionary<string, object>();
            d["type"] = "transfer";
            d["transfer"] = bridge.TransferObject(job);
            Deliver("transfer:" + job.TransferId, Json.Stringify(d));
        }

        void OnTransferRemoved(string transferId, string itemId)
        {
            if (!helloSeen) return;
            var d = new Dictionary<string, object>();
            d["type"] = "transferRemoved";
            d["transferId"] = transferId;
            d["itemId"] = itemId;
            if (held.Contains("transfer:" + transferId)) held.Remove("transfer:" + transferId);
            Deliver("removed:" + transferId, Json.Stringify(d));
        }

        void OnLocalFileChanged(string itemId, bool saved)
        {
            if (!helloSeen) return;
            var d = new Dictionary<string, object>();
            d["type"] = "localFile";
            d["itemId"] = itemId;
            d["saved"] = saved;
            Deliver("localFile:" + itemId, Json.Stringify(d));
        }

        void OnSettingsChanged() { if (helloSeen) PostEvent("settings", "settings", app.SettingsObject()); }
        void OnUpdateChanged() { if (helloSeen) PostEvent("update", "update", bridge.UpdateObject()); }
        void OnConnChanged() { if (helloSeen) PostEvent("conn", "conn", bridge.ConnObject()); }

        // Starts a native drag of a saved file (the page calls this from dragstart).
        public string DragOut(string itemId)
        {
            string path = app.LocalFile(itemId);
            if (path == null) return "not-saved";
            if (web == null) return "busy";
            var data = new DataObject();
            data.SetFileDropList(new StringCollection { path });
            BeginInvoke(new Action(() => { try { web.DoDragDrop(data, DragDropEffects.Copy); } catch (Exception ex) { Log.Error("Drag out", ex); } }));
            return null;
        }

        // ------------------------------------------------------------------ tests: a picture of the window

        void CaptureSoon(int delayMs)
        {
            var t = new Timer();
            t.Interval = delayMs;
            t.Tick += async (s, e) =>
            {
                t.Stop();
                t.Dispose();
                if (captured || core == null || app.TestCapture == null) return;
                captured = true;
                try
                {
                    using (var ms = new MemoryStream())
                    {
                        await core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, ms);
                        File.WriteAllBytes(app.TestCapture, ms.ToArray());
                    }
                    Log.Write("Test capture saved (" + (helloSeen ? "bridge ready" : "no bridge") + ")");
                }
                catch (Exception ex) { Log.Error("Test capture", ex); }
            };
            t.Start();
        }
    }
}
