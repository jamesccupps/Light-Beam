// The capture host of a remote control session (Beam 1.6, research §8.5 with the spike's findings): a WebView2 with a
// profile of its own (WebView2\RemoteHost) and the flags that let getDisplayMedia pick a screen without a picker, in a
// window that is never shown (with the controller visible, so the page isn't throttled). It runs the page embedded in
// Beam.exe (rc/rc-host.html and .js), served as https://beam-remote-control/ — the name Windows' own "… is sharing your
// screen" bar shows. The page does the WebRTC side; this class relays its messages, checked to come from it.
// Capture is allowed only through the gate (the session going on with its banner up), asked for every request
// (ScreenCaptureStarting); every other permission is denied, and the page can't navigate, open windows or download.
// One host per session (and per screen). At the end the capture stops at once and the host is kept, blank, for 2
// minutes: a reconnect to the same screen starts without a new browser process (one takes ~6 s to exit). Then it's
// closed, waiting for its browser process to exit.
// (1.11) Its picture asks every viewer to show each frame at once (WebRTC's playout delay 0, sent with every frame): the
// phone's WebView and browsers, which can't be given the Windows viewer's own flag, then hold nothing back.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

namespace Beam
{
    class RcHost
    {
        public const string HostName = "beam-remote-control";
        public const string Origin = "https://" + HostName;
        const string PageUrl = Origin + "/rc-host.html";
        static Task lastExit = Task.FromResult(0);          // the previous host's browser process: the profile takes one at a time
        static readonly List<RcHost> open = new List<RcHost>();
        static RcHost parked;                               // the last session's host, kept warm
        static System.Windows.Forms.Timer parkTimer;
        const int ParkMs = 120000;

        readonly Config cfg;
        readonly string source;                             // the screen's name for --auto-select-desktop-capture-source
        readonly bool devTools;
        Func<bool> gate;
        HostForm form;
        CoreWebView2Controller controller;
        CoreWebView2 core;
        TaskCompletionSource<bool> exited;
        Task closing;
        bool closed, ending, reused, dead;

        public event Action<RcHost, Dictionary<string, object>> Message;
        public bool Captured;
        public string RuntimeVersion;

        public RcHost(Config cfg, string source, bool devTools, Func<bool> gate)
        {
            this.cfg = cfg;
            this.source = source;
            this.devTools = devTools;
            this.gate = gate;
        }

        // A host for a session: the one kept warm from the last session when it captures the same screen (a reconnect
        // starts at once), else a new one.
        public static RcHost For(Config cfg, string source, bool devTools, Func<bool> gate)
        {
            var p = parked;
            parked = null;
            if (parkTimer != null) parkTimer.Stop();
            if (p != null && !p.closed && !p.dead && p.core != null && p.exited != null && !p.exited.Task.IsCompleted && p.source == source && p.devTools == devTools)
            {
                p.gate = gate;
                p.Captured = false;
                p.ending = false;
                p.reused = true;
                return p;
            }
            if (p != null) { var ignored = p.Close(); }
            return new RcHost(cfg, source, devTools, gate);
        }

        public bool Reused { get { return reused; } }

        public async Task Start()
        {
            if (reused) { core.Navigate(PageUrl); return; } // a fresh page in the warm host
            foreach (var other in open.ToList()) await other.Close(); // one at a time (the options differ per screen)
            open.Add(this);
            await lastExit;
            if (closed) return;
            WebHost.EnsureLoader(cfg);
            string folder = Path.Combine(cfg.WebViewFolder, "RemoteHost");
            string page = Path.Combine(folder, "page");
            Directory.CreateDirectory(page);
            WritePage(page);
            var o = new CoreWebView2EnvironmentOptions();
            // The spike's flags (plan/rd-spike-results.md): pick this screen without a picker; the blink flag is insurance
            // (capture is started with a user gesture through DevTools anyway).
            // (1.11) and WebRTC's sender field trial that puts playout delay 0 on every frame (the viewer shows it at once).
            o.AdditionalBrowserArguments = "--auto-select-desktop-capture-source=\"" + source + "\" --disable-blink-features=GetDisplayMediaRequiresUserActivation" +
                " --force-fieldtrials=WebRTC-ForceSendPlayoutDelay/min_ms:0,max_ms:0/";
            o.Language = "en-US"; // the source names are English
            o.AllowSingleSignOnUsingOSPrimaryAccount = false;
            var env = await CoreWebView2Environment.CreateAsync(null, folder, o);
            exited = new TaskCompletionSource<bool>();
            var done = exited;
            env.BrowserProcessExited += (s, e) => done.TrySetResult(true);
            RuntimeVersion = env.BrowserVersionString;
            form = new HostForm();
            IntPtr hwnd = form.Handle; // the window exists, and is never shown
            controller = await env.CreateCoreWebView2ControllerAsync(hwnd);
            if (closed) { var ignored = Close(true); return; }
            controller.Bounds = new Rectangle(0, 0, 1280, 800);
            controller.IsVisible = true; // a hidden page gets throttled timers
            core = controller.CoreWebView2;
            Configure();
            core.SetVirtualHostNameToFolderMapping(HostName, page, CoreWebView2HostResourceAccessKind.Deny);
            core.Navigate(PageUrl);
        }

        static void WritePage(string dir)
        {
            foreach (var name in new[] { "rc-host.html", "rc-host.js" })
            {
                byte[] bytes = Embedded.Resource("Beam.rc." + name);
                if (bytes == null) throw new FileNotFoundException(name + " isn't embedded in this build");
                File.WriteAllBytes(Path.Combine(dir, name), bytes);
            }
        }

        void Configure()
        {
            var st = core.Settings;
            st.AreDevToolsEnabled = devTools;
            st.AreDefaultContextMenusEnabled = false;
            st.AreDefaultScriptDialogsEnabled = false;
            st.IsStatusBarEnabled = false;
            st.IsZoomControlEnabled = false;
            st.IsBuiltInErrorPageEnabled = false;
            st.AreHostObjectsAllowed = false;
            st.IsGeneralAutofillEnabled = false;
            st.IsPasswordAutosaveEnabled = false;
            st.IsSwipeNavigationEnabled = false;
            st.AreBrowserAcceleratorKeysEnabled = false;
            st.IsWebMessageEnabled = true;
            core.NavigationStarting += (s, e) =>
            {
                if (e.Uri == PageUrl || e.Uri == "about:blank") return;
                e.Cancel = true;
                Log.Write("Remote control: the capture page tried to leave its page; refused");
            };
            core.NewWindowRequested += (s, e) => { e.Handled = true; };
            core.DownloadStarting += (s, e) => { e.Cancel = true; e.Handled = true; };
            core.LaunchingExternalUriScheme += (s, e) => { e.Cancel = true; };
            core.PermissionRequested += (s, e) => { e.State = CoreWebView2PermissionState.Deny; };
            core.ScreenCaptureStarting += OnCaptureStarting;
            core.WebMessageReceived += OnWebMessage;
            core.ProcessFailed += (s, e) =>
            {
                dead = true; // never reused
                var m = new Dictionary<string, object>();
                m["t"] = "ended";
                m["reason"] = "process " + e.ProcessFailedKind;
                Raise(m);
            };
        }

        // Every getDisplayMedia call, from any frame: allowed only from this page, while the gate holds.
        void OnCaptureStarting(object sender, CoreWebView2ScreenCaptureStartingEventArgs e)
        {
            string from = "";
            try { from = e.OriginalSourceFrameInfo != null ? e.OriginalSourceFrameInfo.Source : ""; } catch { }
            bool ours = from != null && from.StartsWith(Origin + "/", StringComparison.Ordinal);
            bool allow = !closed && !ending && ours && gate();
            e.Cancel = !allow;
            Log.Write("Remote control: a screen capture was " + (allow ? "allowed (the session is on and its banner is up)" : "refused (" + (ours ? "no live session with its banner up" : "not Beam's page") + ")"));
        }

        void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (closed || ending || e.Source == null || !e.Source.StartsWith(Origin + "/", StringComparison.Ordinal)) return;
            Dictionary<string, object> m;
            try { m = Json.ParseObject(e.WebMessageAsJson); }
            catch { return; }
            if (m == null) return;
            if (Json.Str(m, "t") == "captured") Captured = true;
            Raise(m);
        }

        void Raise(Dictionary<string, object> m)
        {
            if (closed || ending || Message == null) return;
            try { Message(this, m); }
            catch (Exception ex) { Log.Error("Remote control: a message from the capture page", ex); }
        }

        public void Post(Dictionary<string, object> m)
        {
            if (closed || ending || core == null) return;
            try { core.PostWebMessageAsJson(Json.Stringify(m)); }
            catch (Exception ex) { Log.Error("Remote control: to the capture page", ex); }
        }

        // Starts the capture with a user gesture (DevTools Runtime.evaluate), as the spike did.
        public async void StartCapture(Dictionary<string, object> config)
        {
            await Evaluate("rcStart(" + Json.Stringify(config) + ")");
        }

        // Tests: a capture attempt the gate has to refuse.
        public async void Probe()
        {
            await Evaluate("rcProbe()");
        }

        async Task Evaluate(string expression)
        {
            if (closed || core == null) return;
            var p = new Dictionary<string, object>();
            p["expression"] = expression;
            p["userGesture"] = true;
            p["awaitPromise"] = false;
            try { await core.CallDevToolsProtocolMethodAsync("Runtime.evaluate", Json.Stringify(p)); }
            catch (Exception ex) { Log.Error("Remote control: starting the capture", ex); }
        }

        // The session is over: the page says bye to the viewer and stops the capture at once; half a second later (time
        // for the bye to go out) the host is parked. Nothing from the page counts any more.
        public Task End(string reason)
        {
            if (closed || ending) return closing ?? Task.FromResult(0);
            ending = true;
            var m = new Dictionary<string, object>();
            m["t"] = "end";
            m["reason"] = reason;
            try { if (core != null) core.PostWebMessageAsJson(Json.Stringify(m)); } catch { }
            return Task.Delay(500).ContinueWith(t => Park(), TaskScheduler.FromCurrentSynchronizationContext());
        }

        // After a session: nothing of it is left (a blank page; the gate refuses everything; nobody hears it), and the
        // host waits 2 minutes for the next session.
        void Park()
        {
            if (closed) return;
            Message = null;
            gate = () => false;
            try { if (core != null) core.Navigate("about:blank"); } catch { }
            var old = parked;
            parked = this;
            if (old != null && old != this) { var ignored = old.Close(); }
            if (parkTimer == null)
            {
                parkTimer = new System.Windows.Forms.Timer();
                parkTimer.Interval = ParkMs;
                parkTimer.Tick += (s, e) => { parkTimer.Stop(); var p = parked; parked = null; if (p != null) { var ignored = p.Close(); } };
            }
            parkTimer.Stop();
            parkTimer.Start();
            Log.Write("Remote control: capture stopped (its host is kept 2 minutes for a reconnect)");
        }

        public Task Close() { return Close(false); }

        // Closes the web view and waits (at most 8 s) for its browser process to exit: the next host needs the folder.
        Task Close(bool force)
        {
            if (closed && !force) return closing ?? Task.FromResult(0);
            closed = true;
            open.Remove(this);
            if (parked == this) parked = null;
            var wait = exited != null ? (Task)exited.Task : Task.FromResult(0);
            var done = exited;
            closing = Task.WhenAny(wait, Task.Delay(8000)).ContinueWith(t =>
            {
                if (done != null) Log.Write("Remote control: capture host closed" + (done.Task.IsCompleted ? "" : " (its browser process was still running 8 s later)"));
            });
            lastExit = closing;
            try { if (controller != null) controller.Close(); } catch (Exception ex) { Log.Error("Remote control: closing the capture host", ex); }
            controller = null;
            core = null;
            try { if (form != null) form.Dispose(); } catch { }
            form = null;
            return closing;
        }

        public static void CloseAll()
        {
            foreach (var h in open.ToList()) { var ignored = h.Close(); }
        }

        // Never shown: it only gives the web view a window.
        class HostForm : Form
        {
            public HostForm()
            {
                FormBorderStyle = FormBorderStyle.None;
                ShowInTaskbar = false;
                StartPosition = FormStartPosition.Manual;
                Location = new Point(-32000, -32000);
                Size = new Size(1280, 800);
                Text = "Beam remote control";
            }

            protected override bool ShowWithoutActivation { get { return true; } }

            protected override CreateParams CreateParams
            {
                get
                {
                    var cp = base.CreateParams;
                    cp.ExStyle |= 0x08000000 | 0x00000080; // WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW
                    return cp;
                }
            }
        }
    }
}
