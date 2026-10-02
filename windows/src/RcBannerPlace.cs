// Where the remote-control banner goes (Beam 1.7.4). It can be dragged anywhere but never off a screen, it grows and
// shrinks around its Stop button (the right end stays put), and it remembers where it was put: Stop's centre as
// fractions of that screen's working area, so another resolution or taskbar keeps it in the same place. Pure geometry
// (test/perf/windows-input-test checks it); RcBanner does the window.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.Linq;

namespace Beam
{
    class BannerArea
    {
        public readonly string Name;      // the screen's device name (\\.\DISPLAY1)
        public readonly Rectangle Work;   // its working area (without the taskbar)
        public readonly bool Primary;

        public BannerArea(string name, Rectangle work, bool primary)
        {
            Name = name ?? "";
            Work = work;
            Primary = primary;
        }
    }

    static class RcBannerPlace
    {
        // The area a rectangle belongs to: the one it overlaps most, else the one nearest its centre (null: no areas).
        public static BannerArea AreaOf(Rectangle r, IList<BannerArea> areas)
        {
            BannerArea best = null;
            long most = 0;
            foreach (var a in areas)
            {
                var i = Rectangle.Intersect(a.Work, r);
                long overlap = i.IsEmpty ? 0 : (long)i.Width * i.Height;
                if (overlap > most) { most = overlap; best = a; }
            }
            return best ?? AreaAt(new Point(r.X + r.Width / 2, r.Y + r.Height / 2), areas);
        }

        // The area a point is on, else the nearest one.
        public static BannerArea AreaAt(Point p, IList<BannerArea> areas)
        {
            BannerArea best = null;
            long nearest = long.MaxValue;
            foreach (var a in areas)
            {
                if (a.Work.Contains(p)) return a;
                long dx = Math.Max(Math.Max(a.Work.Left - p.X, 0), p.X - (a.Work.Right - 1));
                long dy = Math.Max(Math.Max(a.Work.Top - p.Y, 0), p.Y - (a.Work.Bottom - 1));
                long d = dx * dx + dy * dy;
                if (d < nearest) { nearest = d; best = a; }
            }
            return best;
        }

        public static BannerArea PrimaryOf(IList<BannerArea> areas)
        {
            return areas.FirstOrDefault(a => a.Primary) ?? areas.FirstOrDefault();
        }

        // r moved (never resized) so it lies fully inside the area; wider or taller than it: at its left or top edge.
        public static Point ClampTo(Rectangle r, BannerArea a)
        {
            if (a == null) return r.Location;
            var w = a.Work;
            return new Point(Math.Max(w.Left, Math.Min(r.X, w.Right - r.Width)), Math.Max(w.Top, Math.Min(r.Y, w.Bottom - r.Height)));
        }

        public static Point Clamp(Rectangle r, IList<BannerArea> areas)
        {
            return ClampTo(r, AreaOf(r, areas));
        }

        // While dragging: inside the screen the pointer is on, so it follows the pointer from one screen to the next.
        public static Point DragTo(Rectangle r, Point pointer, IList<BannerArea> areas)
        {
            return ClampTo(r, AreaAt(pointer, areas));
        }

        // Fully on one screen.
        public static bool OnScreen(Rectangle r, IList<BannerArea> areas)
        {
            return areas.Any(a => a.Work.Contains(r));
        }

        // The usual place: the top centre of the area, `margin` below its top.
        public static Point TopCentre(Size size, BannerArea a, int margin)
        {
            if (a == null) return Point.Empty;
            return new Point(a.Work.X + (a.Work.Width - size.Width) / 2, a.Work.Y + margin);
        }

        // Another width with the right end (Stop) where it was, then inside the screen it was on.
        public static Point Resize(Rectangle r, int width, IList<BannerArea> areas)
        {
            var a = AreaOf(r, areas);
            return ClampTo(new Rectangle(r.Right - width, r.Y, width, r.Height), a);
        }

        // "name|fx|fy": Stop's centre as fractions of the working area of the screen it's on.
        public static string Spot(Point stopCentre, IList<BannerArea> areas)
        {
            var a = AreaAt(stopCentre, areas);
            if (a == null || a.Work.Width <= 0 || a.Work.Height <= 0) return null;
            double fx = Clamp01((stopCentre.X - a.Work.X) / (double)a.Work.Width);
            double fy = Clamp01((stopCentre.Y - a.Work.Y) / (double)a.Work.Height);
            return a.Name + "|" + fx.ToString("0.####", CultureInfo.InvariantCulture) + "|" + fy.ToString("0.####", CultureInfo.InvariantCulture);
        }

        // Where a banner of `size`, whose Stop centre is at `stopOffset` inside it, goes for a saved spot: the same
        // screen if it's still there (else the primary), Stop at the same fractions, inside the screen. null: no spot,
        // or one that can't be read (then the usual place).
        public static Point? FromSpot(string spot, Size size, Point stopOffset, IList<BannerArea> areas)
        {
            if (string.IsNullOrEmpty(spot) || spot.Length > 300 || areas.Count == 0) return null;
            int j = spot.LastIndexOf('|');
            int i = j > 0 ? spot.LastIndexOf('|', j - 1) : -1;
            if (i < 0) return null;
            double fx, fy;
            const NumberStyles num = NumberStyles.AllowDecimalPoint;
            if (!double.TryParse(spot.Substring(i + 1, j - i - 1), num, CultureInfo.InvariantCulture, out fx)
                || !double.TryParse(spot.Substring(j + 1), num, CultureInfo.InvariantCulture, out fy)) return null;
            if (double.IsNaN(fx) || double.IsNaN(fy) || double.IsInfinity(fx) || double.IsInfinity(fy)) return null; // (.NET reads "NaN" whatever the styles)
            string name = spot.Substring(0, i);
            var a = areas.FirstOrDefault(x => x.Name == name) ?? PrimaryOf(areas);
            var stop = new Point(a.Work.X + (int)Math.Round(Clamp01(fx) * a.Work.Width), a.Work.Y + (int)Math.Round(Clamp01(fy) * a.Work.Height));
            return ClampTo(new Rectangle(stop.X - stopOffset.X, stop.Y - stopOffset.Y, size.Width, size.Height), a);
        }

        static double Clamp01(double v)
        {
            return double.IsNaN(v) ? 0 : Math.Max(0, Math.Min(1, v));
        }
    }
}
