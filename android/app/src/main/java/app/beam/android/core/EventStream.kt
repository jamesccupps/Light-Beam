package app.beam.android.core

import okhttp3.Call
import java.io.IOException

/**
 * One Server-Sent Events connection to `GET /api/events`.
 *
 * The read timeout doubles as the heartbeat: the server sends a `ping` every 25 s (1.4: every 3 minutes in the
 * background), so if nothing at all arrives for [heartbeatMs] (2 × ping + 20 s) the read fails and [run]
 * throws. [setHeartbeat] changes it on the open stream when the server says its ping changed. Reconnecting
 * (with backoff) is the caller's job, see [Backoff]. [mode]: see [BeamApi.eventsCall].
 */
class EventStream(private val api: BeamApi, private val heartbeatMs: Long = HEARTBEAT_MS, private val mode: String? = null) {
    interface Listener {
        /** Called once the server has accepted the stream, before any event is read. */
        fun onOpen()
        fun onEvent(event: String, data: String)
    }

    @Volatile private var call: Call? = null
    @Volatile private var cancelled = false
    @Volatile private var source: okio.BufferedSource? = null

    /** How long the open stream may stay silent before it counts as dead. The timer is uptime: it never wakes the phone. */
    fun setHeartbeat(ms: Long) {
        source?.timeout()?.timeout(ms, java.util.concurrent.TimeUnit.MILLISECONDS)
    }

    /** Blocks until the stream ends. Returns on a clean end of stream, throws on errors and timeouts. */
    fun run(listener: Listener) {
        val call = api.eventsCall(heartbeatMs, mode)
        this.call = call
        if (cancelled) call.cancel()
        val res = call.execute()
        res.use {
            if (!res.isSuccessful) throw api.errorFrom(res)
            val source = res.body?.source() ?: throw IOException("Empty event stream")
            this.source = source
            listener.onOpen()
            var event = ""
            val data = StringBuilder()
            var hasData = false
            while (true) {
                val line = source.readUtf8Line() ?: break
                when {
                    line.isEmpty() -> {
                        if (hasData) listener.onEvent(event.ifEmpty { "message" }, data.toString())
                        event = ""
                        data.setLength(0)
                        hasData = false
                    }
                    line.startsWith(":") -> Unit // comment, e.g. ": ping"
                    else -> {
                        val colon = line.indexOf(':')
                        val field = if (colon < 0) line else line.substring(0, colon)
                        var value = if (colon < 0) "" else line.substring(colon + 1)
                        if (value.startsWith(" ")) value = value.substring(1)
                        when (field) {
                            "event" -> event = value
                            "data" -> {
                                if (hasData) data.append('\n')
                                data.append(value)
                                hasData = true
                            }
                        }
                    }
                }
            }
        }
    }

    fun cancel() {
        cancelled = true
        call?.cancel()
    }

    companion object {
        /** 2 × the 25 s ping + 20 s. */
        const val HEARTBEAT_MS = 70_000L

        /** The server counts as gone after 2 × its ping + 20 s without any data (docs/API.md, stream modes). */
        fun deadAfterMs(pingSeconds: Int): Long = (2L * pingSeconds + 20) * 1000
    }
}

/** Reconnect delays: 1 s, 2 s, 4 s … up to 30 s. */
class Backoff(private val baseMs: Long = 1_000, private val maxMs: Long = 30_000) {
    var attempt = 0
        private set

    fun next(): Long {
        val delay = minOf(maxMs, baseMs shl minOf(attempt, 16))
        attempt++
        return delay
    }

    fun reset() {
        attempt = 0
    }
}
