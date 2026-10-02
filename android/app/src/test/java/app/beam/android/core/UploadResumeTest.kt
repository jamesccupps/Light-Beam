package app.beam.android.core

import com.sun.net.httpserver.HttpServer
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.InetSocketAddress
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.random.Random

/**
 * After a server crash the 1.4 server resumes from its last durable offset, which can be lower than the offset its
 * last reply gave; the next PUT then gets `409 { offset }` with that lower offset. The uploader must go back, re-read
 * the source from there (a source that only reads forward is reopened) and end byte-exact. (From the 1.4.0 review.)
 */
class UploadResumeTest {
    @Test
    fun a409WithALowerOffsetGoesBackAndEndsByteExact() {
        val size = 5 * MB
        val data = Random(3).nextBytes(size.toInt())
        val stored = ByteArrayOutputStream()
        val puts = CopyOnWriteArrayList<String>()
        var crashed = false
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/api/uploads") { ex ->
            val reply: Pair<Int, String> = when (ex.requestMethod) {
                "POST" -> {
                    ex.requestBody.readBytes()
                    201 to """{"id":"u1","name":"x.bin","size":$size,"offset":0,"chunkSize":$MB,"maxChunkSize":${64 * MB}}"""
                }
                "GET" -> 200 to """{"id":"u1","name":"x.bin","size":$size,"offset":${stored.size()},"chunkSize":$MB}"""
                else -> {
                    val offset = ex.requestURI.query.substringAfter("offset=").toLong()
                    val body = ex.requestBody.readBytes()
                    puts += "PUT $offset (${body.size})"
                    if (!crashed && offset == 3 * MB) {
                        // "Crash": only 1.5 MB is durable; what the last reply promised (3 MB) is gone.
                        crashed = true
                        val keep = stored.toByteArray().copyOf((1.5 * MB).toInt())
                        stored.reset(); stored.write(keep)
                        409 to """{"error":"Wrong offset","offset":${stored.size()}}"""
                    } else if (offset != stored.size().toLong()) {
                        409 to """{"error":"Wrong offset","offset":${stored.size()}}"""
                    } else {
                        stored.write(body)
                        if (stored.size().toLong() >= size) 201 to """{"done":true,"item":{"id":"u1","kind":"file","name":"x.bin","size":$size,"ts":1}}"""
                        else 200 to """{"offset":${stored.size()},"done":false}"""
                    }
                }
            }
            val bytes = reply.second.toByteArray()
            ex.sendResponseHeaders(reply.first, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        server.start()
        try {
            val opens = CopyOnWriteArrayList<Long>()
            // A source that can only read forward (like a provider's pipe): every resync reopens it.
            val source = object : UploadSource {
                override val name = "x.bin"
                override val size = size
                override val mime = "application/octet-stream"
                override fun open(offset: Long): InputStream {
                    opens += offset
                    return data.inputStream().also { it.skip(offset) }
                }
            }
            val progress = CopyOnWriteArrayList<Long>()
            val api = BeamApi("http://127.0.0.1:${server.address.port}", "k", "resumedevice001", "Resume")
            val item = Uploader(api, source, emptyList(), sleep = {}, listener = object : Uploader.Listener {
                override fun onProgress(sent: Long, total: Long) { progress += sent }
            }).run()
            println("puts=$puts opens=$opens")
            assertEquals(size, item.size)
            assertArrayEquals("byte-exact after going back", data, stored.toByteArray())
            assertTrue("reopened at the lower offset", (1.5 * MB).toLong() in opens)
            assertTrue("progress went back to the durable offset", progress.contains((1.5 * MB).toLong()))
        } finally {
            server.stop(0)
        }
    }

    private companion object {
        const val MB = 1L shl 20
    }
}
