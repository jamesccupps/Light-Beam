// Live updates: a Server-Sent Events connection to /api/events that survives sleep, network
// changes and silent drops (heartbeat watchdog), reconnecting with backoff.
using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Beam
{
    class EventStream
    {
        readonly Api api;
        readonly int defaultDeadMs;           // no data for this long = a dead connection (until the server says its ping)
        int deadMs;
        public volatile string StreamId;      // Beam 1.4: this stream's id (hello.stream), for pokes
        public Action Connected;              // background thread
        public Action<string> Disconnected;   // background thread, with a reason
        public Action<string, string> Received; // background thread: event name, data

        CancellationTokenSource stop;
        HttpResponseMessage current;
        readonly Stopwatch sinceActivity = new Stopwatch();
        Timer watchdog;
        readonly SemaphoreSlim wake = new SemaphoreSlim(0);
        readonly object sync = new object();
        public volatile int NextRetrySeconds;
        public volatile bool Unauthorized;
        public volatile string UnauthorizedServerId; // Beam 1.4 servers name themselves in their 401s
        public volatile bool KeyRejected;     // Beam 1.6: 403 device-key, this install's key isn't the one the device has
        public volatile bool Unreachable;     // the last failure was "nobody there", not "slow"

        public EventStream(Api api, int heartbeatSec)
        {
            this.api = api;
            defaultDeadMs = deadMs = heartbeatSec * 1000;
        }

        public void Start()
        {
            stop = new CancellationTokenSource();
            var token = stop.Token;
            watchdog = new Timer(Check, null, 10000, 10000); // the limit is minutes; no need to look more often
            Task.Run(() => Loop(token));
        }

        public void Stop()
        {
            if (stop == null) return;
            stop.Cancel();
            if (watchdog != null) watchdog.Dispose();
            DropConnection();
            wake.Release();
        }

        // The server's hello (Beam 1.4): the stream id and its heartbeat. Silence longer than two heartbeats and a
        // bit is a dead connection.
        public void SetStream(string id, int pingSec)
        {
            StreamId = id;
            Volatile.Write(ref deadMs, pingSec > 0 ? (2 * pingSec + 20) * 1000 : defaultDeadMs);
        }

        // Reconnect now (after resume from sleep, network change, or a rename).
        public void Kick()
        {
            DropConnection();
            wake.Release();
        }

        void DropConnection()
        {
            HttpResponseMessage resp;
            lock (sync) { resp = current; current = null; }
            if (resp != null)
            {
                try { resp.Dispose(); } catch { }
            }
        }

        void Check(object state)
        {
            bool dead;
            int limit = Volatile.Read(ref deadMs);
            lock (sync) dead = current != null && sinceActivity.ElapsedMilliseconds > limit;
            if (dead)
            {
                Log.Write("Events: nothing received for " + (limit / 1000) + " s, reconnecting");
                DropConnection();
            }
        }

        async Task Loop(CancellationToken token)
        {
            int backoff = 1000, unauthorizedInARow = 0;
            while (!token.IsCancellationRequested)
            {
                bool opened = false;
                var started = Stopwatch.StartNew();
                string reason = "connection closed";
                HttpResponseMessage resp = null;
                StreamId = null;
                Volatile.Write(ref deadMs, defaultDeadMs);
                try
                {
                    using (var req = api.Request(HttpMethod.Get, api.EventsPath()))
                    {
                        req.Headers.TryAddWithoutValidation("Accept", "text/event-stream");
                        resp = await api.Send(req, 30, token, HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false);
                    }
                    if (!resp.IsSuccessStatusCode)
                    {
                        var err = await Api.ErrorFrom(resp).ConfigureAwait(false);
                        bool keyRejected = err.Status == 403 && Json.Str(err.Body, "reason") == "device-key";
                        Unauthorized = err.Status == 401 || keyRejected; // handled as a revoked sign-in
                        KeyRejected = keyRejected;
                        UnauthorizedServerId = Unauthorized ? Json.Str(err.Body, "serverId") : null;
                        throw err;
                    }
                    Unauthorized = false;
                    KeyRejected = false;
                    Unreachable = false;
                    var stream = await resp.Content.ReadAsStreamAsync().ConfigureAwait(false);
                    lock (sync)
                    {
                        current = resp;
                        sinceActivity.Restart();
                    }
                    opened = true;
                    Log.Write("Events: connected");
                    if (Connected != null) Connected();
                    await Read(stream, token).ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    reason = Api.Describe(ex);
                    if (!opened) Unreachable = Api.IsUnreachable(ex);
                    if (!token.IsCancellationRequested) Log.Write("Events: " + (opened ? "dropped: " : "connect failed: ") + reason);
                }
                finally
                {
                    lock (sync) { if (current == resp) current = null; }
                    if (resp != null) { try { resp.Dispose(); } catch { } }
                }
                if (token.IsCancellationRequested) break;
                if (opened && started.Elapsed.TotalSeconds > 20) backoff = 1000;
                // A revoked sign-in doesn't come back by retrying: after a second 401 in a row, only look again every
                // 5 minutes (or when kicked, e.g. "Retry"). Signing in again starts a new stream at once. Hammering
                // would also count as failed sign-ins and could lock this PC's address out of the server.
                unauthorizedInARow = Unauthorized ? unauthorizedInARow + 1 : 0;
                int wait = unauthorizedInARow >= 2 ? 5 * 60 * 1000 : backoff;
                NextRetrySeconds = wait / 1000;
                if (Disconnected != null) Disconnected(reason);
                // Wait for the backoff delay, or until kicked.
                while (wake.CurrentCount > 0) wake.Wait(0);
                try { await wake.WaitAsync(wait, token).ConfigureAwait(false); }
                catch (OperationCanceledException) { break; }
                backoff = Math.Min(backoff * 2, 30000);
            }
        }

        const int MaxEventChars = 1 << 20; // the server's own events stay far below this

        async Task Read(Stream stream, CancellationToken token)
        {
            using (var reader = new StreamReader(stream, new UTF8Encoding(false)))
            {
                string evName = null;
                var data = new StringBuilder();
                bool tooBig = false; // (audit X-4) an event over MaxEventChars is dropped, not collected without a limit
                while (!token.IsCancellationRequested)
                {
                    string line = await reader.ReadLineAsync().ConfigureAwait(false);
                    if (line == null) return;
                    lock (sync) sinceActivity.Restart();
                    if (line.Length == 0)
                    {
                        if (tooBig) Log.Write("Events: dropped a \"" + (evName ?? "message") + "\" event over " + (MaxEventChars >> 20) + " MB");
                        else if (data.Length > 0 && Received != null)
                        {
                            try { Received(evName ?? "message", data.ToString()); }
                            catch (Exception ex) { Log.Error("Events: handler", ex); }
                        }
                        evName = null;
                        data.Clear();
                        tooBig = false;
                        continue;
                    }
                    if (line[0] == ':') continue;
                    int colon = line.IndexOf(':');
                    string field = colon < 0 ? line : line.Substring(0, colon);
                    string value = colon < 0 ? "" : line.Substring(colon + 1);
                    if (value.StartsWith(" ")) value = value.Substring(1);
                    if (field == "event") evName = value;
                    else if (field == "data" && !tooBig)
                    {
                        if (data.Length + value.Length + 1 > MaxEventChars) { tooBig = true; data.Clear(); continue; }
                        if (data.Length > 0) data.Append('\n');
                        data.Append(value);
                    }
                }
            }
        }
    }
}
