package app.beam.android

import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Looper
import android.provider.MediaStore
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.Device
import app.beam.android.core.Item
import app.beam.android.core.Pairing
import app.beam.android.ui.GalleryActivity
import app.beam.android.ui.ThreadActivity
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.tabs.TabLayout
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
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
 * Picking several and the gallery (1.12): a message's menu → Select, taps pick more, the toolbar becomes the selection
 * bar (Copy joins the texts, Share sends the files in one share, Delete asks and deletes them all at once, Forward
 * sends each on, oldest first), Back ends it; a conversation's gallery shows photos and videos as tiles and other
 * files as a list, and a long-press there picks too.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36], qualifiers = "w412dp-h915dp")
class Gallery112Test {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private val desk = "desk00000001"
    private var thread: ActivityController<ThreadActivity>? = null
    private var gallery: ActivityController<GalleryActivity>? = null
    private var fake: FakeBeam? = null

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
        gallery?.let { it.pause().stop().destroy() }
        app.unpair()
        fake?.close()
    }

    private val now = System.currentTimeMillis()
    private fun me() = app.prefs.deviceId
    private fun text(id: String, from: String, t: String, ago: Long) =
        Item(id, "text", t, false, t.length, null, 0, null, from, if (from == me()) "Pick Phone" else "Desk", listOf(if (from == me()) desk else me()), emptyMap(), now - ago)
    private fun file(id: String, name: String, mime: String, ago: Long) =
        Item(id, "file", null, false, 0, name, 2000, mime, desk, "Desk", listOf(me()), emptyMap(), now - ago)

    /** Signed in to nothing reachable (offline), with [items] from or to Desk. */
    private fun offline(vararg items: Item) {
        app.completePairing(Pairing.Link("http://127.0.0.1:9", "k"), "Pick Phone")
        app.repo.onEvent("devices", JSONObject().put("devices", JSONArray().put(Device(desk, "Desk", "windows", true, now).toJson())).toString())
        for (i in items) app.repo.upsert(i)
    }

    /** Signed in to a FakeBeam that can delete several at once and forward, with [items] on it. */
    private fun online(vararg items: Item): FakeBeam {
        val f = FakeBeam(listOf("stream-modes", "bulk-delete", "forward")).also { fake = it }
        f.devices = JSONArray().put(Device(desk, "Desk", "windows", true, now).toJson()).put(Device("lap000000001", "Laptop", "windows", true, now).toJson())
        f.items = items.map { it.toJson() }
        app.completePairing(Pairing.Link(f.url, "k"), "Pick Phone", "fakebeam01")
        app.connection.acquire("service")
        idleUntil("connected, with the items") { app.repo.state.value.info != null && app.repo.state.value.items.size == items.size }
        return f
    }

    /** A copy of [item] saved on this phone (Downloads/Beam, as the app saves files). */
    private fun saved(item: Item): Uri {
        val uri = app.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, ContentValues().apply { put(MediaStore.MediaColumns.DISPLAY_NAME, item.name) })!!
        app.contentResolver.openOutputStream(uri)!!.use { it.write(byteArrayOf(1, 2, 3)) }
        app.prefs.setLocalFile(item.id, uri)
        return uri
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

    /** The message row showing [text] (a text) or [name] (a file). */
    private fun row(a: android.app.Activity, textOrName: String): View = rows(a).first {
        it.findViewById<TextView>(R.id.text)?.let { t -> t.isShown && t.text.startsWith(textOrName) } == true ||
            it.findViewById<TextView>(R.id.fileName)?.text == textOrName
    }

    private fun toolbar(a: android.app.Activity): MaterialToolbar = a.findViewById(R.id.toolbar)

    /** Long-press on a bubble → the item's menu → [label]. */
    private fun menuEntry(a: android.app.Activity, textOrName: String, label: String) {
        row(a, textOrName).findViewById<View>(R.id.bubble).performLongClick()
        idle(300)
        val entries = ShadowDialog.getLatestDialog().findViewById<LinearLayout>(R.id.entries)
        val entry = (0 until entries.childCount).map { entries.getChildAt(it) as TextView }.first { it.text.toString() == label }
        entry.performClick()
        idle(300)
        layout(a)
    }

    private fun tapPick(a: android.app.Activity, textOrName: String) {
        row(a, textOrName).performClick()
        idle(100)
        layout(a)
    }

    private fun picked(a: android.app.Activity, textOrName: String): Boolean {
        val r = row(a, textOrName)
        return r.findViewById<View>(R.id.pickCheck).isShown && r.isActivated
    }

    @Test
    fun aMessagesMenuStartsPickingTapsPickMoreAndBackEndsIt() {
        offline(text("t1", desk, "First from Desk", 60_000), text("t2", me(), "My reply", 30_000), file("f1", "report.pdf", "application/pdf", 10_000))
        val a = openThread()
        assertNotNull("the gallery's button", toolbar(a).menu.findItem(R.id.action_gallery))

        menuEntry(a, "First from Desk", "Select")
        assertEquals("1 selected", toolbar(a).title.toString())
        assertTrue("picked", picked(a, "First from Desk"))
        assertTrue("every message shows its check", rows(a).all { it.findViewById<View>(R.id.pickCheck)?.isShown != false })
        // The whole row takes the tap: a tap low on a tall bubble (a file card) picks it too.
        val file = row(a, "report.pdf")
        val down = android.os.SystemClock.uptimeMillis()
        val y = file.height - 6f
        file.dispatchTouchEvent(android.view.MotionEvent.obtain(down, down, android.view.MotionEvent.ACTION_DOWN, file.width / 3f, y, 0))
        file.dispatchTouchEvent(android.view.MotionEvent.obtain(down, down + 50, android.view.MotionEvent.ACTION_UP, file.width / 3f, y, 0))
        idle(100)
        layout(a)
        assertTrue("a tap at the bottom of the row picks it (and doesn't open the file)", picked(a, "report.pdf"))
        assertEquals("2 selected", toolbar(a).title.toString())
        tapPick(a, "report.pdf")
        assertFalse("not the others", picked(a, "My reply"))
        val menu = toolbar(a).menu
        assertTrue("Copy for texts", menu.findItem(R.id.pick_copy).isVisible)
        assertFalse("no Save without a file", menu.findItem(R.id.pick_save).isVisible)

        tapPick(a, "My reply")
        tapPick(a, "report.pdf")
        assertEquals("3 selected", toolbar(a).title.toString())
        assertTrue("Save with a file", toolbar(a).menu.findItem(R.id.pick_save).isVisible)
        tapPick(a, "report.pdf")
        assertEquals("tapped again: put back", "2 selected", toolbar(a).title.toString())
        assertFalse(picked(a, "report.pdf"))

        // Copy: their text, oldest first, a blank line between them.
        toolbar(a).menu.performIdentifierAction(R.id.pick_copy, 0)
        idleUntil("copied") { app.getSystemService(ClipboardManager::class.java).primaryClip != null }
        assertEquals("First from Desk\n\nMy reply", app.getSystemService(ClipboardManager::class.java).primaryClip!!.getItemAt(0).text.toString())

        // Back ends it: the conversation's own toolbar again, no checks.
        a.onBackPressedDispatcher.onBackPressed()
        idle(100)
        layout(a)
        assertEquals("Desk", toolbar(a).title.toString())
        assertNotNull(toolbar(a).menu.findItem(R.id.action_gallery))
        assertTrue("checks gone", rows(a).none { it.findViewById<View>(R.id.pickCheck)?.isShown == true })
        assertFalse("rows don't take taps any more", row(a, "My reply").isClickable)
    }

    @Test
    fun shareSendsThePickedFilesInOneShare() {
        val pdf = file("f1", "report.pdf", "application/pdf", 20_000)
        val png = file("f2", "photo.png", "image/png", 10_000)
        offline(pdf, png)
        val pdfUri = saved(pdf)
        val pngUri = saved(png)
        val a = openThread()
        menuEntry(a, "report.pdf", "Select")
        tapPick(a, "photo.png")
        shadowOf(a).clearNextStartedActivities()
        toolbar(a).menu.performIdentifierAction(R.id.pick_share, 0)
        idle(300)
        val chooser = shadowOf(a).nextStartedActivity
        assertEquals(Intent.ACTION_CHOOSER, chooser?.action)
        val send = chooser.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)!!
        assertEquals(Intent.ACTION_SEND_MULTIPLE, send.action)
        assertEquals("a PDF and a PNG: any type", "*/*", send.type)
        assertEquals("both, oldest first", listOf(pdfUri, pngUri), send.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java))
        assertTrue(send.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
    }

    @Test
    fun deleteAsksThenDeletesThemAllAtOnce() {
        val f = online(text("a000000000000001", desk, "one", 30_000), text("a000000000000002", desk, "two", 20_000), text("a000000000000003", desk, "three", 10_000))
        val a = openThread()
        menuEntry(a, "one", "Select")
        tapPick(a, "three")
        toolbar(a).menu.performIdentifierAction(R.id.pick_delete, 0)
        idle(200)
        val asked = ShadowDialog.getLatestDialog() as androidx.appcompat.app.AlertDialog
        assertTrue("asked first", asked.isShowing)
        asked.getButton(android.content.DialogInterface.BUTTON_POSITIVE).performClick()
        idleUntil("deleted on the server") { f.bulkDeletes.isNotEmpty() }
        assertEquals("one request, both ids", listOf(listOf("a000000000000001", "a000000000000003")), f.bulkDeletes.map { it.sorted() })
        idleUntil("gone here") { app.repo.state.value.items.map { it.id } == listOf("a000000000000002") }
        assertEquals("picking ended", "Desk", toolbar(a).title.toString())
    }

    @Test
    fun forwardSendsEachOnOldestFirst() {
        val f = online(text("b000000000000001", desk, "older", 30_000), text("b000000000000002", desk, "newer", 10_000))
        val a = openThread()
        menuEntry(a, "newer", "Select")
        tapPick(a, "older")
        toolbar(a).menu.performIdentifierAction(R.id.pick_forward, 0)
        idle(300)
        val sheet = ShadowDialog.getLatestDialog()
        assertEquals("2 messages", sheet.findViewById<TextView>(R.id.preview).text.toString())
        val targets = sheet.findViewById<RecyclerView>(R.id.targets)
        sheet.window!!.decorView.let { d ->
            d.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(2000, View.MeasureSpec.AT_MOST))
            d.layout(0, 0, d.measuredWidth, d.measuredHeight)
        }
        idle(100)
        val laptop = (0 until targets.childCount).map { targets.getChildAt(it) }.first { v -> texts(v).any { it == "Laptop" } }
        laptop.performClick()
        idleUntil("both forwarded") { f.forwards.size == 2 }
        assertEquals(listOf("b000000000000001" to listOf("lap000000001"), "b000000000000002" to listOf("lap000000001")), f.forwards.toList())
        assertEquals("picking ended", "Desk", toolbar(a).title.toString())
    }

    @Test
    fun theGalleryShowsPhotosAsTilesAndFilesAsAListAndPicksOnALongPress() {
        val photo = file("g1", "photo.png", "image/png", 40_000)
        val video = file("g2", "clip.mp4", "video/mp4", 30_000)
        val pdf = file("g3", "report.pdf", "application/pdf", 20_000)
        offline(photo, video, pdf, text("g4", desk, "not in the gallery", 10_000))
        val photoUri = saved(photo)
        androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().setInTouchMode(true)
        val g = Robolectric.buildActivity(GalleryActivity::class.java, GalleryActivity.intent(app, desk)).setup().also { gallery = it }
        val a = g.get()
        layout(a)
        idleUntil("tiles") { rows(a).size == 2 }
        assertEquals("Photos and files", toolbar(a).title.toString())
        assertEquals("Desk", toolbar(a).subtitle.toString())
        val tabs = a.findViewById<TabLayout>(R.id.tabs)
        assertEquals("Photos & videos · 2", tabs.getTabAt(0)!!.text.toString())
        assertEquals("Files · 1", tabs.getTabAt(1)!!.text.toString())
        // Newest first: the video, then the photo; square tiles.
        assertEquals(listOf("Video clip.mp4", "Photo photo.png"), rows(a).map { it.contentDescription.toString() })
        assertEquals(rows(a)[0].width, rows(a)[0].height)

        // A tap opens a saved photo.
        shadowOf(a).clearNextStartedActivities()
        rows(a)[1].performClick()
        idle(100)
        val opened = shadowOf(a).nextStartedActivity
        assertEquals(Intent.ACTION_VIEW, opened?.action)
        assertEquals(photoUri, opened?.data)

        // A long-press picks; then taps pick more; Back ends it.
        rows(a)[0].performLongClick()
        idle(100)
        layout(a)
        assertEquals("1 selected", toolbar(a).title.toString())
        assertTrue(rows(a)[0].isActivated)
        assertTrue("checks show", rows(a).all { it.findViewById<View>(R.id.check).isShown })
        rows(a)[1].performClick()
        idle(100)
        assertEquals("2 selected", toolbar(a).title.toString())
        assertTrue("Save for files", toolbar(a).menu.findItem(R.id.pick_save).isVisible)
        assertFalse("no Copy without a text", toolbar(a).menu.findItem(R.id.pick_copy).isVisible)
        a.onBackPressedDispatcher.onBackPressed()
        idle(100)
        layout(a)
        assertEquals("Photos and files", toolbar(a).title.toString())
        assertTrue(rows(a).none { it.isActivated })

        // Files: a list.
        tabs.getTabAt(1)!!.select()
        idle(100)
        layout(a)
        idleUntil("the files tab") { rows(a).size == 1 && rows(a)[0].findViewById<TextView>(R.id.name) != null }
        assertEquals("report.pdf", rows(a)[0].findViewById<TextView>(R.id.name).text.toString())
        assertTrue(rows(a)[0].findViewById<TextView>(R.id.meta).text.toString().startsWith("2.0 KB · Desk · "))
    }

    /** Pictures of the new screens to look at: build/screenshots/g112-*.png (NATIVE graphics draw them for real). */
    @Test
    fun screenshots() {
        val colors = listOf(0xFF1F7A8C to 0xFFBFDBF7, 0xFFE07A5F to 0xFFF2CC8F, 0xFF3D405B to 0xFF81B29A, 0xFFEF476F to 0xFFFFD166, 0xFF118AB2 to 0xFF06D6A0)
        val photos = colors.mapIndexed { i, _ -> file("p00000000000000$i", "PXL_2026100$i.jpg", "image/jpeg", 60_000L - i * 5_000) }
        offline(*(photos + listOf(text("p100000000000001", desk, "Photos from Saturday", 500), file("p100000000000002", "Receipt.pdf", "application/pdf", 1_000))).toTypedArray())
        for ((i, p) in photos.withIndex()) {
            val bmp = android.graphics.Bitmap.createBitmap(600, 450, android.graphics.Bitmap.Config.ARGB_8888)
            val c = android.graphics.Canvas(bmp)
            c.drawPaint(android.graphics.Paint().apply { shader = android.graphics.LinearGradient(0f, 0f, 600f, 450f, colors[i].first.toInt(), colors[i].second.toInt(), android.graphics.Shader.TileMode.CLAMP) })
            c.drawCircle(150f + i * 70f, 170f, 80f, android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = 0xB3FFFFFF.toInt() })
            // (Kept as the app keeps previews: decoded straight from the cache folder.)
            java.io.File(app.cacheDir, "thumbs").apply { mkdirs() }.resolve("${p.id}.jpg").outputStream().use { bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 90, it) }
        }
        androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().setInTouchMode(true)
        val g = Robolectric.buildActivity(GalleryActivity::class.java, GalleryActivity.intent(app, desk)).setup().also { gallery = it }
        val a = g.get()
        idleUntil("tiles with pictures") {
            layout(a)
            rows(a).size == 5 && rows(a).all { (it.findViewById<android.widget.ImageView>(R.id.image).drawable != null) }
        }
        shot(a, "gallery")
        rows(a)[1].performLongClick()
        rows(a)[3].performClick()
        idle(100)
        shot(a, "gallery-picking")
        a.onBackPressedDispatcher.onBackPressed()
        g.pause().stop().destroy()
        gallery = null

        val t = openThread()
        menuEntry(t, "Photos from Saturday", "Select")
        tapPick(t, "Receipt.pdf")
        shot(t, "thread-picking")
        assertTrue(java.io.File("build/screenshots/g112-thread-picking.png").length() > 0)
    }

    private fun shot(a: android.app.Activity, name: String) {
        layout(a)
        val root = a.window.decorView
        val bmp = android.graphics.Bitmap.createBitmap(root.width, root.height, android.graphics.Bitmap.Config.ARGB_8888)
        root.draw(android.graphics.Canvas(bmp))
        java.io.File("build/screenshots").apply { mkdirs() }.resolve("g112-$name.png").outputStream().use { bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun texts(v: View): List<String> = when (v) {
        is TextView -> listOf(v.text.toString())
        is android.view.ViewGroup -> (0 until v.childCount).flatMap { texts(v.getChildAt(it)) }
        else -> emptyList()
    }
}
