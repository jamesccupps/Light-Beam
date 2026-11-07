// (1.24, Beam 1.31) The web pages this PC serves to the tailnet, for Beam's Sites list (the user, 2026-11-06: every
// Tailscale site they have, listed in Beam). Sent in this PC's status
// (`sites`: port, the page's title, https) to a server that lists the feature; the server lists each at this PC's
// Tailscale name and checks it from there.
//
// What counts: a program listening on every address (0.0.0.0 / ::) or on this PC's Tailscale address, on a port web
// pages use (WebPort), whose answer to GET / is a web page (200-399 or 401, text/html). Windows' own programs,
// Tailscale's and Beam's are left out; a page bound to 127.0.0.1 only isn't reachable from the tailnet and isn't listed.
//
// The listening sockets come from the whole TCP table (TCP_TABLE_OWNER_PID_ALL), not the listeners-only one: on the
// user's Insider build (10.0.28120) the state field is garbage and the listeners-only table lists open connections
// instead of a web page's 0.0.0.0 listener (2026-11-06). A listening socket is a row whose remote end is empty, whatever its
// state says. Each port is asked once per program run (port|pid); a scan with nothing new costs one table read.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace Beam
{
    static class SiteFinder
    {
        const int MaxSites = 24;
        const int ReadLimit = 64 * 1024;

        class Probe { public bool Site; public string Title; public bool Https; }

        static readonly object Gate = new object();
        static readonly Dictionary<string, Probe> Known = new Dictionary<string, Probe>(); // "port|pid" -> what it answered

        // Only ports web pages use are asked: 80, 81, 443, 591, 1880 and 3000-10999. Never the others: the user's work PCs
        // run building automation, and a web request has no business on an industrial protocol's port (Modbus 502, S7
        // 102, OPC UA 4840, Niagara Fox, IEC 104, DNP3, EtherNet/IP...). Inside the ranges, ports known to be something
        // else are left out too: Windows' own (Remote Desktop, WSD, WinRM, Delivery Optimization), databases and
        // message queues (MySQL, Postgres, AMQP, Kafka, MQTT over TLS), OPC UA, Niagara Fox over TLS, MELSEC, HART-IP.
        static readonly HashSet<int> NotWeb = new HashSet<int>
        {
            3306, 3389, 4840, 4843, 4911, 5007, 5040, 5094, 5357, 5358, 5432, 5672, 5985, 5986, 7680, 8883, 9092, 9600
        };

        static bool WebPort(int port)
        {
            if (NotWeb.Contains(port)) return false;
            return port == 80 || port == 81 || port == 443 || port == 591 || port == 1880 || (port >= 3000 && port <= 10999);
        }
        static readonly HashSet<string> SystemPrograms = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "svchost", "lsass", "wininit", "services", "spoolsv", "tailscaled", "tailscale-ipn", "Beam", "BeamInput"
        };

        struct Listener { public IPAddress Address; public int Port; public int Pid; }

        // This PC's sites, by port: [{ port, title, https? }]. Never throws (an empty list).
        public static List<Dictionary<string, object>> Find()
        {
            var result = new List<Dictionary<string, object>>();
            // Test instances (testOffscreen) never ask this PC's own programs: the user's pages run here.
            if (Ui.TestOffscreen) return result;
            try
            {
                int me = Process.GetCurrentProcess().Id;
                var byPort = new Dictionary<int, Listener>();
                foreach (var l in Listeners())
                {
                    if (l.Pid == me || l.Pid == 0 || !WebPort(l.Port) || !Reachable(l.Address)) continue;
                    Listener seen;
                    // one address a port: the Tailscale one or every address (0.0.0.0 before ::)
                    if (!byPort.TryGetValue(l.Port, out seen) || (seen.Address.AddressFamily == AddressFamily.InterNetworkV6 && l.Address.AddressFamily == AddressFamily.InterNetwork)) byPort[l.Port] = l;
                }
                var todo = new List<Listener>();
                var names = new Dictionary<int, string>();
                lock (Gate)
                {
                    var live = new HashSet<string>(byPort.Values.Select(l => l.Port + "|" + l.Pid));
                    foreach (var k in Known.Keys.Where(k => !live.Contains(k)).ToList()) Known.Remove(k);
                    foreach (var l in byPort.Values) if (!Known.ContainsKey(l.Port + "|" + l.Pid)) todo.Add(l);
                }
                todo = todo.Where(l => { string n = ProgramName(l.Pid); names[l.Pid] = n; return n == null || !SystemPrograms.Contains(n); }).Take(40).ToList();
                var probes = todo.Select(l => Task.Run(() => new KeyValuePair<Listener, Probe>(l, Ask(l, names.ContainsKey(l.Pid) ? names[l.Pid] : null)))).ToArray();
                if (probes.Length > 0) Task.WaitAll(probes, 8000);
                lock (Gate)
                {
                    foreach (var t in probes) if (t.Status == TaskStatus.RanToCompletion) Known[t.Result.Key.Port + "|" + t.Result.Key.Pid] = t.Result.Value;
                    foreach (var l in byPort.Values.OrderBy(x => x.Port))
                    {
                        Probe p;
                        if (!Known.TryGetValue(l.Port + "|" + l.Pid, out p) || !p.Site) continue;
                        var d = new Dictionary<string, object>();
                        d["port"] = l.Port;
                        d["title"] = p.Title;
                        if (p.Https) d["https"] = true;
                        result.Add(d);
                        if (result.Count == MaxSites) break;
                    }
                }
            }
            catch (Exception ex) { Log.Error("Sites", ex); }
            return result;
        }

        // A short text that changes when the list does (for the status report's "something changed").
        public static string Signature(object sites)
        {
            var list = sites as List<Dictionary<string, object>>;
            if (list == null) return "";
            return string.Join("\n", list.Select(d => d["port"] + " " + d["title"] + (d.ContainsKey("https") ? " s" : "")));
        }

        // 0.0.0.0, :: or this PC's Tailscale address (100.64.0.0/10, fd7a:115c:a1e0::/48).
        static bool Reachable(IPAddress a)
        {
            if (a.Equals(IPAddress.Any) || a.Equals(IPAddress.IPv6Any)) return true;
            byte[] b = a.GetAddressBytes();
            if (b.Length == 4) return b[0] == 100 && (b[1] & 0xC0) == 64;
            return b.Length == 16 && b[0] == 0xfd && b[1] == 0x7a && b[2] == 0x11 && b[3] == 0x5c && b[4] == 0xa1 && b[5] == 0xe0;
        }

        static string ProgramName(int pid)
        {
            if (pid == 4) return "System";
            try { using (var p = Process.GetProcessById(pid)) return p.ProcessName; }
            catch { return null; }
        }

        // The program's own name for itself ("Node.js JavaScript Runtime", "Python"), for a page without a title.
        static string ProgramTitle(int pid, string fallback)
        {
            try
            {
                using (var p = Process.GetProcessById(pid))
                {
                    var info = p.MainModule.FileVersionInfo;
                    string s = !string.IsNullOrWhiteSpace(info.FileDescription) ? info.FileDescription : info.ProductName;
                    if (!string.IsNullOrWhiteSpace(s)) return s.Trim();
                }
            }
            catch { } // another account's or an elevated program: its name is enough
            return fallback ?? "A web page";
        }

        // ------------------------------------------------------------------ asking a port

        static Probe Ask(Listener l, string program)
        {
            var target = l.Address.Equals(IPAddress.Any) ? IPAddress.Loopback : l.Address.Equals(IPAddress.IPv6Any) ? IPAddress.IPv6Loopback : l.Address;
            var probe = new Probe();
            try
            {
                var r = Get(target, l.Port, "/", false);
                if (r != null && r.Tls) { r = Get(target, l.Port, "/", true); if (r != null) probe.Https = true; }
                if (r != null && r.Status >= 300 && r.Status < 400 && r.Location != null)
                {
                    // one redirect on this PC (a sign-in page's title is the site's too)
                    Uri next;
                    if (Uri.TryCreate(new Uri("http://localhost:" + l.Port + "/"), r.Location, out next) && (next.IsLoopback || next.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase)) && next.Port == l.Port)
                    {
                        var r2 = Get(target, l.Port, next.PathAndQuery, probe.Https);
                        if (r2 != null && r2.Html && r2.Title != null) r.Title = r2.Title;
                    }
                }
                if (r == null || !(r.Status >= 200 && r.Status < 400 || r.Status == 401)) return probe;
                if (!r.Html && !(r.Status >= 300 && r.Status < 400)) return probe;
                probe.Site = true;
                probe.Title = Clean(r.Title) ?? Clean(ProgramTitle(l.Pid, program)) ?? "A web page";
            }
            catch { }
            return probe;
        }

        class Answer { public int Status; public bool Html; public string Title; public string Location; public bool Tls; }

        static readonly Regex StatusLine = new Regex(@"^HTTP/1\.[01] (\d{3})", RegexOptions.Compiled);
        static readonly Regex TitleTag = new Regex(@"<title[^>]*>([^<]{0,2000})", RegexOptions.IgnoreCase | RegexOptions.Compiled);

        static Answer Get(IPAddress addr, int port, string path, bool tls)
        {
            using (var c = new TcpClient(addr.AddressFamily))
            {
                var wait = c.BeginConnect(addr, port, null, null);
                if (!wait.AsyncWaitHandle.WaitOne(1000)) return null;
                c.EndConnect(wait);
                c.ReceiveTimeout = 2000;
                c.SendTimeout = 2000;
                System.IO.Stream s = c.GetStream();
                // A program that speaks first (SSH, a database, a mail server) isn't a web page.
                if (!tls) { c.Client.Poll(150 * 1000, SelectMode.SelectRead); if (c.Available > 0) return null; }
                if (tls)
                {
                    // This PC's own page, only to read its title: its certificate (often one it made itself) isn't checked.
                    var ssl = new SslStream(s, false, (sender, cert, chain, errors) => true);
                    ssl.AuthenticateAsClient("localhost");
                    s = ssl;
                }
                string req = "GET " + path + " HTTP/1.1\r\nHost: localhost:" + port + "\r\nAccept: text/html\r\nUser-Agent: Beam (finding this PC's sites)\r\nConnection: close\r\n\r\n";
                var bytes = Encoding.ASCII.GetBytes(req);
                s.Write(bytes, 0, bytes.Length);
                var buf = new byte[ReadLimit];
                int got = 0;
                var until = DateTime.UtcNow.AddSeconds(2.5);
                try
                {
                    while (got < buf.Length && DateTime.UtcNow < until)
                    {
                        int n = s.Read(buf, got, buf.Length - got);
                        if (n <= 0) break;
                        got += n;
                        if (got > 16 && Encoding.ASCII.GetString(buf, 0, Math.Min(got, 4096)).IndexOf("</title>", StringComparison.OrdinalIgnoreCase) >= 0) break;
                    }
                }
                catch (System.IO.IOException) { } // the read timed out or it closed: use what came
                if (got == 0) return null;
                if (!tls && buf[0] == 0x15) return new Answer { Tls = true }; // a TLS alert: it wants https
                string text = Encoding.UTF8.GetString(buf, 0, got);
                var m = StatusLine.Match(text);
                if (!m.Success) return null;
                var a = new Answer { Status = int.Parse(m.Groups[1].Value) };
                int end = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
                string head = end > 0 ? text.Substring(0, end) : text;
                foreach (var line in head.Split(new[] { "\r\n" }, StringSplitOptions.None))
                {
                    int colon = line.IndexOf(':');
                    if (colon <= 0) continue;
                    string name = line.Substring(0, colon).Trim(), value = line.Substring(colon + 1).Trim();
                    if (name.Equals("Content-Type", StringComparison.OrdinalIgnoreCase)) a.Html = value.IndexOf("html", StringComparison.OrdinalIgnoreCase) >= 0;
                    else if (name.Equals("Location", StringComparison.OrdinalIgnoreCase)) a.Location = value;
                }
                if (!tls && a.Status == 400 && text.IndexOf("HTTPS", StringComparison.OrdinalIgnoreCase) >= 0 && text.IndexOf("plain HTTP", StringComparison.OrdinalIgnoreCase) >= 0) return new Answer { Tls = true };
                if (a.Html && end > 0)
                {
                    var t = TitleTag.Match(text, end);
                    if (t.Success) a.Title = WebUtility.HtmlDecode(t.Groups[1].Value);
                }
                return a;
            }
        }

        // One line of at most 80 characters, or null.
        static string Clean(string s)
        {
            if (s == null) return null;
            var sb = new StringBuilder();
            foreach (char ch in s) sb.Append(char.IsControl(ch) || (ch >= '‪' && ch <= '‮') || (ch >= '⁦' && ch <= '⁩') ? ' ' : ch);
            string t = Regex.Replace(sb.ToString(), @"\s+", " ").Trim();
            if (t.Length == 0) return null;
            if (t.Length > 80) t = t.Substring(0, 80).TrimEnd();
            if (char.IsHighSurrogate(t[t.Length - 1])) t = t.Substring(0, t.Length - 1);
            return t.Length > 0 ? t : null;
        }

        // ------------------------------------------------------------------ the TCP table

        [DllImport("iphlpapi.dll", SetLastError = true)]
        static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int af, int tableClass, uint reserved);

        const int AF_INET = 2, AF_INET6 = 23, TCP_TABLE_OWNER_PID_ALL = 5;

        static List<Listener> Listeners()
        {
            var list = new List<Listener>();
            Read(AF_INET, 24, (row, l) =>
            {
                uint remote = (uint)Marshal.ReadInt32(row + 12);
                int rport = (Marshal.ReadByte(row + 16) << 8) | Marshal.ReadByte(row + 17);
                if (remote != 0 || rport != 0) return false;
                l.Address = new IPAddress((long)(uint)Marshal.ReadInt32(row + 4));
                l.Port = (Marshal.ReadByte(row + 8) << 8) | Marshal.ReadByte(row + 9);
                l.Pid = Marshal.ReadInt32(row + 20);
                list.Add(l);
                return true;
            });
            Read(AF_INET6, 56, (row, l) =>
            {
                var remote = new byte[16];
                Marshal.Copy(row + 24, remote, 0, 16);
                int rport = (Marshal.ReadByte(row + 44) << 8) | Marshal.ReadByte(row + 45);
                if (remote.Any(x => x != 0) || rport != 0) return false;
                var local = new byte[16];
                Marshal.Copy(row, local, 0, 16);
                l.Address = new IPAddress(local);
                l.Port = (Marshal.ReadByte(row + 20) << 8) | Marshal.ReadByte(row + 21);
                l.Pid = Marshal.ReadInt32(row + 52);
                list.Add(l);
                return true;
            });
            return list;
        }

        static void Read(int af, int rowSize, Func<IntPtr, Listener, bool> each)
        {
            int size = 0;
            GetExtendedTcpTable(IntPtr.Zero, ref size, false, af, TCP_TABLE_OWNER_PID_ALL, 0);
            for (int attempt = 0; attempt < 3 && size > 0; attempt++)
            {
                size += 4096; // it can grow between the two calls
                IntPtr buf = Marshal.AllocHGlobal(size);
                try
                {
                    uint r = GetExtendedTcpTable(buf, ref size, false, af, TCP_TABLE_OWNER_PID_ALL, 0);
                    if (r == 122) continue; // ERROR_INSUFFICIENT_BUFFER: again with the new size
                    if (r != 0) return;
                    int n = Marshal.ReadInt32(buf);
                    for (int i = 0; i < n; i++) each(buf + 4 + i * rowSize, new Listener());
                    return;
                }
                finally { Marshal.FreeHGlobal(buf); }
            }
        }
    }
}
