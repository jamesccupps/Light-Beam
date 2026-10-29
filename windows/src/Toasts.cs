// (Windows app 1.21) Windows' own notifications instead of tray balloons (the 2026-10-11 audit: "native Windows toasts
// (Reply, Copy, Open) instead of balloons"): a text that came has a Reply box (what's typed goes back to that device)
// and Copy (or Open link); a file Open and Show in folder (or Save, when it isn't saved yet). A click elsewhere on one
// does what the balloon's click did.
//
// Beam registers itself for them at each start, for this Windows account only: its name and icon under
// HKCU\Software\Classes\AppUserModelId\Beam.App, and a COM class (ToastActivator, LocalServer32 = Beam.exe
// --toast-activated) Windows calls with what was clicked, also from the notification centre after Beam restarted or
// while it isn't running (Windows starts it). Each notification carries what a click needs in its arguments (which
// item, which device), so one from an earlier run still works. When Windows says no (notifications off for Beam, a
// policy, an older Windows) or the setting "Notifications with buttons" is off, the balloons as before.
using System;
using System.Collections.Generic;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;
using Windows.UI.Notifications;

namespace Beam
{
    // A button on a notification: its label and what it does.
    class ToastButton
    {
        public string Label;
        public Action Do;
        public ToastButton(string label, Action action) { Label = label; Do = action; }
    }

    // What a notification may carry besides its click: buttons, a Reply box (to the device `ReplyTo`), and its text
    // without the "Click to …" hint a balloon needs.
    class ToastExtras
    {
        public List<ToastButton> Buttons = new List<ToastButton>();
        public string ReplyTo, ReplyName; // a device, and its name for the box's hint
        public string Text;
    }

    static class Toasts
    {
        public const string Aumid = "Beam.App";
        public const string ActivatorClsid = "6B3C6D0E-8E37-4F0F-9C2E-5B7A1E4C2D61";
        const int Kept = 60; // notifications whose clicks are remembered here (older ones fall back to their item)

        // Windows' own notifications are in use (else balloons).
        public static bool Available { get; private set; }
        // (tests, a test instance's --test-toasts on) as if they were: what each would show goes to beam.log instead.
        public static bool Simulate;

        static App app;
        static bool comRegistered;
        static int next;
        static readonly Dictionary<int, Shown> shown = new Dictionary<int, Shown>();

        class Shown
        {
            public Action Click;
            public List<ToastButton> Buttons;
            public string ReplyTo;
        }

        // At start and when the setting changes (UI thread): registers, then asks Windows whether they're on for Beam.
        public static void Start(App a)
        {
            app = a;
            Available = false;
            if (a.Cfg.CustomPath || !a.Cfg.NativeToasts)
            {
                if (!a.Cfg.CustomPath) Log.Write("Notifications: balloons (the setting \"Notifications with buttons\" is off)");
                return;
            }
            try { Available = Register(); }
            catch (Exception ex) { Log.Write("Notifications: Windows' own aren't available (" + ex.Message + "): balloons"); }
        }

        // (in a method of its own: on a Windows without them, loading the WinRT types throws here, not in Start)
        static bool Register()
        {
            string exe = Application.ExecutablePath;
            using (var k = Registry.CurrentUser.CreateSubKey(@"Software\Classes\AppUserModelId\" + Aumid))
            {
                k.SetValue("DisplayName", "Beam");
                string icon = IconFile();
                if (icon != null) k.SetValue("IconUri", icon);
                k.SetValue("CustomActivator", "{" + ActivatorClsid + "}");
            }
            using (var k = Registry.CurrentUser.CreateSubKey(@"Software\Classes\CLSID\{" + ActivatorClsid + @"}\LocalServer32"))
                k.SetValue("", "\"" + exe + "\" --toast-activated");
            if (!comRegistered)
            {
                new RegistrationServices().RegisterTypeForComClients(typeof(ToastActivator), RegistrationClassContext.LocalServer, RegistrationConnectionType.MultipleUse);
                comRegistered = true;
            }
            // (1.21.1) Windows has no setting for Beam until its first notification ("Element not found": 1.21.0 took that
            // for no and kept the balloons for good): then they're on, as for any new app.
            NotificationSetting setting;
            try { setting = ToastNotificationManager.CreateToastNotifier(Aumid).Setting; }
            catch (Exception ex)
            {
                if ((uint)ex.HResult != 0x80070490) throw;
                Log.Write("Notifications: Windows' own, with buttons (Windows has no setting for Beam until its first one)");
                return true;
            }
            Log.Write("Notifications: " + (setting == NotificationSetting.Enabled ? "Windows' own, with buttons" : "balloons (Windows says " + setting + " for Beam)"));
            return setting == NotificationSetting.Enabled;
        }

        // Beam's icon as a PNG next to its other files (the notifications' icon), written once.
        static string IconFile()
        {
            try
            {
                string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Beam");
                Directory.CreateDirectory(dir);
                string file = Path.Combine(dir, "notification-icon.png");
                if (!File.Exists(file) || new FileInfo(file).Length == 0) AppIcon.Master.Save(file, ImageFormat.Png);
                return file;
            }
            catch { return null; }
        }

        // Shows one (UI thread); false when Windows' own aren't in use (the caller shows a balloon).
        public static bool Show(string title, string text, Action click, ToastExtras extras, string itemId)
        {
            if (!Available && !Simulate) return false;
            int id = ++next;
            var s = new Shown();
            s.Click = click;
            s.Buttons = extras != null ? extras.Buttons : new List<ToastButton>();
            s.ReplyTo = extras != null ? extras.ReplyTo : null;
            shown[id] = s;
            foreach (int old in shown.Keys.Where(k => k <= id - Kept).ToList()) shown.Remove(old);
            string xml = Xml(id, title, extras != null && extras.Text != null ? extras.Text : text, extras, itemId);
            if (Simulate)
            {
                Log.Write("Toast (test): " + xml);
                return true;
            }
            try
            {
                ShowXml(xml, id);
                return true;
            }
            catch (Exception ex)
            {
                Log.Error("Notification", ex);
                return false;
            }
        }

        static void ShowXml(string xml, int id)
        {
            var doc = new Windows.Data.Xml.Dom.XmlDocument();
            doc.LoadXml(xml);
            var toast = new ToastNotification(doc);
            toast.Tag = "n" + id;
            toast.Group = "beam";
            ToastNotificationManager.CreateToastNotifier(Aumid).Show(toast);
        }

        // The notification: its title and text, a Reply box with Send, its buttons. Each click's arguments say which
        // notification (t), which item (i) and device (d), and what (a: "" the notification, "b0"… a button, "reply").
        public static string Xml(int id, string title, string text, ToastExtras extras, string itemId)
        {
            var args = new StringBuilder("t=" + id);
            if (!string.IsNullOrEmpty(itemId)) args.Append(";i=" + itemId);
            if (extras != null && !string.IsNullOrEmpty(extras.ReplyTo)) args.Append(";d=" + extras.ReplyTo);
            string a = args.ToString();
            var x = new StringBuilder();
            x.Append("<toast launch=\"").Append(Esc(a)).Append("\">");
            x.Append("<visual><binding template=\"ToastGeneric\">");
            x.Append("<text>").Append(Esc(Cut(title, 120))).Append("</text>");
            foreach (var line in (text ?? "").Split('\n').Where(l => l.Trim().Length > 0).Take(2)) x.Append("<text>").Append(Esc(Cut(line, 300))).Append("</text>");
            x.Append("</binding></visual>");
            bool reply = extras != null && !string.IsNullOrEmpty(extras.ReplyTo);
            var buttons = extras != null ? extras.Buttons : new List<ToastButton>();
            if (reply || buttons.Count > 0)
            {
                x.Append("<actions>");
                if (reply)
                {
                    x.Append("<input id=\"reply\" type=\"text\" placeHolderContent=\"").Append(Esc("Reply to " + (extras.ReplyName ?? "it"))).Append("\"/>");
                    x.Append("<action content=\"Send\" hint-inputId=\"reply\" activationType=\"background\" arguments=\"").Append(Esc(a + ";a=reply")).Append("\"/>");
                }
                for (int i = 0; i < buttons.Count && i < (reply ? 4 : 5); i++)
                    x.Append("<action content=\"").Append(Esc(buttons[i].Label)).Append("\" activationType=\"background\" arguments=\"").Append(Esc(a + ";a=b" + i)).Append("\"/>");
                x.Append("</actions>");
            }
            x.Append("</toast>");
            return x.ToString();
        }

        static string Esc(string s) { return SecurityElement.Escape(s ?? "") ?? ""; }
        static string Cut(string s, int n) { s = s ?? ""; return s.Length > n ? s.Substring(0, n - 1) + "…" : s; }

        // A click (from Windows, on a thread of its own; or a test): done on the UI thread.
        public static void Activated(string invoked, IDictionary<string, string> input)
        {
            var parts = new Dictionary<string, string>();
            foreach (var p in (invoked ?? "").Split(';'))
            {
                int eq = p.IndexOf('=');
                if (eq > 0) parts[p.Substring(0, eq)] = p.Substring(eq + 1);
            }
            string t, item, device, what, text = null;
            parts.TryGetValue("t", out t);
            parts.TryGetValue("i", out item);
            parts.TryGetValue("d", out device);
            parts.TryGetValue("a", out what);
            if (input != null) input.TryGetValue("reply", out text);
            int id;
            int.TryParse(t, out id);
            var a = app;
            if (a == null) return;
            a.Post(() => Do(a, id, item, device, what ?? "", text));
        }

        static void Do(App a, int id, string item, string device, string what, string text)
        {
            Shown s;
            shown.TryGetValue(id, out s);
            if (item != null && !Config.ValidId(item)) item = null; // (only ids: the arguments came from outside)
            if (device != null && !Config.ValidId(device)) device = null;
            Log.Write("Notification clicked" + (what.Length > 0 ? " (" + what + ")" : "") + (s == null ? ", from an earlier run" : ""));
            if (what == "reply")
            {
                string to = s != null && s.ReplyTo != null ? s.ReplyTo : device;
                if (to != null && !string.IsNullOrWhiteSpace(text)) a.ReplyFromNotification(to, text.Trim());
                return;
            }
            if (what.StartsWith("b") && s != null)
            {
                int n;
                if (int.TryParse(what.Substring(1), out n) && n >= 0 && n < s.Buttons.Count) { s.Buttons[n].Do(); return; }
            }
            if (s != null && what.Length == 0) { (s.Click ?? (() => a.ShowMain(null, null)))(); return; }
            // One from an earlier run (or a button it no longer knows): its item, else Beam
            if (item != null) a.OpenItemById(item);
            else a.ShowMain(null, null);
        }
    }

    // ------------------------------------------------------------------ the COM side Windows calls for a click

    [StructLayout(LayoutKind.Sequential), Serializable]
    public struct NotificationUserInputData
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string Key;
        [MarshalAs(UnmanagedType.LPWStr)] public string Value;
    }

    [ComImport, Guid("53E31837-6600-4A81-9395-75CFFE746F94"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown), ComVisible(true)]
    public interface INotificationActivationCallback
    {
        void Activate([In, MarshalAs(UnmanagedType.LPWStr)] string appUserModelId, [In, MarshalAs(UnmanagedType.LPWStr)] string invokedArgs,
            [In, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 3)] NotificationUserInputData[] data, [In, MarshalAs(UnmanagedType.U4)] uint dataCount);
    }

    [ClassInterface(ClassInterfaceType.None), ComSourceInterfaces(typeof(INotificationActivationCallback)), Guid(Toasts.ActivatorClsid), ComVisible(true)]
    public class ToastActivator : INotificationActivationCallback
    {
        public void Activate(string appUserModelId, string invokedArgs, NotificationUserInputData[] data, uint dataCount)
        {
            var input = new Dictionary<string, string>();
            if (data != null) for (int i = 0; i < data.Length && i < dataCount; i++) if (data[i].Key != null) input[data[i].Key] = data[i].Value ?? "";
            Toasts.Activated(invokedArgs, input);
        }
    }
}
