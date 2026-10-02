// The viewer window (Beam 1.6): this PC controlling another one. The web app's remote view (<server>/#remote=<id>, the
// web page's remote.js) in a window of its own, with a WebView2 profile of its own (WebView2\RemoteView) that has the
// WebRTC playout-delay field trial (the spike: the jitter buffer drops to ~2 ms; the chat window's profile stays as it
// was). Signed in like the chat window (cookie + injected identity). It's never suspended while open; the browser's
// accelerator keys are off, so Ctrl+R, F5 or Ctrl+F reach the other PC; the page can make it full screen; and when the
// page turns it on, while the window has the focus, a low-level keyboard hook takes the keys Windows would act on
// itself (the Win keys, Alt+Tab, Alt+F4, Ctrl+Esc, Print Screen…) and hands them to the page as `remoteKey` instead.
// Its small bridge is described in docs/HOST-BRIDGE.md ("The viewer window").
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Beam
{
    class RemoteViewWindow : Form
    {
        public static readonly string[] Features = { "keyboardHook", "fullscreen" };
        static Task<CoreWebView2Environment> environment;
        static bool clearOnOpen;   // signed out while the profile couldn't be deleted: the next window clears it first

        readonly App app;
        readonly string device;
        readonly string deviceName;
        WebView2 web;
        CoreWebView2 core;
        string sessionId;          // the page's session (remoteSession): ended when the window closes
        bool hookWanted;
        IntPtr hook = IntPtr.Zero;
        HookProc hookProc;         // kept referenced while installed
        readonly Dictionary<int, string> swallowed = new Dictionary<int, string>(); // keys taken down by the hook (their ups go too)
        bool fullScreen;
        FormWindowState savedState;
        FormBorderStyle savedBorder;
        Rectangle savedBounds;

        public RemoteViewWindow(App app, string device, string deviceName)
        {
            this.app = app;
            this.device = device;
            this.deviceName = deviceName;
            Text = deviceName + " · Beam";
            Ui.StyleForm(this);
            BackColor = Color.Black;
            KeyPreview = false;
            MinimumSize = new Size(Ui.S(480), Ui.S(320));
            if (app.TestOffscreen) { StartPosition = FormStartPosition.Manual; Location = new Point(-20000, -20000); Size = new Size(1280, 800); }
            else
            {
                var wa = Screen.FromPoint(Cursor.Position).WorkingArea;
                StartPosition = FormStartPosition.CenterScreen;
                Size = new Size(Math.Min(Ui.S(1440), wa.Width * 9 / 10), Math.Min(Ui.S(900), wa.Height * 9 / 10));
            }
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

        public void ShowAndActivate()
        {
            if (!Visible) Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            if (!app.TestOffscreen) { Activate(); Native.SetForegroundWindow(Handle); }
            if (web == null) EnsureWeb();
        }

        public void CloseForGood()
        {
            if (!IsDisposed) Close();
        }

        // The app's sign-in changed (a new token): the page's cookie follows.
        public void CookieAgain() { var _ = SetCookie(); }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Theme.ApplyTitleBar(this, Color.Black);
        }

        // ------------------------------------------------------------------ the web view

        static Task<CoreWebView2Environment> Environment(Config cfg)
        {
            if (environment == null || environment.IsFaulted || environment.IsCanceled)
            {
                WebHost.EnsureLoader(cfg);
                string folder = Path.Combine(cfg.WebViewFolder, "RemoteView");
                Directory.CreateDirectory(folder);
                var o = new CoreWebView2EnvironmentOptions();
                o.AdditionalBrowserArguments = "--force-fieldtrials=WebRTC-ForcePlayoutDelay/min_ms:0,max_ms:0/";
                o.AllowSingleSignOnUsingOSPrimaryAccount = false;
                environment = CoreWebView2Environment.CreateAsync(null, folder, o);
                Log.Write("Remote view: its own profile (RemoteView), WebRTC playout delay 0");
            }
            return environment;
        }

        string Origin { get { return app.Cfg.Server == null ? "" : app.Cfg.Server.TrimEnd('/'); } }

        async void EnsureWeb()
        {
            if (web != null) return;
            try
            {
                var env = await Environment(app.Cfg);
                if (IsDisposed) return;
                var w = new WebView2();
                w.DefaultBackgroundColor = Color.Black;
                w.Dock = DockStyle.Fill;
                Controls.Add(w);
                web = w;
                await w.EnsureCoreWebView2Async(env);
                if (IsDisposed) return;
                core = w.CoreWebView2;
                Configure();
                if (clearOnOpen)
                {
                    clearOnOpen = false;
                    try { await core.Profile.ClearBrowsingDataAsync(); } catch (Exception ex) { Log.Error("Remote view: clearing old data", ex); }
                }
                await core.AddScriptToExecuteOnDocumentCreatedAsync(IdentityScript());
                await SetCookie();
                core.Navigate(Origin + "/#remote=" + Uri.EscapeDataString(device));
            }
            catch (Exception ex)
            {
                Log.Error("Remote view", ex);
                MessageBox.Show(this, "The remote control window couldn't start (" + ex.Message + ").", "Beam", MessageBoxButtons.OK, MessageBoxIcon.None);
                Close();
            }
        }

        void Configure()
        {
            var s = core.Settings;
            s.AreDevToolsEnabled = app.DevTools;
            s.AreDefaultContextMenusEnabled = false;   // right-click belongs to the other PC
            s.AreBrowserAcceleratorKeysEnabled = false; // Ctrl+R, F5, Ctrl+F… go to the page, and on to the other PC
            s.AreDefaultScriptDialogsEnabled = true;
            s.IsStatusBarEnabled = false;
            s.IsZoomControlEnabled = false;            // Ctrl+wheel too
            s.IsBuiltInErrorPageEnabled = false;
            s.AreHostObjectsAllowed = false;
            s.IsGeneralAutofillEnabled = false;
            s.IsPasswordAutosaveEnabled = false;
            s.IsSwipeNavigationEnabled = false;
            s.IsPinchZoomEnabled = false;
            s.IsWebMessageEnabled = true;
            core.NavigationStarting += (o, e) =>
            {
                if (SameOrigin(e.Uri) || (e.Uri ?? "").StartsWith("about:", StringComparison.OrdinalIgnoreCase))
                {
                    DropHook("its page loads again"); // a new page asks for the hook itself, or doesn't get it
                    return;
                }
                e.Cancel = true;
                if (e.IsUserInitiated) FileUtil.OpenUrl(e.Uri);
            };
            core.NewWindowRequested += (o, e) => { e.Handled = true; if (!SameOrigin(e.Uri)) FileUtil.OpenUrl(e.Uri); };
            core.DownloadStarting += (o, e) => { e.Cancel = true; e.Handled = true; };
            core.LaunchingExternalUriScheme += (o, e) => { e.Cancel = true; };
            core.NotificationReceived += (o, e) => { e.Handled = true; };
            core.PermissionRequested += (o, e) =>
            {
                // The clipboard without a prompt (the viewer's clipboard sync); nothing else (no camera, no microphone).
                e.State = SameOrigin(e.Uri) && e.PermissionKind == CoreWebView2PermissionKind.ClipboardRead ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
            };
            core.DocumentTitleChanged += (o, e) => { string t = core.DocumentTitle; Text = string.IsNullOrWhiteSpace(t) || t.StartsWith("http") ? deviceName + " · Beam" : t; };
            core.ContainsFullScreenElementChanged += (o, e) => SetFullScreen(core.ContainsFullScreenElement);
            core.WebMessageReceived += OnWebMessage;
            WebGuard.Attach(core, app, () => Origin, true); // the device key on every /api/ request, never seen by the page
            core.ProcessFailed += (o, e) =>
            {
                Log.Write("Remote view: WebView2 process failed (" + e.ProcessFailedKind + ")");
                DropHook("its page stopped");
                if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited || e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
                    BeginInvoke(new Action(() => { if (core != null) core.Reload(); }));
                else if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
                    BeginInvoke(new Action(Close));
            };
        }

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
            h["window"] = "remote";
            h["version"] = AppVersion.Text;
            h["deviceId"] = app.Cfg.DeviceId;
            h["deviceName"] = app.Cfg.DeviceName;
            h["platform"] = "windows";
            h["server"] = Origin;
            h["features"] = Features;
            h["debug"] = app.DevTools;
            string json = Json.Stringify(h);
            return "(function(){if(location.origin!==" + Json.Stringify(Origin) + ")return;var h=" + json + ";" +
                "try{Object.defineProperty(window,'beamHost',{value:Object.freeze(h),writable:false,configurable:false});}catch(e){window.beamHost=h;}" +
                "try{localStorage.setItem('beam.deviceId',h.deviceId);localStorage.setItem('beam.device',h.deviceName);}catch(e){}})();";
        }

        Task SetCookie()
        {
            Uri u;
            if (core == null || app.Cfg.Key == null || !Uri.TryCreate(Origin, UriKind.Absolute, out u)) return Task.FromResult(0);
            try
            {
                var c = core.CookieManager.CreateCookie("beam_key", app.Cfg.Key, u.Host, "/");
                c.IsHttpOnly = true;
                c.IsSecure = u.Scheme == Uri.UriSchemeHttps;
                c.SameSite = CoreWebView2CookieSameSiteKind.Lax;
                c.Expires = DateTime.Now.AddYears(10);
                core.CookieManager.AddOrUpdateCookie(c);
            }
            catch (Exception ex) { Log.Error("Remote view: cookie", ex); }
            return WebHost.SetHostCookie(core, u, app.Cfg.Key, "Remote view");
        }

        // Signed out or revoked: the profile holds the sign-in cookie. Windows are closed first (App), then it goes;
        // if its browser process still holds files, it's tried again shortly and cleared by the next window anyway.
        public static void ForgetProfile(Config cfg)
        {
            environment = null;
            string dir = Path.Combine(cfg.WebViewFolder, "RemoteView");
            if (!Directory.Exists(dir)) return;
            clearOnOpen = true;
            Action attempt = () =>
            {
                try { if (Directory.Exists(dir)) Directory.Delete(dir, true); clearOnOpen = false; }
                catch { Log.Write("Remote view: its data couldn't be removed yet (in use); the next window clears it"); }
            };
            Task.Delay(3000).ContinueWith(t => { var a = App.Current; if (a != null) a.Post(attempt); else attempt(); });
        }

        // ------------------------------------------------------------------ the page's bridge

        void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!SameOrigin(e.Source)) return;
            string json;
            try { json = e.WebMessageAsJson; } catch { return; }
            HandleMessage(json);
        }

        // Tests (custom --config only): a message as if the page sent it; the page reloading.
        public void MessageForTest(string json) { HandleMessage(json); }
        public void ReloadForTest() { if (core != null) core.Reload(); }

        // The page (re)loads or stops: the hook goes until the page asks for it again.
        void DropHook(string why)
        {
            if (!hookWanted) return;
            hookWanted = false;
            UpdateHook();
            Log.Write("Remote view: keyboard hook off (" + why + ")");
        }

        void HandleMessage(string json)
        {
            var m = Json.ParseObject(json);
            if (m == null) return;
            object id = Json.Get(m, "id");
            string type = Json.Str(m, "type") ?? "";
            switch (type)
            {
                case "hello":
                {
                    var r = new Dictionary<string, object>();
                    r["app"] = "windows";
                    r["window"] = "remote";
                    r["version"] = AppVersion.Text;
                    r["deviceId"] = app.Cfg.DeviceId;
                    r["deviceName"] = app.Cfg.DeviceName;
                    r["device"] = device;
                    r["features"] = Features;
                    Reply(id, r);
                    break;
                }
                case "keyboardHook":
                {
                    bool on = Json.Bool(m, "on", false);
                    if (on != hookWanted) Log.Write("Remote view: keyboard hook " + (on ? "wanted by the page" : "off (the page's choice)"));
                    hookWanted = on;
                    UpdateHook();
                    var r = new Dictionary<string, object>();
                    r["on"] = hookWanted;
                    Reply(id, r);
                    break;
                }
                case "remoteSession":
                {
                    string sid = Json.Str(m, "id") ?? Json.Str(m, "session");
                    sessionId = sid != null && sid.Length == 16 && System.Text.RegularExpressions.Regex.IsMatch(sid, "^[0-9a-f]{16}$") ? sid : null;
                    Reply(id, null);
                    break;
                }
                case "closeWindow":
                    Reply(id, null);
                    BeginInvoke(new Action(Close));
                    break;
                case "openLink":
                {
                    string url = Json.Str(m, "url");
                    Uri u;
                    if (Uri.TryCreate(url ?? "", UriKind.Absolute, out u) && (u.Scheme == Uri.UriSchemeHttp || u.Scheme == Uri.UriSchemeHttps)) FileUtil.OpenUrl(url);
                    Reply(id, null);
                    break;
                }
                case "unauthorized":
                    app.OnPageUnauthorized();
                    break;
                case "log":
                {
                    string msg = Json.Str(m, "message") ?? "";
                    Log.Write("Remote view page: " + (msg.Length > 300 ? msg.Substring(0, 300) : msg));
                    break;
                }
                default:
                    Fail(id, "unknown-type", "Unknown message: " + type);
                    break;
            }
        }

        // The `id` of a message to the viewer window is a page-chosen string or number; replies echo it.
        void Reply(object id, object result)
        {
            if (id == null) return;
            var d = new Dictionary<string, object>();
            d["type"] = "reply";
            d["id"] = id;
            d["ok"] = true;
            d["result"] = result ?? new Dictionary<string, object>();
            Post(d);
        }

        void Fail(object id, string code, string error)
        {
            if (id == null) return;
            var d = new Dictionary<string, object>();
            d["type"] = "reply";
            d["id"] = id;
            d["ok"] = false;
            d["code"] = code;
            d["error"] = error;
            Post(d);
        }

        void Post(Dictionary<string, object> d)
        {
            if (core == null) return;
            try { core.PostWebMessageAsJson(Json.Stringify(d)); } catch { }
        }

        // ------------------------------------------------------------------ full screen

        void SetFullScreen(bool on)
        {
            if (on == fullScreen) return;
            fullScreen = on;
            if (on)
            {
                savedState = WindowState;
                savedBorder = FormBorderStyle;
                if (WindowState != FormWindowState.Normal) WindowState = FormWindowState.Normal;
                savedBounds = Bounds;
                FormBorderStyle = FormBorderStyle.None;
                if (!app.TestOffscreen) Bounds = Screen.FromControl(this).Bounds;
            }
            else
            {
                FormBorderStyle = savedBorder;
                Bounds = savedBounds;
                WindowState = savedState;
            }
        }

        // ------------------------------------------------------------------ the keyboard hook (focused, when asked)

        protected override void OnActivated(EventArgs e) { base.OnActivated(e); UpdateHook(); }
        protected override void OnDeactivate(EventArgs e) { base.OnDeactivate(e); UpdateHook(); }

        void UpdateHook()
        {
            bool want = hookWanted && !app.TestOffscreen && Visible && Native.GetForegroundWindow() == Handle;
            if (want && hook == IntPtr.Zero)
            {
                hookProc = OnKey;
                hook = SetWindowsHookEx(13 /* WH_KEYBOARD_LL */, hookProc, GetModuleHandle(null), 0);
                if (hook == IntPtr.Zero) Log.Write("Remote view: the keyboard hook couldn't be set (" + Marshal.GetLastWin32Error() + ")");
            }
            else if (!want && hook != IntPtr.Zero)
            {
                UnhookWindowsHookEx(hook);
                hook = IntPtr.Zero;
                // Keys taken down here go up on the other PC too.
                foreach (var kv in new List<KeyValuePair<int, string>>(swallowed)) SendCode(kv.Value, false);
                swallowed.Clear();
            }
        }

        // Which keys Windows would act on itself: the Win keys (and whatever is pressed with one), Alt+Tab, Alt+Esc,
        // Alt+Space, Alt+F4, Ctrl+Esc, Ctrl+Shift+Esc and Print Screen. Everything else reaches the page as usual.
        public static bool Takes(int vk, bool alt, bool ctrl, bool winHeld)
        {
            if (vk == 0x5B || vk == 0x5C || winHeld) return true;
            if (alt && (vk == 0x09 || vk == 0x1B || vk == 0x20 || vk == 0x73)) return true;
            if (ctrl && vk == 0x1B) return true;
            return vk == 0x2C;
        }

        IntPtr OnKey(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0)
            {
                var k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                int msg = wParam.ToInt32();
                bool down = msg == 0x0100 || msg == 0x0104, up = msg == 0x0101 || msg == 0x0105;
                int vk = (int)k.vkCode;
                bool take;
                if (up) take = swallowed.ContainsKey(vk);
                else
                {
                    bool alt = (k.flags & 0x20) != 0; // LLKHF_ALTDOWN
                    bool ctrl = (GetAsyncKeyState(0x11) & 0x8000) != 0;
                    bool win = swallowed.ContainsKey(0x5B) || swallowed.ContainsKey(0x5C);
                    take = down && Takes(vk, alt, ctrl, win);
                }
                if (take)
                {
                    string kc;
                    if (up && swallowed.TryGetValue(vk, out kc)) { swallowed.Remove(vk); SendCode(kc, false); return new IntPtr(1); }
                    kc = KeyMap.CodeOf(vk, (int)k.scanCode, (k.flags & 0x01) != 0);
                    if (kc == null && vk == 0x2C) kc = "PrintScreen";
                    if (kc != null && down) { swallowed[vk] = kc; SendCode(kc, true); return new IntPtr(1); }
                }
            }
            return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
        }

        void SendCode(string code, bool down)
        {
            var d = new Dictionary<string, object>();
            d["type"] = "remoteKey";
            d["code"] = code;
            d["down"] = down;
            Post(d);
        }

        // ------------------------------------------------------------------ closing

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            hookWanted = false;
            if (hook != IntPtr.Zero) { UnhookWindowsHookEx(hook); hook = IntPtr.Zero; }
            // The session ends with the window, whatever the page managed to say.
            var api = app.Api;
            string sid = sessionId;
            if (sid != null && api != null)
            {
                var body = new Dictionary<string, object>();
                body["reason"] = "stopped";
                Pending.Add(Task.Run(async () => { try { await api.Call(HttpMethod.Post, "/api/rc/sessions/" + sid + "/end", body, 10, CancellationToken.None); } catch { } }));
            }
            try { if (web != null) { Controls.Remove(web); web.Dispose(); } } catch { }
            web = null;
            core = null;
            base.OnFormClosed(e);
        }

        [StructLayout(LayoutKind.Sequential)]
        struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo; }
        delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
        [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    }
}
