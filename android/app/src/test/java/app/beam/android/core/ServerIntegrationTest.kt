package app.beam.android.core

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runners.MethodSorters
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlin.random.Random

/**
 * Exercises the real protocol against a scratch Beam server:
 *   BEAM_HOST=127.0.0.1 BEAM_PORT=8801 BEAM_DATA=<tmp> node server.js
 *   BEAM_TEST_URL=http://127.0.0.1:8801 BEAM_TEST_KEY=<tmp>/key ./gradlew testDebugUnitTest
 * Skipped when those variables aren't set.
 */
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class ServerIntegrationTest {
    private val url = System.getProperty("beam.url").orEmpty()
    private val key = System.getProperty("beam.key").orEmpty()

    @Before
    fun requireServer() {
        assumeTrue("Set BEAM_TEST_URL and BEAM_TEST_KEY to run the server tests", url.isNotEmpty() && key.isNotEmpty())
    }

    private fun newId() = UUID.randomUUID().toString().replace("-", "")

    /** Every client is its own machine (see [TestNet]); pass [ip] to put several on one machine. */
    private fun client(name: String, platform: String = "android", ip: String = TestNet.tailscaleIp()) =
        TestNet.device(url, key, name, platform, ip = ip)
    private val fastSleep: (Long) -> Unit = { Thread.sleep(minOf(it, 300)) }

    @Test
    fun a_pairingCheckAcceptsKeyAndRejectsBadKey() {
        assertTrue(client("Check").me())
        try {
            BeamApi(url, "not-the-key", newId(), "Intruder").me()
            fail("expected 401")
        } catch (e: BeamException) {
            assertEquals(401, e.status)
        }
        val link = Pairing.parse("$url/?key=${encodeURIComponent(key)}")
        assertNotNull(link)
        assertEquals(url, link!!.baseUrl)
        assertEquals(key, link.key)
    }

    @Test
    fun b_registersDeviceWithUnicodeName() {
        val name = "Jämes’ Pixel ✓ 10"
        val a = client(name)
        val result = a.devices()
        assertEquals(a.deviceId, result.you)
        val me = result.devices.first { it.id == a.deviceId }
        assertEquals(name, me.name)
        assertEquals("android", me.platform)
    }

    @Test
    fun c_sendsTextToOneDeviceAndAcks() {
        val a = client("Phone A")
        val b = client("Desktop B", "windows")
        b.me() // register B so it can be targeted
        val item = a.sendText("hello B", listOf(b.deviceId))
        assertEquals(listOf(b.deviceId), item.to)
        assertEquals(a.deviceId, item.from)
        assertTrue(item.isFor(b.deviceId))
        assertFalse(item.isFor(a.deviceId))
        assertTrue(b.items().any { it.id == item.id })

        // Conversation placement on both sides.
        assertEquals(setOf(a.deviceId), Conversations.keysOf(item, b.deviceId, emptyMap()))
        assertEquals(setOf(b.deviceId), Conversations.keysOf(item, a.deviceId, emptyMap()))

        val delivered = b.ack(item.id)
        assertTrue(b.deviceId in delivered)
        assertTrue(b.deviceId in a.item(item.id).delivered)

        // Broadcasts go to "All devices".
        val all = a.sendText("hello everyone", emptyList())
        assertTrue(all.to.isEmpty())
        assertEquals(setOf(Conversations.ALL), Conversations.keysOf(all, b.deviceId, emptyMap()))
    }

    @Test
    fun d_unknownTargetIsRejected() {
        try {
            client("Lonely").sendText("anyone?", listOf("nosuchdevice123"))
            fail("expected 400")
        } catch (e: BeamException) {
            assertEquals(400, e.status)
        }
    }

    @Test
    fun e_eventStreamDeliversItemsReceiptsAndDeletes() {
        val a = client("Sender")
        val b = client("Receiver")
        val events = LinkedBlockingQueue<Pair<String, String>>()
        val opened = CountDownLatch(1)
        val stream = EventStream(b)
        val t = thread {
            try {
                stream.run(object : EventStream.Listener {
                    override fun onOpen() = opened.countDown()
                    override fun onEvent(event: String, data: String) = events.put(event to data)
                })
            } catch (_: IOException) {
            }
        }
        assertTrue("stream did not open", opened.await(10, TimeUnit.SECONDS))
        // Holding the stream open marks B online.
        awaitEvent(events) { e, d -> e == "devices" && JSONObject(d).getJSONArray("devices").let { arr -> (0 until arr.length()).any { arr.getJSONObject(it).let { o -> o.getString("id") == b.deviceId && o.getBoolean("online") } } } }

        val item = a.sendText("live!", listOf(b.deviceId))
        val got = Item.parse(JSONObject(awaitEvent(events) { e, d -> e == "item" && JSONObject(d).getString("id") == item.id }))
        assertEquals("live!", got.text)
        assertTrue(got.isFor(b.deviceId))

        b.ack(item.id)
        awaitEvent(events) { e, d -> e == "update" && JSONObject(d).let { it.getString("id") == item.id && it.getJSONObject("delivered").has(b.deviceId) } }

        a.deleteItem(item.id)
        awaitEvent(events) { e, d -> e == "delete" && JSONObject(d).getString("id") == item.id }

        stream.cancel()
        t.join(5000)
        assertFalse(t.isAlive)
    }

    @Test
    fun f_silentStreamTimesOut() {
        // Nothing but the initial events arrives within 1.5 s (pings come every 25 s), so the
        // heartbeat timeout must end the stream; the app then reconnects with backoff.
        val stream = EventStream(client("Sleepy"), heartbeatMs = 1500)
        val start = System.nanoTime()
        try {
            stream.run(object : EventStream.Listener {
                override fun onOpen() {}
                override fun onEvent(event: String, data: String) {}
            })
            fail("expected a timeout")
        } catch (e: IOException) {
            val seconds = (System.nanoTime() - start) / 1e9
            assertTrue("timed out after $seconds s", seconds in 1.4..15.0)
        }
    }

    @Test
    fun g_resumableUploadSurvivesDroppedConnectionAndDownloadResumes() {
        val a = client("Uploader")
        val b = client("Downloader")
        b.me()
        val size = 2L * UploadInfo.DEFAULT_CHUNK + 123_457 // three chunks
        val data = Random(42).nextBytes(size.toInt())
        // The source "drops the connection" once, in the middle of the second chunk.
        val source = FlakySource("big test.bin", data, failAt = UploadInfo.DEFAULT_CHUNK + 3_000_000)
        val retries = AtomicInteger()
        val progress = AtomicInteger()
        val uploader = Uploader(a, source, listOf(b.deviceId), object : Uploader.Listener {
            override fun onProgress(sent: Long, total: Long) { progress.incrementAndGet() }
            override fun onRetry(attempt: Int, error: Throwable, delayMs: Long) { retries.incrementAndGet(); println("upload retry #$attempt after ${error.javaClass.simpleName}: ${error.message} (offset ${(error as? BeamException)?.offset})") }
        }, sleep = fastSleep)
        val item = uploader.run()
        assertTrue("the simulated failure should have happened", source.failed)
        assertTrue("expected at least one retry", retries.get() >= 1)
        assertTrue(progress.get() > 3)
        assertEquals(size, item.size)
        assertEquals("big test.bin", item.name)
        assertEquals(listOf(b.deviceId), item.to)
        assertEquals(item.id, uploader.uploadId)

        // Download it on B, with the first attempt interrupted part-way; it must resume with Range.
        val sink = FlakyMemorySink(failAfter = 5_000_000)
        Downloader(b, item.id, item.size, sink, sleep = fastSleep).run()
        assertTrue(sink.failed)
        assertTrue("download should resume from where it stopped", sink.resumedFrom > 0)
        assertArrayEquals(sha256(data), sha256(sink.bytes()))
    }

    @Test
    fun h_zeroByteFileCompletesInOnePut() {
        val a = client("Zero")
        val item = Uploader(a, FlakySource("empty.txt", ByteArray(0), failAt = -1), emptyList(), sleep = fastSleep).run()
        assertEquals(0L, item.size)
        val sink = FlakyMemorySink(failAfter = Long.MAX_VALUE)
        Downloader(a, item.id, 0, sink, sleep = fastSleep).run()
        assertEquals(0, sink.bytes().size)
    }

    @Test
    fun i_wrongOffsetReturnsConflictWithActualOffset() {
        val a = client("Conflict")
        val info = a.createUpload("x.bin", 10, "application/octet-stream", emptyList())
        try {
            a.putChunk(info.id, 5, ChunkBody(ByteArrayInputStream(ByteArray(5)), 5) {}, CallHolder())
            fail("expected 409")
        } catch (e: BeamException) {
            assertEquals(409, e.status)
            assertEquals(0L, e.offset)
        }
        a.cancelUpload(info.id)
        try {
            a.uploadStatus(info.id)
            fail("expected 404 after cancel")
        } catch (e: BeamException) {
            assertEquals(404, e.status)
        }
    }

    @Test
    fun j_resumingAFinishedUploadReturnsItsItem() {
        // If the last chunk's response is lost, the session is gone (404) but the item exists
        // under the same id; the uploader must pick that up instead of uploading again.
        val a = client("Finisher")
        val data = Random(7).nextBytes(1000)
        val first = Uploader(a, FlakySource("done.bin", data, failAt = -1), emptyList(), sleep = fastSleep).run()
        val again = Uploader(a, FlakySource("done.bin", data, failAt = -1), emptyList(), sleep = fastSleep).run(resumeId = first.id)
        assertEquals(first.id, again.id)
    }

    @Test
    fun k_immediateResumeWaitsOutABusyServer() {
        // Resuming within milliseconds of a dropped chunk can find the server still "busy" with the
        // aborted request (409 with the old offset). The uploader must wait and resync, not give up.
        val a = client("Impatient")
        val size = UploadInfo.DEFAULT_CHUNK + 777
        val data = Random(3).nextBytes(size.toInt())
        val reasons = mutableListOf<String>()
        val item = Uploader(a, FlakySource("quick.bin", data, failAt = 4_000_000), emptyList(), object : Uploader.Listener {
            override fun onRetry(attempt: Int, error: Throwable, delayMs: Long) {
                reasons += "${(error as? BeamException)?.status ?: error.javaClass.simpleName}: ${error.message}"
            }
        }, sleep = { Thread.sleep(15) }).run()
        println("immediate-resume retries: $reasons")
        assertEquals(size, item.size)
        val sink = FlakyMemorySink(failAfter = Long.MAX_VALUE)
        Downloader(a, item.id, item.size, sink, sleep = fastSleep).run()
        assertArrayEquals(sha256(data), sha256(sink.bytes()))
    }

    @Test
    fun l_browserOnTheSameMachineIsMergedAndClientsAreToldToRefresh() {
        // The desktop app and its browser share one (Tailscale) machine; the observer is elsewhere.
        val deskMachine = TestNet.tailscaleIp()
        val observer = client("Observer phone")
        val events = LinkedBlockingQueue<Pair<String, String>>()
        val opened = CountDownLatch(1)
        val stream = EventStream(observer)
        val t = thread {
            try {
                stream.run(object : EventStream.Listener {
                    override fun onOpen() = opened.countDown()
                    override fun onEvent(event: String, data: String) = events.put(event to data)
                })
            } catch (_: IOException) {
            }
        }
        assertTrue(opened.await(10, TimeUnit.SECONDS))
        val desktopApp = client("Desk app", "windows", deskMachine)
        assertEquals(desktopApp.deviceId, desktopApp.you()) // an app keeps its own id
        val browser = client("Desk browser", "web", deskMachine)
        browser.me() // its first request: the server links it to the app on this machine
        awaitEvent(events) { e, _ -> e == "refresh" }
        assertEquals(desktopApp.deviceId, browser.you()) // the browser now is the app
        val sent = browser.sendText("typed in the browser", listOf(observer.deviceId))
        assertEquals(desktopApp.deviceId, sent.from)
        assertEquals(setOf(desktopApp.deviceId), Conversations.keysOf(sent, observer.deviceId, emptyMap()))
        stream.cancel()
        t.join(5000)
    }

    @Test
    fun m_passwordSignInForApps() {
        val admin = client("Admin phone")
        val signIn = SignInClient(url)
        assertTrue(signIn.hello().serverId!!.isNotBlank())
        try {
            admin.setPassword("short")
            fail("expected 400")
        } catch (e: BeamException) {
            assertEquals(400, e.status)
        }
        assertTrue(admin.setPassword("correct horse battery"))
        assertTrue(admin.info().passwordSet)
        try {
            signIn.loginWithPassword("wrong horse battery")
            fail("expected 403")
        } catch (e: BeamException) {
            assertEquals(403, e.status)
        }
        val newPhone = newId()
        val result = signIn.loginWithPassword("correct horse battery", newPhone)
        // API v3 hands out the device's own token (older servers: the master key).
        assertTrue(result.key == key || result.key.startsWith("bt_"))
        assertTrue(BeamApi(url, result.key, newPhone, "Password phone", "android", TestNet.client()).me())
        assertTrue(!result.server.isNullOrBlank())
        // Address typing: a bare host:port falls back from https to http.
        val found = ServerFinder.find(url.removePrefix("http://"))
        assertEquals(url, found.baseUrl)
        assertEquals(signIn.hello().serverId, found.hello.serverId)
        assertTrue(!admin.setPassword(""))
        assertTrue(!admin.info().passwordSet)
    }

    @Test
    fun n_signInWithAnotherDeviceIsApprovedOverTheLiveStream() {
        val approver = client("Trusted phone")
        val events = LinkedBlockingQueue<Pair<String, String>>()
        val opened = CountDownLatch(1)
        val stream = EventStream(approver)
        val t = thread {
            try {
                stream.run(object : EventStream.Listener {
                    override fun onOpen() = opened.countDown()
                    override fun onEvent(event: String, data: String) = events.put(event to data)
                })
            } catch (_: IOException) {
            }
        }
        assertTrue(opened.await(10, TimeUnit.SECONDS))

        val newDevice = SignInClient(url)
        val ticket = newDevice.createRequest("Work Laptop", "windows")
        assertTrue(Regex("^[A-Z0-9]{4}-[A-Z0-9]{4}$").matches(ticket.code))
        assertEquals(Pairing.normalizeCode(ticket.code), Pairing.approveCode(ticket.approveUrl)) // what the scanner reads
        val live = LoginRequest.parse(JSONObject(awaitEvent(events) { e, d -> e == "login-request" && JSONObject(d).getString("id") == ticket.id }))
        assertEquals("Work Laptop", live.name)
        assertTrue(live.where.isNotBlank())
        assertTrue(approver.loginRequests().any { it.id == ticket.id })
        assertEquals(ticket.id, approver.loginRequest(ticket.code.lowercase().replace("-", "")).id)
        assertEquals(PollResult.Pending, newDevice.poll(ticket, wait = false))

        // The new device long-polls while the trusted phone approves.
        var polled: PollResult? = null
        val poller = thread { polled = newDevice.poll(ticket, wait = true) }
        Thread.sleep(300)
        assertEquals("approved", approver.answerLoginRequest(ticket.code, approve = true))
        poller.join(25_000)
        val approved = polled as PollResult.Approved
        // API v3: the new device gets its own token (older servers: the key).
        assertTrue(approved.key, approved.key == key || approved.key.startsWith("bt_"))
        assertEquals("Trusted phone", approved.approvedBy)
        awaitEvent(events) { e, d -> e == "login-request-done" && JSONObject(d).getString("id") == ticket.id }
        assertEquals(PollResult.Expired, newDevice.poll(ticket, wait = false)) // the key is handed out once
        try {
            approver.answerLoginRequest(ticket.code, approve = true)
            fail("expected 404 for a settled code")
        } catch (e: BeamException) {
            assertTrue(e.status == 404 || e.status == 409)
        }
        stream.cancel()
        t.join(5000)
    }

    @Test
    fun o_signInRequestCanBeDenied() {
        val approver = client("Careful phone")
        val newDevice = SignInClient(url)
        val ticket = newDevice.createRequest("Stranger", "web")
        assertEquals("denied", approver.answerLoginRequest(ticket.code, approve = false))
        assertEquals(PollResult.Denied, newDevice.poll(ticket, wait = true))
        try {
            approver.loginRequest(ticket.code)
            fail("expected 409")
        } catch (e: BeamException) {
            assertEquals(409, e.status)
        }
    }

    @Test
    fun p_updatesAreOfferedDownloadedAndVerified() {
        val dist = System.getProperty("beam.dist").orEmpty()
        assumeTrue("Set BEAM_TEST_DIST to the scratch server's BEAM_DIST", dist.isNotEmpty())
        val apk = File(dist, "beam.apk")
        val sidecar = File(dist, "beam.apk.json")
        val bytes = Random(11).nextBytes(300_000)
        try {
            apk.writeBytes(bytes)
            sidecar.writeText("""{"version": "9.9.9", "versionCode": 999}""")
            val api = client("Updating phone")
            val update = Updates.available(api)!!
            assertEquals(999, update.versionCode)
            assertEquals("9.9.9", update.version)
            assertEquals(bytes.size.toLong(), update.size)
            assertTrue(update.isNewerThan(2))
            assertFalse(update.isNewerThan(999))
            assertFalse(update.copy(versionCode = 1).isNewerThan(2))

            val dest = File.createTempFile("beam-update", ".apk").apply { delete() }
            Updates.download(api, update, dest)
            assertArrayEquals(bytes, dest.readBytes())
            assertTrue(Updates.matches(dest, update))

            // A file that doesn't match the advertised hash is rejected and never kept.
            val tampered = update.copy(sha256 = "0".repeat(64))
            val bad = File.createTempFile("beam-bad", ".apk").apply { delete() }
            try {
                Updates.download(api, tampered, bad)
                fail("expected a verification failure")
            } catch (_: UpdateVerificationException) {
            }
            assertFalse(bad.exists())
            assertFalse(File(bad.path + ".part").exists())
            assertFalse(Updates.matches(dest, tampered))

            // Never send the key to another host.
            try {
                Updates.download(api, update.copy(url = "https://example.com/beam.apk"), bad)
                fail("expected the foreign link to be refused")
            } catch (e: IOException) {
                assertTrue(e.message!!.contains("away from your Beam server"))
            }
            dest.delete()
        } finally {
            apk.delete()
            sidecar.delete()
        }
        assertEquals(null, Updates.available(client("Updating phone 2"))) // nothing on offer without the files
    }

    // ---------------------------------------------------------------- helpers

    private fun awaitEvent(q: LinkedBlockingQueue<Pair<String, String>>, match: (String, String) -> Boolean): String {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            val (e, d) = q.poll(deadline - System.currentTimeMillis(), TimeUnit.MILLISECONDS) ?: break
            if (match(e, d)) return d
        }
        fail("event not received in time")
        throw AssertionError()
    }

    private fun sha256(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b)

    /** In-memory file that throws once when reading reaches [failAt]. */
    private class FlakySource(override val name: String, private val data: ByteArray, private val failAt: Long) : UploadSource {
        override val size = data.size.toLong()
        override val mime = "application/octet-stream"
        @Volatile var failed = false

        override fun open(offset: Long): InputStream = object : InputStream() {
            var pos = offset
            override fun read(): Int {
                val b = ByteArray(1)
                return if (read(b, 0, 1) < 0) -1 else b[0].toInt() and 0xff
            }
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                if (pos >= size) return -1
                var n = minOf(len.toLong(), size - pos).toInt()
                if (!failed && failAt in pos until pos + n) {
                    if (failAt == pos) { failed = true; throw IOException("simulated network drop") }
                    n = (failAt - pos).toInt()
                }
                System.arraycopy(data, pos.toInt(), b, off, n)
                pos += n
                return n
            }
        }
    }

    /** In-memory download target that fails once after [failAfter] bytes. */
    private class FlakyMemorySink(private val failAfter: Long) : DownloadSink {
        private var data = ByteArray(0)
        private var len = 0
        @Volatile var failed = false
        var resumedFrom = -1L

        fun bytes() = data.copyOf(len)
        override fun length() = len.toLong()
        override fun open(offset: Long): OutputStream {
            if (offset > 0) resumedFrom = offset
            len = offset.toInt()
            return object : OutputStream() {
                override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)
                override fun write(b: ByteArray, off: Int, n: Int) {
                    if (!failed && len + n > failAfter) { failed = true; throw IOException("simulated disconnect") }
                    if (len + n > data.size) data = data.copyOf(maxOf(len + n, data.size * 2))
                    System.arraycopy(b, off, data, len, n)
                    len += n
                }
            }
        }
    }

    @Test
    fun q_otherUserAccountsOnOneDeviceAreNeverMergedAsAReinstall() {
        val phoneIp = TestNet.tailscaleIp() // one phone: a personal and a work profile
        val observer = client("Observer")
        fun app(name: String, profile: String) = BeamApi(url, key, newId(), name, "android", TestNet.client(phoneIp), profile = profile)
        val personal = app("Pixel", "a1b2c3d4e5f60718").also { it.me() }
        val work = app("Pixel (work)", "0f1e2d3c4b5a6978").also { it.me() }
        val ids = observer.devices().devices.map { it.id }
        assertTrue("the personal profile's app is still its own device", personal.deviceId in ids)
        assertTrue(work.deviceId in ids)
        // Reinstalled in the personal profile: a new id with the same profile takes over the old one.
        val reinstalled = app("Pixel", "a1b2c3d4e5f60718").also { it.me() }
        val after = observer.devices().devices.map { it.id }
        assertFalse("merged into the reinstall", personal.deviceId in after)
        assertTrue(reinstalled.deviceId in after)
        assertTrue("the work profile stays apart", work.deviceId in after)
    }
}
