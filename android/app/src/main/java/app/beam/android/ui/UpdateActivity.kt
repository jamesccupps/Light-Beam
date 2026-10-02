package app.beam.android.ui

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Bundle
import android.provider.Settings
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import app.beam.android.BuildConfig
import app.beam.android.R
import app.beam.android.data.AppUpdater
import app.beam.android.notify.Notifier
import app.beam.android.service.InstallReceiver
import app.beam.android.update.SelfInstaller
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.progressindicator.LinearProgressIndicator
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Installs a downloaded, SHA-256-verified update (when the user asks for it: the notification, the
 * banner, Settings). If Beam may not install apps yet, the user is sent to "Install unknown apps" once.
 * Closing Android's confirmation keeps the update on offer (the notification comes back).
 */
class UpdateActivity : BaseActivity() {
    private var dialog: AlertDialog? = null
    private var waitingForPermission = false
    private var installing = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Notifier.cancel(this, Notifier.ID_UPDATE)
        // Listening the whole time this screen exists: the result often comes while Android's own prompt is in front
        // (this screen stopped), and it must be shown here, not lost.
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.CREATED) {
                app.updates.installStatus.collect(::onStatus)
            }
        }
        lifecycleScope.launch { prepare() }
    }

    private suspend fun prepare() {
        var state = app.updates.state.value
        if (state !is AppUpdater.State.Ready) {
            showProgress(getString(R.string.update_checking))
            state = app.updates.check(force = true)
        }
        when (state) {
            is AppUpdater.State.Ready -> installWhenAllowed(state)
            is AppUpdater.State.Failed -> showMessage(state.message)
            else -> showMessage(getString(R.string.update_none, BuildConfig.VERSION_NAME))
        }
    }

    private fun installWhenAllowed(ready: AppUpdater.State.Ready) {
        if (packageManager.canRequestPackageInstalls()) {
            install(ready)
            return
        }
        dialog?.dismiss()
        dialog = MaterialAlertDialogBuilder(this)
            .setTitle(R.string.update_permission_title)
            .setMessage(R.string.update_permission_body)
            .setNegativeButton(R.string.cancel) { _, _ -> leave() }
            .setPositiveButton(R.string.update_open_settings) { _, _ ->
                waitingForPermission = true
                startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, "package:$packageName".toUri()))
            }
            .setOnCancelListener { leave() }
            .show()
    }

    override fun onResume() {
        super.onResume()
        if (!waitingForPermission) return
        waitingForPermission = false
        val ready = app.updates.state.value as? AppUpdater.State.Ready
        if (ready != null && packageManager.canRequestPackageInstalls()) install(ready) else leave()
    }

    private fun install(ready: AppUpdater.State.Ready) {
        if (installing) return
        installing = true
        showProgress(getString(R.string.update_installing, ready.update.version))
        lifecycleScope.launch {
            val error = withContext(Dispatchers.IO) {
                try {
                    SelfInstaller.install(this@UpdateActivity, ready.file, app.updates::handingOver)
                    null
                } catch (e: Exception) {
                    app.updates.answered()
                    e.message ?: getString(R.string.update_failed)
                }
            }
            if (error != null) failed(PackageInstaller.STATUS_FAILURE, error)
        }
    }

    private fun onStatus(intent: Intent) {
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = InstallReceiver.confirmIntent(intent) ?: return failed(status, getString(R.string.update_no_prompt))
                // Out of sight, an activity may not be opened: the prompt waits in a notification.
                if (!lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) {
                    Notifier.updateNeedsConfirmation(this, app.updates.readyVersion(), confirm)
                    return
                }
                try {
                    startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } catch (e: Exception) {
                    failed(PackageInstaller.STATUS_FAILURE, getString(R.string.update_no_prompt) + " " + (e.message ?: e.javaClass.simpleName))
                }
            }
            PackageInstaller.STATUS_SUCCESS -> finish()
            // The user closed Android's confirmation: nothing is wrong, the update stays on offer.
            PackageInstaller.STATUS_FAILURE_ABORTED -> {
                installing = false
                app.updates.installFailed(status, null)
                showMessage(getString(R.string.update_cancelled))
            }
            else -> failed(status, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE))
        }
    }

    /** It didn't install: why, in Android's words (also kept with the update and sent to the server's log). */
    private fun failed(status: Int, detail: String?) {
        installing = false
        val text = app.updates.installFailed(status, detail) ?: app.updates.describeFailure(status, detail)
        showMessage(getString(R.string.update_failed_try_again, text))
    }

    /** Leaving without installing: the update stays on offer. */
    private fun leave() {
        app.updates.renotify()
        finish()
    }

    private fun showProgress(message: String) {
        dialog?.dismiss()
        val pad = (24 * resources.displayMetrics.density).toInt()
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, 0)
            addView(TextView(this@UpdateActivity).apply { text = message })
            addView(LinearProgressIndicator(this@UpdateActivity).apply { isIndeterminate = true; setPadding(0, pad / 2, 0, 0) })
        }
        dialog = MaterialAlertDialogBuilder(this)
            .setTitle(R.string.update_title)
            .setView(content)
            .setNegativeButton(R.string.cancel) { _, _ -> leave() }
            .setOnCancelListener { leave() }
            .show()
    }

    private fun showMessage(message: String) {
        dialog?.dismiss()
        dialog = MaterialAlertDialogBuilder(this)
            .setTitle(R.string.update_title)
            .setMessage(message)
            .setPositiveButton(android.R.string.ok) { _, _ -> finish() }
            .setOnCancelListener { finish() }
            .show()
    }

    override fun onDestroy() {
        dialog?.setOnCancelListener(null)
        dialog?.dismiss()
        super.onDestroy()
    }

    companion object {
        fun intent(ctx: Context): Intent = Intent(ctx, UpdateActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}
