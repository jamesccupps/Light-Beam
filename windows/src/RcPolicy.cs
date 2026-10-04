// Remote control (Beam 1.6): the decisions this PC makes about a session that need neither Windows nor the network,
// kept apart so the input-mapping test can check them too. The PC enforces its own rules: its switch, its lock state,
// that the viewer is one of the owner's devices signed in for good, one session at a time, and that the connection's
// peer is the viewer's Tailscale address as the server saw it, on a node of the same Tailscale owner.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Beam
{
    class RcFacts
    {
        public bool ServerFeature;   // the server has `remote-control`
        public bool Allowed;         // "Allow remote control" is on here
        public bool Locked;          // this session is locked (or disconnected from the console)
        public bool Busy;            // a session with another viewer is going on
        public string Me, ViewerId;
        public bool ViewerKnown;     // in this PC's device list
        public bool ViewerTemporary; // a session-only sign-in (a borrowed computer)
        public string ViewerUser;    // the device record's user ("owner")
        public string Ip4, Ip6;      // the viewer's Tailscale addresses, as the server saw them
    }

    // (1.11) How Tailscale reaches a peer now: Via "direct" (Lan: through an address of the same network), "peer-relay"
    // (through another node of the tailnet) or "relay" (through Tailscale's relay servers; Relay names the region).
    class RcPath
    {
        public string Via, Relay;
        public bool Lan;

        public string Key { get { return Via + "|" + Lan + "|" + Relay; } }

        public string Describe()
        {
            if (Via == "direct") return Lan ? "directly, on the same network" : "directly, over the internet";
            if (Via == "peer-relay") return "through a peer relay";
            return "through Tailscale's relay" + (Relay != null ? " (" + Relay + ")" : "");
        }
    }

    static class RcPolicy
    {
        public const string IsLocked = "this PC is locked", IsBusy = "another device is controlling this PC";

        // Why this PC turns a request down (for beam.log), or null to go ahead.
        public static string Refusal(RcFacts f)
        {
            if (!f.ServerFeature) return "the server has no remote control";
            if (!f.Allowed) return "remote control is off on this PC";
            if (string.IsNullOrEmpty(f.ViewerId) || f.ViewerId == f.Me) return "it came from this PC itself";
            if (!f.ViewerKnown) return "it isn't one of your devices";
            if (f.ViewerTemporary) return "that device is only signed in for one browser session";
            if (!string.IsNullOrEmpty(f.ViewerUser) && f.ViewerUser != "owner") return "that device isn't the owner's";
            if (f.Locked) return IsLocked;
            if (f.Busy) return IsBusy;
            if (!IsTailscaleIp(f.Ip4) && !IsTailscaleIp(f.Ip6)) return "the viewer has no Tailscale address";
            return null;
        }

        // What this PC tells the server when it turns a request down (POST /end { reason }).
        public static string EndReason(string refusal)
        {
            if (refusal == null) return "stopped";
            if (refusal == IsLocked) return "locked";
            if (refusal == IsBusy) return "busy";
            return "declined";
        }

        // Tailscale's ranges: 100.64.0.0/10 and fd7a:115c:a1e0::/48.
        public static bool IsTailscaleIp(string ip)
        {
            IPAddress a;
            if (!TryParse(ip, out a)) return false;
            byte[] b = a.GetAddressBytes();
            if (a.AddressFamily == AddressFamily.InterNetwork) return b[0] == 100 && (b[1] & 0xC0) == 64;
            if (a.AddressFamily == AddressFamily.InterNetworkV6)
                return b[0] == 0xfd && b[1] == 0x7a && b[2] == 0x11 && b[3] == 0x5c && b[4] == 0xa1 && b[5] == 0xe0;
            return false;
        }

        public static bool SameIp(string x, string y)
        {
            IPAddress a, b;
            return TryParse(x, out a) && TryParse(y, out b) && a.Equals(b);
        }

        // The address in its plain form ("::ffff:100.64.0.1" → "100.64.0.1"), or null. Nothing else reaches a command line.
        public static string Canonical(string ip)
        {
            IPAddress a;
            return TryParse(ip, out a) ? a.ToString() : null;
        }

        static bool TryParse(string ip, out IPAddress a)
        {
            a = null;
            if (string.IsNullOrEmpty(ip)) return false;
            string s = ip.Trim().Trim('[', ']');
            int zone = s.IndexOf('%');
            if (zone >= 0) return false; // a link-local scope never is a Tailscale address
            if (!IPAddress.TryParse(s, out a)) return false;
            if (a.IsIPv4MappedToIPv6) a = a.MapToIPv4();
            // IPAddress.TryParse takes "100" or "1.2.3" too: only the full dotted form counts.
            if (a.AddressFamily == AddressFamily.InterNetwork && s.Split('.').Length != 4) { a = null; return false; }
            return true;
        }

        // The connection's peer (the selected candidate pair's REMOTE address; local ones read as "") must be one of
        // the viewer's addresses as the server attested them. Null when it is.
        public static string PeerRefusal(string remoteIp, string ip4, string ip6)
        {
            if (string.IsNullOrEmpty(remoteIp)) return "the connection's peer address is unknown";
            if (!IsTailscaleIp(remoteIp)) return "the peer isn't on Tailscale";
            if (!SameIp(remoteIp, ip4) && !SameIp(remoteIp, ip6)) return "the peer isn't the device that asked";
            return null;
        }

        // `tailscale whois --json <ip>` must name a node with that address, owned by the same user as this PC
        // (`tailscale status --json`: Self.UserID). Null when it does.
        public static string OwnerRefusal(IDictionary<string, object> whois, IDictionary<string, object> status, string ip)
        {
            var self = Obj(status, "Self");
            var node = Obj(whois, "Node");
            var profile = Obj(whois, "UserProfile");
            string selfUser = Str(self, "UserID");
            if (string.IsNullOrEmpty(selfUser)) return "this PC's Tailscale user is unknown";
            if (node == null) return "Tailscale doesn't know the peer";
            string owner = Str(node, "User") ?? Str(profile, "ID");
            if (string.IsNullOrEmpty(owner)) return "the peer's Tailscale owner is unknown";
            if (owner != selfUser) return "the peer belongs to another Tailscale user";
            bool listed = false, has = false;
            foreach (string cidr in List(node, "Addresses"))
            {
                listed = true;
                int slash = cidr.IndexOf('/');
                if (SameIp(slash >= 0 ? cidr.Substring(0, slash) : cidr, ip)) has = true;
            }
            if (!listed) return "Tailscale lists no addresses for that node"; // (1.7.2: this passed, the one open door here)
            if (!has) return "Tailscale names another node for that address";
            return null;
        }

        // A request of Beam's own pages that widens access to Beam (or hands it over), refused while another device
        // controls this PC: what it is, for beam.log, or null. The server routes these exact paths only.
        public static string WidensAccess(string method, string path)
        {
            method = (method ?? "GET").ToUpperInvariant();
            path = path ?? "";
            if (method == "GET" && (path == "/api/pair" || path == "/api/qr.svg" || path == "/api/qr.png")) return "a pairing link";
            if (method == "POST" && path == "/api/login-requests/approve") return "approving a sign-in";
            if (method == "POST" && path == "/api/password") return "setting the password";
            if ((method == "PATCH" && path == "/api/settings") || (method == "DELETE" && path.StartsWith("/api/settings/blocked-nodes/", StringComparison.Ordinal)))
                return "changing the server's settings";
            if (method == "POST" && path == "/api/security/sign-out-others") return "signing out the other devices";
            if ((method == "POST" || method == "DELETE") && path == "/api/move") return "moving the server";
            if (path.StartsWith("/api/admin/", StringComparison.Ordinal)) return "the server's admin actions";
            if (method == "POST" && path == "/api/rc/sessions") return "controlling another PC from this one";
            return null;
        }

        // (1.11) How Tailscale reaches the node with address `ip`, from `tailscale status --json`: its peer entry's CurAddr
        // (the address it talks to directly; empty while relayed), PeerRelay and Relay (its relay region). Null when no
        // peer has that address.
        public static RcPath PathOf(IDictionary<string, object> status, string ip)
        {
            var peers = Obj(status, "Peer");
            if (peers == null) return null;
            foreach (var kv in peers)
            {
                var p = kv.Value as IDictionary<string, object>;
                if (p == null) continue;
                bool match = false;
                foreach (string a in List(p, "TailscaleIPs")) if (SameIp(a, ip)) match = true;
                if (!match) continue;
                var r = new RcPath();
                string cur = Str(p, "CurAddr"), peerRelay = Str(p, "PeerRelay");
                if (!string.IsNullOrEmpty(cur)) { r.Via = "direct"; r.Lan = PrivateEndpoint(cur); }
                else if (!string.IsNullOrEmpty(peerRelay)) r.Via = "peer-relay";
                else { r.Via = "relay"; r.Relay = RegionCode(Str(p, "Relay")); }
                return r;
            }
            return null;
        }

        // "192.168.1.20:41641" or "[fd00::1]:41641": an address of a private network (the same Wi-Fi or LAN).
        static bool PrivateEndpoint(string endpoint)
        {
            string host = endpoint.Trim();
            if (host.StartsWith("[")) { int end = host.IndexOf(']'); host = end > 0 ? host.Substring(1, end - 1) : host; }
            else { int colon = host.LastIndexOf(':'); if (colon > 0 && host.IndexOf(':') == colon) host = host.Substring(0, colon); }
            IPAddress a;
            if (!IPAddress.TryParse(host, out a)) return false;
            if (a.IsIPv4MappedToIPv6) a = a.MapToIPv4();
            byte[] b = a.GetAddressBytes();
            if (a.AddressFamily == AddressFamily.InterNetwork)
                return b[0] == 10 || (b[0] == 172 && (b[1] & 0xF0) == 16) || (b[0] == 192 && b[1] == 168) || (b[0] == 169 && b[1] == 254);
            return (b[0] & 0xFE) == 0xFC || (b[0] == 0xFE && (b[1] & 0xC0) == 0x80); // fc00::/7, fe80::/10
        }

        // A relay region's code ("nyc"), or null for anything else.
        static string RegionCode(string s)
        {
            if (string.IsNullOrEmpty(s) || s.Length > 16) return null;
            foreach (char c in s) if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) return null;
            return s;
        }

        // A device name as the banner shows it: no control or direction characters, at most 40 characters.
        public static string DisplayName(string name)
        {
            var sb = new StringBuilder();
            foreach (char c in name ?? "")
            {
                var cat = char.GetUnicodeCategory(c);
                if (cat == UnicodeCategory.Control || cat == UnicodeCategory.Format || cat == UnicodeCategory.LineSeparator ||
                    cat == UnicodeCategory.ParagraphSeparator) continue;
                sb.Append(char.IsWhiteSpace(c) ? ' ' : c);
            }
            string s = sb.ToString().Trim();
            while (s.Contains("  ")) s = s.Replace("  ", " ");
            if (s.Length > 40) s = s.Substring(0, 39).TrimEnd() + "…";
            return s.Length == 0 ? "Another device" : s;
        }

        static IDictionary<string, object> Obj(IDictionary<string, object> d, string key)
        {
            object v;
            return d != null && d.TryGetValue(key, out v) ? v as IDictionary<string, object> : null;
        }

        static string Str(IDictionary<string, object> d, string key)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v) || v == null) return null;
            return v as string ?? Convert.ToString(v, CultureInfo.InvariantCulture);
        }

        static List<string> List(IDictionary<string, object> d, string key)
        {
            var list = new List<string>();
            object v;
            if (d == null || !d.TryGetValue(key, out v)) return list;
            var e = v as IEnumerable;
            if (e == null || v is string) return list;
            foreach (var x in e) if (x is string) list.Add((string)x);
            return list;
        }
    }
}
