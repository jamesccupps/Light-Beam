package app.beam.android.remote

import android.net.Uri
import android.webkit.CookieManager
import android.webkit.WebStorage
import app.beam.android.BeamApp
import app.beam.android.core.BeamApi
import app.beam.android.core.Device
import app.beam.android.core.RcSession
import app.beam.android.core.beamPath
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONObject
import java.io.IOException

/**
 * Remote control (server 1.6 `remote-control`): the viewer is the server's own page (`#remote=<PC id>`), hosted by
 * [app.beam.android.ui.RemoteActivity]. This signs that page in and out, and ends the phone's sessions.
 *
 * **The page's sign-in.** The page gets one of its own, for this phone's device:
 * - the app trades its token for a fresh one with `POST /api/login` (the token in the body, never in a URL a proxy
 *   could log), and puts the answer's cookie in the WebView: `HttpOnly`, for Beam's path only, without an expiry (a
 *   session cookie, though the WebView may still keep one across a process death);
 * - when the viewer closes, that token is revoked (`/api/logout` with it) and the WebView's cookies go.
 *
 * So the app's own token never reaches web content, the page's sign-in lives only while the viewer is open, and
 * anything the page does with it (a sign-out, say) can't sign the app out. Every page token is kept with its server's
 * address until it's revoked: a crash, no network or a viewer still open leave it for later.
 *
 * **Revoking ends sessions.** The server ends every session of this device when one of its sign-ins is revoked, so a
 * kept token is revoked only while no viewer is open (when one closes, at a connect, when the phone leaves the
 * server), or by a viewer that's signing in (it has no session yet). Each open gets a ticket: closing cancels it, and
 * a sign-in that lands after that is never used, only revoked. Setting the app's own token as the cookie (research
 * §8.8) would share one sign-in between the app and web content for good.
 *
 * Nothing here touches the WebView until the viewer is first used.
 *
 * **The kill switch.** Who controls which PC ([sessions]: `GET /api/rc/sessions`, kept up by `rc-sessions` events),
 * so any of them can be ended from the phone ([end]), and a PC's "Allow remote control" turned off ([turnOff]). There's
 * no way to turn it on from here: only at the PC itself.
 */
class RemoteControl(private val app: BeamApp) {
    /** The server can do it. */
    val available: Boolean get() = app.repo.state.value.info?.lists(FEATURE) == true

    private val _sessions = MutableStateFlow<List<RcSession>>(emptyList())

    /** Who controls which PC right now (any device's sessions). */
    val sessions: StateFlow<List<RcSession>> = _sessions

    /** The sessions controlling [pc] now. */
    fun controlling(pc: String): List<RcSession> = _sessions.value.filter { it.host == pc }

    /** `rc-sessions` (every device hears it, coalesced): the list as it is now. */
    fun onSessionsEvent(data: String) {
        val o = runCatching { JSONObject(data) }.getOrNull() ?: return
        _sessions.value = RcSession.parseList(o.optJSONArray("sessions"))
    }

    /** The list as the server has it (blocking): when Settings → Devices shows, and at a connect (see [onConnected]). */
    fun refreshSessions() {
        if (!available) return
        val api = app.api ?: return
        runCatching { api.rcSessions() }.onSuccess { _sessions.value = it }
    }

    /**
     * The stream (re)connected (blocking): page sign-ins kept are revoked (unless a viewer is open), and the session
     * list is fetched (a session that started meanwhile sent no event this stream heard), only once a PC allows remote
     * control at all, so nobody else pays a request for it.
     */
    fun onConnected() {
        revokeKeptIfIdle()
        if (available && app.repo.state.value.devices.any { it.status?.remoteControl == true }) refreshSessions()
    }

    /** "End" (blocking): any device may end any session, the kill switch. */
    fun end(id: String) {
        val api = app.api ?: throw IOException("Not signed in")
        api.endRcSession(id)
        _sessions.value = _sessions.value.filter { it.id != id }
    }

    /** "Turn off remote control" on PC [pc] (blocking): its sessions end, and only the PC itself can turn it on again. */
    fun turnOff(pc: String) {
        val api = app.api ?: throw IOException("Not signed in")
        api.disableRemoteControl(pc)
        _sessions.value = _sessions.value.filter { it.host != pc }
    }

    /** Whether "Control" is offered for [d]: a PC that allows it now (Windows 1.6+, its switch on, unlocked), online. */
    fun canControl(d: Device): Boolean = available && d.can.remoteControl && d.online && d.status?.locked != true && d.id != app.repo.me

    // ---------------------------------------------------------------- the page's sign-in

    private val tokens = Any()

    /** The open viewer's page sign-in (a kept token that isn't this one is left over). Guarded by [tokens]. */
    private var liveToken: String? = null

    /** Tickets handed to viewers as they open, and the open one's (null: no viewer open). Guarded by [tokens]. */
    private var tickets = 0
    private var openTicket: Int? = null

    /**
     * A viewer opens (main thread): its ticket. [closing] cancels it; a sign-in that lands after that is never used,
     * only revoked.
     */
    fun opening(): Int = synchronized(tokens) { (++tickets).also { openTicket = it } }

    /** The viewer that got [ticket] is still open. */
    fun isOpen(ticket: Int): Boolean = synchronized(tokens) { openTicket == ticket }

    /** Tickets handed out so far: what a closing viewer compares with later (a newer viewer's sessions aren't its own). */
    val ticketsSoFar: Int get() = synchronized(tokens) { tickets }

    /**
     * Trades this app's token for the page's own (blocking, on [api] pinned to this server), for the viewer that got
     * [ticket]. The cookie to put in the WebView for [api]'s address: the page's token as a session cookie for Beam's
     * path. Throws when that viewer closed meanwhile (its sign-in is then revoked, unless another viewer is open).
     */
    fun signIn(api: BeamApi, ticket: Int): String {
        // This viewer has no session yet, and no other is open: what's kept can go without ending a live session.
        revokeKept()
        val setCookie = api.pageSignIn() ?: throw IOException("The server didn't sign the viewer in")
        val token = setCookie.substringAfter("beam_key=").substringBefore(';').trim().takeIf { it.isNotEmpty() }
            ?: throw IOException("The server didn't sign the viewer in")
        val live = synchronized(tokens) {
            // Kept until revoked, with its server, so a crash can't leave it valid for good.
            app.prefs.remotePageTokens = app.prefs.remotePageTokens + "${api.base} $token"
            (openTicket == ticket).also { if (it) liveToken = token }
        }
        if (!live) {
            revokeKeptIfIdle()
            throw IOException("The viewer closed before it was signed in")
        }
        app.prefs.remoteUsed = true
        return pageCookie(setCookie, api.base)
    }

    /**
     * The viewer is closing (main thread): no viewer is open any more (its ticket is cancelled), and its page sign-in
     * is left to revoke.
     */
    fun closing() = synchronized(tokens) {
        openTicket = null
        liveToken = null
    }

    /**
     * After a viewer for [pc] closed (blocking): ends this phone's sessions with it (the page normally says goodbye
     * itself, but not when it's torn down or its process dies) and revokes the page sign-ins kept, its own among them
     * (unless a viewer has opened again). A moment later once more, for a session the page was still asking for,
     * unless a viewer has opened since [ticketsAt]: then only the sessions seen at the close.
     */
    suspend fun closed(api: BeamApi, pc: String, ticketsAt: Int) {
        val seen = endMine(api, pc) { true }
        revokeKeptIfIdle()
        delay(AGAIN_MS)
        if (ticketsSoFar == ticketsAt) endMine(api, pc) { true } else endMine(api, pc) { it in seen }
        revokeKeptIfIdle()
    }

    private fun endMine(api: BeamApi, pc: String, which: (String) -> Boolean): Set<String> {
        val me = app.repo.me
        val ended = HashSet<String>()
        runCatching {
            for (s in api.rcSessions()) if (s.viewer == me && s.host == pc && which(s.id)) {
                api.endRcSession(s.id)
                ended += s.id
            }
        }
        return ended
    }

    /** Revokes the page sign-in [token] (blocking). Kept for the next try if it didn't go. */
    fun signOut(api: BeamApi, token: String) {
        if (runCatching { api.pageSignOut(token) }.isSuccess) drop(token)
    }

    /**
     * Page sign-ins kept (a viewer that closed, a crash, no network): revoked now, each at its own server, unless a
     * viewer is open (revoking would end its session). Blocking.
     */
    fun revokeKeptIfIdle() {
        if (synchronized(tokens) { openTicket != null }) return
        revokeKept()
    }

    private fun revokeKept() {
        val kept = synchronized(tokens) { app.prefs.remotePageTokens.mapNotNull(::entry).filter { it.second != liveToken } }
        for ((base, token) in kept) {
            if (runCatching { BeamApi.pageSignOut(app.http, base, token) }.isSuccess) drop(token)
        }
    }

    private fun drop(token: String) = synchronized(tokens) {
        app.prefs.remotePageTokens = app.prefs.remotePageTokens.filterTo(HashSet()) { entry(it)?.second != token }
    }

    /**
     * Unpaired, signed out, paired anew or switched to another server (main thread): page sign-ins still kept are
     * revoked at their own server (best effort), and the WebView forgets the pages.
     */
    fun forget() {
        _sessions.value = emptyList()
        val left = synchronized(tokens) {
            liveToken = null
            openTicket = null
            app.prefs.remotePageTokens.mapNotNull(::entry).also { app.prefs.remotePageTokens = emptySet() }
        }
        if (left.isNotEmpty()) {
            app.scope.launch(Dispatchers.IO) { for ((base, token) in left) runCatching { BeamApi.pageSignOut(app.http, base, token) } }
        }
        if (app.prefs.remoteUsed) {
            app.prefs.remoteUsed = false
            runCatching {
                CookieManager.getInstance().removeAllCookies(null)
                CookieManager.getInstance().flush()
                WebStorage.getInstance().deleteAllData()
            }
        }
    }

    companion object {
        const val FEATURE = "remote-control"
        private const val AGAIN_MS = 2_000L

        /** The viewer for [device] on the server at [base]. */
        fun pageUrl(base: HttpUrl, device: String): String = base.beamPath("/").newBuilder().fragment("remote=$device").build().toString()

        /** On Beam's server at [base]: its scheme, host and port, and under its path (a server may share its host). */
        fun onBeam(base: HttpUrl, u: Uri): Boolean {
            val port = if (u.port != -1) u.port else if (u.scheme == "https") 443 else 80
            if (u.scheme != base.scheme || !u.host.equals(base.host, ignoreCase = true) || port != base.port) return false
            val prefix = base.encodedPath.trimEnd('/')
            val path = u.encodedPath.orEmpty()
            return prefix.isEmpty() || path == prefix || path.startsWith("$prefix/")
        }

        /**
         * The server's `Set-Cookie` for the page, made a session cookie (no `Max-Age`/`Expires`) for Beam's path only.
         * The WebView may still keep a session cookie across a process death; its token is revoked at the next connect.
         */
        fun pageCookie(setCookie: String, base: HttpUrl): String {
            val path = base.encodedPath.trimEnd('/') + "/"
            val parts = setCookie.split(';').map { it.trim() }.filter { it.isNotEmpty() }
            val attributes = parts.drop(1).filterNot { a ->
                a.startsWith("Max-Age", ignoreCase = true) || a.startsWith("Expires", ignoreCase = true) || a.startsWith("Path", ignoreCase = true)
            }
            return (listOf(parts.first(), "Path=$path") + attributes).joinToString("; ")
        }

        /** A kept page sign-in: "<server> <token>". */
        private fun entry(e: String): Pair<HttpUrl, String>? {
            val base = e.substringBeforeLast(' ', "").toHttpUrlOrNull() ?: return null
            val token = e.substringAfterLast(' ').takeIf { it.isNotEmpty() } ?: return null
            return base to token
        }
    }
}
