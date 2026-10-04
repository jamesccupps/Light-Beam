package app.beam.android.data

import app.beam.android.BeamApp
import app.beam.android.core.BeamException
import app.beam.android.core.Format
import app.beam.android.core.Item
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.UUID

/**
 * Texts waiting to be sent. Typing while offline (Tailscale off, server down) queues the text, shows it
 * as "Waiting to send…" and sends it, in order, as soon as the server answers again. Survives restarts.
 */
class Outbox(private val app: BeamApp) {
    enum class Status { QUEUED, SENDING, FAILED }

    data class Entry(
        val localId: String,
        val text: String,
        val to: List<String>,
        val createdAt: Long,
        val status: Status = Status.QUEUED,
        val error: String? = null,
        /** (server 1.14) The message it answers. */
        val reply: String? = null,
    ) {
        fun toJson(): JSONObject = JSONObject().put("localId", localId).put("text", text).put("to", JSONArray(to))
            .put("createdAt", createdAt).put("status", status.name).put("error", error).put("reply", reply)

        companion object {
            fun parse(o: JSONObject) = Entry(
                localId = o.optString("localId"),
                text = o.optString("text"),
                to = (0 until (o.optJSONArray("to")?.length() ?: 0)).map { o.getJSONArray("to").getString(it) },
                createdAt = o.optLong("createdAt"),
                // Anything that was being sent when the app stopped is simply queued again.
                status = if (o.optString("status") == Status.FAILED.name) Status.FAILED else Status.QUEUED,
                error = o.optString("error").takeIf { it.isNotEmpty() && it != "null" },
                reply = o.optString("reply").takeIf { it.isNotEmpty() && it != "null" },
            )
        }
    }

    /** What happened to a text handed to [send]. */
    sealed interface Result {
        data class Sent(val item: Item) : Result
        data object Queued : Result
        data class Failed(val message: String) : Result
    }

    private val _entries = MutableStateFlow(load())
    val entries: StateFlow<List<Entry>> = _entries
    private val lock = Mutex()

    private fun load(): List<Entry> {
        val a = app.prefs.loadArray(Prefs.K_OUTBOX)
        return (0 until a.length()).mapNotNull { a.optJSONObject(it)?.let(Entry::parse) }.filter { it.localId.isNotEmpty() }
    }

    private fun save() = app.prefs.saveArray(Prefs.K_OUTBOX, JSONArray().apply { _entries.value.forEach { put(it.toJson()) } })

    private fun change(localId: String, f: Entry.() -> Entry) {
        _entries.update { list -> list.map { if (it.localId == localId) it.f() else it } }
        save()
    }

    /** Sends [text] to [to] (empty = all devices) now, or queues it if the server can't be reached. */
    suspend fun send(text: String, to: List<String>, reply: String? = null): Result {
        val entry = Entry(UUID.randomUUID().toString(), text, to, System.currentTimeMillis(), reply = reply)
        _entries.update { it + entry }
        save()
        return withContext(Dispatchers.IO) {
            app.reportSent(to)
            lock.withLock { attempt(entry.localId) }
        }
    }

    /** Sends every queued text, oldest first. Called after every (re)connect. */
    fun flush() {
        app.scope.launch(Dispatchers.IO) {
            lock.withLock {
                for (e in _entries.value.filter { it.status == Status.QUEUED }) {
                    if (attempt(e.localId) is Result.Queued) break // still offline: keep the order
                }
            }
        }
    }

    fun retry(localId: String) {
        change(localId) { copy(status = Status.QUEUED, error = null) }
        flush()
    }

    fun cancel(localId: String) {
        _entries.update { list -> list.filterNot { it.localId == localId } }
        save()
    }

    private fun attempt(localId: String): Result {
        val e = _entries.value.firstOrNull { it.localId == localId } ?: return Result.Failed("Cancelled")
        // Known to be offline: don't wait for a connect timeout, the next reconnect sends it.
        if (app.api == null || app.repo.state.value.conn == Repository.Conn.OFFLINE) {
            change(localId) { copy(status = Status.QUEUED) }
            return Result.Queued
        }
        change(localId) { copy(status = Status.SENDING, error = null) }
        return try {
            val item = app.repo.sendTextBlocking(e.text, e.to, e.reply)
            cancel(localId)
            Result.Sent(item)
        } catch (err: BeamException) {
            if (err.status >= 500 || err.status == 408 || err.status == 429 || err.status == 410 || err.status == 401) {
                change(localId) { copy(status = Status.QUEUED) }
                Result.Queued
            } else {
                val message = Format.error(err)
                change(localId) { copy(status = Status.FAILED, error = message) }
                Result.Failed(message)
            }
        } catch (_: IOException) {
            change(localId) { copy(status = Status.QUEUED) }
            Result.Queued
        } catch (err: Exception) {
            val message = Format.error(err)
            change(localId) { copy(status = Status.FAILED, error = message) }
            Result.Failed(message)
        }
    }

    fun clear() {
        _entries.value = emptyList()
        save()
    }
}
