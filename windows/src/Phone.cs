// Phone notifications on this PC (Beam 1.5, feature "phone-notifications"). The phone shares the apps the user picked
// with every device whose "Show phone notifications" is on. This PC shows a balloon for each new one and, on a click,
// opens the chat window's Phone panel, where the page lists them and replies. Their content stays in memory: never in
// beam.log (log lines name the app and the id only), never on disk. Windows keeps shown balloons in its Notification
// Center, so "Show message text in pop-ups" (Settings → This PC) can leave the text out of them.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Windows.Forms;

namespace Beam
{
    class PhoneNotice
    {
        public string Id, Device, App, AppName, Title, Text;
        public List<string> Lines = new List<string>();
        public long When, Posted, At;   // the app's time, the phone's post time (1.5 phones), the server's last update
        public bool? Resent;            // the phone sent it again (after a server restart or a reconnect)
        public bool Silent;
        public long Seen = Stopwatch.GetTimestamp();
        public long Seq;                // the order it came in here (the newest has the highest)

        public static PhoneNotice Parse(Dictionary<string, object> d)
        {
            string id = Json.Str(d, "id");
            if (string.IsNullOrEmpty(id)) return null;
            var n = new PhoneNotice();
            n.Id = id;
            n.Device = Json.Str(d, "device");
            n.App = Json.Str(d, "app") ?? "";
            n.AppName = Json.Str(d, "appName");
            if (string.IsNullOrEmpty(n.AppName)) n.AppName = n.App.Length > 0 ? n.App : "Your phone";
            n.Title = Json.Str(d, "title") ?? "";
            n.Text = Json.Str(d, "text") ?? "";
            n.Lines = Json.StrList(d, "lines");
            n.When = Json.Long(d, "when", 0);
            n.Posted = Json.Long(d, "posted", 0);
            n.At = Json.Long(d, "at", 0);
            var resent = Json.Get(d, "resent");
            if (resent is bool) n.Resent = (bool)resent;
            n.Silent = Json.Bool(d, "silent", false);
            return n;
        }

        // What a balloon would show: the same again (a re-send) doesn't pop up twice.
        public int Signature { get { return (Title + "\u0001" + Text + "\u0001" + string.Join("\u0001", Lines)).GetHashCode(); } }

        // Sent again by the phone, not new: it says so (`resent`); a phone that doesn't, by its post time (else the app's
        // time) being much older than when the server got it. Only for one this PC hasn't seen yet.
        public bool OldNews(bool seenBefore)
        {
            if (Resent.HasValue) return Resent.Value;
            long t = Posted > 0 ? Posted : When;
            return !seenBefore && t > 0 && At > 0 && At - t > 10 * 60 * 1000;
        }

        // Up to `max` lines of the message: the last lines of a conversation, else the text's first lines.
        public List<string> Body(int max)
        {
            var src = Lines.Count > 0 ? Lines.Skip(Math.Max(0, Lines.Count - max)) : Text.Split('\n').Where(l => l.Trim().Length > 0).Take(max);
            return src.Select(l => Fmt.OneLine(l, 120)).Where(l => l.Length > 0).ToList();
        }
    }

    class PhoneNotices
    {
        public const int CoalesceMs = 5000;   // at most one balloon per app in this time
        const int MaxKept = 400;              // the server keeps at most 100 per phone, for 24 h
        const double KeepMs = 24.0 * 3600 * 1000;

        readonly App app;
        readonly Notifier notifier;
        readonly Dictionary<string, PhoneNotice> active = new Dictionary<string, PhoneNotice>();
        readonly Dictionary<string, int> shown = new Dictionary<string, int>(); // id → signature last seen
        readonly Dictionary<string, Bucket> buckets = new Dictionary<string, Bucket>(); // per app (package)
        readonly Timer timer;
        long seq;

        class Bucket
        {
            public long Last = long.MinValue;   // the app's last balloon (Stopwatch ticks: a clock change can't stretch the window)
            public readonly List<PhoneNotice> Waiting = new List<PhoneNotice>();
        }

        public PhoneNotices(App app, Notifier notifier)
        {
            this.app = app;
            this.notifier = notifier;
            timer = new Timer();
            timer.Interval = 250; // runs only while a balloon waits
            timer.Tick += (s, e) => FlushDue();
        }

        public int Count { get { return active.Count; } }

        static double MsSince(long ticks)
        {
            return ticks == long.MinValue ? double.MaxValue : (Stopwatch.GetTimestamp() - ticks) * 1000.0 / Stopwatch.Frequency;
        }

        // `notification` event (also an update: the same id again).
        public void OnNotification(Dictionary<string, object> d)
        {
            var n = PhoneNotice.Parse(d);
            if (n == null) return;
            n.Seq = ++seq;
            active[n.Id] = n;
            Trim();
            int sig = n.Signature, before;
            bool seen = shown.TryGetValue(n.Id, out before);
            shown[n.Id] = sig;
            if (n.Silent) return;
            if (seen && before == sig) return;
            if (n.OldNews(seen)) return;
            if (app.WatchingPhone()) return; // the Phone panel is on screen
            Bucket b;
            if (!buckets.TryGetValue(n.App, out b)) { b = new Bucket(); buckets[n.App] = b; }
            b.Waiting.RemoveAll(w => w.Id == n.Id); // an update replaces the waiting copy
            b.Waiting.Add(n);
            if (b.Waiting.Count == 1 && MsSince(b.Last) >= CoalesceMs) Flush(b);
            else if (!timer.Enabled) timer.Start();
        }

        // `notification-removed` event: { id }, { device, all: true }, or { all: true } (everything shown here).
        public void OnRemoved(Dictionary<string, object> d)
        {
            string id = Json.Str(d, "id");
            string device = Json.Str(d, "device");
            bool all = Json.Bool(d, "all", false);
            var gone = active.Values.Where(n => id != null ? n.Id == id : all && (device == null || n.Device == device)).Select(n => n.Id).ToList();
            if (id != null && !gone.Contains(id)) gone.Add(id);
            foreach (var g in gone) Forget(g);
        }

        // Off, signed out, or another server: nothing stays, not even a balloon about to show.
        public void Clear()
        {
            active.Clear();
            shown.Clear();
            buckets.Clear();
            timer.Stop();
            notifier.DropPhone();
        }

        void Forget(string id)
        {
            active.Remove(id);
            shown.Remove(id);
            foreach (var b in buckets.Values) b.Waiting.RemoveAll(w => w.Id == id);
        }

        void Trim()
        {
            foreach (var old in active.Values.Where(n => MsSince(n.Seen) > KeepMs).Select(n => n.Id).ToList()) Forget(old);
            if (active.Count <= MaxKept) return;
            foreach (var old in active.Values.OrderBy(n => n.Seen).Take(active.Count - MaxKept).Select(n => n.Id).ToList()) Forget(old);
        }

        void FlushDue()
        {
            foreach (var b in buckets.Values)
                if (b.Waiting.Count > 0 && MsSince(b.Last) >= CoalesceMs) Flush(b);
            if (!buckets.Values.Any(b => b.Waiting.Count > 0)) timer.Stop();
        }

        // One balloon for what the app has waiting: "WhatsApp · Mom" + its last lines, or "3 new from WhatsApp" + the
        // latest lines. Without "Show message text in pop-ups": "WhatsApp · new notification" / "3 new from WhatsApp".
        void Flush(Bucket b)
        {
            var list = b.Waiting.ToList();
            b.Waiting.Clear();
            b.Last = Stopwatch.GetTimestamp();
            if (list.Count == 0) return;
            var latest = list.OrderBy(n => n.Seq).Last();
            string id = latest.Id;
            bool text = app.Cfg.PhonePopupText;
            string title, body, log;
            if (list.Count == 1)
            {
                title = !text ? latest.AppName + " · new notification"
                    : latest.Title.Length > 0 ? latest.AppName + " · " + Fmt.OneLine(latest.Title, 60) : latest.AppName;
                body = text ? string.Join("\n", latest.Body(2)) : "";
                log = "phone notification from " + latest.AppName + " (" + id + ")";
            }
            else
            {
                title = list.Count + " new from " + latest.AppName;
                body = text ? string.Join("\n", list.Skip(Math.Max(0, list.Count - 2)).Select(Short)) : "";
                log = list.Count + " phone notifications from " + latest.AppName + " (latest " + id + ")";
            }
            if (!text) log += ", text hidden";
            notifier.ShowPhone(title, body, () => app.OpenPhoneNotification(id), log, latest.Seq);
        }

        // "Mom: Dinner at 7?" for a summary balloon (a conversation's lines already name the sender).
        static string Short(PhoneNotice n)
        {
            var body = n.Body(1);
            string line = body.Count > 0 ? body[0] : "";
            if (n.Lines.Count > 0 || n.Title.Length == 0) return line.Length > 0 ? line : n.Title;
            return Fmt.OneLine(n.Title, 40) + (line.Length > 0 ? ": " + line : "");
        }
    }
}
