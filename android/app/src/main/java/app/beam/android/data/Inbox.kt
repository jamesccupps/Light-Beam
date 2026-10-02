package app.beam.android.data

import android.net.Uri
import app.beam.android.BeamApp
import app.beam.android.core.BeamException
import app.beam.android.core.Conversations
import app.beam.android.core.Item
import app.beam.android.notify.Notifier
import app.beam.android.ui.Clip
import java.util.Collections
import java.util.concurrent.Executors

/**
 * Auto-actions for items sent to this device (docs/API.md checklist): notify, auto-copy, auto-download,
 * then acknowledge. Runs on one thread so catch-up and live events never race. Handled item ids are
 * persisted (capped) so nothing is handled twice.
 */
class Inbox(private val app: BeamApp) {
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "beam-inbox") }
    private val inFlight: MutableSet<String> = Collections.synchronizedSet(HashSet())

    /** Files that would be downloaded automatically but wait for Wi-Fi ("Wi-Fi only" setting). */
    private val waitingForWifi: MutableSet<String> = Collections.synchronizedSet(HashSet())

    init {
        // Back on Wi-Fi: fetch whatever waited for it.
        app.network.addListener { available, _ ->
            if (available && waitingForWifi.isNotEmpty() && !app.network.metered) catchUp()
        }
    }

    /** After every (re)connect: handle whatever arrived while we were away. */
    fun catchUp() = executor.execute { safely { doCatchUp() } }

    fun onItem(item: Item) = executor.execute {
        safely {
            if (app.prefs.baselineDone && item.isFor(app.repo.me) && !app.prefs.isHandled(item.id)) handle(item)
        }
    }

    private fun doCatchUp() {
        val s = app.repo.state.value
        if (!s.loaded || !s.fresh) return
        if (!app.prefs.baselineDone) {
            // First sync after pairing: what's already on the server is old news. Don't notify,
            // download or count it as unread.
            app.prefs.markHandled(s.items.map { it.id })
            val read = HashMap<String, Long>()
            for (item in s.items) for (k in Conversations.keysOf(item, s.me, s.devicesById)) read[k] = maxOf(read[k] ?: 0L, item.ts)
            app.prefs.markAllRead(read)
            app.prefs.baselineDone = true
            return
        }
        for (id in app.prefs.pendingAcks()) ack(id)
        for (item in s.items.asReversed()) {
            if (item.isFor(s.me) && !app.prefs.isHandled(item.id)) handle(item)
        }
    }

    private fun handle(item: Item) {
        if (!inFlight.add(item.id)) return
        try {
            val conv = conversationOf(item)
            val sender = senderName(item)
            val muted = item.from != null && item.from in app.prefs.mutedDevices
            if (item.isText) {
                var text = item.text.orEmpty()
                if (item.truncated) {
                    try {
                        text = app.api?.itemText(item.id) ?: text
                    } catch (_: Exception) {
                    }
                }
                val copy = app.prefs.autoCopy || (item.from != null && item.from in app.prefs.autoCopyDevices)
                val copied = copy && Clip.copy(app, text)
                if (app.visibleConversation != conv) Notifier.textReceived(app, item, text, sender, conv, copied, muted)
                done(item)
            } else {
                val limit = app.prefs.maxDownloadMb * 1024 * 1024
                val fits = limit <= 0 || item.size <= limit
                when {
                    app.prefs.autoDownload && fits && app.prefs.wifiOnlyDownloads && app.network.metered -> {
                        // Stays unhandled: the next catch-up on Wi-Fi downloads it.
                        if (waitingForWifi.add(item.id)) Notifier.fileOffer(app, item, sender, conv, muted, waitingForWifi = true)
                        inFlight.remove(item.id)
                    }
                    app.prefs.autoDownload && fits -> {
                        waitingForWifi.remove(item.id)
                        // Stays "in flight" until onDownloaded / onDownloadFailed.
                        app.transfers.download(item, TransferManager.Reason.AUTO)
                    }
                    else -> {
                        Notifier.fileOffer(app, item, sender, conv, muted, waitingForWifi = false)
                        done(item)
                    }
                }
            }
        } catch (_: Exception) {
            inFlight.remove(item.id)
        }
    }

    /** An automatic download finished: tell the user (unless they're looking at it) and acknowledge. */
    fun onDownloaded(item: Item, uri: Uri, savedName: String) = executor.execute {
        safely {
            val conv = conversationOf(item)
            val muted = item.from != null && item.from in app.prefs.mutedDevices
            if (app.visibleConversation != conv) Notifier.fileSaved(app, item, uri, savedName, senderName(item), conv, muted)
            waitingForWifi.remove(item.id)
            done(item)
        }
    }

    /**
     * [permanent]: the item is gone or the user cancelled, so don't try again. Otherwise the next
     * catch-up retries (and resumes the partial download).
     */
    fun onDownloadFailed(item: Item, error: Throwable, permanent: Boolean) = executor.execute {
        safely {
            inFlight.remove(item.id)
            if (permanent) {
                app.prefs.markHandled(listOf(item.id))
            } else {
                Notifier.downloadFailed(app, item, error, senderName(item), conversationOf(item))
            }
        }
    }

    /** A paused automatic download: it resumes when the user taps the notification or on the next catch-up. */
    fun onDownloadPaused(item: Item) = executor.execute { inFlight.remove(item.id) }

    private fun done(item: Item) {
        app.prefs.markHandled(listOf(item.id))
        inFlight.remove(item.id)
        ack(item.id)
    }

    private fun ack(id: String) {
        try {
            app.api?.ack(id)
            app.prefs.removePendingAck(id)
        } catch (e: BeamException) {
            if (e.status == 404) app.prefs.removePendingAck(id) else app.prefs.addPendingAck(id)
        } catch (_: Exception) {
            app.prefs.addPendingAck(id)
        }
    }

    fun conversationOf(item: Item): String {
        val s = app.repo.state.value
        return Conversations.keysOf(item, s.me, s.devicesById).firstOrNull() ?: Conversations.ALL
    }

    fun senderName(item: Item): String = item.from?.let { app.repo.state.value.devicesById[it]?.name } ?: item.device

    private inline fun safely(block: () -> Unit) {
        try {
            block()
        } catch (_: Exception) {
        }
    }
}
