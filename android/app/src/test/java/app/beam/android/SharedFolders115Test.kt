package app.beam.android

import android.os.Looper
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.core.view.isVisible
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.Device
import app.beam.android.core.DeviceCan
import app.beam.android.core.DeviceStatus
import app.beam.android.core.Pairing
import app.beam.android.ui.DeviceActions
import app.beam.android.ui.FilesActivity
import app.beam.android.ui.MainActivity
import app.beam.android.ui.RemoteActivity
import org.json.JSONArray
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
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowToast
import java.time.Duration

/**
 * (1.15) Shared folders on the phone, against [FakeBeam]: where "Shared folders" shows, and [FilesActivity] hosting the
 * server's page of a PC's folders (`#files=<PC id>`, server 1.28.1) with a sign-in of its own, Back stepping back inside
 * the page before it closes, the page's own Close, and never over an open remote control viewer.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class SharedFolders115Test {
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

    private fun pcJson(id: String, name: String, online: Boolean = true, files: Boolean = true, remoteControl: Boolean = false) =
        Device(id, name, "windows", online, System.currentTimeMillis(), status = DeviceStatus(remoteControl = remoteControl, locked = false),
            can = DeviceCan(remoteDesktop = true, remoteControl = remoteControl, files = files), tailscaleDns = "$id.tail1234.ts.net").toJson()

    private fun start(
        features: List<String> = listOf("stream-modes", "remote-control", "shared-folders", "shared-folders-page"),
        devices: JSONArray = JSONArray().put(pcJson(pc, "Desk")),
    ): FakeBeam {
        val f = FakeBeam(features).also { fake = it }
        f.devices = devices
        app.completePairing(Pairing.Link(f.url, KEY), "Pixel", "fakebeam01")
        app.connection.acquire("service")
        idleUntil("connected") { app.connection.streamId != null && app.repo.state.value.info != null && app.repo.state.value.devices.size == devices.length() }
        return f
    }

    private fun folders(id: String = pc): ActivityController<FilesActivity> = Robolectric.buildActivity(FilesActivity::class.java, FilesActivity.intent(app, id)).setup()

    private fun webOf(a: ActivityController<FilesActivity>): WebView {
        var web: WebView? = null
        idleUntil("the folders' page") {
            web = a.get().findViewById<FrameLayout>(R.id.page).getChildAt(0) as? WebView
            web?.let { shadowOf(it).lastLoadedUrl } != null
        }
        return web!!
    }

    @Test
    fun sharedFoldersShowsForAPcThatSharesThemOnAServerWithTheirPage() {
        start(devices = JSONArray()
            .put(pcJson(pc, "Desk"))
            .put(pcJson("asleep000001", "Asleep PC", online = false))
            .put(pcJson("plain0000001", "Plain PC", files = false)))
        val byId = app.repo.state.value.devicesById
        assertTrue("can.files read", byId.getValue(pc).can.files)
        val main = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        fun labels(id: String) = DeviceActions.entries(main, byId.getValue(id), main.window.decorView).map { it.label }
        val label = app.getString(R.string.device_shared_folders)
        assertTrue(labels(pc).toString(), label in labels(pc))
        assertFalse("offline", label in labels("asleep000001"))
        assertFalse("shares nothing", label in labels("plain0000001"))
        // It opens the folders of that PC.
        DeviceActions.entries(main, byId.getValue(pc), main.window.decorView).first { it.label == label }.action()
        assertEquals(FilesActivity::class.java.name, shadowOf(main).nextStartedActivity.component?.className)
    }

    @Test
    fun anOlderServerWithoutThePageHasNoSharedFolders() {
        start(features = listOf("stream-modes", "remote-control", "shared-folders"))
        val main = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        val d = app.repo.state.value.devicesById.getValue(pc)
        assertFalse(DeviceActions.canBrowseFiles(app, d))
        assertFalse(DeviceActions.entries(main, d, main.window.decorView).any { it.label == app.getString(R.string.device_shared_folders) })
    }

    @Test
    fun thePageSignsInWithItsOwnTokenAndBackStepsInsideBeforeItCloses() {
        val f = start()
        val a = folders()
        val web = webOf(a)
        // The page's own sign-in: the app's token traded once for a cookie the WebView holds; never in the URL.
        assertEquals("${f.url}/#files=$pc", shadowOf(web).lastLoadedUrl)
        assertEquals(listOf(app.prefs.key), f.pageKeys.toList())
        assertTrue(CookieManager.getInstance().getCookie(f.url).orEmpty().contains("beam_key=bt_page0"))
        assertTrue(app.remote.pageOpen)
        web.settings.let { s ->
            assertTrue(s.javaScriptEnabled)
            assertFalse(s.allowFileAccess)
            assertFalse(s.allowContentAccess)
            assertTrue(s.userAgentString.contains("BeamAndroid/"))
        }
        // Back asks the page first: a step back inside it (a subfolder, a file looked at) keeps the screen...
        a.get().onBackPressedDispatcher.onBackPressed()
        idle()
        assertTrue(shadowOf(web).lastEvaluatedJavascript.contains("sharedBack()"))
        shadowOf(web).lastEvaluatedJavascriptCallback.onReceiveValue("true")
        idle()
        assertFalse("a step back inside", a.get().isFinishing)
        // ...and at the top the screen closes: the page's sign-in revoked, its cookie gone.
        a.get().onBackPressedDispatcher.onBackPressed()
        idle()
        shadowOf(web).lastEvaluatedJavascriptCallback.onReceiveValue("false")
        idle()
        assertTrue(a.get().isFinishing)
        idleUntil("the page's sign-in revoked") { f.pageSignOuts.contains("bt_page0") }
        idleUntil("forgotten") { app.prefs.remotePageTokens.isEmpty() }
        assertTrue(CookieManager.getInstance().getCookie(f.url).isNullOrEmpty())
        assertFalse(app.remote.pageOpen)
        assertNull("the page is gone", a.get().findViewById<FrameLayout>(R.id.page).getChildAt(0))
    }

    @Test
    fun thePagesOwnCloseClosesItAndOtherPagesStayOutside() {
        val f = start()
        val a = folders()
        val web = webOf(a)
        val client = shadowOf(web).webViewClient
        // Another site: never loaded here.
        assertTrue(client.shouldOverrideUrlLoading(web, request("https://example.com/")))
        assertFalse(a.get().isFinishing)
        // This PC's folders stay; the page leaving them (its Close goes to Beam's page) closes the screen.
        assertFalse(client.shouldOverrideUrlLoading(web, request("${f.url}/#files=$pc")))
        client.doUpdateVisitedHistory(web, "${f.url}/", false)
        assertTrue(a.get().isFinishing)
        idleUntil("revoked") { f.pageSignOuts.contains("bt_page0") }
    }

    @Test
    fun neverOverAnOpenViewer() {
        val f = start(devices = JSONArray().put(pcJson(pc, "Desk", remoteControl = true)))
        val viewer = Robolectric.buildActivity(RemoteActivity::class.java, RemoteActivity.intent(app, pc)).setup()
        idleUntil("the viewer signed in") { f.pageKeys.size == 1 && (viewer.get().findViewById<FrameLayout>(R.id.viewer).getChildAt(0) as? WebView) != null }
        val a = folders()
        idle()
        assertTrue("it says so and closes", a.get().isFinishing)
        assertEquals(app.getString(R.string.files_remote_open), ShadowToast.getTextOfLatestToast())
        assertEquals("no second sign-in", 1, f.pageKeys.size)
        assertTrue("the viewer's stays", f.pageSignOuts.isEmpty())
        assertFalse(viewer.get().isFinishing)
    }

    @Test
    fun whenThePageCannotLoadItSaysSoWithTryAgain() {
        val f = start()
        val a = folders()
        val web = webOf(a)
        shadowOf(web).webViewClient.onReceivedHttpError(web, request("${f.url}/#files=$pc"),
            android.webkit.WebResourceResponse("text/plain", "utf-8", 502, "Bad Gateway", emptyMap(), "".byteInputStream()))
        idle()
        assertTrue(a.get().findViewById<View>(R.id.problem).isVisible)
        assertNull(a.get().findViewById<FrameLayout>(R.id.page).getChildAt(0))
        idleUntil("its sign-in revoked") { f.pageSignOuts.contains("bt_page0") }
        // Try again: a fresh sign-in and the page again.
        a.get().findViewById<View>(R.id.retry).performClick()
        val again = webOf(a)
        assertEquals("${f.url}/#files=$pc", shadowOf(again).lastLoadedUrl)
        assertEquals(2, f.pageKeys.size)
    }

    private fun request(url: String) = object : android.webkit.WebResourceRequest {
        override fun getUrl(): android.net.Uri = android.net.Uri.parse(url)
        override fun isForMainFrame() = true
        override fun isRedirect() = false
        override fun hasGesture() = false
        override fun getMethod() = "GET"
        override fun getRequestHeaders(): Map<String, String> = emptyMap()
    }
}
