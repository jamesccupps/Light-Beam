package app.beam.android.core

import okhttp3.OkHttpClient
import okhttp3.Protocol
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.BeforeClass
import org.junit.Test
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * The event stream's heartbeat over HTTP/2, which `tailscale serve` speaks (the other tests use HTTP/1.1): a heartbeat
 * raised while the reader waits holds, and a silent stream still dies on time. Against `h2sse.js` (test resources),
 * started with Node; skipped where there is no `node`. (From the 1.4.0 review.)
 */
class Http2StreamTest {
    companion object {
        private var server: Process? = null
        private var url = ""

        @JvmStatic
        @BeforeClass
        fun startServer() {
            val script = Http2StreamTest::class.java.classLoader?.getResource("h2sse.js")?.let { File(it.toURI()) } ?: return
            val port = TestNet.freePort()
            val p = try {
                ProcessBuilder("node", script.path, port.toString()).redirectErrorStream(true).start()
            } catch (_: Exception) {
                return // no Node here
            }
            val ready = p.inputStream.bufferedReader().let { r ->
                val deadline = System.currentTimeMillis() + 10_000
                var line: String? = null
                while (System.currentTimeMillis() < deadline) {
                    line = r.readLine() ?: break
                    if ("h2c SSE on" in line) break
                }
                line?.contains("h2c SSE on") == true
            }
            if (!ready) {
                p.destroy()
                return
            }
            // Keep reading its log, or it could block on a full pipe.
            Thread { runCatching { p.inputStream.copyTo(java.io.OutputStream.nullOutputStream()) } }.apply { isDaemon = true }.start()
            server = p
            url = "http://127.0.0.1:$port"
        }

        @JvmStatic
        @AfterClass
        fun stopServer() {
            server?.let {
                it.destroy()
                if (!it.waitFor(5, TimeUnit.SECONDS)) it.destroyForcibly()
            }
            server = null
        }
    }

    private fun api(): BeamApi {
        val client = OkHttpClient.Builder()
            .protocols(listOf(Protocol.H2_PRIOR_KNOWLEDGE))
            .connectTimeout(15, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).writeTimeout(60, TimeUnit.SECONDS)
            .build()
        return BeamApi(url, "k", "h2testdevice001", "H2 Test", client = client)
    }

    /** Another thread (the poke) raises the heartbeat while the reader waits: the next, longer gap is fine. */
    @Test
    fun aHeartbeatRaisedFromAnotherThreadHolds() {
        assumeTrue("needs node", server != null)
        val stream = EventStream(api(), heartbeatMs = 1_000, mode = "grow")
        val events = mutableListOf<String>()
        stream.run(object : EventStream.Listener {
            override fun onOpen() {}
            override fun onEvent(event: String, data: String) {
                events += event
                if (event == "hello") Thread { Thread.sleep(100); stream.setHeartbeat(10_000) }.start()
            }
        })
        assertEquals(listOf("hello", "ping", "item"), events)
    }

    /** A silent stream is still noticed as dead (over h2 there's no socket timeout; the stream's own one counts). */
    @Test
    fun aSilentStreamDiesAfterItsHeartbeat() {
        assumeTrue("needs node", server != null)
        val stream = EventStream(api(), heartbeatMs = 1_500, mode = "dead")
        val t0 = System.currentTimeMillis()
        val error = runCatching {
            stream.run(object : EventStream.Listener {
                override fun onOpen() {}
                override fun onEvent(event: String, data: String) {}
            })
        }.exceptionOrNull()
        val ms = System.currentTimeMillis() - t0
        assertTrue("timed out: $error", error is java.io.IOException)
        assertTrue("within the heartbeat (+slack): $ms ms", ms in 1_000..6_000)
    }
}
