// Beam for Windows: the download read loop over HTTPS and plain HTTP (re-review R4), and what it holds back when a
// sender pauses (R1). Built and run by windows-https-read.mjs together with windows\src\SliceReader.cs; the loop is
// the one in Downloader.Fetch (two 1 MB buffers, the next slice read while the last one is written).
//
//   https-read.exe <url> <reader> <out file> <pinned thumbprint> <range from> <stop after idle ms> ["Name: value"...]
//
// <reader>: new (SliceReader), short (1.4.0 after the first review: a short read ends the slice) or full (1.4.0 as
// first built: up to 256 KB, whatever comes). Prints one JSON line. The test certificate is accepted by this process
// alone, by its thumbprint; nothing is added to any certificate store.
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Security;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;
using System.Threading;
using System.Threading.Tasks;

// As Beam.exe (Program.cs): without it .NET runs the harness with 4.0-era TLS defaults (TLS 1.0), not the system's.
[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8", FrameworkDisplayName = ".NET Framework 4.8")]

namespace Beam
{
    static class HttpsRead
    {
        [DllImport("kernel32.dll")] static extern bool QueryProcessCycleTime(IntPtr process, out ulong cycles);
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();

        const int Piece = 64 * 1024, Most = 256 * 1024;
        static long reads, lastRead = Stopwatch.GetTimestamp();

        static int Main(string[] args)
        {
            try { return Run(args).GetAwaiter().GetResult(); }
            catch (Exception ex) { Console.Error.WriteLine(ex); return 1; }
        }

        static void Touch()
        {
            reads++;
            Interlocked.Exchange(ref lastRead, Stopwatch.GetTimestamp());
        }

        // 1.4.0 after the first review: one read that comes back short ends the slice.
        static async Task<int> ShortSlice(Stream stream, byte[] buffer, CancellationToken token)
        {
            int got = 0;
            while (got < Most && got < buffer.Length)
            {
                int want = Math.Min(Piece, buffer.Length - got);
                int n = await stream.ReadAsync(buffer, got, want, token).ConfigureAwait(false);
                if (n == 0) break;
                Touch();
                got += n;
                if (n < want) break;
            }
            return got;
        }

        // 1.4.0 as first built: reads until 256 KB are in (or the end).
        static async Task<int> FullSlice(Stream stream, byte[] buffer, CancellationToken token)
        {
            int got = 0;
            while (got < Most && got < buffer.Length)
            {
                int n = await stream.ReadAsync(buffer, got, Math.Min(Piece, buffer.Length - got), token).ConfigureAwait(false);
                if (n == 0) break;
                Touch();
                got += n;
            }
            return got;
        }

        static async Task<int> Run(string[] a)
        {
            string url = a[0], variant = a[1], outFile = a[2], pin = a[3];
            long from = long.Parse(a[4]);
            int idleStop = int.Parse(a[5]);
            ServicePointManager.ServerCertificateValidationCallback = (s, cert, chain, errors) =>
                errors == SslPolicyErrors.None || (cert != null && string.Equals(new X509Certificate2(cert).Thumbprint, pin, StringComparison.OrdinalIgnoreCase));
            // As Api.CreateClient.
            var handler = new HttpClientHandler();
            handler.UseCookies = false;
            handler.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;
            var client = new HttpClient(handler);
            client.Timeout = Timeout.InfiniteTimeSpan;
            var req = new HttpRequestMessage(HttpMethod.Get, url);
            for (int i = 6; i < a.Length; i++)
            {
                int colon = a[i].IndexOf(':');
                req.Headers.TryAddWithoutValidation(a[i].Substring(0, colon).Trim(), a[i].Substring(colon + 1).Trim());
            }
            if (from > 0) req.Headers.Range = new RangeHeaderValue(from, null);

            var cts = new CancellationTokenSource();
            ulong c0, c1;
            QueryProcessCycleTime(GetCurrentProcess(), out c0);
            var cpu0 = Process.GetCurrentProcess().TotalProcessorTime;
            var clock = Stopwatch.StartNew();
            long written = 0;
            int writes = 0;
            bool stoppedIdle = false;
            string error = null;
            using (var resp = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, cts.Token).ConfigureAwait(false))
            {
                if ((int)resp.StatusCode != 200 && (int)resp.StatusCode != 206) throw new Exception("HTTP " + (int)resp.StatusCode);
                Timer idle = null;
                if (idleStop > 0)
                    idle = new Timer(_ =>
                    {
                        double quiet = (Stopwatch.GetTimestamp() - Interlocked.Read(ref lastRead)) * 1000.0 / Stopwatch.Frequency;
                        if (quiet > idleStop && !stoppedIdle)
                        {
                            stoppedIdle = true;
                            Thread.Sleep(200); // let a slice handed over just now reach the file
                            try { resp.Dispose(); } catch { }
                        }
                    }, null, 100, 100);
                using (var file = new FileStream(outFile, FileMode.Create, FileAccess.Write, FileShare.Read, 4096, true))
                using (var stream = await resp.Content.ReadAsStreamAsync().ConfigureAwait(false))
                {
                    var reader = new SliceReader(stream, Touch, cts.Token);
                    var buf = new byte[1 << 20];
                    var spare = new byte[1 << 20];
                    Task writing = null;
                    try
                    {
                        while (true)
                        {
                            int n = variant == "new" ? await reader.Next(buf).ConfigureAwait(false)
                                : variant == "short" ? await ShortSlice(stream, buf, cts.Token).ConfigureAwait(false)
                                : await FullSlice(stream, buf, cts.Token).ConfigureAwait(false);
                            if (writing != null) { await writing.ConfigureAwait(false); writing = null; }
                            if (n == 0) break;
                            writing = file.WriteAsync(buf, 0, n);
                            written += n;
                            writes++;
                            var t = buf; buf = spare; spare = t;
                        }
                    }
                    catch (Exception ex) { if (!stoppedIdle) error = ex.GetType().Name + ": " + ex.Message; }
                    finally
                    {
                        reader.Abandon();
                        if (writing != null) { try { writing.Wait(10000); } catch { } }
                    }
                }
                if (idle != null) idle.Dispose();
            }
            clock.Stop();
            QueryProcessCycleTime(GetCurrentProcess(), out c1);
            var cpu = Process.GetCurrentProcess().TotalProcessorTime - cpu0;
            long onDisk = new FileInfo(outFile).Length;
            Console.WriteLine(string.Format(System.Globalization.CultureInfo.InvariantCulture,
                "{{\"reader\":\"{0}\",\"written\":{1},\"onDisk\":{2},\"reads\":{3},\"writes\":{4},\"secs\":{5:0.000},\"cpuMs\":{6:0},\"mcycles\":{7:0},\"idleStop\":{8},\"error\":{9}}}",
                variant, written, onDisk, reads, writes, clock.Elapsed.TotalSeconds, cpu.TotalMilliseconds, (c1 - c0) / 1e6,
                stoppedIdle ? "true" : "false", error == null ? "null" : "\"" + error.Replace("\\", "/").Replace("\"", "'") + "\""));
            return 0;
        }
    }
}
