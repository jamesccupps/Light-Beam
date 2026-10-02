// Signed updates (1.7.3; windows/update-key.mjs). The build signs
//   "beam-windows-update\n<version>\n<sha256>\n<size>"
// with its builder's private key (ECDSA P-256, SHA-256, the signature as r||s); the public half is compiled in
// (UpdateKey.PublicKey, made by the build). An update is installed only with a signature from that key over the
// version offered and the SHA-256 and size of what was actually downloaded: the server only passes signatures on,
// so neither a changed dist/ folder nor a stranger on the way can hand this PC a Beam.exe of their own, nor an older
// signed one (the version is in what's signed). A build made without a key (PublicKey empty) checks the server's
// SHA-256 only, as before 1.7.3.
using System;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace Beam
{
    static class UpdateSignature
    {
        public static bool Required { get { return !string.IsNullOrEmpty(UpdateKey.PublicKey); } }

        // Null when the update may be installed; else why not.
        public static string Check(string version, string sha256Hex, long size, string signature)
        {
            return Check(UpdateKey.PublicKey, version, sha256Hex, size, signature);
        }

        public static string Check(string publicKey, string version, string sha256Hex, long size, string signature)
        {
            if (string.IsNullOrEmpty(publicKey)) return null;
            if (string.IsNullOrEmpty(signature)) return "the update isn't signed";
            byte[] sig, xy;
            try
            {
                sig = Convert.FromBase64String(signature.Trim());
                xy = Convert.FromBase64String(publicKey);
            }
            catch (FormatException) { return "the update's signature is garbled"; }
            if (sig.Length != 64 || xy.Length != 64) return "the update's signature is garbled";
            // BCRYPT_ECCKEY_BLOB for an ECDSA P-256 public key: magic "ECS1", key length 32, then X and Y.
            var blob = new byte[8 + 64];
            blob[0] = 0x45; blob[1] = 0x43; blob[2] = 0x53; blob[3] = 0x31; blob[4] = 32;
            Buffer.BlockCopy(xy, 0, blob, 8, 64);
            byte[] message = Encoding.UTF8.GetBytes("beam-windows-update\n" + version + "\n" + (sha256Hex ?? "").Trim().ToLowerInvariant() + "\n" + size.ToString(CultureInfo.InvariantCulture));
            try
            {
                using (var key = CngKey.Import(blob, CngKeyBlobFormat.EccPublicBlob))
                using (var ecdsa = new ECDsaCng(key))
                {
                    ecdsa.HashAlgorithm = CngAlgorithm.Sha256;
                    return ecdsa.VerifyData(message, sig) ? null : "the update isn't signed with this Beam's key";
                }
            }
            catch (CryptographicException ex) { return "the update's signature couldn't be checked (" + ex.Message + ")"; }
        }
    }
}
