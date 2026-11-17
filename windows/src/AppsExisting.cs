// An app that's on this PC already, not from Beam (this app 1.27, Beam 1.35). The user, 2026-11-17: "make sure the app
// isnt already installed, i had two versions of slate on one of my computers because of beam". Slate's own setup (its
// Help → Open files with Slate…, `Slate.exe --install`, winget) puts it in Programs\Slate and lists it in Installed
// apps; Beam then took "Slate (Beam)" beside it: a second Slate, a second Start menu entry, a second Installed apps
// entry. Before installing, Beam now looks:
//   Installed apps   this user's, and the PC's (64- and 32-bit), by name: letters and digits, a version or an
//                    architecture after it left out ("7-Zip 24.08 (x64)" is 7zip, "HW-Blackbox" is "HW Blackbox");
//                    never Beam's own entries (BeamApp-…, or an Uninstall that asks Beam: --remove-app)
//   App Paths        the program's file (a portable .exe, as Slate.exe): where Windows' Run box finds it
//   Programs\<name>  a folder of the app's name that isn't Beam's (no .beamapp) holding its program
// Found: nothing is installed; Beam remembers it as "found" (it never updates, moves or removes it) and the Apps page
// says so. And an app Beam installed that is also installed elsewhere (the Slate that was there twice) is told to the
// server too (`also`), so the Apps page can say which copy is Beam's.
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Beam
{
    class FoundApp
    {
        public string Where, Version;
    }

    static class ExistingApps
    {
        const string UninstallRoot = @"Software\Microsoft\Windows\CurrentVersion\Uninstall";
        const string AppPaths = @"Software\Microsoft\Windows\CurrentVersion\App Paths\";
        const string Marker = ".beamapp";

        class Entry { public string Name, Version, Location; }

        // An app's name as it's compared: "" when too short to go by (two letters would match too much).
        public static string Key(string name)
        {
            string s = (name ?? "").Trim();
            s = Regex.Replace(s, @"\s*[\(\[](x64|x86|64-bit|32-bit|amd64|arm64|64 bit|32 bit)[\)\]]\s*$", "", RegexOptions.IgnoreCase);
            s = Regex.Replace(s, @"(?:\s+|[-_]|\s+v)v?\d+(?:\.\d+)+.*$", "", RegexOptions.IgnoreCase);
            var sb = new StringBuilder();
            foreach (char c in s.ToLowerInvariant()) if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) sb.Append(c);
            return sb.Length >= 3 ? sb.ToString() : "";
        }

        // Installed apps' entries (a test instance: its stand-in, testInstalled; never the registry).
        static List<Entry> Entries(Config cfg)
        {
            var list = new List<Entry>();
            if (cfg.CustomPath)
            {
                foreach (var o in cfg.TestInstalled ?? new object[0])
                {
                    var d = Json.Obj(o);
                    if (d != null && !string.IsNullOrWhiteSpace(Json.Str(d, "name")))
                        list.Add(new Entry { Name = Json.Str(d, "name"), Version = Json.Str(d, "version"), Location = Json.Str(d, "location") });
                }
                return list;
            }
            Read(RegistryHive.CurrentUser, RegistryView.Default, list);
            if (Environment.Is64BitOperatingSystem) Read(RegistryHive.LocalMachine, RegistryView.Registry64, list);
            Read(RegistryHive.LocalMachine, RegistryView.Registry32, list);
            return list;
        }

        static void Read(RegistryHive hive, RegistryView view, List<Entry> list)
        {
            try
            {
                using (var root = RegistryKey.OpenBaseKey(hive, view))
                using (var k = root.OpenSubKey(UninstallRoot))
                {
                    if (k == null) return;
                    foreach (var sub in k.GetSubKeyNames())
                    {
                        if (sub.StartsWith("BeamApp-", StringComparison.OrdinalIgnoreCase)) continue;
                        try
                        {
                            using (var e = k.OpenSubKey(sub))
                            {
                                if (e == null) continue;
                                string name = e.GetValue("DisplayName") as string;
                                if (string.IsNullOrWhiteSpace(name)) continue;
                                string un = e.GetValue("UninstallString") as string ?? "";
                                if (un.IndexOf("--remove-app", StringComparison.OrdinalIgnoreCase) >= 0) continue; // (Beam's)
                                string loc = (e.GetValue("InstallLocation") as string ?? "").Trim().Trim('"');
                                if (loc.Length == 0) loc = FolderOfIcon(e.GetValue("DisplayIcon") as string);
                                list.Add(new Entry { Name = name.Trim(), Version = (e.GetValue("DisplayVersion") as string ?? "").Trim(), Location = loc });
                            }
                        }
                        catch { }
                    }
                }
            }
            catch { }
        }

        // "C:\…\Slate.exe",0 → C:\…
        static string FolderOfIcon(string icon)
        {
            if (string.IsNullOrWhiteSpace(icon)) return null;
            string p = icon.Trim();
            if (p.StartsWith("\"")) { int end = p.IndexOf('"', 1); p = end > 0 ? p.Substring(1, end - 1) : p.Trim('"'); }
            else { int comma = p.LastIndexOf(','); if (comma > 0) p = p.Substring(0, comma); }
            try { return Path.IsPathRooted(p) ? Path.GetDirectoryName(p) : null; } catch { return null; }
        }

        // The installed version in Installed apps, by the app's name (an app whose setup Beam ran, or found here).
        public static string VersionOf(Config cfg, string name)
        {
            string key = Key(name);
            if (key.Length == 0) return null;
            var e = Entries(cfg).FirstOrDefault(x => Key(x.Name) == key && !string.IsNullOrEmpty(x.Version));
            return e != null ? Short(e.Version) : null;
        }

        // An install of the app that isn't Beam's: null if there's none. fileName/type: the app's file on the server
        // (a portable .exe is looked for by its name); run: the program in its .zip; except: the folder of Beam's own copy.
        public static FoundApp Find(Config cfg, string programs, string name, string fileName, string type, string run, string except)
        {
            string key = Key(name);
            if (key.Length > 0)
                foreach (var e in Entries(cfg))
                    if (Key(e.Name) == key && !SameFolder(e.Location, except))
                        return new FoundApp { Where = !string.IsNullOrEmpty(e.Location) ? e.Location : e.Name + " (Installed apps)", Version = Short(e.Version) };
            bool portable = type == "exe" && !string.IsNullOrEmpty(fileName) && !LooksLikeSetup(fileName);
            if (portable && !cfg.CustomPath)
            {
                foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
                {
                    try
                    {
                        using (var k = hive.OpenSubKey(AppPaths + fileName))
                        {
                            string p = k != null ? (k.GetValue("") as string ?? "").Trim().Trim('"') : "";
                            if (p.Length > 0 && Path.IsPathRooted(p) && File.Exists(p) && !Beams(Path.GetDirectoryName(p)) && !SameFolder(Path.GetDirectoryName(p), except))
                                return new FoundApp { Where = Path.GetDirectoryName(p), Version = AppInstaller.ExeVersion(p) };
                        }
                    }
                    catch { }
                }
            }
            string dir = Path.Combine(programs, AppInstaller.FolderName(name));
            if (Directory.Exists(dir) && !Beams(dir) && !SameFolder(dir, except))
            {
                string exe = null;
                if (portable && File.Exists(Path.Combine(dir, fileName))) exe = Path.Combine(dir, fileName);
                else if (type == "zip")
                {
                    if (!string.IsNullOrEmpty(run) && File.Exists(Path.Combine(dir, run.Replace('/', '\\')))) exe = Path.Combine(dir, run.Replace('/', '\\'));
                    else
                    {
                        try { exe = Directory.GetFiles(dir, "*.exe").FirstOrDefault(f => Key(Path.GetFileNameWithoutExtension(f)) == key && key.Length > 0); }
                        catch { }
                    }
                }
                if (exe != null) return new FoundApp { Where = dir, Version = AppInstaller.ExeVersion(exe) };
            }
            return null;
        }

        static bool LooksLikeSetup(string name)
        {
            return name.IndexOf("setup", StringComparison.OrdinalIgnoreCase) >= 0 || name.IndexOf("install", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        // A folder Beam installed into (its marker), or one inside it.
        static bool Beams(string dir)
        {
            try
            {
                for (string d = dir; !string.IsNullOrEmpty(d); d = Path.GetDirectoryName(d))
                {
                    if (File.Exists(Path.Combine(d, Marker))) return true;
                    if (string.Equals(Path.GetFileName(Path.GetDirectoryName(d) ?? ""), "Programs", StringComparison.OrdinalIgnoreCase)) break; // (up to the app's own folder)
                }
            }
            catch { }
            return false;
        }

        static bool SameFolder(string a, string b)
        {
            if (string.IsNullOrEmpty(a) || string.IsNullOrEmpty(b)) return false;
            try { return string.Equals(Path.GetFullPath(a).TrimEnd('\\'), Path.GetFullPath(b).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase); }
            catch { return false; }
        }

        // At most 40 characters of a version.
        static string Short(string v)
        {
            v = (v ?? "").Trim();
            return v.Length == 0 ? null : v.Length > 40 ? v.Substring(0, 40) : v;
        }
    }
}
