// This PC's Beam log when another device asks (Beam 1.20 + this app 1.14; a PC's Device info → Beam log): the end of
// beam.log (with the end of beam.log.old when the current one is short), at most 512 KB, sent to the server, which hands
// it straight to the device that asked and keeps nothing. beam.log never holds message text, keys or tokens.
using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Beam
{
    static class DeviceLog
    {
        const int MaxBytes = 512 * 1024;

        public static async void Send(App app, string id)
        {
            if (app.Api == null || string.IsNullOrEmpty(id)) return;
            try
            {
                string text = await Task.Run(() => Tail(Log.FilePath, MaxBytes));
                var body = new Dictionary<string, object>();
                body["id"] = id;
                body["name"] = "beam.log";
                body["text"] = text;
                await app.Api.Call(HttpMethod.Post, "/api/devices/me/log", body, 30, CancellationToken.None);
                Log.Write("Log: sent the end of beam.log (" + (Encoding.UTF8.GetByteCount(text) / 1024) + " KB) to the device that asked");
            }
            catch (Exception ex) { Log.Write("Log: not sent (" + Api.Describe(ex) + ")"); }
        }

        // The last `max` bytes of the log (the old copy's end first when the current one is shorter), from a whole line.
        static string Tail(string path, int max)
        {
            if (string.IsNullOrEmpty(path)) return "";
            byte[] current = ReadEnd(path, max);
            byte[] old = current.Length < max ? ReadEnd(path + ".old", max - current.Length) : new byte[0];
            var all = new byte[old.Length + current.Length];
            Buffer.BlockCopy(old, 0, all, 0, old.Length);
            Buffer.BlockCopy(current, 0, all, old.Length, current.Length);
            string text = Encoding.UTF8.GetString(all);
            bool cut = old.Length > 0 ? new FileInfo(path + ".old").Length > old.Length : new FileInfo(path).Length > current.Length;
            if (cut)
            {
                int nl = text.IndexOf('\n');
                if (nl >= 0) text = text.Substring(nl + 1);
            }
            return text;
        }

        static byte[] ReadEnd(string path, int max)
        {
            try
            {
                using (var f = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    long start = Math.Max(0, f.Length - max);
                    f.Seek(start, SeekOrigin.Begin);
                    var buf = new byte[f.Length - start];
                    int got = 0;
                    while (got < buf.Length)
                    {
                        int n = f.Read(buf, got, buf.Length - got);
                        if (n <= 0) break;
                        got += n;
                    }
                    if (got < buf.Length) Array.Resize(ref buf, got);
                    return buf;
                }
            }
            catch { return new byte[0]; }
        }
    }
}
