package app.beam.android.core

import org.json.JSONObject

/**
 * (server 1.27 `appearance`) The look: light, dark or like the phone, and an accent colour (null: Beam's own). The
 * server's is for every device without one of its own; a device's own is its `settings.appearance` (docs/API.md,
 * "Appearance").
 */
data class Look(val theme: String = AUTO, val accent: String? = null) {
    fun toJson(): JSONObject = JSONObject().put("theme", theme).put("accent", accent ?: JSONObject.NULL)

    /** The accent colour the phone shows for it (one of [ACCENTS]' colours, null for Beam's own): see [shownAs]. */
    val shownAccent: String? get() = shownAs(accent)

    companion object {
        const val AUTO = "auto"
        const val LIGHT = "light"
        const val DARK = "dark"

        /** Beam's own accent in the light theme (what the swatch shows; the look itself says null). */
        const val BEAM_ACCENT = "#5a4bf0"

        /** The accent colours on offer, as the web's (theme.js ACCENTS): Beam's own (null), then name and colour. */
        val ACCENTS: List<Pair<String, String?>> = listOf(
            "Beam" to null, "Blue" to "#2563eb", "Teal" to "#0e7c86", "Green" to "#16803c", "Amber" to "#b45309",
            "Red" to "#d12b2b", "Pink" to "#c2185b", "Purple" to "#8b3fd9", "Graphite" to "#4b5563",
        )

        private val HEX = Regex("^#[0-9a-f]{6}$")

        /** What the server sent (`{theme, accent}` or null); anything else in it reads as Beam's own. */
        fun parse(o: JSONObject?): Look? {
            if (o == null) return null
            val theme = o.optString("theme").let { if (it == LIGHT || it == DARK) it else AUTO }
            return Look(theme, o.str("accent")?.lowercase()?.takeIf { HEX.matches(it) })
        }

        fun isPreset(accent: String?) = ACCENTS.any { it.second == accent }

        /**
         * An Android theme can only be one that's built in, so a colour of the user's own (the web's Custom) shows as
         * the nearest of [ACCENTS] (Beam's own among them); a preset as itself.
         */
        fun shownAs(accent: String?): String? {
            if (accent == null || isPreset(accent)) return accent
            val c = rgb(accent) ?: return null
            return ACCENTS.minBy { (_, hex) -> distance(c, rgb(hex ?: BEAM_ACCENT)!!) }.second
        }

        private fun rgb(hex: String): IntArray? {
            if (!HEX.matches(hex.lowercase())) return null
            val n = hex.substring(1).toInt(16)
            return intArrayOf((n shr 16) and 255, (n shr 8) and 255, n and 255)
        }

        // "Redmean": a cheap distance that's closer to how far apart two colours look than plain RGB.
        private fun distance(a: IntArray, b: IntArray): Double {
            val r = (a[0] + b[0]) / 2.0
            val dr = (a[0] - b[0]).toDouble()
            val dg = (a[1] - b[1]).toDouble()
            val db = (a[2] - b[2]).toDouble()
            return (2 + r / 256) * dr * dr + 4 * dg * dg + (2 + (255 - r) / 256) * db * db
        }
    }
}
