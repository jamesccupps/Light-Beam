package app.beam.android.data

import app.beam.android.BeamApp
import app.beam.android.core.Alert
import app.beam.android.notify.Notifier
import org.json.JSONObject

/**
 * Server alerts (server 1.3, `alert` events): a device's battery or storage running low, a device going
 * offline (and coming back), the server's disk filling up. Each becomes a notification on the "Alerts" channel.
 * Alerts about this phone itself are for the other devices (the phone shows its own battery), except the
 * server's disk. Alerts raised while the phone was offline are shown once after it reconnects (the last day).
 */
class Alerts(private val app: BeamApp) {
    /** An `alert` event (from the event stream's thread). */
    fun onEvent(o: JSONObject) = show(Alert.parse(o))

    fun show(alert: Alert) {
        if (alert.text.isBlank()) return
        val me = app.repo.me
        if (alert.device != null && (alert.device == me || alert.device == app.prefs.deviceId) && alert.kind != KIND_SERVER_DISK) return
        if (alert.id.isNotEmpty() && !app.prefs.markAlertShown(alert.id)) return // shown before (event, then catch-up)
        val name = alert.device?.let { app.repo.state.value.devicesById[it]?.name }
        Notifier.alert(app, alert, name)
    }

    /** After every connect: what was raised while the phone couldn't hear it. Blocking. */
    fun catchUp() {
        val api = app.api ?: return
        if (app.repo.state.value.info?.has("alerts") != true) return
        val list = try {
            api.alerts()
        } catch (_: Exception) {
            return
        }
        val now = System.currentTimeMillis()
        if (app.prefs.alertsSeenUntil == 0L) {
            // First time with this server: old alerts are old news.
            list.forEach { if (it.id.isNotEmpty()) app.prefs.markAlertShown(it.id) }
            app.prefs.alertsSeenUntil = now
            return
        }
        list.filter { it.at > now - CATCH_UP_MS }.sortedBy { it.at }.forEach(::show)
    }

    companion object {
        const val KIND_SERVER_DISK = "serverDisk"
        private const val CATCH_UP_MS = 24 * 3_600_000L
    }
}
