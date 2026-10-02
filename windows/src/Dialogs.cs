// Native dialogs that stay native: the "Send to…" picker (hotkey, Explorer), and a Settings window used when
// the messenger page can't show the "This PC" settings (an older server's page, or no WebView2).
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Windows.Forms;

namespace Beam
{
    class DialogBase : Form
    {
        protected int Y;
        protected int Pad { get { return Ui.S(24); } }
        protected Control Host;   // where AddLabel & co. put controls (the form, or a scrolling panel)
        protected int HostWidth;
        protected int ColX = -1, ColW = -1;
        protected int X0 { get { return ColX >= 0 ? ColX : Pad; } }
        protected int W0 { get { return ColW >= 0 ? ColW : HostWidth - Pad * 2; } }

        public DialogBase(string title, int width)
        {
            Text = title;
            Ui.StyleForm(this);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(Ui.S(width), Ui.S(200));
            KeyPreview = true;
            Host = this;
            HostWidth = ClientSize.Width;
            Y = Pad;
            Theme.Changed += OnTheme;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) Theme.Changed -= OnTheme;
            base.Dispose(disposing);
        }

        protected override bool ShowWithoutActivation { get { return Ui.TestOffscreen; } }
        protected override CreateParams CreateParams { get { return Ui.TestParams(base.CreateParams); } }

        void OnTheme(object s, EventArgs e)
        {
            BackColor = Theme.Bg;
            Theme.ApplyTitleBar(this, Theme.Bg);
            Recolor(this);
            Invalidate(true);
        }

        protected static void Recolor(Control root)
        {
            foreach (Control c in root.Controls)
            {
                var l = c as Label2;
                if (l != null) l.ApplyTheme();
                var t = c as TextField;
                if (t != null) t.ApplyTheme();
                if (c is FlatButton || c is FlatCheck || c is TextField || c is Label2 || c is Panel) c.BackColor = Theme.Bg;
                Recolor(c);
            }
        }

        protected Label2 AddLabel(string text, Font font, bool secondary, int gapAfter)
        {
            var l = new Label2(text, font, secondary);
            l.BackColor = Theme.Bg;
            var size = TextRenderer.MeasureText(text, font, new Size(W0, int.MaxValue), Ui.Wrap);
            l.SetBounds(X0, Y, W0, size.Height + Ui.S(2));
            Host.Controls.Add(l);
            Y += l.Height + gapAfter;
            return l;
        }

        protected TextField AddField(string value, int width, int gapAfter)
        {
            var f = new TextField();
            f.BackColor = Theme.Bg;
            f.Text = value ?? "";
            f.SetBounds(X0, Y, width <= 0 ? W0 : width, Ui.S(36));
            Host.Controls.Add(f);
            Y += f.Height + gapAfter;
            return f;
        }

        protected FlatCheck AddCheck(string text, string note, bool value, int indent, int gapAfter)
        {
            var c = new FlatCheck(text);
            c.BackColor = Theme.Bg;
            c.Note = note;
            c.Checked = value;
            int h = Ui.S(24);
            if (!string.IsNullOrEmpty(note))
                h = Ui.S(24) + TextRenderer.MeasureText(note, Ui.Small, new Size(W0 - indent - Ui.S(28), int.MaxValue), Ui.Wrap).Height + Ui.S(2);
            c.SetBounds(X0 + indent, Y, W0 - indent, h);
            Host.Controls.Add(c);
            Y += h + gapAfter;
            return c;
        }

        protected FlatButton Button(string text, bool primary)
        {
            var b = new FlatButton(text, null);
            b.Primary = primary;
            b.BackColor = Theme.Bg;
            b.Size = new Size(Math.Max(Ui.S(96), b.Preferred().Width), Ui.S(36));
            Host.Controls.Add(b);
            return b;
        }

        protected void Section(string title)
        {
            Y += Ui.S(6);
            AddLabel(title, Ui.SmallBold, true, Ui.S(8));
        }
    }

    class SettingsForm : DialogBase
    {
        readonly App app;
        readonly TextField name, maxMb, folder, outboxFolder;
        readonly FlatCheck autoCopy, clipHistory, autoSave, openLinks, autoOpenLinks, sendTo, outbox, autostart, autoUpdate;
        readonly FlatCheck showPhone, phoneText;  // Beam 1.5 servers only
        readonly bool phoneWas;
        readonly FlatCheck allowRc;               // Beam 1.6 servers only
        readonly bool rcWas;
        readonly Label2 updateState, serverLine;
        readonly FlatButton checkUpdates;
        readonly Panel body, footer;

        public SettingsForm(App app) : base("Beam settings", 820)
        {
            this.app = app;
            var cfg = app.Cfg;
            // Content scrolls; Save/Cancel stay visible at any size.
            body = new Panel();
            body.BackColor = Theme.Bg;
            body.AutoScroll = true;
            footer = new Panel();
            footer.BackColor = Theme.Bg;
            Controls.Add(body);
            Controls.Add(footer);
            Host = body;
            HostWidth = ClientSize.Width - SystemInformation.VerticalScrollBarWidth;

            AddLabel("Settings", Ui.Big, false, Ui.S(8));
            int top = Y;
            int gap = Ui.S(36);
            int colW = (HostWidth - Pad * 2 - gap) / 2;

            // ---- left column
            ColX = Pad;
            ColW = colW;
            Section("THIS PC");
            name = AddField(cfg.DeviceName, 0, Ui.S(10));
            var phoneOn = app.PhoneNotificationsOn;
            if (phoneOn.HasValue)
            {
                phoneWas = phoneOn.Value;
                showPhone = AddCheck("Show phone notifications", "Notifications from the apps you pick on your phone appear here; click one to reply.", phoneWas, 0, Ui.S(6));
                phoneText = AddCheck("Show message text in pop-ups", "Windows keeps pop-ups in its Notification Center until they're cleared. Off: only the app and how many; the text stays in Beam's Phone panel.", cfg.PhonePopupText, Ui.S(28), Ui.S(10));
            }
            if (app.ServerHas("remote-control"))
            {
                rcWas = cfg.AllowRemoteControl;
                string who = cfg.RemoteControlDevices.Count == 0 ? "no devices yet" : string.Join(", ", cfg.RemoteControlDevices.Select(a => a.Name));
                allowRc = AddCheck("Allow remote control", rcWas ? "Can see and control this PC: " + who + "." : "Devices you choose can see and control this PC; a banner shows while one does. Turning it on asks first.", rcWas, 0, Ui.S(6));
                if (rcWas)
                {
                    var choose = Button("Choose devices…", false);
                    choose.Location = new Point(X0 + Ui.S(28), Y);
                    choose.Click += (s, e) => app.ShowRcAllow(this);
                    Y += Ui.S(46);
                }
                else Y += Ui.S(4);
            }

            Section("RECEIVING");
            autoCopy = AddCheck("Copy received text to the clipboard", null, cfg.AutoCopy, 0, Ui.S(8));
            clipHistory = AddCheck("Keep it in clipboard history (Win+V)", "Off: received text isn't saved in clipboard history or synced by cloud clipboard.", cfg.ClipboardHistory, Ui.S(28), Ui.S(8));
            openLinks = AddCheck("Clicking a link notification opens the link", null, cfg.OpenLinks, 0, Ui.S(8));
            autoOpenLinks = AddCheck("Open links sent to this PC automatically", "A link sent to this PC (not to all devices) opens in your browser right away.", cfg.AutoOpenLinks, 0, Ui.S(8));
            autoSave = AddCheck("Save received files automatically", null, cfg.AutoSave, 0, Ui.S(8));
            int indent = Ui.S(28);
            var upTo = Row("Up to", X0 + indent, Ui.S(48));
            maxMb = new TextField();
            maxMb.BackColor = Theme.Bg;
            maxMb.Text = cfg.MaxSaveMB.ToString();
            maxMb.SetBounds(upTo.Right + Ui.S(4), Y, Ui.S(90), Ui.S(36));
            maxMb.Box.KeyPress += (s, e) => { if (!char.IsDigit(e.KeyChar) && !char.IsControl(e.KeyChar)) e.Handled = true; };
            body.Controls.Add(maxMb);
            Row("MB per file", maxMb.Right + Ui.S(8), Ui.S(120));
            Y += Ui.S(44);
            folder = FolderRow("Save to", cfg.SaveFolderPath, "saveFolder");

            Section("SENDING");
            sendTo = AddCheck("Add my devices to Explorer's Send to menu", "Right-click files › Send to › Beam › a device (on Windows 11, under Show more options).", cfg.SendToMenu, 0, Ui.S(10));
            outbox = AddCheck("Outbox folders", "Files and folders you put in \"To <device>\" are sent to that device, then moved to its Sent folder.", cfg.Outbox, 0, Ui.S(6));
            outboxFolder = FolderRow("Folder", cfg.OutboxFolderPath, "outboxFolder");
            int leftBottom = Y;

            // ---- right column
            Y = top;
            ColX = Pad + colW + gap;
            Section("WINDOWS");
            autostart = AddCheck("Start Beam when I sign in", "Beam waits in the notification area and receives in the background.", Autostart.IsEnabled(cfg), 0, Ui.S(8));
            var keys = new List<string>();
            foreach (var kv in new[] { new[] { "picker", "send the clipboard to a device" }, new[] { "lastTarget", "send it to the last device again" }, new[] { "copyLatest", "copy the latest received text" }, new[] { "screenshot", "send a screenshot" } })
            {
                string spec = cfg.Hotkeys[kv[0]];
                if (string.IsNullOrEmpty(spec)) continue;
                keys.Add(spec + ": " + kv[1] + (app.HotkeyRegistered(kv[0]) ? "" : " (taken by another app)"));
            }
            if (keys.Count > 0) AddLabel(string.Join("\n", keys), Ui.Small, true, Ui.S(10));

            Section("UPDATES");
            autoUpdate = AddCheck("Install updates automatically", "Beam " + AppVersion.Text + ". New versions come from your Beam server and install while nothing is being sent.", cfg.AutoUpdate, 0, Ui.S(8));
            checkUpdates = Button("Check for updates", false);
            checkUpdates.Size = new Size(checkUpdates.Preferred().Width, Ui.S(36));
            checkUpdates.Location = new Point(X0, Y);
            checkUpdates.Click += (s, e) =>
            {
                checkUpdates.Enabled = false;
                SetUpdateState("Checking…", false);
                app.CheckForUpdates(true, msg => { if (!IsDisposed) { checkUpdates.Enabled = true; SetUpdateState(msg, msg.StartsWith("Couldn")); } });
            };
            updateState = new Label2("", Ui.Small, true);
            updateState.BackColor = Theme.Bg;
            updateState.TextAlign = ContentAlignment.MiddleLeft;
            updateState.SetBounds(checkUpdates.Right + Ui.S(10), Y, X0 + W0 - checkUpdates.Right - Ui.S(10), Ui.S(36));
            body.Controls.Add(updateState);
            Y += Ui.S(46);

            Section("SERVER");
            serverLine = AddLabel(ServerText(), Ui.Small, true, Ui.S(8));
            var switchBtn = Button("Switch server…", false);
            switchBtn.Location = new Point(X0, Y);
            switchBtn.Click += (s, e) => { Close(); app.SwitchServerDialog(); };
            var againBtn = Button("Sign in again", false);
            againBtn.Location = new Point(switchBtn.Right + Ui.S(8), Y);
            againBtn.Click += (s, e) => { Close(); app.SignInAgain(); };
            Y += Ui.S(44);
            var signOut = Button("Sign out", false);
            signOut.DangerStyle = true;
            signOut.Location = new Point(X0, Y);
            signOut.Click += (s, e) =>
            {
                if (MessageBox.Show(this, "Sign this PC out of Beam? You can sign in again any time; your items stay on the server.", "Sign out", MessageBoxButtons.OKCancel, MessageBoxIcon.None) != DialogResult.OK) return;
                Close();
                app.Unpair();
            };
            Y += Ui.S(44);

            // ---- layout: body scrolls, footer pinned
            ColX = ColW = -1;
            int contentH = Math.Max(Y, leftBottom) + Ui.S(8);
            var save = new FlatButton("Save", null);
            save.Primary = true;
            var cancel = new FlatButton("Cancel", null);
            foreach (var b in new[] { save, cancel }) { b.BackColor = Theme.Bg; b.Size = new Size(Math.Max(Ui.S(96), b.Preferred().Width), Ui.S(36)); footer.Controls.Add(b); }
            int footerH = Ui.S(36) + Pad;
            save.SetBounds(ClientSize.Width - Pad - save.Width, Ui.S(8), save.Width, save.Height);
            cancel.SetBounds(save.Left - Ui.S(10) - cancel.Width, Ui.S(8), cancel.Width, cancel.Height);
            save.Click += (s, e) => DoSave();
            cancel.Click += (s, e) => Close();
            int max = Screen.FromPoint(Cursor.Position).WorkingArea.Height - Ui.S(80);
            int h = Math.Min(contentH + footerH, max);
            ClientSize = new Size(ClientSize.Width, h);
            footer.SetBounds(0, h - footerH, ClientSize.Width, footerH);
            body.SetBounds(0, 0, ClientSize.Width, h - footerH);
        }

        string ServerText()
        {
            var cfg = app.Cfg;
            string s = App.HostOf(cfg.Server) + (app.ServerVersion != null ? " · Beam server " + app.ServerVersion : "") + " · " + app.ConnText;
            var storage = app.ServerInfo != null ? Json.Obj(Json.Get(app.ServerInfo, "storage")) : null;
            if (storage != null)
            {
                long used = Json.Long(storage, "used", -1), free = Json.Long(storage, "free", -1);
                if (used >= 0) s += "\nStorage: " + Fmt.Size(used) + " used" + (free >= 0 ? ", " + Fmt.Size(free) + " free" : "");
            }
            return s;
        }

        Label2 Row(string text, int x, int w)
        {
            var l = new Label2(text, Ui.Font, true);
            l.BackColor = Theme.Bg;
            l.TextAlign = ContentAlignment.MiddleLeft;
            l.SetBounds(x, Y, w, Ui.S(36));
            body.Controls.Add(l);
            return l;
        }

        TextField FolderRow(string label, string value, string setting)
        {
            int indent = Ui.S(28);
            var lbl = Row(label, X0 + indent, Ui.S(60));
            var browse = Button("Browse…", false);
            browse.SetBounds(X0 + W0 - browse.Width, Y, browse.Width, browse.Height);
            var f = new TextField();
            f.BackColor = Theme.Bg;
            f.Text = value;
            f.SetBounds(lbl.Right + Ui.S(4), Y, browse.Left - Ui.S(8) - lbl.Right - Ui.S(4), Ui.S(36));
            body.Controls.Add(f);
            browse.Click += (s, e) =>
            {
                using (var dlg = new FolderBrowserDialog())
                {
                    dlg.SelectedPath = f.Text;
                    dlg.Description = setting == "outboxFolder" ? "Where should Beam keep the outbox folders?" : "Where should Beam save received files?";
                    if (dlg.ShowDialog(this) == DialogResult.OK) f.Text = dlg.SelectedPath;
                }
            };
            Y += Ui.S(46);
            return f;
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            if (!Ui.TestOffscreen) Native.SetForegroundWindow(Handle);
            app.FetchServerInfo();
        }

        void SetUpdateState(string text, bool error)
        {
            updateState.Text = text;
            updateState.ForeColor = error ? Theme.Danger : Theme.Text2;
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Escape) Close();
            base.OnKeyDown(e);
        }

        void DoSave()
        {
            var s = new Dictionary<string, object>();
            s["deviceName"] = name.Text;
            s["autoCopy"] = autoCopy.Checked;
            s["clipboardHistory"] = clipHistory.Checked;
            s["openLinks"] = openLinks.Checked;
            s["autoOpenLinks"] = autoOpenLinks.Checked;
            s["autoSave"] = autoSave.Checked;
            long mb;
            if (long.TryParse(maxMb.Text.Trim(), out mb) && mb > 0) s["maxSaveMB"] = mb;
            string def = Path.Combine(FileUtil.DownloadsFolder(), "Beam");
            s["saveFolder"] = string.Equals(folder.Text.Trim(), def, StringComparison.OrdinalIgnoreCase) ? "" : folder.Text.Trim();
            s["outboxFolder"] = outboxFolder.Text.Trim();
            s["sendToMenu"] = sendTo.Checked;
            s["outbox"] = outbox.Checked;
            s["autostart"] = autostart.Checked;
            s["autoUpdate"] = autoUpdate.Checked;
            if (showPhone != null && showPhone.Checked != phoneWas && app.PhoneFeature) s["phoneNotifications"] = showPhone.Checked;
            if (phoneText != null) s["phonePopupText"] = phoneText.Checked;
            string err = app.ApplySettings(s);
            if (err != null) { MessageBox.Show(this, err, "Beam settings", MessageBoxButtons.OK, MessageBoxIcon.None); return; }
            // Remote control: off at once; on only through its own confirmation (with the device list).
            bool rcOn = allowRc != null && allowRc.Checked && !rcWas;
            if (allowRc != null && !allowRc.Checked && rcWas) app.Rc.SetOff("Settings on this PC");
            Close();
            if (rcOn) app.ShowRcAllow(null);
        }
    }

    // Small popup listing All devices + each device. Click (or 1–9) sends to one; tick several (Ctrl+click,
    // Space) to send to all of them at once. The last choice is highlighted next time (never All devices).
    class TargetPicker : Form
    {
        readonly App app;
        readonly string title, what;
        readonly Action<List<string>> onPick;
        readonly List<string> keys = new List<string>();
        readonly HashSet<string> ticked = new HashSet<string>();
        int hot = -1, sel = 0;
        bool picked;

        int HeaderH { get { return Ui.S(62); } }
        int RowH { get { return Ui.S(44); } }
        int FooterH { get { return ticked.Count > 0 ? Ui.S(52) : Ui.S(30); } }

        public static void Show(App app, string title, string what, Action<List<string>> onPick)
        {
            var p = new TargetPicker(app, title, what, onPick);
            Ui.PlaceForTest(p);
            // Fresh online dots while it's open (the stream switches to foreground), repainted as they change.
            Action repaint = () => { if (!p.IsDisposed) p.Invalidate(); };
            app.Changed += repaint;
            p.FormClosed += (s, e) => { app.Changed -= repaint; app.LiveViewClosed(); };
            app.LiveViewOpened();
            p.Show();
            if (Ui.TestOffscreen) return;
            p.Activate();
            Native.SetForegroundWindow(p.Handle);
        }

        TargetPicker(App app, string title, string what, Action<List<string>> onPick)
        {
            this.app = app;
            this.title = title;
            this.what = what;
            this.onPick = onPick;
            AutoScaleMode = AutoScaleMode.None;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            KeyPreview = true;
            StartPosition = FormStartPosition.Manual;
            Text = "Beam";
            Icon = AppIconCache.Window;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
            keys.Add("*");
            foreach (var d in app.OtherDevices()) keys.Add(d.Id);
            // Highlight the last device used (never All devices); tick it again if it was several.
            var last = app.LastTargets();
            if (last != null && last.Count > 1) foreach (var t in last) if (keys.Contains(t)) ticked.Add(t);
            string first = last != null && last.Count > 0 ? last[0] : null;
            sel = first != null && keys.Contains(first) ? keys.IndexOf(first) : (keys.Count > 1 ? 1 : 0);
            Relayout();
        }

        void Relayout()
        {
            int w = Ui.S(320);
            int h = HeaderH + keys.Count * RowH + FooterH;
            var anchor = Visible ? Location : Cursor.Position;
            var wa = Screen.FromPoint(anchor).WorkingArea;
            int x = Visible ? Left : Math.Max(wa.Left + 8, Math.Min(anchor.X - w / 2, wa.Right - w - 8));
            int y = Visible ? Top : Math.Max(wa.Top + 8, Math.Min(anchor.Y - Ui.S(24), wa.Bottom - h - 8));
            Bounds = new Rectangle(x, Math.Min(y, wa.Bottom - Math.Min(h, wa.Height - 16) - 8), w, Math.Min(h, wa.Height - 16));
            Invalidate();
        }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = Ui.TestParams(base.CreateParams);
                cp.ClassStyle |= 0x00020000; // CS_DROPSHADOW
                return cp;
            }
        }

        protected override bool ShowWithoutActivation { get { return Ui.TestOffscreen; } }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            Theme.RoundCorners(this);
        }

        protected override void OnDeactivate(EventArgs e)
        {
            base.OnDeactivate(e);
            if (!IsDisposed && !Ui.TestOffscreen) BeginInvoke(new Action(Close));
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            base.OnFormClosed(e);
            BeginInvoke(new Action(Dispose));
        }

        void Toggle(int i)
        {
            if (i < 0 || i >= keys.Count) return;
            string k = keys[i];
            if (ticked.Contains(k)) ticked.Remove(k);
            else
            {
                if (k == "*") ticked.Clear(); else ticked.Remove("*");
                ticked.Add(k);
            }
            sel = i;
            Relayout();
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Escape) Close();
            else if (e.KeyCode == Keys.Down) { sel = (sel + 1) % keys.Count; Invalidate(); }
            else if (e.KeyCode == Keys.Up) { sel = (sel + keys.Count - 1) % keys.Count; Invalidate(); }
            else if (e.KeyCode == Keys.Space) Toggle(sel);
            else if (e.KeyCode == Keys.Enter) { if (ticked.Count > 0) PickTicked(); else Pick(sel); }
            else if (e.KeyCode >= Keys.D1 && e.KeyCode <= Keys.D9) Pick(e.KeyCode - Keys.D1);
            else if (e.KeyCode >= Keys.NumPad1 && e.KeyCode <= Keys.NumPad9) Pick(e.KeyCode - Keys.NumPad1);
            base.OnKeyDown(e);
        }

        void Finish(List<string> targets)
        {
            if (picked) return;
            picked = true;
            Close();
            app.RememberTargets(targets);
            try { onPick(targets); }
            catch (Exception ex) { Log.Error("Send", ex); }
        }

        void Pick(int i)
        {
            if (i < 0 || i >= keys.Count) return;
            Finish(keys[i] == "*" ? new List<string>() : new List<string> { keys[i] });
        }

        void PickTicked()
        {
            if (ticked.Contains("*")) { Finish(new List<string>()); return; }
            Finish(keys.Where(k => ticked.Contains(k)).ToList());
        }

        int IndexAt(Point p)
        {
            if (p.Y < HeaderH) return -1;
            int i = (p.Y - HeaderH) / RowH;
            return i >= 0 && i < keys.Count ? i : -1;
        }

        Rectangle BoxRect(Rectangle row)
        {
            int s = Ui.S(18);
            return new Rectangle(row.X + Ui.S(10), row.Y + (row.Height - s) / 2, s, s);
        }

        Rectangle SendButtonRect()
        {
            return new Rectangle(Ui.S(12), Height - FooterH + Ui.S(8), Width - Ui.S(24), Ui.S(36));
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            int i = IndexAt(e.Location);
            if (i != hot) { hot = i; if (i >= 0) sel = i; Invalidate(); }
            Cursor = i >= 0 || (ticked.Count > 0 && SendButtonRect().Contains(e.Location)) ? Cursors.Hand : Cursors.Default;
            base.OnMouseMove(e);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left) { base.OnMouseUp(e); return; }
            if (ticked.Count > 0 && SendButtonRect().Contains(e.Location)) { PickTicked(); return; }
            int i = IndexAt(e.Location);
            if (i >= 0)
            {
                var row = new Rectangle(Ui.S(6), HeaderH + i * RowH, Width - Ui.S(12), RowH - Ui.S(2));
                bool onBox = BoxRect(row).Contains(e.Location) || e.X < BoxRect(row).Right + Ui.S(6);
                if (onBox || (ModifierKeys & Keys.Control) != 0 || ticked.Count > 0) Toggle(i);
                else Pick(i);
            }
            base.OnMouseUp(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(Theme.Surface);
            using (var p = new Pen(Theme.Border)) g.DrawRectangle(p, 0, 0, Width - 1, Height - 1);
            int pad = Ui.S(16);
            Ui.Text(g, title, Ui.Bold, new Rectangle(pad, Ui.S(12), Width - pad * 2, Ui.S(20)), Theme.Text, Ui.Line);
            Ui.Text(g, what, Ui.Small, new Rectangle(pad, Ui.S(34), Width - pad * 2, Ui.S(18)), Theme.Text2, Ui.Line);
            using (var p = new Pen(Theme.Border)) g.DrawLine(p, pad, HeaderH - Ui.S(4), Width - pad, HeaderH - Ui.S(4));
            for (int i = 0; i < keys.Count; i++)
            {
                var r = new Rectangle(Ui.S(6), HeaderH + i * RowH, Width - Ui.S(12), RowH - Ui.S(2));
                if (i == sel) Ui.FillRound(g, Theme.Hover, r, Ui.S(8));
                string key = keys[i];
                var d = app.DeviceById(key);
                bool all = key == "*";
                var box = BoxRect(r);
                if (ticked.Contains(key))
                {
                    Ui.FillRound(g, Theme.Accent, box, Ui.S(4));
                    Ui.Glyph(g, Ui.GCheck, Ui.IconsSmall, box, Theme.AccentText);
                }
                else Ui.DrawRound(g, i == sel ? Theme.Text2 : Theme.Text3, box, Ui.S(4), 1f);
                var av = new Rectangle(box.Right + Ui.S(10), r.Y + (r.Height - Ui.S(30)) / 2, Ui.S(30), Ui.S(30));
                Ui.FillCircle(g, all ? Theme.Accent : Theme.Surface2, av);
                Ui.Glyph(g, all ? Ui.GPeople : Ui.PlatformGlyph(d != null ? d.Platform : null), Ui.IconFont(13), av, all ? Theme.AccentText : Theme.Text2);
                int tx = av.Right + Ui.S(10);
                bool online = d != null && d.Online;
                int dotX = r.Right - Ui.S(38);
                Ui.Text(g, app.NameOf(key), Ui.Font, new Rectangle(tx, r.Y, dotX - tx - Ui.S(10), r.Height), Theme.Text, Ui.Line);
                if (!all) Ui.FillCircle(g, online ? Theme.Online : Theme.Offline, new Rectangle(dotX, r.Y + r.Height / 2 - Ui.S(4), Ui.S(8), Ui.S(8)));
                if (i < 9) Ui.Text(g, (i + 1).ToString(), Ui.Small, new Rectangle(r.Right - Ui.S(22), r.Y, Ui.S(14), r.Height), Theme.Text3, Ui.Center);
            }
            if (ticked.Count > 0)
            {
                var b = SendButtonRect();
                Ui.FillRound(g, Theme.Accent, b, Ui.S(8));
                string label = ticked.Contains("*") ? "Send to all devices" : "Send to " + ticked.Count + (ticked.Count == 1 ? " device" : " devices");
                Ui.Text(g, label, Ui.Bold, b, Theme.AccentText, Ui.Center);
            }
            else
            {
                var hint = new Rectangle(pad, Height - FooterH, Width - pad * 2, FooterH - Ui.S(6));
                Ui.Text(g, "Ctrl+click or Space to pick several", Ui.Small, hint, Theme.Text3, Ui.Center);
            }
        }
    }
}
