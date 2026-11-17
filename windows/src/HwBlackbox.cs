// HW Blackbox on this PC's page (this app 1.27, Beam 1.35; the IDEAS row "HW Blackbox on each PC's page", picked by the
// user on 2026-11-17: "yeah integrate that into beam"). HW Blackbox (the user's hardware monitor for Windows, on GitHub
// as HW-Blackbox) serves a dashboard on 127.0.0.1 to this Windows session. With the status check
// (every 15 minutes; read again at most every 10) Beam reads three of its answers and sends a summary in its status:
// HW Blackbox's version, the Diagnose findings that aren't fine (most serious first), and the last time the PC went off
// without shutting down, with the power supply's last readings before it. Read only: Beam presses none of its buttons
// (its POSTs need a page of its own anyway). Not installed, its dashboard off, or served by another user's session (a
// 403): nothing is sent, and a summary sent before is taken back.
//   where   C:\ProgramData\HWBlackbox\config.json: dashboard.enabled, dashboard.port (9070); never a port guessed
//           without that file (another program could be there)
//   ask     /api/ping (it must say app "hw-blackbox-dashboard"), /api/diagnose, /api/overview's power_offs
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;

namespace Beam
{
    static class HwBlackbox
    {
        const int ChecksMax = 12, TitleMax = 80, SummaryMax = 300;
        static readonly TimeSpan Fresh = TimeSpan.FromMinutes(10), Retry = TimeSpan.FromMinutes(2), Grace = TimeSpan.FromMinutes(30);
        static readonly object gate = new object();
        static DateTime nextRead = DateTime.MinValue, lastGood = DateTime.MinValue;
        static string readFrom;
        static bool missing; // (said so in the log already)
        static Dictionary<string, object> last;

        // The summary for the status (null: no HW Blackbox here). On a worker thread: up to a few seconds.
        public static Dictionary<string, object> Read(Config cfg)
        {
            string url = BaseUrl(cfg);
            lock (gate)
            {
                if (url == readFrom && DateTime.UtcNow < nextRead) return last;
                readFrom = url;
                Dictionary<string, object> got = null;
                string why = null;
                if (url != null)
                {
                    try { got = Ask(url); }
                    catch (Exception ex) { why = ex.Message; }
                }
                if (got == null && last != null && url != null && DateTime.UtcNow - lastGood < Grace)
                {
                    // A moment without it (HW Blackbox updating, its agent starting again): what it said last stays a while.
                    if (!missing) Log.Write("HW Blackbox doesn't answer here" + (why != null ? " (" + why + ")" : "") + ": its last findings stay for now");
                    missing = true;
                    nextRead = DateTime.UtcNow + Retry;
                    return last;
                }
                if (got != null && (last == null || missing || Version(got) != Version(last))) Log.Write("HW Blackbox " + Version(got) + " runs here: its findings go with this PC's status");
                else if (got == null && last != null) Log.Write("HW Blackbox doesn't answer here any more: its findings are taken back");
                else if (got == null && why != null && !missing) Log.Write("HW Blackbox: couldn't read its dashboard (" + why + ")");
                missing = got == null && why != null;
                if (got != null) lastGood = DateTime.UtcNow;
                nextRead = DateTime.UtcNow + (got == null && why != null ? Retry : Fresh);
                last = got;
                return got;
            }
        }

        static string Version(Dictionary<string, object> d)
        {
            return d != null ? Json.Str(d, "version") : null;
        }

        // What makes a report worth sending at once: another version, a finding that came, went or changed its level,
        // another power-off. (Their wording changes all the time, "a core flat out for 1 h 53 min": that waits for the
        // 6-hour refresh.)
        public static string Signature(Dictionary<string, object> d)
        {
            if (d == null) return "";
            var sb = new StringBuilder(Json.Str(d, "version") ?? "");
            var checks = Json.Get(d, "checks") as object[] ?? (Json.Get(d, "checks") as List<object> ?? new List<object>()).ToArray();
            foreach (var o in checks)
            {
                var c = Json.Obj(o);
                if (c != null) sb.Append('|').Append(Json.Str(c, "id")).Append(':').Append(Json.Str(c, "level"));
            }
            var p = Json.Obj(Json.Get(d, "powerOff"));
            if (p != null) sb.Append("|off:").Append(Json.Long(p, "up", 0));
            return sb.ToString();
        }

        // The dashboard's address from HW Blackbox's own settings; a test instance only ever its stand-in (testHwbUrl).
        static string BaseUrl(Config cfg)
        {
            if (cfg.CustomPath) return string.IsNullOrEmpty(cfg.TestHwbUrl) ? null : cfg.TestHwbUrl.TrimEnd('/');
            try
            {
                string file = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "HWBlackbox", "config.json");
                if (!File.Exists(file)) return null;
                var fi = new FileInfo(file);
                if (fi.Length > 1 << 20) return null;
                var d = Json.ParseObject(File.ReadAllText(file, Encoding.UTF8));
                var dash = Json.Obj(Json.Get(d, "dashboard"));
                if (dash != null && !Json.Bool(dash, "enabled", true)) return null;
                long port = dash != null ? Json.Long(dash, "port", 9070) : 9070;
                return port >= 1 && port <= 65535 ? "http://127.0.0.1:" + port : null;
            }
            catch { return null; }
        }

        static Dictionary<string, object> Ask(string url)
        {
            var ping = Get(url + "/api/ping", 3000);
            if (ping == null || Json.Str(ping, "app") != "hw-blackbox-dashboard") return null;
            string version = Clean(Json.Str(ping, "version"), 20);
            if (version == null) return null;
            var o = new Dictionary<string, object>();
            o["version"] = version;
            o["port"] = new Uri(url).Port; // (its own PC's window offers "Open HW Blackbox")
            // Diagnose (1.0.8 and later): ~1 s there, kept a minute
            var diag = Get(url + "/api/diagnose", 20000);
            if (diag != null)
            {
                var counts = new Dictionary<string, object>();
                var c = Json.Obj(Json.Get(diag, "counts"));
                if (c != null) foreach (var k in new[] { "bad", "warn", "info", "ok" }) { long n = Json.Long(c, k, -1); if (n >= 0 && n <= 1000) counts[k] = n; }
                o["counts"] = counts;
                var list = new List<object>();
                foreach (var x in AsList(Json.Get(diag, "checks")))
                {
                    var check = Json.Obj(x);
                    string level = check != null ? Json.Str(check, "level") : null;
                    if (level != "bad" && level != "warn" && level != "info") continue;
                    string title = Clean(Json.Str(check, "title"), TitleMax);
                    if (title == null) continue;
                    var one = new Dictionary<string, object>();
                    string id = Clean(Json.Str(check, "id"), 80);
                    if (id != null) one["id"] = id;
                    one["level"] = level;
                    one["title"] = title;
                    string summary = Clean(Json.Str(check, "summary"), SummaryMax);
                    if (summary != null) one["summary"] = summary;
                    list.Add(one);
                }
                string[] order = { "bad", "warn", "info" };
                o["checks"] = list.OrderBy(x => Array.IndexOf(order, Json.Str((Dictionary<string, object>)x, "level"))).Take(ChecksMax).ToArray();
                double at = Json.Double(diag, "at", 0);
                if (at > 0) o["at"] = (long)(at * 1000);
            }
            if (!o.ContainsKey("at")) o["at"] = Fmt.NowMs();
            // The newest power-off (its incident reports, oldest first)
            var overview = Get(url + "/api/overview", 10000);
            var offs = overview != null ? AsList(Json.Get(overview, "power_offs")) : new List<object>();
            var newest = offs.Count > 0 ? Json.Obj(offs[offs.Count - 1]) : null;
            long up = newest != null ? Ms(Json.Str(newest, "boot")) : 0;
            if (up > 0)
            {
                var p = new Dictionary<string, object>();
                p["up"] = up;
                long down = Ms(Json.Str(newest, "went_down"));
                if (down > 0 && down <= up) p["down"] = down;
                string why = Clean(Json.Str(newest, "why"), 200);
                if (why != null) p["why"] = why;
                var rails = Json.Obj(Json.Get(newest, "last_rails"));
                if (rails != null)
                {
                    var r = new Dictionary<string, object>();
                    foreach (var pair in new[] { new[] { "v12_v", "v12" }, new[] { "v5_v", "v5" }, new[] { "v33_v", "v33" } })
                    {
                        double v = Json.Double(rails, pair[0], -1);
                        if (v > 0 && v < 30) r[pair[1]] = Math.Round(v, 3);
                    }
                    if (r.Count > 0) p["rails"] = r;
                }
                o["powerOff"] = p;
            }
            return o;
        }

        static List<object> AsList(object v)
        {
            var a = v as object[];
            if (a != null) return a.ToList();
            var l = v as List<object>;
            return l ?? new List<object>();
        }

        // "2026-10-23T22:24:32" (this PC's time, before 1.1.0) or with its offset: ms since 1970, or 0.
        static long Ms(string text)
        {
            DateTimeOffset t;
            if (string.IsNullOrEmpty(text) || !DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeLocal, out t)) return 0;
            long ms = t.ToUnixTimeMilliseconds();
            return ms > 946684800000L && ms < Fmt.NowMs() + 86400000L ? ms : 0;
        }

        // One line, at most `max` characters (cut with "…").
        static string Clean(string s, int max)
        {
            if (string.IsNullOrWhiteSpace(s)) return null;
            var sb = new StringBuilder();
            foreach (char ch in s) sb.Append(char.IsControl(ch) ? ' ' : ch);
            string t = System.Text.RegularExpressions.Regex.Replace(sb.ToString(), @"\s+", " ").Trim();
            if (t.Length == 0) return null;
            return t.Length > max ? t.Substring(0, max - 1).TrimEnd() + "…" : t;
        }

        // A GET on this PC (no proxy, no redirects, 1 MB at most): its JSON object, or null.
        static Dictionary<string, object> Get(string url, int timeoutMs)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Proxy = null;
            req.AllowAutoRedirect = false;
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            req.Accept = "application/json";
            req.UserAgent = "Beam (this PC's status)";
            try
            {
                using (var resp = (HttpWebResponse)req.GetResponse())
                using (var s = resp.GetResponseStream())
                using (var ms = new MemoryStream())
                {
                    if (resp.StatusCode != HttpStatusCode.OK) return null;
                    var buf = new byte[65536];
                    int n;
                    while ((n = s.Read(buf, 0, buf.Length)) > 0)
                    {
                        ms.Write(buf, 0, n);
                        if (ms.Length > 1 << 20) return null;
                    }
                    return Json.ParseObject(Encoding.UTF8.GetString(ms.ToArray()));
                }
            }
            catch (WebException ex)
            {
                var r = ex.Response as HttpWebResponse;
                if (r != null) { int code = (int)r.StatusCode; r.Close(); if (code == 403 || code == 404 || code == 421) return null; }
                if (ex.Status == WebExceptionStatus.ConnectFailure) return null; // (not running: its service starts it at sign-in)
                throw;
            }
        }
    }
}
