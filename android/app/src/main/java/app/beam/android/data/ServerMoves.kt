package app.beam.android.data

import app.beam.android.BeamApp
import app.beam.android.core.Hello
import app.beam.android.core.Pairing
import app.beam.android.core.Proof
import app.beam.android.core.SignInClient
import app.beam.android.notify.Notifier
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Follows the server when it moves (docs/API.md, "When the server moves"): a `410 { movedTo }` answer or
 * a `moved` event leads here; so does a long outage (then the app looks for the server by itself). A new
 * address is used only if it's the same Beam (same serverId) and, on API v3 servers, proves it knows this
 * device's secret. The key stays the same.
 */
class ServerMoves(private val app: BeamApp) {
    private val busy = AtomicBoolean(false)
    @Volatile private var lastRejected: String? = null

    /** From any thread, whenever a call answered 410 with [movedTo] (or the server announced a move). */
    fun onMoved(movedTo: String) {
        val target = Pairing.normalizeServer(movedTo) ?: return
        if (target == app.prefs.baseUrl) return
        if (!busy.compareAndSet(false, true)) return
        app.scope.launch(Dispatchers.IO) {
            try {
                follow(target)
            } finally {
                busy.set(false)
            }
        }
    }

    /** Checks [target] and switches to it if it's the same Beam. Blocking; returns true if switched. */
    fun follow(target: String): Boolean {
        val there = verify(target) ?: run {
            // Unreachable is fine (the next 410 tries again); a different Beam is worth telling the user.
            if (reachable(target) && lastRejected != target) {
                lastRejected = target
                Notifier.moveRejected(app, target)
            }
            return false
        }
        switchTo(target, there.serverId)
        Notifier.serverMoved(app, target)
        return true
    }

    /**
     * Looks for this Beam at other addresses after a long outage: addresses it advertised before and
     * `https://beam.<tailnet>.ts.net`. Blocking; returns true if it found it (and switched).
     */
    fun rediscover(): Boolean {
        val current = app.prefs.baseUrl ?: return false
        val candidates = LinkedHashSet<String>()
        candidates += app.prefs.alternates
        Pairing.tailnetBeam(current)?.let { candidates += it }
        candidates -= current
        for (c in candidates) {
            val there = verify(c) ?: continue
            switchTo(c, there.serverId)
            Notifier.serverMoved(app, c)
            return true
        }
        return false
    }

    /**
     * `/api/hello` at [target] if it is this Beam: the same serverId and, when the server supports it
     * (API v3), a valid proof that it knows this device's secret. Null otherwise.
     */
    fun verify(target: String): Hello? {
        val secret = app.prefs.key ?: return null
        val nonce = Proof.nonce()
        val there = try {
            SignInClient(target, app.http).hello(secret, nonce)
        } catch (_: Exception) {
            return null
        }
        if (there.movedTo != null) return null // an old address pointing on; follow that one instead
        val expected = app.prefs.serverId ?: try {
            app.prefs.baseUrl?.let { SignInClient(it, app.http).hello().serverId } // the old server may still answer
        } catch (_: Exception) {
            null
        }
        val serverId = there.serverId ?: return null
        if (expected == null || serverId != expected) return null
        if (there.api >= 3 && !Proof.matches(secret, serverId, nonce, there.proof)) return null
        return there
    }

    private fun reachable(target: String): Boolean = try {
        SignInClient(target, app.http).hello()
        true
    } catch (_: Exception) {
        false
    }

    /** Points the app at [baseUrl]; running requests and retries follow right away. */
    fun switchTo(baseUrl: String, serverId: String?) {
        val old = app.prefs.baseUrl
        app.prefs.moveServer(baseUrl)
        if (serverId != null) app.prefs.serverId = serverId
        if (old != null && old != baseUrl) app.prefs.alternates = app.prefs.alternates - baseUrl
        app.api?.base = baseUrl.toHttpUrl()
        app.connection.restart()
    }

    /** Remembers addresses the server advertises, for [rediscover]. */
    fun learn(vararg addresses: String?) {
        val current = app.prefs.baseUrl
        val add = addresses.mapNotNull { it?.let(Pairing::normalizeServer) }.filter { it != current }
        if (add.isNotEmpty()) app.prefs.alternates = app.prefs.alternates + add
    }

    /**
     * After every connect: remember the server's id (apps paired before ids existed) and every address it
     * is known by (API v3 `urls`), for finding it again after a move. Blocking.
     */
    fun refreshHello() {
        val base = app.prefs.baseUrl ?: return
        try {
            val hello = SignInClient(base, app.http).hello()
            if (app.prefs.serverId == null) hello.serverId?.let { app.prefs.serverId = it }
            learn(*hello.urls.toTypedArray())
        } catch (_: Exception) {
        }
        // (1.7.6, audit S-33) and from the signed-in /api/info: a later server leaves them out of /api/hello
        try {
            app.api?.info()?.urls?.let { learn(*it.toTypedArray()) }
        } catch (_: Exception) {
        }
    }
}
