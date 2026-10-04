package app.beam.android.ui

import android.os.Build
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

    fun show(activity: BaseActivity, item: Item, snack: (String) -> Unit) {
        val labels = arrayOf(R.string.fast_link_hour, R.string.fast_link_day, R.string.fast_link_week).map { activity.getString(it) }.toTypedArray()
        var chosen = 1
        MaterialAlertDialogBuilder(activity)
            .setTitle(activity.getString(R.string.fast_link_for, item.displayName))
            .setSingleChoiceItems(labels, chosen) { _, which -> chosen = which }
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.fast_link_make) { _, _ -> make(activity, item, HOURS[chosen], snack) }
            .show()
    }

    private fun make(activity: BaseActivity, item: Item, hours: Int, snack: (String) -> Unit) {
        activity.lifecycleScope.launch {
            try {
                val (url, expires) = activity.app.repo.fastLink(item, hours)
                if (activity.isFinishing || activity.isDestroyed) return@launch
                // (Android 13 and later show their own "Copied")
                if (Clip.copy(activity, url) && Build.VERSION.SDK_INT < 33) activity.toast(activity.getString(R.string.fast_link_copied))
                MaterialAlertDialogBuilder(activity)
                    .setTitle(item.displayName)
                    .setMessage(activity.getString(R.string.fast_link_made, url, Format.at(expires)))
                    .setNeutralButton(R.string.share) { _, _ -> FileActions.shareText(activity, url) }
                    .setPositiveButton(R.string.copy) { _, _ -> if (Clip.copy(activity, url) && Build.VERSION.SDK_INT < 33) activity.toast(activity.getString(R.string.fast_link_copied)) }
                    .show()
            } catch (e: Exception) {
                snack(Format.error(e))
            }
        }
    }
}
