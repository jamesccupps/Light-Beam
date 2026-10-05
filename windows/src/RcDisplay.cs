// Fits the shared screen to the viewer (Beam 1.8; the user: "it should change the desktop scaling and resolution too,
// because right now it doesnt fit my screen"): the screen's resolution and display scaling change to suit the screen
// it is viewed on, as Microsoft's Remote Desktop does, and go back when the session ends. Only sizes the monitor offers
// are possible: Beam shares the real screen, and its own monitor shows the change too.
// - The resolution changes in Windows' temporary mode (CDS_FULLSCREEN): if Beam exits, Windows puts it back itself.
// - The scaling is Windows' own per-monitor setting (DisplayConfigSetDeviceInfo, what Settings → Display uses; not
//   documented, so a Windows that refuses it keeps its scaling). It stays when Beam exits, so the original is written
//   down first (config rcDisplayRestore) and put back at Beam's next start if it never got to.
// Changes broadcast to every window (WM_DISPLAYCHANGE, WM_DPICHANGED): Apply and Undo run off the UI thread; Plan and
// the bookkeeping on it. Test instances get FakeDisplay: nothing real changes.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Runtime.InteropServices;

namespace Beam
{
    struct DisplayMode
    {
        public int W, H, Hz;
        public DisplayMode(int w, int h, int hz) { W = w; H = h; Hz = hz; }
        public bool SameSize(DisplayMode o) { return W == o.W && H == o.H; }
        public override string ToString() { return W.ToString(CultureInfo.InvariantCulture) + "×" + H.ToString(CultureInfo.InvariantCulture); }
    }

    class DpiInfo { public int Current, Recommended, Max; }

    interface IDisplayBackend
    {
        string Name { get; }
        List<DisplayMode> Modes(string device);
        DisplayMode? Current(string device);
        bool SetMode(string device, DisplayMode m);   // temporary: Windows' saved mode stays as it was
        bool ResetMode(string device);                // back to Windows' saved mode
        DpiInfo Dpi(string device);                   // null: unknown
        bool SetDpi(string device, int percent);
    }

    // The choices, apart from Windows (tested by test/perf/windows-input-test).
    static class DisplayFit
    {
        public static readonly int[] Steps = { 100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500 };

        // The monitor's mode for a viewer whose picture area is vw×vh physical pixels: the one it shows closest to pixel
        // for pixel (each step of up- or downscaling costs), filling the most of it (black bars cost less). Same
        // orientation as now, at least 1024×720 (or the current mode), at the current refresh rate where the size has it.
        public static DisplayMode? Pick(IList<DisplayMode> modes, DisplayMode current, int vw, int vh)
        {
            if (vw < 200 || vh < 200 || vw > 16384 || vh > 16384) return null;
            bool landscape = current.W >= current.H;
            var sizes = new Dictionary<long, DisplayMode>();
            var all = new List<DisplayMode>(modes ?? new List<DisplayMode>());
            all.Add(current);
            foreach (var m in all)
            {
                bool now = m.SameSize(current);
                if (!now && (m.W < 1024 || m.H < 720 || (m.W >= m.H) != landscape)) continue;
                long k = ((long)m.W << 20) | (uint)m.H;
                DisplayMode had;
                if (!sizes.TryGetValue(k, out had) || BetterRate(m.Hz, had.Hz, current.Hz)) sizes[k] = m;
            }
            DisplayMode? best = null;
            double bestCost = double.MaxValue;
            foreach (var m in sizes.Values.OrderByDescending(x => (long)x.W * x.H))
            {
                double f = Math.Min((double)vw / m.W, (double)vh / m.H);
                double used = (m.W * f) * (m.H * f) / ((double)vw * vh);
                double cost = 3 * Math.Abs(Math.Log(f)) + (1 - used);
                if (cost < bestCost - 1e-9) { best = m; bestCost = cost; }
            }
            return best;
        }

        static bool BetterRate(int hz, int had, int now)
        {
            if (had == now) return false;
            if (hz == now) return true;
            return hz > had;
        }

        // The scaling (percent) that shows the PC's interface at the size the viewer shows its own: one PC pixel is f
        // viewer pixels, so dpr / f; Windows' nearest step (the lower one on a tie), 100% up to what Windows allows.
        public static int Scale(DisplayMode m, int vw, int vh, double dpr, int maxPercent)
        {
            if (m.W <= 0 || m.H <= 0 || vw <= 0 || vh <= 0 || double.IsNaN(dpr) || dpr <= 0) return 100;
            double f = Math.Min((double)vw / m.W, (double)vh / m.H);
            double want = dpr / f * 100;
            int best = 100;
            foreach (int step in Steps)
            {
                if (step > Math.Max(100, maxPercent)) break;
                if (Math.Abs(step - want) < Math.Abs(best - want) - 1e-9) best = step;
            }
            return best;
        }
    }

    // A screen's own settings, as written down before a fit: "device|w|h|hz|percent" (percent 0: unknown).
    class SavedDisplay
    {
        public string Device;
        public DisplayMode Mode;
        public int Percent;

        public override string ToString()
        {
            return string.Join("|", Device, Mode.W.ToString(CultureInfo.InvariantCulture), Mode.H.ToString(CultureInfo.InvariantCulture),
                Mode.Hz.ToString(CultureInfo.InvariantCulture), Percent.ToString(CultureInfo.InvariantCulture));
        }

        public static SavedDisplay Parse(string s)
        {
            var p = (s ?? "").Split('|');
            int w, h, hz, pc;
            if (p.Length != 5 || p[0].Length == 0 || p[0].Length > 64
                || !int.TryParse(p[1], NumberStyles.None, CultureInfo.InvariantCulture, out w)
                || !int.TryParse(p[2], NumberStyles.None, CultureInfo.InvariantCulture, out h)
                || !int.TryParse(p[3], NumberStyles.None, CultureInfo.InvariantCulture, out hz)
                || !int.TryParse(p[4], NumberStyles.None, CultureInfo.InvariantCulture, out pc)) return null;
            if (w < 320 || h < 200 || w > 16384 || h > 16384) return null;
            var d = new SavedDisplay();
            d.Device = p[0];
            d.Mode = new DisplayMode(w, h, hz);
            d.Percent = pc;
            return d;
        }
    }

    class DisplayPlan
    {
        public string Device;
        public DisplayMode Mode;        // to switch to
        public int Percent;             // the scaling wanted (Apply clamps it to what Windows allows at that mode)
        public int Vw, Vh;
        public double Dpr;
        public bool Scale;              // (1.11.4) the viewer's scaling too; else the screen's own, as near as that mode allows
        public bool Changed;            // Apply changed the resolution or the scaling
        public SavedDisplay Original;   // what the screen had before the first fit of the session
    }

    class RcDisplay
    {
        readonly IDisplayBackend backend;
        readonly Action<string> log;
        SavedDisplay original;          // the fitted screen's own settings, while it is fitted

        public RcDisplay(IDisplayBackend backend, Action<string> log)
        {
            this.backend = backend;
            this.log = log ?? (s => { });
        }

        public IDisplayBackend Backend { get { return backend; } }
        public SavedDisplay Original { get { return original; } }
        public bool Fitted { get { return original != null; } }

        // UI thread, reads only. Null: nothing to do here (no modes, or the screen can't be read).
        public DisplayPlan Plan(string device, int vw, int vh, double dpr, bool scale)
        {
            if (string.IsNullOrEmpty(device)) return null;
            var now = backend.Current(device);
            if (!now.HasValue) return null;
            var pick = DisplayFit.Pick(backend.Modes(device), now.Value, vw, vh);
            if (!pick.HasValue) return null;
            var plan = new DisplayPlan();
            plan.Device = device;
            plan.Mode = pick.Value;
            plan.Vw = vw;
            plan.Vh = vh;
            plan.Dpr = dpr;
            plan.Scale = scale;
            plan.Percent = DisplayFit.Scale(pick.Value, vw, vh, dpr, 500);
            if (original != null && original.Device == device) plan.Original = original;
            else
            {
                var dpi = backend.Dpi(device);
                plan.Original = new SavedDisplay();
                plan.Original.Device = device;
                plan.Original.Mode = now.Value;
                plan.Original.Percent = dpi != null ? dpi.Current : 0;
            }
            return plan;
        }

        // UI thread: from here on the screen counts as fitted (the caller has written plan.Original down).
        public void Begin(DisplayPlan plan) { original = plan.Original; }

        // Off the UI thread. The resolution first (Windows' largest scaling depends on it), then the scaling.
        public string Apply(DisplayPlan plan)
        {
            var now = backend.Current(plan.Device);
            bool moved = false;
            if (!now.HasValue || !now.Value.SameSize(plan.Mode) || now.Value.Hz != plan.Mode.Hz)
            {
                if (!backend.SetMode(plan.Device, plan.Mode)) return "Windows didn't take " + plan.Mode + " for this screen";
                moved = true;
            }
            var dpi = backend.Dpi(plan.Device);
            string scale = "";
            bool scaled = false;
            if (dpi != null)
            {
                // (1.11.4) Without the viewer's "Bigger text": the screen's own scaling, unless that mode can't have it.
                int own = plan.Original != null && plan.Original.Percent > 0 ? plan.Original.Percent : dpi.Current;
                int want = plan.Scale ? DisplayFit.Scale(plan.Mode, plan.Vw, plan.Vh, plan.Dpr, dpi.Max) : Math.Max(100, Math.Min(own, dpi.Max));
                if (want != dpi.Current && !backend.SetDpi(plan.Device, want)) scale = " (Windows kept its scaling)";
                else
                {
                    scaled = want != dpi.Current;
                    scale = " at " + want + "%" + (plan.Scale ? "" : want == own ? " (its own scaling)" : " (its own " + own + "% doesn't go at this size)");
                }
            }
            plan.Changed = moved || scaled;
            log("fitted to the viewer: " + plan.Mode + scale + (moved ? "" : " (the same size)") + "; it was " + Describe(plan.Original));
            return null;
        }

        // Off the UI thread: the screen as it was. True when nothing is left to undo.
        public bool Undo(SavedDisplay saved, string why)
        {
            if (saved == null) return true;
            bool ok = true;
            var now = backend.Current(saved.Device);
            if (!now.HasValue || !now.Value.SameSize(saved.Mode) || (saved.Mode.Hz > 1 && now.Value.Hz != saved.Mode.Hz)) // (0 or 1: the default rate)
            {
                ok = backend.ResetMode(saved.Device);
                var after = backend.Current(saved.Device);
                if (ok && after.HasValue && !after.Value.SameSize(saved.Mode)) ok = backend.SetMode(saved.Device, saved.Mode); // (Windows' saved mode was another)
            }
            if (saved.Percent > 0)
            {
                var dpi = backend.Dpi(saved.Device);
                if (dpi != null && dpi.Current != saved.Percent && !backend.SetDpi(saved.Device, saved.Percent)) ok = false;
            }
            log((ok ? "back to " : "couldn't fully put back ") + Describe(saved) + " (" + why + ")");
            return ok;
        }

        // UI thread, after Undo.
        public void End() { original = null; }

        public static string Describe(SavedDisplay d)
        {
            return d == null ? "?" : d.Mode + (d.Percent > 0 ? " at " + d.Percent + "%" : "");
        }
    }

    // Test instances (custom --config): a made-up 2560×1440 monitor at 150%; nothing real changes.
    class FakeDisplay : IDisplayBackend
    {
        public readonly List<DisplayMode> All = new List<DisplayMode>
        {
            new DisplayMode(3840, 2160, 60), new DisplayMode(2560, 1440, 144), new DisplayMode(2560, 1440, 60), new DisplayMode(1920, 1200, 60),
            new DisplayMode(1920, 1080, 60), new DisplayMode(1680, 1050, 60), new DisplayMode(1600, 900, 60), new DisplayMode(1366, 768, 60),
            new DisplayMode(1280, 720, 60), new DisplayMode(1024, 768, 60), new DisplayMode(800, 600, 60),
        };
        public DisplayMode Saved = new DisplayMode(2560, 1440, 60), Now = new DisplayMode(2560, 1440, 60);
        public int Percent = 150;
        public readonly List<string> Calls = new List<string>();
        readonly object gate = new object();

        public string Name { get { return "a made-up screen (test instance)"; } }
        public List<DisplayMode> Modes(string device) { lock (gate) return new List<DisplayMode>(All); }
        public DisplayMode? Current(string device) { lock (gate) return Now; }
        public bool SetMode(string device, DisplayMode m) { lock (gate) { Calls.Add("mode " + m + "@" + m.Hz); Now = m; return true; } }
        public bool ResetMode(string device) { lock (gate) { Calls.Add("reset"); Now = Saved; return true; } }

        // Windows' largest scaling keeps the interface at least 1024 wide (1920 → 175%).
        public DpiInfo Dpi(string device)
        {
            lock (gate)
            {
                var d = new DpiInfo();
                d.Current = Percent;
                d.Recommended = 150;
                d.Max = DisplayFit.Steps.Where(s => Now.W * 100 / s >= 1024).DefaultIfEmpty(100).Max();
                return d;
            }
        }

        public bool SetDpi(string device, int percent)
        {
            lock (gate)
            {
                Calls.Add("scale " + percent);
                if (Array.IndexOf(DisplayFit.Steps, percent) < 0) return false;
                Percent = percent;
                return true;
            }
        }

        public string State { get { lock (gate) return Now + "@" + Now.Hz + " " + Percent + "% calls: " + string.Join(", ", Calls); } }
    }

#if !NO_REAL_DISPLAY
    // Windows itself: EnumDisplaySettingsEx / ChangeDisplaySettingsEx for the resolution; the per-monitor scaling
    // through DisplayConfigGetDeviceInfo / DisplayConfigSetDeviceInfo (types -3 and -4: undocumented, relative to
    // Windows' recommended step).
    class Win32Display : IDisplayBackend
    {
        public string Name { get { return "Windows"; } }

        public List<DisplayMode> Modes(string device)
        {
            var list = new List<DisplayMode>();
            var dm = NewDevMode();
            for (int i = 0; i < 2000 && EnumDisplaySettingsEx(device, i, ref dm, 0); i++)
            {
                if (dm.dmBitsPerPel >= 24 && (dm.dmDisplayFlags & DM_INTERLACED) == 0 && dm.dmPelsWidth > 0 && dm.dmPelsHeight > 0)
                    list.Add(new DisplayMode(dm.dmPelsWidth, dm.dmPelsHeight, dm.dmDisplayFrequency));
                dm = NewDevMode();
            }
            return list;
        }

        public DisplayMode? Current(string device)
        {
            var dm = NewDevMode();
            if (!EnumDisplaySettingsEx(device, ENUM_CURRENT_SETTINGS, ref dm, 0)) return null;
            return new DisplayMode(dm.dmPelsWidth, dm.dmPelsHeight, dm.dmDisplayFrequency);
        }

        public bool SetMode(string device, DisplayMode m)
        {
            var dm = NewDevMode();
            if (!EnumDisplaySettingsEx(device, ENUM_CURRENT_SETTINGS, ref dm, 0)) return false;
            dm.dmPelsWidth = m.W;
            dm.dmPelsHeight = m.H;
            dm.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT;
            if (m.Hz > 1) { dm.dmDisplayFrequency = m.Hz; dm.dmFields |= DM_DISPLAYFREQUENCY; }
            return ChangeDisplaySettingsEx(device, ref dm, IntPtr.Zero, CDS_FULLSCREEN, IntPtr.Zero) == DISP_CHANGE_SUCCESSFUL;
        }

        public bool ResetMode(string device)
        {
            return ChangeDisplaySettingsEx(device, IntPtr.Zero, IntPtr.Zero, 0, IntPtr.Zero) == DISP_CHANGE_SUCCESSFUL;
        }

        public DpiInfo Dpi(string device)
        {
            HEADER src;
            if (!Source(device, out src)) return null;
            var get = new DPI_GET();
            get.header = src;
            get.header.type = -3;
            get.header.size = Marshal.SizeOf(typeof(DPI_GET));
            if (DisplayConfigGetDeviceInfo(ref get) != 0) return null;
            int rec = -get.minRel, cur = rec + get.curRel, max = rec + get.maxRel, n = DisplayFit.Steps.Length;
            if (rec < 0 || rec >= n || cur < 0 || cur >= n) return null;
            var d = new DpiInfo();
            d.Recommended = DisplayFit.Steps[rec];
            d.Current = DisplayFit.Steps[cur];
            d.Max = DisplayFit.Steps[Math.Max(0, Math.Min(n - 1, max))];
            return d;
        }

        public bool SetDpi(string device, int percent)
        {
            int want = Array.IndexOf(DisplayFit.Steps, percent);
            HEADER src;
            if (want < 0 || !Source(device, out src)) return false;
            var get = new DPI_GET();
            get.header = src;
            get.header.type = -3;
            get.header.size = Marshal.SizeOf(typeof(DPI_GET));
            if (DisplayConfigGetDeviceInfo(ref get) != 0) return false;
            var set = new DPI_SET();
            set.header = src;
            set.header.type = -4;
            set.header.size = Marshal.SizeOf(typeof(DPI_SET));
            set.scaleRel = want - (-get.minRel);
            return DisplayConfigSetDeviceInfo(ref set) == 0;
        }

        // The display path's source (adapter and id) whose GDI name is `device` (\\.\DISPLAY1).
        static bool Source(string device, out HEADER found)
        {
            found = new HEADER();
            uint np, nm;
            if (GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, out np, out nm) != 0 || np == 0) return false;
            var paths = new PATH_INFO[np];
            var modes = new MODE_INFO[nm];
            if (QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, ref np, paths, ref nm, modes, IntPtr.Zero) != 0) return false;
            for (int i = 0; i < np; i++)
            {
                var name = new SOURCE_NAME();
                name.header.type = 1; // DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME
                name.header.size = Marshal.SizeOf(typeof(SOURCE_NAME));
                name.header.adapterId = paths[i].sourceInfo.adapterId;
                name.header.id = paths[i].sourceInfo.id;
                if (DisplayConfigGetDeviceInfo(ref name) != 0) continue;
                if (!string.Equals(name.gdiName, device, StringComparison.OrdinalIgnoreCase)) continue;
                found = name.header;
                return true;
            }
            return false;
        }

        static DEVMODE NewDevMode()
        {
            var dm = new DEVMODE();
            dm.dmDeviceName = new string('\0', 32);
            dm.dmFormName = new string('\0', 32);
            dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
            return dm;
        }

        const int ENUM_CURRENT_SETTINGS = -1;
        const uint CDS_FULLSCREEN = 0x4;
        const int DISP_CHANGE_SUCCESSFUL = 0;
        const int DM_PELSWIDTH = 0x80000, DM_PELSHEIGHT = 0x100000, DM_DISPLAYFREQUENCY = 0x400000;
        const int DM_INTERLACED = 0x2;
        const uint QDC_ONLY_ACTIVE_PATHS = 2;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct DEVMODE
        {
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
            public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
            public int dmFields;
            public int dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
            public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
            public short dmLogPixels;
            public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
            public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
        }

        [StructLayout(LayoutKind.Sequential)] struct LUID { public uint Low; public int High; }
        [StructLayout(LayoutKind.Sequential)] struct HEADER { public int type; public int size; public LUID adapterId; public uint id; }
        [StructLayout(LayoutKind.Sequential)] struct DPI_GET { public HEADER header; public int minRel, curRel, maxRel; }
        [StructLayout(LayoutKind.Sequential)] struct DPI_SET { public HEADER header; public int scaleRel; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct SOURCE_NAME { public HEADER header; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string gdiName; }
        [StructLayout(LayoutKind.Sequential)] struct PATH_SOURCE { public LUID adapterId; public uint id, modeInfoIdx, statusFlags; }
        [StructLayout(LayoutKind.Sequential)]
        struct PATH_TARGET { public LUID adapterId; public uint id, modeInfoIdx; public int outputTechnology, rotation, scaling; public uint refreshNum, refreshDen; public int scanLineOrdering, targetAvailable; public uint statusFlags; }
        [StructLayout(LayoutKind.Sequential)] struct PATH_INFO { public PATH_SOURCE sourceInfo; public PATH_TARGET targetInfo; public uint flags; }
        [StructLayout(LayoutKind.Sequential, Size = 64)] struct MODE_INFO { public int infoType; }

        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettingsEx(string device, int mode, ref DEVMODE dm, uint flags);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ChangeDisplaySettingsEx(string device, ref DEVMODE dm, IntPtr hwnd, uint flags, IntPtr param);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ChangeDisplaySettingsEx(string device, IntPtr dm, IntPtr hwnd, uint flags, IntPtr param);
        [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint paths, out uint modes);
        [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint np, [Out] PATH_INFO[] paths, ref uint nm, [Out] MODE_INFO[] modes, IntPtr topology);
        [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(ref SOURCE_NAME packet);
        [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(ref DPI_GET packet);
        [DllImport("user32.dll")] static extern int DisplayConfigSetDeviceInfo(ref DPI_SET packet);
    }
#endif
}
