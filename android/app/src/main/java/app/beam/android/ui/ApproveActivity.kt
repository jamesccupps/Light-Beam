package app.beam.android.ui

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.net.toUri
import androidx.core.view.isVisible
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import app.beam.android.BeamApp
import app.beam.android.R
import app.beam.android.core.BeamException
import app.beam.android.core.Format
import app.beam.android.core.LoginRequest
import app.beam.android.core.Pairing
import app.beam.android.databinding.SheetApproveBinding
import app.beam.android.notify.Notifier
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * "Work Laptop wants to sign in": shows who is asking, from where, and the code, then approves or
 * denies (Steam-style sign-in). Reached from the scanner, the notification, a link, or a typed code.
 * Not exported: only Beam itself (and its notifications) can open it, so nothing can approve silently.
 */
class ApproveActivity : BaseActivity() {
    private lateinit var sb: SheetApproveBinding
    private var sheet: BottomSheetDialog? = null
    private var request: LoginRequest? = null
    private var code = ""
    private var busy = false
    private var settled = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!app.prefs.paired) {
            Toast.makeText(this, R.string.not_paired, Toast.LENGTH_LONG).show()
            finish()
            return
        }
        code = Pairing.normalizeCode(intent.getStringExtra(EXTRA_CODE).orEmpty())
        if (code.length != 8) {
            Toast.makeText(this, R.string.signin_not_a_code, Toast.LENGTH_LONG).show()
            finish()
            return
        }
        showSheet()
        lookUp(approveNow = intent.getBooleanExtra(EXTRA_APPROVE_NOW, false))
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                // Settled somewhere else (another device, the web app) while this was open.
                app.signIns.settled.collect { (id, status) ->
                    if (id == request?.id && !busy && !settled) showDone(status, byMe = false)
                }
            }
        }
    }

    private fun showSheet() {
        sb = SheetApproveBinding.inflate(layoutInflater)
        val dialog = BottomSheetDialog(this)
        sheet = dialog
        dialog.setContentView(sb.root)
        dialog.behavior.skipCollapsed = true
        dialog.behavior.state = BottomSheetBehavior.STATE_EXPANDED
        dialog.setOnDismissListener { finish() }
        sb.code.text = Pairing.formatCode(code)
        sb.approve.setOnClickListener { answer(approve = true) }
        sb.deny.setOnClickListener { answer(approve = false) }
        dialog.show()
    }

    private fun lookUp(approveNow: Boolean) {
        sb.progress.visibility = android.view.View.VISIBLE
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { app.api!!.loginRequest(code) } }
            sb.progress.visibility = android.view.View.INVISIBLE
            result.onSuccess { r ->
                request = r
                Notifier.cancelSignIn(this@ApproveActivity, r.id)
                sb.title.text = getString(if (r.isMove) R.string.signin_wants_move else R.string.signin_wants, r.name)
                if (r.isMove) sb.hint.setText(R.string.signin_move_warning)
                sb.where.text = if (r.where.isNotBlank()) getString(R.string.signin_from, r.where) else ""
                sb.where.isVisible = r.where.isNotBlank()
                sb.who.text = r.who?.let { getString(R.string.signin_who, it) }
                sb.who.isVisible = r.who != null
                sb.avatar.setImageResource(platformIcon(r.platform))
                sb.code.text = r.code
                val total = ((r.expiresAt - r.createdAt) / 60_000).coerceAtLeast(1)
                val minutes = ((r.expiresAt - System.currentTimeMillis()) / 60_000 + 1).coerceIn(1, total)
                sb.expires.text = getString(R.string.signin_expires, minutes)
                sb.approve.isEnabled = true
                sb.deny.isEnabled = true
                if (approveNow) answer(approve = true)
            }.onFailure { showError(explain(it)) }
        }
    }

    private fun explain(e: Throwable): String {
        if (e is BeamException && e.status == 404) {
            val host = intent.getStringExtra(EXTRA_HOST)
            val ours = app.prefs.baseUrl
            return if (host != null && ours != null && host != ours) getString(R.string.signin_other_server, host.substringAfter("://"))
            else getString(R.string.signin_not_found)
        }
        return Format.error(e)
    }

    private fun answer(approve: Boolean) {
        if (busy || settled) return
        busy = true
        sb.approve.isEnabled = false
        sb.deny.isEnabled = false
        sb.progress.visibility = android.view.View.VISIBLE
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { app.api!!.answerLoginRequest(code, approve) } }
            busy = false
            sb.progress.visibility = android.view.View.INVISIBLE
            result.onSuccess { status -> showDone(status, byMe = true) }
                .onFailure { showError(explain(it)) }
        }
    }

    private fun showDone(status: String, byMe: Boolean) {
        settled = true
        val name = request?.name ?: getString(R.string.signin_the_device)
        sb.buttons.isVisible = false
        sb.hint.isVisible = false
        sb.expires.isVisible = false
        sb.message.isVisible = true
        sb.message.setTextColor(getColor(R.color.text))
        sb.message.text = when {
            status == "approved" && byMe -> getString(R.string.signin_approved, name)
            status == "approved" -> getString(R.string.signin_approved_elsewhere, name)
            status == "denied" -> getString(R.string.signin_denied)
            else -> getString(R.string.signin_expired)
        }
        lifecycleScope.launch {
            delay(1400)
            sheet?.dismiss()
        }
    }

    private fun showError(message: String) {
        sb.message.isVisible = true
        sb.message.setTextColor(getColor(R.color.danger))
        sb.message.text = message
        sb.approve.isEnabled = false
        sb.deny.isEnabled = false
    }

    override fun onDestroy() {
        sheet?.setOnDismissListener(null)
        sheet?.dismiss()
        super.onDestroy()
    }

    companion object {
        private const val EXTRA_CODE = "code"
        private const val EXTRA_APPROVE_NOW = "approveNow"
        private const val EXTRA_HOST = "host"

        /** [approveNow]: from the notification's Approve button (the user already saw who's asking). */
        fun intent(ctx: Context, code: String, approveNow: Boolean = false, host: String? = null): Intent =
            Intent(ctx, ApproveActivity::class.java)
                .setAction("app.beam.android.action.APPROVE." + (if (approveNow) "now." else "") + Pairing.normalizeCode(code))
                .putExtra(EXTRA_CODE, code)
                .putExtra(EXTRA_APPROVE_NOW, approveNow)
                .putExtra(EXTRA_HOST, host)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}

/**
 * Opened for `https://<server>/?approve=CODE` links (a phone camera or browser opening the sign-in
 * QR code). Hands approval codes to [ApproveActivity]; anything else goes on to the browser.
 */
class ApproveLinkActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val data = intent.data
        val link = data?.toString().orEmpty()
        val code = Pairing.approveCode(link)
        val prefs = BeamApp.from(this).prefs
        val paired = prefs.paired
        if (code != null && paired) {
            // (1.7.6, audit S-35) Only a link for this phone's own Beam opens the approval sheet.
            val host = Pairing.approveHost(link)
            if (Pairing.isOwnServer(host, prefs.baseUrl, prefs.alternates)) startActivity(ApproveActivity.intent(this, code, host = host))
            else Toast.makeText(this, getString(R.string.signin_link_other_server, host?.substringAfter("://") ?: "?"), Toast.LENGTH_LONG).show()
        } else if (!paired && Pairing.parse(link) != null) {
            // A pairing link opened from the camera or a web page: sign this phone in with it.
            startActivity(Intent(this, PairActivity::class.java).putExtra(PairActivity.EXTRA_LINK, link).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } else if (data != null) {
            openInBrowser(data)
        }
        finish()
    }

    private fun openInBrowser(uri: Uri) {
        val view = Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        // The default browser, found with a URL nobody else claims (Beam must not handle its own link).
        val browser = packageManager.resolveActivity(
            Intent(Intent.ACTION_VIEW, "https://example.com/".toUri()).addCategory(Intent.CATEGORY_BROWSABLE),
            PackageManager.MATCH_DEFAULT_ONLY,
        )?.activityInfo?.packageName
        try {
            if (browser != null && browser != packageName && browser != "android") {
                startActivity(view.setPackage(browser))
            } else {
                val chooser = Intent.createChooser(view, null)
                    .putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, arrayOf(componentName))
                startActivity(chooser)
            }
        } catch (_: Exception) {
            Toast.makeText(this, R.string.signin_no_browser, Toast.LENGTH_LONG).show()
        }
    }
}
