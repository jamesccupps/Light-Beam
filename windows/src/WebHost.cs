// WebView2 plumbing: the SDK's managed DLLs are embedded in Beam.exe and loaded from memory; the native
// loader DLL is extracted once per version; the browser environment (one per process) lives in a per-config
// profile folder. Beam.exe stays a single self-updating file.
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Threading.Tasks;
using Microsoft.Web.WebView2.Core;

namespace Beam
{
    // No WebView2 types in here: this runs before the SDK assemblies can be resolved.
    static class Embedded
    {
        static readonly Dictionary<string, Assembly> loaded = new Dictionary<string, Assembly>();

        public static void Register()
        {
            AppDomain.CurrentDomain.AssemblyResolve += Resolve;
        }

        static Assembly Resolve(object sender, ResolveEventArgs e)
        {
            string name = new AssemblyName(e.Name).Name;
            if (name != "Microsoft.Web.WebView2.Core" && name != "Microsoft.Web.WebView2.WinForms") return null;
            lock (loaded)
            {
                Assembly a;
                if (loaded.TryGetValue(name, out a)) return a;
                byte[] bytes = Resource("Beam.webview2." + name.Substring("Microsoft.Web.WebView2.".Length) + ".dll");
                if (bytes == null) return null;
                a = Assembly.Load(bytes);
                loaded[name] = a;
                return a;
            }
        }

        public static byte[] Resource(string name)
        {
            using (var s = typeof(Embedded).Assembly.GetManifestResourceStream(name))
            {
                if (s == null) return null;
                var bytes = new byte[s.Length];
                int off = 0;
                while (off < bytes.Length)
                {
                    int n = s.Read(bytes, off, bytes.Length - off);
                    if (n <= 0) break;
                    off += n;
                }
                return bytes;
            }
        }
    }

    static class WebHost
    {
        static Task<CoreWebView2Environment> environment;
        static bool loaderReady;
        static string runtimeVersion;
        public static bool Missing;   // no WebView2 Runtime on this PC

        static string Arch()
        {
            if (IntPtr.Size == 4) return "x86";
            string a = (System.Environment.GetEnvironmentVariable("PROCESSOR_ARCHITECTURE") ?? "").ToUpperInvariant();
            return a == "ARM64" ? "arm64" : "x64";
        }

        // Extracts WebView2Loader.dll for this process's architecture (once per loader version).
        static void PrepareLoader(Config cfg)
        {
            if (loaderReady) return;
            string arch = Arch();
            byte[] bytes = Embedded.Resource("Beam.webview2." + arch + ".WebView2Loader.dll");
            if (bytes == null) throw new FileNotFoundException("WebView2Loader.dll for " + arch + " isn't embedded in this build");
            string hash;
            using (var sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(bytes), 0, 6).Replace("-", "").ToLowerInvariant();
            string dir = Path.Combine(cfg.WebViewFolder, "loader", arch + "-" + hash);
            string dll = Path.Combine(dir, "WebView2Loader.dll");
            if (!File.Exists(dll) || new FileInfo(dll).Length != bytes.Length)
            {
                Directory.CreateDirectory(dir);
                string tmp = dll + "." + Guid.NewGuid().ToString("N") + ".tmp";
                File.WriteAllBytes(tmp, bytes);
                try { File.Move(tmp, dll); } catch { FileUtil.TryDelete(tmp); if (!File.Exists(dll)) throw; }
            }
            CoreWebView2Environment.SetLoaderDllFolderPath(dir);
            loaderReady = true;
        }

        // Beam 1.7.6 (audit S-10): over https the page also gets the sign-in as `__Host-beam_key`, which the browser keeps
        // host-only, Secure and on path / (so no other machine of the tailnet can plant one under that name). The cookie
        // manager's CreateCookie names a Domain, which that prefix forbids, so it goes through DevTools with the page's
        // URL instead. At most 2 s: until the server reads only the new name, the old `beam_key` signs the page in too.
        public static async Task SetHostCookie(CoreWebView2 core, Uri origin, string key, string who)
        {
            if (core == null || origin == null || origin.Scheme != Uri.UriSchemeHttps || string.IsNullOrEmpty(key)) return;
            var p = new Dictionary<string, object>();
            p["name"] = "__Host-beam_key";
            p["value"] = key;
            p["url"] = "https://" + origin.Authority + "/";
            p["secure"] = true;
            p["httpOnly"] = true;
            p["sameSite"] = "Lax";
            p["expires"] = (long)(DateTime.UtcNow.AddYears(10) - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds;
            try
            {
                var call = core.CallDevToolsProtocolMethodAsync("Network.setCookie", Json.Stringify(p));
                if (await Task.WhenAny(call, Task.Delay(2000)) != call) { Log.Write(who + ": the __Host- sign-in cookie took over 2 s"); return; }
                await call; // (throws if DevTools refused it)
            }
            catch (Exception ex) { Log.Error(who + ": the __Host- sign-in cookie", ex); }
        }

        // For the other web views (Beam 1.6 remote control): the loader, before their own environments.
        public static void EnsureLoader(Config cfg)
        {
            PrepareLoader(cfg);
        }

        // The installed WebView2 Runtime's version, or null when there is none.
        public static string RuntimeVersion(Config cfg)
        {
            if (runtimeVersion != null || Missing) return runtimeVersion;
            try
            {
                PrepareLoader(cfg);
                runtimeVersion = CoreWebView2Environment.GetAvailableBrowserVersionString(null);
            }
            catch (WebView2RuntimeNotFoundException)
            {
                Missing = true;
            }
            catch (Exception ex)
            {
                Log.Error("WebView2", ex);
                Missing = true;
            }
            if (runtimeVersion == null) Missing = true;
            else Log.Write("WebView2 Runtime " + runtimeVersion);
            return runtimeVersion;
        }

        static volatile int opened;        // web views started in this process (UI thread)
        static volatile bool clearOnOpen;  // a sign-out's data couldn't be deleted: the next web view clears it first

        // The chat window's stored data (cookies, storage, the HTTP disk cache) when no web view is open to clear it
        // itself. A just-released web view's processes may still hold files for a few seconds: once more 10 s later,
        // unless a web view has started on the folder meanwhile; that one clears it before loading anything.
        public static void ForgetProfile(Config cfg)
        {
            string dir = Path.Combine(cfg.WebViewFolder, "Profile");
            if (TryDeleteProfile(dir)) { clearOnOpen = false; return; }
            clearOnOpen = true;
            int seen = opened;
            Action retry = () =>
            {
                if (opened != seen) return;
                if (TryDeleteProfile(dir)) clearOnOpen = false;
                else Log.Write("The chat window's data couldn't be removed yet (in use): it's cleared when the window opens");
            };
            Task.Delay(10000).ContinueWith(t => { var app = App.Current; if (app != null) app.Post(retry); else retry(); });
        }

        // A new web view, before it loads anything: data that a sign-out couldn't delete goes now.
        public static async Task ClearLeftovers(CoreWebView2 core)
        {
            if (!clearOnOpen) return;
            clearOnOpen = false;
            try
            {
                await core.Profile.ClearBrowsingDataAsync();
                Log.Write("Cleared the chat window's data left from signing out");
            }
            catch (Exception ex) { Log.Error("Clearing the chat window's data", ex); }
        }

        static bool TryDeleteProfile(string dir)
        {
            try
            {
                if (Directory.Exists(dir)) Directory.Delete(dir, true);
                return true;
            }
            catch (Exception ex) { Log.Error("Clearing the chat window's data", ex); return false; }
        }

        // UI thread, for every web view about to start.
        public static Task<CoreWebView2Environment> Environment(Config cfg)
        {
            opened++;
            if (environment == null || environment.IsFaulted || environment.IsCanceled)
            {
                PrepareLoader(cfg);
                string profile = Path.Combine(cfg.WebViewFolder, "Profile");
                Directory.CreateDirectory(profile);
                var options = new CoreWebView2EnvironmentOptions();
                options.AllowSingleSignOnUsingOSPrimaryAccount = false;
                environment = CoreWebView2Environment.CreateAsync(null, profile, options);
            }
            return environment;
        }
    }
}
