package app.beam.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.io.InputStream
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Upload speed of the app's [Uploader] through `test/perf/netsim.mjs` (a set round trip and bandwidth), with the
 * server's 8 MB chunks and with 1.4 big chunks. Runs only with BEAM_PERF=1 and BEAM_NETSIM_URL, e.g.
 *
 *   node test/perf/netsim.mjs --listen 8861 --to 127.0.0.1:8811 --rtt 25 --mbps 400
 *   BEAM_PERF=1 BEAM_NETSIM_URL=http://127.0.0.1:8861 BEAM_TEST_KEY=<key> ./gradlew testDebugUnitTest --tests '*TransferPerfTest'
 */
class TransferPerfTest {
    private val url = System.getProperty("beam.netsim").orEmpty()
    private val key = System.getProperty("beam.key").orEmpty()
    private val perf = System.getProperty("beam.perf").orEmpty() == "1"

    /** [size] bytes of cheap pseudo-random data, never all in memory. */
    private class Generated(override val size: Long) : UploadSource {
        override val name = "speed.bin"
        override val mime = "application/octet-stream"
        override fun open(offset: Long): InputStream = object : InputStream() {
            private var pos = offset
            override fun read(): Int = if (pos >= size) -1 else ((pos++ * 31 + 7) and 0xFF).toInt()
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                if (pos >= size) return -1
                val n = minOf(len.toLong(), size - pos).toInt()
                for (i in 0 until n) b[off + i] = (((pos + i) * 31 + 7) and 0xFF).toByte()
                pos += n
                return n
            }
        }
    }

    @Test
    fun uploadsThroughASlowRoundTrip() {
        assumeTrue("BEAM_PERF=1, BEAM_NETSIM_URL and BEAM_TEST_KEY", perf && url.isNotEmpty() && key.isNotEmpty())
        val size = 512L shl 20
        val rows = LinkedHashMap<String, String>()
        for (big in listOf(false, true)) {
            val puts = CopyOnWriteArrayList<Long>()
            val client = TestNet.client().newBuilder().addInterceptor { c ->
                if (c.request().method == "PUT") puts += c.request().body?.contentLength() ?: -1
                c.proceed(c.request())
            }.build()
            val pc = BeamApi(url, key, TestNet.newId(), "Speed PC", "android", client)
            assumeTrue("the server lists big-chunks", !big || pc.info().lists("big-chunks"))
            val t0 = System.nanoTime()
            val item = Uploader(pc, Generated(size), emptyList(), sleep = { Thread.sleep(it) }, bigChunks = big).run()
            val s = (System.nanoTime() - t0) / 1e9
            assertEquals(size, item.size)
            pc.deleteItem(item.id)
            val label = if (big) "1.4 big chunks" else "8 MB chunks"
            rows["upload 512 MB through netsim, $label"] = "%.1f MB/s in %d PUTs (%s)".format(size / 1048576.0 / s, puts.size,
                puts.joinToString(" ") { "${it shr 20}" } .let { if (it.length > 60) it.take(60) + "…" else it } + " MB")
        }
        val table = buildString {
            appendLine("Android transfers (" + url + ")")
            val width = rows.keys.maxOf { it.length }
            for ((k, v) in rows) appendLine(k.padEnd(width) + "  " + v)
        }
        println(table)
        System.getProperty("beam.perf.dir")?.takeIf { it.isNotBlank() }?.let { File(it).apply { mkdirs() }.resolve("android-perf.txt").appendText(table + "\n") }
        assertTrue(rows.size == 2)
    }
}
