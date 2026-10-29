package app.beam.android.ui

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
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
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.core.view.updatePadding
import androidx.lifecycle.lifecycleScope
import app.beam.android.BuildConfig
import app.beam.android.R
import app.beam.android.core.Format
import app.beam.android.databinding.ActivityFilesBinding
import app.beam.android.remote.RemoteControl
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl

/**
 * (1.15) Shared folders: the folders a PC shares with this phone (chosen at that PC, Beam for Windows 1.18+), as the
 * server's own page shows them (`#files=<PC id>`, server 1.28.1): look in them, sort, search, look at a file, tick files
 * and folders and copy them here (they arrive in the conversation with that PC, as anything it sends). The user,
 * 2026-10-15: "it says i can share folders to my phone, but i dont see a way to access them in the phone".
 *
 * Hosted as [RemoteActivity] hosts the viewer: the page signs in with a sign-in of its own for this phone (see
 * [RemoteControl]; one page of Beam's at a time, so never over an open viewer), may only stay on Beam's server, and
 * gets nothing of the app's. Back steps back inside the page (a file looked at, a search, a subfolder: its
 * `sharedBack()`), then leaves; the page's own Close leaves too, and the page's sign-in is revoked as it goes.
 */
class FilesActivity : BaseActivity() {
    private lateinit var b: ActivityFilesBinding
    private var web: WebView? = null
    private var device = ""
    private var base: HttpUrl? = null
    private var ticket: Int? = null
    private var leaving = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val id = intent.getStringExtra(EXTRA_DEVICE)
        if (id == null || !DEVICE_ID.matches(id) || app.api == null) {
            finish()
            return
        }
        // The viewer holds the page sign-in: closing it first keeps its session (they share one, one page at a time).
        if (app.remote.pageOpen) {
            toast(getString(R.string.files_remote_open))
            finish()
            return
        }
        device = id
        b = ActivityFilesBinding.inflate(layoutInflater)
        setContentView(b.root)
        ViewCompat.setOnApplyWindowInsetsListener(b.root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            v.updatePadding(left = bars.left, top = bars.top, right = bars.right, bottom = bars.bottom)
            insets
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = back()
        })
        b.retry.setOnClickListener { open() }
        b.close.setOnClickListener { leave() }
        open()
    }

    /** Signs the page in, then loads the folders. */
    private fun open() {
        val api = app.api?.pinned() ?: return finish()
        base = api.base
        closePage() // (a try before this one)
        b.problem.isVisible = false
        b.progress.isVisible = true
        val t = app.remote.opening().also { ticket = it }
        lifecycleScope.launch {
            val signedIn = withContext(Dispatchers.IO) { runCatching { app.remote.signIn(api, t) } }
            if (leaving || ticket != t || !app.remote.isOpen(t)) return@launch
            signedIn.onSuccess { cookie ->
                CookieManager.getInstance().apply {
                    setAcceptCookie(true)
                    setCookie(api.base.toString(), cookie)
                    flush()
                }
                webView().loadUrl(RemoteControl.filesUrl(api.base, device))
            }.onFailure { problem(getString(R.string.files_sign_in_failed, Format.error(it))) }
        }
    }

    @SuppressLint("SetJavaScriptEnabled") // the page is a script, and only Beam's server's pages load here
    private fun webView(): WebView = web ?: WebView(this).also { w ->
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true // the page's own choices (list or pictures, the sort)
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            setGeolocationEnabled(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            userAgentString = "$userAgentString BeamAndroid/${BuildConfig.VERSION_NAME}"
        }
        w.setBackgroundColor(themeColor(com.google.android.material.R.attr.colorSurface))
        w.webViewClient = Client()
        w.webChromeClient = Chrome()
        w.setDownloadListener { _, _, _, _, _ -> } // (the page downloads nothing: copies arrive as messages)
        b.page.addView(w, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        web = w
    }

    private fun dropWebView() {
        val w = web ?: return
        web = null
        w.stopLoading()
        w.loadUrl("about:blank")
        b.page.removeView(w)
        w.destroy()
    }

    /** The page goes, and (when it was the open page of Beam's) its sign-in is revoked and the WebView's cookies go. */
    private fun closePage() {
        val t = ticket ?: return
        ticket = null
        if (::b.isInitialized) dropWebView()
        if (!app.remote.closing(t)) return
        runCatching {
            CookieManager.getInstance().removeAllCookies(null)
            CookieManager.getInstance().flush()
        }
        app.scope.launch(Dispatchers.IO) { app.remote.revokeKeptIfIdle() }
    }

    private fun problem(text: String) {
        closePage()
        b.progress.isVisible = false
        b.problemText.text = text
        b.problem.isVisible = true
    }

    /** Back: a step back inside the page while there is one, else the folders close. */
    private fun back() {
        val w = web
        if (w == null || leaving) return leave()
        w.evaluateJavascript("typeof sharedBack === 'function' && sharedBack() === true") { answer ->
            if (answer != "true" && web === w) leave()
        }
    }

    private fun leave() {
        if (leaving) return
        leaving = true
        closePage()
        finish()
    }

    private fun sameServer(u: Uri): Boolean = base?.let { RemoteControl.onBeam(it, u) } == true

    /** On Beam's server and on this PC's folders. */
    private fun isFiles(url: String?): Boolean {
        val u = url?.toUri() ?: return false
        return sameServer(u) && u.fragment == "files=$device"
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            if (sameServer(url)) {
                if (isFiles(url.toString())) return false
                leave() // the page left the folders (its Close): so does Beam
                return true
            }
            // Not Beam's: a link the user tapped opens in the browser; nothing else leaves the page.
            if (request.hasGesture() && url.scheme in setOf("http", "https")) {
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE)) }
            }
            return true
        }

        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
            if (!leaving && web === view && url != "about:blank" && !isFiles(url)) leave()
        }

        override fun onPageFinished(view: WebView, url: String?) {
            if (web === view) b.progress.isVisible = false
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame && web === view) problem(getString(R.string.files_load_failed))
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (request.isForMainFrame && web === view) problem(getString(R.string.files_load_failed))
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            // The page's process died (memory, a crash): Beam stays up.
            if (web === view) {
                web = null
                b.page.removeView(view)
                view.destroy()
                problem(getString(R.string.files_stopped))
            } else {
                view.destroy()
            }
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        /** The folders never need the camera or the microphone. */
        override fun onPermissionRequest(request: PermissionRequest) = request.deny()

        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean = false

        /** Nothing of the page goes to the log. */
        override fun onConsoleMessage(message: ConsoleMessage): Boolean = true

        override fun onCloseWindow(window: WebView) {
            if (window === web) leave()
        }
    }

    override fun onStart() {
        super.onStart()
        web?.onResume()
    }

    override fun onStop() {
        super.onStop()
        web?.onPause()
    }

    override fun onDestroy() {
        if (!leaving) {
            leaving = true
            closePage()
        }
        super.onDestroy()
    }

    companion object {
        private const val EXTRA_DEVICE = "device"
        private val DEVICE_ID = Regex("^[A-Za-z0-9_-]{8,64}$")
        const val FEATURE = "shared-folders-page" // (server 1.28.1: index.html#files=<PC id>)

        /** PC [device]'s shared folders (one that [DeviceActions.canBrowseFiles]). */
        fun intent(ctx: Context, device: String): Intent = Intent(ctx, FilesActivity::class.java).putExtra(EXTRA_DEVICE, device)
    }
}
