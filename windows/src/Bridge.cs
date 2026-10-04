// The host side of docs/HOST-BRIDGE.md: messages from the web page (already origin-checked by WebWindow)
// are turned into native actions, and replies/events are sent back as JSON.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Beam
{
    class Bridge
    {
        public const int Version = 1;
        public static readonly string[] Features = { "transfers", "localFiles", "settings", "clipboard", "pickFiles", "pickFolder", "dragOut", "dragOutDone", "openPanel", "remoteDesktop", "phoneNotifications", "remoteControl", "restoreSettings", "copyFiles", "dragOutMany" };

        // Several files at once (copyFiles, dragOut with itemIds; Beam 1.12): more than this is a mistake, not a selection.
        const int MaxFilesAtOnce = 1000;

        readonly App app;
        readonly WebWindow win;

        public Bridge(App app, WebWindow win)
        {
            this.app = app;
            this.win = win;
        }

        void Reply(object id, object result)
        {
            if (id == null) return;
            var d = new Dictionary<string, object>();
            d["type"] = "reply";
            d["id"] = id;
            d["ok"] = true;
            d["result"] = result ?? new Dictionary<string, object>();
            Send(d);
        }

        // Replies to a test's messages (--test-bridge, ids "test-…") are logged too.
        void Send(Dictionary<string, object> d)
        {
            string json = Json.Stringify(d);
            var tid = d["id"] as string;
            if (tid != null && tid.StartsWith("test-") && app.Cfg.CustomPath) Log.Write("Bridge test reply: " + json);
            win.Post(json);
        }

        void Fail(object id, string code, string error)
        {
            if (id == null) return;
            var d = new Dictionary<string, object>();
            d["type"] = "reply";
            d["id"] = id;
            d["ok"] = false;
            d["code"] = code;
            d["error"] = error;
            Send(d);
        }

        static Dictionary<string, object> Obj(string key, object value)
        {
            var d = new Dictionary<string, object>();
            d[key] = value;
            return d;
        }

        // `to`: device ids, [] = every device.
        static List<string> Targets(Dictionary<string, object> m)
        {
            var to = Json.StrList(m, "to").Where(t => t != "all" && t != "*").ToList();
            return to.Where(Config.ValidId).ToList();
        }

        public void Handle(string json, List<string> files)
        {
            var m = Json.ParseObject(json);
            if (m == null) return;
            string type = Json.Str(m, "type") ?? "";
            object id = Json.Get(m, "id");
            try
            {
                Dispatch(type, id, m, files);
            }
            catch (Exception ex)
            {
                Log.Error("Bridge " + type, ex);
                Fail(id, "error", ex.Message);
            }
        }

        void Dispatch(string type, object id, Dictionary<string, object> m, List<string> files)
        {
            string itemId = Json.Str(m, "itemId");
            switch (type)
            {
                case "hello":
                    win.OnHello();
                    Reply(id, HelloState());
                    win.AfterHello();
                    break;
                case "sendFiles":
                    if (files.Count == 0) { Fail(id, "bad-request", "No files arrived. Drop files from Explorer, or use the paperclip."); break; }
                    Reply(id, Obj("count", app.SendFiles(files, Targets(m), false, "page", null)));
                    break;
                case "pickFiles":
                    PickFiles(id, Targets(m));
                    break;
                case "pickFolder":
                    PickFolder(id, Targets(m));
                    break;
                case "sendClipboard":
                {
                    var p = app.ReadClipboard();
                    if (p.Empty) { Fail(id, "empty", "The clipboard is empty"); break; }
                    app.SendPayload(p, Targets(m));
                    var r = new Dictionary<string, object>();
                    r["kind"] = p.Kind;
                    r["description"] = p.Describe();
                    Reply(id, r);
                    break;
                }
                case "saveFile":
                {
                    string err = app.SaveItemById(itemId, null, null);
                    if (err != null) Fail(id, err, "That file isn't on the server any more"); else Reply(id, null);
                    break;
                }
                case "saveFileAs":
                    SaveAs(id, itemId);
                    break;
                case "openFile":
                case "revealFile":
                {
                    string err = app.OpenItemFile(itemId, type == "openFile" ? "open" : "reveal");
                    if (err != null) Fail(id, err, "That file isn't on the server any more"); else Reply(id, null);
                    break;
                }
                case "cancelTransfer":
                case "retryTransfer":
                case "dismissTransfer":
                {
                    string action = type.Substring(0, type.Length - "Transfer".Length);
                    if (app.TransferAction(Json.Str(m, "transferId"), action)) Reply(id, null);
                    else Fail(id, "not-found", "That transfer is gone");
                    break;
                }
                case "copyText":
                    CopyText(id, itemId, Json.Str(m, "text"));
                    break;
                case "copyImage":
                    CopyImage(id, itemId, Json.Str(m, "png"));
                    break;
                case "remoteDesktop":
                {
                    string host = RemoteHost(Json.Str(m, "host"));
                    if (host == null) { Fail(id, "bad-request", "That isn't a computer name or address"); break; }
                    string err = app.StartRemoteDesktop(host);
                    if (err != null) Fail(id, "failed", err);
                    else Reply(id, null);
                    break;
                }
                case "openLink":
                {
                    string url = Json.Str(m, "url");
                    Uri u;
                    if (!Uri.TryCreate(url ?? "", UriKind.Absolute, out u) || (u.Scheme != Uri.UriSchemeHttp && u.Scheme != Uri.UriSchemeHttps && u.Scheme != Uri.UriSchemeMailto))
                    { Fail(id, "bad-request", "Only web and mail links can be opened"); break; }
                    FileUtil.OpenUrl(url);
                    Reply(id, null);
                    break;
                }
                case "dragOut":
                {
                    // One file (itemId), or several picked together (itemIds, Beam 1.12): all of them in one drag.
                    var several = Json.StrList(m, "itemIds").Distinct().ToList();
                    if (several.Count > MaxFilesAtOnce) { Fail(id, "bad-request", "Too many files at once"); break; }
                    string r = several.Count > 0 ? win.DragOut(several) : win.DragOut(itemId);
                    if (r == null) Reply(id, null);
                    else if (r == "copied") Reply(id, Obj("copied", true)); // (this PC is being controlled: no drag, 1.7.1)
                    else Fail(id, r, r == "clipboard" ? "Couldn't copy it" : several.Count > 1 ? "Save them first" : "Save the file first");
                    break;
                }
                case "copyFiles":
                    CopyFiles(id, Json.StrList(m, "itemIds").Distinct().ToList(), Json.Long(m, "clipSeq", -1));
                    break;
                case "read":
                    app.MarkRead(App.FromPageConv(Json.Str(m, "conversation")), Json.Long(m, "ts", 0));
                    Reply(id, null);
                    break;
                case "viewing":
                    win.SetViewing(Json.Str(m, "conversation"), Json.Bool(m, "visible", true));
                    Reply(id, null);
                    break;
                case "getSettings":
                    Reply(id, Obj("settings", app.SettingsObject()));
                    break;
                case "setSettings":
                {
                    string err = app.ApplySettings(Json.Obj(Json.Get(m, "settings")));
                    // Remote control is turned on (and its devices chosen) only at this PC: never from the page.
                    if (err == RemoteControl.OnlyHere) Fail(id, "native-only", err);
                    else if (err != null) Fail(id, "bad-request", err); else Reply(id, Obj("settings", app.SettingsObject()));
                    break;
                }
                case "restoreSettings": // Beam 1.8.1: the native choice of backups (SettingsBackups)
                    app.Backups.ShowChoices();
                    Reply(id, null);
                    break;
                case "openRemote": // Beam 1.6: "Control" opens a viewer window of its own
                {
                    string err = app.OpenRemote(Json.Str(m, "device"));
                    if (err != null) Fail(id, "bad-request", err); else Reply(id, null);
                    break;
                }
                case "browseFolder":
                {
                    string setting = Json.Str(m, "setting");
                    if (setting != "saveFolder" && setting != "outboxFolder") { Fail(id, "bad-request", "Unknown folder"); break; }
                    string path = app.BrowseFolder(setting, win);
                    if (path == null) Fail(id, "cancelled", "Cancelled"); else Reply(id, Obj("path", path));
                    break;
                }
                case "openFolder":
                    app.OpenFolderOf(Json.Str(m, "which"));
                    Reply(id, null);
                    break;
                case "checkForUpdates":
                    app.CheckForUpdates(true, msg => Reply(id, Obj("update", UpdateObject())));
                    break;
                case "installUpdate":
                    app.InstallUpdateNow();
                    Reply(id, null);
                    break;
                case "signInAgain":
                    Reply(id, null);
                    app.SignInAgain();
                    break;
                case "switchServer":
                    Reply(id, null);
                    app.SwitchServerDialog();
                    break;
                case "unpair":
                    Reply(id, null);
                    app.Post(() => app.Unpair());
                    break;
                case "unauthorized":
                    app.OnPageUnauthorized();
                    break;
                case "moved":
                    app.PageMoved(Json.Str(m, "movedTo"));
                    break;
                case "log":
                {
                    string msg = Json.Str(m, "message") ?? "";
                    if (msg.Length > 300) msg = msg.Substring(0, 300);
                    Log.Write("Page " + (Json.Str(m, "level") == "error" ? "error" : "info") + ": " + msg);
                    break;
                }
                default:
                    Fail(id, "unknown-type", "Unknown message: " + type);
                    break;
            }
        }

        void PickFiles(object id, List<string> to)
        {
            using (var dlg = new OpenFileDialog())
            {
                dlg.Multiselect = true;
                dlg.Title = "Send files with Beam";
                if (dlg.ShowDialog(win) != DialogResult.OK || dlg.FileNames.Length == 0) { Reply(id, Obj("count", 0)); return; }
                Reply(id, Obj("count", app.SendFiles(dlg.FileNames, to, false, "page", null)));
            }
        }

        void PickFolder(object id, List<string> to)
        {
            using (var dlg = new FolderBrowserDialog())
            {
                dlg.Description = "Choose a folder to send (it's sent as a .zip)";
                dlg.ShowNewFolderButton = false;
                if (dlg.ShowDialog(win) != DialogResult.OK) { Reply(id, Obj("count", 0)); return; }
                Reply(id, Obj("count", app.SendFiles(new[] { dlg.SelectedPath }, to, false, "page", null)));
            }
        }

        void SaveAs(object id, string itemId)
        {
            var it = app.ItemById(itemId);
            if (it == null || !it.IsFile) { Fail(id, "not-found", "That file isn't on the server any more"); return; }
            using (var dlg = new SaveFileDialog())
            {
                dlg.FileName = FileUtil.SafeName(it.Name);
                dlg.InitialDirectory = app.Cfg.SaveFolderPath;
                dlg.OverwritePrompt = true;
                dlg.Title = "Save " + it.Name;
                if (dlg.ShowDialog(win) != DialogResult.OK) { Fail(id, "cancelled", "Cancelled"); return; }
                app.SaveItemById(itemId, null, dlg.FileName);
                Reply(id, null);
            }
        }

        async void CopyText(object id, string itemId, string text)
        {
            bool ok = await app.CopyItemText(itemId, text);
            if (ok) Reply(id, null); else Fail(id, "not-found", "Couldn't copy that text");
        }

        // Copy image (1.6.2): the item's picture, or `png` (base64) from the page for a type Windows can't read.
        async void CopyImage(object id, string itemId, string png)
        {
            byte[] bytes = null;
            if (png != null)
            {
                if (png.Length > App.MaxCopyImageBytes / 3 * 4 + 4) { Fail(id, "too-big", "That image is too big to copy"); return; }
                try { bytes = Convert.FromBase64String(png); }
                catch (FormatException) { Fail(id, "bad-request", "That isn't an image"); return; }
            }
            string err = await app.CopyItemImage(itemId, bytes);
            if (err == null) Reply(id, null);
            else Fail(id, err, err == "too-big" ? "That image is too big to copy"
                : err == "unsupported" ? "Windows can't read that kind of image"
                : err == "not-found" ? "That image isn't on the server any more" : "Couldn't copy the image");
        }

        // Copy several files (Beam 1.12): the saved files go onto the clipboard together, as Explorer's Copy puts them. If any
        // isn't on this PC yet nothing is copied: the reply names those ("missing") with the clipboard's sequence number;
        // the page saves them and asks again with `clipSeq`, and hears "clipboard-changed" if something else was copied
        // meanwhile (what the user copied while waiting stays where it is).
        void CopyFiles(object id, List<string> itemIds, long clipSeq)
        {
            if (itemIds.Count == 0 || itemIds.Count > MaxFilesAtOnce) { Fail(id, "bad-request", itemIds.Count == 0 ? "No files to copy" : "Too many files at once"); return; }
            var paths = new List<string>();
            var missing = new List<object>();
            foreach (string itemId in itemIds)
            {
                var it = app.ItemById(itemId);
                if (it == null || !it.IsFile) { Fail(id, "not-found", "One of those files isn't on the server any more"); return; }
                string path = app.LocalFile(itemId);
                if (path == null) missing.Add(itemId); else paths.Add(path);
            }
            if (missing.Count > 0)
            {
                var r = new Dictionary<string, object>();
                r["missing"] = missing.ToArray();
                r["clipSeq"] = (long)ClipPayload.Sequence();
                Reply(id, r);
                return;
            }
            if (clipSeq >= 0 && clipSeq != (long)ClipPayload.Sequence()) { Fail(id, "clipboard-changed", "Something else was copied meanwhile"); return; }
            if (!ClipPayload.SetFiles(paths)) { Fail(id, "clipboard", "Couldn't copy them"); return; }
            Log.Write("Copied " + (paths.Count == 1 ? "a file" : paths.Count + " files") + " to the clipboard from the chat");
            Reply(id, Obj("copied", paths.Count));
        }

        // A computer name for mstsc /v: a DNS name (letters, digits, hyphens, dots) or an IPv4/IPv6 address; else null.
        // Nothing else reaches the command line.
        public static string RemoteHost(string host)
        {
            if (host == null) return null;
            host = host.Trim();
            if (host.EndsWith(".")) host = host.Substring(0, host.Length - 1);
            if (host.Length == 0 || host.Length > 253) return null;
            System.Net.IPAddress ip;
            if (host.Contains(":"))
            {
                string bare = host.Trim('[', ']');
                if (System.Net.IPAddress.TryParse(bare, out ip) && ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6) return bare;
                return null;
            }
            if (System.Text.RegularExpressions.Regex.IsMatch(host, @"^\d{1,3}(\.\d{1,3}){3}$"))
                return System.Net.IPAddress.TryParse(host, out ip) ? host : null;
            foreach (string label in host.Split('.'))
                if (!System.Text.RegularExpressions.Regex.IsMatch(label, @"^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")) return null;
            return host;
        }

        Dictionary<string, object> HelloState()
        {
            var d = new Dictionary<string, object>();
            d["app"] = "windows";
            d["version"] = AppVersion.Text;
            d["deviceId"] = app.Cfg.DeviceId;
            d["deviceName"] = app.Cfg.DeviceName;
            d["settings"] = app.SettingsObject();
            d["update"] = UpdateObject();
            d["conn"] = ConnObject();
            var transfers = new List<object>();
            foreach (var u in app.Uploads) transfers.Add(TransferObject(u));
            foreach (var j in app.Downloads.Values) transfers.Add(TransferObject(j));
            d["transfers"] = transfers.ToArray();
            d["localFiles"] = app.LocalFiles();
            return d;
        }

        public Dictionary<string, object> UpdateObject()
        {
            var d = new Dictionary<string, object>();
            d["state"] = app.UpdateState;
            d["version"] = app.UpdateVersion;
            d["error"] = app.UpdateError;
            d["current"] = AppVersion.Text;
            return d;
        }

        public Dictionary<string, object> ConnObject()
        {
            var d = new Dictionary<string, object>();
            d["state"] = app.Conn == Conn.Online ? "online" : app.Conn == Conn.Unauthorized ? "unauthorized" : app.Conn == Conn.Connecting ? "connecting" : "offline";
            d["text"] = app.ConnText;
            return d;
        }

        static string StateName(JobState s)
        {
            switch (s)
            {
                case JobState.Queued: return "queued";
                case JobState.Preparing: return "queued";
                case JobState.Running: return "running";
                case JobState.Retrying: return "retrying";
                case JobState.Done: return "done";
                case JobState.Failed: return "failed";
                case JobState.Cancelled: return "cancelled";
                default: return "failed";
            }
        }

        public Dictionary<string, object> TransferObject(Job job)
        {
            var d = new Dictionary<string, object>();
            d["id"] = job.TransferId;
            var s = job.State;
            d["state"] = StateName(s);
            d["size"] = job.Size;
            d["done"] = job.Done;
            d["rate"] = (long)job.Rate;
            d["eta"] = job.EtaSeconds;
            d["status"] = s == JobState.Failed ? (job.Error ?? "Failed") : s == JobState.Gone ? (job.Error ?? "Deleted") : job.Status;
            d["canCancel"] = job.Active;
            d["canRetry"] = s == JobState.Failed;
            var u = job as UploadJob;
            if (u != null)
            {
                d["kind"] = "upload";
                d["name"] = u.Name;
                d["itemId"] = u.Result != null ? u.Result.Id : null;
                d["conversations"] = u.To.Count == 0 ? new object[] { "all" } : u.To.Cast<object>().ToArray();
                d["to"] = u.To.ToArray();
                d["auto"] = false;
                return d;
            }
            var dl = (DownloadJob)job;
            d["kind"] = "download";
            d["name"] = dl.Item.Name;
            d["itemId"] = dl.Item.Id;
            d["conversations"] = app.ConvsOf(dl.Item).Select(c => (object)App.ToPageConv(c)).ToArray();
            d["auto"] = dl.Auto;
            return d;
        }
    }
}
