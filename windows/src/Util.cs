// Small helpers shared by the whole app: logging, JSON, formatting, file names, P/Invoke, icons.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace Beam
{
    // beam.log (1 MB, one old copy). Never log message text, keys or tokens: only ids, kinds and states.
    static class Log
    {
        static readonly object sync = new object();
        public static string FilePath;

        public static void Write(string message)
        {
            try
            {
                lock (sync)
                {
                    if (FilePath == null) return;
                    var info = new FileInfo(FilePath);
                    if (info.Exists && info.Length > 1024 * 1024)
                    {
                        File.Copy(FilePath, FilePath + ".old", true);
                        File.Delete(FilePath);
                    }
                    string line = (message ?? "").Replace("\r", " ").Replace("\n", " / ");
                    File.AppendAllText(FilePath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture) + "  " + line + Environment.NewLine, new UTF8Encoding(false));
                }
            }
            catch { }
        }

        public static void Error(string context, Exception ex)
        {
            Write(context + ": " + (ex == null ? "?" : ex.GetType().Name + ": " + ex.Message + (ex.InnerException != null ? " / " + ex.InnerException.Message : "")));
        }
    }

    // Timing lines for test/perf/windows-perf.ps1: "Perf: <what> <ms> ms". A handful per start and window open.
    static class Perf
    {
        static readonly DateTime started = StartTime();

        static DateTime StartTime()
        {
            try { return System.Diagnostics.Process.GetCurrentProcess().StartTime; }
            catch { return DateTime.Now; }
        }

        public static long SinceStart { get { return (long)(DateTime.Now - started).TotalMilliseconds; } }

        public static void Mark(string what, long ms)
        {
            Log.Write("Perf: " + what + " " + ms + " ms");
        }
    }

    // Short calls that must reach the server before Beam exits (taking back a sign-in request, signing out).
    // They must not need the UI thread (ConfigureAwait(false) all the way) and must not throw.
    static class Pending
    {
        static readonly List<System.Threading.Tasks.Task> tasks = new List<System.Threading.Tasks.Task>();

        public static void Add(System.Threading.Tasks.Task task)
        {
            if (task == null) return;
            lock (tasks)
            {
                tasks.RemoveAll(t => t.IsCompleted);
                tasks.Add(task);
            }
        }

        // Called once the UI has shut down: waits a little for what's still in flight.
        public static void Wait(int ms)
        {
            System.Threading.Tasks.Task[] open;
            lock (tasks) open = tasks.FindAll(t => !t.IsCompleted).ToArray();
            if (open.Length == 0) return;
            try { System.Threading.Tasks.Task.WaitAll(open, ms); } catch { }
        }
    }

    static class Json
    {
        static JavaScriptSerializer Serializer()
        {
            var s = new JavaScriptSerializer();
            s.MaxJsonLength = int.MaxValue;
            s.RecursionLimit = 64;
            return s;
        }

        public static object Parse(string json)
        {
            if (string.IsNullOrEmpty(json)) return null;
            return Serializer().DeserializeObject(json);
        }

        public static Dictionary<string, object> ParseObject(string json)
        {
            try { return Parse(json) as Dictionary<string, object>; }
            catch { return null; }
        }

        public static string Stringify(object value)
        {
            return Serializer().Serialize(value);
        }

        public static Dictionary<string, object> Obj(object value)
        {
            return value as Dictionary<string, object>;
        }

        public static object Get(IDictionary<string, object> d, string key)
        {
            object v;
            if (d == null || !d.TryGetValue(key, out v)) return null;
            return v;
        }

        public static string Str(IDictionary<string, object> d, string key)
        {
            object v = Get(d, key);
            if (v == null) return null;
            return v as string ?? Convert.ToString(v, CultureInfo.InvariantCulture);
        }

        public static long Long(IDictionary<string, object> d, string key, long fallback)
        {
            object v = Get(d, key);
            if (v == null) return fallback;
            try { return Convert.ToInt64(v, CultureInfo.InvariantCulture); }
            catch { return fallback; }
        }

        public static bool Bool(IDictionary<string, object> d, string key, bool fallback)
        {
            object v = Get(d, key);
            if (v is bool) return (bool)v;
            return fallback;
        }

        public static List<string> StrList(IDictionary<string, object> d, string key)
        {
            var list = new List<string>();
            var arr = Get(d, key) as IEnumerable;
            if (arr == null || arr is string) return list;
            foreach (object o in arr) if (o != null) list.Add(Convert.ToString(o, CultureInfo.InvariantCulture));
            return list;
        }

        public static Dictionary<string, long> LongMap(IDictionary<string, object> d, string key)
        {
            var map = new Dictionary<string, long>();
            var o = Get(d, key) as Dictionary<string, object>;
            if (o == null) return map;
            foreach (var kv in o)
            {
                try { map[kv.Key] = Convert.ToInt64(kv.Value, CultureInfo.InvariantCulture); } catch { }
            }
            return map;
        }

        // Indented JSON for files people may open (config.json).
        public static string Pretty(object value)
        {
            var sb = new StringBuilder();
            WritePretty(sb, value, 0);
            return sb.ToString();
        }

        static void WritePretty(StringBuilder sb, object value, int depth)
        {
            var dict = value as IDictionary<string, object>;
            var list = value as IList;
            string pad = new string(' ', (depth + 1) * 2);
            string end = new string(' ', depth * 2);
            if (dict != null)
            {
                if (dict.Count == 0) { sb.Append("{}"); return; }
                sb.Append("{\n");
                int i = 0;
                foreach (var kv in dict)
                {
                    sb.Append(pad).Append(Stringify(kv.Key)).Append(": ");
                    WritePretty(sb, kv.Value, depth + 1);
                    if (++i < dict.Count) sb.Append(',');
                    sb.Append('\n');
                }
                sb.Append(end).Append('}');
            }
            else if (list != null && !(value is string))
            {
                if (list.Count == 0) { sb.Append("[]"); return; }
                sb.Append('[');
                for (int i = 0; i < list.Count; i++)
                {
                    if (i > 0) sb.Append(", ");
                    WritePretty(sb, list[i], depth + 1);
                }
                sb.Append(']');
            }
            else sb.Append(Stringify(value));
        }
    }

    static class Fmt
    {
        static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);

        public static long NowMs()
        {
            return (long)(DateTime.UtcNow - Epoch).TotalMilliseconds;
        }

        public static string Size(long n)
        {
            if (n < 1024) return n + " B";
            string[] units = { "KB", "MB", "GB", "TB" };
            double v = n;
            int i = -1;
            do { v /= 1024; i++; } while (v >= 1024 && i < units.Length - 1);
            return (v < 10 ? v.ToString("0.0", CultureInfo.CurrentCulture) : Math.Round(v).ToString(CultureInfo.CurrentCulture)) + " " + units[i];
        }

        public static string OneLine(string text, int max)
        {
            if (text == null) return "";
            var sb = new StringBuilder();
            bool space = false;
            foreach (char c in text)
            {
                if (char.IsWhiteSpace(c)) { space = sb.Length > 0; continue; }
                if (space) { sb.Append(' '); space = false; }
                sb.Append(c);
                if (sb.Length >= max) { sb.Append('…'); break; }
            }
            return sb.ToString();
        }

        public static string Platform(string p)
        {
            switch (p)
            {
                case "windows": return "Windows";
                case "mac": return "Mac";
                case "linux": return "Linux";
                case "android": return "Android";
                case "ios": return "iPhone";
                case "web": return "Browser";
                case "cli": return "Command line";
                default: return string.IsNullOrEmpty(p) ? "Unknown" : p;
            }
        }

        // The whole message is one http(s) link (what a "link" notification means).
        public static bool IsLink(string text)
        {
            if (string.IsNullOrEmpty(text)) return false;
            string t = text.Trim();
            if (t.Length > 4000 || t.IndexOfAny(new[] { ' ', '\n', '\r', '\t' }) >= 0) return false;
            Uri u;
            return Uri.TryCreate(t, UriKind.Absolute, out u) && (u.Scheme == Uri.UriSchemeHttp || u.Scheme == Uri.UriSchemeHttps);
        }
    }

    static class FileUtil
    {
        static readonly string[] Reserved = { "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9" };

        // Opening these runs code: Beam shows them in their folder instead of opening them.
        static readonly HashSet<string> Executable = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            ".exe", ".com", ".bat", ".cmd", ".msi", ".msix", ".msixbundle", ".appx", ".appxbundle", ".msp", ".mst", ".ps1", ".psm1",
            ".psd1", ".ps1xml", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".ws", ".scr", ".pif", ".lnk", ".url", ".hta", ".cpl",
            ".reg", ".jar", ".application", ".appref-ms", ".gadget", ".inf", ".msc", ".scf", ".settingcontent-ms", ".diagcab",
            ".library-ms", ".search-ms", ".sys", ".dll", ".ocx", ".chm", ".vb", ".xll", ".xlam", ".ppam", ".iqy", ".slk", ".website",
            // (disk images mount and hide what they hold; installers, themes, scriptlets and web archives run or fetch)
            ".iso", ".img", ".vhd", ".vhdx", ".appinstaller", ".searchconnector-ms", ".theme", ".themepack",
            ".desktopthemepackfile", ".wsc", ".sct", ".xbap", ".mht", ".mhtml"
        };

        public static bool IsExecutable(string path)
        {
            return Executable.Contains(Path.GetExtension(path ?? "") ?? "");
        }

        public static string SafeName(string name)
        {
            name = name ?? "";
            int slash = Math.Max(name.LastIndexOf('/'), name.LastIndexOf('\\'));
            if (slash >= 0) name = name.Substring(slash + 1);
            var invalid = new HashSet<char>(Path.GetInvalidFileNameChars());
            var sb = new StringBuilder();
            foreach (char c in name)
            {
                // Bidi controls can disguise an extension ("photo‮gpj.exe").
                if (c >= '‪' && c <= '‮' || c >= '⁦' && c <= '⁩' || c == '‎' || c == '‏' || c == '؜') continue;
                sb.Append(invalid.Contains(c) || c < 32 ? '_' : c);
            }
            name = sb.ToString().Trim().Trim('.').Trim();
            if (name.Length > 180) name = name.Substring(0, 180);
            string stem = name.Split('.')[0].ToUpperInvariant();
            if (Array.IndexOf(Reserved, stem) >= 0) name = "_" + name;
            return name.Length == 0 ? "file" : name;
        }

        // photo.jpg -> photo (1).jpg -> photo (2).jpg ...
        public static string UniquePath(string folder, string name)
        {
            string path = Path.Combine(folder, name);
            if (!File.Exists(path) && !Directory.Exists(path)) return path;
            string ext = Path.GetExtension(name);
            string stem = Path.GetFileNameWithoutExtension(name);
            if (ext.Length > 12 || ext.Length == name.Length) { stem = name; ext = ""; }
            for (int i = 1; ; i++)
            {
                path = Path.Combine(folder, stem + " (" + i + ")" + ext);
                if (!File.Exists(path) && !Directory.Exists(path)) return path;
            }
        }

        public static string DownloadsFolder()
        {
            try
            {
                Guid downloads = new Guid("374DE290-123F-4565-9164-39C4925E467B");
                IntPtr p;
                if (Native.SHGetKnownFolderPath(ref downloads, 0, IntPtr.Zero, out p) == 0)
                {
                    string s = Marshal.PtrToStringUni(p);
                    Marshal.FreeCoTaskMem(p);
                    if (!string.IsNullOrEmpty(s)) return s;
                }
            }
            catch { }
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");
        }

        public static string MimeFor(string name)
        {
            string ext = Path.GetExtension(name ?? "").ToLowerInvariant();
            try
            {
                if (ext.Length > 1)
                {
                    using (var key = Registry.ClassesRoot.OpenSubKey(ext))
                    {
                        string type = key == null ? null : key.GetValue("Content Type") as string;
                        if (!string.IsNullOrEmpty(type) && type.IndexOf('/') > 0) return type;
                    }
                }
            }
            catch { }
            return "application/octet-stream";
        }

        // Marks a received file as coming from another computer ("Mark of the Web"), so Windows asks before
        // running it and Office opens it in Protected View.
        public static void MarkFromInternet(string path, string referrer)
        {
            try
            {
                string text = "[ZoneTransfer]\r\nZoneId=3\r\n" + (string.IsNullOrEmpty(referrer) ? "" : "ReferrerUrl=" + referrer + "\r\n");
                var bytes = Encoding.ASCII.GetBytes(text);
                using (var h = Native.CreateFile(path + ":Zone.Identifier", 0x40000000 /*GENERIC_WRITE*/, 0, IntPtr.Zero, 2 /*CREATE_ALWAYS*/, 0x80, IntPtr.Zero))
                {
                    if (h.IsInvalid) return;
                    using (var fs = new FileStream(h, FileAccess.Write)) fs.Write(bytes, 0, bytes.Length);
                }
            }
            catch (Exception ex) { Log.Error("Mark of the Web", ex); }
        }

        // Selects the file in an Explorer window (reusing an open one), or opens its folder.
        // Test instances (custom --config with testOffscreen) never open windows of other apps on this desktop.
        static bool TestInstance(string what)
        {
            if (!Ui.TestOffscreen) return false;
            Log.Write("Test instance: not opening " + what);
            return true;
        }

        public static void ShowInFolder(string path)
        {
            if (TestInstance("Explorer")) return;
            try
            {
                if (File.Exists(path) || Directory.Exists(path))
                {
                    IntPtr pidl = Native.ILCreateFromPathW(path);
                    if (pidl != IntPtr.Zero)
                    {
                        try { if (Native.SHOpenFolderAndSelectItems(pidl, 0, IntPtr.Zero, 0) == 0) return; }
                        finally { Native.ILFree(pidl); }
                    }
                    System.Diagnostics.Process.Start("explorer.exe", "/select,\"" + path + "\"");
                }
                else if (Directory.Exists(Path.GetDirectoryName(path))) System.Diagnostics.Process.Start("explorer.exe", "\"" + Path.GetDirectoryName(path) + "\"");
            }
            catch (Exception ex) { Log.Error("ShowInFolder", ex); }
        }

        public static void OpenFolder(string folder)
        {
            if (TestInstance("a folder")) return;
            try
            {
                Directory.CreateDirectory(folder);
                System.Diagnostics.Process.Start("explorer.exe", "\"" + folder + "\"");
            }
            catch (Exception ex) { Log.Error("OpenFolder", ex); }
        }

        // Opens a file the user asked to open. Never called automatically; executables are only shown.
        public static void Open(string path)
        {
            if (IsExecutable(path)) { ShowInFolder(path); return; }
            if (TestInstance("a file")) return;
            try
            {
                var psi = new System.Diagnostics.ProcessStartInfo(path);
                psi.UseShellExecute = true;
                System.Diagnostics.Process.Start(psi);
            }
            catch (Exception ex) { Log.Error("Open", ex); ShowInFolder(path); }
        }

        public static void OpenUrl(string url)
        {
            Uri u;
            if (!Uri.TryCreate(url ?? "", UriKind.Absolute, out u)) return;
            if (u.Scheme != Uri.UriSchemeHttp && u.Scheme != Uri.UriSchemeHttps && u.Scheme != Uri.UriSchemeMailto) return;
            if (TestInstance("a link")) return;
            try
            {
                var psi = new System.Diagnostics.ProcessStartInfo(u.AbsoluteUri);
                psi.UseShellExecute = true;
                System.Diagnostics.Process.Start(psi);
            }
            catch (Exception ex) { Log.Error("Open link", ex); }
        }

        public static void TryDelete(string path)
        {
            try { if (path != null && File.Exists(path)) File.Delete(path); } catch { }
        }
    }

    static class Native
    {
        public const int WM_HOTKEY = 0x0312;
        public const int WM_DPICHANGED = 0x02E0;
        public const uint MOD_ALT = 0x1, MOD_CONTROL = 0x2, MOD_SHIFT = 0x4, MOD_WIN = 0x8, MOD_NOREPEAT = 0x4000;

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll")]
        public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern bool AllowSetForegroundWindow(int processId);

        [DllImport("user32.dll")]
        public static extern uint GetClipboardSequenceNumber();

        [DllImport("user32.dll")]
        public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

        [DllImport("user32.dll")]
        public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

        [DllImport("dwmapi.dll")]
        public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        [DllImport("uxtheme.dll", CharSet = CharSet.Unicode)]
        public static extern int SetWindowTheme(IntPtr hwnd, string appName, string idList);

        [DllImport("shell32.dll")]
        public static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr ILCreateFromPathW(string path);

        [DllImport("shell32.dll")]
        public static extern void ILFree(IntPtr pidl);

        [DllImport("shell32.dll")]
        public static extern int SHOpenFolderAndSelectItems(IntPtr pidlFolder, uint cidl, IntPtr apidl, uint flags);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        public static extern IntPtr LoadLibrary(string path);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }
    }

    // Builds crisp multi-size icons from the 256px PNG embedded in the exe.
    static class AppIcon
    {
        static Bitmap master;
        static byte[] multi;

        public static Bitmap Master
        {
            get
            {
                if (master == null) master = LoadMaster();
                return master;
            }
        }

        static Bitmap LoadMaster()
        {
            try
            {
                using (var s = typeof(AppIcon).Assembly.GetManifestResourceStream("Beam.icon.ico"))
                {
                    var data = new byte[s.Length];
                    s.Read(data, 0, data.Length);
                    int count = BitConverter.ToUInt16(data, 4);
                    int best = -1, bestSize = 0;
                    for (int i = 0; i < count; i++)
                    {
                        int w = data[6 + i * 16];
                        if (w == 0) w = 256;
                        if (w > bestSize) { bestSize = w; best = i; }
                    }
                    int size = BitConverter.ToInt32(data, 6 + best * 16 + 8);
                    int offset = BitConverter.ToInt32(data, 6 + best * 16 + 12);
                    if (data[offset] == 0x89 && data[offset + 1] == (byte)'P')
                    {
                        using (var ms = new MemoryStream(data, offset, size))
                        using (var img = Image.FromStream(ms))
                            return new Bitmap(img);
                    }
                    using (var ms = new MemoryStream(data))
                    using (var ico = new Icon(ms, 256, 256))
                        return ico.ToBitmap();
                }
            }
            catch (Exception ex)
            {
                Log.Error("Icon", ex);
                var bmp = new Bitmap(64, 64);
                using (var g = Graphics.FromImage(bmp)) g.Clear(Color.FromArgb(0x5A, 0x4B, 0xF0));
                return bmp;
            }
        }

        public static Bitmap Scaled(int size)
        {
            var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(bmp))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.SmoothingMode = SmoothingMode.HighQuality;
                g.DrawImage(Master, new Rectangle(0, 0, size, size));
            }
            return bmp;
        }

        static byte[] Multi()
        {
            if (multi != null) return multi;
            var list = new List<Bitmap>();
            foreach (int s in new[] { 16, 20, 24, 32, 40, 48, 64, 128 }) list.Add(Scaled(s));
            multi = BuildIco(list);
            foreach (var b in list) b.Dispose();
            return multi;
        }

        public static Icon Window()
        {
            return new Icon(new MemoryStream(Multi()));
        }

        public static Icon Sized(int size)
        {
            return new Icon(new MemoryStream(Multi()), size, size);
        }

        // Tray icon, optionally with an unread dot.
        public static Icon Tray(bool dot, Color dotColor)
        {
            int size = System.Windows.Forms.SystemInformation.SmallIconSize.Width;
            if (!dot) return Sized(size);
            using (var bmp = Scaled(size))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    float d = size * 0.46f;
                    var r = new RectangleF(size - d - 0.5f, size - d - 0.5f, d, d);
                    using (var b = new SolidBrush(dotColor)) g.FillEllipse(b, r);
                    using (var p = new Pen(Color.White, Math.Max(1f, size / 16f))) g.DrawEllipse(p, r);
                }
                return new Icon(new MemoryStream(BuildIco(new List<Bitmap> { bmp })), size, size);
            }
        }

        // Writes an .ico with 32-bit DIB images (alpha preserved).
        public static byte[] BuildIco(List<Bitmap> images)
        {
            var ms = new MemoryStream();
            var w = new BinaryWriter(ms);
            w.Write((short)0); w.Write((short)1); w.Write((short)images.Count);
            var blobs = new List<byte[]>();
            foreach (var bmp in images) blobs.Add(Dib(bmp));
            int offset = 6 + 16 * images.Count;
            for (int i = 0; i < images.Count; i++)
            {
                int size = images[i].Width;
                w.Write((byte)(size >= 256 ? 0 : size));
                w.Write((byte)(size >= 256 ? 0 : size));
                w.Write((byte)0); w.Write((byte)0);
                w.Write((short)1); w.Write((short)32);
                w.Write(blobs[i].Length);
                w.Write(offset);
                offset += blobs[i].Length;
            }
            foreach (var b in blobs) w.Write(b);
            w.Flush();
            return ms.ToArray();
        }

        static byte[] Dib(Bitmap bmp)
        {
            int w = bmp.Width, h = bmp.Height;
            int maskStride = ((w + 31) / 32) * 4;
            var ms = new MemoryStream();
            var bw = new BinaryWriter(ms);
            bw.Write(40); bw.Write(w); bw.Write(h * 2); bw.Write((short)1); bw.Write((short)32);
            bw.Write(0); bw.Write(w * h * 4 + maskStride * h); bw.Write(0); bw.Write(0); bw.Write(0); bw.Write(0);
            var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            var px = new byte[data.Stride * h];
            Marshal.Copy(data.Scan0, px, 0, px.Length);
            bmp.UnlockBits(data);
            for (int y = h - 1; y >= 0; y--) bw.Write(px, y * data.Stride, w * 4);
            var mask = new byte[maskStride];
            for (int y = h - 1; y >= 0; y--)
            {
                Array.Clear(mask, 0, mask.Length);
                for (int x = 0; x < w; x++)
                    if (px[y * data.Stride + x * 4 + 3] == 0) mask[x / 8] |= (byte)(0x80 >> (x % 8));
                bw.Write(mask);
            }
            bw.Flush();
            return ms.ToArray();
        }
    }
}
