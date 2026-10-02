package app.beam.android.phone

import android.app.ActivityOptions
import android.app.Notification
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.ComponentName
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.service.quicksettings.TileService
import androidx.core.app.NotificationManagerCompat
import androidx.core.graphics.drawable.toBitmap
import app.beam.android.BeamApp
import app.beam.android.core.BeamApi
import app.beam.android.core.BeamException
import app.beam.android.core.strings
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * "Notifications on your PCs" (server 1.5 `phone-notifications`): the notifications of the apps the user picked go
 * to the server for the devices set to show them; replies, buttons and dismissals asked for there come back as
 * `notification-request` events and are carried out here.
 *
 * - Privacy: content lives in memory only (never a file, prefs or a log). Package names and icons may be cached.
 * - Battery: with the switch off Android doesn't even bind the listener (`requestUnbind`), so it costs nothing. With
 *   it on, about one request per shared notification, sent while the phone is awake for it anyway: a new one goes
 *   at once, its updates at most every [UPDATE_EVERY_MS] (the latest wins), removals after [REMOVE_DELAY_MS], one
 *   request at a time. No timers of its own; a failed send is tried again after 2, 10 and 60 seconds, and at the
 *   next connect or liveness poke (sooner when the network comes back first).
 * - The server keeps them in memory for a day: whenever this process (or the listener, after a reconnect) starts
 *   sharing, it first clears what the server still has from before, then sends what the shade holds now.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class PhoneNotifications(private val app: BeamApp) {
    /** The listener while Android has it bound (it runs in this process). */
    @Volatile var listener: NotificationListenerService? = null
        private set

    private val _changes = MutableStateFlow(0)
    /** Bumped whenever the switch, the access or the listener changes (screens and the tile follow it). */
    val changes: StateFlow<Int> = _changes

    /** The master switch. */
    val enabled: Boolean get() = app.prefs.shareNotifications

    /** Android's one-time "notification access" for Beam. */
    val accessGranted: Boolean get() = NotificationManagerCompat.getEnabledListenerPackages(app).contains(app.packageName)

    /** The server takes them (1.5). */
    val serverReady: Boolean get() = app.repo.state.value.info?.lists(FEATURE) == true

    /** Everything is in place: notifications of picked apps go out as they come. */
    val sharing: Boolean get() = enabled && app.prefs.phoneSetupDone && accessGranted && serverReady && app.api != null

    // ---------------------------------------------------------------- what's shared (memory only)

    private class Shared(
        val sbnKey: String,
        val notification: SharedNotification,
        val actions: List<Notification.Action>,
        val groupKey: String?,
        val summary: Boolean,
        /** FLAG_NO_CLEAR: Android ignores a listener's cancel of it. */
        val noClear: Boolean,
    )

    private class Icon(val sha: String, val png: ByteArray)

    private val active = ConcurrentHashMap<String, Shared>()
    /** What the server has (this server instance): key → hash of the content it got. */
    private val sent = ConcurrentHashMap<String, Int>()
    /** When each key was last sent, for the update floor. */
    private val lastPut = ConcurrentHashMap<String, Long>()
    /**
     * Keys whose next PUT is a re-send (`"resent": true`): the server most likely has them already (a restarted
     * server, this process's first sync, the listener connecting again, an app picked with notifications in the
     * shade). PCs show them without a balloon. A send the server never took isn't one (the PCs judge it by `posted`),
     * and a real change makes it a normal send again.
     */
    private val resend: MutableSet<String> = ConcurrentHashMap.newKeySet()
    /** Removals that didn't get through yet. */
    private val unsentRemovals: MutableSet<String> = ConcurrentHashMap.newKeySet()
    /** Failed sends in a row, per key (the backoff). */
    private val failures = ConcurrentHashMap<String, Int>()
    private val pending = ConcurrentHashMap<String, Job>()
    /**
     * Keys with a send scheduled that hasn't started yet: it reads the content when it starts, so a change meanwhile
     * needs no send of its own. Once it has started, one does.
     */
    private val waiting: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private val requests = Mutex()
    /** Bumped when sharing stops: a send in flight then doesn't count as on the server. */
    private val generation = AtomicInteger()
    private val iconsOnServer: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private val icons = ConcurrentHashMap<String, Icon>()
    private val noIcon: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private val names = ConcurrentHashMap<String, String>()
    @Volatile private var serverInstance: String? = null
    /** The server's copy was replaced since this process (or the listener) started sharing. */
    @Volatile private var synced = false
    @Volatile private var syncJob: Job? = null
    /** A sync's `DELETE` is under way (a connect meanwhile needn't start another). */
    @Volatile private var syncing = false
    @Volatile private var removalJob: Job? = null
    /** The switch just went on: its first sync sends the whole shade as re-sends (like picking an app). */
    @Volatile private var resendShade = false
    /** [syncedAt], loaded when first needed. */
    @Volatile private var syncedAtCache = -1L

    /** The listener's callbacks, one at a time and in order, off the main thread (some need binder calls). */
    private val serial = Dispatchers.IO.limitedParallelism(1)

    /** The shared ones right now (tests). */
    val sharedKeys: Set<String> get() = active.keys.toSet()

    private fun later(block: () -> Unit) {
        app.scope.launch(serial) { block() }
    }

    // ---------------------------------------------------------------- the switches

    fun setEnabled(on: Boolean) {
        if (enabled == on) return
        app.prefs.shareNotifications = on
        if (on) {
            app.prefs.phoneRemovalPending = false
            synced = false
            resendShade = true
            if (accessGranted) runCatching { NotificationListenerService.requestRebind(ComponentName(app, ShareListenerService::class.java)) }
            listener?.let { l -> later { fullSync(l) } }
        } else {
            stopSharing(removeFromServer = true)
            listener?.let { runCatching { it.requestUnbind() } }
            listener = null
        }
        changed()
    }

    /** Whether notifications of app [pkg] are shared (each app is off until the user picks it). */
    fun setAppShared(pkg: String, on: Boolean) {
        app.prefs.sharedApps = if (on) app.prefs.sharedApps + pkg else app.prefs.sharedApps - pkg
        val l = listener
        later {
            if (on) {
                if (l != null && sharing) {
                    val ranking = runCatching { l.currentRanking }.getOrNull()
                    activeOf(l).filter { it.packageName == pkg }.forEachIndexed { i, sbn ->
                        share(l, sbn, ranking, delayMs = i * SPACING_MS, resent = true)
                    }
                }
            } else {
                for (key in active.filterValues { it.notification.app == pkg }.keys) remove(key)
            }
        }
        changed()
    }

    private fun stopSharing(removeFromServer: Boolean) {
        generation.incrementAndGet()
        syncJob?.cancel()
        pending.values.forEach { it.cancel() }
        pending.clear()
        waiting.clear()
        active.clear()
        sent.clear()
        lastPut.clear()
        resend.clear()
        unsentRemovals.clear()
        failures.clear()
        synced = false
        if (!removeFromServer) return
        app.prefs.phoneRemovalPending = true
        removeAllWithRetries()
    }

    /**
     * `DELETE /api/phone/notifications`, after any send in flight, tried again after 2, 10 and 60 s (and at the next
     * connect or liveness poke). Not once sharing is back: its first sync replaces the server's copy anyway.
     */
    private fun removeAllWithRetries() {
        removalJob?.cancel()
        removalJob = app.scope.launch(Dispatchers.IO) {
            for (wait in listOf(0L) + BACKOFF_MS) {
                delay(wait)
                if (sharing || !app.prefs.phoneRemovalPending) return@launch
                val done = requests.withLock {
                    sent.clear()
                    !app.prefs.phoneRemovalPending || removeAllFromServer(app.api?.pinned())
                }
                if (done) return@launch
            }
        }
    }

    /** True when the server has none of this phone's notifications (or can't have: no sign-in, an older server). */
    private fun removeAllFromServer(api: BeamApi?): Boolean {
        if (api == null || !serverReady) return true
        return try {
            api.deleteAllPhoneNotifications()
            app.prefs.phoneRemovalPending = false
            true
        } catch (_: Exception) {
            false
        }
    }

    /**
     * Unpairing, or switching to another server: what this server holds goes now, while the sign-in still works
     * (best effort; the server drops them after a day anyway), then sharing stops here.
     */
    fun leaveServer() {
        // A copy that stays with this server: the DELETE may wait for a send in flight, and by then the app may point
        // at another one ("Switch anyway" moves the same BeamApi).
        val api = app.api?.pinned()
        if ((enabled || app.prefs.phoneRemovalPending) && api != null && serverReady) {
            app.scope.launch(Dispatchers.IO) { requests.withLock { runCatching { api.deleteAllPhoneNotifications() } } }
        }
        forget()
    }

    /** Signed out or unpaired: what was held for that server goes (it's that server's business now). */
    fun forget() {
        stopSharing(removeFromServer = false)
        app.prefs.phoneRemovalPending = false
        serverInstance = null
        iconsOnServer.clear()
        syncedAtCache = 0L
        if (app.prefs.phoneSyncedAt != 0L) app.prefs.phoneSyncedAt = 0L
    }

    /**
     * Paired with a server (maybe another one): the first setup ("Show on") belongs to a server, so on one where it
     * wasn't confirmed sharing stays off until the user switches it on there.
     */
    fun onPaired() {
        forget()
        if (enabled && !app.prefs.phoneSetupDone) {
            app.prefs.shareNotifications = false
            listener?.let { runCatching { it.requestUnbind() } }
            listener = null
        }
        changed()
    }

    // ---------------------------------------------------------------- from the listener

    fun onListenerConnected(l: NotificationListenerService) {
        listener = l
        if (!enabled) {
            // Off: nothing to do here. Android unbinds until the switch goes on again (requestRebind).
            runCatching { l.requestUnbind() }
            listener = null
        } else {
            synced = false
            later { fullSync(l) }
        }
        changed()
    }

    fun onListenerDisconnected(l: NotificationListenerService) {
        if (listener === l) listener = null
        // Access taken away while sharing: what was shared goes too.
        if (enabled && !accessGranted) stopSharing(removeFromServer = true)
        changed()
    }

    fun onPosted(l: NotificationListenerService, sbn: StatusBarNotification, ranking: NotificationListenerService.RankingMap?) {
        if (!enabled) return
        later {
            noteRecent(sbn.packageName)
            if (sharing) share(l, sbn, ranking)
        }
    }

    fun onRemoved(sbn: StatusBarNotification) {
        if (!enabled) return
        later {
            val key = NotificationReader.keyOf(sbn)
            if (active.containsKey(key) || sent.containsKey(key)) remove(key)
        }
    }

    /**
     * Replaces the server's copy with the shade as it is now: after this process or the listener (re)started, the
     * server may still hold notifications that went away meanwhile (a reboot, an update, a kill). They'd stay on the
     * PCs for a day and couldn't be dismissed.
     */
    private fun fullSync(l: NotificationListenerService) {
        val all = activeOf(l)
        all.forEach { noteRecent(it.packageName) }
        if (!sharing) return
        // What went away while the listener was gone (Android tells it nothing then) isn't sent again.
        val inShade = all.map { NotificationReader.keyOf(it) }.toSet()
        active.keys.retainAll(inShade)
        resend.retainAll(inShade)
        val known = active.keys.toSet()
        val wholeShade = resendShade
        resendShade = false
        val syncedUntil = syncedAt()
        val ranking = runCatching { l.currentRanking }.getOrNull()
        for (sbn in all) share(l, sbn, ranking, send = false)
        // Re-sends: what the server most likely has. The switch just went on: the whole shade (like picking an app).
        // One this process sent: if the server took it as it is now. Any other (after a restart, or the listener gone
        // a while): if it was posted before the newest one the server took. Anything newer is new to the PCs, which
        // judge it by `posted`.
        for ((key, s) in active) {
            val had = when {
                wholeShade -> true
                key in known -> sent[key] == NotificationReader.contentHash(s.notification)
                else -> s.notification.posted in 1..syncedUntil
            }
            if (had) resend += key
        }
        val gen = generation.get()
        syncJob?.cancel()
        syncJob = app.scope.launch(Dispatchers.IO) {
            for (wait in listOf(0L) + BACKOFF_MS) {
                delay(wait)
                if (gen != generation.get() || !sharing) return@launch
                syncing = true
                val cleared = try {
                    requests.withLock {
                        if (gen != generation.get()) return@withLock false
                        val api = app.api?.pinned() ?: return@withLock false
                        try {
                            api.deleteAllPhoneNotifications()
                            // Sharing stopped meanwhile: that stop's own removal stands, and the next start syncs.
                            if (gen != generation.get()) return@withLock false
                            // One the server took meanwhile (as it is now) was on the PCs: a re-send too.
                            resend += active.filter { (key, s) -> sent[key] == NotificationReader.contentHash(s.notification) }.keys
                            sent.clear()
                            unsentRemovals.clear()
                            app.prefs.phoneRemovalPending = false
                            synced = true
                            true
                        } catch (_: Exception) {
                            false
                        }
                    }
                } finally {
                    syncing = false
                }
                if (cleared) {
                    // Everything in the shade now: the re-sends marked above, the rest as normal sends.
                    active.keys.forEachIndexed { i, key -> schedule(key, i * SPACING_MS) }
                    return@launch
                }
            }
        }
    }

    private fun activeOf(l: NotificationListenerService): List<StatusBarNotification> =
        runCatching { l.activeNotifications?.toList() }.getOrNull().orEmpty()

    /** Takes [sbn] into what's shared (or out of it), and sends it unless [send] is false. On [serial]. */
    private fun share(
        l: NotificationListenerService,
        sbn: StatusBarNotification,
        rankingMap: NotificationListenerService.RankingMap?,
        delayMs: Long? = null,
        resent: Boolean = false,
        send: Boolean = true,
    ) {
        val key = NotificationReader.keyOf(sbn)
        val ranking = rankingMap?.let { map -> NotificationListenerService.Ranking().takeIf { map.getRanking(sbn.key, it) } }
        val flags = sbn.notification?.flags ?: 0
        val summary = flags and Notification.FLAG_GROUP_SUMMARY != 0
        // Only a summary needs the others (are its children shared?).
        val activeNow = if (summary) activeOf(l) else emptyList()
        if (!NotificationReader.shareable(sbn, app.packageName, app.prefs.sharedApps, activeNow, ranking)) {
            if (active.containsKey(key)) remove(key) // it changed (now ongoing, or a summary with children)
            return
        }
        val read = NotificationReader.read(sbn, appName(sbn.packageName), null, NotificationReader.silent(sbn, ranking)) ?: return
        val previous = active[key]
        val isNew = previous == null && !sent.containsKey(key)
        active[key] = Shared(sbn.key, read.first, read.second, sbn.groupKey, summary, flags and Notification.FLAG_NO_CLEAR != 0)
        // A re-send stays one until the content really changes (an app posting the same again doesn't count).
        val changed = previous == null || NotificationReader.contentHash(previous.notification) != NotificationReader.contentHash(read.first)
        if (resent) resend += key else if (changed) resend -= key
        if (send) {
            // A new one goes at once (no wake lock needed); its updates at most every UPDATE_EVERY_MS. A send that's
            // already waiting picks up the latest version when it goes (so a busy app can't keep postponing it).
            val wait = delayMs ?: if (isNew) 0L else maxOf(PUT_DELAY_MS, (lastPut[key] ?: 0L) + UPDATE_EVERY_MS - System.currentTimeMillis())
            if (isNew || delayMs != null || key !in waiting) schedule(key, wait)
        }
        // Its group's summary showed alone until now: with a child shared, it would show twice.
        if (!summary) {
            for ((k, s) in active.entries.toList()) if (s.summary && s.groupKey == sbn.groupKey && s.notification.app == sbn.packageName) remove(k)
        }
    }

    private fun remove(key: String) {
        active.remove(key)
        resend -= key
        schedule(key, REMOVE_DELAY_MS)
    }

    // ---------------------------------------------------------------- sending (one request at a time)

    private fun schedule(key: String, delayMs: Long) {
        pending.remove(key)?.cancel()
        val job = app.scope.launch(Dispatchers.IO, start = CoroutineStart.LAZY) {
            delay(delayMs)
            val result = requests.withLock {
                waiting -= key // from here on a change needs a send of its own
                var r = flush(key)
                // The server takes about 20 changes a second per phone: a 429 waits its Retry-After (1 s), once.
                if (r == RETRY) {
                    delay(1_000)
                    r = flush(key)
                }
                r
            }
            if (result == DONE) {
                failures.remove(key)
            } else {
                // A network blip, a server problem or a second 429: again after 2, 10 and 60 s, and at the next
                // connect or liveness poke.
                val n = (failures[key] ?: 0) + 1
                failures[key] = n
                BACKOFF_MS.getOrNull(n - 1)?.let { wait -> app.scope.launch { schedule(key, wait) } }
            }
        }
        waiting += key
        pending[key] = job
        job.invokeOnCompletion { pending.remove(key, job) }
        job.start()
    }

    /** Sends what [key] is now on the phone: the notification, or that it's gone. */
    private fun flush(key: String): Int {
        // All of this send goes to one server, even if the app switches to another meanwhile.
        val api = app.api?.pinned() ?: return DONE
        if (!enabled || !serverReady) return DONE
        val shared = active[key]
        val gen = generation.get()
        try {
            if (shared == null) {
                if (sent.remove(key) != null || unsentRemovals.remove(key)) {
                    try {
                        api.deletePhoneNotification(key)
                    } catch (e: Exception) {
                        unsentRemovals += key
                        throw e
                    }
                }
                return DONE
            }
            val hash = NotificationReader.contentHash(shared.notification)
            if (sent[key] == hash && key !in resend) return DONE
            var body = shared.notification
            iconFor(body.app)?.let { icon ->
                body = body.copy(icon = icon.sha)
                if (icon.sha !in iconsOnServer) {
                    if (!api.hasPhoneIcon(icon.sha)) api.putPhoneIcon(icon.sha, icon.png)
                    iconsOnServer += icon.sha
                }
            }
            val json = body.toJson()
            if (key in resend) json.put("resent", true)
            lastPut[key] = System.currentTimeMillis() // the update floor counts from here, so a change meanwhile waits
            api.putPhoneNotification(key, json)
            if (gen == generation.get()) {
                sent[key] = hash
                resend -= key
                failures.remove(key)
                markSynced(body.posted)
            }
        } catch (e: BeamException) {
            return when {
                e.status == 429 -> RETRY
                e.status in 400..499 -> DONE // refused as it is (a limit): the next change of it tries again
                else -> FAILED
            }
        } catch (_: Exception) {
            return FAILED
        }
        return DONE
    }

    /**
     * [Prefs.phoneSyncedAt]: the posted time of the newest notification the server took (0: none yet). One saved while
     * the clock was ahead counts as now.
     */
    private fun syncedAt(): Long {
        if (syncedAtCache < 0) syncedAtCache = app.prefs.phoneSyncedAt.coerceAtMost(System.currentTimeMillis())
        return syncedAtCache
    }

    /**
     * The server took one posted at [posted]: what was posted until then is on the PCs, unless a send is still failing.
     * Kept for the next start of the process (a timestamp only), written only when it moves on. A time more than a
     * minute ahead (posted while the clock was wrong) doesn't count: it would stick until the clock caught up.
     */
    private fun markSynced(posted: Long) {
        val now = System.currentTimeMillis()
        if (failures.isNotEmpty() || posted > now + CLOCK_SLACK_MS) return
        val until = syncedAt()
        if (posted <= until && until <= now + CLOCK_SLACK_MS) return
        syncedAtCache = posted
        app.prefs.phoneSyncedAt = posted
    }

    /** The stream (re)connected: what didn't get through goes now (at a moment the phone is awake anyway). */
    fun onConnected() = catchUp(always = true)

    /** A liveness poke came back (after a network change): what failed meanwhile goes now, not after its backoff. */
    fun onAlive() = catchUp(always = false)

    private fun catchUp(always: Boolean) {
        if (!sharing) {
            // Switched off, or access taken away, while the server couldn't be reached: its copy goes now.
            if (app.prefs.phoneRemovalPending) removeAllWithRetries()
            return
        }
        val l = listener
        when {
            !synced && l != null -> if (!syncing) later { fullSync(l) }
            always || failures.isNotEmpty() || unsentRemovals.isNotEmpty() -> retryNow()
        }
    }

    /**
     * Sends what the server is missing now: what failed (without waiting for its backoff) and what never went. Not as
     * re-sends: the server never took them, so the PCs judge them by `posted` (a message from a minute ago still pops
     * up). A re-send that failed stays one. Keys with a send already queued keep it.
     */
    private fun retryNow() {
        val backingOff = failures.keys.toSet()
        failures.clear()
        fun due(key: String) = key in backingOff || !pending.containsKey(key)
        val missing = active.filter { (key, s) -> due(key) && sent[key] != NotificationReader.contentHash(s.notification) }.keys
        (unsentRemovals.filter { due(it) } + missing).forEachIndexed { i, key -> schedule(key, i * SPACING_MS) }
    }

    /**
     * The server's `instance` (in the stream's `hello`): a restarted server has none of them (they're in its memory
     * only), so the active ones go again.
     */
    fun onServerInstance(instance: String?) {
        if (instance.isNullOrEmpty()) return
        val before = serverInstance
        serverInstance = instance
        if (before == null || before == instance) return
        // What the old instance had as it is now goes again as re-sends; a send it never took stays a normal one.
        val had = active.filter { (key, s) -> sent[key] == NotificationReader.contentHash(s.notification) }.keys
        sent.clear()
        unsentRemovals.clear()
        iconsOnServer.clear()
        if (sharing) {
            resend += had
            active.keys.filter { !pending.containsKey(it) }.forEachIndexed { i, key -> schedule(key, i * SPACING_MS) }
        }
    }

    // ---------------------------------------------------------------- requests from PCs

    /** `notification-request`: a reply, a button or a dismissal asked for on a PC. The answer goes back to the server. */
    fun onRequest(data: String) {
        val o = runCatching { JSONObject(data) }.getOrNull() ?: return
        val rid = o.optString("request").ifEmpty { return }
        app.scope.launch(Dispatchers.IO) {
            val error = try {
                execute(o)
            } catch (e: Exception) {
                e.message ?: "It didn't work on the phone"
            }
            runCatching { app.api?.answerPhoneRequest(rid, error == null, error) }
        }
    }

    /**
     * Carries out a request: null when it worked, else what the PC should say. Keys this phone doesn't have (any
     * more) are removed from the server too: a dismissal of one counts as done.
     */
    fun execute(o: JSONObject): String? {
        if (!enabled) return "Sharing is off on the phone"
        val keys = o.optJSONArray("keys").strings()
        if (keys.isEmpty()) return "Nothing to do"
        val known = keys.mapNotNull { active[it] }
        for (key in keys) if (!active.containsKey(key)) {
            unsentRemovals += key
            schedule(key, 0)
        }
        return when (o.optString("kind")) {
            "dismiss" -> {
                if (known.isEmpty()) return null
                val l = listener ?: return "Notification access is off on the phone"
                val clearable = known.filter { !it.noClear }
                clearable.forEach { l.cancelNotification(it.sbnKey) }
                if (clearable.isEmpty()) CANT_DISMISS else null
            }
            "reply" -> {
                val target = known.firstOrNull() ?: return GONE
                val text = o.optString("text")
                if (text.isBlank()) return "Nothing to send"
                val action = actionOf(target, o.optString("action")) { return it }
                val inputs = action.remoteInputs.orEmpty().filter { it.allowFreeFormInput }
                if (inputs.isEmpty()) return "It doesn't take a reply"
                val fill = Intent()
                RemoteInput.addResultsToIntent(inputs.toTypedArray(), fill, Bundle().apply { inputs.forEach { putCharSequence(it.resultKey, text) } })
                RemoteInput.setResultsSource(fill, RemoteInput.SOURCE_FREE_FORM_INPUT)
                send(action.actionIntent, fill)
            }
            "action" -> {
                val target = known.firstOrNull() ?: return GONE
                val action = actionOf(target, o.optString("action")) { return it }
                send(action.actionIntent, null)
            }
            else -> "The phone doesn't know that request"
        }
    }

    /** The action a PC's [id] names, or [fail] with why not (it was moved or retitled since: refused). */
    private inline fun actionOf(s: Shared, id: String, fail: (String) -> Nothing): Notification.Action {
        val i = s.notification.actions.indexOfFirst { it.id == id }
        if (i >= 0) s.actions.getOrNull(i)?.let { return it }
        val position = Regex("^a(\\d+)").find(id)?.groupValues?.get(1)?.toIntOrNull()
        fail(if (position != null && position < s.actions.size) CHANGED else "That button is gone")
    }

    private fun send(pi: PendingIntent, fill: Intent?): String? {
        // A button that opens a screen: Android doesn't let an app in the background start one.
        val opensScreen = Build.VERSION.SDK_INT >= 31 && pi.isActivity
        if (opensScreen && !app.isInForeground) return OPEN_ON_PHONE
        return try {
            val options = if (opensScreen && Build.VERSION.SDK_INT >= 34) {
                // Beam is on screen (checked above): it may start the app's screen.
                @Suppress("DEPRECATION")
                val mode = if (Build.VERSION.SDK_INT >= 36) ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOW_IF_VISIBLE else ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED
                ActivityOptions.makeBasic().setPendingIntentBackgroundActivityStartMode(mode).toBundle()
            } else {
                null
            }
            pi.send(app, 0, fill, null, null, null, options)
            null
        } catch (_: PendingIntent.CanceledException) {
            "The app no longer takes this"
        }
    }

    // ---------------------------------------------------------------- apps: names, icons, recently notifying

    fun appName(pkg: String): String = names.getOrPut(pkg) {
        try {
            val pm = app.packageManager
            pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
        } catch (_: Exception) {
            pkg
        }
    }

    /** The app's icon as a 64×64 PNG and its hash (cached for the process). */
    private fun iconFor(pkg: String): Icon? {
        icons[pkg]?.let { return it }
        if (pkg in noIcon) return null
        return try {
            val bmp = app.packageManager.getApplicationIcon(pkg).toBitmap(64, 64, Bitmap.Config.ARGB_8888)
            val png = ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
            if (png.size > 32 * 1024) null else Icon(NotificationReader.sha256Hex(png), png).also { icons[pkg] = it }
        } catch (_: Exception) {
            noIcon += pkg
            null
        }
    }

    /** Apps seen notifying (package names only), so the app list can show them first. */
    private fun noteRecent(pkg: String) {
        if (pkg == app.packageName) return
        val now = System.currentTimeMillis()
        val recent = app.prefs.recentNotifiers
        if (now - (recent[pkg] ?: 0L) < 3_600_000L) return // written at most hourly per app
        app.prefs.recentNotifiers = (recent + (pkg to now)).entries.sortedByDescending { it.value }.take(50).associate { it.key to it.value }
    }

    private fun changed() {
        _changes.value++
        runCatching { TileService.requestListeningState(app, ComponentName(app, PcNotificationsTileService::class.java)) }
    }

    /** Access was granted or taken away while Beam was away (a screen came back): the switch and the tile follow. */
    fun recheck() = changed()

    companion object {
        const val FEATURE = "phone-notifications"
        /** An update waits at least this long (changes within it go as one). */
        const val PUT_DELAY_MS = 500L
        /** At most one update per notification this often (an app that re-posts every second costs one in 2 s). */
        const val UPDATE_EVERY_MS = 2_000L
        const val REMOVE_DELAY_MS = 1_000L
        /** Between the requests of a burst (all active ones at once): the server takes about 20 a second. */
        const val SPACING_MS = 60L
        /** A failed send goes again after these, then at the next connect or liveness poke. */
        val BACKOFF_MS = listOf(2_000L, 10_000L, 60_000L)
        /** How far ahead a `posted` time may be and still count for [Prefs.phoneSyncedAt]. */
        private const val CLOCK_SLACK_MS = 60_000L
        private const val DONE = 0
        private const val RETRY = 1
        private const val FAILED = 2
        const val OPEN_ON_PHONE = "Open it on the phone"
        const val GONE = "It's gone from the phone"
        const val CHANGED = "That button changed on the phone"
        const val CANT_DISMISS = "It can't be dismissed"
    }
}
