package app.beam.android

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.net.Uri
import android.os.Looper
import android.provider.MediaStore
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.ChunkBody
import app.beam.android.core.Device
import app.beam.android.core.Item
import app.beam.android.core.Pairing
import app.beam.android.core.SignInClient
import app.beam.android.core.SourceChangedException
import app.beam.android.core.TestNet
import app.beam.android.data.Files
import app.beam.android.data.Prefs
import app.beam.android.data.Repository
import app.beam.android.data.SecretBox
import app.beam.android.data.SettingsBackups
import app.beam.android.data.TransferManager
import app.beam.android.service.Ringer
import app.beam.android.service.TransferService
import app.beam.android.ui.Thumbs
import okio.Buffer
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
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.net.HttpURLConnection
import java.io.RandomAccessFile
import java.net.URL
import java.time.Duration
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.zip.CRC32
import java.util.zip.DeflaterOutputStream

/**
 * (Android 1.16) Round C of the user's review of 2026-11-05: what the phone does by itself comes only from approved
 * devices (M2), Restore names approved devices only, "Wi-Fi only" follows the network (M9), a server thumbnail is decoded
 * small (M8), the file's own size wins and the last chunk checks the end (M10), a Cancel or a pause while an upload gets
 * ready holds (M6), an upload that waits for a connection keeps a copy of its own (M7), the ringer's volume comes back
 * after a crash, the page sign-ins are sealed. The upload tests need a scratch server (BEAM_TEST_URL / BEAM_TEST_KEY, and
 * BEAM_SERVER_JS for the one that stops its own); the rest always run.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36])
class Review116Test {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private val url = System.getProperty("beam.url").orEmpty()
    private val key = System.getProperty("beam.key").orEmpty()
    private val serverJs = System.getProperty("beam.server.js").orEmpty()
    private var fake: FakeBeam? = null
    private var server: Process? = null
    private var data: File? = null
    private val cleanups = ArrayList<() -> Unit>()
    private val desk = "desk00000001"
    private val newPc = "newpc0000001"

    @Before
    fun setUp() {
        TestFiles.reset()
        FakeMediaStore.reset()
        Robolectric.setupContentProvider(FakeMediaStore::class.java, MediaStore.AUTHORITY)
        Robolectric.setupContentProvider(TestFiles::class.java, TestFiles.AUTHORITY)
    }

    @After
    fun tearDown() {
        TestFiles.gate?.countDown()
        app.network.meteredForTest(null)
        app.connection.release("service")
        if (app.prefs.paired) app.unpair()
        fake?.close()
        server?.let {
            it.destroy()
            if (!it.waitFor(10, TimeUnit.SECONDS)) it.destroyForcibly().waitFor()
        }
        data?.deleteRecursively()
        cleanups.forEach { runCatching(it) }
        TestFiles.reset()
        assertEquals("network calls on the main thread", emptyList<String>(), MainThreadGuard.violations.toList())
    }

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

    // ---------------------------------------------------------------- against FakeBeam: what the phone does by itself

    private fun online(features: List<String> = listOf("stream-modes", "trust")): FakeBeam {
        val now = System.currentTimeMillis()
        val f = FakeBeam(features).also { fake = it }
        f.devices = JSONArray()
            .put(Device(desk, "Desk", "windows", true, now, trusted = true).toJson())
            .put(Device(newPc, "New PC", "windows", true, now, trusted = false).toJson())
        app.completePairing(Pairing.Link(f.url, "bt_the_phones_own_token_16"), "Review Phone", "fakebeam16")
        app.connection.acquire("service")
        idleUntil("connected") {
            app.repo.state.value.let { it.loaded && it.fresh && it.conn == Repository.Conn.CONNECTED && it.devices.size == 2 } && app.prefs.baselineDone
        }
        return f
    }

    private fun me() = app.repo.me
    private fun text(id: String, from: String, words: String) =
        Item(id, "text", words, false, words.length, null, 0, null, from, from, listOf(me()), emptyMap(), System.currentTimeMillis())
    private fun file(id: String, from: String, name: String, size: Long) =
        Item(id, "file", null, false, 0, name, size, "application/octet-stream", from, from, listOf(me()), emptyMap(), System.currentTimeMillis())

    private fun clipboard(): String? = app.getSystemService(ClipboardManager::class.java).primaryClip?.getItemAt(0)?.text?.toString()

    /** (the review's M2) Copied and downloaded by itself only from an approved device; the others still notify. */
    @Test
    fun onlyApprovedDevicesItemsAreCopiedOrDownloadedByThemselves() {
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        app.prefs.autoCopy = true
        app.prefs.autoDownload = true
        val f = online()
        app.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("test", "what was there"))

        f.send("item", text("r116000000000001", newPc, "from a PC nobody approved").toJson())
        idleUntil("handled") { app.prefs.isHandled("r116000000000001") }
        assertEquals("not copied: that device isn't approved", "what was there", clipboard())

        f.send("item", text("r116000000000002", desk, "from Desk").toJson())
        idleUntil("handled") { app.prefs.isHandled("r116000000000002") }
        assertEquals("copied: an approved device", "from Desk", clipboard())

        f.send("item", file("r116000000000003", newPc, "unasked.bin", 10).toJson())
        idleUntil("handled") { app.prefs.isHandled("r116000000000003") }
        idleFor(300)
        assertNull("never downloaded by itself", app.transfers.downloads.value["r116000000000003"])
        assertTrue("never fetched", f.fileRequests.none { it.contains("r116000000000003") })
        assertTrue("offered in a notification", shadowOf(app.getSystemService(android.app.NotificationManager::class.java)).allNotifications.any {
            it.extras.getCharSequence(android.app.Notification.EXTRA_TEXT)?.toString()?.contains("unasked.bin") == true
        })
    }

    /** (the review's M2) Restore settings never makes a device that isn't approved the tile's or one copied from. */
    @Test
    fun restoreNamesOnlyApprovedDevices() {
        val prefs = Prefs(app)
        SettingsBackups.applyTo(
            prefs,
            JSONObject().put("tileTarget", "pc0001").put("autoCopyDevices", JSONArray(listOf("pc0001", "pc0002")))
                .put("mutedDevices", JSONArray(listOf("pc0001", "pc0002"))),
            setOf("phone01"),
        ) { it == "pc0002" }
        assertNull("the tile never sends to a device that isn't approved", prefs.tileTarget)
        assertEquals(setOf("pc0002"), prefs.autoCopyDevices)
        assertEquals("muting is harmless: kept", setOf("pc0001", "pc0002"), prefs.mutedDevices)
    }

    /**
     * (the review's M9) "Wi-Fi only" was checked once, as a download started: one that began on Wi-Fi went on over mobile
     * data. Now it pauses when the network turns metered (behind Tailscale only that changes) and carries on on Wi-Fi; one
     * that arrives on mobile data waits, and comes when Wi-Fi does.
     */
    @Test
    fun wifiOnlyFollowsTheNetwork() {
        app.prefs.autoDownload = true
        app.prefs.wifiOnlyDownloads = true
        app.network.meteredForTest(false)
        val f = online(listOf("stream-modes"))
        val bytes = java.util.Random(16).let { r -> ByteArray(400 * 1024).also(r::nextBytes) }
        f.liveFile = bytes
        f.liveSteps = 40
        f.liveStepMs = 100

        val id = "r116000000000010"
        f.send("item", file(id, desk, "wifi only.bin", bytes.size.toLong()).toJson())
        idleUntil("downloading") { (app.transfers.downloads.value[id]?.received ?: 0) > 0 }
        app.network.meteredForTest(true)
        idleUntil("paused for Wi-Fi") { app.transfers.downloads.value[id]?.let { it.status == TransferManager.Status.PAUSED && it.wifi } == true }
        assertTrue(app.transfers.waitingForWifi(id))
        assertFalse("not a Resume notification's to carry on", app.transfers.hasPaused)
        val seen = f.fileRequests.size
        idleFor(600)
        assertEquals("nothing more over mobile data", seen, f.fileRequests.size)

        // Another comes on mobile data: it waits too.
        val later = "r116000000000011"
        f.send("item", file(later, desk, "later.bin", bytes.size.toLong()).toJson())
        idleUntil("seen") { app.repo.state.value.item(later) != null }
        idleFor(500)
        assertNull("waits for Wi-Fi", app.transfers.downloads.value[later]?.takeIf { it.status == TransferManager.Status.RUNNING })

        app.network.meteredForTest(false)
        idleUntil("both saved on Wi-Fi", 30_000) { app.prefs.localFile(id) != null && app.prefs.localFile(later) != null }
        assertTrue(FakeMediaStore.byName("wifi only.bin")!!.readBytes().contentEquals(bytes))
        assertTrue(FakeMediaStore.byName("later.bin")!!.readBytes().contentEquals(bytes))
    }

    // ---------------------------------------------------------------- small parts, no server

    /** A grayscale PNG of [w] × [h] (all black), made without the memory a bitmap of that size would take. */
    private fun bigPng(w: Int, h: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        fun chunk(type: String, body: ByteArray) {
            val t = type.toByteArray()
            out.write(java.nio.ByteBuffer.allocate(4).putInt(body.size).array())
            out.write(t)
            out.write(body)
            val crc = CRC32().apply { update(t); update(body) }
            out.write(java.nio.ByteBuffer.allocate(4).putInt(crc.value.toInt()).array())
        }
        out.write(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))
        chunk("IHDR", java.nio.ByteBuffer.allocate(13).putInt(w).putInt(h).put(8).put(0).put(0).put(0).put(0).array())
        val idat = java.io.ByteArrayOutputStream()
        DeflaterOutputStream(idat).use { z -> val row = ByteArray(w + 1); repeat(h) { z.write(row) } }
        chunk("IDAT", idat.toByteArray())
        chunk("IEND", ByteArray(0))
        return out.toByteArray()
    }

    /** (the review's M8) A thumbnail whose header says 9000 × 9000 is decoded at most 720 px a side, never in full. */
    @Test
    fun aHugeThumbnailIsDecodedSmall() {
        val id = "r116000000000020"
        val thumb = File(File(app.cacheDir, "thumbs").apply { mkdirs() }, "$id.jpg")
        thumb.writeBytes(bigPng(9000, 9000))
        cleanups += { thumb.delete() }
        val item = Item(id, "file", null, false, 0, "big.png", 100, "image/png", desk, "Desk", emptyList(), emptyMap(), 0, thumb = true)
        val bmp = Thumbs.loadItem(app, item, null)
        assertTrue("a preview", bmp != null)
        assertTrue("${bmp!!.width} × ${bmp.height}", maxOf(bmp.width, bmp.height) <= 720)
    }

    /** (the review's M10) The file's own size wins over what its app lists; the last chunk refuses a file longer than said. */
    @Test
    fun theFilesOwnSizeWinsAndTheLastChunkChecksTheEnd() {
        TestFiles.file = File.createTempFile("m10", ".bin").apply { writeBytes(ByteArray(5_000) { it.toByte() }); deleteOnExit() }
        TestFiles.reportedSize = 4_000 // the size before an edit
        assertEquals(5_000L, Files.meta(app, Uri.parse("content://${TestFiles.AUTHORITY}/edited.jpg")).size)

        fun send(have: Int, length: Long, last: Boolean): Long {
            val sink = Buffer()
            ChunkBody(ByteArray(have).inputStream(), length, last = last) {}.writeTo(sink)
            return sink.size
        }
        assertEquals(10L, send(10, 10, last = true))
        assertEquals("a chunk that isn't the last goes on", 9L, send(10, 9, last = false))
        assertTrue("the last chunk of a file longer than said", runCatching { send(10, 9, last = true) }.exceptionOrNull() is SourceChangedException)
        assertTrue("shorter than said", runCatching { send(8, 9, last = true) }.exceptionOrNull() is SourceChangedException)
    }

    /** (the review's Low) The alarm volume Beam turned up while ringing comes back at the next start after a crash. */
    @Test
    fun theRingersVolumeComesBackAfterACrash() {
        val audio = app.getSystemService(AudioManager::class.java)
        val max = audio.getStreamMaxVolume(AudioManager.STREAM_ALARM)
        audio.setStreamVolume(AudioManager.STREAM_ALARM, max, 0) // as it rang when the process ended
        app.prefs.ringVolumeToRestore = 2
        Ringer(app).recover()
        assertEquals(2, audio.getStreamVolume(AudioManager.STREAM_ALARM))
        assertEquals(-1, app.prefs.ringVolumeToRestore)
        // Changed by someone since: left as it is.
        audio.setStreamVolume(AudioManager.STREAM_ALARM, 4, 0)
        app.prefs.ringVolumeToRestore = 1
        Ringer(app).recover()
        assertEquals(4, audio.getStreamVolume(AudioManager.STREAM_ALARM))
    }

    /** (the review's Low) The viewer and Shared folders pages' own sign-ins are kept sealed, like the app's own. */
    @Test
    fun pageSignInsAreKeptSealed() {
        val prefs = Prefs(app, ReversingBox())
        prefs.remotePageTokens = setOf("https://beam.example bt_a_page_token_000001")
        val raw = app.getSharedPreferences("beam", Context.MODE_PRIVATE).getStringSet("remotePageTokens", null).orEmpty()
        assertTrue(raw.toString(), raw.single().startsWith("sealed:") && !raw.single().contains("bt_a_page_token"))
        assertEquals(setOf("https://beam.example bt_a_page_token_000001"), prefs.remotePageTokens)
        // One kept in clear by 1.15 still reads, and is sealed at the next change.
        app.getSharedPreferences("beam", Context.MODE_PRIVATE).edit().putStringSet("remotePageTokens", setOf("https://old bt_old_one")).commit()
        assertEquals(setOf("https://old bt_old_one"), prefs.remotePageTokens)
    }

    /** A stand-in for the Keystore's box: what it seals reads differently. */
    private class ReversingBox : SecretBox {
        override fun seal(plain: String): String = "box(" + plain.reversed() + ")"
        override fun open(sealed: String): String? = sealed.takeIf { it.startsWith("box(") && it.endsWith(")") }?.removePrefix("box(")?.removeSuffix(")")?.reversed()
    }

    // ---------------------------------------------------------------- uploads, against a scratch server

    private fun needServer() = assumeTrue("Set BEAM_TEST_URL and BEAM_TEST_KEY", url.isNotEmpty() && key.isNotEmpty())

    private fun signIn(base: String = url, k: String = key) {
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        app.completePairing(Pairing.Link(base, k), "Review Phone", background { SignInClient(base).hello().serverId })
        app.connection.acquire("service")
        idleUntil("connected") { app.repo.state.value.let { it.loaded && it.fresh && it.conn == Repository.Conn.CONNECTED } && app.prefs.baselineDone }
    }

    private fun <T> background(block: () -> T): T {
        var result: Result<T>? = null
        val t = Thread { result = runCatching(block) }.apply { start() }
        while (t.isAlive) idle()
        return result!!.getOrThrow()
    }

    private fun upload(to: String, name: String): ServiceStart {
        val intent = Intent(app, TransferService::class.java).setAction(TransferService.ACTION_UPLOAD).putExtra("to", arrayOf(to))
        intent.clipData = ClipData.newRawUri("files", Uri.parse("content://${TestFiles.AUTHORITY}/" + Uri.encode(name)))
        return ServiceStart(Robolectric.buildService(TransferService::class.java, intent).create().startCommand(0, 1))
    }

    class ServiceStart(val svc: org.robolectric.android.controller.ServiceController<TransferService>)

    private fun photo(bytes: Int): File = File.createTempFile("r116", ".jpg").apply {
        writeBytes(java.util.Random(116).let { r -> ByteArray(bytes).also(r::nextBytes) })
        deleteOnExit()
        cleanups += { delete() }
    }

    /**
     * (the review's M6) A Cancel while an upload gets ready (here: reading the picture's size, before the uploader
     * exists) used to be forgotten: the file went anyway, with no row. Now nothing goes. A pause there holds too.
     */
    @Test
    fun aCancelOrAPauseWhileGettingReadyHolds() {
        needServer()
        signIn()
        val laptop = TestNet.device(url, key, "M6 Laptop", "windows").also { it.me() }
        cleanups += { laptop.items().filter { it.name == "m6 photo.jpg" }.forEach { laptop.deleteItem(it.id) } }
        TestFiles.file = photo(200 * 1024)
        TestFiles.type = "image/jpeg"
        // Open 1 is the size (Files.meta); open 2 the picture's size, in the upload's run: it waits there.
        TestFiles.gate = CountDownLatch(1)
        TestFiles.gateFrom = 2
        val s = upload(laptop.deviceId, "m6 photo.jpg")
        idleUntil("getting ready") { TestFiles.opens.get() >= 2 }
        val up = app.transfers.uploads.value.single()
        assertNull("no session yet: the uploader doesn't exist", up.serverId)
        app.transfers.cancelUpload(up.localId)
        assertTrue("the row goes at once", app.transfers.uploads.value.isEmpty())
        TestFiles.gate!!.countDown()
        idleFor(2_500)
        assertTrue("nothing was sent", laptop.items().none { it.name == "m6 photo.jpg" })
        s.svc.destroy()

        // The same with a pause (Android's time limit): it stays paused, and Resume sends it once.
        TestFiles.opens.set(0)
        TestFiles.gate = CountDownLatch(1)
        val s2 = upload(laptop.deviceId, "m6 photo.jpg")
        idleUntil("getting ready again") { TestFiles.opens.get() >= 2 }
        assertTrue(app.transfers.pauseAll())
        TestFiles.gate!!.countDown()
        idleUntil("paused") { app.transfers.uploads.value.singleOrNull()?.status == TransferManager.Status.PAUSED }
        idleFor(1_500)
        assertEquals(TransferManager.Status.PAUSED, app.transfers.uploads.value.single().status)
        assertTrue("nothing sent while paused", laptop.items().none { it.name == "m6 photo.jpg" })
        TestFiles.gateFrom = Int.MAX_VALUE
        app.transfers.resumeAll()
        idleUntil("sent after Resume", 30_000) { laptop.items().any { it.name == "m6 photo.jpg" && it.size == TestFiles.file.length() } }
        idleUntil("row gone") { app.transfers.uploads.value.isEmpty() }
        assertEquals("once", 1, laptop.items().count { it.name == "m6 photo.jpg" })
        s2.svc.destroy()
    }

    /**
     * (the review's M10) A file that grew after its size was taken (its app's list, or an edit while it waited) used to
     * arrive cut to that size, "sent", with no error. Now the last chunk finds the rest, and it goes once more from a copy
     * of its own, whole.
     */
    @Test
    fun aFileLongerThanItSaidGoesWhole() {
        needServer()
        signIn()
        val laptop = TestNet.device(url, key, "M10 Laptop", "windows").also { it.me() }
        cleanups += { laptop.items().filter { it.name == "grew.bin" }.forEach { laptop.deleteItem(it.id) } }
        TestFiles.file = photo(100 * 1024)
        // Open 1 is the size; open 2 the first chunk's read: before it, the file grows.
        TestFiles.gate = CountDownLatch(1)
        TestFiles.gateFrom = 2
        val s = upload(laptop.deviceId, "grew.bin")
        idleUntil("sending") { TestFiles.opens.get() >= 2 }
        val more = java.util.Random(10).let { r -> ByteArray(30 * 1024).also(r::nextBytes) }
        TestFiles.file.appendBytes(more)
        TestFiles.gateFrom = Int.MAX_VALUE
        TestFiles.gate!!.countDown()
        idleUntil("sent", 30_000) { laptop.items().any { it.name == "grew.bin" } && app.transfers.uploads.value.isEmpty() }
        val sent = laptop.items().filter { it.name == "grew.bin" }
        assertEquals("once, whole", listOf(TestFiles.file.length()), sent.map { it.size })
        assertTrue("Beam's copy is gone", File(app.filesDir, "outgoing").listFiles().orEmpty().isEmpty())
        s.svc.destroy()
    }

    private fun startServer(dir: File, port: Int): Process {
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
            remove("BEAM_FAMILY_BACKUP_DIR")
        }
        val p = pb.start()
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
        return p
    }

    /**
     * (the review's M7) A shared file's access ends when the transfer service stops, so an upload that failed for want of
     * a connection then failed again ("Beam no longer has access to that file") at the retry, Resume or a restart. Now,
     * while it may still read it, Beam keeps a copy of its own, and the retry sends that.
     */
    @Test
    fun anUploadThatWaitsKeepsACopyOfItsOwn() {
        assumeTrue("Set BEAM_SERVER_JS", serverJs.isNotEmpty())
        val dir = java.nio.file.Files.createTempDirectory("beam-m7").toFile().also { data = it }
        val port = TestNet.freePort()
        server = startServer(dir, port)
        val base = "http://127.0.0.1:$port"
        val k = File(dir, "key").readText().trim()
        signIn(base, k)
        val laptop = TestNet.device(base, k, "M7 Laptop", "windows").also { it.me() }
        app.transfers.maxUploadFailures = 0
        app.transfers.lastingAccessForTest = false // a share: Android keeps no lasting permission for it
        val big = File.createTempFile("m7-share", ".bin").apply { deleteOnExit() }
        RandomAccessFile(big, "rw").use { it.setLength(96L * 1024 * 1024) }
        cleanups += { big.delete() }
        TestFiles.file = big
        val s = upload(laptop.deviceId, "shared video.bin")
        idleUntil("under way", 60_000) {
            val id = app.transfers.uploads.value.firstOrNull()?.serverId
            id != null && (app.transfers.uploads.value.first().sent > 0)
        }
        server!!.destroyForcibly().waitFor() // the connection goes
        idleUntil("waiting for a connection", 60_000) { app.transfers.uploads.value.singleOrNull()?.let { it.status == TransferManager.Status.FAILED && it.retryable } == true }
        val waiting = app.transfers.uploads.value.single()
        assertTrue("Beam's own copy", waiting.copy != null && File(waiting.copy!!).length() == big.length())
        s.svc.destroy()
        TestFiles.denied = true // the share's access is gone with the service

        server = startServer(dir, port)
        app.connection.restart()
        idleUntil("sent from the copy", 120_000) { background { laptop.items() }.any { it.name == "shared video.bin" && it.size == big.length() } }
        idleUntil("row gone") { app.transfers.uploads.value.isEmpty() }
        idleUntil("its copy gone") { File(app.filesDir, "outgoing").listFiles().orEmpty().isEmpty() }
    }
}
