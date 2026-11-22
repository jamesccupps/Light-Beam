package app.beam.android.core

import com.sun.net.httpserver.HttpServer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.net.InetSocketAddress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.random.Random

/**
 * (1.20.2, the 2026-11-21 audit's finding 17) A file that can't be opened or read any more (deleted or moved before it
 * was read, a cloud file its app can't supply) is not a lost connection: it was retried 25 times over about ten
 * minutes ("Connection lost, retrying…") and held every upload behind it. Now it's tried once more, then the upload
 * stops with [SourceUnreadableException]; a single hiccup still goes through byte for byte.
 */
class UnreadableSource1202Test {
    private val size = 3 * MB

    private class Server(val size: Long) : AutoCloseable {
        /** PUTs at the second chunk answered 503 (the server busy: not the file), this many times. */
        @Volatile var busy = 0
        val stored = ByteArrayOutputStream()
        val requests = CopyOnWriteArrayList<String>()
        private val http = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val url get() = "http://127.0.0.1:${http.address.port}"

        init {
            http.createContext("/api/uploads") { ex ->
                requests += ex.requestMethod
                val reply: Pair<Int, String> = when (ex.requestMethod) {
                    "POST" -> {
                        ex.requestBody.readBytes()
                        201 to """{"id":"u1","name":"x.bin","size":$size,"offset":0,"chunkSize":$MB,"maxChunkSize":$MB}"""
                    }
                    "GET" -> 200 to """{"id":"u1","name":"x.bin","size":$size,"offset":${synchronized(stored) { stored.size() }},"chunkSize":$MB}"""
                    "DELETE" -> 200 to "{}"
                    else -> {
                        val offset = ex.requestURI.query.substringAfter("offset=").toLong()
                        val body = try {
                            ex.requestBody.readBytes()
                        } catch (_: IOException) {
                            null // the phone stopped in the middle of the chunk
                        }
                        synchronized(stored) {
                            when {
                                busy > 0 && offset == MB && body != null -> {
                                    busy--
                                    503 to """{"error":"Busy"}"""
                                }
                                body == null || body.size.toLong() != minOf(MB, size - offset) -> 400 to """{"error":"Cut short","offset":${stored.size()}}"""
                                offset != stored.size().toLong() -> 409 to """{"error":"Wrong offset","offset":${stored.size()}}"""
                                else -> {
                                    stored.write(body)
                                    if (stored.size().toLong() >= size) 201 to """{"done":true,"item":{"id":"u1","kind":"file","name":"x.bin","size":$size,"ts":1}}"""
                                    else 200 to """{"offset":${stored.size()},"done":false}"""
                                }
                            }
                        }
                    }
                }
                val bytes = reply.second.toByteArray()
                try {
                    ex.sendResponseHeaders(reply.first, bytes.size.toLong())
                    ex.responseBody.use { it.write(bytes) }
                } catch (_: IOException) {
                }
            }
            http.start()
        }

        override fun close() = http.stop(0)
    }

    /** A source whose opens (counted) fail as [failOpen] says, and whose stream fails at a place in the file ([failRead]: by open). */
    private class Source(val data: ByteArray, val failOpen: (Int) -> Boolean, val failRead: (Int) -> Long?) : UploadSource {
        val opens = AtomicInteger()
        override val name = "x.bin"
        override val size = data.size.toLong()
        override val mime = "application/octet-stream"
        override fun open(offset: Long): InputStream {
            val n = opens.incrementAndGet()
            if (failOpen(n)) throw FileNotFoundException("/storage/emulated/0/Download/x.bin: open failed: ENOENT (No such file or directory)")
            val failAfter = failRead(n)?.let { it - offset }
            val inner = data.inputStream().also { it.skip(offset) }
            return if (failAfter == null) inner else object : InputStream() {
                var read = 0L
                override fun read(): Int {
                    if (read >= failAfter) throw IOException("read failed: EIO (I/O error)")
                    return inner.read().also { if (it >= 0) read++ }
                }
                override fun read(b: ByteArray, off: Int, len: Int): Int {
                    if (read >= failAfter) throw IOException("read failed: EIO (I/O error)")
                    val n2 = inner.read(b, off, minOf(len.toLong(), failAfter - read).toInt().coerceAtLeast(1))
                    if (n2 > 0) read += n2
                    return n2
                }
            }
        }
    }

    private fun send(server: Server, source: Source, retries: MutableList<String>): Result<Item> {
        val api = BeamApi(server.url, "k", "unreadable0001", "Unreadable")
        val t0 = System.nanoTime()
        val r = runCatching {
            Uploader(api, source, emptyList(), sleep = {}, listener = object : Uploader.Listener {
                override fun onRetry(attempt: Int, error: Throwable, delayMs: Long) { retries += error.toString() }
            }).run()
        }
        println("opens=${source.opens.get()} requests=${server.requests} retries=$retries in ${(System.nanoTime() - t0) / 1_000_000} ms: $r")
        return r
    }

    @Test
    fun aFileThatIsGoneStopsAtOnceNotAsALostConnection() {
        Server(size).use { server ->
            val retries = CopyOnWriteArrayList<String>()
            val source = Source(Random(1).nextBytes(size.toInt()), failOpen = { true }, failRead = { null })
            val r = send(server, source, retries)
            val e = r.exceptionOrNull()
            assertTrue("stops as the file's failure (${e})", e is SourceUnreadableException)
            assertEquals("Can't read this file any more.", Format.error(e!!))
            assertEquals("opened twice (once more after a second), not 26 times", 2, source.opens.get())
            assertTrue("never \"Connection lost, retrying…\" ($retries)", retries.isEmpty())
        }
    }

    @Test
    fun aFileThatFailsInTheMiddleOfAChunkStopsToo() {
        Server(size).use { server ->
            val retries = CopyOnWriteArrayList<String>()
            // The first chunk goes; then every stream fails 100 KB into the second chunk (the same place in the file)
            val source = Source(Random(2).nextBytes(size.toInt()), failOpen = { false }, failRead = { MB + 100 * 1024 })
            val r = send(server, source, retries)
            assertTrue("stops as the file's failure (${r.exceptionOrNull()})", r.exceptionOrNull() is SourceUnreadableException)
            assertTrue("never \"Connection lost, retrying…\" ($retries)", retries.isEmpty())
            assertEquals("the first chunk is on the server", MB, server.stored.size().toLong())
        }
    }

    @Test
    fun oneHiccupStillGoesThroughByteForByte() {
        Server(size).use { server ->
            val retries = CopyOnWriteArrayList<String>()
            val data = Random(3).nextBytes(size.toInt())
            // The first stream fails 300 KB into the second chunk; the next one reads to the end
            val source = Source(data, failOpen = { false }, failRead = { n -> if (n == 1) MB + 300 * 1024 else null })
            val r = send(server, source, retries)
            val item = r.getOrElse { fail("should have been sent: $it"); return }
            assertEquals(size, item.size)
            assertArrayEquals("byte for byte", data, server.stored.toByteArray())
            assertTrue("opened again after the hiccup", source.opens.get() >= 2)
            assertTrue("never \"Connection lost, retrying…\" ($retries)", retries.isEmpty())
        }
    }

    @Test
    fun theServersFailuresAreStillRetriedAsBefore() {
        Server(size).use { server ->
            val retries = CopyOnWriteArrayList<String>()
            val data = Random(4).nextBytes(size.toInt())
            val api = BeamApi(server.url, "k", "unreadable0002", "Unreadable")
            // The server, not the file: the second chunk is answered "busy" twice before it goes
            server.busy = 2
            val source = Source(data, failOpen = { false }, failRead = { null })
            val item = Uploader(api, source, emptyList(), sleep = {}, listener = object : Uploader.Listener {
                override fun onRetry(attempt: Int, error: Throwable, delayMs: Long) { retries += error.toString() }
            }).run()
            assertEquals(size, item.size)
            assertArrayEquals(data, server.stored.toByteArray())
            assertEquals("retried as before (not the file's failure), twice", 2, retries.size)
        }
    }

    private companion object {
        const val MB = 1L shl 20
    }
}
