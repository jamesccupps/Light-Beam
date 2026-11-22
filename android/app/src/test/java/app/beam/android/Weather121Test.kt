package app.beam.android

import android.Manifest
import android.os.Looper
import android.view.View
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import androidx.core.view.isVisible
import androidx.recyclerview.widget.RecyclerView
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.Device
import app.beam.android.core.Pairing
import app.beam.android.data.Repository
import app.beam.android.data.Weather
import app.beam.android.ui.MainActivity
import app.beam.android.ui.WeatherActivity
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import java.time.Duration

/**
 * (Android 1.21, server 1.36) LocalCast's weather (the user, 2026-11-21: "my local cast weather should be part of this
 * app"): the main list's Weather row after Alerts (the temperature now, LocalCast's warning first, °F when its page shows
 * imperial), read from `GET /api/weather`; tapping it opens LocalCast's own page in [WeatherActivity] (only its own
 * address; nothing of Beam's goes to it); none from an older server or a sign-in not approved yet.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class Weather121Test {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private var fake: FakeBeam? = null
    private val opened = mutableListOf<ActivityController<*>>()
    private val desk = "desk00000121"
    private val page = "http://my-pc:8787/"

    @After
    fun tearDown() {
        for (c in opened.asReversed()) runCatching { c.pause().stop().destroy() }
        opened.clear()
        app.connection.release("service")
        if (app.prefs.paired) app.unpair()
        fake?.close()
    }

    private fun <C : ActivityController<*>> keep(c: C): C = c.also { opened += it }
    private fun idle(ms: Long = 20) = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ms))
    private fun idleUntil(what: String, timeoutMs: Long = 10_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            idle()
            if (condition()) return
            Thread.sleep(10)
        }
        throw AssertionError("timed out: $what")
    }

    private fun weatherJson() = JSONObject().put("url", page).put("how", "found").put("name", "Biddeford").put("locale", "Biddeford, Maine").put("units", "imperial")
        .put("now", JSONObject().put("temp", 6.1).put("feels", 5.5).put("text", "Partly cloudy").put("kind", "partly").put("day", false).put("age", 11))
        .put("today", JSONObject().put("hi", 16).put("lo", 2.2).put("pop", 13))
        .put("hazards", JSONArray().put(JSONObject().put("title", "Freeze risk").put("kind", "freeze")))

    private fun start(features: List<String> = listOf("stream-modes", "trust", "weather")): FakeBeam {
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        val now = System.currentTimeMillis()
        val f = FakeBeam(features).also { fake = it }
        f.devices = JSONArray().put(Device(desk, "Desk", "windows", true, now, trusted = true).toJson())
        f.weather = weatherJson()
        app.completePairing(Pairing.Link(f.url, "bt_the_phones_own_token_121"), "Weather Phone", "fakebeam121")
        app.connection.acquire("service")
        idleUntil("connected") { app.connection.streamId != null && app.repo.state.value.info != null && app.repo.state.value.loaded }
        return f
    }

    private fun bindAll(list: RecyclerView): List<View> {
        @Suppress("UNCHECKED_CAST")
        val adapter = list.adapter as RecyclerView.Adapter<RecyclerView.ViewHolder>
        return (0 until adapter.itemCount).map { pos ->
            val holder = adapter.onCreateViewHolder(list, adapter.getItemViewType(pos))
            adapter.onBindViewHolder(holder, pos)
            holder.itemView
        }
    }

    private fun texts(view: View): List<String> {
        val out = ArrayList<String>()
        fun walk(v: View) {
            if (v is TextView && v.isVisible && v.text.isNotEmpty()) out += v.text.toString()
            if (v is android.view.ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i))
        }
        walk(view)
        return out
    }

    @Test
    fun theWeatherRowShowsLocalCastsWeatherAndOpensItsPage() {
        val f = start()
        val main = keep(Robolectric.buildActivity(MainActivity::class.java).setup()).get()
        val list = main.findViewById<RecyclerView>(R.id.list)
        idleUntil("the Weather row") { bindAll(list).any { "Weather" in texts(it) } }
        val rows = bindAll(list)
        val i = rows.indexOfFirst { "Weather" in texts(it) }
        assertEquals("after All devices (no Alerts here)", 1, i)
        val row = texts(rows[i])
        assertTrue("43° now ($row)", "43°" in row)
        assertTrue("its warning first, °F ($row)", "Freeze risk · Partly cloudy · ↑61° ↓36° · rain 13%" in row)
        assertTrue("asked once at least", f.weatherRequests.get() >= 1)

        // A tap opens LocalCast's page in Beam
        rows[i].findViewById<View>(R.id.row).performClick()
        idle()
        val next = shadowOf(main).nextStartedActivity
        assertEquals(WeatherActivity::class.java.name, next?.component?.className)
        val screen = keep(Robolectric.buildActivity(WeatherActivity::class.java, next).setup()).get()
        var web: WebView? = null
        idleUntil("the page") {
            web = screen.findViewById<FrameLayout>(R.id.page).getChildAt(0) as? WebView
            web?.let { shadowOf(it).lastLoadedUrl } != null
        }
        assertEquals(page, shadowOf(web!!).lastLoadedUrl)
        assertTrue("its script runs", web!!.settings.javaScriptEnabled)
        assertFalse("no files", web!!.settings.allowFileAccess)

        // Gone when the server has none any more (turned off in Settings)
        f.weather = JSONObject().put("url", JSONObject.NULL).put("off", true)
        app.weather.refresh()
        idleUntil("the row gone") { bindAll(list).none { "Weather" in texts(it) } }
    }

    @Test
    fun onlyAWebPagesAddressOpens() {
        for (bad in listOf("file:///sdcard/x.html", "javascript:alert(1)", "http://me:pw@host/", "content://x/y", "")) {
            val c = keep(Robolectric.buildActivity(WeatherActivity::class.java, WeatherActivity.intent(app, bad)).setup())
            assertTrue("refused: $bad", c.get().isFinishing)
        }
    }

    @Test
    fun anOlderServerHasNoWeatherRow() {
        start(features = listOf("stream-modes", "trust"))
        val main = keep(Robolectric.buildActivity(MainActivity::class.java).setup()).get()
        val list = main.findViewById<RecyclerView>(R.id.list)
        idleUntil("the list") { bindAll(list).isNotEmpty() }
        app.weather.refresh()
        idle(300)
        assertTrue(bindAll(list).none { "Weather" in texts(it) })
        assertNull(fake!!.weatherRequests.get().takeIf { it > 0 })
    }

    @Test
    fun theRowsWordsFromTheServersAnswer() {
        val words = { e: String -> "LocalCast didn't answer ($e)" }
        val w = Weather.rowOf(weatherJson(), words)!!
        assertEquals(Weather.Row(page, "43°", "Freeze risk · Partly cloudy · ↑61° ↓36° · rain 13%", true, "Biddeford, Biddeford, Maine"), w)
        val metric = Weather.rowOf(weatherJson().put("units", "metric").put("hazards", JSONArray()).put("today", JSONObject().put("hi", 16).put("lo", 2.2).put("pop", 5)), words)!!
        assertEquals("6° then the day, no rain under 10 %", Weather.Row(page, "6°", "Partly cloudy · ↑16° ↓2°", false, "Biddeford, Biddeford, Maine"), metric)
        val down = Weather.rowOf(JSONObject().put("url", page).put("error", "nothing answers on that port").put("name", JSONObject.NULL), words)!!
        assertEquals(Weather.Row(page, "", "LocalCast didn't answer (nothing answers on that port)", false, ""), down)
        assertNull("none", Weather.rowOf(JSONObject().put("url", JSONObject.NULL).put("off", true), words))
        assertNull("not a web page's address", Weather.rowOf(weatherJson().put("url", "file:///x"), words))
    }
}
