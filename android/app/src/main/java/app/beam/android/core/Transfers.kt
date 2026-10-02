package app.beam.android.core

import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

/** Thrown when a transfer was cancelled by the user. */
class TransferCancelledException : Exception("Cancelled")

/**
 * Thrown when a transfer was paused (Android's time limit for background transfers, or the user). The
 * server keeps the upload session and the partial download stays on disk, so it resumes later.
 */
class TransferPausedException : Exception("Paused")

/** Something that can be uploaded: must know its size up front and be re-openable at any offset. */
interface UploadSource {
    val name: String
    val size: Long
    val mime: String

    /** Opens a stream positioned at [offset]. */
    fun open(offset: Long): InputStream
}

/** Where a download goes. Must survive failures so the download can resume from [length]. */
interface DownloadSink {
    /** Bytes already stored (the resume point). */
    fun length(): Long

    /** Opens a stream positioned at [offset], discarding anything stored after it. */
    fun open(offset: Long): OutputStream
}

/**
 * Resumable upload (docs/API.md "Sending files: resumable"): create a session, PUT chunks at the server's
 * offset, and after a network failure resync the offset (`GET /api/uploads/{id}`, or the 409 body) and
 * carry on with exponential backoff. The file is streamed chunk by chunk, never loaded into memory.
 */
class Uploader(
    private val api: BeamApi,
    private val source: UploadSource,
    private val to: List<String>,
    private val listener: Listener = object : Listener {},
    private val maxFailures: Int = 25,
    private val sleep: (Long) -> Unit = { Thread.sleep(it) },
    /** A picture's size in pixels, if known (sent along so previews have the right shape early). */
    private val size: Pair<Int, Int>? = null,
    /**
     * The server lists `big-chunks` (1.4): each PUT carries about [CHUNK_TARGET_MS] of sending at the speed the
     * last one went, at least [BIG_CHUNK_MIN], at most the server's `maxChunkSize`. Each chunk waits a round trip
     * for its answer before the next one starts: 8 MB chunks left a 25 ms, 50 MB/s link idle 21 % of the time.
     * Bounded requests (not one PUT for the whole file) give clean checkpoints if Android stops the app, and
     * nobody has checked how `tailscale serve` treats a request that runs for hours.
     */
    private val bigChunks: Boolean = false,
) {
    interface Listener {
        fun onStarted(uploadId: String) {}
        fun onProgress(sent: Long, total: Long) {}
        fun onRetry(attempt: Int, error: Throwable, delayMs: Long) {}
    }

    /** The server's upload id (also the id of the finished item). */
    @Volatile var uploadId: String? = null
        private set

    @Volatile private var cancelled = false
    @Volatile private var paused = false
    @Volatile private var kicked = false
    private val holder = CallHolder()

    /** Stops for good and deletes the server's partial upload. */
    fun cancel() {
        cancelled = true
        holder.cancel()
    }

    /** Stops but keeps the server's partial upload, so [run] with the same id resumes it. */
    fun pause() {
        paused = true
        holder.cancel()
    }

    /** The network changed: drop the request in flight and carry on over the new network right away. */
    fun kick() {
        kicked = true
        holder.abortCurrent()
    }

    /** Uploads the file and returns the new item. Pass [resumeId] to continue an earlier session. */
    fun run(resumeId: String? = null): Item {
        val backoff = Backoff()
        var failures = 0
        var id: String? = resumeId
        var offset = -1L // -1: ask the server
        var chunk = UploadInfo.DEFAULT_CHUNK
        var minChunk = chunk
        var maxChunk = chunk
        fun sizes(info: UploadInfo) {
            maxChunk = if (bigChunks) maxOf(info.maxChunkSize, info.chunkSize) else info.chunkSize
            minChunk = if (bigChunks) minOf(BIG_CHUNK_MIN, maxChunk).coerceAtLeast(info.chunkSize) else info.chunkSize
            chunk = chunk.coerceIn(minChunk, maxChunk) // a size measured before a resync stays
        }
        var input: InputStream? = null
        var inputPos = -1L

        fun retryAfter(e: Throwable) {
            if (kicked) {
                // A deliberate reconnect after a network change isn't a failure.
                kicked = false
                return
            }
            failures++
            if (failures > maxFailures) throw e
            val delay = backoff.next()
            listener.onRetry(failures, e, delay)
            sleepChecked(delay)
        }

        try {
            while (true) {
                checkStopped()
                try {
                    if (id == null) {
                        val info = api.createUpload(source.name, source.size, source.mime, to, size?.first ?: 0, size?.second ?: 0)
                        id = info.id
                        sizes(info)
                        offset = info.offset
                        uploadId = id
                        listener.onStarted(info.id)
                    } else if (offset < 0) {
                        try {
                            val info = api.uploadStatus(id)
                            sizes(info)
                            offset = info.offset
                            if (uploadId == null) {
                                uploadId = id
                                listener.onStarted(id)
                            }
                        } catch (e: BeamException) {
                            if (e.status != 404) throw e
                            // The session is gone: it either finished (the item has the same id) or expired.
                            finishedItem(id)?.let { return it }
                            id = null
                            failures++
                            if (failures > maxFailures) throw e
                            continue
                        }
                    }

                    val start = offset
                    listener.onProgress(start, source.size)
                    val len = minOf(chunk, source.size - start)
                    if (input == null || inputPos != start) {
                        input?.close()
                        input = source.open(start)
                        inputPos = start
                    }
                    val body = ChunkBody(input, len) { listener.onProgress(start + it, source.size) }
                    inputPos = -1 // unknown until the chunk went through
                    val t0 = System.nanoTime()
                    val result = api.putChunk(id, start, body, holder)
                    inputPos = start + len
                    chunk = nextChunk(len, (System.nanoTime() - t0) / 1_000_000, minChunk, maxChunk)
                    failures = 0
                    backoff.reset()
                    if (result.done) {
                        listener.onProgress(source.size, source.size)
                        return result.item ?: api.item(id)
                    }
                    offset = result.offset
                } catch (e: BeamException) {
                    checkStopped()
                    val serverOffset = e.offset
                    when {
                        e.status == 409 && serverOffset != null -> {
                            // Same offset means the server is still writing an interrupted chunk: wait a bit.
                            if (serverOffset == offset) retryAfter(e)
                            offset = serverOffset
                        }
                        e.status == 404 && id != null -> {
                            offset = -1
                            retryAfter(e)
                        }
                        // 410: the server moved; the app switches the address and the retry follows it.
                        e.status >= 500 || e.status == 408 || e.status == 429 || e.status == 410 || (e.status == 400 && serverOffset != null) -> {
                            retryAfter(e)
                            offset = -1
                        }
                        else -> throw e
                    }
                } catch (e: SourceChangedException) {
                    throw e
                } catch (e: IOException) {
                    checkStopped()
                    retryAfter(e)
                    if (id != null) offset = -1
                }
            }
        } finally {
            try {
                input?.close()
            } catch (_: IOException) {
            }
            if (cancelled) id?.let { uploadId ->
                try {
                    api.cancelUpload(uploadId)
                } catch (_: Exception) {
                }
            }
        }
    }

    companion object {
        /** Server 1.4 `big-chunks`: each PUT carries about this long of sending (the gap between them costs < 1 %)… */
        const val CHUNK_TARGET_MS = 4_000L

        /** …and at least this much. */
        const val BIG_CHUNK_MIN = 64L * 1024 * 1024

        /** The next chunk: [CHUNK_TARGET_MS] at the speed of the last one ([sent] bytes in [ms]), within [min]…[max]. */
        fun nextChunk(sent: Long, ms: Long, min: Long, max: Long): Long {
            if (max <= min || sent <= 0) return min
            return (sent.toDouble() / ms.coerceAtLeast(1) * CHUNK_TARGET_MS).toLong().coerceIn(min, max)
        }
    }

    private fun finishedItem(id: String): Item? = try {
        api.item(id).takeIf { it.isFile && it.size == source.size }
    } catch (e: BeamException) {
        if (e.status == 404) null else throw e
    }

    private fun checkStopped() {
        if (cancelled) throw TransferCancelledException()
        if (paused) throw TransferPausedException()
    }

    private fun sleepChecked(ms: Long) {
        checkStopped()
        try {
            sleep(ms)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        checkStopped()
    }
}

/**
 * Downloads `GET /api/file/{id}` into a [DownloadSink], resuming with `Range: bytes=N-` after failures.
 * The retry budget counts failures in a row: any attempt that received bytes starts it over, so a
 * multi-GB download over a flaky connection keeps going as long as it makes progress.
 */
class Downloader(
    private val api: BeamApi,
    private val itemId: String,
    private val size: Long,
    private val sink: DownloadSink,
    private val listener: Listener = object : Listener {},
    private val maxFailures: Int = 25,
    private val sleep: (Long) -> Unit = { Thread.sleep(it) },
) {
    interface Listener {
        fun onProgress(received: Long, total: Long) {}
        fun onRetry(attempt: Int, error: Throwable, delayMs: Long) {}
    }

    @Volatile private var cancelled = false
    @Volatile private var paused = false
    @Volatile private var kicked = false
    private val holder = CallHolder()

    fun cancel() {
        cancelled = true
        holder.cancel()
    }

    /** Stops but keeps what arrived, so the next [run] resumes from there. */
    fun pause() {
        paused = true
        holder.cancel()
    }

    /** The network changed: drop the request in flight and resume over the new network right away. */
    fun kick() {
        kicked = true
        holder.abortCurrent()
    }

    fun run() {
        val backoff = Backoff()
        var failures = 0

        fun retryAfter(e: Throwable, progressed: Boolean) {
            if (progressed) {
                failures = 0
                backoff.reset()
            }
            if (kicked) {
                kicked = false
                return
            }
            failures++
            if (failures > maxFailures) throw e
            val delay = backoff.next()
            listener.onRetry(failures, e, delay)
            checkStopped()
            try {
                sleep(delay)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            }
            checkStopped()
        }

        while (true) {
            checkStopped()
            var received = 0L
            try {
                var have = sink.length()
                if (have > size) have = 0
                if (size > 0 && have == size) {
                    listener.onProgress(size, size)
                    return
                }
                api.openFile(itemId, have, holder).use { res ->
                    var start = 0L
                    if (res.code == 206) {
                        val range = res.header("Content-Range").orEmpty()
                        if (!range.startsWith("bytes $have-")) throw IOException("The server sent the wrong part of the file")
                        start = have
                    }
                    val body = res.body ?: throw IOException("Empty download")
                    var got = start
                    listener.onProgress(got, size)
                    sink.open(start).use { out ->
                        body.byteStream().use { input ->
                            val buf = ByteArray(64 * 1024)
                            while (true) {
                                val n = input.read(buf)
                                if (n < 0) break
                                out.write(buf, 0, n)
                                got += n
                                received += n
                                listener.onProgress(got, size)
                            }
                        }
                    }
                }
                val stored = sink.length()
                if (stored == size) return
                throw IOException("Download incomplete ($stored of $size bytes)")
            } catch (e: BeamException) {
                checkStopped()
                when {
                    e.status == 416 -> {
                        if (sink.length() == size) return
                        sink.open(0).close()
                        retryAfter(e, progressed = false)
                    }
                    e.status >= 500 || e.status == 408 || e.status == 429 || e.status == 410 -> retryAfter(e, received > 0)
                    else -> throw e
                }
            } catch (e: IOException) {
                checkStopped()
                retryAfter(e, received > 0)
            }
        }
    }

    private fun checkStopped() {
        if (cancelled) throw TransferCancelledException()
        if (paused) throw TransferPausedException()
    }
}
