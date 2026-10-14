package app.beam.android

import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.isVisible
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.Device
import app.beam.android.core.Pairing
import app.beam.android.ui.SettingsActivity
import org.json.JSONArray
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog
import java.time.Duration

/**
 * (server 1.25, the security review) Approving a device from the phone, against [FakeBeam]: Settings → Devices says
 * which devices aren't approved yet, and a device's menu lets it control PCs and install apps (PUT
 * /api/devices/{id}/trust) or stops it. Only from a phone whose own sign-in is trusted, on a server with `trust`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class Trust125Test {
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
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            idle()
            if (condition()) return
            Thread.sleep(10)
        }
        throw AssertionError("timed out: $what")
    }

    private fun texts(view: View): List<String> {
        val out = ArrayList<String>()
        fun walk(v: View) {
            if (v is TextView && v.isVisible && v.text.isNotEmpty()) out += v.text.toString()
            if (v is ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i))
        }
        walk(view)
        return out
    }

    private fun device(id: String, name: String, trusted: Boolean) =
        Device(id, name, "windows", true, System.currentTimeMillis(), trusted = trusted).toJson()

    /** Paired with a FakeBeam with [features] ("stream-modes": its hello names the stream, so the app is connected), this phone's sign-in trusted or not, connected, with a new PC and Desk. */
    private fun start(features: List<String> = listOf("stream-modes", "trust"), meTrusted: Boolean? = true): FakeBeam {
        val f = FakeBeam(features).also { fake = it }
        f.meTrusted = meTrusted
        f.devices = JSONArray().put(device("newpc0000001", "New PC", false)).put(device("desk00000001", "Desk", true))
        app.completePairing(Pairing.Link(f.url, "bt_the_phones_own_token_01"), "Pixel", "fakebeam01")
        app.connection.acquire("service")
        idleUntil("connected") { app.connection.streamId != null && app.repo.state.value.info != null && app.repo.state.value.devices.size == 2 }
        return f
    }

    private fun settings(): SettingsActivity {
        val s = Robolectric.buildActivity(SettingsActivity::class.java).setup().get()
        idleUntil("the devices listed") { texts(s.findViewById(R.id.devicesList)).contains("New PC") }
        return s
    }

    /** That device's row in Settings → Devices. */
    private fun row(s: SettingsActivity, name: String): View {
        val list = s.findViewById<LinearLayout>(R.id.devicesList)
        return (0 until list.childCount).map { list.getChildAt(it) }.first { texts(it).firstOrNull() == name }
    }

    /** That device's menu (its row tapped): the entries' labels and views. */
    private fun menu(s: SettingsActivity, name: String): List<TextView> {
        row(s, name).performClick()
        idle(300)
        val entries = ShadowDialog.getLatestDialog().findViewById<LinearLayout>(R.id.entries)
        return (0 until entries.childCount).map { entries.getChildAt(it) as TextView }
    }

    private val notYet get() = app.getString(R.string.trust_not_yet)
    private val allow get() = app.getString(R.string.trust_allow)
    private val revoke get() = app.getString(R.string.trust_revoke)

    @Test
    fun aDeviceNotApprovedYetIsApprovedFromSettingsAndTakenBack() {
        val f = start()
        val s = settings()
        idleUntil("New PC: not approved, once the phone knows it may approve") { texts(row(s, "New PC")).any { notYet in it } }
        assertTrue("Desk is", texts(row(s, "Desk")).none { notYet in it })
        assertTrue(menu(s, "Desk").any { it.text.toString() == revoke })
        ShadowDialog.getLatestDialog().dismiss()
        menu(s, "New PC").first { it.text.toString() == allow }.performClick()
        idleUntil("approved on the server") { f.trustCalls.toList() == listOf("newpc0000001" to true) }
        idleUntil("and here") { app.repo.state.value.devicesById["newpc0000001"]?.trusted == true && texts(row(s, "New PC")).none { notYet in it } }
        menu(s, "New PC").first { it.text.toString() == revoke }.performClick()
        idleUntil("taken back") { f.trustCalls.lastOrNull() == ("newpc0000001" to false) }
    }

    @Test
    fun noSwitchFromAPhoneThatIsNotTrusted() {
        val f = start(meTrusted = false)
        val s = settings()
        idle(500)
        assertTrue(texts(row(s, "New PC")).none { notYet in it })
        val labels = menu(s, "New PC").map { it.text.toString() }
        assertFalse(labels.toString(), labels.any { it == allow || it == revoke })
        assertTrue(f.trustCalls.isEmpty())
    }

    @Test
    fun noSwitchOnAServerWithoutTrust() {
        start(features = listOf("stream-modes"), meTrusted = null)
        val s = settings()
        idle(500)
        assertTrue(texts(row(s, "New PC")).none { notYet in it })
        val labels = menu(s, "New PC").map { it.text.toString() }
        assertFalse(labels.toString(), labels.any { it == allow || it == revoke })
    }
}
