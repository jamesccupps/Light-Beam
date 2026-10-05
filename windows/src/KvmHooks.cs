// The low-level hooks behind keyboard and mouse across PCs (Beam 1.12, KvmController), on a thread of their own with
// its own message loop: this PC's input never waits for Beam's window thread, and a handler only does arithmetic and
// queues (Windows drops a hook that takes too long). The mouse hook is in while the feature is on (it watches for the
// pointer at the edge); the keyboard hook only while the pointer is on another PC. Never in a test instance: the tests
// call KvmController's handlers directly. Beam ending in any way takes both hooks with it (Windows does), so this PC's
// keyboard and mouse can't be left captured.
// While the pointer is on another PC, this PC's own pointer waits in the middle of its screen, hidden: a window of this
// thread's over this PC's screens, all but transparent (1 of 255), with no pointer of its own. It's shown and hidden here,
// in the same step that moves the pointer, whatever Beam's window thread is doing (a busy window thread can't leave it
// over the screen). The hooks keep every click from it; mouse input that reaches it anyway (the hook gone, or Windows
// not giving it what goes to an administrator's window) brings the pointer back (Lost).
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;

namespace Beam
{
    // One input event as a hook saw it.
    struct KvmInput
    {
        public bool Key;                 // keyboard (else mouse)
        public int Msg;                  // WM_MOUSEMOVE, WM_LBUTTONDOWN… / WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP
        public int X, Y;                 // mouse: where the pointer would go (physical pixels)
        public int Data;                 // mouse: the wheel's delta or which X button (the high word of mouseData)
        public int Vk, Scan;             // keyboard
        public bool Extended;            // keyboard: an E0 key
        public bool Injected;            // put in by a program (SendInput), not the hardware: passed through
    }

    class KvmHooks
    {
        public const int WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202, WM_RBUTTONDOWN = 0x0204, WM_RBUTTONUP = 0x0205,
            WM_MBUTTONDOWN = 0x0207, WM_MBUTTONUP = 0x0208, WM_MOUSEWHEEL = 0x020A, WM_XBUTTONDOWN = 0x020B, WM_XBUTTONUP = 0x020C, WM_MOUSEHWHEEL = 0x020E,
            WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_SYSKEYDOWN = 0x0104, WM_SYSKEYUP = 0x0105;
        const int WM_QUIT = 0x0012, WM_APP_KEYS_ON = 0x8001, WM_APP_KEYS_OFF = 0x8002, WM_APP_COVER_OFF = 0x8003;

        readonly Func<KvmInput, bool> handler;  // on the hook thread; true: this PC doesn't get it
        Thread thread;
        uint threadId;
        IntPtr mouseHook = IntPtr.Zero, keyHook = IntPtr.Zero;
        HookProc mouseProc, keyProc;            // kept referenced while installed
        readonly ManualResetEventSlim started = new ManualResetEventSlim();
        IntPtr cover = IntPtr.Zero;              // the window over the screens while the pointer is away
        WndProcFn coverProc;                     // kept referenced while it exists
        int parkX, parkY, coverAt;
        public Action Lost;                      // (on this thread) mouse input reached the cover: the hook isn't keeping it

        public KvmHooks(Func<KvmInput, bool> handler)
        {
            this.handler = handler;
            mouseProc = OnMouse;
            keyProc = OnKey;
        }

        public bool Running { get { return mouseHook != IntPtr.Zero; } }

        public bool Start()
        {
            if (thread != null) return Running;
            thread = new Thread(Run);
            thread.IsBackground = true;
            thread.Name = "Beam keyboard and mouse hooks";
            thread.Start();
            started.Wait(3000);
            return Running;
        }

        void Run()
        {
            threadId = GetCurrentThreadId();
            mouseHook = SetWindowsHookEx(14 /* WH_MOUSE_LL */, mouseProc, GetModuleHandle(null), 0);
            if (mouseHook == IntPtr.Zero) Log.Write("Keyboard and mouse: the mouse hook couldn't be set (" + Marshal.GetLastWin32Error() + ")");
            started.Set();
            MSG msg;
            while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
            {
                if (msg.hwnd == IntPtr.Zero && msg.message == WM_APP_KEYS_ON) { KeysOn(); continue; }
                if (msg.hwnd == IntPtr.Zero && msg.message == WM_APP_KEYS_OFF) { KeysOff(); continue; }
                if (msg.hwnd == IntPtr.Zero && msg.message == WM_APP_COVER_OFF) { CoverOff(); continue; }
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }
            KeysOff();
            if (mouseHook != IntPtr.Zero) { UnhookWindowsHookEx(mouseHook); mouseHook = IntPtr.Zero; }
            if (cover != IntPtr.Zero) { DestroyWindow(cover); cover = IntPtr.Zero; }
        }

        // The keyboard hook in or out (asked from any thread; done on the hook thread). From inside a handler (the hook
        // thread itself) it's done at once.
        public void Keys(bool on)
        {
            if (thread == null) return;
            if (Thread.CurrentThread == thread) { if (on) KeysOn(); else KeysOff(); return; }
            PostThreadMessage(threadId, on ? WM_APP_KEYS_ON : WM_APP_KEYS_OFF, IntPtr.Zero, IntPtr.Zero);
        }

        void KeysOn()
        {
            if (keyHook != IntPtr.Zero) return;
            keyHook = SetWindowsHookEx(13 /* WH_KEYBOARD_LL */, keyProc, GetModuleHandle(null), 0);
            if (keyHook == IntPtr.Zero) Log.Write("Keyboard and mouse: the keyboard hook couldn't be set (" + Marshal.GetLastWin32Error() + ")");
        }

        void KeysOff()
        {
            if (keyHook == IntPtr.Zero) return;
            UnhookWindowsHookEx(keyHook);
            keyHook = IntPtr.Zero;
        }

        // On this thread only (the handler crossing over): the cover over `screens`, and the pointer at (px, py) under it.
        public void CoverOn(Rectangle screens, int px, int py)
        {
            if (Thread.CurrentThread != thread) return;
            if (cover == IntPtr.Zero)
            {
                coverProc = CoverProc;
                var wc = new WNDCLASSEX();
                wc.cbSize = Marshal.SizeOf(typeof(WNDCLASSEX));
                wc.lpfnWndProc = Marshal.GetFunctionPointerForDelegate(coverProc);
                wc.hInstance = GetModuleHandle(null);
                wc.lpszClassName = "BeamKvmCover";
                RegisterClassEx(ref wc); // (registered already by an earlier start: fine)
                // WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE; WS_POPUP
                cover = CreateWindowEx(0x00080000 | 0x00000008 | 0x00000080 | 0x08000000, "BeamKvmCover", "Beam keyboard and mouse", unchecked((int)0x80000000),
                    screens.X, screens.Y, screens.Width, screens.Height, IntPtr.Zero, IntPtr.Zero, wc.hInstance, IntPtr.Zero);
                if (cover == IntPtr.Zero) { Log.Write("Keyboard and mouse: the cover window couldn't be made (" + Marshal.GetLastWin32Error() + "); this PC's pointer stays visible meanwhile"); return; }
                SetLayeredWindowAttributes(cover, 0, 1, 0x02 /* LWA_ALPHA */);
            }
            parkX = px;
            parkY = py;
            coverAt = Environment.TickCount;
            SetWindowPos(cover, new IntPtr(-1) /* HWND_TOPMOST */, screens.X, screens.Y, screens.Width, screens.Height, 0x0010 | 0x0040); // NOACTIVATE | SHOWWINDOW
            SetCursorPos(px, py); // (over the cover now: the pointer takes its look, none)
        }

        // From any thread: the cover goes (at once on this thread, else as soon as this thread looks, in a moment).
        public void CoverOff()
        {
            if (thread == null) return;
            if (Thread.CurrentThread != thread) { PostThreadMessage(threadId, WM_APP_COVER_OFF, IntPtr.Zero, IntPtr.Zero); return; }
            if (cover != IntPtr.Zero) ShowWindow(cover, 0 /* SW_HIDE */);
        }

        IntPtr CoverProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam)
        {
            switch (msg)
            {
                case 0x0020: SetCursor(IntPtr.Zero); return new IntPtr(1); // WM_SETCURSOR: no pointer here
                case 0x0021: return new IntPtr(3);                       // WM_MOUSEACTIVATE: MA_NOACTIVATE
                case WM_MOUSEMOVE:
                {
                    POINT p;
                    // (a move to where the pointer waits is Windows placing it there, not the mouse)
                    if (GetCursorPos(out p) && (p.x != parkX || p.y != parkY)) LostNow();
                    break;
                }
                case WM_LBUTTONDOWN: case WM_RBUTTONDOWN: case WM_MBUTTONDOWN: case WM_XBUTTONDOWN: case WM_MOUSEWHEEL:
                    LostNow();
                    break;
            }
            return DefWindowProc(hwnd, msg, wParam, lParam);
        }

        void LostNow()
        {
            if (Environment.TickCount - coverAt < 300 || Lost == null) return;
            try { Lost(); } catch { }
        }

        public void Stop()
        {
            var t = thread;
            if (t == null) return;
            PostThreadMessage(threadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
            t.Join(3000);
            thread = null;
        }

        IntPtr OnMouse(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0)
            {
                var m = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
                var e = new KvmInput();
                e.Msg = wParam.ToInt32();
                e.X = m.pt.x;
                e.Y = m.pt.y;
                e.Data = (short)((m.mouseData >> 16) & 0xFFFF);
                e.Injected = (m.flags & 0x01) != 0; // LLMHF_INJECTED
                bool take = false;
                try { take = handler(e); } catch { }
                if (take) return new IntPtr(1);
            }
            return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
        }

        IntPtr OnKey(int code, IntPtr wParam, IntPtr lParam)
        {
            if (code >= 0)
            {
                var k = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
                var e = new KvmInput();
                e.Key = true;
                e.Msg = wParam.ToInt32();
                e.Vk = (int)k.vkCode;
                e.Scan = (int)k.scanCode;
                e.Extended = (k.flags & 0x01) != 0;  // LLKHF_EXTENDED
                e.Injected = (k.flags & 0x10) != 0;  // LLKHF_INJECTED
                bool take = false;
                try { take = handler(e); } catch { }
                if (take) return new IntPtr(1);
            }
            return CallNextHookEx(IntPtr.Zero, code, wParam, lParam);
        }

        [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
        [StructLayout(LayoutKind.Sequential)] struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)] struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public int message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }
        delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);
        delegate IntPtr WndProcFn(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct WNDCLASSEX { public int cbSize; public uint style; public IntPtr lpfnWndProc; public int cbClsExtra; public int cbWndExtra; public IntPtr hInstance; public IntPtr hIcon; public IntPtr hCursor; public IntPtr hbrBackground; public string lpszMenuName; public string lpszClassName; public IntPtr hIconSm; }
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern ushort RegisterClassEx(ref WNDCLASSEX wc);
        [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateWindowEx(int exStyle, string cls, string name, int style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
        [DllImport("user32.dll")] static extern IntPtr DefWindowProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr hwnd);
        [DllImport("user32.dll")] static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint key, byte alpha, uint flags);
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
        [DllImport("user32.dll")] static extern IntPtr SetCursor(IntPtr cursor);
        [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint thread);
        [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
        [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG msg);
        [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG msg);
        [DllImport("user32.dll")] static extern bool PostThreadMessage(uint thread, int msg, IntPtr wParam, IntPtr lParam);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    }
}
