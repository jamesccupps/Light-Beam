package app.beam.android

import android.content.Intent
import android.graphics.Paint
import android.os.Looper
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.widget.Toolbar
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.recyclerview.widget.RecyclerView
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.Conversations
import app.beam.android.core.Device
import app.beam.android.core.Item
import app.beam.android.core.Pairing
import app.beam.android.notify.Shortcuts
import app.beam.android.ui.MainActivity
import app.beam.android.ui.SendActivity
import app.beam.android.ui.ThreadActivity
import org.json.JSONArray
import org.json.JSONObject
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
 * Notes (1.20.0, server 1.34 `notes`): a message to the device it was sent from. The Notes thread shows this phone's and
 * the desk's notes (the desk's says where it came from), sends to this phone itself, has Done in a note's sheet (and
 * the desk ticking one off arrives live); "Save to Notes" on a message forwards it to this phone; the share sheet's
 * Notes sends there.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w412dp-h915dp")
class Notes120Test {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private val desk = "desk00000020"
    private var thread: ActivityController<ThreadActivity>? = null
    private var send: ActivityController<SendActivity>? = null
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
        send?.let { it.pause().stop().destroy() }
        ShadowDialog.getLatestDialog()?.dismiss()
        app.unpair()
        fake?.close()
    }

    private fun text(id: String, t: String, from: String, to: List<String>, ago: Long) =
        Item(id, "text", t, false, t.length, null, 0, null, from, if (from == desk) "Desk" else "Notes Phone", to, emptyMap(), now - ago)

    private fun online(vararg items: Item): FakeBeam {
        val me = app.prefs.deviceId
        val f = FakeBeam(listOf("stream-modes", "notes", "forward", "replies", "edit")).also { fake = it }
        f.devices = JSONArray().put(Device(desk, "Desk", "windows", true, now).toJson()).put(Device(me, "Notes Phone", "android", true, now).toJson())
        f.items = items.map { it.toJson() }
        app.completePairing(Pairing.Link(f.url, "k"), "Notes Phone", "fakebeam20")
        app.connection.acquire("service")
        idleUntil("connected, with the items") { app.repo.state.value.info != null && app.repo.state.value.items.size == items.size }
        return f
    }

    private fun openNotes(): ThreadActivity {
        androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().setInTouchMode(true)
        val t = Robolectric.buildActivity(ThreadActivity::class.java, ThreadActivity.intent(app, Conversations.NOTES)).setup().also { thread = it }
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

    private fun menu(a: android.app.Activity, text: String): List<TextView> {
        row(a, text).findViewById<View>(R.id.bubble).performLongClick()
        idle(300)
        val entries = ShadowDialog.getLatestDialog().findViewById<LinearLayout>(R.id.entries)
        return (0 until entries.childCount).mapNotNull { entries.getChildAt(it) as? TextView }
    }

    @Test
    fun theNotesThreadShowsEveryNoteSendsToThisPhoneAndTicksThemOff() {
        val me = app.prefs.deviceId
        val f = online(
            text("n000000000000001", "Buy milk", desk, listOf(desk), 60_000),
            text("n000000000000002", "Call the bank", me, listOf(me), 50_000),
            text("m000000000000003", "Hello from the desk", desk, listOf(me), 40_000),
        )
        assertTrue("the Beam keeps notes", app.repo.state.value.notesOn)
        val a = openNotes()
        assertEquals("Notes", a.findViewById<Toolbar>(R.id.toolbar).title.toString())
        assertEquals("Write a note", a.findViewById<EditText>(R.id.input).hint.toString())
        val shown = rows(a).mapNotNull { it.findViewById<TextView>(R.id.text)?.takeIf { t -> t.isShown }?.text?.toString() }
        assertEquals(listOf("Buy milk", "Call the bank"), shown)
        assertEquals("From Desk", row(a, "Buy milk").findViewById<TextView>(R.id.sender).text.toString())
        assertFalse("no tick on a note", row(a, "Call the bank").findViewById<View>(R.id.statusIcon).isShown)

        // a note written here goes to this phone itself
        a.findViewById<EditText>(R.id.input).setText("Pick up the keys")
        a.findViewById<View>(R.id.send).performClick()
        idleUntil("sent") { f.texts.isNotEmpty() }
        assertEquals(listOf(me), (0 until f.texts[0].getJSONArray("to").length()).map { f.texts[0].getJSONArray("to").getString(it) })

        // Done from the sheet (no Reply in Notes), then the desk ticking its own off arrives live
        val labels = menu(a, "Call the bank").map { it.text.toString() }
        assertTrue(labels.toString(), labels.containsAll(listOf("Done", "Send to…", "Delete")) && "Reply" !in labels && "Save to Notes" !in labels)
        menu(a, "Call the bank").first { it.text.toString() == "Done" }.performClick()
        idleUntil("ticked off") { f.dones.isNotEmpty() }
        assertEquals("n000000000000002" to true, f.dones[0])
        idleUntil("struck through") {
            layout(a)
            val r = row(a, "Call the bank")
            r.findViewById<TextView>(R.id.meta).text.contains("Done") && (r.findViewById<TextView>(R.id.text).paintFlags and Paint.STRIKE_THRU_TEXT_FLAG) != 0
        }
        f.send("update", JSONObject().put("id", "n000000000000001").put("done", true))
        idleUntil("the desk's, live") {
            layout(a)
            row(a, "Buy milk").findViewById<TextView>(R.id.meta).text.contains("Done")
        }
    }

    @Test
    fun saveToNotesForwardsAMessageToThisPhone() {
        val me = app.prefs.deviceId
        val f = online(text("m000000000000004", "The door code is 4471", desk, listOf(me), 40_000))
        androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().setInTouchMode(true)
        val t = Robolectric.buildActivity(ThreadActivity::class.java, ThreadActivity.intent(app, desk)).setup().also { thread = it }
        t.windowFocusChanged(true)
        layout(t.get())
        idleUntil("rows") { rows(t.get()).isNotEmpty() }
        val save = menu(t.get(), "The door code").first { it.text.toString() == "Save to Notes" }
        save.performClick()
        idleUntil("forwarded") { f.forwards.isNotEmpty() }
        assertEquals("m000000000000004" to listOf(me), f.forwards[0])
    }

    @Test
    fun theShareSheetsNotesSendsToThisPhone() {
        val me = app.prefs.deviceId
        val f = online()
        val share = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "a link for later")
            .putExtra(ShortcutManagerCompat.EXTRA_SHORTCUT_ID, Shortcuts.idFor(Conversations.NOTES))
        val s = Robolectric.buildActivity(SendActivity::class.java, share).setup().also { send = it }
        idle(300)
        val sheet = ShadowDialog.getLatestDialog()
        assertTrue("the sheet", sheet != null && sheet.isShowing)
        sheet.findViewById<View>(R.id.send).performClick()
        idleUntil("sent to Notes") { f.texts.isNotEmpty() }
        assertEquals("a link for later", f.texts[0].optString("text"))
        assertEquals(listOf(me), (0 until f.texts[0].getJSONArray("to").length()).map { f.texts[0].getJSONArray("to").getString(it) })
        idleUntil("finished") { s.get().isFinishing }
    }

    @Test
    fun theListHasNotesUnderAllDevices() {
        val me = app.prefs.deviceId
        online(text("n000000000000005", "Buy milk", me, listOf(me), 60_000))
        val m = Robolectric.buildActivity(MainActivity::class.java).setup()
        try {
            layout(m.get())
            idleUntil("the rows") {
                layout(m.get())
                rows(m.get()).size >= 3
            }
            val titles = rows(m.get()).map { it.findViewById<TextView>(R.id.title).text.toString() }
            assertEquals(listOf("All devices", "Notes", "Desk"), titles.take(3))
            assertEquals("Buy milk", rows(m.get())[1].findViewById<TextView>(R.id.preview).text.toString())
        } finally {
            m.pause().stop().destroy()
        }
    }
}
