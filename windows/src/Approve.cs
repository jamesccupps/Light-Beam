// "<Name> wants to sign in to Beam": a small topmost prompt near the tray for approving (or denying)
// a new device's sign-in request. Without a request it first asks for the code shown on the new device.
using System;
using System.Drawing;
using System.Windows.Forms;

namespace Beam
{
    class ApproveForm : Form
    {
        readonly App app;
        LoginRequest request;
        public readonly bool Automatic; // opened by a live event: don't steal the focus
        public bool Answered;
        readonly Font codeFont;
        readonly PictureBox icon;
        readonly Label2 title, where, codeLabel, code, check, status, countdown;
        readonly TextField codeField;
        readonly FlatButton find, deny, approve, close;
        readonly Timer timer = new Timer();
        DateTime armedAt;
        bool busy;
        int Pad { get { return Ui.S(20); } }
        int W { get { return Ui.S(400); } }

        public string RequestId { get { return request != null ? request.Id : null; } }

        public ApproveForm(App app, LoginRequest r, bool automatic)
        {
            this.app = app;
            request = r;
            Automatic = automatic;
            Text = "Beam sign-in request";
            Ui.StyleForm(this);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            MinimizeBox = false;
            TopMost = true;
            ShowInTaskbar = true;
            KeyPreview = true;
            StartPosition = FormStartPosition.Manual;
            codeFont = new Font("Segoe UI Semibold", 26f * Ui.Scale, GraphicsUnit.Pixel);

            icon = new PictureBox();
            icon.Image = AppIcon.Scaled(Ui.S(32));
            icon.SizeMode = PictureBoxSizeMode.Zoom;
            Controls.Add(icon);
            title = Add(new Label2("", Ui.Title, false));
            where = Add(new Label2("", Ui.Small, true));
            codeLabel = Add(new Label2("Code on the new device", Ui.SmallBold, true));
            code = Add(new Label2("", codeFont, false));
            check = Add(new Label2("Only approve if you are signing in that device yourself right now and the code matches.", Ui.Small, true));
            status = Add(new Label2("", Ui.Small, true));
            countdown = Add(new Label2("", Ui.Small, true));
            codeField = new TextField();
            codeField.BackColor = Theme.Bg;
            codeField.Box.CharacterCasing = CharacterCasing.Upper;
            codeField.Box.KeyDown += (s, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; Find(); } };
            Controls.Add(codeField);
            find = AddButton("Find", true);
            find.Click += (s, e) => Find();
            deny = AddButton("Deny", false);
            deny.DangerStyle = true;
            deny.Click += (s, e) => Answer(false);
            approve = AddButton("Approve", true);
            approve.Click += (s, e) => Answer(true);
            close = AddButton("Close", false);
            close.Click += (s, e) => Close();

            timer.Interval = 250;
            timer.Tick += (s, e) => Tick();
            Relayout();
        }

        T Add<T>(T c) where T : Control
        {
            c.BackColor = Theme.Bg;
            Controls.Add(c);
            return c;
        }

        FlatButton AddButton(string text, bool primary)
        {
            var b = new FlatButton(text, null);
            b.Primary = primary;
            b.BackColor = Theme.Bg;
            b.Size = new Size(Math.Max(Ui.S(96), b.Preferred().Width), Ui.S(36));
            Controls.Add(b);
            return b;
        }

        protected override bool ShowWithoutActivation { get { return Automatic || Ui.TestOffscreen; } }
        protected override CreateParams CreateParams { get { return Ui.TestParams(base.CreateParams); } }

        static int TextHeight(string text, Font font, int width)
        {
            return TextRenderer.MeasureText(text, font, new Size(width, int.MaxValue), Ui.Wrap).Height + Ui.S(2);
        }

        void Relayout()
        {
            int w = W - Pad * 2, y = Pad;
            bool details = request != null;
            icon.SetBounds(Pad, y + Ui.S(2), Ui.S(32), Ui.S(32));
            int tx = Pad + Ui.S(44), tw = w - Ui.S(44);
            bool move = details && request.Purpose == "move";
            title.Text = !details ? "Approve a sign-in" : move ? request.Name + " wants a full copy of this Beam" : request.Name + " wants to sign in to Beam";
            check.Text = move
                ? "This is for moving Beam to another computer: approving hands over every item, file and sign-in. Only approve if you are moving Beam there right now and the code matches."
                : "Only approve if you are signing in that device yourself right now and the code matches.";
            check.ForeColor = move ? Theme.Danger : Theme.Text2;
            int th = TextHeight(title.Text, Ui.Title, tw);
            title.SetBounds(tx, y, tw, th);
            y += Math.Max(th, Ui.S(36)) + Ui.S(4);
            where.Text = details
                ? "From " + (string.IsNullOrEmpty(request.Where) ? "an unknown address" : request.Where) + (string.IsNullOrEmpty(request.Platform) ? "" : " · " + Fmt.Platform(request.Platform)) + (string.IsNullOrEmpty(request.Who) ? "" : "\nTailscale: " + request.Who)
                : "Type the code shown on the device that is signing in.";
            int wh = TextHeight(where.Text, Ui.Small, tw);
            where.SetBounds(tx, y, tw, wh);
            y += wh + Ui.S(14);

            codeLabel.Visible = code.Visible = check.Visible = deny.Visible = approve.Visible = countdown.Visible = details;
            codeField.Visible = find.Visible = !details;
            if (details)
            {
                codeLabel.SetBounds(Pad, y, w, Ui.S(18));
                y += Ui.S(20);
                code.Text = request.Code;
                code.SetBounds(Pad, y, w, codeFont.Height + Ui.S(6));
                y += code.Height + Ui.S(6);
                int ch = TextHeight(check.Text, Ui.Small, w);
                check.SetBounds(Pad, y, w, ch);
                y += ch + Ui.S(8);
            }
            else
            {
                codeField.SetBounds(Pad, y, w - find.Width - Ui.S(8), Ui.S(36));
                find.SetBounds(Pad + w - find.Width, y, find.Width, Ui.S(36));
                y += Ui.S(44);
            }
            int sh = string.IsNullOrEmpty(status.Text) ? 0 : TextHeight(status.Text, Ui.Small, w);
            status.SetBounds(Pad, y, w, sh);
            y += sh + (sh > 0 ? Ui.S(8) : 0) + Ui.S(6);
            if (details)
            {
                approve.SetBounds(Pad + w - approve.Width, y, approve.Width, approve.Height);
                deny.SetBounds(approve.Left - Ui.S(10) - deny.Width, y, deny.Width, deny.Height);
                countdown.SetBounds(Pad, y, deny.Left - Pad - Ui.S(8), approve.Height);
                countdown.TextAlign = ContentAlignment.MiddleLeft;
                close.Visible = false;
            }
            else
            {
                close.Visible = true;
                close.SetBounds(Pad + w - close.Width, y, close.Width, close.Height);
            }
            y += Ui.S(36) + Pad;
            ClientSize = new Size(W, y);
        }

        // Bottom-right corner of the screen, above the taskbar; stacked when several are open.
        public void ShowNearTray(int index)
        {
            var wa = Screen.PrimaryScreen.WorkingArea;
            int x = wa.Right - Width - Ui.S(16);
            int y = wa.Bottom - Height - Ui.S(16) - index * Ui.S(24);
            Location = new Point(Math.Max(wa.Left, x), Math.Max(wa.Top, y));
            Ui.PlaceForTest(this);
            Show();
            if (!Automatic && !Ui.TestOffscreen) { Activate(); Native.SetForegroundWindow(Handle); }
            Arm();
        }

        void Arm()
        {
            // Buttons wake up after a moment so a click or Enter meant for something else can't approve.
            armedAt = DateTime.Now.AddMilliseconds(1200);
            approve.Enabled = deny.Enabled = false;
            timer.Start();
            Tick();
        }

        void Tick()
        {
            if (busy) return;
            if (request != null)
            {
                bool armed = DateTime.Now >= armedAt;
                approve.Enabled = deny.Enabled = armed && !Answered;
                var left = request.LocalExpiry - DateTime.Now;
                if (left <= TimeSpan.Zero && !Answered) { Close(); return; }
                if (!Answered) countdown.Text = "Expires in " + (int)left.TotalMinutes + ":" + left.Seconds.ToString("00");
            }
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            if (request == null) codeField.Box.Focus();
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Escape) Close();
            base.OnKeyDown(e);
        }

        async void Find()
        {
            string c = codeField.Text.Trim();
            if (c.Length < 4 || app.Api == null) return;
            find.Enabled = false;
            SetStatus("Looking up " + c + "…", false);
            try
            {
                var r = await app.Api.FindLogin(c);
                if (IsDisposed) return;
                if (r == null) throw new ApiException(404, "No sign-in request with that code", null);
                if (app.FocusApproval(r.Id)) { Answered = true; Close(); return; } // already asking about it
                request = r;
                SetStatus("", false);
                app.TrackApproval(this);
                Relayout();
                Arm();
            }
            catch (Exception ex)
            {
                if (IsDisposed) return;
                find.Enabled = true;
                SetStatus(Api.Describe(ex), true);
            }
        }

        async void Answer(bool yes)
        {
            if (request == null || busy || Answered || DateTime.Now < armedAt) return;
            if (yes && app.RcBlocks("approving a sign-in")) { SetStatus("Not while another device controls this PC: stop that session first.", true); return; }
            busy = true;
            approve.Enabled = deny.Enabled = false;
            SetStatus(yes ? "Approving…" : "Denying…", false);
            try
            {
                await app.Api.AnswerLogin(request.Code, yes);
                Answered = true;
                Log.Write("Sign-in request " + request.Id + " " + (yes ? "approved" : "denied") + " here");
                if (yes) app.Notify(request.Name + " is signed in", "Approved from this PC.");
                Close();
            }
            catch (Exception ex)
            {
                if (IsDisposed) return;
                busy = false;
                var api = ex as ApiException;
                if (api != null && (api.Status == 404 || api.Status == 409))
                {
                    Answered = true;
                    SetStatus(api.Message, true);
                    countdown.Text = "";
                    var t = new Timer();
                    t.Interval = 4000;
                    t.Tick += (s, e) => { t.Stop(); t.Dispose(); if (!IsDisposed) Close(); };
                    t.Start();
                    return;
                }
                approve.Enabled = deny.Enabled = true;
                SetStatus("Couldn't answer: " + Api.Describe(ex), true);
            }
        }

        // The request was settled somewhere (another device answered, or it expired).
        public void Settled(string state)
        {
            if (Answered || IsDisposed) return;
            Answered = true;
            Close();
        }

        void SetStatus(string text, bool error)
        {
            status.Text = text;
            status.ForeColor = error ? Theme.Danger : Theme.Text2;
            var loc = Location;
            int oldH = Height;
            Relayout();
            if (Visible) Location = new Point(loc.X, loc.Y - (Height - oldH));
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            timer.Stop();
            timer.Dispose();
            base.OnFormClosed(e);
            codeFont.Dispose();
        }
    }
}
