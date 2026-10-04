package app.beam.android.ui

import android.content.Context
import android.content.res.ColorStateList
import android.net.Uri
import android.text.Selection
import android.text.Spannable
import android.view.ActionMode
import android.view.Gravity
import android.view.LayoutInflater
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import androidx.appcompat.content.res.AppCompatResources
import androidx.core.view.ViewCompat
import androidx.core.view.doOnPreDraw
import androidx.core.view.isVisible
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import app.beam.android.R
import app.beam.android.core.Format
import app.beam.android.core.Item
import app.beam.android.data.Outbox
import app.beam.android.data.Repository
import app.beam.android.data.TransferManager
import app.beam.android.databinding.ItemDayBinding
import app.beam.android.databinding.ItemMessageBinding
import com.google.android.material.chip.Chip

/** One row in a conversation. */
sealed interface Row {
    val rowId: String

    data class Day(val label: String, override val rowId: String) : Row

    data class Msg(
        val item: Item,
        val mine: Boolean,
        /** Shown above bubbles from others where the sender isn't obvious (All devices, old items). */
        val sender: String?,
        val status: String?,
        val delivered: Boolean,
        val download: TransferManager.Download?,
        val local: Uri?,
    ) : Row {
        override val rowId get() = "i:" + item.id
    }

    /** A file still being sent (not on the server yet). */
    data class Up(val up: TransferManager.Upload) : Row {
        override val rowId get() = "u:" + up.localId
    }

    /** A text waiting in the outbox (typed while offline). */
    data class Out(val entry: Outbox.Entry) : Row {
        override val rowId get() = "o:" + entry.localId
    }

    /** A file another device is sending right now (API v3 `upload` events): "Arriving… 35%". */
    data class In(val inc: Repository.Incoming, val download: TransferManager.Download? = null) : Row {
        override val rowId get() = "n:" + inc.id
    }
}

/**
 * Chat bubbles. A long-press on a text selects it in place (Android's own selection with handles), with
 * Forward, Delete and More… added to the selection toolbar; a long-press anywhere else on a bubble opens the
 * item's menu. The selection goes away on a tap outside it, a scroll, sending, leaving the screen or the row
 * being recycled ([clearSelection]); receipts and progress never touch it (DiffUtil payloads leave the text alone).
 */
class MessageAdapter(private val ctx: Context, private val actions: Actions) : ListAdapter<Row, RecyclerView.ViewHolder>(DIFF) {
    interface Actions {
        /** Tap on a file or image: open it (downloading it first if needed). */
        fun open(item: Item)
        /** Long-press on any bubble: the item's menu. */
        fun menu(row: Row, anchor: View)
        fun showAll(item: Item)
        fun cancelDownload(item: Item)
        fun retryDownload(item: Item)
        fun cancelUpload(up: TransferManager.Upload)
        fun retryUpload(up: TransferManager.Upload)
        fun retryOutbox(entry: Outbox.Entry)
        fun cancelOutbox(entry: Outbox.Entry)
        /** Split screen / desktop windows: drag a saved file out of Beam. */
        fun dragOut(view: View, item: Item, uri: Uri): Boolean
        /** Tap on a file still arriving: save it as it comes in (server 1.4 `live-download`). */
        fun saveArriving(inc: Repository.Incoming)
        /** From the text selection toolbar. */
        fun forward(item: Item)
        fun delete(item: Item)
        /** Picking several (1.12): a tap on a message picks it or puts it back. */
        fun pick(row: Row.Msg)
        /** Picking several: a long-press (in split screen, on a picked saved file: drag every picked saved file). */
        fun pickLong(row: Row.Msg, view: View): Boolean
        /** (server 1.14) A tap on a reaction: this device's on or off. */
        fun react(item: Item, emoji: String)
        /** (server 1.14) A tap on a reply's quote: the message it answers. */
        fun showReplied(id: String)
        /** (server 1.14) Who a device is, for a reply's quote and the reactions ("You" for this phone). */
        fun nameOf(deviceId: String?, fallback: String?): String
        /** This phone's id as the server knows it. */
        fun myId(): String
    }

    /** Briefly highlighted (a search result that was opened). */
    var highlightId: String? = null

    /** Picking several (1.12): every message shows a check, and a tap picks it ([Picker]). */
    private var picking = false
    private var picked: Set<String> = emptySet()

    fun setPicking(on: Boolean, ids: Set<String>) {
        if (!on && !picking) return
        picking = on
        picked = ids.toSet()
        notifyItemRangeChanged(0, itemCount, PAYLOAD_PICK)
    }

    private class DayHolder(val b: ItemDayBinding) : RecyclerView.ViewHolder(b.root)
    private class MsgHolder(val b: ItemMessageBinding) : RecyclerView.ViewHolder(b.root) {
        var row: Row? = null
    }

    /** The text selected in a bubble right now (with its action mode), if any. */
    private var selectionView: TextView? = null
    private var selectionMode: ActionMode? = null

    /** A text is selected in one of the bubbles. */
    val hasSelection: Boolean get() = selectionView?.hasSelection() == true

    /** The action mode (toolbar) of the current text selection, if any. */
    val selectionActionMode: ActionMode? get() = selectionMode

    /** Ends the text selection (and its toolbar), if there is one. */
    fun clearSelection() {
        val tv = selectionView ?: return
        selectionView = null
        val mode = selectionMode
        selectionMode = null
        mode?.finish()
        (tv.text as? Spannable)?.let { Selection.removeSelection(it) }
    }

    /** Whether a touch at screen position [x], [y] lands on the text that's selected. */
    fun selectionContains(x: Float, y: Float): Boolean {
        val tv = selectionView ?: return false
        val at = IntArray(2)
        tv.getLocationOnScreen(at)
        return x >= at[0] && x < at[0] + tv.width && y >= at[1] && y < at[1] + tv.height
    }

    private fun color(id: Int) = ctx.getColor(id)

    override fun getItemViewType(position: Int) = if (getItem(position) is Row.Day) 0 else 1

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val inflater = LayoutInflater.from(parent.context)
        if (viewType == 0) return DayHolder(ItemDayBinding.inflate(inflater, parent, false))
        val holder = MsgHolder(ItemMessageBinding.inflate(inflater, parent, false))
        val b = holder.b
        // Long-press on the padding, the time or a file: the menu. On the text itself: Android's selection.
        b.bubble.setOnLongClickListener { v -> holder.row?.let { longPress(v, it, b) } ?: false }
        b.bubble.setOnClickListener {
            when (val row = holder.row) {
                is Row.Msg -> if (row.item.isFile) actions.open(row.item)
                is Row.In -> if (row.download?.active != true) actions.saveArriving(row.inc) // failed or paused: again
                else -> Unit
            }
        }
        b.text.customSelectionActionModeCallback = SelectionActions(holder)
        // Picking several: the row takes every tap (links, files and the text don't react); off otherwise.
        b.root.setOnClickListener { (holder.row as? Row.Msg)?.let(actions::pick) }
        b.root.setOnLongClickListener { v -> (holder.row as? Row.Msg)?.let { actions.pickLong(it, v) } ?: false }
        b.root.picking = false
        return holder
    }

    /** Beam's actions in the text selection toolbar, next to Copy / Share / Select all. */
    private inner class SelectionActions(private val holder: MsgHolder) : ActionMode.Callback {
        override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
            if (selectionView !== holder.b.text) clearSelection() // one selection at a time
            selectionView = holder.b.text
            selectionMode = mode
            if (holder.row is Row.Msg) { // not for texts still waiting in the outbox
                menu.add(Menu.NONE, R.id.selection_forward, ORDER_BEAM, R.string.forward)
                menu.add(Menu.NONE, R.id.selection_delete, ORDER_BEAM + 1, R.string.delete)
                menu.add(Menu.NONE, R.id.selection_more, ORDER_BEAM + 2, R.string.selection_more)
            }
            return true
        }

        override fun onPrepareActionMode(mode: ActionMode, menu: Menu) = false

        override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
            val row = holder.row as? Row.Msg ?: return false
            val action: () -> Unit = when (item.itemId) {
                R.id.selection_forward -> { { actions.forward(row.item) } }
                R.id.selection_delete -> { { actions.delete(row.item) } }
                R.id.selection_more -> { { actions.menu(row, holder.b.bubble) } }
                else -> return false
            }
            clearSelection()
            action()
            return true
        }

        override fun onDestroyActionMode(mode: ActionMode) {
            if (selectionMode === mode) {
                selectionMode = null
                selectionView = null
            }
        }
    }

    override fun onViewRecycled(holder: RecyclerView.ViewHolder) {
        if (holder is MsgHolder && holder.b.text === selectionView) clearSelection()
    }

    override fun onViewDetachedFromWindow(holder: RecyclerView.ViewHolder) {
        if (holder is MsgHolder && holder.b.text === selectionView) clearSelection()
    }

    override fun onViewAttachedToWindow(holder: RecyclerView.ViewHolder) {
        // A selectable TextView that was detached from the window (scrolled away and back) otherwise stops
        // starting selections on a long-press (a long-standing Android bug); re-enabling it resets that.
        if (holder is MsgHolder && holder.b.text.isTextSelectable) {
            holder.b.text.isEnabled = false
            holder.b.text.isEnabled = true
        }
    }

    private fun longPress(v: View, row: Row, b: ItemMessageBinding): Boolean {
        val local = (row as? Row.Msg)?.local
        val activity = ctx as? android.app.Activity
        if (local != null && activity?.isInMultiWindowMode == true && row.item.isFile) return actions.dragOut(v, row.item, local)
        actions.menu(row, b.bubble)
        return true
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        when (val row = getItem(position)) {
            is Row.Day -> (holder as DayHolder).b.day.text = row.label
            else -> bind(holder as MsgHolder, row)
        }
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int, payloads: MutableList<Any>) {
        val row = getItem(position)
        if (payloads.isEmpty() || holder !is MsgHolder || row is Row.Day) return onBindViewHolder(holder, position)
        holder.row = row
        if (payloads.all { it == PAYLOAD_PICK }) return bindPick(holder.b, row)
        // Only receipts, pins or progress changed: leave the text (and any links) alone.
        when (row) {
            is Row.Msg -> {
                bindMeta(holder.b, row)
                if (row.item.isFile) bindTransfer(holder.b, row)
            }
            is Row.Up -> bindUpload(holder.b, row.up, contentToo = false)
            is Row.Out -> bindOutbox(holder.b, row.entry)
            is Row.In -> bindIncoming(holder.b, row.inc, row.download)
            is Row.Day -> Unit
        }
        bindPick(holder.b, row)
    }

    private fun bind(h: MsgHolder, row: Row) {
        h.row = row
        when (row) {
            is Row.Msg -> bindMsg(h.b, row)
            is Row.Up -> bindUpload(h.b, row.up, contentToo = true)
            is Row.Out -> bindOutbox(h.b, row.entry)
            is Row.In -> bindIncoming(h.b, row.inc, row.download)
            is Row.Day -> Unit
        }
        bindPick(h.b, row)
    }

    /** Picking several: the check (on the side away from the bubble) and the row's tint; only messages on the server. */
    private fun bindPick(b: ItemMessageBinding, row: Row) {
        val msg = row as? Row.Msg
        val show = picking && msg != null
        b.root.picking = show
        b.pickCheck.isVisible = show
        if (msg == null || !show) {
            b.root.isActivated = false
            b.root.contentDescription = null
            ViewCompat.setStateDescription(b.root, null)
            return
        }
        val on = msg.item.id in picked
        b.root.isActivated = on
        val lp = b.pickCheck.layoutParams as FrameLayout.LayoutParams
        val gravity = Gravity.CENTER_VERTICAL or if (msg.mine) Gravity.START else Gravity.END
        if (lp.gravity != gravity) {
            lp.gravity = gravity
            b.pickCheck.layoutParams = lp
        }
        b.root.contentDescription = b.bubble.contentDescription
        ViewCompat.setStateDescription(b.root, ctx.getString(if (on) R.string.pick_picked else R.string.pick_not_picked))
    }

    // ---------------------------------------------------------------- items on the server

    /** Photos, and videos that have a preview, show as the picture itself. */
    private fun pictureLike(row: Row.Msg) = row.item.isImage || (row.item.isVideo && (row.item.thumb || row.local != null))

    private fun bindMsg(b: ItemMessageBinding, row: Row.Msg) {
        val item = row.item
        val imageOnly = pictureLike(row)
        style(b, row.mine, failed = false, pending = false, imageOnly = imageOnly)
        b.sender.isVisible = row.sender != null
        b.sender.text = row.sender
        b.bubble.contentDescription = null
        highlight(b, item.id)

        bindReply(b, item)
        bindReactions(b, item)
        if (item.isText) {
            showText(b, item)
            b.imageBox.isVisible = false
            b.fileCard.isVisible = false
            b.progress.isVisible = false
            b.fileActions.isVisible = false
        } else {
            b.text.isVisible = false
            b.showAll.isVisible = false
            bindFile(b, row)
        }
        bindMeta(b, row)
    }

    /** (server 1.14) A reply's quote of what it answers, as it was then; a tap goes there. */
    private fun bindReply(b: ItemMessageBinding, item: Item) {
        val r = item.reply
        b.replyQuote.isVisible = r != null
        if (r == null) return
        b.replyWho.text = actions.nameOf(r.from, r.device)
        b.replyText.text = when {
            r.kind == "file" -> ctx.getString(R.string.reply_file, r.name ?: "file")
            r.text != null -> r.text.replace(Regex("\\s+"), " ").trim()
            else -> ctx.getString(R.string.reply_gone)
        }
        b.replyQuote.setOnClickListener { actions.showReplied(r.id) }
    }

    /** (server 1.14) Reactions under the words: each with how many; this phone's are checked; a tap turns it on or off. */
    private fun bindReactions(b: ItemMessageBinding, item: Item) {
        val list = item.reactions.filterValues { it.isNotEmpty() }
        b.reactions.isVisible = list.isNotEmpty()
        b.reactions.removeAllViews()
        val mine = actions.myId()
        for ((emoji, by) in list) {
            val who = by.joinToString(", ") { if (it == mine) ctx.getString(R.string.this_device) else actions.nameOf(it, null) }
            b.reactions.addView(Chip(ctx).apply {
                text = "$emoji ${by.size}"
                isCheckable = true
                isChecked = mine in by
                isCheckedIconVisible = false
                setEnsureMinTouchTargetSize(false)
                chipMinHeight = 28 * ctx.resources.displayMetrics.density
                contentDescription = ctx.getString(R.string.reaction_count, emoji, by.size, who)
                setOnClickListener { actions.react(item, emoji) }
            })
        }
    }

    /** Rows that aren't messages on the server (sending, arriving, waiting) have no quote or reactions. */
    private fun noChatExtras(b: ItemMessageBinding) {
        b.replyQuote.isVisible = false
        b.reactions.isVisible = false
    }

    /** Up to [MAX_LINES] lines (and at most [MAX_CHARS] characters are laid out); the rest is behind "Show all". */
    private fun showText(b: ItemMessageBinding, item: Item) {
        b.text.isVisible = true
        val full = item.text.orEmpty()
        b.text.maxLines = MAX_LINES
        // Links (web and e-mail, never phone numbers) come from android:autoLink: in selectable text only
        // those stay tappable.
        b.text.text = full.take(MAX_CHARS)
        val cut = item.truncated || full.length > MAX_CHARS
        b.showAll.isVisible = cut
        b.showAll.setOnClickListener { actions.showAll(item) }
        if (!cut) {
            b.text.doOnPreDraw {
                val layout = b.text.layout ?: return@doOnPreDraw
                val clipped = layout.lineCount > 0 && layout.getEllipsisCount(layout.lineCount - 1) > 0
                if (clipped != b.showAll.isVisible) b.showAll.isVisible = clipped
            }
        }
    }

    private fun bindMeta(b: ItemMessageBinding, row: Row.Msg) {
        val item = row.item
        val parts = mutableListOf(Format.time(item.ts))
        if (item.edited > 0) parts += ctx.getString(R.string.edited) // (server 1.14)
        if (row.status != null) parts += row.status
        val meta = parts.joinToString(" · ")
        b.meta.text = meta
        b.imageMeta.text = meta
        val picture = pictureLike(row) && b.imageBox.isVisible
        b.statusIcon.isVisible = row.mine && !picture
        b.statusIcon.setImageResource(if (row.delivered) R.drawable.ic_done_all else R.drawable.ic_check)
        b.pin.isVisible = item.pinned
        b.footer.isVisible = !picture
        b.bubble.contentDescription = listOfNotNull(
            row.sender,
            if (item.isText) item.text?.take(300) else item.displayName,
            if (item.pinned) ctx.getString(R.string.pinned) else null,
            meta,
        ).joinToString(", ")
    }

    private fun bindFile(b: ItemMessageBinding, row: Row.Msg) {
        val item = row.item
        b.fileName.text = item.displayName
        b.fileIcon.setImageResource(fileTypeIcon(item.mime, item.name))
        b.play.isVisible = item.isVideo
        if (pictureLike(row)) {
            b.imageBox.isVisible = true
            b.fileCard.isVisible = false
            // The sender's width and height (API v3) give the preview its shape before it has loaded.
            if (item.w > 0 && item.h > 0) Thumbs.shape(b.thumb, item.w, item.h)
            Thumbs.bind(b.thumb, "i:" + item.id, { Thumbs.loadItem(ctx, item, row.local) }) { ok ->
                // No preview (not decodable, too big to fetch): show it as a file instead.
                if (!ok) {
                    b.imageBox.isVisible = false
                    b.fileCard.isVisible = true
                    style(b, row.mine, failed = false, pending = false, imageOnly = false)
                    b.footer.isVisible = true
                    b.statusIcon.isVisible = row.mine
                }
            }
        } else {
            Thumbs.clear(b.thumb)
            b.imageBox.isVisible = false
            b.fileCard.isVisible = true
        }
        bindTransfer(b, row)
    }

    /** Progress, size and the Cancel / Retry buttons of a file being downloaded. */
    private fun bindTransfer(b: ItemMessageBinding, row: Row.Msg) {
        val item = row.item
        val d = row.download
        val running = d != null && d.active
        val failed = d != null && d.status == TransferManager.Status.FAILED
        val paused = d != null && d.status == TransferManager.Status.PAUSED
        b.fileMeta.text = when {
            running && d.status == TransferManager.Status.RETRYING -> ctx.getString(R.string.transfer_retrying)
            running && d.status == TransferManager.Status.QUEUED -> ctx.getString(R.string.transfer_waiting_download)
            running -> ctx.getString(R.string.transfer_of, Format.size(d.received), Format.size(item.size))
            paused -> ctx.getString(R.string.transfer_paused, Format.size(d.received), Format.size(item.size))
            failed -> ctx.getString(R.string.transfer_download_failed, d.error.orEmpty())
            row.local != null -> ctx.getString(R.string.file_saved_meta, Format.size(item.size))
            else -> Format.size(item.size)
        }
        val progressView = if (b.imageBox.isVisible) b.imageProgress else b.progress
        (if (progressView === b.progress) b.imageProgress else b.progress).isVisible = false
        progressView.isVisible = running || paused
        if (running || paused) {
            val determinate = item.size > 0 && (d.status == TransferManager.Status.RUNNING || paused)
            if (determinate) {
                progressView.isIndeterminate = false
                progressView.setProgressCompat((d.received * 100 / item.size).toInt(), true)
            } else if (!progressView.isIndeterminate) {
                progressView.isIndeterminate = true
            }
        }
        b.fileActions.isVisible = running || failed || paused
        b.actRetry.isVisible = failed || paused
        b.actRetry.setText(if (paused) R.string.resume else R.string.retry)
        b.actCancel.isVisible = running || failed || paused
        b.actCancel.setText(R.string.cancel)
        b.actRetry.setOnClickListener { actions.retryDownload(item) }
        b.actCancel.setOnClickListener { actions.cancelDownload(item) }
    }

    // ---------------------------------------------------------------- files being sent

    private fun bindUpload(b: ItemMessageBinding, up: TransferManager.Upload, contentToo: Boolean) {
        noChatExtras(b)
        val failed = up.status == TransferManager.Status.FAILED
        val paused = up.status == TransferManager.Status.PAUSED
        if (contentToo) {
            style(b, mine = true, failed = failed, pending = false, imageOnly = false)
            highlight(b, null)
            b.sender.isVisible = false
            b.text.isVisible = false
            b.showAll.isVisible = false
            b.fileCard.isVisible = true
            b.fileName.text = up.name
            b.fileIcon.setImageResource(fileTypeIcon(up.mime, up.name))
            b.pin.isVisible = false
            b.footer.isVisible = true
            b.statusIcon.isVisible = false
            b.meta.text = Format.time(up.createdAt)
            if (up.mime.startsWith("image/")) {
                b.imageBox.isVisible = true
                b.play.isVisible = false
                Thumbs.bind(b.thumb, "u:" + up.localId, { Thumbs.loadUri(ctx, up.uri) }) { ok -> if (!ok) b.imageBox.isVisible = false }
            } else {
                Thumbs.clear(b.thumb)
                b.imageBox.isVisible = false
            }
        } else if (b.bubble.background == null || failed != (b.bubble.tag == TAG_FAILED)) {
            style(b, mine = true, failed = failed, pending = false, imageOnly = false)
        }
        b.fileMeta.text = when (up.status) {
            TransferManager.Status.QUEUED -> ctx.getString(R.string.transfer_waiting_send)
            TransferManager.Status.PREPARING -> ctx.getString(R.string.transfer_preparing)
            TransferManager.Status.RUNNING -> if (up.size > 0) ctx.getString(R.string.transfer_of, Format.size(up.sent), Format.size(up.size)) else ctx.getString(R.string.transfer_sending)
            TransferManager.Status.RETRYING -> ctx.getString(R.string.transfer_retrying)
            TransferManager.Status.PAUSED -> ctx.getString(R.string.transfer_paused, Format.size(up.sent), Format.size(up.size.coerceAtLeast(0)))
            TransferManager.Status.FAILED -> ctx.getString(R.string.transfer_not_sent, up.error ?: ctx.getString(R.string.something_wrong))
        }
        b.imageProgress.isVisible = false
        b.progress.isVisible = !failed
        if (!failed) {
            if (up.size > 0 && (up.status == TransferManager.Status.RUNNING || paused)) {
                b.progress.isIndeterminate = false
                b.progress.setProgressCompat((up.sent * 100 / up.size).toInt(), true)
            } else if (!b.progress.isIndeterminate) {
                b.progress.isIndeterminate = true
            }
        }
        b.fileActions.isVisible = true
        b.actRetry.isVisible = failed || paused
        b.actRetry.setText(if (paused) R.string.resume else R.string.retry)
        b.actCancel.isVisible = true
        b.actCancel.setText(if (failed) R.string.remove else R.string.cancel)
        b.actRetry.setOnClickListener { actions.retryUpload(up) }
        b.actCancel.setOnClickListener { actions.cancelUpload(up) }
        b.bubble.contentDescription = up.name + ", " + b.fileMeta.text
    }

    // ---------------------------------------------------------------- files on their way here

    private fun bindIncoming(b: ItemMessageBinding, inc: Repository.Incoming, download: TransferManager.Download?) {
        noChatExtras(b)
        style(b, mine = false, failed = false, pending = false, imageOnly = false)
        highlight(b, null)
        b.sender.isVisible = false
        b.text.isVisible = false
        b.showAll.isVisible = false
        Thumbs.clear(b.thumb)
        b.imageBox.isVisible = false
        b.imageProgress.isVisible = false
        b.fileCard.isVisible = true
        b.fileName.text = inc.name
        b.fileIcon.setImageResource(fileTypeIcon(inc.mime, inc.name))
        val percent = if (inc.size > 0) (inc.offset * 100 / inc.size).toInt().coerceIn(0, 100) else 0
        b.fileMeta.text = if (download != null && download.active && inc.size > 0) {
            ctx.getString(R.string.transfer_incoming_saving, percent, (download.received * 100 / inc.size).toInt().coerceIn(0, 100))
        } else {
            ctx.getString(R.string.transfer_incoming, percent, Format.size(inc.size))
        }
        b.progress.isVisible = true
        b.progress.isIndeterminate = false
        b.progress.setProgressCompat(percent, true)
        b.fileActions.isVisible = false
        b.pin.isVisible = false
        b.statusIcon.isVisible = false
        b.footer.isVisible = true
        b.meta.text = Format.time(inc.ts)
        b.bubble.contentDescription = inc.name + ", " + b.fileMeta.text
    }

    // ---------------------------------------------------------------- texts waiting to be sent

    private fun bindOutbox(b: ItemMessageBinding, e: Outbox.Entry) {
        noChatExtras(b)
        val failed = e.status == Outbox.Status.FAILED
        style(b, mine = true, failed = failed, pending = !failed, imageOnly = false)
        highlight(b, null)
        b.sender.isVisible = false
        b.text.isVisible = true
        b.text.maxLines = MAX_LINES
        b.text.text = e.text.take(MAX_CHARS)
        b.showAll.isVisible = false
        Thumbs.clear(b.thumb)
        b.imageBox.isVisible = false
        b.fileCard.isVisible = false
        b.progress.isVisible = false
        b.imageProgress.isVisible = false
        b.pin.isVisible = false
        b.statusIcon.isVisible = !failed
        b.statusIcon.setImageResource(R.drawable.ic_schedule)
        b.footer.isVisible = true
        b.meta.text = when (e.status) {
            Outbox.Status.QUEUED -> ctx.getString(R.string.outbox_waiting)
            Outbox.Status.SENDING -> ctx.getString(R.string.transfer_sending)
            Outbox.Status.FAILED -> ctx.getString(R.string.transfer_not_sent, e.error ?: ctx.getString(R.string.something_wrong))
        }
        b.fileActions.isVisible = failed
        b.actRetry.isVisible = failed
        b.actRetry.setText(R.string.retry)
        b.actCancel.isVisible = failed
        b.actCancel.setText(R.string.remove)
        b.actRetry.setOnClickListener { actions.retryOutbox(e) }
        b.actCancel.setOnClickListener { actions.cancelOutbox(e) }
        b.bubble.contentDescription = e.text.take(300) + ", " + b.meta.text
    }

    // ---------------------------------------------------------------- looks

    private fun highlight(b: ItemMessageBinding, id: String?) {
        b.bubble.foreground = if (id != null && id == highlightId) AppCompatResources.getDrawable(ctx, R.drawable.bubble_highlight) else null
    }

    private fun style(b: ItemMessageBinding, mine: Boolean, failed: Boolean, pending: Boolean, imageOnly: Boolean) {
        val lp = b.bubble.layoutParams as FrameLayout.LayoutParams
        val gravity = if (mine) Gravity.END else Gravity.START
        if (lp.gravity != gravity) {
            lp.gravity = gravity
            b.bubble.layoutParams = lp
        }
        b.bubble.tag = if (failed) TAG_FAILED else null
        if (imageOnly) {
            b.bubble.background = null
            b.bubble.setPadding(0, 0, 0, 0)
        } else {
            b.bubble.setBackgroundResource(
                when {
                    failed -> R.drawable.bubble_failed
                    mine -> R.drawable.bubble_mine
                    else -> R.drawable.bubble_theirs
                },
            )
            val d = ctx.resources.displayMetrics.density
            b.bubble.setPadding((12 * d).toInt(), (8 * d).toInt(), (12 * d).toInt(), (4 * d).toInt())
        }
        b.bubble.alpha = if (pending) 0.72f else 1f
        val onAccent = mine && !failed && !imageOnly
        val ink = color(if (onAccent) R.color.mine_ink else R.color.text)
        val muted = color(if (onAccent) R.color.mine_muted else R.color.muted)
        val accent = color(R.color.accent)
        b.text.setTextColor(ink)
        b.text.setLinkTextColor(if (onAccent) ink else accent)
        // The selection must show on my (accent-coloured) bubbles too.
        b.text.highlightColor = if (onAccent) 0x66FFFFFF else (accent and 0x00FFFFFF) or 0x40000000
        b.fileName.setTextColor(ink)
        b.fileMeta.setTextColor(muted)
        b.meta.setTextColor(muted)
        b.statusIcon.imageTintList = ColorStateList.valueOf(muted)
        b.pin.imageTintList = ColorStateList.valueOf(muted)
        b.fileIcon.setBackgroundResource(if (onAccent) R.drawable.file_icon_bg else R.drawable.file_icon_bg_theirs)
        b.fileIcon.imageTintList = ColorStateList.valueOf(if (onAccent) ink else accent)
        for (button in listOf(b.actRetry, b.actCancel, b.showAll)) button.setTextColor(if (onAccent) ink else accent)
        b.progress.setIndicatorColor(if (onAccent) ink else accent)
        b.progress.trackColor = if (onAccent) 0x40FFFFFF else color(R.color.accent_soft)
    }

    companion object {
        const val MAX_LINES = 25
        /** After Android's Copy / Share / Select all (orders up to ~10), before apps' text actions (100+). */
        private const val ORDER_BEAM = 20
        private const val MAX_CHARS = 4000
        private const val TAG_FAILED = "failed"
        const val PAYLOAD_META = "meta"
        /** Only the picks changed (1.12): the checks, nothing else. */
        const val PAYLOAD_PICK = "pick"

        private val DIFF = object : DiffUtil.ItemCallback<Row>() {
            override fun areItemsTheSame(a: Row, b: Row) = a.rowId == b.rowId
            override fun areContentsTheSame(a: Row, b: Row) = a == b

            /** Only receipts, pins, progress or transfer state changed: update those parts in place. */
            override fun getChangePayload(a: Row, b: Row): Any? = when {
                a is Row.Msg && b is Row.Msg && sameContent(a, b) -> PAYLOAD_META
                a is Row.Up && b is Row.Up && a.up.name == b.up.name && (a.up.status == TransferManager.Status.FAILED) == (b.up.status == TransferManager.Status.FAILED) -> PAYLOAD_META
                a is Row.In && b is Row.In -> PAYLOAD_META
                else -> null
            }

            private fun sameContent(a: Row.Msg, b: Row.Msg) =
                a.item.id == b.item.id && a.item.text == b.item.text && a.item.name == b.item.name && a.item.mime == b.item.mime &&
                    a.item.size == b.item.size && a.item.thumb == b.item.thumb && a.mine == b.mine && a.sender == b.sender &&
                    (a.local == null) == (b.local == null) &&
                    // (server 1.14: these are drawn in the bubble too)
                    a.item.reactions == b.item.reactions && a.item.edited == b.item.edited && a.item.reply == b.item.reply
        }
    }
}
