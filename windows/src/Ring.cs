// "Ring this PC" (the server's `ring` event, Beam 1.3): a looping sound for up to a minute and a small window on top
// ("Beam is ringing this PC · from Robin Phone") with Stop. `ring { stop: true }` stops it too. Test instances (quiet
// configs) stay silent.
using System;
using System.Drawing;
using System.IO;
using System.Media;
using System.Windows.Forms;

namespace Beam
{
    class Ringer
    {
        const int LimitMs = 60 * 1000;
        readonly App app;
        readonly Timer limit;
        SoundPlayer player;
        Stream tone;
        RingForm form;

        public Ringer(App app)
        {
            this.app = app;
            limit = new Timer();
            limit.Interval = LimitMs;
            limit.Tick += (s, e) => Stop("after a minute");
        }

        public bool Ringing { get { return form != null; } }

        public void Start(string by)
        {
            limit.Stop();
            limit.Start(); // a minute from the latest ring
            if (form == null || form.IsDisposed)
            {
                form = new RingForm(by, () => Stop("stopped on this PC"));
                form.Show();
            }
            else form.SetFrom(by);
            if (player == null) StartSound();
            Log.Write("Ringing (from " + (by ?? "?") + ")");
        }

        public void Stop(string why)
        {
            if (form == null && player == null) return;
            limit.Stop();
            if (player != null)
            {
                try { player.Stop(); } catch { }
                player.Dispose();
                player = null;
            }
            if (tone != null) { tone.Dispose(); tone = null; }
            var f = form;
            form = null;
            if (f != null && !f.IsDisposed && !f.Done) f.Close();
            Log.Write("Ringing stopped (" + why + ")");
        }

        void StartSound()
        {
            if (app.Cfg.Quiet) { Log.Write("Ringing without sound (quiet test config)"); return; }
            try
            {
                string file = SoundFile();
                if (file != null) player = new SoundPlayer(file);
                else player = new SoundPlayer(tone = Tone());
                player.PlayLooping();
            }
            catch (Exception ex)
            {
                Log.Error("Ring sound", ex);
                try { System.Media.SystemSounds.Exclamation.Play(); } catch { }
            }
        }

        // Windows' own alarm sounds (Windows 8 and later), else a tone made here.
        static string SoundFile()
        {
            string media = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "Media");
            foreach (string name in new[] { "Alarm01.wav", "Ring01.wav", "Alarm02.wav", "Ring02.wav" })
            {
                string p = Path.Combine(media, name);
                if (File.Exists(p)) return p;
            }
            return null;
        }

        // One second of a two-note beep (16-bit mono WAV); PlayLooping repeats it.
        static MemoryStream Tone()
        {
            const int rate = 22050;
            var samples = new short[rate];
            Action<int, int, double> beep = (start, len, freq) =>
            {
                double fade = rate * 0.01;
                for (int i = 0; i < len && start + i < samples.Length; i++)
                {
                    double env = Math.Min(1.0, Math.Min(i, len - i) / fade);
                    samples[start + i] = (short)(Math.Sin(2 * Math.PI * freq * i / rate) * 14000 * env);
                }
            };
            beep(0, rate * 15 / 100, 988);
            beep(rate * 22 / 100, rate * 15 / 100, 1319);
            var ms = new MemoryStream();
            var w = new BinaryWriter(ms);
            w.Write(new[] { 'R', 'I', 'F', 'F' });
            w.Write(36 + samples.Length * 2);
            w.Write(new[] { 'W', 'A', 'V', 'E', 'f', 'm', 't', ' ' });
            w.Write(16);
            w.Write((short)1);      // PCM
            w.Write((short)1);      // mono
            w.Write(rate);
            w.Write(rate * 2);      // bytes per second
            w.Write((short)2);      // block align
            w.Write((short)16);     // bits per sample
            w.Write(new[] { 'd', 'a', 't', 'a' });
            w.Write(samples.Length * 2);
            foreach (short s in samples) w.Write(s);
            w.Flush();
            ms.Position = 0;
            return ms;
        }
    }

    // Small, on top, bottom-right; doesn't take the focus from what you're typing.
    class RingForm : DialogBase
    {
        readonly Label2 from;
        readonly Action stop;
        public bool Done;   // closed (or closing): don't close it again

        public RingForm(string by, Action stop) : base("Beam", 360)
        {
            this.stop = stop;
            TopMost = true;
            ShowInTaskbar = true;
            AddLabel("Beam is ringing this PC", Ui.Title, false, Ui.S(4));
            from = AddLabel(FromText(by), Ui.Font, true, Ui.S(16));
            var button = Button("Stop", true);
            button.Size = new Size(HostWidth - Pad * 2, Ui.S(40));
            button.Location = new Point(Pad, Y);
            button.Click += (s, e) => Close();
            Y += button.Height + Pad;
            ClientSize = new Size(ClientSize.Width, Y);
            StartPosition = FormStartPosition.Manual;
            var wa = Screen.PrimaryScreen.WorkingArea;
            Location = new Point(wa.Right - Width - Ui.S(16), wa.Bottom - Height - Ui.S(16));
            Ui.PlaceForTest(this);
        }

        static string FromText(string by) { return string.IsNullOrEmpty(by) ? "from another device" : "from " + by; }

        public void SetFrom(string by) { from.Text = FromText(by); }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Escape || e.KeyCode == Keys.Enter) Close();
            base.OnKeyDown(e);
        }

        protected override void OnFormClosed(FormClosedEventArgs e)
        {
            bool first = !Done;
            Done = true;
            base.OnFormClosed(e);
            if (first) stop();
        }
    }
}
