package app.beam.android

import android.Manifest
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.os.Looper
import androidx.recyclerview.widget.RecyclerView
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.Device
import app.beam.android.core.DeviceStatus
import app.beam.android.core.EventStream
import app.beam.android.core.Item
import app.beam.android.core.Pairing
import app.beam.android.core.SignInClient
import app.beam.android.core.TestNet
import app.beam.android.data.Repository
import app.beam.android.ui.MainActivity
import app.beam.android.ui.ThreadActivity
import app.beam.android.ui.Thumbs
import org.json.JSONArray
import org.json.JSONObject
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.time.Duration
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import kotlin.concurrent.thread
import kotlin.random.Random

/**
 * Speed and idle cost, measured through the real app (Robolectric on the JVM, so times are this PC's, not a
 * phone's: a Pixel is roughly 3–5× slower at this kind of work). Prints a table and writes it to build/perf.
 * Budgets (the asserts) sit far above the numbers measured for 1.4.0 (see plan/speed-results-android.md), so
 * they catch a real regression (a quadratic loop, disk or network work on the main thread), not a busy PC.
 * The idle-traffic measurement takes a few minutes against a scratch server and runs only with BEAM_PERF=1
 * (BEAM_PERF_IDLE_S: how long; 200 s by default, to cover a 180 s background heartbeat).
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w412dp-h915dp")
class PerfTest {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private val url = System.getProperty("beam.url").orEmpty()
    private val key = System.getProperty("beam.key").orEmpty()
    private val perf = System.getProperty("beam.perf").orEmpty() == "1"
    private val idleSeconds = System.getProperty("beam.perf.idle")?.toIntOrNull() ?: 200
    private val desk = "desk00000001"

    private fun idle(ms: Long = 20) = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ms))

    private fun idleUntil(what: String, timeoutMs: Long = 30_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            idle()
            if (condition()) return
            Thread.sleep(2)
        }
        throw AssertionError("timed out: $what")
    }

    private fun <T> offMain(block: () -> T): T {
        val ex = Executors.newSingleThreadExecutor()
        try {
            return ex.submit(Callable { block() }).get()
        } finally {
            ex.shutdown()
        }
    }

    private fun ms(nanos: Long) = "%.1f ms".format(nanos / 1e6)

    private fun budget(what: String, nanos: Long, maxMs: Long) =
        assertTrue("$what took ${ms(nanos)}, budget $maxMs ms", nanos <= maxMs * 1_000_000)

    /** A realistic mix: texts from a few words to a few KB, now and then a file; half from the desk. */
    private fun items(n: Int, me: String): List<Item> {
        val r = Random(n)
        val now = System.currentTimeMillis()
        return (0 until n).map { i ->
            val fromDesk = i % 2 == 0
            val from = if (fromDesk) desk else me
            val to = listOf(if (fromDesk) me else desk)
            val ts = now - (n - i) * 60_000L
            if (i % 10 == 9) {
                Item("f%015d".format(i), "file", null, false, 0, "photo-$i.jpg", 2_000_000L + i, "image/jpeg", from, "Desk", to, emptyMap(), ts)
            } else {
                val len = if (i % 50 == 0) 3_000 else 50 + r.nextInt(400)
                val text = buildString { while (length < len) append("Beam text $i with a link https://example.com/$i and more words. ") }.take(len)
                Item("t%015d".format(i), "text", text, false, text.length, null, 0, null, from, "Desk", to, mapOf(desk to ts + 500), ts)
            }
        }
    }

    /** Pairs with a server that never answers (the app stays "connecting") and fills in [n] items. */
    private fun offlineWith(n: Int, silent: ServerSocket): String {
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        app.completePairing(Pairing.Link("http://127.0.0.1:${silent.localPort}", "k"), "Perf Phone")
        val me = app.prefs.deviceId
        val devices = JSONArray().put(Device(desk, "Desk", "windows", true, System.currentTimeMillis()).toJson())
        app.repo.onEvent("devices", JSONObject().put("devices", devices).toString())
        for (item in items(n, me)) app.repo.upsert(item)
        return me
    }

    @Test
    fun coldStartFromTheSavedCopy() {
        for (n in listOf(500, 5000)) {
            ServerSocket(0, 50, InetAddress.getByName("127.0.0.1")).use { silent ->
                offlineWith(n, silent)
                offMain { app.repo.saveNow() }
                val bytes = File(app.filesDir, "state.json").length()
                // What a new process does in Application.onCreate: read the saved copy (main thread).
                val loads = (1..5).map { System.nanoTime().let { t0 -> Repository(app).also { check(it.state.value.items.size == n) }; System.nanoTime() - t0 } }.sorted()
                // Then the conversation list's first frame.
                val t0 = System.nanoTime()
                val main = Robolectric.buildActivity(MainActivity::class.java).setup()
                val list = main.get().findViewById<RecyclerView>(R.id.list)
                idleUntil("list") { (list.adapter?.itemCount ?: 0) >= 2 }
                val firstList = System.nanoTime() - t0
                results["cold start, $n items: saved copy (${bytes / 1024} KB) read"] = ms(loads[2])
                results["cold start, $n items: conversation list shown"] = ms(firstList)
                main.pause().stop().destroy()
                app.unpair()
                // Measured: 2.5 / 19 ms to read, 110–130 ms to the list.
                budget("reading the saved copy of $n items", loads[2], if (n <= 500) 50 else 300)
                budget("the conversation list with $n items", firstList, 1_500)
            }
        }
    }

    @Test
    fun openingAThreadOf500Items() {
        ServerSocket(0, 50, InetAddress.getByName("127.0.0.1")).use { silent ->
            offlineWith(500, silent)
            val times = (1..3).map {
                val t0 = System.nanoTime()
                val t = Robolectric.buildActivity(ThreadActivity::class.java, ThreadActivity.intent(app, desk)).setup()
                val list = t.get().findViewById<RecyclerView>(R.id.list)
                idleUntil("rows") { (list.adapter?.itemCount ?: 0) >= 500 && list.childCount > 0 }
                val took = System.nanoTime() - t0
                t.pause().stop().destroy()
                took
            }.sorted()
            results["open a thread of 500 items (rows + first layout)"] = ms(times[1])
            app.unpair()
            budget("opening a thread of 500 items", times[1], 3_000) // measured: ~370 ms
        }
    }

    @Test
    fun pictureThumbnails() {
        ServerSocket(0, 50, InetAddress.getByName("127.0.0.1")).use { silent ->
            offlineWith(0, silent)
            // A 12-megapixel photo saved on the phone, and the small copy Beam keeps.
            val big = Bitmap.createBitmap(4000, 3000, Bitmap.Config.ARGB_8888)
            // Photo-like detail (a flat picture would compress to almost nothing): smooth gradients plus noise.
            val r = Random(7)
            val row = IntArray(4000)
            for (y in 0 until 3000) {
                for (x in 0 until 4000) {
                    val n = r.nextInt(48)
                    row[x] = Color.rgb((x / 16 + n) and 255, (y / 12 + n) and 255, ((x + y) / 28 + n) and 255)
                }
                big.setPixels(row, 0, 4000, 0, y, 4000, 1)
            }
            val photo = File.createTempFile("perf-photo", ".jpg").apply { deleteOnExit() }
            photo.outputStream().use { big.compress(Bitmap.CompressFormat.JPEG, 90, it) }
            // What Thumbs does with a saved photo: decode it scaled down (on a phone: ImageDecoder with a target
            // size, which Robolectric can't run on Windows; BitmapFactory with inSampleSize does the same work).
            fun decodeOriginal(): Bitmap = BitmapFactory.decodeFile(photo.path, BitmapFactory.Options().apply { inSampleSize = 4 })
            val fromOriginal = (1..3).map { System.nanoTime().let { t0 -> decodeOriginal(); System.nanoTime() - t0 } }.sorted()
            val small = File.createTempFile("perf-thumb", ".jpg").apply { deleteOnExit() }
            small.outputStream().use { decodeOriginal().compress(Bitmap.CompressFormat.JPEG, 85, it) }
            val fromSmall = (1..3).map { System.nanoTime().let { t0 -> BitmapFactory.decodeFile(small.path); System.nanoTime() - t0 } }.sorted()
            results["photo preview from the ${photo.length() / 1024} KB original (12 MP)"] = ms(fromOriginal[1])
            results["photo preview from a ${small.length() / 1024} KB small copy"] = ms(fromSmall[1])

            // Thumbs itself: a saved photo whose small copy exists never touches the original again (here the
            // original's address leads nowhere, and there's no server either).
            val item = Item("p000000000000001", "file", null, false, 0, "photo.jpg", photo.length(), "image/jpeg", desk, "Desk", emptyList(), emptyMap(), System.currentTimeMillis())
            small.copyTo(File(File(app.cacheDir, "thumbs").apply { mkdirs() }, "${item.id}.local.jpg"), overwrite = true)
            val gone = android.net.Uri.fromFile(File(app.cacheDir, "no-such-photo.jpg"))
            val viaThumbs = (1..3).map {
                offMain {
                    val t0 = System.nanoTime()
                    val bmp = Thumbs.loadItem(app, item, gone)
                    check(bmp != null && bmp.width == 1000) { "the small copy, not ${bmp?.width}" }
                    System.nanoTime() - t0
                }
            }.sorted()
            results["photo preview through Thumbs (small copy)"] = ms(viaThumbs[1])
            app.unpair()
            budget("a photo preview from its small copy", viaThumbs[1], 60) // measured: ~3–4 ms
        }
    }

    /**
     * "Screen off, Stay connected" against a scratch server for [idleSeconds] while 4 PCs report their status
     * every 6 s (a storm: in real life each reports every 15 minutes and on changes): what reaches the phone
     * (each event wakes it), what it sends, how often it rewrites its saved copy.
     */
    @Test
    fun idleTraffic() {
        assumeTrue("BEAM_PERF=1 and a scratch server", perf && url.isNotEmpty() && key.isNotEmpty())
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        app.completePairing(Pairing.Link(url, key), "Idle Phone", offMain { SignInClient(url).hello().serverId })
        val main = Robolectric.buildActivity(MainActivity::class.java).setup()
        idleUntil("connected") { app.repo.state.value.conn == Repository.Conn.CONNECTED && app.prefs.baselineDone }
        val pcs = (1..4).map { TestNet.device(url, key, "Idle PC $it", "windows").also { pc -> pc.me() } }
        val streams = pcs.map { pc -> EventStream(pc).also { s -> thread(isDaemon = true) { runCatching { s.run(object : EventStream.Listener { override fun onOpen() {}; override fun onEvent(event: String, data: String) {} }) } } } }
        // The phone knows the PCs before it idles (a new device is worth saving; its status news isn't).
        idleUntil("the PCs are known") { pcs.all { pc -> app.repo.state.value.devices.any { it.id == pc.deviceId && it.online } } }
        Thread.sleep(2_000)
        app.connection.acquire("service") // "Stay connected"
        main.pause().stop() // the screen goes off
        Thread.sleep(3_000)
        idle(100)
        val events0 = app.connection.eventsReceived.get()
        val requests0 = MainThreadGuard.mark()
        val writes0 = app.repo.cacheWrites.get()
        val streams0 = app.connection.streamsOpened.get()
        val start = System.currentTimeMillis()
        var reports = 0
        var next = start
        while (System.currentTimeMillis() - start < idleSeconds * 1000L) {
            if (System.currentTimeMillis() >= next) {
                val pc = pcs[reports % pcs.size]
                pc.putStatus(DeviceStatus(80 - reports, false, 100L shl 30, 500L shl 30, "Windows 11 Pro"))
                reports++
                next += 6_000
            }
            idle(50)
            Thread.sleep(50)
        }
        Thread.sleep(2_000) // a last throttled `devices` or a debounced save
        idle(100)
        val events = app.connection.eventsReceived.get() - events0
        val requests = MainThreadGuard.requestsSince(requests0).filter { !it.endsWith("/api/events") }
        val writes = app.repo.cacheWrites.get() - writes0
        val reconnects = app.connection.streamsOpened.get() - streams0
        val perHour = 3600.0 / idleSeconds
        val modes = app.repo.state.value.info?.lists("stream-modes") == true
        val label = "idle ${idleSeconds}s (${if (modes) "server with stream-modes" else "server without stream-modes"})"
        results["$label: status reports by other PCs"] = "$reports"
        results["$label: events that reached the phone (each = a wakeup)"] = "$events (%.0f/h)".format(events * perHour)
        results["$label: requests the phone sent"] = "${requests.size} ${requests.groupingBy { it }.eachCount()}"
        results["$label: saved-copy rewrites"] = "$writes (%.0f/h)".format(writes * perHour)
        results["$label: stream mode, heartbeat"] = "${app.connection.streamMode ?: "-"}, " +
            app.connection.heartbeatSeconds.let { if (it > 0) "$it s" else "25 s (1.3.0 default)" }
        // Server 1.4 counts the writes to each stream (each one wakes the phone's radio) since it opened.
        val metrics = runCatching {
            offMain { app.api!!.let { api -> api.execute(api.request(api.url("/api/metrics")).get().build()).use { JSONObject(it.body!!.string()) } } }
        }.getOrNull()
        val streamsNow = metrics?.optJSONArray("streams")
        val mine = streamsNow?.let { a -> (0 until a.length()).map { a.getJSONObject(it) }.firstOrNull { it.optString("device") == app.repo.me } }
        if (mine != null) {
            results["$label: server's count for the phone's stream (whole run)"] = "writes ${mine.optInt("writes")}, events offered " +
                "${mine.optInt("events")}, held ${mine.optInt("heldTotal")}, pokes ${mine.optInt("pokes")}"
        }
        streams.forEach { it.cancel() }
        app.connection.release("service")
        main.destroy()
        app.unpair()
        // Budgets. The phone itself sends nothing and writes nothing while it idles (1.3.0: a rewrite per report).
        assertEquals("requests while idle: $requests", 0, requests.size)
        assertEquals("saved-copy rewrites while idle", 0L, writes)
        assertEquals("one stream the whole time", 0L, reconnects)
        // In the background the server holds status news until the heartbeat: one wakeup per 3 minutes, not one per
        // report (1.3.0: ~12 a minute in this storm). A little slack for a flush when the queue fills up.
        if (modes) assertTrue("events while idle: $events", events <= idleSeconds / 180 + 2)
    }

    companion object {
        private val results = LinkedHashMap<String, String>()

        @JvmStatic
        @AfterClass
        fun printTable() {
            if (results.isEmpty()) return
            val width = results.keys.maxOf { it.length }
            val table = buildString {
                appendLine("Android perf (Robolectric on this PC)")
                for ((k, v) in results) appendLine(k.padEnd(width) + "  " + v)
            }
            println(table)
            val dir = System.getProperty("beam.perf.dir")?.takeIf { it.isNotBlank() } ?: return
            File(dir).mkdirs()
            File(dir, "android-perf.txt").appendText(table + "\n")
        }
    }
}
