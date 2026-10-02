// Installing itself: Beam.exe can be run from anywhere (Downloads, a USB stick). The first time, it copies
// itself to %LOCALAPPDATA%\Programs\Beam, adds a Start menu entry, turns on "start with Windows" once, and
// continues as that copy. Shortcuts, the Run key and Send to always point at the installed exe.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace Beam
{
    static class Install
    {
        public static string InstalledExe(Config cfg)
        {
            return Path.Combine(cfg.InstallDir, "Beam.exe");
        }

        public static bool RunningInstalled(Config cfg)
        {
            return SamePath(Application.ExecutablePath, InstalledExe(cfg));
        }

        // What shortcuts and the Run key should start: the installed copy once it exists, else this exe.
        public static string TargetExe(Config cfg)
        {
            string installed = InstalledExe(cfg);
            return File.Exists(installed) ? installed : Application.ExecutablePath;
        }

        public static string StartMenuLink(Config cfg)
        {
            return Path.Combine(cfg.StartMenuFolder, "Beam.lnk");
        }

        static bool SamePath(string a, string b)
        {
            try { return string.Equals(Path.GetFullPath(a).TrimEnd('\\'), Path.GetFullPath(b).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase); }
            catch { return false; }
        }

        // Windows command-line quoting (the rules CommandLineToArgvW uses).
        public static string JoinArgs(IEnumerable<string> args)
        {
            var sb = new StringBuilder();
            foreach (var a in args)
            {
                if (sb.Length > 0) sb.Append(' ');
                if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) { sb.Append(a); continue; }
                sb.Append('"');
                int slashes = 0;
                foreach (char c in a)
                {
                    if (c == '\\') { slashes++; continue; }
                    if (c == '"') sb.Append('\\', slashes * 2 + 1);
                    else sb.Append('\\', slashes);
                    slashes = 0;
                    sb.Append(c);
                }
                sb.Append('\\', slashes * 2);
                sb.Append('"');
            }
            return sb.ToString();
        }

        // Returns true when this process should exit because the installed copy takes over.
        public static bool SelfInstall(Options o, Config cfg, string[] args, Action releaseLock)
        {
            if (o.Portable || (cfg.CustomPath && !o.Install) || RunningInstalled(cfg)) return false;
            string target = InstalledExe(cfg);
            try
            {
                Version mine = Updater.Current, theirs = File.Exists(target) ? Updater.FileVersion(target) : null;
                if (theirs == null || mine > theirs)
                {
                    Directory.CreateDirectory(cfg.InstallDir);
                    CopyWithRetry(Application.ExecutablePath, target);
                    Log.Write("Installed Beam " + AppVersion.Text + " to " + target);
                }
                else Log.Write("Beam " + theirs + " is already installed in " + cfg.InstallDir + "; starting that one");
                EnsureStartMenu(cfg);
                if (!cfg.AutostartInitialized)
                {
                    Autostart.Set(true, cfg);
                    cfg.AutostartInitialized = true;
                    cfg.Save();
                }
                else Autostart.Repair(cfg);
            }
            catch (Exception ex)
            {
                Log.Error("Installing Beam (it keeps running from here)", ex);
                return false;
            }
            releaseLock();
            var rest = args.Where(a => !string.Equals(a, "--install", StringComparison.OrdinalIgnoreCase)).ToList();
            rest.Add("--installed");
            try
            {
                var psi = new ProcessStartInfo(target, JoinArgs(rest));
                psi.UseShellExecute = false;
                psi.WorkingDirectory = cfg.InstallDir;
                Process.Start(psi);
                return true;
            }
            catch (Exception ex)
            {
                Log.Error("Starting the installed Beam", ex);
                return false;
            }
        }

        static void CopyWithRetry(string from, string to)
        {
            for (int i = 0; ; i++)
            {
                try { File.Copy(from, to, true); return; }
                catch (IOException)
                {
                    if (i >= 20) throw;
                    Thread.Sleep(500); // antivirus may hold the new file while it scans it
                }
            }
        }

        public static void EnsureStartMenu(Config cfg)
        {
            try
            {
                string link = StartMenuLink(cfg);
                string args = cfg.CustomPath ? "--show --config \"" + cfg.FilePath + "\"" : "--show";
                Shortcut.Create(link, InstalledExe(cfg), args, "Beam: send text and files between your devices");
            }
            catch (Exception ex) { Log.Error("Start menu entry", ex); }
        }
    }
}
