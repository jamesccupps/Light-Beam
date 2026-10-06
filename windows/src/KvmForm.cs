// "Keyboard and mouse across PCs" (Beam 1.12): where the user's PCs stand around this one, and whether this PC's
// keyboard and mouse go over to them. (1.12.5) Arranged on a grid by dragging, on any side (the user: "why can i only put
// computers to the left?"); 1.12 had three lists, a row to its left. Each of those PCs decides for itself whether this
// one may (Allow remote control, with this PC on its list): that's only ever done at that PC.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Beam
{
    class KvmForm : DialogBase
    {
        readonly App app;
        readonly FlatCheck on;
        public readonly KvmArrange Arrange;

        public KvmForm(App app) : base("Keyboard and mouse across PCs", 600)
        {
            this.app = app;
            AddLabel("Keyboard and mouse across PCs", Ui.Title, false, Ui.S(10));
            AddLabel("Put your PCs where they stand around this one. Move the pointer off an edge of this PC's screens toward a " +
                "PC there and it carries on onto it, with the keyboard; what you copy on one PC (text or a picture) pastes on " +
                "the next. Move it back to come back.", Ui.Font, true, Ui.S(14));
            on = AddCheck("Use this PC's keyboard and mouse on the PCs beside it", null, app.Cfg.KvmOn, 0, Ui.S(12));
            Arrange = new KvmArrange(app, app.Cfg.KvmPlaces);
            Arrange.BackColor = Theme.Bg;
            Arrange.SetBounds(X0, Y, W0, Ui.S(300));
            Host.Controls.Add(Arrange);
            // (the first PC put there turns it on)
            bool none = Arrange.Count == 0;
            Arrange.Changed += (s, e) =>
            {
                if (none && Arrange.Count > 0) on.Checked = true;
                none = Arrange.Count == 0;
            };
            Y += Arrange.Height + Ui.S(10);
            AddLabel("Each of those PCs needs Beam 1.12 or later with “Allow remote control” on and this PC on its list " +
                "(its tray → Remote control devices…): that's only ever set at that PC. While this PC's keyboard and mouse can " +
                "reach one, it says so with a banner, which can be hidden there. A locked PC can't be used this way.", Ui.Small, true, Ui.S(14));

            var save = Button("Save", true);
            var cancel = Button("Cancel", false);
            save.SetBounds(ClientSize.Width - Pad - save.Width, Y, save.Width, save.Height);
            cancel.SetBounds(save.Left - Ui.S(10) - cancel.Width, Y, cancel.Width, cancel.Height);
            save.Click += (s, e) => Save();
            cancel.Click += (s, e) => Close();
            Y += save.Height + Pad;
            ClientSize = new Size(ClientSize.Width, Y);
        }

        public void Save()
        {
            var places = Arrange.Places();
            int joined = KvmLayout.Joining(places, KvmController.MaxPcs).Count;
            app.Cfg.KvmPlaces = places;
            app.Cfg.KvmOn = on.Checked && joined > 0;
            app.Cfg.Save();
            Log.Write("Keyboard and mouse across PCs: " + (app.Cfg.KvmOn ? "on" : "off") + ", " + (places.Count == 0 ? "no PCs" : places.Count + " PC(s) placed" +
                (joined < places.Count ? ", " + (places.Count - joined) + " not joined up with this one" : "")) + " (its settings)");
            app.Kvm.Apply("its settings");
            Close();
        }

        // (tests) What it shows.
        public string Describe() { return (on.Checked ? "on" : "off") + "; " + Arrange.Describe(); }

        // (tests) The window as drawn, into a PNG.
        public void Shot(string file)
        {
            using (var bmp = new Bitmap(Width, Height))
            {
                DrawToBitmap(bmp, new Rectangle(0, 0, Width, Height));
                bmp.Save(file, ImageFormat.Png);
            }
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            if (!Ui.TestOffscreen) Native.SetForegroundWindow(Handle);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Escape)
            {
                if (Arrange.Dragging) Arrange.CancelDrag(); // (Esc puts a PC being dragged back; again closes)
                else Close();
            }
            base.OnKeyDown(e);
        }
    }

    // (1.12.5) The PCs on a grid around this one, as they stand on the desk: this PC in the middle (it stays put), each PC
    // a tile. A tile drags to another cell beside the arrangement (onto another tile: the two swap); a + beside it puts a
    // PC there; a click on a tile offers Remove. A PC that doesn't join up with this one (no PC beside it leads here) is
    // drawn dashed, with a note: the pointer can't get there.
    class KvmArrange : Owner
    {
        readonly App app;
        readonly List<KvmPlace> places;              // where each PC stands (this PC is 0,0, not in it)
        public event EventHandler Changed;

        // The grid as drawn: cells minX.. and minY.., cols × rows of them, each cw × ch with `gap` between, the first at
        // (ox, oy); the canvas behind them, the note under it.
        int minX, minY, cols, rows, cw, ch, gap, ox, oy;
        Rectangle canvas;
        int NoteHeight { get { return Ui.S(40); } }

        Point? under;                 // the cell under the pointer
        string taken;                 // the PC the left button went down on (a click, or a drag once it moves)
        Point pressAt, dragAt;
        Size grab;                    // where in its tile it was taken
        bool dragging;
        Point? drop;                  // where it would go
        ContextMenuStrip menu;

        public KvmArrange(App app, IEnumerable<KvmPlace> start)
        {
            this.app = app;
            places = KvmLayout.Clean(start, KvmController.MaxPcs);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing && menu != null) menu.Dispose();
            base.Dispose(disposing);
        }

        public int Count { get { return places.Count; } }
        public bool Dragging { get { return dragging; } }

        public List<KvmPlace> Places() { return places.Select(p => new KvmPlace { Id = p.Id, X = p.X, Y = p.Y }).ToList(); }

        KvmPlace PcAt(Point c) { return places.FirstOrDefault(p => p.X == c.X && p.Y == c.Y); }

        string NameOf(string id)
        {
            var d = app.DeviceById(id);
            return d != null ? RcPolicy.DisplayName(d.Name) : "A PC that's no longer in Beam";
        }

        // ------------------------------------------------------------------ changes (its menus, a drag, tests)

        List<Point> Slots() { return KvmLayout.Slots(places, KvmController.MaxPcs).Select(s => new Point(s.X, s.Y)).ToList(); }

        bool IsSlot(Point c) { return places.Count < KvmController.MaxPcs && Slots().Contains(c); }

        public bool Add(string id, Point c)
        {
            if (string.IsNullOrEmpty(id) || id == app.Me || places.Any(p => p.Id == id) || !IsSlot(c)) return false;
            places.Add(new KvmPlace { Id = id, X = c.X, Y = c.Y });
            Done();
            return true;
        }

        public bool Remove(string id)
        {
            if (places.RemoveAll(p => p.Id == id) == 0) return false;
            Done();
            return true;
        }

        // Where a PC can go: an empty cell beside this PC or beside a PC that joins up with it (that PC itself left out),
        // or another PC's cell (they swap).
        List<Point> Targets(string id)
        {
            var others = places.Where(p => p.Id != id).ToList();
            var list = KvmLayout.Slots(others, KvmController.MaxPcs).Select(s => new Point(s.X, s.Y)).ToList();
            list.AddRange(others.Select(p => new Point(p.X, p.Y)));
            return list;
        }

        public bool MoveTo(string id, Point c)
        {
            var p = places.FirstOrDefault(q => q.Id == id);
            if (p == null || (p.X == c.X && p.Y == c.Y) || !Targets(id).Contains(c)) return false;
            var other = PcAt(c);
            if (other != null) { other.X = p.X; other.Y = p.Y; }
            p.X = c.X;
            p.Y = c.Y;
            Done();
            return true;
        }

        void Done()
        {
            under = null;
            Invalidate();
            if (Changed != null) Changed(this, EventArgs.Empty);
        }

        // ------------------------------------------------------------------ the grid

        // The cells shown: this PC's, every PC's, and the empty ones beside the arrangement (+, and where a drag can go: a
        // PC can only go beside it), at least those around this PC; as big as fits, 16:10 like a screen, up to 2:1 when
        // the height is short.
        void Grid()
        {
            int x0 = -1, x1 = 1, y0 = -1, y1 = 1;
            foreach (var p in places.Concat(KvmLayout.Slots(places, KvmController.MaxPcs)))
            {
                x0 = Math.Min(x0, p.X);
                x1 = Math.Max(x1, p.X);
                y0 = Math.Min(y0, p.Y);
                y1 = Math.Max(y1, p.Y);
            }
            minX = x0;
            minY = y0;
            cols = x1 - x0 + 1;
            rows = y1 - y0 + 1;
            canvas = new Rectangle(0, 0, Width - 1, Math.Max(Ui.S(60), Height - NoteHeight - 1));
            gap = Ui.S(8);
            int pad = Ui.S(14);
            int aw = canvas.Width - 2 * pad, ah = canvas.Height - 2 * pad;
            cw = Math.Max(Ui.S(24), (aw - (cols - 1) * gap) / cols);
            ch = Math.Max(Ui.S(16), (ah - (rows - 1) * gap) / rows);
            if (ch * 16 > cw * 10) ch = cw * 10 / 16;
            else cw = Math.Min(cw, ch * 2);
            ox = canvas.X + (canvas.Width - (cols * cw + (cols - 1) * gap)) / 2;
            oy = canvas.Y + (canvas.Height - (rows * ch + (rows - 1) * gap)) / 2;
        }

        Rectangle Cell(Point c) { return new Rectangle(ox + (c.X - minX) * (cw + gap), oy + (c.Y - minY) * (ch + gap), cw, ch); }

        // The cell a point is in (not in a gap), or null.
        Point? CellAt(Point pt)
        {
            for (int y = minY; y < minY + rows; y++)
                for (int x = minX; x < minX + cols; x++)
                    if (Cell(new Point(x, y)).Contains(pt)) return new Point(x, y);
            return null;
        }

        // The cell nearest a point (a gap goes to the nearer side), within the grid.
        Point NearestCell(Point pt)
        {
            int x = minX + (int)Math.Floor((pt.X - ox + gap / 2.0) / (cw + gap));
            int y = minY + (int)Math.Floor((pt.Y - oy + gap / 2.0) / (ch + gap));
            return new Point(Math.Max(minX, Math.Min(minX + cols - 1, x)), Math.Max(minY, Math.Min(minY + rows - 1, y)));
        }

        // ------------------------------------------------------------------ the mouse

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            Grid();
            var c = CellAt(e.Location);
            var p = c != null ? PcAt(c.Value) : null;
            if (e.Button != MouseButtons.Left || p == null) return;
            taken = p.Id;
            pressAt = e.Location;
            var r = Cell(c.Value);
            grab = new Size(e.X - r.X, e.Y - r.Y);
            Capture = true;
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            Grid();
            // (the button's state from the press, not from e: a test's messages carry no real button)
            if (taken != null)
            {
                if (!dragging && (Math.Abs(e.X - pressAt.X) > SystemInformation.DragSize.Width / 2 || Math.Abs(e.Y - pressAt.Y) > SystemInformation.DragSize.Height / 2))
                    dragging = true;
                if (dragging)
                {
                    dragAt = e.Location;
                    // (where the tile's middle is)
                    var c = NearestCell(new Point(e.X - grab.Width + cw / 2, e.Y - grab.Height + ch / 2));
                    drop = Targets(taken).Contains(c) ? c : (Point?)null;
                    Cursor = Cursors.SizeAll;
                    Invalidate();
                    return;
                }
            }
            var h = CellAt(e.Location);
            if (h != under) { under = h; Invalidate(); }
            Cursor = h != null && (PcAt(h.Value) != null || IsSlot(h.Value)) ? Cursors.Hand : Cursors.Default;
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            Grid();
            if (e.Button == MouseButtons.Left && dragging)
            {
                string id = taken;
                var to = drop;
                EndDrag();
                if (to != null) MoveTo(id, to.Value);
                return;
            }
            string was = taken;
            taken = null;
            Capture = false;
            var c = CellAt(e.Location);
            if (c == null) return;
            var p = PcAt(c.Value);
            if (p != null && (e.Button == MouseButtons.Right || (e.Button == MouseButtons.Left && was == p.Id))) PcMenu(p);
            else if (p == null && e.Button == MouseButtons.Left && IsSlot(c.Value)) AddMenu(c.Value);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            if (under != null && !dragging) { under = null; Invalidate(); }
            base.OnMouseLeave(e);
        }

        protected override void OnMouseCaptureChanged(EventArgs e)
        {
            if (dragging && !Capture) EndDrag(); // (the mouse went elsewhere mid-drag: Alt+Tab, a window in front)
            base.OnMouseCaptureChanged(e);
        }

        public void CancelDrag() { EndDrag(); }

        void EndDrag()
        {
            dragging = false;
            taken = null;
            drop = null;
            Cursor = Cursors.Default;
            if (Capture) Capture = false;
            Invalidate();
        }

        // ------------------------------------------------------------------ its menus

        // + : which PC goes there (the user's other Windows PCs not placed yet).
        void AddMenu(Point c)
        {
            var m = NewMenu();
            var pcs = app.Devices.Where(d => d.Id != app.Me && !d.Temporary && d.Platform == "windows" && !places.Any(p => p.Id == d.Id))
                .OrderBy(d => d.Name, StringComparer.CurrentCultureIgnoreCase).ToList();
            foreach (var d in pcs)
            {
                string id = d.Id;
                m.Items.Add(new ToolStripMenuItem(RcPolicy.DisplayName(d.Name) + (d.Online ? "" : "  (offline)"), MenuRenderer.Dot(d.Online ? Theme.Online : Theme.Offline), (s, e) => Add(id, c)));
            }
            if (pcs.Count == 0) m.Items.Add(new ToolStripMenuItem(places.Count > 0 ? "Your other Windows PCs are all placed" : "No other Windows PCs in your Beam") { Enabled = false });
            Pop(m, Cell(c));
        }

        // A PC: what it is, and Remove.
        void PcMenu(KvmPlace p)
        {
            var m = NewMenu();
            string id = p.Id;
            var d = app.DeviceById(id);
            m.Items.Add(new ToolStripMenuItem(NameOf(id) + (d == null ? "" : d.Online ? " · online" : " · offline")) { Enabled = false });
            m.Items.Add(new ToolStripSeparator());
            m.Items.Add(new ToolStripMenuItem("Remove", null, (s, e) => Remove(id)));
            Pop(m, Cell(new Point(p.X, p.Y)));
        }

        ContextMenuStrip NewMenu()
        {
            if (menu != null) menu.Dispose();
            menu = new ContextMenuStrip();
            return menu;
        }

        void Pop(ContextMenuStrip m, Rectangle near)
        {
            MenuRenderer.Apply(m);
            // (tests: never on screen; the test picks from it: TestPick)
            if (Ui.TestOffscreen) { Log.Write("Keyboard and mouse settings: (test) menu: " + string.Join(" | ", m.Items.OfType<ToolStripMenuItem>().Select(i => i.Text + (i.Enabled ? "" : " (off)")))); return; }
            m.Show(this, new Point(near.X, near.Bottom + Ui.S(4)));
        }

        // ------------------------------------------------------------------ drawing

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(BackColor);
            Grid();
            Ui.FillRound(g, Theme.Surface, canvas, Ui.S(10));
            Ui.DrawRound(g, Theme.Border, canvas, Ui.S(10), 1f);
            var joined = KvmLayout.Joining(places, KvmController.MaxPcs);
            if (dragging)
            {
                // Where it can go: empty cells (dashed), and the one it would go to now.
                foreach (var t in Targets(taken)) if (PcAt(t) == null) Slot(g, Cell(t), drop == t, false);
            }
            else if (places.Count < KvmController.MaxPcs)
                foreach (var s in Slots()) Slot(g, Cell(s), under == s, true);
            Here(g, Cell(Point.Empty));
            foreach (var p in places)
            {
                var c = new Point(p.X, p.Y);
                if (dragging && p.Id == taken) { Slot(g, Cell(c), drop == c, false); continue; } // (empty while it's carried)
                Tile(g, Cell(c), p, joined.Any(j => j.Id == p.Id), !dragging && under == c, dragging && drop == c, false);
            }
            if (dragging)
            {
                var p = places.FirstOrDefault(q => q.Id == taken);
                if (p != null) Tile(g, new Rectangle(dragAt.X - grab.Width, dragAt.Y - grab.Height, cw, ch), p, true, false, false, true);
            }
            Note(g, joined);
        }

        static Rectangle Inner(Rectangle r) { return new Rectangle(r.X, r.Y, r.Width - 1, r.Height - 1); }

        static void Dashed(Graphics g, Color c, Rectangle r, int radius)
        {
            var old = g.SmoothingMode;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var path = Ui.Round(Inner(r), radius))
            using (var pen = new Pen(c, Math.Max(1f, Ui.Scale)))
            {
                pen.DashStyle = DashStyle.Dash;
                g.DrawPath(pen, path);
            }
            g.SmoothingMode = old;
        }

        // Text in the middle of a box, on as many lines as fit.
        static void Middle(Graphics g, string s, Font f, Rectangle r, Color c)
        {
            var flags = Ui.Wrap | TextFormatFlags.HorizontalCenter | TextFormatFlags.EndEllipsis;
            int h = Math.Min(r.Height, TextRenderer.MeasureText(g, s, f, new Size(r.Width, int.MaxValue), flags).Height);
            TextRenderer.DrawText(g, s, f, new Rectangle(r.X, r.Y + (r.Height - h) / 2, r.Width, h), c, flags);
        }

        // An empty cell: a + to put a PC there, or (dragging) a place the PC can go.
        void Slot(Graphics g, Rectangle r, bool hot, bool plus)
        {
            int rad = Ui.S(8);
            if (hot) Ui.FillRound(g, plus ? Theme.Hover : Theme.Selected, Inner(r), rad);
            if (hot && plus) Ui.DrawRound(g, Theme.Accent, Inner(r), rad, 1f);
            else Dashed(g, plus ? Theme.Text3 : Theme.Accent, r, rad);
            if (plus) Plus(g, r, hot ? Theme.Accent : Theme.Text3);
        }

        // A + of two lines (a font's glyph came out tinted by ClearType).
        static void Plus(Graphics g, Rectangle r, Color c)
        {
            int half = Math.Max(Ui.S(5), Math.Min(r.Width, r.Height) / 8);
            int x = r.X + r.Width / 2, y = r.Y + r.Height / 2;
            using (var pen = new Pen(c, Math.Max(1f, (float)Math.Round(1.5 * Ui.Scale))))
            {
                g.DrawLine(pen, x - half, y, x + half, y);
                g.DrawLine(pen, x, y - half, x, y + half);
            }
        }

        // This PC: the one that stays put.
        void Here(Graphics g, Rectangle r)
        {
            Ui.FillRound(g, Theme.Accent, Inner(r), Ui.S(8));
            string me = RcPolicy.DisplayName(app.Cfg.DeviceName ?? "");
            var tr = Rectangle.Inflate(r, -Ui.S(6), -Ui.S(3));
            Middle(g, "This PC" + (me.Length > 0 ? "\n" + me : ""), Ui.Small, tr, Theme.AccentText);
        }

        // A PC: its name; a dot (online or not); dashed in the warning colour when it doesn't join up.
        void Tile(Graphics g, Rectangle r, KvmPlace p, bool joins, bool hot, bool target, bool lifted)
        {
            var d = app.DeviceById(p.Id);
            int rad = Ui.S(8);
            Ui.FillRound(g, target ? Theme.Selected : hot ? Theme.Hover : Theme.Surface2, Inner(r), rad);
            if (!joins) Dashed(g, Theme.Warning, r, rad);
            else Ui.DrawRound(g, lifted || target ? Theme.Accent : hot ? Theme.Text3 : Theme.Border, Inner(r), rad, lifted || target ? 1.5f : 1f);
            int dot = Ui.S(6);
            Ui.FillCircle(g, d != null && d.Online ? Theme.Online : Theme.Offline, new Rectangle(r.Right - dot - Ui.S(6), r.Y + Ui.S(6), dot, dot));
            var tr = Rectangle.Inflate(r, -Ui.S(11), -Ui.S(3));
            Middle(g, NameOf(p.Id), Ui.Small, tr, joins ? Theme.Text : Theme.Text2);
        }

        // Under the grid: how it works, or which PCs the pointer can't reach.
        void Note(Graphics g, List<KvmPlace> joined)
        {
            var lost = places.Where(p => !joined.Any(j => j.Id == p.Id)).Select(p => NameOf(p.Id)).ToList();
            string text;
            Color c = Theme.Text2;
            if (lost.Count > 0)
            {
                text = string.Join(" and ", lost) + (lost.Count == 1 ? " isn't" : " aren't") + " next to this PC or to a PC next to it, so the pointer can't get there.";
                c = Theme.Warning;
            }
            else if (places.Count == 0) text = "Click + beside this PC to put one of your PCs there.";
            else if (places.Count >= KvmController.MaxPcs) text = "Drag a PC to where it stands (onto another, they swap); click one to remove it. Three PCs at most.";
            else text = "Drag a PC to where it stands (onto another, they swap). + puts another PC there; click a PC to remove it.";
            TextRenderer.DrawText(g, text, Ui.Small, new Rectangle(0, canvas.Bottom + Ui.S(8), Width, NoteHeight - Ui.S(8)), c, Ui.Wrap);
        }

        // ------------------------------------------------------------------ tests (window messages to this control only:
        // no real input)

        public string Describe()
        {
            Grid();
            var joined = KvmLayout.Joining(places, KvmController.MaxPcs);
            return (places.Count == 0 ? "no PCs" : string.Join("; ", places.Select(p => NameOf(p.Id) + " " + p.X + "," + p.Y + (joined.Any(j => j.Id == p.Id) ? "" : " (not joined up)"))))
                + " | slots " + string.Join(" ", (places.Count < KvmController.MaxPcs ? Slots() : new List<Point>()).Select(s => s.X + "," + s.Y))
                + " | grid " + cols + "x" + rows;
        }

        const int WM_MOUSEMOVE = 0x0200, WM_LBUTTONDOWN = 0x0201, WM_LBUTTONUP = 0x0202, WM_RBUTTONDOWN = 0x0204, WM_RBUTTONUP = 0x0205;
        [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

        void Message(int msg, Point pt, int keys)
        {
            SendMessage(Handle, msg, (IntPtr)keys, (IntPtr)((pt.Y << 16) | (pt.X & 0xFFFF)));
        }

        static Point Mid(Rectangle r) { return new Point(r.X + r.Width / 2, r.Y + r.Height / 2); }

        // A drag of the tile in one cell to another, as the mouse would do it.
        public void TestDrag(Point from, Point to)
        {
            Grid();
            Point a = Mid(Cell(from)), b = Mid(Cell(to));
            Message(WM_MOUSEMOVE, a, 0);
            Message(WM_LBUTTONDOWN, a, 1);
            for (int k = 1; k <= 5; k++) Message(WM_MOUSEMOVE, new Point(a.X + (b.X - a.X) * k / 5, a.Y + (b.Y - a.Y) * k / 5), 1);
            Message(WM_LBUTTONUP, b, 0);
        }

        // A click on a cell (its menu is logged, not shown).
        public void TestClick(Point c, bool right)
        {
            Grid();
            var a = Mid(Cell(c));
            Message(WM_MOUSEMOVE, a, 0);
            Message(right ? WM_RBUTTONDOWN : WM_LBUTTONDOWN, a, right ? 2 : 1);
            Message(right ? WM_RBUTTONUP : WM_LBUTTONUP, a, 0);
        }

        // The item of the menu last opened that starts with this text.
        public bool TestPick(string text)
        {
            var item = menu == null ? null : menu.Items.OfType<ToolStripMenuItem>().FirstOrDefault(i => i.Enabled && i.Text.StartsWith(text, StringComparison.OrdinalIgnoreCase));
            if (item == null) return false;
            item.PerformClick();
            return true;
        }
    }
}
