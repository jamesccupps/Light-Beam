// Finding a Beam server without typing its address: probe GET /api/hello on this PC and on every
// online Tailscale peer (docs/API.md, "Finding the server"), over https on the MagicDNS name, the
// conventional "beam" node, and plain http on each peer's Tailscale address (port 8765) for servers that
// aren't behind `tailscale serve`. Also used to find the server again after it moved (same serverId + proof).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Beam
{
    class FoundServer
    {
        public string Url;
        public string Label;
        public string ServerId;
        public string Version;
        public string MovedTo;
        public int ApiVersion;
        public Dictionary<string, object> Hello;

        public string Host
        {
            get
            {
                Uri u;
                return Uri.TryCreate(Url, UriKind.Absolute, out u) ? (u.IsDefaultPort ? u.Host : u.Host + ":" + u.Port) : Url;
            }
        }
    }

    static class Discovery
    {
        const int DefaultPort = 8765;

        class Candidate
        {
            public string Url;
            public string Label;
        }

        public static string TailscaleExe()
        {
            try
            {
                foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
                {
                    if (dir.Trim().Length == 0) continue;
                    string p = Path.Combine(dir.Trim().Trim('"'), "tailscale.exe");
                    if (File.Exists(p)) return p;
                }
            }
            catch { }
            foreach (var root in new[] { Environment.GetEnvironmentVariable("ProgramW6432"), Environment.GetEnvironmentVariable("ProgramFiles") })
            {
                if (string.IsNullOrEmpty(root)) continue;
                string p = Path.Combine(root, "Tailscale", "tailscale.exe");
                if (File.Exists(p)) return p;
            }
            return null;
        }

        public static bool CanSeeTailnet()
        {
            return !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("BEAM_TEST_PEERS")) || TailscaleExe() != null;
        }

        static void Add(List<Candidate> list, string url, string label)
        {
            if (url == null) return;
            var c = new Candidate();
            c.Url = url;
            c.Label = label;
            list.Add(c);
        }

        // Online peers from `tailscale status --json`. BEAM_TEST_PEERS (comma-separated URLs) replaces the tailnet for testing.
        static List<Candidate> Peers()
        {
            var list = new List<Candidate>();
            string test = Environment.GetEnvironmentVariable("BEAM_TEST_PEERS");
            if (!string.IsNullOrEmpty(test))
            {
                foreach (var u in test.Split(','))
                {
                    string url = Api.NormalizeBase(u);
                    if (url != null) Add(list, url, new Uri(url).Host);
                }
                return list;
            }
            string exe = TailscaleExe();
            if (exe == null) return list;
            try
            {
                var psi = new ProcessStartInfo(exe, "status --json");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = Encoding.UTF8;
                using (var p = Process.Start(psi))
                {
                    var output = p.StandardOutput.ReadToEndAsync();
                    p.StandardError.ReadToEndAsync();
                    if (!p.WaitForExit(8000))
                    {
                        try { p.Kill(); } catch { }
                        Log.Write("Discovery: tailscale status timed out");
                        return list;
                    }
                    var status = Json.ParseObject(output.Result);
                    // This PC first: if it hosts Beam behind `tailscale serve`, its tailnet name is the best address.
                    var self = Json.Obj(Json.Get(status, "Self"));
                    string selfDns = (Json.Str(self, "DNSName") ?? "").TrimEnd('.');
                    if (selfDns.Length > 0) Add(list, "https://" + selfDns, "This PC");
                    // A Beam in Docker gets its own node, conventionally called "beam".
                    int dot = selfDns.IndexOf('.');
                    if (dot > 0) Add(list, "https://beam" + selfDns.Substring(dot), "beam");
                    var peers = Json.Obj(Json.Get(status, "Peer"));
                    if (peers == null) return list;
                    foreach (var kv in peers)
                    {
                        var peer = Json.Obj(kv.Value);
                        if (!Json.Bool(peer, "Online", false)) continue;
                        string dns = (Json.Str(peer, "DNSName") ?? "").TrimEnd('.');
                        string label = Json.Str(peer, "HostName") ?? (dns.Length > 0 ? dns.Split('.')[0] : "peer");
                        if (dns.Length > 0) Add(list, "https://" + dns, label);
                        var ips = Json.StrList(peer, "TailscaleIPs");
                        string v4 = ips.FirstOrDefault(ip => ip.IndexOf('.') > 0);
                        if (v4 != null) Add(list, "http://" + v4 + ":" + DefaultPort, label);
                    }
                }
            }
            catch (Exception ex) { Log.Error("Discovery: tailscale", ex); }
            return list;
        }

        // A Beam server on this PC. BEAM_LOCAL_URLS (comma-separated) replaces it for testing.
        static List<Candidate> Local()
        {
            var list = new List<Candidate>();
            string over = Environment.GetEnvironmentVariable("BEAM_LOCAL_URLS");
            foreach (var u in string.IsNullOrEmpty(over) ? new[] { "http://localhost:" + DefaultPort } : over.Split(','))
                Add(list, Api.NormalizeBase(u), "This PC");
            return list;
        }

        static async Task<List<FoundServer>> Probe(List<Candidate> candidates, int timeoutSec, CancellationToken ct, string nonce, string secret)
        {
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var unique = candidates.Where(c => seen.Add(c.Url)).ToList();
            var tasks = unique.Select(async c =>
            {
                try
                {
                    var d = await Api.Hello(c.Url, timeoutSec, ct, nonce, secret).ConfigureAwait(false);
                    var f = new FoundServer();
                    f.Url = c.Url;
                    f.Label = c.Label;
                    f.ServerId = Json.Str(d, "serverId");
                    f.Version = Json.Str(d, "version");
                    f.ApiVersion = (int)Json.Long(d, "api", 2);
                    f.MovedTo = Json.Str(d, "movedTo");
                    if (string.IsNullOrEmpty(f.MovedTo)) f.MovedTo = null;
                    f.Hello = d;
                    return f;
                }
                catch { return null; }
            }).ToList();
            var results = await Task.WhenAll(tasks).ConfigureAwait(false);
            return results.Where(r => r != null).ToList();
        }

        // Every Beam that answers, best address first. Servers that moved away are left out.
        public static async Task<List<FoundServer>> FindAll(CancellationToken ct)
        {
            return await FindAll(ct, null, null, null).ConfigureAwait(false);
        }

        static async Task<List<FoundServer>> FindAll(CancellationToken ct, string nonce, string secret, IEnumerable<string> extra)
        {
            var candidates = Local();
            if (extra != null) foreach (var u in extra) Add(candidates, Api.NormalizeBase(u), "known address");
            candidates.AddRange(await Task.Run(() => Peers()).ConfigureAwait(false));
            Log.Write("Discovery: probing " + candidates.Count + " address(es)");
            var found = await Probe(candidates, 4, ct, nonce, secret).ConfigureAwait(false);
            Log.Write("Discovery: found " + (found.Count == 0 ? "nothing" : string.Join(", ", found.Select(f => f.Url + (f.MovedTo != null ? " (moved)" : "")))));
            // One entry per Beam: the same server can answer on localhost, its tailnet name and its IP.
            var result = new List<FoundServer>();
            foreach (var f in found.Where(x => x.MovedTo == null))
            {
                int same = string.IsNullOrEmpty(f.ServerId) ? -1 : result.FindIndex(r => r.ServerId == f.ServerId);
                if (same < 0) result.Add(f);
                else if (Rank(f) > Rank(result[same]))
                {
                    if (result[same].Label == "This PC" && f.Label != "This PC") f.Label = "This PC";
                    result[same] = f;
                }
            }
            return result.OrderByDescending(Rank).ToList();
        }

        // Prefer the tailnet (https) name, then other addresses, then localhost: it works from other devices too.
        static int Rank(FoundServer f)
        {
            Uri u;
            if (!Uri.TryCreate(f.Url, UriKind.Absolute, out u)) return 0;
            if (u.IsLoopback) return 0;
            return u.Scheme == Uri.UriSchemeHttps ? 2 : 1;
        }

        // Our Beam (same serverId, and a valid proof of our secret on API v3) at an address other than `except`, or null.
        public static async Task<FoundServer> FindOurs(string serverId, string secret, string except, IEnumerable<string> known, CancellationToken ct)
        {
            if (string.IsNullOrEmpty(serverId)) return null;
            string nonce = Api.NewNonce();
            var found = await FindAll(ct, nonce, secret, known).ConfigureAwait(false);
            return found.FirstOrDefault(f => !SameUrl(f.Url, except) && Api.IsOurServer(f.Hello, serverId, secret, nonce));
        }

        public static bool SameUrl(string a, string b)
        {
            return string.Equals((a ?? "").TrimEnd('/'), (b ?? "").TrimEnd('/'), StringComparison.OrdinalIgnoreCase);
        }
    }
}
