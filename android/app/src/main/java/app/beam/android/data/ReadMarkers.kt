package app.beam.android.data

import app.beam.android.BeamApp
import app.beam.android.core.BeamException
import app.beam.android.notify.Notifier
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

/**
 * What this device has read, per conversation. Kept locally for unread counts and (API v3) shared with
 * the server (`PUT /api/read`, `read` events), so a browser tab and the app sharing this identity agree
 * and notifications clear when something was read elsewhere.
 */
class ReadMarkers(private val app: BeamApp) {
    private val pending = ConcurrentHashMap<String, Long>()
    private var job: Job? = null

    /** The user has seen conversation [key] (an app conversation key) up to [ts]. */
    fun markRead(key: String, ts: Long) {
        if (ts <= 0 || !app.prefs.markRead(key, ts)) return
        pending.merge(key, ts) { a, b -> maxOf(a, b) }
        job?.cancel()
        job = app.scope.launch(Dispatchers.IO) {
            delay(800)
            push()
        }
    }

    /** Sends markers the server hasn't got yet. Blocking; failures stay pending for the next connect. */
    fun push() {
        val api = app.api ?: return
        val info = app.repo.state.value.info
        if (info != null && !info.has("read-markers")) {
            pending.clear() // an older server: read state stays on this device
            return
        }
        for ((key, ts) in pending.entries.toList()) {
            try {
                api.putRead(Repository.serverConversation(key), ts)
                pending.remove(key, ts)
            } catch (e: BeamException) {
                if (e.status == 404 || e.status == 400) pending.remove(key)
            } catch (_: Exception) {
                return
            }
        }
    }

    /** Markers from `GET /api/me` (after every connect): take whichever is newer, clear old notifications. */
    fun merge(read: Map<String, Long>) {
        if (read.isEmpty()) return
        val mapped = read.mapKeys { Repository.appConversation(it.key) }
        app.prefs.markAllRead(mapped)
        for ((key, ts) in mapped) Notifier.conversationRead(app, key, ts)
    }

    /** Signed out: markers not sent yet go with everything else. */
    fun clear() {
        job?.cancel()
        pending.clear()
    }

    /** A `read` event for this device: something was read in another client with this identity. */
    fun onRemoteRead(conversation: String, ts: Long) {
        val key = Repository.appConversation(conversation)
        app.prefs.markRead(key, ts)
        Notifier.conversationRead(app, key, ts)
    }
}
