// "Keyboard and mouse across PCs" (Beam 1.12): which of the user's PCs stand to the left of this one, nearest first, and
// whether this PC's keyboard and mouse go over to them. Each of those PCs decides for itself whether this one may
// (Allow remote control, with this PC on its list): that's only ever done at that PC.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace Beam
{
    class KvmForm : DialogBase
    {
        readonly App app;
        readonly FlatCheck on;
        readonly List<ComboBox> picks = new List<ComboBox>();

        sealed class Choice
        {
            public string Id, Text;
            public override string ToString() { return Text; }
        }

        public KvmForm(App app) : base("Keyboard and mouse across PCs", 520)
        {
            this.app = app;
            AddLabel("Keyboard and mouse across PCs", Ui.Title, false, Ui.S(10));
            AddLabel("Move the pointer off the left edge of this PC's screens and it carries on onto the PCs beside it, with the " +
                "keyboard, and text copied on one PC pastes on the next. Move it back to come back.", Ui.Font, true, Ui.S(14));
            on = AddCheck("Use this PC's keyboard and mouse on the PCs to its left", null, app.Cfg.KvmOn, 0, Ui.S(8));
            var pcs = app.Devices.Where(d => d.Id != app.Me && !d.Temporary && d.Platform == "windows")
                .OrderBy(d => d.Name, StringComparer.CurrentCultureIgnoreCase).ToList();
            string[] titles = { "TO THE LEFT OF THIS PC", "TO THE LEFT OF THAT ONE", "AND TO THE LEFT OF THAT" };
            for (int i = 0; i < KvmController.MaxPcs; i++)
            {
                Section(titles[i]);
                var c = new ComboBox();
                c.DropDownStyle = ComboBoxStyle.DropDownList;
                c.FlatStyle = FlatStyle.Flat;
                c.Font = Ui.Font;
                c.BackColor = Theme.Surface;
                c.ForeColor = Theme.Text;
                c.Items.Add(new Choice { Id = null, Text = "(none)" });
                foreach (var d in pcs) c.Items.Add(new Choice { Id = d.Id, Text = d.Name + (d.Online ? "" : "  (offline)") });
                string had = i < app.Cfg.KvmLeft.Count ? app.Cfg.KvmLeft[i] : null;
                var dev = had != null ? app.DeviceById(had) : null;
                if (had != null && !pcs.Any(d => d.Id == had)) c.Items.Add(new Choice { Id = had, Text = dev != null ? dev.Name : "A PC that's no longer in Beam" });
                c.SelectedIndex = 0;
                for (int k = 0; k < c.Items.Count; k++) if (((Choice)c.Items[k]).Id == had && had != null) c.SelectedIndex = k;
                c.SetBounds(X0, Y, Math.Min(W0, Ui.S(360)), Ui.S(32));
                Host.Controls.Add(c);
                Y += c.Height + Ui.S(6);
                picks.Add(c);
            }
            Y += Ui.S(6);
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

        void Save()
        {
            var ids = new List<string>();
            foreach (var c in picks)
            {
                var ch = c.SelectedItem as Choice;
                if (ch == null || ch.Id == null) break; // (nearest first: a gap ends the row)
                if (!ids.Contains(ch.Id)) ids.Add(ch.Id);
            }
            app.Cfg.KvmLeft = ids;
            app.Cfg.KvmOn = on.Checked && ids.Count > 0;
            app.Cfg.Save();
            Log.Write("Keyboard and mouse across PCs: " + (app.Cfg.KvmOn ? "on" : "off") + ", " + (ids.Count == 0 ? "no PCs" : ids.Count + " PC(s) to the left") + " (its settings)");
            app.Kvm.Apply("its settings");
            Close();
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            if (!Ui.TestOffscreen) Native.SetForegroundWindow(Handle);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Escape) Close();
            base.OnKeyDown(e);
        }
    }
}
