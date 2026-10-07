// This PC's status for the Beam server (Beam 1.3 servers, PUT /api/devices/me/status): battery (only when there is
// one), the system drive's free/total space, the Windows version, the MAC addresses of physical network adapters (so
// the server can wake this PC with Wake-on-LAN) and whether Remote Desktop is on. Nothing else is collected; the server
// never shows the MACs. Every report wakes the other devices' apps (a `devices` event), so it's sent only when
// something really changed (battery ±5 %, plugged in/out, crossing 20/15 %, the free space moving by a gigabyte or
// crossing the low-space line, another OS/adapter/Remote Desktop state), on connect when stale, and every 6 hours.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.NetworkInformation;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;
using Timer = System.Windows.Forms.Timer;

namespace Beam
{
    class StatusReporter
    {
        static readonly TimeSpan Check = TimeSpan.FromMinutes(15);   // look at storage & co. this often
        static readonly TimeSpan Refresh = TimeSpan.FromHours(6);    // report unchanged status this often
        readonly App app;
        readonly Timer timer;          // every minute on battery-powered PCs (battery changes), else every 15 minutes
        DateTime lastSent = DateTime.MinValue, lastChecked = DateTime.MinValue;
        Dictionary<string, object> last; // the last report the server took
        bool unsupported;              // the server has no status endpoint (older than 1.3): until the next connect
        bool sending, again, againForce;
        string reportedTo;             // server|serverId|device the last report went to

        public StatusReporter(App app)
        {
            this.app = app;
            timer = new Timer();
            timer.Tick += (s, e) => Tick();
        }

        public void OnConnected()
        {
            unsupported = false;
            // Another server or device record (signed in again, switched, moved): it has no status from us yet.
            string to = app.Cfg.Server + "|" + app.Cfg.ServerId + "|" + app.Me;
            if (to != reportedTo) { reportedTo = to; Forget(); }
            timer.Interval = Battery() != null ? 60 * 1000 : (int)Check.TotalMilliseconds;
            timer.Start();
            // A reconnect after a short blip needs no report unless something changed; after an hour it gets one.
            Report("connect", DateTime.UtcNow - lastSent > TimeSpan.FromHours(1));
        }

        public void Stop()
        {
            timer.Stop();
            Forget(); // signed out or revoked: the next sign-in reports afresh
        }

        void Forget()
        {
            last = null;
            lastSent = DateTime.MinValue;
            lastChecked = DateTime.MinValue;
        }

        // At once (the remote control switch or the lock changed): the server decides who may connect from it.
        public void Now(string why)
        {
            if (unsupported || app.Api == null || app.Conn != Conn.Online) return;
            Report(why, true);
        }

        // Plugged in or out, battery level notifications (SystemEvents), and the minute timer.
        public void CheckBattery()
        {
            if (unsupported || app.Api == null || app.Conn != Conn.Online) return;
            if (BatteryChanged(Battery())) Report("battery", true);
        }

        void Tick()
        {
            if (app.Conn != Conn.Online) return;
            if (DateTime.UtcNow - lastChecked >= Check - TimeSpan.FromSeconds(30)) Report("check", DateTime.UtcNow - lastSent >= Refresh);
            else CheckBattery();
        }

        static Dictionary<string, object> Part(Dictionary<string, object> d, string key)
        {
            object v;
            return d != null && d.TryGetValue(key, out v) ? v as Dictionary<string, object> : null;
        }

        static object Val(Dictionary<string, object> d, string key)
        {
            object v;
            return d != null && d.TryGetValue(key, out v) ? v : null;
        }

        // A real change: ±5 %, charging flips, or crossing 20 % / 15 % (the server's low-battery alert).
        bool BatteryChanged(Dictionary<string, object> b)
        {
            var a = Part(last, "battery");
            if (a == null || b == null) return a != b;
            int level = (int)b["level"], lastLevel = (int)a["level"];
            if ((bool)b["charging"] != (bool)a["charging"] || Math.Abs(level - lastLevel) >= 5) return true;
            return (level <= 20) != (lastLevel <= 20) || (level <= 15) != (lastLevel <= 15);
        }

        // Free space moved by a gigabyte (or 2 %), or crossed the server's low-space line (or its re-arm line).
        static bool StorageChanged(Dictionary<string, object> a, Dictionary<string, object> b)
        {
            if (a == null || b == null) return a != b;
            long freeA = Convert.ToInt64(a["free"]), freeB = Convert.ToInt64(b["free"]), total = Convert.ToInt64(b["total"]);
            if (total != Convert.ToInt64(a["total"])) return true;
            long low = Math.Max(2L << 30, total / 20), rearm = low + low / 5;
            if ((freeA < low) != (freeB < low) || (freeA < rearm) != (freeB < rearm)) return true;
            return Math.Abs(freeA - freeB) >= Math.Max(1L << 30, total / 50);
        }

        bool Changed(Dictionary<string, object> body)
        {
            if (last == null) return true;
            if (BatteryChanged(Part(body, "battery"))) return true;
            if (StorageChanged(Part(last, "storage"), Part(body, "storage"))) return true;
            if (!Equals(Val(last, "os"), Val(body, "os")) || !Equals(Val(last, "remoteDesktop"), Val(body, "remoteDesktop"))) return true;
            if (!Equals(Val(last, "remoteControl"), Val(body, "remoteControl")) || !Equals(Val(last, "locked"), Val(body, "locked"))) return true;
            if (!Equals(Val(last, "startsWithWindows"), Val(body, "startsWithWindows")) || !Equals(Val(last, "startWanted"), Val(body, "startWanted"))) return true;
            return string.Join(",", (string[])last["macs"]) != string.Join(",", (string[])body["macs"]);
        }

        async void Report(string why, bool force)
        {
            var api = app.Api;
            if (api == null || unsupported) return;
            if (sending) { again = true; againForce |= force; return; }
            sending = true;
            try
            {
                var body = await Task.Run(() => Collect());
                lastChecked = DateTime.UtcNow;
                if (api != app.Api) return;
                // Beam 1.6: the remote control switch and the lock (only to a server that knows them: others answer 400).
                if (app.ServerHas("remote-control") && app.Rc != null)
                {
                    body["remoteControl"] = app.Cfg.AllowRemoteControl;
                    body["locked"] = app.Rc.Locked;
                }
                // Beam 1.20 (app 1.14): for the setup check, whether Windows' own startup list has this app (and whether
                // its user wants it there). Only to a server that knows them: others answer 400.
                if (app.ServerHas("setup-check"))
                {
                    body["startsWithWindows"] = Autostart.IsEnabled(app.Cfg);
                    body["startWanted"] = app.Cfg.AutostartWanted != false;
                }
                if (!force && !Changed(body)) return;
                bool gone = !body.ContainsKey("battery") && Part(last, "battery") != null;
                if (gone) body["battery"] = null; // it went away (a UPS unplugged)
                await api.Call(HttpMethod.Put, "/api/devices/me/status", body, 20, CancellationToken.None);
                if (gone) body.Remove("battery");
                bool first = lastSent == DateTime.MinValue;
                lastSent = DateTime.UtcNow;
                last = body;
                if (first || why != "check") Log.Write("Status sent (" + why + ")");
            }
            catch (ApiException ex)
            {
                if (ex.Status == 404 || ex.Status == 405)
                {
                    unsupported = true;
                    Log.Write("Status: this Beam server doesn't take device status yet (older than 1.3)");
                }
                else if (ex.Status == 400)
                {
                    unsupported = true;
                    Log.Write("Status rejected by the server: " + ex.Message);
                }
                else Log.Write("Status: " + ex.Message);
            }
            catch (Exception ex) { Log.Write("Status: " + Api.Describe(ex)); }
            finally
            {
                sending = false;
                if (again)
                {
                    bool f = againForce;
                    again = againForce = false;
                    Report("changed", f);
                }
            }
        }

        // ------------------------------------------------------------------ what's reported

        public static Dictionary<string, object> Collect()
        {
            var d = new Dictionary<string, object>();
            var battery = Battery();
            if (battery != null) d["battery"] = battery;
            var storage = SystemDrive();
            if (storage != null) d["storage"] = storage;
            string os = OsName();
            if (!string.IsNullOrEmpty(os)) d["os"] = os;
            d["macs"] = PhysicalMacs().ToArray();
            d["remoteDesktop"] = RemoteDesktopOn();
            return d;
        }

        // { level 0-100, charging } or null when this PC has no battery (desktops) or Windows doesn't know.
        public static Dictionary<string, object> Battery()
        {
            try
            {
                var ps = SystemInformation.PowerStatus;
                if ((ps.BatteryChargeStatus & BatteryChargeStatus.NoSystemBattery) != 0 || ps.BatteryChargeStatus == BatteryChargeStatus.Unknown) return null;
                float pct = ps.BatteryLifePercent;
                if (pct < 0 || pct > 1) return null; // 255: unknown
                var b = new Dictionary<string, object>();
                b["level"] = (int)Math.Round(pct * 100);
                b["charging"] = ps.PowerLineStatus == PowerLineStatus.Online || (ps.BatteryChargeStatus & BatteryChargeStatus.Charging) != 0;
                return b;
            }
            catch { return null; }
        }

        static Dictionary<string, object> SystemDrive()
        {
            try
            {
                string root = Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.Windows));
                if (string.IsNullOrEmpty(root)) root = "C:\\";
                var drive = new DriveInfo(root);
                if (!drive.IsReady) return null;
                var s = new Dictionary<string, object>();
                s["free"] = drive.AvailableFreeSpace;
                s["total"] = drive.TotalSize;
                return s;
            }
            catch { return null; }
        }

        static RegistryKey Hklm()
        {
            return RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, Environment.Is64BitOperatingSystem ? RegistryView.Registry64 : RegistryView.Default);
        }

        static object Value(string key, string name)
        {
            try
            {
                using (var hklm = Hklm())
                using (var k = hklm.OpenSubKey(key))
                    return k != null ? k.GetValue(name) : null;
            }
            catch { return null; }
        }

        const string CurrentVersion = @"SOFTWARE\Microsoft\Windows NT\CurrentVersion";

        // "Windows 11 Pro 24H2". Windows 11 still calls itself "Windows 10" in ProductName; the build number tells.
        public static string OsName()
        {
            string product = (Value(CurrentVersion, "ProductName") as string ?? "Windows").Trim();
            string display = Value(CurrentVersion, "DisplayVersion") as string ?? Value(CurrentVersion, "ReleaseId") as string;
            int build;
            int.TryParse(Value(CurrentVersion, "CurrentBuildNumber") as string ?? "", out build);
            if (build >= 22000 && product.StartsWith("Windows 10", StringComparison.OrdinalIgnoreCase)) product = "Windows 11" + product.Substring(10);
            string s = product + (string.IsNullOrEmpty(display) ? "" : " " + display.Trim());
            return s.Length > 60 ? s.Substring(0, 60) : s;
        }

        // Remote Desktop accepts connections: not a Home edition, and fDenyTSConnections is 0 (Group Policy first).
        public static bool RemoteDesktopOn()
        {
            string edition = Value(CurrentVersion, "EditionID") as string ?? "";
            if (edition.StartsWith("Core", StringComparison.OrdinalIgnoreCase)) return false;
            object policy = Value(@"SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services", "fDenyTSConnections");
            if (policy is int) return (int)policy == 0;
            object deny = Value(@"SYSTEM\CurrentControlSet\Control\Terminal Server", "fDenyTSConnections");
            return deny is int && (int)deny == 0;
        }

        static readonly string[] VirtualWords = {
            "virtual", "hyper-v", "vethernet", "vpn", "tap-", "tap adapter", "tap-windows", "wintun", "wireguard", "tailscale",
            "zerotier", "vmware", "virtualbox", "npcap", "loopback", "bluetooth", "wi-fi direct", "miniport", "teredo",
            "isatap", "pseudo", "kernel debug", "docker", "wsl", "hamachi", "openvpn", "anyconnect", "globalprotect", "fortinet" };

        // MACs of physical Ethernet and Wi-Fi adapters (at most 8, working ones first). Virtual, VPN, Hyper-V,
        // Tailscale, Bluetooth and loopback adapters are left out.
        public static List<string> PhysicalMacs()
        {
            var list = new List<string>();
            try
            {
                var physical = PhysicalAdapterIds();
                var nics = NetworkInterface.GetAllNetworkInterfaces()
                    .OrderBy(n => n.OperationalStatus == OperationalStatus.Up ? 0 : 1)
                    .ThenBy(n => n.NetworkInterfaceType == NetworkInterfaceType.Wireless80211 ? 1 : 0);
                foreach (var ni in nics)
                {
                    var t = ni.NetworkInterfaceType;
                    if (t != NetworkInterfaceType.Ethernet && t != NetworkInterfaceType.GigabitEthernet && t != NetworkInterfaceType.FastEthernetT
                        && t != NetworkInterfaceType.FastEthernetFx && t != NetworkInterfaceType.Ethernet3Megabit && t != NetworkInterfaceType.Wireless80211) continue;
                    string text = ((ni.Description ?? "") + " " + (ni.Name ?? "")).ToLowerInvariant();
                    if (VirtualWords.Any(w => text.Contains(w))) continue;
                    if (physical != null && !physical.Contains(ni.Id)) continue;
                    var mac = ni.GetPhysicalAddress().GetAddressBytes();
                    if (mac.Length != 6 || mac.All(b => b == 0) || (mac[0] & 1) != 0) continue;
                    string s = string.Join(":", mac.Select(b => b.ToString("x2")));
                    if (!list.Contains(s)) list.Add(s);
                    if (list.Count == 8) break;
                }
            }
            catch (Exception ex) { Log.Error("Network adapters", ex); }
            return list;
        }

        // Adapter GUIDs Windows marks as physical (NCF_PHYSICAL in the network adapter class key), or null if unreadable.
        static HashSet<string> PhysicalAdapterIds()
        {
            try
            {
                var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                using (var hklm = Hklm())
                using (var cls = hklm.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Class\{4d36e972-e325-11ce-bfc1-08002be10318}"))
                {
                    if (cls == null) return null;
                    foreach (string sub in cls.GetSubKeyNames())
                    {
                        try
                        {
                            using (var k = cls.OpenSubKey(sub))
                            {
                                if (k == null) continue;
                                string id = k.GetValue("NetCfgInstanceId") as string;
                                object ch = k.GetValue("Characteristics");
                                if (id != null && ch is int && ((int)ch & 0x4) != 0) ids.Add(id);
                            }
                        }
                        catch { } // e.g. "Properties": not readable, not an adapter
                    }
                }
                return ids.Count > 0 ? ids : null;
            }
            catch { return null; }
        }
    }
}
