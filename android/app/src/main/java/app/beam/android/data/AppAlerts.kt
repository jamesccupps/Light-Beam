package app.beam.android.data

import app.beam.android.BeamApp
import app.beam.android.R
import app.beam.android.core.BeamException
import app.beam.android.notify.Notifier
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/**
 * (1.19, server 1.33) The alerts inbox: the user's other programs post their alerts to Beam (the ntfy way), and an
 * alert the server says pops up (`inbox` events with `notify`: priority 3 and up, the app neither muted nor snoozed)
 * becomes a notification here, on "Alerts from your apps" (priority 4-5: its urgent channel). Tapping it opens the
 * list (the server's `#alerts` page, [app.beam.android.ui.FilesActivity.alertsIntent]); its link opens in the browser.
 * Alerts that came while the phone couldn't hear them are shown once after it reconnects (the last day). Beam's own
 * alerts are in the list too, but pop up as before ([Alerts]).
 */
class AppAlerts(private val app: BeamApp) {
    /**
     * (1.20.2, the 2026-11-21 audit) The main list's Alerts row, as on the web and Windows: the newest alert ([line], its
     * app's name first) and how many came since this device last looked (the server's read marker). Null: none here
     * (a server without Alerts, a sign-in that may not see them, or not read yet).
     */
    data class Row(val line: String?, val at: Long, val unread: Int)

    private val _row = MutableStateFlow<Row?>(null)
    val row: StateFlow<Row?> = _row
    private val reading = AtomicBoolean(false)
    @Volatile private var again = false

    /** Reads the list again for the row, off the event stream's thread (one at a time; one more if asked meanwhile). */
    fun refreshRow() {
        if (!reading.compareAndSet(false, true)) {
            again = true
            return
        }
        app.scope.launch(Dispatchers.IO) {
            try {
                do {
                    again = false
                    readRow()
                } while (again)
            } finally {
                reading.set(false)
            }
        }
    }

    private fun readRow() {
        val api = app.api ?: return
        if (app.repo.state.value.info?.has(FEATURE) != true) {
            _row.value = null
            return
        }
        try {
            setRow(api.inbox())
        } catch (e: BeamException) {
            if (e.status == 403 || e.status == 404) _row.value = null // (an untrusted sign-in sees none)
        } catch (_: Exception) {
        }
    }

    private fun setRow(o: JSONObject) {
        val list = o.optJSONArray("alerts") ?: JSONArray()
        val read = o.optLong("read")
        val names = HashMap<String, String>()
        o.optJSONArray("senders")?.let { a -> for (i in 0 until a.length()) a.optJSONObject(i)?.let { names[it.optString("id")] = it.optString("name") } }
        var unread = 0
        var newest: JSONObject? = null
        for (i in 0 until list.length()) {
            val a = list.optJSONObject(i) ?: continue
            if (a.optLong("at") > read) unread++
            if (newest == null || a.optLong("at") > newest.optLong("at")) newest = a
        }
        val line = newest?.let { a ->
            val head = listOf(a.optString("emojis"), a.optString("title")).filter { it.isNotBlank() }.joinToString(" ").ifBlank { a.optString("text") }
            val who = names[a.optString("sender")]?.takeIf { it.isNotBlank() } ?: app.getString(R.string.inbox_some_app)
            "$who: $head".replace(Regex("\\s+"), " ").take(120)
        }
        _row.value = Row(line, newest?.optLong("at") ?: 0L, unread)
    }

    /** `inbox-read` or `inbox-changed` (this device looked somewhere else; an alert deleted, an app removed). */
    fun onChanged() = refreshRow()

    /** An `inbox` event (from the event stream's thread). */
    fun onEvent(o: JSONObject) {
        refreshRow() // (1.20.2) the Alerts row: every alert, quiet ones too
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
        } catch (e: Exception) {
            if (e is BeamException && (e.status == 403 || e.status == 404)) _row.value = null
            return // (an untrusted sign-in: 403; offline)
        }
        setRow(o) // (1.20.2) the main list's Alerts row
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
