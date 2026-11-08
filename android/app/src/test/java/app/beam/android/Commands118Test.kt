package app.beam.android

import android.os.Looper
import android.webkit.CookieManager
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.Device
import app.beam.android.core.DeviceCan
import app.beam.android.core.DeviceStatus
import app.beam.android.core.Pairing
import app.beam.android.ui.DeviceActions
import app.beam.android.ui.FilesActivity
import app.beam.android.ui.MainActivity
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
import java.time.Duration

/**
 * (1.18, server 1.32) Run a command on a PC, against [FakeBeam]: where it shows (a PC online with `can.commands`, on a
 * server with commands), and [FilesActivity] hosting the server's panel for it (`#commands=<PC id>`) with the page's own
 * sign-in; Back leaves it (the page stops what still runs first).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class Commands118Test {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private val pc = "desk00000001"
    private val KEY = "bt_the_apps_own_token_0001"
    private var fake: FakeBeam? = null

    @After
    fun tearDown() {
        app.connection.release("service")
        if (app.prefs.paired) app.unpair()
        fake?.close()
        CookieManager.getInstance().removeAllCookies(null)
    }

    private fun idle(ms: Long = 20) = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ms))

    private fun idleUntil(what: String, timeoutMs: Long = 10_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            idle()
            if (condition()) return
            Thread.sleep(10)
        }
        throw AssertionError("timed out: $what")
    }

    private fun pcJson(id: String, name: String, online: Boolean = true, commands: Boolean = true) =
        Device(id, name, "windows", online, System.currentTimeMillis(), status = DeviceStatus(remoteControl = true, locked = false),
            can = DeviceCan(remoteDesktop = true, remoteControl = true, commands = commands), tailscaleDns = "$id.tail1234.ts.net").toJson()

    private fun start(
        features: List<String> = listOf("stream-modes", "remote-control", "commands"),
        devices: JSONArray = JSONArray().put(pcJson(pc, "Desk")),
    ): FakeBeam {
        val f = FakeBeam(features).also { fake = it }
        f.devices = devices
        app.completePairing(Pairing.Link(f.url, KEY), "Pixel", "fakebeam01")
        app.connection.acquire("service")
        idleUntil("connected") { app.connection.streamId != null && app.repo.state.value.info != null && app.repo.state.value.devices.size == devices.length() }
        return f
    }

    private fun webOf(a: ActivityController<FilesActivity>): WebView {
        var web: WebView? = null
        idleUntil("the panel's page") {
            web = a.get().findViewById<FrameLayout>(R.id.page).getChildAt(0) as? WebView
            web?.let { shadowOf(it).lastLoadedUrl } != null
        }
        return web!!
    }

    @Test
    fun runACommandShowsForAPcThatRunsThemOnAServerWithThem() {
        start(devices = JSONArray()
            .put(pcJson(pc, "Desk"))
            .put(pcJson("asleep000001", "Asleep PC", online = false))
            .put(pcJson("plain0000001", "Plain PC", commands = false)))
        val byId = app.repo.state.value.devicesById
        assertTrue("can.commands read", byId.getValue(pc).can.commands)
        val main = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        fun labels(id: String) = DeviceActions.entries(main, byId.getValue(id), main.window.decorView).map { it.label }
        val label = app.getString(R.string.device_run_command)
        assertTrue(labels(pc).toString(), label in labels(pc))
        assertFalse("offline", label in labels("asleep000001"))
        assertFalse("commands off there", label in labels("plain0000001"))
        DeviceActions.entries(main, byId.getValue(pc), main.window.decorView).first { it.label == label }.action()
        val started = shadowOf(main).nextStartedActivity
        assertEquals(FilesActivity::class.java.name, started.component?.className)
        assertEquals("commands", started.getStringExtra("page"))
    }

    @Test
    fun anOlderServerHasNoRunACommand() {
        start(features = listOf("stream-modes", "remote-control"))
        val main = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        val d = app.repo.state.value.devicesById.getValue(pc)
        assertFalse(DeviceActions.canRunCommands(app, d))
        assertFalse(DeviceActions.entries(main, d, main.window.decorView).any { it.label == app.getString(R.string.device_run_command) })
    }

    @Test
    fun thePanelSignsInWithItsOwnTokenAndBackLeavesIt() {
        val f = start()
        val a = Robolectric.buildActivity(FilesActivity::class.java, FilesActivity.commandsIntent(app, pc)).setup()
        val web = webOf(a)
        assertEquals("${f.url}/#commands=$pc", shadowOf(web).lastLoadedUrl)
        assertEquals(listOf(app.prefs.key), f.pageKeys.toList())
        assertTrue(app.remote.pageOpen)
        // Back asks the page (it stops what still runs), then the screen closes and the page's sign-in goes.
        a.get().onBackPressedDispatcher.onBackPressed()
        idle()
        assertTrue(shadowOf(web).lastEvaluatedJavascript.contains("commandsBack()"))
        shadowOf(web).lastEvaluatedJavascriptCallback.onReceiveValue("false")
        idle()
        assertTrue(a.get().isFinishing)
        idleUntil("the page's sign-in revoked") { !app.remote.pageOpen }
    }
}
