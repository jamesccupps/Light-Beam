// Beam for Windows 1.6: the remote control input mapping, checked INPUT by INPUT. Run by windows-input-test.mjs, which
// compiles this file with windows\src\InputInjector.cs and RcPolicy.cs and /define:NO_REAL_INPUT: the binary has no
// SendInput at all (the runner checks), so nothing here can reach the real keyboard or mouse. The backend records the
// INPUT records; the screen layouts are made up (several monitors, mixed DPI, negative coordinates).
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

namespace Beam
{
    class MemoryBackend : IInputBackend
    {
        public readonly List<InputRecord[]> Batches = new List<InputRecord[]>();
        public string Name { get { return "memory"; } }
        public int Send(InputRecord[] records) { Batches.Add(records); return records.Length; }
        public List<InputRecord> All() { return Batches.SelectMany(b => b).ToList(); }
        public void Clear() { Batches.Clear(); }
    }

    static class InputTest
    {
        static int failures, passed;
        static long now = 1000;
        static readonly JavaScriptSerializer json = new JavaScriptSerializer();

        static void Check(bool ok, string what)
        {
            if (ok) passed++; else { failures++; Console.WriteLine("FAIL " + what); }
        }

        static void Section(string name, int before)
        {
            Console.WriteLine((failures == before ? "ok   " : "FAIL ") + name);
        }

        static Dictionary<string, object> Msg(string s) { return (Dictionary<string, object>)json.DeserializeObject(s); }

        static ScreenInfo Scr(int id, int x, int y, int w, int h, bool primary, double scale)
        {
            var s = new ScreenInfo();
            s.Id = id; s.X = x; s.Y = y; s.W = w; s.H = h; s.Primary = primary; s.Scale = scale; s.Device = "\\\\.\\DISPLAY" + (id + 1);
            return s;
        }

        static DesktopLayout Layout(params ScreenInfo[] screens)
        {
            var l = new DesktopLayout();
            l.Screens.AddRange(screens);
            l.X = screens.Min(s => s.X);
            l.Y = screens.Min(s => s.Y);
            l.W = screens.Max(s => s.X + s.W) - l.X;
            l.H = screens.Max(s => s.Y + s.H) - l.Y;
            return l;
        }

        static InputInjector Injector(MemoryBackend b, DesktopLayout l)
        {
            return new InputInjector(b, () => l, () => now);
        }

        static string Desc(InputRecord r) { return r.ToJson(0); }

        static bool Key(InputRecord r, ushort vk, ushort scan, uint flags)
        {
            return r.Type == InputRecord.Keyboard && r.Vk == vk && r.Scan == scan && r.Flags == flags;
        }

        // Where Windows puts the pointer for an absolute coordinate: pixel = abs * size / 65536 (+ the desktop's origin).
        static int Back(int abs, int origin, int size) { return origin + (int)((long)abs * size / 65536); }

        static int Main()
        {
            const uint S = InputInjector.SCANCODE, E = InputInjector.EXTENDEDKEY, U = InputInjector.KEYUP, UNI = InputInjector.UNICODE;
            const uint MOVE = InputInjector.MOVE | InputInjector.ABSOLUTE | InputInjector.VIRTUALDESK;

            // ---------------------------------------------------------------- the native INPUT layout
            int f0 = failures;
            int size = Marshal.SizeOf(typeof(NativeInput.INPUT));
            Check(size == (IntPtr.Size == 8 ? 40 : 28), "sizeof(INPUT) is " + size);
            Check(Marshal.OffsetOf(typeof(NativeInput.INPUT), "u").ToInt32() == (IntPtr.Size == 8 ? 8 : 4), "the union is pointer-aligned");
            Check(Marshal.OffsetOf(typeof(NativeInput.MOUSEINPUT), "dwFlags").ToInt32() == 12, "MOUSEINPUT.dwFlags at 12");
            Check(Marshal.OffsetOf(typeof(NativeInput.KEYBDINPUT), "dwFlags").ToInt32() == 4, "KEYBDINPUT.dwFlags at 4");
            var nat = NativeInput.ToNative(new[]
            {
                new InputRecord { Type = InputRecord.Mouse, Dx = 123, Dy = 456, MouseData = -120, Flags = MOVE | InputInjector.WHEEL },
                new InputRecord { Type = InputRecord.Keyboard, Vk = 0, Scan = 0x1E, Flags = S | U },
            });
            Check(nat[0].type == 0 && nat[0].u.mi.dx == 123 && nat[0].u.mi.dy == 456 && nat[0].u.mi.mouseData == 0xFFFFFF88 && nat[0].u.mi.dwFlags == (MOVE | 0x0800), "a mouse INPUT, negative wheel as DWORD");
            Check(nat[1].type == 1 && nat[1].u.ki.wVk == 0 && nat[1].u.ki.wScan == 0x1E && nat[1].u.ki.dwFlags == (S | U), "a keyboard INPUT");
            Check(nat[0].u.mi.time == 0 && nat[0].u.mi.dwExtraInfo == IntPtr.Zero, "time and extra info are left to Windows");
            Section("the native INPUT structure (" + size + " bytes)", f0);

            // ---------------------------------------------------------------- absolute coordinates land on the pixel
            f0 = failures;
            foreach (int w in new[] { 1, 2, 3, 640, 1080, 1366, 1440, 1920, 2160, 2560, 3840, 4480, 5760, 7680, 11520, 65535 })
            {
                bool allOk = true;
                for (int p = 0; p < w; p++)
                {
                    int a = InputInjector.Absolute(p, w);
                    if (a < 0 || a > 65535 || (w > 1 && Back(a, 0, w) != p)) { allOk = false; Check(false, "pixel " + p + " of " + w + " → " + a + " → " + Back(a, 0, w)); break; }
                }
                Check(allOk, "every pixel of " + w);
            }
            Check(InputInjector.Absolute(-10, 1920) == 0 && InputInjector.Absolute(5000, 1920) == InputInjector.Absolute(1919, 1920), "out of range clamps");
            Check(InputInjector.Absolute(1, 1920) == 35, "x=1 of 1920 is 35 (34 would land on pixel 0)");
            Section("absolute coordinates: every pixel round-trips (pixel = abs * size / 65536)", f0);

            // ---------------------------------------------------------------- several monitors, mixed DPI
            f0 = failures;
            var layouts = new Dictionary<string, DesktopLayout>
            {
                { "side by side, 125 % + 100 %, the second lower", Layout(Scr(0, 0, 0, 2560, 1440, true, 1.25), Scr(1, 2560, 180, 1920, 1080, false, 1.0)) },
                { "a 4K primary at 150 % with a screen to its left (negative x)", Layout(Scr(0, -1920, 0, 1920, 1080, false, 1.0), Scr(1, 0, 0, 3840, 2160, true, 1.5)) },
                { "stacked, the second above (negative y), 175 %", Layout(Scr(0, 0, -1440, 2560, 1440, false, 1.75), Scr(1, 0, 0, 1920, 1080, true, 1.0)) },
                { "three screens, a portrait one", Layout(Scr(0, 0, 0, 1920, 1080, true, 1.0), Scr(1, 1920, -420, 1080, 1920, false, 1.0), Scr(2, -2560, 100, 2560, 1600, false, 1.25)) },
            };
            foreach (var kv in layouts)
            {
                var l = kv.Value;
                var b = new MemoryBackend();
                var inj = Injector(b, l);
                bool ok = true;
                long n = 0;
                foreach (var s in l.Screens)
                {
                    inj.Screen = s.Id;
                    inj.NewConnection();
                    n = 0;
                    var points = new[] { new[] { 0, 0 }, new[] { s.W - 1, s.H - 1 }, new[] { s.W / 2, s.H / 2 }, new[] { 1, 1 }, new[] { s.W - 2, 3 }, new[] { 7, s.H - 9 } };
                    foreach (var p in points)
                    {
                        b.Clear();
                        inj.Handle(Msg("{\"t\":\"mv\",\"n\":" + (++n) + ",\"x\":" + p[0] + ",\"y\":" + p[1] + ",\"m\":" + s.Id + "}"));
                        var r = b.All();
                        if (r.Count != 1 || r[0].Flags != MOVE) { ok = false; Check(false, kv.Key + ": one absolute move"); continue; }
                        int px = Back(r[0].Dx, l.X, l.W), py = Back(r[0].Dy, l.Y, l.H);
                        if (px != s.X + p[0] || py != s.Y + p[1])
                        {
                            ok = false;
                            Check(false, kv.Key + ": screen " + s.Id + " (" + p[0] + "," + p[1] + ") → (" + r[0].Dx + "," + r[0].Dy + ") → desktop (" + px + "," + py + "), want (" + (s.X + p[0]) + "," + (s.Y + p[1]) + ")");
                        }
                    }
                    // Clamped to the screen being shown, never onto a neighbour.
                    b.Clear();
                    inj.Handle(Msg("{\"t\":\"mv\",\"n\":" + (++n) + ",\"x\":-50,\"y\":" + (s.H + 500) + ",\"m\":" + s.Id + "}"));
                    var c = b.All();
                    ok &= c.Count == 1 && Back(c[0].Dx, l.X, l.W) == s.X && Back(c[0].Dy, l.Y, l.H) == s.Y + s.H - 1;
                    // A move for another screen (left over from a switch) is dropped.
                    b.Clear();
                    inj.Handle(Msg("{\"t\":\"mv\",\"n\":" + (++n) + ",\"x\":5,\"y\":5,\"m\":" + (s.Id + 1) + "}"));
                    ok &= b.All().Count == 0;
                }
                Check(ok, kv.Key);
            }
            Section("several monitors and mixed DPI: physical pixels on the shown screen, clamped to it", f0);

            // ---------------------------------------------------------------- buttons, wheel, move order
            f0 = failures;
            {
                var l = Layout(Scr(0, 0, 0, 1920, 1080, true, 1.0));
                var b = new MemoryBackend();
                var inj = Injector(b, l);
                inj.Handle(Msg("{\"t\":\"btn\",\"b\":0,\"d\":true,\"x\":960,\"y\":540,\"m\":0}"));
                var r = b.All();
                Check(r.Count == 1 && r[0].Flags == (MOVE | InputInjector.LEFTDOWN) && r[0].Dx == InputInjector.Absolute(960, 1920) && r[0].Dy == InputInjector.Absolute(540, 1080), "left down at its own position, one INPUT: " + (r.Count > 0 ? Desc(r[0]) : "none"));
                b.Clear();
                inj.Handle(Msg("{\"t\":\"btn\",\"b\":0,\"d\":true,\"x\":961,\"y\":540,\"m\":0}"));
                Check(b.All().Count == 0, "a second left down while it's down: nothing");
                inj.Handle(Msg("{\"t\":\"btn\",\"b\":0,\"d\":false,\"x\":970,\"y\":541,\"m\":0}"));
                r = b.All();
                Check(r.Count == 1 && r[0].Flags == (MOVE | InputInjector.LEFTUP) && Back(r[0].Dx, 0, 1920) == 970, "left up where it was let go");
                b.Clear();
                inj.Handle(Msg("{\"t\":\"btn\",\"b\":2,\"d\":false,\"x\":1,\"y\":1}"));
                Check(b.All().Count == 0, "an up for a button not pressed here: nothing");
                var flags = new uint[][] { new[] { InputInjector.LEFTDOWN, InputInjector.LEFTUP }, new[] { InputInjector.MIDDLEDOWN, InputInjector.MIDDLEUP }, new[] { InputInjector.RIGHTDOWN, InputInjector.RIGHTUP }, new[] { InputInjector.XDOWN, InputInjector.XUP }, new[] { InputInjector.XDOWN, InputInjector.XUP } };
                for (int btn = 0; btn < 5; btn++)
                {
                    b.Clear();
                    inj.Handle(Msg("{\"t\":\"btn\",\"b\":" + btn + ",\"d\":true,\"x\":10,\"y\":20,\"m\":0}"));
                    inj.Handle(Msg("{\"t\":\"btn\",\"b\":" + btn + ",\"d\":false,\"x\":10,\"y\":20,\"m\":0}"));
                    r = b.All();
                    int data = btn == 3 ? InputInjector.XBUTTON1 : btn == 4 ? InputInjector.XBUTTON2 : 0;
                    Check(r.Count == 2 && r[0].Flags == (MOVE | flags[btn][0]) && r[1].Flags == (MOVE | flags[btn][1]) && r[0].MouseData == data && r[1].MouseData == data,
                        "button " + btn + " down and up (" + (r.Count > 0 ? Desc(r[0]) : "") + ")");
                }
                b.Clear();
                inj.Handle(Msg("{\"t\":\"btn\",\"b\":7,\"d\":true,\"x\":10,\"y\":20}"));
                Check(b.All().Count == 0, "an unknown button: nothing");
                // Wheel: the browser's sign (down/right positive), 120 a notch; Windows' WHEEL is forward-positive.
                b.Clear();
                inj.Handle(Msg("{\"t\":\"wheel\",\"dx\":0,\"dy\":120,\"x\":100,\"y\":200,\"m\":0}"));
                r = b.All();
                Check(r.Count == 1 && r[0].Flags == (MOVE | InputInjector.WHEEL) && r[0].MouseData == -120 && Back(r[0].Dx, 0, 1920) == 100, "one notch down → WHEEL -120 at its position");
                b.Clear();
                inj.Handle(Msg("{\"t\":\"wheel\",\"dx\":-240,\"dy\":-120,\"x\":100,\"y\":200,\"m\":0}"));
                r = b.All();
                Check(r.Count == 2 && r[0].MouseData == 120 && (r[0].Flags & InputInjector.WHEEL) != 0 && r[1].Flags == InputInjector.HWHEEL && r[1].MouseData == -240, "up and left: WHEEL +120, then HWHEEL -240");
                b.Clear();
                inj.Handle(Msg("{\"t\":\"wheel\",\"dx\":0,\"dy\":0.4,\"x\":1,\"y\":1,\"m\":0}"));
                Check(b.All().Count == 0, "a fraction of a unit waits");
                inj.Handle(Msg("{\"t\":\"wheel\",\"dx\":0,\"dy\":0.7,\"x\":1,\"y\":1,\"m\":0}"));
                r = b.All();
                Check(r.Count == 1 && r[0].MouseData == -1, "...and goes once the fractions add up to a unit");
                b.Clear();
                inj.Handle(Msg("{\"t\":\"wheel\",\"dx\":0,\"dy\":100000,\"x\":1,\"y\":1,\"m\":0}"));
                r = b.All();
                Check(r.Count == 1 && r[0].MouseData == -InputInjector.MaxWheel, "a huge wheel is capped at ten notches");
                // mv is unordered: an older one never moves the pointer back, nor across a button press.
                b.Clear();
                inj.Handle(Msg("{\"t\":\"mv\",\"n\":50,\"x\":10,\"y\":10,\"m\":0}"));
                inj.Handle(Msg("{\"t\":\"mv\",\"n\":49,\"x\":900,\"y\":900,\"m\":0}"));
                Check(b.All().Count == 1, "an older mv after a newer one is dropped");
                inj.Handle(Msg("{\"t\":\"btn\",\"n\":60,\"b\":0,\"d\":true,\"x\":20,\"y\":20,\"m\":0}"));
                inj.Handle(Msg("{\"t\":\"mv\",\"n\":59,\"x\":900,\"y\":900,\"m\":0}"));
                Check(b.All().Count == 2, "an mv sent before a click doesn't move the pointer after it");
                inj.Handle(Msg("{\"t\":\"btn\",\"n\":60,\"b\":0,\"d\":false,\"x\":20,\"y\":20,\"m\":0}"));
                b.Clear();
                inj.Handle(Msg("{\"t\":\"mv\",\"n\":61,\"x\":\"5\",\"y\":5,\"m\":0}"));
                inj.Handle(Msg("{\"t\":\"mv\",\"n\":62,\"x\":1e300,\"y\":5,\"m\":0}"));
                Check(b.All().Count == 0, "malformed coordinates are dropped");
            }
            Section("buttons (left, middle, right, back, forward), wheel and the mv order", f0);

            // ---------------------------------------------------------------- keys
            f0 = failures;
            {
                var l = Layout(Scr(0, 0, 0, 1920, 1080, true, 1.0));
                var b = new MemoryBackend();
                var inj = Injector(b, l);
                Func<string, bool, List<InputRecord>> press = (code, down) =>
                {
                    b.Clear();
                    inj.Handle(Msg("{\"t\":\"key\",\"c\":\"" + code + "\",\"d\":" + (down ? "true" : "false") + "}"));
                    now += 200;
                    inj.Flush();
                    return b.All();
                };
                var table = new object[][]
                {
                    new object[] { "KeyA", (ushort)0, (ushort)0x1E, S }, new object[] { "KeyZ", (ushort)0, (ushort)0x2C, S },
                    new object[] { "Digit1", (ushort)0, (ushort)0x02, S }, new object[] { "Digit0", (ushort)0, (ushort)0x0B, S },
                    new object[] { "Enter", (ushort)0, (ushort)0x1C, S }, new object[] { "Escape", (ushort)0, (ushort)0x01, S },
                    new object[] { "Backspace", (ushort)0, (ushort)0x0E, S }, new object[] { "Tab", (ushort)0, (ushort)0x0F, S },
                    new object[] { "Space", (ushort)0, (ushort)0x39, S }, new object[] { "Backquote", (ushort)0, (ushort)0x29, S },
                    new object[] { "IntlBackslash", (ushort)0, (ushort)0x56, S }, new object[] { "F1", (ushort)0, (ushort)0x3B, S },
                    new object[] { "F11", (ushort)0, (ushort)0x57, S }, new object[] { "F12", (ushort)0, (ushort)0x58, S },
                    new object[] { "ShiftLeft", (ushort)0, (ushort)0x2A, S }, new object[] { "ShiftRight", (ushort)0, (ushort)0x36, S },
                    new object[] { "AltLeft", (ushort)0, (ushort)0x38, S }, new object[] { "ControlRight", (ushort)0, (ushort)0x1D, S | E },
                    new object[] { "AltRight", (ushort)0, (ushort)0x38, S | E }, new object[] { "ArrowLeft", (ushort)0, (ushort)0x4B, S | E },
                    new object[] { "ArrowUp", (ushort)0, (ushort)0x48, S | E }, new object[] { "Home", (ushort)0, (ushort)0x47, S | E },
                    new object[] { "Delete", (ushort)0, (ushort)0x53, S | E }, new object[] { "Insert", (ushort)0, (ushort)0x52, S | E },
                    new object[] { "PageDown", (ushort)0, (ushort)0x51, S | E }, new object[] { "NumpadEnter", (ushort)0, (ushort)0x1C, S | E },
                    new object[] { "NumpadDivide", (ushort)0, (ushort)0x35, S | E }, new object[] { "Numpad7", (ushort)0, (ushort)0x47, S },
                    new object[] { "NumpadMultiply", (ushort)0, (ushort)0x37, S }, new object[] { "PrintScreen", (ushort)0, (ushort)0x37, S | E },
                    new object[] { "ContextMenu", (ushort)0, (ushort)0x5D, S | E }, new object[] { "AudioVolumeUp", (ushort)0, (ushort)0x30, S | E },
                    new object[] { "MetaLeft", (ushort)0x5B, (ushort)0x5B, E }, new object[] { "MetaRight", (ushort)0x5C, (ushort)0x5C, E },
                    new object[] { "Pause", (ushort)0x13, (ushort)0x45, 0u }, new object[] { "NumLock", (ushort)0x90, (ushort)0x45, E },
                };
                foreach (var row in table)
                {
                    string code = (string)row[0];
                    ushort vk = (ushort)row[1], scan = (ushort)row[2];
                    uint fl = (uint)row[3];
                    var down = press(code, true);
                    var up = press(code, false);
                    Check(down.Count == 1 && Key(down[0], vk, scan, fl), code + " down: " + (down.Count > 0 ? Desc(down[0]) : "nothing"));
                    Check(up.Count == 1 && Key(up[0], vk, scan, fl | U), code + " up: " + (up.Count > 0 ? Desc(up[0]) : "nothing"));
                }
                Check(press("Power", true).Count == 0 && press("Sleep", true).Count == 0 && press("WakeUp", true).Count == 0, "power keys are never sent");
                Check(press("NoSuchKey", true).Count == 0 && press("", true).Count == 0, "unknown codes are dropped");
                Check(press("KeyQ", false).Count == 0, "an up for a key not pressed here: nothing");
                var rep = press("KeyR", true).Concat(press("KeyR", true)).Concat(press("KeyR", false)).ToList();
                Check(rep.Count == 3 && Key(rep[0], 0, 0x13, S) && Key(rep[1], 0, 0x13, S) && Key(rep[2], 0, 0x13, S | U), "a held key repeats, and goes up once");
                // Win+L would lock the PC: L is dropped while a Win key is down.
                var wl = press("MetaLeft", true).Concat(press("KeyL", true)).Concat(press("KeyL", false)).Concat(press("MetaLeft", false)).ToList();
                Check(wl.Count == 2 && Key(wl[0], 0x5B, 0x5B, E) && Key(wl[1], 0x5B, 0x5B, E | U), "Win+L: only the Win key goes, never the L");
                var l2 = press("KeyL", true).Concat(press("KeyL", false)).ToList();
                Check(l2.Count == 2 && Key(l2[0], 0, 0x26, S), "L on its own types");
                Check(KeyMap.CodeOf(0x5B, 0x5B, true) == "MetaLeft" && KeyMap.CodeOf(0x09, 0x0F, false) == "Tab" && KeyMap.CodeOf(0x2C, 0x37, true) == "PrintScreen"
                    && KeyMap.CodeOf(0x73, 0x3E, false) == "F4" && KeyMap.CodeOf(0x1B, 0x01, false) == "Escape" && KeyMap.CodeOf(0x20, 0x39, false) == "Space"
                    && KeyMap.CodeOf(0xA3, 0x1D, true) == "ControlRight" && KeyMap.CodeOf(0x37, 0x37, false) == "NumpadMultiply", "hook keys map back to their codes");
            }
            Section("keys: KeyboardEvent.code → set-1 scancodes, extended keys, Win/Pause/NumLock by virtual key, Win+L never", f0);

            // ---------------------------------------------------------------- key repeats, and Win+L in any layout
            f0 = failures;
            {
                var b = new MemoryBackend();
                var inj = Injector(b, Layout(Scr(0, 0, 0, 1920, 1080, true, 1.0)));
                inj.Handle(Msg("{\"t\":\"key\",\"c\":\"KeyA\",\"d\":true}"));
                for (int i = 0; i < 300; i++) inj.Handle(Msg("{\"t\":\"key\",\"c\":\"KeyA\",\"d\":true}"));
                int downs = b.All().Count;
                Check(downs == 1 + (int)InputInjector.RepeatRate, "a held key repeats at most " + InputInjector.RepeatRate + " times a second (" + (downs - 1) + " of 300 at once)");
                now += 1000;
                b.Clear();
                for (int i = 0; i < 20; i++) { inj.Handle(Msg("{\"t\":\"key\",\"c\":\"KeyA\",\"d\":true}")); now += 20; }
                Check(b.All().Count == 20, "...a keyboard's own pace (every 20 ms) goes through");
                b.Clear();
                inj.Handle(Msg("{\"t\":\"key\",\"c\":\"KeyA\",\"d\":false}"));
                Check(b.All().Count == 1 && Key(b.All()[0], 0, 0x1E, S | U), "...and it goes up once");
                // Repeats count against the overall cap too: many held keys repeating can't flood SendInput.
                b.Clear();
                now += 2000;
                var codes = new[] { "KeyQ", "KeyW", "KeyE", "KeyR", "KeyT", "KeyY", "KeyU", "KeyI", "KeyO", "KeyP" };
                foreach (var c in codes) inj.Handle(Msg("{\"t\":\"key\",\"c\":\"" + c + "\",\"d\":true}"));
                for (int i = 0; i < 100; i++) foreach (var c in codes) inj.Handle(Msg("{\"t\":\"key\",\"c\":\"" + c + "\",\"d\":true}"));
                int all = b.All().Count;
                Check(all == 400, "every down counts against the 400 a second, repeats included (" + all + " of 1010 at once)");
                inj.ReleaseAll("test");
                // Win+L is a virtual-key hotkey: on Dvorak the P key makes VK_L.
                var dvorak = new MemoryBackend();
                var inj2 = Injector(dvorak, Layout(Scr(0, 0, 0, 1920, 1080, true, 1.0)));
                inj2.VirtualKeyOf = k => k.Code == "KeyP" ? 0x4C : k.Code == "KeyL" ? 0x4E : k.Vk != 0 ? k.Vk : 0x41;
                now += 2000;
                inj2.Handle(Msg("{\"t\":\"key\",\"c\":\"MetaLeft\",\"d\":true}"));
                inj2.Handle(Msg("{\"t\":\"key\",\"c\":\"KeyP\",\"d\":true}"));
                inj2.Handle(Msg("{\"t\":\"key\",\"c\":\"KeyP\",\"d\":false}"));
                inj2.Handle(Msg("{\"t\":\"key\",\"c\":\"KeyL\",\"d\":true}"));
                inj2.Handle(Msg("{\"t\":\"key\",\"c\":\"KeyL\",\"d\":false}"));
                inj2.Handle(Msg("{\"t\":\"key\",\"c\":\"MetaLeft\",\"d\":false}"));
                var r = dvorak.All();
                Check(r.Count == 2 && Key(r[0], 0x5B, 0x5B, E) && Key(r[1], 0x5B, 0x5B, E | U), "Dvorak: Win plus the key that makes VK_L is dropped (and the L key too)");
                dvorak.Clear();
                inj2.Handle(Msg("{\"t\":\"key\",\"c\":\"KeyP\",\"d\":true}"));
                inj2.Handle(Msg("{\"t\":\"key\",\"c\":\"KeyP\",\"d\":false}"));
                Check(dvorak.All().Count == 2, "...that key on its own types");
            }
            Section("key repeats are capped; Win+L is blocked by virtual key in any layout", f0);

            // ---------------------------------------------------------------- AltGr
            f0 = failures;
            {
                var b = new MemoryBackend();
                var inj = Injector(b, Layout(Scr(0, 0, 0, 1920, 1080, true, 1.0)));
                Action<string, bool> key = (code, down) => inj.Handle(Msg("{\"t\":\"key\",\"c\":\"" + code + "\",\"d\":" + (down ? "true" : "false") + "}"));
                // AltGr on a German keyboard: ControlLeft (fake) then AltRight, the same instant; Q = @.
                key("ControlLeft", true); now += 1;
                key("AltRight", true); now += 30;
                key("KeyQ", true); key("KeyQ", false); now += 30;
                key("ControlLeft", false); key("AltRight", false);
                now += 200; inj.Flush();
                var r = b.All();
                Check(r.Count == 4 && Key(r[0], 0, 0x38, S | E) && Key(r[1], 0, 0x10, S) && Key(r[2], 0, 0x10, S | U) && Key(r[3], 0, 0x38, S | E | U),
                    "AltGr+Q: AltRight, Q, Q up, AltRight up; the fake ControlLeft is never sent (" + string.Join(" ", r.Select(Desc)) + ")");
                // A real Ctrl press alone: sent once the AltGr window has passed.
                b.Clear();
                key("ControlLeft", true);
                Check(b.All().Count == 0 && inj.HasPending, "ControlLeft waits " + InputInjector.AltGrWindowMs + " ms (it may be AltGr's)");
                now += InputInjector.AltGrWindowMs + 1; inj.Flush();
                r = b.All();
                Check(r.Count == 1 && Key(r[0], 0, 0x1D, S) && !inj.HasPending, "...then goes on its own");
                key("ControlLeft", false);
                // Ctrl+C typed fast: Ctrl first, then C.
                b.Clear();
                key("ControlLeft", true); now += 5; key("KeyC", true); key("KeyC", false); key("ControlLeft", false);
                r = b.All();
                Check(r.Count == 4 && Key(r[0], 0, 0x1D, S) && Key(r[1], 0, 0x2E, S) && Key(r[3], 0, 0x1D, S | U), "Ctrl+C typed fast keeps its order");
                // Ctrl, then AltRight too late: both are real.
                b.Clear();
                key("ControlLeft", true); now += InputInjector.AltGrWindowMs + 20; key("AltRight", true);
                r = b.All();
                Check(r.Count == 2 && Key(r[0], 0, 0x1D, S) && Key(r[1], 0, 0x38, S | E), "Ctrl then AltRight a while later: both go");
                inj.ReleaseAll("test");
                // A click right after ControlLeft (Ctrl+click): Ctrl goes first.
                b.Clear();
                key("ControlLeft", true); now += 2;
                inj.Handle(Msg("{\"t\":\"btn\",\"b\":0,\"d\":true,\"x\":5,\"y\":5,\"m\":0}"));
                r = b.All();
                Check(r.Count == 2 && Key(r[0], 0, 0x1D, S) && r[1].Flags == (MOVE | InputInjector.LEFTDOWN), "Ctrl+click: Ctrl first");
                // ...but a pointer move doesn't end the AltGr window.
                inj.ReleaseAll("test");
                b.Clear();
                key("ControlLeft", true); now += 1;
                inj.Handle(Msg("{\"t\":\"mv\",\"n\":900,\"x\":7,\"y\":7,\"m\":0}")); now += 1;
                key("AltRight", true);
                r = b.All();
                Check(r.Count == 2 && r[0].Flags == MOVE && Key(r[1], 0, 0x38, S | E), "a move between the two still makes it AltGr");
                inj.ReleaseAll("test");
            }
            Section("AltGr: the browser's fake ControlLeft before AltRight is dropped; a real Ctrl isn't", f0);

            // ---------------------------------------------------------------- text
            f0 = failures;
            {
                var b = new MemoryBackend();
                var inj = Injector(b, Layout(Scr(0, 0, 0, 1920, 1080, true, 1.0)));
                inj.Handle(Msg("{\"t\":\"text\",\"s\":\"é\"}"));
                var r = b.All();
                Check(r.Count == 2 && Key(r[0], 0, 0xE9, UNI) && Key(r[1], 0, 0xE9, UNI | U), "é: one Unicode down and up");
                b.Clear();
                inj.Handle(Msg("{\"t\":\"text\",\"s\":\"\\ud83d\\ude00\"}"));
                r = b.All();
                Check(r.Count == 4 && Key(r[0], 0, 0xD83D, UNI) && Key(r[1], 0, 0xDE00, UNI) && Key(r[2], 0, 0xD83D, UNI | U) && Key(r[3], 0, 0xDE00, UNI | U),
                    "an emoji: both surrogates down, then both up");
                b.Clear();
                inj.Handle(Msg("{\"t\":\"text\",\"s\":\"a\\r\\nb\\tc\\u0007\"}"));
                r = b.All();
                Check(r.Count == 10 && Key(r[0], 0, 'a', UNI) && Key(r[2], 0, 0x1C, S) && Key(r[3], 0, 0x1C, S | U) && Key(r[4], 0, 'b', UNI) && Key(r[6], 0, 0x0F, S) && Key(r[8], 0, 'c', UNI),
                    "line breaks become Enter, tabs Tab, other control characters go");
                b.Clear();
                var half = new Dictionary<string, object>();
                half["t"] = "text";
                half["s"] = "\ud800x"; // built here: a JSON parser turns a lone surrogate into U+FFFD
                inj.Handle(half);
                r = b.All();
                Check(r.Count == 2 && Key(r[0], 0, 'x', UNI), "half a surrogate pair is dropped");
                b.Clear();
                inj.Handle(Msg("{\"t\":\"text\",\"s\":\"" + new string('k', 5000) + "\"}"));
                Check(b.All().Count == InputInjector.MaxText * 2, "text is capped at " + InputInjector.MaxText + " characters a message");
                Check(!inj.Holding, "text leaves nothing held");
            }
            Section("text: KEYEVENTF_UNICODE, surrogate pairs, Enter and Tab", f0);

            // ---------------------------------------------------------------- release-all
            f0 = failures;
            {
                var b = new MemoryBackend();
                var inj = Injector(b, Layout(Scr(0, 0, 0, 1920, 1080, true, 1.0)));
                inj.Handle(Msg("{\"t\":\"key\",\"c\":\"ShiftLeft\",\"d\":true}"));
                inj.Handle(Msg("{\"t\":\"key\",\"c\":\"MetaLeft\",\"d\":true}"));
                inj.Handle(Msg("{\"t\":\"key\",\"c\":\"KeyA\",\"d\":true}"));
                inj.Handle(Msg("{\"t\":\"btn\",\"b\":0,\"d\":true,\"x\":5,\"y\":5,\"m\":0}"));
                inj.Handle(Msg("{\"t\":\"btn\",\"b\":3,\"d\":true,\"x\":5,\"y\":5,\"m\":0}"));
                inj.Handle(Msg("{\"t\":\"key\",\"c\":\"ControlLeft\",\"d\":true}")); // still held back (AltGr window)
                Check(inj.Holding, "holding keys and buttons");
                b.Clear();
                inj.Handle(Msg("{\"t\":\"release\"}"));
                var r = b.All();
                Check(b.Batches.Count == 1 && r.Count == 5, "release: one batch with every up (" + r.Count + ")");
                Check(r.Count == 5 && Key(r[0], 0, 0x1E, S | U) && Key(r[1], 0x5B, 0x5B, E | U) && Key(r[2], 0, 0x2A, S | U), "keys go up newest first");
                Check(r.Count == 5 && r[3].Flags == InputInjector.LEFTUP && r[4].Flags == InputInjector.XUP && r[4].MouseData == InputInjector.XBUTTON1, "buttons go up where the pointer is (no move)");
                Check(!inj.Holding && !inj.HasPending, "nothing held afterwards; the held-back ControlLeft is forgotten");
                b.Clear();
                Check(inj.ReleaseAll("again") == 0 && b.All().Count == 0, "releasing again does nothing");
                now += 500; inj.Flush();
                Check(b.All().Count == 0, "the forgotten ControlLeft never goes down later");
            }
            Section("release-all (release, a lost viewer, the end of a session)", f0);

            // ---------------------------------------------------------------- rates
            f0 = failures;
            {
                var b = new MemoryBackend();
                var inj = Injector(b, Layout(Scr(0, 0, 0, 1920, 1080, true, 1.0)));
                for (int i = 0; i < 400; i++) inj.Handle(Msg("{\"t\":\"mv\",\"n\":" + (i + 1) + ",\"x\":" + i + ",\"y\":5,\"m\":0}"));
                int moves = b.All().Count;
                Check(moves == 250, "pointer moves are capped at 250 a second (" + moves + " of 400 at once)");
                b.Clear();
                now += 1000;
                inj.Handle(Msg("{\"t\":\"mv\",\"n\":1000,\"x\":1,\"y\":5,\"m\":0}"));
                Check(b.All().Count == 1, "...and flow again a second later");
                b.Clear();
                for (int i = 0; i < 500; i++) inj.Handle(Msg("{\"t\":\"text\",\"s\":\"x\"}"));
                Check(b.All().Count == 400 * 2, "other input is capped at 400 messages a second");
                inj.Handle(Msg("{\"t\":\"key\",\"c\":\"KeyB\",\"d\":true}"));
                Check(!inj.Holding, "past the cap a key down is dropped too");
                now += 1000;
                inj.Handle(Msg("{\"t\":\"key\",\"c\":\"KeyB\",\"d\":true}"));
                b.Clear();
                for (int i = 0; i < 500; i++) inj.Handle(Msg("{\"t\":\"text\",\"s\":\"x\"}"));
                inj.Handle(Msg("{\"t\":\"key\",\"c\":\"KeyB\",\"d\":false}"));
                var r = b.All();
                Check(r.Count > 0 && Key(r[r.Count - 1], 0, 0x30, S | U), "...but an up always goes, past the cap");
            }
            Section("rate caps", f0);

            // ---------------------------------------------------------------- the recording backend's lines
            f0 = failures;
            {
                string file = Path.Combine(Path.GetTempPath(), "beam-input-test-" + Guid.NewGuid().ToString("N") + ".jsonl");
                try
                {
                    var rec = new RecordingBackend(file);
                    var inj = new InputInjector(rec, () => Layout(Scr(0, 0, 0, 1920, 1080, true, 1.0)), () => now);
                    inj.Handle(Msg("{\"t\":\"key\",\"c\":\"KeyA\",\"d\":true}"));
                    inj.Handle(Msg("{\"t\":\"btn\",\"b\":0,\"d\":true,\"x\":960,\"y\":540,\"m\":0}"));
                    inj.Handle(Msg("{\"t\":\"release\"}"));
                    var lines = File.ReadAllLines(file);
                    Check(lines.Length == 4, "four lines (" + lines.Length + ")");
                    Check(lines.Length == 4 && lines[0] == "{\"b\":1,\"type\":\"key\",\"vk\":0,\"scan\":30,\"flags\":8}", "a key line: " + (lines.Length > 0 ? lines[0] : ""));
                    Check(lines.Length == 4 && lines[1] == "{\"b\":2,\"type\":\"mouse\",\"dx\":32768,\"dy\":32768,\"data\":0,\"flags\":49155}", "a mouse line: " + (lines.Length > 1 ? lines[1] : ""));
                    Check(lines.Length == 4 && lines[2].StartsWith("{\"b\":3,") && lines[3].StartsWith("{\"b\":3,"), "one batch number per call");
                    Check(rec.Name == "recording" && inj.BackendName == "recording", "named recording");
                }
                finally { try { File.Delete(file); } catch { } }
            }
            Section("the recording backend writes each INPUT as a JSON line", f0);

            // ---------------------------------------------------------------- policy
            f0 = failures;
            {
                Func<RcFacts> ok = () => new RcFacts { ServerFeature = true, Allowed = true, Me = "pc1", ViewerId = "laptop1", ViewerKnown = true, ViewerUser = "owner", Ip4 = "100.101.102.103", Ip6 = "fd7a:115c:a1e0::1" };
                Check(RcPolicy.Refusal(ok()) == null, "a known device of the owner, switch on, unlocked: yes");
                var f = ok(); f.Allowed = false; Check(RcPolicy.Refusal(f) != null && RcPolicy.EndReason(RcPolicy.Refusal(f)) == "declined", "switch off: declined");
                f = ok(); f.ServerFeature = false; Check(RcPolicy.Refusal(f) != null, "no server feature: no");
                f = ok(); f.Locked = true; Check(RcPolicy.EndReason(RcPolicy.Refusal(f)) == "locked", "locked: locked");
                f = ok(); f.Busy = true; Check(RcPolicy.EndReason(RcPolicy.Refusal(f)) == "busy", "another session: busy");
                f = ok(); f.ViewerKnown = false; Check(RcPolicy.EndReason(RcPolicy.Refusal(f)) == "declined", "an unknown device: declined");
                f = ok(); f.ViewerTemporary = true; Check(RcPolicy.Refusal(f) != null, "a session-only sign-in: no");
                f = ok(); f.ViewerUser = "guest"; Check(RcPolicy.Refusal(f) != null, "not the owner's device: no");
                f = ok(); f.ViewerId = "pc1"; Check(RcPolicy.Refusal(f) != null, "itself: no");
                f = ok(); f.Ip4 = "192.168.1.20"; f.Ip6 = null; Check(RcPolicy.Refusal(f) != null, "no Tailscale address: no");
                f = ok(); f.Ip4 = null; Check(RcPolicy.Refusal(f) == null, "IPv6 only is fine");
                Check(RcPolicy.IsTailscaleIp("100.64.0.0") && RcPolicy.IsTailscaleIp("100.127.255.255") && RcPolicy.IsTailscaleIp("100.111.218.20"), "100.64/10");
                Check(!RcPolicy.IsTailscaleIp("100.63.255.255") && !RcPolicy.IsTailscaleIp("100.128.0.1") && !RcPolicy.IsTailscaleIp("10.0.0.1") && !RcPolicy.IsTailscaleIp("100.64.1"), "not 100.64/10");
                Check(RcPolicy.IsTailscaleIp("fd7a:115c:a1e0::da01:dad7") && RcPolicy.IsTailscaleIp("[fd7a:115c:a1e0:ab12::1]") && !RcPolicy.IsTailscaleIp("fd7a:115c:a1e1::1") && !RcPolicy.IsTailscaleIp("fe80::1%3"), "fd7a:115c:a1e0::/48");
                Check(RcPolicy.IsTailscaleIp("::ffff:100.64.0.1") && !RcPolicy.IsTailscaleIp("") && !RcPolicy.IsTailscaleIp(null) && !RcPolicy.IsTailscaleIp("abc.local"), "edge cases");
                Check(RcPolicy.PeerRefusal("100.101.102.103", "100.101.102.103", null) == null && RcPolicy.PeerRefusal("fd7a:115c:a1e0:0::1", null, "fd7a:115c:a1e0::1") == null, "the peer is the attested address (v4 or v6)");
                Check(RcPolicy.PeerRefusal("100.101.102.104", "100.101.102.103", "fd7a:115c:a1e0::1") != null, "another Tailscale address: hang up");
                Check(RcPolicy.PeerRefusal("", "100.101.102.103", null) != null && RcPolicy.PeerRefusal("192.168.1.32", "192.168.1.32", null) != null, "unknown or not Tailscale: hang up");
                var status = Msg("{\"Self\":{\"UserID\":1234567890123456,\"TailscaleIPs\":[\"100.111.218.20\"]},\"User\":{\"1234567890123456\":{\"LoginName\":\"me@example.com\"}}}");
                var mine = Msg("{\"Node\":{\"User\":1234567890123456,\"Addresses\":[\"100.101.102.103/32\",\"fd7a:115c:a1e0::1/128\"],\"ComputedName\":\"laptop\"},\"UserProfile\":{\"ID\":1234567890123456,\"LoginName\":\"me@example.com\"}}");
                var theirs = Msg("{\"Node\":{\"User\":8631650921607788,\"Addresses\":[\"100.101.102.103/32\"]},\"UserProfile\":{\"ID\":8631650921607788,\"LoginName\":\"other@example.com\"}}");
                Check(RcPolicy.OwnerRefusal(mine, status, "100.101.102.103") == null && RcPolicy.OwnerRefusal(mine, status, "fd7a:115c:a1e0::1") == null, "whois: a node of the same owner");
                Check(RcPolicy.OwnerRefusal(theirs, status, "100.101.102.103") != null, "whois: another owner (a user ID one apart) → hang up");
                Check(RcPolicy.OwnerRefusal(mine, status, "100.101.102.104") != null, "whois names a node without that address → hang up");
                Check(RcPolicy.OwnerRefusal(Msg("{}"), status, "100.101.102.103") != null && RcPolicy.OwnerRefusal(mine, Msg("{}"), "100.101.102.103") != null, "nothing known → hang up");
                var noAddresses = Msg("{\"Node\":{\"User\":1234567890123456,\"ComputedName\":\"laptop\"},\"UserProfile\":{\"ID\":1234567890123456,\"LoginName\":\"me@example.com\"}}");
                Check(RcPolicy.OwnerRefusal(noAddresses, status, "100.101.102.103") != null, "whois lists no addresses for the node → hang up (1.7.2: it passed)");
                Check(RcPolicy.DisplayName("Robin\u202E Laptop\r\n") == "Robin Laptop" && RcPolicy.DisplayName("") == "Another device" && RcPolicy.DisplayName(new string('x', 60)).Length == 40, "banner names: no control or direction characters, 40 at most");
                var widens = new[] { "GET /api/pair", "GET /api/qr.svg", "GET /api/qr.png", "POST /api/login-requests/approve", "POST /api/password", "PATCH /api/settings",
                    "DELETE /api/settings/blocked-nodes/abc", "POST /api/security/sign-out-others", "POST /api/move", "DELETE /api/move", "GET /api/admin/export", "POST /api/admin/shutdown",
                    "post /api/rc/sessions" };
                var fine = new[] { "GET /api/settings", "POST /api/login-requests/deny", "GET /api/login-requests", "POST /api/rc/disable", "POST /api/rc/sessions/0123456789abcdef/end",
                    "GET /api/rc/sessions", "GET /api/items", "DELETE /api/devices/abc", "POST /api/text", "GET /api/devices", "PUT /api/devices/me/settings" };
                Check(widens.All(x => RcPolicy.WidensAccess(x.Split(' ')[0], x.Split(' ')[1]) != null), "during a session the pages can't get a pairing link, approve a sign-in, set the password, change the server's settings, sign out others, move or administer the server, or control another PC");
                Check(fine.All(x => RcPolicy.WidensAccess(x.Split(' ')[0], x.Split(' ')[1]) == null), "...but everything else stays (turning remote control off, ending a session, denying a sign-in, messages)");
            }
            Section("policy: the request, the peer and its Tailscale owner", f0);

            // Signed updates (1.7.3): vectors signed by the runner with a key of its own (update-vectors.cs).
            int u0 = failures;
            {
                var uv = UpdateVectors.Version;
                var usha = UpdateVectors.Sha;
                var usize = UpdateVectors.Size;
                var usig = UpdateVectors.Sig;
                Check(UpdateSignature.Required, "a build with a key installs only signed updates");
                Check(UpdateSignature.Check(uv, usha, usize, usig) == null, "a signed update passes");
                Check(UpdateSignature.Check(uv, usha.ToUpperInvariant(), usize, usig) == null, "...its SHA-256 in either case");
                Check(UpdateSignature.Check("9.8.8", usha, usize, usig) != null && UpdateSignature.Check("9.8.6", usha, usize, usig) != null, "another version: no (an older signed build can't pass as new)");
                Check(UpdateSignature.Check(uv, "0" + usha.Substring(1), usize, usig) != null, "another SHA-256: no");
                Check(UpdateSignature.Check(uv, usha, usize + 1, usig) != null, "another size: no");
                Check(UpdateSignature.Check(uv, usha, usize, null) != null && UpdateSignature.Check(uv, usha, usize, "") != null, "no signature: no");
                Check(UpdateSignature.Check(uv, usha, usize, "not base64!") != null && UpdateSignature.Check(uv, usha, usize, Convert.ToBase64String(new byte[63])) != null, "a garbled signature: no");
                var flipped = Convert.FromBase64String(usig);
                flipped[10] ^= 1;
                Check(UpdateSignature.Check(uv, usha, usize, Convert.ToBase64String(flipped)) != null, "one bit changed: no");
                Check(UpdateSignature.Check(uv, usha, usize, UpdateVectors.OtherSig) != null, "signed with another key: no");
                Check(UpdateSignature.Check(UpdateVectors.OtherKey, uv, usha, usize, UpdateVectors.OtherSig) == null, "...which that key accepts");
                Check(UpdateSignature.Check("", uv, usha, usize, null) == null, "a build without a key checks only the SHA-256 (as before 1.7.3)");
            }
            Section("signed updates: version, SHA-256 and size, from this Beam's key only (1.7.3)", u0);

            // The remote-control banner's place (1.7.4): three made-up screens, one left of the primary (negative x),
            // one right of it and higher up. The banner is 600×40 (pill 180×40), Stop's centre 558,20 inside it.
            int b0 = failures;
            {
                var one = new BannerArea(@"\\.\DISPLAY1", new Rectangle(0, 0, 1920, 1040), true);
                var two = new BannerArea(@"\\.\DISPLAY2", new Rectangle(1920, -200, 1280, 1024), false);
                var three = new BannerArea(@"\\.\DISPLAY3", new Rectangle(-1600, 100, 1600, 900), false);
                var areas = new List<BannerArea> { one, two, three };
                var full = new Size(600, 40);
                var stop = new Point(558, 20);
                Func<int, int, Rectangle> at = (x, y) => new Rectangle(x, y, 600, 40);
                Check(RcBannerPlace.Clamp(at(100, 100), areas) == new Point(100, 100), "a banner on a screen stays where it is");
                Check(RcBannerPlace.Clamp(at(1500, 100), areas) == new Point(1320, 100), "half off the right edge: back inside the screen it's mostly on");
                Check(RcBannerPlace.Clamp(at(100, -30), areas) == new Point(100, 0) && RcBannerPlace.Clamp(at(100, 1030), areas) == new Point(100, 1000), "above the top or over the taskbar: inside the working area");
                Check(RcBannerPlace.Clamp(at(5000, 5000), areas) == new Point(2600, 784), "off every screen: onto the nearest one");
                Check(RcBannerPlace.Clamp(new Rectangle(0, 0, 2000, 40), areas) == new Point(0, 0), "wider than the screen: its left edge");
                Check(RcBannerPlace.DragTo(at(1900, 480), new Point(2000, 500), areas) == new Point(1920, 480), "dragged onto the next screen: the pointer's screen, fully");
                Check(RcBannerPlace.DragTo(at(-80, 940), new Point(-50, 950), areas) == new Point(-600, 940), "...also one at negative coordinates");
                bool always = true;
                for (int x = -1700; x <= 3300 && always; x += 50)
                    for (int y = -300; y <= 1100 && always; y += 50)
                        always = RcBannerPlace.OnScreen(new Rectangle(RcBannerPlace.DragTo(at(x - 100, y - 20), new Point(x, y), areas), full), areas);
                Check(always, "dragged anywhere over the desktop (gaps between screens too), it's always fully on a screen");
                Check(RcBannerPlace.OnScreen(at(100, 100), areas) && !RcBannerPlace.OnScreen(at(1500, 100), areas) && !RcBannerPlace.OnScreen(at(-20000, -20000), areas), "on a screen: fully on one");
                Check(RcBannerPlace.TopCentre(full, RcBannerPlace.PrimaryOf(areas), 8) == new Point(660, 8), "the usual place: the top centre of the primary screen");
                Check(RcBannerPlace.Resize(at(1000, 8), 180, areas) == new Point(1420, 8) && RcBannerPlace.Resize(new Rectangle(1420, 8, 180, 40), 600, areas) == new Point(1000, 8), "shrinking and growing keep Stop (the right end) in place");
                Check(RcBannerPlace.Resize(new Rectangle(0, 8, 180, 40), 600, areas) == new Point(0, 8), "...unless it would leave the screen");
                string spot = RcBannerPlace.Spot(new Point(1000 + 558, 500 + 20), areas);
                Check(spot == @"\\.\DISPLAY1|0.8115|0.5", "a spot: the screen and Stop's place as fractions (" + spot + ")");
                Check(RcBannerPlace.FromSpot(spot, full, stop, areas) == new Point(1000, 500), "...back from it: the same place");
                string spot2 = RcBannerPlace.Spot(new Point(2100 + 558, 300 + 20), areas);
                Check(spot2 != null && spot2.StartsWith(@"\\.\DISPLAY2|") && RcBannerPlace.FromSpot(spot2, full, stop, areas) == new Point(2100, 300), "...also on another screen (" + spot2 + ")");
                Check(RcBannerPlace.FromSpot(@"\\.\DISPLAY9|0.5|0.1", full, stop, areas) == new Point(402, 84), "a screen that's gone: the primary, same fractions");
                var bigger = new List<BannerArea> { new BannerArea(@"\\.\DISPLAY1", new Rectangle(0, 0, 2560, 1400), true) };
                Check(RcBannerPlace.FromSpot(spot, full, stop, bigger) == new Point(1519, 680), "another resolution: the same place relative to the screen");
                var wild = RcBannerPlace.FromSpot(@"\\.\DISPLAY1|7|0.5", full, stop, areas);
                Check(wild != null && RcBannerPlace.OnScreen(new Rectangle(wild.Value, full), areas), "a fraction out of range: still fully on the screen");
                Check(new[] { null, "", "abc", "x|0.5", "x|abc|0.5", "x|-0.5|0.5", "x|NaN|0.5", "x|1e3|0.5", "x|0.5|" }.All(s => RcBannerPlace.FromSpot(s, full, stop, areas) == null), "a spot that can't be read: none (the usual place)");
                Check(RcBannerPlace.Spot(new Point(-20000, -20000), new List<BannerArea> { one }) == @"\\.\DISPLAY1|0|0", "a spot off the screen: the nearest corner");
                Check(RcBannerPlace.FromSpot(spot, full, stop, new List<BannerArea>()) == null, "no screens: no place");
            }
            Section("remote-control banner: dragged anywhere, never off a screen, remembered (1.7.4)", b0);

            // ---------------------------------------------------------------- fitting the PC to the viewer (1.8)
            b0 = failures;
            {
                // A 4K monitor's modes (16:9 and the usual others), at 60 Hz, 2560×1440 at 144 Hz too.
                var modes = new List<DisplayMode>();
                foreach (var s in new[] { "3840x2160", "3200x1800", "2560x1440", "2048x1152", "1920x1080", "1680x1050", "1600x900", "1440x900", "1366x768", "1280x1024", "1280x720", "1024x768", "800x600" })
                {
                    var p = s.Split('x');
                    modes.Add(new DisplayMode(int.Parse(p[0]), int.Parse(p[1]), 60));
                }
                modes.Add(new DisplayMode(2560, 1440, 144));
                var at4k = new DisplayMode(3840, 2160, 60);
                Func<int, int, string> pick = (w, h) => { var m = DisplayFit.Pick(modes, at4k, w, h); return m.HasValue ? m.Value + "@" + m.Value.Hz : "none"; };
                Check(pick(1920, 1080) == "1920×1080@60", "a full HD screen: full HD (" + pick(1920, 1080) + ")");
                Check(pick(1920, 1200) == "1920×1080@60", "a 16:10 laptop (1920×1200): 1920×1080 pixel for pixel, not 1680×1050 stretched (" + pick(1920, 1200) + ")");
                Check(pick(3840, 2160) == "3840×2160@60", "a 4K screen: 4K");
                Check(pick(2340, 1080) == "1920×1080@60", "a phone held sideways (2340×1080): 1920×1080, its height pixel for pixel (" + pick(2340, 1080) + ")");
                Check(pick(1080, 2340) == "1024×768@60", "a phone held upright: the mode that fills its width best (" + pick(1080, 2340) + ")");
                Check(pick(1500, 950) == "1440×900@60", "a window of 1500×950: 1440×900 (" + pick(1500, 950) + ")");
                Check(pick(800, 600) == "1024×768@60", "a small window: never below 1024×720 (" + pick(800, 600) + ")");
                Check(pick(100, 100) == "none" && pick(20000, 1000) == "none", "a viewer size that can't be: nothing");
                var at144 = new DisplayMode(2560, 1440, 144);
                Check(DisplayFit.Pick(modes, at144, 2560, 1440).Value.Hz == 144 && DisplayFit.Pick(modes, at144, 1920, 1080).Value.Hz == 60, "the current refresh rate where the size has it, else the size's own");
                Check(DisplayFit.Pick(new List<DisplayMode>(), at4k, 1920, 1080).Value.W == 3840, "no modes read: the current one");

                Check(DisplayFit.Scale(new DisplayMode(1920, 1080, 60), 1920, 1200, 1.25, 175) == 125, "a laptop at 125%: 125%");
                Check(DisplayFit.Scale(new DisplayMode(1920, 1080, 60), 2340, 1080, 2.75, 175) == 175, "a phone (275%): as large as Windows allows at 1920×1080 (175%)");
                Check(DisplayFit.Scale(new DisplayMode(3840, 2160, 60), 3840, 2160, 1.5, 300) == 150, "a 4K screen at 150%: 150%");
                Check(DisplayFit.Scale(new DisplayMode(1440, 900, 60), 1500, 950, 1.0, 175) == 100, "a window at 100%: 100%");
                Check(DisplayFit.Scale(new DisplayMode(1920, 1080, 60), 1920, 1080, 1.125, 200) == 100, "halfway between two steps: the lower one");
                Check(DisplayFit.Scale(new DisplayMode(1920, 1080, 60), 3840, 2160, 1.0, 175) == 100, "shown twice as large: 100% (Windows' least)");
                Check(DisplayFit.Scale(new DisplayMode(1920, 1080, 60), 1920, 1080, double.NaN, 175) == 100, "a scaling that can't be: 100%");

                var saved = new SavedDisplay();
                saved.Device = @"\\.\DISPLAY1";
                saved.Mode = new DisplayMode(3840, 2160, 60);
                saved.Percent = 150;
                Check(SavedDisplay.Parse(saved.ToString()) != null && SavedDisplay.Parse(saved.ToString()).ToString() == @"\\.\DISPLAY1|3840|2160|60|150", "the original, written down and read back (" + saved + ")");
                Check(new[] { null, "", "x", "a|b|c|d|e", @"\\.\D|100|100|60|150", @"\\.\D|3840|2160|60", @"\\.\D|-3840|2160|60|150" }.All(s => SavedDisplay.Parse(s) == null), "...one that can't be read: none");

                // A fit and its undo, on the made-up screen (2560×1440 at 150%).
                var fake = new FakeDisplay();
                var lines = new List<string>();
                var d = new RcDisplay(fake, lines.Add);
                var plan = d.Plan("DISPLAY1", 1920, 1200, 1.25, true);
                Check(plan != null && plan.Mode.W == 1920 && plan.Mode.H == 1200 && plan.Original.Mode.W == 2560 && plan.Original.Percent == 150, "the plan: 1920×1200 (this screen has it: the exact size), the original (2560×1440 at 150%) noted first");
                d.Begin(plan);
                Check(d.Apply(plan) == null && fake.Now.W == 1920 && fake.Now.H == 1200 && fake.Percent == 125, "applied: 1920×1200 at 125% (" + fake.State + ")");
                var again = d.Plan("DISPLAY1", 2340, 1080, 2.75, true);
                Check(again != null && again.Original == plan.Original, "a second fit in the session keeps the first original");
                Check(d.Fitted && d.Undo(d.Original, "test") && fake.Now.W == 2560 && fake.Now.H == 1440 && fake.Percent == 150, "undone: 2560×1440 at 150% again (" + fake.State + ")");
                d.End();
                Check(!d.Fitted && lines.Count == 2 && lines[0].StartsWith("fitted to the viewer: 1920×1200 at 125%") && lines[1].StartsWith("back to 2560×1440 at 150%"), "the log: " + string.Join(" / ", lines));

                var phone = new FakeDisplay();
                var dp = new RcDisplay(phone, null);
                var pp = dp.Plan("DISPLAY1", 2340, 1080, 2.75, true);
                dp.Begin(pp);
                dp.Apply(pp);
                Check(phone.Now.W == 1920 && phone.Percent == 175, "a phone: 1920×1080 at 175%, the most Windows allows there (" + phone.State + ")");
                var same = new FakeDisplay();
                var ds = new RcDisplay(same, null);
                var ps = ds.Plan("DISPLAY1", 2560, 1440, 1.5, true);
                ds.Begin(ps);
                ds.Apply(ps);
                Check(same.Calls.Count == 0, "already the right size and scaling: nothing changes (" + same.State + ")");
                var moved = new FakeDisplay();
                moved.Saved = new DisplayMode(1920, 1080, 60); // (Windows' saved mode isn't what was on screen)
                var dm = new RcDisplay(moved, null);
                var pm = dm.Plan("DISPLAY1", 1280, 720, 1.0, true);
                dm.Begin(pm);
                dm.Apply(pm);
                Check(dm.Undo(dm.Original, "test") && moved.Now.W == 2560 && moved.Now.H == 1440, "Windows' saved mode was another: back to the original size all the same (" + moved.State + ")");

                // 1.11.4: without the viewer's "Bigger text" the scaling stays the screen's own (150% here), or the
                // nearest that size allows; nothing at all changes when the size is right already.
                var own = new FakeDisplay();
                var ownLines = new List<string>();
                var dn = new RcDisplay(own, ownLines.Add);
                var pn = dn.Plan("DISPLAY1", 1920, 1200, 1.25, false);
                dn.Begin(pn);
                Check(dn.Apply(pn) == null && own.Now.W == 1920 && own.Now.H == 1200 && own.Percent == 150 && pn.Changed, "without Bigger text: 1920×1200, its own 150% kept (" + own.State + ")");
                Check(ownLines.Count == 1 && ownLines[0].StartsWith("fitted to the viewer: 1920×1200 at 150% (its own scaling); it was 2560×1440 at 150%"), "...the log says so: " + string.Join(" / ", ownLines));
                var small = new FakeDisplay();
                var smallLines = new List<string>();
                var dsm = new RcDisplay(small, smallLines.Add);
                var psm = dsm.Plan("DISPLAY1", 1280, 720, 1.0, false);
                dsm.Begin(psm);
                dsm.Apply(psm);
                Check(small.Now.W == 1280 && small.Percent == 125 && smallLines.Count == 1 && smallLines[0].Contains("at 125% (its own 150% doesn't go at this size)"), "...a size that can't have 150%: the nearest it allows, 125% (" + small.State + ")");
                var right = new FakeDisplay();
                var dr = new RcDisplay(right, null);
                var pr = dr.Plan("DISPLAY1", 2560, 1440, 2.0, false);
                dr.Begin(pr);
                dr.Apply(pr);
                Check(right.Calls.Count == 0 && !pr.Changed, "...the right size already: nothing changes, whatever the viewer's own scaling (" + right.State + ")");
            }
            Section("fitting the PC to the viewer: its size and scaling, noted and put back (1.8; its scaling only with Bigger text, 1.11.4)", b0);

            // ---------------------------------------------------------------- keyboard and mouse across PCs (1.12)
            int k0 = failures;
            {
                // The user's desk: Office Desktop's one screen, Shop Desktop's monitor with a TV on the wall above it, the
                // laptop's dock monitor to the left of the laptop's own screen (its main display, at 150%).
                Func<int, int, int, int, int, bool, double, KvmScreen> ks = (id, x, y, w, h, main, sc) => new KvmScreen { Id = id, X = x, Y = y, W = w, H = h, Primary = main, Scale = sc };
                var laptop = new KvmDesk(new[] { ks(0, 0, 0, 1920, 1200, true, 1.5), ks(1, -2560, -120, 2560, 1440, false, 1.0) });
                var shop = new KvmDesk(new[] { ks(0, 0, 0, 1920, 1080, true, 1.0), ks(1, -960, -2160, 3840, 2160, false, 2.0) });
                var camera = new KvmDesk(new[] { ks(0, 0, 0, 1920, 1080, true, 1.0) });
                Check(laptop.MainOn(-1).Id == 1, "the laptop's left side is its dock monitor's (its own screen has the dock beside it)");
                Check(!laptop.OpenSide(-1, 0, 600) && laptop.OpenSide(-1, -2560, 600), "...the laptop screen's left edge isn't open, the dock's is");
                double hl = laptop.ExitHeight(-1, laptop.Screen(1), 600);
                Check(Math.Abs(hl - 720.0 / 1439) < 1e-9, "leaving by the dock's left edge at its middle: height " + hl);
                var into = shop.Enter(1, hl);
                Check(into.Screen == 0 && into.X == 1919 && into.Y == 540, "onto Shop's monitor (not the TV above it) at its right edge, the same height: " + into.Screen + " " + into.X + "," + into.Y);
                var up = shop.Move(new KvmPoint(0, 500, 3), 0, -10);
                Check(up.Exit == 0 && up.At.Screen == 1 && up.At.Y == -7, "up from Shop's monitor into its TV: screen " + up.At.Screen + " y " + up.At.Y);
                var offTv = shop.Move(new KvmPoint(1, -950, -1000), -20, 0);
                Check(offTv.Exit == -1 && offTv.Height == 0, "off the TV's left side: out of SHOP at the top (the TV is above its main screen): " + offTv.Exit + " " + offTv.Height);
                var cam = camera.Enter(1, offTv.Height);
                Check(cam.Screen == 0 && cam.X == 1919 && cam.Y == 0, "...onto Camera's screen at its top right");
                var offMon = shop.Move(new KvmPoint(0, 5, 540), -10, 0);
                Check(offMon.Exit == -1 && Math.Abs(offMon.Height - 540.0 / 1079) < 1e-9, "off Shop's monitor's left side: out at its height");
                var cam2 = camera.Enter(1, offMon.Height);
                Check(cam2.X == 1919 && cam2.Y == 540, "...onto Camera's screen beside it at the same height: " + cam2.X + "," + cam2.Y);
                var back = camera.Move(new KvmPoint(0, 1915, 300), 10, 0);
                Check(back.Exit == 1, "off Camera's right side: back towards SHOP");
                var onShop = shop.Enter(-1, back.Height);
                Check(onShop.Screen == 0 && onShop.X == 0, "...onto Shop's monitor at its left edge");
                var home = shop.Move(new KvmPoint(0, 1915, 900), 10, 0);
                Check(home.Exit == 1 && Math.Abs(home.Height - 900.0 / 1079) < 1e-9, "off Shop's monitor's right side: home");
                var atHome = laptop.Enter(-1, home.Height);
                Check(atHome.Screen == 1 && atHome.X == -2560 && atHome.Y == -120 + (int)Math.Round(home.Height * 1439), "...onto the dock monitor's left edge at that height: " + atHome.X + "," + atHome.Y);
                var inside = shop.Move(new KvmPoint(0, 100, 100), 50, 30);
                Check(inside.Exit == 0 && inside.At.X == 150 && inside.At.Y == 130, "a move within a screen");
                var floor = shop.Move(new KvmPoint(0, 100, 1070), 0, 50);
                Check(floor.Exit == 0 && floor.At.Y == 1079, "down past the bottom with nothing below: stopped there");
                // Two screens side by side with a gap between them at this height: Windows stops at the edge, so does this.
                var gap = new KvmDesk(new[] { ks(0, 0, 0, 1920, 1080, true, 1), ks(1, 2000, 0, 1920, 1080, false, 1) });
                var stop = gap.Move(new KvmPoint(0, 1915, 500), 30, 0);
                Check(stop.Exit == 0 && stop.At.Screen == 0 && stop.At.X == 1919, "a gap to the next screen: stopped at the edge, not out of the PC");
                // (1.12.3) The user's laptop screen is taller than its dock monitor: at its corners above and below the
                // monitor Windows stops the pointer at its left edge, and that isn't a way out (it went over to SHOP);
                // the dock monitor's own left edge is.
                var tall = new KvmDesk(new[] { ks(0, 0, 0, 2880, 1800, true, 2.0), ks(1, -1920, 360, 1920, 1080, false, 1.0) });
                Check(!tall.OpenSide(-1, 0, 100) && !tall.OpenSide(-1, 0, 1700) && !tall.OpenSide(-1, 0, 900), "a laptop screen taller than its dock monitor: its left edge isn't a way out, above, beside or below the monitor");
                Check(tall.OpenSide(-1, -1920, 400) && tall.OpenSide(-1, -1920, 1400), "...the dock monitor's left edge is, top to bottom");
                Check(tall.MainOn(-1).Id == 1, "...and the pointer comes back onto the dock monitor");
                // The same on a PC beside: the taller of two monitors side by side, at a height its neighbour doesn't
                // reach, stops the pointer at its edge (as Windows does there) instead of leaving past the neighbour.
                var pair = new KvmDesk(new[] { ks(0, 0, 0, 1920, 1080, true, 1), ks(1, -2560, 200, 2560, 800, false, 1) });
                var corner = pair.Move(new KvmPoint(0, 3, 50), -20, 0);
                Check(corner.Exit == 0 && corner.At.Screen == 0 && corner.At.X == 0, "a PC's taller monitor above its neighbour's top: stopped at its edge, not out past the neighbour (" + corner.Exit + ", " + corner.At.Screen + " " + corner.At.X + ")");
                var through = pair.Move(new KvmPoint(0, 3, 500), -20, 0);
                Check(through.Exit == 0 && through.At.Screen == 1, "...beside the neighbour: into it");
                var outside = pair.Move(new KvmPoint(1, -2555, 500), -20, 0);
                Check(outside.Exit == -1, "...and out of that PC by the neighbour's own left edge");
                // The pointer keeps its speed across scalings (150% here, 100% there: two thirds as many pixels), fractions carried.
                var carry = new KvmCarry();
                int ox, oy, sum = 0;
                for (int i = 0; i < 3; i++) { carry.Scale(1, 0, 1.5, 1.0, out ox, out oy); sum += ox; }
                carry.Scale(3, -3, 1.5, 1.0, out ox, out oy);
                Check(sum == 2 && ox == 2 && oy == -2, "150% → 100%: 3 pixels make 2, a pixel at a time too (" + sum + "; " + ox + "," + oy + ")");
                // A kvm session's input: a point names its screen (any of the PC's); one it hasn't is dropped.
                var two = Layout(Scr(0, 0, 0, 1920, 1080, true, 1.0), Scr(1, -1280, 0, 1280, 1024, false, 1.0));
                var kb = new MemoryBackend();
                var kinj = Injector(kb, two);
                kinj.AnyScreen = true;
                kinj.Handle(Msg("{\"t\":\"mv\",\"n\":1,\"m\":1,\"x\":10,\"y\":20}"));
                var kr = kb.All();
                Check(kr.Count == 1 && Back(kr[0].Dx, two.X, two.W) == -1270 && Back(kr[0].Dy, two.Y, two.H) == 20, "mv on screen 1 lands there: " + (kr.Count > 0 ? Desc(kr[0]) : "none"));
                kb.Clear();
                kinj.Handle(Msg("{\"t\":\"mv\",\"n\":2,\"m\":7,\"x\":10,\"y\":20}"));
                Check(kb.All().Count == 0, "a screen it doesn't have: dropped");
                kinj.Handle(Msg("{\"t\":\"btn\",\"n\":3,\"b\":0,\"d\":true,\"m\":0,\"x\":100,\"y\":200}"));
                kr = kb.All();
                Check(kr.Count == 1 && (kr[0].Flags & InputInjector.LEFTDOWN) != 0 && Back(kr[0].Dx, two.X, two.W) == 100 && Back(kr[0].Dy, two.Y, two.H) == 200, "a click at its point on screen 0");
                kinj.ReleaseAll("test");
                // What the laptop's keyboard hook sees, as the code the other PC presses.
                Check(KeyMap.CodeOf(0x41, 0x1E, false) == "KeyA" && KeyMap.CodeOf(0x25, 0x4B, true) == "ArrowLeft" && KeyMap.CodeOf(0x5B, 0x5B, true) == "MetaLeft"
                    && KeyMap.CodeOf(0xA2, 0x1D, false) == "ControlLeft" && KeyMap.CodeOf(0xA3, 0x1D, true) == "ControlRight" && KeyMap.CodeOf(0x0D, 0x1C, true) == "NumpadEnter",
                    "the hook's keys as codes: A, ←, Win, both Ctrls, numpad Enter");
            }
            Section("keyboard and mouse across PCs: the user's desk (dock monitor, Shop's TV above), crossings, speed, any screen (1.12)", k0);

            Console.WriteLine();
            Console.WriteLine(failures == 0 ? "All " + passed + " checks passed." : failures + " of " + (passed + failures) + " checks FAILED.");
            return failures == 0 ? 0 : 1;
        }
    }
}
