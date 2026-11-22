package app.beam.android.data

import app.beam.android.BeamApp
import app.beam.android.R
import app.beam.android.core.BeamException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.roundToLong

/**
 * (1.21, server 1.36) LocalCast's weather on the main list (the user, 2026-11-21: "my local cast weather should be part
 * of this app", then "you should just implement the page that is served by tailscale into beam, i wont change that
 * link"). The server reads LocalCast's page data (`GET /api/weather`, trusted sign-ins); the row says what it's like now
 * and today, LocalCast's warnings first, and opens LocalCast's own page ([app.beam.android.ui.WeatherActivity]).
 */
class Weather(private val app: BeamApp) {
    /** The row: LocalCast's page, the temperature now, the line under it (a warning first), and where. */
    data class Row(val url: String, val temp: String, val line: String, val warn: Boolean, val place: String)

    private val _row = MutableStateFlow<Row?>(null)
    val row: StateFlow<Row?> = _row
    private val reading = AtomicBoolean(false)
    @Volatile private var at = 0L

    /** Read again when the last read is older than [maxAgeMs] (the list's screen shows again, its timer). */
    fun refreshIfOld(maxAgeMs: Long = 5 * 60_000L) {
        if (System.currentTimeMillis() - at > maxAgeMs) refresh()
    }

    /** Reads it again, off the main thread (one read at a time). */
    fun refresh() {
        if (!reading.compareAndSet(false, true)) return
        app.scope.launch(Dispatchers.IO) {
            try {
                read()
            } finally {
                reading.set(false)
            }
        }
    }

    private fun read() {
        val api = app.api ?: return
        if (app.repo.state.value.info?.lists(FEATURE) != true) {
            _row.value = null
            return
        }
        val o = try {
            api.weather()
        } catch (e: BeamException) {
            if (e.status == 403 || e.status == 404) _row.value = null // (a sign-in not approved yet sees none)
            at = System.currentTimeMillis()
            return
        } catch (_: Exception) {
            return // (offline: the last one stays)
        }
        at = System.currentTimeMillis()
        _row.value = rowOf(o) { app.getString(R.string.weather_no_answer, it) }
    }

    companion object {
        const val FEATURE = "weather"

        /** LocalCast gives °C; its page says how it shows them (imperial: °F). */
        fun deg(c: Double?, units: String): String = if (c == null || c.isNaN()) "" else "${(if (units == "metric") c else c * 9 / 5 + 32).roundToLong()}°"

        private fun JSONObject.text(key: String): String = if (!has(key) || isNull(key)) "" else optString(key)
        private fun JSONObject?.number(key: String): Double? = this?.takeIf { it.has(key) && !it.isNull(key) }?.optDouble(key)?.takeIf { !it.isNaN() }

        /** The row from `GET /api/weather`, or null when there's no LocalCast page. */
        fun rowOf(o: JSONObject, noAnswer: (String) -> String): Row? {
            val url = o.text("url").takeIf { it.startsWith("http://") || it.startsWith("https://") } ?: return null
            val units = o.text("units")
            val place = listOf(o.text("name"), o.text("locale")).filter { it.isNotBlank() }.joinToString(", ")
            val now = o.optJSONObject("now") ?: return Row(url, "", if (o.has("error")) noAnswer(o.text("error")) else "", false, place)
            val today = o.optJSONObject("today")
            val warn = o.optJSONArray("hazards")?.optJSONObject(0)?.text("title").orEmpty()
            val day = listOfNotNull(today.number("hi")?.let { "↑" + deg(it, units) }, today.number("lo")?.let { "↓" + deg(it, units) }).joinToString(" ")
            val rain = today.number("pop")?.takeIf { it >= 10 }?.let { "rain ${it.roundToLong()}%" }.orEmpty()
            val line = listOf(warn, now.text("text"), day, rain).filter { it.isNotBlank() }.joinToString(" · ")
            return Row(url, deg(now.number("temp"), units), line, warn.isNotBlank(), place)
        }
    }
}
