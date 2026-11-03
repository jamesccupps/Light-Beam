// Beam's input helper (Windows 1.22, plan Beam-dev\plan\rc-admin.md): remote control's clicks and keys for windows Beam
// itself can't reach. It's marked uiAccess="true"; Windows gives it UIAccess (input into any window, whatever its
// integrity: an administrator's window, a UAC prompt on the normal desktop) only when it's signed with a certificate
// in the PC's Trusted Root store and runs from Program Files (Settings → Security → "Administrator windows", set up
// once per PC). Without that it starts all the same and reaches what Beam reaches.
//
//   BeamInput.exe --pipe <name> --parent <pid> --token <64 hex> [--record <file>]
//
// Beam starts it for a remote control session and owns the pipe; the helper connects, checks that the pipe's server is
// its parent and that the parent is Beam.exe signed with the helper's own certificate, says hello (the token, whether
// it has UIAccess), then only takes INPUT records (24 bytes each, at most 256 a batch) and answers how many went in.
// No other commands. It quits when the pipe closes, when Beam's process ends, or when nobody's there in 15 s.
// --record (tests): the records as JSON lines in that file, like Beam's RecordingBackend; never SendInput.
using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading;

[assembly: System.Reflection.AssemblyTitle("Beam input helper")]
[assembly: System.Reflection.AssemblyProduct("Beam")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("1.0.0.0")]

namespace BeamInputHelper
{
    static class Program
    {
        public const byte Protocol = 1;
        const int MaxBatch = 256, RecordSize = 24;

        static int Main(string[] args)
        {
            string pipe = null, token = null, record = null;
            int parent = 0;
            for (int i = 0; i + 1 < args.Length; i += 2)
            {
                switch (args[i])
                {
                    case "--pipe": pipe = args[i + 1]; break;
                    case "--parent": int.TryParse(args[i + 1], NumberStyles.None, CultureInfo.InvariantCulture, out parent); break;
                    case "--token": token = args[i + 1]; break;
                    case "--record": record = args[i + 1]; break;
                    default: return 2;
                }
            }
            if (pipe == null || parent <= 0 || token == null || token.Length != 64 || !IsName(pipe)) return 2;
            byte[] tokenBytes = Hex(token);
            if (tokenBytes == null) return 2;

            Process beam;
            try { beam = Process.GetProcessById(parent); }
            catch { return 3; }
            // The parent must be Beam signed with this helper's own certificate (a copy of Beam that was changed, or
            // another program starting the helper to use it, is refused).
            if (!SignedLikeMe(beam)) return 4;
            var watch = new Thread(() => { try { beam.WaitForExit(); } catch { } Environment.Exit(0); });
            watch.IsBackground = true;
            watch.Start();

            using (var client = new NamedPipeClientStream(".", pipe, PipeDirection.InOut, PipeOptions.None))
            {
                try { client.Connect(15000); }
                catch { return 5; }
                uint server;
                if (!GetNamedPipeServerProcessId(client.SafePipeHandle.DangerousGetHandle(), out server) || server != (uint)parent) return 6;

                var hello = new byte[6 + 1 + 1 + 32];
                Encoding.ASCII.GetBytes("BEAMIN").CopyTo(hello, 0);
                hello[6] = Protocol;
                hello[7] = (byte)(HasUiAccess() ? 1 : 0);
                tokenBytes.CopyTo(hello, 8);
                client.Write(hello, 0, hello.Length);
                client.Flush();

                var head = new byte[2];
                var body = new byte[MaxBatch * RecordSize];
                int batch = 0;
                while (true)
                {
                    if (!ReadAll(client, head, 2)) return 0;
                    int count = head[0] | (head[1] << 8);
                    if (count == 0) return 0; // "that's all"
                    if (count > MaxBatch) return 7;
                    if (!ReadAll(client, body, count * RecordSize)) return 0;
                    var inputs = Decode(body, count);
                    int sent = record != null ? Record(record, inputs, ++batch) : (int)SendInput((uint)count, inputs, Marshal.SizeOf(typeof(INPUT)));
                    head[0] = (byte)(sent & 0xFF);
                    head[1] = (byte)((sent >> 8) & 0xFF);
                    client.Write(head, 0, 2);
                    client.Flush();
                }
            }
        }

        static bool IsName(string s)
        {
            if (s.Length < 8 || s.Length > 100) return false;
            foreach (char c in s) if (!(char.IsLetterOrDigit(c) || c == '-')) return false;
            return true;
        }

        static byte[] Hex(string s)
        {
            var b = new byte[s.Length / 2];
            for (int i = 0; i < b.Length; i++)
            {
                int v;
                if (!int.TryParse(s.Substring(i * 2, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out v)) return null;
                b[i] = (byte)v;
            }
            return b;
        }

        static bool ReadAll(Stream s, byte[] buf, int n)
        {
            int got = 0;
            while (got < n)
            {
                int r;
                try { r = s.Read(buf, got, n - got); }
                catch { return false; }
                if (r <= 0) return false;
                got += r;
            }
            return true;
        }

        // [0] type (0 mouse, 1 keyboard) [2..3] vk [4..5] scan [8..11] dx [12..15] dy [16..19] mouse data [20..23] flags
        static INPUT[] Decode(byte[] b, int count)
        {
            var list = new INPUT[count];
            for (int i = 0; i < count; i++)
            {
                int o = i * RecordSize;
                list[i].type = b[o];
                if (b[o] == 0)
                {
                    list[i].u.mi.dx = BitConverter.ToInt32(b, o + 8);
                    list[i].u.mi.dy = BitConverter.ToInt32(b, o + 12);
                    list[i].u.mi.mouseData = BitConverter.ToUInt32(b, o + 16);
                    list[i].u.mi.dwFlags = BitConverter.ToUInt32(b, o + 20);
                }
                else
                {
                    list[i].type = 1;
                    list[i].u.ki.wVk = BitConverter.ToUInt16(b, o + 2);
                    list[i].u.ki.wScan = BitConverter.ToUInt16(b, o + 4);
                    list[i].u.ki.dwFlags = BitConverter.ToUInt32(b, o + 20);
                }
            }
            return list;
        }

        // Tests: the same lines as Beam's RecordingBackend.
        static int Record(string path, INPUT[] inputs, int batch)
        {
            var c = CultureInfo.InvariantCulture;
            var sb = new StringBuilder();
            foreach (var r in inputs)
            {
                if (r.type == 0)
                    sb.Append("{\"b\":" + batch.ToString(c) + ",\"type\":\"mouse\",\"dx\":" + r.u.mi.dx.ToString(c) + ",\"dy\":" + r.u.mi.dy.ToString(c) +
                        ",\"data\":" + unchecked((int)r.u.mi.mouseData).ToString(c) + ",\"flags\":" + r.u.mi.dwFlags.ToString(c) + ",\"via\":\"helper\"}\n");
                else
                    sb.Append("{\"b\":" + batch.ToString(c) + ",\"type\":\"key\",\"vk\":" + r.u.ki.wVk.ToString(c) + ",\"scan\":" + r.u.ki.wScan.ToString(c) +
                        ",\"flags\":" + r.u.ki.dwFlags.ToString(c) + ",\"via\":\"helper\"}\n");
            }
            try { File.AppendAllText(path, sb.ToString(), new UTF8Encoding(false)); }
            catch { return 0; }
            return inputs.Length;
        }

        // The parent's exe carries an intact Authenticode signature (its root may be untrusted here: the test copies
        // run outside the setup) by the certificate that signed this helper.
        static bool SignedLikeMe(Process p)
        {
            try
            {
                string mine = Thumbprint(typeof(Program).Assembly.Location);
                string path = ImagePath(p);
                if (mine == null || path == null || Thumbprint(path) != mine) return false;
                uint trust = Verify(path);
                return trust == 0 || trust == 0x800B0109 /* CERT_E_UNTRUSTEDROOT */;
            }
            catch { return false; }
        }

        static string Thumbprint(string file)
        {
            try { return new X509Certificate2(X509Certificate.CreateFromSignedFile(file)).Thumbprint; }
            catch { return null; }
        }

        static string ImagePath(Process p)
        {
            var sb = new StringBuilder(1024);
            int size = sb.Capacity;
            IntPtr h = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, p.Id);
            if (h == IntPtr.Zero) return null;
            try { return QueryFullProcessImageName(h, 0, sb, ref size) ? sb.ToString() : null; }
            finally { CloseHandle(h); }
        }

        static bool HasUiAccess()
        {
            IntPtr token;
            if (!OpenProcessToken(GetCurrentProcess(), 0x0008 /* TOKEN_QUERY */, out token)) return false;
            try
            {
                int value, len;
                return GetTokenInformation(token, 26 /* TokenUIAccess */, out value, 4, out len) && value != 0;
            }
            finally { CloseHandle(token); }
        }

        // WinVerifyTrust on a file, no UI, no revocation check (a self-made certificate has no CRL).
        static uint Verify(string path)
        {
            var file = new WINTRUST_FILE_INFO();
            file.cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_FILE_INFO));
            file.pcwszFilePath = path;
            IntPtr pFile = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)));
            try
            {
                Marshal.StructureToPtr(file, pFile, false);
                var data = new WINTRUST_DATA();
                data.cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_DATA));
                data.dwUIChoice = 2;            // WTD_UI_NONE
                data.fdwRevocationChecks = 0;   // WTD_REVOKE_NONE
                data.dwUnionChoice = 1;         // WTD_CHOICE_FILE
                data.pFile = pFile;
                data.dwStateAction = 0;
                data.dwProvFlags = 0x00000040;  // WTD_CACHE_ONLY_URL_RETRIEVAL (never goes online)
                var action = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE"); // WINTRUST_ACTION_GENERIC_VERIFY_V2
                return (uint)WinVerifyTrust(new IntPtr(-1), ref action, ref data);
            }
            finally { Marshal.FreeHGlobal(pFile); }
        }

        [StructLayout(LayoutKind.Sequential)]
        struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)]
        struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Explicit)]
        struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
        [StructLayout(LayoutKind.Sequential)]
        struct INPUT { public uint type; public UNION u; }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct WINTRUST_FILE_INFO { public uint cbStruct; public string pcwszFilePath; public IntPtr hFile; public IntPtr pgKnownSubject; }
        [StructLayout(LayoutKind.Sequential)]
        struct WINTRUST_DATA
        {
            public uint cbStruct; public IntPtr pPolicyCallbackData; public IntPtr pSIPClientData; public uint dwUIChoice;
            public uint fdwRevocationChecks; public uint dwUnionChoice; public IntPtr pFile; public uint dwStateAction;
            public IntPtr hWVTStateData; public IntPtr pwszURLReference; public uint dwProvFlags; public uint dwUIContext;
            public IntPtr pSignatureSettings;
        }

        [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetNamedPipeServerProcessId(IntPtr pipe, out uint pid);
        [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int cls, out int info, int len, out int retLen);
        [DllImport("wintrust.dll", CharSet = CharSet.Unicode)] static extern int WinVerifyTrust(IntPtr hwnd, ref Guid action, ref WINTRUST_DATA data);
    }
}
