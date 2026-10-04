package app.beam.android.ui

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.util.AttributeSet
import android.view.DragEvent
import android.view.MotionEvent
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.Toast
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.recyclerview.widget.RecyclerView
import app.beam.android.BeamApp
import app.beam.android.R
import app.beam.android.core.Conversations
import app.beam.android.core.Pairing
import app.beam.android.data.Outbox
import app.beam.android.data.Repository
import app.beam.android.service.TransferService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

abstract class BaseActivity : AppCompatActivity() {
    val app: BeamApp get() = BeamApp.from(this)

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
    }

    fun toast(text: CharSequence) = Toast.makeText(this, text, Toast.LENGTH_SHORT).show()
}

object Clip {
    fun copy(ctx: Context, text: String): Boolean = try {
        ctx.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Beam", text))
        true
    } catch (_: Exception) {
        false
    }

    /**
     * What's on the clipboard, as texts and content Uris. Android 10+ only lets the app read it while one
     * of its windows has focus, so call this from a focused activity.
     */
    fun read(ctx: Context): Pair<List<String>, List<Uri>> {
        val clip = try {
            ctx.getSystemService(ClipboardManager::class.java).primaryClip
        } catch (_: Exception) {
            null
        } ?: return emptyList<String>() to emptyList()
        val texts = ArrayList<String>()
        val uris = ArrayList<Uri>()
        for (i in 0 until clip.itemCount) {
            val item = clip.getItemAt(i)
            val uri = item.uri
            if (uri != null && uri.scheme == "content") {
                uris += uri
            } else {
                val text = (item.text ?: item.coerceToText(ctx))?.toString()
                if (!text.isNullOrBlank()) texts += text
            }
        }
        return texts to uris
    }
}

/** Pads a view for the system bars (and the keyboard), since Beam draws edge to edge. */
fun View.padForSystemBars(top: Boolean = false, bottom: Boolean = false, ime: Boolean = false, sides: Boolean = true) {
    val l = paddingLeft
    val t = paddingTop
    val r = paddingRight
    val b = paddingBottom
    ViewCompat.setOnApplyWindowInsetsListener(this) { v, insets ->
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val keyboard = if (ime) insets.getInsets(WindowInsetsCompat.Type.ime()).bottom else 0
        v.setPadding(
            l + if (sides) bars.left else 0,
            t + if (top) bars.top else 0,
            r + if (sides) bars.right else 0,
            b + if (bottom) maxOf(bars.bottom, keyboard) else 0,
        )
        insets
    }
}

fun platformIcon(platform: String?, isAll: Boolean = false): Int = when {
    isAll -> R.drawable.ic_devices
    platform == "android" || platform == "ios" -> R.drawable.ic_phone
    platform == "windows" || platform == "linux" -> R.drawable.ic_desktop
    platform == "mac" -> R.drawable.ic_laptop
    platform == "cli" -> R.drawable.ic_terminal
    platform == "web" -> R.drawable.ic_globe
    else -> R.drawable.ic_devices
}

/** An icon for a file by its type (PDF, video, audio, image, archive, app, text…). */
fun fileTypeIcon(mime: String?, name: String?): Int {
    val m = mime.orEmpty().lowercase()
    val ext = name.orEmpty().substringAfterLast('.', "").lowercase()
    return when {
        m.startsWith("image/") -> R.drawable.ic_image
        m.startsWith("video/") -> R.drawable.ic_video
        m.startsWith("audio/") -> R.drawable.ic_audio
        m == "application/pdf" || ext == "pdf" -> R.drawable.ic_pdf
        m == "application/vnd.android.package-archive" || ext == "apk" -> R.drawable.ic_apk
        ext in setOf("zip", "7z", "rar", "tar", "gz", "tgz", "xz", "bz2") || m.contains("zip") || m.contains("compressed") -> R.drawable.ic_archive
        m.startsWith("text/") || ext in setOf("txt", "md", "csv", "log", "json", "xml") -> R.drawable.ic_text_file
        else -> R.drawable.ic_file
    }
}

object FileActions {
    fun open(ctx: Context, uri: Uri, mime: String) {
        val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            ctx.startActivity(view)
        } catch (_: ActivityNotFoundException) {
            try {
                ctx.startActivity(Intent.createChooser(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "*/*").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), null))
            } catch (_: Exception) {
                Toast.makeText(ctx, R.string.no_app_opens_file, Toast.LENGTH_LONG).show()
            }
        }
    }

    /** Beam's own "Send to…" isn't offered when sharing out of Beam. */
    private fun chooser(ctx: Context, send: Intent): Intent = Intent.createChooser(send, null)
        .putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, arrayOf(ComponentName(ctx, SendActivity::class.java)))

    fun share(ctx: Context, uri: Uri, mime: String) {
        val send = Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        send.clipData = ClipData.newRawUri("", uri)
        ctx.startActivity(chooser(ctx, send))
    }

    /** Several files in one share (1.12), as the Photos or Files app shares them: the type they have in common. */
    fun shareMany(ctx: Context, files: List<Pair<Uri, String>>) {
        if (files.isEmpty()) return
        if (files.size == 1) return share(ctx, files[0].first, files[0].second)
        val types = files.map { it.second }.distinct()
        val kinds = types.map { it.substringBefore('/') }.distinct()
        val type = when {
            types.size == 1 -> types[0]
            kinds.size == 1 -> kinds[0] + "/*"
            else -> "*/*"
        }
        val uris = ArrayList(files.map { it.first })
        val send = Intent(Intent.ACTION_SEND_MULTIPLE).setType(type).putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        send.clipData = ClipData.newRawUri("", uris[0]).apply { for (u in uris.drop(1)) addItem(ClipData.Item(u)) }
        ctx.startActivity(chooser(ctx, send))
    }

    fun shareText(ctx: Context, text: String) {
        ctx.startActivity(chooser(ctx, Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)))
    }

    fun openLink(ctx: Context, url: String) {
        try {
            ctx.startActivity(Intent(Intent.ACTION_VIEW, url.toUri()).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (_: Exception) {
            Toast.makeText(ctx, R.string.signin_no_browser, Toast.LENGTH_LONG).show()
        }
    }

    /**
     * (1.12) A web page inside Beam: a Custom Tab of the browser (its engine, its sign-ins and its notifications, shown
     * over Beam with a close button back to it), or the browser itself when none can show one. Beam Family opens here.
     */
    fun openInApp(ctx: Context, url: String) {
        val browser = customTabsBrowser(ctx) ?: return openLink(ctx, url)
        val tab = Intent(Intent.ACTION_VIEW, url.toUri())
            .setPackage(browser)
            .putExtras(Bundle().apply { putBinder(CT_SESSION, null) }) // (a Custom Tab without a session of its own)
            .putExtra(CT_TOOLBAR_COLOR, ctx.getColor(R.color.surface))
            .putExtra(CT_COLOR_SCHEME, 0) // the system's light or dark
            .putExtra(CT_TITLE, 1) // the page's title over its address
            .putExtra(Intent.EXTRA_REFERRER, "android-app://${ctx.packageName}".toUri())
        try {
            ctx.startActivity(tab)
        } catch (_: ActivityNotFoundException) {
            openLink(ctx, url)
        }
    }

    const val CT_SERVICE = "android.support.customtabs.action.CustomTabsService"
    const val CT_SESSION = "android.support.customtabs.extra.SESSION"
    private const val CT_TOOLBAR_COLOR = "android.support.customtabs.extra.TOOLBAR_COLOR"
    private const val CT_COLOR_SCHEME = "androidx.browser.customtabs.extra.COLOR_SCHEME"
    private const val CT_TITLE = "android.support.customtabs.extra.TITLE_VISIBILITY"

    /** The browser that shows Custom Tabs: the default one if it can, else the first that can; null when none can. */
    fun customTabsBrowser(ctx: Context): String? {
        val pm = ctx.packageManager
        val web = Intent(Intent.ACTION_VIEW, "https://example.com/".toUri()).addCategory(Intent.CATEGORY_BROWSABLE)
        val tabs = { pkg: String -> pkg != ctx.packageName && pm.resolveService(Intent(CT_SERVICE).setPackage(pkg), 0) != null }
        val default = pm.resolveActivity(web, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName
        if (default != null && default != "android" && tabs(default)) return default
        return pm.queryIntentActivities(web, PackageManager.MATCH_ALL).map { it.activityInfo.packageName }.distinct().firstOrNull(tabs)
    }

    /** Opens the Tailscale app (or its store page if it isn't installed). */
    fun openTailscale(ctx: Context) {
        val launch = ctx.packageManager.getLaunchIntentForPackage("com.tailscale.ipn")
        try {
            ctx.startActivity(launch ?: Intent(Intent.ACTION_VIEW, "https://tailscale.com/download/android".toUri()))
        } catch (_: Exception) {
            Toast.makeText(ctx, R.string.offline_tailscale, Toast.LENGTH_LONG).show()
        }
    }
}

/**
 * The offline banner shared by the conversation list and threads: why Beam can't reach the server and
 * what to do about it (Tailscale off → open Tailscale; otherwise retry or change the address).
 */
object OfflineBanner {
    /** Shows the banner for [s] (or hides it); returns true if it's showing. */
    fun bind(activity: Activity, banner: View, text: android.widget.TextView, action1: com.google.android.material.button.MaterialButton,
        action2: com.google.android.material.button.MaterialButton, s: Repository.State): Boolean {
        val app = BeamApp.from(activity)
        // Brief blips (a reconnect after a network change) aren't worth a banner.
        val longEnough = s.offlineSince > 0 && System.currentTimeMillis() - s.offlineSince > 4_000
        if (s.conn != Repository.Conn.OFFLINE || !(longEnough || s.fresh.not())) {
            banner.isVisible = false
            return false
        }
        action2.isVisible = false
        when (s.offline) {
            Repository.Offline.TAILSCALE_OFF -> {
                text.setText(R.string.offline_tailscale)
                action1.setText(R.string.open_tailscale)
                action1.setOnClickListener { FileActions.openTailscale(activity) }
            }
            Repository.Offline.NO_NETWORK -> {
                text.setText(R.string.offline_no_network)
                action1.setText(R.string.retry)
                action1.setOnClickListener { app.connection.kick() }
            }
            else -> {
                val host = app.prefs.baseUrl.orEmpty().substringAfter("://")
                text.text = activity.getString(R.string.offline_unreachable, host)
                action1.setText(R.string.retry)
                action1.setOnClickListener { app.connection.kick() }
                action2.isVisible = true
                action2.setText(R.string.change_address)
                action2.setOnClickListener { activity.startActivity(Intent(activity, SettingsActivity::class.java).putExtra(SettingsActivity.EXTRA_CHANGE_SERVER, true)) }
            }
        }
        banner.isVisible = true
        return true
    }

    /** Whether the needs-Tailscale hint applies to this server at all. */
    fun usesTailscale(app: BeamApp) = Pairing.needsTailscale(app.prefs.baseUrl.orEmpty())
}

/**
 * Drag and drop between apps (split screen, freeform windows, DeX, ChromeOS): files dropped onto a
 * conversation are uploaded to that device, text is sent as a message.
 */
object Drops {
    /** Marks drags that started inside Beam, so a bubble dragged out isn't re-sent by accident. */
    const val LOCAL_DRAG = "app.beam.android.local-drag"

    fun listener(activity: Activity, conversation: () -> String, onHover: (Boolean) -> Unit) = View.OnDragListener { _, e ->
        when (e.action) {
            DragEvent.ACTION_DRAG_STARTED -> e.localState != LOCAL_DRAG && e.clipDescription != null
            DragEvent.ACTION_DRAG_ENTERED -> {
                onHover(true)
                true
            }
            DragEvent.ACTION_DRAG_EXITED, DragEvent.ACTION_DRAG_ENDED -> {
                onHover(false)
                true
            }
            DragEvent.ACTION_DROP -> {
                onHover(false)
                deliver(activity, e, conversation())
            }
            else -> true
        }
    }

    fun deliver(activity: Activity, e: DragEvent, conversation: String): Boolean {
        val app = BeamApp.from(activity)
        val clip = e.clipData ?: return false
        // Grants read access to the dropped content Uris for as long as this activity lives; the
        // upload service gets its own grant when we hand the Uris over.
        activity.requestDragAndDropPermissions(e)
        val uris = ArrayList<Uri>()
        val texts = ArrayList<String>()
        for (i in 0 until clip.itemCount) {
            val item = clip.getItemAt(i)
            val uri = item.uri
            if (uri != null) {
                uris += uri
            } else {
                val text = (item.text ?: item.coerceToText(activity))?.toString()
                if (!text.isNullOrBlank()) texts += text
            }
        }
        val to = Conversations.targets(conversation)
        if (uris.isNotEmpty()) {
            val ok = TransferService.upload(activity, uris, to)
            val message = if (ok) activity.resources.getQuantityString(R.plurals.sending_files, uris.size, uris.size) else activity.getString(R.string.send_failed_start)
            Toast.makeText(activity, message, Toast.LENGTH_SHORT).show()
        }
        val appContext = activity.applicationContext
        for (text in texts) {
            app.scope.launch {
                val result = app.outbox.send(text, to)
                if (result is Outbox.Result.Failed) withContext(Dispatchers.Main) { Toast.makeText(appContext, result.message, Toast.LENGTH_LONG).show() }
            }
        }
        return uris.isNotEmpty() || texts.isNotEmpty()
    }
}

/**
 * A message row (1.12): while picking several ([picking]) it takes every touch itself, so a tap picks the message and
 * nothing inside reacts (a link, a file, the text's selection); its foreground tints it when picked (activated).
 */
class MessageRow @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : FrameLayout(context, attrs) {
    var picking = false
        set(value) {
            field = value
            isClickable = value
            isLongClickable = value
        }

    override fun onInterceptTouchEvent(ev: MotionEvent): Boolean = picking || super.onInterceptTouchEvent(ev)
}

/** A LinearLayout that never gets wider than 82% of its parent (chat bubbles). */
class BubbleLayout @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : LinearLayout(context, attrs) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val mode = MeasureSpec.getMode(widthMeasureSpec)
        if (mode == MeasureSpec.UNSPECIFIED) return super.onMeasure(widthMeasureSpec, heightMeasureSpec)
        val available = MeasureSpec.getSize(widthMeasureSpec)
        val cap = minOf((available * 0.82f).toInt(), (resources.displayMetrics.density * 560).toInt())
        super.onMeasure(MeasureSpec.makeMeasureSpec(minOf(available, cap), MeasureSpec.AT_MOST), heightMeasureSpec)
    }
}

/**
 * A list that stops growing at a share of the screen's height, so whatever sits below it (the Send
 * button of the share sheet) always stays on screen; the list scrolls instead.
 */
class MaxHeightRecyclerView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : RecyclerView(context, attrs) {
    /** Fraction of the window height this list may take. */
    var maxHeightFraction = 0.55f

    override fun onMeasure(widthSpec: Int, heightSpec: Int) {
        val cap = (resources.displayMetrics.heightPixels * maxHeightFraction).toInt()
        val mode = MeasureSpec.getMode(heightSpec)
        val size = MeasureSpec.getSize(heightSpec)
        val limited = when (mode) {
            MeasureSpec.UNSPECIFIED -> MeasureSpec.makeMeasureSpec(cap, MeasureSpec.AT_MOST)
            else -> MeasureSpec.makeMeasureSpec(minOf(size, cap), mode)
        }
        super.onMeasure(widthSpec, limited)
    }
}

/** A scrolling area that stops growing at a share of the screen's height (so buttons below it stay visible). */
class MaxHeightScrollView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : androidx.core.widget.NestedScrollView(context, attrs) {
    var maxHeightFraction = 0.6f

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val cap = (resources.displayMetrics.heightPixels * maxHeightFraction).toInt()
        val mode = MeasureSpec.getMode(heightMeasureSpec)
        val size = MeasureSpec.getSize(heightMeasureSpec)
        val limited = if (mode == MeasureSpec.UNSPECIFIED) MeasureSpec.makeMeasureSpec(cap, MeasureSpec.AT_MOST)
        else MeasureSpec.makeMeasureSpec(minOf(size, cap), mode)
        super.onMeasure(widthMeasureSpec, limited)
    }
}
