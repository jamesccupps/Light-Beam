package app.beam.android

import android.content.DialogInterface
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.net.Uri
import android.os.Looper
import android.view.KeyEvent
import android.view.View
import android.text.InputType
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import androidx.core.graphics.Insets
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.appcompat.app.AlertDialog
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.Device
import app.beam.android.core.DeviceCan
import app.beam.android.core.DeviceStatus
import app.beam.android.core.Pairing
import app.beam.android.remote.RemoteControl
import okhttp3.HttpUrl.Companion.toHttpUrl
import app.beam.android.ui.DeviceActions
import app.beam.android.ui.MainActivity
import app.beam.android.ui.RemoteActivity
import app.beam.android.ui.SettingsActivity
import app.beam.android.ui.ThreadActivity
import com.google.android.material.appbar.MaterialToolbar
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
import org.robolectric.android.controller.ActivityController
import org.robolectric.shadows.ShadowDialog
import org.robolectric.annotation.Config
import java.time.Duration

/**
 * Remote control (1.6) on the phone, against [FakeBeam]: where "Control" shows, and [RemoteActivity] hosting the
 * server's viewer page: its own sign-in for the page, the WebView's settings, staying on Beam's server, no camera or
 * microphone, the keyboard, and the session ending on back (after "Disconnect?"), the page's own Disconnect, or being
 * out of sight a while.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class RemoteControlTest {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private val pc = "desk00000001"
    private val mine = "0123456789abcdef"
    private val others = "fedcba9876543210"
    /** The app's own sign-in (distinct enough to search for). */
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

    private fun pcJson(
        id: String,
        name: String,
        online: Boolean = true,
        can: DeviceCan = DeviceCan(remoteDesktop = true, remoteControl = true),
        status: DeviceStatus = DeviceStatus(remoteControl = true, locked = false),
    ) = Device(id, name, "windows", online, System.currentTimeMillis(), status = status, can = can, tailscaleDns = "$id.tail1234.ts.net").toJson()

    /** Paired with a FakeBeam (1.6 unless [features] say otherwise), connected, with [devices]; [before] sets it up. */
    private fun start(
        features: List<String> = listOf("stream-modes", "remote-control"),
        devices: JSONArray = JSONArray().put(pcJson(pc, "Desk")),
        before: (FakeBeam) -> Unit = {},
    ): FakeBeam {
        val f = FakeBeam(features).also { fake = it }
        f.devices = devices
        before(f)
        app.completePairing(Pairing.Link(f.url, KEY), "Pixel", "fakebeam01")
        app.connection.acquire("service")
        idleUntil("connected") { app.connection.streamId != null && app.repo.state.value.info != null && app.repo.state.value.devices.size == devices.length() }
        return f
    }

    private fun session(id: String, viewer: String) = JSONObject().put("id", id).put("host", pc).put("viewer", viewer).put("since", 1L).put("state", "live")

    private fun viewer(): ActivityController<RemoteActivity> = Robolectric.buildActivity(RemoteActivity::class.java, RemoteActivity.intent(app, pc)).setup()

    /** The viewer's WebView, once the page is loading. */
    /** Back, then Disconnect in "Disconnect?" (back asks first since 1.6.1). */
    private fun backAndDisconnect(a: ActivityController<RemoteActivity>) {
        a.get().onBackPressedDispatcher.onBackPressed()
        idle()
        val asked = ShadowDialog.getLatestDialog() as AlertDialog
        assertTrue("Disconnect? shows", asked.isShowing)
        asked.getButton(DialogInterface.BUTTON_POSITIVE).performClick()
        idle()
    }

    private fun webOf(a: ActivityController<RemoteActivity>): WebView {
        var web: WebView? = null
        idleUntil("the viewer page") {
            web = a.get().findViewById<FrameLayout>(R.id.viewer).getChildAt(0) as? WebView
            web?.let { shadowOf(it).lastLoadedUrl } != null
        }
        return web!!
    }

    private fun request(url: String, gesture: Boolean = false) = object : WebResourceRequest {
        override fun getUrl(): Uri = url.toUri()
        override fun isForMainFrame() = true
        override fun isRedirect() = false
        override fun hasGesture() = gesture
        override fun getMethod() = "GET"
        override fun getRequestHeaders(): Map<String, String> = emptyMap()
    }

    private class AskedFor(private val what: Array<String>) : PermissionRequest() {
        var granted = false
        var denied = false
        override fun getOrigin(): Uri = "https://example.com/".toUri()
        override fun getResources(): Array<String> = what
        override fun grant(resources: Array<out String>?) {
            granted = true
        }

        override fun deny() {
            denied = true
        }
    }

    private fun texts(v: View): List<String> = when (v) {
        is TextView -> listOf(v.text.toString())
        is ViewGroup -> (0 until v.childCount).flatMap { texts(v.getChildAt(it)) }
        else -> emptyList()
    }

    // ---------------------------------------------------------------- where "Control" shows

    @Test
    fun controlShowsOnlyForAPcThatAllowsItNow() {
        val now = System.currentTimeMillis()
        start(devices = JSONArray()
            .put(pcJson(pc, "Desk"))
            .put(pcJson("locked000001", "Locked PC", can = DeviceCan(remoteDesktop = true), status = DeviceStatus(remoteControl = true, locked = true)))
            .put(pcJson("asleep000001", "Asleep PC", online = false))
            .put(pcJson("plain0000001", "Plain PC", can = DeviceCan(remoteDesktop = true), status = DeviceStatus(remoteControl = false, locked = false)))
            .put(Device("phone0000002", "Other phone", "android", true, now).toJson()))
        val byId = app.repo.state.value.devicesById
        assertEquals(true, byId.getValue(pc).status?.remoteControl)
        assertEquals(true, byId.getValue("locked000001").status?.locked)
        assertTrue(app.remote.canControl(byId.getValue(pc)))
        for (id in listOf("locked000001", "asleep000001", "plain0000001", "phone0000002")) assertFalse(id, app.remote.canControl(byId.getValue(id)))
        // The device menus (conversation list, Settings → Devices): Control for the PC; a locked one keeps Remote
        // Desktop (when an app here handles it), as before.
        val rdp = Intent(Intent.ACTION_VIEW, "rdp://full%20address=s:locked000001.tail1234.ts.net".toUri())
        shadowOf(app.packageManager).addResolveInfoForIntent(rdp, ResolveInfo().apply { activityInfo = ActivityInfo().apply { packageName = "com.microsoft.rdc"; name = "Rdp" } })
        val main = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        fun labels(id: String) = DeviceActions.entries(main, byId.getValue(id), main.window.decorView).map { it.label }
        assertTrue(labels(pc).toString(), app.getString(R.string.device_control) in labels(pc))
        assertFalse(app.getString(R.string.device_control) in labels("locked000001"))
        assertTrue(labels("locked000001").toString(), app.getString(R.string.device_remote_desktop) in labels("locked000001"))
        // The conversation's own menu.
        val desk = Robolectric.buildActivity(ThreadActivity::class.java, ThreadActivity.intent(app, pc)).setup()
        idleUntil("Control in the PC's menu") { desk.get().findViewById<MaterialToolbar>(R.id.toolbar).menu.findItem(R.id.action_control).isVisible }
        val locked = Robolectric.buildActivity(ThreadActivity::class.java, ThreadActivity.intent(app, "locked000001")).setup()
        idle(200)
        assertFalse(locked.get().findViewById<MaterialToolbar>(R.id.toolbar).menu.findItem(R.id.action_control).isVisible)
        // It opens the viewer for that PC.
        desk.get().findViewById<MaterialToolbar>(R.id.toolbar).menu.performIdentifierAction(R.id.action_control, 0)
        val opened = shadowOf(desk.get()).nextStartedActivity
        assertEquals(RemoteActivity::class.java.name, opened.component?.className)
    }

    @Test
    fun anOlderServerHasNoControlAndTheViewerSaysWhy() {
        val f = start(features = listOf("stream-modes"))
        assertFalse(app.remote.available)
        assertFalse(app.remote.canControl(app.repo.state.value.devicesById.getValue(pc)))
        // Opened anyway (say, the server was downgraded): it says why and signs nothing in.
        val a = viewer()
        idle(200)
        assertTrue(a.get().findViewById<View>(R.id.problem).isVisible)
        assertTrue(f.pageKeys.isEmpty())
        assertNull(a.get().findViewById<FrameLayout>(R.id.viewer).getChildAt(0))
    }

    // ---------------------------------------------------------------- the viewer

    @Test
    fun theViewerSignsInWithItsOwnTokenAndOnlyShowsBeam() {
        val f = start()
        val a = viewer()
        val web = webOf(a)
        // The page's own sign-in: the app's token was traded once for a cookie the WebView holds; the page's URL
        // never carries a key.
        assertEquals("${f.url}/#remote=$pc", shadowOf(web).lastLoadedUrl)
        assertEquals(listOf(app.prefs.key), f.pageKeys.toList())
        assertTrue("traded in a POST body, never a URL", f.requests.contains("POST /api/login") && f.requests.none { it == "GET /" })
        assertEquals(setOf("${f.url}/ bt_page0"), app.prefs.remotePageTokens)
        assertTrue(CookieManager.getInstance().getCookie(f.url).orEmpty().contains("beam_key=bt_page0"))
        assertFalse(shadowOf(web).lastLoadedUrl.contains(app.prefs.key!!))
        // The WebView: the viewer's script and its video without a tap; no files; screen on.
        web.settings.let { s ->
            assertTrue(s.javaScriptEnabled)
            assertFalse(s.mediaPlaybackRequiresUserGesture)
            assertTrue(s.domStorageEnabled)
            assertFalse(s.allowFileAccess)
            assertFalse(s.allowContentAccess)
            assertTrue(s.userAgentString, s.userAgentString.endsWith(" BeamAndroid/${BuildConfig.VERSION_NAME}"))
        }
        assertTrue(a.get().window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)
        // The user may screenshot the PC's screen (FLAG_SECURE off by choice; no recents snapshot on 13+).
        assertTrue(a.get().window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE == 0)
        // Only Beam's server loads in it; a link elsewhere the user tapped goes to the browser.
        val client = shadowOf(web).webViewClient
        assertFalse(client.shouldOverrideUrlLoading(web, request("${f.url}/#remote=$pc")))
        assertTrue(client.shouldOverrideUrlLoading(web, request("https://example.com/")))
        assertNull(shadowOf(a.get()).nextStartedActivity)
        assertTrue(client.shouldOverrideUrlLoading(web, request("https://example.com/help", gesture = true)))
        assertEquals("https://example.com/help", shadowOf(a.get()).nextStartedActivity.dataString)
        // No camera, no microphone: a viewer only receives.
        val asked = AskedFor(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE, PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        shadowOf(web).webChromeClient!!.onPermissionRequest(asked)
        assertTrue(asked.denied)
        assertFalse(asked.granted)
        // The page gets nothing of the app's: no JavaScript bridge.
        assertNull(shadowOf(web).getJavascriptInterface("BeamAndroid"))
        // A keyboard's Esc that the page let through comes back as "back": it isn't a disconnect.
        for (action in listOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) {
            a.get().dispatchKeyEvent(KeyEvent(0, 0, action, KeyEvent.KEYCODE_BACK, 0, 0, -1, 0, KeyEvent.FLAG_FALLBACK))
        }
        idle()
        assertFalse(a.get().isFinishing)
        // Rotating keeps the page (and its session): the activity isn't recreated.
        val info = app.packageManager.getActivityInfo(a.get().componentName, 0)
        assertTrue(info.configChanges and ActivityInfo.CONFIG_ORIENTATION != 0 && info.configChanges and ActivityInfo.CONFIG_SCREEN_SIZE != 0)
        assertEquals("any orientation (landscape too)", ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED, info.screenOrientation)
        // The soft keyboard: the page gets the room above it.
        assertEquals(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE, info.softInputMode and WindowManager.LayoutParams.SOFT_INPUT_MASK_ADJUST)
        val root = a.get().findViewById<View>(R.id.root)
        ViewCompat.dispatchApplyWindowInsets(root, WindowInsetsCompat.Builder().setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, 600)).build())
        assertEquals(600, root.paddingBottom)
        ViewCompat.dispatchApplyWindowInsets(root, WindowInsetsCompat.Builder().build())
        assertEquals(0, root.paddingBottom)
    }

    @Test
    fun backAsksThenEndsTheSessionAndSignsThePageOut() {
        val f = start()
        f.rcSessions += session(mine, app.repo.me)
        f.rcSessions += session(others, "laptop000001")
        val a = viewer()
        webOf(a)
        // Back (an edge swipe made by accident while moving the pointer, too): "Disconnect?" first.
        a.get().onBackPressedDispatcher.onBackPressed()
        idle()
        val asked = ShadowDialog.getLatestDialog() as AlertDialog
        assertTrue(asked.isShowing)
        assertFalse(a.get().isFinishing)
        asked.getButton(DialogInterface.BUTTON_NEGATIVE).performClick() // Keep controlling
        idle()
        assertFalse("kept", a.get().isFinishing)
        assertTrue(f.rcEnded.isEmpty())
        backAndDisconnect(a)
        assertTrue(a.get().isFinishing)
        idleUntil("this phone's session ended on the server") { f.rcEnded.contains(mine) }
        idleUntil("the page's sign-in revoked") { f.pageSignOuts.contains("bt_page0") }
        assertFalse("another device's session stays", f.rcEnded.contains(others))
        idleUntil("forgotten") { app.prefs.remotePageTokens.isEmpty() }
        assertTrue(CookieManager.getInstance().getCookie(f.url).isNullOrEmpty())
        assertNull("the page is gone", a.get().findViewById<FrameLayout>(R.id.viewer).getChildAt(0))
    }

    @Test
    fun outOfSightItEndsAfterAWhileBackSoonerItStays() {
        val f = start()
        f.rcSessions += session(mine, app.repo.me)
        val a = viewer()
        val web = webOf(a)
        // Away briefly (another app, a glance at a message): the video pauses, the session stays.
        a.pause().stop()
        assertTrue(shadowOf(web).wasOnPauseCalled())
        idle(RemoteActivity.END_AFTER_MS - 2_000)
        a.restart().resume()
        idle(RemoteActivity.END_AFTER_MS + 1_000)
        Thread.sleep(300)
        assertFalse(a.get().isFinishing)
        assertTrue(f.rcEnded.isEmpty())
        // Away longer (the screen off): the session ends and the viewer goes.
        a.pause().stop()
        idle(RemoteActivity.END_AFTER_MS + 100)
        assertTrue(a.get().isFinishing)
        idleUntil("ended on the server") { f.rcEnded.contains(mine) }
        idleUntil("the page's sign-in revoked") { f.pageSignOuts.contains("bt_page0") }
    }

    @Test
    fun thePagesOwnDisconnectClosesIt() {
        val f = start()
        f.rcSessions += session(mine, app.repo.me)
        val a = viewer()
        val web = webOf(a)
        // The page leaving the viewer (it went home after Disconnect): Beam's viewer goes too.
        shadowOf(web).webViewClient.doUpdateVisitedHistory(web, "${f.url}/#", false)
        assertTrue(a.get().isFinishing)
        idleUntil("ended") { f.rcEnded.contains(mine) }
    }

    @Test
    fun aCrashedPageDoesNotTakeBeamDown() {
        start()
        val a = viewer()
        val web = webOf(a)
        val gone = object : RenderProcessGoneDetail() {
            override fun didCrash() = false
            override fun rendererPriorityAtExit() = 0
        }
        assertTrue(shadowOf(web).webViewClient.onRenderProcessGone(web, gone))
        idle()
        assertTrue(a.get().findViewById<View>(R.id.problem).isVisible)
        assertFalse(a.get().isFinishing)
        assertEquals("Try again and Close (no Open in Chrome)", listOf(app.getString(R.string.remote_retry), app.getString(R.string.remote_close)),
            texts(a.get().findViewById(R.id.problem)).drop(1))
        // "Try again" signs in afresh (the old page's sign-in revoked first) and loads the viewer again.
        a.get().findViewById<View>(R.id.retry).performClick()
        webOf(a)
        idleUntil("signed in again") { fake!!.pageTokens.size == 2 }
        assertTrue(fake!!.pageSignOuts.contains("bt_page0"))
    }

    @Test
    fun unpairRevokesALeftoverPageSignIn() {
        val f = start()
        // A viewer whose process died: its page sign-in is still there.
        app.prefs.remotePageTokens = setOf("${f.url}/ bt_left")
        app.prefs.remoteUsed = true
        CookieManager.getInstance().setCookie(f.url, "beam_key=bt_left; Path=/")
        app.unpair()
        idleUntil("revoked") { f.pageSignOuts.contains("bt_left") }
        assertTrue(app.prefs.remotePageTokens.isEmpty())
        assertFalse(app.prefs.remoteUsed)
        assertTrue(CookieManager.getInstance().getCookie(f.url).isNullOrEmpty())
    }

    /**
     * Closed with back, then opened again at once (a mis-tap): the first viewer's late clean-up leaves the new viewer's
     * session and sign-in alone (review of 1.6.0).
     */
    @Test
    fun reopeningRightAfterClosingKeepsTheNewViewer() {
        val f = start()
        f.rcSessions += session("1111111111111111", app.repo.me)
        val first = viewer()
        webOf(first)
        backAndDisconnect(first)
        idleUntil("the first session ended") { f.rcEnded.contains("1111111111111111") }
        val second = viewer()
        webOf(second)
        idleUntil("the second page signed in") { f.pageTokens.size == 2 }
        f.rcSessions += session("2222222222222222", app.repo.me)
        val until = System.currentTimeMillis() + 3_500
        while (System.currentTimeMillis() < until) {
            idle()
            Thread.sleep(10)
        }
        assertFalse("the new viewer's session", f.rcEnded.contains("2222222222222222"))
        assertFalse("the new page's sign-in", f.pageSignOuts.contains(f.pageTokens[1]))
        assertTrue("the first page's sign-in went", f.pageSignOuts.contains(f.pageTokens[0]))
        assertEquals(setOf("${f.url}/ ${f.pageTokens[1]}"), app.prefs.remotePageTokens)
    }

    /**
     * Back while the viewer is still signing in: that sign-in, landing after, is revoked at once and never used, and a
     * later viewer is left alone: a reconnect while it's live revokes nothing (the server would end its session), its
     * close revokes what's kept (re-check of the 1.6 review).
     */
    @Test
    fun backDuringTheSignInDropsItAndLeavesTheNextViewerAlone() {
        val f = start()
        f.loginDelayMs = 1_500
        val first = viewer()
        idleUntil("the sign-in asked") { f.pageKeys.size == 1 }
        first.get().onBackPressedDispatcher.onBackPressed()
        first.pause().stop().destroy()
        idleUntil("the sign-in answered") { f.pageTokens.size == 1 }
        val stale = f.pageTokens[0]
        idleUntil("revoked as it landed") { f.pageSignOuts.contains(stale) }
        idleUntil("not kept") { app.prefs.remotePageTokens.isEmpty() }
        // The next viewer is live; a page sign-in a crash left is kept meanwhile.
        f.loginDelayMs = 0
        val second = viewer()
        webOf(second)
        val live = f.pageTokens[1]
        app.prefs.remotePageTokens = app.prefs.remotePageTokens + "${f.url}/ bt_crashleftover"
        val revoked = f.pageSignOuts.size
        offMain { app.remote.onConnected() }
        assertEquals("nothing revoked under a live viewer", revoked, f.pageSignOuts.size)
        // Closed: its own sign-in and the leftover go.
        backAndDisconnect(second)
        idleUntil("both revoked") { f.pageSignOuts.containsAll(listOf(live, "bt_crashleftover")) }
        idleUntil("nothing kept") { app.prefs.remotePageTokens.isEmpty() }
    }

    /** Control for another PC while the first is still signing in: that sign-in is dropped, never revoked under the new viewer. */
    @Test
    fun anotherPcMidSignInDropsTheFirstSignIn() {
        val f = start(devices = JSONArray().put(pcJson(pc, "Desk")).put(pcJson("desk00000002", "Den PC")))
        f.loginDelayMs = 1_500
        val a = viewer()
        idleUntil("the first sign-in asked") { f.pageKeys.size == 1 }
        f.loginDelayMs = 0
        a.newIntent(RemoteActivity.intent(app, "desk00000002"))
        val web = webOf(a)
        assertEquals("${f.url}/#remote=desk00000002", shadowOf(web).lastLoadedUrl)
        idleUntil("both answered") { f.pageTokens.size == 2 }
        idleUntil("both kept") { app.prefs.remotePageTokens.size == 2 }
        Thread.sleep(500)
        assertTrue("nothing revoked under the live viewer: ${f.pageSignOuts}", f.pageSignOuts.isEmpty())
        backAndDisconnect(a)
        idleUntil("both revoked once it closed") { f.pageSignOuts.containsAll(f.pageTokens) }
    }

    /** The app's own network calls, off the main thread (where the app never makes them). */
    private fun <T> offMain(block: () -> T): T {
        var result: Result<T>? = null
        kotlin.concurrent.thread { result = runCatching(block) }.join()
        return result!!.getOrThrow()
    }

    /** What's typed goes to the PC (passwords too): the keyboard learns nothing, and suggests, corrects or capitalizes nothing. */
    @Test
    fun theKeyboardLearnsAndChangesNothing() {
        start()
        val web = webOf(viewer())
        val asked = EditorInfo().apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or
                InputType.TYPE_TEXT_FLAG_AUTO_COMPLETE or InputType.TYPE_TEXT_FLAG_MULTI_LINE
        }
        web.onCreateInputConnection(asked)
        assertTrue(asked.imeOptions and EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING != 0)
        // Sideways it stays a keyboard under the picture, never a full-screen text box.
        assertTrue(asked.imeOptions and EditorInfo.IME_FLAG_NO_EXTRACT_UI != 0 && asked.imeOptions and EditorInfo.IME_FLAG_NO_FULLSCREEN != 0)
        assertEquals(
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS,
            asked.inputType,
        )
    }

    /** The page's cookie: a session cookie (never kept for later) for Beam's path only; and only Beam's path loads. */
    @Test
    fun thePageCookieAndPagesStayWithBeam() {
        val base = "https://nas.example.ts.net/beam".toHttpUrl()
        assertEquals(
            "beam_key=bt_x; Path=/beam/; HttpOnly; SameSite=Lax; Secure",
            RemoteControl.pageCookie("beam_key=bt_x; Path=/; Max-Age=315360000; HttpOnly; SameSite=Lax; Secure", base),
        )
        assertEquals("beam_key=bt_x; Path=/; HttpOnly", RemoteControl.pageCookie("beam_key=bt_x; Expires=Wed, 21 Oct 2036 07:28:00 GMT; HttpOnly", "http://127.0.0.1:8765".toHttpUrl()))
        assertTrue(RemoteControl.onBeam(base, "https://nas.example.ts.net/beam/#remote=desk".toUri()))
        assertTrue(RemoteControl.onBeam(base, "https://nas.example.ts.net/beam/api/me".toUri()))
        assertTrue(RemoteControl.onBeam(base, "https://nas.example.ts.net:443/beam".toUri()))
        assertFalse("another app on the host", RemoteControl.onBeam(base, "https://nas.example.ts.net/other/".toUri()))
        assertFalse(RemoteControl.onBeam(base, "https://nas.example.ts.net/beamer/".toUri()))
        assertFalse(RemoteControl.onBeam(base, "https://nas.example.ts.net/".toUri()))
        assertFalse(RemoteControl.onBeam(base, "http://nas.example.ts.net/beam/".toUri()))
        assertFalse(RemoteControl.onBeam(base, "https://nas.example.ts.net:8443/beam/".toUri()))
        assertTrue("a server at the host's root", RemoteControl.onBeam("http://127.0.0.1:8765".toHttpUrl(), "http://127.0.0.1:8765/anything".toUri()))
    }

    /** A page sign-in a crash left: revoked at the next connect, and at a new pairing (at its own server). */
    @Test
    fun aLeftoverPageSignInIsRevokedAtTheNextConnectAndANewPairing() {
        val f = start()
        app.prefs.remotePageTokens = setOf("${f.url}/ bt_crash1")
        app.connection.restart()
        idleUntil("revoked at the connect") { f.pageSignOuts.contains("bt_crash1") }
        idleUntil("forgotten") { app.prefs.remotePageTokens.isEmpty() }
        // Another one left, then paired with another server: revoked at its own server first.
        app.prefs.remotePageTokens = setOf("${f.url}/ bt_crash2")
        val second = FakeBeam(listOf("stream-modes", "remote-control"))
        try {
            app.completePairing(Pairing.Link(second.url, KEY), "Pixel", "fakebeam02")
            idleUntil("revoked at the old server") { f.pageSignOuts.contains("bt_crash2") }
            assertTrue(second.pageSignOuts.isEmpty())
            assertTrue(app.prefs.remotePageTokens.isEmpty())
        } finally {
            second.close()
        }
    }

    // ---------------------------------------------------------------- the kill switch

    /** Who controls a PC shows in Settings → Devices and the device's menu, and "End" there ends it (any device may). */
    @Test
    fun aPcBeingControlledShowsWhoAndEndEndsIt() {
        val now = System.currentTimeMillis()
        val devices = JSONArray().put(pcJson(pc, "Desk")).put(Device("laptop000001", "Laptop", "windows", true, now).toJson())
        // A session that started before the phone connected: the connect asks for the list (a PC allows control).
        val f = start(devices = devices, before = { it.rcSessions += session(others, "laptop000001") })
        idleUntil("fetched at the connect") { app.remote.controlling(pc).map { it.id } == listOf(others) }
        val settings = Robolectric.buildActivity(SettingsActivity::class.java).setup()
        idleUntil("in Settings → Devices") { texts(settings.get().findViewById(R.id.devicesList)).any { "being controlled from Laptop" in it } }
        val main = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        fun entries() = DeviceActions.entries(main, app.repo.state.value.devicesById.getValue(pc), main.window.decorView)
        val end = app.getString(R.string.remote_controlled_by_end, "Laptop")
        assertEquals("first in the menu", end, entries().first().label)
        entries().first().action()
        idleUntil("ended on the server") { f.rcEnded.contains(others) }
        idleUntil("gone here") { app.remote.controlling(pc).isEmpty() }
        idleUntil("gone from Settings") { texts(settings.get().findViewById(R.id.devicesList)).none { "being controlled" in it } }
        // rc-sessions events keep it current; this phone's own session says so.
        f.send("rc-sessions", JSONObject().put("sessions", JSONArray().put(session(mine, app.repo.me))))
        idleUntil("the event") { app.remote.controlling(pc).map { it.id } == listOf(mine) }
        assertEquals(app.getString(R.string.remote_controlled_by_end, app.getString(R.string.remote_this_phone)), entries().first().label)
    }

    /** "Turn off remote control" for a PC whose switch is on; nothing on the phone turns it on. */
    @Test
    fun turnOffRemoteControlButNeverOn() {
        val f = start(devices = JSONArray().put(pcJson(pc, "Desk"))
            .put(pcJson("plain0000001", "Plain PC", can = DeviceCan(remoteDesktop = true), status = DeviceStatus(remoteControl = false, locked = false))))
        val main = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        fun entries(id: String) = DeviceActions.entries(main, app.repo.state.value.devicesById.getValue(id), main.window.decorView)
        val turnOff = app.getString(R.string.remote_turn_off)
        assertTrue(entries(pc).any { it.label == turnOff })
        assertFalse(entries("plain0000001").any { it.label == turnOff })
        val labels = (entries(pc) + entries("plain0000001")).map { it.label }
        assertTrue(labels.toString(), labels.none { it.contains("allow", ignoreCase = true) || it.contains("turn on", ignoreCase = true) })
        entries(pc).first { it.label == turnOff }.action()
        idleUntil("turned off on the server") { f.rcDisabled.toList() == listOf(pc) }
    }

    @Test
    fun noNewPermissions() {
        @Suppress("DEPRECATION")
        val requested = app.packageManager.getPackageInfo(app.packageName, PackageManager.GET_PERMISSIONS).requestedPermissions.orEmpty().toSet()
        assertEquals(
            "1.6 asks for nothing new (a viewer captures nothing)",
            setOf(
                "android.permission.ACCESS_NETWORK_STATE", "android.permission.CAMERA", "android.permission.FOREGROUND_SERVICE",
                "android.permission.FOREGROUND_SERVICE_DATA_SYNC", "android.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING",
                "android.permission.INTERNET", "android.permission.POST_NOTIFICATIONS", "android.permission.POST_PROMOTED_NOTIFICATIONS",
                "android.permission.RECEIVE_BOOT_COMPLETED", "android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS",
                "android.permission.REQUEST_INSTALL_PACKAGES", "android.permission.UPDATE_PACKAGES_WITHOUT_USER_ACTION",
                "android.permission.VIBRATE", "app.beam.android.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION",
            ),
            requested,
        )
    }
}
