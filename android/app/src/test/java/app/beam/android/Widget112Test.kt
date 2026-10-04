package app.beam.android

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.ClipData
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Looper
import android.provider.MediaStore
import android.view.View
import android.widget.TextView
import androidx.core.view.isVisible
import androidx.recyclerview.widget.RecyclerView
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.Device
import app.beam.android.core.Item
import app.beam.android.core.Pairing
import app.beam.android.ui.BeamWidget
import app.beam.android.ui.MainActivity
import app.beam.android.ui.OpenActivity
import app.beam.android.ui.SendActivity
import app.beam.android.ui.ThreadActivity
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
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog
import java.io.File
import java.time.Duration

/**
 * The home-screen widget (Android 1.12): the newest thing received on this phone, live (one this phone sent doesn't
 * count; a deleted one gives way to the one before), Copy for a text, a photo's preview, a tap that opens it; Send
 * clipboard and Send a photo (the photo picker, then where to); signed out, "Sign in to Beam".
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w412dp-h915dp")
class Widget112Test {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private val desk = "desk00000001"
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
        app.unpair()
        fake?.close()
    }

    private fun me() = app.prefs.deviceId
    private fun text(id: String, t: String, ago: Long) =
        Item(id, "text", t, false, t.length, null, 0, null, desk, "Desk", listOf(me()), emptyMap(), now - ago)
    private fun photo(id: String, name: String, ago: Long) =
        Item(id, "file", null, false, 0, name, 300_000, "image/jpeg", desk, "Desk", listOf(me()), emptyMap(), now - ago, thumb = true)
    private fun mine(id: String, t: String, ago: Long) =
        Item(id, "text", t, false, t.length, null, 0, null, me(), "Link Phone", listOf(desk), emptyMap(), now - ago)

    private fun online(vararg items: Item): FakeBeam {
        val f = FakeBeam(listOf("stream-modes", "forward")).also { fake = it }
        f.devices = JSONArray().put(Device(desk, "Desk", "windows", true, now).toJson())
        f.items = items.map { it.toJson() }
        app.completePairing(Pairing.Link(f.url, "k"), "Widget Phone", "fakebeam03")
        app.connection.acquire("service")
        idleUntil("connected, with the items") { app.repo.state.value.info != null && app.repo.state.value.items.size == items.size }
        return f
    }

    private val manager get() = AppWidgetManager.getInstance(app)
    private fun widget(id: Int): View = shadowOf(manager).getViewFor(id)
    private fun textOf(id: Int, view: Int) = widget(id).findViewById<TextView>(view).text.toString()
    private fun shown() = BeamWidget.Shown.of(app, app.repo.state.value, app.prefs.localFiles.value)

    @Test
    fun showsTheNewestThingReceivedLiveWithCopyAndOpensIt() {
        val f = online(mine("w000000000000003", "sent from this phone", 10_000), text("w000000000000002", "the newest words for me", 60_000), text("w000000000000001", "older words", 120_000))
        val id = shadowOf(manager).createWidget(BeamWidget::class.java, R.layout.widget_beam)
        idleUntil("drawn") { textOf(id, R.id.widgetText) == "the newest words for me" }
        assertTrue("from Desk, with the time", textOf(id, R.id.widgetFrom).startsWith("Desk · "))
        assertTrue("Copy, for a text", widget(id).findViewById<View>(R.id.widgetCopy).isVisible)
        assertFalse("no preview for a text", widget(id).findViewById<View>(R.id.widgetPreview).isVisible)

        // What the taps do: Copy as the notification's; the text in its conversation (the list behind it); the two sends.
        val taps = BeamWidget.taps(app, shown())
        val copy = taps.getValue(R.id.widgetCopy)
        assertTrue(copy.broadcast)
        assertEquals("app.beam.android.action.COPY", copy.intent.action)
        assertEquals("w000000000000002", copy.intent.getStringExtra("item"))
        assertEquals("the newest words for me", copy.intent.getStringExtra("text"))
        val open = taps.getValue(R.id.widgetLast)
        assertTrue(open.withList)
        assertEquals(ThreadActivity::class.java.name, open.intent.component?.className)
        assertEquals(desk, open.intent.getStringExtra("conversation"))
        assertEquals("w000000000000002", open.intent.getStringExtra("item"))
        assertEquals(SendActivity.CLIPBOARD_ALIAS, taps.getValue(R.id.widgetSendClipboard).intent.component?.className)
        assertEquals(SendActivity.ACTION_SEND_CLIPBOARD, taps.getValue(R.id.widgetSendClipboard).intent.action)
        assertEquals(SendActivity.CLIPBOARD_ALIAS, taps.getValue(R.id.widgetSendPhoto).intent.component?.className)
        assertEquals(SendActivity.ACTION_SEND_PHOTOS, taps.getValue(R.id.widgetSendPhoto).intent.action)

        // Something new arrives: drawn at once. Deleted: the one before is back.
        f.send("item", text("w000000000000004", "brand new", 0).toJson())
        idleUntil("the new one") { textOf(id, R.id.widgetText) == "brand new" }
        f.send("delete", JSONObject().put("id", "w000000000000004"))
        idleUntil("the one before, again") { textOf(id, R.id.widgetText) == "the newest words for me" }

        // Signed out: "Sign in to Beam", and every tap opens Beam.
        app.unpair()
        idleUntil("signed out") { textOf(id, R.id.widgetText) == app.getString(R.string.widget_signed_out) }
        assertFalse(widget(id).findViewById<View>(R.id.widgetCopy).isVisible)
        assertTrue(BeamWidget.taps(app, shown()).values.all { it.intent.component?.className == MainActivity::class.java.name })
    }

    @Test
    fun aPhotoShowsItsPreviewAndOpensTheSavedCopyOnceThereIsOne() {
        // The server's small thumbnail, as kept on the phone after the conversation showed it.
        val thumbs = File(app.cacheDir, "thumbs").apply { mkdirs() }
        File(thumbs, "w000000000000011.jpg").outputStream().use { Bitmap.createBitmap(64, 48, Bitmap.Config.ARGB_8888).compress(Bitmap.CompressFormat.JPEG, 80, it) }
        online(photo("w000000000000011", "beach.jpg", 30_000))
        val id = shadowOf(manager).createWidget(BeamWidget::class.java, R.layout.widget_beam)
        idleUntil("drawn") { textOf(id, R.id.widgetText).startsWith("beach.jpg · ") }
        idleUntil("its preview") { widget(id).findViewById<View>(R.id.widgetPreview).isVisible }
        assertFalse("no Copy for a file", widget(id).findViewById<View>(R.id.widgetCopy).isVisible)
        val before = BeamWidget.taps(app, shown()).getValue(R.id.widgetLast)
        assertEquals("not saved here yet: its place in the conversation", ThreadActivity::class.java.name, before.intent.component?.className)
        // Saved: a tap opens the saved copy, as the notification's Open does.
        val saved = Uri.parse("content://media/external/downloads/77")
        app.prefs.setLocalFile("w000000000000011", saved)
        val after = BeamWidget.taps(app, shown()).getValue(R.id.widgetLast)
        assertEquals(OpenActivity::class.java.name, after.intent.component?.className)
        assertEquals(saved, after.intent.data)
    }

    @Test
    fun nothingYet() {
        online()
        val id = shadowOf(manager).createWidget(BeamWidget::class.java, R.layout.widget_beam)
        idleUntil("drawn") { textOf(id, R.id.widgetText) == app.getString(R.string.widget_nothing) }
        assertFalse(widget(id).findViewById<View>(R.id.widgetCopy).isVisible)
    }

    @Test
    fun sendAPhotoPicksThenAsksWhereToAndSends() {
        online()
        val c = Robolectric.buildActivity(SendActivity::class.java, SendActivity.photosIntent(app)).setup()
        val picker = shadowOf(c.get()).nextStartedActivityForResult
        assertEquals("Android's photo picker", MediaStore.ACTION_PICK_IMAGES, picker.intent.action)
        val picked = Intent().apply {
            clipData = ClipData.newRawUri("", Uri.parse("content://media/picker/0/com.android.providers.media.photopicker/media/1"))
                .apply { addItem(ClipData.Item(Uri.parse("content://media/picker/0/com.android.providers.media.photopicker/media/2"))) }
        }
        shadowOf(c.get()).receiveResult(picker.intent, Activity.RESULT_OK, picked)
        idle(300)
        val sheet = ShadowDialog.getLatestDialog()
        assertTrue("then where to", sheet.isShowing)
        assertEquals(app.resources.getQuantityString(R.plurals.file_count, 2, 2), sheet.findViewById<TextView>(R.id.preview).text.toString())
        val targets = sheet.findViewById<RecyclerView>(R.id.targets)
        idleUntil("the devices") { targets.adapter?.itemCount ?: 0 >= 2 }
        targets.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(1600, View.MeasureSpec.AT_MOST))
        targets.layout(0, 0, 1080, 1600)
        val desk = (0 until targets.childCount).map { targets.getChildAt(it) }.first { it.findViewById<TextView>(R.id.title).text == "Desk" }
        desk.findViewById<View>(R.id.row).performClick()
        idle(300)
        val upload = generateSequence { shadowOf(app).nextStartedService }.firstOrNull { it.action == "app.beam.android.action.UPLOAD" }
        assertEquals("handed to the upload service", 2, upload?.clipData?.itemCount)
        assertEquals(listOf(this.desk), upload?.getStringArrayExtra("to")?.toList())
    }

    @Test
    fun onlyBeamItselfCanAskForPhotos() {
        online()
        val c = Robolectric.buildActivity(SendActivity::class.java, Intent(app, SendActivity::class.java).setAction(SendActivity.ACTION_SEND_PHOTOS)).setup()
        assertNull("no picker", shadowOf(c.get()).nextStartedActivityForResult)
        assertTrue(c.get().isFinishing)
    }
}
