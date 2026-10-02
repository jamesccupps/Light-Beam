package app.beam.android

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.os.BatteryManager
import android.os.Looper
import android.provider.Settings
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.view.isVisible
import androidx.recyclerview.widget.RecyclerView
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.Conversations
import app.beam.android.core.Device
import app.beam.android.core.DeviceCan
import app.beam.android.core.DeviceStatus
import app.beam.android.core.Item
import app.beam.android.core.Pairing
import app.beam.android.data.StatusReporter
import app.beam.android.notify.Notifier
import app.beam.android.notify.Shortcuts
import app.beam.android.ui.MainActivity
import app.beam.android.ui.SendActivity
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
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog
import org.robolectric.shadows.ShadowMediaPlayer
import org.robolectric.shadows.util.DataSource
import java.net.InetAddress
import java.net.ServerSocket
import java.time.Duration

/**
 * Server 1.3 features on the phone, offline (events fed straight in): ringing this phone, server alerts,
 * device status in the header, device actions (ring / wake / Remote Desktop), Direct Share shortcuts and the
 * share sheet's loading state.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class QuickWinsTest {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private val desk = "desk00000001"
    private val laptop = "laptop000001"
    private lateinit var me: String

    private fun idle(ms: Long = 100) = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ms))

    private fun notifications(): List<Notification> = shadowOf(app.getSystemService(NotificationManager::class.java)).allNotifications
    private fun Notification.title() = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
    private fun Notification.text() = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()

    /** Accepts connections but never answers: the app stays "connecting" (not "offline") during a test. */
    private val silentServer = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))

    @Before
    fun offlinePhone() {
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        app.completePairing(Pairing.Link("http://127.0.0.1:${silentServer.localPort}", "k"), "Quick Phone")
        me = app.prefs.deviceId
        val now = System.currentTimeMillis()
        val devices = JSONArray()
            .put(
                Device(
                    desk, "Desk", "windows", true, now,
                    status = DeviceStatus(85, false, 120L * 1024 * 1024 * 1024, 500L * 1024 * 1024 * 1024, "Windows 11 Pro 24H2", now),
                    can = DeviceCan(ring = true, wake = false, remoteDesktop = true), tailscaleDns = "desk.tailnet.ts.net",
                ).toJson(),
            )
            .put(Device(laptop, "Laptop", "windows", false, now - 3_600_000, can = DeviceCan(ring = true, wake = true)).toJson())
        app.repo.onEvent("devices", JSONObject().put("devices", devices).toString())
        app.repo.upsert(Item("i1", "text", "hello", false, 5, null, 0, null, desk, "Desk", listOf(me), emptyMap(), now - 60_000))
    }

    @After
    fun cleanUp() {
        if (app.ringer.ringing.value) app.ringer.stop(tellServer = false)
        app.unpair()
        silentServer.close()
    }

    // ---------------------------------------------------------------- ring this phone

    private fun ringEvent(device: String, stop: Boolean = false, by: String = "Desk") =
        app.repo.onEvent("ring", JSONObject().put("device", device).put("by", by).put("from", desk).put("stop", stop).put("at", System.currentTimeMillis()).toString())

    private fun ringing() = notifications().firstOrNull { it.channelId == Notifier.CH_RING }

    @Test
    fun ringsLoudlyWithAStopButtonAndPutsTheVolumeBack() {
        ShadowMediaPlayer.addMediaInfo(DataSource.toDataSource(app, Settings.System.DEFAULT_ALARM_ALERT_URI), ShadowMediaPlayer.MediaInfo(60_000, 0))
        val audio = app.getSystemService(AudioManager::class.java)
        audio.setStreamVolume(AudioManager.STREAM_ALARM, 2, 0)
        ringEvent(me)
        idle()
        assertTrue(app.ringer.ringing.value)
        assertTrue("the alarm sound plays", app.ringer.soundPlaying)
        assertEquals("loud", audio.getStreamMaxVolume(AudioManager.STREAM_ALARM), audio.getStreamVolume(AudioManager.STREAM_ALARM))
        val n = ringing()
        assertNotNull(n)
        assertEquals("Ringing from Desk", n!!.title())
        assertEquals(listOf("Stop"), n.actions.map { it.title.toString() })
        assertTrue("can't be swiped away", (n.flags and Notification.FLAG_ONGOING_EVENT) != 0)

        n.actions.single().actionIntent.send()
        idle()
        assertFalse(app.ringer.ringing.value)
        assertFalse(app.ringer.soundPlaying)
        assertNull("notification gone", ringing())
        assertEquals("volume put back", 2, audio.getStreamVolume(AudioManager.STREAM_ALARM))
    }

    @Test
    fun stopsOnAStopEventWhenBeamIsOpenedAndAfterAMinute() {
        ringEvent(me)
        idle()
        assertTrue(app.ringer.ringing.value)
        ringEvent(me, stop = true)
        idle()
        assertFalse("ring {stop: true}", app.ringer.ringing.value)

        ringEvent(me)
        idle()
        assertTrue(app.ringer.ringing.value)
        val main = Robolectric.buildActivity(MainActivity::class.java).setup()
        assertFalse("opening Beam", app.ringer.ringing.value)
        main.pause().stop().destroy()

        ringEvent(me)
        idle()
        assertTrue(app.ringer.ringing.value)
        idle(61_000)
        assertFalse("after a minute", app.ringer.ringing.value)
        assertNull(ringing())
    }

    @Test
    fun otherDevicesRingingIsRememberedNotPlayed() {
        ringEvent(desk, by = "Quick Phone")
        idle()
        assertFalse(app.ringer.ringing.value)
        assertTrue(app.ringer.isRinging(desk))
        ringEvent(desk, stop = true)
        assertFalse(app.ringer.isRinging(desk))
    }

    // ---------------------------------------------------------------- alerts

    private fun alert(kind: String, device: String?, text: String, level: String = "warn") =
        app.repo.onEvent("alert", JSONObject().put("id", kind + device).put("kind", kind).put("device", device ?: JSONObject.NULL)
            .put("level", level).put("text", text).put("at", System.currentTimeMillis()).toString())

    @Test
    fun alertsAboutOtherDevicesAndTheServerBecomeNotifications() {
        alert("battery", desk, "Desk's battery is at 12%")
        alert("battery", me, "Quick Phone's battery is at 9%") // this phone knows its own battery
        alert("serverDisk", null, "The server's disk has 3 GB left")
        val shown = notifications().filter { it.channelId == Notifier.CH_ALERTS }
        assertEquals(listOf("Desk's battery is at 12%", "The server's disk has 3 GB left"), shown.map { it.text() }.sortedBy { it })
        assertEquals("Desk", shown.first { it.text()!!.startsWith("Desk") }.title())
        assertEquals("Your Beam server", shown.first { it.text()!!.startsWith("The server") }.title())
        // "Back online" replaces "offline" for the same device.
        alert("offline", laptop, "Laptop has been offline for 10 minutes")
        alert("online", laptop, "Laptop is back online", level = "info")
        val presence = notifications().filter { it.channelId == Notifier.CH_ALERTS && it.title() == "Laptop" }
        assertEquals(listOf("Laptop is back online"), presence.map { it.text() })
    }

    // ---------------------------------------------------------------- the conversation screen

    @Test
    fun theHeaderShowsTheDevicesStatusAndItsActions() {
        val t = Robolectric.buildActivity(ThreadActivity::class.java, ThreadActivity.intent(app, desk)).setup()
        idle(300)
        val toolbar = t.get().findViewById<com.google.android.material.appbar.MaterialToolbar>(R.id.toolbar)
        assertEquals("Online · 85% battery · 120 GB free", toolbar.subtitle.toString())
        assertTrue("Ring", toolbar.menu.findItem(R.id.action_ring).isVisible)
        assertFalse("online: no Wake", toolbar.menu.findItem(R.id.action_wake).isVisible)
        assertFalse("no Remote Desktop app here", toolbar.menu.findItem(R.id.action_remote_desktop).isVisible)
        t.pause().stop().destroy()

        // With a Remote Desktop app installed, and for the offline laptop (Wake).
        val rdp = ComponentName("com.microsoft.rdc.androidx", "com.microsoft.rdc.Main")
        shadowOf(app.packageManager).addActivityIfNotPresent(rdp)
        shadowOf(app.packageManager).addIntentFilterForActivity(rdp, IntentFilter(Intent.ACTION_VIEW).apply { addDataScheme("rdp") })
        val t2 = Robolectric.buildActivity(ThreadActivity::class.java, ThreadActivity.intent(app, desk)).setup()
        idle(300)
        val menu2 = t2.get().findViewById<com.google.android.material.appbar.MaterialToolbar>(R.id.toolbar).menu
        assertTrue(menu2.findItem(R.id.action_remote_desktop).isVisible)
        t2.get().findViewById<com.google.android.material.appbar.MaterialToolbar>(R.id.toolbar).menu.performIdentifierAction(R.id.action_remote_desktop, 0)
        assertEquals("rdp://full%20address=s:desk.tailnet.ts.net", shadowOf(t2.get()).nextStartedActivity?.data?.toString())
        t2.pause().stop().destroy()

        val t3 = Robolectric.buildActivity(ThreadActivity::class.java, ThreadActivity.intent(app, laptop)).setup()
        idle(300)
        val menu3 = t3.get().findViewById<com.google.android.material.appbar.MaterialToolbar>(R.id.toolbar).menu
        assertTrue("offline and wakeable", menu3.findItem(R.id.action_wake).isVisible)
        t3.pause().stop().destroy()
    }

    @Test
    fun theConversationListMenuHasTheDeviceActions() {
        val main = Robolectric.buildActivity(MainActivity::class.java).setup()
        idle(500)
        val list = main.get().findViewById<RecyclerView>(R.id.list)
        list.measure(0, 0)
        list.layout(0, 0, 1080, 2000)
        idle(200)
        val row = (0 until list.childCount).map { list.getChildAt(it) }.first { it.findViewById<TextView>(R.id.title)?.text == "Laptop" }
        row.findViewById<android.view.View>(R.id.row).performLongClick()
        idle(200)
        val entries = ShadowDialog.getLatestDialog().findViewById<LinearLayout>(R.id.entries)
        val labels = (0 until entries.childCount).map { (entries.getChildAt(it) as TextView).text.toString() }
        assertTrue(labels.toString(), labels.containsAll(listOf("Ring", "Wake", "Clear conversation")))
        main.pause().stop().destroy()
    }

    // ---------------------------------------------------------------- status report

    @Test
    fun theStatusReportHasBatteryStorageAndAndroid() {
        val bm = app.getSystemService(BatteryManager::class.java)
        shadowOf(bm).setIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY, 42)
        shadowOf(bm).setIsCharging(true)
        org.robolectric.shadows.ShadowStatFs.registerStats(android.os.Environment.getDataDirectory().path, 1000, 400, 300)
        val s = app.status.read()
        assertEquals(42, s.batteryLevel)
        assertEquals(300L * org.robolectric.shadows.ShadowStatFs.BLOCK_SIZE, s.storageFree)
        assertEquals(1000L * org.robolectric.shadows.ShadowStatFs.BLOCK_SIZE, s.storageTotal)
        assertEquals(true, s.charging)
        assertTrue(s.os!!.startsWith("Android "))
        val json = s.toJson()
        assertEquals(42, json.getJSONObject("battery").getInt("level"))
        assertTrue(json.getJSONObject("battery").getBoolean("charging"))
        assertTrue(json.keys().asSequence().all { it in setOf("battery", "storage", "os") })
        // What counts as a change worth a report.
        val base = DeviceStatus(50, false, 10L shl 30, 100L shl 30, "Android 16")
        assertFalse(StatusReporter.changed(base, base.copy(batteryLevel = 46)))
        assertTrue(StatusReporter.changed(base, base.copy(batteryLevel = 45)))
        assertTrue(StatusReporter.changed(base, base.copy(charging = true)))
        assertTrue("crossing 20 %", StatusReporter.changed(base.copy(batteryLevel = 21), base.copy(batteryLevel = 20)))
        assertTrue("crossing 15 %", StatusReporter.changed(base.copy(batteryLevel = 17), base.copy(batteryLevel = 15)))
        // 1.4: no periodic report any more; time alone is no change.
        assertFalse(StatusReporter.changed(base, base.copy(batteryLevel = 48)))
    }

    // ---------------------------------------------------------------- Direct Share and the share sheet

    @Test
    fun devicesArePublishedAsSharingShortcutsAndUseIsReported() {
        val s = app.repo.state.value
        Shortcuts.publish(app, Conversations.summaries(s.me, s.devices, s.items, emptyMap()))
        val dynamic = ShortcutManagerCompat.getDynamicShortcuts(app)
        val deskShortcut: ShortcutInfoCompat? = dynamic.firstOrNull { it.id == Shortcuts.idFor(desk) }
        assertNotNull(dynamic.map { it.id }.toString(), deskShortcut)
        assertTrue(deskShortcut!!.categories!!.contains(Shortcuts.SHARE_CATEGORY))
        assertEquals("Desk", deskShortcut.shortLabel.toString())

        // Sending to a device that isn't among them publishes it (and reports the use).
        ShortcutManagerCompat.removeDynamicShortcuts(app, listOf(Shortcuts.idFor(laptop)))
        app.reportSent(listOf(laptop))
        assertTrue(ShortcutManagerCompat.getDynamicShortcuts(app).any { it.id == Shortcuts.idFor(laptop) })
    }

    @Test
    fun theShareSheetWaitsForTheDeviceListInsteadOfShowingOnlyAllDevices() {
        val share = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "hello")
        // Nothing saved yet, and the server hasn't answered: "Loading your devices…", not a lone "All devices".
        val devices = app.repo.state.value.devices
        app.repo.clear()
        val send = Robolectric.buildActivity(SendActivity::class.java, share).setup()
        val sheet = ShadowDialog.getLatestDialog()
        val targets = sheet.findViewById<RecyclerView>(R.id.targets)
        assertTrue("loading", sheet.findViewById<TextView>(R.id.loading).isVisible)
        assertFalse(targets.isVisible)
        // The list arrives.
        app.repo.onEvent("devices", JSONObject().put("devices", JSONArray().apply { devices.forEach { put(it.toJson()) } }).toString())
        app.repo.upsert(Item("i2", "text", "hi", false, 2, null, 0, null, desk, "Desk", listOf(me), emptyMap(), System.currentTimeMillis()))
        idle(300)
        assertTrue(targets.isVisible)
        assertFalse(sheet.findViewById<TextView>(R.id.loading).isVisible)
        assertEquals("All devices + Desk + Laptop", 3, targets.adapter?.itemCount)
        send.pause().stop().destroy()

        // The server can't be reached at all (nothing listens on port 9): what's possible anyway, and why.
        app.completePairing(Pairing.Link("http://127.0.0.1:9", "k"), "Quick Phone")
        val send2 = Robolectric.buildActivity(SendActivity::class.java, share).setup()
        val sheet2 = ShadowDialog.getLatestDialog()
        val deadline = System.currentTimeMillis() + 20_000
        while (System.currentTimeMillis() < deadline && !sheet2.findViewById<RecyclerView>(R.id.targets).isVisible) {
            idle(50)
            Thread.sleep(20)
        }
        assertTrue(sheet2.findViewById<RecyclerView>(R.id.targets).isVisible)
        assertFalse(sheet2.findViewById<TextView>(R.id.loading).isVisible)
        assertTrue(sheet2.findViewById<TextView>(R.id.error).isVisible)
        send2.pause().stop().destroy()
    }
}
