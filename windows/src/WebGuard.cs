// What Beam's own pages send to the server, looked at by the host on the way out (Beam 1.6, WebResourceRequested):
// - remote control requests get this install's device key (X-Beam-Device-Key): the server takes the app's token from
//   a page for remote control only with it, and the page never sees it (the viewer window adds it to every /api/
//   request);
// - while another device controls this PC, requests that would widen access to Beam get 403 here: a pairing link
//   or its QR code, approving a sign-in, setting the password, the server's settings and blocked machines, signing out
//   the other devices, moving the server, its admin actions, and controlling another PC from this one
//   (RcPolicy.WidensAccess). The native side refuses the same (App.RcBlocks).
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using Microsoft.Web.WebView2.Core;

namespace Beam
{
    static class WebGuard
    {
        // The chat window: these only (most of its traffic never passes through here).
        static readonly string[] Watched = { "*/api/rc/*", "*/api/pair*", "*/api/qr*", "*/api/login-requests/*", "*/api/password*",
            "*/api/settings*", "*/api/security/*", "*/api/move*", "*/api/admin/*" };

        public static void Attach(CoreWebView2 core, App app, Func<string> origin, bool everyApi)
        {
            if (everyApi) core.AddWebResourceRequestedFilter("*/api/*", CoreWebView2WebResourceContext.All);
            else foreach (var f in Watched) core.AddWebResourceRequestedFilter(f, CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += (s, e) => OnRequest(core, app, origin(), everyApi, e);
        }

        static void OnRequest(CoreWebView2 core, App app, string origin, bool everyApi, CoreWebView2WebResourceRequestedEventArgs e)
        {
            Uri u, o;
            if (!Uri.TryCreate(e.Request.Uri ?? "", UriKind.Absolute, out u) || !Uri.TryCreate(origin ?? "", UriKind.Absolute, out o)) return;
            if (u.Scheme != o.Scheme || !string.Equals(u.Host, o.Host, StringComparison.OrdinalIgnoreCase) || u.Port != o.Port) return;
            string path = u.AbsolutePath, method = e.Request.Method ?? "GET";
            string what = app.Rc != null && app.Rc.Active ? RcPolicy.WidensAccess(method, path) : null;
            if (what != null)
            {
                var body = new Dictionary<string, object>();
                body["error"] = "Not while another device controls this PC: stop that session first.";
                body["reason"] = "rc-active";
                var bytes = Encoding.UTF8.GetBytes(Json.Stringify(body));
                try
                {
                    e.Response = core.Environment.CreateWebResourceResponse(new MemoryStream(bytes), 403, "Forbidden",
                        "Content-Type: application/json\r\nCache-Control: no-store");
                }
                catch (Exception ex) { Log.Error("Remote control: refusing a page request", ex); }
                Log.Write("Remote control: refused " + what + " from the page while another device controls this PC");
                return;
            }
            if (DeviceKey.Value != null && (everyApi || path.StartsWith("/api/rc/", StringComparison.Ordinal)))
            {
                try { e.Request.Headers.SetHeader("X-Beam-Device-Key", DeviceKey.Value); }
                catch (Exception ex) { Log.Error("The device key for a page request", ex); }
            }
        }
    }
}
