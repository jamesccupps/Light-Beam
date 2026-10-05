// The Beam server API (docs/API.md): models, request helpers and the simple endpoints.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Beam
{
    class Device
    {
        public string Id;
        public string Name;
        public string Platform;
        public bool Online;
        public long LastSeen;
        public bool PhoneNotifications;   // Beam 1.5: settings.phoneNotifications (shows the phone's notifications)
        public bool Temporary;            // a session-only sign-in (a borrowed computer's browser)
        public string User;               // "owner"
        public string TailscaleIp, TailscaleName; // the machine the server knows it on (tailscale.ip / .name)
        public bool CanRemoteControl;     // Beam 1.6: can.remoteControl (a PC that allows it, unlocked)

        public static Device Parse(Dictionary<string, object> d)
        {
            if (d == null) return null;
            var dev = new Device();
            dev.Id = Json.Str(d, "id");
            dev.Name = Json.Str(d, "name") ?? "Unknown device";
            dev.Platform = Json.Str(d, "platform") ?? "";
            dev.Online = Json.Bool(d, "online", false);
            dev.LastSeen = Json.Long(d, "lastSeen", 0);
            dev.PhoneNotifications = Json.Bool(Json.Obj(Json.Get(d, "settings")), "phoneNotifications", false);
            dev.Temporary = Json.Bool(d, "temporary", false);
            dev.User = Json.Str(d, "user");
            var ts = Json.Obj(Json.Get(d, "tailscale"));
            dev.TailscaleIp = Json.Str(ts, "ip");
            dev.TailscaleName = Json.Str(ts, "name");
            dev.CanRemoteControl = Json.Bool(Json.Obj(Json.Get(d, "can")), "remoteControl", false);
            return dev.Id == null ? null : dev;
        }

        public static List<Device> ListFrom(object o)
        {
            var list = new List<Device>();
            var arr = o as object[];
            if (arr == null) return list;
            foreach (var x in arr)
            {
                var d = Device.Parse(Json.Obj(x));
                if (d != null) list.Add(d);
            }
            return list;
        }
    }

    // (1.11.1) One answer of GET /api/items: the whole list, or (Delta) what changed since a cursor: the changed and
    // new items, and the ids deleted (some maybe never seen here).
    class ItemsPage
    {
        public List<Item> Items = new List<Item>();
        public List<string> Deleted = new List<string>();
        public string Cursor;
        public bool Delta;
    }

    class Item
    {
        public string Id;
        public string Kind;
        public string Text;
        public bool Truncated;
        public long TextLength;
        public string Name;
        public long Size;
        public string Mime;
        public string From;
        public string DeviceName;
        public List<string> To = new List<string>();
        public Dictionary<string, long> Delivered = new Dictionary<string, long>();
        public long Ts;
        public long Edited; // (1.14 edit) when its words last changed, 0 if never

        public bool IsFile { get { return Kind == "file"; } }
        public bool IsText { get { return Kind == "text"; } }

        public static Item Parse(Dictionary<string, object> d)
        {
            if (d == null) return null;
            var it = new Item();
            it.Id = Json.Str(d, "id");
            it.Kind = Json.Str(d, "kind") ?? "text";
            it.Text = Json.Str(d, "text") ?? "";
            it.Truncated = Json.Bool(d, "truncated", false);
            it.TextLength = Json.Long(d, "textLength", it.Text.Length);
            it.Name = Json.Str(d, "name") ?? "file";
            it.Size = Json.Long(d, "size", 0);
            it.Mime = Json.Str(d, "mime") ?? "";
            it.From = Json.Str(d, "from");
            it.DeviceName = Json.Str(d, "device") ?? "Unknown device";
            it.To = Json.StrList(d, "to");
            it.Delivered = Json.LongMap(d, "delivered");
            it.Ts = Json.Long(d, "ts", 0);
            it.Edited = Json.Long(d, "edited", 0);
            return it.Id == null ? null : it;
        }
    }

    // A pending "sign in with another device" request (docs/API.md, "Signing in a new device").
    class LoginRequest
    {
        public string Id;
        public string Code;
        public string Name;
        public string Platform;
        public string Where;
        public string DeviceId;   // v3: the requesting device's id (so a device ignores its own requests)
        public string Who;        // v3: the Tailscale account/node, when known
        public string Purpose;    // v3: "sign-in" or "move" (asks for a full copy of this Beam)
        public long CreatedAt;
        public long ExpiresAt;
        public DateTime LocalExpiry;

        public static LoginRequest Parse(Dictionary<string, object> d)
        {
            if (d == null || Json.Str(d, "code") == null) return null;
            var r = new LoginRequest();
            r.Id = Json.Str(d, "id");
            r.Code = Json.Str(d, "code");
            r.Name = Json.Str(d, "name") ?? "A new device";
            r.Platform = Json.Str(d, "platform") ?? "";
            r.Where = Json.Str(d, "where") ?? "";
            r.DeviceId = Json.Str(d, "deviceId");
            var ts = Json.Obj(Json.Get(d, "tailscale"));
            r.Who = ts != null ? (Json.Str(ts, "login") ?? Json.Str(ts, "user") ?? Json.Str(ts, "node")) : Json.Str(d, "who");
            r.Purpose = Json.Str(d, "purpose") ?? "sign-in";
            r.CreatedAt = Json.Long(d, "createdAt", 0);
            r.ExpiresAt = Json.Long(d, "expiresAt", 0);
            // Clocks may disagree a little: never less than 30 s (the server's "done" event closes it
            // for real), never more than the request's lifetime.
            long lifetime = r.ExpiresAt > r.CreatedAt ? r.ExpiresAt - r.CreatedAt : 5 * 60 * 1000;
            long remaining = Math.Max(30 * 1000, Math.Min(r.ExpiresAt - Fmt.NowMs(), lifetime));
            r.LocalExpiry = DateTime.Now.AddMilliseconds(remaining);
            return r;
        }
    }

    class ApiException : Exception
    {
        public readonly int Status;
        public readonly Dictionary<string, object> Body;

        public ApiException(int status, string message, Dictionary<string, object> body)
            : base(message)
        {
            Status = status;
            Body = body;
        }
    }

    class Api
    {
        public static readonly HttpClient Http = CreateClient();
        // Sent as X-Beam-Profile (and profile= on /api/events): see Program.Main. Null in tools and tests.
        public static string Profile;
        // Raised (on any thread) when a server answers 410 with "movedTo" (docs/API.md, "When the server moves").
        public static event Action<string> Moved;
        // Raised (on any thread) when the configured server hands out a device token for this PC (X-Beam-Token).
        public static event Action<string> TokenIssued;
        // Raised (on any thread) when the server says it knows this device by another id (X-Beam-You).
        public static event Action<string> YouChanged;
        public readonly string Base;
        public string LastYou;
        readonly string fixedKey;   // for one-off calls to another address; normally the key is read from cfg
        readonly Config cfg;

        static HttpClient CreateClient()
        {
            var handler = new HttpClientHandler();
            handler.UseCookies = false;
            // Beam 1.4 servers gzip JSON (item lists, devices) when asked; files are never compressed.
            handler.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;
            var client = new HttpClient(handler);
            client.Timeout = Timeout.InfiniteTimeSpan;
            return client;
        }

        public Api(Config cfg)
        {
            Base = cfg.Server.TrimEnd('/');
            this.cfg = cfg;
        }

        public Api(string server, string key, Config cfg)
        {
            Base = server.TrimEnd('/');
            fixedKey = key;
            this.cfg = cfg;
        }

        string Key { get { return fixedKey ?? cfg.Key; } }

        // "https://host/?key=KEY" -> ("https://host", "KEY")
        public static bool ParseLink(string link, out string server, out string key)
        {
            server = null;
            key = null;
            if (string.IsNullOrWhiteSpace(link)) return false;
            Uri uri;
            if (!Uri.TryCreate(link.Trim(), UriKind.Absolute, out uri)) return false;
            if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return false;
            string query = uri.Query.TrimStart('?');
            foreach (var part in query.Split('&'))
            {
                int eq = part.IndexOf('=');
                if (eq > 0 && part.Substring(0, eq) == "key")
                {
                    try { key = Uri.UnescapeDataString(part.Substring(eq + 1)).Trim(); }
                    catch { key = part.Substring(eq + 1); }
                }
            }
            if (string.IsNullOrEmpty(key)) return false;
            server = uri.GetLeftPart(UriPartial.Authority);
            return true;
        }

        public HttpRequestMessage Request(HttpMethod method, string path)
        {
            var req = new HttpRequestMessage(method, Base + path);
            req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + Key);
            req.Headers.TryAddWithoutValidation("X-Beam-Device-Id", cfg.DeviceId);
            req.Headers.TryAddWithoutValidation("X-Beam-Device", Uri.EscapeDataString(cfg.DeviceName ?? ""));
            req.Headers.TryAddWithoutValidation("X-Beam-Platform", "windows");
            req.Headers.TryAddWithoutValidation("X-Beam-App-Version", AppVersion.Text);
            if (Profile != null) req.Headers.TryAddWithoutValidation("X-Beam-Profile", Profile);
            if (DeviceKey.Value != null) req.Headers.TryAddWithoutValidation("X-Beam-Device-Key", DeviceKey.Value); // never in a URL or a log
            req.Headers.ExpectContinue = false;
            return req;
        }

        public string EventsPath()
        {
            return "/api/events?device=" + Uri.EscapeDataString(cfg.DeviceId) + "&name=" + Uri.EscapeDataString(cfg.DeviceName ?? "") + "&platform=windows"
                + "&version=" + Uri.EscapeDataString(AppVersion.Text)
                + "&mode=background"
                + (Profile != null ? "&profile=" + Uri.EscapeDataString(Profile) : "");
        }

        // Sends a request with a timeout; timeouts surface as TimeoutException, user cancellation as OperationCanceledException.
        public async Task<HttpResponseMessage> Send(HttpRequestMessage req, int timeoutSec, CancellationToken ct, HttpCompletionOption option)
        {
            var resp = await SendRaw(req, timeoutSec, ct, option).ConfigureAwait(false);
            NoticeToken(resp);
            return resp;
        }

        // The server swaps the master key for a device token of our own (API v3).
        void NoticeToken(HttpResponseMessage resp)
        {
            if (fixedKey != null || cfg == null) return;
            IEnumerable<string> values;
            if (resp.Headers.TryGetValues("X-Beam-You", out values) && Discovery.SameUrl(Base, cfg.Server))
            {
                string you = values.FirstOrDefault();
                var youHandler = YouChanged;
                if (Config.ValidId(you) && you != cfg.DeviceId && youHandler != null)
                {
                    try { youHandler(you); } catch (Exception ex) { Log.Error("You handler", ex); }
                }
            }
            if (!resp.Headers.TryGetValues("X-Beam-Token", out values)) return;
            string token = values.FirstOrDefault();
            if (string.IsNullOrEmpty(token) || token == cfg.Key || !Discovery.SameUrl(Base, cfg.Server)) return;
            var handler = TokenIssued;
            if (handler != null)
            {
                try { handler(token); } catch (Exception ex) { Log.Error("Token handler", ex); }
            }
        }

        public static async Task<HttpResponseMessage> SendRaw(HttpRequestMessage req, int timeoutSec, CancellationToken ct, HttpCompletionOption option)
        {
            using (var cts = CancellationTokenSource.CreateLinkedTokenSource(ct))
            {
                if (timeoutSec > 0) cts.CancelAfter(TimeSpan.FromSeconds(timeoutSec));
                try
                {
                    return await Http.SendAsync(req, option, cts.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    if (ct.IsCancellationRequested) throw;
                    throw new TimeoutException("The server did not answer in time");
                }
            }
        }

        public static async Task<ApiException> ErrorFrom(HttpResponseMessage resp)
        {
            string body = "";
            try { body = await resp.Content.ReadAsStringAsync().ConfigureAwait(false); } catch { }
            var d = Json.ParseObject(body);
            string msg = Json.Str(d, "error");
            if (string.IsNullOrEmpty(msg)) msg = "HTTP " + (int)resp.StatusCode + " " + resp.ReasonPhrase;
            NoticeMoved((int)resp.StatusCode, d);
            return new ApiException((int)resp.StatusCode, msg, d);
        }

        public static void NoticeMoved(int status, Dictionary<string, object> body)
        {
            if (status != 410) return;
            RaiseMoved(Json.Str(body, "movedTo"));
        }

        public static void RaiseMoved(string to)
        {
            var handler = Moved;
            if (!string.IsNullOrEmpty(to) && handler != null)
            {
                try { handler(to); }
                catch (Exception ex) { Log.Error("Moved handler", ex); }
            }
        }

        // ------------------------------------------------------------------ calls that need no key

        // "robin-desktop.tail1234.ts.net" -> "https://robin-desktop.tail1234.ts.net"; "192.168.1.5:8765" -> "http://…".
        public static string NormalizeBase(string input)
        {
            if (string.IsNullOrWhiteSpace(input)) return null;
            string s = input.Trim();
            if (!s.Contains("://"))
            {
                string host = s.Split('/')[0];
                int colon = host.LastIndexOf(':');
                bool port = colon > 0 && colon < host.Length - 1 && host.Substring(colon + 1).All(char.IsDigit) && host.Substring(colon + 1) != "443";
                s = (port ? "http://" : "https://") + s;
            }
            Uri uri;
            if (!Uri.TryCreate(s, UriKind.Absolute, out uri)) return null;
            if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return null;
            if (string.IsNullOrEmpty(uri.Host)) return null;
            return uri.GetLeftPart(UriPartial.Authority);
        }

        // Sign-in calls (login requests, login, autopair): they carry this PC's profile and the app version.
        public static Task<Dictionary<string, object>> Anon(HttpMethod method, string url, object body, int timeoutSec, CancellationToken ct, string loginSecret)
        {
            return AnonCore(method, url, body, timeoutSec, ct, loginSecret, true);
        }

        // identify = false for /api/hello: discovery probes it on addresses that may not be a Beam at all.
        static async Task<Dictionary<string, object>> AnonCore(HttpMethod method, string url, object body, int timeoutSec, CancellationToken ct, string loginSecret, bool identify)
        {
            using (var req = new HttpRequestMessage(method, url))
            {
                req.Headers.TryAddWithoutValidation("X-Beam-Platform", "windows");
                if (identify)
                {
                    req.Headers.TryAddWithoutValidation("X-Beam-App-Version", AppVersion.Text);
                    if (Profile != null) req.Headers.TryAddWithoutValidation("X-Beam-Profile", Profile);
                    if (DeviceKey.Value != null) req.Headers.TryAddWithoutValidation("X-Beam-Device-Key", DeviceKey.Value); // a sign-in binds it
                }
                req.Headers.ExpectContinue = false;
                if (loginSecret != null) req.Headers.TryAddWithoutValidation("X-Beam-Login-Secret", loginSecret);
                if (body != null) req.Content = new StringContent(Json.Stringify(body), Encoding.UTF8, "application/json");
                using (var resp = await SendRaw(req, timeoutSec, ct, HttpCompletionOption.ResponseContentRead).ConfigureAwait(false))
                {
                    if (!resp.IsSuccessStatusCode) throw await ErrorFrom(resp).ConfigureAwait(false);
                    string text = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
                    return Json.ParseObject(text) ?? new Dictionary<string, object>();
                }
            }
        }

        // GET /api/hello: { beam: true, version, serverId, api?, movedTo?, proof? }. Throws if it isn't a Beam server.
        // With a secret, asks the server to prove it knows it (API v3); see VerifyProof.
        public static async Task<Dictionary<string, object>> Hello(string baseUrl, int timeoutSec, CancellationToken ct, string nonce, string secret)
        {
            string url = baseUrl.TrimEnd('/') + "/api/hello";
            if (nonce != null && secret != null) url += "?nonce=" + nonce + "&tid=" + TokenId(secret);
            var d = await AnonCore(HttpMethod.Get, url, null, timeoutSec, ct, null, false).ConfigureAwait(false);
            if (!Json.Bool(d, "beam", false)) throw new ApiException(0, "That address isn't a Beam server", d);
            return d;
        }

        public static Task<Dictionary<string, object>> Hello(string baseUrl, int timeoutSec, CancellationToken ct)
        {
            return Hello(baseUrl, timeoutSec, ct, null, null);
        }

        public static string NewNonce()
        {
            var b = new byte[16];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(b);
            return Hex(b);
        }

        static string Hex(byte[] b)
        {
            var sb = new StringBuilder(b.Length * 2);
            foreach (var x in b) sb.Append(x.ToString("x2"));
            return sb.ToString();
        }

        static byte[] Sha(byte[] b)
        {
            using (var s = SHA256.Create()) return s.ComputeHash(b);
        }

        // tid = first 16 hex of sha256(sha256(secret)); proof = HMAC-SHA256(sha256(secret), serverId + ":" + nonce).
        public static string TokenId(string secret)
        {
            return Hex(Sha(Sha(Encoding.UTF8.GetBytes(secret)))).Substring(0, 16);
        }

        public static string Proof(string secret, string serverId, string nonce)
        {
            using (var h = new HMACSHA256(Sha(Encoding.UTF8.GetBytes(secret))))
                return Hex(h.ComputeHash(Encoding.UTF8.GetBytes(serverId + ":" + nonce)));
        }

        // True when the hello answer comes from our Beam: same serverId, and on API v3 a valid proof of our secret.
        public static bool IsOurServer(Dictionary<string, object> hello, string serverId, string secret, string nonce)
        {
            string id = Json.Str(hello, "serverId");
            if (string.IsNullOrEmpty(serverId) || id != serverId) return false;
            // (audit X-1) The proof always: the id is public (any hello names it), and `api` is whatever the answer says.
            string proof = Json.Str(hello, "proof");
            bool proven = proof != null && secret != null && nonce != null && string.Equals(proof, Proof(secret, serverId, nonce), StringComparison.OrdinalIgnoreCase);
            if (!proven) Log.Write("A server answering with our Beam's id couldn't prove it holds this PC's sign-in; ignored");
            return proven;
        }

        // POST /api/autopair (API v3): signed in by Tailscale identity. Returns { key, server, via } or throws (403 if not allowed).
        public static Task<Dictionary<string, object>> Autopair(string baseUrl, string deviceId, string name, CancellationToken ct)
        {
            var body = new Dictionary<string, object>();
            body["client"] = "app";
            body["deviceId"] = deviceId;
            body["name"] = name;
            body["platform"] = "windows";
            return Anon(HttpMethod.Post, baseUrl.TrimEnd('/') + "/api/autopair", body, 10, ct, null);
        }

        public static async Task WithdrawLogin(string baseUrl, string id, string secret)
        {
            try { await Anon(HttpMethod.Delete, baseUrl.TrimEnd('/') + "/api/login-requests/" + id, null, 8, CancellationToken.None, secret).ConfigureAwait(false); }
            catch (Exception ex) { Log.Write("Withdrawing a sign-in request: " + Describe(ex)); }
        }

        public async Task<object> Call(HttpMethod method, string path, object body, int timeoutSec, CancellationToken ct)
        {
            using (var req = Request(method, path))
            {
                if (body != null)
                    req.Content = new StringContent(Json.Stringify(body), Encoding.UTF8, "application/json");
                using (var resp = await Send(req, timeoutSec, ct, HttpCompletionOption.ResponseContentRead).ConfigureAwait(false))
                {
                    if (!resp.IsSuccessStatusCode) throw await ErrorFrom(resp).ConfigureAwait(false);
                    if (resp.StatusCode == HttpStatusCode.NoContent) return null;
                    string text = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
                    var type = resp.Content.Headers.ContentType;
                    if (type != null && type.MediaType == "application/json") return Json.Parse(text);
                    return text;
                }
            }
        }

        public Task<object> Call(HttpMethod method, string path)
        {
            return Call(method, path, null, 30, CancellationToken.None);
        }

        // GET /api/me: { ok, you, read? } (read markers are API v3).
        public async Task<Dictionary<string, object>> Me()
        {
            var d = Json.Obj(await Call(HttpMethod.Get, "/api/me").ConfigureAwait(false));
            LastYou = Json.Str(d, "you") ?? LastYou;
            return d;
        }

        public async Task<List<Device>> Devices()
        {
            var d = Json.Obj(await Call(HttpMethod.Get, "/api/devices").ConfigureAwait(false));
            LastYou = Json.Str(d, "you");
            return Device.ListFrom(Json.Get(d, "devices"));
        }

        // Beam 1.5: a device's server-side settings, e.g. { phoneNotifications: true } ("me" = this PC). 204 + `devices`.
        public Task<object> SetDeviceSettings(string device, Dictionary<string, object> settings)
        {
            return Call(HttpMethod.Put, "/api/devices/" + Uri.EscapeDataString(device) + "/settings", settings, 30, CancellationToken.None);
        }

        // ------------------------------------------------------------------ signing in other devices

        public async Task<List<LoginRequest>> PendingLogins()
        {
            var d = Json.Obj(await Call(HttpMethod.Get, "/api/login-requests").ConfigureAwait(false));
            var list = new List<LoginRequest>();
            var arr = Json.Get(d, "requests") as object[];
            if (arr != null)
                foreach (var o in arr)
                {
                    var r = LoginRequest.Parse(Json.Obj(o));
                    if (r != null) list.Add(r);
                }
            return list;
        }

        public async Task<LoginRequest> FindLogin(string code)
        {
            return LoginRequest.Parse(Json.Obj(await Call(HttpMethod.Get, "/api/login-requests?code=" + Uri.EscapeDataString(code)).ConfigureAwait(false)));
        }

        public async Task AnswerLogin(string code, bool approve)
        {
            var body = new Dictionary<string, object>();
            body["code"] = code;
            await Call(HttpMethod.Post, "/api/login-requests/" + (approve ? "approve" : "deny"), body, 30, CancellationToken.None).ConfigureAwait(false);
        }

        public async Task<Dictionary<string, object>> Info()
        {
            return Json.Obj(await Call(HttpMethod.Get, "/api/info").ConfigureAwait(false));
        }

        // Sets (8+ characters), changes or, with "", removes the sign-in password. Returns passwordSet.
        public async Task<bool> SetPassword(string password)
        {
            var body = new Dictionary<string, object>();
            body["password"] = password;
            var d = Json.Obj(await Call(HttpMethod.Post, "/api/password", body, 30, CancellationToken.None).ConfigureAwait(false));
            return Json.Bool(d, "passwordSet", password.Length > 0);
        }

        // GET /api/items; (1.11.1) with `since` (a cursor from an earlier answer, Beam 1.4 `items-since`) only what
        // changed since then, unless the server can't tell (then the whole list, Delta false).
        public async Task<ItemsPage> ItemsSince(string since)
        {
            string path = since == null ? "/api/items" : "/api/items?since=" + Uri.EscapeDataString(since);
            var d = Json.Obj(await Call(HttpMethod.Get, path, null, 60, CancellationToken.None).ConfigureAwait(false));
            var page = new ItemsPage();
            page.Delta = since != null && Json.Bool(d, "delta", false);
            page.Cursor = Json.Str(d, "cursor");
            page.Deleted = Json.StrList(d, "deleted");
            var arr = Json.Get(d, "items") as object[];
            if (arr != null)
                foreach (var o in arr)
                {
                    var it = Item.Parse(Json.Obj(o));
                    if (it != null) page.Items.Add(it);
                }
            return page;
        }

        // GET /api/pair: a single-use pairing key (15 minutes), to open Beam in this PC's browser signed in (audit S-1).
        public async Task<string> PairKey()
        {
            return Json.Str(Json.Obj(await Call(HttpMethod.Get, "/api/pair").ConfigureAwait(false)), "key");
        }

        public async Task<Item> GetItem(string id)
        {
            return Item.Parse(Json.Obj(await Call(HttpMethod.Get, "/api/items/" + id).ConfigureAwait(false)));
        }

        public async Task<string> FullText(string id)
        {
            return (await Call(HttpMethod.Get, "/api/items/" + id + "/text").ConfigureAwait(false)) as string;
        }

        // GET /api/file/{id}: a small file's bytes in memory (an image to copy). Throws ApiException 413 past max bytes.
        public async Task<byte[]> FileBytes(string id, long max)
        {
            using (var req = Request(HttpMethod.Get, "/api/file/" + Uri.EscapeDataString(id) + "?inline"))
            using (var resp = await Send(req, 120, CancellationToken.None, HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false))
            {
                if (!resp.IsSuccessStatusCode) throw await ErrorFrom(resp).ConfigureAwait(false);
                long? length = resp.Content.Headers.ContentLength;
                if (length.HasValue && length.Value > max) throw new ApiException(413, "That file is too big", null);
                using (var body = await resp.Content.ReadAsStreamAsync().ConfigureAwait(false))
                using (var ms = new System.IO.MemoryStream(length.HasValue ? (int)length.Value : 1 << 20))
                {
                    var buf = new byte[81920];
                    int n;
                    while ((n = await body.ReadAsync(buf, 0, buf.Length).ConfigureAwait(false)) > 0)
                    {
                        if (ms.Length + n > max) throw new ApiException(413, "That file is too big", null);
                        ms.Write(buf, 0, n);
                    }
                    return ms.ToArray();
                }
            }
        }

        public async Task<Item> SendText(string text, List<string> to)
        {
            var body = new Dictionary<string, object>();
            body["text"] = text;
            body["to"] = to.ToArray();
            return Item.Parse(Json.Obj(await Call(HttpMethod.Post, "/api/text", body, 60, CancellationToken.None).ConfigureAwait(false)));
        }

        // PUT /api/items/{id}/thumb (v3): a JPEG preview for an image we sent.
        public async Task PutThumb(string id, byte[] jpeg)
        {
            using (var req = Request(HttpMethod.Put, "/api/items/" + id + "/thumb"))
            {
                req.Content = new ByteArrayContent(jpeg);
                req.Content.Headers.ContentType = new MediaTypeHeaderValue("image/jpeg");
                using (var resp = await Send(req, 60, CancellationToken.None, HttpCompletionOption.ResponseContentRead).ConfigureAwait(false))
                    if (!resp.IsSuccessStatusCode) throw await ErrorFrom(resp).ConfigureAwait(false);
            }
        }

        // POST /api/logout: revokes this device's token (v3) when signing out.
        public async Task Logout()
        {
            using (var req = Request(HttpMethod.Post, "/api/logout"))
            using (await Send(req, 15, CancellationToken.None, HttpCompletionOption.ResponseContentRead).ConfigureAwait(false)) { }
        }

        public async Task<Dictionary<string, long>> Ack(string id)
        {
            var d = Json.Obj(await Call(HttpMethod.Post, "/api/items/" + id + "/ack").ConfigureAwait(false));
            return Json.LongMap(d, "delivered");
        }

        public static string Describe(Exception ex)
        {
            var agg = ex as AggregateException;
            if (agg != null && agg.InnerException != null) ex = agg.InnerException;
            if (ex is ApiException) return ex.Message;
            if (ex is TimeoutException) return "the server did not answer in time";
            if (ex is HttpRequestException)
            {
                var we = WebError(ex);
                if (we != null)
                {
                    switch (we.Status)
                    {
                        case WebExceptionStatus.NameResolutionFailure: return "the server's name could not be found";
                        case WebExceptionStatus.ConnectFailure: return "could not connect to the server";
                        case WebExceptionStatus.TrustFailure:
                        case WebExceptionStatus.SecureChannelFailure: return "secure connection failed";
                    }
                    return we.Message;
                }
                var inner = ex.InnerException;
                return inner != null ? inner.Message : ex.Message;
            }
            return ex.Message;
        }

        static WebException WebError(Exception ex)
        {
            for (var e = ex; e != null; e = e.InnerException)
            {
                var we = e as WebException;
                if (we != null) return we;
            }
            return null;
        }

        // "Nobody is there" (connection refused, name unknown) rather than "slow": worth looking elsewhere at once.
        public static bool IsUnreachable(Exception ex)
        {
            var agg = ex as AggregateException;
            if (agg != null && agg.InnerException != null) ex = agg.InnerException;
            var we = WebError(ex);
            return we != null && (we.Status == WebExceptionStatus.ConnectFailure || we.Status == WebExceptionStatus.NameResolutionFailure);
        }
    }
}
