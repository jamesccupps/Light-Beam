// Beam Family in a window of the app's own (Windows app 1.10): the family's chat (its own server; Beam's /api/info names
// its address, BEAM_FAMILY_URL) in WebView2 with a profile of its own (WebView2\Family). Beam's sign-in cookie never
// reaches it (cookies don't keep to a port, and Family is often on Beam's own machine name), and Family signs its people
// in itself (by Tailscale on the tailnet). No bridge and no Beam identity: the page is only told it's in this window
// (`beamHost.window = "family"`), so it doesn't offer notifications, which WebView2 can't get (no push service): those
// stay with the browser. Opened from the chat's ♥ (bridge openFamily), the tray's "Beam Family" and `Beam.exe --family`.
// Closing it lets it go (it's made again when opened). Minimized, its page is hidden, so Family pushes to the other
// devices and doesn't mark anything read meanwhile.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Beam
{
    class FamilyWindow : Form
    {
        static Task<CoreWebView2Environment> environment;
        static bool clearOnOpen;   // signed out while the profile couldn't be deleted: the next window clears it first

        readonly App app;
        string url;                // Family's address, as Beam's server gave it
        WebView2 web;
        CoreWebView2 core;
        bool loadFailed, quietShow, creating;
        readonly Timer retryTimer;
        readonly Panel overlay;
        readonly Label2 overlayTitle, overlayText;
        readonly FlatButton overlayRetry;

        public FamilyWindow(App app, string url)
        {
            this.app = app;
            this.url = url;
            Text = "Beam Family";
            Ui.StyleForm(this);
            KeyPreview = false;
            MinimumSize = new Size(Ui.S(380), Ui.S(480));

            overlay = new Panel();
            overlay.Dock = DockStyle.Fill;
            overlay.BackColor = Theme.Bg;
            overlayTitle = new Label2("", Ui.Title, false);
            overlayTitle.TextAlign = ContentAlignment.TopCenter;
            overlayText = new Label2("", Ui.Font, true);
            overlayText.TextAlign = ContentAlignment.TopCenter;
            overlayRetry = new FlatButton("Try again", null);
            overlayRetry.Primary = true;
            overlayRetry.BackColor = Theme.Bg;
            overlayRetry.Size = new Size(Math.Max(Ui.S(120), overlayRetry.Preferred().Width), Ui.S(36));
            overlayRetry.Click += (s, e) => Navigate();
            overlay.Controls.Add(overlayTitle);
            overlay.Controls.Add(overlayText);
            overlay.Controls.Add(overlayRetry);
            overlay.Resize += (s, e) => LayoutOverlay();
            overlay.Visible = false;
            Controls.Add(overlay);

            retryTimer = new Timer();
            retryTimer.Interval = 10000;
            retryTimer.Tick += (s, e) => { if (loadFailed && Visible) Navigate(); };

            RestoreBounds_();
            Theme.Changed += OnTheme;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                Theme.Changed -= OnTheme;
                retryTimer.Dispose();
                if (web != null) { try { web.Dispose(); } catch { } web = null; core = null; }
            }
            base.Dispose(disposing);
        }

        protected override bool ShowWithoutActivation { get { return quietShow || (app != null && app.TestOffscreen); } }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                if (app != null && app.TestOffscreen) cp.ExStyle |= 0x08000000 | 0x00000080; // tests: never focused, no taskbar
                return cp;
            }
        }

        public string Url { get { return url; } }

        // activate = false: shown without taking the focus (reopened after an update).
        public void ShowAndActivate(bool activate)
        {
            if (!Visible) { quietShow = !activate; Show(); quietShow = false; }
            if (WindowState == FormWindowState.Minimized && activate) WindowState = FormWindowState.Normal;
            if (!app.TestOffscreen && activate) { Activate(); BringToFront(); Native.SetForegroundWindow(Handle); }
            if (web == null) EnsureWeb();
            else if (loadFailed) Navigate();
        }

        // Beam's server now names another address for Family: the window goes there.
        public void UrlChanged(string newUrl)
        {
            if (newUrl == url) return;
            url = newUrl;
            if (core != null) Navigate();
        }

        public void CloseForGood()
        {
            if (!IsDisposed) Close();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            SaveBounds();
            base.OnFormClosing(e);
        }

        protected override void OnResizeEnd(EventArgs e)
        {
            base.OnResizeEnd(e);
            SaveBounds();
        }

        // Minimized counts as hidden: the page says so to Family (pushes go to the other devices, nothing is read).
        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            SyncVisible();
        }

        void SyncVisible()
        {
            if (web == null) return;
            bool shown = WindowState != FormWindowState.Minimized;
            try { if (web.Visible != shown) web.Visible = shown; } catch { }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Theme.ApplyTitleBar(this, Theme.Bg);
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Native.WM_DPICHANGED)
            {
                // Per-monitor DPI (as the chat window): take the size Windows suggests for the new monitor.
                var r = (Native.RECT)System.Runtime.InteropServices.Marshal.PtrToStructure(m.LParam, typeof(Native.RECT));
                Native.SetWindowPos(Handle, IntPtr.Zero, r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top, 0x0014 /* NOZORDER | NOACTIVATE */);
                return;
            }
            base.WndProc(ref m);
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

        void SaveBounds()
        {
            if (app.TestOffscreen) return;
            var b = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            if (b.Width < 100) return;
            var c = app.Cfg;
            c.FamX = b.X; c.FamY = b.Y; c.FamW = b.Width; c.FamH = b.Height;
            c.FamMax = WindowState == FormWindowState.Maximized;
            c.Save();
        }

        void RestoreBounds_()
        {
            var c = app.Cfg;
            if (app.TestOffscreen)
            {
                StartPosition = FormStartPosition.Manual;
                Bounds = new Rectangle(-20000, -20000, 1100, 800);
                return;
            }
            var saved = new Rectangle(c.FamX, c.FamY, c.FamW, c.FamH);
            bool visible = c.FamW >= MinimumSize.Width && c.FamH >= MinimumSize.Height &&
                Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(new Rectangle(saved.X + 40, saved.Y + 10, Math.Max(1, saved.Width - 80), 40)));
            if (visible)
            {
                StartPosition = FormStartPosition.Manual;
                Bounds = saved;
                if (c.FamMax) WindowState = FormWindowState.Maximized;
                return;
            }
            var wa = Screen.FromPoint(Cursor.Position).WorkingArea;
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(Math.Min(Ui.S(1100), wa.Width * 9 / 10), Math.Min(Ui.S(780), wa.Height * 9 / 10));
        }

        // ------------------------------------------------------------------ overlay (can't reach Family)

        void ShowOverlay(string title, string text)
        {
            overlayTitle.Text = title;
            overlayText.Text = text;
            overlay.Visible = true;
            overlay.BringToFront();
            LayoutOverlay();
        }

        void LayoutOverlay()
        {
            int w = Math.Min(overlay.ClientSize.Width - Ui.S(40), Ui.S(460));
            int x = (overlay.ClientSize.Width - w) / 2;
            int y = overlay.ClientSize.Height / 2 - Ui.S(70);
            int th = TextRenderer.MeasureText(overlayTitle.Text.Length > 0 ? overlayTitle.Text : " ", Ui.Title, new Size(w, int.MaxValue), Ui.Wrap).Height;
            overlayTitle.SetBounds(x, y, w, th);
            y += th + Ui.S(6);
            int h2 = TextRenderer.MeasureText(overlayText.Text.Length > 0 ? overlayText.Text : " ", Ui.Font, new Size(w, int.MaxValue), Ui.Wrap).Height;
            overlayText.SetBounds(x, y, w, h2 + Ui.S(4));
            y += h2 + Ui.S(20);
            overlayRetry.Location = new Point((overlay.ClientSize.Width - overlayRetry.Width) / 2, y);
        }

        // ------------------------------------------------------------------ the web view

        static Task<CoreWebView2Environment> Environment(Config cfg)
        {
            if (environment == null || environment.IsFaulted || environment.IsCanceled)
            {
                WebHost.EnsureLoader(cfg);
                string folder = Path.Combine(cfg.WebViewFolder, "Family");
                Directory.CreateDirectory(folder);
                var o = new CoreWebView2EnvironmentOptions();
                o.AllowSingleSignOnUsingOSPrimaryAccount = false;
                environment = CoreWebView2Environment.CreateAsync(null, folder, o);
                Log.Write("Beam Family: its own profile (Family)");
            }
            return environment;
        }

        string Origin
        {
            get
            {
                Uri u;
                return Uri.TryCreate(url ?? "", UriKind.Absolute, out u) ? u.Scheme + "://" + u.Authority : "";
            }
        }

        bool SameOrigin(string other)
        {
            Uri u, o;
            if (!Uri.TryCreate(other ?? "", UriKind.Absolute, out u) || !Uri.TryCreate(Origin, UriKind.Absolute, out o)) return false;
            return u.Scheme == o.Scheme && string.Equals(u.Host, o.Host, StringComparison.OrdinalIgnoreCase) && u.Port == o.Port;
        }

        async void EnsureWeb()
        {
            if (web != null || creating) return; // (opened twice quickly: one web view)
            creating = true;
            try
            {
                var env = await Environment(app.Cfg);
                if (IsDisposed) return;
                var w = new WebView2();
                w.DefaultBackgroundColor = Theme.Bg;
                w.Dock = DockStyle.Fill;
                Controls.Add(w);
                w.SendToBack();
                web = w;
                await w.EnsureCoreWebView2Async(env);
                if (IsDisposed) return;
                core = w.CoreWebView2;
                Configure();
                if (clearOnOpen)
                {
                    clearOnOpen = false;
                    try { await core.Profile.ClearBrowsingDataAsync(); } catch (Exception ex) { Log.Error("Beam Family: clearing old data", ex); }
                }
                await core.AddScriptToExecuteOnDocumentCreatedAsync(HostScript());
                SyncVisible(); // (opened minimized: hidden from the start)
                Navigate();
            }
            catch (Exception ex)
            {
                Log.Error("Beam Family window", ex);
                ShowOverlay("Beam Family's window couldn't start", "Microsoft Edge WebView2 didn't start (" + ex.Message + "). Beam Family works in the browser too.");
                overlayRetry.Visible = false;
            }
            finally { creating = false; }
        }

        // What the page may know: it's in this window (no notifications here). Only for Family's own pages.
        string HostScript()
        {
            var h = new Dictionary<string, object>();
            h["app"] = "windows";
            h["window"] = "family";
            h["version"] = AppVersion.Text;
            return "(function(){if(location.origin!==" + Json.Stringify(Origin) + ")return;var h=" + Json.Stringify(h) + ";" +
                "try{Object.defineProperty(window,'beamHost',{value:Object.freeze(h),writable:false,configurable:false});}catch(e){}})();";
        }

        void Navigate()
        {
            if (core == null) { EnsureWeb(); return; }
            loadFailed = false;
            retryTimer.Stop();
            try { core.Navigate(url); }
            catch (Exception ex) { Log.Error("Beam Family: navigate", ex); }
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
            s.IsWebMessageEnabled = false;
            s.IsGeneralAutofillEnabled = false;
            s.IsPasswordAutosaveEnabled = false;
            s.IsSwipeNavigationEnabled = false;
            core.NavigationStarting += (o, e) =>
            {
                string uri = e.Uri ?? "";
                if (SameOrigin(uri) || uri.StartsWith("about:", StringComparison.OrdinalIgnoreCase)) return;
                e.Cancel = true;
                if (e.IsUserInitiated) FileUtil.OpenUrl(uri);
            };
            core.NavigationCompleted += OnNavigationCompleted;
            // Links in messages, and anything else that wants a window of its own: the browser.
            core.NewWindowRequested += (o, e) => { e.Handled = true; FileUtil.OpenUrl(e.Uri); };
            core.LaunchingExternalUriScheme += (o, e) => { e.Cancel = true; };
            core.WindowCloseRequested += (o, e) => BeginInvoke(new Action(Close));
            core.PermissionRequested += (o, e) =>
            {
                // As in the chat window: pasting and saving several files; nothing else (notifications stay with the browser).
                bool ours = SameOrigin(e.Uri);
                e.State = ours && (e.PermissionKind == CoreWebView2PermissionKind.ClipboardRead || e.PermissionKind == CoreWebView2PermissionKind.MultipleAutomaticDownloads)
                    ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
            };
            core.DocumentTitleChanged += (o, e) =>
            {
                string t = core.DocumentTitle;
                Text = string.IsNullOrWhiteSpace(t) || t.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? "Beam Family" : t;
            };
            core.ProcessFailed += (o, e) =>
            {
                Log.Write("Beam Family: WebView2 process failed (" + e.ProcessFailedKind + ")");
                if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited || e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
                    BeginInvoke(new Action(() => { if (core != null) core.Reload(); }));
                else if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
                    BeginInvoke(new Action(Close));
            };
        }

        void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (!e.IsSuccess)
            {
                if (e.WebErrorStatus == CoreWebView2WebErrorStatus.OperationCanceled) return;
                loadFailed = true;
                Log.Write("Beam Family: couldn't load its page (" + e.WebErrorStatus + ")");
                ShowOverlay("Can't reach Beam Family", "Beam Family at " + App.HostOf(Origin) + " isn't answering. This window tries again every few seconds.");
                overlayRetry.Visible = true;
                retryTimer.Start();
                return;
            }
            loadFailed = false;
            overlay.Visible = false;
        }

        // Signed out of Beam or revoked: the window closes (App), then its profile goes (it holds the Family sign-in made
        // in it). Its browser process may hold files for a few seconds: tried after 3, 10 and 30 s, and the next window
        // clears it first anyway.
        public static void ForgetProfile(Config cfg)
        {
            environment = null;
            string dir = Path.Combine(cfg.WebViewFolder, "Family");
            if (!Directory.Exists(dir)) return;
            clearOnOpen = true;
            Forget(dir, 0);
        }

        static readonly int[] ForgetAfter = { 3000, 10000, 30000 };

        static void Forget(string dir, int attempt)
        {
            Action run = () =>
            {
                if (!clearOnOpen) return; // a new window has cleared it already
                try
                {
                    if (Directory.Exists(dir)) Directory.Delete(dir, true);
                    clearOnOpen = false;
                    Log.Write("Beam Family: removed its window's data");
                }
                catch
                {
                    if (attempt + 1 < ForgetAfter.Length) Forget(dir, attempt + 1);
                    else Log.Write("Beam Family: its window's data couldn't be removed yet (in use); the next window clears it");
                }
            };
            Task.Delay(ForgetAfter[attempt]).ContinueWith(t => { var a = App.Current; if (a != null) a.Post(run); else run(); });
        }
    }
}
