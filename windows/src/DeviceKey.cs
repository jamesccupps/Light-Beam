// This install's device key (Beam 1.6): 32 random bytes made on the first run, kept DPAPI-protected for this Windows
// account (CurrentUser scope) in the config folder (device.key), and sent as X-Beam-Device-Key on every request Beam
// itself makes with its sign-in: API calls, the event stream and sign-ins. The server ties a device to the first key
// it sees, so this PC's token used by another Windows account or another program elsewhere doesn't pass as this
// install (remote control relies on that). Never logged, never in a URL, never given to a web page (pages keep using
// the cookie). A key that can't be read (another account, a copied config folder) is replaced by a new one: the
// server then treats this PC as a new device, and it signs in again.
using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace Beam
{
    static class DeviceKey
    {
        static readonly byte[] Entropy = Encoding.UTF8.GetBytes("Beam device key 1");
        static string value;

        // base64url, or null when none could be made or kept (then none is sent).
        public static string Value { get { return value; } }

        public static void Load(string dir)
        {
            string path = Path.Combine(dir, "device.key");
            string lost = null;
            if (File.Exists(path))
            {
                try
                {
                    byte[] key = ProtectedData.Unprotect(File.ReadAllBytes(path), Entropy, DataProtectionScope.CurrentUser);
                    if (key.Length == 32)
                    {
                        value = Encode(key);
                        Array.Clear(key, 0, key.Length);
                        return;
                    }
                    lost = "it isn't a key";
                }
                catch (Exception ex) { lost = ex.GetType().Name; }
            }
            var fresh = new byte[32];
            using (var rng = new RNGCryptoServiceProvider()) rng.GetBytes(fresh);
            try
            {
                byte[] blob = ProtectedData.Protect(fresh, Entropy, DataProtectionScope.CurrentUser);
                string tmp = path + ".tmp";
                File.WriteAllBytes(tmp, blob);
                if (File.Exists(path)) File.Replace(tmp, path, null);
                else File.Move(tmp, path);
                value = Encode(fresh);
                Log.Write(lost == null ? "Made this install's device key"
                    : "This install's device key couldn't be read (" + lost + "): made a new one. The server treats this PC as a new device: sign in again");
            }
            catch (Exception ex)
            {
                // A key that can't be kept isn't used: the next start would send another one.
                value = null;
                Log.Error("The device key couldn't be saved", ex);
            }
            finally { Array.Clear(fresh, 0, fresh.Length); }
        }

        static string Encode(byte[] b)
        {
            return Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }
    }

    // DPAPI (CurrentUser) for secrets kept in files: only this Windows account on this PC can read them back.
    static class Dpapi
    {
        public static readonly byte[] ConfigKey = Encoding.UTF8.GetBytes("Beam config key 1");

        public static string Protect(string text, byte[] entropy)
        {
            try { return Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(text), entropy, DataProtectionScope.CurrentUser)); }
            catch (Exception ex) { Log.Error("DPAPI", ex); return null; }
        }

        // Null when it can't be read here (another account, another PC, a damaged value).
        public static string Unprotect(string sealedText, byte[] entropy)
        {
            try { return Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(sealedText), entropy, DataProtectionScope.CurrentUser)); }
            catch { return null; }
        }
    }
}
