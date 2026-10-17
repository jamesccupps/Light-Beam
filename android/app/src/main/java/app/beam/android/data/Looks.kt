package app.beam.android.data

import android.os.Handler
import android.os.Looper
import androidx.appcompat.app.AppCompatDelegate
import app.beam.android.BeamApp
import app.beam.android.R
import app.beam.android.core.Device
import app.beam.android.core.Look
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import org.json.JSONException
import org.json.JSONObject

/**
 * (1.14, server 1.27 `appearance`) The look this phone shows: its own (set here, Settings → Appearance), else the one
 * for all devices (the hello and `settings` events), else Beam's own. Both are kept, so the app starts in its look.
 * Light or dark goes through AppCompat's night mode; the accent is a theme overlay that [overlay] picks and every
 * BaseActivity puts on before it's drawn (and recreates for when the accent changes).
 */
class Looks(private val app: BeamApp) {
    private val main = Handler(Looper.getMainLooper())
    private val _look = MutableStateFlow(effective())
    val look: StateFlow<Look> = _look
    private val _hasOwn = MutableStateFlow(own != null)

    /** Whether this phone has a look of its own (it can, and show the same as the one for all devices). */
    val hasOwn: StateFlow<Boolean> = _hasOwn

    /** The look for all devices, or null: Beam's own. */
    val server: Look? get() = read(app.prefs.lookServer)

    /** This phone's own, or null. */
    val own: Look? get() = read(app.prefs.lookOwn)

    /** The hello's or a `settings` event's `appearance` (null: none, or a server from before 1.27). */
    fun onServer(look: Look?) {
        if (look == server) return
        app.prefs.lookServer = look?.toJson()?.toString()
        changed()
    }

    /** A list of the devices from the server: this phone's own look is in its entry. */
    fun onDevices(devices: List<Device>, me: String) {
        val mine = devices.firstOrNull { it.id == me } ?: return
        onOwn(mine.look)
    }

    private fun onOwn(look: Look?) {
        if (look == own) return
        app.prefs.lookOwn = look?.toJson()?.toString()
        _hasOwn.value = look != null
        changed()
    }

    /**
     * A change made here: [ownLook] this phone's own (null: back to the look for all devices), else the look for all
     * devices. Shown at once, put back as it was when the server says no (then it throws).
     */
    suspend fun save(look: Look?, ownLook: Boolean) {
        val api = app.api ?: throw IllegalStateException("not signed in")
        val before = if (ownLook) own else server
        if (ownLook) onOwn(look) else onServer(look)
        try {
            withContext(Dispatchers.IO) {
                if (ownLook) api.setOwnLook(look)
                else api.patchSettings(JSONObject().put("appearance", look?.toJson() ?: JSONObject.NULL))
            }
        } catch (e: CancellationException) {
            throw e // (not a no: the server's next word on it counts)
        } catch (e: Exception) {
            if (ownLook) onOwn(before) else onServer(before)
            throw e
        }
    }

    /** Light, dark or like the phone, for every screen (main thread; AppCompat recreates the open ones). */
    fun applyNightMode() {
        AppCompatDelegate.setDefaultNightMode(
            when (_look.value.theme) {
                Look.LIGHT -> AppCompatDelegate.MODE_NIGHT_NO
                Look.DARK -> AppCompatDelegate.MODE_NIGHT_YES
                else -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
            },
        )
    }

    private fun effective(): Look = own ?: server ?: Look()

    private fun changed() {
        val next = effective()
        if (next == _look.value) return
        _look.value = next
        if (Looper.myLooper() == Looper.getMainLooper()) applyNightMode() else main.post { applyNightMode() }
    }

    private fun read(json: String?): Look? = try {
        json?.let { Look.parse(JSONObject(it)) }
    } catch (_: JSONException) {
        null
    }

    companion object {
        /** The theme overlay for an accent the phone shows ([Look.shownAccent]), or 0 for Beam's own. */
        fun overlay(shown: String?): Int = when (shown) {
            "#2563eb" -> R.style.ThemeOverlay_Beam_Look_Blue
            "#0e7c86" -> R.style.ThemeOverlay_Beam_Look_Teal
            "#16803c" -> R.style.ThemeOverlay_Beam_Look_Green
            "#b45309" -> R.style.ThemeOverlay_Beam_Look_Amber
            "#d12b2b" -> R.style.ThemeOverlay_Beam_Look_Red
            "#c2185b" -> R.style.ThemeOverlay_Beam_Look_Pink
            "#8b3fd9" -> R.style.ThemeOverlay_Beam_Look_Purple
            "#4b5563" -> R.style.ThemeOverlay_Beam_Look_Graphite
            else -> 0
        }
    }
}
