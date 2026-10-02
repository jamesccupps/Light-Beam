package app.beam.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageInstaller
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.net.Uri
import android.os.Looper
import android.provider.MediaStore
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.EditText
import android.widget.TextView
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.BeamApi
import app.beam.android.core.CallHolder
import app.beam.android.core.Device
import app.beam.android.core.Item
import app.beam.android.core.ChunkBody
import app.beam.android.core.EventStream
import app.beam.android.core.Pairing
import app.beam.android.core.SignInClient
import app.beam.android.core.TestNet
import app.beam.android.data.AppUpdater
import app.beam.android.data.Outbox
import app.beam.android.data.Repository
import app.beam.android.data.TransferManager
import app.beam.android.service.InstallReceiver
import app.beam.android.ui.ApproveActivity
import app.beam.android.ui.ForwardSheet
import app.beam.android.ui.MainActivity
import app.beam.android.ui.PairActivity
import app.beam.android.ui.PairQr
import app.beam.android.ui.Row
import app.beam.android.ui.SearchActivity
import app.beam.android.ui.SendActivity
import app.beam.android.ui.SettingsActivity
import app.beam.android.ui.ThreadActivity
import app.beam.android.ui.UpdateActivity
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog
import java.io.ByteArrayOutputStream
import java.io.File
import java.time.Duration
import kotlin.concurrent.thread

/**
 * Renders every screen to PNGs (light, dark and 200 % font) with realistic data from a fresh scratch
 * server, for eyeballing the layout without a device. Fake system bars are drawn on top (magenta: status
 * bar, cyan: gesture bar, grey: keyboard) to check edge-to-edge insets. Skipped unless BEAM_SHOTS_URL/KEY
 * are set; the PNGs land in build/screenshots.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ScreenshotTest {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private val url = System.getProperty("beam.shots.url").orEmpty()
    private val key = System.getProperty("beam.shots.key").orEmpty()
    private val outDir = File(System.getProperty("beam.shots.dir") ?: "build/screenshots")
    private var prefix = ""

    @Test
    @Config(sdk = [36], qualifiers = "w412dp-h915dp-xhdpi")
    fun light() = shoot("light")

    @Test
    @Config(sdk = [36], qualifiers = "w412dp-h915dp-night-xhdpi")
    fun dark() = shoot("dark")

    @Test
    @Config(sdk = [36], qualifiers = "w412dp-h915dp-xhdpi")
    fun font200() {
        RuntimeEnvironment.setFontScale(2.0f)
        shoot("font200")
    }

    /** Cold start while the server can't be reached: the saved copy shows, with the reason and what to do. */
    @Test
    @Config(sdk = [36], qualifiers = "w412dp-h915dp-xhdpi")
    fun offline() {
        prefix = "offline"
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        app.completePairing(Pairing.Link("http://127.0.0.1:${TestNet.freePort()}", "whatever"), "Pixel 9 Pro XL")
        // What the phone saw last time (normally saved by the app itself).
        val me = app.prefs.deviceId
        val desk = Device("offlinedesk01", "Robin’s Desktop", "windows", false, System.currentTimeMillis() - 3_600_000)
        val t0 = System.currentTimeMillis() - 7_200_000
        fun text(id: String, from: String, to: List<String>, t: String, dt: Long) =
            Item(id, "text", t, false, t.length, null, 0, null, from, "Robin’s Desktop", to, emptyMap(), t0 + dt)
        app.repo.onEvent("devices", org.json.JSONObject().put("devices", org.json.JSONArray().put(desk.toJson())).toString())
        app.repo.upsert(text("off1", desk.id, listOf(me), "The door code is 4471", 0))
        app.repo.upsert(text("off2", me, listOf(desk.id), "Thanks!", 60_000))
        val main = Robolectric.buildActivity(MainActivity::class.java).setup()
        val deadline = System.currentTimeMillis() + 7000
        while (System.currentTimeMillis() < deadline) {
            idle(100)
            Thread.sleep(50)
        }
        save(main.get().window.decorView, "01-conversations-offline")
        main.pause().stop().destroy()
    }

    // ------------------------------------------------------------------ helpers

    private fun idle(ms: Long = 200) = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ms))

    private fun until(what: String, timeoutMs: Long = 20_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            idle(50)
            if (condition()) return
            Thread.sleep(40)
        }
        throw AssertionError("timed out: $what")
    }

    private fun dp(v: Int) = (v * app.resources.displayMetrics.density).toInt()

    private fun device(name: String, platform: String, id: String) = TestNet.device(url, key, name, platform, id = id).also { it.me() }

    /** Starts every run from an empty server: no items, no devices. */
    private fun resetServer() {
        val admin = TestNet.device(url, key, "admin", "cli", id = "shotadmin0001")
        admin.execute(admin.request(admin.url("/api/items")).delete().build()).close()
        // Itself last: every request registers the caller again.
        for (d in admin.devices().devices.sortedBy { it.id == admin.deviceId }) admin.execute(admin.request(admin.url("/api/devices/" + d.id)).delete().build()).close()
    }

    private fun upload(from: BeamApi, name: String, mime: String, bytes: ByteArray, to: List<String>) {
        val info = from.createUpload(name, bytes.size.toLong(), mime, to)
        from.putChunk(info.id, 0, ChunkBody(bytes.inputStream(), bytes.size.toLong()) {}, CallHolder())
    }

    private fun picture(w: Int, h: Int, a: Int, b: Int): ByteArray {
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        c.drawPaint(Paint().apply { shader = LinearGradient(0f, 0f, 0f, h.toFloat(), a, b, Shader.TileMode.CLAMP) })
        c.drawCircle(w / 2f, h * 0.68f, h * 0.2f, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(255, 214, 120) })
        c.drawRect(0f, h * 0.77f, w.toFloat(), h.toFloat(), Paint().apply { color = Color.rgb(40, 36, 90) })
        return ByteArrayOutputStream().also { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    }

    private fun fakeInsets(root: View, ime: Int) {
        val b = WindowInsetsCompat.Builder()
            .setInsets(WindowInsetsCompat.Type.statusBars(), Insets.of(0, dp(STATUS), 0, 0))
            .setInsets(WindowInsetsCompat.Type.navigationBars(), Insets.of(0, 0, 0, dp(NAV)))
            .setVisible(WindowInsetsCompat.Type.statusBars(), true)
            .setVisible(WindowInsetsCompat.Type.navigationBars(), true)
        if (ime > 0) b.setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, dp(ime))).setVisible(WindowInsetsCompat.Type.ime(), true)
        ViewCompat.dispatchApplyWindowInsets(root, b.build())
    }

    /** Draws [root] (plus an optional dialog window on top) with fake system bars, and saves a PNG. */
    private fun save(root: View, name: String, overlay: View? = null, ime: Int = 0, fullHeight: View? = null) {
        val w = root.resources.displayMetrics.widthPixels
        var h = root.resources.displayMetrics.heightPixels
        if (fullHeight != null) {
            fullHeight.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
            h = maxOf(h, fullHeight.measuredHeight + dp(STATUS + NAV + 72))
        }
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        canvas.drawColor(Color.BLACK)
        for (v in listOfNotNull(root, overlay)) {
            // Alert dialogs wrap their content (centred); activities and bottom sheets fill the window.
            val lp = v.layoutParams as? WindowManager.LayoutParams
            val wraps = v !== root && lp?.height == ViewGroup.LayoutParams.WRAP_CONTENT
            repeat(2) {
                fakeInsets(v, ime)
                if (wraps) {
                    val widthSpec = if (lp?.width == ViewGroup.LayoutParams.MATCH_PARENT) View.MeasureSpec.EXACTLY else View.MeasureSpec.AT_MOST
                    v.measure(View.MeasureSpec.makeMeasureSpec(w, widthSpec), View.MeasureSpec.makeMeasureSpec(h - dp(STATUS + NAV), View.MeasureSpec.AT_MOST))
                    v.layout(0, 0, v.measuredWidth, v.measuredHeight)
                } else {
                    v.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
                    v.layout(0, 0, w, h)
                }
                idle(150)
            }
            if (v !== root) canvas.drawColor(Color.argb(0x66, 0, 0, 0)) // the dim behind a dialog
            canvas.save()
            if (wraps) canvas.translate((w - v.measuredWidth) / 2f, (h - v.measuredHeight) / 2f)
            v.draw(canvas)
            canvas.restore()
        }
        val paint = Paint()
        paint.color = 0x66FF00FF
        canvas.drawRect(0f, 0f, w.toFloat(), dp(STATUS).toFloat(), paint)
        if (ime > 0) {
            paint.color = 0xAA808080.toInt()
            canvas.drawRect(0f, (h - dp(ime)).toFloat(), w.toFloat(), h.toFloat(), paint)
        } else {
            paint.color = 0x6600FFFF
            canvas.drawRect(0f, (h - dp(NAV)).toFloat(), w.toFloat(), h.toFloat(), paint)
        }
        outDir.mkdirs()
        File(outDir, "$prefix-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Suppress("UNCHECKED_CAST")
    private fun <T> field(o: Any, name: String): T = o.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(o) as T

    // ------------------------------------------------------------------ the run

    private fun shoot(theme: String) {
        assumeTrue("Set BEAM_SHOTS_URL and BEAM_SHOTS_KEY", url.isNotEmpty() && key.isNotEmpty())
        prefix = theme
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        FakeMediaStore.reset()
        Robolectric.setupContentProvider(FakeMediaStore::class.java, MediaStore.AUTHORITY)
        Robolectric.setupContentProvider(TestFiles::class.java, TestFiles.AUTHORITY)
        resetServer()

        // ---- Signing in.
        val pair = Robolectric.buildActivity(PairActivity::class.java).setup()
        idle(300)
        save(pair.get().window.decorView, "01-pair")
        pair.pause().stop().destroy()

        app.completePairing(Pairing.parse(Pairing.link(url, key))!!, "Pixel 9 Pro XL")
        val me = app.prefs.deviceId
        val phone = BeamApi(url, key, me, "Pixel 9 Pro XL", "android").also { it.me() }
        val main = Robolectric.buildActivity(MainActivity::class.java).setup()
        until("connected + baseline") { app.repo.state.value.let { it.loaded && it.conn == Repository.Conn.CONNECTED } && app.prefs.baselineDone }

        val desktop = device("Robin’s Desktop", "windows", "shotdesktop01")
        val mac = device("MacBook Air", "mac", "shotmacbook01")
        val tablet = device("Galaxy Tab S9", "android", "shottablet001")
        val online = EventStream(desktop)
        thread(isDaemon = true) {
            try {
                online.run(object : EventStream.Listener {
                    override fun onOpen() {}
                    override fun onEvent(event: String, data: String) {}
                })
            } catch (_: Exception) {
            }
        }
        mac.sendText("Dinner at 7? I'll bring dessert", emptyList())
        desktop.sendText("Here's the link for the booking: https://example.com/reservations/4821", listOf(me))
        phone.sendText("Thanks! Grabbing it now", listOf(desktop.deviceId))
        upload(desktop, "sunset.png", "image/png", picture(800, 520, Color.rgb(255, 140, 90), Color.rgb(90, 75, 240)), listOf(me))
        upload(desktop, "Q3 report final.pdf", "application/pdf", ByteArray(2_450_000) { (it % 251).toByte() }, listOf(me))
        desktop.sendText(
            "Wi-Fi for the cabin:\nNetwork: LakeHouse-5G\nPassword: correct-horse-battery-staple\nOrder 1000755 arrives Friday; mail robin@example.com if it doesn't work.",
            listOf(me),
        )
        val log = buildString { var i = 0; while (length < 70_000) append("2026-09-30 10:00:${(i++ % 60).toString().padStart(2, '0')} INFO request id=${1_000_000 + i} done\n") }
        desktop.sendText(log, listOf(me))
        app.prefs.maxDownloadMb = 1 // "too big" to download automatically
        upload(desktop, "holiday-video.mp4", "video/mp4", ByteArray(3_200_000) { (it % 13).toByte() }, listOf(me))
        mac.sendText("Can you send me the boarding pass?", listOf(me))
        tablet.sendText("Battery at 12%, charging now", emptyList())
        until("items") { app.repo.state.value.items.size >= 10 }
        until("auto-downloads", 30_000) { app.transfers.active.value == 0 }
        Thread.sleep(800)
        idle(1500)
        save(main.get().window.decorView, "02-conversations")

        // ---- The desktop conversation: text, links, a photo, files, a clamped log, and every transfer state.
        val uploads: MutableStateFlow<List<TransferManager.Upload>> = field(app.transfers, "_uploads")
        val downloads: MutableStateFlow<Map<String, TransferManager.Download>> = field(app.transfers, "_downloads")
        val video = app.repo.state.value.items.first { it.name == "holiday-video.mp4" }
        downloads.value = mapOf(video.id to TransferManager.Download(video.id, video.displayName, video.size, received = video.size * 35 / 100, status = TransferManager.Status.RUNNING))
        uploads.value = listOf(
            TransferManager.Upload("up1", Uri.parse("content://${TestFiles.AUTHORITY}/Screen recording.mp4"), "Screen recording 2026-09-30.mp4", 734_003_200, "video/mp4", listOf(desktop.deviceId), sent = 288_000_000, status = TransferManager.Status.PAUSED, serverId = "x"),
        )
        val outbox: MutableStateFlow<List<Outbox.Entry>> = field(app.outbox, "_entries")
        outbox.value = listOf(Outbox.Entry("o1", "On my way, see you at 7", listOf(desktop.deviceId), System.currentTimeMillis()))
        val thread = Robolectric.buildActivity(ThreadActivity::class.java, ThreadActivity.intent(app, desktop.deviceId)).setup()
        idle(1500)
        Thread.sleep(1500) // thumbnails decode on background threads
        idle(500)
        val list = thread.get().findViewById<RecyclerView>(R.id.list)
        save(thread.get().window.decorView, "03-thread")
        save(thread.get().window.decorView, "04-thread-full", fullHeight = list)
        thread.get().findViewById<EditText>(R.id.input).apply {
            setText("See you there")
            requestFocus()
        }
        idle(200)
        save(thread.get().window.decorView, "05-thread-keyboard", ime = 300)

        // Long-press on a text bubble: the item's menu. Then "Select text" and "Forward".
        val wifi = app.repo.state.value.items.first { it.text?.startsWith("Wi-Fi") == true }
        @Suppress("UNCHECKED_CAST")
        val rows = (list.adapter as ListAdapter<Row, *>).currentList
        val wifiRow = rows.indexOfFirst { it is Row.Msg && it.item.id == wifi.id }
        (list.layoutManager as LinearLayoutManager).scrollToPositionWithOffset(wifiRow, dp(120))
        thread.get().window.decorView.let { d ->
            d.measure(View.MeasureSpec.makeMeasureSpec(d.resources.displayMetrics.widthPixels, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(d.resources.displayMetrics.heightPixels, View.MeasureSpec.EXACTLY))
            d.layout(0, 0, d.resources.displayMetrics.widthPixels, d.resources.displayMetrics.heightPixels)
        }
        idle(300)
        val bubble = (0 until list.childCount).map { list.getChildAt(it) }
            .firstOrNull { it.findViewById<TextView>(R.id.text)?.text?.startsWith("Wi-Fi") == true }?.findViewById<View>(R.id.bubble)
        checkNotNull(bubble) { "the Wi-Fi bubble isn't on screen" }.performLongClick()
        idle(300)
        save(thread.get().window.decorView, "06-item-menu", ShadowDialog.getLatestDialog().window!!.decorView)
        ShadowDialog.getLatestDialog().dismiss()
        thread.get().showAll(wifi)
        idle(500)
        save(thread.get().window.decorView, "07-select-text", ShadowDialog.getLatestDialog().window!!.decorView)
        ShadowDialog.getLatestDialog().dismiss()
        ForwardSheet.show(thread.get(), wifi, list)
        idle(500)
        save(thread.get().window.decorView, "07b-forward", ShadowDialog.getLatestDialog().window!!.decorView)
        ShadowDialog.getLatestDialog().dismiss()
        uploads.value = emptyList()
        downloads.value = emptyMap()
        outbox.value = emptyList()
        thread.pause().stop().destroy()

        // ---- Search.
        val search = Robolectric.buildActivity(SearchActivity::class.java).setup()
        search.get().findViewById<EditText>(R.id.query).setText("boarding pass")
        idle(800)
        Thread.sleep(300)
        idle(300)
        save(search.get().window.decorView, "08-search")
        search.pause().stop().destroy()

        // ---- Share sheet with more devices than fit: the list scrolls, Send stays.
        for (i in 1..6) device("Old laptop $i", if (i % 2 == 0) "windows" else "android", "shotold0000$i")
        until("devices") { app.repo.state.value.devices.size >= 10 }
        TestFiles.file = File.createTempFile("shot", ".jpg").apply { writeBytes(picture(300, 200, Color.RED, Color.BLUE)); deleteOnExit() }
        val many = Intent(Intent.ACTION_SEND_MULTIPLE).setType("image/*").putParcelableArrayListExtra(
            Intent.EXTRA_STREAM,
            arrayListOf(Uri.parse("content://${TestFiles.AUTHORITY}/PXL_1.jpg"), Uri.parse("content://${TestFiles.AUTHORITY}/PXL_2.jpg")),
        )
        val send = Robolectric.buildActivity(SendActivity::class.java, many).setup()
        idle(800)
        val sheet = ShadowDialog.getLatestDialog()
        val targets = sheet.findViewById<RecyclerView>(R.id.targets)
        sheet.window!!.decorView.let { d ->
            d.measure(View.MeasureSpec.makeMeasureSpec(d.resources.displayMetrics.widthPixels, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(d.resources.displayMetrics.heightPixels, View.MeasureSpec.EXACTLY))
            d.layout(0, 0, d.resources.displayMetrics.widthPixels, d.resources.displayMetrics.heightPixels)
        }
        idle(200)
        targets.findViewHolderForAdapterPosition(1)?.itemView?.findViewById<View>(R.id.row)?.performLongClick()
        idle(300)
        save(send.get().window.decorView, "09-share-many-devices", sheet.window!!.decorView)
        sheet.setOnDismissListener(null)
        send.pause().stop().destroy()

        // ---- Approve a sign-in.
        // From its own (Tailscale-style) address, like a real laptop; withdrawn after the shot.
        val newLaptop = SignInClient(url, TestNet.client())
        val ticket = newLaptop.createRequest("Work Laptop", "windows")
        val approve = Robolectric.buildActivity(ApproveActivity::class.java, ApproveActivity.intent(app, ticket.code)).setup()
        until("approve sheet") { ShadowDialog.getLatestDialog()?.findViewById<TextView>(R.id.title)?.text?.contains("wants") == true }
        idle(500)
        save(approve.get().window.decorView, "10-approve", ShadowDialog.getLatestDialog().window!!.decorView)
        approve.pause().stop().destroy()
        newLaptop.withdraw(ticket)

        // ---- Settings (full length).
        val settings = Robolectric.buildActivity(SettingsActivity::class.java).setup()
        idle(1500)
        save(settings.get().window.decorView, "11-settings-full", fullHeight = settings.get().findViewById(R.id.content))
        PairQr.show(settings.get())
        until("pairing QR") { ShadowDialog.getLatestDialog()?.findViewById<android.widget.ImageView>(R.id.qr)?.drawable != null }
        idle(300)
        save(settings.get().window.decorView, "11b-pair-qr", ShadowDialog.getLatestDialog().window!!.decorView)
        ShadowDialog.getLatestDialog().dismiss()
        settings.pause().stop().destroy()

        // ---- Update: the user closes Android's install prompt.
        val dist = System.getProperty("beam.shots.dist").orEmpty()
        if (dist.isNotEmpty() && File(dist).isDirectory) {
            File(dist, "beam.apk").writeBytes(ByteArray(150_000) { (it % 7).toByte() })
            File(dist, "beam.apk.json").writeText("""{"version": "9.0.0", "versionCode": 900}""")
            try {
                runBlocking { app.updates.check(force = true) }
                if (app.updates.state.value is AppUpdater.State.Ready) {
                    shadowOf(app.packageManager).setCanRequestPackageInstalls(true)
                    val up = Robolectric.buildActivity(UpdateActivity::class.java, UpdateActivity.intent(app)).setup()
                    until("session committed") { app.packageManager.packageInstaller.allSessions.isNotEmpty() }
                    app.updates.publishInstallStatus(
                        Intent(app, InstallReceiver::class.java).setAction(InstallReceiver.ACTION_STATUS)
                            .putExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE_ABORTED),
                    )
                    idle(500)
                    save(up.get().window.decorView, "12-update-cancelled", ShadowDialog.getLatestDialog().window!!.decorView)
                    up.pause().stop().destroy()
                }
            } finally {
                File(dist, "beam.apk").delete()
                File(dist, "beam.apk.json").delete()
            }
        }

        main.pause().stop().destroy()
        online.cancel()
    }

    companion object {
        const val STATUS = 32
        const val NAV = 24
    }
}
