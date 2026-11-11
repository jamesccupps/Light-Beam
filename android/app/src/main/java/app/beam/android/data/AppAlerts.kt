package app.beam.android.data

import app.beam.android.BeamApp
import app.beam.android.R
import app.beam.android.notify.Notifier
import org.json.JSONObject

/**
 * (1.19, server 1.33) The alerts inbox: the user's other programs post their alerts to Beam (the ntfy way), and an
 * alert the server says pops up (`inbox` events with `notify`: priority 3 and up, the app neither muted nor snoozed)
 * becomes a notification here, on "Alerts from your apps" (priority 4-5: its urgent channel). Tapping it opens the
 * list (the server's `#alerts` page, [app.beam.android.ui.FilesActivity.alertsIntent]); its link opens in the browser.
 * Alerts that came while the phone couldn't hear them are shown once after it reconnects (the last day). Beam's own
 * alerts are in the list too, but pop up as before ([Alerts]).
 */
class AppAlerts(private val app: BeamApp) {
    /** An `inbox` event (from the event stream's thread). */
    fun onEvent(o: JSONObject) {
        if (!o.optBoolean("notify")) return
        val a = o.optJSONObject("alert") ?: return
        show(a, o.optJSONObject("sender")?.optString("name").orEmpty())
    }

    private fun show(a: JSONObject, appName: String) {
        val id = a.optString("id")
        if (id.isEmpty() || a.optString("text").isEmpty()) return
        if (!app.prefs.markAlertShown("inbox:$id")) return // shown before (event, then catch-up)
        Notifier.appAlert(app, a, appName.ifEmpty { app.getString(R.string.inbox_some_app) })
    }

    /** After every connect: what came while the phone couldn't hear it (the last day). Blocking. */
    fun catchUp() {
        val api = app.api ?: return
        if (app.repo.state.value.info?.has(FEATURE) != true) return
        val o = try {
            api.inbox()
        } catch (_: Exception) {
            return // (an untrusted sign-in: 403; offline)
        }
        val list = o.optJSONArray("alerts") ?: return
        val senders = HashMap<String, JSONObject>()
        o.optJSONArray("senders")?.let { a -> for (i in 0 until a.length()) a.optJSONObject(i)?.let { senders[it.optString("id")] = it } }
        val now = System.currentTimeMillis()
        val alerts = (0 until list.length()).mapNotNull { list.optJSONObject(it) }
        if (app.prefs.inboxSeenUntil == 0L) {
            // First time with this server: old alerts are old news.
            alerts.forEach { app.prefs.markAlertShown("inbox:${it.optString("id")}") }
            app.prefs.inboxSeenUntil = now
            return
        }
        for (a in alerts.sortedBy { it.optLong("at") }) {
            val s = senders[a.optString("sender")] ?: continue
            val quiet = s.optBoolean("builtIn") || s.optBoolean("muted") || s.optLong("snoozeUntil") > now || a.optInt("priority", 3) < 3
            if (quiet || a.optLong("at") < now - CATCH_UP_MS) continue
            show(a, s.optString("name"))
        }
        app.prefs.inboxSeenUntil = now
    }

    companion object {
        const val FEATURE = "inbox"
        private const val CATCH_UP_MS = 24 * 3_600_000L
    }
}
