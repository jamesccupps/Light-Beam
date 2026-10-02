// "Allow remote control" (Beam 1.6): the native confirmation that turns it on, listing the devices that may control
// this PC (all ticked but this PC and session-only sign-ins), and later the same list to change which ones may. Only
// this window turns remote control on or adds a device to the list: never the page, the server or another device.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace Beam
{
    class RcAllowForm : DialogBase
    {
        readonly App app;
        readonly bool turningOn;
        readonly List<KeyValuePair<string, FlatCheck>> checks = new List<KeyValuePair<string, FlatCheck>>();
        readonly Panel body, footer;

        public RcAllowForm(App app, bool turningOn) : base(turningOn ? "Allow remote control" : "Remote control devices", 560)
        {
            this.app = app;
            this.turningOn = turningOn;
            body = new Panel();
            body.BackColor = Theme.Bg;
            body.AutoScroll = true;
            footer = new Panel();
            footer.BackColor = Theme.Bg;
            Controls.Add(body);
            Controls.Add(footer);
            Host = body;
            HostWidth = ClientSize.Width - SystemInformation.VerticalScrollBarWidth;

            AddLabel(turningOn ? "Allow remote control of this PC?" : "Who may control this PC", Ui.Title, false, Ui.S(10));
            AddLabel("The devices ticked below can see this PC's screen and use its mouse and keyboard, without asking each time, " +
                "over Tailscale. While one does, a red banner at the top of the screen says which, with Stop; " + RemoteControl.KillKeys +
                " stops it too. A locked PC can't be controlled. You can turn this off here, or from any of your devices.", Ui.Font, true, Ui.S(14));
            Section("DEVICES THAT MAY CONTROL THIS PC");
            var listed = app.Cfg.RemoteControlDevices;
            var devices = app.Devices.Where(d => d.Id != app.Me && !d.Temporary).OrderBy(d => d.Name, StringComparer.CurrentCultureIgnoreCase).ToList();
            foreach (var d in devices)
            {
                var entry = listed.FirstOrDefault(a => a.Id == d.Id);
                bool tick = turningOn || entry != null;
                string machine = entry != null && entry.Machine != null ? "on " + entry.Machine + " (pinned)" : d.TailscaleName != null ? "on " + d.TailscaleName : "no Tailscale address yet";
                var c = AddCheck(d.Name, Platform(d.Platform) + " · " + machine, tick, 0, Ui.S(6));
                checks.Add(new KeyValuePair<string, FlatCheck>(d.Id, c));
            }
            if (devices.Count == 0) AddLabel("No other devices yet.", Ui.Font, true, Ui.S(8));
            Y += Ui.S(6);
            AddLabel("Only tick devices you trust. Beam in another Windows account on the same PC counts as a different device.", Ui.Font, false, Ui.S(8));
            AddLabel("Devices added later can't control this PC until they're ticked here. Each one is tied to the Tailscale " +
                "machine it's on when it's ticked: on another machine, it has to be ticked again.", Ui.Small, true, Ui.S(8));

            int contentH = Y + Ui.S(8);
            var ok = new FlatButton(turningOn ? "Allow remote control" : "Save", null);
            ok.Primary = true;
            var cancel = new FlatButton("Cancel", null);
            var buttons = new List<FlatButton> { ok, cancel };
            FlatButton off = null;
            if (!turningOn)
            {
                off = new FlatButton("Turn remote control off", null);
                off.DangerStyle = true;
                buttons.Add(off);
            }
            foreach (var b in buttons) { b.BackColor = Theme.Bg; b.Size = new Size(Math.Max(Ui.S(96), b.Preferred().Width), Ui.S(36)); footer.Controls.Add(b); }
            int footerH = Ui.S(36) + Pad;
            ok.SetBounds(ClientSize.Width - Pad - ok.Width, Ui.S(8), ok.Width, ok.Height);
            cancel.SetBounds(ok.Left - Ui.S(10) - cancel.Width, Ui.S(8), cancel.Width, cancel.Height);
            if (off != null) off.SetBounds(Pad, Ui.S(8), off.Width, off.Height);
            ok.Click += (s, e) => Confirm();
            cancel.Click += (s, e) => Close();
            if (off != null) off.Click += (s, e) => { app.Rc.SetOff("Settings on this PC"); Close(); };
            int max = Screen.FromPoint(Cursor.Position).WorkingArea.Height - Ui.S(80);
            int h = Math.Min(contentH + footerH, max);
            ClientSize = new Size(ClientSize.Width, h);
            footer.SetBounds(0, h - footerH, ClientSize.Width, footerH);
            body.SetBounds(0, 0, ClientSize.Width, h - footerH);
            AcceptButton = null;
        }

        static string Platform(string p)
        {
            switch (p)
            {
                case "windows": return "Windows";
                case "android": return "Android";
                case "ios": return "iPhone";
                case "mac": return "Mac";
                case "linux": return "Linux";
                case "web": return "Browser";
                case "cli": return "Command line";
                default: return "Device";
            }
        }

        void Confirm()
        {
            var ids = checks.Where(kv => kv.Value.Checked).Select(kv => kv.Key).ToList();
            if (turningOn) app.Rc.Allow(ids, "the confirmation on this PC");
            else app.Rc.SetDevices(ids, null, "Settings on this PC");
            Close();
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            if (!Ui.TestOffscreen) Native.SetForegroundWindow(Handle);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Escape) Close();
            base.OnKeyDown(e);
        }
    }
}
