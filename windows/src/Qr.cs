// A compact QR code encoder (byte mode, versions 1-40, all error-correction levels, automatic mask),
// following ISO/IEC 18004, plus a control that draws one. Used to show sign-in codes without a server.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Text;
using System.Windows.Forms;

namespace Beam
{
    enum QrEcc { L = 0, M = 1, Q = 2, H = 3 }

    class QrCode
    {
        public readonly int Version;
        public readonly int Size;
        public readonly int Mask;
        readonly bool[,] modules;    // [y, x], true = dark
        readonly bool[,] isFunction;

        public bool this[int x, int y] { get { return modules[y, x]; } }

        static readonly int[,] EccPerBlock = {
            { -1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30 },
            { -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28 },
            { -1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30 },
            { -1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30 },
        };

        static readonly int[,] EccBlocks = {
            { -1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25 },
            { -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49 },
            { -1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68 },
            { -1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81 },
        };

        static readonly int[] FormatEccBits = { 1, 0, 3, 2 }; // L, M, Q, H

        // Encodes text as UTF-8 bytes in the smallest version that fits. mask -1 = pick the best.
        public static QrCode Encode(string text, QrEcc ecc, int mask)
        {
            byte[] data = Encoding.UTF8.GetBytes(text ?? "");
            int e = (int)ecc;
            for (int ver = 1; ver <= 40; ver++)
            {
                int capacityBits = DataCodewords(ver, e) * 8;
                int countBits = ver <= 9 ? 8 : 16;
                if (4 + countBits + data.Length * 8 <= capacityBits) return new QrCode(ver, e, data, mask);
            }
            throw new ArgumentException("Too much data for a QR code");
        }

        QrCode(int ver, int ecc, byte[] data, int mask)
        {
            Version = ver;
            Size = ver * 4 + 17;
            modules = new bool[Size, Size];
            isFunction = new bool[Size, Size];
            DrawFunctionPatterns(ecc);
            byte[] all = AddEccAndInterleave(Codewords(ver, ecc, data), ver, ecc);
            DrawCodewords(all);

            if (mask < 0)
            {
                int best = int.MaxValue;
                for (int m = 0; m < 8; m++)
                {
                    ApplyMask(m);
                    DrawFormatBits(ecc, m);
                    int penalty = Penalty();
                    if (penalty < best) { best = penalty; mask = m; }
                    ApplyMask(m); // XOR again undoes it
                }
            }
            Mask = mask;
            ApplyMask(mask);
            DrawFormatBits(ecc, mask);
        }

        // ------------------------------------------------------------------ data

        static int RawDataModules(int ver)
        {
            int result = (16 * ver + 128) * ver + 64;
            if (ver >= 2)
            {
                int numAlign = ver / 7 + 2;
                result -= (25 * numAlign - 10) * numAlign - 55;
                if (ver >= 7) result -= 36;
            }
            return result;
        }

        static int DataCodewords(int ver, int ecc)
        {
            return RawDataModules(ver) / 8 - EccPerBlock[ecc, ver] * EccBlocks[ecc, ver];
        }

        static byte[] Codewords(int ver, int ecc, byte[] data)
        {
            var bits = new List<bool>();
            Action<int, int> append = (value, len) => { for (int i = len - 1; i >= 0; i--) bits.Add(((value >> i) & 1) != 0); };
            append(4, 4); // byte mode
            append(data.Length, ver <= 9 ? 8 : 16);
            foreach (byte b in data) append(b, 8);
            int capacity = DataCodewords(ver, ecc) * 8;
            append(0, Math.Min(4, capacity - bits.Count));
            append(0, (8 - bits.Count % 8) % 8);
            for (int pad = 0xEC; bits.Count < capacity; pad ^= 0xEC ^ 0x11) append(pad, 8);
            var result = new byte[bits.Count / 8];
            for (int i = 0; i < bits.Count; i++) if (bits[i]) result[i >> 3] |= (byte)(0x80 >> (i & 7));
            return result;
        }

        static byte[] AddEccAndInterleave(byte[] data, int ver, int ecc)
        {
            int numBlocks = EccBlocks[ecc, ver];
            int blockEccLen = EccPerBlock[ecc, ver];
            int rawCodewords = RawDataModules(ver) / 8;
            int numShortBlocks = numBlocks - rawCodewords % numBlocks;
            int shortBlockLen = rawCodewords / numBlocks;
            byte[] divisor = RsDivisor(blockEccLen);
            var blocks = new List<byte[]>();
            for (int i = 0, k = 0; i < numBlocks; i++)
            {
                int datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
                var dat = new byte[datLen];
                Array.Copy(data, k, dat, 0, datLen);
                k += datLen;
                byte[] eccBytes = RsRemainder(dat, divisor);
                var block = new byte[shortBlockLen + 1];
                Array.Copy(dat, 0, block, 0, datLen);
                // Short blocks leave a gap at shortBlockLen - blockEccLen, skipped when interleaving.
                Array.Copy(eccBytes, 0, block, shortBlockLen + 1 - blockEccLen, blockEccLen);
                blocks.Add(block);
            }
            var result = new byte[rawCodewords];
            int n = 0;
            for (int i = 0; i < shortBlockLen + 1; i++)
                for (int j = 0; j < blocks.Count; j++)
                    if (i != shortBlockLen - blockEccLen || j >= numShortBlocks) result[n++] = blocks[j][i];
            return result;
        }

        static byte[] RsDivisor(int degree)
        {
            var result = new byte[degree];
            result[degree - 1] = 1;
            int root = 1;
            for (int i = 0; i < degree; i++)
            {
                for (int j = 0; j < result.Length; j++)
                {
                    result[j] = (byte)GfMul(result[j], root);
                    if (j + 1 < result.Length) result[j] ^= result[j + 1];
                }
                root = GfMul(root, 0x02);
            }
            return result;
        }

        static byte[] RsRemainder(byte[] data, byte[] divisor)
        {
            var result = new byte[divisor.Length];
            foreach (byte b in data)
            {
                int factor = b ^ result[0];
                Array.Copy(result, 1, result, 0, result.Length - 1);
                result[result.Length - 1] = 0;
                for (int i = 0; i < result.Length; i++) result[i] ^= (byte)GfMul(divisor[i], factor);
            }
            return result;
        }

        static int GfMul(int x, int y)
        {
            int z = 0;
            for (int i = 7; i >= 0; i--)
            {
                z = (z << 1) ^ ((z >> 7) * 0x11D);
                z ^= ((y >> i) & 1) * x;
            }
            return z & 0xFF;
        }

        // ------------------------------------------------------------------ drawing

        void SetFunction(int x, int y, bool dark)
        {
            modules[y, x] = dark;
            isFunction[y, x] = true;
        }

        void DrawFunctionPatterns(int ecc)
        {
            for (int i = 0; i < Size; i++)
            {
                SetFunction(6, i, i % 2 == 0);
                SetFunction(i, 6, i % 2 == 0);
            }
            DrawFinder(3, 3);
            DrawFinder(Size - 4, 3);
            DrawFinder(3, Size - 4);
            int[] pos = AlignmentPositions();
            int n = pos.Length;
            for (int i = 0; i < n; i++)
                for (int j = 0; j < n; j++)
                    if (!(i == 0 && j == 0 || i == 0 && j == n - 1 || i == n - 1 && j == 0)) DrawAlignment(pos[i], pos[j]);
            DrawFormatBits(ecc, 0); // reserves the area; redrawn once the mask is known
            DrawVersion();
        }

        int[] AlignmentPositions()
        {
            if (Version == 1) return new int[0];
            int numAlign = Version / 7 + 2;
            int step = (Version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4) * 2;
            var result = new int[numAlign];
            result[0] = 6;
            for (int i = numAlign - 1, p = Size - 7; i >= 1; i--, p -= step) result[i] = p;
            return result;
        }

        void DrawFinder(int x, int y)
        {
            for (int dy = -4; dy <= 4; dy++)
                for (int dx = -4; dx <= 4; dx++)
                {
                    int dist = Math.Max(Math.Abs(dx), Math.Abs(dy));
                    int xx = x + dx, yy = y + dy;
                    if (xx >= 0 && xx < Size && yy >= 0 && yy < Size) SetFunction(xx, yy, dist != 2 && dist != 4);
                }
        }

        void DrawAlignment(int x, int y)
        {
            for (int dy = -2; dy <= 2; dy++)
                for (int dx = -2; dx <= 2; dx++)
                    SetFunction(x + dx, y + dy, Math.Max(Math.Abs(dx), Math.Abs(dy)) != 1);
        }

        void DrawFormatBits(int ecc, int mask)
        {
            int data = FormatEccBits[ecc] << 3 | mask;
            int rem = data;
            for (int i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
            int bits = (data << 10 | rem) ^ 0x5412;
            for (int i = 0; i <= 5; i++) SetFunction(8, i, Bit(bits, i));
            SetFunction(8, 7, Bit(bits, 6));
            SetFunction(8, 8, Bit(bits, 7));
            SetFunction(7, 8, Bit(bits, 8));
            for (int i = 9; i < 15; i++) SetFunction(14 - i, 8, Bit(bits, i));
            for (int i = 0; i < 8; i++) SetFunction(Size - 1 - i, 8, Bit(bits, i));
            for (int i = 8; i < 15; i++) SetFunction(8, Size - 15 + i, Bit(bits, i));
            SetFunction(8, Size - 8, true);
        }

        void DrawVersion()
        {
            if (Version < 7) return;
            int rem = Version;
            for (int i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1F25);
            int bits = Version << 12 | rem;
            for (int i = 0; i < 18; i++)
            {
                bool bit = Bit(bits, i);
                int a = Size - 11 + i % 3, b = i / 3;
                SetFunction(a, b, bit);
                SetFunction(b, a, bit);
            }
        }

        static bool Bit(int x, int i)
        {
            return ((x >> i) & 1) != 0;
        }

        void DrawCodewords(byte[] data)
        {
            int i = 0;
            for (int right = Size - 1; right >= 1; right -= 2)
            {
                if (right == 6) right = 5;
                for (int vert = 0; vert < Size; vert++)
                {
                    for (int j = 0; j < 2; j++)
                    {
                        int x = right - j;
                        bool upward = ((right + 1) & 2) == 0;
                        int y = upward ? Size - 1 - vert : vert;
                        if (!isFunction[y, x] && i < data.Length * 8)
                        {
                            modules[y, x] = Bit(data[i >> 3], 7 - (i & 7));
                            i++;
                        }
                    }
                }
            }
        }

        void ApplyMask(int mask)
        {
            for (int y = 0; y < Size; y++)
                for (int x = 0; x < Size; x++)
                {
                    bool invert;
                    switch (mask)
                    {
                        case 0: invert = (x + y) % 2 == 0; break;
                        case 1: invert = y % 2 == 0; break;
                        case 2: invert = x % 3 == 0; break;
                        case 3: invert = (x + y) % 3 == 0; break;
                        case 4: invert = (x / 3 + y / 2) % 2 == 0; break;
                        case 5: invert = x * y % 2 + x * y % 3 == 0; break;
                        case 6: invert = (x * y % 2 + x * y % 3) % 2 == 0; break;
                        default: invert = ((x + y) % 2 + x * y % 3) % 2 == 0; break;
                    }
                    if (invert && !isFunction[y, x]) modules[y, x] = !modules[y, x];
                }
        }

        // Standard penalty rules N1-N4, used to pick the most readable mask.
        int Penalty()
        {
            int result = 0;
            for (int pass = 0; pass < 2; pass++)
            {
                for (int a = 0; a < Size; a++)
                {
                    bool runColor = false;
                    int runLen = 0;
                    var history = new int[7];
                    for (int b = 0; b < Size; b++)
                    {
                        bool m = pass == 0 ? modules[a, b] : modules[b, a];
                        if (m == runColor)
                        {
                            runLen++;
                            if (runLen == 5) result += 3;
                            else if (runLen > 5) result++;
                        }
                        else
                        {
                            AddHistory(runLen, history);
                            if (!runColor) result += FinderLike(history) * 40;
                            runColor = m;
                            runLen = 1;
                        }
                    }
                    result += FinderTerminate(runColor, runLen, history) * 40;
                }
            }
            for (int y = 0; y < Size - 1; y++)
                for (int x = 0; x < Size - 1; x++)
                {
                    bool c = modules[y, x];
                    if (c == modules[y, x + 1] && c == modules[y + 1, x] && c == modules[y + 1, x + 1]) result += 3;
                }
            int dark = 0;
            for (int y = 0; y < Size; y++)
                for (int x = 0; x < Size; x++)
                    if (modules[y, x]) dark++;
            int total = Size * Size;
            int k = (Math.Abs(dark * 20 - total * 10) + total - 1) / total - 1;
            result += k * 10;
            return result;
        }

        void AddHistory(int runLen, int[] history)
        {
            if (history[0] == 0) runLen += Size; // light border before the first run
            Array.Copy(history, 0, history, 1, history.Length - 1);
            history[0] = runLen;
        }

        int FinderLike(int[] h)
        {
            int n = h[1];
            bool core = n > 0 && h[2] == n && h[3] == n * 3 && h[4] == n && h[5] == n;
            return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
        }

        int FinderTerminate(bool runColor, int runLen, int[] history)
        {
            if (runColor)
            {
                AddHistory(runLen, history);
                runLen = 0;
            }
            runLen += Size;
            AddHistory(runLen, history);
            return FinderLike(history);
        }
    }

    // Draws a QR code crisply (whole pixels per module) on white, with a quiet zone.
    class QrView : Control
    {
        QrCode code;
        public string Placeholder = "";

        public QrView()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            BackColor = Color.White;
        }

        public QrCode Code
        {
            get { return code; }
            set { code = value; Invalidate(); }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(Color.White);
            if (code == null)
            {
                TextRenderer.DrawText(g, Placeholder, Ui.Small, ClientRectangle, Color.FromArgb(0x70, 0x76, 0x82), Ui.Center | TextFormatFlags.WordBreak);
                return;
            }
            int quiet = 4;
            int cells = code.Size + quiet * 2;
            int px = Math.Max(1, Math.Min(Width, Height) / cells);
            int ox = (Width - px * code.Size) / 2, oy = (Height - px * code.Size) / 2;
            using (var b = new SolidBrush(Color.Black))
            {
                for (int y = 0; y < code.Size; y++)
                    for (int x = 0; x < code.Size; x++)
                        if (code[x, y]) g.FillRectangle(b, ox + x * px, oy + y * px, px, px);
            }
        }
    }
}
