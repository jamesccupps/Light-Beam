// (Windows 1.12.6) The viewer measuring the delay end to end (the user, on what makes Parsec fast: "yeah do 1 and 2"): a
// square in the top left corner of the screen this PC shares, on top of everything, that turns from magenta to green
// and back for each probe the viewer sends the way its input comes (`in`); the viewer watches its picture for the change.
// This PC answers how long each took from arriving here to being on its screen (painted, then DwmFlush: composed).
// The square has a thread of its own (nothing here waits for the UI thread or the page's), takes no clicks, never takes
// the focus, and goes when the viewer is done, after 20 s without a probe, at the session's end or a switch of screens.
// (1.22.1) Big changes too, for a viewer that asks (`big`): the square sits in the corner of a block of text the size of
// a window opening (the cloud session's bench, 1200×800 on a 1920×1080 screen: Beam-dev\plan\rc-big-1015.md), and a big
// probe swaps the block's page of text in the same paint as the square's colour, so the square still times it.
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

        // The square at the top left corner of a screen (physical pixels), with `big` on its block of text; `shown` once
        // it's on the screen.
        public static RcProbe Start(Rectangle screen, bool big, Action<double> shown)
        {
            var p = new RcProbe();
            long from = Stopwatch.GetTimestamp();
            var ready = new ManualResetEventSlim();
            var t = new Thread(() =>
            {
                // (1.23, the user's review) nothing here may end Beam (an 8K screen's pages are big), and a Close that came
                // before this thread was ready still closes it (the square is topmost)
                System.Windows.Forms.Timer idle = null;
                try
                {
                    var c = new Control();
                    GC.KeepAlive(c.Handle);
                    p.marshal = c; // (only with its handle: BeginInvoke on one without throws)
                    Bitmap[] pages = null;
                    if (big)
                    {
                        try { pages = Pages(screen.Width, screen.Height); }
                        catch (Exception ex) { Log.Error("Remote control: the delay probe's block (the square alone)", ex); }
                    }
                    var at = pages != null ? new Rectangle(screen.X, screen.Y, pages[0].Width, pages[0].Height) : new Rectangle(screen.X, screen.Y, Size, Size);
                    p.square = new Square(at, Magenta, pages);
                    idle = new System.Windows.Forms.Timer();
                    idle.Interval = 1000;
                    idle.Tick += (s, e) => { if (Ms(p.last) > IdleMs) p.Close(); };
                    idle.Start();
                    ready.Set();
                    if (p.closed) { p.square.Dispose(); return; } // (closed before it was shown)
                    p.square.Show();
                    p.square.Refresh();
                    DwmFlush();
                    shown(Ms(from));
                    Application.Run();
                }
                catch (Exception ex)
                {
                    Log.Error("Remote control: the delay probe", ex);
                    p.closed = true;
                    try { if (p.square != null) { p.square.Close(); p.square.Dispose(); } } catch { }
                }
                finally
                {
                    ready.Set();
                    if (idle != null) idle.Dispose();
                }
            });
            t.SetApartmentState(ApartmentState.STA);
            t.IsBackground = true;
            t.Name = "Beam delay probe";
            t.Start();
            ready.Wait(2000);
            return p;
        }

        static double Ms(long since) { return (Stopwatch.GetTimestamp() - since) * 1000.0 / Stopwatch.Frequency; }

        // The other colour, at once (`big`: the block's other page too, in the same paint); `done` gets it (green or not)
        // and the time from `arrived` (a Stopwatch timestamp) to the change being on the screen.
        public void Flip(long arrived, bool big, Action<bool, double> done)
        {
            last = Stopwatch.GetTimestamp();
            Run(() =>
            {
                green = !green;
                square.Turn(green ? Green : Magenta, big);
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

        // (1.22.1) The block's two pages: lines of words in the bench's sizes (13 px text, 18 px lines at 1080 rows,
        // larger on a larger screen), each page other words on another background, as a window of text opening.
        static readonly string[] Words = "the quick brown fox jumps over lazy dog remote control picture frame encoder network latency window menu file edit view help settings beam desktop laptop".Split(' ');

        // A line at a time (DrawString: one call a line, ~40 a page; TextRenderer copied the whole bitmap for each word,
        // 2.5 s for the two pages in windows-rc).
        static Bitmap[] Pages(int screenW, int screenH)
        {
            int w = Math.Max(Size * 4, (int)Math.Round(screenW * 0.625)), h = Math.Max(Size * 4, (int)Math.Round(screenH * 0.74));
            double k = Math.Max(1, screenH / 1080.0);
            var pages = new Bitmap[2];
            using (var font = new Font("Segoe UI", (float)(13 * k), GraphicsUnit.Pixel))
            using (var ink = new SolidBrush(Color.FromArgb(0x1d, 0x23, 0x30)))
            {
                var format = StringFormat.GenericTypographic;
                for (int i = 0; i < 2; i++)
                {
                    var b = new Bitmap(w, h, System.Drawing.Imaging.PixelFormat.Format32bppRgb);
                    using (var g = Graphics.FromImage(b))
                    {
                        g.Clear(i == 0 ? Color.FromArgb(0xf3, 0xf6, 0xfb) : Color.FromArgb(0xff, 0xfd, 0xf3));
                        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
                        var rnd = new Random(i + 1);
                        float space = (float)(8 * k); // (about two spaces; a line that comes out longer is cut at the edge)
                        var widths = new float[Words.Length];
                        for (int j = 0; j < Words.Length; j++) widths[j] = g.MeasureString(Words[j], font, 1000, format).Width;
                        int line = (int)Math.Round(18 * k);
                        var text = new System.Text.StringBuilder();
                        for (int y = (int)Math.Round(6 * k) + Size; y < h - line; y += line)
                        {
                            text.Clear();
                            float x = (float)(8 * k);
                            while (x < w - 60 * k)
                            {
                                int j = rnd.Next(Words.Length);
                                text.Append(Words[j]).Append("  ");
                                x += widths[j] + space;
                            }
                            g.DrawString(text.ToString(), font, ink, (float)(8 * k), y, format);
                        }
                    }
                    pages[i] = b;
                }
            }
            return pages;
        }

        // The square: topmost, click-through (layered and transparent to the mouse), no focus, not in the taskbar. With
        // pages (1.22.1): the block, painted from them, the square in its corner. Each page is kept as a GDI bitmap in a
        // memory DC and painted with BitBlt, as an app paints a window (GDI+'s DrawImage took 52 ms for a page here).
        sealed class Square : Form
        {
            readonly IntPtr[] dcs, bitmaps, before;
            int page;
            Color color;

            public Square(Rectangle at, Color color, Bitmap[] pages)
            {
                FormBorderStyle = FormBorderStyle.None;
                ShowInTaskbar = false;
                StartPosition = FormStartPosition.Manual;
                Bounds = at;
                BackColor = color;
                TopMost = true;
                this.color = color;
                if (pages == null) return;
                SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint | ControlStyles.Opaque, true);
                dcs = new IntPtr[pages.Length];
                bitmaps = new IntPtr[pages.Length];
                before = new IntPtr[pages.Length];
                for (int i = 0; i < pages.Length; i++)
                {
                    bitmaps[i] = pages[i].GetHbitmap();
                    dcs[i] = CreateCompatibleDC(IntPtr.Zero);
                    before[i] = SelectObject(dcs[i], bitmaps[i]);
                    pages[i].Dispose();
                }
            }

            // The square's other colour now, and with `page` the block's other page, in one paint
            public void Turn(Color c, bool page)
            {
                color = c;
                if (dcs == null) { BackColor = c; Refresh(); return; }
                if (page) this.page ^= 1;
                Invalidate(page ? ClientRectangle : new Rectangle(0, 0, RcProbe.Size, RcProbe.Size));
                Update();
            }

            protected override void OnPaint(PaintEventArgs e)
            {
                if (dcs == null) { base.OnPaint(e); return; }
                var r = e.ClipRectangle;
                IntPtr hdc = e.Graphics.GetHdc();
                try { BitBlt(hdc, r.X, r.Y, r.Width, r.Height, dcs[page], r.X, r.Y, 0x00CC0020 /* SRCCOPY */); }
                finally { e.Graphics.ReleaseHdc(hdc); }
                using (var b = new SolidBrush(color)) e.Graphics.FillRectangle(b, 0, 0, RcProbe.Size, RcProbe.Size);
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

            protected override void Dispose(bool disposing)
            {
                if (dcs != null)
                {
                    for (int i = 0; i < dcs.Length; i++)
                    {
                        if (dcs[i] == IntPtr.Zero) continue;
                        SelectObject(dcs[i], before[i]);
                        DeleteDC(dcs[i]);
                        DeleteObject(bitmaps[i]);
                        dcs[i] = IntPtr.Zero;
                    }
                }
                base.Dispose(disposing);
            }
        }

        [DllImport("dwmapi.dll")] static extern int DwmFlush();
        [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint key, byte alpha, uint flags);
        [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
        [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
        [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
        [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
    }
}
