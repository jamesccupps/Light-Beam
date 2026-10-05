// Remote control input (Beam 1.6, research §4 and §8.7). The viewer's input messages (`in`: btn, wheel, key, text,
// release; `mv`: pointer moves) become Windows INPUT records, sent through one of two backends:
// - SendInputBackend, the real thing. Only a normal Beam (no --config) uses it.
// - RecordingBackend: every INPUT as a JSON line in a file, never real input. Test instances (--config) always use it,
//   and the input-mapping test compiles this file with NO_REAL_INPUT, which leaves SendInput out of the binary.
// Pointer: monitor-relative physical pixels (Beam is Per-Monitor-V2) → MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
// rounded so that Windows lands on that exact pixel. Keys: KeyboardEvent.code → set-1 scancodes (an 0xE0 prefix is the
// extended flag); the Win keys, Pause and NumLock go by virtual key. The fake ControlLeft that browsers send just
// before AltRight (AltGr) is dropped: this PC's own layout makes its own. Everything pressed here is let go on
// `release`, a lost viewer and the end of a session. Never injected: Win+L (the viewer has a Lock action instead) and
// the power keys.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Beam
{
    // One INPUT as SendInput takes it (type 0: mouse, 1: keyboard).
    struct InputRecord
    {
        public const int Mouse = 0, Keyboard = 1;
        public int Type;
        public int Dx, Dy;        // mouse: 0..65535 across the virtual desktop (with ABSOLUTE | VIRTUALDESK)
        public int MouseData;     // mouse: the wheel delta, or which X button
        public uint Flags;        // MOUSEEVENTF_* or KEYEVENTF_*
        public ushort Vk, Scan;   // keyboard

        public string ToJson(int batch)
        {
            var c = CultureInfo.InvariantCulture;
            if (Type == Mouse)
                return "{\"b\":" + batch.ToString(c) + ",\"type\":\"mouse\",\"dx\":" + Dx.ToString(c) + ",\"dy\":" + Dy.ToString(c) +
                    ",\"data\":" + MouseData.ToString(c) + ",\"flags\":" + Flags.ToString(c) + "}";
            return "{\"b\":" + batch.ToString(c) + ",\"type\":\"key\",\"vk\":" + Vk.ToString(c) + ",\"scan\":" + Scan.ToString(c) +
                ",\"flags\":" + Flags.ToString(c) + "}";
        }
    }

    // The native INPUT layout (40 bytes on 64-bit Windows, 28 on 32-bit: the union is pointer-aligned).
    static class NativeInput
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Explicit)]
        public struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT { public uint type; public UNION u; }

        public static INPUT[] ToNative(InputRecord[] records)
        {
            var list = new INPUT[records.Length];
            for (int i = 0; i < records.Length; i++)
            {
                var r = records[i];
                list[i].type = (uint)r.Type;
                if (r.Type == InputRecord.Mouse)
                {
                    list[i].u.mi.dx = r.Dx;
                    list[i].u.mi.dy = r.Dy;
                    list[i].u.mi.mouseData = unchecked((uint)r.MouseData);
                    list[i].u.mi.dwFlags = r.Flags;
                }
                else
                {
                    list[i].u.ki.wVk = r.Vk;
                    list[i].u.ki.wScan = r.Scan;
                    list[i].u.ki.dwFlags = r.Flags;
                }
            }
            return list;
        }

#if !NO_REAL_INPUT
        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint SendInput(uint count, INPUT[] inputs, int size);
#endif
    }

    interface IInputBackend
    {
        string Name { get; }
        int Send(InputRecord[] records);   // how many went in
    }

#if !NO_REAL_INPUT
    // The real one: never in an automated test (test instances get the recording backend, see RemoteControl).
    class SendInputBackend : IInputBackend
    {
        public string Name { get { return "SendInput"; } }

        public int Send(InputRecord[] records)
        {
            if (records.Length == 0) return 0;
            var native = NativeInput.ToNative(records);
            return (int)NativeInput.SendInput((uint)native.Length, native, Marshal.SizeOf(typeof(NativeInput.INPUT)));
        }
    }
#endif

    // Tests: each SendInput call's records as JSON lines ("b" numbers the calls), appended to a file.
    class RecordingBackend : IInputBackend
    {
        readonly string path;
        int batch;

        public RecordingBackend(string path) { this.path = path; }

        public string Name { get { return "recording"; } }

        public int Send(InputRecord[] records)
        {
            if (records.Length == 0) return 0;
            batch++;
            var sb = new StringBuilder();
            foreach (var r in records) sb.Append(r.ToJson(batch)).Append('\n');
            try { File.AppendAllText(path, sb.ToString(), new UTF8Encoding(false)); }
            catch { return 0; }
            return records.Length;
        }
    }

    // ------------------------------------------------------------------ screens

    class ScreenInfo
    {
        public int Id;           // the order WebRTC lists screens in ("Screen <Id+1>"; a lone screen is "Entire screen")
        public string Device;    // \\.\DISPLAY1
        public int X, Y, W, H;   // physical pixels (Beam is Per-Monitor-V2), relative to the primary screen's corner
        public bool Primary;
        public double Scale;     // 1.25 at 120 DPI
    }

    class DesktopLayout
    {
        public readonly List<ScreenInfo> Screens = new List<ScreenInfo>();
        public int X, Y, W, H;   // the virtual desktop (SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN)

        public ScreenInfo Screen(int id)
        {
            foreach (var s in Screens) if (s.Id == id) return s;
            return null;
        }

        public ScreenInfo Primary
        {
            get
            {
                foreach (var s in Screens) if (s.Primary) return s;
                return Screens.Count > 0 ? Screens[0] : null;
            }
        }

        // The source name the capture host auto-selects for a screen.
        public string SourceName(int id)
        {
            return Screens.Count <= 1 ? "Entire screen" : "Screen " + (id + 1).ToString(CultureInfo.InvariantCulture);
        }

        // Screens in EnumDisplayDevices order (as WebRTC numbers them), with their rectangles from EnumDisplayMonitors.
        public static DesktopLayout Current()
        {
            var layout = new DesktopLayout();
            var found = new List<ScreenInfo>();
            Win.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr hm, IntPtr hdc, ref Win.RECT rc, IntPtr data) =>
            {
                var mi = new Win.MONITORINFOEX();
                mi.cbSize = Marshal.SizeOf(typeof(Win.MONITORINFOEX));
                if (!Win.GetMonitorInfo(hm, ref mi)) return true;
                var s = new ScreenInfo();
                s.Device = mi.szDevice;
                s.X = mi.rcMonitor.Left;
                s.Y = mi.rcMonitor.Top;
                s.W = mi.rcMonitor.Right - mi.rcMonitor.Left;
                s.H = mi.rcMonitor.Bottom - mi.rcMonitor.Top;
                s.Primary = (mi.dwFlags & 1) != 0;
                uint dx = 96, dy = 96;
                try { if (Win.GetDpiForMonitor(hm, 0, out dx, out dy) != 0) dx = 96; } catch { dx = 96; }
                s.Scale = dx / 96.0;
                found.Add(s);
                return true;
            }, IntPtr.Zero);
            var order = new List<string>();
            var dd = new Win.DISPLAY_DEVICE();
            dd.cb = Marshal.SizeOf(typeof(Win.DISPLAY_DEVICE));
            for (uint i = 0; i < 64 && Win.EnumDisplayDevices(null, i, ref dd, 0); i++)
            {
                if ((dd.StateFlags & 1) != 0) order.Add(dd.DeviceName); // DISPLAY_DEVICE_ATTACHED_TO_DESKTOP
                dd.cb = Marshal.SizeOf(typeof(Win.DISPLAY_DEVICE));
            }
            found.Sort((a, b) =>
            {
                int ia = order.FindIndex(n => string.Equals(n, a.Device, StringComparison.OrdinalIgnoreCase));
                int ib = order.FindIndex(n => string.Equals(n, b.Device, StringComparison.OrdinalIgnoreCase));
                if (ia < 0) ia = int.MaxValue;
                if (ib < 0) ib = int.MaxValue;
                return ia.CompareTo(ib);
            });
            for (int i = 0; i < found.Count; i++) { found[i].Id = i; layout.Screens.Add(found[i]); }
            layout.X = Win.GetSystemMetrics(76);
            layout.Y = Win.GetSystemMetrics(77);
            layout.W = Win.GetSystemMetrics(78);
            layout.H = Win.GetSystemMetrics(79);
            return layout;
        }

        static class Win
        {
            [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
            [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
            public struct MONITORINFOEX { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice; }
            [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
            public struct DISPLAY_DEVICE
            {
                public int cb;
                [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
                [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
                public uint StateFlags;
                [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
                [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
            }
            public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT rc, IntPtr data);
            [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
            [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr hm, ref MONITORINFOEX mi);
            [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool EnumDisplayDevices(string device, uint index, ref DISPLAY_DEVICE dd, uint flags);
            [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hm, int type, out uint x, out uint y);
            [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
        }
    }

    // ------------------------------------------------------------------ keys

    // A key as Windows takes it: by set-1 scancode (Vk 0), or by virtual key (with its scancode for apps that read it).
    class KeyDef
    {
        public string Code;     // KeyboardEvent.code
        public ushort Scan;
        public bool Extended;
        public ushort Vk;

        public InputRecord Record(bool down)
        {
            var r = new InputRecord();
            r.Type = InputRecord.Keyboard;
            r.Scan = Scan;
            r.Vk = Vk;
            r.Flags = (Vk == 0 ? InputInjector.SCANCODE : 0) | (Extended ? InputInjector.EXTENDEDKEY : 0) | (down ? 0 : InputInjector.KEYUP);
            return r;
        }
    }

    static class KeyMap
    {
        // KeyboardEvent.code → the Windows set-1 scancode, from Chromium's dom_code_data.inc (the Win column);
        // E0xx is an extended key. Left out on purpose: Power, Sleep and WakeUp.
        static readonly string[] Table =
        {
            "KeyA 1E", "KeyB 30", "KeyC 2E", "KeyD 20", "KeyE 12", "KeyF 21", "KeyG 22", "KeyH 23", "KeyI 17", "KeyJ 24",
            "KeyK 25", "KeyL 26", "KeyM 32", "KeyN 31", "KeyO 18", "KeyP 19", "KeyQ 10", "KeyR 13", "KeyS 1F", "KeyT 14",
            "KeyU 16", "KeyV 2F", "KeyW 11", "KeyX 2D", "KeyY 15", "KeyZ 2C",
            "Digit1 02", "Digit2 03", "Digit3 04", "Digit4 05", "Digit5 06", "Digit6 07", "Digit7 08", "Digit8 09", "Digit9 0A", "Digit0 0B",
            "Enter 1C", "Escape 01", "Backspace 0E", "Tab 0F", "Space 39", "Minus 0C", "Equal 0D", "BracketLeft 1A",
            "BracketRight 1B", "Backslash 2B", "Semicolon 27", "Quote 28", "Backquote 29", "Comma 33", "Period 34", "Slash 35",
            "CapsLock 3A", "F1 3B", "F2 3C", "F3 3D", "F4 3E", "F5 3F", "F6 40", "F7 41", "F8 42", "F9 43", "F10 44", "F11 57",
            "F12 58", "F13 64", "F14 65", "F15 66", "F16 67", "F17 68", "F18 69", "F19 6A", "F20 6B", "F21 6C", "F22 6D",
            "F23 6E", "F24 76",
            "PrintScreen E037", "ScrollLock 46", "Insert E052", "Home E047", "PageUp E049", "Delete E053", "End E04F",
            "PageDown E051", "ArrowRight E04D", "ArrowLeft E04B", "ArrowDown E050", "ArrowUp E048",
            "NumpadDivide E035", "NumpadMultiply 37", "NumpadSubtract 4A", "NumpadAdd 4E", "NumpadEnter E01C", "Numpad1 4F",
            "Numpad2 50", "Numpad3 51", "Numpad4 4B", "Numpad5 4C", "Numpad6 4D", "Numpad7 47", "Numpad8 48", "Numpad9 49",
            "Numpad0 52", "NumpadDecimal 53", "NumpadEqual 59", "NumpadComma 7E",
            "IntlBackslash 56", "IntlRo 73", "IntlYen 7D", "KanaMode 70", "Convert 79", "NonConvert 7B", "Lang1 72", "Lang2 71",
            "ContextMenu E05D",
            "ControlLeft 1D", "ShiftLeft 2A", "AltLeft 38", "ControlRight E01D", "ShiftRight 36", "AltRight E038",
            "MediaTrackNext E019", "MediaTrackPrevious E010", "MediaStop E024", "MediaPlayPause E022", "AudioVolumeMute E020",
            "AudioVolumeUp E030", "AudioVolumeDown E02E", "BrowserSearch E065", "BrowserHome E032", "BrowserBack E06A",
            "BrowserForward E069", "BrowserStop E068", "BrowserRefresh E067", "BrowserFavorites E066",
        };

        static readonly Dictionary<string, KeyDef> byCode = Build();
        static readonly Dictionary<int, string> byScan = new Dictionary<int, string>();

        static Dictionary<string, KeyDef> Build()
        {
            var d = new Dictionary<string, KeyDef>(StringComparer.Ordinal);
            foreach (string row in Table)
            {
                int sp = row.IndexOf(' ');
                int v = int.Parse(row.Substring(sp + 1), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
                var k = new KeyDef();
                k.Code = row.Substring(0, sp);
                k.Scan = (ushort)(v & 0xFF);
                k.Extended = (v & 0xFF00) == 0xE000;
                d[k.Code] = k;
            }
            // By virtual key (research §4.4): the Win keys (as Sunshine does), Pause and NumLock (scancode 0x45 is both,
            // told apart only by the extended flag).
            Add(d, "MetaLeft", 0x5B, 0x5B, true);
            Add(d, "MetaRight", 0x5C, 0x5C, true);
            Add(d, "Pause", 0x13, 0x45, false);
            Add(d, "NumLock", 0x90, 0x45, true);
            return d;
        }

        static void Add(Dictionary<string, KeyDef> d, string code, ushort vk, ushort scan, bool ext)
        {
            var k = new KeyDef();
            k.Code = code;
            k.Vk = vk;
            k.Scan = scan;
            k.Extended = ext;
            d[code] = k;
        }

        public static KeyDef Find(string code)
        {
            KeyDef k;
            return code != null && byCode.TryGetValue(code, out k) ? k : null;
        }

        // The other way (a low-level keyboard hook's vkCode, scanCode and extended flag): the KeyboardEvent.code, or null.
        public static string CodeOf(int vk, int scan, bool extended)
        {
            switch (vk)
            {
                case 0x5B: return "MetaLeft";
                case 0x5C: return "MetaRight";
                case 0x13: return "Pause";
                case 0x90: return "NumLock";
            }
            lock (byScan)
            {
                if (byScan.Count == 0)
                    foreach (var k in byCode.Values)
                        if (k.Vk == 0) byScan[(k.Extended ? 0xE000 : 0) | k.Scan] = k.Code;
                string code;
                return byScan.TryGetValue((extended ? 0xE000 : 0) | (scan & 0xFF), out code) ? code : null;
            }
        }
    }

    // ------------------------------------------------------------------ the injector

    class InputInjector
    {
        // MOUSEEVENTF_*
        public const uint MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010,
            MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040, XDOWN = 0x0080, XUP = 0x0100, WHEEL = 0x0800, HWHEEL = 0x1000,
            VIRTUALDESK = 0x4000, ABSOLUTE = 0x8000;
        public const int XBUTTON1 = 1, XBUTTON2 = 2;
        // KEYEVENTF_*
        public const uint EXTENDEDKEY = 0x0001, KEYUP = 0x0002, UNICODE = 0x0004, SCANCODE = 0x0008;

        public const int AltGrWindowMs = 50;   // a ControlLeft this close before AltRight is the browser's fake one
        public const int MaxText = 1000;       // UTF-16 units per text message
        public const int MaxWheel = 1200;      // ten notches per message
        const double InRate = 400, MvRate = 250; // messages a second (downs, wheel and text past it are dropped)
        public const double RepeatRate = 50;      // repeats of one held key a second (a keyboard's own repeat is ~30)

        readonly IInputBackend backend;
        readonly Func<DesktopLayout> layoutSource;
        readonly Func<long> clock;              // milliseconds
        DesktopLayout layout;
        long layoutAt = long.MinValue;
        readonly List<KeyDef> heldKeys = new List<KeyDef>();
        readonly List<int> heldButtons = new List<int>();
        long lastMv = -1;                      // the newest mv applied (btn and wheel advance it too)
        double wheelX, wheelY;                 // what's left over of a wheel step
        bool ctrlPending;                      // a ControlLeft down held back (it may be AltGr's fake one)
        long ctrlAt;
        readonly Bucket inBucket = new Bucket(InRate), mvBucket = new Bucket(MvRate);

        public int Screen;                     // the screen being captured (ScreenInfo.Id): coordinates are within it
        public bool AnyScreen;                 // (1.12) a kvm session: a point names its screen (`m`), any of this PC's
        public long Injected, Dropped;
        public Action<string> Note;            // rare events for beam.log (never keys or text)
        public Func<KeyDef, int> VirtualKeyOf;  // the virtual key a key makes in this PC's layout now (Win+L by key, any layout)
        readonly Dictionary<string, Bucket> repeats = new Dictionary<string, Bucket>(); // per held key

        public InputInjector(IInputBackend backend, Func<DesktopLayout> layoutSource, Func<long> clock)
        {
            this.backend = backend;
            this.layoutSource = layoutSource;
            this.clock = clock;
        }

        // (1.12.1) Handle and Flush run on the session page's own thread (RcThread), the rest on the UI thread: one lock.
        // Stopped (the session ended) it takes nothing more until the next connection.
        readonly object sync = new object();
        bool stopped;

        public string BackendName { get { return backend.Name; } }
        public bool Holding { get { lock (sync) return heldKeys.Count > 0 || heldButtons.Count > 0; } }
        public bool HasPending { get { lock (sync) return ctrlPending; } }

        public DesktopLayout Layout
        {
            get
            {
                long now = clock();
                if (layout == null || now - layoutAt > 1000 || now < layoutAt)
                {
                    layout = layoutSource();
                    layoutAt = now;
                }
                return layout;
            }
        }

        public void LayoutChanged() { lock (sync) layout = null; }

        // A new connection (another screen, a reconnect): its mv numbers start again, and input is taken again.
        public void NewConnection() { lock (sync) { lastMv = -1; stopped = false; } }

        // One message from the `in` or `mv` channel, parsed.
        public void Handle(Dictionary<string, object> m)
        {
            if (m == null) return;
            lock (sync)
            {
                if (stopped) { Dropped++; return; }
                string t = Str(m, "t");
                switch (t)
                {
                    case "mv": Move(m); break;
                    case "btn": Button(m); break;
                    case "wheel": Wheel(m); break;
                    case "key": Key(m); break;
                    case "text": Text(m); break;
                    case "release": ReleaseAll("the viewer let go"); break;
                    default: Dropped++; break;
                }
            }
        }

        // The AltGr window has passed: a held-back ControlLeft goes now (the owner's timer calls this).
        public void Flush()
        {
            lock (sync) if (!stopped && ctrlPending && clock() - ctrlAt > AltGrWindowMs) PressPendingCtrl();
        }

        // The session ended: everything held is let go, and nothing more is taken until NewConnection (a message the
        // page's thread is handling right now goes first: the lock).
        public int Stop(string why)
        {
            lock (sync) { stopped = true; return ReleaseAll(why); }
        }

        // Lets go of every key and button pressed here. Returns how many INPUTs that took.
        public int ReleaseAll(string why)
        {
            lock (sync) return ReleaseAllLocked(why);
        }

        int ReleaseAllLocked(string why)
        {
            ctrlPending = false;
            wheelX = wheelY = 0;
            var list = new List<InputRecord>();
            for (int i = heldKeys.Count - 1; i >= 0; i--) list.Add(heldKeys[i].Record(false));
            foreach (int b in heldButtons) list.Add(ButtonRecord(b, false, null));
            heldKeys.Clear();
            repeats.Clear();
            heldButtons.Clear();
            if (list.Count == 0) return 0;
            Send(list.ToArray());
            if (Note != null) Note("let go of " + list.Count + " held key(s) and button(s) (" + why + ")");
            return list.Count;
        }

        // ---------------------------------------------------------------- pointer

        void Move(Dictionary<string, object> m)
        {
            long n = Long(m, "n", -1);
            if (n >= 0)
            {
                if (n <= lastMv) { Dropped++; return; } // an older one overtook a newer one (mv is unordered)
                lastMv = n;
            }
            object scr;
            if (!AnyScreen && m.TryGetValue("m", out scr) && scr != null && Long(m, "m", -1) != Screen) { Dropped++; return; } // a screen switch
            if (!mvBucket.Take(clock())) { Dropped++; return; }
            InputRecord r;
            if (!PointRecord(m, out r)) { Dropped++; return; }
            Send(new[] { r });
        }

        void Button(Dictionary<string, object> m)
        {
            long n = Long(m, "n", -1);
            if (n > lastMv) lastMv = n;
            int b = (int)Long(m, "b", -1);
            object dv;
            bool down = m.TryGetValue("d", out dv) && dv is bool && (bool)dv;
            if (b < 0 || b > 4) { Dropped++; return; }
            FlushBeforeOther();
            if (down)
            {
                if (heldButtons.Contains(b)) return;
                if (!inBucket.Take(clock())) { Dropped++; return; }
            }
            else if (!heldButtons.Contains(b)) return; // never let go of what the viewer didn't press here
            InputRecord at;
            bool hasPoint = PointRecord(m, out at);
            Send(new[] { ButtonRecord(b, down, hasPoint ? (InputRecord?)at : null) });
            if (down) heldButtons.Add(b); else heldButtons.Remove(b);
        }

        static InputRecord ButtonRecord(int b, bool down, InputRecord? at)
        {
            var r = at.HasValue ? at.Value : new InputRecord();
            r.Type = InputRecord.Mouse;
            switch (b)
            {
                case 0: r.Flags |= down ? LEFTDOWN : LEFTUP; break;
                case 1: r.Flags |= down ? MIDDLEDOWN : MIDDLEUP; break;
                case 2: r.Flags |= down ? RIGHTDOWN : RIGHTUP; break;
                default: r.Flags |= down ? XDOWN : XUP; r.MouseData = b == 3 ? XBUTTON1 : XBUTTON2; break;
            }
            return r;
        }

        void Wheel(Dictionary<string, object> m)
        {
            long n = Long(m, "n", -1);
            if (n > lastMv) lastMv = n;
            FlushBeforeOther();
            if (!inBucket.Take(clock())) { Dropped++; return; }
            double dx = Num(m, "dx"), dy = Num(m, "dy");
            if (double.IsNaN(dx) || double.IsInfinity(dx)) dx = 0;
            if (double.IsNaN(dy) || double.IsInfinity(dy)) dy = 0;
            wheelX = Clamp(wheelX + dx, MaxWheel);
            wheelY = Clamp(wheelY + dy, MaxWheel);
            int sx = (int)wheelX, sy = (int)wheelY; // whole units go; fractions wait for more
            wheelX -= sx;
            wheelY -= sy;
            if (sx == 0 && sy == 0) return;
            InputRecord at;
            bool hasPoint = PointRecord(m, out at);
            var list = new List<InputRecord>();
            if (sy != 0)
            {
                var r = hasPoint ? at : new InputRecord();
                r.Type = InputRecord.Mouse;
                r.Flags |= WHEEL;
                r.MouseData = -sy; // the browser's down is positive; Windows' forward (up) is
                list.Add(r);
                hasPoint = false;
            }
            if (sx != 0)
            {
                var r = hasPoint ? at : new InputRecord();
                r.Type = InputRecord.Mouse;
                r.Flags |= HWHEEL;
                r.MouseData = sx; // right is positive in both
                list.Add(r);
            }
            Send(list.ToArray());
        }

        static double Clamp(double v, double max) { return v > max ? max : v < -max ? -max : v; }

        // A move to (x, y) on the captured screen, clamped to it. (AnyScreen: on the screen `m` names; one this PC
        // doesn't have now is dropped.)
        bool PointRecord(Dictionary<string, object> m, out InputRecord r)
        {
            r = new InputRecord();
            double x = Num(m, "x"), y = Num(m, "y");
            if (double.IsNaN(x) || double.IsNaN(y) || Math.Abs(x) > 1e6 || Math.Abs(y) > 1e6) return false;
            var l = Layout;
            long named = AnyScreen ? Long(m, "m", -1) : -1;
            var s = l == null ? null : named >= 0 ? (named < 64 ? l.Screen((int)named) : null) : l.Screen(Screen) ?? l.Primary;
            if (s == null || l.W <= 0 || l.H <= 0) return false;
            int px = Math.Max(0, Math.Min(s.W - 1, (int)Math.Floor(x)));
            int py = Math.Max(0, Math.Min(s.H - 1, (int)Math.Floor(y)));
            r.Type = InputRecord.Mouse;
            r.Dx = Absolute(s.X + px - l.X, l.W);
            r.Dy = Absolute(s.Y + py - l.Y, l.H);
            r.Flags = MOVE | ABSOLUTE | VIRTUALDESK;
            return true;
        }

        // A pixel of the virtual desktop (0 = its left/top edge) → the 0..65535 that SendInput takes. Windows maps back
        // with pixel = abs * size / 65536, so this is the smallest abs that lands on exactly that pixel (65535-based
        // formulas end up a pixel off near the top-left).
        public static int Absolute(int p, int size)
        {
            if (size <= 1) return 0;
            if (p < 0) p = 0;
            if (p > size - 1) p = size - 1;
            long a = ((long)p * 65536 + size - 1) / size;
            return (int)Math.Min(65535, a);
        }

        // ---------------------------------------------------------------- keys

        void Key(Dictionary<string, object> m)
        {
            string code = Str(m, "c");
            object dv;
            bool down = m.TryGetValue("d", out dv) && dv is bool && (bool)dv;
            var k = KeyMap.Find(code);
            if (k == null) { Dropped++; FlushBeforeOther(); return; }
            long now = clock();
            if (ctrlPending)
            {
                if (code == "AltRight" && down && now - ctrlAt <= AltGrWindowMs)
                {
                    ctrlPending = false; // AltGr: the browser's fake ControlLeft goes; this PC's layout adds its own
                    if (Note != null) Note("AltGr");
                }
                else PressPendingCtrl();
            }
            bool held = IsHeld(code);
            if (down)
            {
                if (code == "ControlLeft" && !held) { ctrlPending = true; ctrlAt = now; return; }
                if ((IsHeld("MetaLeft") || IsHeld("MetaRight")) && (code == "KeyL" || (VirtualKeyOf != null && VirtualKeyOf(k) == 0x4C)))
                {
                    // Win+L (by its key in this PC's layout, or the L key itself) would lock this PC and end the
                    // session: the viewer has a Lock action instead.
                    Dropped++;
                    if (Note != null) Note("Win+L isn't passed on");
                    return;
                }
                if (!inBucket.Take(now)) { Dropped++; return; } // repeats count too
                Bucket rep;
                if (held && repeats.TryGetValue(code, out rep) && !rep.Take(now)) { Dropped++; return; }
                Send(new[] { k.Record(true) }); // again while held: key repeat
                if (!held) { heldKeys.Add(k); repeats[code] = new Bucket(RepeatRate); }
                return;
            }
            if (!held) return; // never let go of what the viewer didn't press here
            Send(new[] { k.Record(false) });
            RemoveHeld(code);
            repeats.Remove(code);
        }

        void PressPendingCtrl()
        {
            ctrlPending = false;
            var k = KeyMap.Find("ControlLeft");
            Send(new[] { k.Record(true) });
            if (!IsHeld("ControlLeft")) heldKeys.Add(k);
        }

        // Anything but a move: a held-back ControlLeft can't be AltGr's any more.
        void FlushBeforeOther()
        {
            if (ctrlPending) PressPendingCtrl();
        }

        bool IsHeld(string code)
        {
            foreach (var k in heldKeys) if (k.Code == code) return true;
            return false;
        }

        void RemoveHeld(string code)
        {
            heldKeys.RemoveAll(k => k.Code == code);
        }

        // Committed text (IME, phone keyboards): KEYEVENTF_UNICODE, each character's units down then up; line breaks and
        // tabs as Enter and Tab; other control characters are dropped.
        void Text(Dictionary<string, object> m)
        {
            FlushBeforeOther();
            string s = Str(m, "s");
            if (string.IsNullOrEmpty(s)) return;
            if (!inBucket.Take(clock())) { Dropped++; return; }
            if (s.Length > MaxText) s = s.Substring(0, MaxText);
            var list = new List<InputRecord>();
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                if (c == '\r' || c == '\n')
                {
                    if (c == '\r' && i + 1 < s.Length && s[i + 1] == '\n') i++;
                    Press(list, KeyMap.Find("Enter"));
                    continue;
                }
                if (c == '\t') { Press(list, KeyMap.Find("Tab")); continue; }
                if (c < 0x20 || c == 0x7F) continue;
                int units = char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]) ? 2 : 1;
                if (units == 1 && char.IsSurrogate(c)) continue; // half a pair
                for (int u = 0; u < units; u++) list.Add(UnicodeRecord(s[i + u], true));
                for (int u = 0; u < units; u++) list.Add(UnicodeRecord(s[i + u], false));
                i += units - 1;
            }
            if (list.Count > 0) Send(list.ToArray());
        }

        static void Press(List<InputRecord> list, KeyDef k)
        {
            list.Add(k.Record(true));
            list.Add(k.Record(false));
        }

        static InputRecord UnicodeRecord(char c, bool down)
        {
            var r = new InputRecord();
            r.Type = InputRecord.Keyboard;
            r.Scan = c;
            r.Flags = UNICODE | (down ? 0 : KEYUP);
            return r;
        }

        void Send(InputRecord[] records)
        {
            Injected += backend.Send(records);
        }

        // ---------------------------------------------------------------- message fields

        static string Str(Dictionary<string, object> m, string key)
        {
            object v;
            return m.TryGetValue(key, out v) ? v as string : null;
        }

        static double Num(Dictionary<string, object> m, string key)
        {
            object v;
            if (!m.TryGetValue(key, out v) || v == null || v is string || v is bool) return double.NaN;
            try { return Convert.ToDouble(v, CultureInfo.InvariantCulture); }
            catch { return double.NaN; }
        }

        static long Long(Dictionary<string, object> m, string key, long fallback)
        {
            double d = Num(m, key);
            if (double.IsNaN(d) || double.IsInfinity(d) || Math.Abs(d) > 9e15) return fallback;
            return (long)Math.Floor(d);
        }

        // A token bucket: `rate` a second, bursts of up to a second's worth.
        class Bucket
        {
            readonly double rate;
            double tokens;
            long at = long.MinValue;

            public Bucket(double rate) { this.rate = rate; tokens = rate; }

            public bool Take(long now)
            {
                if (at != long.MinValue && now > at) tokens = Math.Min(rate, tokens + (now - at) * rate / 1000.0);
                at = now;
                if (tokens < 1) return false;
                tokens -= 1;
                return true;
            }
        }
    }

    // ------------------------------------------------------------------ what input can reach (for the viewer's state)

    static class InputTarget
    {
        static int ownLevel = -1;

        // The foreground window's process runs at a higher integrity level (as administrator): Windows silently drops
        // input injected into it (UIPI). A process that can't even be opened counts as one. (1.12.3) Only a window that
        // can be seen: a hidden one isn't in front of anything (the user's Desktop had the GameInput service's hidden
        // window as its foreground; the viewer held every click as "an administrator window is in front", so nothing
        // could be clicked to bring a window forward again).
        public static bool ForegroundElevated()
        {
            try
            {
                IntPtr w = GetForegroundWindow();
                if (w == IntPtr.Zero || !IsWindowVisible(w) || Cloaked(w)) return false;
                uint pid;
                GetWindowThreadProcessId(w, out pid);
                if (pid == 0 || pid == (uint)Process.GetCurrentProcess().Id) return false;
                if (ownLevel < 0) ownLevel = LevelOf(GetCurrentProcess());
                int level = LevelOf(IntPtr.Zero, pid);
                return level < 0 || level > ownLevel;
            }
            catch { return false; }
        }

        static int LevelOf(IntPtr process, uint pid = 0)
        {
            bool close = false;
            if (process == IntPtr.Zero)
            {
                process = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
                if (process == IntPtr.Zero) return -1;
                close = true;
            }
            try
            {
                IntPtr token;
                if (!OpenProcessToken(process, 0x0008 /* TOKEN_QUERY */, out token)) return -1;
                try
                {
                    int size;
                    GetTokenInformation(token, 25 /* TokenIntegrityLevel */, IntPtr.Zero, 0, out size);
                    if (size <= 0) return -1;
                    IntPtr buf = Marshal.AllocHGlobal(size);
                    try
                    {
                        if (!GetTokenInformation(token, 25, buf, size, out size)) return -1;
                        IntPtr sid = Marshal.ReadIntPtr(buf); // TOKEN_MANDATORY_LABEL.Label.Sid
                        int count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
                        return Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
                    }
                    finally { Marshal.FreeHGlobal(buf); }
                }
                finally { CloseHandle(token); }
            }
            finally { if (close) CloseHandle(process); }
        }

        // The virtual key this key makes in the keyboard layout of the window in front (Win+L is a virtual-key hotkey,
        // so on Dvorak or Colemak another key than L makes it). 0 when unknown.
        public static int VirtualKeyOf(KeyDef k)
        {
            if (k.Vk != 0) return k.Vk;
            try
            {
                uint pid;
                uint thread = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
                IntPtr layout = GetKeyboardLayout(thread);
                return (int)MapVirtualKeyEx((uint)((k.Extended ? 0xE000 : 0) | k.Scan), 3 /* MAPVK_VSC_TO_VK_EX */, layout);
            }
            catch { return 0; }
        }

        // A secure desktop is up (a UAC prompt, the lock or sign-in screen): this session's input goes nowhere.
        public static bool SecureDesktop()
        {
            try
            {
                IntPtr d = OpenInputDesktop(0, false, 0x0100 /* DESKTOP_SWITCHDESKTOP */);
                if (d == IntPtr.Zero) return true; // the Winlogon desktop can't be opened from a user's process
                try
                {
                    var name = new StringBuilder(256);
                    int needed;
                    if (!GetUserObjectInformation(d, 2 /* UOI_NAME */, name, name.Capacity * 2, out needed)) return false;
                    return !string.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
                }
                finally { CloseDesktop(d); }
            }
            catch { return false; }
        }

        // A window the compositor hides (a suspended app's, one on another virtual desktop) though Windows calls it visible.
        static bool Cloaked(IntPtr w)
        {
            try { int c; return DwmGetWindowAttribute(w, 14 /* DWMWA_CLOAKED */, out c, 4) == 0 && c != 0; }
            catch { return false; }
        }

        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
        [DllImport("user32.dll")] static extern IntPtr GetKeyboardLayout(uint thread);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint MapVirtualKeyEx(uint code, uint mapType, IntPtr layout);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr info, int length, out int returned);
        [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
        [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder info, int length, out int needed);
    }
}
