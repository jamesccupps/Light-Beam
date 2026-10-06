// (Windows 1.12.6) The viewer draws this PC's pointer itself, under its own mouse, at once (the user, on what makes
// Parsec feel fast: "yeah do 1 and 2"; then "Hide it on the PC"). Edge's screen capture always draws the pointer into
// the picture (getDisplayMedia's `cursor: 'never'` is ignored and still reads "never": checked on Edge 155), so while
// a viewer with a mouse controls this PC, the standard pointers here are swapped for blank ones and the viewer is told
// which one is showing, as a CSS name.
// - Only the standard pointers (arrow, text, hand, resize, wait…): an app's own pointer can't be hidden, so it stays
//   in the picture and the viewer shows its dot (`css` null), as it does while this PC's own mouse moves (someone at
//   the PC: raw input from a real device, which input from the viewer never is; for a few seconds).
// - Put back at the session's end, when the viewer turns it off, when Beam quits or fails, and at Beam's next start if
//   it stopped with them hidden (a marker file next to its config). A test instance never touches the real pointers.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace Beam
{
    class RcPointer : IDisposable
    {
        // The standard pointers: their ids (OCR_* = IDC_*), and the CSS names a browser draws them with.
        static readonly int[] Ids = { 32512, 32513, 32514, 32515, 32516, 32642, 32643, 32644, 32645, 32646, 32648, 32649, 32650, 32651, 32671, 32672 };
        static readonly string[] Css = { "default", "text", "wait", "crosshair", "default", "nwse-resize", "nesw-resize", "ew-resize", "ns-resize", "move",
            "not-allowed", "pointer", "progress", "help", "default", "default" };
        const int RevealMs = 4000;
        static readonly object gate = new object();
        static string markerFile;           // while the real pointers are hidden
        static volatile RcPointer active;   // (for Beam failing: Emergency)

        readonly Action<Dictionary<string, object>> send; // to the viewer (ctl), from a timer's thread
        readonly bool test;
        readonly Timer timer;
        readonly Stopwatch clock = Stopwatch.StartNew();
        bool hidden, stopped;
        long revealUntil = -1;   // (clock ms) this PC's own mouse moved: shown until then
        string told;             // what the viewer was told last

        public RcPointer(Config cfg, Action<Dictionary<string, object>> send)
        {
            this.send = send;
            test = cfg.CustomPath;
            markerFile = Path.Combine(cfg.Dir, "rc-pointer-hidden");
            active = this;
            timer = new Timer(Tick, null, 0, 33);
        }

        // Someone moved this PC's own mouse: its pointer shows for a few seconds (and the viewer shows its dot).
        public void Reveal()
        {
            lock (gate) revealUntil = clock.ElapsedMilliseconds + RevealMs;
        }

        // The shape again at the next look (a new connection to the viewer).
        public void Resend()
        {
            lock (gate) told = null;
        }

        void Tick(object state)
        {
            lock (gate)
            {
                if (stopped) return;
                bool reveal = clock.ElapsedMilliseconds < revealUntil;
                if (reveal) Show(); else Hide();
                var ci = new CURSORINFO();
                ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
                if (!GetCursorInfo(ref ci)) return; // (a secure desktop: nothing to say)
                bool off = (ci.flags & 1) == 0;     // (an app hid it, or a touch or pen hides it)
                string css = reveal || off ? null : NameOf(ci.hCursor);
                string key = off ? "hidden" : css ?? "picture";
                if (key == told) return;
                told = key;
                var m = new Dictionary<string, object>();
                m["t"] = "cursor";
                m["css"] = css;
                m["hidden"] = off;
                try { send(m); } catch (Exception ex) { Log.Error("Remote control: the pointer's shape", ex); }
            }
        }

        // The standard pointer a handle is (they're shared by every process), as a CSS name; null: an app's own.
        static string NameOf(IntPtr h)
        {
            if (h == IntPtr.Zero) return null;
            for (int i = 0; i < Ids.Length; i++) if (LoadCursor(IntPtr.Zero, (IntPtr)Ids[i]) == h) return Css[i];
            return null;
        }

        // (under gate) The standard pointers swapped for blank ones.
        void Hide()
        {
            if (hidden) return;
            hidden = true;
            if (test) { Log.Write("Remote control: (test) this PC's pointer would be hidden now"); return; }
            try { File.WriteAllText(markerFile, DateTime.Now.ToString("o")); } catch { }
            int done = 0;
            foreach (int id in Ids)
            {
                IntPtr blank = Blank();
                if (blank != IntPtr.Zero && SetSystemCursor(blank, (uint)id)) done++; // (it takes the copy)
            }
            Log.Write("Remote control: this PC's pointer is hidden while the viewer draws it (" + done + " of " + Ids.Length + " pointers)");
        }

        // (under gate) The real pointers again (Windows reads them back from the user's settings).
        void Show()
        {
            if (!hidden) return;
            hidden = false;
            if (test) { Log.Write("Remote control: (test) this PC's pointer would show again"); return; }
            PutBack();
        }

        static void PutBack()
        {
            SystemParametersInfo(0x0057 /* SPI_SETCURSORS */, 0, IntPtr.Zero, 0);
            try { if (markerFile != null) File.Delete(markerFile); } catch { }
        }

        static IntPtr Blank()
        {
            var and = new byte[32 * 32 / 8];
            for (int i = 0; i < and.Length; i++) and[i] = 0xFF; // (all transparent)
            return CreateCursor(IntPtr.Zero, 0, 0, 32, 32, and, new byte[and.Length]);
        }

        public void Dispose()
        {
            timer.Dispose();
            lock (gate)
            {
                stopped = true;
                Show();
            }
            if (active == this) active = null;
        }

        // Beam failing: the real pointers back, if hidden.
        public static void Emergency()
        {
            var a = active;
            if (a == null || a.test || !Monitor.TryEnter(gate, 500)) return;
            try { a.stopped = true; a.Show(); }
            catch { }
            finally { Monitor.Exit(gate); }
        }

        // At Beam's start: pointers it hid before it stopped (it failed, or was ended) are put back.
        public static void Recover(Config cfg)
        {
            if (cfg.CustomPath) return;
            markerFile = Path.Combine(cfg.Dir, "rc-pointer-hidden");
            if (!File.Exists(markerFile)) return;
            PutBack();
            Log.Write("Remote control: this PC's pointer was still hidden from before Beam stopped: shown again");
        }

        // ------------------------------------------------------------------ this PC's own mouse (raw input)

        // Raw input from mice to `hwnd` (a window of the UI thread), even when Beam isn't in front.
        public static bool Listen(IntPtr hwnd, bool on)
        {
            var d = new RAWINPUTDEVICE[1];
            d[0].usUsagePage = 0x01;
            d[0].usUsage = 0x02; // (a mouse)
            d[0].dwFlags = on ? 0x00000100u /* RIDEV_INPUTSINK */ : 0x00000001u /* RIDEV_REMOVE */;
            d[0].hwndTarget = on ? hwnd : IntPtr.Zero;
            return RegisterRawInputDevices(d, 1, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE)));
        }

        // A WM_INPUT: whether it's a real mouse here that moved or clicked (the viewer's input comes from no device).
        public static bool FromThisMouse(IntPtr lParam)
        {
            uint size = 0, header = (uint)Marshal.SizeOf(typeof(RAWINPUTHEADER));
            if (GetRawInputData(lParam, 0x10000003 /* RID_INPUT */, IntPtr.Zero, ref size, header) != 0 || size < header + 24) return false;
            IntPtr buf = Marshal.AllocHGlobal((int)size);
            try
            {
                if (GetRawInputData(lParam, 0x10000003, buf, ref size, header) != size) return false;
                var h = (RAWINPUTHEADER)Marshal.PtrToStructure(buf, typeof(RAWINPUTHEADER));
                if (h.dwType != 0 /* RIM_TYPEMOUSE */ || h.hDevice == IntPtr.Zero) return false;
                int at = (int)header;
                int buttons = Marshal.ReadInt16(buf, at + 4);     // usButtonFlags
                int dx = Marshal.ReadInt32(buf, at + 12), dy = Marshal.ReadInt32(buf, at + 16);
                return dx != 0 || dy != 0 || buttons != 0;
            }
            finally { Marshal.FreeHGlobal(buf); }
        }

        [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT pt; }
        [StructLayout(LayoutKind.Sequential)] struct RAWINPUTDEVICE { public ushort usUsagePage, usUsage; public uint dwFlags; public IntPtr hwndTarget; }
        [StructLayout(LayoutKind.Sequential)] struct RAWINPUTHEADER { public uint dwType, dwSize; public IntPtr hDevice, wParam; }

        [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO ci);
        [DllImport("user32.dll")] static extern IntPtr LoadCursor(IntPtr hInstance, IntPtr name);
        [DllImport("user32.dll")] static extern bool SetSystemCursor(IntPtr hcur, uint id);
        [DllImport("user32.dll")] static extern IntPtr CreateCursor(IntPtr hInst, int xHotSpot, int yHotSpot, int nWidth, int nHeight, byte[] andPlane, byte[] xorPlane);
        [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint param, IntPtr vparam, uint winIni);
        [DllImport("user32.dll", SetLastError = true)] static extern bool RegisterRawInputDevices(RAWINPUTDEVICE[] devices, uint count, uint size);
        [DllImport("user32.dll")] static extern uint GetRawInputData(IntPtr hRawInput, uint command, IntPtr data, ref uint size, uint headerSize);
    }
}
