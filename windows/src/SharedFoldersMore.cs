// (Windows app 1.20, Beam 1.28) Shared folders more like Explorer (the user, 2026-10-15: "we should add like windows type
// things to it like preview and sort and everything"): this PC's own icon for each file type, thumbnails, one file's
// preview, a search in a folder and its subfolders, and whole folders in a copy (a .zip of what the folder shows). The
// same rules as a listing (SharedFolders.cs): only folders shared with the asker, only what's shown there, read-only.
// Pictures and videos come from Windows' own thumbnails (the Shell, on a thread of their own, below normal priority);
// a file in the cloud (OneDrive's placeholders) only from what Windows already has, never downloaded for a thumbnail.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

namespace Beam
{
    static partial class Shares
    {
        const int MaxThumbs = 24, MaxThumbPx = 256, MaxIcons = 64, MaxResults = 300, MaxLooked = 50000;
        const int TextBytes = 256 * 1024, PictureBytes = 4 * 1024 * 1024, PdfBytes = 10 * 1024 * 1024, PreviewPx = 2048, FramePx = 1280;
        const int ZipFiles = 10000;
        const long ZipBytes = 8L << 30;
        const uint Offline = 0x1000, RecallOnOpen = 0x40000, RecallOnDataAccess = 0x400000; // (in the cloud: not on this PC yet)
        static readonly TimeSpan Budget = TimeSpan.FromSeconds(8); // (the server waits 15 s for an answer)
        static readonly Dictionary<string, string> WebPictures = new Dictionary<string, string>
        {
            { ".jpg", "image/jpeg" }, { ".jpeg", "image/jpeg" }, { ".jfif", "image/jpeg" }, { ".png", "image/png" }, { ".gif", "image/gif" }, { ".webp", "image/webp" },
        };
        static readonly string[] OtherPictures = { ".bmp", ".tif", ".tiff", ".heic", ".heif", ".avif", ".ico", ".dng", ".cr2", ".nef", ".arw" };
        static readonly string[] Videos = { ".mp4", ".mov", ".m4v", ".avi", ".mkv", ".wmv", ".webm", ".mpg", ".mpeg", ".3gp", ".mts", ".m2ts" };
        // (already compressed: stored as they are in a .zip, which is faster and no bigger)
        static readonly string[] Packed = { ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".avif", ".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".wmv",
            ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".zip", ".7z", ".rar", ".gz", ".bz2", ".xz", ".zst", ".docx", ".xlsx", ".pptx", ".msi", ".cab" };
        static readonly Dictionary<string, string[]> iconCache = new Dictionary<string, string[]>(); // file type -> its icon (PNG, base64), its name

        static string Ext(string name) { return (System.IO.Path.GetExtension(name ?? "") ?? "").ToLowerInvariant(); }
        static bool InCloud(Entry e) { return (e.Attributes & (Offline | RecallOnOpen | RecallOnDataAccess)) != 0; }

        // The shared folder asked for when it's one shared with the asker; else null, and the answer says no.
        static SharedFolder Asked(App app, Dictionary<string, object> answer, string by, string byName, string share)
        {
            var f = Visible(app, by).FirstOrDefault(x => x.Id == share);
            if (f == null || by == app.Me) No(answer, "not-shared", "That folder isn't shared with " + byName);
            return f;
        }

        // `name` inside the folder `dir`: one step, or (from a search) steps through folders that are shown, like "2026/a.jpg".
        // Its full path and entry, or null.
        static string Inside(string dir, string name, out Entry e)
        {
            e = null;
            var steps = (name ?? "").Split(new[] { '/', '\\' }, StringSplitOptions.RemoveEmptyEntries);
            if (steps.Length == 0) return null;
            string cur = dir;
            for (int i = 0; i < steps.Length; i++)
            {
                if (!NameOk(steps[i])) return null;
                var x = One(cur + "\\" + steps[i]);
                if (x == null || !Shown(x) || (i < steps.Length - 1 && !x.Dir)) return null;
                cur = cur + "\\" + x.Name;
                e = x;
            }
            return cur;
        }

        static Task<T> OnSta<T>(Func<T> work)
        {
            var done = new TaskCompletionSource<T>();
            var t = new Thread(() => { try { done.SetResult(work()); } catch (Exception ex) { done.SetException(ex); } });
            t.IsBackground = true;
            t.Priority = ThreadPriority.BelowNormal;
            t.SetApartmentState(ApartmentState.STA); // (the Shell's thumbnail makers want one)
            t.Start();
            return done.Task;
        }

        static Dictionary<string, object> Start(Dictionary<string, object> d)
        {
            var answer = new Dictionary<string, object>();
            answer["id"] = Json.Str(d, "id");
            return answer;
        }

        // ------------------------------------------------------------------ `files-icons`: this PC's icon per file type

        public static async void OnIcons(App app, Dictionary<string, object> d)
        {
            string id = Json.Str(d, "id"), by = Json.Str(d, "by"), byName = Json.Str(d, "byName") ?? "A device";
            if (app.Api == null || string.IsNullOrEmpty(id)) return;
            var answer = Start(d);
            try
            {
                var exts = Json.StrList(d, "exts").Where(x => x == "/" || (x.Length > 1 && x.Length <= 17 && x[0] == '.' && x.Skip(1).All(c => char.IsLetterOrDigit(c) || c == '_' || c == '+' || c == '-')))
                    .Select(x => x.ToLowerInvariant()).Distinct().Take(MaxIcons).ToList();
                if (Visible(app, by).Count == 0 || by == app.Me) No(answer, "not-shared", "Nothing here is shared with " + byName);
                else
                {
                    var icons = new Dictionary<string, object>();
                    var types = new Dictionary<string, object>();
                    await OnSta(() =>
                    {
                        foreach (var x in exts)
                        {
                            string[] got;
                            lock (iconCache) iconCache.TryGetValue(x, out got);
                            if (got == null) { got = TypeIcon(x); lock (iconCache) iconCache[x] = got; }
                            if (got[0] != null) icons[x] = got[0];
                            if (!string.IsNullOrEmpty(got[1])) types[x] = got[1];
                        }
                        return true;
                    });
                    answer["ok"] = true;
                    answer["icons"] = icons;
                    answer["types"] = types;
                }
            }
            catch (Exception ex) { No(answer, "error", "This PC couldn't find those icons"); Log.Error("Shared folders", ex); }
            await Answer(app, answer);
        }

        // ------------------------------------------------------------------ `files-thumbs`: Windows' thumbnails

        public static async void OnThumbs(App app, Dictionary<string, object> d)
        {
            string id = Json.Str(d, "id"), by = Json.Str(d, "by"), byName = Json.Str(d, "byName") ?? "A device";
            string share = Json.Str(d, "share") ?? "", rel = Json.Str(d, "path") ?? "";
            var names = Json.StrList(d, "names").Distinct().Take(MaxThumbs).ToList();
            int px = Math.Max(32, Math.Min(MaxThumbPx, (int)Json.Long(d, "px", 160)));
            if (app.Api == null || string.IsNullOrEmpty(id)) return;
            var answer = Start(d);
            try
            {
                var f = Asked(app, answer, by, byName, share);
                if (f != null)
                {
                    string norm;
                    string dir = await Task.Run(() => Resolve(f, rel, out norm));
                    if (dir == null) No(answer, "not-found", "That folder isn't there");
                    else
                    {
                        var thumbs = new Dictionary<string, object>();
                        var none = new List<object>();
                        await OnSta(() =>
                        {
                            var clock = Stopwatch.StartNew();
                            foreach (var n in names)
                            {
                                if (clock.Elapsed > Budget) break; // (the rest: asked again)
                                Entry e;
                                string file = Inside(dir, n, out e);
                                byte[] jpeg = null;
                                if (file != null && !e.Dir)
                                {
                                    using (var bmp = ShellImage(file, px, ThumbnailOnly | (InCloud(e) ? InCacheOnly : 0)))
                                        if (bmp != null) jpeg = JpegOf(bmp, px, 75, 90 * 1024);
                                }
                                if (jpeg != null) thumbs[n] = Convert.ToBase64String(jpeg);
                                else none.Add(n);
                            }
                            return true;
                        });
                        answer["ok"] = true;
                        answer["thumbs"] = thumbs;
                        answer["none"] = none.ToArray();
                    }
                }
            }
            catch (Exception ex) { No(answer, "error", "This PC couldn't make those thumbnails"); Log.Error("Shared folders", ex); }
            await Answer(app, answer);
        }

        // ------------------------------------------------------------------ `files-preview`: one file to look at

        class Preview
        {
            public string Kind, Type;
            public byte[] Bytes;
            public bool Truncated;
        }

        public static async void OnPreview(App app, Dictionary<string, object> d)
        {
            string id = Json.Str(d, "id"), by = Json.Str(d, "by"), byName = Json.Str(d, "byName") ?? "A device";
            string share = Json.Str(d, "share") ?? "", rel = Json.Str(d, "path") ?? "", name = Json.Str(d, "name") ?? "";
            if (app.Api == null || string.IsNullOrEmpty(id)) return;
            var answer = Start(d);
            try
            {
                var f = Asked(app, answer, by, byName, share);
                if (f != null)
                {
                    string norm = "", file = null;
                    Entry e = null;
                    await Task.Run(() =>
                    {
                        string dir = Resolve(f, rel, out norm);
                        if (dir != null) file = Inside(dir, name, out e);
                    });
                    if (file == null || e.Dir) No(answer, "not-found", "That file isn't there");
                    else
                    {
                        var p = await OnSta(() => PreviewOf(file, e));
                        string where = f.Name + "\\" + (norm.Length > 0 ? norm.Replace('/', '\\') + "\\" : "") + name.Replace('/', '\\');
                        if (p == null) No(answer, "no-preview", "There's no preview for this kind of file: copy it to open it");
                        else
                        {
                            answer["ok"] = true;
                            answer["kind"] = p.Kind;
                            answer["type"] = p.Type;
                            answer["size"] = e.Size;
                            answer["data"] = Convert.ToBase64String(p.Bytes);
                            if (p.Truncated) answer["truncated"] = true;
                            Log.Write("Shared folders: " + byName + " previewed " + where + " (" + p.Kind + ", " + Fmt.Size(p.Bytes.Length) + ")");
                        }
                    }
                }
            }
            catch (Exception ex) { No(answer, "error", "This PC couldn't read that file"); Log.Error("Shared folders", ex); }
            await Answer(app, answer);
        }

        static Preview PreviewOf(string file, Entry e)
        {
            string ext = Ext(e.Name), type;
            if (WebPictures.TryGetValue(ext, out type) && e.Size <= PictureBytes) return new Preview { Kind = "picture", Type = type, Bytes = ReadStart(file, PictureBytes) };
            if (WebPictures.ContainsKey(ext) || OtherPictures.Contains(ext))
            {
                byte[] jpeg = null;
                try { if (Thumbnail.IsImage(e.Name)) jpeg = Thumbnail.Jpeg(file, PreviewPx, 3 * 1024 * 1024); } catch { }
                if (jpeg == null) jpeg = ShellJpeg(file, PreviewPx, 0);
                return jpeg == null ? null : new Preview { Kind = "picture", Type = "image/jpeg", Bytes = jpeg };
            }
            if (ext == ".pdf")
            {
                if (e.Size <= PdfBytes) return new Preview { Kind = "pdf", Type = "application/pdf", Bytes = ReadStart(file, PdfBytes) };
                var page = ShellJpeg(file, FramePx, ThumbnailOnly); // (too big to send: its first page, when Windows can draw it)
                return page == null ? null : new Preview { Kind = "picture", Type = "image/jpeg", Bytes = page };
            }
            if (Videos.Contains(ext))
            {
                var frame = ShellJpeg(file, FramePx, ThumbnailOnly);
                return frame == null ? null : new Preview { Kind = "video", Type = "image/jpeg", Bytes = frame };
            }
            var start = ReadStart(file, TextBytes);
            if (LooksText(start)) return new Preview { Kind = "text", Type = "text/plain", Bytes = start, Truncated = e.Size > start.Length };
            var shot = ShellJpeg(file, FramePx, ThumbnailOnly); // (anything else Windows has a thumbnail for)
            return shot == null ? null : new Preview { Kind = "picture", Type = "image/jpeg", Bytes = shot };
        }

        static byte[] ReadStart(string file, int max)
        {
            using (var fs = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                var buf = new byte[(int)Math.Min(max, fs.Length)];
                int got = 0, n;
                while (got < buf.Length && (n = fs.Read(buf, got, buf.Length - got)) > 0) got += n;
                if (got < buf.Length) Array.Resize(ref buf, got);
                return buf;
            }
        }

        // Text, roughly: a byte-order mark, or no zero bytes (or UTF-16's, every other byte). The page decides the rest.
        static bool LooksText(byte[] b)
        {
            if (b.Length >= 2 && ((b[0] == 0xFF && b[1] == 0xFE) || (b[0] == 0xFE && b[1] == 0xFF))) return true;
            if (b.Length >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF) return true;
            int n = Math.Min(b.Length, 4096), even = 0, odd = 0;
            for (int i = 0; i < n; i++) if (b[i] == 0) { if (i % 2 == 0) even++; else odd++; }
            if (even + odd == 0) return true;
            return (odd > n / 2 * 0.3 && even < n / 2 * 0.05) || (even > n / 2 * 0.3 && odd < n / 2 * 0.05);
        }

        // ------------------------------------------------------------------ `files-search`: names in a folder and below

        public static async void OnSearch(App app, Dictionary<string, object> d)
        {
            string id = Json.Str(d, "id"), by = Json.Str(d, "by"), byName = Json.Str(d, "byName") ?? "A device";
            string share = Json.Str(d, "share") ?? "", rel = Json.Str(d, "path") ?? "", q = (Json.Str(d, "q") ?? "").Trim();
            if (app.Api == null || string.IsNullOrEmpty(id)) return;
            var answer = Start(d);
            try
            {
                var f = Asked(app, answer, by, byName, share);
                if (f != null)
                {
                    string norm = "";
                    bool more = false;
                    List<object> results = null;
                    int looked = 0;
                    await Task.Run(() =>
                    {
                        string dir = Resolve(f, rel, out norm);
                        if (dir == null || q.Length == 0) return;
                        results = new List<object>();
                        var clock = Stopwatch.StartNew();
                        var todo = new Queue<KeyValuePair<string, string>>(); // a folder on disk, its path inside `dir`
                        todo.Enqueue(new KeyValuePair<string, string>(dir, ""));
                        while (todo.Count > 0)
                        {
                            if (results.Count >= MaxResults || looked >= MaxLooked || clock.Elapsed > Budget) { more = true; break; }
                            var cur = todo.Dequeue();
                            foreach (var e in Read(cur.Key).Where(Shown).OrderBy(x => x.Name, StringComparer.CurrentCultureIgnoreCase))
                            {
                                looked++;
                                if (e.Dir) todo.Enqueue(new KeyValuePair<string, string>(cur.Key + "\\" + e.Name, cur.Value.Length > 0 ? cur.Value + "/" + e.Name : e.Name));
                                if (e.Name.IndexOf(q, StringComparison.CurrentCultureIgnoreCase) < 0) continue;
                                if (results.Count >= MaxResults) { more = true; break; }
                                var o = new Dictionary<string, object>();
                                o["p"] = cur.Value;
                                o["n"] = e.Name;
                                if (e.Dir) o["dir"] = true;
                                o["s"] = e.Dir ? 0 : e.Size;
                                o["m"] = e.Mtime;
                                results.Add(o);
                            }
                        }
                    });
                    if (results == null) No(answer, "not-found", "That folder isn't there");
                    else
                    {
                        answer["ok"] = true;
                        answer["results"] = results.ToArray();
                        if (more) answer["more"] = true;
                        Log.Write("Shared folders: " + byName + " searched " + f.Name + (norm.Length > 0 ? "\\" + norm.Replace('/', '\\') : "") + " for \"" + q + "\" (" + results.Count + (more ? "+" : "") + " of " + looked + ")");
                    }
                }
            }
            catch (Exception ex) { No(answer, "error", "This PC couldn't search that folder"); Log.Error("Shared folders", ex); }
            await Answer(app, answer);
        }

        // ------------------------------------------------------------------ whole folders in a copy

        // Why the folder can't go as one .zip, or null (counting what it shows: files, their bytes).
        static string ZipRefusal(string dir, string outgoing)
        {
            int files = 0;
            long bytes = 0;
            var todo = new Stack<string>();
            todo.Push(dir);
            while (todo.Count > 0)
            {
                string cur = todo.Pop();
                foreach (var e in Read(cur).Where(Shown))
                {
                    if (e.Dir) { todo.Push(cur + "\\" + e.Name); continue; }
                    files++;
                    bytes += e.Size;
                    if (files > ZipFiles || bytes > ZipBytes) return "too much for one .zip (over " + ZipFiles.ToString("N0") + " files or " + Fmt.Size(ZipBytes) + "): open it and copy its files";
                }
            }
            try
            {
                var drive = new DriveInfo(System.IO.Path.GetPathRoot(System.IO.Path.GetFullPath(outgoing)));
                if (drive.AvailableFreeSpace < bytes + (1L << 30)) return "not enough free space on this PC to zip it (" + Fmt.Size(bytes) + ")";
            }
            catch { }
            return null;
        }

        // A folder -> "<its name>.zip" in the outgoing folder, holding only what the folder shows (no hidden files, nothing
        // starting with ".", no links), its own folder first in every path. (On a worker thread, through SendFiles.)
        public static string ZipShown(string dir, string outFolder)
        {
            Directory.CreateDirectory(outFolder);
            string name = FileUtil.SafeName(System.IO.Path.GetFileName(dir.TrimEnd('\\')));
            if (name.Length == 0) name = "Folder";
            string dest = FileUtil.UniquePath(outFolder, name + ".zip"), part = System.IO.Path.GetFullPath(dest + ".part");
            FileUtil.TryDelete(part);
            int left = 0;
            using (var fs = new FileStream(part, FileMode.CreateNew))
            using (var zip = new ZipArchive(fs, ZipArchiveMode.Create))
            {
                var todo = new Stack<KeyValuePair<string, string>>(); // a folder on disk, its path in the .zip
                todo.Push(new KeyValuePair<string, string>(dir.TrimEnd('\\'), name));
                while (todo.Count > 0)
                {
                    var cur = todo.Pop();
                    var entries = Read(cur.Key).Where(Shown).ToList();
                    if (entries.Count == 0) zip.CreateEntry(cur.Value + "/");
                    foreach (var e in entries)
                    {
                        string disk = cur.Key + "\\" + e.Name, inZip = cur.Value + "/" + e.Name;
                        if (e.Dir) { todo.Push(new KeyValuePair<string, string>(disk, inZip)); continue; }
                        if (string.Equals(disk, part, StringComparison.OrdinalIgnoreCase)) continue; // (a folder holding the outgoing one: never this .zip itself)
                        try
                        {
                            using (var src = new FileStream(disk, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                            {
                                var entry = zip.CreateEntry(inZip, Packed.Contains(Ext(e.Name)) ? CompressionLevel.NoCompression : CompressionLevel.Fastest);
                                entry.LastWriteTime = ZipTime(e.Mtime);
                                using (var to = entry.Open()) src.CopyTo(to, 1 << 20);
                            }
                        }
                        catch (Exception ex) { left++; Log.Write("Shared folders: " + inZip + " left out of the .zip (" + ex.Message + ")"); }
                    }
                }
            }
            File.Move(part, dest);
            if (left > 0) Log.Write("Shared folders: " + name + ".zip made without " + left + " file(s) that couldn't be read");
            return dest;
        }

        static DateTimeOffset ZipTime(long ms)
        {
            DateTime t;
            try { t = Epoch.AddMilliseconds(ms).ToLocalTime(); } catch { t = DateTime.Now; }
            if (t.Year < 1980) t = new DateTime(1980, 1, 1);
            if (t.Year > 2107) t = new DateTime(2107, 12, 31);
            return new DateTimeOffset(t);
        }

        // ------------------------------------------------------------------ Windows' icons and thumbnails

        [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IShellItemImageFactory
        {
            [PreserveSig] int GetImage(NativeSize size, int flags, out IntPtr bitmap);
        }

        [StructLayout(LayoutKind.Sequential)]
        struct NativeSize { public int Width, Height; }

        [StructLayout(LayoutKind.Sequential)]
        struct NativeBitmap
        {
            public int Type, Width, Height, WidthBytes;
            public ushort Planes, BitsPixel;
            public IntPtr Bits;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct BitmapInfo
        {
            public uint biSize;
            public int biWidth, biHeight;
            public ushort biPlanes, biBitCount;
            public uint biCompression, biSizeImage;
            public int biXPelsPerMeter, biYPelsPerMeter;
            public uint biClrUsed, biClrImportant;
            public uint Color0, Color1, Color2; // (room for what GetDIBits may add)
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct ShFileInfo
        {
            public IntPtr Icon;
            public int IconIndex;
            public uint Attributes;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string DisplayName;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string TypeName;
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        static extern void SHCreateItemFromParsingName(string path, IntPtr bindCtx, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory item);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr SHGetFileInfoW(string path, uint attributes, ref ShFileInfo info, uint size, uint flags);
        [DllImport("shell32.dll")]
        static extern int SHGetImageList(int list, ref Guid riid, out IntPtr imageList);
        [DllImport("comctl32.dll")]
        static extern IntPtr ImageList_GetIcon(IntPtr imageList, int index, int flags);
        [DllImport("user32.dll")]
        static extern bool DestroyIcon(IntPtr icon);
        [DllImport("gdi32.dll")]
        static extern int GetObject(IntPtr h, int size, ref NativeBitmap bm);
        [DllImport("gdi32.dll")]
        static extern int GetDIBits(IntPtr dc, IntPtr hbm, uint start, uint lines, [Out] byte[] bits, ref BitmapInfo info, uint usage);
        [DllImport("gdi32.dll")]
        static extern IntPtr CreateCompatibleDC(IntPtr dc);
        [DllImport("gdi32.dll")]
        static extern bool DeleteDC(IntPtr dc);
        [DllImport("gdi32.dll")]
        static extern bool DeleteObject(IntPtr h);

        const int ThumbnailOnly = 0x8, InCacheOnly = 0x10;
        const uint SysIconIndex = 0x4000, TypeName = 0x400, UseFileAttributes = 0x10, NormalFile = 0x80, FolderAttribute = 0x10;
        const int ExtraLarge = 2; // (48 px)
        static Guid ImageListId = new Guid("46EB5926-582E-4017-9FDF-E8998DAA0950");

        // The icon Windows shows for a file type (".pdf"; "/" a folder), 48 px, as a PNG in base64, and the type's name
        // ("PDF Document"); either null. No file is touched.
        static string[] TypeIcon(string ext)
        {
            var got = new string[2];
            var info = new ShFileInfo();
            bool folder = ext == "/";
            if (SHGetFileInfoW(folder ? "folder" : "file" + ext, folder ? FolderAttribute : NormalFile, ref info, (uint)Marshal.SizeOf(typeof(ShFileInfo)), SysIconIndex | TypeName | UseFileAttributes) == IntPtr.Zero) return got;
            got[1] = info.TypeName;
            IntPtr list, icon = IntPtr.Zero;
            if (SHGetImageList(ExtraLarge, ref ImageListId, out list) != 0 || list == IntPtr.Zero) return got;
            try
            {
                icon = ImageList_GetIcon(list, info.IconIndex, 1); // (ILD_TRANSPARENT)
                if (icon == IntPtr.Zero) return got;
                using (var ic = Icon.FromHandle(icon))
                using (var bmp = ic.ToBitmap())
                using (var ms = new MemoryStream())
                {
                    bmp.Save(ms, ImageFormat.Png);
                    got[0] = Convert.ToBase64String(ms.ToArray());
                }
            }
            catch { }
            finally
            {
                if (icon != IntPtr.Zero) DestroyIcon(icon);
                Marshal.Release(list);
            }
            return got;
        }

        // Windows' own picture of a file (its thumbnail; with ThumbnailOnly never just its icon), its longer side about px.
        static Bitmap ShellImage(string file, int px, int flags)
        {
            IShellItemImageFactory item = null;
            IntPtr hbm = IntPtr.Zero;
            try
            {
                SHCreateItemFromParsingName(file, IntPtr.Zero, typeof(IShellItemImageFactory).GUID, out item);
                var size = new NativeSize();
                size.Width = px;
                size.Height = px;
                if (item.GetImage(size, flags, out hbm) != 0 || hbm == IntPtr.Zero) return null;
                return BitmapOf(hbm);
            }
            catch { return null; }
            finally
            {
                if (hbm != IntPtr.Zero) DeleteObject(hbm);
                if (item != null) Marshal.ReleaseComObject(item);
            }
        }

        // A copy of a Shell bitmap, the right way up (GDI's own reading of it, top-down: a fresh thumbnail comes top-down,
        // a cached one bottom-up, and their headers don't say), its alpha kept when it has one (else opaque).
        static Bitmap BitmapOf(IntPtr hbm)
        {
            var bm = new NativeBitmap();
            if (GetObject(hbm, Marshal.SizeOf(typeof(NativeBitmap)), ref bm) == 0) return null;
            int w = bm.Width, h = bm.Height;
            if (bm.BitsPixel != 32 || w <= 0 || h <= 0) return Image.FromHbitmap(hbm);
            var info = new BitmapInfo();
            info.biSize = 40;
            info.biWidth = w;
            info.biHeight = -h;
            info.biPlanes = 1;
            info.biBitCount = 32;
            var px = new byte[w * h * 4];
            IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
            int lines;
            try { lines = GetDIBits(dc, hbm, 0, (uint)h, px, ref info, 0); }
            finally { DeleteDC(dc); }
            if (lines != h) return Image.FromHbitmap(hbm);
            bool alpha = false;
            for (int i = 3; i < px.Length; i += 4) if (px[i] != 0) { alpha = true; break; }
            var bmp = new Bitmap(w, h, alpha ? PixelFormat.Format32bppPArgb : PixelFormat.Format32bppRgb);
            var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, bmp.PixelFormat);
            try { for (int y = 0; y < h; y++) Marshal.Copy(px, y * w * 4, data.Scan0 + y * data.Stride, w * 4); }
            finally { bmp.UnlockBits(data); }
            return bmp;
        }

        static byte[] ShellJpeg(string file, int px, int flags)
        {
            using (var bmp = ShellImage(file, px, flags)) return bmp == null ? null : JpegOf(bmp, px, 82, 3 * 1024 * 1024);
        }

        // A JPEG of the picture, its longer side at most maxSide, on white (no transparency in a JPEG), under maxBytes.
        static byte[] JpegOf(Image src, int maxSide, long quality, int maxBytes)
        {
            double scale = Math.Min(1.0, (double)maxSide / Math.Max(src.Width, src.Height));
            int w = Math.Max(1, (int)Math.Round(src.Width * scale)), h = Math.Max(1, (int)Math.Round(src.Height * scale));
            using (var bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.Clear(Color.White);
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    g.DrawImage(src, new Rectangle(0, 0, w, h));
                }
                var codec = ImageCodecInfo.GetImageEncoders().FirstOrDefault(c => c.FormatID == ImageFormat.Jpeg.Guid);
                for (long q = quality; q >= 40; q -= 15)
                {
                    using (var ms = new MemoryStream())
                    using (var ps = new EncoderParameters(1))
                    {
                        ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, q);
                        bmp.Save(ms, codec, ps);
                        if (ms.Length <= maxBytes) return ms.ToArray();
                    }
                }
            }
            return null;
        }
    }
}
