package app.beam.android.core

import app.beam.android.data.Connection
import com.sun.net.httpserver.HttpServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.OutputStream
import java.net.InetSocketAddress
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Pure JVM tests of the client core (no server, no Android). */
class CoreTest {
    private class MemorySink : DownloadSink {
        var bytes = ByteArray(0)
        override fun length() = bytes.size.toLong()
        override fun open(offset: Long): OutputStream {
            bytes = bytes.copyOf(offset.toInt())
            return object : ByteArrayOutputStream() {
                override fun write(b: ByteArray, off: Int, len: Int) {
                    bytes += b.copyOfRange(off, off + len) // kept even if the connection drops next
                }
            }
        }
    }

    /** A file server whose connection drops after [perResponse] bytes, every time (flaky mobile data). */
    private fun flakyServer(data: ByteArray, perResponse: Int, requests: AtomicInteger): HttpServer {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/file/") { ex ->
            requests.incrementAndGet()
            val range = ex.requestHeaders.getFirst("Range")
            val start = range?.removePrefix("bytes=")?.substringBefore('-')?.toInt() ?: 0
            val len = data.size - start
            if (range != null) {
                ex.responseHeaders.add("Content-Range", "bytes $start-${data.size - 1}/${data.size}")
                ex.sendResponseHeaders(206, len.toLong())
            } else {
                ex.sendResponseHeaders(200, len.toLong())
            }
            if (perResponse > 0) {
                ex.responseBody.write(data, start, minOf(perResponse, len))
                ex.responseBody.flush()
            }
            if (perResponse < len) throw IOException("drop") else ex.close()
        }
        server.start()
        return server
    }

    @Test
    fun downloadsKeepGoingThroughManyDropsAsLongAsTheyMakeProgress() {
        val data = ByteArray(3 * 1024 * 1024) { (it % 251).toByte() }
        val requests = AtomicInteger()
        val server = flakyServer(data, 64 * 1024, requests)
        try {
            val api = BeamApi("http://127.0.0.1:${server.address.port}", "k", "coretestdevice1", "Core")
            val sink = MemorySink()
            Downloader(api, "x", data.size.toLong(), sink, maxFailures = 25, sleep = {}).run()
            assertTrue("needs far more than 25 reconnects", requests.get() > 40)
            assertTrue(sink.bytes.contentEquals(data))
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun downloadsGiveUpWhenNothingArrivesAtAll() {
        val requests = AtomicInteger()
        val server = flakyServer(ByteArray(100_000), 0, requests)
        try {
            val api = BeamApi("http://127.0.0.1:${server.address.port}", "k", "coretestdevice1", "Core")
            try {
                Downloader(api, "x", 100_000, MemorySink(), maxFailures = 5, sleep = {}).run()
                fail("expected it to give up")
            } catch (_: IOException) {
            }
            assertEquals(6, requests.get())
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun serversUnderAPathPrefixWork() {
        val api = BeamApi("https://nas.example/beam", "k", "coretestdevice1", "Core")
        assertEquals("https://nas.example/beam/api/me", api.url("/api/me").toString())
        assertEquals("https://nas.example/beam/api/file/abc?inline=", api.url("/api/file/abc", "inline" to "").toString())
        assertEquals("https://pc.tail1.ts.net/api/me", BeamApi("https://pc.tail1.ts.net", "k", "coretestdevice1", "Core").url("/api/me").toString())
        assertEquals("https://nas.example/beam", Pairing.parse("https://nas.example/beam/?key=K1")!!.baseUrl)
        assertEquals("https://pc.tail1.ts.net", Pairing.parse("https://pc.tail1.ts.net/?key=K1")!!.baseUrl)
        assertEquals(listOf("https://nas.local/beam", "http://nas.local:8765/beam"), Pairing.serverCandidates("nas.local/beam"))
        val update = AppUpdate("1.2.0", 4, "/download/android", 1, "00")
        assertEquals("https://nas.example/beam/download/android", Updates.resolve(api, update).toString())
        try {
            Updates.resolve(api, update.copy(url = "https://evil.example/beam.apk"))
            fail("an update link to another host must be refused")
        } catch (_: IOException) {
        }
    }

    @Test
    fun proofIsAnHmacOverTheServerIdAndNonce() {
        val secret = "the-device-token"
        val key = java.security.MessageDigest.getInstance("SHA-256").digest(secret.toByteArray())
        val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key, "HmacSHA256")) }
        val expected = mac.doFinal("server123:nonce456".toByteArray()).joinToString("") { "%02x".format(it) }
        assertEquals(expected, Proof.expected(secret, "server123", "nonce456"))
        assertTrue(Proof.matches(secret, "server123", "nonce456", expected.uppercase()))
        assertFalse(Proof.matches("another-secret", "server123", "nonce456", expected))
        assertFalse(Proof.matches(secret, "server123", "nonce456", null))
        assertEquals(16, Proof.tokenId(secret).length)
    }

    @Test
    fun reconnectsQuicklyThenSlowlyWhileTheServerIsGone() {
        val delays = (1..16).map { Connection.delayFor(it) }
        assertEquals(1_000L, delays[0])
        assertEquals(16_000L, delays[4])
        assertTrue(delays.subList(5, 11).all { it == 30_000L })
        assertTrue(delays[11] in 5 * 60_000L..5 * 60_000L + 30_000)
        assertTrue(delays.drop(13).all { it in 15 * 60_000L..15 * 60_000L + 30_000 })
    }

    @Test
    fun knowsWhichAddressesNeedTailscale() {
        assertTrue(Pairing.needsTailscale("https://robin-desktop.tail9876.ts.net"))
        assertTrue(Pairing.needsTailscale("http://100.70.248.8:8765"))
        assertFalse(Pairing.needsTailscale("http://192.168.1.32:8765"))
        assertFalse(Pairing.needsTailscale("https://beam.example.com"))
        assertEquals("https://beam.tail9876.ts.net", Pairing.tailnetBeam("https://robin-desktop.tail9876.ts.net"))
        assertNull(Pairing.tailnetBeam("https://beam.tail9876.ts.net"))
        assertNull(Pairing.tailnetBeam("http://192.168.1.32:8765"))
    }

    @Test
    fun itemsSurviveTheTripToDiskAndBack() {
        val item = Item("id1", "text", "hello", true, 70_000, null, 0, null, "a1", "Desk", listOf("b1"), mapOf("b1" to 5L), 42, pinned = true)
        assertEquals(item, Item.parse(item.toJson()))
        val file = Item("id2", "file", null, false, 0, "a b.pdf", 1234, "application/pdf", null, "curl", emptyList(), emptyMap(), 43)
        assertEquals(file, Item.parse(file.toJson()))
    }

    @Test
    fun serverInfoOfOlderServersHasNoV3Features() {
        val v2 = ServerInfo.parse(org.json.JSONObject("""{"version":"1.0.0","retentionDays":14,"maxUpload":4294967296}"""))
        assertEquals(2, v2.api)
        assertFalse(v2.has("forward"))
        val v3 = ServerInfo.parse(org.json.JSONObject("""{"version":"1.2.0","api":3,"storage":{"used":1024,"free":2048}}"""))
        assertTrue(v3.has("forward"))
        assertEquals(1024L, v3.storageUsed)
        val listed = ServerInfo.parse(org.json.JSONObject("""{"version":"1.2.0","api":3,"features":["pin"]}"""))
        assertTrue(listed.has("pin"))
        assertFalse(listed.has("forward"))
    }

    @Test
    fun sendsTheProfileOnEveryRequestWhenItHasOne() {
        val withProfile = BeamApi("http://127.0.0.1:1", "k", "device0001", "Pixel", "android", profile = "a1b2c3d4e5f60718")
        assertEquals("a1b2c3d4e5f60718", withProfile.request(withProfile.url("/api/me")).build().header("X-Beam-Profile"))
        assertEquals("a1b2c3d4e5f60718", withProfile.eventsCall(1000).request().header("X-Beam-Profile"))
        val without = BeamApi("http://127.0.0.1:1", "k", "device0001", "Pixel", "android")
        assertEquals(null, without.request(without.url("/api/me")).build().header("X-Beam-Profile"))
    }

    @Test
    fun sendsTheAppVersionOnEveryRequestAndTheEventStream() {
        val api = BeamApi("http://127.0.0.1:1", "k", "device0001", "Pixel", "android")
        assertEquals(app.beam.android.BuildConfig.VERSION_NAME, api.request(api.url("/api/me")).build().header("X-Beam-App-Version"))
        val events = api.eventsCall(1000).request()
        assertEquals(app.beam.android.BuildConfig.VERSION_NAME, events.header("X-Beam-App-Version"))
        assertEquals(app.beam.android.BuildConfig.VERSION_NAME, events.url.queryParameter("version"))

        // Sign-in calls too (before the device has a key).
        val seen = java.util.concurrent.atomic.AtomicReference<String?>()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/hello") { ex ->
            seen.set(ex.requestHeaders.getFirst("X-Beam-App-Version"))
            val body = "{\"beam\":true,\"version\":\"1.2.1\",\"serverId\":\"s1\",\"api\":3}".toByteArray()
            ex.sendResponseHeaders(200, body.size.toLong())
            ex.responseBody.use { it.write(body) }
        }
        server.start()
        try {
            SignInClient("http://127.0.0.1:${server.address.port}").hello()
            assertEquals(app.beam.android.BuildConfig.VERSION_NAME, seen.get())
        } finally {
            server.stop(0)
        }
    }

    @Test
    fun readsDeviceStatusCapabilitiesAndAlerts() {
        val d = Device.parse(org.json.JSONObject(
            """{"id":"desk00000001","name":"Desk","platform":"windows","online":false,"lastSeen":5,"appVersion":"1.3.0",
               "status":{"battery":{"level":85,"charging":true},"storage":{"free":1073741824,"total":2147483648},"os":"Windows 11 Pro","at":7},
               "tailscale":{"name":"desk","dns":"desk.tail1.ts.net.","ip":"100.64.0.9"},"can":{"ring":true,"wake":true,"remoteDesktop":true}}""",
        ))
        assertEquals(85, d.status!!.batteryLevel)
        assertEquals(true, d.status!!.charging)
        assertEquals(1073741824L, d.status!!.storageFree)
        assertEquals("Windows 11 Pro", d.status!!.os)
        assertEquals(DeviceCan(ring = true, wake = true, remoteDesktop = true), d.can)
        assertEquals("desk.tail1.ts.net", d.tailscaleDns)
        assertEquals("1.3.0", d.appVersion)
        assertEquals("85% charging · 1.0 GB free", Format.deviceStatus(d.status))
        // The saved copy keeps it all.
        assertEquals(d, Device.parse(d.toJson()))
        // Older servers: nothing of it.
        val old = Device.parse(org.json.JSONObject("""{"id":"x1234567","name":"Old","platform":"android","online":true,"lastSeen":1}"""))
        assertNull(old.status)
        assertEquals(DeviceCan(), old.can)
        // What this phone sends: only the fields the server takes.
        val body = DeviceStatus(42, false, 5L, 10L, "Android 16 · Pixel 9 Pro XL").toJson()
        assertEquals(setOf("battery", "storage", "os"), body.keys().asSequence().toSet())
        val alert = Alert.parse(org.json.JSONObject("""{"id":"a1","kind":"battery","device":"desk00000001","level":"warn","text":"Desk is at 9%","at":3}"""))
        assertEquals(Alert("a1", "battery", "desk00000001", "warn", "Desk is at 9%", 3), alert)
        assertNull(Alert.parse(org.json.JSONObject("""{"id":"a2","kind":"serverDisk","device":null,"level":"warn","text":"x","at":4}""")).device)
    }

    /** A fake upload endpoint: chunks of 1 MB, up to [maxChunk] with `big-chunks`; records every PUT's size. */
    private fun uploadServer(size: Long, maxChunk: Long, puts: MutableList<Long>): HttpServer {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        var offset = 0L
        server.createContext("/api/uploads") { ex ->
            val reply = if (ex.requestMethod == "POST") {
                ex.requestBody.readBytes()
                """{"id":"u1","name":"big.bin","size":$size,"offset":0,"chunkSize":${1 shl 20},"maxChunkSize":$maxChunk}"""
            } else {
                val n = ex.requestBody.readBytes().size.toLong()
                puts += n
                offset += n
                if (offset >= size) {
                    """{"done":true,"item":{"id":"u1","kind":"file","name":"big.bin","size":$size,"ts":1}}"""
                } else {
                    """{"offset":$offset,"done":false}"""
                }
            }
            val bytes = reply.toByteArray()
            ex.sendResponseHeaders(if (ex.requestMethod == "POST") 201 else 200, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        server.start()
        return server
    }

    private class MemorySource(override val size: Long) : UploadSource {
        override val name = "big.bin"
        override val mime = "application/octet-stream"
        override fun open(offset: Long) = java.io.ByteArrayInputStream(ByteArray((size - offset).toInt()))
    }

    @Test
    fun withBigChunksThePutsAreAsBigAsTheServerTakes() {
        val size = 40L shl 20
        for (big in listOf(false, true)) {
            val puts = java.util.concurrent.CopyOnWriteArrayList<Long>()
            val server = uploadServer(size, 16L shl 20, puts)
            try {
                val api = BeamApi("http://127.0.0.1:${server.address.port}", "k", "coretestdevice1", "Core")
                val item = Uploader(api, MemorySource(size), emptyList(), sleep = {}, bigChunks = big).run()
                assertEquals(size, item.size)
                if (big) {
                    // At least 64 MB each, but never more than the server takes (16 MB here).
                    assertEquals(listOf(16L shl 20, 16L shl 20, 8L shl 20), puts.toList())
                } else {
                    assertTrue("the server's chunk size without the feature: $puts", puts.size == 40 && puts.all { it == 1L shl 20 })
                }
            } finally {
                server.stop(0)
            }
        }
    }

    @Test
    fun bigChunksCarryAboutFourSecondsEach() {
        val mb = 1L shl 20
        val max = 10_240 * mb
        // 64 MB in a second: 256 MB next.
        assertEquals(256 * mb, Uploader.nextChunk(64 * mb, 1_000, 64 * mb, max))
        // Slow mobile data (4 MB/s): never below 64 MB.
        assertEquals(64 * mb, Uploader.nextChunk(64 * mb, 16_000, 64 * mb, max))
        // Never above what the server takes, and the server's size without the feature (min == max).
        assertEquals(100 * mb, Uploader.nextChunk(256 * mb, 100, 64 * mb, 100 * mb))
        assertEquals(8 * mb, Uploader.nextChunk(8 * mb, 10, 8 * mb, 8 * mb))
    }

    /**
     * A stream opened with a short heartbeat that then gets a longer one (the app switched it to the background)
     * must wait for the longer one, over HTTP/1.1 too: OkHttp's socket timeout there is fixed at the start.
     */
    @Test
    fun anOpenStreamsHeartbeatCanGrow() {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/events") { ex ->
            ex.responseHeaders.add("Content-Type", "text/event-stream")
            ex.sendResponseHeaders(200, 0)
            val out = ex.responseBody
            out.write("event: hello\ndata: {}\n\n".toByteArray())
            out.flush()
            Thread.sleep(2_500) // longer than the first heartbeat (1 s), shorter than the second (10 s)
            out.write("event: item\ndata: {}\n\n".toByteArray())
            out.flush()
            ex.close()
        }
        server.start()
        try {
            val api = BeamApi("http://127.0.0.1:${server.address.port}", "k", "coretestdevice1", "Core")
            val stream = EventStream(api, heartbeatMs = 1_000)
            val events = mutableListOf<String>()
            stream.run(object : EventStream.Listener {
                override fun onOpen() {}
                override fun onEvent(event: String, data: String) {
                    events += event
                    if (event == "hello") stream.setHeartbeat(10_000)
                }
            })
            assertEquals(listOf("hello", "item"), events)
        } finally {
            server.stop(0)
        }
    }
}
