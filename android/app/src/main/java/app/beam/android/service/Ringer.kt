package app.beam.android.service

import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationAttributes
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import androidx.annotation.MainThread
import app.beam.android.BeamApp
import app.beam.android.core.str
import app.beam.android.notify.Notifier
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * "Ring this phone" (server 1.3, `ring` events): the alarm sound at full volume (so it's heard even on silent,
 * where Android lets alarms through), vibration and a "Ringing from <device>" notification with Stop, for up to
 * a minute. Stops on Stop, when Beam is opened, or on `ring {stop: true}`; the alarm volume is put back after.
 * Also remembers which other devices are ringing, so their menus offer "Stop ringing".
 */
class Ringer(private val app: BeamApp) {
    private val main = Handler(Looper.getMainLooper())
    private var player: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var savedAlarmVolume = -1
    private var focus: AudioFocusRequest? = null
    // After a minute (the other devices stop showing it by themselves then).
    private val autoStop = Runnable { stop(tellServer = false) }

    private val _ringing = MutableStateFlow(false)
    /** This phone is ringing. */
    val ringing: StateFlow<Boolean> = _ringing

    private val _others = MutableStateFlow<Map<String, Long>>(emptyMap())
    /** Other devices being rung right now (id → until when). */
    val others: StateFlow<Map<String, Long>> = _others

    fun isRinging(deviceId: String): Boolean = (_others.value[deviceId] ?: 0L) > System.currentTimeMillis()

    /** The alarm sound is playing (tests). */
    internal val soundPlaying: Boolean get() = player?.isPlaying == true

    /** A `ring { device, by, stop, at }` event, from any thread. Only the device it's for rings. */
    fun onEvent(o: JSONObject) {
        val device = o.str("device") ?: return
        val stop = o.optBoolean("stop")
        if (device == app.repo.me || device == app.prefs.deviceId) {
            val by = o.str("by")
            val name = by?.let { app.repo.state.value.devicesById[it]?.name } ?: by?.takeIf { it.isNotBlank() }
            main.post { if (stop) stop(tellServer = false) else start(name) }
        } else {
            _others.update { if (stop) it - device else it + (device to System.currentTimeMillis() + RING_MS) }
        }
    }

    /** Remembers that this phone just rang another device (before the server's event arrives). */
    fun rangOther(deviceId: String, stop: Boolean) =
        _others.update { if (stop) it - deviceId else it + (deviceId to System.currentTimeMillis() + RING_MS) }

    @MainThread
    fun start(by: String?) {
        main.removeCallbacks(autoStop)
        main.postDelayed(autoStop, RING_MS)
        Notifier.ringing(app, by)
        if (_ringing.value) return // already ringing: keep going, with the new name
        _ringing.value = true
        val audio = app.getSystemService(AudioManager::class.java)
        if (audio != null) {
            savedAlarmVolume = audio.getStreamVolume(AudioManager.STREAM_ALARM)
            try {
                audio.setStreamVolume(AudioManager.STREAM_ALARM, audio.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0)
            } catch (_: Exception) {
                // Do Not Disturb may not allow it; the sound still plays at the current alarm volume.
            }
            try {
                val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(ALARM).build()
                audio.requestAudioFocus(request)
                focus = request
            } catch (_: Exception) {
            }
        }
        player = play()
        vibrate()
    }

    /** Stops ringing. [tellServer]: let the other devices know it stopped (their "Stop ringing" goes away). */
    @MainThread
    fun stop(tellServer: Boolean) {
        main.removeCallbacks(autoStop)
        Notifier.cancel(app, Notifier.ID_RING)
        if (!_ringing.value) return
        _ringing.value = false
        player?.let {
            try {
                it.stop()
            } catch (_: Exception) {
            }
            it.release()
        }
        player = null
        vibrator?.cancel()
        vibrator = null
        val audio = app.getSystemService(AudioManager::class.java)
        if (audio != null) {
            focus?.let { audio.abandonAudioFocusRequest(it) }
            if (savedAlarmVolume >= 0) {
                try {
                    audio.setStreamVolume(AudioManager.STREAM_ALARM, savedAlarmVolume, 0)
                } catch (_: Exception) {
                }
            }
        }
        focus = null
        savedAlarmVolume = -1
        if (tellServer) {
            val me = app.repo.me
            app.scope.launch(Dispatchers.IO) { runCatching { app.api?.ring(me, stop = true) } }
        }
    }

    /** The alarm sound, looping; falls back to the ringtone and the notification sound. */
    private fun play(): MediaPlayer? {
        val candidates = listOfNotNull(
            RingtoneManager.getActualDefaultRingtoneUri(app, RingtoneManager.TYPE_ALARM),
            Settings.System.DEFAULT_ALARM_ALERT_URI,
            RingtoneManager.getActualDefaultRingtoneUri(app, RingtoneManager.TYPE_RINGTONE),
            Settings.System.DEFAULT_RINGTONE_URI,
            Settings.System.DEFAULT_NOTIFICATION_URI,
        ).distinct()
        for (uri in candidates) {
            val p = MediaPlayer()
            try {
                p.setAudioAttributes(ALARM)
                p.setDataSource(app, uri)
                p.isLooping = true
                p.prepare()
                p.start()
                return p
            } catch (_: Exception) {
                p.release()
            }
        }
        return null
    }

    private fun vibrate() {
        val v = if (Build.VERSION.SDK_INT >= 31) {
            app.getSystemService(VibratorManager::class.java)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            app.getSystemService(Vibrator::class.java)
        }
        if (v == null || !v.hasVibrator()) return
        vibrator = v
        val pattern = VibrationEffect.createWaveform(longArrayOf(0, 800, 700), 0)
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                v.vibrate(pattern, VibrationAttributes.createForUsage(VibrationAttributes.USAGE_ALARM))
            } else {
                @Suppress("DEPRECATION")
                v.vibrate(pattern, ALARM)
            }
        } catch (_: Exception) {
        }
    }

    companion object {
        const val RING_MS = 60_000L
        val ALARM: AudioAttributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
    }
}
