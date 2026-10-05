// The banner shown while another device controls this PC (Beam 1.6): "Robin Phone (pixel-9 · 100.70.1.2) is
// controlling this PC · Stop". This PC renders it from its device list and its own Tailscale check, never from text the
// viewer sends. It appears at the top centre of the screen (Windows' own sharing bar sits at the bottom), never takes
// the focus, re-asserts top-most every second, and ignores clicks for 500 ms after it appears, so a click meant for
// what was there before can't land on Stop. Closing it in any way is Stop: no banner, no session.
// Beam 1.7.4 (the user: it covered the browser's tabs): it can be dragged anywhere (never off a screen) and starts where
// it was put last time; a double-click puts it back at the top. After 5 s it shrinks to a small "Beam · Stop" pill
// that grows back under the mouse. Stop stays where it is through all of that. RcBannerPlace has the geometry.
// Beam 1.12, a kvm session (another device's own keyboard and mouse, all day): "Robin Laptop's keyboard and mouse ·
// Hide · Stop". Hide folds it into Beam's icon in the taskbar corner (the user: "make the banner able to be hidden"),
// whose menu then shows the session (Show the banner, Back, Stop); folded, it still counts as up.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Beam
{
    class RcBanner : Form
    {
        public const int ClickGuardMs = 500, ShrinkAfterMs = 5000, ShrinkAgainMs = 1500, GrowAfterMs = 400;
        const string Short = "Beam";
        static readonly Color Back = Color.FromArgb(0xA4, 0x26, 0x2C), Fore = Color.White, StopHover = Color.FromArgb(0xF3, 0xD6, 0xD7);
        readonly App app;
        readonly string label;
        readonly Action onStop, onHide;               // onHide: a kvm session's banner only
        readonly Stopwatch shown = new Stopwatch();
        readonly ToolTip tip;
        readonly Timer shrink = new Timer(), grow = new Timer();
        Rectangle stopRect, hideRect;                  // hideRect: empty unless a kvm banner shows it whole
        Size full, pill;
        int stopW, hideW;
        Point home;                                    // where it belongs (KeepOnTop puts it back there)
        Point grab, downAt;                            // a drag: where the pointer holds it, where the press was
        bool hover, hoverHide, up, stopped, compact, dragging, moved, downOnStop, downOnHide, folded;

        public RcBanner(App app, string label, Action onStop) : this(app, label, onStop, null, null) { }

        // kvmViewer: a kvm session's viewer (its name), whose banner says "<name>'s keyboard and mouse" and can be hidden.
        public RcBanner(App app, string label, Action onStop, string kvmViewer, Action onHide)
        {
            this.app = app;
            this.label = kvmViewer != null ? kvmViewer + "'s keyboard and mouse" : label + " is controlling this PC";
            this.onStop = onStop;
            this.onHide = kvmViewer != null ? onHide : null;
            Text = "Beam remote control";
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            BackColor = Back;
            DoubleBuffered = true;
            Font = Ui.Bold;
            tip = new ToolTip();
            tip.ShowAlways = true; // (it's never the active window)
            tip.SetToolTip(this, this.onHide != null
                ? label + " can use this PC: its pointer comes over from its own screen. Hide puts this banner away (Beam's menu in the taskbar corner shows it again). Stop ends it at once; " + RemoteControl.KillKeys + " does too, from anywhere."
                : this.label + ". Drag it anywhere; a double-click puts it back at the top. Stop ends the remote control at once. " + RemoteControl.KillKeys + " does too, from anywhere.");
            shrink.Tick += (s, e) => ShrinkNow();
            // The pill grows only when the mouse stays on it: one passing over on its way to a tab leaves it small.
            grow.Interval = GrowAfterMs;
            grow.Tick += (s, e) => { grow.Stop(); if (!dragging && !stopped && !IsDisposed && Bounds.Contains(Cursor.Position)) Grow(); };
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

        // Up: shown (or a kvm banner folded into the tray), not closed (the session checks this every second).
        public bool Up { get { return up && !IsDisposed && (Visible || folded); } }

        // On the screen (not folded away).
        public bool IsShown { get { return up && !IsDisposed && !folded && Visible; } }

        // Every screen's working area. Tests: one made-up screen far off the real ones, so the banner is shown and can be
        // moved but never appears on the user's screen.
        static List<BannerArea> Areas()
        {
            if (Ui.TestOffscreen) return new List<BannerArea> { new BannerArea("test", new Rectangle(-20000, -20000, 1600, 900), true) };
            return Screen.AllScreens.Select(s => new BannerArea(s.DeviceName, s.WorkingArea, s.Primary)).ToList();
        }

        Rectangle StopIn(Size size)
        {
            return new Rectangle(size.Width - stopW - Ui.S(6), Ui.S(6), stopW, size.Height - Ui.S(12));
        }

        // A kvm banner's Hide, just left of Stop, while it shows whole.
        Rectangle HideIn(Size size, Rectangle stop)
        {
            return onHide == null || size != full ? Rectangle.Empty : new Rectangle(stop.X - hideW - Ui.S(6), stop.Y, hideW, stop.Height);
        }

        // foldedNow: a kvm banner its PC chose to keep folded into the tray (it's up, not on the screen).
        public void ShowBanner(ScreenInfo screen, bool foldedNow = false)
        {
            int h = Ui.S(40), pad = Ui.S(16);
            stopW = Math.Max(Ui.S(72), Ui.Width("Stop", Ui.Bold) + Ui.S(28));
            hideW = onHide != null ? Math.Max(Ui.S(64), Ui.Width("Hide", Ui.Bold) + Ui.S(24)) : 0;
            var areas = Areas();
            int narrowest = areas.Count > 0 ? areas.Min(a => a.Work.Width) - Ui.S(16) : int.MaxValue; // (it must fit on any screen)
            int textW = Math.Min(Ui.Width(label, Ui.Bold), Ui.S(720));
            int buttons = stopW + Ui.S(6) + (hideW > 0 ? hideW + Ui.S(6) : 0);
            full = new Size(Math.Max(Ui.S(200), Math.Min(narrowest, pad + textW + Ui.S(14) + buttons)), h);
            pill = new Size(pad + Ui.S(16) + Ui.Width(Short, Ui.Bold) + Ui.S(14) + stopW + Ui.S(6), h);
            Size = full;
            stopRect = StopIn(full);
            hideRect = HideIn(full, stopRect);
            var stopCentre = new Point(stopRect.X + stopRect.Width / 2, stopRect.Y + stopRect.Height / 2);
            Point? saved = RcBannerPlace.FromSpot(app.Cfg.RcBannerSpot, full, stopCentre, areas);
            if (saved != null) Location = saved.Value;
            else
            {
                // The top centre of the screen asked for (the primary one), as before 1.7.4.
                BannerArea target = null;
                if (screen != null) target = RcBannerPlace.AreaOf(new Rectangle(screen.X, screen.Y, screen.W, screen.H), areas);
                Location = RcBannerPlace.TopCentre(full, target ?? RcBannerPlace.PrimaryOf(areas), Ui.S(8));
            }
            home = Location;
            SetShape();
            up = true;
            shown.Restart(); // (the click guard counts from the start, folded or not)
            folded = foldedNow && onHide != null;
            if (folded) { Log.Write("Remote control: the banner is folded into the tray (as chosen at this PC)"); return; }
            Show();
            ShrinkLater(ShrinkAfterMs);
            KeepOnTop();
            Log.Write("Remote control: the banner is " + (saved != null ? "where it was put last time" : "at the top centre"));
        }

        // A kvm banner: on the screen again (whole, then the pill after a while), or folded into the tray.
        public void SetShown(bool show)
        {
            if (IsDisposed || stopped || onHide == null || show == !folded) return;
            folded = !show;
            if (!show) { shrink.Stop(); grow.Stop(); Hide(); return; }
            if (compact) SetCompact(false);
            Show();
            shown.Restart(); // (the click guard again: it appears under the pointer)
            ShrinkLater(ShrinkAfterMs);
            KeepOnTop();
        }

        void SetShape()
        {
            using (var path = Ui.Round(new Rectangle(Point.Empty, Size), Height / 2)) Region = new Region(path);
        }

        // Top-most again, and back at the top if something moved it (partly) off every screen. (Folded: nothing.)
        public void KeepOnTop()
        {
            if (!IsHandleCreated || IsDisposed || folded) return;
            uint flags = 0x0001 | 0x0010 | 0x0040; // NOSIZE | NOACTIVATE | SHOWWINDOW
            var areas = Areas();
            if (dragging || RcBannerPlace.OnScreen(Bounds, areas)) flags |= 0x0002; // NOMOVE
            else
            {
                home = RcBannerPlace.TopCentre(Size, RcBannerPlace.PrimaryOf(areas), Ui.S(8)); // the primary screen as it is now
                Log.Write("Remote control: the banner was moved off the screen; it's back at the top");
            }
            SetWindowPos(Handle, new IntPtr(-1) /* HWND_TOPMOST */, home.X, home.Y, 0, 0, flags);
        }

        public void CloseBanner()
        {
            stopped = true;
            up = false;
            shrink.Stop();
            grow.Stop();
            if (!IsDisposed) { Close(); Dispose(); }
        }

        // ------------------------------------------------------------------ Stop and Hide

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

        void ClickHide(string how)
        {
            if (stopped || folded || onHide == null) return;
            long ms = shown.ElapsedMilliseconds;
            if (ms < ClickGuardMs) { Log.Write("Remote control: Hide ignored, the banner appeared " + ms + " ms ago (" + how + ")"); return; }
            app.Post(onHide);
        }

        // ------------------------------------------------------------------ the pill

        // The whole banner or the pill; the right end (Stop) stays where it is. (Hide shows on the whole banner only.)
        void SetCompact(bool on)
        {
            if (on == compact || IsDisposed) return;
            compact = on;
            var size = on ? pill : full;
            var at = RcBannerPlace.Resize(Bounds, size.Width, Areas());
            Bounds = new Rectangle(at, size);
            stopRect = StopIn(size);
            hideRect = HideIn(size, stopRect);
            SetShape();
            home = Location;
            Invalidate();
        }

        void ShrinkLater(int ms)
        {
            shrink.Stop();
            shrink.Interval = ms;
            shrink.Start();
        }

        void ShrinkNow()
        {
            shrink.Stop();
            if (IsDisposed || stopped || dragging || folded) return;
            if (!Ui.TestOffscreen && Bounds.Contains(Cursor.Position)) { ShrinkLater(ShrinkAgainMs); return; } // still under the mouse
            SetCompact(true);
        }

        void Grow()
        {
            shrink.Stop();
            grow.Stop();
            SetCompact(false);
        }

        // ------------------------------------------------------------------ moving it

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left) return;
            moved = false; // (a click on Stop after a drag is a click)
            grow.Stop();
            downOnStop = stopRect.Contains(e.Location);
            downOnHide = !downOnStop && hideRect.Contains(e.Location);
            if (downOnStop || downOnHide) return;
            dragging = true;
            downAt = Cursor.Position;
            grab = new Point(downAt.X - Left, downAt.Y - Top);
            shrink.Stop();
            Capture = true;
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            if (dragging)
            {
                var p = Cursor.Position;
                var slop = SystemInformation.DragSize;
                if (!moved && (Math.Abs(p.X - downAt.X) > slop.Width / 2 || Math.Abs(p.Y - downAt.Y) > slop.Height / 2)) moved = true;
                if (moved) DragTo(p);
            }
            else
            {
                shrink.Stop();
                if (compact && !grow.Enabled) grow.Start();
                var at = PointToClient(Cursor.Position);
                bool h = stopRect.Contains(at), hh = hideRect.Contains(at); // (where they are now, if it just grew)
                if (h != hover || hh != hoverHide) { hover = h; hoverHide = hh; Cursor = h || hh ? Cursors.Hand : Cursors.Default; Invalidate(); }
            }
            base.OnMouseMove(e);
        }

        void DragTo(Point pointer)
        {
            var at = RcBannerPlace.DragTo(new Rectangle(pointer.X - grab.X, pointer.Y - grab.Y, Width, Height), pointer, Areas());
            if (at != Location) Location = at;
            home = Location;
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (e.Button != MouseButtons.Left) return;
            EndDrag();
            Capture = false;
        }

        // The mouse taken away mid-drag (another window took the capture): it stays where it got to.
        protected override void OnMouseCaptureChanged(EventArgs e)
        {
            base.OnMouseCaptureChanged(e);
            if (!Capture) EndDrag();
        }

        void EndDrag()
        {
            if (!dragging) return;
            dragging = false;
            if (moved) Remember("a drag");
            if (!Bounds.Contains(Cursor.Position)) ShrinkLater(ShrinkAgainMs); // (let go off it: at a screen edge)
        }

        protected override void OnMouseClick(MouseEventArgs e)
        {
            base.OnMouseClick(e);
            // Pressed and let go on Stop: a drag that ends over Stop (at a screen edge) isn't a click on it.
            if (e.Button == MouseButtons.Left && downOnStop && !moved && stopRect.Contains(e.Location)) ClickStop("a click");
            else if (e.Button == MouseButtons.Left && downOnHide && !moved && hideRect.Contains(e.Location)) ClickHide("a click");
        }

        protected override void OnMouseDoubleClick(MouseEventArgs e)
        {
            base.OnMouseDoubleClick(e);
            if (e.Button == MouseButtons.Left && !stopRect.Contains(e.Location) && !hideRect.Contains(e.Location)) BackToTop("a double-click");
        }

        // Where Stop is now, kept for the next session.
        void Remember(string how)
        {
            var stop = new Point(Left + stopRect.X + stopRect.Width / 2, Top + stopRect.Y + stopRect.Height / 2);
            app.Cfg.RcBannerSpot = RcBannerPlace.Spot(stop, Areas());
            app.Cfg.Save();
            Log.Write("Remote control: the banner was moved (" + how + "); it starts there next time");
        }

        void BackToTop(string how)
        {
            dragging = false;
            Location = RcBannerPlace.TopCentre(Size, RcBannerPlace.PrimaryOf(Areas()), Ui.S(8));
            home = Location;
            app.Cfg.RcBannerSpot = null;
            app.Cfg.Save();
            Log.Write("Remote control: the banner is back at the top (" + how + ")");
            ShrinkLater(ShrinkAgainMs); // (it moved away from under the mouse)
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            grow.Stop();
            if (hover || hoverHide) { hover = hoverHide = false; Invalidate(); }
            if (!dragging) ShrinkLater(ShrinkAgainMs);
            base.OnMouseLeave(e);
        }

        // ------------------------------------------------------------------ tests (--test-rc banner:…; nothing real is clicked)

        public void TestCommand(string arg)
        {
            string cmd = arg ?? "info", rest = null;
            int colon = cmd.IndexOf(':');
            if (colon > 0) { rest = cmd.Substring(colon + 1); cmd = cmd.Substring(0, colon); }
            var area = RcBannerPlace.PrimaryOf(Areas()).Work;
            Point? p = null;
            if (rest != null)
            {
                // x,y of the (made-up) screen, never far from it: a test can't put the banner on the user's screen.
                var xy = rest.Split(',');
                int x, y;
                if (xy.Length == 2 && int.TryParse(xy[0], out x) && int.TryParse(xy[1], out y) && Math.Abs(x) <= 5000 && Math.Abs(y) <= 5000)
                    p = new Point(area.X + x, area.Y + y);
            }
            if ((cmd == "drag" || cmd == "jump") && (p == null || !Ui.TestOffscreen)) { Log.Write("Remote control: (test) banner " + cmd + " needs x,y in a test instance"); return; }
            switch (cmd)
            {
                case "drag": // the pointer takes it by its label and lets go at x,y of the screen
                    grab = new Point(Ui.S(16), Height / 2);
                    dragging = moved = true;
                    DragTo(p.Value);
                    dragging = false;
                    Remember("a test drag");
                    break;
                case "jump": Location = p.Value; break; // something else moved it (KeepOnTop's next round puts it back)
                case "hover": if (rest == "off") ShrinkLater(ShrinkAgainMs); else Grow(); break;
                case "top": BackToTop("a test double-click"); break;
                case "hide": ClickHide("a test click"); break; // (1.12, a kvm banner: as a click on Hide, guard and all)
            }
            Log.Write("Remote control: (test) banner " + (folded ? "folded" : compact ? "pill" : "full") + " at " + (Left - area.X) + "," + (Top - area.Y) + " size " + Width + "x" + Height
                + " of " + area.Width + "x" + area.Height + ", spot " + (app.Cfg.RcBannerSpot ?? "none") + (onHide != null ? ", hide " + (hideRect.IsEmpty ? "no" : "yes") : ""));
        }

        // ------------------------------------------------------------------ drawing

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(Back);
            int pad = Ui.S(16);
            if (compact)
            {
                int dot = Ui.S(8);
                Ui.FillCircle(g, Fore, new Rectangle(pad, (Height - dot) / 2, dot, dot));
                Ui.Text(g, Short, Ui.Bold, new Rectangle(pad + Ui.S(16), 0, stopRect.Left - pad - Ui.S(16) - Ui.S(6), Height), Fore, Ui.Line);
            }
            else
            {
                int right = hideRect.IsEmpty ? stopRect.Left : hideRect.Left;
                Ui.Text(g, label, Ui.Bold, new Rectangle(pad, 0, right - pad - Ui.S(10), Height), Fore, Ui.Line);
            }
            if (!hideRect.IsEmpty)
            {
                // Hide: quieter than Stop (an outline), the same shape.
                var smooth = g.SmoothingMode;
                g.SmoothingMode = SmoothingMode.AntiAlias;
                using (var pen = new Pen(hoverHide ? StopHover : Fore, Math.Max(1, Ui.S(1))))
                using (var path = Ui.Round(new Rectangle(hideRect.X, hideRect.Y, hideRect.Width - 1, hideRect.Height - 1), hideRect.Height / 2))
                    g.DrawPath(pen, path);
                g.SmoothingMode = smooth;
                Ui.Text(g, "Hide", Ui.Bold, hideRect, hoverHide ? StopHover : Fore, Ui.Center);
            }
            Ui.FillRound(g, hover ? StopHover : Fore, stopRect, stopRect.Height / 2);
            Ui.Text(g, "Stop", Ui.Bold, stopRect, Back, Ui.Center);
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
            if (disposing) { shrink.Dispose(); grow.Dispose(); tip.Dispose(); }
            base.Dispose(disposing);
        }

        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    }
}
