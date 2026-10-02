package app.beam.android.service

import android.app.Service
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.IBinder
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import app.beam.android.BeamApp
import app.beam.android.data.TransferManager
import app.beam.android.notify.Notifier
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Foreground service (type `dataSync`) that keeps the process alive while files are being sent or
 * received, showing the progress notification with a Cancel action. Files to upload are handed over
 * as ClipData with FLAG_GRANT_READ_URI_PERMISSION, so this service holds its own read permission for
 * them even after the activity that received them is gone.
 */
class TransferService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var watcher: Job? = null
    private var lastStartId = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val app = BeamApp.from(this)
        lastStartId = startId
        try {
            ServiceCompat.startForeground(this, Notifier.ID_TRANSFERS, app.transfers.buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } catch (_: Exception) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        when (intent?.action) {
            ACTION_UPLOAD -> {
                val uris = ArrayList<Uri>()
                intent.clipData?.let { clip -> for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let(uris::add) }
                val to = intent.getStringArrayExtra(EXTRA_TO)?.toList() ?: emptyList()
                app.transfers.enqueueUploads(uris, to)
            }
            ACTION_DOWNLOAD -> {
                val itemId = intent.getStringExtra(EXTRA_ITEM)
                val tag = intent.getStringExtra(EXTRA_NOTIFICATION_TAG)
                if (tag != null) Notifier.cancel(this, intent.getIntExtra(EXTRA_NOTIFICATION_ID, 0), tag)
                if (itemId != null) startDownload(app, itemId)
            }
            ACTION_RESUME -> app.transfers.resumeAll()
        }
        if (watcher == null) {
            watcher = scope.launch {
                // Stop shortly after the last transfer finishes.
                app.transfers.active.collectLatest { n ->
                    if (n == 0) {
                        delay(1500)
                        // Only if no newer start arrived meanwhile (its files' read grants live until we stop).
                        stopSelfResult(lastStartId)
                    }
                }
            }
        }
        return START_NOT_STICKY
    }

    /** A download started from a notification: its own notification says when the file is saved. */
    private fun startDownload(app: BeamApp, itemId: String) {
        val cached = app.repo.state.value.item(itemId)
        if (cached != null) {
            app.transfers.download(cached, TransferManager.Reason.NOTIFY)
            return
        }
        app.transfers.hold()
        scope.launch {
            try {
                val item = withContext(Dispatchers.IO) { runCatching { app.api?.item(itemId) }.getOrNull() }
                if (item != null) app.transfers.download(item, TransferManager.Reason.NOTIFY)
            } finally {
                app.transfers.unhold()
            }
        }
    }

    /**
     * Android 15+: dataSync services may run 6 hours a day. When time is up, pause everything (the server
     * keeps the upload sessions, the partial downloads stay) and offer "Resume" in a notification.
     */
    override fun onTimeout(startId: Int, fgsType: Int) {
        val app = BeamApp.from(this)
        if (app.transfers.pauseAll()) Notifier.transfersPaused(this)
        stopSelf()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        const val ACTION_UPLOAD = "app.beam.android.action.UPLOAD"
        const val ACTION_DOWNLOAD = "app.beam.android.action.DOWNLOAD"
        const val ACTION_RESUME = "app.beam.android.action.RESUME"
        const val ACTION_KEEP_ALIVE = "app.beam.android.action.KEEP_ALIVE"
        private const val EXTRA_TO = "to"
        private const val EXTRA_ITEM = "item"
        private const val EXTRA_NOTIFICATION_TAG = "notificationTag"
        private const val EXTRA_NOTIFICATION_ID = "notificationId"

        /**
         * Sends files to [to] (empty = all devices). Must be called while the caller can read [uris]
         * (an activity that received them, or a drop with DragAndDropPermissions).
         */
        fun upload(ctx: Context, uris: List<Uri>, to: List<String>): Boolean {
            if (uris.isEmpty()) return false
            val clip = ClipData.newRawUri("files", uris[0])
            for (i in 1 until uris.size) clip.addItem(ClipData.Item(uris[i]))
            val intent = Intent(ctx, TransferService::class.java)
                .setAction(ACTION_UPLOAD)
                .putExtra(EXTRA_TO, to.toTypedArray())
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            intent.clipData = clip
            return try {
                ContextCompat.startForegroundService(ctx, intent)
                true
            } catch (_: Exception) {
                false
            }
        }

        fun downloadIntent(ctx: Context, itemId: String, tag: String?, notificationId: Int): Intent =
            Intent(ctx, TransferService::class.java)
                .setAction(ACTION_DOWNLOAD)
                .putExtra(EXTRA_ITEM, itemId)
                .putExtra(EXTRA_NOTIFICATION_TAG, tag)
                .putExtra(EXTRA_NOTIFICATION_ID, notificationId)

        fun resumeIntent(ctx: Context): Intent = Intent(ctx, TransferService::class.java).setAction(ACTION_RESUME)

        /** Makes sure the service runs while transfers are active (ignored if Android doesn't allow it now). */
        fun keepAlive(ctx: Context) {
            try {
                ContextCompat.startForegroundService(ctx, Intent(ctx, TransferService::class.java).setAction(ACTION_KEEP_ALIVE))
            } catch (_: Exception) {
            }
        }
    }
}
