package app.beam.android.ui

import android.os.Build
import android.view.LayoutInflater
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.isVisible
import androidx.core.widget.TextViewCompat
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import app.beam.android.BeamApp
import app.beam.android.R
import app.beam.android.core.Conversations
import app.beam.android.core.Format
import app.beam.android.core.Item
import app.beam.android.databinding.ItemActionBinding
import app.beam.android.databinding.SheetActionsBinding
import app.beam.android.databinding.SheetSendBinding
import app.beam.android.databinding.SheetTextBinding
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.snackbar.Snackbar
import kotlinx.coroutines.launch

/** A bottom sheet with a list of actions (the long-press menu of an item, a device, …). */
object ActionSheet {
    data class Entry(val icon: Int, val label: String, val action: () -> Unit)

    fun show(activity: AppCompatActivity, title: CharSequence?, entries: List<Entry>): BottomSheetDialog {
        val b = SheetActionsBinding.inflate(activity.layoutInflater)
        val dialog = BottomSheetDialog(activity)
        dialog.setContentView(b.root)
        dialog.behavior.skipCollapsed = true
        dialog.behavior.state = BottomSheetBehavior.STATE_EXPANDED
        b.title.text = title
        b.title.isVisible = !title.isNullOrBlank()
        for (e in entries) {
            val row = ItemActionBinding.inflate(LayoutInflater.from(activity), b.entries, false)
            row.action.text = e.label
            row.action.setCompoundDrawablesRelativeWithIntrinsicBounds(e.icon, 0, 0, 0)
            TextViewCompat.setCompoundDrawableTintList(row.action, android.content.res.ColorStateList.valueOf(activity.getColor(R.color.muted)))
            row.action.setOnClickListener {
                dialog.dismiss()
                e.action()
            }
            b.entries.addView(row.root)
        }
        dialog.show()
        return dialog
    }
}

/**
 * "Select text": the whole text of a message in a sheet, freely selectable (partial copy), with Copy all
 * and Share. Long texts are fetched in full first. Tapping outside closes it.
 */
object TextSheet {
    fun show(activity: AppCompatActivity, item: Item, sender: String?) {
        val app = BeamApp.from(activity)
        val b = SheetTextBinding.inflate(activity.layoutInflater)
        val dialog = BottomSheetDialog(activity)
        dialog.setContentView(b.root)
        dialog.behavior.skipCollapsed = true
        dialog.behavior.state = BottomSheetBehavior.STATE_EXPANDED
        b.title.text = listOfNotNull(sender, Format.time(item.ts)).joinToString(" · ")
        b.text.text = item.text.orEmpty()
        var full = item.text.orEmpty()
        b.copyAll.setOnClickListener {
            if (Clip.copy(activity, full) && Build.VERSION.SDK_INT < 33) activity.toastShort(R.string.copied)
            dialog.dismiss()
        }
        b.share.setOnClickListener {
            FileActions.shareText(activity, full)
            dialog.dismiss()
        }
        if (item.truncated) {
            b.progress.isVisible = true
            activity.lifecycleScope.launch {
                try {
                    full = app.repo.fullText(item)
                    b.text.text = full
                } catch (e: Exception) {
                    b.hint.text = Format.error(e)
                } finally {
                    b.progress.isVisible = false
                }
            }
        }
        dialog.show()
    }
}

/** Forward: pick where an item goes next (the server copies it; no download and upload). */
object ForwardSheet {
    fun show(activity: AppCompatActivity, item: Item, anchorView: android.view.View) {
        val app = BeamApp.from(activity)
        val b = SheetSendBinding.inflate(activity.layoutInflater)
        val dialog = BottomSheetDialog(activity)
        dialog.setContentView(b.root)
        dialog.behavior.skipCollapsed = true
        dialog.behavior.state = BottomSheetBehavior.STATE_EXPANDED
        b.title.setText(R.string.forward_to)
        b.preview.text = if (item.isText) "“" + item.text.orEmpty().trim().replace(Regex("\\s+"), " ").take(120) + "”" else item.displayName
        b.hint.setText(R.string.forward_hint)
        val s = app.repo.state.value
        val source = Conversations.keysOf(item, s.me, s.devicesById)
        val targets = TargetAdapter(onTap = { t ->
            dialog.dismiss()
            activity.lifecycleScope.launch {
                try {
                    app.repo.forward(item, Conversations.targets(t.key))
                    val name = if (t.isAll) activity.getString(R.string.all_devices) else t.name
                    Snackbar.make(anchorView, activity.getString(R.string.forwarded_to, name), Snackbar.LENGTH_SHORT).show()
                } catch (e: Exception) {
                    Snackbar.make(anchorView, Format.error(e), Snackbar.LENGTH_LONG).show()
                }
            }
        }, onLongPress = {})
        targets.me = s.me
        b.targets.layoutManager = LinearLayoutManager(activity)
        b.targets.adapter = targets
        // Everywhere except the conversation it's already in.
        targets.submitList(Conversations.summaries(s.me, s.devices, s.items, emptyMap()).filter { it.key !in source && it.known })
        dialog.show()
    }
}

fun AppCompatActivity.toastShort(res: Int) = android.widget.Toast.makeText(this, res, android.widget.Toast.LENGTH_SHORT).show()

/** Sets a TextView's text to a string resource with arguments (tiny helper for sheets). */
fun TextView.setTextRes(res: Int, vararg args: Any) {
    text = context.getString(res, *args)
}
