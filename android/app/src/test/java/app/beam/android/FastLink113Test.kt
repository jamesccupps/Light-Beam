package app.beam.android

import android.content.ClipboardManager
import android.content.DialogInterface
import android.os.Looper
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.recyclerview.widget.RecyclerView
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.Device
import app.beam.android.core.Item
import app.beam.android.core.Pairing
import app.beam.android.ui.ThreadActivity
import org.json.JSONArray
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog
import java.time.Duration

/**
 * Fast links (1.10.0; server 1.13 `fast-links`): a file's menu has "Fast link" when the server makes them (a text's
 * doesn't, nor a server without them); how long is chosen first, then the server is asked, and the link is copied and
 * shown with Copy and Share.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w412dp-h915dp")
class FastLink113Test {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private val desk = "desk00000001"
    private var thread: ActivityController<ThreadActivity>? = null
    private var fake: FakeBeam? = null
    private val now = System.currentTimeMillis()

    private fun idle(ms: Long = 50) = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ms))

    private fun idleUntil(what: String, timeoutMs: Long = 8_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            idle(20)
            if (condition()) return
            Thread.sleep(10)
        }
        throw AssertionError("timed out: $what")
    }

    @After
    fun close() {
        thread?.let { it.pause().stop().destroy() }
        app.unpair()
        fake?.close()
    }

    private fun me() = app.prefs.deviceId
    private fun text(id: String, t: String, ago: Long) =
        Item(id, "text", t, false, t.length, null, 0, null, desk, "Desk", listOf(me()), emptyMap(), now - ago)
    private fun file(id: String, name: String, ago: Long) =
        Item(id, "file", null, false, 0, name, 2000, "application/octet-stream", desk, "Desk", listOf(me()), emptyMap(), now - ago)

    private fun online(features: List<String>, vararg items: Item): FakeBeam {
        val f = FakeBeam(features).also { fake = it }
        f.devices = JSONArray().put(Device(desk, "Desk", "windows", true, now).toJson())
        f.items = items.map { it.toJson() }
        app.completePairing(Pairing.Link(f.url, "k"), "Link Phone", "fakebeam02")
        app.connection.acquire("service")
        idleUntil("connected, with the items") { app.repo.state.value.info != null && app.repo.state.value.items.size == items.size }
        return f
    }

    private fun openThread(): ThreadActivity {
        androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().setInTouchMode(true)
        val t = Robolectric.buildActivity(ThreadActivity::class.java, ThreadActivity.intent(app, desk)).setup().also { thread = it }
        t.windowFocusChanged(true)
        layout(t.get())
        idleUntil("rows") { rows(t.get()).isNotEmpty() }
        return t.get()
    }

    private fun layout(a: android.app.Activity) {
        idle(100)
        val decor = a.window.decorView
        val w = decor.resources.displayMetrics.widthPixels
        val h = decor.resources.displayMetrics.heightPixels
        decor.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
        decor.layout(0, 0, w, h)
        idle(100)
    }

    private fun rows(a: android.app.Activity): List<View> {
        val list = a.findViewById<RecyclerView>(R.id.list)
        return (0 until list.childCount).map { list.getChildAt(it) }
    }

    private fun row(a: android.app.Activity, textOrName: String): View = rows(a).first {
        it.findViewById<TextView>(R.id.text)?.let { t -> t.isShown && t.text.startsWith(textOrName) } == true ||
            it.findViewById<TextView>(R.id.fileName)?.text == textOrName
    }

    /** A long-press on the bubble → its menu's entries (TextViews). */
    private fun menu(a: android.app.Activity, textOrName: String): List<TextView> {
        row(a, textOrName).findViewById<View>(R.id.bubble).performLongClick()
        idle(300)
        val entries = ShadowDialog.getLatestDialog().findViewById<LinearLayout>(R.id.entries)
        return (0 until entries.childCount).map { entries.getChildAt(it) as TextView }
    }

    private fun labels(a: android.app.Activity, textOrName: String): List<String> {
        val list = menu(a, textOrName).map { it.text.toString() }
        ShadowDialog.getLatestDialog().dismiss()
        idle(100)
        return list
    }

    @Test
    fun aFilesMenuMakesAFastLinkForTheChosenTimeCopiesAndShowsIt() {
        val f = online(listOf("stream-modes", "forward", "fast-links"), file("l000000000000001", "trip.bin", 60_000), text("l000000000000002", "just words", 30_000))
        val a = openThread()
        assertTrue("a file's menu", labels(a, "trip.bin").contains("Fast link"))
        assertFalse("not a text's", labels(a, "just words").contains("Fast link"))

        menu(a, "trip.bin").first { it.text.toString() == "Fast link" }.performClick()
        idle(300)
        val choose = ShadowDialog.getLatestDialog() as AlertDialog
        val list = choose.listView
        list.performItemClick(list.adapter.getView(2, null, list), 2, 2) // for a week
        choose.getButton(DialogInterface.BUTTON_POSITIVE).performClick()
        val url = "https://family.example.ts.net:8443/f/" + "a".repeat(32)
        idleUntil("the link shown") {
            (ShadowDialog.getLatestDialog() as? AlertDialog)?.findViewById<TextView>(android.R.id.message)?.text?.startsWith(url) == true
        }
        assertEquals(listOf("l000000000000001" to 168), f.fastLinks.toList())
        assertEquals("copied at once", url, app.getSystemService(ClipboardManager::class.java).primaryClip?.getItemAt(0)?.text?.toString())
    }

    @Test
    fun noFastLinkFromAServerWithoutThem() {
        online(listOf("stream-modes", "forward"), file("l000000000000003", "trip.bin", 60_000))
        val a = openThread()
        assertFalse(labels(a, "trip.bin").contains("Fast link"))
    }
}
