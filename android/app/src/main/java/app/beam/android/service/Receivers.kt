package app.beam.android.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.widget.Toast
import androidx.core.app.RemoteInput
import app.beam.android.BeamApp
import app.beam.android.R
import app.beam.android.core.Conversations
import app.beam.android.core.Format
import app.beam.android.notify.Notifier
import app.beam.android.ui.Clip
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Starts the background connection after a reboot or an app update, if "Stay connected" is on. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val app = BeamApp.from(context)
        if (app.prefs.paired && app.prefs.stayConnected) ConnectionService.start(context)
        // After an update, transfers that were running continue (they were saved before the restart).
        if (app.transfers.active.value > 0) TransferService.keepAlive(context)
    }
}

/** Notification actions that don't open a screen: Copy, Reply, Deny, Cancel transfers. */
class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = BeamApp.from(context)
        when (intent.action) {
            ACTION_COPY -> {
                val itemId = intent.getStringExtra(EXTRA_ITEM) ?: return
                val tag = intent.getStringExtra(EXTRA_TAG)
                val inline = intent.getStringExtra(EXTRA_TEXT)
                val pending = goAsync()
                app.scope.launch {
                    try {
                        val text = inline ?: withContext(Dispatchers.IO) {
                            runCatching { app.api?.itemText(itemId) }.getOrNull()
                                ?: app.repo.state.value.item(itemId)?.text
                        }
                        withContext(Dispatchers.Main) {
                            if (text != null && Clip.copy(context, text)) {
                                // Android 13+ shows its own confirmation.
                                if (Build.VERSION.SDK_INT < 33) Toast.makeText(context, R.string.copied, Toast.LENGTH_SHORT).show()
                                if (tag != null) Notifier.cancel(context, Notifier.ID_TEXTS, tag)
                                Notifier.cancel(context, Notifier.idFor(itemId), tag)
                                Notifier.updateSummary(context)
                            }
                        }
                    } finally {
                        pending.finish()
                    }
                }
            }
            ACTION_REPLY -> {
                val conversation = intent.getStringExtra(EXTRA_CONVERSATION) ?: return
                val reply = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(Notifier.KEY_REPLY)?.toString()?.trim()
                if (reply.isNullOrEmpty()) return
                // Shown right away; the outbox sends it (now, or once the server can be reached).
                Notifier.replied(context, conversation, reply)
                app.readMarkers.markRead(conversation, app.repo.state.value.items
                    .filter { conversation in Conversations.keysOf(it, app.repo.me, app.repo.state.value.devicesById) }
                    .maxOfOrNull { it.ts } ?: 0L)
                val pending = goAsync()
                app.scope.launch {
                    try {
                        app.outbox.send(reply, Conversations.targets(conversation))
                    } finally {
                        pending.finish()
                    }
                }
            }
            ACTION_CHILD_DISMISSED -> Notifier.updateSummary(context)
            ACTION_STOP_RINGING -> app.ringer.stop(tellServer = true)
            ACTION_CANCEL_TRANSFERS -> app.transfers.cancelAll()
            ACTION_DENY_SIGNIN -> {
                val requestId = intent.getStringExtra(EXTRA_ITEM) ?: return
                val code = intent.getStringExtra(EXTRA_CODE) ?: return
                val pending = goAsync()
                app.scope.launch {
                    try {
                        val message = withContext(Dispatchers.IO) {
                            try {
                                app.api?.answerLoginRequest(code, approve = false)
                                context.getString(R.string.signin_denied)
                            } catch (e: Exception) {
                                Format.error(e)
                            }
                        }
                        withContext(Dispatchers.Main) {
                            Notifier.cancelSignIn(context, requestId)
                            Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
                        }
                    } finally {
                        pending.finish()
                    }
                }
            }
        }
    }

    companion object {
        private const val ACTION_COPY = "app.beam.android.action.COPY"
        private const val ACTION_REPLY = "app.beam.android.action.REPLY"
        private const val ACTION_CHILD_DISMISSED = "app.beam.android.action.CHILD_DISMISSED"
        private const val ACTION_CANCEL_TRANSFERS = "app.beam.android.action.CANCEL_TRANSFERS"
        private const val ACTION_DENY_SIGNIN = "app.beam.android.action.DENY_SIGNIN"
        private const val ACTION_STOP_RINGING = "app.beam.android.action.STOP_RINGING"
        private const val EXTRA_CODE = "code"
        private const val EXTRA_ITEM = "item"
        private const val EXTRA_TEXT = "text"
        private const val EXTRA_TAG = "tag"
        private const val EXTRA_CONVERSATION = "conversation"

        fun copyIntent(ctx: Context, itemId: String, text: String?, tag: String): Intent =
            Intent(ctx, ActionReceiver::class.java).setAction(ACTION_COPY)
                .putExtra(EXTRA_ITEM, itemId).putExtra(EXTRA_TEXT, text).putExtra(EXTRA_TAG, tag)

        fun replyIntent(ctx: Context, conversation: String): Intent =
            Intent(ctx, ActionReceiver::class.java).setAction(ACTION_REPLY).putExtra(EXTRA_CONVERSATION, conversation)

        fun childDismissedIntent(ctx: Context): Intent = Intent(ctx, ActionReceiver::class.java).setAction(ACTION_CHILD_DISMISSED)

        fun denySignInIntent(ctx: Context, requestId: String, code: String): Intent =
            Intent(ctx, ActionReceiver::class.java).setAction(ACTION_DENY_SIGNIN)
                .putExtra(EXTRA_ITEM, requestId).putExtra(EXTRA_CODE, code)

        fun cancelTransfersIntent(ctx: Context): Intent =
            Intent(ctx, ActionReceiver::class.java).setAction(ACTION_CANCEL_TRANSFERS)

        fun stopRingingIntent(ctx: Context): Intent = Intent(ctx, ActionReceiver::class.java).setAction(ACTION_STOP_RINGING)
    }
}

/**
 * Result of a PackageInstaller session. Hands it to [app.beam.android.ui.UpdateActivity] if it's on
 * screen; otherwise (a silent update in the background, or the screen was closed) a confirmation Android
 * asks for becomes a notification: an activity may not be opened from the background.
 */
class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        // (an answer always has a status: without one, nothing was answered)
        if (intent.action != ACTION_STATUS || !intent.hasExtra(PackageInstaller.EXTRA_STATUS)) return
        val app = BeamApp.from(context)
        // An earlier try that a newer one gave up: Android answers it "aborted", which isn't about the update now.
        if (!app.updates.isCurrent(intent.getIntExtra(EXTRA_SESSION, intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)))) return
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        if (status != PackageInstaller.STATUS_PENDING_USER_ACTION) app.updates.answered()
        if (app.updates.publishInstallStatus(intent)) return
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> confirmIntent(intent)?.let {
                Notifier.updateNeedsConfirmation(context, app.updates.readyVersion(), it)
            }
            PackageInstaller.STATUS_SUCCESS -> Unit // the new version starts itself (MY_PACKAGE_REPLACED)
            else -> app.updates.installFailed(status, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE))
        }
    }

    companion object {
        const val ACTION_STATUS = "app.beam.android.action.INSTALL_STATUS"
        const val EXTRA_SESSION = "app.beam.android.extra.SESSION"

        fun confirmIntent(intent: Intent): Intent? = androidx.core.content.IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java)
    }
}
