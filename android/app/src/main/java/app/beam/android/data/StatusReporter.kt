package app.beam.android.data

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.os.SystemClock
import androidx.core.content.ContextCompat
import app.beam.android.BeamApp
import app.beam.android.core.BeamException
import app.beam.android.core.DeviceStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Tells the server this phone's battery, storage and Android version (`PUT /api/devices/me/status`), so other
 * devices can show them and the server can warn when the battery or storage runs low.
 *
 * Never wakes the phone and never sends what the server already has: a report goes out only when something
 * really changed (battery ±5 %, charging on/off, crossing 20 % or 15 %, a gigabyte of storage, the Android
 * version), and only at a moment the phone is awake anyway: when the event stream (re)connects or an event
 * arrives (a heartbeat every 3 minutes in the background), checked at most once a minute. Plugging in or
 * unplugging only notes the new state; the next such moment sends it. The last report the server took is kept
 * across restarts, so an unchanged phone sends nothing after a restart either.
 */
class StatusReporter(private val app: BeamApp) {
    @Volatile private var lastSent: DeviceStatus? = app.prefs.lastStatus
    @Volatile private var lastCheckAt = 0L
    /** Charging as the last plug/unplug broadcast said (the battery may lag behind it by a moment). */
    @Volatile private var chargingHint: Boolean? = null
    /** This server doesn't take status reports (older than 1.3): don't ask again until the next connect. */
    @Volatile private var unsupported = false
    private val sending = AtomicBoolean(false)

    private val power = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            chargingHint = when (intent.action) {
                Intent.ACTION_POWER_CONNECTED -> true
                Intent.ACTION_POWER_DISCONNECTED -> false
                else -> chargingHint
            }
            // Checked (and sent, if it changed) at the next moment the phone is awake for the server anyway.
            lastCheckAt = 0L
        }
    }

    /** Listens for the (rare) power broadcasts while the app runs. */
    fun start() {
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_POWER_CONNECTED)
            addAction(Intent.ACTION_POWER_DISCONNECTED)
            addAction(Intent.ACTION_BATTERY_LOW)
            addAction(Intent.ACTION_BATTERY_OKAY)
        }
        try {
            ContextCompat.registerReceiver(app, power, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        } catch (_: Exception) {
        }
    }

    /**
     * The event stream opened: report if this phone's entry on the server (the connect just fetched the devices)
     * differs from what the phone would report, or has none: a new or restored server gets it at once. Blocking
     * (called in the background after connects).
     */
    fun onConnected() {
        unsupported = false
        val s = app.repo.state.value
        if (s.fresh) lastSent = s.devices.firstOrNull { it.id == s.me }?.status
        check()
    }

    /** A server event arrived (the phone is awake anyway): maybe report. Cheap: one check a minute at most. */
    fun onActivity() {
        if (SystemClock.elapsedRealtime() - lastCheckAt < CHECK_EVERY_MS) return
        check()
    }

    /** Blocking. */
    private fun check() {
        if (unsupported || app.api == null) return
        lastCheckAt = SystemClock.elapsedRealtime()
        val read = read()
        val hint = chargingHint
        val now = if (hint != null && read.batteryLevel != null && read.charging != hint) read.copy(charging = hint) else read
        val before = lastSent
        if (before == null || changed(before, now)) send(now)
    }

    /** Blocking. */
    fun send(status: DeviceStatus) {
        val api = app.api ?: return
        val info = app.repo.state.value.info
        if (info != null && !info.has("device-status")) unsupported = true // a server before 1.3
        if (unsupported || !sending.compareAndSet(false, true)) return
        try {
            api.putStatus(status)
            lastSent = status
            app.prefs.lastStatus = status
            if (status.charging == chargingHint) chargingHint = null
        } catch (e: BeamException) {
            // 404/405: a server before 1.3. 400: it doesn't take one of the fields. Either way, not again now.
            if (e.status == 404 || e.status == 405 || e.status == 400) unsupported = true
        } catch (_: Exception) {
            // Offline: the next connect reports.
        } finally {
            sending.set(false)
        }
    }

    /** Signed out: the next server (or sign-in) gets a fresh report. */
    fun forget() {
        lastSent = null
        lastCheckAt = 0L
        chargingHint = null
    }

    /** The last report the server accepted (for tests and the settings screen). */
    val lastReported: DeviceStatus? get() = lastSent

    /** What this phone would report right now. */
    fun read(): DeviceStatus {
        var level: Int? = null
        var charging: Boolean? = null
        try {
            val bm = app.getSystemService(BatteryManager::class.java)
            val capacity = bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: Int.MIN_VALUE
            if (capacity in 0..100) level = capacity
            if (bm != null) charging = bm.isCharging
        } catch (_: Exception) {
        }
        if (level == null) {
            // Some devices don't report the capacity property: the sticky battery broadcast has it (no receiver kept).
            val sticky = try {
                app.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            } catch (_: Exception) {
                null
            }
            if (sticky != null) {
                val raw = sticky.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
                val scale = sticky.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
                if (raw >= 0 && scale > 0) level = (raw * 100 / scale).coerceIn(0, 100)
                val plugged = sticky.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)
                if (charging == null) charging = plugged != 0
            }
        }
        var free: Long? = null
        var total: Long? = null
        try {
            val fs = StatFs(Environment.getDataDirectory().path)
            free = fs.availableBytes
            total = fs.totalBytes
        } catch (_: Exception) {
        }
        return DeviceStatus(level, if (level != null) charging else null, free, total?.takeIf { it > 0 }, osName())
    }

    companion object {
        const val CHECK_EVERY_MS = 60_000L

        /** "Android 16 · Pixel 9 Pro XL" (at most 60 characters). */
        fun osName(): String {
            val manufacturer = Build.MANUFACTURER.orEmpty().trim()
            val model = Build.MODEL.orEmpty().trim()
            val name = when {
                model.isEmpty() -> manufacturer
                manufacturer.isEmpty() || model.startsWith(manufacturer, ignoreCase = true) || manufacturer.equals("Google", ignoreCase = true) -> model
                else -> manufacturer.replaceFirstChar { if (it.isLowerCase()) it.titlecase(Locale.ROOT) else it.toString() } + " " + model
            }
            val release = Build.VERSION.RELEASE.orEmpty().ifEmpty { Build.VERSION.SDK_INT.toString() }
            return listOf("Android $release", name).filter { it.isNotBlank() }.joinToString(" · ").take(60)
        }

        /** 0: at or below 15 %, 1: at or below 20 %, 2: above. */
        private fun band(level: Int?): Int = when {
            level == null -> -1
            level <= 15 -> 0
            level <= 20 -> 1
            else -> 2
        }

        /** A change worth reporting at once: battery ±5 %, charging on/off, crossing 20 % or 15 %, storage or OS. */
        fun changed(before: DeviceStatus, now: DeviceStatus): Boolean {
            if (before.charging != now.charging) return true
            val a = before.batteryLevel
            val b = now.batteryLevel
            if ((a == null) != (b == null)) return true
            if (a != null && b != null && (kotlin.math.abs(a - b) >= 5 || band(a) != band(b))) return true
            if (before.os != now.os) return true
            // Storage: a gigabyte either way, or 5 % of the disk. Only known with both numbers (that's what's sent).
            val fa = before.storageFree.takeIf { before.storageTotal != null }
            val fb = now.storageFree.takeIf { now.storageTotal != null }
            if ((fa == null) != (fb == null)) return true
            if (fa != null && fb != null) {
                val step = maxOf(1L shl 30, (now.storageTotal ?: 0L) / 20)
                if (kotlin.math.abs(fa - fb) >= step) return true
            }
            return false
        }

    }
}
