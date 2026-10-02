package app.beam.android

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.BeamApi
import app.beam.android.core.BeamException
import app.beam.android.core.Pairing
import app.beam.android.core.SignInClient
import app.beam.android.core.TestNet
import app.beam.android.data.Repository
import app.beam.android.ui.MainActivity
import kotlinx.coroutines.runBlocking
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files
import java.time.Duration

/**
 * "When the server moves": two scratch servers share a copy of one data folder; the first is then
 * restarted with BEAM_MOVED_TO pointing at the second. The app must follow (same serverId, same key),
 * reconnect and say so, and must refuse a server with a different id. Needs BEAM_SERVER_JS.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class ServerMoveTest {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private val serverJs = System.getProperty("beam.server.js").orEmpty()
    private val processes = mutableListOf<Process>()
    private val dirs = mutableListOf<File>()

    private fun tempDir(prefix: String) = Files.createTempDirectory(prefix).toFile().also { dirs += it }

    private fun start(port: Int, data: File, movedTo: String? = null): Process {
        val dist = tempDir("beam-move-dist")
        val pb = ProcessBuilder("node", serverJs)
            .redirectErrorStream(true)
            .redirectOutput(File(dist, "server.log"))
        pb.environment().apply {
            put("BEAM_HOST", "127.0.0.1")
            put("BEAM_PORT", port.toString())
            put("BEAM_DATA", data.absolutePath)
            put("BEAM_DIST", dist.absolutePath)
            if (movedTo != null) put("BEAM_MOVED_TO", movedTo) else remove("BEAM_MOVED_TO")
            remove("BEAM_PUBLIC_URL")
            put("BEAM_TAILSCALE", "off") // never ask this machine's real Tailscale
        }
        val p = pb.start()
        processes += p
        val deadline = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < deadline) {
            try {
                val c = URL("http://127.0.0.1:$port/api/hello").openConnection() as HttpURLConnection
                c.connectTimeout = 500
                if (c.responseCode == 200) return p
            } catch (_: Exception) {
            }
            Thread.sleep(150)
        }
        fail("server on $port didn't start")
        throw AssertionError()
    }

    private fun stop(p: Process) {
        p.destroy()
        p.waitFor()
        processes -= p
    }

    /**
     * Like `node server.js stop`: the server writes everything to disk before it exits. (Killing it could lose
     * a write still in flight, e.g. devices.json, before its data folder is copied.)
     */
    private fun stopCleanly(p: Process, base: String, key: String) {
        try {
            val admin = BeamApi(base, key, "move-admin-01", "admin", "cli")
            admin.execute(admin.request(admin.url("/api/admin/shutdown")).post(ByteArray(0).toRequestBody(null)).build()).close()
            p.waitFor(15, java.util.concurrent.TimeUnit.SECONDS)
        } catch (_: Exception) {
        }
        stop(p)
    }

    @After
    fun cleanUp() {
        if (app.prefs.paired) app.unpair() // stop this app's connection before its servers go
        processes.forEach { it.destroyForcibly(); it.waitFor() }
        dirs.forEach { it.deleteRecursively() }
    }

    private fun idleUntil(what: String, timeoutMs: Long = 30_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(50))
            if (condition()) return
            Thread.sleep(40)
        }
        fail("Timed out waiting for $what")
    }

    private fun notifications(): List<Notification> = shadowOf(app.getSystemService(NotificationManager::class.java)).allNotifications

    @Test
    fun followsTheServerToItsNewAddress() {
        assumeTrue("Set BEAM_SERVER_JS to run the move test", serverJs.isNotEmpty())
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        val (portA, portB, portC) = Triple(TestNet.freePort(), TestNet.freePort(), TestNet.freePort())
        val oldUrl = "http://127.0.0.1:$portA"
        val newUrl = "http://127.0.0.1:$portB"
        val dataA = tempDir("beam-move-a")
        var serverA = start(portA, dataA)
        val key = File(dataA, "key").readText().trim()
        val serverId = SignInClient(oldUrl).hello().serverId!!

        // Paired like the first release was: no serverId stored yet. The app fetches it once.
        app.completePairing(Pairing.Link(oldUrl, key), "Robo Phone")
        val main = Robolectric.buildActivity(MainActivity::class.java).setup()
        idleUntil("connected") { app.repo.state.value.conn == Repository.Conn.CONNECTED && app.prefs.serverId != null }
        assertEquals(serverId, app.prefs.serverId)
        val me = app.prefs.deviceId
        val laptopIp = TestNet.tailscaleIp()
        val laptop = TestNet.device(oldUrl, key, "Laptop", "windows", id = "moving-laptop-01", ip = laptopIp)
        laptop.me()
        val before = laptop.sendText("sent before the move", listOf(me))
        idleUntil("item arrives") { app.repo.state.value.item(before.id) != null }
        // Wait for the old server to have written it to disk, then move the data folder.
        idleUntil("items saved") { File(dataA, "items.json").let { it.exists() && it.readText().contains(before.id) } }
        stopCleanly(serverA, oldUrl, key)
        val dataB = tempDir("beam-move-b")
        dataA.copyRecursively(dataB, overwrite = true)
        start(portB, dataB)
        serverA = start(portA, dataA, movedTo = newUrl)

        // What the old address says now.
        assertEquals(newUrl, SignInClient(oldUrl).hello().movedTo)
        try {
            laptop.devices()
            fail("expected 410")
        } catch (e: BeamException) {
            assertEquals(410, e.status)
            assertEquals(newUrl, e.movedTo)
        }

        // The app follows on its own: 410 from the event stream -> same serverId at the new address.
        idleUntil("switched to the new address") {
            app.prefs.baseUrl == newUrl && app.api?.base.toString().startsWith(newUrl) &&
                app.repo.state.value.conn == Repository.Conn.CONNECTED
        }
        // Same secret as before the move: the master key, or (API v3) the device token it was swapped for.
        assertTrue(app.prefs.key == key || (app.prefs.hasDeviceToken && app.prefs.key!!.startsWith("bt_")))
        idleUntil("moved notification") { notifications().any { it.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() == "Beam moved to 127.0.0.1:$portB" } }
        idleUntil("items still there") { app.repo.state.value.item(before.id) != null }
        runBlocking { app.repo.sendText("sent after the move", listOf("moving-laptop-01")) }
        val laptopThere = TestNet.device(newUrl, key, "Laptop", "windows", id = "moving-laptop-01", ip = laptopIp)
        assertTrue(laptopThere.items().any { it.text == "sent after the move" && it.from == me })

        // A different Beam (its own data, its own serverId) is never followed automatically.
        val other = tempDir("beam-move-c")
        start(portC, other)
        // follow() does network I/O: like the app, call it off the main thread.
        val followed = java.util.concurrent.Executors.newSingleThreadExecutor().submit(java.util.concurrent.Callable { app.moves.follow("http://127.0.0.1:$portC") }).get()
        assertFalse(followed)
        assertEquals(newUrl, app.prefs.baseUrl)
        idleUntil("refusal notification") {
            notifications().any { it.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() == "Beam says it moved to 127.0.0.1:$portC" }
        }
        assertEquals("network calls on the main thread", emptyList<String>(), MainThreadGuard.violations.toList())
        main.pause().stop().destroy()
        stop(serverA)
    }
}
