// LocalCast's weather in a window of the app's own (Windows app 1.28, Beam 1.36; the user, 2026-11-21: "my local cast
// weather should be part of this app", then "you should just implement the page that is served by tailscale into
// beam, i wont change that link"). The chat's Weather row asks for it (bridge openWeather, with the address Beam's
// server found: LocalCast's page on the tailnet); the page is LocalCast's own, as it is. Like Beam Family's window:
// WebView2 with a profile of its own (WebView2\Weather), no bridge and no Beam identity, nothing of Beam's sign-in.
// Only that page's own address stays in it (its other links open in the browser). Closing it lets it go.
using System;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Beam
{
    class WeatherWindow : Form
    {
        static Task<CoreWebView2Environment> environment;

        readonly App app;
        string url;
        WebView2 web;
        CoreWebView2 core;
        bool loadFailed, creating;
        readonly Timer retryTimer;
        readonly Panel overlay;
        readonly Label2 overlayTitle, overlayText;
        readonly FlatButton overlayRetry;

        // http(s) only, without a user name or password: the address the server gave, or null.
        public static string CleanUrl(string s)
        {
            Uri u;
            if (string.IsNullOrEmpty(s) || s.Length > 2000 || !Uri.TryCreate(s, UriKind.Absolute, out u)) return null;
            if (u.Scheme != Uri.UriSchemeHttp && u.Scheme != Uri.UriSchemeHttps) return null;
            if (!string.IsNullOrEmpty(u.UserInfo)) return null;
            return u.AbsoluteUri;
        }

        public WeatherWindow(App app, string url)
        {
            this.app = app;
            this.url = url;
            Text = "Weather";
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

            if (app.TestOffscreen)
            {
                StartPosition = FormStartPosition.Manual;
                Bounds = new Rectangle(-20000, -20000, 1100, 800);
            }
            else
            {
                var wa = Screen.FromPoint(Cursor.Position).WorkingArea;
                StartPosition = FormStartPosition.CenterScreen;
                Size = new Size(Math.Min(Ui.S(1180), wa.Width * 9 / 10), Math.Min(Ui.S(820), wa.Height * 9 / 10));
            }
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

        protected override bool ShowWithoutActivation { get { return app != null && app.TestOffscreen; } }

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

        public void ShowAndActivate()
        {
            if (!Visible) Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            if (!app.TestOffscreen) { Activate(); BringToFront(); Native.SetForegroundWindow(Handle); }
            if (web == null) EnsureWeb();
            else if (loadFailed) Navigate();
        }

        // The row named another address (LocalCast moved, or Settings changed it): the window goes there.
        public void UrlChanged(string newUrl)
        {
            if (newUrl == url) return;
            url = newUrl;
            if (core != null) Navigate();
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

        static Task<CoreWebView2Environment> Environment(Config cfg)
        {
            if (environment == null || environment.IsFaulted || environment.IsCanceled)
            {
                WebHost.EnsureLoader(cfg);
                string folder = Path.Combine(cfg.WebViewFolder, "Weather");
                Directory.CreateDirectory(folder);
                var o = new CoreWebView2EnvironmentOptions();
                o.AllowSingleSignOnUsingOSPrimaryAccount = false;
                environment = CoreWebView2Environment.CreateAsync(null, folder, o);
                Log.Write("Weather: its own profile (Weather)");
            }
            return environment;
        }

        bool SameOrigin(string other)
        {
            Uri u, o;
            if (!Uri.TryCreate(other ?? "", UriKind.Absolute, out u) || !Uri.TryCreate(url ?? "", UriKind.Absolute, out o)) return false;
            return u.Scheme == o.Scheme && string.Equals(u.Host, o.Host, StringComparison.OrdinalIgnoreCase) && u.Port == o.Port;
        }

        async void EnsureWeb()
        {
            if (web != null || creating) return;
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
                Navigate();
            }
            catch (Exception ex)
            {
                Log.Error("Weather window", ex);
                ShowOverlay("The weather's window couldn't start", "Microsoft Edge WebView2 didn't start (" + ex.Message + "). LocalCast's page opens in the browser too.");
                overlayRetry.Visible = false;
            }
            finally { creating = false; }
        }

        void Navigate()
        {
            if (core == null) { EnsureWeb(); return; }
            loadFailed = false;
            retryTimer.Stop();
            try { core.Navigate(url); }
            catch (Exception ex) { Log.Error("Weather: navigate", ex); }
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
            core.NewWindowRequested += (o, e) => { e.Handled = true; FileUtil.OpenUrl(e.Uri); };
            core.LaunchingExternalUriScheme += (o, e) => { e.Cancel = true; };
            core.WindowCloseRequested += (o, e) => BeginInvoke(new Action(Close));
            core.PermissionRequested += (o, e) => { e.State = CoreWebView2PermissionState.Deny; };
            core.DocumentTitleChanged += (o, e) =>
            {
                string t = core.DocumentTitle;
                Text = string.IsNullOrWhiteSpace(t) || t.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? "Weather" : t;
            };
            core.ProcessFailed += (o, e) =>
            {
                Log.Write("Weather: WebView2 process failed (" + e.ProcessFailedKind + ")");
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
                Log.Write("Weather: couldn't load LocalCast's page (" + e.WebErrorStatus + ")");
                Uri u;
                string where = Uri.TryCreate(url, UriKind.Absolute, out u) ? u.Authority : url;
                ShowOverlay("Can't reach LocalCast", "LocalCast's page at " + where + " isn't answering. This window tries again every few seconds.");
                overlayRetry.Visible = true;
                retryTimer.Start();
                return;
            }
            loadFailed = false;
            overlay.Visible = false;
            Log.Write("Weather: LocalCast's page shown");
        }
    }
}
