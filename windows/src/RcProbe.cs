// (Windows 1.12.6) The viewer measuring the delay end to end (the user, on what makes Parsec fast: "yeah do 1 and 2"): a
// square in the top left corner of the screen this PC shares, on top of everything, that turns from magenta to green
// and back for each probe the viewer sends the way its input comes (`in`); the viewer watches its picture for the change.
// This PC answers how long each took from arriving here to being on its screen (painted, then DwmFlush: composed).
// The square has a thread of its own (nothing here waits for the UI thread or the page's), takes no clicks, never takes
// the focus, and goes when the viewer is done, after 20 s without a probe, at the session's end or a switch of screens.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace Beam
{
    class RcProbe
    {
        public const int Size = 32;
        const int IdleMs = 20000;
        static readonly Color Magenta = Color.FromArgb(255, 0, 255), Green = Color.FromArgb(0, 255, 0);
        Control marshal;           // its thread
        Square square;             // (its thread's)
        bool green;
        long last = Stopwatch.GetTimestamp();
        volatile bool closed;

        // The square at the top left corner of a screen (physical pixels); `shown` once it's on the screen.
        public static RcProbe Start(Point corner, Action<double> shown)
        {
            var p = new RcProbe();
            long from = Stopwatch.GetTimestamp();
            var ready = new ManualResetEventSlim();
            var t = new Thread(() =>
            {
                p.marshal = new Control();
                GC.KeepAlive(p.marshal.Handle);
                p.square = new Square(new Rectangle(corner.X, corner.Y, Size, Size), Magenta);
                var idle = new System.Windows.Forms.Timer();
                idle.Interval = 1000;
                idle.Tick += (s, e) => { if (Ms(p.last) > IdleMs) p.Close(); };
                idle.Start();
                ready.Set();
                p.square.Show();
                p.square.Refresh();
                DwmFlush();
                shown(Ms(from));
                Application.Run();
                idle.Dispose();
            });
            t.SetApartmentState(ApartmentState.STA);
            t.IsBackground = true;
            t.Name = "Beam delay probe";
            t.Start();
            ready.Wait(2000);
            return p;
        }

        static double Ms(long since) { return (Stopwatch.GetTimestamp() - since) * 1000.0 / Stopwatch.Frequency; }

        // The other colour, at once; `done` gets it (green or not) and the time from `arrived` (a Stopwatch timestamp)
        // to the change being on the screen.
        public void Flip(long arrived, Action<bool, double> done)
        {
            last = Stopwatch.GetTimestamp();
            Run(() =>
            {
                green = !green;
                square.BackColor = green ? Green : Magenta;
                square.Refresh();
                DwmFlush();
                done(green, Ms(arrived));
            });
        }

        public bool IsGreen { get { return green; } }

        public void Close()
        {
            if (closed) return;
            closed = true;
            Run(() =>
            {
                square.Close();
                square.Dispose();
                Application.ExitThread();
            });
        }

        void Run(Action a)
        {
            var m = marshal;
            if (m == null) return;
            try
            {
                m.BeginInvoke(new Action(() =>
                {
                    try { a(); }
                    catch (Exception ex) { Log.Error("Remote control: the delay probe", ex); }
                }));
            }
            catch (Exception ex) { Log.Error("Remote control: the delay probe", ex); }
        }

        // The square: topmost, click-through (layered and transparent to the mouse), no focus, not in the taskbar.
        sealed class Square : Form
        {
            public Square(Rectangle at, Color color)
            {
                FormBorderStyle = FormBorderStyle.None;
                ShowInTaskbar = false;
                StartPosition = FormStartPosition.Manual;
                Bounds = at;
                BackColor = color;
                TopMost = true;
            }

            protected override bool ShowWithoutActivation { get { return true; } }

            protected override CreateParams CreateParams
            {
                get
                {
                    var cp = base.CreateParams;
                    cp.ExStyle |= 0x00000080 /* TOOLWINDOW */ | 0x08000000 /* NOACTIVATE */ | 0x00000008 /* TOPMOST */ | 0x00080000 /* LAYERED */ | 0x00000020 /* TRANSPARENT */;
                    return cp;
                }
            }

            protected override void OnHandleCreated(EventArgs e)
            {
                base.OnHandleCreated(e);
                SetLayeredWindowAttributes(Handle, 0, 255, 0x2 /* LWA_ALPHA: opaque */);
            }
        }

        [DllImport("dwmapi.dll")] static extern int DwmFlush();
        [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint key, byte alpha, uint flags);
    }
}
