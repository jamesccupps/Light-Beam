package app.beam.android.ui

import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.view.inputmethod.EditorInfo
import androidx.appcompat.app.AlertDialog
import androidx.core.view.isVisible
import androidx.lifecycle.lifecycleScope
import app.beam.android.BeamApp
import app.beam.android.R
import app.beam.android.core.BeamApi
import app.beam.android.core.BeamException
import app.beam.android.core.CallHolder
import app.beam.android.core.Format
import app.beam.android.core.Pairing
import app.beam.android.core.PollResult
import app.beam.android.core.ServerFinder
import app.beam.android.core.SignInClient
import app.beam.android.core.SignInResult
import app.beam.android.core.SignInTicket
import app.beam.android.data.Prefs
import app.beam.android.databinding.ActivityPairBinding
import app.beam.android.databinding.DialogSigninRequestBinding
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.zxing.BarcodeFormat
import com.journeyapps.barcodescanner.BarcodeEncoder
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException

/**
 * Signing this phone in (docs/API.md, "Signing in a new device" and "Pairing"). With a server address
 * (scanned, pasted or typed) Beam first tries to sign in with no step at all: the server recognises its
 * owner's devices by their Tailscale identity. Otherwise: the pairing link's key, the sign-in password, or
 * approval from a device that's already signed in (QR + code).
 */
class PairActivity : BaseActivity() {
    private lateinit var b: ActivityPairBinding
    private var busy = false
    private var requestDialog: AlertDialog? = null
    private var requestJob: Job? = null
    private var pollHolder = CallHolder()

    /** The sign-in request on screen, withdrawn when the user closes it (so other devices stop asking). */
    private var ticket: Pair<String, SignInTicket>? = null

    private val scanner = registerForActivityResult(ScanContract()) { result ->
        val contents = result.contents ?: return@registerForActivityResult
        if (Pairing.approveCode(contents) != null) {
            showError(getString(R.string.pair_scanned_approve_code))
            return@registerForActivityResult
        }
        b.link.setText(contents)
        signIn()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityPairBinding.inflate(layoutInflater)
        setContentView(b.root)
        b.scroll.padForSystemBars(top = true, bottom = true, ime = true)

        if (savedInstanceState == null) b.name.setText(app.prefs.deviceName)
        b.scan.setOnClickListener {
            scanner.launch(
                ScanOptions()
                    .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                    .setPrompt(getString(R.string.pair_scan_prompt))
                    .setBeepEnabled(false)
                    .setOrientationLocked(false),
            )
        }
        b.linkLayout.setEndIconOnClickListener {
            val text = Clip.read(this).first.firstOrNull()
            if (!text.isNullOrBlank()) b.link.setText(text.trim())
        }
        b.pair.setOnClickListener { signIn() }
        b.another.setOnClickListener { signInWithAnotherDevice() }
        b.password.setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_DONE) {
                signIn()
                true
            } else {
                false
            }
        }
        (intent?.getStringExtra(EXTRA_LINK) ?: intent?.dataString)?.let { link ->
            if (Pairing.parse(link) != null || Pairing.anyServer(link) != null) {
                b.link.setText(link)
                if (savedInstanceState == null) signIn()
            }
        }
        // Signed out by the server (the sign-in was removed or expired): say so, and offer the same server.
        (intent?.getStringExtra(EXTRA_SIGNED_OUT) ?: app.prefs.signedOutFrom)?.let { server ->
            if (b.link.text.isNullOrBlank()) b.link.setText(server)
            if (!busy) showError(getString(R.string.signed_out))
        }
    }

    private fun deviceName(): String =
        b.name.text?.toString()?.trim()?.take(Prefs.MAX_NAME)?.ifEmpty { null } ?: Prefs.defaultDeviceName(this)

    /**
     * The Sign in button. Any address first gets the zero-step sign-in; then a pairing link signs in with
     * its key, a password signs in with the password, and anything else asks another device to approve.
     */
    private fun signIn() {
        if (busy) return
        val input = b.link.text?.toString().orEmpty().trim()
        val link = Pairing.parse(input)
        when {
            input.isEmpty() -> showError(getString(R.string.pair_enter_address))
            link == null && Pairing.approveCode(input) != null -> showError(getString(R.string.pair_scanned_approve_code))
            else -> start(input, link, b.password.text?.toString().orEmpty())
        }
    }

    private fun start(input: String, link: Pairing.Link?, password: String) {
        val name = deviceName()
        setBusy(true)
        lifecycleScope.launch {
            val found = withContext(Dispatchers.IO) { runCatching { ServerFinder.find(link?.baseUrl ?: input, app.http) } }
            val server = found.getOrNull()
            // 1. No step at all: the server knows this device's owner by their Tailscale identity.
            val auto = server?.let { f -> withContext(Dispatchers.IO) { runCatching { SignInClient(f.baseUrl, app.http).autopair(app.prefs.deviceId, name, profile = app.prefs.profileId) }.getOrNull() } }
            if (server != null && auto != null) {
                finishWith(server, auto, name)
                return@launch
            }
            when {
                // 2. The pairing link's key (or single-use pairing token).
                link != null -> {
                    val result = withContext(Dispatchers.IO) {
                        runCatching {
                            BeamApi(server?.baseUrl ?: link.baseUrl, link.key, app.prefs.deviceId, name, "android", app.http, app.prefs.profileId).me()
                            val serverId = server?.hello?.serverId ?: runCatching { SignInClient(link.baseUrl, app.http).hello().serverId }.getOrNull()
                            Pairing.Link(server?.baseUrl ?: link.baseUrl, link.key) to serverId
                        }
                    }
                    setBusy(false)
                    result.onSuccess { (l, serverId) -> finishSignIn(l, name, serverId) }.onFailure { showError(explainKey(it)) }
                }
                server == null -> {
                    setBusy(false)
                    showError(Format.error(found.exceptionOrNull() ?: IOException()))
                }
                // 3. The sign-in password.
                password.isNotEmpty() -> {
                    val result = withContext(Dispatchers.IO) {
                        runCatching {
                            val signedIn = SignInClient(server.baseUrl, app.http).loginWithPassword(password, app.prefs.deviceId)
                            verify(server, signedIn.key, signedIn.server, name)
                        }
                    }
                    setBusy(false)
                    result.onSuccess { (l, serverId) -> finishSignIn(l, name, serverId) }.onFailure { showError(Format.error(it)) }
                }
                // 4. Approval from a device that's already signed in.
                else -> {
                    setBusy(false)
                    showRequestDialog(server, name)
                }
            }
        }
    }

    private suspend fun finishWith(server: ServerFinder.Found, result: SignInResult, name: String) {
        val verified = withContext(Dispatchers.IO) { runCatching { verify(server, result.key, result.server, name) } }
        setBusy(false)
        verified.onSuccess { (link, serverId) -> finishSignIn(link, name, serverId) }.onFailure { showError(Format.error(it)) }
    }

    /**
     * Checks the key and picks the address to keep: the server's own preferred address if this phone
     * can reach it and it's the same Beam, otherwise the one that worked.
     */
    private fun verify(found: ServerFinder.Found, key: String, preferred: String?, name: String): Pair<Pairing.Link, String?> {
        var base = found.baseUrl
        val better = preferred?.let { Pairing.normalizeServer(it) }
        if (better != null && better != base) {
            val there = runCatching { SignInClient(better, app.http).hello() }.getOrNull()
            if (there != null && there.serverId == found.hello.serverId) base = better
        }
        BeamApi(base, key, app.prefs.deviceId, name, "android", app.http, app.prefs.profileId).me()
        return Pairing.Link(base, key) to found.hello.serverId
    }

    private fun finishSignIn(link: Pairing.Link, name: String, serverId: String?) {
        app.completePairing(link, name, serverId)
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        finish()
    }

    private fun explainKey(e: Throwable): String =
        if (e is BeamException && e.status == 401) getString(R.string.pair_key_rejected) else Format.error(e)

    // ---------------------------------------------------------------- sign in with another device

    private fun signInWithAnotherDevice() {
        if (busy) return
        val input = b.link.text?.toString().orEmpty().trim()
        if (input.isEmpty()) {
            showError(getString(R.string.pair_enter_address))
            return
        }
        start(input, Pairing.parse(input), password = "")
    }

    private fun showRequestDialog(found: ServerFinder.Found, name: String) {
        pollHolder = CallHolder()
        val db = DialogSigninRequestBinding.inflate(layoutInflater)
        val dialog = MaterialAlertDialogBuilder(this)
            .setTitle(R.string.signin_another)
            .setView(db.root)
            .setNegativeButton(R.string.cancel, null)
            .setOnDismissListener {
                requestJob?.cancel()
                pollHolder.cancel()
                requestDialog = null
                withdraw()
            }
            .show()
        requestDialog = dialog
        db.retry.setOnClickListener {
            db.retry.isVisible = false
            requestJob = waitForApproval(found, name, db, dialog)
        }
        db.copyCode.setOnClickListener {
            if (Clip.copy(this, db.code.text.toString()) && Build.VERSION.SDK_INT < 33) toast(getString(R.string.copied))
        }
        requestJob = waitForApproval(found, name, db, dialog)
    }

    /** Takes back the request on screen (DELETE /api/login-requests/{id}); best effort, in the background. */
    private fun withdraw() {
        val (base, t) = ticket ?: return
        ticket = null
        val app = BeamApp.from(this)
        app.scope.launch(Dispatchers.IO) { SignInClient(base, app.http).withdraw(t) }
    }

    /** Shows a fresh code + QR and long-polls until it's approved, denied or expires (then renews it). */
    private fun waitForApproval(found: ServerFinder.Found, name: String, db: DialogSigninRequestBinding, dialog: AlertDialog): Job =
        lifecycleScope.launch {
            val client = SignInClient(found.baseUrl, app.http)
            while (isActive) {
                db.status.setText(R.string.signin_waiting)
                val t = withContext(Dispatchers.IO) { runCatching { client.createRequest(name, "android", app.prefs.deviceId) } }.getOrElse {
                    db.status.text = Format.error(it)
                    db.retry.isVisible = true
                    return@launch
                }
                ticket = found.baseUrl to t
                db.code.text = t.code
                db.qrProgress.isVisible = true
                db.qr.setImageBitmap(withContext(Dispatchers.Default) { qr(t.approveUrl) })
                db.qrProgress.isVisible = false
                var result: PollResult = PollResult.Pending
                while (isActive && result == PollResult.Pending) {
                    result = withContext(Dispatchers.IO) {
                        try {
                            client.poll(t, wait = true, holder = pollHolder)
                        } catch (e: IOException) {
                            if (pollHolder.cancelled) return@withContext PollResult.Pending
                            delay(2000)
                            PollResult.Pending
                        } catch (e: BeamException) {
                            delay(3000)
                            PollResult.Pending
                        }
                    }
                    if (pollHolder.cancelled) return@launch
                }
                when (val r = result) {
                    is PollResult.Approved -> {
                        ticket = null // settled; nothing to withdraw
                        db.status.setText(R.string.signin_approved_here)
                        val verified = withContext(Dispatchers.IO) { runCatching { verify(found, r.key, r.server, name) } }
                        verified.onSuccess { (link, serverId) ->
                            dialog.setOnDismissListener(null)
                            dialog.dismiss()
                            finishSignIn(link, name, serverId)
                        }.onFailure {
                            db.status.text = Format.error(it)
                            db.retry.isVisible = true
                        }
                        return@launch
                    }
                    PollResult.Denied -> {
                        ticket = null
                        db.status.setText(R.string.signin_denied_here)
                        db.retry.isVisible = true
                        return@launch
                    }
                    else -> Unit // expired: loop round for a fresh code
                }
            }
        }

    private fun qr(text: String): Bitmap? = runCatching { BarcodeEncoder().encodeBitmap(text, BarcodeFormat.QR_CODE, 600, 600) }.getOrNull()

    private fun setBusy(value: Boolean) {
        busy = value
        b.progress.isVisible = value
        b.pair.isEnabled = !value
        b.scan.isEnabled = !value
        b.another.isEnabled = !value
        if (value) b.error.isVisible = false
    }

    private fun showError(message: String) {
        b.error.text = message
        b.error.isVisible = true
    }

    override fun onDestroy() {
        requestJob?.cancel()
        pollHolder.cancel()
        requestDialog?.setOnDismissListener(null)
        requestDialog?.dismiss()
        if (isFinishing) withdraw()
        super.onDestroy()
    }

    companion object {
        /** A pairing link or server address to sign in with right away (e.g. from a web page's "Open Beam"). */
        const val EXTRA_LINK = "link"

        /** Signed out by this server (it answered 401): say so, and fill in its address. */
        const val EXTRA_SIGNED_OUT = "signedOut"
    }
}
