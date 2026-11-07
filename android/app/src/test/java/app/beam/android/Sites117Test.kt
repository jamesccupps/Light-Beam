package app.beam.android

import android.content.Intent
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.Pairing
import app.beam.android.ui.MainActivity
import app.beam.android.ui.SitesActivity
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog
import java.time.Duration

/** (1.17, server 1.31) Sites: the menu entry from a server that has them; the list; a tap opens the browser; hiding a found one. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class Sites117Test {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private var fake: FakeBeam? = null

    @After
    fun tearDown() {
        app.connection.release("service")
        if (app.prefs.paired) app.unpair()
        fake?.close()
    }

    private fun idle(ms: Long = 20) = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ms))

    private fun idleUntil(what: String, timeoutMs: Long = 10_000, condition: () -> Boolean) {
        val end = System.currentTimeMillis() + timeoutMs
        while (!condition()) {
            if (System.currentTimeMillis() > end) throw AssertionError("timed out waiting for $what")
            idle(50)
            Thread.sleep(20)
        }
    }

    private fun texts(view: View): List<String> {
        val out = mutableListOf<String>()
        fun walk(v: View) {
            if (v is TextView && v.isShown && v.text.isNotEmpty()) out += v.text.toString()
            if (v is ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i))
        }
        walk(view)
        return out
    }

    private fun site(id: String, kind: String, name: String, host: String, up: Boolean?, extra: JSONObject.() -> Unit = {}) =
        JSONObject().put("id", id).put("kind", kind).put("url", "http://$host/").put("host", host).put("name", name)
            .apply { if (up != null) put("up", up) }.apply(extra)

    private fun start(): FakeBeam {
        val f = FakeBeam(listOf("stream-modes", "trust", "sites")).also { fake = it }
        f.sites = JSONObject().put("checking", false).put("checkedAt", System.currentTimeMillis()).put("sites", JSONArray()
            .put(site("shoppc000001.8000", "found", "Trends", "shop-pc:8000", true) { put("deviceName", "Shop PC") })
            .put(site("a1b2c3d4", "added", "Garden Pi", "garden-pi:8080", false) { put("problem", "nothing answers on that port") }))
        app.completePairing(Pairing.Link(f.url, "bt_the_phones_own_token_01"), "Pixel", "fakebeam01")
        app.connection.acquire("service")
        idleUntil("connected") { app.connection.streamId != null && app.repo.state.value.info != null }
        return f
    }

    @Test
    fun theListOpensASiteAndHidesAFoundOne() {
        val f = start()
        val main = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        idleUntil("Sites in the menu") { main.findViewById<com.google.android.material.appbar.MaterialToolbar>(R.id.toolbar).menu.findItem(R.id.action_sites)?.isVisible == true }

        val s = Robolectric.buildActivity(SitesActivity::class.java).setup().get()
        val list = s.findViewById<RecyclerView>(R.id.list)
        idleUntil("the sites listed") { list.childCount == 2 }
        assertEquals(listOf("T", "Trends", "shop-pc:8000 · on Shop PC"), texts(list.getChildAt(0))) // (a letter: no icon)
        assertEquals(listOf("G", "Garden Pi", "garden-pi:8080 · added", "Not answering: nothing answers on that port"), texts(list.getChildAt(1)))

        // A tap opens it in the browser.
        list.getChildAt(0).findViewById<View>(R.id.row).performClick()
        val opened = shadowOf(s).nextStartedActivity
        assertEquals(Intent.ACTION_VIEW, opened.action)
        assertEquals("http://shop-pc:8000/", opened.dataString)

        // Touch and hold: a found one is hidden (not removed); an added one is removed.
        list.getChildAt(0).findViewById<View>(R.id.row).performLongClick()
        idle(300)
        var entries = ShadowDialog.getLatestDialog().findViewById<LinearLayout>(R.id.entries)
        val labels = (0 until entries.childCount).map { (entries.getChildAt(it) as TextView).text.toString() }
        assertEquals(listOf("Open", "Copy address", "Rename", "Hide"), labels)
        entries.getChildAt(3).performClick()
        idleUntil("hidden") { f.siteCalls.any { it.startsWith("PATCH /api/sites/shoppc000001.8000") && it.contains("\"hidden\":true") } }
        list.getChildAt(1).findViewById<View>(R.id.row).performLongClick()
        idle(300)
        entries = ShadowDialog.getLatestDialog().findViewById(R.id.entries)
        assertTrue((0 until entries.childCount).any { (entries.getChildAt(it) as TextView).text == "Remove" })

        // The `sites` event: the list is read again (now with the found one hidden, at the end).
        f.sites = JSONObject(f.sites.toString()).also { it.getJSONArray("sites").getJSONObject(0).put("hidden", true) }
        f.send("sites", JSONObject().put("at", System.currentTimeMillis()))
        idleUntil("read again") { texts(list).contains("shop-pc:8000 · on Shop PC · hidden") }
        assertEquals("Garden Pi", texts(list.getChildAt(0))[1])
    }
}
