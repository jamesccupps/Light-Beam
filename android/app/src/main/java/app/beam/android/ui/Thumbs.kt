package app.beam.android.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.util.LruCache
import android.widget.ImageView
import androidx.core.graphics.scale
import androidx.core.view.isVisible
import app.beam.android.BeamApp
import app.beam.android.R
import app.beam.android.core.Item
import java.io.File
import java.util.Collections
import java.util.concurrent.Executors
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Image previews for file bubbles: memory cache + small JPEG thumbnails on disk. */
object Thumbs {
    private const val MAX_PX = 720
    private const val MAX_REMOTE_BYTES = 25L * 1024 * 1024

    private val cache = object : LruCache<String, Bitmap>((Runtime.getRuntime().maxMemory() / 12 / 1024).toInt()) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount / 1024
    }
    /** Recent failures (key → time), retried after a minute (e.g. the network was down). */
    private val failed: MutableMap<String, Long> = Collections.synchronizedMap(HashMap())
    private val scope = CoroutineScope(SupervisorJob() + Executors.newFixedThreadPool(2).asCoroutineDispatcher())

    /**
     * Shows the preview for [key] in [view]; [onResult] says whether there is one (false: show it as a file). With
     * [keepShape] the view keeps its size (a gallery tile, 1.12) instead of taking the picture's shape.
     */
    fun bind(view: ImageView, key: String, load: () -> Bitmap?, keepShape: Boolean = false, onResult: (Boolean) -> Unit = {}) {
        view.setTag(R.id.thumb_key, key)
        cache.get(key)?.let {
            show(view, it, keepShape)
            onResult(true)
            return
        }
        view.setImageDrawable(null)
        val failedAt = failed[key]
        if (failedAt != null && System.currentTimeMillis() - failedAt < 60_000) {
            onResult(false)
            return
        }
        view.isVisible = true
        scope.launch {
            val bmp = try {
                load()
            } catch (_: Exception) {
                null
            }
            if (bmp != null) cache.put(key, bmp) else failed[key] = System.currentTimeMillis()
            withContext(Dispatchers.Main) {
                if (view.getTag(R.id.thumb_key) == key) {
                    if (bmp != null) show(view, bmp, keepShape)
                    onResult(bmp != null)
                }
            }
        }
    }

    /** Signed out: previews don't stay, in memory or on disk (including the small copies of saved photos). */
    fun forgetAll(ctx: Context) {
        cache.evictAll()
        failed.clear()
        BeamApp.from(ctx).discard(File(ctx.cacheDir, "thumbs")) // gone at once, deleted in the background
    }

    private const val KEEP_FILES = 1_000
    private const val KEEP_BYTES = 100L * 1024 * 1024
    private val writes = java.util.concurrent.atomic.AtomicInteger()

    /**
     * Writes [file] whole or not at all (a temporary file, then a rename): another loader of the same preview
     * never decodes half a JPEG. Every 50 writes the folder is pruned (see [prune]).
     */
    private fun writeWhole(file: File, write: (java.io.OutputStream) -> Unit) {
        val tmp = File(file.parentFile, file.name + ".tmp-" + Thread.currentThread().id)
        try {
            tmp.outputStream().use(write)
            if (!tmp.renameTo(file)) {
                file.delete()
                if (!tmp.renameTo(file)) throw java.io.IOException("Can't save ${file.name}")
            }
        } finally {
            tmp.delete()
        }
        if (writes.incrementAndGet() % 50 == 0) prune(file.parentFile ?: return)
    }

    /** A preview read from disk: marks it as recently used (pruning keeps those). */
    private fun touched(file: File): File = file.also { it.setLastModified(System.currentTimeMillis()) }

    /**
     * Keeps the most recently used previews: at most [keepFiles] files and [keepBytes] (the cache folder; Android may
     * also clear it). Leftovers of interrupted writes go after an hour.
     */
    internal fun prune(dir: File, keepFiles: Int = KEEP_FILES, keepBytes: Long = KEEP_BYTES) {
        val all = dir.listFiles()?.filter { it.isFile } ?: return
        val hourAgo = System.currentTimeMillis() - 3_600_000L
        all.filter { !it.name.endsWith(".jpg") && it.lastModified() < hourAgo }.forEach { it.delete() }
        var bytes = 0L
        all.filter { it.name.endsWith(".jpg") }.sortedByDescending { it.lastModified() }.forEachIndexed { i, f ->
            bytes += f.length()
            if (i >= keepFiles || bytes > keepBytes) f.delete()
        }
    }

    /** Sizes the preview box for a [w]x[h] picture (before it has loaded), like [show] does after. */
    fun shape(view: ImageView, w: Int, h: Int) {
        val lp = view.layoutParams
        val width = lp.width.takeIf { it > 0 } ?: view.resources.getDimensionPixelSize(R.dimen.thumb_width)
        val height = (width.toFloat() * h / w.coerceAtLeast(1)).toInt().coerceIn((width * 0.5f).toInt(), (width * 1.35f).toInt())
        if (lp.height != height) {
            lp.height = height
            view.layoutParams = lp
        }
    }

    fun clear(view: ImageView) {
        view.setTag(R.id.thumb_key, null)
        view.setImageDrawable(null)
    }

    private fun show(view: ImageView, bmp: Bitmap, keepShape: Boolean = false) {
        view.isVisible = true
        if (keepShape) {
            view.setImageBitmap(bmp)
            return
        }
        val lp = view.layoutParams
        val width = lp.width.takeIf { it > 0 } ?: view.resources.getDimensionPixelSize(R.dimen.thumb_width)
        val height = (width.toFloat() * bmp.height / bmp.width.coerceAtLeast(1)).toInt()
            .coerceIn((width * 0.5f).toInt(), (width * 1.35f).toInt())
        if (lp.height != height) {
            lp.height = height
            view.layoutParams = lp
        }
        view.setImageBitmap(bmp)
    }

    private fun thumbFile(ctx: Context, itemId: String) = File(File(ctx.cacheDir, "thumbs").apply { mkdirs() }, "$itemId.jpg")

    /** The small copy of a photo saved on this phone (its own file: the server's thumbnail is smaller still). */
    private fun localThumbFile(ctx: Context, itemId: String) = File(File(ctx.cacheDir, "thumbs").apply { mkdirs() }, "$itemId.local.jpg")

    /**
     * Preview of an item: from the saved copy, a thumbnail kept on the device, the server's small thumbnail
     * (API v3), or, for pictures up to 25 MB on older servers, the picture itself.
     */
    fun loadItem(ctx: Context, item: Item, local: Uri?): Bitmap? {
        if (local != null && item.isImage) {
            // A small copy of the saved photo: ~20× quicker than decoding the original again (a 12 MP photo
            // is several MB) whenever the preview has left the memory cache.
            val small = localThumbFile(ctx, item.id)
            if (small.exists()) BitmapFactory.decodeFile(touched(small).path)?.let { return it }
            try {
                val bmp = decode(ImageDecoder.createSource(ctx.contentResolver, local))
                try {
                    writeWhole(small) { bmp.compress(Bitmap.CompressFormat.JPEG, 85, it) }
                } catch (_: Exception) {
                    // No small copy this time: the next preview decodes the original again.
                }
                return bmp
            } catch (_: Exception) {
                // Deleted or unreadable: fall back to the server copy.
            }
        }
        val thumb = thumbFile(ctx, item.id)
        if (thumb.exists()) BitmapFactory.decodeFile(touched(thumb).path)?.let { return it }
        val api = BeamApp.from(ctx).api ?: return null
        if (item.thumb) {
            val bytes = api.thumb(item.id)
            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return null
            writeWhole(thumb) { it.write(bytes) }
            return bmp
        }
        if (local != null && item.isVideo) return videoFrame(ctx, local)
        if (!item.isImage || item.size > MAX_REMOTE_BYTES) return null
        val part = File(thumb.parentFile, "${item.id}.part")
        try {
            api.openFile(item.id, 0).use { res ->
                val body = res.body ?: return null
                body.byteStream().use { input -> part.outputStream().use { input.copyTo(it) } }
            }
            val bmp = decode(ImageDecoder.createSource(part))
            writeWhole(thumb) { bmp.compress(Bitmap.CompressFormat.JPEG, 85, it) }
            return bmp
        } finally {
            part.delete()
        }
    }

    /** A photo or video this device sent: keep a preview from the original, so it isn't downloaded again to show it. */
    fun saveOwn(ctx: Context, itemId: String, bmp: Bitmap) {
        writeWhole(thumbFile(ctx, itemId)) { bmp.compress(Bitmap.CompressFormat.JPEG, 85, it) }
        cache.put("i:$itemId", bmp)
    }

    /** A preview of a picture or video on the device (up to [MAX_PX]), or null. */
    fun preview(ctx: Context, uri: Uri, mime: String): Bitmap? = try {
        if (mime.startsWith("video/")) videoFrame(ctx, uri) else decode(ImageDecoder.createSource(ctx.contentResolver, uri))
    } catch (_: Exception) {
        null
    }

    private fun videoFrame(ctx: Context, uri: Uri): Bitmap? = try {
        ctx.contentResolver.loadThumbnail(uri, android.util.Size(MAX_PX, MAX_PX), null)
    } catch (_: Exception) {
        try {
            android.media.MediaMetadataRetriever().use { r ->
                r.setDataSource(ctx, uri)
                r.getScaledFrameAtTime(1_000_000, android.media.MediaMetadataRetriever.OPTION_CLOSEST_SYNC, MAX_PX, MAX_PX)
            }
        } catch (_: Exception) {
            null
        }
    }

    /**
     * The small JPEG the server keeps for a picture or video (API v3): about 320 px, at most 256 KB.
     */
    fun serverThumb(bmp: Bitmap): ByteArray? {
        val longest = maxOf(bmp.width, bmp.height).coerceAtLeast(1)
        val scale = minOf(1.0, 320.0 / longest)
        val small = if (scale < 1.0) bmp.scale((bmp.width * scale).toInt().coerceAtLeast(1), (bmp.height * scale).toInt().coerceAtLeast(1)) else bmp
        for (quality in intArrayOf(80, 60, 40)) {
            val out = java.io.ByteArrayOutputStream()
            small.compress(Bitmap.CompressFormat.JPEG, quality, out)
            if (out.size() <= 256 * 1024) return out.toByteArray()
        }
        return null
    }

    /** Width and height of a picture or video on the device, or null. */
    fun pictureSize(ctx: Context, uri: Uri, mime: String): Pair<Int, Int>? = try {
        if (mime.startsWith("video/")) {
            android.media.MediaMetadataRetriever().use { r ->
                r.setDataSource(ctx, uri)
                val w = r.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
                val h = r.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
                val rotation = r.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
                if (w <= 0 || h <= 0) null else if (rotation % 180 != 0) h to w else w to h
            }
        } else if (mime.startsWith("image/")) {
            var size: Pair<Int, Int>? = null
            try {
                ImageDecoder.decodeDrawable(ImageDecoder.createSource(ctx.contentResolver, uri)) { _, info, _ ->
                    size = info.size.width to info.size.height
                    throw StopDecoding() // only the header was needed
                }
            } catch (_: StopDecoding) {
            }
            size
        } else {
            null
        }
    } catch (_: Exception) {
        null
    }

    private class StopDecoding : RuntimeException()

    fun loadUri(ctx: Context, uri: Uri): Bitmap? = decode(ImageDecoder.createSource(ctx.contentResolver, uri))

    private fun decode(source: ImageDecoder.Source): Bitmap = ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
        val w = info.size.width
        val h = info.size.height
        val longest = maxOf(w, h)
        if (longest > MAX_PX) {
            val scale = MAX_PX.toDouble() / longest
            decoder.setTargetSize((w * scale).toInt().coerceAtLeast(1), (h * scale).toInt().coerceAtLeast(1))
        }
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
    }
}
