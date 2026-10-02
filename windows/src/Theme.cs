// Light/dark theme (follows Windows' app theme), DPI scaling, fonts, drawing helpers and a few
// small owner-drawn controls (buttons, check boxes, text fields, menus) that look right in both themes.
using System;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Windows.Forms;
using Microsoft.Win32;

namespace Beam
{
    static class Theme
    {
        public static bool Dark;
        public static Color Bg, Sidebar, Surface, Surface2, Hover, Selected, Border, Text, Text2, Text3;
        public static Color Accent, AccentHover, AccentText, Mine, Theirs, Online, Offline, Danger, Warning, Scroll;
        public static event EventHandler Changed;

        public static void Load()
        {
            bool dark = false;
            try
            {
                using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                {
                    object v = k == null ? null : k.GetValue("AppsUseLightTheme");
                    if (v is int) dark = (int)v == 0;
                }
            }
            catch { }
            string forced = Environment.GetEnvironmentVariable("BEAM_THEME");
            if (forced == "dark") dark = true;
            if (forced == "light") dark = false;
            Dark = dark;
            if (dark)
            {
                Bg = Hex(0x0E1014); Sidebar = Hex(0x13161B); Surface = Hex(0x171A20); Surface2 = Hex(0x1F232B);
                Hover = Hex(0x1C2027); Selected = Hex(0x252140); Border = Hex(0x2A2F38);
                Text = Hex(0xE9EBEF); Text2 = Hex(0xA3A9B4); Text3 = Hex(0x737A86);
                Accent = Hex(0x8D80FF); AccentHover = Hex(0xA197FF); AccentText = Hex(0x0E1014);
                Mine = Hex(0x2A2550); Theirs = Hex(0x1C2027);
                Online = Hex(0x3DD68C); Offline = Hex(0x4A505B); Danger = Hex(0xFF6B70); Warning = Hex(0xF5B94A);
                Scroll = Hex(0x3A404B);
            }
            else
            {
                Bg = Hex(0xF6F7F9); Sidebar = Hex(0xEEEFF3); Surface = Hex(0xFFFFFF); Surface2 = Hex(0xF0F1F4);
                Hover = Hex(0xE4E5EA); Selected = Hex(0xE2DEFD); Border = Hex(0xDDDFE5);
                Text = Hex(0x15171C); Text2 = Hex(0x5B6270); Text3 = Hex(0x8A909C);
                Accent = Hex(0x5A4BF0); AccentHover = Hex(0x4A3AE0); AccentText = Color.White;
                Mine = Hex(0xE6E2FF); Theirs = Hex(0xFFFFFF);
                Online = Hex(0x1FAF5E); Offline = Hex(0xB5BAC3); Danger = Hex(0xD93036); Warning = Hex(0xB7791F);
                Scroll = Hex(0xC4C8CF);
            }
        }

        static Color Hex(int rgb)
        {
            return Color.FromArgb((rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF);
        }

        public static Color Blend(Color a, Color b, double t)
        {
            return Color.FromArgb(
                (int)(a.R + (b.R - a.R) * t),
                (int)(a.G + (b.G - a.G) * t),
                (int)(a.B + (b.B - a.B) * t));
        }

        public static void Watch(Control marshal)
        {
            SystemEvents.UserPreferenceChanged += (s, e) =>
            {
                if (e.Category != UserPreferenceCategory.General && e.Category != UserPreferenceCategory.Color) return;
                try
                {
                    marshal.BeginInvoke(new Action(() =>
                    {
                        bool was = Dark;
                        Load();
                        if (was != Dark && Changed != null) Changed(null, EventArgs.Empty);
                    }));
                }
                catch { }
            };
        }

        // Dark/light title bar (Windows 10 1809+) and, on Windows 11, a caption colour matching the window.
        public static void ApplyTitleBar(Form form, Color caption)
        {
            if (!form.IsHandleCreated) return;
            try
            {
                int on = Dark ? 1 : 0;
                if (Native.DwmSetWindowAttribute(form.Handle, 20, ref on, 4) != 0)
                    Native.DwmSetWindowAttribute(form.Handle, 19, ref on, 4);
                int color = caption.R | (caption.G << 8) | (caption.B << 16);
                Native.DwmSetWindowAttribute(form.Handle, 35, ref color, 4);
            }
            catch { }
        }

        public static void RoundCorners(Form form)
        {
            try
            {
                int round = 2;
                Native.DwmSetWindowAttribute(form.Handle, 33, ref round, 4);
            }
            catch { }
        }

        public static void DarkScrollbars(Control c)
        {
            try
            {
                if (c.IsHandleCreated) Native.SetWindowTheme(c.Handle, Dark ? "DarkMode_Explorer" : "Explorer", null);
            }
            catch { }
        }
    }

    static class Ui
    {
        public static float Scale = 1f;
        public static bool TestOffscreen; // tests: windows open off-screen and never take the focus

        // For forms: WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW in test mode.
        public static CreateParams TestParams(CreateParams cp)
        {
            if (TestOffscreen) cp.ExStyle |= 0x08000000 | 0x00000080;
            return cp;
        }

        public static void PlaceForTest(Form f)
        {
            if (!TestOffscreen) return;
            f.StartPosition = FormStartPosition.Manual;
            f.Location = new Point(-20000, -20000);
        }
        public static Font Font, Bold, Small, SmallBold, Title, Big, Icons, IconsSmall, IconsBig;
        static string iconFamily;

        public const string GAttach = "", GSend = "", GSettings = "", GCopy = "", GDelete = "",
            GOpen = "", GFolder = "", GDownload = "", GDoc = "", GAll = "", GPc = "",
            GPhone = "", GLaptop = "", GGlobe = "", GTerminal = "", GCheck = "",
            GClose = "", GRetry = "", GImage = "", GVideo = "", GAudio = "", GZip = "",
            GLink = "", GMore = "", GClip = "", GPeople = "";

        public const string GQr = "";

        public static void Init()
        {
            using (var g = Graphics.FromHwnd(IntPtr.Zero)) Scale = g.DpiX / 96f;
            string forced = Environment.GetEnvironmentVariable("BEAM_UI_SCALE");
            float f;
            if (forced != null && float.TryParse(forced, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out f) && f > 0.5f && f < 4f) Scale = f;
            string text = HasFont("Segoe UI Variable Text") ? "Segoe UI Variable Text" : "Segoe UI";
            string display = HasFont("Segoe UI Variable Display") ? "Segoe UI Variable Display" : "Segoe UI";
            Font = Px(text, 14f, FontStyle.Regular);
            Bold = Px(HasFont("Segoe UI Variable Text Semibold") ? "Segoe UI Variable Text Semibold" : "Segoe UI Semibold", 14f, FontStyle.Regular);
            Small = Px(text, 12f, FontStyle.Regular);
            SmallBold = Px(HasFont("Segoe UI Variable Small Semibol") ? "Segoe UI Variable Small Semibol" : "Segoe UI Semibold", 12f, FontStyle.Regular);
            Title = Px(HasFont("Segoe UI Variable Display Semib") ? "Segoe UI Variable Display Semib" : "Segoe UI Semibold", 17f, FontStyle.Regular);
            Big = Px(display, 22f, FontStyle.Regular);
            iconFamily = HasFont("Segoe Fluent Icons") ? "Segoe Fluent Icons" : "Segoe MDL2 Assets";
            Icons = Px(iconFamily, 16f, FontStyle.Regular);
            IconsSmall = Px(iconFamily, 12f, FontStyle.Regular);
            IconsBig = Px(iconFamily, 20f, FontStyle.Regular);
        }

        static bool HasFont(string name)
        {
            try
            {
                using (var f = new Font(name, 10f)) return string.Equals(f.Name, name, StringComparison.OrdinalIgnoreCase);
            }
            catch { return false; }
        }

        static Font Px(string family, float px, FontStyle style)
        {
            return new Font(family, px * Scale, style, GraphicsUnit.Pixel);
        }

        public static Font IconFont(float px)
        {
            return Px(iconFamily, px, FontStyle.Regular);
        }

        public static int S(float v)
        {
            return (int)Math.Round(v * Scale);
        }

        public static GraphicsPath Round(Rectangle r, int radius)
        {
            var p = new GraphicsPath();
            int d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
            if (d <= 1) { p.AddRectangle(r); return p; }
            p.AddArc(r.X, r.Y, d, d, 180, 90);
            p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            p.CloseFigure();
            return p;
        }

        public static void FillRound(Graphics g, Color color, Rectangle r, int radius)
        {
            var old = g.SmoothingMode;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var path = Round(r, radius))
            using (var b = new SolidBrush(color))
                g.FillPath(b, path);
            g.SmoothingMode = old;
        }

        public static void DrawRound(Graphics g, Color color, Rectangle r, int radius, float width)
        {
            var old = g.SmoothingMode;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var path = Round(r, radius))
            using (var p = new Pen(color, width))
                g.DrawPath(p, path);
            g.SmoothingMode = old;
        }

        public static void FillCircle(Graphics g, Color color, Rectangle r)
        {
            var old = g.SmoothingMode;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var b = new SolidBrush(color)) g.FillEllipse(b, r);
            g.SmoothingMode = old;
        }

        public const TextFormatFlags Line = TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding;
        public const TextFormatFlags Wrap = TextFormatFlags.NoPrefix | TextFormatFlags.WordBreak | TextFormatFlags.TextBoxControl | TextFormatFlags.NoPadding;
        public const TextFormatFlags Center = TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine | TextFormatFlags.VerticalCenter | TextFormatFlags.HorizontalCenter | TextFormatFlags.NoPadding;

        public static void Text(Graphics g, string s, Font f, Rectangle r, Color c, TextFormatFlags flags)
        {
            TextRenderer.DrawText(g, s, f, r, c, flags);
        }

        public static void Glyph(Graphics g, string glyph, Font f, Rectangle r, Color c)
        {
            TextRenderer.DrawText(g, glyph, f, r, c, Center);
        }

        public static int Width(string s, Font f)
        {
            return TextRenderer.MeasureText(s, f, new Size(int.MaxValue, int.MaxValue), TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine | TextFormatFlags.NoPadding).Width;
        }

        public static string PlatformGlyph(string platform)
        {
            switch (platform)
            {
                case "android":
                case "ios": return GPhone;
                case "mac": return GLaptop;
                case "web": return GGlobe;
                case "cli": return GTerminal;
                default: return GPc;
            }
        }

        public static void StyleForm(Form f)
        {
            f.AutoScaleMode = AutoScaleMode.None;
            f.Font = Font;
            f.BackColor = Theme.Bg;
            f.ForeColor = Theme.Text;
            f.Icon = AppIconCache.Window;
            f.HandleCreated += (s, e) => Theme.ApplyTitleBar(f, f.BackColor);
        }
    }

    static class AppIconCache
    {
        static Icon window;
        public static Icon Window
        {
            get
            {
                if (window == null) window = AppIcon.Window();
                return window;
            }
        }
    }

    // Base for owner-drawn controls: double buffered, no flicker, tracks hover/press.
    class Owner : Control
    {
        protected bool hover, pressed;

        public Owner()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            SetStyle(ControlStyles.Selectable, false);
        }

        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; pressed = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnMouseDown(MouseEventArgs e) { if (e.Button == MouseButtons.Left) { pressed = true; Invalidate(); } base.OnMouseDown(e); }
        protected override void OnMouseUp(MouseEventArgs e) { pressed = false; Invalidate(); base.OnMouseUp(e); }
    }

    class FlatButton : Owner
    {
        public string Glyph;
        public bool Primary;
        public bool Quiet;
        public bool DangerStyle;
        public int Radius = -1;
        ToolTip tip;

        public FlatButton(string text, string glyph)
        {
            Text = text;
            Glyph = glyph;
            Cursor = Cursors.Hand;
            SetStyle(ControlStyles.Selectable, true);
            TabStop = true;
        }

        public string Tooltip
        {
            set
            {
                if (tip == null) tip = new ToolTip();
                tip.SetToolTip(this, value);
            }
        }

        public Size Preferred()
        {
            int w = Ui.S(16) * 2;
            if (!string.IsNullOrEmpty(Glyph)) w += Ui.S(16) + (string.IsNullOrEmpty(Text) ? 0 : Ui.S(8));
            if (!string.IsNullOrEmpty(Text)) w += Ui.Width(Text, Ui.Bold);
            if (string.IsNullOrEmpty(Text)) w = Ui.S(36);
            return new Size(w, Ui.S(36));
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter) OnClick(EventArgs.Empty);
            base.OnKeyDown(e);
        }

        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }
        protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(BackColor);
            var r = new Rectangle(0, 0, Width - 1, Height - 1);
            int radius = Radius >= 0 ? Radius : Ui.S(8);
            Color fill, fg;
            if (Primary)
            {
                fill = hover || pressed ? Theme.AccentHover : Theme.Accent;
                fg = Theme.AccentText;
                if (!Enabled) { fill = Theme.Blend(Theme.Accent, BackColor, 0.55); }
            }
            else if (Quiet)
            {
                fill = pressed ? Theme.Selected : hover ? Theme.Hover : BackColor;
                fg = DangerStyle ? Theme.Danger : hover ? Theme.Text : Theme.Text2;
            }
            else
            {
                fill = pressed ? Theme.Selected : hover ? Theme.Hover : Theme.Surface2;
                fg = DangerStyle ? Theme.Danger : Theme.Text;
            }
            if (!Enabled) fg = Theme.Text3;
            if (fill != BackColor) Ui.FillRound(g, fill, r, radius);
            if (!Primary && !Quiet) Ui.DrawRound(g, Theme.Border, r, radius, 1f);
            if (Focused && ShowFocusCues) Ui.DrawRound(g, Theme.Accent, new Rectangle(1, 1, Width - 3, Height - 3), radius, 1.5f);

            bool hasText = !string.IsNullOrEmpty(Text);
            bool hasGlyph = !string.IsNullOrEmpty(Glyph);
            int gw = hasGlyph ? Ui.S(16) : 0;
            int tw = hasText ? Ui.Width(Text, Ui.Bold) : 0;
            int gap = hasText && hasGlyph ? Ui.S(8) : 0;
            int x = (Width - gw - gap - tw) / 2;
            if (hasGlyph) Ui.Glyph(g, Glyph, Ui.Icons, new Rectangle(x, 0, gw, Height), fg);
            if (hasText) Ui.Text(g, Text, Ui.Bold, new Rectangle(x + gw + gap, 0, tw + 2, Height), fg, Ui.Line);
        }
    }

    class FlatCheck : Owner
    {
        bool check;
        public string Note;
        public event EventHandler CheckedChanged;

        public FlatCheck(string text)
        {
            Text = text;
            Cursor = Cursors.Hand;
            SetStyle(ControlStyles.Selectable, true);
            TabStop = true;
        }

        public bool Checked
        {
            get { return check; }
            set
            {
                if (check == value) return;
                check = value;
                Invalidate();
                if (CheckedChanged != null) CheckedChanged(this, EventArgs.Empty);
            }
        }

        protected override void OnClick(EventArgs e) { Checked = !Checked; Focus(); base.OnClick(e); }
        protected override void OnKeyDown(KeyEventArgs e) { if (e.KeyCode == Keys.Space) Checked = !Checked; base.OnKeyDown(e); }
        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }
        protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(BackColor);
            int box = Ui.S(18);
            var r = new Rectangle(0, Ui.S(2), box, box);
            if (check)
            {
                Ui.FillRound(g, Enabled ? (hover ? Theme.AccentHover : Theme.Accent) : Theme.Text3, r, Ui.S(4));
                Ui.Glyph(g, Ui.GCheck, Ui.IconsSmall, r, Theme.AccentText);
            }
            else
            {
                Ui.FillRound(g, hover ? Theme.Hover : Theme.Surface, r, Ui.S(4));
                Ui.DrawRound(g, hover ? Theme.Text2 : Theme.Text3, r, Ui.S(4), 1f);
            }
            if (Focused && ShowFocusCues) Ui.DrawRound(g, Theme.Accent, new Rectangle(r.X - 2, r.Y - 2, r.Width + 3, r.Height + 3), Ui.S(5), 1f);
            var tr = new Rectangle(box + Ui.S(10), 0, Width - box - Ui.S(10), Ui.S(22));
            Ui.Text(g, Text, Ui.Font, tr, Enabled ? Theme.Text : Theme.Text3, Ui.Line);
            if (!string.IsNullOrEmpty(Note))
                Ui.Text(g, Note, Ui.Small, new Rectangle(tr.X, Ui.S(22), tr.Width, Height - Ui.S(22)), Theme.Text2, Ui.Wrap);
        }
    }

    // A single-line text input with a rounded border.
    class TextField : Owner
    {
        public readonly TextBox Box;

        public TextField()
        {
            Box = new TextBox();
            Box.BorderStyle = BorderStyle.None;
            Box.Font = Ui.Font;
            Controls.Add(Box);
            Box.GotFocus += (s, e) => Invalidate();
            Box.LostFocus += (s, e) => Invalidate();
            Height = Ui.S(36);
            ApplyTheme();
        }

        public override string Text
        {
            get { return Box.Text; }
            set { Box.Text = value; }
        }

        public bool ReadOnly
        {
            get { return Box.ReadOnly; }
            set { Box.ReadOnly = value; ApplyTheme(); }
        }

        public void ApplyTheme()
        {
            Box.BackColor = ReadOnly ? Theme.Surface2 : Theme.Surface;
            Box.ForeColor = ReadOnly ? Theme.Text2 : Theme.Text;
            Invalidate();
        }

        protected override void OnLayout(LayoutEventArgs e)
        {
            base.OnLayout(e);
            int pad = Ui.S(10);
            Box.SetBounds(pad, (Height - Box.PreferredHeight) / 2, Width - pad * 2, Box.PreferredHeight);
        }

        protected override void OnMouseDown(MouseEventArgs e) { Box.Focus(); base.OnMouseDown(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(BackColor);
            var r = new Rectangle(0, 0, Width - 1, Height - 1);
            Ui.FillRound(g, Box.BackColor, r, Ui.S(6));
            Ui.DrawRound(g, Box.Focused ? Theme.Accent : Theme.Border, r, Ui.S(6), Box.Focused ? 1.5f : 1f);
        }
    }

    class Label2 : Label
    {
        public Label2(string text, Font font, bool secondary)
        {
            Text = text;
            Font = font;
            AutoSize = false;
            UseMnemonic = false;
            Tag = secondary;
            ForeColor = secondary ? Theme.Text2 : Theme.Text;
        }

        public void ApplyTheme()
        {
            ForeColor = (bool)Tag ? Theme.Text2 : Theme.Text;
        }

        // Drawn without GDI's side padding so labels line up with fields and buttons.
        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(BackColor);
            var flags = Ui.Wrap;
            if (TextAlign == ContentAlignment.MiddleLeft) flags = Ui.Line;
            else if (TextAlign == ContentAlignment.MiddleCenter) flags = Ui.Center;
            else if (TextAlign == ContentAlignment.TopCenter) flags = Ui.Wrap | TextFormatFlags.HorizontalCenter;
            TextRenderer.DrawText(e.Graphics, Text, Font, ClientRectangle, ForeColor, flags);
        }
    }


    // Menus that follow the light/dark theme: roomy rows, rounded selection, coloured dots that stay coloured
    // even on disabled items (the connection status).
    class MenuRenderer : ToolStripProfessionalRenderer
    {
        public MenuRenderer() : base(new MenuColors()) { RoundedEdges = false; }

        public static void Apply(ToolStrip strip)
        {
            strip.Renderer = new MenuRenderer();
            strip.BackColor = Theme.Surface;
            strip.ForeColor = Theme.Text;
            strip.Font = Ui.Font;
            strip.Padding = new Padding(Ui.S(4), Ui.S(6), Ui.S(4), Ui.S(6));
            var dd = strip as ToolStripDropDownMenu;
            if (dd != null) dd.ShowImageMargin = true;
            Recolor(strip.Items);
        }

        static void Recolor(ToolStripItemCollection items)
        {
            foreach (ToolStripItem i in items)
            {
                i.ForeColor = i.Enabled ? Theme.Text : Theme.Text3;
                if (!(i is ToolStripSeparator)) i.Padding = new Padding(0, Ui.S(3), 0, Ui.S(3));
                var mi = i as ToolStripMenuItem;
                if (mi != null && mi.HasDropDownItems)
                {
                    mi.DropDown.BackColor = Theme.Surface;
                    mi.DropDown.Renderer = new MenuRenderer();
                    mi.DropDown.Padding = new Padding(Ui.S(4), Ui.S(6), Ui.S(4), Ui.S(6));
                    Recolor(mi.DropDownItems);
                }
            }
        }

        // A small round dot for menu items (online state, connection state).
        public static Image Dot(Color c)
        {
            int s = Ui.S(16);
            var bmp = new Bitmap(s, s);
            using (var g = Graphics.FromImage(bmp))
            {
                int d = Ui.S(8);
                Ui.FillCircle(g, c, new Rectangle((s - d) / 2, (s - d) / 2, d, d));
            }
            return bmp;
        }

        protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
        {
            var r = new Rectangle(0, 0, e.ToolStrip.Width - 1, e.ToolStrip.Height - 1);
            using (var p = new Pen(Theme.Border)) e.Graphics.DrawRectangle(p, r);
        }

        protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
        {
            if (!e.Item.Selected || !e.Item.Enabled) return;
            var r = new Rectangle(Ui.S(2), 1, e.Item.Width - Ui.S(4), e.Item.Height - 2);
            Ui.FillRound(e.Graphics, Theme.Hover, r, Ui.S(4));
        }

        protected override void OnRenderItemImage(ToolStripItemImageRenderEventArgs e)
        {
            // Draw the image as it is, never greyed out.
            if (e.Image != null) e.Graphics.DrawImage(e.Image, e.ImageRectangle);
        }

        // A checked item (e.g. "Show phone notifications"): an accent check mark in the image margin.
        protected override void OnRenderItemCheck(ToolStripItemImageRenderEventArgs e)
        {
            var r = e.ImageRectangle;
            if (r.Width <= 0 || r.Height <= 0) return;
            var g = e.Graphics;
            var mode = g.SmoothingMode;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            using (var p = new Pen(Theme.Accent, Math.Max(2f, Ui.S(2))))
            {
                p.StartCap = LineCap.Round;
                p.EndCap = LineCap.Round;
                p.LineJoin = LineJoin.Round;
                g.DrawLines(p, new[]
                {
                    new PointF(r.Left + r.Width * 0.2f, r.Top + r.Height * 0.52f),
                    new PointF(r.Left + r.Width * 0.42f, r.Top + r.Height * 0.74f),
                    new PointF(r.Left + r.Width * 0.8f, r.Top + r.Height * 0.3f),
                });
            }
            g.SmoothingMode = mode;
        }

        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            e.TextColor = e.Item.Enabled ? Theme.Text : Theme.Text2;
            base.OnRenderItemText(e);
        }

        protected override void OnRenderArrow(ToolStripArrowRenderEventArgs e)
        {
            e.ArrowColor = Theme.Text2;
            base.OnRenderArrow(e);
        }

        protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
        {
            int y = e.Item.Height / 2;
            using (var p = new Pen(Theme.Border)) e.Graphics.DrawLine(p, Ui.S(10), y, e.Item.Width - Ui.S(10), y);
        }

        class MenuColors : ProfessionalColorTable
        {
            public override Color ToolStripDropDownBackground { get { return Theme.Surface; } }
            public override Color ImageMarginGradientBegin { get { return Theme.Surface; } }
            public override Color ImageMarginGradientMiddle { get { return Theme.Surface; } }
            public override Color ImageMarginGradientEnd { get { return Theme.Surface; } }
            public override Color MenuBorder { get { return Theme.Border; } }
            public override Color MenuItemBorder { get { return Theme.Hover; } }
            public override Color MenuItemSelected { get { return Theme.Hover; } }
            public override Color MenuItemSelectedGradientBegin { get { return Theme.Hover; } }
            public override Color MenuItemSelectedGradientEnd { get { return Theme.Hover; } }
            public override Color MenuItemPressedGradientBegin { get { return Theme.Hover; } }
            public override Color MenuItemPressedGradientEnd { get { return Theme.Hover; } }
            public override Color SeparatorDark { get { return Theme.Border; } }
            public override Color SeparatorLight { get { return Theme.Border; } }
        }
    }

    // A small indeterminate progress ring.
    class Spinner : Control
    {
        readonly Timer timer = new Timer();
        int angle;

        public Spinner()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
            SetStyle(ControlStyles.Selectable, false);
            timer.Interval = 40;
            timer.Tick += (s, e) => { angle = (angle + 12) % 360; Invalidate(); };
        }

        public bool Spinning
        {
            get { return timer.Enabled; }
            set { if (value) timer.Start(); else timer.Stop(); Invalidate(); }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) timer.Dispose();
            base.Dispose(disposing);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(Parent != null ? Parent.BackColor : Theme.Bg);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            float w = Math.Max(2f, Width / 9f);
            var r = new RectangleF(w, w, Width - 2 * w - 1, Height - 2 * w - 1);
            using (var track = new Pen(Theme.Border, w)) g.DrawEllipse(track, r);
            using (var arc = new Pen(Theme.Accent, w))
            {
                arc.StartCap = LineCap.Round;
                arc.EndCap = LineCap.Round;
                g.DrawArc(arc, r, angle, 100);
            }
        }
    }
}
