package app.beam.android.ui

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.ConsoleMessage
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
import androidx.appcompat.app.AppCompatActivity
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.core.view.updatePadding
import app.beam.android.BuildConfig
import app.beam.android.R
import app.beam.android.databinding.ActivityFilesBinding

/**
 * (1.21, server 1.36) LocalCast's page, from the main list's Weather row: the user's own forecaster's page on the
 * tailnet, as it is (the user: "you should just implement the page that is served by tailscale into beam, i wont change
 * that link"). Nothing of Beam's goes to it (no sign-in, no bridge); only its own address stays here, any other link
 * opens in the browser. Back steps back inside it, then closes.
 */
class WeatherActivity : AppCompatActivity() {
    private lateinit var b: ActivityFilesBinding
    private lateinit var page: Uri
    private var web: WebView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val url = intent.getStringExtra(EXTRA_URL)?.let { cleanUrl(it) }
        if (url == null) {
            finish()
            return
        }
        page = url
        b = ActivityFilesBinding.inflate(layoutInflater)
        setContentView(b.root)
        ViewCompat.setOnApplyWindowInsetsListener(b.root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            v.updatePadding(left = bars.left, top = bars.top, right = bars.right, bottom = bars.bottom)
            insets
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val w = web
                if (w != null && w.canGoBack()) w.goBack() else finish()
            }
        })
        b.retry.setOnClickListener { load() }
        b.close.setOnClickListener { finish() }
        load()
    }

    override fun onDestroy() {
        web?.let {
            web = null
            it.stopLoading()
            it.destroy()
        }
        super.onDestroy()
    }

    private fun load() {
        b.problem.isVisible = false
        b.progress.isVisible = true
        webView().loadUrl(page.toString())
    }

    @SuppressLint("SetJavaScriptEnabled") // LocalCast's page is a script; only its own address loads here
    private fun webView(): WebView = web ?: WebView(this).also { w ->
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true // the page's own choices
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
        w.setDownloadListener { url, _, _, _, _ -> openOutside(url.toUri()) }
        b.page.addView(w, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        web = w
    }

    private fun problem(text: String) {
        b.progress.isVisible = false
        b.problemText.text = text
        b.problem.isVisible = true
    }

    private fun sameSite(u: Uri): Boolean = u.scheme == page.scheme && u.host.equals(page.host, ignoreCase = true) && portOf(u) == portOf(page)

    private fun openOutside(u: Uri) {
        if (u.scheme !in setOf("http", "https")) return
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE)) }
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (sameSite(request.url)) return false
            if (request.hasGesture()) openOutside(request.url)
            return true
        }

        override fun onPageFinished(view: WebView, url: String?) {
            if (web === view) b.progress.isVisible = false
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame && web === view) problem(getString(R.string.weather_load_failed, page.authority.orEmpty()))
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (request.isForMainFrame && web === view) problem(getString(R.string.weather_load_failed, page.authority.orEmpty()))
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (web === view) {
                web = null
                b.page.removeView(view)
                problem(getString(R.string.weather_load_failed, page.authority.orEmpty()))
            }
            view.destroy()
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest) = request.deny()

        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean = false

        /** Nothing of the page goes to the log. */
        override fun onConsoleMessage(message: ConsoleMessage): Boolean = true
    }

    companion object {
        private const val EXTRA_URL = "url"

        private fun portOf(u: Uri): Int = if (u.port != -1) u.port else if (u.scheme == "https") 443 else 80

        /** http(s) only, with a host and without a user name or password: LocalCast's page as the server gave it. */
        fun cleanUrl(s: String): Uri? {
            val u = runCatching { s.toUri() }.getOrNull() ?: return null
            if (u.scheme !in setOf("http", "https") || u.host.isNullOrEmpty() || u.userInfo != null) return null
            return u
        }

        fun intent(ctx: Context, url: String): Intent = Intent(ctx, WeatherActivity::class.java).putExtra(EXTRA_URL, url)
    }
}
