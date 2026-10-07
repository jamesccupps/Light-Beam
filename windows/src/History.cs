// Each PC's history (Beam 1.18 + this app 1.13; the user: "we should do the history for each pc"): Windows' own record of
// this PC's restarts and shutdowns (and who asked), power losses, blue screens and sign-ins, and this Beam's own crashes,
// sent to the server when Beam connects. The server explains them on the PC's page (Device info → History) and alerts
// when the PC comes back from a power loss or a blue screen. Read from Windows' System and Application logs as this user
// (Windows lets users read them: no admin), from where the server's copy ends (the first time, 30 days back), at most
// once an hour. Only the kinds the server asks for (server lib/history.js WANTED); of the Application log, only this
// Beam.exe's crashes and hangs.
using System;
using System.Collections.Generic;
using System.Diagnostics.Eventing.Reader;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Beam
{
    class PcHistory
    {
        static readonly string SystemQuery = Query(
            Kind("User32", 1074),                                       // a restart or shutdown asked for: who and why
            Kind("Microsoft-Windows-Kernel-Power", 41),                 // started again without a clean shutdown
            Kind("EventLog", 6008),                                     // ...and Windows' estimate of when it went down
            Kind("Microsoft-Windows-Kernel-General", 12, 13),           // Windows started; Windows shut down cleanly
            Kind("Microsoft-Windows-WER-SystemErrorReporting", 1001),   // a blue screen's stop code
            Kind("Microsoft-Windows-Winlogon", 7001));                  // someone signed in
        static readonly string AppQuery = Query(
            Kind("Application Error", 1000), Kind(".NET Runtime", 1026), Kind("Application Hang", 1002));
        const int MaxPerLog = 500;

        readonly App app;
        bool busy;
        DateTime lastSent = DateTime.MinValue;

        public PcHistory(App app)
        {
            this.app = app;
        }

        static string Kind(string provider, params int[] ids)
        {
            return "(Provider[@Name='" + provider + "'] and (" + string.Join(" or ", ids.Select(i => "EventID=" + i.ToString(CultureInfo.InvariantCulture))) + "))";
        }

        static string Query(params string[] kinds)
        {
            return "*[System[(" + string.Join(" or ", kinds) + ") and TimeCreated[@SystemTime>='{0}']]]";
        }

        // After connecting (a reconnect within the hour doesn't send again): what's new since the server's copy.
        public async void Report(bool force)
        {
            if (busy || app.Api == null || !app.ServerHas("history")) return;
            if (!force && DateTime.UtcNow - lastSent < TimeSpan.FromHours(1)) return;
            busy = true;
            try
            {
                var since = Json.Obj(await app.Api.Call(HttpMethod.Get, "/api/devices/me/history/since", null, 15, CancellationToken.None));
                DateTime fromSystem = From(Json.Str(since, "System")), fromApp = From(Json.Str(since, "Application"));
                string exe = Application.ExecutablePath;
                string fake = app.Cfg.CustomPath ? app.Cfg.TestHistoryEvents : null;
                var records = await Task.Run(() => fake != null ? ReadFake(fake) : Read(fromSystem, fromApp, exe));
                var body = new Dictionary<string, object>();
                body["events"] = records.ToArray();
                var r = Json.Obj(await app.Api.Call(HttpMethod.Post, "/api/devices/me/history", body, 30, CancellationToken.None));
                lastSent = DateTime.UtcNow;
                long added = Json.Long(r, "added", 0);
                Log.Write("History: " + (added > 0 ? "sent " + added + " new record(s) of Windows' restarts, sign-ins and crashes" : "nothing new in Windows' records")
                    + " (" + records.Count + " read" + (fake != null ? ", from the test file" : "") + ")");
            }
            catch (Exception ex) { Log.Write("History: not sent (" + Api.Describe(ex) + ")"); }
            finally { busy = false; }
        }

        // A minute before the server's newest record (it keeps each record once); the first time, 30 days back.
        static DateTime From(string iso)
        {
            DateTime t;
            if (iso != null && DateTime.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out t)) return t.AddMinutes(-1);
            return DateTime.UtcNow.AddDays(-30);
        }

        static List<object> Read(DateTime fromSystem, DateTime fromApp, string exe)
        {
            var list = new List<object>();
            list.AddRange(ReadLog("System", SystemQuery, fromSystem));
            list.AddRange(BeamOnly(ReadLog("Application", AppQuery, fromApp), exe));
            return list;
        }

        static List<Dictionary<string, object>> ReadLog(string log, string query, DateTime fromUtc)
        {
            var list = new List<Dictionary<string, object>>();
            string xpath = string.Format(CultureInfo.InvariantCulture, query, fromUtc.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture));
            var q = new EventLogQuery(log, PathType.LogName, xpath);
            q.ReverseDirection = true; // the newest first: the newest 500 when there are more
            try
            {
                using (var reader = new EventLogReader(q))
                {
                    for (EventRecord e = reader.ReadEvent(); e != null; e = reader.ReadEvent())
                    {
                        using (e) list.Add(Record(log, e));
                        if (list.Count >= MaxPerLog) break;
                    }
                }
            }
            catch (EventLogNotFoundException) { }
            catch (Exception ex) { Log.Write("History: couldn't read Windows' " + log + " log (" + ex.Message + ")"); }
            return list;
        }

        // As the server takes it: the record's values as text (dates ISO in UTC, byte arrays "hex:…").
        static Dictionary<string, object> Record(string log, EventRecord e)
        {
            var d = new Dictionary<string, object>();
            d["log"] = log;
            d["id"] = e.Id;
            d["provider"] = e.ProviderName;
            d["time"] = e.TimeCreated.HasValue ? e.TimeCreated.Value.ToUniversalTime().ToString("o", CultureInfo.InvariantCulture) : null;
            d["rec"] = e.RecordId.HasValue ? (object)e.RecordId.Value : null;
            var data = new List<object>();
            try { foreach (var p in e.Properties) data.Add(Text(p.Value)); } catch { }
            d["data"] = data.ToArray();
            return d;
        }

        static string Text(object v)
        {
            if (v == null) return "";
            if (v is DateTime) return ((DateTime)v).ToUniversalTime().ToString("o", CultureInfo.InvariantCulture);
            var bytes = v as byte[];
            if (bytes != null)
            {
                var sb = new StringBuilder("hex:");
                for (int i = 0; i < bytes.Length && i < 64; i++) sb.Append(bytes[i].ToString("x2", CultureInfo.InvariantCulture));
                return sb.ToString();
            }
            return Convert.ToString(v, CultureInfo.InvariantCulture);
        }

        // Only this Beam.exe's: an Application Error or Hang names the program's path; a .NET Runtime crash (the
        // exception) doesn't, so it goes along only with an Application Error of ours from the same moment.
        static List<Dictionary<string, object>> BeamOnly(List<Dictionary<string, object>> records, string exe)
        {
            Func<Dictionary<string, object>, object[]> dataOf = r => (object[])r["data"];
            var ours = records.Where(r => ((int)r["id"] == 1000 || (int)r["id"] == 1002)
                && dataOf(r).Any(v => string.Equals(v as string, exe, StringComparison.OrdinalIgnoreCase))).ToList();
            var times = ours.Select(r => TimeOf(r)).ToList();
            string app = "Application: " + Path.GetFileName(exe);
            foreach (var r in records.Where(x => (int)x["id"] == 1026))
            {
                string text = dataOf(r).Length > 0 ? dataOf(r)[0] as string : null;
                if (text == null || text.IndexOf(app, StringComparison.OrdinalIgnoreCase) < 0) continue;
                DateTime t = TimeOf(r);
                if (times.Any(x => Math.Abs((x - t).TotalSeconds) <= 15)) ours.Add(r);
            }
            return ours;
        }

        static DateTime TimeOf(Dictionary<string, object> r)
        {
            DateTime t;
            return DateTime.TryParse(r["time"] as string, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal, out t) ? t : DateTime.MinValue;
        }

        // Tests (custom --config only, "testHistoryEvents"): records from a file instead of Windows' logs.
        static List<object> ReadFake(string path)
        {
            var list = Json.Parse(File.ReadAllText(path)) as object[];
            return list != null ? list.ToList() : new List<object>();
        }

        // Tests (custom --config only): send | read (what Windows' logs would give, counted in beam.log)
        public void TestCommand(string cmd)
        {
            switch (cmd)
            {
                case "send": Report(true); break;
                case "read":
                    Task.Run(() =>
                    {
                        var records = Read(DateTime.UtcNow.AddDays(-30), DateTime.UtcNow.AddDays(-30), Application.ExecutablePath);
                        var kinds = records.Cast<Dictionary<string, object>>().GroupBy(r => r["provider"] + " " + r["id"]).Select(g => g.Key + " x" + g.Count());
                        Log.Write("History: (test) Windows' logs give " + records.Count + " record(s): " + string.Join(", ", kinds));
                    });
                    break;
                default: Log.Write("History: (test) unknown " + cmd); break;
            }
        }
    }
}
