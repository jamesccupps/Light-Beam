package app.beam.android

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Looper
import android.provider.MediaStore
import android.view.View
import android.widget.TextView
import androidx.core.view.isVisible
import androidx.recyclerview.widget.RecyclerView
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.Conversations
import app.beam.android.core.Device
import app.beam.android.core.Item
import app.beam.android.core.Pairing
import app.beam.android.core.SignInClient
import app.beam.android.core.TestNet
import app.beam.android.data.Files
import app.beam.android.data.Inbox
import app.beam.android.data.Repository
import app.beam.android.data.TransferManager
import app.beam.android.notify.Notifier
import app.beam.android.service.TransferService
import app.beam.android.ui.FilesActivity
import app.beam.android.ui.MainActivity
import app.beam.android.ui.SettingsActivity
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
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import java.io.File
import java.time.Duration
import java.time.ZoneId

/**
 * (Android 1.20.2) The 2026-11-21 audit: one sound for a burst of items (Android 16's "Notification cooldown" quieted
 * an urgent alert after seven at once); a long text whose whole words can't be fetched waits (never copied or notified
 * cut at 16 KB: finding 5); the main list's Alerts row with its count; every alert switch the server has in Settings;
 * a photo from the system picker named from when it was taken; and an upload whose file is gone stops at once with
 * "Can't read this file any more" while the next one goes (finding 17: it said "Connection lost, retrying…" for ten
 * minutes and held the others). The upload test needs a scratch server (BEAM_TEST_URL / BEAM_TEST_KEY).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class Audit1121Test {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private val url = System.getProperty("beam.url").orEmpty()
    private val key = System.getProperty("beam.key").orEmpty()
    private var fake: FakeBeam? = null
    private val opened = mutableListOf<ActivityController<*>>()
    private val cleanups = ArrayList<() -> Unit>()
    private val desk = "desk00000001"

    @Before
    fun setUp() {
        TestFiles.reset()
        Robolectric.setupContentProvider(TestFiles::class.java, TestFiles.AUTHORITY)
    }

    @After
    fun tearDown() {
        for (c in opened.asReversed()) runCatching { c.pause().stop().destroy() }
        opened.clear()
        app.connection.release("service")
        if (app.prefs.paired) app.unpair()
        fake?.close()
        cleanups.forEach { runCatching(it) }
        TestFiles.reset()
    }

    private fun <C : ActivityController<*>> keep(c: C): C = c.also { opened += it }

    private fun idle(ms: Long = 20) = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ms))

    private fun idleUntil(what: String, timeoutMs: Long = 15_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            idle()
            if (condition()) return
            Thread.sleep(10)
        }
        throw AssertionError("timed out: $what")
    }

    private fun idleFor(ms: Long) {
        val until = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < until) {
            idle()
            Thread.sleep(10)
        }
    }

    private fun <T> background(block: () -> T): T {
        var result: Result<T>? = null
        val t = Thread { result = runCatching(block) }.apply { start() }
        while (t.isAlive) idle()
        return result!!.getOrThrow()
    }

    private fun notifications(): List<Notification> = shadowOf(app.getSystemService(NotificationManager::class.java)).allNotifications
    private fun Notification.text() = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()
    private fun clipboard(): String? = app.getSystemService(ClipboardManager::class.java).primaryClip?.getItemAt(0)?.text?.toString()

    private fun online(features: List<String> = listOf("stream-modes", "trust")): FakeBeam {
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        val now = System.currentTimeMillis()
        val f = FakeBeam(features).also { fake = it }
        f.devices = JSONArray().put(Device(desk, "Desk", "windows", true, now, trusted = true).toJson())
        app.completePairing(Pairing.Link(f.url, "bt_the_phones_own_token_21"), "Audit Phone", "fakebeam21")
        app.connection.acquire("service")
        idleUntil("connected") {
            app.repo.state.value.let { it.loaded && it.fresh && it.conn == Repository.Conn.CONNECTED && it.devices.isNotEmpty() } && app.prefs.baselineDone
        }
        return f
    }

    private fun me() = app.repo.me
    private fun file(id: String, name: String) =
        Item(id, "file", null, false, 0, name, 10, "application/octet-stream", desk, desk, listOf(me()), emptyMap(), System.currentTimeMillis())

    // ---------------------------------------------------------------- one sound for a burst

    @Test
    fun aBurstOfItemsSoundsOnceThenTheNextBurstSoundsAgain() {
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        val silent = { n: Notification -> n.groupAlertBehavior == Notification.GROUP_ALERT_SUMMARY } // (NotificationCompat's silent)
        fun offer(id: String) {
            val item = Item(id, "file", null, false, 0, "$id.bin", 10, "application/octet-stream", desk, desk, listOf("phone"), emptyMap(), System.currentTimeMillis())
            Notifier.fileOffer(app, item, "Desk", desk, muted = false, waitingForWifi = false)
        }
        fun posted(id: String) = notifications().first { it.text()?.startsWith("$id.bin") == true }
        for (i in 1..7) offer("burst000000000$i")
        assertFalse("the burst's first item sounds", silent(posted("burst0000000001")))
        for (i in 2..7) assertTrue("item $i of the burst: silent", silent(posted("burst000000000$i")))
        idle(11_000) // (the burst is over: 10 s since its sound)
        offer("burst0000000008")
        assertFalse("the next one sounds again", silent(posted("burst0000000008")))
        val item = Item("muted000000001", "file", null, false, 0, "muted000000001.bin", 10, null, desk, desk, listOf("phone"), emptyMap(), System.currentTimeMillis())
        Notifier.fileOffer(app, item, "Desk", desk, muted = true, waitingForWifi = false)
        assertTrue("a muted device: silent as ever", silent(posted("muted000000001")))
    }

    // ---------------------------------------------------------------- finding 5: a long text's whole words

    @Test
    fun aLongTextWhoseWholeWordsCantBeFetchedWaitsNeverCutAt16Kb() {
        app.prefs.autoCopy = true
        Inbox.TEXT_RETRY_MS = 1500
        cleanups += { Inbox.TEXT_RETRY_MS = 30_000L }
        val f = online()
        app.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("test", "what was there"))
        val words = "a long text, line after line. ".repeat(1200) // ~36 KB
        val id = "long0000000001"
        f.fullTexts[id] = words
        f.textFails = true
        val preview = words.take(16 * 1024)
        f.send("item", Item(id, "text", preview, true, words.length, null, 0, null, desk, desk, listOf(me()), emptyMap(), System.currentTimeMillis()).toJson())
        idleUntil("its whole words asked for") { id in f.textRequests }
        idleFor(800) // (its retry, 1.5 s on, fails again: still waiting)
        assertFalse("not handled: the next catch-up tries again", app.prefs.isHandled(id))
        assertEquals("never copied cut at 16 KB", "what was there", clipboard())
        assertTrue("never notified cut", notifications().none { it.text()?.startsWith("a long text") == true })

        f.textFails = false
        // No reconnect: its retry (a catch-up soon after) takes it, whole
        idleUntil("handled once it could be fetched") { app.prefs.isHandled(id) }
        assertEquals("copied whole", words, clipboard())
        assertTrue("the whole text was fetched again", f.textRequests.count { it == id } >= 2)
    }

    // ---------------------------------------------------------------- the main list's Alerts row

    private fun bindAll(list: RecyclerView): List<View> {
        @Suppress("UNCHECKED_CAST")
        val adapter = list.adapter as RecyclerView.Adapter<RecyclerView.ViewHolder>
        return (0 until adapter.itemCount).map { pos ->
            val holder = adapter.onCreateViewHolder(list, adapter.getItemViewType(pos))
            adapter.onBindViewHolder(holder, pos)
            holder.itemView
        }
    }

    private fun texts(view: View): List<String> {
        val out = ArrayList<String>()
        fun walk(v: View) {
            if (v is TextView && v.isVisible && v.text.isNotEmpty()) out += v.text.toString()
            if (v is android.view.ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i))
        }
        walk(view)
        return out
    }

    @Test
    fun theMainListHasAnAlertsRowWithItsCount() {
        val now = System.currentTimeMillis()
        val f = FakeBeam(listOf("stream-modes", "trust", "inbox")).also { fake = it }
        val alert = { id: String, at: Long, title: String -> JSONObject().put("id", id).put("sender", "a1b2c3d4").put("at", at).put("title", title).put("text", "details").put("priority", 3) }
        f.inbox = JSONObject()
            .put("senders", JSONArray().put(JSONObject().put("id", "a1b2c3d4").put("name", "Stock Watcher").put("muted", false).put("snoozeUntil", 0)))
            .put("alerts", JSONArray().put(alert("2222222222222222", now - 1000, "Back in stock")).put(alert("1111111111111111", now - 60_000, "Price drop")).put(alert("0000000000000000", now - 3_600_000, "Old news")))
            .put("read", now - 120_000)
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        f.devices = JSONArray().put(Device(desk, "Desk", "windows", true, now, trusted = true).toJson())
        app.completePairing(Pairing.Link(f.url, "bt_the_phones_own_token_22"), "Audit Phone", "fakebeam22")
        app.connection.acquire("service")
        idleUntil("connected") { app.connection.streamId != null && app.repo.state.value.info != null && app.repo.state.value.loaded }
        val main = keep(Robolectric.buildActivity(MainActivity::class.java).setup()).get()
        val list = main.findViewById<RecyclerView>(R.id.list)
        idleUntil("the Alerts row") { bindAll(list).getOrNull(1)?.let { "Alerts" in texts(it) } == true }
        val row = texts(bindAll(list)[1])
        assertTrue("after All devices, with its newest alert ($row)", "All devices" in texts(bindAll(list)[0]) && row.any { it == "Stock Watcher: Back in stock" })
        assertTrue("two new since this phone last looked ($row)", "2" in row)

        // Looked at elsewhere (the page marks them read): the count goes
        f.inbox.put("read", now)
        f.send("inbox-read", JSONObject().put("at", now))
        idleUntil("no count") { bindAll(list).getOrNull(1)?.let { r -> "Alerts" in texts(r) && "2" !in texts(r) } == true }

        // A new one (a quiet one too: listed, so counted)
        val arr = f.inbox.getJSONArray("alerts")
        val newer = JSONArray().put(alert("3333333333333333", now + 1000, "Just now")).also { for (i in 0 until arr.length()) it.put(arr.get(i)) }
        f.inbox.put("alerts", newer)
        f.send("inbox", JSONObject().put("alert", newer.getJSONObject(0)).put("notify", false).put("sender", JSONObject().put("id", "a1b2c3d4").put("name", "Stock Watcher")))
        idleUntil("the new one") { bindAll(list).getOrNull(1)?.let { r -> "Stock Watcher: Just now" in texts(r) && "1" in texts(r) } == true }

        // Opening it opens the list (#alerts)
        bindAll(list)[1].findViewById<View>(R.id.row).performClick()
        idle()
        val next = shadowOf(main).nextStartedActivity
        assertEquals(FilesActivity::class.java.name, next?.component?.className)
    }

    @Test
    fun anOlderServerHasNoAlertsRow() {
        online(listOf("stream-modes", "trust"))
        val main = keep(Robolectric.buildActivity(MainActivity::class.java).setup()).get()
        val list = main.findViewById<RecyclerView>(R.id.list)
        idleUntil("the list") { bindAll(list).isNotEmpty() }
        idleFor(300)
        assertTrue(bindAll(list).none { "Alerts" in texts(it) })
        assertTrue("never a conversation", Conversations.ALERTS.startsWith("~"))
    }

    // ---------------------------------------------------------------- Settings -> Alerts: every switch the server has

    @Test
    fun settingsShowsEveryAlertSwitchTheServerHas() {
        val f = online()
        f.settingsGet = JSONObject().put("alerts", JSONObject().put("battery", true).put("storage", true).put("serverDisk", true)
            .put("tailscaleKey", true).put("powerLoss", false).put("setup", true).put("hardware", true).put("down", true).put("offline", JSONArray()))
        val s = keep(Robolectric.buildActivity(SettingsActivity::class.java).setup()).get()
        idleUntil("the alerts") { s.findViewById<View>(R.id.alertsSection).isVisible && s.findViewById<View>(R.id.rowAlertDown).isVisible }
        for (id in listOf(R.id.rowAlertTailscale, R.id.rowAlertPowerLoss, R.id.rowAlertSetup, R.id.rowAlertHardware, R.id.rowAlertDown)) {
            assertTrue("shown: ${s.resources.getResourceEntryName(id)}", s.findViewById<View>(id).isVisible)
        }
        assertFalse("a PC's power loss: off, as the server says", s.findViewById<com.google.android.material.materialswitch.MaterialSwitch>(R.id.alertPowerLoss).isChecked)
        assertTrue(s.findViewById<com.google.android.material.materialswitch.MaterialSwitch>(R.id.alertDown).isChecked)

        // An older server (only the first three): the others stay hidden
        f.settingsGet = JSONObject().put("alerts", JSONObject().put("battery", true).put("storage", false).put("serverDisk", true).put("offline", JSONArray()))
        val older = keep(Robolectric.buildActivity(SettingsActivity::class.java).setup()).get()
        idleUntil("the alerts") { older.findViewById<View>(R.id.alertsSection).isVisible }
        for (id in listOf(R.id.rowAlertTailscale, R.id.rowAlertPowerLoss, R.id.rowAlertSetup, R.id.rowAlertHardware, R.id.rowAlertDown)) {
            assertFalse("hidden: ${older.resources.getResourceEntryName(id)}", older.findViewById<View>(id).isVisible)
        }
    }

    // ---------------------------------------------------------------- a photo from the system picker

    @Test
    fun aPickerPhotoIsNamedFromWhenItWasTaken() {
        val taken = java.time.ZonedDateTime.of(2026, 11, 21, 16, 39, 5, 0, ZoneId.of("America/New_York")).toInstant().toEpochMilli()
        val zone = ZoneId.of("America/New_York")
        assertEquals("IMG 2026-11-21 16.39.05.jpg", Files.pickerName("23.jpg", "image/jpeg", taken, zone))
        assertEquals("VID 2026-11-21 16.39.05.mp4", Files.pickerName("1000000041.mp4", "video/mp4", taken, zone))
        assertNull("a real name stays", Files.pickerName("PXL_20261121_163905123.jpg", "image/jpeg", taken, zone))
        assertNull("no time: as it was", Files.pickerName("23.jpg", "image/jpeg", null, zone))
        assertTrue(Files.isPickerUri(Uri.parse("content://media/picker/0/com.android.providers.media.photopicker/media/23")))
        assertTrue(Files.isPickerUri(Uri.parse("content://media/picker_get_content/0/com.android.providers.media.photopicker/media/23")))
        assertFalse(Files.isPickerUri(Uri.parse("content://media/external/images/media/23")))
        assertFalse(Files.isPickerUri(Uri.parse("content://${MediaStore.AUTHORITY}.documents/document/image:23")))
    }

    // ---------------------------------------------------------------- finding 17: a file that's gone (scratch server)

    @Test
    fun anUploadWhoseFileIsGoneStopsAndTheNextOneGoes() {
        assumeTrue("Set BEAM_TEST_URL and BEAM_TEST_KEY", url.isNotEmpty() && key.isNotEmpty())
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        app.completePairing(Pairing.Link(url, key), "Audit Phone", background { SignInClient(url).hello().serverId })
        app.connection.acquire("service")
        idleUntil("connected") { app.repo.state.value.let { it.loaded && it.fresh && it.conn == Repository.Conn.CONNECTED } && app.prefs.baselineDone }
        val laptop = TestNet.device(url, key, "A17 Laptop", "windows").also { it.me() }
        cleanups += { laptop.items().filter { it.name == "after-the-gone-one.bin" }.forEach { laptop.deleteItem(it.id) } }
        TestFiles.file = File.createTempFile("a1121", ".bin").apply {
            writeBytes(java.util.Random(17).let { r -> ByteArray(300 * 1024).also(r::nextBytes) })
            deleteOnExit()
        }
        cleanups += { TestFiles.file.delete() }
        TestFiles.gone += "gone-before-it-was-read.bin"
        val started = System.currentTimeMillis()
        val first = upload(laptop.deviceId, "gone-before-it-was-read.bin")
        // (the gone one first in the queue: the next one waits behind it, as in the audit's emulator run)
        idleUntil("the gone one under way") { app.transfers.uploads.value.any { it.name == "gone-before-it-was-read.bin" && it.status != TransferManager.Status.QUEUED } }
        val second = upload(laptop.deviceId, "after-the-gone-one.bin")
        idleUntil("the gone one stopped", 20_000) { app.transfers.uploads.value.any { it.name == "gone-before-it-was-read.bin" && it.status == TransferManager.Status.FAILED } }
        idleUntil("the next one sent", 30_000) { background { laptop.items() }.any { it.name == "after-the-gone-one.bin" && it.size == TestFiles.file.length() } }
        assertTrue("not ten minutes: ${System.currentTimeMillis() - started} ms", System.currentTimeMillis() - started < 20_000)
        val gone = app.transfers.uploads.value.single { it.name == "gone-before-it-was-read.bin" }
        assertEquals(TransferManager.Status.FAILED, gone.status)
        assertEquals("Can't read this file any more.", gone.error)
        assertFalse("not waiting for a connection", gone.retryable)
        first.destroy()
        second.destroy()
    }

    private fun upload(to: String, name: String): org.robolectric.android.controller.ServiceController<TransferService> {
        val intent = Intent(app, TransferService::class.java).setAction(TransferService.ACTION_UPLOAD).putExtra("to", arrayOf(to))
        intent.clipData = ClipData.newRawUri("files", Uri.parse("content://${TestFiles.AUTHORITY}/" + Uri.encode(name)))
        return Robolectric.buildService(TransferService::class.java, intent).create().also { it.startCommand(0, 1) }
    }
}
