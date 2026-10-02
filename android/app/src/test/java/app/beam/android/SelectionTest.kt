package app.beam.android

import android.os.Looper
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.Device
import app.beam.android.core.Item
import app.beam.android.core.Pairing
import app.beam.android.ui.MessageAdapter
import app.beam.android.ui.ThreadActivity
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
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
 * Text in bubbles is selectable in place (1.2.1): a long-press on the text starts Android's selection with
 * Beam's Forward / Delete / More… in its toolbar; a tap outside it (or a scroll, or sending) ends it; receipts
 * don't disturb it; a long-press elsewhere on a bubble still opens the item's menu. No server needed.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE) // real text measurement: taps land on the right characters
@Config(sdk = [36], qualifiers = "w412dp-h915dp")
class SelectionTest {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private lateinit var thread: ActivityController<ThreadActivity>
    private val desk = "desk00000001"

    private fun idle(ms: Long = 50) = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ms))

    private fun idleUntil(what: String, timeoutMs: Long = 5_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            idle(20)
            if (condition()) return
            Thread.sleep(10)
        }
        throw AssertionError("timed out: $what [children=${list.childCount} adapterItems=${list.adapter?.itemCount} repoItems=${app.repo.state.value.items.size} loaded=${app.repo.state.value.loaded} me=${app.repo.state.value.me} listSize=${list.width}x${list.height} attached=${list.isAttachedToWindow} mode=${adapter.selectionActionMode}]")
    }

    @Before
    fun openConversation() {
        app.completePairing(Pairing.Link("http://127.0.0.1:9", "k"), "Selection Phone") // unreachable: offline
        val me = app.prefs.deviceId
        val now = System.currentTimeMillis()
        val devices = JSONArray().put(Device(desk, "Desk", "windows", true, now).toJson())
        app.repo.onEvent("devices", JSONObject().put("devices", devices).toString())
        fun text(id: String, from: String, to: String, t: String, ago: Long) =
            Item(id, "text", t, false, t.length, null, 0, null, from, if (from == me) "Selection Phone" else "Desk", listOf(to), emptyMap(), now - ago)
        app.repo.upsert(text("t1", desk, me, "Select part of this, or open https://example.com/x please", 60_000))
        app.repo.upsert(text("t2", me, desk, "My reply, waiting for its receipt", 30_000))
        app.repo.upsert(Item("f1", "file", null, false, 0, "report.pdf", 2000, "application/pdf", desk, "Desk", listOf(me), emptyMap(), now - 10_000))
        // Like a phone being touched: touch mode, and the window has the focus (text selection needs both).
        androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().setInTouchMode(true)
        thread = Robolectric.buildActivity(ThreadActivity::class.java, ThreadActivity.intent(app, desk)).setup()
        thread.windowFocusChanged(true)
        idle(500)
        layout()
        idleUntil("rows") { rows().size >= 3 }
    }

    @After
    fun close() {
        thread.pause().stop().destroy()
        app.unpair()
    }

    private val activity get() = thread.get()
    private val list get() = activity.findViewById<RecyclerView>(R.id.list)
    private val adapter get() = list.adapter as MessageAdapter

    private fun layout() {
        val decor = activity.window.decorView
        val w = decor.resources.displayMetrics.widthPixels
        val h = decor.resources.displayMetrics.heightPixels
        decor.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
        decor.layout(0, 0, w, h)
        idle(100)
    }

    private fun rows(): List<View> = (0 until list.childCount).map { list.getChildAt(it) }

    private fun bubbleWith(prefix: String): View = rows().first { it.findViewById<TextView>(R.id.text)?.text?.startsWith(prefix) == true }

    private fun textOf(prefix: String): TextView = bubbleWith(prefix).findViewById(R.id.text)

    /** Where [v]'s point ([dx], [dy] inside it) is on screen. */
    private fun onScreen(v: View, dx: Int, dy: Int): Pair<Float, Float> {
        val at = IntArray(2)
        v.getLocationOnScreen(at)
        return (at[0] + dx).toFloat() to (at[1] + dy).toFloat()
    }

    /** A finger on the touchscreen (Android only shows selection handles and toolbars for touch input). */
    private fun touch(action: Int, x: Float, y: Float, downTime: Long): MotionEvent =
        MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, x, y, 0).apply { source = InputDevice.SOURCE_TOUCHSCREEN }

    /** A real long-press on the first word of [tv], through the activity (as a finger would). */
    private fun longPressText(tv: TextView) {
        val (x, y) = onScreen(tv, tv.totalPaddingLeft + 12, tv.totalPaddingTop + tv.lineHeight / 2)
        val down = SystemClock.uptimeMillis()
        activity.dispatchTouchEvent(touch(MotionEvent.ACTION_DOWN, x, y, down))
        idle(ViewConfiguration.getLongPressTimeout() + 150L)
        activity.dispatchTouchEvent(touch(MotionEvent.ACTION_UP, x, y, down))
        idle(200)
        idleUntil("selection toolbar") { adapter.selectionActionMode != null }
    }

    private fun tap(x: Float, y: Float) {
        val down = SystemClock.uptimeMillis()
        activity.dispatchTouchEvent(touch(MotionEvent.ACTION_DOWN, x, y, down))
        activity.dispatchTouchEvent(touch(MotionEvent.ACTION_UP, x, y, down))
        idle(100)
    }

    @Test
    fun longPressOnTheTextSelectsItWithBeamsActionsInTheToolbar() {
        val tv = textOf("Select part")
        assertTrue(tv.isTextSelectable)
        longPressText(tv)
        assertTrue("text selected in place", tv.hasSelection())
        assertEquals("Select", tv.text.subSequence(tv.selectionStart, tv.selectionEnd).toString())
        val menu = adapter.selectionActionMode!!.menu
        assertNotNull("Android's Copy", menu.findItem(android.R.id.copy))
        assertEquals("Forward", menu.findItem(R.id.selection_forward)?.title?.toString())
        assertEquals("Delete", menu.findItem(R.id.selection_delete)?.title?.toString())
        assertEquals("More…", menu.findItem(R.id.selection_more)?.title?.toString())
        assertTrue("no item menu for a long-press on the text", ShadowDialog.getLatestDialog()?.isShowing != true)
    }

    @Test
    fun aTapOutsideTheSelectedTextClearsIt() {
        val tv = textOf("Select part")
        longPressText(tv)
        assertTrue(tv.hasSelection())
        // Below the last bubble, on the empty part of the list.
        val (x, y) = onScreen(list, list.width / 2, list.height - 4)
        tap(x, y)
        assertFalse("selection gone", tv.hasSelection())
        assertNull("toolbar gone", adapter.selectionActionMode)

        // Also a tap on another bubble.
        longPressText(tv)
        val other = bubbleWith("My reply")
        val (ox, oy) = onScreen(other, other.width / 2, 4)
        tap(ox, oy)
        assertFalse(tv.hasSelection())
        assertNull(adapter.selectionActionMode)
    }

    @Test
    fun sendingOrLeavingTheScreenClearsTheSelection() {
        val tv = textOf("Select part")
        longPressText(tv)
        activity.findViewById<EditText>(R.id.input).setText("typed while selecting")
        activity.findViewById<View>(R.id.send).performClick()
        idle()
        assertFalse(tv.hasSelection())
        assertNull(adapter.selectionActionMode)

        longPressText(tv)
        thread.pause()
        assertFalse(tv.hasSelection())
        assertNull(adapter.selectionActionMode)
        thread.resume()
    }

    @Test
    fun aReceiptDoesNotDisturbALiveSelection() {
        val tv = textOf("My reply")
        longPressText(tv)
        assertTrue(tv.hasSelection())
        val mode = adapter.selectionActionMode
        app.repo.onEvent("update", JSONObject().put("id", "t2").put("delivered", JSONObject().put(desk, System.currentTimeMillis())).toString())
        idleUntil("receipt applied") { app.repo.state.value.item("t2")?.delivered?.containsKey(desk) == true }
        idle(500)
        layout()
        assertTrue("same bubble", textOf("My reply") === tv)
        assertTrue("still selected", tv.hasSelection())
        assertTrue("same toolbar", adapter.selectionActionMode === mode)
    }

    @Test
    fun moreOpensTheItemMenuAndForwardOpensTheForwardSheet() {
        val tv = textOf("Select part")
        longPressText(tv)
        adapter.selectionActionMode!!.menu.performIdentifierAction(R.id.selection_more, 0)
        idle(300)
        assertFalse(tv.hasSelection())
        val sheet = ShadowDialog.getLatestDialog()
        val entries = sheet.findViewById<LinearLayout>(R.id.entries)
        val labels = (0 until entries.childCount).map { (entries.getChildAt(it) as TextView).text.toString() }
        assertTrue(labels.toString(), labels.containsAll(listOf("Copy", "Select text", "Open link", "Share", "Delete")))
        sheet.dismiss()

        longPressText(tv)
        adapter.selectionActionMode!!.menu.performIdentifierAction(R.id.selection_forward, 0)
        idle(300)
        assertEquals("Forward to…", ShadowDialog.getLatestDialog().findViewById<TextView>(R.id.title).text.toString())
    }

    @Test
    fun aLongPressOnTheBubbleOutsideTheTextOpensTheItemMenu() {
        // The padding / time row of a text bubble.
        bubbleWith("Select part").findViewById<View>(R.id.bubble).performLongClick()
        idle(300)
        val entries = ShadowDialog.getLatestDialog().findViewById<LinearLayout>(R.id.entries)
        val labels = (0 until entries.childCount).map { (entries.getChildAt(it) as TextView).text.toString() }
        assertTrue(labels.toString(), labels.containsAll(listOf("Copy", "Select text")))
        assertNull("no selection", adapter.selectionActionMode)
        ShadowDialog.getLatestDialog().dismiss()

        // A file bubble.
        val file = rows().first { it.findViewById<TextView>(R.id.fileName)?.text == "report.pdf" }
        file.findViewById<View>(R.id.bubble).performLongClick()
        idle(300)
        val fileEntries = ShadowDialog.getLatestDialog().findViewById<LinearLayout>(R.id.entries)
        val fileLabels = (0 until fileEntries.childCount).map { (fileEntries.getChildAt(it) as TextView).text.toString() }
        assertTrue(fileLabels.toString(), fileLabels.containsAll(listOf("Open", "Share", "Delete")))
    }

    @Test
    fun linksInTheTextStayTappable() {
        val tv = textOf("Select part")
        val link = "https://example.com/x"
        val start = tv.text.indexOf(link)
        // A point on the link, found the way the TextView itself maps touches to characters.
        var point: Pair<Int, Int>? = null
        loop@ for (y in 0 until tv.height step 4) {
            for (x in 0 until tv.width step 4) {
                val offset = tv.getOffsetForPosition(x.toFloat(), y.toFloat())
                if (offset in start + 2 until start + link.length - 2) {
                    point = x to y
                    break@loop
                }
            }
        }
        val (x, y) = checkNotNull(point) { "no point on the link" }
        val (sx, sy) = onScreen(tv, x, y)
        shadowOf(activity).clearNextStartedActivities()
        tap(sx, sy) // one tap, as on a phone
        val opened = shadowOf(activity).nextStartedActivity
        assertEquals("android.intent.action.VIEW", opened?.action)
        assertEquals(link, opened?.data?.toString())
        assertFalse("a tap on a link selects nothing", tv.hasSelection())
    }
}
