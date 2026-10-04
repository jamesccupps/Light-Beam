package app.beam.android

import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.ResolveInfo
import android.content.pm.ServiceInfo
import android.os.Looper
import androidx.appcompat.widget.Toolbar
import androidx.core.net.toUri
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.Device
import app.beam.android.core.Pairing
import app.beam.android.ui.FileActions
import app.beam.android.ui.MainActivity
import org.json.JSONArray
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
 * Beam Family inside the app (Android 1.12): the menu's "Beam Family" opens it in a Custom Tab of the browser (the
 * browser's engine, so Family's sign-in and notifications work as there; back returns to Beam), or in the browser
 * itself when it can't show one.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class FamilyTab112Test {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private val family = "https://family.example.ts.net:8443"
    private var fake: FakeBeam? = null
    private var main: ActivityController<MainActivity>? = null

    private fun idleUntil(what: String, timeoutMs: Long = 8_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(20))
            if (condition()) return
            Thread.sleep(10)
        }
        throw AssertionError("timed out: $what")
    }

    @After
    fun close() {
        main?.let { it.pause().stop().destroy() }
        app.unpair()
        fake?.close()
    }

    /** A browser on the phone: it opens web links, and maybe shows Custom Tabs. */
    private fun browser(pkg: String, tabs: Boolean) {
        val pm = shadowOf(app.packageManager)
        val web = Intent(Intent.ACTION_VIEW, "https://example.com/".toUri()).addCategory(Intent.CATEGORY_BROWSABLE)
        pm.addResolveInfoForIntent(web, ResolveInfo().apply { isDefault = true; activityInfo = ActivityInfo().apply { packageName = pkg; name = "$pkg.Browser" } })
        if (tabs) pm.addResolveInfoForIntent(Intent(FileActions.CT_SERVICE).setPackage(pkg), ResolveInfo().apply { serviceInfo = ServiceInfo().apply { packageName = pkg; name = "$pkg.Tabs" } })
    }

    /** Signed in, the server naming Beam Family; the menu's "Beam Family" tapped → what was started. */
    private fun tapFamily(): Intent {
        val f = FakeBeam(listOf("stream-modes")).also { fake = it }
        f.devices = JSONArray().put(Device("desk00000001", "Desk", "windows", true, System.currentTimeMillis()).toJson())
        app.completePairing(Pairing.Link(f.url, "k"), "Tab Phone", "fakebeam04")
        app.connection.acquire("service")
        idleUntil("connected, with the server's info") { app.repo.state.value.info != null }
        val m = Robolectric.buildActivity(MainActivity::class.java).setup().also { main = it }
        app.repo.setInfo(app.repo.state.value.info!!.copy(family = family))
        val menu = m.get().findViewById<Toolbar>(R.id.toolbar).menu
        idleUntil("Beam Family in the menu") { menu.findItem(R.id.action_family).isVisible }
        menu.performIdentifierAction(R.id.action_family, 0)
        return shadowOf(m.get()).nextStartedActivity
    }

    @Test
    fun beamFamilyOpensInACustomTabOfTheBrowser() {
        browser("com.android.chrome", tabs = true)
        val opened = tapFamily()
        assertEquals(Intent.ACTION_VIEW, opened.action)
        assertEquals(family, opened.dataString)
        assertEquals("the browser that shows Custom Tabs", "com.android.chrome", opened.`package`)
        assertTrue("a Custom Tab (the session extra, even without a session)", opened.extras?.containsKey(FileActions.CT_SESSION) == true)
        assertEquals("over Beam: back returns to it", 0, opened.flags and Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    @Test
    fun aBrowserWithoutCustomTabsOpensItAsBefore() {
        browser("org.example.browser", tabs = false)
        val opened = tapFamily()
        assertEquals(Intent.ACTION_VIEW, opened.action)
        assertEquals(family, opened.dataString)
        assertNull(opened.`package`)
        assertFalse(opened.hasExtra(FileActions.CT_SESSION))
        assertTrue("in the browser", opened.hasCategory(Intent.CATEGORY_BROWSABLE))
    }
}
