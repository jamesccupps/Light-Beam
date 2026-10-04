package app.beam.android.ui

import android.net.Uri
import android.os.Build
import android.view.MenuItem
import androidx.activity.OnBackPressedCallback
import androidx.lifecycle.lifecycleScope
import app.beam.android.R
import app.beam.android.core.Format
import app.beam.android.core.Item
import app.beam.android.data.Files
import app.beam.android.data.TransferManager
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import kotlinx.coroutines.launch

/**
 * Several messages, photos or files picked at once (1.12; the user: "a way to select multiple messages pictures or
 * maybe just a gallery of the device pictures that were sent to allow me to copy or drag multiple at the same time
 * into another program"): in a conversation (a message's menu → Select, then taps) and in its gallery (a long-press on
 * a tile). The toolbar turns into the selection bar: how many, Share (to another app, all in one share), Save (to
 * Downloads/Beam), Forward, Delete, Copy (their text) and Select all; Back or × ends it. Files not on the phone yet are
 * fetched first ([TransferManager.Reason.GROUP]) and shared or announced once they're all here.
 */
class Picker(
    private val activity: BaseActivity,
    private val toolbar: MaterialToolbar,
    /** What Select all picks: the list on screen. */
    private val all: () -> List<Item>,
    /** The picks changed: draw the checks again. */
    private val onChange: () -> Unit,
    /** Picking ended: the screen puts its own toolbar back. */
    private val onEnd: () -> Unit,
    private val snack: (String) -> Unit,
) {
    /** The picked item ids, in the order they were picked. */
    val ids = LinkedHashSet<String>()
    var active = false
        private set

    private val app get() = activity.app
    private val back = object : OnBackPressedCallback(false) {
        override fun handleOnBackPressed() = stop()
    }

    init {
        activity.onBackPressedDispatcher.addCallback(activity, back)
    }

    /** Starts picking (the toolbar becomes the selection bar), with [id] picked if given. */
    fun start(id: String? = null) {
        if (!active) {
            active = true
            back.isEnabled = true
            ids.clear()
            toolbar.menu.clear()
            toolbar.inflateMenu(R.menu.pick)
            toolbar.setNavigationIcon(R.drawable.ic_close)
            toolbar.setNavigationContentDescription(R.string.pick_stop)
            toolbar.setNavigationOnClickListener { stop() }
            toolbar.setOnMenuItemClickListener {
                onMenu(it)
                true
            }
        }
        if (id != null) ids += id
        refresh()
    }

    /** A tap while picking: in or out (and the first one starts picking). */
    fun toggle(id: String) {
        if (!active) return start(id)
        if (!ids.remove(id)) ids += id
        refresh()
    }

    fun stop() {
        if (!active) return
        active = false
        back.isEnabled = false
        ids.clear()
        onEnd()
        onChange()
    }

    /** What went meanwhile (deleted on another device) drops out. */
    fun keepOnly(existing: Set<String>) {
        if (active && ids.retainAll(existing)) refresh()
    }

    /** The picked items, oldest first (the order they were sent). */
    fun items(): List<Item> {
        val s = app.repo.state.value
        return ids.mapNotNull { s.item(it) }.sortedBy { it.ts }
    }

    private fun refresh() {
        val list = items()
        toolbar.title = if (list.isEmpty()) activity.getString(R.string.pick_none) else activity.resources.getQuantityString(R.plurals.picked, list.size, list.size)
        toolbar.subtitle = null
        val menu = toolbar.menu
        val any = list.isNotEmpty()
        val canForward = list.all { it.isText } || app.repo.state.value.info?.has("forward") == true
        menu.findItem(R.id.pick_share)?.isVisible = any
        menu.findItem(R.id.pick_save)?.isVisible = list.any { it.isFile }
        menu.findItem(R.id.pick_forward)?.isVisible = any && canForward
        menu.findItem(R.id.pick_delete)?.isVisible = any
        menu.findItem(R.id.pick_copy)?.isVisible = list.any { it.isText }
        onChange()
    }

    private fun onMenu(item: MenuItem) {
        val list = items()
        when (item.itemId) {
            R.id.pick_all -> {
                all().forEach { ids += it.id }
                refresh()
            }
            R.id.pick_copy -> copy(list)
            R.id.pick_share -> share(list)
            R.id.pick_save -> fetch(list.filter { it.isFile }, share = false)
            R.id.pick_forward -> ForwardSheet.show(activity, list, toolbar) { stop() }
            R.id.pick_delete -> delete(list)
        }
    }

    // ---------------------------------------------------------------- what the bar does

    /** Their text, oldest first, a blank line between them (long ones in full). */
    private fun copy(list: List<Item>) {
        val texts = list.filter { it.isText }
        if (texts.isEmpty()) return
        activity.lifecycleScope.launch {
            try {
                val joined = texts.map { app.repo.fullText(it) }.joinToString("\n\n")
                // (Android 13 and later show their own "Copied".)
                if (Clip.copy(activity, joined) && Build.VERSION.SDK_INT < 33) {
                    activity.toast(activity.resources.getQuantityString(R.plurals.picked_copied, texts.size, texts.size))
                }
            } catch (e: Exception) {
                snack(Format.error(e))
            }
        }
    }

    /** The files in one share (fetched first if needed); with no files, the texts. */
    private fun share(list: List<Item>) {
        val files = list.filter { it.isFile }
        if (files.isNotEmpty()) return fetch(files, share = true)
        val texts = list.filter { it.isText }
        if (texts.isEmpty()) return snack(activity.getString(R.string.pick_nothing_to_share))
        activity.lifecycleScope.launch {
            try {
                FileActions.shareText(activity, texts.map { app.repo.fullText(it) }.joinToString("\n\n"))
            } catch (e: Exception) {
                snack(Format.error(e))
            }
        }
    }

    private fun delete(list: List<Item>) {
        if (list.isEmpty()) return
        MaterialAlertDialogBuilder(activity)
            .setMessage(activity.resources.getQuantityString(R.plurals.picked_delete_confirm, list.size, list.size))
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.delete) { _, _ ->
                stop()
                activity.lifecycleScope.launch {
                    try {
                        app.repo.deleteAll(list.map { it.id })
                    } catch (e: Exception) {
                        snack(Format.error(e))
                    }
                }
            }
            .show()
    }

    // ---------------------------------------------------------------- files fetched together

    private class Batch(val share: Boolean, val items: List<Item>) {
        val got = LinkedHashMap<String, Uri>()
    }

    private var batch: Batch? = null

    private fun localCopy(item: Item): Uri? = app.prefs.localFile(item.id)?.takeIf { Files.exists(activity, it) }

    /** Saved ones report back at once ([onFinished]); the others are downloaded first, with progress on their bubbles. */
    private fun fetch(files: List<Item>, share: Boolean) {
        if (files.isEmpty()) return
        val b = Batch(share, files)
        batch = b
        val missing = files.count { localCopy(it) == null }
        if (missing > 0) snack(activity.resources.getQuantityString(R.plurals.picked_getting, missing, missing))
        for (f in files) app.transfers.download(f, TransferManager.Reason.GROUP)
    }

    /** The screen's finished handler asks this first (on the main thread): true if it was one of the batch. */
    fun onFinished(f: TransferManager.Finished): Boolean {
        val b = batch ?: return false
        if (f.reason != TransferManager.Reason.GROUP || b.items.none { it.id == f.item.id }) return false
        b.got[f.item.id] = f.uri
        if (b.got.size < b.items.size) return true
        batch = null
        val files = b.items.mapNotNull { i -> b.got[i.id]?.let { it to Files.mimeFor(i.displayName, i.mime) } }
        if (b.share) FileActions.shareMany(activity, files)
        else snack(activity.resources.getQuantityString(R.plurals.picked_saved, files.size, files.size))
        return true
    }

    /** A download of the batch failed: said once, and the batch is dropped (the rest stay saved). */
    fun onDownloads(downloads: Map<String, TransferManager.Download>) {
        val b = batch ?: return
        val failed = b.items.firstOrNull { it.id !in b.got && downloads[it.id]?.status == TransferManager.Status.FAILED } ?: return
        batch = null
        snack(activity.getString(if (b.share) R.string.pick_failed else R.string.pick_save_failed, failed.displayName))
    }

    /** Back on screen: what finished meanwhile (nobody was listening) reports back now. */
    fun resume() {
        val b = batch ?: return
        for (i in b.items) if (i.id !in b.got) app.transfers.download(i, TransferManager.Reason.GROUP)
    }
}
