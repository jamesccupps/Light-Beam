package app.beam.android

import android.Manifest
import android.app.NotificationManager
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Looper
import android.provider.MediaStore
import android.widget.EditText
import android.widget.TextView
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.Device
import app.beam.android.core.Item
import app.beam.android.core.Pairing
import app.beam.android.core.SignInClient
import app.beam.android.core.TestNet
import app.beam.android.data.Prefs
import app.beam.android.data.Repository
import app.beam.android.data.TransferManager
import app.beam.android.notify.Notifier
import app.beam.android.ui.MainActivity
import app.beam.android.ui.PairActivity
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File
import java.time.Duration
import java.util.concurrent.Callable
import java.util.concurrent.Executors

/**
 * A real 401 (this device's sign-in was removed from another device, revoked or expired) wipes everything the
 * sign-in left on the phone, like the web app, and shows sign-in. Offline, 5xx, 503 (moving), 410 (moved) and a
 * 401 that isn't Beam's own keep everything. Against [FakeBeam] always; against a scratch server (the phone
 * removed from a PC) when BEAM_TEST_URL / BEAM_TEST_KEY are set.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class SignOutTest {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private val url = System.getProperty("beam.url").orEmpty()
    private val key = System.getProperty("beam.key").orEmpty()
    private val desk = "desk00000001"
    private var fake: FakeBeam? = null
    private val sp get() = app.getSharedPreferences("beam", Context.MODE_PRIVATE)

    @Before
    fun setUp() {
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        FakeMediaStore.reset()
        Robolectric.setupContentProvider(FakeMediaStore::class.java, MediaStore.AUTHORITY)
    }

    @After
    fun tearDown() {
        if (app.prefs.paired) app.unpair()
        fake?.close()
    }

    private fun idle(ms: Long = 50) = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ms))

    private fun idleUntil(what: String, timeoutMs: Long = 15_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            idle()
            if (condition()) return
            Thread.sleep(20)
        }
        throw AssertionError("timed out: $what")
    }

    private fun idleFor(ms: Long) {
        val until = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < until) {
            idle()
            Thread.sleep(20)
        }
    }

    private fun <T> offMain(block: () -> T): T {
        val ex = Executors.newSingleThreadExecutor()
        try {
            return ex.submit(Callable { block() }).get()
        } finally {
            ex.shutdown()
        }
    }

    private fun item(id: String, text: String, ts: Long) = JSONObject()
        .put("id", id).put("kind", "text").put("text", text).put("textLength", text.length).put("from", desk).put("device", "Desk")
        .put("to", JSONArray().put(app.prefs.deviceId)).put("delivered", JSONObject()).put("ts", ts)

    private class Traces(val savedFile: Uri, val deviceId: String)

    /** Leaves one of everything a signed-in phone keeps, for conversation [with]. */
    private fun leaveTraces(with: String): Traces {
        app.repo.saveNow() // the saved copy and its cursor
        app.prefs.setDraft(with, "half-written")
        app.readMarkers.markRead(with, System.currentTimeMillis())
        // A text the server refuses (no such device) stays in the outbox, marked failed.
        runBlocking { app.outbox.send("waiting", listOf("nosuchdevice01")) }
        // Previews (including the small copy of a saved photo) and a copy waiting to be sent.
        File(app.cacheDir, "thumbs").apply { mkdirs() }.let { File(it, "x.jpg").writeText("jpeg"); File(it, "x.local.jpg").writeText("jpeg") }
        File(app.cacheDir, "outgoing").apply { mkdirs() }.resolve("copy").writeText("waiting to go")
        // A file the user saved: it stays.
        val saved = app.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, ContentValues().apply { put(MediaStore.MediaColumns.DISPLAY_NAME, "kept.jpg") })!!
        app.contentResolver.openOutputStream(saved)!!.use { it.write(byteArrayOf(1, 2, 3)) }
        app.prefs.setLocalFile("k000000000000001", saved)
        Notifier.serverMoved(app, "http://example.invalid") // any notification of Beam's
        idleUntil("Direct Share shortcuts") { ShortcutManagerCompat.getDynamicShortcuts(app).isNotEmpty() }
        assertTrue(app.outbox.entries.value.isNotEmpty())
        return Traces(saved, app.prefs.deviceId)
    }

    private fun notifications() = shadowOf(app.getSystemService(NotificationManager::class.java)).allNotifications

    private fun assertKept(what: String, t: Traces) {
        assertTrue("$what: still signed in", app.prefs.paired)
        assertTrue("$what: saved copy", File(app.filesDir, "state.json").exists())
        assertTrue("$what: history", app.repo.state.value.items.isNotEmpty())
        assertTrue("$what: outbox", app.outbox.entries.value.isNotEmpty())
        assertTrue("$what: previews", File(app.cacheDir, "thumbs/x.local.jpg").exists())
        assertTrue("$what: drafts", app.prefs.drafts.value.isNotEmpty())
        assertTrue("$what: read marks", app.prefs.lastRead.value.isNotEmpty())
        assertTrue("$what: shortcuts", ShortcutManagerCompat.getDynamicShortcuts(app).isNotEmpty())
        assertEquals(t.deviceId, app.prefs.deviceId)
    }

    private fun assertWiped(t: Traces) {
        idleUntil("signed out") { app.prefs.signedOutFrom != null } // set once everything is gone
        idleUntil("transfers gone") { app.transfers.downloads.value.isEmpty() && app.transfers.uploads.value.isEmpty() }
        assertFalse("saved copy (with its cursor)", File(app.filesDir, "state.json").exists())
        assertTrue("history", app.repo.state.value.items.isEmpty())
        assertTrue("outbox", app.outbox.entries.value.isEmpty() && sp.getString("outbox", null).let { it == null || it == "[]" })
        assertFalse("previews", File(app.cacheDir, "thumbs").exists())
        assertFalse("copies waiting to be sent", File(app.cacheDir, "outgoing").exists())
        assertTrue("drafts", app.prefs.drafts.value.isEmpty())
        assertTrue("read marks", app.prefs.lastRead.value.isEmpty())
        val records = app.prefs.loadArray(Prefs.K_TRANSFERS).optJSONObject(0)
        assertTrue("resume records: $records", records == null || (records.optJSONArray("uploads")?.length() ?: 0) + (records.optJSONArray("downloads")?.length() ?: 0) == 0)
        assertTrue("shortcuts", ShortcutManagerCompat.getDynamicShortcuts(app).isEmpty())
        // Only "Beam signed out" may be left (it's posted when no Beam screen shows).
        assertTrue("notifications", notifications().all { it.extras.getCharSequence("android.title")?.toString() == app.getString(R.string.signed_out_title) })
        assertEquals("the device id never changes", t.deviceId, app.prefs.deviceId)
        assertTrue("a saved file stays", app.contentResolver.openInputStream(t.savedFile)!!.use { it.readBytes() }.contentEquals(byteArrayOf(1, 2, 3)))
        assertTrue("sign-in offers the same server again", app.prefs.signedOutFrom != null)
    }

    private fun startFake(): FakeBeam {
        val f = FakeBeam(listOf("stream-modes", "items-since", "live-download")).also { fake = it }
        f.devices = JSONArray().put(Device(desk, "Desk", "windows", true, System.currentTimeMillis()).toJson())
        f.items = listOf(item("a000000000000001", "hello", System.currentTimeMillis() - 1_000))
        app.completePairing(Pairing.Link(f.url, "k"), "Signed Phone", "fakebeam01")
        return f
    }

    @Test
    fun aRealUnauthorizedWipesEverythingAndShowsSignIn() {
        val f = startFake()
        val main = Robolectric.buildActivity(MainActivity::class.java).setup()
        idleUntil("synced") { app.repo.state.value.fresh && app.repo.state.value.items.size == 1 }
        val traces = leaveTraces(desk)
        // A download in progress (its resume record is saved).
        f.liveFile = ByteArray(400_000)
        f.liveSteps = 40
        f.liveStepMs = 300
        val file = Item("f000000000000001", "file", null, false, 0, "movie.mp4", 400_000, "video/mp4", desk, "Desk", listOf(app.prefs.deviceId), emptyMap(), System.currentTimeMillis())
        app.transfers.download(file, TransferManager.Reason.SAVE)
        idleUntil("downloading") { (app.transfers.downloads.value[file.id]?.received ?: 0) > 0 && sp.contains("transfers") }

        // The sign-in is gone on the server: the next request (the stream reconnecting) gets Beam's 401.
        f.status = 401
        f.dropStreams()
        assertWiped(traces)
        assertTrue("the partial download went too", FakeMediaStore.byName("movie.mp4") == null)

        // Sign-in shows, saying why, with the same server filled in.
        val started = shadowOf(app).nextStartedActivity
        assertEquals(PairActivity::class.java.name, started?.component?.className)
        val pair = Robolectric.buildActivity(PairActivity::class.java, started).setup()
        assertEquals(f.url, pair.get().findViewById<EditText>(R.id.link).text.toString())
        assertEquals(app.getString(R.string.signed_out), pair.get().findViewById<TextView>(R.id.error).text.toString())
        pair.pause().stop().destroy()
        main.pause().stop().destroy()
    }

    /**
     * Another Beam answering at the same address (a wrong data folder, a restore, a move gone wrong) must not make
     * the phone throw everything away: only this Beam's 401 counts (its id in the 401, else from `/api/hello`).
     */
    @Test
    fun aDifferentBeamAtTheSameAddressKeepsEverything() {
        val f = startFake()
        val main = Robolectric.buildActivity(MainActivity::class.java).setup()
        idleUntil("synced") { app.repo.state.value.fresh && app.repo.state.value.items.size == 1 }
        val traces = leaveTraces(desk)
        f.serverId = "someotherbeam"
        f.status = 401
        f.dropStreams()
        idleUntil("rejected") { app.repo.state.value.conn == Repository.Conn.AUTH_FAILED }
        idleFor(500)
        assertKept("another Beam's 401", traces)
        // Without the id in its 401 (a 1.3 server): the app asks /api/hello, and it's still another Beam.
        f.serverIdIn401 = false
        val tried = f.requests.count { it == "GET /api/hello" }
        app.connection.restart()
        idleUntil("asked who it is") { f.requests.count { it == "GET /api/hello" } > tried }
        idleFor(500)
        assertKept("another Beam's 401 without its id", traces)
        // This Beam after all (its hello says so): signed out.
        f.serverId = "fakebeam01"
        app.connection.restart()
        assertWiped(traces)
        main.pause().stop().destroy()
    }

    @Test
    fun offlineServerProblemsAndMovesKeepEverything() {
        val f = startFake()
        val main = Robolectric.buildActivity(MainActivity::class.java).setup()
        idleUntil("synced") { app.repo.state.value.fresh && app.repo.state.value.items.size == 1 }
        val traces = leaveTraces(desk)
        val cases = listOf<Pair<String, () -> Unit>>(
            "a server problem (500)" to { f.status = 500 },
            "a move in progress (503)" to { f.status = 503 },
            "a move (410) to an address that doesn't answer" to { f.status = 410; f.movedTo = "http://127.0.0.1:9" },
            "a 401 that isn't Beam's (a proxy's page)" to { f.status = 401; f.plain401 = true },
        )
        for ((what, set) in cases) {
            set()
            val before = f.eventsRequests.size
            f.dropStreams()
            app.connection.restart()
            idleUntil("a reconnect: $what") { f.eventsRequests.size > before }
            runBlocking { app.repo.refresh() } // and an API call
            idleFor(300)
            assertKept(what, traces)
            f.plain401 = false
        }
        // No server at all.
        f.close()
        fake = null
        app.connection.restart()
        runBlocking { app.repo.refresh() }
        idleFor(1_000)
        assertKept("offline", traces)
        main.pause().stop().destroy()
    }

    @Test
    fun aPhoneRemovedOnTheServerIsWipedAtItsNextRequest() {
        assumeTrue("Set BEAM_TEST_URL and BEAM_TEST_KEY to run the server tests", url.isNotEmpty() && key.isNotEmpty())
        val pc = TestNet.device(url, key, "Removing PC", "windows")
        offMain { pc.me() }
        app.completePairing(Pairing.Link(url, key), "Removed Phone", offMain { SignInClient(url).hello().serverId })
        val main = Robolectric.buildActivity(MainActivity::class.java).setup()
        // The phone swaps the shared key for its own token (removing a device revokes its tokens).
        idleUntil("connected with its own token", 30_000) { app.repo.state.value.conn == Repository.Conn.CONNECTED && app.prefs.hasDeviceToken }
        offMain { pc.sendText("for the phone", listOf(app.repo.me)) }
        idleUntil("the message") { app.repo.state.value.items.any { it.text == "for the phone" } }
        val traces = leaveTraces(pc.deviceId)

        offMain { pc.forgetDevice(app.repo.me) } // "Remove" in another device's settings
        runBlocking { app.repo.refresh() } // the phone's next request
        assertWiped(traces)
        main.pause().stop().destroy()
    }
}
