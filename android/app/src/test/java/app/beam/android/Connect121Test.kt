package app.beam.android

import android.Manifest
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.Device
import app.beam.android.core.Pairing
import org.json.JSONArray
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Duration

/**
 * (1.12.1) Catching up after the event stream (re)connects, on a slow link where every request takes 100 ms: the
 * list's two requests go side by side, the server's info is asked once, and the rest goes side by side after it, so
 * the catch-up takes a few round trips instead of one per request.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class Connect121Test {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private val desk = "desk00000001"
    private var fake: FakeBeam? = null

    private fun idleUntil(what: String, timeoutMs: Long = 20_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(20))
            if (condition()) return
            Thread.sleep(10)
        }
        throw AssertionError("timed out: $what")
    }

    /** Until nothing new was asked for 1.5 s. */
    private fun settle(f: FakeBeam) {
        var seen = f.timeline.size
        var quietSince = System.currentTimeMillis()
        idleUntil("settled", 30_000) {
            val n = f.timeline.size
            if (n != seen) {
                seen = n
                quietSince = System.currentTimeMillis()
            }
            System.currentTimeMillis() - quietSince > 1_500
        }
    }

    @After
    fun stop() {
        app.connection.release("service")
        app.unpair()
        fake?.close()
    }

    @Test
    fun theCatchUpAfterAConnectGoesSideBySide() {
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        val features = listOf("stream-modes", "items-since", "gzip", "read-markers", "alerts", "remote-control", "backups")
        val f = FakeBeam(features).also { fake = it }
        f.devices = JSONArray().put(Device(desk, "Desk", "windows", true, System.currentTimeMillis()).toJson())
        app.completePairing(Pairing.Link(f.url, "k"), "Connect Phone", "fakebeam01")
        settle(f)
        f.delayMs = 100
        app.connection.acquire("service")
        idleUntil("stream") { f.streamsOpened.isNotEmpty() }
        settle(f)

        val opened = f.streamsOpened.first()
        val catchUp = f.timeline.filter { it.second >= opened }.sortedBy { it.second }
        val span = catchUp.maxOf { it.third } - opened
        println("The catch-up after a connect, every request 100 ms: ${catchUp.size} requests, done ${span} ms after the stream opened")
        catchUp.forEach { (what, came, answered) -> println("  +${came - opened} ms  $what  (${answered - came} ms)") }

        assertEquals("the server's info once: $catchUp", 1, catchUp.count { it.first == "GET /api/info" })
        val devices = catchUp.first { it.first == "GET /api/devices" }
        val items = catchUp.first { it.first == "GET /api/items" }
        assertTrue("the list's two requests side by side", Math.abs(devices.second - items.second) < 60)
        assertTrue("a few round trips, not one per request: $span ms", span < 600)
    }
}
