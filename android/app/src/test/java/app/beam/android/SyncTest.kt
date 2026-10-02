package app.beam.android

import android.Manifest
import android.os.Looper
import android.provider.MediaStore
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.Device
import app.beam.android.core.DeviceStatus
import app.beam.android.core.Pairing
import androidx.recyclerview.widget.RecyclerView
import app.beam.android.data.Connection
import app.beam.android.data.Repository
import app.beam.android.data.TransferManager
import app.beam.android.ui.MainActivity
import app.beam.android.ui.MessageAdapter
import app.beam.android.ui.Row
import app.beam.android.ui.ThreadActivity
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Duration

/**
 * The 1.4 protocol from the app's side, against [FakeBeam]: background mode while no Beam screen shows and
 * pokes instead of reconnects (P1), delta sync into the saved copy (P2), saving a file that's still
 * arriving (P4), and the old behaviour against a server without those features.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class SyncTest {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private val desk = "desk00000001"
    private var fake: FakeBeam? = null

    private fun idleUntil(what: String, timeoutMs: Long = 10_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(20))
            if (condition()) return
            Thread.sleep(10)
        }
        throw AssertionError("timed out: $what")
    }

    private fun item(id: String, text: String, ts: Long, pinned: Boolean = false) = JSONObject()
        .put("id", id).put("kind", "text").put("text", text).put("textLength", text.length).put("from", desk).put("device", "Desk")
        .put("to", JSONArray().put(app.prefs.deviceId)).put("delivered", JSONObject()).put("ts", ts).put("pinned", pinned)

    private fun start(features: List<String>, setup: FakeBeam.() -> Unit = {}): FakeBeam {
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        val f = FakeBeam(features).also { fake = it }
        f.devices = JSONArray().put(Device(desk, "Desk", "windows", true, System.currentTimeMillis()).toJson())
        f.setup()
        app.completePairing(Pairing.Link(f.url, "k"), "Sync Phone", "fakebeam01")
        return f
    }

    @After
    fun stop() {
        app.connection.release("service")
        app.unpair()
        fake?.close()
    }

    @Test
    fun theStreamIsInTheBackgroundWhileNoScreenShowsAndPokesInsteadOfReconnecting() {
        val f = start(listOf("stream-modes", "items-since"))
        app.connection.acquire("service") // "Stay connected", screen off
        idleUntil("stream") { app.connection.streamId != null }
        assertTrue(f.eventsRequests.single().contains("mode=background"))
        assertEquals(180, app.connection.heartbeatSeconds)

        // A Beam screen comes on: the same stream switches to foreground (and gets what was held back).
        val main = Robolectric.buildActivity(MainActivity::class.java).setup()
        idleUntil("poked to foreground") { app.connection.streamMode == Connection.MODE_FOREGROUND }
        assertEquals("foreground", f.pokes.last().getString("mode"))
        assertEquals(25, app.connection.heartbeatSeconds)
        // The screen goes away: back to the background, still the same stream.
        main.pause().stop()
        idleUntil("poked to background") { app.connection.streamMode == Connection.MODE_BACKGROUND }
        Thread.sleep(300)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
        assertEquals("never reconnected", 1, f.eventsRequests.size)
        main.destroy()
    }

    @Test
    fun turningThePhoneKeepsTheStream() {
        val f = start(listOf("stream-modes"))
        val main = Robolectric.buildActivity(MainActivity::class.java).setup()
        idleUntil("stream") { app.connection.streamId != null && app.repo.state.value.fresh }
        Thread.sleep(1_000)
        val requests0 = f.requests.size
        main.recreate()
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(200))
        Thread.sleep(1_000)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(200))
        assertEquals("one stream", 1, f.eventsRequests.size)
        assertEquals("no requests: ${f.requests.drop(requests0)}", 0, f.requests.size - requests0)
        assertEquals(Connection.MODE_FOREGROUND, app.connection.streamMode)
        main.pause().stop().destroy()
    }

    /**
     * The poke's ping arrives before its reply, and the stream reads on at once: it must already expect the
     * background heartbeat then, or a stream switched to the background times out after the foreground's
     * 2 × 1 + 20 s here (70 s for real) and reconnects every time the screen goes off.
     */
    @Test
    fun aStreamSwitchedToTheBackgroundDoesNotTimeOutEarly() {
        val f = start(listOf("stream-modes")) {
            pingForeground = 1 // dead after 22 s without data
            pingBackground = 30
            pokeReplyDelayMs = 500
        }
        app.connection.acquire("service")
        val main = Robolectric.buildActivity(MainActivity::class.java).setup()
        idleUntil("foreground") { app.connection.streamMode == Connection.MODE_FOREGROUND }
        Thread.sleep(2_000) // a few 1 s pings
        main.pause().stop()
        idleUntil("background") { app.connection.streamMode == Connection.MODE_BACKGROUND }
        // 25 s without data: past the foreground's 22 s, short of the background's.
        val until = System.currentTimeMillis() + 25_000
        while (System.currentTimeMillis() < until) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
            Thread.sleep(100)
        }
        assertEquals("never reconnected", 1, f.eventsRequests.size)
        main.destroy()
    }

    @Test
    fun quickScreenChangesEndInTheRightMode() {
        val f = start(listOf("stream-modes"))
        app.connection.acquire("service")
        idleUntil("stream") { app.connection.streamId != null }
        repeat(3) {
            val main = Robolectric.buildActivity(MainActivity::class.java).setup()
            main.pause().stop().destroy()
        }
        idleUntil("background again") { f.modes() == listOf("background") && app.connection.streamMode == Connection.MODE_BACKGROUND }
        Thread.sleep(1_000)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
        assertEquals("the server's view", listOf("background"), f.modes())
        assertEquals("one stream", 1, f.eventsRequests.size)
    }

    @Test
    fun aPokeThatIsNotAnsweredOnTheStreamReconnects() {
        val f = start(listOf("stream-modes")) { answerPokes = false }
        app.connection.acquire("service")
        idleUntil("stream") { app.connection.streamId != null }
        app.connection.poke() // what a network change does
        idleUntil("reconnected after the poke got no answer", 12_000) { f.eventsRequests.size == 2 }
    }

    @Test
    fun aStreamTheServerNoLongerHasReconnectsAtOnce() {
        val f = start(listOf("stream-modes")) { pokeAlive = false }
        app.connection.acquire("service")
        idleUntil("stream") { app.connection.streamId != null }
        val t0 = System.currentTimeMillis()
        app.connection.poke()
        idleUntil("reconnected") { f.eventsRequests.size == 2 }
        assertTrue("without waiting for the poke's ping", System.currentTimeMillis() - t0 < 4_000)
    }

    @Test
    fun reconnectsFetchOnlyWhatChangedIntoTheSavedCopy() {
        val now = System.currentTimeMillis()
        val long = "x".repeat(4_000)
        val f = start(listOf("stream-modes", "items-since", "gzip")) {
            items = listOf(item("b000000000000001", "second", now - 1_000), item("a000000000000001", "first $long", now - 2_000))
            cursor = "c1"
        }
        app.connection.acquire("service")
        idleUntil("first sync") { app.repo.state.value.fresh && app.repo.state.value.items.size == 2 }
        assertTrue("the first sync is the full list", f.itemsRequests.single().isEmpty())
        assertTrue("replies come compressed (P3)", f.gzipped.get() >= 1)
        assertEquals("first $long", app.repo.state.value.items.last().text)
        // What the server can do comes just after the first sync (and from the saved copy after that).
        idleUntil("info") { app.repo.state.value.info?.lists("items-since") == true }

        // Meanwhile: "second" was pinned, "third" arrived, "first" was deleted.
        f.delta = JSONObject().put("delta", true).put("cursor", "c2")
            .put("items", JSONArray().put(item("c000000000000001", "third", now)).put(item("b000000000000001", "second", now - 1_000, pinned = true)))
            .put("deleted", JSONArray().put("a000000000000001"))
        app.connection.restart()
        idleUntil("delta sync") { app.repo.state.value.items.map { it.text } == listOf("third", "second") }
        assertEquals("since=c1", f.itemsRequests.last())
        assertTrue(app.repo.state.value.items.first { it.text == "second" }.pinned)

        // The saved copy has the new cursor: a restart asks for changes since c2.
        app.repo.saveNow()
        val saved = JSONObject(java.io.File(app.filesDir, "state.json").readText())
        assertEquals("c2", saved.getString("cursor"))

        // Devices were merged on the server: the whole list again, then what changed while it came.
        f.send("refresh", JSONObject().put("reason", "devices-linked"))
        idleUntil("full list after a merge, and the catch-up") { f.itemsRequests.size >= 4 }
        assertTrue("the whole list", f.itemsRequests[2].isEmpty())
        assertTrue("then a delta from its cursor: ${f.itemsRequests[3]}", f.itemsRequests[3].startsWith("since="))
    }

    /**
     * Budget: while the phone idles, other devices' status reports (each a `devices` event) cost it no request
     * and no rewrite of its saved copy (1.3.0: one rewrite each). A rename still gets saved.
     */
    @Test
    fun otherDevicesStatusReportsCostTheIdlePhoneNothing() {
        val f = start(listOf("stream-modes"))
        app.connection.acquire("service")
        idleUntil("stream") { app.connection.streamId != null && app.repo.state.value.fresh }
        Thread.sleep(2_500) // the connect's own requests and its save
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
        val requests0 = f.requests.size
        val events0 = app.connection.eventsReceived.get()
        // Like the server: sorted by last seen, so the one that just reported comes first.
        fun devices(name: String, battery: Int, laptopFirst: Boolean = false): JSONObject {
            val d = Device(desk, name, "windows", true, System.currentTimeMillis(), DeviceStatus(battery, false, 100L shl 30, 500L shl 30, "Windows 11 Pro")).toJson()
            val laptop = Device("laptop000001", "Laptop", "windows", true, System.currentTimeMillis(), DeviceStatus(battery / 2, true)).toJson()
            return JSONObject().put("devices", if (laptopFirst) JSONArray().put(laptop).put(d) else JSONArray().put(d).put(laptop))
        }
        f.send("devices", devices("Desk", 90))
        idleUntil("two devices") { app.repo.state.value.devices.size == 2 }
        Thread.sleep(2_000)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
        val writes1 = app.repo.cacheWrites.get()
        for (i in 0 until 20) {
            f.send("devices", devices("Desk", 90 - i, laptopFirst = i % 2 == 0))
            f.send("ping", JSONObject())
        }
        idleUntil("events") { app.connection.eventsReceived.get() - events0 >= 41 }
        Thread.sleep(2_000)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
        assertEquals("requests: ${f.requests.drop(requests0)}", 0, f.requests.size - requests0)
        assertEquals("saved-copy rewrites", 0, app.repo.cacheWrites.get() - writes1)
        assertEquals(71, app.repo.state.value.devices.single { it.id == desk }.status?.batteryLevel)

        f.send("devices", devices("Desk upstairs", 70))
        idleUntil("a rename is saved") { app.repo.cacheWrites.get() - writes1 == 1L }
    }

    /**
     * The server sends the sender's own stream its upload events too: this phone's upload is "Sending…", never
     * "Arriving…", and nothing downloads it back (review of 1.4.0).
     */
    @Test
    fun thePhonesOwnUploadIsNotArriving() {
        FakeMediaStore.reset()
        Robolectric.setupContentProvider(FakeMediaStore::class.java, MediaStore.AUTHORITY)
        val f = start(listOf("stream-modes", "live-download")) { liveFile = ByteArray(40_000) { 7 } }
        app.connection.acquire("service")
        idleUntil("stream") { app.connection.streamId != null }
        idleUntil("info") { app.repo.state.value.info?.lists("live-download") == true }
        val mine = JSONObject().put("id", "u00000000000mine").put("name", "my video.mp4").put("size", 40_000).put("offset", 5_000)
            .put("mime", "video/mp4").put("from", app.repo.me).put("device", "Sync Phone").put("to", JSONArray().put(desk))
        val theirs = JSONObject(mine.toString()).put("id", "u0000000000their").put("from", desk).put("device", "Desk")
            .put("to", JSONArray().put(app.prefs.deviceId))
        f.send("upload", mine)
        f.send("upload", theirs)
        idleUntil("theirs arriving") { app.repo.state.value.incoming.containsKey("u0000000000their") }
        assertFalse("its own upload isn't arriving", app.repo.state.value.incoming.containsKey("u00000000000mine"))

        val t = Robolectric.buildActivity(ThreadActivity::class.java, ThreadActivity.intent(app, desk)).setup()
        val adapter = t.get().findViewById<RecyclerView>(R.id.list).adapter as MessageAdapter
        idleUntil("rows") { adapter.currentList.any { it is Row.In } }
        assertEquals(listOf("u0000000000their"), adapter.currentList.filterIsInstance<Row.In>().map { it.inc.id })
        // And a tap on one would never fetch this phone's own file back.
        t.get().saveArriving(Repository.Incoming("u00000000000mine", "my video.mp4", 40_000, 5_000, "video/mp4", app.repo.me, "Sync Phone",
            listOf(desk), System.currentTimeMillis()))
        Thread.sleep(300)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
        assertTrue("no download of its own file: ${f.fileRequests}", f.fileRequests.isEmpty())
        t.pause().stop().destroy()
    }

    /**
     * A `refresh` event fetches the whole list off the stream's thread. A message that arrives meanwhile is shown,
     * then the older list lands without it: the catch-up right after brings it back, in memory and in the saved
     * copy (review of 1.4.0: it stayed gone until the next reconnect).
     */
    @Test
    fun aMessageArrivingDuringARefreshSurvivesIt() {
        val now = System.currentTimeMillis()
        val f = start(listOf("stream-modes", "items-since")) { items = listOf(item("a000000000000001", "old", now - 5_000)) }
        app.connection.acquire("service")
        idleUntil("first sync") { app.repo.state.value.fresh && app.repo.state.value.items.size == 1 }
        idleUntil("info") { app.repo.state.value.info?.lists("items-since") == true }
        f.itemsDelayMs = 1_500
        f.send("refresh", JSONObject().put("reason", "devices-linked"))
        idleUntil("the refresh's request reached the server") { f.itemsRequests.size >= 2 }
        val fresh = item("b000000000000001", "new message", now)
        f.items = listOf(fresh, item("a000000000000001", "old", now - 5_000))
        f.send("item", fresh)
        idleUntil("the live message is shown") { app.repo.state.value.items.any { it.id == "b000000000000001" } }
        f.itemsDelayMs = 0
        idleUntil("the older list landed and the catch-up after it", 10_000) { f.itemsRequests.size >= 3 }
        Thread.sleep(500)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
        assertTrue("the new message stays", app.repo.state.value.items.any { it.id == "b000000000000001" })
        app.repo.saveNow()
        val saved = JSONObject(java.io.File(app.filesDir, "state.json").readText())
        assertTrue("and in the saved copy", saved.toString().contains("b000000000000001"))
    }

    /**
     * "Status only on real changes" compares with what the server has for this phone: one that has none (new, or
     * restored from an older backup) gets it at the next connect, though nothing changed on the phone.
     */
    @Test
    fun aServerWithoutThisPhonesStatusGetsItOnConnect() {
        val f = start(listOf("stream-modes", "device-status"))
        app.connection.acquire("service")
        fun reports() = f.requests.count { it == "PUT /api/devices/me/status" }
        idleUntil("the first report") { reports() == 1 }
        app.connection.restart() // the server still lists no status for the phone
        idleUntil("sent again", 10_000) { reports() == 2 }
        // Now the server has it: nothing to send.
        val opened = f.eventsRequests.size
        f.devices = JSONArray(f.devices.toString())
            .put(Device(app.repo.me, "Sync Phone", "android", true, System.currentTimeMillis(), app.status.lastReported).toJson())
        app.connection.restart()
        idleUntil("reconnected") { f.eventsRequests.size > opened && app.repo.state.value.devices.size == 2 }
        Thread.sleep(1_500)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
        assertEquals("unchanged, and the server has it", 2, reports())
    }

    @Test
    fun anOlderServerKeepsTheOldBehaviour() {
        val f = start(emptyList()) { items = listOf(item("a000000000000001", "first", System.currentTimeMillis())) }
        app.connection.acquire("service")
        idleUntil("synced") { app.repo.state.value.fresh }
        assertNull("no stream id from an older server", app.connection.streamId)
        val main = Robolectric.buildActivity(MainActivity::class.java).setup()
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(500))
        main.pause().stop().destroy()
        assertTrue("no pokes", f.pokes.isEmpty())
        app.connection.restart()
        idleUntil("resynced") { f.itemsRequests.size == 2 }
        assertTrue("never a delta", f.itemsRequests.all { !it.contains("since") })
    }

    @Test
    fun aFileStillArrivingCanBeSavedAndACancelledOneIsThrownAway() {
        FakeMediaStore.reset()
        Robolectric.setupContentProvider(FakeMediaStore::class.java, MediaStore.AUTHORITY)
        val bytes = ByteArray(40_000) { (it % 251).toByte() }
        val f = start(listOf("stream-modes", "live-download")) { liveFile = bytes }
        app.connection.acquire("service")
        idleUntil("stream") { app.connection.streamId != null }
        idleUntil("info") { app.repo.state.value.info?.lists("live-download") == true }
        val upload = JSONObject().put("id", "u000000000000001").put("name", "big video.mp4").put("size", bytes.size).put("offset", 10_000)
            .put("mime", "video/mp4").put("from", desk).put("device", "Desk").put("to", JSONArray().put(app.prefs.deviceId))
        f.send("upload", upload)
        idleUntil("arriving") { app.repo.state.value.incoming.containsKey("u000000000000001") }
        // What tapping the arriving file does.
        val inc = app.repo.state.value.incoming.getValue("u000000000000001")
        app.transfers.download(inc.asItem(), TransferManager.Reason.SAVE)
        idleUntil("saved while it arrived", 15_000) { app.prefs.localFile("u000000000000001") != null }
        assertTrue(FakeMediaStore.byName("big video.mp4")?.readBytes()?.contentEquals(bytes) == true)
        assertEquals(listOf("/api/file/u000000000000001 "), f.fileRequests.toList())

        // Another one is cancelled while saving: the partial copy goes.
        f.liveFile = ByteArray(400_000) { (it % 13).toByte() }
        f.liveSteps = 40
        f.liveStepMs = 300
        f.send("upload", JSONObject(upload.toString()).put("id", "u000000000000002").put("name", "cancelled.mp4").put("size", 400_000))
        idleUntil("second arriving") { app.repo.state.value.incoming.containsKey("u000000000000002") }
        app.transfers.download(app.repo.state.value.incoming.getValue("u000000000000002").asItem(), TransferManager.Reason.SAVE)
        idleUntil("saving") { app.transfers.downloads.value["u000000000000002"]?.received ?: 0 > 0 }
        f.send("upload-cancelled", JSONObject().put("id", "u000000000000002"))
        idleUntil("given up") { app.transfers.downloads.value["u000000000000002"] == null }
        assertNull("not saved", app.prefs.localFile("u000000000000002"))
        assertFalse(app.repo.state.value.incoming.containsKey("u000000000000002"))
        assertNull(FakeMediaStore.byName("cancelled.mp4"))
    }
}
