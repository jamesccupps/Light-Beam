package app.beam.android.ui

import android.annotation.SuppressLint
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.IntentCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.view.isVisible
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import app.beam.android.R
import app.beam.android.core.Conversations
import app.beam.android.core.Format
import app.beam.android.data.Outbox
import app.beam.android.databinding.ItemTargetBinding
import app.beam.android.databinding.SheetSendBinding
import app.beam.android.notify.Shortcuts
import app.beam.android.service.TransferService
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog
import kotlinx.coroutines.launch

/**
 * "Send to…" chooser for the share sheet (ACTION_SEND / ACTION_SEND_MULTIPLE) and the Quick Settings
 * clipboard tile. Tap a device to send right away; long-press to pick several. A Direct Share target
 * ("Share → Desktop") or the tile's chosen device skips the chooser altogether.
 */
class SendActivity : BaseActivity() {
    private val texts = ArrayList<String>()
    private val uris = ArrayList<Uri>()
    private var waitingForClipboard = false
    private var sheet: BottomSheetDialog? = null
    private var sb: SheetSendBinding? = null
    private var sending = false
    private lateinit var targets: TargetAdapter

    /** Where to send without asking: a Direct Share shortcut, or the tile's default device. */
    private var directTarget: String? = null

    /** Loading the device list failed (no saved copy either): offer what's possible anyway. */
    private var refreshFailed = false

    /** (1.12) The widget's "Send a photo": Android's photo picker, then where to (nothing picked: nothing happens). */
    private val photos = registerForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(50)) { picked ->
        if (picked.isEmpty()) {
            finish()
            return@registerForActivityResult
        }
        for (uri in picked) {
            // Lets the upload resume (or be retried) after this screen is gone, even after a restart.
            try {
                contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } catch (_: Exception) {
            }
        }
        uris += picked.filter { it.scheme == ContentResolver.SCHEME_CONTENT }
        proceed()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!app.prefs.paired) {
            Toast.makeText(this, R.string.not_paired, Toast.LENGTH_LONG).show()
            startActivity(Intent(this, PairActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            finish()
            return
        }
        directTarget = Shortcuts.conversationFor(intent.getStringExtra(ShortcutManagerCompat.EXTRA_SHORTCUT_ID))
        when (intent.action) {
            Intent.ACTION_SEND -> {
                intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.takeIf { it.isNotBlank() }?.let(texts::add)
                IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let(uris::add)
            }
            Intent.ACTION_SEND_MULTIPLE -> {
                IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let(uris::addAll)
                val many = intent.getCharSequenceArrayListExtra(Intent.EXTRA_TEXT)
                if (many != null) {
                    many.mapNotNull { it?.toString()?.takeIf(String::isNotBlank) }.forEach(texts::add)
                } else {
                    intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.takeIf { it.isNotBlank() }?.let(texts::add)
                }
            }
            ACTION_SEND_CLIPBOARD -> {
                // Only Beam itself (the tile, its own menu) may have the clipboard read and sent: through the alias,
                // which isn't exported. Another app naming this action gets nothing.
                if (intent.component?.className != CLIPBOARD_ALIAS) {
                    finish()
                    return
                }
                waitingForClipboard = true
                if (intent.getBooleanExtra(EXTRA_FROM_TILE, false)) directTarget = app.prefs.tileTarget?.takeIf { known(it) }
            }
            ACTION_SEND_PHOTOS -> {
                // (1.12) The widget's "Send a photo", through the same alias as the clipboard.
                if (intent.component?.className != CLIPBOARD_ALIAS) {
                    finish()
                    return
                }
                if (savedInstanceState == null) photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
                return // (the picker's answer goes on: photos)
            }
        }
        if (!waitingForClipboard && uris.isEmpty()) {
            // Some apps only put the files in ClipData.
            intent.clipData?.let { clip -> for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let(uris::add) }
        }
        // Shared files come as content:// (Android 7+ refuses file:// between apps); a file:// one could name Beam's
        // own private files, which Beam can read and another app can't.
        uris.retainAll { it.scheme == ContentResolver.SCHEME_CONTENT }
        if (!waitingForClipboard) {
            if (texts.isEmpty() && uris.isEmpty()) {
                Toast.makeText(this, R.string.nothing_to_send, Toast.LENGTH_SHORT).show()
                finish()
                return
            }
            proceed()
        }
    }

    private fun known(key: String) = key == Conversations.ALL || app.repo.state.value.devicesById.containsKey(key)

    /** Android 10+ only lets the focused app read the clipboard, so wait for focus. */
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus || !waitingForClipboard) return
        waitingForClipboard = false
        val (t, u) = Clip.read(this)
        texts += t
        uris += u.filter { it.scheme == ContentResolver.SCHEME_CONTENT } // (as for shares: never file://)
        if (texts.isEmpty() && uris.isEmpty()) {
            Toast.makeText(this, R.string.clipboard_empty, Toast.LENGTH_SHORT).show()
            finish()
            return
        }
        proceed()
    }

    private fun proceed() {
        val target = directTarget
        if (target != null) sendNow(listOf(target), withSheet = false) else showSheet()
    }

    private fun preview(): String = buildList {
        texts.firstOrNull()?.let { add("“" + it.trim().replace(Regex("\\s+"), " ").take(120) + "”") }
        if (uris.isNotEmpty()) add(resources.getQuantityString(R.plurals.file_count, uris.size, uris.size))
        if (texts.size > 1) add(resources.getQuantityString(R.plurals.text_count, texts.size, texts.size))
    }.joinToString(" · ")

    @SuppressLint("NotifyDataSetChanged")
    private fun showSheet() {
        val binding = SheetSendBinding.inflate(layoutInflater)
        sb = binding
        val dialog = BottomSheetDialog(this)
        sheet = dialog
        dialog.setContentView(binding.root)
        dialog.behavior.skipCollapsed = true
        dialog.behavior.state = BottomSheetBehavior.STATE_EXPANDED
        dialog.setOnDismissListener { if (!sending) finish() }

        binding.preview.text = preview()
        targets = TargetAdapter(
            onTap = { s -> if (targets.multi) targets.toggle(s.key) else sendNow(listOf(s.key), withSheet = true) },
            onLongPress = { s ->
                if (!targets.multi) {
                    targets.multi = true
                    targets.notifyDataSetChanged()
                }
                targets.toggle(s.key)
            },
        )
        targets.onSelectionChanged = {
            binding.send.isVisible = targets.multi && targets.selected.isNotEmpty()
            binding.send.text = if (targets.selected.size > 1) getString(R.string.send_count, targets.selected.size) else getString(R.string.send)
            binding.hint.setText(if (targets.multi) R.string.send_hint_multi else R.string.send_hint_single)
        }
        binding.targets.layoutManager = LinearLayoutManager(this)
        binding.targets.adapter = targets
        binding.send.setOnClickListener { sendNow(targets.selected.toList(), withSheet = true) }
        dialog.show()

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.repo.state.collect { s ->
                    targets.me = s.me
                    // The saved copy shows at once. Without one, wait for the server rather than offering only
                    // "All devices" (which looks like the other devices are gone).
                    val known = s.devices.any { it.id != s.me }
                    val ready = (s.loaded && (known || s.fresh)) || refreshFailed
                    binding.loading.isVisible = !ready
                    binding.targets.isVisible = ready
                    if (ready) targets.submitList(Conversations.summaries(s.me, s.devices, s.items, emptyMap()))
                    binding.progress.visibility = if (!ready || sending) View.VISIBLE else View.INVISIBLE
                }
            }
        }
        val s = app.repo.state.value
        if (!s.loaded || (!s.fresh && s.devices.none { it.id != s.me })) {
            lifecycleScope.launch {
                val error = app.repo.refresh()
                if (error != null) {
                    refreshFailed = true
                    // Still possible: "All devices" (queued until the server answers).
                    val now = app.repo.state.value
                    targets.submitList(Conversations.summaries(now.me, now.devices, now.items, emptyMap()))
                    binding.loading.isVisible = false
                    binding.targets.isVisible = true
                    binding.progress.visibility = if (sending) View.VISIBLE else View.INVISIBLE
                    showError(Format.error(error))
                }
            }
        }
    }

    private fun nameOf(key: String): String = when {
        key == Conversations.ALL -> getString(R.string.all_devices)
        else -> app.repo.state.value.devicesById[key]?.name ?: getString(R.string.unknown_device)
    }

    /**
     * Hands files to the upload service (they're queued; progress shows in a notification) and texts to
     * the outbox (sent now, or queued while the server can't be reached).
     */
    private fun sendNow(keys: List<String>, withSheet: Boolean) {
        if (sending || keys.isEmpty()) return
        val binding = sb
        val to = if (Conversations.ALL in keys) emptyList() else keys
        val names = keys.joinToString(", ") { nameOf(it) }
        sending = true
        binding?.error?.isVisible = false
        binding?.progress?.visibility = View.VISIBLE
        lifecycleScope.launch {
            try {
                var queued = uris.isNotEmpty()
                if (uris.isNotEmpty()) {
                    if (!TransferService.upload(this@SendActivity, uris, to)) throw IllegalStateException(getString(R.string.send_failed_start))
                    uris.clear() // handed over; don't send twice if a text below fails
                }
                while (texts.isNotEmpty()) {
                    when (val result = app.outbox.send(texts.first(), to)) {
                        is Outbox.Result.Failed -> throw IllegalStateException(result.message)
                        Outbox.Result.Queued -> queued = true
                        is Outbox.Result.Sent -> Unit
                    }
                    texts.removeAt(0)
                }
                val message = if (queued) getString(R.string.queued_for, names) else getString(R.string.sent_to, names)
                Toast.makeText(this@SendActivity, message, Toast.LENGTH_SHORT).show()
                sheet?.dismiss()
                finish()
            } catch (e: Exception) {
                sending = false
                binding?.progress?.visibility = View.INVISIBLE
                if (withSheet) showError(Format.error(e)) else {
                    Toast.makeText(this@SendActivity, Format.error(e), Toast.LENGTH_LONG).show()
                    finish()
                }
            }
        }
    }

    private fun showError(message: String) {
        sb?.error?.apply {
            text = message
            isVisible = true
        }
    }

    override fun onDestroy() {
        sheet?.setOnDismissListener(null)
        sheet?.dismiss()
        super.onDestroy()
    }

    companion object {
        const val ACTION_SEND_CLIPBOARD = "app.beam.android.action.SEND_CLIPBOARD"

        /** The non-exported alias (AndroidManifest) that ACTION_SEND_CLIPBOARD must come through. */
        const val CLIPBOARD_ALIAS = "app.beam.android.ui.ClipboardSendActivity"

        /** "Send the clipboard", for Beam's own tile and menu. */
        fun clipboardIntent(ctx: Context): Intent = Intent().setClassName(ctx, CLIPBOARD_ALIAS).setAction(ACTION_SEND_CLIPBOARD)

        /** (1.12) "Send a photo" (the home-screen widget): the photo picker, then where to. */
        const val ACTION_SEND_PHOTOS = "app.beam.android.action.SEND_PHOTOS"

        fun photosIntent(ctx: Context): Intent = Intent().setClassName(ctx, CLIPBOARD_ALIAS).setAction(ACTION_SEND_PHOTOS)

        /** The Quick Settings tile: use its default device (Settings › Quick Settings tile) if one is set. */
        const val EXTRA_FROM_TILE = "fromTile"
    }
}

class TargetAdapter(
    private val onTap: (Conversations.Summary) -> Unit,
    private val onLongPress: (Conversations.Summary) -> Unit,
) : ListAdapter<Conversations.Summary, TargetAdapter.Holder>(DIFF) {
    var multi = false
    var me = ""
    val selected = LinkedHashSet<String>()
    var onSelectionChanged: () -> Unit = {}

    class Holder(val b: ItemTargetBinding) : RecyclerView.ViewHolder(b.root)

    fun toggle(key: String) {
        if (!selected.add(key)) selected.remove(key)
        val index = currentList.indexOfFirst { it.key == key }
        if (index >= 0) notifyItemChanged(index)
        onSelectionChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
        Holder(ItemTargetBinding.inflate(LayoutInflater.from(parent.context), parent, false))

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val s = getItem(position)
        val b = holder.b
        val ctx = b.root.context
        b.title.text = if (s.isAll) ctx.getString(R.string.all_devices) else s.name
        b.subtitle.text = if (s.isAll) ctx.getString(R.string.broadcast_subtitle) else Format.presence(s.online, s.lastSeen)
        b.avatar.setImageResource(platformIcon(s.platform, s.isAll))
        b.onlineDot.isVisible = s.online
        b.check.isVisible = multi
        b.check.isChecked = s.key in selected
        b.row.setOnClickListener { onTap(s) }
        b.row.setOnLongClickListener {
            onLongPress(s)
            true
        }
    }

    companion object {
        private val DIFF = object : DiffUtil.ItemCallback<Conversations.Summary>() {
            override fun areItemsTheSame(a: Conversations.Summary, b: Conversations.Summary) = a.key == b.key
            override fun areContentsTheSame(a: Conversations.Summary, b: Conversations.Summary) =
                a.name == b.name && a.online == b.online && a.lastSeen == b.lastSeen && a.platform == b.platform
        }
    }
}
