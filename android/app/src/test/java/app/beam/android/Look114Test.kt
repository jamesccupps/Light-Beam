package app.beam.android

import android.os.Looper
import android.view.View
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.view.isVisible
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.Device
import app.beam.android.core.Look
import app.beam.android.core.Pairing
import app.beam.android.ui.AppearanceActivity
import app.beam.android.ui.SettingsActivity
import app.beam.android.ui.themeColor
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
import org.robolectric.annotation.Config
import java.time.Duration

/**
 * (1.14, server 1.27 `appearance`) The phone follows the look: the one for all devices from the hello and `settings`
 * events, its own from its entry in the devices list; light or dark as AppCompat's night mode, the accent as a theme
 * overlay on every screen. Settings → Appearance changes either, against [FakeBeam].
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class Look114Test {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private var fake: FakeBeam? = null

    /** The screens made here, closed before the next look change and at the end (see [screen]). */
    private val screens = ArrayList<org.robolectric.android.controller.ActivityController<*>>()

    @After
    fun tearDown() {
        closeScreens()
        app.connection.release("service")
        if (app.prefs.paired) app.unpair()
        fake?.close()
        app.prefs.lookServer = null
        app.prefs.lookOwn = null
    }

    /**
     * A screen as it opens now. On a phone a new look makes the open screens again (AppCompat for light or dark,
     * BaseActivity for the accent); Robolectric can't remake one it made, so each is closed before the look changes.
     */
    private fun <T : android.app.Activity> screen(type: Class<T>): T {
        idle(100) // (a look change from the stream reaches the main thread first)
        val c = Robolectric.buildActivity(type).setup()
        screens += c
        return c.get()
    }

    private fun closeScreens() {
        idle(100)
        for (c in screens) c.pause().stop().destroy()
        screens.clear()
        idle(100)
    }

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

    private fun start(features: List<String> = listOf("stream-modes", "appearance"), appearance: JSONObject? = null, own: JSONObject? = null): FakeBeam {
        val f = FakeBeam(features).also { fake = it }
        f.appearance = appearance
        val phone = Device(app.prefs.deviceId, "Pixel", "android", true, System.currentTimeMillis()).toJson()
        if (own != null) phone.put("settings", JSONObject().put("appearance", own))
        f.devices = JSONArray().put(phone).put(Device("desk00000001", "Desk", "windows", true, System.currentTimeMillis()).toJson())
        app.completePairing(Pairing.Link(f.url, "bt_the_phones_own_token_01"), "Pixel", "fakebeam01")
        app.connection.acquire("service")
        idleUntil("connected") { app.connection.streamId != null && app.repo.state.value.info != null && app.repo.state.value.devices.size == 2 }
        return f
    }

    private fun look(theme: String, accent: String?) = JSONObject().put("theme", theme).put("accent", accent ?: JSONObject.NULL)

    @Test
    fun readsTheLookAndShowsAColourOfYourOwnAsTheNearestOne() {
        assertEquals(Look(Look.DARK, "#2563eb"), Look.parse(look("dark", "#2563EB")))
        assertEquals("anything else is like the phone", Look(Look.AUTO, null), Look.parse(JSONObject().put("theme", "sepia").put("accent", "blue")))
        assertNull(Look.parse(null))
        assertEquals("#2563eb", Look.shownAs("#2563eb"))
        assertEquals("#2563eb", Look.shownAs("#3070f0"))
        assertEquals("#d12b2b", Look.shownAs("#ff0000"))
        assertNull("near Beam's own", Look.shownAs("#5b4cf1"))
        assertNull(Look.shownAs(null))
    }

    @Test
    fun followsTheLookForAllDevicesAndChangesWithIt() {
        val f = start(appearance = look("dark", "#2563eb"))
        idleUntil("the hello's look") { app.looks.look.value == Look(Look.DARK, "#2563eb") }
        val s = screen(SettingsActivity::class.java)
        assertEquals(AppCompatDelegate.MODE_NIGHT_YES, AppCompatDelegate.getDefaultNightMode())
        assertEquals("the screen in its accent", s.getColor(R.color.look_blue), s.themeColor(R.attr.beamAccent))
        assertEquals(s.getColor(R.color.look_blue), s.themeColor(androidx.appcompat.R.attr.colorPrimary))
        idleUntil("the row") { s.findViewById<View>(R.id.rowAppearance).isVisible }
        closeScreens()

        f.appearance = look("light", null)
        f.send("settings", JSONObject().put("appearance", f.appearance))
        idleUntil("the settings event's") { app.looks.look.value == Look(Look.LIGHT, null) }
        val again = screen(SettingsActivity::class.java)
        assertEquals(AppCompatDelegate.MODE_NIGHT_NO, AppCompatDelegate.getDefaultNightMode())
        assertEquals("Beam's own again", again.getColor(R.color.accent), again.themeColor(R.attr.beamAccent))
        assertEquals("kept for the next start", Look(Look.LIGHT, null), Look.parse(JSONObject(app.prefs.lookServer!!)))
    }

    @Test
    fun itsOwnLookWinsAndIsSavedWhereItApplies() {
        val f = start(appearance = look("dark", "#2563eb"), own = look("light", "#16803c"))
        idleUntil("its own look") { app.looks.look.value == Look(Look.LIGHT, "#16803c") }
        val a = screen(AppearanceActivity::class.java)
        assertEquals(a.getColor(R.color.look_green), a.themeColor(R.attr.beamAccent))
        assertTrue("only this phone", a.findViewById<android.widget.RadioButton>(R.id.whereOwn).isChecked)
        assertTrue(a.findViewById<com.google.android.material.button.MaterialButton>(R.id.themeLight).isChecked)
        val swatches = a.findViewById<android.widget.GridLayout>(R.id.swatches)
        val chosen = (0 until swatches.childCount).map { swatches.getChildAt(it) }.filter { it.isSelected }.map { it.contentDescription }
        assertEquals("nine colours, Green chosen", listOf(9, "Green"), listOf(swatches.childCount, chosen.single()))
        closeScreens()

        // Dark, on this phone only: PUT /api/devices/me/settings; shown at once, and the devices event agrees.
        kotlinx.coroutines.runBlocking { app.looks.save(Look(Look.DARK, "#16803c"), ownLook = true) }
        assertEquals(Look(Look.DARK, "#16803c"), app.looks.look.value)
        assertEquals(AppCompatDelegate.MODE_NIGHT_YES, AppCompatDelegate.getDefaultNightMode())
        idleUntil("its own look sent") { f.lookCalls.lastOrNull()?.let { it.first == app.prefs.deviceId && JSONObject(it.second).optString("theme") == "dark" } == true }
        idle(300)
        assertEquals("still, after the server's devices event", Look(Look.DARK, "#16803c"), app.looks.look.value)

        // All my devices: its own one goes, the one for all devices shows.
        kotlinx.coroutines.runBlocking { app.looks.save(null, ownLook = true) }
        idleUntil("its own look dropped") { f.lookCalls.lastOrNull() == (app.prefs.deviceId to "null") }
        idleUntil("the look for all devices") { app.looks.look.value == Look(Look.DARK, "#2563eb") && app.looks.own == null }

        // A colour for all devices: PATCH /api/settings.
        kotlinx.coroutines.runBlocking { app.looks.save(Look(Look.DARK, "#0e7c86"), ownLook = false) }
        idleUntil("for all devices") { f.lookCalls.lastOrNull()?.first == "all" && f.appearance?.optString("accent") == "#0e7c86" }
        idleUntil("shown") { app.looks.look.value == Look(Look.DARK, "#0e7c86") }
        val b = screen(AppearanceActivity::class.java)
        assertTrue("all my devices", b.findViewById<android.widget.RadioButton>(R.id.whereAll).isChecked)
        assertEquals(b.getColor(R.color.look_teal), b.themeColor(R.attr.beamAccent))
        closeScreens()

        // Only this phone, as it looks now: its own (the screen says so), though nothing it shows changes.
        kotlinx.coroutines.runBlocking { app.looks.save(app.looks.look.value, ownLook = true) }
        assertTrue(app.looks.hasOwn.value)
        val c = screen(AppearanceActivity::class.java)
        assertTrue("only this phone", c.findViewById<android.widget.RadioButton>(R.id.whereOwn).isChecked)
        assertEquals(c.getString(R.string.look_intro_own), c.findViewById<android.widget.TextView>(R.id.intro).text.toString())
    }

    @Test
    fun aRefusedSaveGoesBack() {
        val f = start(appearance = look("auto", "#2563eb"))
        idleUntil("the hello's look") { app.looks.look.value == Look(Look.AUTO, "#2563eb") }
        f.status = 403
        val failed = runCatching { kotlinx.coroutines.runBlocking { app.looks.save(Look(Look.AUTO, "#d12b2b"), ownLook = false) } }
        f.status = 0
        assertTrue(failed.isFailure)
        assertEquals("as it was", Look(Look.AUTO, "#2563eb"), app.looks.look.value)
    }

    @Test
    fun anOlderServerHasNoLook() {
        app.prefs.lookServer = look("dark", "#2563eb").toString() // (from another Beam before)
        start(features = listOf("stream-modes"))
        idleUntil("Beam's own") { app.looks.look.value == Look() }
        val s = screen(SettingsActivity::class.java)
        idle(300)
        assertFalse(s.findViewById<View>(R.id.rowAppearance).isVisible)
    }
}
