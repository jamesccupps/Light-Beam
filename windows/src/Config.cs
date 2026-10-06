// Settings (config.json) and local state (handled.json, state.json), stored next to each other.
// A custom --config keeps *everything* (downloads, Send to, outbox, autostart, clipboard, WebView profile,
// install location) inside that config's folder, so test instances never touch the user's real setup.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;

namespace Beam
{
    class Config
    {
        public string FilePath;
        public string Dir;
        public bool CustomPath;

        public string Server;
        public string Key;                     // in config.json DPAPI-protected for this Windows account (keyProtected), Beam 1.6
        public bool KeyUnreadable;             // a protected key this account can't read (a copied config): sign in again
        bool keyInClear;                       // read from a plain "key" (before 1.6, or written by the installer)
        public bool RotateToken;               // the sign-in was once kept in clear: replace it, once (App.RenewSignIn)
        public string RevokeKey;               // ...and the old one, until the server has revoked it (DPAPI-protected too)
        public string ServerId;
        public bool AutoUpdate = true;
        public int RediscoverSec = 600;
        public string DeviceId;
        public string DeviceName;
        public bool AutoCopy = true;
        public bool ClipboardHistory = true;   // received text may appear in Win+V history / cloud clipboard
        public bool OpenLinks = true;          // clicking a notification about a link opens the link
        public bool AutoOpenLinks;             // a link sent to this PC opens in the browser at once
        public bool PhonePopupText = true;     // phone notification balloons show the message (off: app and count only)
        public bool AllowRemoteControl;        // Beam 1.6 "Allow remote control": off by default, turned on only at this PC
        public string RcBannerSpot;            // Beam 1.7.4: where the remote-control banner was put ("screen|fx|fy", RcBannerPlace)
        public bool RcKvmBannerHidden;         // Beam 1.12: a kvm session's banner folded into the tray (chosen at this PC)
        public bool RcKvmTarget;               // Beam 1.12.4: a kvm session has been live here: its capture host is kept warm
        public bool KvmOn;                     // Beam 1.12: this PC's keyboard and mouse go over to the PCs beside it (KvmController)
        public List<KvmPlace> KvmPlaces = new List<KvmPlace>(); // ...where those PCs stand around it (1.12.5; 1.12's kvmLeft: a row to its left)
        public string RcDisplayRestore;        // Beam 1.8: a screen fitted to a viewer, as it was ("device|w|h|hz|percent", RcDisplay)
        public string InstallId;               // Beam 1.8.1: this install's own id (its settings backups on the server go by it)
        public bool RestoreChecked;            // ...and an earlier install's backup was looked for (offered once)
        public List<RcAllowed> RemoteControlDevices = new List<RcAllowed>(); // ...and the devices that may (pinned to their Tailscale node)
        public bool AutoSave = true;
        public long MaxSaveMB = 2048;
        public string SaveFolder;
        public bool SendToMenu = true;
        public string SendToFolder;
        public bool Outbox = false;
        public string OutboxFolder;
        public string LastConversation = "*";
        public List<string> LastTargets = new List<string>();
        public int WinX, WinY, WinW, WinH;
        public bool WinMax;
        public int FamX, FamY, FamW, FamH;     // (1.10) Beam Family's window
        public bool FamMax;
        public double Zoom = 1.0;
        public int HeartbeatSec = 70;
        public bool Quiet;                     // tests: no tray icon and no notifications
        public bool TestOffscreen;             // tests (custom --config only): every window opens off-screen, unfocused
        public int TestRcLeaseSec;             // tests (custom --config only): the remote control lease interval
        public string TestTailscaleExe, TestTailscaleArgs; // tests (custom --config only): a fake `tailscale` CLI
        public int WebViewReleaseSec = 180;    // the hidden messenger window's web view is released after this
        public string BadUpdateVersion;        // an update that failed its health check; skipped until a newer one
        public bool AutostartInitialized;      // "start with Windows" was set up once; the user owns it from then on
        public bool RuntimeHintShown;          // told once that the WebView2 runtime is missing
        public Dictionary<string, string> Hotkeys = DefaultHotkeys();
        public List<string> KnownUrls = new List<string>(); // every address our Beam said it answers on (hello.urls)

        Dictionary<string, object> raw = new Dictionary<string, object>();

        public static Dictionary<string, string> DefaultHotkeys()
        {
            var d = new Dictionary<string, string>();
            d["picker"] = "Ctrl+Alt+B";
            d["lastTarget"] = "Ctrl+Alt+Shift+B";
            d["copyLatest"] = "Ctrl+Alt+G";
            d["screenshot"] = "Ctrl+Alt+Shift+S";
            return d;
        }

        public bool Paired
        {
            get { return !string.IsNullOrEmpty(Server) && !string.IsNullOrEmpty(Key); }
        }

        static string LocalAppData { get { return Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData); } }

        public string SaveFolderPath
        {
            get
            {
                if (!string.IsNullOrEmpty(SaveFolder)) return SaveFolder;
                return CustomPath ? Path.Combine(Dir, "Downloads") : Path.Combine(FileUtil.DownloadsFolder(), "Beam");
            }
        }

        public string SendToFolderPath
        {
            get
            {
                if (!string.IsNullOrEmpty(SendToFolder)) return SendToFolder;
                if (CustomPath) return Path.Combine(Dir, "SendTo", "Beam");
                return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.SendTo), "Beam");
            }
        }

        public string OutboxFolderPath
        {
            get
            {
                if (!string.IsNullOrEmpty(OutboxFolder)) return OutboxFolder;
                if (CustomPath) return Path.Combine(Dir, "Outbox");
                return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Beam");
            }
        }

        // Copies Beam makes to send (clipboard images, zipped folders). Not %TEMP%: they must survive a restart
        // until the upload has finished.
        public string OutgoingFolder
        {
            get { return CustomPath ? Path.Combine(Dir, "outgoing") : Path.Combine(LocalAppData, "Beam", "outgoing"); }
        }

        public string WebViewFolder
        {
            get { return CustomPath ? Path.Combine(Dir, "WebView2") : Path.Combine(LocalAppData, "Beam", "WebView2"); }
        }

        // Where 1.1.0 downloaded updates; only cleaned up now (1.2.0 stages updates next to the installed exe).
        public string LegacyUpdateFolder
        {
            get { return CustomPath ? Path.Combine(Dir, "update") : Path.Combine(LocalAppData, "Beam", "update"); }
        }

        public string InstallDir
        {
            get { return CustomPath ? Path.Combine(Dir, "Programs", "Beam") : Path.Combine(LocalAppData, "Programs", "Beam"); }
        }

        public string StartMenuFolder
        {
            get { return CustomPath ? Path.Combine(Dir, "Start Menu") : Environment.GetFolderPath(Environment.SpecialFolder.Programs); }
        }

        public long MaxSaveBytes
        {
            get { return MaxSaveMB * 1024L * 1024L; }
        }

        public static string DefaultPath()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Beam", "config.json");
        }

        public static Config Load(string path, bool custom)
        {
            var c = new Config();
            c.FilePath = Path.GetFullPath(path);
            c.Dir = Path.GetDirectoryName(c.FilePath);
            c.CustomPath = custom;
            Directory.CreateDirectory(c.Dir);
            Dictionary<string, object> d = null;
            try
            {
                if (File.Exists(c.FilePath)) d = Json.ParseObject(File.ReadAllText(c.FilePath, Encoding.UTF8));
                if (d == null && File.Exists(c.FilePath + ".tmp")) d = Json.ParseObject(File.ReadAllText(c.FilePath + ".tmp", Encoding.UTF8));
            }
            catch (Exception ex) { Log.Error("Reading config", ex); }
            if (d != null)
            {
                c.raw = d;
                c.Server = Json.Str(d, "server");
                string sealedKey = Json.Str(d, "keyProtected");
                if (!string.IsNullOrEmpty(sealedKey))
                {
                    c.Key = Dpapi.Unprotect(sealedKey, Dpapi.ConfigKey);
                    if (c.Key == null)
                    {
                        c.KeyUnreadable = true;
                        Log.Write("The saved sign-in can't be read by this Windows account (a copied or restored config?): sign in again");
                    }
                }
                else
                {
                    c.Key = Json.Str(d, "key");
                    c.keyInClear = !string.IsNullOrEmpty(c.Key);
                }
                c.RotateToken = c.Key != null && (c.keyInClear || Json.Bool(d, "rotateToken", false));
                string sealedOld = Json.Str(d, "revokeKeyProtected");
                if (!string.IsNullOrEmpty(sealedOld)) c.RevokeKey = Dpapi.Unprotect(sealedOld, Dpapi.ConfigKey);
                c.ServerId = Json.Str(d, "serverId");
                c.AutoUpdate = Json.Bool(d, "autoUpdate", true);
                c.RediscoverSec = (int)Math.Max(10, Json.Long(d, "rediscoverSec", 600));
                c.DeviceId = Json.Str(d, "deviceId");
                c.DeviceName = Json.Str(d, "deviceName");
                c.AutoCopy = Json.Bool(d, "autoCopy", true);
                c.ClipboardHistory = Json.Bool(d, "clipboardHistory", true);
                c.OpenLinks = Json.Bool(d, "openLinks", true);
                c.AutoOpenLinks = Json.Bool(d, "autoOpenLinks", false);
                c.PhonePopupText = Json.Bool(d, "phonePopupText", true);
                c.AllowRemoteControl = Json.Bool(d, "allowRemoteControl", false);
                c.RcBannerSpot = Json.Str(d, "rcBannerSpot");
                c.RcKvmBannerHidden = Json.Bool(d, "rcKvmBannerHidden", false);
                c.RcKvmTarget = Json.Bool(d, "rcKvmTarget", false);
                c.KvmOn = Json.Bool(d, "kvmOn", false);
                var places = Json.Get(d, "kvmPlaces") as object[];
                if (places != null)
                    c.KvmPlaces = KvmLayout.Clean(places.Select(o => Json.Obj(o)).Where(p => p != null && ValidId(Json.Str(p, "id")))
                        .Select(p => new KvmPlace { Id = Json.Str(p, "id"), X = (int)Json.Long(p, "x", 0), Y = (int)Json.Long(p, "y", 0) }), KvmController.MaxPcs);
                else // (1.12's row to the left, nearest first)
                    c.KvmPlaces = KvmLayout.Clean(Json.StrList(d, "kvmLeft").Where(ValidId).Distinct().Select((id, i) => new KvmPlace { Id = id, X = -(i + 1), Y = 0 }), KvmController.MaxPcs);
                c.RcDisplayRestore = Json.Str(d, "rcDisplayRestore");
                c.InstallId = Json.Str(d, "installId");
                c.RestoreChecked = Json.Bool(d, "restoreChecked", false);
                var rcList = Json.Get(d, "remoteControlDevices") as object[];
                if (rcList != null)
                    foreach (var o in rcList)
                    {
                        var a = RcAllowed.Parse(Json.Obj(o));
                        if (a != null && !c.RemoteControlDevices.Any(x => x.Id == a.Id)) c.RemoteControlDevices.Add(a);
                    }
                c.AutoSave = Json.Bool(d, "autoSave", true);
                c.MaxSaveMB = Math.Max(1, Json.Long(d, "maxSaveMB", 2048));
                c.SaveFolder = Json.Str(d, "saveFolder");
                c.SendToMenu = Json.Bool(d, "sendToMenu", true);
                c.SendToFolder = Json.Str(d, "sendToFolder");
                c.Outbox = Json.Bool(d, "outbox", false);
                c.OutboxFolder = Json.Str(d, "outboxFolder");
                c.LastConversation = Json.Str(d, "lastConversation") ?? "*";
                c.LastTargets = Json.StrList(d, "lastTargets");
                c.KnownUrls = Json.StrList(d, "knownUrls");
                c.HeartbeatSec = (int)Math.Max(5, Json.Long(d, "heartbeatSec", 70));
                c.Quiet = Json.Bool(d, "quiet", false);
                c.TestOffscreen = Json.Bool(d, "testOffscreen", false);
                if (custom)
                {
                    c.TestRcLeaseSec = (int)Math.Max(0, Json.Long(d, "testRcLeaseSec", 0));
                    c.TestTailscaleExe = Json.Str(d, "testTailscaleExe");
                    c.TestTailscaleArgs = Json.Str(d, "testTailscaleArgs");
                }
                c.WebViewReleaseSec = (int)Math.Max(5, Json.Long(d, "webViewReleaseSec", 180));
                c.BadUpdateVersion = Json.Str(d, "badUpdateVersion");
                c.AutostartInitialized = Json.Bool(d, "autostartInitialized", false);
                c.RuntimeHintShown = Json.Bool(d, "runtimeHintShown", false);
                double zoom;
                if (double.TryParse(Json.Str(d, "zoom") ?? "", NumberStyles.Float, CultureInfo.InvariantCulture, out zoom) && zoom >= 0.25 && zoom <= 5) c.Zoom = zoom;
                var hk = Json.Obj(Json.Get(d, "hotkeys"));
                if (hk != null)
                    foreach (var kv in hk)
                        if (c.Hotkeys.ContainsKey(kv.Key)) c.Hotkeys[kv.Key] = kv.Value == null ? "" : Convert.ToString(kv.Value, CultureInfo.InvariantCulture);
                var w = Json.Obj(Json.Get(d, "window"));
                if (w != null)
                {
                    c.WinX = (int)Json.Long(w, "x", 0);
                    c.WinY = (int)Json.Long(w, "y", 0);
                    c.WinW = (int)Json.Long(w, "w", 0);
                    c.WinH = (int)Json.Long(w, "h", 0);
                    c.WinMax = Json.Bool(w, "max", false);
                }
                var fw = Json.Obj(Json.Get(d, "familyWindow"));
                if (fw != null)
                {
                    c.FamX = (int)Json.Long(fw, "x", 0);
                    c.FamY = (int)Json.Long(fw, "y", 0);
                    c.FamW = (int)Json.Long(fw, "w", 0);
                    c.FamH = (int)Json.Long(fw, "h", 0);
                    c.FamMax = Json.Bool(fw, "max", false);
                }
            }
            bool dirty = false;
            if (string.IsNullOrEmpty(c.DeviceId) || !ValidId(c.DeviceId))
            {
                c.DeviceId = Guid.NewGuid().ToString("N");
                dirty = true;
            }
            if (!ValidId(c.InstallId))
            {
                c.InstallId = Guid.NewGuid().ToString("N").Substring(0, 16);
                dirty = true;
            }
            if (string.IsNullOrEmpty(c.DeviceName)) c.DeviceName = DefaultName();
            if (c.keyInClear)
            {
                dirty = true; // the plain key goes now: from here on only its DPAPI-protected form is on disk
                Log.Write("The saved sign-in is now protected for this Windows account (DPAPI)");
            }
            if (dirty) c.Save();
            return c;
        }

        public static bool ValidId(string id)
        {
            if (id == null || id.Length < 8 || id.Length > 64) return false;
            foreach (char ch in id)
                if (!(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '_' || ch == '-')) return false;
            return true;
        }

        // "ROBIN-DESKTOP" -> "Robin-Desktop"; segments with digits ("DESKTOP-4F2K9") keep their case.
        public static string DefaultName()
        {
            string name = Environment.MachineName ?? "Windows PC";
            var sb = new StringBuilder();
            var word = new StringBuilder();
            Action flush = () =>
            {
                string w = word.ToString();
                bool letters = w.Length > 0 && w.All(char.IsLetter);
                sb.Append(letters ? char.ToUpper(w[0], CultureInfo.CurrentCulture) + w.Substring(1).ToLower(CultureInfo.CurrentCulture) : w);
                word.Clear();
            };
            foreach (char ch in name)
            {
                if (ch == '-' || ch == '_' || ch == ' ' || ch == '.') { flush(); sb.Append(ch == '_' ? '-' : ch); }
                else word.Append(ch);
            }
            flush();
            string result = sb.ToString().Trim();
            if (result.Length > 40) result = result.Substring(0, 40);
            return result.Length == 0 ? "Windows PC" : result;
        }

        public void Save()
        {
            try
            {
                var d = new Dictionary<string, object>(raw);
                d["server"] = Server;
                // The sign-in, DPAPI-protected for this Windows account: a copy of config.json is no use elsewhere.
                d.Remove("key");
                d.Remove("keyProtected");
                if (!string.IsNullOrEmpty(Key))
                {
                    string sealedKey = Dpapi.Protect(Key, Dpapi.ConfigKey);
                    if (sealedKey != null) d["keyProtected"] = sealedKey;
                    else d["key"] = Key; // DPAPI failed: kept as before 1.6 rather than signing out
                }
                if (RotateToken && !string.IsNullOrEmpty(Key)) d["rotateToken"] = true; else d.Remove("rotateToken");
                d.Remove("revokeKeyProtected");
                string sealedOld = string.IsNullOrEmpty(RevokeKey) ? null : Dpapi.Protect(RevokeKey, Dpapi.ConfigKey);
                if (sealedOld != null) d["revokeKeyProtected"] = sealedOld;
                d["serverId"] = ServerId;
                d["autoUpdate"] = AutoUpdate;
                if (RediscoverSec != 600) d["rediscoverSec"] = RediscoverSec;
                d["deviceId"] = DeviceId;
                d["deviceName"] = DeviceName;
                d["autoCopy"] = AutoCopy;
                d["clipboardHistory"] = ClipboardHistory;
                d["openLinks"] = OpenLinks;
                d["autoOpenLinks"] = AutoOpenLinks;
                d["phonePopupText"] = PhonePopupText;
                d["allowRemoteControl"] = AllowRemoteControl;
                if (!string.IsNullOrEmpty(RcBannerSpot)) d["rcBannerSpot"] = RcBannerSpot; else d.Remove("rcBannerSpot");
                if (RcKvmBannerHidden) d["rcKvmBannerHidden"] = true; else d.Remove("rcKvmBannerHidden");
                if (RcKvmTarget) d["rcKvmTarget"] = true; else d.Remove("rcKvmTarget");
                d["kvmOn"] = KvmOn;
                d["kvmPlaces"] = KvmPlaces.Select(p => (object)new Dictionary<string, object> { { "id", p.Id }, { "x", p.X }, { "y", p.Y } }).ToArray();
                d.Remove("kvmLeft");
                if (!string.IsNullOrEmpty(RcDisplayRestore)) d["rcDisplayRestore"] = RcDisplayRestore; else d.Remove("rcDisplayRestore");
                d["installId"] = InstallId;
                d["restoreChecked"] = RestoreChecked;
                d["remoteControlDevices"] = RemoteControlDevices.Select(x => (object)x.ToJson()).ToArray();
                d["autoSave"] = AutoSave;
                d["maxSaveMB"] = MaxSaveMB;
                d["saveFolder"] = SaveFolder;
                d["sendToMenu"] = SendToMenu;
                d["sendToFolder"] = SendToFolder;
                d["outbox"] = Outbox;
                d["outboxFolder"] = OutboxFolder;
                d["lastConversation"] = LastConversation;
                d["lastTargets"] = LastTargets.ToArray();
                d["knownUrls"] = KnownUrls.ToArray();
                if (HeartbeatSec != 70) d["heartbeatSec"] = HeartbeatSec;
                if (Quiet) d["quiet"] = true; else d.Remove("quiet");
                d["badUpdateVersion"] = BadUpdateVersion;
                d["autostartInitialized"] = AutostartInitialized;
                if (RuntimeHintShown) d["runtimeHintShown"] = true;
                if (Math.Abs(Zoom - 1.0) > 0.001) d["zoom"] = Zoom.ToString("0.###", CultureInfo.InvariantCulture); else d.Remove("zoom");
                var hk = new Dictionary<string, object>();
                foreach (var kv in Hotkeys) hk[kv.Key] = kv.Value;
                d["hotkeys"] = hk;
                if (WinW > 0)
                {
                    var w = new Dictionary<string, object>();
                    w["x"] = WinX; w["y"] = WinY; w["w"] = WinW; w["h"] = WinH; w["max"] = WinMax;
                    d["window"] = w;
                }
                if (FamW > 0)
                {
                    var fw = new Dictionary<string, object>();
                    fw["x"] = FamX; fw["y"] = FamY; fw["w"] = FamW; fw["h"] = FamH; fw["max"] = FamMax;
                    d["familyWindow"] = fw;
                }
                raw = d;
                AtomicWrite(FilePath, Json.Pretty(d));
            }
            catch (Exception ex) { Log.Error("Saving config", ex); }
        }

        public static void AtomicWrite(string path, string text)
        {
            string tmp = path + ".tmp";
            using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                var bytes = new UTF8Encoding(false).GetBytes(text);
                fs.Write(bytes, 0, bytes.Length);
                fs.Flush(true);
            }
            if (!File.Exists(path)) { File.Move(tmp, path); return; }
            try { File.Replace(tmp, path, null); }
            catch (IOException)
            {
                File.Copy(tmp, path, true);
                File.Delete(tmp);
            }
        }
    }

    // A transfer that must survive a restart (see App.RestoreTransfers).
    class SavedUpload
    {
        public string LocalId, Path, Name, Mime, UploadId, Origin;
        public long Size, MtimeTicks, Ts;
        public List<string> To = new List<string>();
        public bool DeleteWhenDone, Notify;

        public Dictionary<string, object> ToJson()
        {
            var d = new Dictionary<string, object>();
            d["localId"] = LocalId; d["path"] = Path; d["name"] = Name; d["mime"] = Mime; d["uploadId"] = UploadId;
            d["origin"] = Origin; d["size"] = Size; d["mtime"] = MtimeTicks; d["ts"] = Ts; d["to"] = To.ToArray();
            d["deleteWhenDone"] = DeleteWhenDone; d["notify"] = Notify;
            return d;
        }

        public static SavedUpload From(Dictionary<string, object> d)
        {
            if (d == null) return null;
            var s = new SavedUpload();
            s.LocalId = Json.Str(d, "localId"); s.Path = Json.Str(d, "path"); s.Name = Json.Str(d, "name");
            s.Mime = Json.Str(d, "mime"); s.UploadId = Json.Str(d, "uploadId"); s.Origin = Json.Str(d, "origin");
            s.Size = Json.Long(d, "size", 0); s.MtimeTicks = Json.Long(d, "mtime", 0); s.Ts = Json.Long(d, "ts", 0);
            s.To = Json.StrList(d, "to"); s.DeleteWhenDone = Json.Bool(d, "deleteWhenDone", false); s.Notify = Json.Bool(d, "notify", false);
            return s.Path == null || s.LocalId == null ? null : s;
        }
    }

    class SavedDownload
    {
        public string ItemId, Folder, SaveAs, Then; // Then: null, "open" or "reveal"

        public Dictionary<string, object> ToJson()
        {
            var d = new Dictionary<string, object>();
            d["itemId"] = ItemId; d["folder"] = Folder; d["saveAs"] = SaveAs; d["then"] = Then;
            return d;
        }

        public static SavedDownload From(Dictionary<string, object> d)
        {
            if (d == null || Json.Str(d, "itemId") == null) return null;
            var s = new SavedDownload();
            s.ItemId = Json.Str(d, "itemId"); s.Folder = Json.Str(d, "folder"); s.SaveAs = Json.Str(d, "saveAs"); s.Then = Json.Str(d, "then");
            return s;
        }
    }

    // Which items were already handled (copied/saved/notified), what was read, where files are, and the
    // transfers to resume. Everything here belongs to one server: Reset() when this PC signs in elsewhere.
    class State
    {
        const int MaxHandled = 2000;
        const int MaxPaths = 2000;

        readonly string handledFile;
        readonly string stateFile;
        readonly List<string> handledOrder = new List<string>();
        readonly HashSet<string> handled = new HashSet<string>();
        public bool Initialized;
        public long BaselineTs;
        public string ServerId;   // the server this state belongs to
        public Dictionary<string, long> LastRead = new Dictionary<string, long>();
        public Dictionary<string, string> LocalPaths = new Dictionary<string, string>();
        public Dictionary<string, string> Shortcuts = new Dictionary<string, string>();
        public List<SavedUpload> Uploads = new List<SavedUpload>();
        public List<SavedDownload> Downloads = new List<SavedDownload>();

        public State(string dir)
        {
            handledFile = Path.Combine(dir, "handled.json");
            stateFile = Path.Combine(dir, "state.json");
            try
            {
                if (File.Exists(handledFile))
                {
                    var d = Json.ParseObject(File.ReadAllText(handledFile, Encoding.UTF8));
                    if (d != null)
                    {
                        Initialized = Json.Bool(d, "initialized", true);
                        BaselineTs = Json.Long(d, "baselineTs", 0);
                        ServerId = Json.Str(d, "serverId");
                        foreach (var id in Json.StrList(d, "ids")) if (handled.Add(id)) handledOrder.Add(id);
                    }
                }
            }
            catch (Exception ex) { Log.Error("Reading handled.json", ex); }
            try
            {
                if (File.Exists(stateFile))
                {
                    var d = Json.ParseObject(File.ReadAllText(stateFile, Encoding.UTF8));
                    if (d != null)
                    {
                        LastRead = Json.LongMap(d, "lastRead");
                        var paths = Json.Obj(Json.Get(d, "files"));
                        if (paths != null) foreach (var kv in paths) if (kv.Value is string) LocalPaths[kv.Key] = (string)kv.Value;
                        var sc = Json.Obj(Json.Get(d, "sendTo"));
                        if (sc != null) foreach (var kv in sc) if (kv.Value is string) Shortcuts[kv.Key] = (string)kv.Value;
                        var ups = Json.Get(d, "uploads") as object[];
                        if (ups != null) foreach (var o in ups) { var s = SavedUpload.From(Json.Obj(o)); if (s != null) Uploads.Add(s); }
                        var downs = Json.Get(d, "downloads") as object[];
                        if (downs != null) foreach (var o in downs) { var s = SavedDownload.From(Json.Obj(o)); if (s != null) Downloads.Add(s); }
                    }
                }
            }
            catch (Exception ex) { Log.Error("Reading state.json", ex); }
        }

        public bool IsHandled(string id)
        {
            return handled.Contains(id);
        }

        public void MarkHandled(string id)
        {
            MarkHandled(new[] { id });
        }

        public void MarkHandled(IEnumerable<string> ids)
        {
            bool changed = false;
            foreach (var id in ids)
            {
                if (handled.Add(id)) { handledOrder.Add(id); changed = true; }
            }
            while (handledOrder.Count > MaxHandled)
            {
                handled.Remove(handledOrder[0]);
                handledOrder.RemoveAt(0);
            }
            if (changed) SaveHandled(); // only the first sync sets Initialized (a late callback must not)
        }

        // Signing in to a different Beam (or signing out): its items are new to us, but not "new" to the user.
        public void Reset(string serverId)
        {
            handled.Clear();
            handledOrder.Clear();
            Initialized = false;
            BaselineTs = 0;
            ServerId = serverId;
            LastRead.Clear();
            LocalPaths.Clear();
            Uploads.Clear();
            Downloads.Clear();
            SaveHandled();
            Save();
        }

        public void SaveHandled()
        {
            try
            {
                var d = new Dictionary<string, object>();
                d["initialized"] = Initialized;
                d["baselineTs"] = BaselineTs;
                d["serverId"] = ServerId;
                d["ids"] = handledOrder.ToArray();
                Config.AtomicWrite(handledFile, Json.Stringify(d));
            }
            catch (Exception ex) { Log.Error("Saving handled.json", ex); }
        }

        public string LocalPath(string itemId)
        {
            string p;
            return itemId != null && LocalPaths.TryGetValue(itemId, out p) ? p : null;
        }

        public void SetLocalPath(string itemId, string path)
        {
            if (path == null) LocalPaths.Remove(itemId);
            else LocalPaths[itemId] = path;
            if (LocalPaths.Count > MaxPaths)
            {
                foreach (var k in LocalPaths.Keys.Take(LocalPaths.Count - MaxPaths).ToList()) LocalPaths.Remove(k);
            }
            Save();
        }

        public long GetLastRead(string conv)
        {
            long v;
            return LastRead.TryGetValue(conv, out v) ? v : 0;
        }

        public bool SetLastRead(string conv, long ts)
        {
            if (ts <= GetLastRead(conv)) return false;
            LastRead[conv] = ts;
            Save();
            return true;
        }

        public void Save()
        {
            try
            {
                var d = new Dictionary<string, object>();
                var lr = new Dictionary<string, object>();
                foreach (var kv in LastRead) lr[kv.Key] = kv.Value;
                var files = new Dictionary<string, object>();
                foreach (var kv in LocalPaths) files[kv.Key] = kv.Value;
                var sc = new Dictionary<string, object>();
                foreach (var kv in Shortcuts) sc[kv.Key] = kv.Value;
                d["lastRead"] = lr;
                d["files"] = files;
                d["sendTo"] = sc;
                d["uploads"] = Uploads.Select(u => (object)u.ToJson()).ToArray();
                d["downloads"] = Downloads.Select(u => (object)u.ToJson()).ToArray();
                Config.AtomicWrite(stateFile, Json.Stringify(d));
            }
            catch (Exception ex) { Log.Error("Saving state.json", ex); }
        }
    }
}
