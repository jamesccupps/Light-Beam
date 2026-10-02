package app.beam.android

import android.content.Context
import android.util.Base64
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.Pairing
import app.beam.android.core.ServerInfo
import app.beam.android.data.Prefs
import app.beam.android.data.SecretBox
import app.beam.android.remote.RemoteControl
import app.beam.android.ui.DeviceActions
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Beam for Android 1.7.6: the rest of the consolidated audit (S-23, S-35, S-10, S-33) and the viewer's Remote Desktop. */
@RunWith(RobolectricTestRunner::class)
class Audit176Test {
    private val ctx: Context = ApplicationProvider.getApplicationContext()
    private val raw get() = ctx.getSharedPreferences("beam", Context.MODE_PRIVATE)

    /** Stands in for the Keystore (which needs a phone): reversible, and never the token as written. */
    private class FakeBox(private val tag: String = "a", private val works: Boolean = true) : SecretBox {
        override fun seal(plain: String) = if (works) "$tag:" + Base64.encodeToString(plain.reversed().toByteArray(), Base64.NO_WRAP) else null
        override fun open(sealed: String) =
            if (!works || !sealed.startsWith("$tag:")) null else String(Base64.decode(sealed.substring(tag.length + 1), Base64.NO_WRAP)).reversed()
    }

    @Before fun clean() = raw.edit().clear().commit().let { }

    @Test fun signInIsSealedOnDisk() {
        val token = "bt_signin_for_this_phone"
        Prefs(ctx, FakeBox()).savePairing("https://beam.example.ts.net", token, "Phone")
        assertFalse("not in clear", raw.contains("key"))
        assertFalse("not even inside the sealed value", raw.getString("keySealed", "")!!.contains(token))
        assertEquals("a fresh start reads it back", token, Prefs(ctx, FakeBox()).key)
        Prefs(ctx, FakeBox()).switchKey("bt_rotated_one", deviceToken = true)
        assertEquals("bt_rotated_one", Prefs(ctx, FakeBox()).key)
        assertFalse(raw.contains("key"))
    }

    @Test fun anOlderVersionsSignInIsSealedWhenFirstRead() {
        raw.edit().putString("baseUrl", "https://beam.example.ts.net").putString("key", "bt_from_1_7_0").commit()
        val prefs = Prefs(ctx, FakeBox())
        assertEquals("bt_from_1_7_0", prefs.key)
        assertTrue(prefs.paired)
        assertFalse("the clear copy is gone", raw.contains("key"))
        assertEquals("bt_from_1_7_0", Prefs(ctx, FakeBox()).key)
    }

    @Test fun aPhoneWhoseKeystoreFailsKeepsItsSignIn() {
        Prefs(ctx, FakeBox(works = false)).savePairing("https://beam.example.ts.net", "bt_kept_as_before", "Phone")
        assertEquals("kept as before", "bt_kept_as_before", raw.getString("key", null))
        assertEquals("bt_kept_as_before", Prefs(ctx, FakeBox(works = false)).key)
    }

    @Test fun aSealedSignInThatCantBeOpenedSignsOutAndClearingForgetsIt() {
        Prefs(ctx, FakeBox("a")).savePairing("https://beam.example.ts.net", "bt_sealed", "Phone")
        assertNull("another key (the Keystore's was lost): signed out", Prefs(ctx, FakeBox("b")).key)
        assertFalse(Prefs(ctx, FakeBox("b")).paired)
        val prefs = Prefs(ctx, FakeBox("a"))
        prefs.clearPairing()
        assertFalse(raw.contains("key") || raw.contains("keySealed"))
        assertNull(prefs.key)
    }

    @Test fun approvalLinksOnlyForThisPhonesOwnBeam() {
        val base = "https://beam.example.ts.net"
        val alternates = setOf("https://beam-nas.example.ts.net")
        assertTrue(Pairing.isOwnServer(Pairing.approveHost("$base/?approve=ABCD2345"), base, alternates))
        assertTrue("also at an address it's known by", Pairing.isOwnServer(Pairing.approveHost("https://BEAM-NAS.example.ts.net/?approve=ABCD2345"), base, alternates))
        assertFalse("another tailnet's Beam", Pairing.isOwnServer(Pairing.approveHost("https://beam.other.ts.net/?approve=ABCD2345"), base, alternates))
        assertFalse(Pairing.isOwnServer(null, base, alternates))
        assertFalse(Pairing.isOwnServer(base, null, alternates))
    }

    @Test fun theViewersSignInCookieUnderEitherName() {
        val withPath = "https://nas.example.ts.net/beam".toHttpUrl()
        assertEquals("__Host-beam_key=bt_x; Path=/; HttpOnly; SameSite=Lax; Secure",
            RemoteControl.pageCookie("__Host-beam_key=bt_x; Path=/; Max-Age=315360000; HttpOnly; SameSite=Lax; Secure", withPath))
        assertEquals("beam_key=bt_x; Path=/beam/; HttpOnly", RemoteControl.pageCookie("beam_key=bt_x; Path=/; HttpOnly", withPath))
        assertEquals("bt_x", RemoteControl.cookieValue("__Host-beam_key=bt_x; Path=/; Secure"))
        assertEquals("bt_y", RemoteControl.cookieValue("beam_key=bt_y; Path=/"))
        assertNull(RemoteControl.cookieValue("beam_key=; Path=/"))
    }

    @Test fun addressesComeFromInfo() {
        val info = ServerInfo.parse(JSONObject("""{"version":"1.7.6","api":3,"urls":["https://beam.example.ts.net","https://beam-nas.example.ts.net"]}"""))
        assertEquals(listOf("https://beam.example.ts.net", "https://beam-nas.example.ts.net"), info.urls)
        assertEquals(emptyList<String>(), ServerInfo.parse(JSONObject("""{"version":"1.7.4","api":3}""")).urls)
    }

    @Test fun theViewersRemoteDesktopDownloadNamesThePc() {
        assertEquals("pc0123", DeviceActions.rdpDevice("/api/devices/pc0123/remote-desktop.rdp"))
        assertEquals("pc0123", DeviceActions.rdpDevice("/beam/api/devices/pc0123/remote-desktop.rdp"))
        assertNull(DeviceActions.rdpDevice("/api/devices/pc0123/other.rdp"))
        assertNull(DeviceActions.rdpDevice(null))
    }
}
