package app.beam.android.core

import okhttp3.OkHttpClient
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlin.random.Random

/**
 * The 1.4 protocol (docs/API.md) against a real scratch server, from the client core's side: background
 * streams and pokes (P1), delta sync (P2), compressed replies (P3), downloading a file that's still arriving
 * (P4) and big upload chunks (P5). Each test runs only when the server lists its feature.
 *
 *   BEAM_TEST_URL=http://127.0.0.1:8811 BEAM_TEST_KEY=<key> ./gradlew testDebugUnitTest --tests '*ProtocolV14Test'
 */
class ProtocolV14Test {
    private val url = System.getProperty("beam.url").orEmpty()
    private val key = System.getProperty("beam.key").orEmpty()
    private lateinit var info: ServerInfo

    @Before
    fun requireServer() {
        assumeTrue("Set BEAM_TEST_URL and BEAM_TEST_KEY to run the server tests", url.isNotEmpty() && key.isNotEmpty())
        info = TestNet.device(url, key, "Probe").info()
    }

    private fun needs(feature: String) = assumeTrue("the server doesn't list $feature", info.lists(feature))

    /** An open event stream whose events land in a queue. */
    private class Listening(val api: BeamApi, mode: String?) : AutoCloseable {
        val events = LinkedBlockingQueue<Pair<String, JSONObject>>()
        val stream = EventStream(api, EventStream.deadAfterMs(180), mode)
        init {
            thread(isDaemon = true) {
                runCatching {
                    stream.run(object : EventStream.Listener {
                        override fun onOpen() {}
                        override fun onEvent(event: String, data: String) {
                            events.put(event to (runCatching { JSONObject(data) }.getOrNull() ?: JSONObject()))
                        }
                    })
                }
            }
        }

        /** The next event named [name] within [ms], skipping others (returned in [skipped]). */
        fun next(name: String, ms: Long = 5_000, skipped: MutableList<String>? = null): JSONObject? {
            val deadline = System.currentTimeMillis() + ms
            while (true) {
                val left = deadline - System.currentTimeMillis()
                if (left <= 0) return null
                val (event, data) = events.poll(left, TimeUnit.MILLISECONDS) ?: return null
                if (event == name) return data
                skipped?.add(event)
            }
        }

        override fun close() = stream.cancel()
    }

    @Test
    fun backgroundStreamsHoldStatusNewsUntilAPoke() {
        needs("stream-modes")
        val phone = TestNet.device(url, key, "Background Phone")
        val pc = TestNet.device(url, key, "Busy PC", "windows")
        pc.me()
        Listening(phone, "background").use { s ->
            val hello = s.next("hello")!!
            assertEquals("background", hello.getString("mode"))
            assertEquals(180, hello.getInt("ping"))
            val id = hello.getString("stream")
            s.events.clear()

            // Status news from another device waits for the heartbeat…
            pc.putStatus(DeviceStatus(55, false, 100L shl 30, 500L shl 30, "Windows 11 Pro"))
            assertEquals("held", null, s.next("devices", 1_500))
            // …but a message for this phone goes out at once, after what was held (order kept).
            val skipped = mutableListOf<String>()
            val sent = pc.sendText("for the phone", listOf(phone.deviceId))
            assertEquals(sent.id, s.next("item", 3_000, skipped)?.getString("id"))
            assertTrue("held events first: $skipped", "devices" in skipped)

            // A poke switches the same stream to the foreground and answers on it.
            val poke = phone.poke(id, "foreground")
            assertTrue(poke.alive)
            assertEquals("foreground", poke.mode)
            assertEquals(25, poke.ping)
            assertEquals(true, s.next("ping", 3_000)?.optBoolean("poke"))
            pc.putStatus(DeviceStatus(40, false, 100L shl 30, 500L shl 30, "Windows 11 Pro"))
            assertTrue("foreground: at once", s.next("devices", 8_000) != null)

            // Somebody else's stream, or one that's gone: reconnect.
            assertFalse(pc.poke(id, "background").alive)
            assertFalse(phone.poke("no-such-stream", "background").alive)
        }
    }

    @Test
    fun aDeltaBringsTheOldListUpToDate() {
        needs("items-since")
        val phone = TestNet.device(url, key, "Delta Phone")
        val pc = TestNet.device(url, key, "Delta PC", "windows")
        phone.me()
        pc.me()
        val first = pc.sendText("first", listOf(phone.deviceId))
        val second = pc.sendText("second", listOf(phone.deviceId))
        val before = phone.itemsPage()
        assertTrue(before.cursor != null)

        // Meanwhile: a new one, a pin, a delete, a delivery.
        val third = pc.sendText("third", listOf(phone.deviceId))
        phone.setPinned(second.id, true)
        pc.deleteItem(first.id)
        phone.ack(third.id)

        val delta = phone.itemsPage(before.cursor)
        assertTrue("a delta", delta.delta)
        assertTrue(first.id in delta.deleted)
        val applied = (before.items.filter { it.id !in delta.deleted && delta.items.none { d -> d.id == it.id } } + delta.items).sortedByDescending { it.ts }
        val now = phone.itemsPage()
        assertEquals(now.items.map { it.id }, applied.map { it.id })
        assertEquals(now.items.map { it.pinned to it.delivered.keys }, applied.map { it.pinned to it.delivered.keys })
        assertTrue(applied.first { it.id == second.id }.pinned)
        assertTrue("small: ${delta.items.size} of ${now.items.size}", delta.items.size <= 3)

        // A cursor it can't answer exactly: the whole list.
        val foreign = phone.itemsPage("not-a-cursor")
        assertFalse(foreign.delta)
        assertEquals(now.items.map { it.id }, foreign.items.map { it.id })
    }

    @Test
    fun listsComeCompressed() {
        needs("gzip")
        val encodings = CopyOnWriteArrayList<String>()
        val ip = TestNet.tailscaleIp()
        val client: OkHttpClient = TestNet.client(ip).newBuilder()
            .addNetworkInterceptor { c -> c.proceed(c.request()).also { encodings += c.request().url.encodedPath + " " + (it.header("Content-Encoding") ?: "identity") } }
            .build()
        val phone = BeamApi(url, key, TestNet.newId(), "Gzip Phone", "android", client)
        phone.me()
        TestNet.device(url, key, "Gzip PC", "windows").sendText("x".repeat(4_000), listOf(phone.deviceId))
        phone.itemsPage()
        assertTrue("$encodings", "/api/items gzip" in encodings)
    }

    /** A source that hands out its bytes slowly: [pauseMs] after every [step] bytes. */
    private class SlowSource(private val data: ByteArray, private val step: Int, private val pauseMs: Long) : UploadSource {
        override val name = "arriving.bin"
        override val size = data.size.toLong()
        override val mime = "application/octet-stream"
        override fun open(offset: Long): InputStream = object : InputStream() {
            private val inner = ByteArrayInputStream(data, offset.toInt(), data.size - offset.toInt())
            private var sinceSleep = 0
            override fun read(): Int = inner.read()
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                if (sinceSleep >= step) {
                    Thread.sleep(pauseMs)
                    sinceSleep = 0
                }
                val n = inner.read(b, off, minOf(len, step - sinceSleep))
                if (n > 0) sinceSleep += n
                return n
            }
        }
    }

    private class MemorySink : DownloadSink {
        val out = java.io.ByteArrayOutputStream()
        override fun length() = out.size().toLong()
        override fun open(offset: Long): java.io.OutputStream {
            val kept = out.toByteArray().copyOf(offset.toInt())
            out.reset()
            out.write(kept)
            return out
        }
    }

    @Test
    fun aFileStillArrivingCanBeDownloaded() {
        needs("live-download")
        val pc = TestNet.device(url, key, "Sending PC", "windows")
        val phone = TestNet.device(url, key, "Receiving Phone")
        phone.me()
        val data = Random(11).nextBytes(3 * 1024 * 1024)
        Listening(phone, "background").use { s ->
            s.next("hello")
            var uploaded: Item? = null
            val up = thread { uploaded = Uploader(pc, SlowSource(data, 256 * 1024, 150), listOf(phone.deviceId), sleep = { Thread.sleep(it) }).run() }
            // The first `upload` event reaches even a background stream at once: the download starts on it.
            val first = s.next("upload", 5_000)!!
            val id = first.getString("id")
            assertEquals(data.size.toLong(), first.getLong("size"))
            val sink = MemorySink()
            val t0 = System.currentTimeMillis()
            Downloader(phone, id, data.size.toLong(), sink, sleep = { Thread.sleep(it) }).run()
            val took = System.currentTimeMillis() - t0
            up.join(30_000)
            assertArrayEquals(data, sink.out.toByteArray())
            assertEquals(id, uploaded?.id)
            assertTrue("the download trailed the upload ($took ms)", took > 1_000)
        }
    }

    @Test
    fun bigChunksNeedFewerRoundTrips() {
        needs("big-chunks")
        val size = 48L shl 20
        val data = Random(5).nextBytes(size.toInt())
        val source = object : UploadSource {
            override val name = "big.bin"
            override val size = size
            override val mime = "application/octet-stream"
            override fun open(offset: Long): InputStream = ByteArrayInputStream(data, offset.toInt(), data.size - offset.toInt())
        }
        val counts = listOf(false, true).map { big ->
            val puts = CopyOnWriteArrayList<Long>()
            val client = TestNet.client().newBuilder().addInterceptor { c ->
                if (c.request().method == "PUT") puts += c.request().body?.contentLength() ?: -1
                c.proceed(c.request())
            }.build()
            val pc = BeamApi(url, key, TestNet.newId(), "Chunky PC", "windows", client)
            val item = Uploader(pc, source, emptyList(), sleep = { Thread.sleep(it) }, bigChunks = big).run()
            assertEquals(size, item.size)
            assertEquals(size, puts.sum())
            pc.deleteItem(item.id)
            puts.size
        }
        assertEquals("8 MB chunks without the feature", 6, counts[0])
        assertEquals("at least 64 MB each with it: one PUT for 48 MB", 1, counts[1])
    }
}
