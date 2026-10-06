// The keyboard-and-mouse links' page (Beam 1.12, KvmController): a WebView2 with a profile of its own (WebView2\Kvm),
// in a window that is never shown (with the controller visible, so the page's timers aren't throttled), running the page
// embedded in Beam.exe (rc/kvm-link.html and .js) as https://beam-kvm/. The page does the WebRTC side of every link;
// this class relays its messages, checked to come from it. Every permission is denied (it needs none: no capture, no
// camera, no microphone), and the page can't navigate, open windows or download. One page for all the links, while
// keyboard and mouse across PCs is on.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

namespace Beam
{
    class KvmPage
    {
        public const string HostName = "beam-kvm";
        public const string Origin = "https://" + HostName;
        const string PageUrl = Origin + "/kvm-link.html";

        readonly Config cfg;
        readonly bool devTools;
        PageForm form;
        CoreWebView2Controller controller;
        CoreWebView2 core;
        bool closed;

        public event Action<Dictionary<string, object>> Message;
        public bool Ready;                 // the page said so: messages to it arrive
        public string RuntimeVersion;
        // (1.12.4) Messages posted before then (the PCs are asked at once, while the page still loads), sent in order then.
        readonly List<string> waiting = new List<string>();

        public KvmPage(Config cfg, bool devTools)
        {
            this.cfg = cfg;
            this.devTools = devTools;
        }

        public async Task Start()
        {
            WebHost.EnsureLoader(cfg);
            string folder = Path.Combine(cfg.WebViewFolder, "Kvm");
            string page = Path.Combine(folder, "page");
            Directory.CreateDirectory(page);
            foreach (var name in new[] { "kvm-link.html", "kvm-link.js" })
            {
                byte[] bytes = Embedded.Resource("Beam.rc." + name);
                if (bytes == null) throw new FileNotFoundException(name + " isn't embedded in this build");
                File.WriteAllBytes(Path.Combine(page, name), bytes);
            }
            var o = new CoreWebView2EnvironmentOptions();
            o.Language = "en-US";
            o.AllowSingleSignOnUsingOSPrimaryAccount = false;
            var env = await CoreWebView2Environment.CreateAsync(null, folder, o);
            if (closed) return;
            RuntimeVersion = env.BrowserVersionString;
            form = new PageForm();
            IntPtr hwnd = form.Handle; // the window exists, and is never shown
            controller = await env.CreateCoreWebView2ControllerAsync(hwnd);
            if (closed) { Close(); return; }
            controller.Bounds = new Rectangle(0, 0, 320, 200);
            controller.IsVisible = true; // a hidden page gets throttled timers (its pings)
            core = controller.CoreWebView2;
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
                Log.Write("Keyboard and mouse: the link page tried to leave its page; refused");
            };
            core.NewWindowRequested += (s, e) => { e.Handled = true; };
            core.DownloadStarting += (s, e) => { e.Cancel = true; e.Handled = true; };
            core.LaunchingExternalUriScheme += (s, e) => { e.Cancel = true; };
            core.PermissionRequested += (s, e) => { e.State = CoreWebView2PermissionState.Deny; };
            core.ScreenCaptureStarting += (s, e) => { e.Cancel = true; };
            core.WebMessageReceived += OnWebMessage;
            core.ProcessFailed += (s, e) =>
            {
                Ready = false;
                var m = new Dictionary<string, object>();
                m["t"] = "failed";
                m["why"] = e.ProcessFailedKind.ToString();
                Raise(m);
            };
            core.SetVirtualHostNameToFolderMapping(HostName, page, CoreWebView2HostResourceAccessKind.Deny);
            core.Navigate(PageUrl);
        }

        void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (closed || e.Source == null || !e.Source.StartsWith(Origin + "/", StringComparison.Ordinal)) return;
            Dictionary<string, object> m;
            try { m = Json.ParseObject(e.WebMessageAsJson); }
            catch { return; }
            if (m == null) return;
            if (Json.Str(m, "t") == "ready")
            {
                Ready = true;
                foreach (var json in waiting) Send(json);
                waiting.Clear();
            }
            Raise(m);
        }

        void Raise(Dictionary<string, object> m)
        {
            if (closed || Message == null) return;
            try { Message(m); }
            catch (Exception ex) { Log.Error("Keyboard and mouse: a message from the link page", ex); }
        }

        public void Post(Dictionary<string, object> m)
        {
            if (closed) return;
            string json = Json.Stringify(m);
            if (!Ready || core == null) { if (waiting.Count < 4000) waiting.Add(json); return; }
            Send(json);
        }

        void Send(string json)
        {
            try { if (core != null) core.PostWebMessageAsJson(json); }
            catch (Exception ex) { Log.Error("Keyboard and mouse: to the link page", ex); }
        }

        public void Close()
        {
            if (closed && core == null) return;
            closed = true;
            Ready = false;
            Message = null;
            try { if (controller != null) controller.Close(); } catch (Exception ex) { Log.Error("Keyboard and mouse: closing the link page", ex); }
            controller = null;
            core = null;
            try { if (form != null) form.Dispose(); } catch { }
            form = null;
        }

        // Never shown: it only gives the web view a window.
        class PageForm : Form
        {
            public PageForm()
            {
                FormBorderStyle = FormBorderStyle.None;
                ShowInTaskbar = false;
                StartPosition = FormStartPosition.Manual;
                Location = new Point(-32000, -32000);
                Size = new Size(320, 200);
                Text = "Beam keyboard and mouse";
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
