package app.beam.android.data

import app.beam.android.BeamApp
import app.beam.android.core.BeamException
import app.beam.android.core.EventStream
import app.beam.android.core.Pairing
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.random.Random

/**
 * Holds the live event stream while anyone needs it (the UI while visible, the background service while
 * "Stay connected" is on). Reconnects quickly at first (1 s … 30 s), then every 5–15 minutes while the
 * server stays unreachable (to save battery), and right away when the network changes or the app opens.
 * Catches up on missed items after every (re)connect.
 */
class Connection(private val app: BeamApp) {
    private val holders = HashSet<String>()
    private var job: Job? = null
    @Volatile private var stream: EventStream? = null
    private val wake = Channel<Unit>(Channel.CONFLATED)
    @Volatile private var rediscoveryTried = false

    /** Events received on the stream (each one wakes the phone when it's asleep) and streams opened. */
    val eventsReceived = java.util.concurrent.atomic.AtomicLong()
    val streamsOpened = java.util.concurrent.atomic.AtomicLong()

    /** The server's heartbeat on the current stream, from its `hello` (0: not said, i.e. 25 s). */
    @Volatile var heartbeatSeconds = 0

    /**
     * The open stream's id (server 1.4 `stream-modes`, from its `hello`). With it the app switches the stream
     * between background (a heartbeat every 3 minutes; only what needs the phone now comes at once) and
     * foreground by poking it, instead of reconnecting. Null: an older server, or no stream.
     */
    @Volatile var streamId: String? = null
        private set
    @Volatile var streamMode: String? = null
        private set
    private val pokeAck = java.util.concurrent.atomic.AtomicReference<CompletableDeferred<Unit>?>()

    private val networkListener = NetworkMonitor.Listener { available, switched ->
        // A different default network: pooled connections are probably dead (the everyday client has no pings
        // to find out by itself).
        if (switched) app.http.connectionPool.evictAll()
        when {
            // Server 1.4: ask the stream whether it's still there (a poke answers on it within seconds); only
            // reconnect if it doesn't. A network change that kept the tunnel (Tailscale) costs nothing then.
            available && streamId != null -> poke(liveness = true)
            switched -> stream?.cancel()
        }
        if (available) wake.trySend(Unit)
    }

    @Synchronized
    fun acquire(tag: String) {
        holders += tag
        if (job?.isActive != true) start() else kick()
    }

    @Synchronized
    fun release(tag: String) {
        holders -= tag
        if (holders.isEmpty()) stop()
    }

    /** Reconnect now (after pairing, unpairing, renaming or a server switch). */
    fun restart() {
        stream?.cancel()
        wake.trySend(Unit)
    }

    /** Try again right away if we're waiting out a backoff (the app opened, or the user tapped Retry). */
    fun kick() {
        if (app.repo.state.value.conn != Repository.Conn.CONNECTED) wake.trySend(Unit)
    }

    /** What the stream should be now: foreground while a Beam screen shows, background otherwise. */
    private fun desiredMode() = if (app.isInForeground) MODE_FOREGROUND else MODE_BACKGROUND

    /** A Beam screen came on, or the last one went away: switch the live stream (server 1.4). */
    fun onScreenChanged() {
        if (streamId != null && streamMode != desiredMode()) poke(liveness = false)
    }

    /**
     * Server 1.4: switches the open stream to [desiredMode] and makes the server send what it held back, then a
     * `ping {poke: true}`. If the server says the stream is gone, or that ping doesn't arrive within 5 s (a
     * dead socket after a network change), reconnect.
     */
    fun poke(liveness: Boolean = true) {
        if (streamId == null) return
        app.scope.launch(Dispatchers.IO) {
            // One at a time, each with the mode wanted when it runs, and again if the screen changed meanwhile:
            // two quick screen changes must never leave the stream in the foreground (25 s pings) by mistake.
            val again = pokes.withLock { pokeNow(liveness) }
            if (again) poke(liveness = false)
        }
    }

    private val pokes = Mutex()

    /**
     * One poke. [liveness]: after a network change, ask even if the mode is right. Returns true when the wanted
     * mode changed while it ran (poke again).
     */
    private suspend fun pokeNow(liveness: Boolean): Boolean {
        val id = streamId ?: return false
        val target = stream ?: return false // this poke's stream: a newer one gets its heartbeat from its own hello
        val api = app.api ?: return false
        val mode = desiredMode()
        if (!liveness && streamMode == mode) return false // queued behind others that already switched it
        // Any `ping {poke: true}` from now on proves the stream alive (a pending one is shared).
        val ack = pokeAck.updateAndGet { it ?: CompletableDeferred() }!!
        // The stream's next read starts as soon as that ping arrives, usually before this call returns: give it the
        // longer of the two heartbeats now, or a switch to the background (180 s) would time out after 70 s.
        val expected = if (mode == MODE_BACKGROUND) BACKGROUND_PING_S else FOREGROUND_PING_S
        if (streamId != id) return false
        target.setHeartbeat(EventStream.deadAfterMs(maxOf(expected, heartbeatSeconds, FOREGROUND_PING_S)))
        val result = try {
            api.poke(id, mode)
        } catch (e: BeamException) {
            if (e.status == 404) streamId = null // this server doesn't know pokes after all: plain reconnects from now on
            null
        } catch (_: Exception) {
            null
        }
        if (streamId != id) return false
        if (result == null || !result.alive) {
            if (streamId == id) restart()
            return false
        }
        streamMode = result.mode ?: mode
        if (result.ping > 0) {
            heartbeatSeconds = result.ping
            target.setHeartbeat(EventStream.deadAfterMs(result.ping))
        }
        if (withTimeoutOrNull(POKE_WAIT_MS) { ack.await() } == null) {
            if (streamId == id) restart()
            return false
        }
        // The stream is alive after a network change: what failed to send meanwhile goes now.
        if (liveness) app.phone.onAlive()
        return streamId == id && streamMode != desiredMode()
    }

    private fun start() {
        app.network.addListener(networkListener)
        job = app.scope.launch(Dispatchers.IO) { loop() }
    }

    private fun stop() {
        job?.cancel()
        job = null
        stream?.cancel()
        streamId = null // nothing left to poke
        streamMode = null
        app.network.removeListener(networkListener)
        app.repo.setConn(Repository.Conn.IDLE)
    }

    private suspend fun loop() {
        var failures = 0
        while (currentCoroutineContext().isActive) {
            val api = app.api
            if (api == null) {
                app.repo.setConn(Repository.Conn.IDLE)
                wake.receive()
                continue
            }
            app.repo.setConn(Repository.Conn.CONNECTING)
            val mode = desiredMode()
            streamId = null
            streamMode = null
            heartbeatSeconds = 0
            pokeAck.set(null)
            // Until the server's hello says its ping: 2 × (180 s in the background, 25 s on screen) + 20 s.
            val s = EventStream(api, EventStream.deadAfterMs(if (mode == MODE_BACKGROUND) BACKGROUND_PING_S else FOREGROUND_PING_S), mode)
            stream = s
            var openedAt = 0L
            var authFailed = false
            try {
                runStream(s) {
                    openedAt = System.currentTimeMillis()
                    failures = 0
                    rediscoveryTried = false
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: BeamException) {
                authFailed = e.status == 401
            } catch (_: Exception) {
                // Network errors and heartbeat timeouts: reconnect below.
            }
            stream = null
            currentCoroutineContext().ensureActive() // stopped on purpose: don't report "offline"
            if (authFailed) {
                if (app.api == null) continue // signed out: everything was wiped, sign-in shows
                app.repo.setConn(Repository.Conn.AUTH_FAILED)
                withTimeoutOrNull(5 * 60_000L) { wake.receive() }
                continue
            }
            if (openedAt > 0 && System.currentTimeMillis() - openedAt > 60_000) failures = 0
            failures++
            app.repo.setConn(Repository.Conn.OFFLINE, offlineReason(api.base.toString()))
            maybeRediscover()
            withTimeoutOrNull(delayFor(failures)) { wake.receive() }
        }
    }

    /** Why the last attempt failed, as far as the phone can tell. */
    private fun offlineReason(base: String): Repository.Offline = when {
        !app.network.online -> Repository.Offline.NO_NETWORK
        Pairing.needsTailscale(base) && !app.network.vpnActive -> Repository.Offline.TAILSCALE_OFF
        else -> Repository.Offline.UNREACHABLE
    }

    /**
     * After 10 minutes without the server (and with Tailscale up), look for it elsewhere once: the address
     * it advertised before, or `https://beam.<tailnet>.ts.net` if it moved to its own Tailscale node.
     */
    private fun maybeRediscover() {
        val s = app.repo.state.value
        if (rediscoveryTried || s.offline != Repository.Offline.UNREACHABLE) return
        if (s.offlineSince == 0L || System.currentTimeMillis() - s.offlineSince < REDISCOVER_AFTER_MS) return
        rediscoveryTried = true
        app.scope.launch(Dispatchers.IO) {
            if (app.moves.rediscover()) restart()
        }
    }

    private suspend fun runStream(s: EventStream, onOpened: () -> Unit) = coroutineScope {
        // Cancelling this coroutine must also abort the blocking read.
        val watcher = launch {
            try {
                awaitCancellation()
            } finally {
                s.cancel()
            }
        }
        try {
            withContext(Dispatchers.IO) {
                s.run(object : EventStream.Listener {
                    override fun onOpen() {
                        streamsOpened.incrementAndGet()
                        onOpened()
                        app.repo.setConn(Repository.Conn.CONNECTED)
                        app.onConnected()
                    }

                    override fun onEvent(event: String, data: String) {
                        eventsReceived.incrementAndGet()
                        if (event == "hello") onHello(s, data)
                        if (event == "ping" && data.contains("\"poke\"")) pokeAck.getAndSet(null)?.complete(Unit)
                        // The phone is awake for this anyway: a free moment for the status report and, every
                        // 6 hours, the update check (neither ever wakes the phone by itself).
                        app.status.onActivity()
                        app.updates.checkIfDue()
                        if (event == "app-update") {
                            app.updates.onEvent(data)
                            return
                        }
                        if (event.startsWith("login-request")) {
                            app.signIns.onEvent(event, data)
                            return
                        }
                        // Server 1.5: a PC asks this phone to reply to, press a button on, or dismiss a notification.
                        if (event == "notification-request") {
                            app.phone.onRequest(data)
                            return
                        }
                        // Server 1.6: who controls which PC (the kill switch in Settings → Devices).
                        if (event == "rc-sessions") {
                            app.remote.onSessionsEvent(data)
                            return
                        }
                        val item = app.repo.onEvent(event, data)
                        if (item != null) app.inbox.onItem(item)
                    }
                })
            }
        } finally {
            watcher.cancel()
        }
    }

    /** The stream's `hello`: its id, mode and ping (server 1.4), or nothing new (older servers: a 25 s ping). */
    private fun onHello(s: EventStream, data: String) {
        val o = try {
            org.json.JSONObject(data)
        } catch (_: org.json.JSONException) {
            return
        }
        val ping = o.optInt("ping")
        heartbeatSeconds = ping
        s.setHeartbeat(EventStream.deadAfterMs(if (ping > 0) ping else FOREGROUND_PING_S))
        streamMode = o.optString("mode").ifEmpty { null }
        streamId = o.optString("stream").ifEmpty { null }
        // Server 1.5: a restarted server lost the shared notifications (memory only): they go again.
        app.phone.onServerInstance(o.optString("instance").ifEmpty { null })
        // The screen changed while the stream was opening.
        if (streamId != null && streamMode != desiredMode()) poke(liveness = false)
    }

    companion object {
        const val REDISCOVER_AFTER_MS = 10 * 60_000L
        const val MODE_FOREGROUND = "foreground"
        const val MODE_BACKGROUND = "background"
        const val FOREGROUND_PING_S = 25
        const val BACKGROUND_PING_S = 180
        const val POKE_WAIT_MS = 5_000L

        /**
         * 1 s, 2 s, 4 s … 30 s for the first attempts (about 3½ minutes), then 5, 10 and 15 minutes (with a
         * little jitter) while the server stays unreachable. Network changes and opening the app skip the wait.
         */
        fun delayFor(failures: Int): Long = when {
            failures <= 5 -> 1_000L shl (failures - 1).coerceAtLeast(0)
            failures <= 11 -> 30_000L
            failures == 12 -> 5 * 60_000L
            failures == 13 -> 10 * 60_000L
            else -> 15 * 60_000L
        } + if (failures > 11) Random.nextLong(0, 30_000) else 0L
    }
}
