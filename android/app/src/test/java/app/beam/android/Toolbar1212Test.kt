package app.beam.android

import android.view.ContextThemeWrapper
import androidx.test.core.app.ApplicationProvider
import app.beam.android.ui.roomForLargeText
import com.google.android.material.appbar.MaterialToolbar
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * (Android 1.21.2, the 2026-11-21 audit: "Android at 200 % text") A toolbar that shows a second line gets 6dp above and
 * below from a 1.3x font scale (at 200 % "Online" sat on the messages' edge), and nothing at normal sizes (padding there
 * moved the title or grew the bar: the screenshots before and after).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w412dp-h915dp-xhdpi")
class Toolbar1212Test {
    private fun toolbarAt(scale: Float): MaterialToolbar {
        RuntimeEnvironment.setFontScale(scale)
        val app: BeamApp = ApplicationProvider.getApplicationContext()
        return MaterialToolbar(ContextThemeWrapper(app, R.style.Theme_Beam))
    }

    @Test
    fun largeTextGetsRoomAboveAndBelow() {
        val t = toolbarAt(2.0f)
        val (top, bottom) = t.paddingTop to t.paddingBottom
        t.roomForLargeText()
        val pad = (6 * t.resources.displayMetrics.density).toInt()
        assertEquals("6dp above at 200 %", top + pad, t.paddingTop)
        assertEquals("6dp below at 200 %", bottom + pad, t.paddingBottom)
        val u = toolbarAt(1.3f)
        val before = u.paddingTop
        u.roomForLargeText()
        assertEquals("from 1.3x", before + pad, u.paddingTop)
    }

    @Test
    fun normalTextIsUnchanged() {
        for (scale in listOf(1.0f, 1.15f)) {
            val t = toolbarAt(scale)
            val before = listOf(t.paddingLeft, t.paddingTop, t.paddingRight, t.paddingBottom)
            t.roomForLargeText()
            assertEquals("nothing at ${scale}x", before, listOf(t.paddingLeft, t.paddingTop, t.paddingRight, t.paddingBottom))
        }
    }
}
