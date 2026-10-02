// The banner shown while another device controls this PC (Beam 1.6): "Robin Phone (pixel-9 · 100.70.1.2) is
// controlling this PC · Stop". This PC renders it from its device list and its own Tailscale check, never from text the
// viewer sends. It sits top-most at the top centre of the screen (Windows' own sharing bar sits at the bottom), never
// takes the focus, re-asserts top-most every second, and ignores clicks for 500 ms after it appears, so a click meant
// for what was there before can't land on Stop. Closing it in any way is Stop: no banner, no session.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Beam
{
    class RcBanner : Form
    {
        public const int ClickGuardMs = 500;
        static readonly Color Back = Color.FromArgb(0xA4, 0x26, 0x2C), Fore = Color.White, StopHover = Color.FromArgb(0xF3, 0xD6, 0xD7);
        readonly App app;
        readonly string label;
        readonly Action onStop;
        readonly Stopwatch shown = new Stopwatch();
        readonly ToolTip tip;
        Rectangle stopRect;
        Point home;                                    // where it was shown
        bool hover, up, stopped;

        public RcBanner(App app, string label, Action onStop)
        {
            this.app = app;
            this.label = label + " is controlling this PC";
            this.onStop = onStop;
            Text = "Beam remote control";
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            BackColor = Back;
            DoubleBuffered = true;
            Font = Ui.Bold;
            tip = new ToolTip();
            tip.SetToolTip(this, "Stop ends the remote control at once. " + RemoteControl.KillKeys + " does too, from anywhere.");
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= 0x00000008 | 0x00000080 | 0x08000000; // WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
                return cp;
            }
        }

        // Up: shown, not closed (the session checks this every second).
        public bool Up { get { return up && !IsDisposed && Visible; } }

        public void ShowBanner(ScreenInfo screen)
        {
            int h = Ui.S(40), pad = Ui.S(16), stopW = Math.Max(Ui.S(72), Ui.Width("Stop", Ui.Bold) + Ui.S(28));
            int textW = Math.Min(Ui.Width(label, Ui.Bold), Ui.S(720));
            int w = pad + textW + Ui.S(14) + stopW + Ui.S(6);
            Size = new Size(w, h);
            stopRect = new Rectangle(w - stopW - Ui.S(6), Ui.S(6), stopW, h - Ui.S(12));
            if (Ui.TestOffscreen) Location = new Point(-20000, -20000); // tests: shown, but never on the user's screen
            else
            {
                var area = screen != null ? new Rectangle(screen.X, screen.Y, screen.W, screen.H) : Screen.PrimaryScreen.Bounds;
                var work = Screen.FromRectangle(area).WorkingArea;
                Location = new Point(area.X + (area.Width - w) / 2, Math.Max(area.Y, work.Y) + Ui.S(8));
            }
            home = Location;
            using (var path = Ui.Round(new Rectangle(0, 0, w, h), h / 2)) Region = new Region(path);
            Show();
            up = true;
            shown.Restart();
            KeepOnTop();
        }

        // Top-most again, and back where it belongs if something moved it (partly) off every screen.
        public void KeepOnTop()
        {
            if (!IsHandleCreated || IsDisposed) return;
            uint flags = 0x0001 | 0x0010 | 0x0040; // NOSIZE | NOACTIVATE | SHOWWINDOW
            var bounds = new Rectangle(Location, Size);
            bool seen = Ui.TestOffscreen || Screen.AllScreens.Any(s => s.WorkingArea.Contains(bounds));
            if (seen) flags |= 0x0002; // NOMOVE
            else
            {
                var wa = Screen.PrimaryScreen.WorkingArea; // the top centre of the primary screen as it is now
                home = new Point(wa.X + (wa.Width - Width) / 2, wa.Y + Ui.S(8));
                Log.Write("Remote control: the banner was moved off the screen; it's back at the top");
            }
            SetWindowPos(Handle, new IntPtr(-1) /* HWND_TOPMOST */, home.X, home.Y, 0, 0, flags);
        }

        public void CloseBanner()
        {
            stopped = true;
            up = false;
            if (!IsDisposed) { Close(); Dispose(); }
        }

        // Tests: a click on Stop, with the same 500 ms guard.
        public void ClickStopForTest()
        {
            ClickStop("a test click");
        }

        void ClickStop(string how)
        {
            if (stopped) return;
            long ms = shown.ElapsedMilliseconds;
            if (ms < ClickGuardMs) { Log.Write("Remote control: Stop ignored, the banner appeared " + ms + " ms ago (" + how + ")"); return; }
            stopped = true;
            app.Post(onStop); // not from inside this window's own click
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(Back);
            int pad = Ui.S(16);
            Ui.Text(g, label, Ui.Bold, new Rectangle(pad, 0, stopRect.Left - pad - Ui.S(10), Height), Fore, Ui.Line);
            Ui.FillRound(g, hover ? StopHover : Fore, stopRect, stopRect.Height / 2);
            Ui.Text(g, "Stop", Ui.Bold, stopRect, Back, Ui.Center);
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            bool h = stopRect.Contains(e.Location);
            if (h != hover) { hover = h; Cursor = h ? Cursors.Hand : Cursors.Default; Invalidate(); }
            base.OnMouseMove(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            if (hover) { hover = false; Invalidate(); }
            base.OnMouseLeave(e);
        }

        protected override void OnMouseClick(MouseEventArgs e)
        {
            base.OnMouseClick(e);
            if (e.Button == MouseButtons.Left && stopRect.Contains(e.Location)) ClickStop("a click");
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            base.OnFormClosing(e);
            if (stopped) return;
            // Closed some other way (Alt+F4 on it, a task manager): that's Stop too.
            stopped = true;
            up = false;
            app.Post(onStop);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) tip.Dispose();
            base.Dispose(disposing);
        }

        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    }
}
