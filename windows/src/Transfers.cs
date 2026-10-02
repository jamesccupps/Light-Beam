// File transfers: resumable chunked uploads (streamed from disk) and resumable downloads (HTTP Range).
// Two lanes per direction, so small files never wait behind a big one. Failures retry with backoff and
// resync with the server; a connection that silently stops moving bytes is dropped after 60 s and resumed.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Threading;
using System.Threading.Tasks;

namespace Beam
{
    enum JobState { Queued, Preparing, Running, Retrying, Done, Failed, Cancelled, Gone }

    class LocalFileException : Exception
    {
        public LocalFileException(string message, Exception inner) : base(message, inner) { }
    }

    // A chunk of a file as a request body, read from disk while it's being sent: two 1 MB buffers, the next read
    // running while the previous slice goes out. A big chunk needs no big buffer, and disk and network overlap.
    class FileChunkContent : HttpContent
    {
        const int Slice = 1 << 20, Piece = 64 * 1024;
        readonly FileStream file;
        readonly long offset, count;
        readonly Action<long> progress;
        readonly CancellationToken token;

        public FileChunkContent(FileStream file, long offset, long count, Action<long> progress, CancellationToken token)
        {
            this.file = file;
            this.offset = offset;
            this.count = count;
            this.progress = progress;
            this.token = token;
            Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        }

        async Task<int> ReadSlice(byte[] buffer, int want)
        {
            int got = 0;
            try
            {
                while (got < want)
                {
                    int n = await file.ReadAsync(buffer, got, want - got, token).ConfigureAwait(false);
                    if (n == 0) break;
                    got += n;
                }
            }
            catch (IOException ex) { throw new LocalFileException("Can't read the file: " + ex.Message, ex); }
            if (got < want) throw new LocalFileException("The file changed while it was being sent", null);
            return got;
        }

        protected override async Task SerializeToStreamAsync(Stream stream, TransportContext context)
        {
            var current = new byte[(int)Math.Min(Slice, Math.Max(1, count))];
            var next = count > Slice ? new byte[Slice] : null;
            file.Position = offset; // again if the request is ever sent twice
            long sent = 0;
            int n = count > 0 ? await ReadSlice(current, (int)Math.Min(Slice, count)).ConfigureAwait(false) : 0;
            while (n > 0)
            {
                long after = sent + n;
                int want = (int)Math.Min(Slice, count - after);
                var read = want > 0 ? ReadSlice(next, want) : Task.FromResult(0);
                // Written in 64 KB pieces, each one reported: on a very slow link (a few KB/s) the stall watchdog
                // still sees progress well within its minute.
                for (int pos = 0; pos < n; pos += Piece)
                {
                    int m = Math.Min(Piece, n - pos);
                    await stream.WriteAsync(current, pos, m, token).ConfigureAwait(false);
                    if (progress != null) progress(sent + pos + m);
                }
                sent = after;
                n = await read.ConfigureAwait(false);
                var t = current; current = next; next = t;
            }
        }

        protected override bool TryComputeLength(out long length)
        {
            length = count;
            return true;
        }
    }

    abstract class Job
    {
        public const long BigFile = 16L * 1024 * 1024;
        public volatile JobState State = JobState.Queued;
        public string Error;
        public bool Permanent;
        public string Status;
        public CancellationTokenSource Cts = new CancellationTokenSource();
        public long Ts;
        public int Failures;
        public long Size;
        public long Done;                 // bytes sent or received so far
        public bool FinalHandled;         // UI thread: the finished state was processed once
        public double Rate;               // UI thread: smoothed bytes per second
        public Stopwatch Clock;           // since the transfer first started running (for the log's MB/s)
        public int Session;               // UI thread: the sign-in session it belongs to (callbacks from an older one are ignored)
        public bool ByUser;               // cancelled by the user (not by the app or the server)
        long rateBytes = -1, rateTicks;
        long lastProgress = Stopwatch.GetTimestamp();
        CancellationTokenSource request;  // the HTTP request in flight; cancelled to drop a stalled connection

        public bool Active
        {
            get { return State == JobState.Queued || State == JobState.Preparing || State == JobState.Running || State == JobState.Retrying; }
        }

        public abstract string TransferId { get; }

        public static int Backoff(int failures)
        {
            return Math.Min(30, 1 << Math.Min(failures - 1, 5));
        }

        public void Touch() { Interlocked.Exchange(ref lastProgress, Stopwatch.GetTimestamp()); }

        public double IdleSeconds
        {
            get { return (Stopwatch.GetTimestamp() - Interlocked.Read(ref lastProgress)) / (double)Stopwatch.Frequency; }
        }

        public CancellationTokenSource BeginRequest(CancellationToken outer)
        {
            var cts = CancellationTokenSource.CreateLinkedTokenSource(outer);
            request = cts;
            Touch();
            return cts;
        }

        public void EndRequest(CancellationTokenSource cts)
        {
            if (request == cts) request = null;
            cts.Dispose();
        }

        // Drops the current request (stalled, or the PC just woke up); the transfer resumes where the server is.
        public void Kick()
        {
            var r = request;
            if (r != null) { try { r.Cancel(); } catch { } }
        }

        // UI thread, a few times a second.
        public void SampleRate()
        {
            long now = Stopwatch.GetTimestamp();
            if (State != JobState.Running) { rateBytes = -1; Rate = 0; return; }
            if (rateBytes < 0) { rateBytes = Done; rateTicks = now; return; }
            double secs = (now - rateTicks) / (double)Stopwatch.Frequency;
            if (secs < 0.5) return;
            double inst = Math.Max(0, (Done - rateBytes) / secs);
            Rate = Rate <= 0 ? inst : Rate * 0.7 + inst * 0.3;
            rateBytes = Done;
            rateTicks = now;
        }

        public long EtaSeconds
        {
            get { return Rate > 1 && Size > Done ? (long)((Size - Done) / Rate) : -1; }
        }
    }

    class UploadJob : Job
    {
        public string LocalId;
        public string Path;
        public string SourceFolder;       // a folder being zipped into Path
        public string Name;
        public string Mime;
        public string Origin;             // "send", "outbox", "clipboard", "page"… (for the log only)
        public List<string> To = new List<string>();
        public string UploadId;
        public long Offset;
        public long ChunkSize = 8 * 1024 * 1024;
        public long MinChunk = 8 * 1024 * 1024;  // the server's chunk size
        public long MaxChunk = 8 * 1024 * 1024;  // Beam 1.4 servers take bigger ones: each chunk then lasts ~4 s
        public long MtimeTicks;
        public Item Result;
        public bool DeleteWhenDone;
        public bool NotifyWhenDone;
        public bool NeedsResync;          // restored after a restart: ask the server where it stands first
        public Action<UploadJob> Finished;
        public int RestartCount;
        public DateTime BusySince = DateTime.MinValue; // the server has said "still busy with this chunk" since then

        public override string TransferId { get { return "up:" + LocalId; } }
    }

    class DownloadJob : Job
    {
        public Item Item;
        public string Folder;
        public string SaveAs;             // explicit destination ("Save as…"), else a unique name in Folder
        public string Then;               // "open" or "reveal" once saved
        public bool Auto;
        public string PartPath;
        public string FinalPath;
        public string Referrer;
        public bool Early;                // started while the file was still arriving (Beam 1.4 servers)
        public bool SenderCancelled;      // ...and the sender gave up: there will be no item
        public bool ItemDeleted;          // UI thread: cancelled because its item was deleted on the server
        public int ErrorStatus;           // the server's HTTP status when it failed for good because of an answer
        public int ParkSeconds;           // early: how long the last wait for the sender was (grows while it stays paused)
        public int QuickRetries;          // early: retries without a pause in a row (the file just became an item)
        public long Gap;                  // early: how far the sender was ahead at the last look, if no bytes came since
        public volatile bool Parked;      // early: waiting for its sender between two looks
        readonly SemaphoreSlim wake = new SemaphoreSlim(0);

        // An early download with nothing to do until its sender goes on: parked, or on a connection that has had no
        // bytes for a while. It isn't a busy transfer: no progress ticks, an update may install, Quit doesn't ask.
        // (The partial file stays; the next `upload` event or the item starts it again after a restart.)
        public bool Waiting
        {
            get { return Early && Active && (Parked || (State == JobState.Running && IdleSeconds > 10)); }
        }

        // More of an early download's file arrived, or the sender finished: stop waiting.
        public void WakeUp() { if (wake.CurrentCount == 0) wake.Release(); }

        // A wake-up that came in meanwhile ends the wait at once (the caller looks at the upload again first anyway).
        public Task<bool> WaitForWake(int ms, CancellationToken ct)
        {
            return wake.WaitAsync(ms, ct);
        }

        // Before a fresh look at the upload: wake-ups from before it are old news (e.g. held `upload` events of bytes
        // this job already has), and mustn't end the next wait at once.
        public void ForgetWakeUps()
        {
            while (wake.CurrentCount > 0 && wake.Wait(0)) { }
        }

        public override string TransferId { get { return "down:" + Item.Id; } }
    }

    abstract class Worker<T> where T : Job
    {
        protected const int MaxFailures = 25;
        protected const int StallSeconds = 60;
        readonly Queue<T>[] queues = { new Queue<T>(), new Queue<T>() };
        readonly SemaphoreSlim[] signals = { new SemaphoreSlim(0), new SemaphoreSlim(0) };
        readonly List<T> running = new List<T>();
        protected readonly Func<Api> api;
        protected readonly Action<T> changed;   // state changes (background thread)
        protected readonly Action<T> progress;  // byte progress (background thread)
        readonly Timer watchdog;

        protected Worker(Func<Api> api, Action<T> changed, Action<T> progress)
        {
            this.api = api;
            this.changed = changed;
            this.progress = progress;
            for (int lane = 0; lane < queues.Length; lane++)
            {
                int l = lane;
                Task.Run(() => Loop(l));
            }
            watchdog = new Timer(_ => CheckStalls(), null, Timeout.Infinite, Timeout.Infinite); // runs while a transfer does
        }

        // Lane 0: small files; lane 1: big ones.
        static int LaneOf(T job) { return job.Size >= Job.BigFile ? 1 : 0; }

        // Jobs that mostly wait (a download trailing its sender) run on their own, outside the lanes, so they never
        // hold up other files.
        protected virtual bool OwnRunner(T job) { return false; }

        public void Enqueue(T job)
        {
            job.State = JobState.Queued;
            if (OwnRunner(job)) { Task.Run(() => RunOne(job)); return; }
            int lane = LaneOf(job);
            lock (queues[lane]) queues[lane].Enqueue(job);
            signals[lane].Release();
        }

        // After sleep or a network change: drop every connection in flight; transfers resume by themselves.
        public void KickAll()
        {
            lock (running) foreach (var j in running) j.Kick();
        }

        // A job with nothing to do right now (an early download waiting for its sender).
        protected virtual bool Resting(T job) { return false; }

        int watchdogMs = Timeout.Infinite; // under `running`

        void SetWatchdog(int ms)
        {
            if (ms == watchdogMs) return;
            watchdogMs = ms;
            watchdog.Change(ms, ms);
        }

        void CheckStalls()
        {
            lock (running)
            {
                bool busy = false;
                foreach (var j in running)
                {
                    if (!Resting(j)) busy = true;
                    if (j.State == JobState.Running && j.IdleSeconds > StallSeconds)
                    {
                        Log.Write("Transfer " + j.TransferId + ": no progress for " + StallSeconds + " s, reconnecting");
                        j.Kick();
                        j.Touch();
                    }
                }
                // Only jobs waiting for their senders: a look every 15 s will do (a stall takes 60 s).
                if (running.Count > 0) SetWatchdog(busy ? 5000 : 15000);
            }
        }

        async Task Loop(int lane)
        {
            while (true)
            {
                await signals[lane].WaitAsync().ConfigureAwait(false);
                T job;
                lock (queues[lane])
                {
                    if (queues[lane].Count == 0) continue;
                    job = queues[lane].Dequeue();
                }
                await RunOne(job).ConfigureAwait(false);
            }
        }

        async Task RunOne(T job)
        {
            if (job.State != JobState.Queued)
            {
                // Cancelled while waiting in the queue.
                try { Done(job); } catch (Exception ex) { Log.Error("Transfer finished", ex); }
                return;
            }
            lock (running)
            {
                running.Add(job);
                SetWatchdog(5000);
            }
            try { await Run(job).ConfigureAwait(false); }
            catch (Exception ex)
            {
                Log.Error("Transfer", ex);
                job.State = JobState.Failed;
                job.Error = ex.Message;
            }
            finally
            {
                lock (running)
                {
                    running.Remove(job);
                    if (running.Count == 0) SetWatchdog(Timeout.Infinite);
                }
            }
            try { Done(job); }
            catch (Exception ex) { Log.Error("Transfer finished", ex); }
        }

        protected abstract Task Run(T job);
        protected abstract void Done(T job);

        // " (12.3 MB in 1.5 s, 8.2 MB/s)" for files of 1 MB and more.
        protected static string Speed(Job job)
        {
            if (job.Clock == null || job.Size < 1024 * 1024) return "";
            double secs = Math.Max(0.001, job.Clock.Elapsed.TotalSeconds);
            return string.Format(System.Globalization.CultureInfo.InvariantCulture, " ({0:0.0} MB in {1:0.00} s, {2:0.0} MB/s)", job.Size / 1048576.0, secs, job.Size / 1048576.0 / secs);
        }

        // A problem with the local file, also when HttpClient wrapped it (it happens inside the request body).
        protected static LocalFileException LocalProblem(Exception ex)
        {
            for (var e = ex; e != null; e = e.InnerException)
            {
                var local = e as LocalFileException;
                if (local != null) return local;
            }
            return null;
        }

        protected static bool IsPermanent(Exception ex)
        {
            if (LocalProblem(ex) != null) return true;
            var api = ex as ApiException;
            return api != null && (api.Status == 400 || api.Status == 401 || api.Status == 403 || api.Status == 413 || api.Status == 507);
        }
    }

    class Uploader : Worker<UploadJob>
    {
        public Uploader(Func<Api> api, Action<UploadJob> changed, Action<UploadJob> progress) : base(api, changed, progress) { }

        public void Cancel(UploadJob job)
        {
            if (!job.Active) return;
            job.State = JobState.Cancelled;
            job.Cts.Cancel();
            DropServerUpload(job);
            changed(job);
        }

        public void Retry(UploadJob job)
        {
            if (job.State != JobState.Failed) return;
            job.Cts = new CancellationTokenSource();
            job.Failures = 0;
            job.Error = null;
            job.Permanent = false;
            job.FinalHandled = false;
            job.NeedsResync = job.UploadId != null;
            Enqueue(job);
            changed(job);
        }

        public void DropServerUpload(UploadJob job)
        {
            string id = job.UploadId;
            if (id == null) return;
            Task.Run(async () =>
            {
                try { await api().Call(HttpMethod.Delete, "/api/uploads/" + id).ConfigureAwait(false); }
                catch { }
            });
        }

        protected override void Done(UploadJob job)
        {
            if (job.State == JobState.Done && job.DeleteWhenDone) FileUtil.TryDelete(job.Path);
            changed(job);
        }

        protected override async Task Run(UploadJob job)
        {
            var ct = job.Cts.Token;
            if (job.Clock == null) job.Clock = Stopwatch.StartNew();
            job.State = JobState.Running;
            job.Status = null;
            changed(job);
            FileStream fs;
            try
            {
                fs = new FileStream(job.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1 << 16, FileOptions.Asynchronous | FileOptions.SequentialScan);
            }
            catch (Exception ex)
            {
                job.State = JobState.Failed;
                job.Permanent = true;
                job.Error = "Can't read the file: " + ex.Message;
                return;
            }
            using (fs)
            {
                if (job.UploadId == null) job.Size = fs.Length;
                while (true)
                {
                    Exception transient = null;
                    try
                    {
                        ct.ThrowIfCancellationRequested();
                        if (job.NeedsResync)
                        {
                            await Resync(job, ct).ConfigureAwait(false);
                            job.NeedsResync = false;
                            if (job.State == JobState.Done) return;
                        }
                        if (job.UploadId == null)
                        {
                            await Create(job, ct).ConfigureAwait(false);
                            changed(job); // the upload id must be saved, so it can resume after a restart
                        }
                        if (await SendChunk(job, fs, ct).ConfigureAwait(false)) break;
                        continue;
                    }
                    catch (Exception ex)
                    {
                        if (ct.IsCancellationRequested || job.State == JobState.Cancelled)
                        {
                            job.State = JobState.Cancelled;
                            return;
                        }
                        if (IsPermanent(ex) || job.Failures >= MaxFailures)
                        {
                            job.State = JobState.Failed;
                            job.Permanent = IsPermanent(ex);
                            job.Error = LocalProblem(ex) != null ? LocalProblem(ex).Message : Api.Describe(ex);
                            Log.Write("Upload " + job.TransferId + " failed: " + job.Error);
                            return;
                        }
                        transient = ex;
                    }
                    // Network trouble: wait, then ask the server how much it really has. The next PUT is small
                    // again (the link may be slow now); bytes the server kept count as progress.
                    long offsetBefore = job.Offset;
                    job.ChunkSize = job.MinChunk;
                    job.Failures++;
                    int wait = Job.Backoff(job.Failures);
                    job.State = JobState.Retrying;
                    job.Status = "Connection problem (" + Api.Describe(transient) + "), retrying in " + wait + " s";
                    Log.Write("Upload " + job.TransferId + ": " + job.Status);
                    changed(job);
                    try
                    {
                        await Task.Delay(wait * 1000, ct).ConfigureAwait(false);
                        await Resync(job, ct).ConfigureAwait(false);
                        if (job.Offset > offsetBefore) job.Failures = 0;
                    }
                    catch (Exception)
                    {
                        if (ct.IsCancellationRequested) { job.State = JobState.Cancelled; return; }
                    }
                    if (job.State == JobState.Done) return;
                    job.State = JobState.Running;
                    job.Status = null;
                    changed(job);
                }
            }
        }

        async Task Create(UploadJob job, CancellationToken ct)
        {
            var body = new Dictionary<string, object>();
            body["name"] = job.Name;
            body["size"] = job.Size;
            body["mime"] = job.Mime;
            body["to"] = job.To.ToArray();
            int w, h;
            if (Thumbnail.Dimensions(job.Path, out w, out h)) { body["w"] = w; body["h"] = h; }
            var d = Json.Obj(await api().Call(HttpMethod.Post, "/api/uploads", body, 60, ct).ConfigureAwait(false));
            job.UploadId = Json.Str(d, "id");
            job.Offset = Json.Long(d, "offset", 0);
            job.Done = job.Offset;
            ChunkLimits(job, d);
            Log.Write("Upload " + job.TransferId + " (" + job.Size + " bytes, " + job.Origin + ") started as " + job.UploadId);
        }

        // Returns true when the upload is complete.
        async Task<bool> SendChunk(UploadJob job, FileStream fs, CancellationToken ct)
        {
            long baseOffset = job.Offset;
            long got = Math.Max(0, Math.Min(job.ChunkSize, job.Size - baseOffset));
            try
            {
                if (fs.Length != job.Size) throw new LocalFileException("The file changed while it was being sent", null);
            }
            catch (IOException ex) { throw new LocalFileException("Can't read the file: " + ex.Message, ex); }

            var reqCts = job.BeginRequest(ct);
            var took = Stopwatch.StartNew();
            try
            {
                var req = api().Request(HttpMethod.Put, "/api/uploads/" + job.UploadId + "?offset=" + baseOffset);
                req.Content = new FileChunkContent(fs, baseOffset, got, n =>
                {
                    job.Done = baseOffset + n;
                    job.Touch();
                    progress(job);
                }, reqCts.Token);
                using (req)
                using (var resp = await api().Send(req, 0, reqCts.Token, HttpCompletionOption.ResponseContentRead).ConfigureAwait(false))
                {
                    int status = (int)resp.StatusCode;
                    string text = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
                    var d = Json.ParseObject(text);
                    if (status == 200)
                    {
                        SizeNextChunk(job, got, took.Elapsed.TotalSeconds);
                        job.Offset = Json.Long(d, "offset", baseOffset + got);
                        job.Done = job.Offset;
                        job.Failures = 0;
                        job.BusySince = DateTime.MinValue;
                        progress(job);
                        return false;
                    }
                    if (status == 201)
                    {
                        job.Result = Item.Parse(Json.Obj(Json.Get(d, "item")));
                        job.Offset = job.Size;
                        job.Done = job.Size;
                        job.State = JobState.Done;
                        Log.Write("Upload " + job.TransferId + " finished as item " + (job.Result != null ? job.Result.Id : job.UploadId) + Speed(job));
                        return true;
                    }
                    if (status == 409)
                    {
                        long off = Json.Long(d, "offset", -1);
                        if (off >= 0 && off != baseOffset)
                        {
                            // Wrong offset: carry on from where the server is.
                            Log.Write("Upload " + job.TransferId + ": continuing at the server's offset " + off);
                            job.Offset = off;
                            job.Done = off;
                            job.BusySince = DateTime.MinValue;
                            return false;
                        }
                        // The server is still writing an earlier attempt of this chunk (a connection that died
                        // silently). Wait for it to give that up; newer servers take over after 30 s.
                        if (job.BusySince == DateTime.MinValue) job.BusySince = DateTime.UtcNow;
                        if (DateTime.UtcNow - job.BusySince > TimeSpan.FromMinutes(10)) throw new ApiException(409, Json.Str(d, "error") ?? "The server is stuck on this upload", d);
                        if ((DateTime.UtcNow - job.BusySince).TotalSeconds < 4) Log.Write("Upload " + job.TransferId + ": the server is still busy with an earlier attempt; waiting");
                        await Task.Delay(3000, ct).ConfigureAwait(false);
                        if (off < 0) await Resync(job, ct).ConfigureAwait(false);
                        return job.State == JobState.Done;
                    }
                    if (status == 404)
                    {
                        await Resync(job, ct).ConfigureAwait(false);
                        return job.State == JobState.Done;
                    }
                    string msg = Json.Str(d, "error") ?? ("HTTP " + status);
                    Api.NoticeMoved(status, d);
                    if (status >= 500 && status != 507 || status == 410) throw new HttpRequestException("Server error: " + msg);
                    throw new ApiException(status, msg, d);
                }
            }
            catch (OperationCanceledException)
            {
                if (ct.IsCancellationRequested) throw;
                throw new TimeoutException("The connection stalled");
            }
            finally { job.EndRequest(reqCts); }
        }

        // chunkSize (every server): the size to send per request. Beam 1.4 servers add maxChunkSize (any size up to
        // the whole file, since an interrupted PUT keeps what arrived): then each PUT carries about 4 s at the rate
        // measured so far, at least 64 MB, streamed from disk. A request round trip per 4 s costs well under 1 % of
        // the link, and bounded requests stay clear of proxies' limits (tailscale serve) and give clean checkpoints.
        const long BigChunk = 64L * 1024 * 1024;
        const double ChunkSeconds = 4.0;

        static void ChunkLimits(UploadJob job, Dictionary<string, object> d)
        {
            long chunk = Json.Long(d, "chunkSize", 0);
            if (chunk > 0) job.MinChunk = Math.Max(64 * 1024, Math.Min(chunk, BigChunk));
            long max = Json.Long(d, "maxChunkSize", 0);
            if (max > job.MinChunk)
            {
                job.MaxChunk = max;
                job.MinChunk = Math.Min(BigChunk, max);
            }
            else job.MaxChunk = job.MinChunk;
            job.ChunkSize = Math.Max(job.MinChunk, Math.Min(job.ChunkSize, job.MaxChunk));
        }

        static void SizeNextChunk(UploadJob job, long bytes, double seconds)
        {
            if (job.MaxChunk <= job.MinChunk || seconds <= 0) return;
            long next = (long)(bytes / Math.Max(0.05, seconds) * ChunkSeconds);
            next = next / (1 << 20) * (1 << 20);
            job.ChunkSize = Math.Max(job.MinChunk, Math.Min(job.MaxChunk, next));
        }

        // Ask the server where the upload stands. A missing upload either finished (the item exists
        // under the same id) or expired (start over).
        async Task Resync(UploadJob job, CancellationToken ct)
        {
            if (job.UploadId == null) return;
            try
            {
                var d = Json.Obj(await api().Call(HttpMethod.Get, "/api/uploads/" + job.UploadId, null, 30, ct).ConfigureAwait(false));
                ChunkLimits(job, d);
                job.Offset = Json.Long(d, "offset", job.Offset);
                job.Done = job.Offset;
                return;
            }
            catch (ApiException ex)
            {
                if (ex.Status != 404) throw;
            }
            try
            {
                var item = await api().GetItem(job.UploadId).ConfigureAwait(false);
                if (item != null)
                {
                    // It finished, though its last answer never came here (a dropped connection, a retry, a restart).
                    job.Result = item;
                    job.Offset = job.Size;
                    job.Done = job.Size;
                    job.State = JobState.Done;
                    Log.Write("Upload " + job.TransferId + " finished as item " + item.Id + Speed(job) + ", found on the server");
                    return;
                }
            }
            catch (ApiException ex)
            {
                if (ex.Status != 404) throw;
            }
            job.RestartCount++;
            if (job.RestartCount > 3) throw new ApiException(400, "The server keeps losing this upload", null);
            Log.Write("Upload " + job.TransferId + ": the server no longer has it, starting over");
            job.UploadId = null;
            job.Offset = 0;
            job.Done = 0;
        }
    }

    class Downloader : Worker<DownloadJob>
    {
        public Downloader(Func<Api> api, Action<DownloadJob> changed, Action<DownloadJob> progress) : base(api, changed, progress) { }

        protected override bool OwnRunner(DownloadJob job) { return job.Early; }

        protected override bool Resting(DownloadJob job) { return job.Waiting; }

        const int GoOn = 1, SenderGone = 2;

        // An early download (the file was still arriving) stopped getting bytes. Where does the upload stand?
        // - More has arrived: go on now. But if the last try got none of it (no bytes since the last look), wait as
        //   below instead of retrying and failing over and over.
        // - Nothing new: the sender paused. Wait for it (an `upload` event or the item wakes the job; otherwise look
        //   again after 15 s, then less often, up to 5 min), not counted as a failure.
        // - No upload any more: if its item exists the file is complete, go on (same ETag, the download resumes);
        //   if not, the sender cancelled it.
        // Returns 0 (a normal failure), GoOn or SenderGone.
        async Task<int> WaitForSender(DownloadJob job, CancellationToken ct)
        {
            job.ForgetWakeUps();
            long have = 0;
            try { if (File.Exists(job.PartPath)) have = new FileInfo(job.PartPath).Length; } catch { }
            long offset = -1;
            bool noUpload = false;
            try
            {
                var u = Json.Obj(await api().Call(HttpMethod.Get, "/api/uploads/" + job.Item.Id, null, 20, ct).ConfigureAwait(false));
                offset = Json.Long(u, "offset", -1);
            }
            catch (ApiException ex)
            {
                if (ex.Status != 404) return 0;
                noUpload = true;
            }
            catch (Exception) { if (ct.IsCancellationRequested) throw; return 0; }
            if (noUpload)
            {
                Item finished = null;
                try { finished = await api().GetItem(job.Item.Id).ConfigureAwait(false); }
                catch (ApiException ex2) { if (ex2.Status == 404) return SenderGone; return 0; }
                catch (Exception) { if (ct.IsCancellationRequested) throw; return 0; }
                if (finished == null) return 0;
                return ++job.QuickRetries <= 3 ? GoOn : 0;
            }
            if (offset > have)
            {
                bool gotNone = job.Gap > 0; // Gap is cleared by every slice written since the last look
                job.Gap = offset - have;
                if (!gotNone) return ++job.QuickRetries <= 3 ? GoOn : 0;
            }
            else job.Gap = 0;
            job.QuickRetries = 0;
            job.ParkSeconds = Math.Min(300, job.ParkSeconds <= 0 ? 15 : job.ParkSeconds * 2);
            if (job.ParkSeconds == 15 || job.Gap > 0)
                Log.Write("Download " + job.TransferId + ": waiting for the sender (" + have + " of " + offset + " bytes here)");
            job.State = JobState.Retrying;
            job.Status = "Waiting for the sender";
            job.Parked = true;
            changed(job);
            try { await job.WaitForWake(job.ParkSeconds * 1000, ct).ConfigureAwait(false); }
            finally { job.Parked = false; }
            job.State = JobState.Running;
            job.Status = null;
            changed(job);
            return GoOn;
        }

        public void Cancel(DownloadJob job)
        {
            if (!job.Active) return;
            job.State = JobState.Cancelled;
            job.Cts.Cancel();
            changed(job);
        }

        protected override void Done(DownloadJob job)
        {
            if ((job.State == JobState.Cancelled || job.State == JobState.Gone) && job.PartPath != null) FileUtil.TryDelete(job.PartPath);
            changed(job);
        }

        public static string PartPathFor(DownloadJob job)
        {
            if (job.SaveAs != null) return job.SaveAs + "." + job.Item.Id + ".beampart";
            string safe = FileUtil.SafeName(job.Item.Name);
            if (safe.Length > 80) safe = safe.Substring(0, 80);
            return Path.Combine(job.Folder, safe + "." + job.Item.Id + ".beampart");
        }

        protected override async Task Run(DownloadJob job)
        {
            var ct = job.Cts.Token;
            var item = job.Item;
            if (job.Clock == null) job.Clock = Stopwatch.StartNew();
            job.State = JobState.Running;
            job.Size = item.Size;
            changed(job);
            try
            {
                Directory.CreateDirectory(job.SaveAs != null ? Path.GetDirectoryName(job.SaveAs) : job.Folder);
            }
            catch (Exception ex)
            {
                job.State = JobState.Failed;
                job.Permanent = true;
                job.Error = "Can't create the folder: " + ex.Message;
                return;
            }
            job.PartPath = PartPathFor(job);
            while (true)
            {
                Exception transient = null;
                try
                {
                    ct.ThrowIfCancellationRequested();
                    if (await Fetch(job, ct).ConfigureAwait(false)) return;
                    continue;
                }
                catch (Exception ex)
                {
                    if (ct.IsCancellationRequested || job.State == JobState.Cancelled)
                    {
                        job.State = JobState.Cancelled;
                        return;
                    }
                    if (IsPermanent(ex))
                    {
                        var answer = ex as ApiException;
                        job.State = JobState.Failed;
                        job.Permanent = true;
                        job.ErrorStatus = answer != null ? answer.Status : 0;
                        job.Error = LocalProblem(ex) != null ? LocalProblem(ex).Message : Api.Describe(ex);
                        Log.Write("Download " + job.TransferId + " failed: " + job.Error);
                        return;
                    }
                    transient = ex;
                }
                if (job.Early)
                {
                    int next;
                    try { next = await WaitForSender(job, ct).ConfigureAwait(false); }
                    catch (OperationCanceledException) { job.State = JobState.Cancelled; return; }
                    if (next == SenderGone)
                    {
                        job.State = JobState.Gone;
                        job.Error = "The sender cancelled it";
                        Log.Write("Download " + job.TransferId + ": the upload is gone (cancelled by the sender)");
                        return;
                    }
                    if (next == GoOn) continue;
                }
                if (job.Failures >= MaxFailures)
                {
                    job.State = JobState.Failed;
                    job.Error = Api.Describe(transient);
                    Log.Write("Download " + job.TransferId + " failed: " + job.Error);
                    return;
                }
                job.Failures++;
                int wait = Job.Backoff(job.Failures);
                job.State = JobState.Retrying;
                job.Status = "Connection problem (" + Api.Describe(transient) + "), retrying in " + wait + " s";
                Log.Write("Download " + job.TransferId + ": " + job.Status);
                changed(job);
                try { await Task.Delay(wait * 1000, ct).ConfigureAwait(false); }
                catch (OperationCanceledException) { job.State = JobState.Cancelled; return; }
                job.State = JobState.Running;
                job.Status = null;
                changed(job);
            }
        }

        // Returns true when the job reached a final state (done or gone).
        async Task<bool> Fetch(DownloadJob job, CancellationToken ct)
        {
            var item = job.Item;
            long have = 0;
            try
            {
                if (File.Exists(job.PartPath)) have = new FileInfo(job.PartPath).Length;
                if (have > item.Size) { File.Delete(job.PartPath); have = 0; }
            }
            catch (IOException ex) { throw new LocalFileException("Can't write the file: " + ex.Message, ex); }
            job.Done = have;
            if (have == item.Size && (have > 0 || File.Exists(job.PartPath))) return Finish(job);

            var reqCts = job.BeginRequest(ct);
            try
            {
                var req = api().Request(HttpMethod.Get, "/api/file/" + item.Id);
                if (have > 0) req.Headers.Range = new RangeHeaderValue(have, null);
                using (req)
                using (var resp = await api().Send(req, 60, reqCts.Token, HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false))
                {
                    int status = (int)resp.StatusCode;
                    if (status == 404)
                    {
                        if (job.Early) throw new HttpRequestException("Not on the server right now");
                        job.State = JobState.Gone;
                        job.Error = "It was deleted from the server";
                        return true;
                    }
                    if (status == 416)
                    {
                        FileUtil.TryDelete(job.PartPath);
                        throw new HttpRequestException("Range not satisfiable, starting over");
                    }
                    if (status != 200 && status != 206)
                    {
                        var err = await Api.ErrorFrom(resp).ConfigureAwait(false);
                        if (status >= 500) throw new HttpRequestException(err.Message);
                        throw err;
                    }
                    bool append = status == 206;
                    if (append)
                    {
                        var range = resp.Content.Headers.ContentRange;
                        if (range == null || !range.From.HasValue || range.From.Value != have)
                        {
                            // A partial answer from somewhere else than asked: never splice it into the file.
                            FileUtil.TryDelete(job.PartPath);
                            throw new HttpRequestException("Unexpected range from the server, starting over");
                        }
                    }
                    if (have > 0) Log.Write("Download " + job.TransferId + ": " + (append ? "resuming at byte " + have : "the server ignored the range, starting over"));
                    if (!append) have = 0;
                    job.Done = have;

                    FileStream file;
                    try
                    {
                        // Writes are whole 1 MB slices, so the stream's own buffer (4 KB) is bypassed: no extra copy.
                        file = new FileStream(job.PartPath, append ? FileMode.Append : FileMode.Create, FileAccess.Write, FileShare.Read, 4096, true);
                    }
                    catch (Exception ex) { throw new LocalFileException("Can't write the file: " + ex.Message, ex); }

                    try
                    {
                        using (reqCts.Token.Register(() => { try { resp.Dispose(); } catch { } }))
                        using (file)
                        using (var stream = await resp.Content.ReadAsStreamAsync().ConfigureAwait(false))
                        {
                            // Two buffers: the next slice comes off the network while the last one goes to disk.
                            var reader = new SliceReader(stream, job.Touch, reqCts.Token);
                            var buf = new byte[1 << 20];
                            var spare = new byte[1 << 20];
                            Task writing = null;
                            try
                            {
                                while (true)
                                {
                                    int n = await reader.Next(buf).ConfigureAwait(false);
                                    if (writing != null)
                                    {
                                        try { await writing.ConfigureAwait(false); }
                                        catch (IOException ex) { throw new LocalFileException("Can't write the file: " + ex.Message, ex); }
                                        writing = null;
                                    }
                                    if (n == 0) break;
                                    job.ParkSeconds = 0;
                                    job.QuickRetries = 0;
                                    job.Gap = 0;
                                    writing = file.WriteAsync(buf, 0, n, ct);
                                    job.Done += n;
                                    job.Failures = 0;
                                    progress(job);
                                    var t = buf; buf = spare; spare = t;
                                }
                            }
                            finally
                            {
                                // A connection that broke mid-way: let the last write land before the file closes (the
                                // next attempt resumes from the file's real length).
                                reader.Abandon();
                                if (writing != null) { try { writing.Wait(10000); } catch { } }
                            }
                        }
                    }
                    catch (ObjectDisposedException ex) { throw new HttpRequestException("The download stalled", ex); }
                    catch (OperationCanceledException)
                    {
                        if (ct.IsCancellationRequested) throw;
                        throw new HttpRequestException("The download stalled");
                    }
                    if (job.Done < item.Size) throw new HttpRequestException("The connection closed early");
                    return Finish(job);
                }
            }
            catch (OperationCanceledException)
            {
                if (ct.IsCancellationRequested) throw;
                throw new TimeoutException("The connection stalled");
            }
            finally { job.EndRequest(reqCts); }
        }

        bool Finish(DownloadJob job)
        {
            try
            {
                if (!File.Exists(job.PartPath)) File.WriteAllBytes(job.PartPath, new byte[0]);
                string final;
                if (job.SaveAs != null)
                {
                    final = job.SaveAs;
                    if (File.Exists(final)) File.Delete(final);
                }
                else final = FileUtil.UniquePath(job.Folder, FileUtil.SafeName(job.Item.Name));
                File.Move(job.PartPath, final);
                FileUtil.MarkFromInternet(final, job.Referrer);
                job.FinalPath = final;
                job.State = JobState.Done;
                Log.Write("Saved " + job.TransferId + " to " + final + Speed(job));
                return true;
            }
            catch (Exception ex) { throw new LocalFileException("Can't save the file: " + ex.Message, ex); }
        }
    }
}
