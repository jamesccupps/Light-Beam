// A speed test when another device asks (Beam 1.18 + this app 1.13; Settings → Connections → Test speed; the user: "we
// should do ... the speed test"): this PC downloads and uploads test data through its own way to the server, as its
// transfers go, about 3 s each way (64 MB at most each), and reports what it measured. One at a time.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Threading;
using System.Threading.Tasks;

namespace Beam
{
    static class SpeedTest
    {
        const double Seconds = 3;
        const long MaxBytes = 64L * 1024 * 1024;
        const int MaxRequest = 16 * 1024 * 1024;
        static bool running;

        // id: the server's id for the request (its answer goes to the device that asked).
        public static async void Run(App app, string id)
        {
            if (running || app.Api == null) return;
            running = true;
            try
            {
                double down = await Measure(app.Api, true);
                double up = await Measure(app.Api, false);
                var body = new Dictionary<string, object>();
                body["down"] = Math.Round(down, 1);
                body["up"] = Math.Round(up, 1);
                if (id != null) body["id"] = id;
                await app.Api.Call(HttpMethod.Post, "/api/speedtest/result", body, 15, CancellationToken.None);
                Log.Write(string.Format(CultureInfo.InvariantCulture, "Speed test (another device asked): {0:0.#} Mbit/s down, {1:0.#} Mbit/s up", down, up));
            }
            catch (Exception ex) { Log.Write("Speed test: failed (" + Api.Describe(ex) + ")"); }
            finally { running = false; }
        }

        // Mbit/s one way: requests one after another, each bigger while they're quick.
        static async Task<double> Measure(Api api, bool down)
        {
            long bytes = 0;
            int size = 256 * 1024;
            var buffer = new byte[1024 * 1024];
            var clock = Stopwatch.StartNew();
            while (clock.Elapsed.TotalSeconds < Seconds && bytes < MaxBytes)
            {
                var t0 = clock.Elapsed;
                if (down)
                {
                    using (var req = api.Request(HttpMethod.Get, "/api/speedtest/down?bytes=" + size.ToString(CultureInfo.InvariantCulture)))
                    using (var resp = await api.Send(req, 60, CancellationToken.None, HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false))
                    {
                        if (!resp.IsSuccessStatusCode) throw new HttpRequestException("the server answered " + (int)resp.StatusCode);
                        using (var s = await resp.Content.ReadAsStreamAsync().ConfigureAwait(false))
                        {
                            int n;
                            while ((n = await s.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) > 0) bytes += n;
                        }
                    }
                }
                else
                {
                    using (var req = api.Request(HttpMethod.Post, "/api/speedtest/up"))
                    {
                        req.Content = new ByteArrayContent(new byte[size]);
                        req.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
                        using (var resp = await api.Send(req, 60, CancellationToken.None, HttpCompletionOption.ResponseContentRead).ConfigureAwait(false))
                        {
                            if (!resp.IsSuccessStatusCode) throw new HttpRequestException("the server answered " + (int)resp.StatusCode);
                        }
                    }
                    bytes += size;
                }
                double took = (clock.Elapsed - t0).TotalMilliseconds;
                if (took < 700) size = Math.Min(size * 4, MaxRequest);
                else if (took < 1500) size = Math.Min(size * 2, MaxRequest);
            }
            return bytes * 8.0 / Math.Max(0.001, clock.Elapsed.TotalSeconds) / 1e6;
        }
    }
}
