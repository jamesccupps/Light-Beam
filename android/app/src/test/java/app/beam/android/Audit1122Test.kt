package app.beam.android

import android.content.DialogInterface
import android.content.Intent
import android.os.Looper
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.BeamApi
import app.beam.android.core.Pairing
import app.beam.android.ui.PairActivity
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
 * (1.12.2) The audit's fixes on the phone: a pairing link from outside the app signs in only after a yes that names
 * the server (S-10); only a token in a device token's shape is taken from X-Beam-Token (C-7); a server answering with
 * this Beam's id is followed only with the proof, whatever `api` it claims (X-1).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class Audit1122Test {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private val fakes = mutableListOf<FakeBeam>()

    private fun idleFor(ms: Long) {
        val until = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < until) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(20))
            Thread.sleep(10)
        }
    }

    @After
    fun stop() {
        app.unpair()
        fakes.forEach { it.close() }
    }

    @Test
    fun aPairingLinkFromOutsideTheAppWaitsForAYesThatNamesTheServer() {
        val f = FakeBeam(listOf("stream-modes")).also { fakes += it }
        val link = "${f.url}/?key=bp_example0000000000000000000000"
        val pair = Robolectric.buildActivity(PairActivity::class.java, Intent(app, PairActivity::class.java).putExtra(PairActivity.EXTRA_LINK, link)).setup()
        idleFor(800)
        assertTrue("nothing asked of that server yet: ${f.requests}", f.requests.isEmpty())
        val dialog = ShadowDialog.getLatestDialog() as AlertDialog
        val message = dialog.findViewById<TextView>(android.R.id.message)?.text.toString()
        assertTrue("the dialog names the server: $message", message.contains("127.0.0.1"))
        dialog.getButton(DialogInterface.BUTTON_POSITIVE).performClick()
        idleFor(1500)
        assertTrue("signing in once the person said yes", f.requests.isNotEmpty())
        pair.pause().stop().destroy()
    }

    @Test
    fun onlyATokenInATokensShapeIsTakenFromTheServer() {
        val api = BeamApi("http://127.0.0.1:9/", "bt_current", "audit000001", "Phone")
        val taken = mutableListOf<String>()
        api.onToken = { taken += it }
        fun answer(token: String) = Response.Builder().request(Request.Builder().url("http://127.0.0.1:9/api/me").build())
            .protocol(Protocol.HTTP_1_1).code(200).message("OK").header("X-Beam-Token", token).build()
        // (lower case: a real token's mixed-case shape would be refused by the publish script's secret check)
        api.noticeToken(answer("not a token"))
        api.noticeToken(answer("bt_bad token with spaces"))
        api.noticeToken(answer("bt_abcdef0123456789-_xyzxyz"))
        assertEquals(listOf("bt_abcdef0123456789-_xyzxyz"), taken)
    }

    @Test
    fun aServerWithThisBeamsIdButNoProofIsNotFollowedWhateverApiItClaims() {
        val home = FakeBeam(listOf("stream-modes")).also { fakes += it }
        app.completePairing(Pairing.Link(home.url, "bt_home000000000000000000000000"), "Audit Phone", "fakebeam01")
        val other = FakeBeam(listOf("stream-modes")).also { fakes += it }
        other.helloApi = 2 // "too old to prove anything"
        assertNull("not followed without the proof", app.moves.verify(other.url))
        other.helloApi = 3
        assertNull("nor as api 3", app.moves.verify(other.url))
    }
}
