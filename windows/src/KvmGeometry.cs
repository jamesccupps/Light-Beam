// Keyboard and mouse across PCs (Beam 1.12, KvmController): the arithmetic of where the pointer is once it has left
// this PC's screen, and where it goes. Each PC's screens are in its own physical pixels, as Windows arranges them there
// (this PC's from Windows, the others' from their hello), and the PCs stand in a row with this PC on the right.
// - Within a PC the pointer moves as Windows moves it: across into the screen beside, up or down into the one above or
//   below (Shop Desktop's TV on the wall above its monitor), stopped where there's no screen.
// - It leaves a PC through a screen's side where nothing of that PC lies further that way at that height, and comes onto
//   the next PC's main screen on that side (its main display, or the screen on that side nearest it), at the same height
//   as a share of the screen it left. So the desk's monitors meet each other (the user's desk: Office Desktop's screen,
//   Shop Desktop's monitor, the laptop's dock monitor, the laptop), and a screen above or below the main ones (the TV)
//   leaves at their top or bottom and is reached from its own PC.
// No Windows calls here: windows-input-test checks it.
using System;
using System.Collections.Generic;
using System.Linq;

namespace Beam
{
    class KvmScreen
    {
        public int Id;               // the PC's own number for it (InputInjector's screen id; `m` in mv, btn, wheel)
        public int X, Y, W, H;       // physical pixels, relative to that PC's main screen's corner
        public bool Primary;         // that PC's main display
        public double Scale = 1;     // its scaling (1.5 at 150%)

        public int Right { get { return X + W; } }
        public int Bottom { get { return Y + H; } }
        public bool Contains(int x, int y) { return x >= X && x < Right && y >= Y && y < Bottom; }
    }

    // Where the pointer is on a PC: one of its screens, and a point of its desktop on that screen.
    struct KvmPoint
    {
        public int Screen, X, Y;
        public KvmPoint(int screen, int x, int y) { Screen = screen; X = x; Y = y; }
    }

    // The result of a move: the new point, or (Exit -1 left, +1 right) the side it left by, at a height (0..1).
    struct KvmMove
    {
        public KvmPoint At;
        public int Exit;
        public double Height;
    }

    // One PC's screens.
    class KvmDesk
    {
        public readonly List<KvmScreen> Screens;

        public KvmDesk(IEnumerable<KvmScreen> screens)
        {
            Screens = (screens ?? Enumerable.Empty<KvmScreen>()).Where(s => s != null && s.W > 0 && s.H > 0 && s.W <= 65536 && s.H <= 65536).ToList();
        }

        public bool Empty { get { return Screens.Count == 0; } }

        public KvmScreen Screen(int id) { return Screens.FirstOrDefault(s => s.Id == id); }

        public KvmScreen At(int x, int y) { return Screens.FirstOrDefault(s => s.Contains(x, y)); }

        KvmScreen Main { get { return Screens.FirstOrDefault(s => s.Primary) ?? Screens.FirstOrDefault(s => s.X == 0 && s.Y == 0) ?? Screens[0]; } }

        // Whether the pointer leaves this PC at x on that side (-1 left, +1 right) at this height: nothing of this PC lies
        // beyond x at that height, and no screen of it stands wholly beyond the screen it's on. (1.12.3: the laptop's own
        // screen and its dock monitor differ in height; at the screen's corners above and below the monitor Windows stops
        // the pointer at its inner edge, and that was taken for a way out: the pointer went over to SHOP. A TV above a
        // monitor isn't wholly beside it: the monitor's own edge stays a way out.)
        public bool OpenSide(int side, int x, int y)
        {
            if (Screens.Any(s => y >= s.Y && y < s.Bottom && (side < 0 ? s.X < x : s.Right > x + 1))) return false;
            var on = At(x, y);
            return on == null || !Screens.Any(s => s != on && (side < 0 ? s.Right <= on.X : s.X >= on.Right));
        }

        bool Open(KvmScreen s, int side) { return OpenSide(side, side < 0 ? s.X : s.Right - 1, s.Y + s.H / 2); }

        // The main screen on a side: the main display if that side of it is open, else the screen open on that side whose
        // middle is nearest the main display's (at its height first).
        public KvmScreen MainOn(int side)
        {
            var main = Main;
            var open = Screens.Where(s => Open(s, side)).ToList();
            if (open.Count == 0) return main;
            if (open.Contains(main)) return main;
            int mid = main.Y + main.H / 2;
            return open.OrderBy(s => mid >= s.Y && mid < s.Bottom ? 0 : 1).ThenBy(s => Math.Abs(s.Y + s.H / 2 - mid)).ThenBy(s => side < 0 ? s.X : -s.Right).First();
        }

        // Where the pointer comes onto this PC through its side (-1: the left one, +1: the right) at a height (0 the top):
        // its main screen on that side, just inside.
        public KvmPoint Enter(int side, double height)
        {
            var s = MainOn(side);
            int y = s.Y + (int)Math.Round(Clamp01(height) * (s.H - 1));
            return new KvmPoint(s.Id, side < 0 ? s.X : s.Right - 1, y);
        }

        // The height (0..1) of a point leaving by a side from screen `s`: on the main screen on that side, its share of
        // it; from a screen above or below it (a TV on the wall), its top or bottom.
        public double ExitHeight(int side, KvmScreen s, int y)
        {
            var main = MainOn(side);
            if (s == null || s == main || (y >= main.Y && y < main.Bottom)) return Clamp01((y - main.Y) / (double)Math.Max(1, main.H - 1));
            return y < main.Y ? 0 : 1;
        }

        // A move by (dx, dy) from p, as Windows moves a pointer: across into a screen beside the one it's on, stopped
        // where there's none, and out of the PC where its own side is open (Exit).
        public KvmMove Move(KvmPoint p, int dx, int dy)
        {
            var r = new KvmMove();
            var cur = Screen(p.Screen) ?? At(p.X, p.Y) ?? Screens[0];
            int x = Math.Max(cur.X, Math.Min(cur.Right - 1, p.X)), y = Math.Max(cur.Y, Math.Min(cur.Bottom - 1, p.Y));
            // Across first, then up or down (each step only within screens: a gap stops it).
            int nx = x + dx;
            if (nx < cur.X || nx >= cur.Right)
            {
                var beside = At(nx, y);
                if (beside != null) cur = beside;
                else
                {
                    int side = nx < cur.X ? -1 : 1;
                    int edgeX = side < 0 ? cur.X : cur.Right - 1;
                    if (OpenSide(side, edgeX, y))
                    {
                        r.Exit = side;
                        r.Height = ExitHeight(side, cur, y);
                        r.At = new KvmPoint(cur.Id, edgeX, y);
                        return r;
                    }
                    // (another screen further along at this height, with a gap: Windows stops at the edge too)
                    nx = edgeX;
                }
            }
            int ny = y + dy;
            if (ny < cur.Y || ny >= cur.Bottom)
            {
                var other = At(nx, ny);
                if (other != null) cur = other;
                else ny = Math.Max(cur.Y, Math.Min(cur.Bottom - 1, ny));
            }
            r.At = new KvmPoint(cur.Id, nx, ny);
            return r;
        }

        static double Clamp01(double v) { return double.IsNaN(v) ? 0.5 : v < 0 ? 0 : v > 1 ? 1 : v; }
    }

    // A move's share of a pixel that doesn't go yet (another PC's screens scale differently): carried to the next one.
    class KvmCarry
    {
        double rx, ry;

        public void Reset() { rx = ry = 0; }

        // (dx, dy) of this PC's pixels at its scaling, in the other PC's pixels at `to`: the pointer covers as much of
        // what's shown there as it does here.
        public void Scale(int dx, int dy, double from, double to, out int ox, out int oy)
        {
            double k = from > 0 && to > 0 ? to / from : 1;
            if (k < 0.25) k = 0.25;
            if (k > 4) k = 4;
            double fx = dx * k + rx, fy = dy * k + ry;
            // (whole pixels go now; a hair under a whole one counts as one: 2/3 × 3 is 1.9999999999999998)
            ox = (int)Math.Truncate(fx + (fx > 0 ? 1e-9 : -1e-9));
            oy = (int)Math.Truncate(fy + (fy > 0 ? 1e-9 : -1e-9));
            rx = fx - ox;
            ry = fy - oy;
        }
    }
}
