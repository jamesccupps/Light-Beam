package app.beam.android.data

import app.beam.android.BeamApp
import app.beam.android.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

/**
 * This phone's Beam settings, kept on the server too (Beam 1.8.2, like the PCs' since 1.8.1; the user: "we should
 * definetly have a way to backup setting and everything and restore them if needed for all computers"): sent when they
 * change, never the sign-in or the ids. A reinstall comes back as the same device ([Prefs.deviceId] comes from
 * ANDROID_ID), so once per install the earlier install's backup is offered back ([offer]; MainActivity asks). Settings →
 * "Restore settings…" does it any time, also from another phone's backup. Sharing notifications with the PCs comes back
 * on only on its own screen: Android's notification access is the user's to give again.
 *
 * Battery: no timers of its own. A change goes [delayMs] later (changes in a row as one), and only when the server
 * doesn't have it yet ([Prefs.backupSent]); one that didn't get through goes at the next connect.
 */
class SettingsBackups(private val app: BeamApp) {
    /** A backup on the server; [here]: this phone's own (an earlier install of Beam on it). */
    class Choice(val device: String, val name: String, val install: String, val at: Long, val here: Boolean, val settings: JSONObject)

    private val _offer = MutableStateFlow<Choice?>(null)

    /** An earlier install's settings to offer back after a reinstall, until the offer is answered. */
    val offer: StateFlow<Choice?> = _offer

    /** How long a change waits for more before it goes (tests shorten it). */
    @Volatile var delayMs = 10_000L

    @Volatile private var job: Job? = null
    private val checking = AtomicBoolean(false)
    private val sending = Any()

    fun start() = app.prefs.watchSettings { changed() }

    /** The server keeps them (1.8.1). Listed only: API 3 servers before it say nothing about backups. */
    private val serverKeeps: Boolean get() = app.repo.state.value.info?.lists(FEATURE) == true

    /** A setting changed (here, or a restore): it goes in [delayMs]. Not before the offer after a reinstall was answered. */
    fun changed() {
        if (!app.prefs.restoreChecked) return
        job?.cancel()
        job = app.scope.launch(Dispatchers.IO) {
            delay(delayMs)
            send()
        }
    }

    /** Sends this install's settings unless the server has them already. Blocking. */
    fun send() {
        val api = app.api ?: return
        if (!serverKeeps || !app.prefs.restoreChecked) return
        synchronized(sending) {
            val settings = settingsOf(app.prefs)
            val mark = markOf(settings)
            if (mark == app.prefs.backupSent) return
            try {
                api.putBackup(app.prefs.installId, BuildConfig.VERSION_NAME, settings)
                app.prefs.backupSent = mark
            } catch (_: Exception) {
                // Offline, or not taken: again at the next connect or change.
            }
        }
    }

    /** Which server has which settings: "<server> <sha-256>". */
    private fun markOf(settings: JSONObject): String {
        val sha = MessageDigest.getInstance("SHA-256").digest(settings.toString().toByteArray()).joinToString("") { "%02x".format(it) }
        return "${app.prefs.serverId ?: app.prefs.baseUrl} $sha"
    }

    /**
     * The event stream opened (the devices and the server's features were just fetched): the first time, an earlier
     * install's backup is looked for; afterwards this install's goes up if the server lacks it. Blocking.
     */
    fun onConnected() {
        if (app.api == null || !serverKeeps) return
        val s = app.repo.state.value
        // A server without any of this phone's (a new or restored one) gets them again.
        if (s.fresh && s.devicesById[s.me]?.backupAt == null) app.prefs.backupSent = null
        if (app.prefs.restoreChecked) send() else check()
    }

    private fun check() {
        if (!checking.compareAndSet(false, true)) return
        try {
            val earlier = fetch("me", here = true).firstOrNull { it.install != app.prefs.installId }
            if (earlier == null) checked() else _offer.value = earlier
        } catch (_: Exception) {
            // Offline: the next connect looks again.
        } finally {
            checking.set(false)
        }
    }

    /** The offer was answered (or there was nothing to offer): from now on this install's settings go up. */
    fun checked() {
        _offer.value = null
        if (!app.prefs.restoreChecked) app.prefs.restoreChecked = true
        changed()
    }

    /** Unpaired or another server: an offer for the old one goes. */
    fun forget() {
        job?.cancel()
        _offer.value = null
    }

    /** A device's Android backups on the server, newest first. Blocking; throws when the server can't be asked. */
    private fun fetch(device: String, here: Boolean): List<Choice> {
        val api = app.api ?: return emptyList()
        val r = api.backups(device)
        val list = r.optJSONArray("backups") ?: return emptyList()
        val id = r.optString("device").ifEmpty { device }
        val name = r.optString("name")
        return (0 until list.length()).mapNotNull { i ->
            val b = list.optJSONObject(i) ?: return@mapNotNull null
            val settings = b.optJSONObject("settings")
            if (b.optString("app") != "android" || settings == null) null
            else Choice(id, name, b.optString("install"), b.optLong("at"), here, settings)
        }
    }

    /**
     * Settings → "Restore settings…": this phone's earlier installs' backups, then the newest of each other phone's.
     * Blocking; throws when the server can't be asked.
     */
    fun choices(): List<Choice> {
        val list = fetch("me", here = true).filter { it.install != app.prefs.installId }.toMutableList()
        val s = app.repo.state.value
        for (d in s.devices.sortedByDescending { it.backupAt ?: 0L }) {
            if (d.id == s.me || d.platform != "android" || d.backupAt == null) continue
            runCatching { fetch(d.id, here = false).firstOrNull() }.getOrNull()?.let(list::add)
        }
        return list.take(MAX_CHOICES)
    }

    /**
     * Puts [c]'s settings back (main thread). Another phone's name stays its own, and this phone is never muted or the
     * tile's target. Sharing notifications with the PCs isn't switched on here: true when the backup had it on and it's
     * off now (the caller offers its screen).
     */
    fun apply(c: Choice): Boolean {
        val s = c.settings
        applyTo(app.prefs, s, setOf(app.prefs.deviceId, app.repo.me))
        strings(s, "sharedApps")?.let { want ->
            val have = app.prefs.sharedApps
            for (pkg in have - want) app.phone.setAppShared(pkg, false)
            for (pkg in want - have) app.phone.setAppShared(pkg, true)
        }
        app.ensureBackgroundService()
        if (c.here) (s.opt("deviceName") as? String)?.trim()?.take(Prefs.MAX_NAME)?.takeIf { it.isNotEmpty() && it != app.prefs.deviceName }?.let(app::renameDevice)
        checked()
        return s.optBoolean("shareNotifications") && !app.phone.enabled
    }

    companion object {
        const val FEATURE = "backups"
        private const val MAX_CHOICES = 8

        /** Lists are cut to this many, so a backup stays far below the server's 32 KB. */
        private const val MAX_LIST = 200

        /** What a backup of [p] holds (lists sorted: the same settings always read the same). */
        fun settingsOf(p: Prefs): JSONObject = JSONObject()
            .put("deviceName", p.deviceName)
            .put("stayConnected", p.stayConnected)
            .put("autoCopy", p.autoCopy)
            .put("autoDownload", p.autoDownload)
            .put("wifiOnlyDownloads", p.wifiOnlyDownloads)
            .put("maxDownloadMb", p.maxDownloadMb)
            .put("tileTarget", p.tileTarget.orEmpty()) // "": ask
            .put("mutedDevices", JSONArray(p.mutedDevices.sorted().take(MAX_LIST)))
            .put("autoCopyDevices", JSONArray(p.autoCopyDevices.sorted().take(MAX_LIST)))
            .put("shareNotifications", p.shareNotifications)
            .put("sharedApps", JSONArray(p.sharedApps.sorted().take(MAX_LIST)))

        /** Puts [s] into [p], all but the name and the shared apps (those go through the app). [mine]: this phone's ids. */
        fun applyTo(p: Prefs, s: JSONObject, mine: Set<String>) {
            (s.opt("stayConnected") as? Boolean)?.let { p.stayConnected = it }
            (s.opt("autoCopy") as? Boolean)?.let { p.autoCopy = it }
            (s.opt("autoDownload") as? Boolean)?.let { p.autoDownload = it }
            (s.opt("wifiOnlyDownloads") as? Boolean)?.let { p.wifiOnlyDownloads = it }
            (s.opt("maxDownloadMb") as? Number)?.toLong()?.takeIf { it >= 0 }?.let { p.maxDownloadMb = it }
            if (s.has("tileTarget")) p.tileTarget = (s.opt("tileTarget") as? String)?.takeIf { it.isNotEmpty() && it !in mine }
            strings(s, "mutedDevices")?.let { p.mutedDevices = it - mine }
            strings(s, "autoCopyDevices")?.let { p.autoCopyDevices = it - mine }
        }

        fun strings(s: JSONObject, key: String): Set<String>? =
            s.optJSONArray(key)?.let { a -> (0 until minOf(a.length(), MAX_LIST)).mapNotNull { (a.opt(it) as? String)?.takeIf(String::isNotBlank) }.toSet() }
    }
}
