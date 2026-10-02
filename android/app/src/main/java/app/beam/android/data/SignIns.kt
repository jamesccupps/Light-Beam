package app.beam.android.data

import app.beam.android.BeamApp
import app.beam.android.core.LoginRequest
import app.beam.android.notify.Notifier
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import org.json.JSONException
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

/**
 * Sign-in requests from new devices waiting for approval (Steam-style sign-in). Fed by the SSE events
 * `login-request` / `login-request-done` and by `GET /api/login-requests` after every (re)connect;
 * each new request gets a notification with Approve / Deny.
 */
class SignIns(private val app: BeamApp) {
    private val _pending = MutableStateFlow<Map<String, LoginRequest>>(emptyMap())
    val pending: StateFlow<Map<String, LoginRequest>> = _pending

    private val _settled = MutableSharedFlow<Pair<String, String>>(extraBufferCapacity = 16)
    /** (request id, status) whenever a request is approved, denied or expires anywhere. */
    val settled: SharedFlow<Pair<String, String>> = _settled

    private val notified: MutableSet<String> = ConcurrentHashMap.newKeySet()

    fun onEvent(type: String, data: String) {
        val o = try {
            JSONObject(data)
        } catch (_: JSONException) {
            return
        }
        when (type) {
            "login-request" -> add(LoginRequest.parse(o))
            "login-request-done" -> settle(o.optString("id"), o.optString("status"))
        }
    }

    /** Catches up after a (re)connect: events sent while away aren't replayed. Blocking. */
    fun sync() {
        val api = app.api ?: return
        val list = try {
            api.loginRequests()
        } catch (_: Exception) {
            return
        }
        val ids = list.map { it.id }.toSet()
        for (gone in _pending.value.keys - ids) settle(gone, "expired")
        list.forEach(::add)
    }

    private fun add(r: LoginRequest) {
        // This device's own request (API v3 tells): never ask it to approve itself.
        if (r.id.isEmpty() || r.deviceId == app.prefs.deviceId) return
        _pending.update { it + (r.id to r) }
        if (notified.add(r.id)) Notifier.signInRequest(app, r)
    }

    private fun settle(id: String, status: String) {
        if (id.isEmpty()) return
        _pending.update { it - id }
        Notifier.cancelSignIn(app, id)
        _settled.tryEmit(id to status)
    }

    /** Signed out: requests waiting for an answer from this phone go. */
    fun clear() {
        _pending.value = emptyMap()
        notified.clear()
    }
}
