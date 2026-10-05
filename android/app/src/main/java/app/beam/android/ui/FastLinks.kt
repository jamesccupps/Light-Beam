package app.beam.android.ui

import android.os.Build
import android.widget.ArrayAdapter
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import androidx.lifecycle.lifecycleScope
import app.beam.android.R
import app.beam.android.core.Format
import app.beam.android.core.Item
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.launch

/**
 * A fast link for a file (1.10; server 1.13 feature `fast-links`; the user: "Make a fast link" from Beam's own apps):
 * anyone with the link can download the file without Beam or signing in, until it runs out. Beam Family on the server's
 * machine makes it (its public link is reachable from anywhere; Beam isn't), from the file itself. First how long, then
 * the link: copied at once, with Copy and Share.
 */
object FastLinks {
    const val FEATURE = "fast-links"
    private val HOURS = intArrayOf(1, 24, 24 * 7)
    /** (1.13.0) How many downloads before it stops (0: until it runs out). */
    private val LIMITS = intArrayOf(0, 1, 3, 10)
    private val LOCATION_TYPES = Regex("^(image/(jpeg|png)|video/)", RegexOption.IGNORE_CASE)
    private val LOCATION_NAMES = Regex("\\.(jpe?g|png|mp4|m4v|mov|3gp|mkv|webm)$", RegexOption.IGNORE_CASE)

    /** A photo or video Beam Family can share without its location data (it says for sure when the link is made). */
    fun mayLoseLocation(item: Item) = LOCATION_TYPES.containsMatchIn(item.mime.orEmpty()) || LOCATION_NAMES.containsMatchIn(item.name.orEmpty())

    fun show(activity: BaseActivity, item: Item, snack: (String) -> Unit) {
        val labels = arrayOf(R.string.fast_link_hour, R.string.fast_link_day, R.string.fast_link_week).map { activity.getString(it) }.toTypedArray()
        var chosen = 1
        // (1.13.0) Under how long: stop after so many downloads; a photo or video without where it was taken.
        val pad = (24 * activity.resources.displayMetrics.density).toInt()
        val extras = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, 0, pad, 0) }
        val limitLabels = arrayOf(R.string.fast_link_limit_none, R.string.fast_link_limit_one, R.string.fast_link_limit_3, R.string.fast_link_limit_10).map { activity.getString(it) }
        extras.addView(TextView(activity).apply { text = activity.getString(R.string.fast_link_stop_after) })
        val limit = Spinner(activity).apply {
            tag = TAG_LIMIT
            adapter = ArrayAdapter(activity, android.R.layout.simple_spinner_dropdown_item, limitLabels)
        }
        extras.addView(limit)
        val location = CheckBox(activity).apply { tag = TAG_LOCATION; text = activity.getString(R.string.fast_link_no_location) }
        if (mayLoseLocation(item)) extras.addView(location)
        MaterialAlertDialogBuilder(activity)
            .setTitle(activity.getString(R.string.fast_link_for, item.displayName))
            .setSingleChoiceItems(labels, chosen) { _, which -> chosen = which }
            .setView(extras)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.fast_link_make) { _, _ ->
                make(activity, item, HOURS[chosen], LIMITS[limit.selectedItemPosition.coerceIn(0, LIMITS.size - 1)], location.isChecked && mayLoseLocation(item), snack)
            }
            .show()
    }

    const val TAG_LIMIT = "fastLinkLimit"
    const val TAG_LOCATION = "fastLinkLocation"

    private fun make(activity: BaseActivity, item: Item, hours: Int, maxDownloads: Int, removeLocation: Boolean, snack: (String) -> Unit) {
        activity.lifecycleScope.launch {
            try {
                val made = activity.app.repo.fastLink(item, hours, maxDownloads, removeLocation)
                val url = made.url
                if (activity.isFinishing || activity.isDestroyed) return@launch
                // (Android 13 and later show their own "Copied")
                if (Clip.copy(activity, url) && Build.VERSION.SDK_INT < 33) activity.toast(activity.getString(R.string.fast_link_copied))
                // (what the server did: one before 1.15 knows neither choice)
                val also = listOfNotNull(
                    made.maxDownloads.takeIf { it > 0 }?.let { if (it == 1) activity.getString(R.string.fast_link_made_one) else activity.getString(R.string.fast_link_made_many, it) },
                    activity.getString(R.string.fast_link_made_location).takeIf { made.removeLocation },
                )
                MaterialAlertDialogBuilder(activity)
                    .setTitle(item.displayName)
                    .setMessage(activity.getString(R.string.fast_link_made, url, Format.at(made.expires)) + also.joinToString("") { " $it" })
                    .setNeutralButton(R.string.share) { _, _ -> FileActions.shareText(activity, url) }
                    .setPositiveButton(R.string.copy) { _, _ -> if (Clip.copy(activity, url) && Build.VERSION.SDK_INT < 33) activity.toast(activity.getString(R.string.fast_link_copied)) }
                    .show()
            } catch (e: Exception) {
                snack(Format.error(e))
            }
        }
    }
}
