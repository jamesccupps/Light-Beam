package app.beam.android

import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.BeamApi
import app.beam.android.core.EventStream
import app.beam.android.core.Pairing
import app.beam.android.core.SignInClient
import app.beam.android.core.TestNet
import app.beam.android.data.Repository
import kotlinx.coroutines.runBlocking
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files
import java.time.Duration
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Remote control (1.6) against a real 1.6 server of its own (BEAM_SERVER_JS, a port from BEAM_TEST_PORTS), with a
 * made-up tailnet (a fake tailscaled LocalAPI, like the server's own tests): a Windows 1.6 PC that allows it shows
 * "Control" on the phone; the viewer page's own sign-in acts as the phone and may start a session (an automatic
 * browser sign-in may not); the phone ends it (back), ends it from the kill switch, turns remote control off, and the
 * page's sign-in is revoked; a locked PC has no "Control".
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class RemoteProtocolTest {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private val serverJs = System.getProperty("beam.server.js").orEmpty()
    private var server: Process? = null
    private var tailscaled: Process? = null
    private var data: File? = null
    private val streams = CopyOnWriteArrayList<EventStream>()

    @After
    fun tearDown() {
        app.connection.release("service")
        if (app.prefs.paired) app.unpair()
        streams.forEach { it.cancel() }
        for (p in listOfNotNull(server, tailscaled)) {
            p.destroy()
            if (!p.waitFor(10, TimeUnit.SECONDS)) p.destroyForcibly().waitFor()
        }
        data?.deleteRecursively()
    }

    private fun idleUntil(what: String, timeoutMs: Long = 15_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(20))
            if (condition()) return
            Thread.sleep(10)
        }
        throw AssertionError("timed out: $what")
    }

    /** A fake tailscaled: this server's machine and the PC's, both the user's. Returns its socket (a pipe on Windows). */
    private fun startTailscaled(dir: File): String {
        val where = if (System.getProperty("os.name").orEmpty().startsWith("Windows")) {
            "\\\\.\\pipe\\beam-android-rc-${ProcessHandle.current().pid()}-${System.nanoTime()}"
        } else {
            File(dir, "ts.sock").absolutePath
        }
        val script = File(dir, "tailscaled.js").apply { writeText(TAILSCALED) }
        val p = ProcessBuilder("node", script.absolutePath, where).redirectErrorStream(true).start().also { tailscaled = it }
        val ready = p.inputStream.bufferedReader().readLine()
        assertEquals("ready", ready)
        return where
    }

    private fun startServer(dir: File, socket: String): String {
        val port = TestNet.freePort()
        val pb = ProcessBuilder("node", serverJs).redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.appendTo(File(dir, "server.log")))
        pb.environment().apply {
            put("BEAM_HOST", "127.0.0.1")
            put("BEAM_PORT", port.toString())
            put("BEAM_DATA", dir.absolutePath)
            put("BEAM_DIST", dir.absolutePath)
            put("BEAM_TAILSCALE", "")
            put("BEAM_TAILSCALE_SOCKET", socket)
            put("BEAM_TAILSCALE_OWNERS", "robin@example.com")
            remove("BEAM_PUBLIC_URL")
            remove("BEAM_MOVED_TO")
        }
        server = pb.start()
        val base = "http://127.0.0.1:$port"
        val deadline = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < deadline) {
            try {
                val c = URL("$base/api/hello").openConnection() as HttpURLConnection
                c.connectTimeout = 500
                if (c.responseCode == 200) break
            } catch (_: Exception) {
            }
            Thread.sleep(150)
        }
        return base
    }

    private fun listen(api: BeamApi): LinkedBlockingQueue<Pair<String, JSONObject>> {
        val q = LinkedBlockingQueue<Pair<String, JSONObject>>()
        val s = EventStream(api, mode = "background").also { streams += it }
        thread(isDaemon = true) {
            runCatching {
                s.run(object : EventStream.Listener {
                    override fun onOpen() {}
                    override fun onEvent(event: String, data: String) {
                        q.put(event to (runCatching { JSONObject(data) }.getOrNull() ?: JSONObject()))
                    }
                })
            }
        }
        return q
    }

    private fun LinkedBlockingQueue<Pair<String, JSONObject>>.next(name: String, ms: Long = 10_000, match: (JSONObject) -> Boolean = { true }): JSONObject {
        val deadline = System.currentTimeMillis() + ms
        while (true) {
            val left = deadline - System.currentTimeMillis()
            if (left <= 0) throw AssertionError("no $name event")
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(10))
            val (event, data) = poll(minOf(left, 100), TimeUnit.MILLISECONDS) ?: continue
            if (event == name && match(data)) return data
        }
    }

    /** A request the way the viewer page makes it: its cookie, from Beam's own origin. */
    private fun asPage(base: String, token: String, method: String, path: String, body: JSONObject? = null): Pair<Int, JSONObject> {
        val req = Request.Builder().url(base + path).header("Cookie", "beam_key=$token").header("Origin", base)
            .method(method, body?.toString()?.toRequestBody(BeamApi.JSON)).build()
        return page.newCall(req).execute().use { res -> res.code to (runCatching { JSONObject(res.body!!.string()) }.getOrNull() ?: JSONObject()) }
    }

    private val page = BeamApi.defaultClient()

    /** The app's own network calls, off the main thread (where the app never makes them). */
    private fun <T> offMain(block: () -> T): T {
        var result: Result<T>? = null
        thread { result = runCatching(block) }.join()
        return result!!.getOrThrow()
    }

    private fun BeamApi.status(body: JSONObject) =
        execute(request(url("/api/devices/me/status")).put(body.toString().toRequestBody(BeamApi.JSON)).build()).close()

    @Test
    fun theViewerActsAsThePhoneAndThePhoneCanEndOrTurnOffControl() {
        assumeTrue("Set BEAM_SERVER_JS to run the 1.6 protocol tests", serverJs.isNotEmpty())
        val dir = Files.createTempDirectory("beam-remote-control").toFile().also { data = it }
        val base = startServer(dir, startTailscaled(dir))
        val key = File(dir, "key").readText().trim()
        val version = SignInClient(base).hello().version
        val (major, minor) = version.split('.').map { it.toIntOrNull() ?: 0 } + listOf(0, 0)
        assertTrue("a server with remote control (1.6 or later): $version", major > 1 || (major == 1 && minor >= 6))

        // A Windows 1.6 PC on the tailnet that allows remote control, its app connected (it says which Windows account
        // it runs under, so its first report ties remote control to it).
        val desk = BeamApi(base, key, PC, "Desk", "windows", TestNet.client(PC_IP), PC_PROFILE)
        desk.me()
        val events = listen(desk)
        events.next("hello")
        desk.status(JSONObject().put("remoteControl", true).put("locked", false))

        // The phone: "Control" for it.
        app.completePairing(Pairing.Link(base, key), "Pixel", SignInClient(base).hello().serverId)
        app.connection.acquire("service")
        idleUntil("connected to a 1.6 server") { app.repo.state.value.conn == Repository.Conn.CONNECTED && app.remote.available }
        idleUntil("Control for the PC") { app.repo.state.value.devicesById[PC]?.let(app.remote::canControl) == true }

        // The viewer page's own sign-in: a new token (traded for the app's at /?key=), acting as the phone.
        val api = app.api!!.pinned()
        val cookie = offMain { app.remote.signIn(api, app.remote.opening()) }
        val token = app.prefs.remotePageTokens.single().substringAfterLast(' ')
        assertTrue(cookie.contains("HttpOnly") && !cookie.contains("Max-Age"))
        assertNotEquals(app.prefs.key, token)
        assertEquals(app.repo.me, asPage(base, token, "GET", "/api/me").second.optString("you"))

        // It may start a session, the way the page does; the PC hears it's this phone, at the addresses the server saw.
        fun startAsPage(): String {
            val (code, started) = asPage(base, token, "POST", "/api/rc/sessions", JSONObject().put("device", PC))
            assertEquals(started.toString(), 201, code)
            assertEquals(PC_IP, started.getJSONObject("host").optString("ip4"))
            val id = started.getString("id")
            assertEquals(app.repo.me, events.next("rc-request") { it.optString("id") == id }.optString("from"))
            return id
        }
        val first = startAsPage()

        // The viewer closes: the app ends this phone's session (whatever the page managed).
        offMain { runBlocking { app.remote.closed(api, PC, app.remote.ticketsSoFar) } } // (its page still open)
        var ended = events.next("rc-end") { it.optString("id") == first }
        assertEquals(listOf("stopped", app.repo.me), listOf(ended.optString("reason"), ended.optString("from")))

        // The kill switch: who controls the PC shows on the phone, and End there ends it.
        val second = startAsPage()
        offMain { app.remote.refreshSessions() }
        assertEquals(listOf(second), app.remote.controlling(PC).map { it.id })
        offMain { app.remote.end(second) }
        ended = events.next("rc-end") { it.optString("id") == second }
        assertEquals(app.repo.me, ended.optString("from"))
        assertTrue(app.remote.controlling(PC).isEmpty())

        // A browser signed in automatically because Beam runs on this phone may not start a session (server 1.6's
        // eligibility: `sign-in`); the page's traded sign-in above could.
        val autoReq = Request.Builder().url("$base/api/autopair")
            .post(JSONObject().put("deviceId", "autobrowser01").toString().toRequestBody(BeamApi.JSON)).build()
        val auto = page.newCall(autoReq).execute().use { res ->
            assertEquals(200, res.code)
            Regex("beam_key=([^;]+)").find(res.headers("Set-Cookie").joinToString(" "))!!.groupValues[1]
        }
        val (autoCode, autoBody) = asPage(base, auto, "POST", "/api/rc/sessions", JSONObject().put("device", PC))
        assertEquals(autoBody.toString(), 403, autoCode)
        assertEquals("sign-in", autoBody.optString("reason"))

        // The viewer closes: the page's sign-in goes; the app's own is untouched; no sign-in in the server's log.
        app.remote.closing()
        offMain { app.remote.revokeKeptIfIdle() }
        assertTrue(app.prefs.remotePageTokens.isEmpty())
        assertEquals(401, asPage(base, token, "GET", "/api/me").first)
        assertTrue("the app's own sign-in is untouched", offMain { app.api!!.me() })
        val log = File(dir, "server.log").readText()
        assertFalse("no sign-in in the server's log", log.contains(token) || log.contains(app.prefs.key!!) || log.contains(key))

        // A locked PC: no "Control" (Remote Desktop, as before).
        desk.status(JSONObject().put("locked", true))
        offMain { app.repo.refreshBlocking() } // (a background stream gets status news when a screen shows)
        idleUntil("locked") { app.repo.state.value.devicesById[PC]?.status?.locked == true }
        assertFalse(app.remote.canControl(app.repo.state.value.devicesById.getValue(PC)))

        // "Turn off remote control" from the phone: the PC hears it, and even unlocked it can't be controlled until it
        // turns it on itself (nothing on the phone can).
        offMain { app.remote.turnOff(PC) }
        assertEquals(app.repo.me, events.next("rc-disable").optString("from"))
        desk.status(JSONObject().put("locked", false))
        offMain { app.repo.refreshBlocking() }
        idleUntil("unlocked") { app.repo.state.value.devicesById[PC]?.status?.locked == false }
        assertFalse(app.repo.state.value.devicesById.getValue(PC).can.remoteControl)
        assertFalse(app.remote.canControl(app.repo.state.value.devicesById.getValue(PC)))
    }

    /**
     * A viewer closed while it was still signing in: its sign-in, landing after, is revoked at once and never used. A
     * page sign-in left over meanwhile is never revoked while the next viewer is live (the server would end its
     * session), only once that one has closed (re-check of the 1.6 review).
     */
    @Test
    fun aLateSignInIsDroppedAndNothingIsRevokedUnderALiveViewer() {
        assumeTrue("Set BEAM_SERVER_JS to run the 1.6 protocol tests", serverJs.isNotEmpty())
        val dir = Files.createTempDirectory("beam-remote-control").toFile().also { data = it }
        val base = startServer(dir, startTailscaled(dir))
        val key = File(dir, "key").readText().trim()
        val desk = BeamApi(base, key, PC, "Desk", "windows", TestNet.client(PC_IP), PC_PROFILE)
        desk.me()
        val events = listen(desk)
        events.next("hello")
        desk.status(JSONObject().put("remoteControl", true).put("locked", false))
        app.completePairing(Pairing.Link(base, key), "Pixel", SignInClient(base).hello().serverId)
        app.connection.acquire("service")
        idleUntil("connected to a 1.6 server") { app.repo.state.value.conn == Repository.Conn.CONNECTED && app.remote.available }
        idleUntil("Control for the PC") { app.repo.state.value.devicesById[PC]?.let(app.remote::canControl) == true }
        val api = app.api!!.pinned()

        // Back at the spinner: the ticket is cancelled before the sign-in lands; it's revoked at once, never kept.
        val early = app.remote.opening()
        app.remote.closing()
        assertTrue(offMain { runCatching { app.remote.signIn(api, early) } }.isFailure)
        assertTrue("revoked, not kept", app.prefs.remotePageTokens.isEmpty())

        // The next viewer goes live and its page starts a session; a page sign-in a crash left is kept meanwhile.
        offMain { app.remote.signIn(api, app.remote.opening()) }
        val live = app.prefs.remotePageTokens.single().substringAfterLast(' ')
        val leftover = offMain { api.pageSignIn() }!!.substringAfter("beam_key=").substringBefore(';')
        app.prefs.remotePageTokens = app.prefs.remotePageTokens + "${api.base} $leftover"
        val (code, started) = asPage(base, live, "POST", "/api/rc/sessions", JSONObject().put("device", PC))
        assertEquals(started.toString(), 201, code)
        val id = started.getString("id")
        events.next("rc-request") { it.optString("id") == id }

        // A reconnect while it's live revokes nothing: the session stays.
        offMain { app.remote.onConnected() }
        assertEquals(200, asPage(base, leftover, "GET", "/api/me").first)
        assertNull(runCatching { events.next("rc-end", 3_000) { it.optString("id") == id } }.getOrNull())

        // Closed: both sign-ins go now.
        app.remote.closing()
        offMain { app.remote.revokeKeptIfIdle() }
        assertEquals(401, asPage(base, leftover, "GET", "/api/me").first)
        assertEquals(401, asPage(base, live, "GET", "/api/me").first)
        assertTrue(app.prefs.remotePageTokens.isEmpty())
    }

    private companion object {
        const val PC = "rcdesk000001"
        const val PC_IP = "100.64.91.1"

        /** The PC app's Windows account (X-Beam-Profile). */
        const val PC_PROFILE = "a1b2c3d4e5f60718"

        /** tailscaled's LocalAPI, made up: this server's machine (100.64.91.100) and the PC's, both robin@. */
        val TAILSCALED = """
            const http = require('http');
            const user = 'robin@example.com';
            const self = ['100.64.91.100', 'fd7a:115c:a1e0::5b64'];
            const pc = ['100.64.91.1', 'fd7a:115c:a1e0::5b01'];
            const server = http.createServer((req, res) => {
              const u = new URL(req.url, 'http://local-tailscaled.sock');
              const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
              if (u.pathname === '/localapi/v0/status') {
                return reply(200, {
                  Self: { HostName: 'beam-host', TailscaleIPs: self, UserID: 1 },
                  Peer: { peer0: { ID: 'nDESK', HostName: 'desk', DNSName: 'desk.tail1234.ts.net.', TailscaleIPs: pc, UserID: 1 } },
                  User: { 1: { LoginName: user } },
                });
              }
              if (u.pathname === '/localapi/v0/whois') {
                const addr = u.searchParams.get('addr') || '';
                const ip = addr.startsWith('[') ? addr.slice(1, addr.indexOf(']')) : addr.split(':')[0];
                const ips = pc.includes(ip) ? pc : self.includes(ip) ? self : null;
                if (!ips) return reply(404, {});
                return reply(200, {
                  UserProfile: { LoginName: user, DisplayName: user },
                  Node: { ComputedName: ips === pc ? 'desk' : 'beam-host', StableID: ips === pc ? 'nDESK' : 'nHOST', Addresses: ips.map(a => a + (a.includes(':') ? '/128' : '/32')) },
                });
              }
              if (u.pathname === '/localapi/v0/serve-config') return reply(200, {});
              reply(404, {});
            });
            server.listen(process.argv[2], () => console.log('ready'));
        """.trimIndent()
    }
}
