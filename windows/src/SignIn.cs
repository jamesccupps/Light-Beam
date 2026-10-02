// Signing in: finds the server by itself, then tries Tailscale sign-in (no steps at all), and otherwise shows a
// QR code + short code to approve from a signed-in device (like Steam), a password, or a pairing link.
// Also used to sign in again after the key was revoked, and to switch to another Beam server.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Beam
{
    enum PairMode { First, Again, Switch }

    // A row of text tabs with an accent underline under the selected one.
    class TabStrip : Owner
    {
        public readonly List<string> Tabs = new List<string>();
        int selected;
        readonly List<Rectangle> rects = new List<Rectangle>();
        public event Action<int> Changed;

        public int Selected
        {
            get { return selected; }
            set
            {
                if (selected == value) return;
                selected = value;
                Invalidate();
                if (Changed != null) Changed(value);
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(BackColor);
            using (var p = new Pen(Theme.Border)) g.DrawLine(p, 0, Height - 1, Width, Height - 1);
            rects.Clear();
            int x = 0;
            for (int i = 0; i < Tabs.Count; i++)
            {
                var font = i == selected ? Ui.Bold : Ui.Font;
                int w = Ui.Width(Tabs[i], Ui.Bold) + Ui.S(4);
                var r = new Rectangle(x, 0, w, Height - Ui.S(3));
                rects.Add(r);
                Ui.Text(g, Tabs[i], font, r, i == selected ? Theme.Text : Theme.Text2, Ui.Line);
                if (i == selected) Ui.FillRound(g, Theme.Accent, new Rectangle(x, Height - Ui.S(3), w, Ui.S(3)), Ui.S(1));
                x += w + Ui.S(20);
            }
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            Cursor = rects.Any(r => r.Contains(e.Location)) ? Cursors.Hand : Cursors.Default;
            base.OnMouseMove(e);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            for (int i = 0; i < rects.Count; i++) if (rects[i].Contains(e.Location)) Selected = i;
            base.OnMouseUp(e);
        }
    }

    class PairForm : DialogBase
    {
        const int TabPhone = 0, TabPassword = 1, TabLink = 2;
        readonly App app;
        readonly PairMode mode;
        string server; // the Beam we sign in to, e.g. https://robin-desktop.tail1234.ts.net
        List<FoundServer> found = new List<FoundServer>();
        bool searching, choosing, typingAddress, finishing, autopairing;
        readonly CancellationTokenSource life = new CancellationTokenSource();
        CancellationTokenSource request;
        DateTime requestExpiry;
        // The sign-in request this window has out: withdrawn when it's replaced or no longer needed.
        string reqId, reqSecret, reqServer;
        string autopairYou;
        readonly System.Windows.Forms.Timer tick = new System.Windows.Forms.Timer();

        readonly Label2 serverLabel;
        readonly Spinner serverSpinner;
        readonly FlatButton changeServer, connect;
        readonly TextField address;
        readonly List<FlatButton> choices = new List<FlatButton>();
        readonly Label2 nameLabel;
        readonly TextField name;
        readonly TabStrip tabs;
        readonly Panel phonePanel, passwordPanel, linkPanel;
        readonly Panel qrFrame;
        readonly QrView qr;
        readonly Label2 code, phoneHint, phoneStatus;
        readonly FlatButton tryAgain;
        readonly TextField password, link;
        readonly FlatButton signIn, pair;
        readonly Label2 passwordStatus, linkStatus;
        readonly FlatButton cancel;
        readonly PictureBox icon;
        readonly Label2 title, subtitle;
        readonly Font codeFont;
        bool tryAgainShown; // Visible is false until the window is shown, so layout keeps its own flag

        public PairForm(App app, PairMode mode) : base(mode == PairMode.Again ? "Sign in to Beam again" : mode == PairMode.Switch ? "Switch Beam server" : "Sign in to Beam", 480)
        {
            this.app = app;
            this.mode = mode;
            AutoScroll = true;
            codeFont = new Font(HasFont("Segoe UI Variable Display Semib") ? "Segoe UI Variable Display Semib" : "Segoe UI Semibold", 26f * Ui.Scale, GraphicsUnit.Pixel);

            icon = new PictureBox();
            icon.Image = AppIcon.Scaled(Ui.S(32));
            icon.SizeMode = PictureBoxSizeMode.Zoom;
            icon.BackColor = Color.Transparent;
            Controls.Add(icon);
            title = MakeLabel(this, Text, Ui.Big, false);
            subtitle = MakeLabel(this, mode == PairMode.Again ? "This PC's sign-in was revoked or replaced. Sign in again; this PC keeps its name and history." : "", Ui.Small, true);

            serverSpinner = new Spinner();
            serverSpinner.Size = new Size(Ui.S(18), Ui.S(18));
            serverSpinner.BackColor = Theme.Bg;
            Controls.Add(serverSpinner);
            serverLabel = MakeLabel(this, "Looking for your Beam server…", Ui.Font, true);
            changeServer = MakeButton(this, "Change", false);
            changeServer.Quiet = true;
            changeServer.Click += (s, e) => { typingAddress = true; choosing = false; Relayout(); address.Box.Focus(); };
            address = new TextField();
            address.BackColor = Theme.Bg;
            address.Box.KeyDown += (s, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; ConnectTyped(); } };
            Controls.Add(address);
            connect = MakeButton(this, "Connect", false);
            connect.Click += (s, e) => ConnectTyped();

            nameLabel = MakeLabel(this, "Name for this PC", Ui.SmallBold, true);
            name = new TextField();
            name.BackColor = Theme.Bg;
            name.Text = app.Cfg.DeviceName;
            Controls.Add(name);

            tabs = new TabStrip();
            tabs.BackColor = Theme.Bg;
            tabs.Tabs.Add("Approve with another device");
            tabs.Tabs.Add("Password");
            tabs.Tabs.Add("Pairing link");
            tabs.Changed += i => ShowTab();
            Controls.Add(tabs);

            // Phone: QR code of the approval link, the short code, and live status.
            phonePanel = MakePanel();
            qrFrame = new Panel();
            qrFrame.BackColor = Color.White; // QR codes need a light background, even in dark mode
            qr = new QrView();
            qr.Dock = DockStyle.Fill;
            qr.Placeholder = "";
            qrFrame.Controls.Add(qr);
            phonePanel.Controls.Add(qrFrame);
            code = MakeLabel(phonePanel, "", codeFont, false);
            code.TextAlign = ContentAlignment.MiddleCenter;
            phoneHint = MakeLabel(phonePanel, "Scan it with your phone's camera or the Beam app, or type the code in Beam on a signed-in device. Signed-in devices also ask by themselves.", Ui.Small, true);
            phoneHint.TextAlign = ContentAlignment.TopCenter;
            phoneStatus = MakeLabel(phonePanel, "", Ui.Small, true);
            phoneStatus.TextAlign = ContentAlignment.TopCenter;
            tryAgain = MakeButton(phonePanel, "Try again", true);
            tryAgain.Visible = tryAgainShown = false;
            tryAgain.Click += (s, e) => StartRequest();

            // Password
            passwordPanel = MakePanel();
            MakeLabel(passwordPanel, "Sign-in password", Ui.SmallBold, true).SetBounds(0, 0, ContentWidth, Ui.S(20));
            password = new TextField();
            password.BackColor = Theme.Bg;
            password.Box.UseSystemPasswordChar = true;
            password.Box.KeyDown += (s, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; DoPassword(); } };
            passwordPanel.Controls.Add(password);
            signIn = MakeButton(passwordPanel, "Sign in", true);
            signIn.Click += (s, e) => DoPassword();
            passwordStatus = MakeLabel(passwordPanel, "The password is set in Beam's settings on a device that's already signed in. You can also paste a pairing link here.", Ui.Small, true);

            // Pairing link
            linkPanel = MakePanel();
            MakeLabel(linkPanel, "Pairing link", Ui.SmallBold, true).SetBounds(0, 0, ContentWidth, Ui.S(20));
            link = new TextField();
            link.BackColor = Theme.Bg;
            link.Box.KeyDown += (s, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; DoLink(); } };
            linkPanel.Controls.Add(link);
            pair = MakeButton(linkPanel, "Pair", true);
            pair.Click += (s, e) => DoLink();
            linkStatus = MakeLabel(linkPanel, "On a signed-in device, open Beam, choose Add a device and copy the link. It looks like https://your-server/?key=…", Ui.Small, true);

            cancel = Button("Cancel", false);
            cancel.Click += (s, e) => Close();

            tick.Interval = 1000;
            tick.Tick += (s, e) => UpdateCountdown();

            if (mode == PairMode.Again && app.Cfg.Server != null) server = app.Cfg.Server;
            else
            {
                string clip = ClipboardLink();
                if (clip.Length > 0)
                {
                    link.Text = clip;
                    link.Box.SelectionStart = 0;
                    tabs.Selected = TabLink;
                }
            }
            Relayout();
        }

        int ContentWidth { get { return ClientSize.Width - Pad * 2; } }

        static bool HasFont(string n)
        {
            try { using (var f = new Font(n, 10f)) return string.Equals(f.Name, n, StringComparison.OrdinalIgnoreCase); }
            catch { return false; }
        }

        Panel MakePanel()
        {
            var p = new Panel();
            p.BackColor = Theme.Bg;
            Controls.Add(p);
            return p;
        }

        static Label2 MakeLabel(Control parent, string text, Font font, bool secondary)
        {
            var l = new Label2(text, font, secondary);
            l.BackColor = Theme.Bg;
            parent.Controls.Add(l);
            return l;
        }

        static FlatButton MakeButton(Control parent, string text, bool primary)
        {
            var b = new FlatButton(text, null);
            b.Primary = primary;
            b.BackColor = Theme.Bg;
            b.Size = new Size(Math.Max(Ui.S(96), b.Preferred().Width), Ui.S(36));
            parent.Controls.Add(b);
            return b;
        }

        static int TextHeight(string text, Font font, int width)
        {
            return TextRenderer.MeasureText(text.Length == 0 ? " " : text, font, new Size(width, int.MaxValue), Ui.Wrap).Height + Ui.S(2);
        }

        // ------------------------------------------------------------------ layout (compact: fits 150% on 1080p)

        void Relayout()
        {
            SuspendLayout();
            int w = ContentWidth, y = Pad;
            icon.SetBounds(Pad, y, Ui.S(32), Ui.S(32));
            title.SetBounds(Pad + Ui.S(44), y, w - Ui.S(44), Ui.S(32));
            y += Ui.S(40);
            bool hasSubtitle = subtitle.Text.Length > 0;
            subtitle.Visible = hasSubtitle;
            if (hasSubtitle)
            {
                int sh = TextHeight(subtitle.Text, Ui.Small, w);
                subtitle.SetBounds(Pad, y, w, sh);
                y += sh + Ui.S(6);
            }

            // Server
            bool showAddress = typingAddress || (!searching && !choosing && !autopairing && server == null);
            bool showChange = server != null && !typingAddress && !choosing && !autopairing && !finishing;
            changeServer.Visible = showChange;
            bool busy = searching || autopairing;
            serverSpinner.Visible = busy;
            serverSpinner.Spinning = busy;
            int sx = busy ? Pad + Ui.S(26) : Pad;
            int labelW = (showChange ? w - changeServer.Width - Ui.S(8) : w) - (sx - Pad);
            serverLabel.Text = ServerText();
            int lh = Math.Max(Ui.S(28), TextHeight(serverLabel.Text, Ui.Font, labelW));
            serverSpinner.Location = new Point(Pad, y + (Ui.S(28) - serverSpinner.Height) / 2);
            serverLabel.TextAlign = lh <= Ui.S(28) ? ContentAlignment.MiddleLeft : ContentAlignment.TopLeft;
            serverLabel.SetBounds(sx, y, labelW, lh);
            changeServer.SetBounds(Pad + w - changeServer.Width, y + (lh - Ui.S(36)) / 2, changeServer.Width, Ui.S(36));
            y += lh + Ui.S(6);
            foreach (var b in choices) { Controls.Remove(b); b.Dispose(); }
            choices.Clear();
            if (choosing)
            {
                foreach (var f in found)
                {
                    var fs = f;
                    var b = new FlatButton(f.Label + "   ·   " + f.Host, Ui.PlatformGlyph("windows"));
                    b.BackColor = Theme.Bg;
                    b.SetBounds(Pad, y, w, Ui.S(38));
                    b.Click += (s, e) => { choosing = false; typingAddress = false; ChooseServer(fs.Url); };
                    Controls.Add(b);
                    choices.Add(b);
                    y += Ui.S(44);
                }
            }
            address.Visible = connect.Visible = showAddress;
            if (showAddress)
            {
                address.SetBounds(Pad, y, w - connect.Width - Ui.S(8), Ui.S(36));
                connect.SetBounds(Pad + w - connect.Width, y, connect.Width, Ui.S(36));
                y += Ui.S(44);
            }
            y += Ui.S(4);

            nameLabel.SetBounds(Pad, y, w, Ui.S(18));
            y += Ui.S(20);
            name.SetBounds(Pad, y, w, Ui.S(34));
            y += Ui.S(46);

            tabs.SetBounds(Pad, y, w, Ui.S(32));
            y += Ui.S(42);

            // Panels share one area; the phone panel only takes room once there is a code to show.
            int panelTop = y;
            bool haveServer = server != null && !autopairing;
            qrFrame.Visible = code.Visible = phoneHint.Visible = haveServer;
            if (server == null && !searching && !autopairing) SetPhoneStatus(choosing ? "Choose your Beam above to get a sign-in code." : "Enter your Beam server's address above to get a sign-in code.", false);
            if (searching || autopairing) SetPhoneStatus("", false);
            int ph = LayoutPhone(w, haveServer);
            phonePanel.SetBounds(Pad, panelTop, w, ph);
            int pw = LayoutForm(passwordPanel, password, signIn, passwordStatus, w);
            passwordPanel.SetBounds(Pad, panelTop, w, pw);
            int lk = LayoutForm(linkPanel, link, pair, linkStatus, w);
            linkPanel.SetBounds(Pad, panelTop, w, lk);
            int panelH = tabs.Selected == TabPhone ? ph : tabs.Selected == TabPassword ? pw : lk;
            y = panelTop + panelH + Ui.S(12);

            cancel.SetBounds(Pad + w - cancel.Width, y, cancel.Width, cancel.Height);
            int h = y + cancel.Height + Pad;
            int max = Screen.FromPoint(Cursor.Position).WorkingArea.Height - Ui.S(60);
            ClientSize = new Size(ClientSize.Width, Math.Min(h, max));
            ShowTab();
            ResumeLayout();
        }

        int LayoutPhone(int w, bool haveServer)
        {
            int y = 0;
            if (haveServer)
            {
                int size = Ui.S(184);
                qrFrame.SetBounds((w - size) / 2, 0, size, size);
                y = size + Ui.S(8);
                code.SetBounds(0, y, w, codeFont.Height + Ui.S(4));
                y += code.Height + Ui.S(2);
                int hh = TextHeight(phoneHint.Text, Ui.Small, w - Ui.S(20));
                phoneHint.SetBounds(Ui.S(10), y, w - Ui.S(20), hh);
                y += hh + Ui.S(4);
            }
            int sh = TextHeight(phoneStatus.Text, Ui.Small, w);
            phoneStatus.SetBounds(0, y, w, sh);
            y += sh;
            if (tryAgainShown)
            {
                tryAgain.SetBounds((w - tryAgain.Width) / 2, y + Ui.S(6), tryAgain.Width, tryAgain.Height);
                y += Ui.S(6) + tryAgain.Height;
            }
            return y;
        }

        static int LayoutForm(Panel panel, TextField field, FlatButton button, Label2 status, int w)
        {
            field.SetBounds(0, Ui.S(24), w - button.Width - Ui.S(8), Ui.S(36));
            button.SetBounds(w - button.Width, Ui.S(24), button.Width, Ui.S(36));
            int sh = TextHeight(status.Text, Ui.Small, w);
            status.SetBounds(0, Ui.S(68), w, sh);
            return Ui.S(68) + sh;
        }

        void ShowTab()
        {
            phonePanel.Visible = tabs.Selected == TabPhone;
            passwordPanel.Visible = tabs.Selected == TabPassword;
            linkPanel.Visible = tabs.Selected == TabLink;
            if (Visible && tabs.Selected == TabPassword) password.Box.Focus();
            if (Visible && tabs.Selected == TabLink) link.Box.Focus();
            if (tabs.Selected == TabPhone && server != null && request == null && !finishing && !autopairing && !tryAgainShown) StartRequest();
        }

        string ServerText()
        {
            if (searching) return "Looking for your Beam server…";
            if (autopairing) return "Signing in with Tailscale…";
            if (choosing) return "Found " + found.Count + " Beam servers. Which one is yours?";
            if (typingAddress || server == null)
                return found.Count == 0 && !typingAddress
                    ? "Couldn't find a Beam server by itself. Type its address (for example your-pc.tailnet.ts.net):"
                    : "Beam server address:";
            return "Beam server: " + App.HostOf(server);
        }

        // ------------------------------------------------------------------ finding the server

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            if (!Ui.TestOffscreen) Native.SetForegroundWindow(Handle);
            if (tabs.Selected == TabLink) link.Box.Focus();
            if (mode == PairMode.Again && server != null) ChooseServer(server);
            else Discover();
        }

        async void Discover()
        {
            searching = true;
            Relayout();
            List<FoundServer> list;
            try { list = await Discovery.FindAll(life.Token); }
            catch (Exception ex) { Log.Error("Discovery", ex); list = new List<FoundServer>(); }
            if (IsDisposed) return;
            searching = false;
            found = list;
            if (server != null) { Relayout(); return; } // the user typed one meanwhile
            if (list.Count == 1) ChooseServer(list[0].Url);
            else
            {
                choosing = list.Count > 1;
                Relayout();
                if (!choosing) address.Box.Focus();
            }
        }

        async void ConnectTyped()
        {
            string url = Api.NormalizeBase(address.Text);
            if (url == null)
            {
                serverLabel.Text = "That doesn't look like an address. Try something like your-pc.tailnet.ts.net";
                serverLabel.ForeColor = Theme.Danger;
                return;
            }
            connect.Enabled = false;
            serverLabel.Text = "Checking " + App.HostOf(url) + "…";
            serverLabel.ForeColor = Theme.Text2;
            try
            {
                var hello = await Api.Hello(url, 8, life.Token);
                string moved = Json.Str(hello, "movedTo");
                if (!string.IsNullOrEmpty(moved)) url = Api.NormalizeBase(moved) ?? url;
                typingAddress = false;
                ChooseServer(url);
            }
            catch (Exception ex)
            {
                if (IsDisposed) return;
                serverLabel.Text = "No Beam server answered at " + App.HostOf(url) + " (" + Api.Describe(ex) + ").";
                serverLabel.ForeColor = Theme.Danger;
            }
            finally { if (!IsDisposed) connect.Enabled = true; }
        }

        // A server was chosen: first try signing in by Tailscale identity (no steps), then the usual ways.
        async void ChooseServer(string url)
        {
            server = url;
            serverLabel.ForeColor = Theme.Text2;
            StopRequest(true);
            autopairing = true;
            Relayout();
            try
            {
                var d = await Api.Autopair(url, app.Cfg.DeviceId, DeviceName(), life.Token);
                string key = Json.Str(d, "key");
                if (!string.IsNullOrEmpty(key))
                {
                    autopairing = false;
                    Log.Write("Signed in by Tailscale identity at " + url);
                    autopairYou = Json.Str(d, "you");
                    Finish(url, Json.Str(d, "server"), key, "tailscale");
                    return;
                }
            }
            catch (Exception ex)
            {
                if (IsDisposed || life.IsCancellationRequested) return;
                var api = ex as ApiException;
                Log.Write("Tailscale sign-in at " + App.HostOf(url) + " not possible (" + (api != null ? api.Status + " " + api.Message : Api.Describe(ex)) + ")");
            }
            if (IsDisposed) return;
            autopairing = false;
            Relayout(); // on the phone tab this already asks for a code (ShowTab)
            if (tabs.Selected == TabPhone && request == null) StartRequest();
            else if (tabs.Selected == TabPassword) password.Box.Focus();
        }

        // ------------------------------------------------------------------ approve with another device

        void StopRequest(bool withdraw)
        {
            if (request != null) request.Cancel();
            request = null;
            tick.Stop();
            if (withdraw && reqId != null)
            {
                string id = reqId, secret = reqSecret, srv = reqServer;
                reqId = reqSecret = reqServer = null;
                Pending.Add(Api.WithdrawLogin(srv, id, secret));
            }
        }

        async void StartRequest()
        {
            StopRequest(true);
            if (server == null || finishing) return;
            var cts = CancellationTokenSource.CreateLinkedTokenSource(life.Token);
            request = cts;
            var token = cts.Token;
            string baseUrl = server;
            qr.Code = null;
            code.Text = "";
            tryAgain.Visible = tryAgainShown = false;
            SetPhoneStatus("Asking " + App.HostOf(baseUrl) + " for a sign-in code…", false);
            Dictionary<string, object> created = null;
            while (!token.IsCancellationRequested && created == null)
            {
                int wait = 0;
                try
                {
                    var body = new Dictionary<string, object>();
                    body["name"] = DeviceName();
                    body["platform"] = "windows";
                    body["deviceId"] = app.Cfg.DeviceId;
                    // Not cancelled midway: a request the server has already created must be taken back (below),
                    // not left behind to ask the other devices.
                    created = await Api.Anon(HttpMethod.Post, baseUrl + "/api/login-requests", body, 20, CancellationToken.None, null);
                }
                catch (Exception ex)
                {
                    if (token.IsCancellationRequested || IsDisposed) return;
                    var api = ex as ApiException;
                    SetPhoneStatus("Couldn't get a sign-in code: " + Api.Describe(ex) + (api != null && api.Status == 429 ? "" : ". Retrying…"), true);
                    wait = api != null && api.Status == 429 ? 60000 : 4000;
                }
                if (wait > 0)
                {
                    try { await Task.Delay(wait, token); } catch { return; }
                }
            }
            string id = Json.Str(created, "id");
            string secret = Json.Str(created, "secret");
            if (token.IsCancellationRequested || IsDisposed)
            {
                // Replaced or closed while the server was creating it.
                if (created != null && id != null && secret != null) Pending.Add(Api.WithdrawLogin(baseUrl, id, secret));
                return;
            }
            reqId = id;
            reqSecret = secret;
            reqServer = baseUrl;
            string approveUrl = Json.Str(created, "approveUrl") ?? "";
            code.Text = Json.Str(created, "code") ?? "";
            try { qr.Code = QrCode.Encode(approveUrl, QrEcc.M, -1); }
            catch (Exception ex) { Log.Error("QR", ex); }
            long lifetime = Json.Long(created, "expiresAt", 0) - Fmt.NowMs();
            requestExpiry = DateTime.Now.AddMilliseconds(Math.Max(60000, Math.Min(lifetime, 10 * 60000)));
            tick.Start();
            UpdateCountdown();
            Relayout();
            Log.Write("Sign-in request " + id + " created on " + baseUrl);

            // Long-poll until someone answers; each poll returns within about 20 s.
            while (!token.IsCancellationRequested)
            {
                Dictionary<string, object> state = null;
                bool retry = false;
                try
                {
                    state = await Api.Anon(HttpMethod.Get, baseUrl + "/api/login-requests/" + id + "?wait", null, 45, token, secret);
                }
                catch (Exception ex)
                {
                    if (token.IsCancellationRequested || IsDisposed) return;
                    var api = ex as ApiException;
                    if (api != null && api.Status == 404) { reqId = null; StartRequest(); return; } // gone (expired or server restarted)
                    SetPhoneStatus("Can't reach the server (" + Api.Describe(ex) + "), still trying…", true);
                    retry = true;
                }
                if (retry)
                {
                    try { await Task.Delay(3000, token); } catch { return; }
                    continue;
                }
                if (token.IsCancellationRequested || IsDisposed) return;
                string status = Json.Str(state, "status");
                if (status == "approved")
                {
                    reqId = null; // used up: nothing to withdraw
                    tick.Stop();
                    string by = Json.Str(state, "approvedBy");
                    SetPhoneStatus("Approved" + (string.IsNullOrEmpty(by) ? "" : " on " + by) + ". Signing in…", false);
                    Finish(baseUrl, Json.Str(state, "server"), Json.Str(state, "key"), "approval");
                    return;
                }
                if (status == "denied")
                {
                    reqId = null;
                    tick.Stop();
                    request = null;
                    qr.Code = null;
                    SetPhoneStatus("The sign-in was denied on your other device.", true);
                    tryAgain.Visible = tryAgainShown = true;
                    Relayout();
                    return;
                }
                if (status == "expired" || status == "withdrawn")
                {
                    reqId = null;
                    StartRequest(); // show a fresh code
                    return;
                }
                UpdateCountdown();
            }
        }

        void UpdateCountdown()
        {
            if (request == null || finishing) return;
            var left = requestExpiry - DateTime.Now;
            if (left < TimeSpan.Zero) left = TimeSpan.Zero;
            SetPhoneStatus("Waiting for approval · a new code in " + (int)left.TotalMinutes + ":" + left.Seconds.ToString("00"), false);
        }

        void SetPhoneStatus(string text, bool error)
        {
            if (IsDisposed) return;
            phoneStatus.Text = text;
            phoneStatus.ForeColor = error ? Theme.Danger : Theme.Text2;
        }

        // ------------------------------------------------------------------ password and pairing link

        async void DoPassword()
        {
            if (finishing) return;
            if (server == null)
            {
                passwordStatus.Text = "Choose your Beam server above first.";
                passwordStatus.ForeColor = Theme.Danger;
                return;
            }
            string secret = password.Text;
            if (secret.Trim().Length == 0) { password.Box.Focus(); return; }
            signIn.Enabled = false;
            passwordStatus.Text = "Signing in…";
            passwordStatus.ForeColor = Theme.Text2;
            string baseUrl = server;
            try
            {
                var body = new Dictionary<string, object>();
                body["secret"] = secret;
                body["client"] = "app";
                body["deviceId"] = app.Cfg.DeviceId;
                var d = await Api.Anon(HttpMethod.Post, baseUrl + "/api/login", body, 20, life.Token, null);
                string key = Json.Str(d, "key");
                if (string.IsNullOrEmpty(key)) throw new ApiException(0, "The server didn't send a key back", d);
                Finish(baseUrl, Json.Str(d, "server"), key, "password");
            }
            catch (Exception ex)
            {
                if (IsDisposed) return;
                signIn.Enabled = true;
                passwordStatus.Text = Api.Describe(ex);
                passwordStatus.ForeColor = Theme.Danger;
                password.Box.SelectAll();
                password.Box.Focus();
            }
        }

        async void DoLink()
        {
            if (finishing) return;
            string srv, key;
            if (!Api.ParseLink(link.Text, out srv, out key))
            {
                linkStatus.Text = "That doesn't look like a pairing link. It looks like https://your-server/?key=…";
                linkStatus.ForeColor = Theme.Danger;
                link.Box.Focus();
                return;
            }
            pair.Enabled = false;
            linkStatus.Text = "Checking the link…";
            linkStatus.ForeColor = Theme.Text2;
            try
            {
                app.Cfg.DeviceName = DeviceName();
                await new Api(srv, key, app.Cfg).Me();
                Finish(srv, null, key, "link");
            }
            catch (Exception ex)
            {
                if (IsDisposed) return;
                pair.Enabled = true;
                var api = ex as ApiException;
                linkStatus.Text = api != null && api.Status == 401 ? "The server rejected that key. Copy a fresh pairing link and try again." : "Couldn't pair: " + Api.Describe(ex);
                linkStatus.ForeColor = Theme.Danger;
            }
        }

        // ------------------------------------------------------------------ finishing

        string DeviceName()
        {
            string n = name.Text.Trim();
            if (n.Length == 0) n = Config.DefaultName();
            return n.Length > 40 ? n.Substring(0, 40) : n;
        }

        // Signed in: keep the address the server calls itself if it works from here, else the one we used.
        async void Finish(string used, string announced, string key, string via)
        {
            if (finishing) return;
            finishing = true;
            StopRequest(true);
            string n = DeviceName();
            app.Cfg.DeviceName = n;
            string chosen = used;
            string serverId = null;
            if (!string.IsNullOrEmpty(announced) && !Discovery.SameUrl(announced, used))
            {
                try
                {
                    var alt = Api.NormalizeBase(announced);
                    if (alt != null)
                    {
                        await new Api(alt, key, app.Cfg).Me();
                        chosen = alt;
                    }
                }
                catch (Exception ex) { Log.Write("Sign-in: " + announced + " isn't reachable from here (" + Api.Describe(ex) + "), keeping " + used); }
            }
            try
            {
                var hello = await Api.Hello(chosen, 10, CancellationToken.None);
                serverId = Json.Str(hello, "serverId");
            }
            catch (Exception ex) { Log.Error("Sign-in: hello", ex); }
            if (IsDisposed) return;
            app.Paired(chosen, key, n, serverId, via, autopairYou);
            Close();
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Escape) Close();
            base.OnKeyDown(e);
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            // Closing the window takes back an unanswered sign-in request, so nobody keeps getting asked.
            StopRequest(true);
            life.Cancel();
            tick.Stop();
            codeFont.Dispose();
            base.OnFormClosed(e);
        }

        static string ClipboardLink()
        {
            if (ClipPayload.IsolatedDir != null) return "";
            try
            {
                if (!Clipboard.ContainsText()) return "";
                string t = Clipboard.GetText().Trim();
                string s, k;
                return t.Length < 2000 && Api.ParseLink(t, out s, out k) ? t : "";
            }
            catch { return ""; }
        }
    }
}
