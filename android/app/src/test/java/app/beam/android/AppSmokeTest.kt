package app.beam.android

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.content.ContentProvider
import android.content.ContentUris
import android.content.ContentValues
import android.content.Intent
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.view.View
import android.widget.EditText
import android.widget.TextView
import androidx.core.view.isVisible
import androidx.recyclerview.widget.RecyclerView
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.BeamApi
import app.beam.android.core.CallHolder
import app.beam.android.core.ChunkBody
import app.beam.android.core.Conversations
import app.beam.android.core.Downloader
import app.beam.android.core.DownloadSink
import app.beam.android.core.Pairing
import app.beam.android.core.ServerInfo
import app.beam.android.core.TestNet
import app.beam.android.notify.Shortcuts
import app.beam.android.data.Repository
import app.beam.android.service.ConnectionService
import app.beam.android.service.TransferService
import app.beam.android.ui.MainActivity
import app.beam.android.ui.PairActivity
import app.beam.android.ui.SendActivity
import app.beam.android.ui.SettingsActivity
import app.beam.android.ui.ThreadActivity
import org.junit.Assert.assertArrayEquals
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.OutputStream
import java.security.MessageDigest
import java.time.Duration
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlin.random.Random

/**
 * Drives the real Android layer (activities, adapters, services, inbox, transfers) under Robolectric,
 * against the scratch Beam server when BEAM_TEST_URL / BEAM_TEST_KEY are set.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class AppSmokeTest {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private val url = System.getProperty("beam.url").orEmpty()
    private val key = System.getProperty("beam.key").orEmpty()

    @Before
    fun setUp() {
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
    }

    private fun idleUntil(what: String, timeoutMs: Long = 15_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(50))
            if (condition()) return
            Thread.sleep(40)
        }
        fail("Timed out waiting for $what")
    }

    /** Creates and binds a view for every adapter position (exercises the real binding code). */
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

    private fun notifications(): List<Notification> =
        shadowOf(app.getSystemService(NotificationManager::class.java)).allNotifications

    private fun Notification.title() = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
    private fun Notification.text() = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()

    @Test
    fun pairScreenExplainsWhatIsMissing() {
        val c = Robolectric.buildActivity(PairActivity::class.java).setup()
        val a = c.get()
        val error = a.findViewById<TextView>(R.id.error)
        a.findViewById<View>(R.id.pair).performClick()
        assertTrue(error.isVisible)
        assertTrue(error.text.contains("address"))
        // An approval code is for the other direction.
        a.findViewById<EditText>(R.id.link).setText("https://my-pc.tailnet.ts.net/?approve=K7QM4R2X")
        a.findViewById<View>(R.id.pair).performClick()
        assertTrue(error.text.contains("already signed in"))
        c.pause().stop().destroy()
    }

    @Test
    fun unpairedLaunchGoesToPairing() {
        val c = Robolectric.buildActivity(MainActivity::class.java).setup()
        assertEquals(PairActivity::class.java.name, shadowOf(c.get()).nextStartedActivity.component?.className)
    }

    @Test
    fun familyMenuOpensBeamFamilyInTheBrowser() {
        assumeTrue("Set BEAM_TEST_URL and BEAM_TEST_KEY", url.isNotEmpty() && key.isNotEmpty())
        // The address comes from the server's info (BEAM_FAMILY_URL there); only http(s) counts.
        assertEquals("https://desk.example.ts.net:8443", ServerInfo.parse(JSONObject().put("family", "https://desk.example.ts.net:8443")).family)
        assertEquals(null, ServerInfo.parse(JSONObject().put("family", "javascript:alert(1)")).family)
        val pair = Robolectric.buildActivity(PairActivity::class.java).setup()
        pair.get().findViewById<EditText>(R.id.link).setText(Pairing.link(url, key))
        pair.get().findViewById<EditText>(R.id.name).setText("Robo Phone")
        pair.get().findViewById<View>(R.id.pair).performClick()
        idleUntil("pairing") { app.prefs.paired }
        pair.pause().stop().destroy()
        val main = Robolectric.buildActivity(MainActivity::class.java).setup()
        idleUntil("connected, with the server's info") { app.repo.state.value.let { it.conn == Repository.Conn.CONNECTED && it.info != null } }
        val menu = main.get().findViewById<androidx.appcompat.widget.Toolbar>(R.id.toolbar).menu
        assertEquals("hidden while the server names no Beam Family", false, menu.findItem(R.id.action_family).isVisible)
        app.repo.setInfo(app.repo.state.value.info!!.copy(family = "https://desk.example.ts.net:8443"))
        idleUntil("shown") { menu.findItem(R.id.action_family).isVisible }
        menu.performIdentifierAction(R.id.action_family, 0)
        val opened = shadowOf(main.get()).nextStartedActivity
        assertEquals(Intent.ACTION_VIEW, opened.action)
        assertEquals("https://desk.example.ts.net:8443", opened.dataString)
        assertTrue("in the browser", opened.hasCategory(Intent.CATEGORY_BROWSABLE))
        main.pause().stop().destroy()
    }

    @Test
    fun endToEndAgainstServer() {
        assumeTrue("Set BEAM_TEST_URL and BEAM_TEST_KEY", url.isNotEmpty() && key.isNotEmpty())
        FakeMediaStore.reset()
        Robolectric.setupContentProvider(FakeMediaStore::class.java, MediaStore.AUTHORITY)
        Robolectric.setupContentProvider(TestFiles::class.java, TestFiles.AUTHORITY)

        // ---- Pair with the real server.
        val pair = Robolectric.buildActivity(PairActivity::class.java).setup()
        pair.get().findViewById<EditText>(R.id.link).setText(Pairing.link(url, key))
        pair.get().findViewById<EditText>(R.id.name).setText("Robo Phone")
        pair.get().findViewById<View>(R.id.pair).performClick()
        idleUntil("pairing") { app.prefs.paired }
        assertEquals("Robo Phone", app.prefs.deviceName)
        assertEquals(MainActivity::class.java.name, shadowOf(pair.get()).nextStartedActivity.component?.className)
        pair.pause().stop().destroy()
        val me = app.prefs.deviceId

        // ---- Another device appears in the conversation list.
        val laptop = TestNet.device(url, key, "Robo Laptop", "windows")
        laptop.me()
        val main = Robolectric.buildActivity(MainActivity::class.java).setup()
        idleUntil("live connection + first sync") {
            val s = app.repo.state.value
            s.conn == Repository.Conn.CONNECTED && s.loaded && app.prefs.baselineDone
        }
        idleUntil("Robo Laptop in the list") {
            app.repo.state.value.devices.any { it.id == laptop.deviceId }
        }
        val convList = main.get().findViewById<RecyclerView>(R.id.list)
        idleUntil("list rows") { bindAll(convList).any { "Robo Laptop" in texts(it) } }
        assertTrue("All devices is pinned first", "All devices" in texts(bindAll(convList).first()))

        // ---- A text sent to this phone: notification, ack ("Delivered"), unread badge.
        val hello = laptop.sendText("hello phone https://example.com", listOf(me))
        idleUntil("ack reaches the server") { me in laptop.item(hello.id).delivered }
        idleUntil("text notification") { notifications().any { it.title() == "Robo Laptop" && it.text()?.startsWith("hello phone") == true } }
        val textNotification = notifications().first { it.title() == "Robo Laptop" }
        // Conversation-style: Copy, Open link (the text has one) and an inline Reply.
        assertEquals(listOf("Copy", "Open link", "Reply"), textNotification.actions.map { it.title.toString() })
        assertEquals(Shortcuts.idFor(laptop.deviceId), textNotification.shortcutId)
        // Its Copy action puts the text on the clipboard (through ActionReceiver).
        textNotification.actions.first { it.title.toString() == "Copy" }.actionIntent.send()
        val clipboard = app.getSystemService(android.content.ClipboardManager::class.java)
        idleUntil("copied from notification") { clipboard.primaryClip?.getItemAt(0)?.text?.toString() == "hello phone https://example.com" }
        idleUntil("unread badge") {
            bindAll(convList).any { row -> "Robo Laptop" in texts(row) && "1" in texts(row) }
        }

        // ---- A broadcast lands in All devices with the sender's name.
        laptop.sendText("to everyone", emptyList())
        idleUntil("broadcast") { app.repo.state.value.items.any { it.text == "to everyone" } }

        // ---- A file too big for auto-download: offered with a Download action.
        app.prefs.autoDownload = false
        val offered = laptop.createUpload("offer.bin", 3, "application/octet-stream", listOf(me)).let { info ->
            laptop.putChunk(info.id, 0, ChunkBody(byteArrayOf(1, 2, 3).inputStream(), 3) {}, CallHolder()).item!!
        }
        idleUntil("offer notification") { notifications().any { it.text()?.startsWith("offer.bin") == true } }
        val offerNotification = notifications().first { it.text()?.startsWith("offer.bin") == true }
        assertEquals("Download", offerNotification.actions.single().title.toString())
        idleUntil("offer acked") { me in laptop.item(offered.id).delivered }
        // Tapping Download starts the transfer service, which saves the file.
        shadowOf(app).clearStartedServices()
        offerNotification.actions.single().actionIntent.send()
        val downloadIntent = shadowOf(app).nextStartedService
        assertEquals(TransferService.ACTION_DOWNLOAD, downloadIntent.action)
        val downloadService = Robolectric.buildService(TransferService::class.java, downloadIntent).create().startCommand(0, 1)
        idleUntil("offered file saved") { FakeMediaStore.byName("offer.bin")?.readBytes()?.contentEquals(byteArrayOf(1, 2, 3)) == true && app.prefs.localFile(offered.id) != null }
        downloadService.destroy()
        app.prefs.autoDownload = true

        // ---- Auto-download: saved through MediaStore (fake provider), then notified and acked.
        val photoBytes = Random(5).nextBytes(300_000)
        val photo = laptop.createUpload("holiday.jpg", photoBytes.size.toLong(), "image/jpeg", listOf(me)).let { info ->
            laptop.putChunk(info.id, 0, ChunkBody(photoBytes.inputStream(), photoBytes.size.toLong()) {}, CallHolder()).item!!
        }
        idleUntil("download saved + acked", 20_000) { me in laptop.item(photo.id).delivered }
        val saved = FakeMediaStore.byName("holiday.jpg")
        assertTrue("file saved", saved != null)
        assertArrayEquals(photoBytes, saved!!.readBytes())
        assertEquals(0, FakeMediaStore.pending(saved)) // published
        idleUntil("saved notification") { notifications().any { it.text()?.startsWith("holiday.jpg") == true } }
        assertEquals(listOf("Open", "Share"), notifications().first { it.text()?.startsWith("holiday.jpg") == true }.actions.map { it.title.toString() })
        assertTrue(app.prefs.localFile(photo.id) != null)

        // ---- Open the conversation: bubbles render, unread clears, reply goes to the laptop only.
        val thread = Robolectric.buildActivity(ThreadActivity::class.java, ThreadActivity.intent(app, laptop.deviceId)).setup()
        val messages = thread.get().findViewById<RecyclerView>(R.id.list)
        idleUntil("thread rows") { (messages.adapter?.itemCount ?: 0) >= 4 }
        val rendered = bindAll(messages).flatMap(::texts)
        assertTrue(rendered.toString(), rendered.any { it.startsWith("hello phone") })
        assertTrue(rendered.toString(), "holiday.jpg" in rendered && "offer.bin" in rendered)
        assertTrue(rendered.toString(), rendered.any { it.contains("Saved") })
        idleUntil("marked read") { (app.prefs.lastRead.value[laptop.deviceId] ?: 0L) >= photo.ts }
        thread.get().findViewById<EditText>(R.id.input).setText("hi laptop")
        thread.get().findViewById<View>(R.id.send).performClick()
        idleUntil("reply on the server") {
            laptop.items().any { it.text == "hi laptop" && it.from == me && it.to == listOf(laptop.deviceId) }
        }
        idleUntil("reply bubble") { bindAll(messages).flatMap(::texts).contains("hi laptop") }

        // ---- The laptop acks my reply: my bubble shows "Delivered".
        val reply = laptop.items().first { it.text == "hi laptop" && it.to == listOf(laptop.deviceId) } // the server keeps earlier runs' items
        laptop.ack(reply.id)
        idleUntil("delivered status") { bindAll(messages).flatMap(::texts).any { it.contains("Delivered") } }
        thread.pause().stop().destroy()

        // ---- Upload through TransferService from a content Uri (2 chunks, streamed).
        val bigBytes = Random(9).nextBytes(8 * 1024 * 1024 + 4321)
        TestFiles.file = File.createTempFile("beam-upload", ".bin").apply { writeBytes(bigBytes); deleteOnExit() }
        val uploadIntent = Intent(app, TransferService::class.java).setAction(TransferService.ACTION_UPLOAD)
            .putExtra("to", arrayOf(laptop.deviceId))
        uploadIntent.clipData = android.content.ClipData.newRawUri("files", Uri.parse("content://${TestFiles.AUTHORITY}/robo%20video.bin"))
        // Earlier runs' phones were merged into this one on the server ("reinstalled app"): only count what's new.
        val since = System.currentTimeMillis() - 1000
        val service = Robolectric.buildService(TransferService::class.java, uploadIntent).create().startCommand(0, 1)
        assertTrue(shadowOf(service.get()).lastForegroundNotification != null)
        idleUntil("upload finished", 30_000) { laptop.items().any { it.name == "robo video.bin" && it.from == me && it.ts >= since } }
        val uploaded = laptop.items().first { it.name == "robo video.bin" && it.from == me && it.ts >= since }
        assertEquals(bigBytes.size.toLong(), uploaded.size)
        assertEquals(listOf(laptop.deviceId), uploaded.to)
        val copy = MemorySink()
        Downloader(laptop, uploaded.id, uploaded.size, copy).run()
        assertArrayEquals(sha(bigBytes), sha(copy.bytes()))
        idleUntil("upload row cleared") { app.transfers.uploads.value.isEmpty() && app.transfers.active.value == 0 }
        service.destroy()

        // ---- Share sheet: tap the laptop to send shared text.
        val share = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "shared from another app")
        val sendActivity = Robolectric.buildActivity(SendActivity::class.java, share).setup()
        idleUntil("share sheet") { ShadowDialog.getLatestDialog() != null }
        val targets = ShadowDialog.getLatestDialog().findViewById<RecyclerView>(R.id.targets)
        idleUntil("share targets") { (targets.adapter?.itemCount ?: 0) >= 2 }
        val laptopRow = bindAll(targets).first { "Robo Laptop" in texts(it) }
        laptopRow.performClick()
        idleUntil("shared text on the server") { laptop.items().any { it.text == "shared from another app" && it.from == me } }
        idleUntil("share sheet closes") { sendActivity.get().isFinishing }

        // ---- Quick Settings tile flow: read the clipboard once focused, pick "All devices", send.
        clipboard.setPrimaryClip(android.content.ClipData.newPlainText("x", "from the clipboard"))
        val clipIntent = SendActivity.clipboardIntent(app)
        val clipActivity = Robolectric.buildActivity(SendActivity::class.java, clipIntent).setup()
        clipActivity.get().onWindowFocusChanged(true)
        idleUntil("clipboard sheet") { ShadowDialog.getLatestDialog()?.findViewById<TextView>(R.id.preview)?.text?.contains("from the clipboard") == true }
        val clipTargets = ShadowDialog.getLatestDialog().findViewById<RecyclerView>(R.id.targets)
        idleUntil("clipboard targets") { (clipTargets.adapter?.itemCount ?: 0) >= 2 }
        bindAll(clipTargets).first().performClick() // All devices
        idleUntil("clipboard text on the server") { laptop.items().any { it.text == "from the clipboard" && it.from == me && it.to.isEmpty() } }

        // ---- Settings screen, background service, unpair.
        val settings = Robolectric.buildActivity(SettingsActivity::class.java).setup()
        assertEquals(url, settings.get().findViewById<TextView>(R.id.serverValue).text.toString())
        settings.get().findViewById<View>(R.id.rowAutoCopy).performClick()
        assertTrue(app.prefs.autoCopy)
        val conn = Robolectric.buildService(ConnectionService::class.java).create().startCommand(0, 1)
        assertTrue(shadowOf(conn.get()).lastForegroundNotification != null)
        conn.destroy()
        settings.pause().stop().destroy()
        main.pause().stop().destroy()
        app.unpair()
        assertTrue(!app.prefs.paired)
        assertEquals(me, app.prefs.deviceId) // identity survives unpairing
        assertEquals("network calls on the main thread", emptyList<String>(), MainThreadGuard.violations.toList())
    }

    private fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b)

    private class MemorySink : DownloadSink {
        private val out = ByteArrayOutputStream()
        fun bytes(): ByteArray = out.toByteArray()
        override fun length() = out.size().toLong()
        override fun open(offset: Long): OutputStream {
            if (offset == 0L) out.reset()
            return out
        }
    }
}

/** Serves one test file as a content Uri, like a file picker or share sheet would. */
class TestFiles : ContentProvider() {
    companion object {
        const val AUTHORITY = "app.beam.android.test.files"
        lateinit var file: File
    }

    override fun onCreate() = true
    override fun getType(uri: Uri) = "application/octet-stream"
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?): Cursor =
        MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)).apply { addRow(arrayOf<Any>(uri.lastPathSegment!!, file.length())) }
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, args: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?) = 0
}

/** Just enough of MediaStore for Downloads/Beam: insert (pending), read/write, publish, query name. */
class FakeMediaStore : ContentProvider() {
    private class Entry(val name: String, val file: File, @Volatile var pending: Int)

    companion object {
        private val entries = ConcurrentHashMap<Long, Entry>()
        private val nextId = AtomicLong(1)
        private val dir: File by lazy { File.createTempFile("fake-media", "").apply { delete(); mkdirs(); deleteOnExit() } }

        fun reset() = entries.clear()
        fun byName(name: String): File? = entries.values.firstOrNull { it.name == name }?.file
        fun pending(file: File): Int = entries.values.first { it.file == file }.pending
    }

    override fun onCreate() = true
    override fun getType(uri: Uri): String? = null

    override fun insert(uri: Uri, values: ContentValues?): Uri {
        val id = nextId.getAndIncrement()
        val name = values?.getAsString(MediaStore.MediaColumns.DISPLAY_NAME) ?: "file"
        val file = File(dir, "$id-$name").apply { createNewFile() }
        entries[id] = Entry(name, file, values?.getAsInteger(MediaStore.MediaColumns.IS_PENDING) ?: 0)
        return ContentUris.withAppendedId(uri, id)
    }

    private fun entry(uri: Uri) = entries[ContentUris.parseId(uri)] ?: throw java.io.FileNotFoundException(uri.toString())

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor =
        ParcelFileDescriptor.open(entry(uri).file, ParcelFileDescriptor.parseMode(mode))

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, args: Array<out String>?, sort: String?): Cursor {
        val e = entry(uri)
        return MatrixCursor(arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)).apply { addRow(arrayOf<Any>(e.name, e.file.length())) }
    }

    override fun update(uri: Uri, values: ContentValues?, selection: String?, args: Array<out String>?): Int {
        val e = entries[ContentUris.parseId(uri)] ?: return 0
        values?.getAsInteger(MediaStore.MediaColumns.IS_PENDING)?.let { e.pending = it }
        return 1
    }

    override fun delete(uri: Uri, selection: String?, args: Array<out String>?): Int {
        val e = entries.remove(ContentUris.parseId(uri)) ?: return 0
        e.file.delete()
        return 1
    }
}
