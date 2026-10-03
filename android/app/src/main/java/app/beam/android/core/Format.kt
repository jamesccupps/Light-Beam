package app.beam.android.core

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.temporal.ChronoUnit
import java.util.Locale
import kotlin.math.roundToLong

object Format {
    /** "532 B", "1.5 MB", "12 GB" (same style as the server). */
    fun size(bytes: Long): String {
        if (bytes < 1024) return "$bytes B"
        val units = arrayOf("KB", "MB", "GB", "TB")
        var n = bytes.toDouble()
        var i = -1
        do {
            n /= 1024
            i++
        } while (n >= 1024 && i < units.size - 1)
        return if (n < 10) String.format(Locale.US, "%.1f %s", n, units[i]) else "${n.roundToLong()} ${units[i]}"
    }

    private fun zone() = ZoneId.systemDefault()

    fun time(ts: Long): String =
        DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withZone(zone()).format(Instant.ofEpochMilli(ts))

    private fun daysAgo(ts: Long, now: Long): Long {
        val z = zone()
        return ChronoUnit.DAYS.between(Instant.ofEpochMilli(ts).atZone(z).toLocalDate(), Instant.ofEpochMilli(now).atZone(z).toLocalDate())
    }

    private fun date(ts: Long, now: Long): String {
        val z = zone()
        val d = Instant.ofEpochMilli(ts).atZone(z)
        val sameYear = d.year == Instant.ofEpochMilli(now).atZone(z).year
        return DateTimeFormatter.ofPattern(if (sameYear) "MMM d" else "MMM d, yyyy").format(d)
    }

    /** Short relative time for lists: "now", "5 min", "14:02", "Yesterday", "Mon", "Sep 28". */
    fun relative(ts: Long, now: Long = System.currentTimeMillis()): String {
        if (ts <= 0) return ""
        val diff = now - ts
        val days = daysAgo(ts, now)
        return when {
            diff < 60_000 -> "now"
            diff < 3_600_000 -> "${diff / 60_000} min"
            days <= 0 -> time(ts)
            days == 1L -> "Yesterday"
            days < 7 -> DateTimeFormatter.ofPattern("EEE").format(Instant.ofEpochMilli(ts).atZone(zone()))
            else -> date(ts, now)
        }
    }

    /** Day separators in a thread: "Today", "Yesterday", "Monday", "Sep 28". */
    fun day(ts: Long, now: Long = System.currentTimeMillis()): String {
        val days = daysAgo(ts, now)
        return when {
            days <= 0 -> "Today"
            days == 1L -> "Yesterday"
            days < 7 -> DateTimeFormatter.ofPattern("EEEE").format(Instant.ofEpochMilli(ts).atZone(zone()))
            else -> date(ts, now)
        }
    }

    fun dayKey(ts: Long): Long = Instant.ofEpochMilli(ts).atZone(zone()).toLocalDate().toEpochDay()

    /** When something happened, in a sentence: "Oct 3, 08:23" (with the year when it isn't this one). */
    fun at(ts: Long, now: Long = System.currentTimeMillis()): String = date(ts, now) + ", " + time(ts)

    /** "Online", "Last seen 5 min ago", "Last seen yesterday", "Last seen Sep 28". */
    /**
     * A device's last report: "85% battery · 120 GB free" (+ " · Android 16 · Pixel 9 Pro XL" with [withOs]).
     * Null when it never sent one.
     */
    fun deviceStatus(s: DeviceStatus?, withOs: Boolean = false): String? {
        if (s == null) return null
        val parts = ArrayList<String>()
        s.batteryLevel?.let { parts += if (s.charging == true) "$it% charging" else "$it% battery" }
        s.storageFree?.let { parts += "${size(it)} free" }
        if (withOs) s.os?.let { parts += it }
        return parts.joinToString(" · ").ifEmpty { null }
    }

    fun presence(online: Boolean, lastSeen: Long, now: Long = System.currentTimeMillis()): String {
        if (online) return "Online"
        if (lastSeen <= 0) return "Offline"
        val diff = now - lastSeen
        val days = daysAgo(lastSeen, now)
        return when {
            diff < 60_000 -> "Last seen just now"
            diff < 3_600_000 -> "Last seen ${diff / 60_000} min ago"
            days <= 0 -> "Last seen at ${time(lastSeen)}"
            days == 1L -> "Last seen yesterday"
            else -> "Last seen ${date(lastSeen, now)}"
        }
    }

    /** A plain-language description of a failure, for toasts and snackbars. */
    fun error(e: Throwable): String = when (e) {
        is BeamException -> when (e.status) {
            401 -> "The server rejected this device's key. Pair again from Settings."
            413 -> e.message ?: "That's too large for the server."
            410 -> e.movedTo?.let { "Beam has moved to $it." } ?: (e.message ?: "Beam has moved.")
            else -> e.message ?: "The server returned an error."
        }
        // Tailscale names (*.ts.net) only resolve while Tailscale is on; that's the usual reason, not the internet.
        is java.net.UnknownHostException -> if (e.message.orEmpty().contains(".ts.net")) "Can't find your Beam server. Is Tailscale on?"
        else "Can't find the server. Check your internet connection."
        is TransferPausedException -> "Paused."
        is java.net.ConnectException -> "Can't reach the server. Is it running?"
        is java.net.SocketTimeoutException -> "The server took too long to respond."
        is javax.net.ssl.SSLException -> "Couldn't make a secure connection to the server."
        is TransferCancelledException -> "Cancelled."
        is NotBeamServerException -> "That address doesn't answer like a Beam server. Check it and try again."
        is IllegalArgumentException -> e.message ?: "That doesn't look right."
        is SourceChangedException -> e.message ?: "The file changed while it was being sent."
        is SecurityException -> "Beam no longer has access to that file."
        is java.io.FileNotFoundException -> "The file couldn't be opened."
        is java.io.IOException -> "Connection problem. Check your network and try again."
        else -> e.message ?: "Something went wrong."
    }
}
