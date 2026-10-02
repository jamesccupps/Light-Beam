// Image size and a small JPEG preview for images this PC sends (API v3 `w`/`h` and PUT /api/items/{id}/thumb),
// so every device can show the picture without downloading the whole file.
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;

namespace Beam
{
    static class Thumbnail
    {
        static readonly string[] Images = { ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tif", ".tiff" };

        public static bool IsImage(string name)
        {
            return Images.Contains((Path.GetExtension(name ?? "") ?? "").ToLowerInvariant());
        }

        static int Orientation(Image img)
        {
            try
            {
                foreach (var p in img.PropertyItems)
                    if (p.Id == 0x0112 && p.Value != null && p.Value.Length >= 2) return BitConverter.ToUInt16(p.Value, 0);
            }
            catch { }
            return 1;
        }

        // Pixel size as shown (EXIF rotation applied). Reads only the header.
        public static bool Dimensions(string path, out int w, out int h)
        {
            w = h = 0;
            if (path == null || !IsImage(path)) return false;
            try
            {
                using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (var img = Image.FromStream(fs, false, false))
                {
                    bool sideways = Orientation(img) >= 5;
                    w = sideways ? img.Height : img.Width;
                    h = sideways ? img.Width : img.Height;
                    return w > 0 && h > 0;
                }
            }
            catch { return false; }
        }

        // A JPEG whose longer side is at most maxSide, under maxBytes, or null.
        public static byte[] Jpeg(string path, int maxSide, int maxBytes)
        {
            var info = new FileInfo(path);
            if (!info.Exists || info.Length == 0 || info.Length > 200L * 1024 * 1024) return null;
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            using (var src = Image.FromStream(fs, false, false))
            {
                int orientation = Orientation(src);
                bool sideways = orientation >= 5 && orientation <= 8;
                int w = sideways ? src.Height : src.Width, h = sideways ? src.Width : src.Height;
                double scale = Math.Min(1.0, (double)maxSide / Math.Max(w, h));
                int tw = Math.Max(1, (int)Math.Round(w * scale)), th = Math.Max(1, (int)Math.Round(h * scale));
                int dw = sideways ? th : tw, dh = sideways ? tw : th;
                using (var bmp = new Bitmap(dw, dh, PixelFormat.Format24bppRgb))
                {
                    using (var g = Graphics.FromImage(bmp))
                    {
                        g.Clear(Color.White); // transparent PNGs become white, not black
                        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                        g.DrawImage(src, new Rectangle(0, 0, dw, dh));
                    }
                    switch (orientation)
                    {
                        case 2: bmp.RotateFlip(RotateFlipType.RotateNoneFlipX); break;
                        case 3: bmp.RotateFlip(RotateFlipType.Rotate180FlipNone); break;
                        case 4: bmp.RotateFlip(RotateFlipType.Rotate180FlipX); break;
                        case 5: bmp.RotateFlip(RotateFlipType.Rotate90FlipX); break;
                        case 6: bmp.RotateFlip(RotateFlipType.Rotate90FlipNone); break;
                        case 7: bmp.RotateFlip(RotateFlipType.Rotate270FlipX); break;
                        case 8: bmp.RotateFlip(RotateFlipType.Rotate270FlipNone); break;
                    }
                    var codec = ImageCodecInfo.GetImageEncoders().FirstOrDefault(c => c.FormatID == ImageFormat.Jpeg.Guid);
                    foreach (long quality in new long[] { 82, 70, 55, 40 })
                    {
                        using (var ms = new MemoryStream())
                        using (var ps = new EncoderParameters(1))
                        {
                            ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
                            bmp.Save(ms, codec, ps);
                            if (ms.Length <= maxBytes) return ms.ToArray();
                        }
                    }
                }
            }
            return null;
        }
    }
}
