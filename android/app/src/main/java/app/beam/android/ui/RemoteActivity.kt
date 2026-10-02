package app.beam.android.ui

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.util.AttributeSet
import android.view.KeyEvent
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.widget.Toast
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.isVisible
import androidx.core.view.updatePadding
import androidx.lifecycle.lifecycleScope
import app.beam.android.BuildConfig
import app.beam.android.R
import app.beam.android.core.Format
import app.beam.android.databinding.ActivityRemoteBinding
import app.beam.android.remote.RemoteControl
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl

/**
 * Remote control (server 1.6): the server's own viewer page (`#remote=<PC id>`) full screen. The page does the work
 * (video, the data channels, gestures, the soft keyboard and key strip); this hosts it:
 * - immersive, the screen kept on, any orientation (rotating keeps the page and its session);
 * - the keyboard passes through: the page resizes above the soft keyboard, and a hardware keyboard's Esc stays a key
 *   for the PC (never "back");
 * - back asks first (an edge swipe while moving the pointer is easy to make by accident); the page leaving the viewer
 *   (its Close goes back to Beam's page), or Beam staying out of sight for [END_AFTER_MS] (another app, the screen
 *   off) end the session; coming back sooner keeps it;
 * - when the page can't load, "Try again". (No "Open in Chrome": a browser signed in automatically because Beam runs
 *   on this phone may not start a session.)
 *
 * Nothing is captured on the phone and nothing is asked for: a viewer only receives, so a camera or microphone request
 * is denied. Android 13+ keeps the PC's screen out of the recent-apps snapshot. The page signs in with a sign-in of its
 * own (see [RemoteControl]), may only stay on Beam's server, and gets nothing of the app's (no JavaScript bridge).
 */
class RemoteActivity : BaseActivity() {
    private lateinit var b: ActivityRemoteBinding
    private var web: WebView? = null
    private var device = ""
    private var base: HttpUrl? = null
    private var ending = false
    private val handler = Handler(Looper.getMainLooper())
    private val endLater = Runnable { disconnect() }
    private var asking: AlertDialog? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val id = intent.getStringExtra(EXTRA_DEVICE)
        if (id == null || !DEVICE_ID.matches(id) || app.api == null) {
            finish()
            return
        }
        device = id
        b = ActivityRemoteBinding.inflate(layoutInflater)
        setContentView(b.root)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.attributes = window.attributes.apply { layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES }
        // The PC's screen isn't kept as the recent-apps snapshot (a screenshot of it on the phone's disk).
        if (Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false)
        immersive()
        // The soft keyboard: the page gets the room above it (with the bars hidden nothing else makes room).
        ViewCompat.setOnApplyWindowInsetsListener(b.root) { v, insets ->
            v.updatePadding(bottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom)
            insets
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = askToDisconnect()
        })
        b.retry.setOnClickListener { open() }
        b.close.setOnClickListener { disconnect() }
        open()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val id = intent.getStringExtra(EXTRA_DEVICE)
        if (id == null || id == device || !DEVICE_ID.matches(id) || ending) return
        // Another PC: this one's session ends first.
        endSession()
        device = id
        setIntent(intent)
        open()
    }

    /** Signs the page in, then loads the viewer. */
    private fun open() {
        if (!app.remote.available) return problem(getString(R.string.remote_needs_server))
        val api = app.api?.pinned() ?: return finish()
        base = api.base
        b.problem.isVisible = false
        b.progress.isVisible = true
        val ticket = app.remote.opening()
        lifecycleScope.launch {
            val signedIn = withContext(Dispatchers.IO) { runCatching { app.remote.signIn(api, ticket) } }
            // Closed, or another PC's viewer opened, while it was on its way: that sign-in was dropped.
            if (ending || !app.remote.isOpen(ticket)) return@launch
            signedIn.onSuccess { cookie ->
                CookieManager.getInstance().apply {
                    setAcceptCookie(true)
                    setCookie(api.base.toString(), cookie)
                    flush()
                }
                webView().loadUrl(RemoteControl.pageUrl(api.base, device))
            }.onFailure { problem(getString(R.string.remote_sign_in_failed, Format.error(it))) }
        }
    }

    @SuppressLint("SetJavaScriptEnabled") // the viewer is a script, and only Beam's server's pages load here
    private fun webView(): WebView = web ?: ViewerWebView(this).also { w ->
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true // the page's own choices (trackpad or touch, quality)
            mediaPlaybackRequiresUserGesture = false // the PC's screen plays as soon as it arrives
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            setGeolocationEnabled(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            // The page can tell it's hosted here (its "Open in Chrome", no install prompts).
            userAgentString = "$userAgentString BeamAndroid/${BuildConfig.VERSION_NAME}"
        }
        w.setBackgroundColor(Color.BLACK)
        w.webViewClient = Client()
        w.webChromeClient = Chrome()
        w.setDownloadListener { url, _, _, _, _ -> onDownload(url) }
        b.viewer.addView(w, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        w.requestFocus() // a hardware keyboard's keys go to the page
        web = w
    }

    // The viewer's "Remote Desktop" for a locked PC (1.7.6): the page downloads a .rdp file, which a WebView can't
    // save. Microsoft's Windows App opens rdp:// links instead, as the conversation's menu does; without it, say so.
    private fun onDownload(url: String) {
        val u = url.toUri()
        val id = DeviceActions.rdpDevice(u.path) ?: return
        if (!sameServer(u)) return
        val open = app.repo.state.value.devicesById[id]?.let { DeviceActions.remoteDesktopIntent(this, it) }
        if (open != null && runCatching { startActivity(open) }.isSuccess) return
        Toast.makeText(this, R.string.remote_desktop_needs_app, Toast.LENGTH_LONG).show()
    }

    private fun dropWebView() {
        val w = web ?: return
        web = null
        w.stopLoading()
        w.loadUrl("about:blank") // the page's pagehide: it says goodbye to the PC
        b.viewer.removeView(w)
        w.destroy()
    }

    private fun problem(text: String) {
        dropWebView()
        // The page is gone: so is its sign-in ("Try again" gets a new one).
        app.remote.closing()
        app.scope.launch(Dispatchers.IO) { app.remote.revokeKeptIfIdle() }
        b.progress.isVisible = false
        b.problemText.text = text
        b.problem.isVisible = true
    }

    /** On Beam's server and on this PC's viewer. */
    private fun isViewer(url: String?): Boolean {
        val u = url?.toUri() ?: return false
        return sameServer(u) && u.fragment.orEmpty().split('&').contains("remote=$device")
    }

    private fun sameServer(u: Uri): Boolean = base?.let { RemoteControl.onBeam(it, u) } == true

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            if (sameServer(url)) return false
            // Not Beam's: a link the user tapped opens in the browser; nothing else leaves the viewer.
            if (request.hasGesture() && url.scheme in setOf("http", "https")) {
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE)) }
            }
            return true
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
            // The page left the viewer (its Disconnect, or it went home): so does Beam.
            if (!ending && web === view && url != "about:blank" && !isViewer(url)) disconnect()
        }

        override fun onPageFinished(view: WebView, url: String?) {
            if (web === view) b.progress.isVisible = false
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame && web === view) problem(getString(R.string.remote_load_failed))
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (request.isForMainFrame && web === view) problem(getString(R.string.remote_load_failed))
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            // The page's process died (memory, a crash): Beam stays up.
            if (web === view) {
                web = null
                b.viewer.removeView(view)
                view.destroy()
                problem(getString(R.string.remote_stopped))
            } else {
                view.destroy()
            }
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        /** A viewer never needs the camera or the microphone. */
        override fun onPermissionRequest(request: PermissionRequest) = request.deny()

        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean = false

        /** Nothing of the page goes to the log. */
        override fun onConsoleMessage(message: ConsoleMessage): Boolean = true

        /** The page closed itself (window.close(), as a 1.6.1 page's Close does): so does Beam. */
        override fun onCloseWindow(window: WebView) {
            if (window === web) disconnect()
        }
    }

    /**
     * Back: "Disconnect?" first, so a stray swipe never ends the session (with nothing on screen, it just leaves).
     * Back again, or Keep controlling, carries on.
     */
    private fun askToDisconnect() {
        if (ending) return
        if (web == null) return disconnect()
        if (asking?.isShowing == true) return
        asking = MaterialAlertDialogBuilder(this)
            .setTitle(R.string.remote_leave_title)
            .setMessage(R.string.remote_leave_text)
            .setNegativeButton(R.string.remote_keep, null)
            .setPositiveButton(R.string.remote_disconnect) { _, _ -> disconnect() }
            .setOnDismissListener { asking = null; immersive() }
            .show()
    }

    /** Ends the session and leaves. */
    private fun disconnect() {
        if (ending) return
        ending = true
        handler.removeCallbacks(endLater)
        asking?.dismiss()
        endSession()
        finish()
    }

    /**
     * The page goes (its pagehide says goodbye), and the server ends this phone's session with the PC too, in case
     * the page couldn't; the page's sign-in is revoked (a sign-in still on its way is dropped when it lands). Which
     * sessions is decided now: a viewer opened right after has its own.
     */
    private fun endSession() {
        val pc = device
        val api = app.api?.pinned()
        app.remote.closing()
        val ticketsAt = app.remote.ticketsSoFar
        dropWebView()
        clearCookies()
        if (api != null) app.scope.launch(Dispatchers.IO) { app.remote.closed(api, pc, ticketsAt) }
    }

    private fun clearCookies() {
        runCatching {
            CookieManager.getInstance().removeAllCookies(null)
            CookieManager.getInstance().flush()
        }
    }

    override fun onStart() {
        super.onStart()
        handler.removeCallbacks(endLater)
        web?.onResume()
    }

    override fun onStop() {
        super.onStop()
        if (ending || isFinishing || isChangingConfigurations) return
        // Out of sight (another app, the screen off): the video pauses, and the session ends unless Beam is back soon.
        web?.onPause()
        handler.postDelayed(endLater, END_AFTER_MS)
    }

    override fun onDestroy() {
        handler.removeCallbacks(endLater)
        if (!ending && device.isNotEmpty() && ::b.isInitialized) {
            ending = true
            endSession()
        }
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) immersive()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        // A hardware keyboard's Esc that the page let through comes back as "back": it's a key for the PC, so it
        // never disconnects.
        if (event.keyCode == KeyEvent.KEYCODE_BACK && event.flags and KeyEvent.FLAG_FALLBACK != 0) return true
        return super.dispatchKeyEvent(event)
    }

    private fun immersive() {
        WindowCompat.getInsetsController(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    companion object {
        private const val EXTRA_DEVICE = "device"
        private val DEVICE_ID = Regex("^[A-Za-z0-9_-]{8,64}$")

        /** Out of sight this long, the session ends. */
        const val END_AFTER_MS = 10_000L

        /** Controls PC [device] (one that [RemoteControl.canControl]). */
        fun intent(ctx: Context, device: String): Intent = Intent(ctx, RemoteActivity::class.java).putExtra(EXTRA_DEVICE, device)
    }
}

/**
 * The viewer's WebView. What's typed goes to the PC, passwords too: the keyboard may not learn it (Gboard's dictionary
 * on disk), nor suggest, correct or capitalize it (each would change the keys the PC gets). The page's key field says
 * the same with its own attributes; this holds whatever the page does.
 */
private class ViewerWebView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : WebView(context, attrs) {
    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        val connection = super.onCreateInputConnection(outAttrs)
        // (sideways, the keyboard never takes the whole screen: the PC's picture stays above it)
        outAttrs.imeOptions = outAttrs.imeOptions or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING or
            EditorInfo.IME_FLAG_NO_FULLSCREEN or EditorInfo.IME_FLAG_NO_EXTRACT_UI
        if (outAttrs.inputType and InputType.TYPE_MASK_CLASS == InputType.TYPE_CLASS_TEXT) {
            outAttrs.inputType = outAttrs.inputType and CHANGES_TEXT.inv() or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        }
        return connection
    }

    private companion object {
        const val CHANGES_TEXT = InputType.TYPE_TEXT_FLAG_AUTO_CORRECT or InputType.TYPE_TEXT_FLAG_AUTO_COMPLETE or
            InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or InputType.TYPE_TEXT_FLAG_CAP_WORDS or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    }
}
