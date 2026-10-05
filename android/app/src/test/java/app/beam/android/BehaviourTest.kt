package app.beam.android

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.content.ClipData
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Bundle
import android.os.Looper
import android.provider.MediaStore
import android.provider.Settings
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.RemoteInput
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.widget.doAfterTextChanged
import androidx.recyclerview.widget.RecyclerView
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.BeamApi
import app.beam.android.core.BeamException
import app.beam.android.core.CallHolder
import app.beam.android.core.ChunkBody
import app.beam.android.core.DeviceStatus
import app.beam.android.core.Item
import app.beam.android.core.Pairing
import app.beam.android.core.SignInClient
import app.beam.android.core.TestNet
import app.beam.android.data.Outbox
import app.beam.android.data.Prefs
import app.beam.android.data.Repository
import app.beam.android.data.TransferManager
import app.beam.android.notify.Notifier
import app.beam.android.notify.Shortcuts
import app.beam.android.service.TransferService
import app.beam.android.ui.MainActivity
import app.beam.android.ui.PairActivity
import app.beam.android.ui.SendActivity
import app.beam.android.ui.ThreadActivity
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.android.controller.ServiceController
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog
import java.io.File
import java.io.RandomAccessFile
import java.time.Duration
import java.util.concurrent.Callable
import java.util.concurrent.Executors

/**
 * The 1.2.0 behaviours, through the real app (Robolectric) against a scratch Beam server (BEAM_TEST_URL /
 * BEAM_TEST_KEY; BEAM_SERVER_JS for the offline test). Each test signs in as a new phone.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class BehaviourTest {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private val url = System.getProperty("beam.url").orEmpty()
    private val key = System.getProperty("beam.key").orEmpty()
    private val serverJs = System.getProperty("beam.server.js").orEmpty()
    private val cleanups = ArrayList<() -> Unit>()

    @After
    fun tearDown() {
        // Robolectric keeps the JVM between tests: stop this app's connection and transfers.
        if (app.prefs.paired) app.unpair()
        cleanups.forEach { runCatching(it) }
        assertEquals("network calls on the main thread", emptyList<String>(), MainThreadGuard.violations.toList())
    }

    private fun idleUntil(what: String, timeoutMs: Long = 20_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(20))
            if (condition()) return
            Thread.sleep(25)
        }
        throw AssertionError("timed out: $what")
    }

    /** Network calls through the app's own client must not run on the main (test) thread. */
    private fun <T> offMain(block: () -> T): T {
        val ex = Executors.newSingleThreadExecutor()
        try {
            return ex.submit(Callable { block() }).get()
        } finally {
            ex.shutdown()
        }
    }

    private fun notifications(): List<Notification> = shadowOf(app.getSystemService(NotificationManager::class.java)).allNotifications
    private fun Notification.title() = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
    private fun Notification.text() = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()

    private fun needServer() = assumeTrue("Set BEAM_TEST_URL and BEAM_TEST_KEY", url.isNotEmpty() && key.isNotEmpty())

    /** Pairs this phone with the test server and opens the conversation list; returns once it's live. */
    private fun signIn(): ActivityController<MainActivity> {
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        FakeMediaStore.reset()
        Robolectric.setupContentProvider(FakeMediaStore::class.java, MediaStore.AUTHORITY)
        Robolectric.setupContentProvider(TestFiles::class.java, TestFiles.AUTHORITY)
        app.completePairing(Pairing.Link(url, key), "Behaviour Phone", offMain { SignInClient(url).hello().serverId })
        val main = Robolectric.buildActivity(MainActivity::class.java).setup()
        idleUntil("connected") {
            app.repo.state.value.let { it.loaded && it.fresh && it.conn == Repository.Conn.CONNECTED } && app.prefs.baselineDone
        }
        return main
    }

    private fun laptop(name: String = "Laptop") = TestNet.device(url, key, name, "windows").also { it.me() }

    private fun sendFile(from: BeamApi, name: String, bytes: ByteArray, to: List<String>): Item =
        from.createUpload(name, bytes.size.toLong(), "application/octet-stream", to).let { info ->
            from.putChunk(info.id, 0, ChunkBody(bytes.inputStream(), bytes.size.toLong()) {}, CallHolder()).item!!
        }

    // ---------------------------------------------------------------- receiving

    /** Tapping "Download" in a notification: when it's done, a notification says so (Open / Share). */
    @Test
    fun aDownloadStartedFromANotificationAnnouncesTheSavedFile() {
        needServer()
        val main = signIn()
        val me = app.prefs.deviceId
        app.prefs.autoDownload = false
        val laptop = laptop()
        val item = sendFile(laptop, "offer-r2.bin", byteArrayOf(1, 2, 3), listOf(me))
        idleUntil("offer notification") { notifications().any { it.text()?.startsWith("offer-r2.bin") == true } }
        main.pause().stop() // the user is in another app
        val offer = notifications().first { it.text()?.startsWith("offer-r2.bin") == true }
        shadowOf(app).clearStartedServices()
        offer.actions.single().actionIntent.send()
        val svc = Robolectric.buildService(TransferService::class.java, shadowOf(app).nextStartedService).create().startCommand(0, 1)
        idleUntil("saved") { app.prefs.localFile(item.id) != null }
        idleUntil("saved notification") {
            notifications().any { n -> n.text()?.contains("offer-r2.bin") == true && n.actions?.map { it.title.toString() } == listOf("Open", "Share") }
        }
        assertTrue(FakeMediaStore.byName("offer-r2.bin")?.readBytes()?.contentEquals(byteArrayOf(1, 2, 3)) == true)
        svc.destroy()
        main.destroy()
    }

    /** Received texts: conversation-style (shortcut), Copy / Open link / Reply, in one group with a summary. */
    @Test
    fun textNotificationsReplyInlineAndLeaveWhenDeleted() {
        needServer()
        val main = signIn()
        val me = app.prefs.deviceId
        val laptop = laptop("Reply Laptop")
        val sent = laptop.sendText("Look at https://example.com/x please", listOf(me))
        idleUntil("text notification") { notifications().any { it.title() == "Reply Laptop" } }
        val n = notifications().first { it.title() == "Reply Laptop" }
        assertEquals(listOf("Copy", "Open link", "Reply"), n.actions.map { it.title.toString() })
        assertEquals(Shortcuts.idFor(laptop.deviceId), n.shortcutId)
        assertEquals(Notifier.GROUP_ITEMS, n.group)
        assertNotNull(
            "the conversation's sharing shortcut exists",
            ShortcutManagerCompat.getDynamicShortcuts(app).firstOrNull { it.id == Shortcuts.idFor(laptop.deviceId) },
        )
        // (the summary is posted just after the conversation's notification, possibly on another thread: wait for it)
        idleUntil("a group summary") { notifications().any { (it.flags and Notification.FLAG_GROUP_SUMMARY) != 0 } }

        // Reply from the shade: goes to the laptop only.
        val reply = n.actions.first { it.title.toString() == "Reply" }
        val fillIn = Intent()
        RemoteInput.addResultsToIntent(
            arrayOf(RemoteInput.Builder(Notifier.KEY_REPLY).build()),
            fillIn,
            Bundle().apply { putCharSequence(Notifier.KEY_REPLY, "on my way") },
        )
        reply.actionIntent.send(app, 0, fillIn)
        idleUntil("reply on the server") { laptop.items().any { it.text == "on my way" && it.from == me && it.to == listOf(laptop.deviceId) } }

        // Deleted on the laptop: the notification goes too.
        laptop.deleteItem(sent.id)
        idleUntil("notification withdrawn") { notifications().none { it.title() == "Reply Laptop" && it.text()?.startsWith("Look at") == true } }
        main.pause().stop().destroy()
    }

    // ---------------------------------------------------------------- transfers

    /** Starts sending a [mb] MB file (sparse, so it costs no disk here) to [to] through the transfer service. */
    private fun bigUpload(to: String, mb: Long): Pair<File, ServiceController<TransferService>> {
        val big = File.createTempFile("r2-big", ".bin").apply { deleteOnExit() }
        RandomAccessFile(big, "rw").use { it.setLength(mb * 1024 * 1024) }
        cleanups += { big.delete() }
        TestFiles.file = big
        val intent = Intent(app, TransferService::class.java).setAction(TransferService.ACTION_UPLOAD).putExtra("to", arrayOf(to))
        intent.clipData = ClipData.newRawUri("files", Uri.parse("content://${TestFiles.AUTHORITY}/big%20video.bin"))
        return big to Robolectric.buildService(TransferService::class.java, intent).create().startCommand(0, 1)
    }

    /** The server holds at least one whole chunk of the running upload. */
    private fun serverHasAChunk(): Boolean {
        val up = app.transfers.uploads.value.firstOrNull() ?: return false
        val id = up.serverId ?: return false
        return offMain { runCatching { app.api!!.uploadStatus(id).offset }.getOrDefault(0L) } >= 8L * 1024 * 1024
    }

    /** Frees the scratch server's disk after the test. */
    private fun deleteOnServer(from: BeamApi, name: String) {
        cleanups += { from.items().filter { it.name == name }.forEach { from.deleteItem(it.id) } }
    }

    /** Android 15+'s time limit pauses transfers (nothing is thrown away); Resume finishes them. */
    @Test
    fun theTimeLimitPausesTransfersAndResumeFinishesThem() {
        needServer()
        val main = signIn()
        val laptop = laptop()
        deleteOnServer(laptop, "big video.bin")
        val (big, svc) = bigUpload(laptop.deviceId, 400)
        idleUntil("upload under way", 60_000) { serverHasAChunk() }
        svc.get().onTimeout(1, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        idleUntil("paused", 30_000) { app.transfers.uploads.value.singleOrNull()?.status == TransferManager.Status.PAUSED }
        val paused = app.transfers.uploads.value.single()
        val kept = offMain { app.api!!.uploadStatus(paused.serverId!!).offset }
        assertTrue("the server kept what was sent ($kept bytes)", kept >= 8L * 1024 * 1024 && kept < big.length())
        assertTrue("a Resume notification", notifications().any { it.title() == "Transfers paused" })
        svc.destroy()

        app.transfers.resumeAll()
        idleUntil("finished", 180_000) { laptop.items().any { it.name == "big video.bin" && it.size == big.length() && it.to == listOf(laptop.deviceId) } }
        idleUntil("row gone") { app.transfers.uploads.value.isEmpty() }
        assertEquals("one upload, not two", 1, laptop.items().count { it.name == "big video.bin" && it.to == listOf(laptop.deviceId) })
        main.pause().stop().destroy()
    }

    /** The upload queue is saved: after the app restarts (or updates itself), a paused upload carries on. */
    @Test
    fun uploadsSurviveARestart() {
        needServer()
        val main = signIn()
        val laptop = laptop()
        deleteOnServer(laptop, "big video.bin")
        val (big, svc) = bigUpload(laptop.deviceId, 400)
        idleUntil("upload under way", 60_000) { serverHasAChunk() }
        assertTrue(app.transfers.pauseAll())
        idleUntil("paused", 30_000) { app.transfers.uploads.value.singleOrNull()?.status == TransferManager.Status.PAUSED }
        svc.destroy()
        // A new process builds a new manager from what's saved on the device.
        val restarted = TransferManager(app)
        assertEquals(TransferManager.Status.PAUSED, restarted.uploads.value.single().status)
        restarted.resumeAll()
        idleUntil("finished after the restart", 180_000) { laptop.items().any { it.name == "big video.bin" && it.size == big.length() && it.to == listOf(laptop.deviceId) } }
        idleUntil("queue empty") { restarted.uploads.value.isEmpty() }
        main.pause().stop().destroy()
    }

    // ---------------------------------------------------------------- the conversation screen

    /** Long-press on a bubble (outside its text) opens one menu; "Select text" opens the whole text in a sheet. */
    @Test
    fun longPressOpensTheMenuAndSelectTextOpensASheet() {
        needServer()
        val main = signIn()
        val me = app.prefs.deviceId
        val laptop = laptop("Menu Laptop")
        laptop.sendText("Select part of this, please", listOf(me))
        val mine = runBlocking { app.repo.sendText("My reply, waiting for its receipt", listOf(laptop.deviceId)) }
        idleUntil("items") { app.repo.state.value.items.count { it.from == laptop.deviceId || it.id == mine.id } >= 2 }
        val t = Robolectric.buildActivity(ThreadActivity::class.java, ThreadActivity.intent(app, laptop.deviceId)).setup()
        val decor = t.get().window.decorView
        fun layout() {
            val w = decor.resources.displayMetrics.widthPixels
            val h = decor.resources.displayMetrics.heightPixels
            decor.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
            decor.layout(0, 0, w, h)
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(300))
        }
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
        layout()
        val rv = t.get().findViewById<RecyclerView>(R.id.list)
        fun rowWith(prefix: String): View = (0 until rv.childCount).map { rv.getChildAt(it) }
            .first { it.findViewById<TextView>(R.id.text)?.text?.startsWith(prefix) == true }
        val theirs = rowWith("Select part")
        assertTrue("selectable in place (1.2.1; see SelectionTest)", theirs.findViewById<TextView>(R.id.text).isTextSelectable)

        // A receipt updates my bubble in place (DiffUtil payload): same view, text never set again.
        val myText = rowWith("My reply").findViewById<TextView>(R.id.text)
        var textSets = 0
        myText.doAfterTextChanged { textSets++ }
        laptop.ack(mine.id)
        idleUntil("receipt applied") { app.repo.state.value.item(mine.id)?.delivered?.containsKey(laptop.deviceId) == true }
        layout()
        assertTrue("the same bubble after the receipt", rowWith("My reply").findViewById<TextView>(R.id.text) === myText)
        assertEquals("text set again by the receipt", 0, textSets)

        // Long-press anywhere on the bubble: the menu.
        theirs.findViewById<View>(R.id.bubble).performLongClick()
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(300))
        val menu = ShadowDialog.getLatestDialog()
        val entries = menu.findViewById<LinearLayout>(R.id.entries)
        val rows = (0 until entries.childCount).map { entries.getChildAt(it) as TextView }
        val labels = rows.map { it.text.toString() }
        assertTrue(labels.toString(), labels.containsAll(listOf("Copy", "Select text", "Share", "Forward", "Delete")))
        rows.first { it.text.toString() == "Select text" }.performClick()
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(300))
        assertFalse("the menu closed", menu.isShowing)
        val sheet = ShadowDialog.getLatestDialog()
        val text = sheet.findViewById<TextView>(R.id.text)
        assertTrue("selectable in the sheet", text.isTextSelectable)
        assertEquals("Select part of this, please", text.text.toString())
        sheet.dismiss()
        t.pause().stop().destroy()
        main.pause().stop().destroy()
    }

    /** Offline: texts wait in the outbox ("Waiting to send…") and go out, in order, once the server answers. */
    @Test
    fun textsTypedOfflineGoOutWhenTheServerIsBack() {
        needServer()
        assumeTrue("Set BEAM_SERVER_JS", serverJs.isNotEmpty())
        val port = TestNet.freePort()
        val data = java.nio.file.Files.createTempDirectory("beam-r2-offline").toFile()
        File(data, "key").writeText(key) // the same key, so this phone's pairing works there
        val base = "http://127.0.0.1:$port"
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        app.completePairing(Pairing.Link(base, key), "Offline Phone")
        val main = Robolectric.buildActivity(MainActivity::class.java).setup()
        idleUntil("offline") { app.repo.state.value.conn == Repository.Conn.OFFLINE }
        assertEquals(Outbox.Result.Queued, runBlocking { app.outbox.send("first, typed offline", emptyList()) })
        assertEquals(Outbox.Result.Queued, runBlocking { app.outbox.send("second, typed offline", emptyList()) })
        assertEquals(2, app.outbox.entries.value.size)
        // The outbox is saved: a restart keeps both.
        assertEquals(2, Outbox(app).entries.value.size)

        val pb = ProcessBuilder("node", serverJs).redirectErrorStream(true).redirectOutput(File(data, "server.log"))
        pb.environment().apply {
            put("BEAM_HOST", "127.0.0.1")
            put("BEAM_PORT", port.toString())
            put("BEAM_DATA", data.absolutePath)
            put("BEAM_DIST", data.absolutePath)
            put("BEAM_TAILSCALE", "off")
            remove("BEAM_PUBLIC_URL")
            remove("BEAM_MOVED_TO")
        }
        val server = pb.start()
        cleanups += {
            server.destroyForcibly().waitFor()
            data.deleteRecursively()
        }
        idleUntil("sent after reconnecting", 60_000) {
            app.connection.kick() // what opening the app or a network change does
            app.outbox.entries.value.isEmpty()
        }
        val texts = TestNet.device(base, key, "Checker", "cli").items().filter { it.from == app.prefs.deviceId }.sortedBy { it.ts }.map { it.text }
        assertEquals(listOf("first, typed offline", "second, typed offline"), texts)
        main.pause().stop().destroy()
    }

    /** The last copy of the history is saved on the device and shown before the server answers. */
    @Test
    fun theSavedCopyShowsAtOnce() {
        needServer()
        val main = signIn()
        val laptop = laptop()
        laptop.sendText("saved for later", listOf(app.prefs.deviceId))
        idleUntil("item") { app.repo.state.value.items.any { it.text == "saved for later" } }
        offMain { app.repo.saveNow() }
        val coldStart = Repository(app) // what a new process builds first
        assertTrue(coldStart.state.value.loaded)
        assertFalse(coldStart.state.value.fresh)
        assertTrue(coldStart.state.value.items.any { it.text == "saved for later" })
        assertEquals(app.repo.state.value.devices.map { it.id }.toSet(), coldStart.state.value.devices.map { it.id }.toSet())
        main.pause().stop().destroy()
    }

    // ---------------------------------------------------------------- signing in and sending

    /** Closing "Sign in with another device" withdraws the request, so signed-in devices stop being asked. */
    @Test
    fun closingTheSignInDialogWithdrawsTheRequest() {
        needServer()
        val pair = Robolectric.buildActivity(PairActivity::class.java).setup()
        val a = pair.get()
        a.findViewById<EditText>(R.id.link).setText(url)
        a.findViewById<View>(R.id.another).performClick()
        idleUntil("code shown") { ShadowDialog.getLatestDialog()?.findViewById<TextView>(R.id.code)?.text?.length == 9 }
        val dialog = ShadowDialog.getLatestDialog()
        val code = dialog.findViewById<TextView>(R.id.code).text.toString()
        val approver = TestNet.device(url, key, "Approver", "android")
        assertTrue(approver.loginRequests().any { it.code == code })
        dialog.dismiss()
        idleUntil("withdrawn", 10_000) { approver.loginRequests().none { it.code == code } }
        pair.pause().stop().destroy()
    }

    /** "Share → Laptop" (a Direct Share shortcut) and the tile's default device send without the chooser. */
    @Test
    fun directShareAndTheTileSendWithoutAsking() {
        needServer()
        val main = signIn()
        val me = app.prefs.deviceId
        val laptop = laptop("Share Laptop")
        idleUntil("device known") { app.repo.state.value.devicesById.containsKey(laptop.deviceId) }

        val share = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "direct share text")
            .putExtra(ShortcutManagerCompat.EXTRA_SHORTCUT_ID, Shortcuts.idFor(laptop.deviceId))
        val before = ShadowDialog.getLatestDialog()
        val send = Robolectric.buildActivity(SendActivity::class.java, share).setup()
        idleUntil("sent by direct share") { laptop.items().any { it.text == "direct share text" && it.from == me && it.to == listOf(laptop.deviceId) } }
        assertTrue("no chooser sheet", ShadowDialog.getLatestDialog() === before)
        idleUntil("finished") { send.get().isFinishing }

        app.prefs.tileTarget = laptop.deviceId
        app.getSystemService(android.content.ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("x", "tile clipboard text"))
        // Another app can't have the clipboard read and sent (the action only works through Beam's own alias).
        val forged = Intent(app, SendActivity::class.java).setAction(SendActivity.ACTION_SEND_CLIPBOARD).putExtra(SendActivity.EXTRA_FROM_TILE, true)
        val forgedActivity = Robolectric.buildActivity(SendActivity::class.java, forged).setup()
        forgedActivity.get().onWindowFocusChanged(true)
        assertTrue("refused", forgedActivity.get().isFinishing)
        Thread.sleep(500)
        assertTrue("nothing sent", laptop.items().none { it.text == "tile clipboard text" })
        val tile = SendActivity.clipboardIntent(app).putExtra(SendActivity.EXTRA_FROM_TILE, true)
        val tileActivity = Robolectric.buildActivity(SendActivity::class.java, tile).setup()
        tileActivity.get().onWindowFocusChanged(true)
        idleUntil("sent by the tile") { laptop.items().any { it.text == "tile clipboard text" && it.to == listOf(laptop.deviceId) } }
        assertTrue("no chooser sheet", ShadowDialog.getLatestDialog() === before)
        // A file:// URI from another app (it could name Beam's own private files) is refused: nothing to send.
        val private = Uri.fromFile(java.io.File(app.filesDir, "secret.txt").apply { writeText("private") })
        val fileShare = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_STREAM, private)
            .putExtra(ShortcutManagerCompat.EXTRA_SHORTCUT_ID, Shortcuts.idFor(laptop.deviceId))
        val fileActivity = Robolectric.buildActivity(SendActivity::class.java, fileShare).setup()
        assertTrue("nothing to send", fileActivity.get().isFinishing)
        Thread.sleep(500)
        assertTrue("no file sent", laptop.items().none { it.name == "secret.txt" })
        main.pause().stop().destroy()
    }

    // ---------------------------------------------------------------- API v3

    /** A master-key app switches to its own device token, and the server can prove it knows it. */
    @Test
    fun switchesToItsOwnTokenAndChecksProofs() {
        needServer()
        assumeTrue("API v3 server", offMain { SignInClient(url).hello() }.api >= 3)
        val main = signIn()
        idleUntil("device token adopted") { app.prefs.hasDeviceToken }
        val token = app.prefs.key!!
        assertTrue(token.startsWith("bt_"))
        assertEquals(token, app.api!!.key)
        assertTrue(offMain { app.api!!.me() })
        // The same Beam proves it knows the (new) secret before the app would follow it anywhere.
        assertNotNull(offMain { app.moves.verify(url) })
        main.pause().stop().destroy()
    }

    /** Pins, forwarding, clearing a conversation and read markers (API v3). */
    @Test
    fun pinsForwardClearAndReadMarkers() {
        needServer()
        assumeTrue("API v3 server", offMain { SignInClient(url).hello() }.api >= 3)
        val main = signIn()
        val me = app.prefs.deviceId
        val laptop = laptop("V3 Laptop")
        val tablet = laptop("V3 Tablet")
        val t1 = laptop.sendText("pin me", listOf(me))
        idleUntil("item + info") { app.repo.state.value.item(t1.id) != null && app.repo.state.value.info?.has("pin") == true }
        val item = app.repo.state.value.item(t1.id)!!
        runBlocking { app.repo.setPinned(item, true) }
        assertTrue(laptop.item(t1.id).pinned)
        val forwarded = runBlocking { app.repo.forward(item, listOf(tablet.deviceId)) }
        assertEquals("pin me", tablet.item(forwarded.id).text)
        assertEquals(me, tablet.item(forwarded.id).from)
        // Read here: the server stores the marker for this device (a browser linked to it sees the same).
        app.readMarkers.markRead(laptop.deviceId, t1.ts)
        idleUntil("read marker on the server") { (offMain { app.api!!.meResult() }.read[laptop.deviceId] ?: 0L) >= t1.ts }
        // Clear the laptop conversation in one call.
        val ids = app.repo.state.value.items.filter { it.from == laptop.deviceId || laptop.deviceId in it.to }.map { it.id }
        assertEquals(ids.size, runBlocking { app.repo.deleteAll(ids) })
        assertTrue(laptop.items().none { it.id in ids })
        assertTrue(app.repo.state.value.items.none { it.id in ids })
        main.pause().stop().destroy()
    }

    // ---------------------------------------------------------------- server 1.3: status, ring, wake, alerts

    /** Battery, storage and Android version reach the server; another device can ring this phone (and stop it). */
    @Test
    fun reportsItsStatusRingsAndHearsAlerts() {
        needServer()
        // (numbers, not text: "1.14.2" < "1.3" as text, so this skipped itself on every server since 1.10)
        val v = offMain { SignInClient(url).hello() }.version.split('.').map { it.takeWhile(Char::isDigit).toIntOrNull() ?: 0 }
        assumeTrue("Beam server 1.3", (v.getOrElse(0) { 0 } to v.getOrElse(1) { 0 }).let { (major, minor) -> major > 1 || (major == 1 && minor >= 3) })
        val bm = app.getSystemService(android.os.BatteryManager::class.java)
        shadowOf(bm).setIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY, 80)
        shadowOf(bm).setIsCharging(false)
        org.robolectric.shadows.ShadowStatFs.registerStats(android.os.Environment.getDataDirectory().path, 10_000_000, 5_000_000, 5_000_000)
        val main = signIn()
        val me = app.prefs.deviceId
        val laptop = laptop("Ring Laptop")

        // Status: on connect.
        idleUntil("status on the server", 20_000) {
            laptop.devices().devices.firstOrNull { it.id == me }?.status?.batteryLevel == 80
        }
        val mine = laptop.devices().devices.first { it.id == me }
        assertTrue(mine.status!!.os!!.startsWith("Android "))
        assertTrue((mine.status!!.storageFree ?: 0) > 0)
        assertTrue("an Android phone can ring", mine.can.ring)

        // The laptop rings this phone, then stops it.
        assertTrue("online", laptop.ring(me))
        idleUntil("ringing") { app.ringer.ringing.value }
        assertTrue(notifications().any { it.title() == "Ringing from Ring Laptop" })
        laptop.ring(me, stop = true)
        idleUntil("stopped") { !app.ringer.ringing.value }

        // This phone rings the laptop (offline here: no event stream), and tries to wake it (no network cards known).
        assertFalse(offMain { app.api!!.ring(laptop.deviceId) })
        idleUntil("the laptop's ring is known here") { app.ringer.isRinging(laptop.deviceId) }
        val wake = offMain { runCatching { app.api!!.wake(laptop.deviceId) } }.exceptionOrNull()
        assertEquals(409, (wake as BeamException).status)

        // The laptop's battery runs low: an alert here (not about this phone).
        laptop.putStatus(DeviceStatus(9, false, null, null, "Windows 11 Pro"))
        idleUntil("battery alert") {
            notifications().any { it.channelId == Notifier.CH_ALERTS && it.text() == "Ring Laptop's battery is at 9%" && it.title() in setOf("Ring Laptop", "Beam") }
        }

        // Alert settings are the server's: read and change them.
        val alerts = offMain { app.api!!.settings() }.getJSONObject("alerts")
        assertTrue(alerts.getBoolean("battery"))
        val changed = offMain { app.api!!.patchSettings(org.json.JSONObject().put("alerts", org.json.JSONObject().put("offline", org.json.JSONArray().put(laptop.deviceId)))) }
        assertEquals(laptop.deviceId, changed.getJSONObject("alerts").getJSONArray("offline").getString(0))
        offMain { app.api!!.patchSettings(org.json.JSONObject().put("alerts", org.json.JSONObject().put("offline", org.json.JSONArray()))) }
        main.pause().stop().destroy()
    }

    // ---------------------------------------------------------------- identity & search (no server)

    /** New installs derive their id from ANDROID_ID (a reinstall is the same device); a stored id never changes. */
    @Test
    fun deviceIdComesFromAndroidIdButAStoredOneNeverChanges() {
        val sp = app.getSharedPreferences("beam", 0)
        Settings.Secure.putString(app.contentResolver, Settings.Secure.ANDROID_ID, "0123456789abcdef")
        sp.edit().remove("deviceId").commit()
        val fresh = Prefs(app).deviceId
        assertTrue(fresh, fresh.matches(Regex("[0-9a-f]{32}")))
        sp.edit().remove("deviceId").commit()
        assertEquals("a reinstall comes back as the same device", fresh, Prefs(app).deviceId)
        sp.edit().putString("deviceId", "livephone1234567").commit()
        assertEquals("the live phone's id stays", "livephone1234567", Prefs(app).deviceId)
        // X-Beam-Profile: the user account on this phone (a work profile has another ANDROID_ID).
        val profile = java.security.MessageDigest.getInstance("SHA-256").digest("android|0123456789abcdef".toByteArray())
            .joinToString("") { "%02x".format(it) }.take(16)
        assertEquals(profile, Prefs(app).profileId)
    }

    /** "Take a photo" asks for the camera first (Beam declares CAMERA for QR codes), then opens the camera app. */
    @Test
    fun takingAPhotoAsksForTheCameraFirst() {
        app.completePairing(Pairing.Link("http://127.0.0.1:9", "k"), "Camera Phone") // no server needed
        val t = Robolectric.buildActivity(ThreadActivity::class.java, ThreadActivity.intent(app, "desk00000001")).setup()
        fun tapTakeAPhoto() {
            t.get().findViewById<View>(R.id.attach).performClick()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(200))
            val entries = ShadowDialog.getLatestDialog().findViewById<LinearLayout>(R.id.entries)
            (0 until entries.childCount).map { entries.getChildAt(it) as TextView }.first { it.text.toString() == "Take a photo" }.performClick()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(200))
        }
        fun started() = generateSequence { shadowOf(t.get()).nextStartedActivity }.toList()
        tapTakeAPhoto()
        val asked = shadowOf(t.get()).lastRequestedPermission
        assertEquals(listOf(Manifest.permission.CAMERA), asked?.requestedPermissions?.toList())
        assertTrue("Android's permission prompt, not the camera yet", started().none { it.action == MediaStore.ACTION_IMAGE_CAPTURE })

        shadowOf(app).grantPermissions(Manifest.permission.CAMERA)
        tapTakeAPhoto()
        assertTrue("not asked again", shadowOf(t.get()).lastRequestedPermission === asked)
        // FileProvider only maps '/'-separated paths, so under Robolectric on a Windows host the photo's Uri
        // can't be made (on a phone it always can); check the camera intent where the host allows it.
        if (File.separatorChar == '/') {
            val capture = started().firstOrNull { it.action == MediaStore.ACTION_IMAGE_CAPTURE }
            assertNotNull("the camera app is asked for a photo", capture)
            val output = androidx.core.content.IntentCompat.getParcelableExtra(capture!!, MediaStore.EXTRA_OUTPUT, Uri::class.java)
            assertEquals("${app.packageName}.files", output?.authority)
        }
        t.pause().stop().destroy()
    }

    /** "Open link" (menu and notification) opens web links, never the domain of an e-mail address. */
    @Test
    fun openLinkIgnoresEmailAddresses() {
        assertEquals("https://example.com/x", Notifier.firstLink("Look at https://example.com/x please"))
        assertEquals(null, Notifier.firstLink("Password: correct-horse; mail robin@example.com if it doesn't work"))
        assertEquals("https://beam.dev", Notifier.firstLink("mail me@example.org or see beam.dev"))
        assertEquals(null, Notifier.firstLink("Order 1000755 arrives Friday"))
    }

    @Test
    fun searchFindsTextsAndFileNamesOffline() {
        val me = app.prefs.deviceId
        fun text(id: String, t: String, ts: Long) = Item(id, "text", t, false, t.length, null, 0, null, "dev1", "Desk", listOf(me), emptyMap(), ts)
        app.repo.upsert(text("s1", "The boarding pass for Friday", 3))
        app.repo.upsert(text("s2", "Pass the salt", 2))
        app.repo.upsert(Item("s3", "file", null, false, 0, "Boarding Pass.pdf", 10, "application/pdf", "dev1", "Desk", listOf(me), emptyMap(), 1))
        assertEquals(listOf("s1", "s3"), app.repo.search("boarding PASS").map { it.id })
        assertEquals(listOf("s1", "s2", "s3"), app.repo.search("pass").map { it.id })
        assertTrue(app.repo.search("   ").isEmpty())
        assertTrue(app.repo.search("nothing like it").isEmpty())
    }
}
