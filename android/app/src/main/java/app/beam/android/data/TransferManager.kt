package app.beam.android.data

import android.app.Notification
import android.net.Uri
import android.os.SystemClock
import androidx.core.net.toUri
import app.beam.android.BeamApp
import app.beam.android.core.BeamException
import app.beam.android.core.Conversations
import app.beam.android.core.Downloader
import app.beam.android.core.Format
import app.beam.android.core.Item
import app.beam.android.core.TransferCancelledException
import app.beam.android.core.TransferPausedException
import app.beam.android.core.UploadSource
import app.beam.android.core.Uploader
import app.beam.android.notify.Notifier
import app.beam.android.service.TransferService
import app.beam.android.ui.Thumbs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.Collections
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * Runs uploads (one at a time) and downloads (two at a time) on background threads and publishes their
 * progress for the UI and the transfers notification. [TransferService] keeps the process alive while
 * anything is [active].
 *
 * The queue is saved on the device, so transfers survive the app being killed or updating itself: uploads
 * continue their server session, downloads their partial file. Android's daily limit for background
 * transfers pauses them (nothing is thrown away) until the user taps "Resume".
 */
class TransferManager(private val app: BeamApp) {
    enum class Status { QUEUED, PREPARING, RUNNING, RETRYING, PAUSED, FAILED }

    /** Why a file is being downloaded; decides what happens when it's done. */
    enum class Reason {
        /** Received and saved by itself: the inbox notifies and acknowledges. */
        AUTO,
        /** Save / Open / Share tapped in a conversation: that screen acts on it if it's still showing. */
        SAVE, OPEN, SHARE,
        /** Started from a notification (or resumed after a restart): a notification says when it's saved. */
        NOTIFY,
    }

    data class Upload(
        val localId: String,
        val uri: Uri,
        val name: String,
        val size: Long,
        val mime: String,
        val to: List<String>,
        val sent: Long = 0,
        val status: Status = Status.QUEUED,
        val error: String? = null,
        val createdAt: Long = System.currentTimeMillis(),
        val serverId: String? = null,
        /** Failed for lack of a connection: tried again by itself after the next reconnect. */
        val retryable: Boolean = false,
    ) {
        val active get() = status != Status.FAILED && status != Status.PAUSED

        fun toJson(): JSONObject = JSONObject().put("localId", localId).put("uri", uri.toString()).put("name", name)
            .put("size", size).put("mime", mime).put("to", JSONArray(to)).put("status", status.name)
            .put("error", error).put("createdAt", createdAt).put("serverId", serverId).put("retryable", retryable)

        companion object {
            fun parse(o: JSONObject): Upload? {
                val status = runCatching { Status.valueOf(o.optString("status")) }.getOrDefault(Status.QUEUED)
                return Upload(
                    localId = o.optString("localId").ifEmpty { return null },
                    uri = o.optString("uri").ifEmpty { return null }.toUri(),
                    name = o.optString("name", "file"),
                    size = o.optLong("size", -1),
                    mime = o.optString("mime", "application/octet-stream"),
                    to = o.optJSONArray("to")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList(),
                    // Whatever was running when the app stopped simply runs again.
                    status = when (status) {
                        Status.FAILED, Status.PAUSED -> status
                        else -> Status.QUEUED
                    },
                    error = o.optString("error").takeIf { it.isNotEmpty() && it != "null" },
                    createdAt = o.optLong("createdAt"),
                    serverId = o.optString("serverId").takeIf { it.isNotEmpty() && it != "null" },
                    retryable = o.optBoolean("retryable"),
                )
            }
        }
    }

    data class Download(
        val itemId: String,
        val name: String,
        val size: Long,
        val received: Long = 0,
        val status: Status = Status.QUEUED,
        val error: String? = null,
    ) {
        val active get() = status != Status.FAILED && status != Status.PAUSED
    }

    data class Finished(val item: Item, val reason: Reason, val uri: Uri)

    /** A screen that acts on finished Save/Open/Share downloads (returns true if it did). */
    fun interface FinishedHandler {
        fun onFinished(f: Finished): Boolean
    }

    private val _uploads = MutableStateFlow<List<Upload>>(emptyList())
    val uploads: StateFlow<List<Upload>> = _uploads

    private val _downloads = MutableStateFlow<Map<String, Download>>(emptyMap())
    val downloads: StateFlow<Map<String, Download>> = _downloads

    /** The conversation screen on top, if any (set in onResume, cleared in onPause). */
    @Volatile var finishedHandler: FinishedHandler? = null

    private val _active = MutableStateFlow(0)
    /** Number of queued or running transfers. */
    val active: StateFlow<Int> = _active

    private val preparing = AtomicInteger(0)
    private val uploadQueue = Channel<String>(Channel.UNLIMITED)
    private val downloadQueue = Channel<DlTask>(Channel.UNLIMITED)
    private val uploaders = ConcurrentHashMap<String, Uploader>()
    private val downloaders = ConcurrentHashMap<String, Downloader>()
    private val cancelledUploads: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private val pausedUploads: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private val dlTasks = ConcurrentHashMap<String, DlTask>()
    private var lastNotify = 0L

    private class DlTask(val item: Item) {
        val reasons: MutableSet<Reason> = Collections.synchronizedSet(HashSet())
        @Volatile var cancelled = false
        @Volatile var paused = false
    }

    init {
        app.scope.launch(Dispatchers.IO) { for (id in uploadQueue) runUpload(id) }
        repeat(2) { app.scope.launch(Dispatchers.IO) { for (task in downloadQueue) runDownload(task) } }
        restore()
        // The network changed: running transfers drop their stalled request and resume over the new one.
        app.network.addListener { available, switched -> if (available && switched) kickAll() }
    }

    // ---------------------------------------------------------------- persistence

    private fun saveState() {
        val ups = JSONArray().apply { _uploads.value.forEach { put(it.toJson()) } }
        val downs = JSONArray()
        for (task in dlTasks.values) {
            val d = _downloads.value[task.item.id] ?: continue
            if (task.cancelled) continue
            // After a restart nobody is left to open or share it: say when it's saved instead.
            val reasons = task.reasons.map { if (it == Reason.OPEN || it == Reason.SHARE || it == Reason.SAVE) Reason.NOTIFY else it }.toSet()
            downs.put(JSONObject().put("item", task.item.toJson()).put("reasons", JSONArray(reasons.map { it.name })).put("paused", d.status == Status.PAUSED))
        }
        app.prefs.saveArray(Prefs.K_TRANSFERS, JSONArray().put(JSONObject().put("uploads", ups).put("downloads", downs)))
    }

    private fun restore() {
        val root = app.prefs.loadArray(Prefs.K_TRANSFERS).optJSONObject(0) ?: return
        val ups = root.optJSONArray("uploads") ?: JSONArray()
        val restored = (0 until ups.length()).mapNotNull { ups.optJSONObject(it)?.let(Upload::parse) }
        if (restored.isNotEmpty()) {
            _uploads.value = restored
            restored.filter { it.status == Status.QUEUED }.forEach { uploadQueue.trySend(it.localId) }
        }
        val downs = root.optJSONArray("downloads") ?: JSONArray()
        for (i in 0 until downs.length()) {
            val o = downs.optJSONObject(i) ?: continue
            val item = o.optJSONObject("item")?.let(Item::parse) ?: continue
            val reasons = o.optJSONArray("reasons")?.let { a -> (0 until a.length()).mapNotNull { runCatching { Reason.valueOf(a.getString(it)) }.getOrNull() } }.orEmpty()
            val task = DlTask(item).also { it.reasons += reasons.ifEmpty { listOf(Reason.NOTIFY) } }
            dlTasks[item.id] = task
            val paused = o.optBoolean("paused")
            _downloads.update { it + (item.id to Download(item.id, item.displayName, item.size, status = if (paused) Status.PAUSED else Status.QUEUED)) }
            if (paused) task.paused = true else downloadQueue.trySend(task)
        }
        recount()
        if (_active.value > 0) TransferService.keepAlive(app)
    }

    // ---------------------------------------------------------------- uploads

    /** Queues files for sending. Called by [TransferService], which holds the read permission for them. */
    fun enqueueUploads(uris: List<Uri>, to: List<String>) {
        if (uris.isEmpty()) return
        preparing.incrementAndGet()
        recount()
        app.scope.launch(Dispatchers.IO) {
            app.reportSent(to)
            try {
                for (uri in uris) {
                    val meta = Files.meta(app, uri)
                    val up = Upload(UUID.randomUUID().toString(), uri, meta.name, meta.size, meta.mime, to)
                    _uploads.update { it + up }
                    saveState()
                    recount()
                    uploadQueue.send(up.localId)
                }
            } catch (e: Exception) {
                Notifier.uploadFailed(app, "your file", Format.error(e), conversationFor(to))
            } finally {
                preparing.decrementAndGet()
                recount()
                notifyProgress(force = true)
            }
        }
    }

    fun retryUpload(localId: String) {
        val up = _uploads.value.firstOrNull { it.localId == localId && (it.status == Status.FAILED || it.status == Status.PAUSED) } ?: return
        updateUpload(localId) { copy(status = Status.QUEUED, error = null, retryable = false) }
        saveState()
        recount()
        TransferService.keepAlive(app)
        uploadQueue.trySend(up.localId)
    }

    /** Cancels a queued/running upload, or removes a failed one. */
    fun cancelUpload(localId: String) {
        val up = _uploads.value.firstOrNull { it.localId == localId } ?: return
        cancelledUploads += localId
        val running = uploaders[localId]
        if (running != null) {
            running.cancel()
        } else {
            _uploads.update { list -> list.filterNot { it.localId == localId } }
            cancelledUploads -= localId
            val serverId = up.serverId
            if (serverId != null) app.scope.launch(Dispatchers.IO) { runCatching { app.api?.cancelUpload(serverId) } }
            saveState()
            recount()
            notifyProgress(force = true)
        }
    }

    private fun runUpload(localId: String) {
        val up = _uploads.value.firstOrNull { it.localId == localId } ?: return
        if (up.status != Status.QUEUED || localId in cancelledUploads) return
        val api = app.api
        if (api == null) {
            updateUpload(localId) { copy(status = Status.FAILED, error = "Not paired") }
            recount()
            return
        }
        var temp: File? = null
        try {
            var source: UploadSource = UriSource(app, up.uri, up.name, up.size, up.mime)
            if (up.size < 0) {
                // The app that shared this didn't say how big it is; resumable uploads need the size.
                updateUpload(localId) { copy(status = Status.PREPARING) }
                val copy = copyToCache(up)
                temp = copy
                source = FileSource(copy, up.name, up.mime)
                updateUpload(localId) { copy(size = copy.length()) }
            }
            updateUpload(localId) { copy(status = Status.RUNNING, error = null, retryable = false) }
            val visual = up.mime.startsWith("image/") || up.mime.startsWith("video/")
            val pictureSize = if (visual) Thumbs.pictureSize(app, up.uri, up.mime) else null
            val last = AtomicLong(0)
            val bigChunks = app.repo.state.value.info?.lists("big-chunks") == true
            val uploader = Uploader(api, source, up.to, size = pictureSize, bigChunks = bigChunks, listener = object : Uploader.Listener {
                override fun onStarted(uploadId: String) {
                    updateUpload(localId) { copy(serverId = uploadId) }
                    saveState() // from now on a restart resumes this session
                }

                override fun onProgress(sent: Long, total: Long) {
                    val now = SystemClock.elapsedRealtime()
                    if (now - last.get() >= 250 || sent == total) {
                        last.set(now)
                        updateUpload(localId) { copy(sent = sent, status = Status.RUNNING, error = null) }
                        notifyProgress()
                    }
                }

                override fun onRetry(attempt: Int, error: Throwable, delayMs: Long) {
                    updateUpload(localId) { copy(status = Status.RETRYING, error = "Connection lost, retrying…") }
                    notifyProgress(force = true)
                }
            })
            uploaders[localId] = uploader
            if (localId in cancelledUploads) uploader.cancel()
            if (localId in pausedUploads) uploader.pause()
            val item = uploader.run(_uploads.value.firstOrNull { it.localId == localId }?.serverId ?: up.serverId)
            app.repo.upsert(item)
            if (visual) saveOwnThumbnail(item, up)
            _uploads.update { list -> list.filterNot { it.localId == localId } }
        } catch (_: TransferCancelledException) {
            _uploads.update { list -> list.filterNot { it.localId == localId } }
        } catch (_: TransferPausedException) {
            updateUpload(localId) { copy(status = Status.PAUSED, error = null) }
        } catch (e: Exception) {
            if (localId in cancelledUploads) {
                _uploads.update { list -> list.filterNot { it.localId == localId } }
            } else {
                val message = Format.error(e)
                val offline = e is IOException && e !is java.io.FileNotFoundException && e !is app.beam.android.core.SourceChangedException
                updateUpload(localId) { copy(status = Status.FAILED, error = message, retryable = offline) }
                if (app.visibleConversation == null && !offline) Notifier.uploadFailed(app, up.name, message, conversationFor(up.to))
            }
        } finally {
            uploaders.remove(localId)
            cancelledUploads.remove(localId)
            pausedUploads.remove(localId)
            temp?.delete()
            saveState()
            recount()
            notifyProgress(force = true)
        }
    }

    /**
     * A preview of a photo or video this phone sent, made from the original: kept here (so it isn't
     * downloaded again to show it) and given to the server (API v3), so other devices needn't fetch the file.
     */
    private fun saveOwnThumbnail(item: Item, up: Upload) {
        try {
            val bmp = Thumbs.preview(app, up.uri, up.mime) ?: return
            Thumbs.saveOwn(app, item.id, bmp)
            if (app.repo.state.value.info?.has("thumbnails") == true) {
                Thumbs.serverThumb(bmp)?.let { app.api?.putThumb(item.id, it) }
            }
        } catch (_: Exception) {
        }
    }

    private fun copyToCache(up: Upload): File {
        val dir = File(app.cacheDir, "outgoing").apply { mkdirs() }
        val file = File(dir, up.localId)
        app.contentResolver.openInputStream(up.uri)?.use { input -> file.outputStream().use { input.copyTo(it, 256 * 1024) } }
            ?: throw java.io.FileNotFoundException("Can't open ${up.name}")
        return file
    }

    private fun updateUpload(localId: String, change: Upload.() -> Upload) =
        _uploads.update { list -> list.map { if (it.localId == localId) it.change() else it } }

    // ---------------------------------------------------------------- downloads

    /** Downloads [item] to Downloads/Beam (or reuses the saved copy), then acts on [reason]. */
    fun download(item: Item, reason: Reason) {
        val local = app.prefs.localFile(item.id)
        if (local != null) {
            if (Files.exists(app, local)) {
                finished(Finished(item, reason, local), Files.displayName(app, local) ?: item.displayName)
                return
            }
            app.prefs.setLocalFile(item.id, null) // the user deleted it; download again
        }
        synchronized(dlTasks) {
            val existing = dlTasks[item.id]
            if (existing != null && !existing.cancelled) {
                existing.reasons += reason
                if (existing.paused) resumeDownload(existing)
                return
            }
            val task = DlTask(item).also { it.reasons += reason }
            dlTasks[item.id] = task
            _downloads.update { it + (item.id to Download(item.id, item.displayName, item.size)) }
            saveState()
            recount()
            downloadQueue.trySend(task)
        }
        TransferService.keepAlive(app)
        notifyProgress(force = true)
    }

    private fun resumeDownload(task: DlTask) {
        task.paused = false
        updateDownload(task.item.id) { copy(status = Status.QUEUED, error = null) }
        saveState()
        recount()
        downloadQueue.trySend(task)
    }

    fun cancelDownload(itemId: String) {
        val task = dlTasks[itemId]
        if (task != null) {
            task.cancelled = true
            downloaders[itemId]?.cancel()
        }
        val d = _downloads.value[itemId]
        if (d != null && (d.status == Status.FAILED || d.status == Status.PAUSED)) {
            dlTasks.remove(itemId)
            _downloads.update { it - itemId }
            app.prefs.pendingDownload(itemId)?.let { runCatching { app.contentResolver.delete(it, null, null) } }
            app.prefs.setPendingDownload(itemId, null)
            saveState()
            recount()
        }
    }

    private fun runDownload(task: DlTask) {
        val item = task.item
        val api = app.api
        if (task.paused) return
        if (task.cancelled || api == null) {
            dlTasks.remove(item.id)
            _downloads.update { it - item.id }
            if (Reason.AUTO in task.reasons) app.inbox.onDownloadFailed(item, TransferCancelledException(), permanent = true)
            saveState()
            recount()
            return
        }
        val sink = MediaStoreSink(app, item)
        updateDownload(item.id) { copy(status = Status.RUNNING, error = null) }
        val last = AtomicLong(0)
        val downloader = Downloader(api, item.id, item.size, sink, object : Downloader.Listener {
            override fun onProgress(received: Long, total: Long) {
                val now = SystemClock.elapsedRealtime()
                if (now - last.get() >= 250 || received == total) {
                    last.set(now)
                    updateDownload(item.id) { copy(received = received, status = Status.RUNNING, error = null) }
                    notifyProgress()
                }
            }

            override fun onRetry(attempt: Int, error: Throwable, delayMs: Long) {
                updateDownload(item.id) { copy(status = Status.RETRYING, error = "Connection lost, retrying…") }
                notifyProgress(force = true)
            }
        })
        downloaders[item.id] = downloader
        if (task.cancelled) downloader.cancel()
        if (task.paused) downloader.pause()
        try {
            downloader.run()
            val (uri, name) = sink.publish()
            app.prefs.setLocalFile(item.id, uri)
            val reasons: List<Reason>
            synchronized(dlTasks) {
                dlTasks.remove(item.id)
                reasons = task.reasons.toList()
                _downloads.update { it - item.id }
            }
            for (r in reasons) finished(Finished(item, r, uri), name)
        } catch (_: TransferPausedException) {
            updateDownload(item.id) { copy(status = Status.PAUSED, error = null) }
            if (Reason.AUTO in task.reasons) app.inbox.onDownloadPaused(item)
        } catch (e: TransferCancelledException) {
            sink.discard()
            dlTasks.remove(item.id)
            _downloads.update { it - item.id }
            if (Reason.AUTO in task.reasons) app.inbox.onDownloadFailed(item, e, permanent = true)
        } catch (e: Exception) {
            val gone = e is BeamException && e.status == 404
            dlTasks.remove(item.id)
            if (gone) {
                sink.discard()
                _downloads.update { it - item.id }
            } else {
                updateDownload(item.id) { copy(status = Status.FAILED, error = Format.error(e)) }
            }
            if (Reason.AUTO in task.reasons) {
                app.inbox.onDownloadFailed(item, e, permanent = gone)
            } else if (!app.isInForeground || finishedHandler == null) {
                Notifier.downloadFailed(app, item, e, app.inbox.senderName(item), app.inbox.conversationOf(item))
            }
        } finally {
            downloaders.remove(item.id)
            saveState()
            recount()
            notifyProgress(force = true)
        }
    }

    /**
     * A download is done (or the file was already saved). Automatic downloads go to the inbox; the rest
     * go to the conversation on screen if there is one that wants it, otherwise a notification says the
     * file was saved (with Open / Share), so nothing finishes silently.
     */
    private fun finished(f: Finished, savedName: String) {
        if (f.reason == Reason.AUTO) {
            app.inbox.onDownloaded(f.item, f.uri, savedName)
            return
        }
        val handled = f.reason != Reason.NOTIFY && finishedHandler?.onFinished(f) == true
        if (!handled) {
            Notifier.fileSaved(app, f.item, f.uri, savedName, app.inbox.senderName(f.item), app.inbox.conversationOf(f.item), muted = false)
        }
    }

    private fun updateDownload(itemId: String, change: Download.() -> Download) =
        _downloads.update { m -> m[itemId]?.let { m + (itemId to it.change()) } ?: m }

    // ---------------------------------------------------------------- everything

    /** Counts as an active transfer while work is being prepared (keeps the service from stopping). */
    fun hold() {
        preparing.incrementAndGet()
        recount()
    }

    fun unhold() {
        preparing.decrementAndGet()
        recount()
    }

    fun cancelAll() {
        _uploads.value.forEach { cancelUpload(it.localId) }
        dlTasks.keys.toList().forEach { cancelDownload(it) }
    }

    /**
     * Android's time limit for background transfers ran out: stop everything but keep the progress (the
     * server's upload sessions and the partial downloads) until the user resumes. Returns true if anything
     * was paused.
     */
    fun pauseAll(): Boolean {
        var any = false
        for (up in _uploads.value) {
            when {
                uploaders[up.localId] != null -> {
                    pausedUploads += up.localId
                    uploaders[up.localId]?.pause()
                    any = true
                }
                up.status == Status.QUEUED || up.status == Status.PREPARING -> {
                    updateUpload(up.localId) { copy(status = Status.PAUSED) }
                    any = true
                }
            }
        }
        for (task in dlTasks.values) {
            if (task.cancelled || task.paused) continue
            task.paused = true
            downloaders[task.item.id]?.pause() ?: updateDownload(task.item.id) { copy(status = Status.PAUSED) }
            any = true
        }
        saveState()
        recount()
        return any
    }

    /** "Resume" on the paused notification (or in a conversation): carry on where everything stopped. */
    fun resumeAll() {
        for (up in _uploads.value.filter { it.status == Status.PAUSED }) retryUpload(up.localId)
        for (task in dlTasks.values.filter { it.paused }) resumeDownload(task)
        Notifier.cancel(app, Notifier.ID_PAUSED)
        TransferService.keepAlive(app)
        notifyProgress(force = true)
    }

    val hasPaused: Boolean get() = _uploads.value.any { it.status == Status.PAUSED } || dlTasks.values.any { it.paused }

    /** Back online: uploads that failed for lack of a connection try again by themselves. */
    fun onConnected() {
        val waiting = _uploads.value.filter { it.status == Status.FAILED && it.retryable }
        waiting.forEach { retryUpload(it.localId) }
    }

    /** The network changed: every running transfer drops its request and resumes right away. */
    fun kickAll() {
        uploaders.values.forEach { it.kick() }
        downloaders.values.forEach { it.kick() }
    }

    private fun recount() {
        _active.value = preparing.get() + _uploads.value.count { it.active } + _downloads.value.values.count { it.active }
    }

    private fun conversationFor(to: List<String>) = to.firstOrNull() ?: Conversations.ALL

    @Synchronized
    private fun notifyProgress(force: Boolean = false) {
        val now = SystemClock.elapsedRealtime()
        if (!force && now - lastNotify < 700) return
        lastNotify = now
        if (_active.value == 0) Notifier.cancel(app, Notifier.ID_TRANSFERS) else Notifier.post(app, Notifier.ID_TRANSFERS, buildNotification())
    }

    /** The ongoing "Sending… / Receiving…" notification (also the transfer service's notification). */
    fun buildNotification(): Notification {
        val ups = _uploads.value.filter { it.active }
        val downs = _downloads.value.values.filter { it.active }
        val total = ups.sumOf { it.size.coerceAtLeast(0) } + downs.sumOf { it.size }
        val done = ups.sumOf { it.sent } + downs.sumOf { it.received }
        val count = ups.size + downs.size
        val title = when {
            count == 0 -> "Getting ready…"
            downs.isEmpty() -> if (ups.size == 1) "Sending ${ups[0].name}" else "Sending ${ups.size} files"
            ups.isEmpty() -> if (downs.size == 1) "Receiving ${downs[0].name}" else "Receiving ${downs.size} files"
            else -> "Transferring $count files"
        }
        val retrying = ups.any { it.status == Status.RETRYING } || downs.any { it.status == Status.RETRYING }
        val percent = if (total > 0) (done * 100 / total).toInt().coerceIn(0, 100) else 0
        val text = when {
            retrying -> "Connection lost, retrying…"
            total > 0 -> "$percent% · ${Format.size(done)} of ${Format.size(total)}"
            else -> ""
        }
        return Notifier.transfers(app, title, text, percent, indeterminate = total <= 0 || count == 0, big = total >= BIG_TRANSFER)
    }

    companion object {
        /** From this size on, transfers get Android 16's progress-centric ("Live Update") notification. */
        const val BIG_TRANSFER = 50L * 1024 * 1024
    }
}
