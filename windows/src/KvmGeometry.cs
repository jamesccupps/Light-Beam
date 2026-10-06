// Keyboard and mouse across PCs (Beam 1.12, KvmController): the arithmetic of where the pointer is once it has left
// this PC's screen, and where it goes. Each PC's screens are in its own physical pixels, as Windows arranges them there
// (this PC's from Windows, the others' from their hello), and the PCs stand on a grid around this one (KvmLayout; 1.12.5:
// on any side, the user: "why can i only put computers to the left?").
// - Within a PC the pointer moves as Windows moves it: across into the screen beside, up or down into the one above or
//   below (Shop Desktop's TV on the wall above its monitor), stopped where there's no screen.
// - It leaves a PC through a screen's side where nothing of that PC lies further that way, when a PC stands on that side
//   (else it stops there, as at any edge), and comes onto that PC's main screen on the facing side (its main display, or
//   the screen on that side nearest it), at the same place along it as a share of the screen it left. So the desk's
//   monitors meet each other (the user's desk: Office Desktop's screen, Shop Desktop's monitor, the laptop's dock
//   monitor, the laptop), and a screen above or below the main ones (the TV) leaves at their top or bottom and is reached
//   from its own PC.
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

    // A side of a PC, all its screens together (1.12.5: the pointer leaves a PC, and comes onto the next, by any of them).
    enum KvmSide { None = 0, Left, Right, Top, Bottom }

    static class KvmSides
    {
        public static readonly KvmSide[] All = { KvmSide.Left, KvmSide.Right, KvmSide.Top, KvmSide.Bottom };

        public static KvmSide Opposite(KvmSide s)
        {
            switch (s)
            {
                case KvmSide.Left: return KvmSide.Right;
                case KvmSide.Right: return KvmSide.Left;
                case KvmSide.Top: return KvmSide.Bottom;
                case KvmSide.Bottom: return KvmSide.Top;
            }
            return KvmSide.None;
        }

        // Left and right: a place along them is a height; top and bottom: a place across.
        public static bool Upright(KvmSide s) { return s == KvmSide.Left || s == KvmSide.Right; }

        // That way, on the grid of PCs as in pixels: -1, 0 or +1.
        public static int Dx(KvmSide s) { return s == KvmSide.Left ? -1 : s == KvmSide.Right ? 1 : 0; }
        public static int Dy(KvmSide s) { return s == KvmSide.Top ? -1 : s == KvmSide.Bottom ? 1 : 0; }

        // Sets of sides (the ones a move may leave a PC by) as bits.
        public static int Bit(KvmSide s) { return 1 << (int)s; }
        public const int AllBits = 2 | 4 | 8 | 16;

        public static string Name(KvmSide s) { return s.ToString().ToLowerInvariant(); }

        public static KvmSide Parse(string s)
        {
            foreach (var x in All) if (string.Equals(Name(x), s, StringComparison.OrdinalIgnoreCase)) return x;
            return KvmSide.None;
        }

        // How a PC stands to the one beside it ("to the left of", "above"…).
        public static string Phrase(KvmSide s)
        {
            switch (s)
            {
                case KvmSide.Left: return "to the left of";
                case KvmSide.Right: return "to the right of";
                case KvmSide.Top: return "above";
                case KvmSide.Bottom: return "below";
            }
            return "beside";
        }
    }

    // The result of a move: the new point, or the side it left by (Exit) at a place along that side (0..1: from the top
    // of a left or right side, from the left end of a top or bottom one).
    struct KvmMove
    {
        public KvmPoint At;
        public KvmSide Exit;
        public double Along;
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

        // Whether the pointer leaves this PC at (x, y) by that side: nothing of this PC lies beyond that point that way, and
        // no screen of it stands wholly beyond the screen it's on. (1.12.3: the laptop's own screen and its dock monitor
        // differ in height; at the screen's corners above and below the monitor Windows stops the pointer at its inner
        // edge, and that was taken for a way out: the pointer went over to SHOP. A TV above a monitor isn't wholly beside
        // it: the monitor's own side edges stay ways out.)
        public bool OpenSide(KvmSide side, int x, int y)
        {
            switch (side)
            {
                case KvmSide.Left: if (Screens.Any(s => y >= s.Y && y < s.Bottom && s.X < x)) return false; break;
                case KvmSide.Right: if (Screens.Any(s => y >= s.Y && y < s.Bottom && s.Right > x + 1)) return false; break;
                case KvmSide.Top: if (Screens.Any(s => x >= s.X && x < s.Right && s.Y < y)) return false; break;
                case KvmSide.Bottom: if (Screens.Any(s => x >= s.X && x < s.Right && s.Bottom > y + 1)) return false; break;
                default: return false;
            }
            var on = At(x, y);
            return on == null || !Screens.Any(s => s != on && Beyond(s, on, side));
        }

        // Whether screen a stands wholly beyond screen b that way.
        static bool Beyond(KvmScreen a, KvmScreen b, KvmSide side)
        {
            switch (side)
            {
                case KvmSide.Left: return a.Right <= b.X;
                case KvmSide.Right: return a.X >= b.Right;
                case KvmSide.Top: return a.Bottom <= b.Y;
                case KvmSide.Bottom: return a.Y >= b.Bottom;
            }
            return false;
        }

        // Whether a screen's side is open at its middle.
        bool Open(KvmScreen s, KvmSide side)
        {
            switch (side)
            {
                case KvmSide.Left: return OpenSide(side, s.X, s.Y + s.H / 2);
                case KvmSide.Right: return OpenSide(side, s.Right - 1, s.Y + s.H / 2);
                case KvmSide.Top: return OpenSide(side, s.X + s.W / 2, s.Y);
                case KvmSide.Bottom: return OpenSide(side, s.X + s.W / 2, s.Bottom - 1);
            }
            return false;
        }

        // The main screen on a side: the main display if that side of it is open, else the screen open on that side whose
        // middle is nearest the main display's (in line with it first), the outermost of equals.
        public KvmScreen MainOn(KvmSide side)
        {
            var main = Main;
            var open = Screens.Where(s => Open(s, side)).ToList();
            if (open.Count == 0 || open.Contains(main)) return main;
            if (KvmSides.Upright(side))
            {
                int mid = main.Y + main.H / 2;
                return open.OrderBy(s => mid >= s.Y && mid < s.Bottom ? 0 : 1).ThenBy(s => Math.Abs(s.Y + s.H / 2 - mid)).ThenBy(s => side == KvmSide.Left ? s.X : -s.Right).First();
            }
            int midX = main.X + main.W / 2;
            return open.OrderBy(s => midX >= s.X && midX < s.Right ? 0 : 1).ThenBy(s => Math.Abs(s.X + s.W / 2 - midX)).ThenBy(s => side == KvmSide.Top ? s.Y : -s.Bottom).First();
        }

        // Where the pointer comes onto this PC through a side at a place along it (0: the top of a left or right side, the
        // left end of a top or bottom one): its main screen on that side, just inside.
        public KvmPoint Enter(KvmSide side, double along)
        {
            var s = MainOn(side);
            along = Clamp01(along);
            int down = s.Y + (int)Math.Round(along * (s.H - 1)), across = s.X + (int)Math.Round(along * (s.W - 1));
            switch (side)
            {
                case KvmSide.Right: return new KvmPoint(s.Id, s.Right - 1, down);
                case KvmSide.Top: return new KvmPoint(s.Id, across, s.Y);
                case KvmSide.Bottom: return new KvmPoint(s.Id, across, s.Bottom - 1);
                default: return new KvmPoint(s.Id, s.X, down);
            }
        }

        // The place along a side (0..1) of a point (x, y) leaving by it from screen `s`: on the main screen on that side,
        // its share of it; from a screen beyond one of its ends (a TV on the wall above it), that end.
        public double ExitAlong(KvmSide side, KvmScreen s, int x, int y)
        {
            var main = MainOn(side);
            if (KvmSides.Upright(side))
            {
                if (s == null || s == main || (y >= main.Y && y < main.Bottom)) return Clamp01((y - main.Y) / (double)Math.Max(1, main.H - 1));
                return y < main.Y ? 0 : 1;
            }
            if (s == null || s == main || (x >= main.X && x < main.Right)) return Clamp01((x - main.X) / (double)Math.Max(1, main.W - 1));
            return x < main.X ? 0 : 1;
        }

        // (this PC) Whether its pointer at (px, py), as its mouse hook sees it, is at or past the outer edge of its screens
        // on that side, where that side is open: the screen, and the point on its edge.
        public bool AtEdge(KvmSide side, int px, int py, out KvmScreen on, out int x, out int y)
        {
            x = px;
            y = py;
            switch (side)
            {
                case KvmSide.Left:
                    on = Screens.Where(s => py >= s.Y && py < s.Bottom).OrderBy(s => s.X).FirstOrDefault();
                    if (on == null || px > on.X) return false;
                    x = on.X;
                    break;
                case KvmSide.Right:
                    on = Screens.Where(s => py >= s.Y && py < s.Bottom).OrderByDescending(s => s.Right).FirstOrDefault();
                    if (on == null || px < on.Right - 1) return false;
                    x = on.Right - 1;
                    break;
                case KvmSide.Top:
                    on = Screens.Where(s => px >= s.X && px < s.Right).OrderBy(s => s.Y).FirstOrDefault();
                    if (on == null || py > on.Y) return false;
                    y = on.Y;
                    break;
                case KvmSide.Bottom:
                    on = Screens.Where(s => px >= s.X && px < s.Right).OrderByDescending(s => s.Bottom).FirstOrDefault();
                    if (on == null || py < on.Bottom - 1) return false;
                    y = on.Bottom - 1;
                    break;
                default:
                    on = null;
                    return false;
            }
            return OpenSide(side, x, y);
        }

        // A move by (dx, dy) from p, as Windows moves a pointer: across into a screen beside the one it's on, stopped
        // where there's none, and out of the PC where its own side is open and may be left (`leave`: the KvmSides.Bit of
        // each side with a PC beyond it). (1.12.5) A side that can't be left stops it like any edge, and the move goes on
        // along it: at Camera's left edge a move with a little of left in it lost its up or down.
        public KvmMove Move(KvmPoint p, int dx, int dy, int leave)
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
                    var side = nx < cur.X ? KvmSide.Left : KvmSide.Right;
                    int edgeX = side == KvmSide.Left ? cur.X : cur.Right - 1;
                    if ((leave & KvmSides.Bit(side)) != 0 && OpenSide(side, edgeX, y))
                    {
                        r.Exit = side;
                        r.Along = ExitAlong(side, cur, edgeX, y);
                        r.At = new KvmPoint(cur.Id, edgeX, y);
                        return r;
                    }
                    // (nothing to go to that way, or another screen further along at this height with a gap: Windows
                    // stops at the edge too)
                    nx = edgeX;
                }
            }
            int ny = y + dy;
            if (ny < cur.Y || ny >= cur.Bottom)
            {
                var other = At(nx, ny);
                if (other != null) cur = other;
                else
                {
                    var side = ny < cur.Y ? KvmSide.Top : KvmSide.Bottom;
                    int edgeY = side == KvmSide.Top ? cur.Y : cur.Bottom - 1;
                    if ((leave & KvmSides.Bit(side)) != 0 && OpenSide(side, nx, edgeY))
                    {
                        r.Exit = side;
                        r.Along = ExitAlong(side, cur, nx, edgeY);
                        r.At = new KvmPoint(cur.Id, nx, edgeY);
                        return r;
                    }
                    ny = edgeY;
                }
            }
            r.At = new KvmPoint(cur.Id, nx, ny);
            return r;
        }

        static double Clamp01(double v) { return double.IsNaN(v) ? 0.5 : v < 0 ? 0 : v > 1 ? 1 : v; }
    }

    // (1.12.5) Where a PC stands: its cell on a grid around this PC, which is 0,0 (-1,0 is to its left, 0,-1 above it).
    class KvmPlace
    {
        public string Id;
        public int X, Y;
    }

    // The PCs around this one, as the pointer goes between them: a PC's neighbours are the PCs in the cells beside its own
    // (this PC among them). A PC counts only if it joins up with this one, itself or through the others.
    class KvmLayout
    {
        public const int This = -1, Nothing = -2;
        public readonly KvmPlace[] Pcs;              // as given (the controller's links, in order)
        readonly Dictionary<long, int> at = new Dictionary<long, int>();
        readonly int[] via;                          // the PC each one is reached through on the way out (This: this PC)
        readonly bool[] joined;
        readonly List<int> order = new List<int>();  // the joined ones, nearest first

        static long Key(int x, int y) { return ((long)x << 32) ^ (uint)y; }

        public KvmLayout(IEnumerable<KvmPlace> pcs)
        {
            Pcs = (pcs ?? Enumerable.Empty<KvmPlace>()).ToArray();
            for (int i = 0; i < Pcs.Length; i++) at[Key(Pcs[i].X, Pcs[i].Y)] = i;
            via = new int[Pcs.Length];
            joined = new bool[Pcs.Length];
            // Outward from this PC, a step at a time, the sides always in the same order (left, right, top, bottom).
            var queue = new Queue<int>();
            queue.Enqueue(This);
            while (queue.Count > 0)
            {
                int from = queue.Dequeue();
                foreach (var side in KvmSides.All)
                {
                    int i = Beside(from, side);
                    if (i < 0 || joined[i]) continue;
                    joined[i] = true;
                    via[i] = from;
                    order.Add(i);
                    queue.Enqueue(i);
                }
            }
        }

        int X(int i) { return i == This ? 0 : Pcs[i].X; }
        int Y(int i) { return i == This ? 0 : Pcs[i].Y; }

        // What stands beside PC `from` (This: this PC) on that side: a PC (its index), This, or Nothing.
        public int Beside(int from, KvmSide side)
        {
            int x = X(from) + KvmSides.Dx(side), y = Y(from) + KvmSides.Dy(side);
            if (x == 0 && y == 0) return This;
            int i;
            return at.TryGetValue(Key(x, y), out i) ? i : Nothing;
        }

        public bool Joined(int i) { return i >= 0 && i < Pcs.Length && joined[i]; }

        // The PC a joined one is reached through (This, or another PC nearer this one).
        public int Via(int i) { return Joined(i) ? via[i] : This; }

        // The side of `a` that `b` stands on (the two beside each other).
        KvmSide SideTo(int a, int b)
        {
            int dx = X(b) - X(a), dy = Y(b) - Y(a);
            return dx < 0 ? KvmSide.Left : dx > 0 ? KvmSide.Right : dy < 0 ? KvmSide.Top : KvmSide.Bottom;
        }

        // The side of this PC the way out to PC i starts by (the way home ends by).
        public KvmSide HomeSide(int i)
        {
            if (!Joined(i)) return KvmSide.Left;
            while (via[i] != This) i = via[i];
            return SideTo(This, i);
        }

        // The side of PC i the way home starts by.
        public KvmSide TowardHome(int i) { return Joined(i) ? SideTo(i, via[i]) : KvmSide.Right; }

        // How a joined PC stands to the one it's reached through: "to the left of", with that PC's index (or This).
        public KvmSide SideOfVia(int i) { return Joined(i) ? SideTo(via[i], i) : KvmSide.None; }

        // Places as they may stand: an id, not this PC's cell, within reach (`max` cells), no id or cell twice (the first
        // one kept), at most `max` of them.
        public static List<KvmPlace> Clean(IEnumerable<KvmPlace> places, int max)
        {
            var list = new List<KvmPlace>();
            foreach (var p in places ?? Enumerable.Empty<KvmPlace>())
            {
                if (p == null || string.IsNullOrEmpty(p.Id) || (p.X == 0 && p.Y == 0) || Math.Abs(p.X) > max || Math.Abs(p.Y) > max) continue;
                if (list.Any(q => q.Id == p.Id || (q.X == p.X && q.Y == p.Y))) continue;
                list.Add(new KvmPlace { Id = p.Id, X = p.X, Y = p.Y });
                if (list.Count == max) break;
            }
            return list;
        }

        // The ones that join up with this PC, nearest first.
        public static List<KvmPlace> Joining(IEnumerable<KvmPlace> places, int max)
        {
            var l = new KvmLayout(Clean(places, max));
            return l.order.Select(i => l.Pcs[i]).ToList();
        }

        // The empty cells where another PC can go: beside this PC or a PC that joins up with it, within reach.
        public static List<KvmPlace> Slots(IEnumerable<KvmPlace> places, int max)
        {
            var l = new KvmLayout(Clean(places, max));
            var slots = new List<KvmPlace>();
            foreach (int from in new[] { This }.Concat(l.order))
                foreach (var side in KvmSides.All)
                {
                    if (l.Beside(from, side) != Nothing) continue;
                    int x = l.X(from) + KvmSides.Dx(side), y = l.Y(from) + KvmSides.Dy(side);
                    if (Math.Abs(x) > max || Math.Abs(y) > max || slots.Any(s => s.X == x && s.Y == y)) continue;
                    slots.Add(new KvmPlace { X = x, Y = y });
                }
            return slots;
        }
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
