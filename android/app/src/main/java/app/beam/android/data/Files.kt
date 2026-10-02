package app.beam.android.data

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import app.beam.android.BeamApp
import app.beam.android.core.DownloadSink
import app.beam.android.core.Item
import app.beam.android.core.UploadSource
import java.io.File
import java.io.FileInputStream
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

object Files {
    /** Received files go to Downloads/Beam. */
    val RELATIVE_PATH = Environment.DIRECTORY_DOWNLOADS + "/Beam/"

    fun collection(): Uri = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)

    fun extension(name: String) = name.substringAfterLast('.', "").lowercase()

    /** MIME type from the file extension (what MediaStore expects), else the declared one. */
    fun mimeFor(name: String, declared: String? = null): String =
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension(name))
            ?: declared?.takeIf { it.contains('/') && it != "application/octet-stream" }
            ?: "application/octet-stream"

    fun exists(ctx: Context, uri: Uri): Boolean = try {
        ctx.contentResolver.openFileDescriptor(uri, "r")?.use { true } ?: false
    } catch (_: Exception) {
        false
    }

    fun displayName(ctx: Context, uri: Uri): String? = try {
        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }
    } catch (_: Exception) {
        null
    }

    data class Meta(val name: String, val size: Long, val mime: String)

    /** Name, size (-1 if unknown) and type of a content Uri the user picked or shared. */
    fun meta(ctx: Context, uri: Uri): Meta {
        val resolver = ctx.contentResolver
        var name: String? = null
        var size = -1L
        try {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val si = c.getColumnIndex(OpenableColumns.SIZE)
                    if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni)
                    if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
                }
            }
        } catch (_: Exception) {
        }
        if (uri.scheme == "file") {
            val f = File(uri.path.orEmpty())
            if (name == null) name = f.name
            if (size < 0 && f.exists()) size = f.length()
        }
        if (size < 0) {
            try {
                resolver.openFileDescriptor(uri, "r")?.use { if (it.statSize >= 0) size = it.statSize }
            } catch (_: Exception) {
            }
        }
        val type = try {
            resolver.getType(uri)
        } catch (_: Exception) {
            null
        }
        var n = (name ?: uri.lastPathSegment?.substringAfterLast('/') ?: "file").trim().ifEmpty { "file" }
        val mime = type ?: mimeFor(n)
        if (!n.contains('.')) {
            MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)?.let { n = "$n.$it" }
        }
        return Meta(n, size, mime)
    }
}

/** Streams a content Uri for uploading; seeks when the provider allows it, skips otherwise. */
class UriSource(
    private val ctx: Context,
    val uri: Uri,
    override val name: String,
    override val size: Long,
    override val mime: String,
) : UploadSource {
    override fun open(offset: Long): InputStream {
        val resolver = ctx.contentResolver
        val pfd = resolver.openFileDescriptor(uri, "r")
        if (pfd != null) {
            val input = ParcelFileDescriptor.AutoCloseInputStream(pfd)
            try {
                if (offset > 0) input.channel.position(offset)
                if (offset == 0L || input.channel.position() == offset) return input
            } catch (_: IOException) {
                // A pipe or socket: can't seek.
            }
            input.close()
        }
        val stream = resolver.openInputStream(uri) ?: throw FileNotFoundException("Can't open $name")
        var left = offset
        while (left > 0) {
            val skipped = stream.skip(left)
            if (skipped <= 0) {
                if (stream.read() < 0) throw IOException("The file ended early")
                left--
            } else {
                left -= skipped
            }
        }
        return stream
    }
}

/** A local file (used when a provider doesn't report the size, so we copied it first). */
class FileSource(private val file: File, override val name: String, override val mime: String) : UploadSource {
    override val size: Long = file.length()
    override fun open(offset: Long): InputStream = FileInputStream(file).also { it.channel.position(offset) }
}

/**
 * Downloads into Downloads/Beam through MediaStore. The entry stays "pending" (hidden, temporary name)
 * until [publish], and its Uri is remembered so an interrupted download resumes where it stopped.
 * MediaStore gives the file a unique name ("photo (1).jpg") if one already exists.
 */
class MediaStoreSink(private val ctx: Context, private val item: Item) : DownloadSink {
    private val prefs = BeamApp.from(ctx).prefs
    private val resolver = ctx.contentResolver
    var uri: Uri? = prefs.pendingDownload(item.id)?.takeIf { Files.exists(ctx, it) }
        private set

    private fun ensure(): Uri {
        uri?.let { return it }
        val name = item.displayName.replace(Regex("[\\u0000-\\u001f/\\\\]"), "_").ifBlank { "file" }
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, Files.mimeFor(name))
            put(MediaStore.MediaColumns.RELATIVE_PATH, Files.RELATIVE_PATH)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val created = resolver.insert(Files.collection(), values) ?: throw IOException("Couldn't create the file in Downloads")
        uri = created
        prefs.setPendingDownload(item.id, created)
        return created
    }

    override fun length(): Long {
        val u = uri ?: return 0
        return try {
            resolver.openFileDescriptor(u, "r")?.use { it.statSize.coerceAtLeast(0) } ?: 0
        } catch (_: FileNotFoundException) {
            uri = null
            0
        }
    }

    override fun open(offset: Long): OutputStream {
        val u = ensure()
        val pfd = resolver.openFileDescriptor(u, "rw") ?: throw IOException("Couldn't open the file for writing")
        val out = ParcelFileDescriptor.AutoCloseOutputStream(pfd)
        try {
            out.channel.truncate(offset)
            out.channel.position(offset)
        } catch (e: IOException) {
            out.close()
            throw e
        }
        return out
    }

    /** Makes the finished file visible under its final name; returns its Uri and name. */
    fun publish(): Pair<Uri, String> {
        val u = ensure()
        resolver.update(u, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        prefs.setPendingDownload(item.id, null)
        return u to (Files.displayName(ctx, u) ?: item.displayName)
    }

    fun discard() {
        uri?.let {
            try {
                resolver.delete(it, null, null)
            } catch (_: Exception) {
            }
        }
        uri = null
        prefs.setPendingDownload(item.id, null)
    }
}
