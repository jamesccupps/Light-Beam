package app.beam.android

import android.os.Looper
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.Device
import app.beam.android.core.Item
import app.beam.android.core.Pairing
import app.beam.android.ui.ThreadActivity
import com.google.android.material.chip.Chip
import com.google.android.material.chip.ChipGroup
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
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog
import java.time.Duration

/**
 * Replies, reactions and edits (1.11.0; server 1.14 `replies`, `reactions`, `edit`): Reply in a message's sheet shows
 * the bar and sends the reply with what it answers, whose bubble quotes it; the quick reactions on top of the sheet
 * and a tap on a chip turn this phone's on and off, and another device's arrives live; Edit puts the words in the box
 * and saves them, and the bubble says edited.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w412dp-h915dp")
class Chat114Test {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private val desk = "desk00000001"
    private var thread: ActivityController<ThreadActivity>? = null
    private var fake: FakeBeam? = null
    private val now = System.currentTimeMillis()
    private val all = listOf("stream-modes", "replies", "reactions", "edit")

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

    private fun text(id: String, t: String, ago: Long) =
        Item(id, "text", t, false, t.length, null, 0, null, desk, "Desk", listOf(app.prefs.deviceId), emptyMap(), now - ago)

    private fun online(vararg items: Item): FakeBeam {
        val f = FakeBeam(all).also { fake = it }
        f.devices = JSONArray().put(Device(desk, "Desk", "windows", true, now).toJson())
        f.items = items.map { it.toJson() }
        app.completePairing(Pairing.Link(f.url, "k"), "Chat Phone", "fakebeam03")
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

    private fun row(a: android.app.Activity, text: String): View = rows(a).first {
        it.findViewById<TextView>(R.id.text)?.let { t -> t.isShown && t.text.startsWith(text) } == true
    }

    /** A long-press on the bubble → its sheet's entries. */
    private fun menu(a: android.app.Activity, text: String): List<TextView> {
        row(a, text).findViewById<View>(R.id.bubble).performLongClick()
        idle(300)
        val entries = ShadowDialog.getLatestDialog().findViewById<LinearLayout>(R.id.entries)
        return (0 until entries.childCount).mapNotNull { entries.getChildAt(it) as? TextView }
    }

    private fun chips(a: android.app.Activity, text: String): List<Chip> {
        val group = row(a, text).findViewById<ChipGroup>(R.id.reactions)
        return if (!group.isShown) emptyList() else (0 until group.childCount).map { group.getChildAt(it) as Chip }
    }

    @Test
    fun replyShowsTheBarAndSendsWhatItAnswersAndTheBubbleQuotesIt() {
        val f = online(text("c000000000000001", "Where are the keys?", 60_000))
        val a = openThread()
        menu(a, "Where are the keys?").first { it.text.toString() == "Reply" }.performClick()
        idle(200)
        val bar = a.findViewById<View>(R.id.replyBar)
        assertTrue("the bar", bar.isShown)
        assertTrue(a.findViewById<TextView>(R.id.replyBarText).text.toString().contains("Where are the keys?"))
        a.findViewById<EditText>(R.id.input).setText("On the hook")
        a.findViewById<View>(R.id.send).performClick()
        idleUntil("sent as a reply") { f.texts.isNotEmpty() }
        assertEquals("c000000000000001", f.texts[0].optString("reply"))
        idleUntil("the bar is gone") { !bar.isShown }
        layout(a)
        idleUntil("the reply's bubble quotes it") {
            layout(a)
            rows(a).any { r -> r.findViewById<TextView>(R.id.replyText)?.let { it.isShown && it.text.toString() == "Where are the keys?" } == true }
        }
    }

    @Test
    fun quickReactionsAndChipsTurnThisPhonesOnAndOffAndAnotherDevicesArriveLive() {
        val f = online(text("c000000000000002", "Dinner at 7?", 60_000))
        val a = openThread()
        row(a, "Dinner at 7?").findViewById<View>(R.id.bubble).performLongClick()
        idle(300)
        val quick = ShadowDialog.getLatestDialog().findViewById<LinearLayout>(R.id.quick)
        assertEquals("six quick reactions", 6, quick.childCount)
        quick.getChildAt(0).performClick() // 👍
        idleUntil("sent") { f.reactionCalls.isNotEmpty() }
        assertEquals(Triple("c000000000000002", "👍", true), f.reactionCalls[0])
        // The server's event: this phone's and the desk's.
        f.send("update", JSONObject().put("id", "c000000000000002").put("reactions", JSONObject().put("👍", JSONArray().put(app.repo.me).put(desk))))
        idleUntil("two, live") {
            layout(a)
            chips(a, "Dinner at 7?").map { it.text.toString() } == listOf("👍 2")
        }
        assertTrue("this phone's is checked", chips(a, "Dinner at 7?")[0].isChecked)
        chips(a, "Dinner at 7?")[0].performClick()
        idleUntil("taken back") { f.reactionCalls.size == 2 }
        assertEquals(Triple("c000000000000002", "👍", false), f.reactionCalls[1])
    }

    @Test
    fun editPutsTheWordsInTheBoxAndTheBubbleSaysEdited() {
        val f = online(text("c000000000000003", "See you at 7", 60_000))
        val a = openThread()
        val input = a.findViewById<EditText>(R.id.input)
        input.setText("a draft")
        menu(a, "See you at 7").first { it.text.toString() == "Edit" }.performClick()
        idleUntil("in the box") { input.text.toString() == "See you at 7" }
        assertTrue("the bar says editing", a.findViewById<TextView>(R.id.replyBarText).text.toString().startsWith("Editing"))
        input.setText("See you at 7:30")
        a.findViewById<View>(R.id.send).performClick()
        idleUntil("saved") { f.edits.isNotEmpty() }
        assertEquals("c000000000000003" to "See you at 7:30", f.edits[0])
        idleUntil("shown, edited") {
            layout(a)
            rows(a).any { r -> r.findViewById<TextView>(R.id.text)?.text?.toString() == "See you at 7:30" && r.findViewById<TextView>(R.id.meta).text.contains("edited") }
        }
        assertEquals("the draft comes back", "a draft", input.text.toString())
    }
}
