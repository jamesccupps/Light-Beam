package app.beam.android.core

import okhttp3.HttpUrl
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.MessageDigest

/** The Android build the server offers (`GET /api/updates` → `android`, docs/API.md "App updates"). */
data class AppUpdate(val version: String, val versionCode: Int, val url: String, val size: Long, val sha256: String) {
    fun isNewerThan(installedVersionCode: Int) = versionCode > installedVersionCode

    companion object {
        fun parse(o: JSONObject?): AppUpdate? {
            if (o == null || !o.has("versionCode")) return null
            val url = o.str("url") ?: return null
            val sha = o.str("sha256")?.lowercase() ?: return null
            return AppUpdate(o.optString("version"), o.optInt("versionCode"), url, o.optLong("size"), sha)
        }
    }
}

/** The downloaded file isn't the build the server described: never install it. */
class UpdateVerificationException : IOException("The downloaded update didn't pass the SHA-256 check, so it wasn't installed")

object Updates {
    /** `GET /api/updates`: the Android build on offer, if any. */
    fun available(api: BeamApi): AppUpdate? {
        val req = api.request(api.url("/api/updates")).get().build()
        val body = api.execute(req).use { it.body?.string().orEmpty() }
        return AppUpdate.parse(JSONObject(body.ifBlank { "{}" }).optJSONObject("android"))
    }

    /**
     * The update's download address, only if it's on the Beam server itself (the key is sent along,
     * so it must never go anywhere else).
     */
    fun resolve(api: BeamApi, update: AppUpdate): HttpUrl {
        // "/download/android" is relative to Beam's own root, which may sit under a path behind a proxy.
        val resolved = api.base.resolve(update.url) ?: throw IOException("The update link is broken")
        val u = if (update.url.startsWith("/")) {
            api.url(resolved.encodedPath).newBuilder().encodedQuery(resolved.encodedQuery).build()
        } else {
            resolved
        }
        if (u.host != api.base.host || u.port != api.base.port || u.scheme != api.base.scheme) {
            throw IOException("The update link points away from your Beam server, so it was ignored")
        }
        return u
    }

    /**
     * Downloads [update] to [dest] (through a temporary file) and checks its SHA-256.
     * Throws [UpdateVerificationException] (and deletes the file) if it doesn't match.
     */
    fun download(api: BeamApi, update: AppUpdate, dest: File, onProgress: (Long, Long) -> Unit = { _, _ -> }): File {
        val part = File(dest.path + ".part")
        val digest = MessageDigest.getInstance("SHA-256")
        val req = api.request(resolve(api, update)).get().build()
        api.execute(req).use { res ->
            val body = res.body ?: throw IOException("Empty download")
            val total = body.contentLength().takeIf { it > 0 } ?: update.size
            body.byteStream().use { input ->
                part.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    var done = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        digest.update(buf, 0, n)
                        out.write(buf, 0, n)
                        done += n
                        onProgress(done, total)
                    }
                }
            }
        }
        if (!hex(digest.digest()).equals(update.sha256, ignoreCase = true)) {
            part.delete()
            throw UpdateVerificationException()
        }
        dest.delete()
        if (!part.renameTo(dest)) {
            part.copyTo(dest, overwrite = true)
            part.delete()
        }
        return dest
    }

    /** True if [file] exists and is exactly [update] (so it needn't be downloaded again). */
    fun matches(file: File, update: AppUpdate): Boolean = file.isFile && sha256(file).equals(update.sha256, ignoreCase = true)

    fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                digest.update(buf, 0, n)
            }
        }
        return hex(digest.digest())
    }

    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }
}
