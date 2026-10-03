package app.beam.android

import android.content.Context
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.BeamApi
import app.beam.android.core.Pairing
import app.beam.android.core.SignInClient
import app.beam.android.core.TestNet
import app.beam.android.data.Prefs
import app.beam.android.data.Repository
import app.beam.android.data.SettingsBackups
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
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
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * Beam for Android 1.8.2: this phone's settings kept on the server (server 1.8.1 `backups`), offered back after a
 * reinstall, and put back from Settings (also another phone's). The protocol test runs against a real server of its
 * own (BEAM_SERVER_JS); the rest always runs.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class Backups182Test {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private val raw get() = app.getSharedPreferences("beam", Context.MODE_PRIVATE)
    private val serverJs = System.getProperty("beam.server.js").orEmpty()
    private var server: Process? = null
    private var data: File? = null

    @Before fun clean() = raw.edit().clear().commit().let { }

    @After
    fun tearDown() {
        app.connection.release("service")
        if (app.prefs.paired) app.unpair()
        server?.let {
            it.destroy()
            if (!it.waitFor(10, TimeUnit.SECONDS)) it.destroyForcibly().waitFor()
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

    private fun idleFor(ms: Long) {
        val until = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < until) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(20))
            Thread.sleep(10)
        }
    }

    /** [block] off the main thread (the app's client refuses requests on it, like a phone). */
    private fun <T> background(block: () -> T): T {
        var result: Result<T>? = null
        val t = thread { result = runCatching(block) }
        while (t.isAlive) shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(20))
        return result!!.getOrThrow()
    }

    // ---------------------------------------------------------------- what a backup holds and what comes back

    @Test fun aBackupHoldsTheSettingsAndNeverTheSignIn() {
        val prefs = Prefs(app)
        prefs.savePairing("https://beam.example.ts.net", "bt_this_phones_own_sign_in", "Robin's phone")
        prefs.autoCopy = true
        prefs.maxDownloadMb = 2048
        prefs.tileTarget = "pc0001"
        prefs.mutedDevices = setOf("pc0002", "pc0001")
        prefs.sharedApps = setOf("com.example.chat")
        val s = SettingsBackups.settingsOf(prefs)
        assertEquals("Robin's phone", s.getString("deviceName"))
        assertTrue(s.getBoolean("autoCopy"))
        assertEquals(2048, s.getLong("maxDownloadMb"))
        assertEquals("pc0001", s.getString("tileTarget"))
        assertEquals("sorted, so the same settings always read the same", JSONArray(listOf("pc0001", "pc0002")).toString(), s.getJSONArray("mutedDevices").toString())
        assertEquals("com.example.chat", s.getJSONArray("sharedApps").getString(0))
        val text = s.toString()
        for (secret in listOf("bt_this_phones_own_sign_in", prefs.deviceId, prefs.installId, "beam.example")) assertFalse("not in a backup: $secret", text.contains(secret))
        assertEquals("an empty tile target is \"ask\"", "", SettingsBackups.settingsOf(Prefs(app).also { it.tileTarget = null }).getString("tileTarget"))
    }

    @Test fun puttingBackLeavesThisPhoneOutAndSkipsWhatItCantRead() {
        val prefs = Prefs(app)
        val me = setOf("phone01")
        SettingsBackups.applyTo(
            prefs,
            JSONObject()
                .put("autoCopy", true).put("autoDownload", false).put("wifiOnlyDownloads", true).put("stayConnected", false)
                .put("maxDownloadMb", 0).put("tileTarget", "phone01")
                .put("mutedDevices", JSONArray(listOf("phone01", "pc0001"))).put("autoCopyDevices", JSONArray(listOf("pc0002", 5))),
            me,
        )
        assertTrue(prefs.autoCopy)
        assertFalse(prefs.autoDownload)
        assertTrue(prefs.wifiOnlyDownloads)
        assertFalse(prefs.stayConnected)
        assertEquals("0: no limit", 0L, prefs.maxDownloadMb)
        assertNull("never this phone itself", prefs.tileTarget)
        assertEquals(setOf("pc0001"), prefs.mutedDevices)
        assertEquals(setOf("pc0002"), prefs.autoCopyDevices)
        // Wrong types and missing keys change nothing.
        SettingsBackups.applyTo(prefs, JSONObject().put("autoCopy", "yes").put("maxDownloadMb", -5).put("mutedDevices", "pc0003"), me)
        assertTrue(prefs.autoCopy)
        assertEquals(0L, prefs.maxDownloadMb)
        assertEquals(setOf("pc0001"), prefs.mutedDevices)
    }

    @Test fun theBackupHearsOfChangesToItsSettingsOnly() {
        val prefs = Prefs(app)
        var heard = 0
        prefs.watchSettings { heard++ }
        prefs.autoCopy = true
        prefs.mutedDevices = setOf("pc0001")
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(2, heard)
        prefs.lastUpdateCheck = 5
        prefs.markRead("pc0001", 10)
        prefs.backupSent = "x"
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals("not for what isn't a setting", 2, heard)
        val install = prefs.installId
        assertEquals("one id per install", install, Prefs(app).installId)
        raw.edit().clear().commit()
        assertTrue("a reinstall (its data gone) is another install", Prefs(app).installId != install)
    }

    // ---------------------------------------------------------------- against a real server

    private fun startServer(): String {
        val dir = Files.createTempDirectory("beam-backups").toFile().also { data = it }
        val port = TestNet.freePort()
        val pb = ProcessBuilder("node", serverJs).redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.appendTo(File(dir, "server.log")))
        pb.environment().apply {
            put("BEAM_HOST", "127.0.0.1")
            put("BEAM_PORT", port.toString())
            put("BEAM_DATA", dir.absolutePath)
            put("BEAM_DIST", dir.absolutePath)
            put("BEAM_TAILSCALE", "off")
            put("BEAM_BACKUP_HOURS", "0")
            remove("BEAM_PUBLIC_URL")
            remove("BEAM_MOVED_TO")
            remove("BEAM_BACKUP_DIR")
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

    /** The phone's backups as another device reads them: `[{ install, settings, ... }]`, newest first. */
    private fun BeamApi.backupsOf(device: String): JSONArray = backups(device).getJSONArray("backups")

    private fun pair(base: String, key: String) {
        app.completePairing(Pairing.Link(base, key), "Pixel", SignInClient(base).hello().serverId)
        app.connection.acquire("service")
        idleUntil("connected to a 1.8.1 server") {
            app.repo.state.value.conn == Repository.Conn.CONNECTED && app.repo.state.value.info?.lists("backups") == true
        }
    }

    @Test
    fun aReinstalledPhoneGetsItsSettingsBack() {
        assumeTrue("Set BEAM_SERVER_JS to run the backup protocol test", serverJs.isNotEmpty())
        val base = startServer()
        val key = File(data, "key").readText().trim()
        val desk = TestNet.device(base, key, "Desk", "windows")
        desk.me()
        app.backups.delayMs = 100
        MainThreadGuard.violations.clear()

        // Paired: nothing earlier to offer, so this install's settings go up.
        pair(base, key)
        val phone = app.repo.me
        idleUntil("checked") { app.prefs.restoreChecked }
        assertNull(app.backups.offer.value)
        idleUntil("the first backup") { desk.backupsOf(phone).length() == 1 }
        val firstInstall = app.prefs.installId
        assertEquals(firstInstall, desk.backupsOf(phone).getJSONObject(0).getString("install"))

        // Changed: they go again (once, for changes in a row).
        app.renameDevice("Robin's phone")
        app.prefs.autoCopy = true
        app.prefs.wifiOnlyDownloads = true
        app.prefs.maxDownloadMb = 2048
        app.prefs.mutedDevices = setOf(desk.deviceId)
        app.prefs.sharedApps = setOf("com.example.chat")
        app.prefs.shareNotifications = true
        // (the rename's reconnect may send some of them first; the rest follow)
        idleUntil("the last change is on the server") {
            val s = desk.backupsOf(phone).getJSONObject(0).getJSONObject("settings")
            s.optBoolean("shareNotifications") && s.optLong("maxDownloadMb") == 2048L
        }
        idleFor(500)
        val kept = desk.backupsOf(phone).getJSONObject(0).getJSONObject("settings")
        assertEquals("Robin's phone", kept.getString("deviceName"))
        assertEquals(desk.deviceId, kept.getJSONArray("mutedDevices").getString(0))
        assertEquals("one backup per install", 1, desk.backupsOf(phone).length())
        // Unchanged settings aren't sent again (another connect).
        val mark = MainThreadGuard.mark()
        app.connection.restart()
        idleUntil("connected again") { MainThreadGuard.requestsSince(mark).any { it == "GET /api/info" } }
        idleFor(1_000)
        assertFalse(MainThreadGuard.requestsSince(mark).toString(), MainThreadGuard.requestsSince(mark).any { it == "PUT /api/devices/me/backup" })

        // Uninstalled and installed again: the same device (its id comes from ANDROID_ID), everything else gone.
        val id = app.prefs.deviceId
        app.unpair()
        raw.edit().clear().putString("deviceId", id).commit()
        pair(base, key)
        idleUntil("the offer") { app.backups.offer.value != null }
        val offer = app.backups.offer.value!!
        assertTrue(offer.here)
        assertEquals(firstInstall, offer.install)
        assertTrue(app.prefs.installId != firstInstall)
        assertFalse(app.prefs.autoCopy)
        assertEquals("Pixel", app.prefs.deviceName)
        Thread.sleep(500)
        assertEquals("nothing of the new install's goes up before the answer", 1, desk.backupsOf(phone).length())

        // Restored: the settings, the name, the apps picked; sharing waits for its own screen.
        assertTrue("sharing was on: its screen is offered", app.backups.apply(offer))
        assertNull(app.backups.offer.value)
        assertTrue(app.prefs.restoreChecked)
        assertTrue(app.prefs.autoCopy)
        assertTrue(app.prefs.wifiOnlyDownloads)
        assertEquals(2048L, app.prefs.maxDownloadMb)
        assertEquals(setOf(desk.deviceId), app.prefs.mutedDevices)
        assertEquals(setOf("com.example.chat"), app.prefs.sharedApps)
        assertFalse(app.prefs.shareNotifications)
        assertEquals("Robin's phone", app.prefs.deviceName)
        idleUntil("the server has the name back") { desk.devices().devices.firstOrNull { it.id == phone }?.name == "Robin's phone" }
        idleUntil("the new install's backup") { desk.backupsOf(phone).length() == 2 }
        assertEquals(app.prefs.installId, desk.backupsOf(phone).getJSONObject(0).getString("install"))

        // Another phone's backup: its settings, never its name or this phone in its lists.
        val tablet = TestNet.device(base, key, "Tablet", "android")
        tablet.me()
        val body = JSONObject().put("install", "tabletinstall01").put("app", "android").put("version", "1.8.2").put(
            "settings",
            JSONObject().put("deviceName", "Tablet").put("autoCopy", false).put("tileTarget", phone).put("mutedDevices", JSONArray(listOf(phone, "pc0009"))),
        )
        tablet.execute(tablet.request(tablet.url("/api/devices/me/backup")).put(body.toString().toRequestBody(BeamApi.JSON)).build()).close()
        // (in the background a `devices` event waits for the heartbeat: the list is fetched, as a screen opening would)
        background { app.repo.refreshBlocking() }
        assertTrue(app.repo.state.value.devicesById[tablet.deviceId]?.backupAt != null)
        val choices = background { app.backups.choices() }
        assertEquals(listOf(true, false), choices.map { it.here })
        val theirs = choices.last()
        assertEquals("Tablet", theirs.name)
        assertFalse(app.backups.apply(theirs))
        assertEquals("Robin's phone", app.prefs.deviceName)
        assertFalse(app.prefs.autoCopy)
        assertNull(app.prefs.tileTarget)
        assertEquals(setOf("pc0009"), app.prefs.mutedDevices)

        assertTrue("no requests on the main thread: ${MainThreadGuard.violations}", MainThreadGuard.violations.isEmpty())
    }
}
