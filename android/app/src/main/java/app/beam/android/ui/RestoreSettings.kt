package app.beam.android.ui

import android.content.Intent
import androidx.appcompat.app.AlertDialog
import androidx.lifecycle.lifecycleScope
import app.beam.android.R
import app.beam.android.core.Format
import app.beam.android.data.SettingsBackups
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Putting back settings kept on the server (1.8.2): the offer after a reinstall, and Settings → "Restore settings". */
object RestoreSettings {
    /** The offer after a reinstall (MainActivity). Not now or Back: it isn't offered again (a tap beside it doesn't count). */
    fun offer(activity: BaseActivity, c: SettingsBackups.Choice): AlertDialog =
        MaterialAlertDialogBuilder(activity)
            .setTitle(R.string.backup_offer_title)
            .setMessage(activity.getString(R.string.backup_offer_body, Format.at(c.at)))
            .setNegativeButton(R.string.backup_not_now) { _, _ -> activity.app.backups.checked() }
            .setPositiveButton(R.string.backup_restore_button) { _, _ -> restore(activity, c) }
            .setOnCancelListener { activity.app.backups.checked() }
            .create()
            .apply {
                setCanceledOnTouchOutside(false)
                show()
            }

    /** Settings → "Restore settings": this phone's earlier installs' backups and other phones', one to pick. */
    fun choose(activity: BaseActivity, onRestored: () -> Unit = {}) {
        activity.lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { activity.app.backups.choices() } }
            val list = result.getOrElse {
                activity.toast(activity.getString(R.string.backup_failed, Format.error(it)))
                return@launch
            }
            if (list.isEmpty()) {
                activity.toast(activity.getString(R.string.backup_none))
                return@launch
            }
            val labels = list.map {
                if (it.here) activity.getString(R.string.backup_choice_here, Format.at(it.at))
                else activity.getString(R.string.backup_choice_other, it.name, Format.at(it.at))
            }
            var picked = 0
            MaterialAlertDialogBuilder(activity)
                .setTitle(R.string.backup_choose_title)
                .setSingleChoiceItems(labels.toTypedArray(), 0) { _, which -> picked = which }
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.backup_restore_button) { _, _ ->
                    restore(activity, list[picked])
                    onRestored()
                }
                .show()
        }
    }

    private fun restore(activity: BaseActivity, c: SettingsBackups.Choice) {
        val askSharing = activity.app.backups.apply(c)
        activity.toast(activity.getString(R.string.backup_restored, Format.at(c.at)))
        // Sharing notifications with the PCs: on again only on its own screen (Android's access is the user's to give).
        if (askSharing && !activity.isFinishing) {
            MaterialAlertDialogBuilder(activity)
                .setTitle(R.string.pc_notifications_title)
                .setMessage(R.string.backup_sharing_body)
                .setNegativeButton(R.string.backup_not_now, null)
                .setPositiveButton(R.string.backup_sharing_ok) { _, _ -> activity.startActivity(Intent(activity, PhoneNotificationsActivity::class.java)) }
                .show()
        }
    }
}
