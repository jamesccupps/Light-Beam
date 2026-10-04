package app.beam.android.ui

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.util.AttributeSet
import android.view.LayoutInflater
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.core.net.toUri
import androidx.core.view.ViewCompat
import androidx.core.view.isVisible
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import app.beam.android.R
import app.beam.android.core.Conversations
import app.beam.android.core.Format
import app.beam.android.core.Item
import app.beam.android.data.Files
import app.beam.android.data.Repository
import app.beam.android.data.TransferManager
import app.beam.android.databinding.ActivityGalleryBinding
import app.beam.android.databinding.ItemGalleryFileBinding
import app.beam.android.databinding.ItemGalleryTileBinding
import com.google.android.material.snackbar.Snackbar
import com.google.android.material.tabs.TabLayout
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * A conversation's photos, videos and files (1.12; the user: "maybe just a gallery of the device pictures that were
 * sent"): photos and videos as a grid, other files as a list, newest first. A tap opens one (downloading it first if
 * needed); a long-press starts picking several ([Picker]: share them to another app together, save, forward, delete).
 */
class GalleryActivity : BaseActivity() {
    private lateinit var b: ActivityGalleryBinding
    private lateinit var key: String
    private lateinit var adapter: GalleryAdapter
    private lateinit var picker: Picker
    private var media = true
    private var convTitle = ""
    private val grid by lazy {
        val dm = resources.displayMetrics
        GridLayoutManager(this, (dm.widthPixels / dm.density / 112).toInt().coerceAtLeast(3))
    }
    private val rows by lazy { LinearLayoutManager(this) }

    /** Opened or shared from here: act on it while this screen is on top. */
    private val finishedHandler = TransferManager.FinishedHandler { f ->
        val s = app.repo.state.value
        if (key !in Conversations.keysOf(f.item, s.me, s.devicesById)) return@FinishedHandler false
        runOnUiThread { if (!picker.onFinished(f)) onDownloadFinished(f) }
        true
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        key = intent.getStringExtra(EXTRA_KEY) ?: Conversations.ALL
        media = savedInstanceState?.getBoolean(STATE_MEDIA) ?: true
        b = ActivityGalleryBinding.inflate(layoutInflater)
        setContentView(b.root)
        b.appbar.padForSystemBars(top = true)
        b.list.padForSystemBars(bottom = true)
        setUpToolbar()

        adapter = GalleryAdapter(this, object : GalleryAdapter.Actions {
            override fun tap(item: Item) = if (picker.active) picker.toggle(item.id) else open(item)
            override fun longPress(item: Item) = picker.toggle(item.id)
        })
        picker = Picker(
            this, b.toolbar,
            all = { adapter.currentList },
            onChange = { adapter.setPicking(picker.active, picker.ids) },
            onEnd = {
                setUpToolbar()
                renderTitle(app.repo.state.value)
            },
            snack = ::snack,
        )
        b.tabs.addTab(b.tabs.newTab(), media)
        b.tabs.addTab(b.tabs.newTab(), !media)
        b.tabs.addOnTabSelectedListener(object : TabLayout.OnTabSelectedListener {
            override fun onTabSelected(tab: TabLayout.Tab) {
                media = tab.position == 0
                picker.stop()
                render(app.repo.state.value)
                b.list.scrollToPosition(0)
            }

            override fun onTabUnselected(tab: TabLayout.Tab) = Unit
            override fun onTabReselected(tab: TabLayout.Tab) = Unit
        })
        b.list.adapter = adapter

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                combine(app.repo.state, app.prefs.localFiles, app.transfers.downloads) { s, locals, downs -> Triple(s, locals, downs) }
                    .collect { (s, locals, downs) ->
                        adapter.locals = locals
                        adapter.senders = { item -> senderOf(s, item) }
                        render(s)
                        picker.onDownloads(downs)
                    }
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean(STATE_MEDIA, media)
    }

    override fun onResume() {
        super.onResume()
        app.transfers.finishedHandler = finishedHandler
        picker.resume()
    }

    override fun onPause() {
        if (app.transfers.finishedHandler === finishedHandler) app.transfers.finishedHandler = null
        super.onPause()
    }

    private fun setUpToolbar() {
        b.toolbar.menu.clear()
        b.toolbar.setNavigationIcon(R.drawable.ic_back)
        b.toolbar.setNavigationContentDescription(R.string.back)
        b.toolbar.setNavigationOnClickListener { finish() }
        b.toolbar.setOnMenuItemClickListener(null)
    }

    private fun render(s: Repository.State) {
        // Newest first.
        val all = Conversations.thread(key, s.me, s.items, s.devicesById).filter { it.isFile }.asReversed()
        val pics = all.filter { it.isImage || it.isVideo }
        val others = all.filter { !it.isImage && !it.isVideo }
        b.tabs.getTabAt(0)?.text = getString(R.string.gallery_media, pics.size)
        b.tabs.getTabAt(1)?.text = getString(R.string.gallery_files, others.size)
        val list = if (media) pics else others
        val lm = if (media) grid else rows
        if (adapter.tiles != media) {
            adapter.tiles = media
            adapter.submitList(null)
        }
        if (b.list.layoutManager !== lm) b.list.layoutManager = lm
        adapter.submitList(list)
        b.empty.isVisible = s.loaded && list.isEmpty()
        b.empty.setText(if (media) R.string.gallery_empty_media else R.string.gallery_empty_files)
        picker.keepOnly(all.mapTo(HashSet()) { it.id })
        renderTitle(s)
    }

    private fun renderTitle(s: Repository.State) {
        convTitle = when {
            key == Conversations.ALL -> getString(R.string.all_devices)
            else -> s.devicesById[key]?.name ?: s.items.firstOrNull { it.from == key }?.device ?: getString(R.string.unknown_device)
        }
        if (picker.active) return
        b.toolbar.title = getString(R.string.gallery_title)
        b.toolbar.subtitle = convTitle
    }

    private fun senderOf(s: Repository.State, item: Item): String =
        if (item.isFrom(s.me)) getString(R.string.you) else item.from?.let { s.devicesById[it]?.name } ?: item.device

    private fun mimeOf(item: Item) = Files.mimeFor(item.displayName, item.mime)

    private fun open(item: Item) {
        val local = app.prefs.localFile(item.id)?.takeIf { Files.exists(this, it) }
        if (local != null) return FileActions.open(this, local, mimeOf(item))
        app.transfers.download(item, TransferManager.Reason.OPEN)
        snack(resources.getQuantityString(R.plurals.picked_getting, 1, 1))
    }

    private fun onDownloadFinished(f: TransferManager.Finished) {
        val mime = mimeOf(f.item)
        when (f.reason) {
            TransferManager.Reason.OPEN -> FileActions.open(this, f.uri, mime)
            TransferManager.Reason.SHARE -> FileActions.share(this, f.uri, mime)
            TransferManager.Reason.SAVE, TransferManager.Reason.GROUP -> Snackbar.make(b.root, R.string.saved_to, Snackbar.LENGTH_LONG)
                .setAction(R.string.open) { FileActions.open(this, f.uri, mime) }
                .show()
            else -> Unit
        }
    }

    private fun snack(message: String) = Snackbar.make(b.root, message, Snackbar.LENGTH_LONG).show()

    companion object {
        private const val EXTRA_KEY = "conversation"
        private const val STATE_MEDIA = "media"

        /** The photos, videos and files of conversation [key]. */
        fun intent(ctx: Context, key: String): Intent = Intent(ctx, GalleryActivity::class.java).putExtra(EXTRA_KEY, key)
    }
}

/** A square: as tall as it is wide (a gallery tile). */
class SquareFrameLayout @JvmOverloads constructor(ctx: Context, attrs: AttributeSet? = null) : FrameLayout(ctx, attrs) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) = super.onMeasure(widthMeasureSpec, widthMeasureSpec)
}

/** The gallery's tiles (photos and videos) or rows (other files); activated = picked. */
class GalleryAdapter(private val ctx: Context, private val actions: Actions) : ListAdapter<Item, RecyclerView.ViewHolder>(DIFF) {
    interface Actions {
        fun tap(item: Item)
        fun longPress(item: Item)
    }

    /** Photos and videos as tiles; false: files as rows. */
    var tiles = true
    /** Item id → its saved copy on this phone. */
    var locals: Map<String, String> = emptyMap()
    var senders: (Item) -> String = { it.device }
    private var picking = false
    private var picked: Set<String> = emptySet()

    fun setPicking(on: Boolean, ids: Set<String>) {
        if (!on && !picking) return
        picking = on
        picked = ids.toSet()
        notifyItemRangeChanged(0, itemCount, PAYLOAD_PICK)
    }

    private class Tile(val b: ItemGalleryTileBinding) : RecyclerView.ViewHolder(b.root)
    private class FileRow(val b: ItemGalleryFileBinding) : RecyclerView.ViewHolder(b.root)

    override fun getItemViewType(position: Int) = if (tiles) 0 else 1

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val inflater = LayoutInflater.from(parent.context)
        val holder: RecyclerView.ViewHolder = if (viewType == 0) Tile(ItemGalleryTileBinding.inflate(inflater, parent, false))
        else FileRow(ItemGalleryFileBinding.inflate(inflater, parent, false))
        holder.itemView.setOnClickListener { at(holder)?.let(actions::tap) }
        holder.itemView.setOnLongClickListener {
            at(holder)?.let(actions::longPress)
            true
        }
        return holder
    }

    private fun at(holder: RecyclerView.ViewHolder): Item? = holder.bindingAdapterPosition.takeIf { it != RecyclerView.NO_POSITION }?.let(::getItem)

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        val item = getItem(position)
        when (holder) {
            is Tile -> bindTile(holder.b, item)
            is FileRow -> bindRow(holder.b, item)
        }
        bindPick(holder, item)
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int, payloads: MutableList<Any>) {
        if (payloads.isNotEmpty() && payloads.all { it == PAYLOAD_PICK }) bindPick(holder, getItem(position))
        else onBindViewHolder(holder, position)
    }

    private fun bindTile(b: ItemGalleryTileBinding, item: Item) {
        b.root.contentDescription = ctx.getString(if (item.isVideo) R.string.gallery_video else R.string.gallery_photo, item.displayName)
        b.placeholder.isVisible = false
        b.play.isVisible = false
        Thumbs.bind(b.image, "i:" + item.id, { Thumbs.loadItem(ctx, item, locals[item.id]?.toUri()) }, keepShape = true) { ok ->
            // No preview (a video without one, a picture too big to fetch): what it is, and its name.
            b.placeholder.isVisible = !ok
            b.play.isVisible = ok && item.isVideo
            if (!ok) {
                b.placeholder.text = item.displayName
                b.placeholder.setCompoundDrawablesRelativeWithIntrinsicBounds(0, if (item.isVideo) R.drawable.ic_video else R.drawable.ic_image, 0, 0)
            }
        }
    }

    private fun bindRow(b: ItemGalleryFileBinding, item: Item) {
        b.icon.setImageResource(fileTypeIcon(item.mime, item.name))
        b.name.text = item.displayName
        b.meta.text = listOf(Format.size(item.size), senders(item), Format.relative(item.ts)).joinToString(" · ")
        b.root.contentDescription = item.displayName + ", " + b.meta.text
    }

    private fun bindPick(holder: RecyclerView.ViewHolder, item: Item) {
        val on = picking && item.id in picked
        holder.itemView.isActivated = on
        when (holder) {
            is Tile -> {
                holder.b.check.isVisible = picking
                holder.b.pickedFrame.isVisible = picking
            }
            is FileRow -> holder.b.check.isVisible = picking
        }
        ViewCompat.setStateDescription(holder.itemView, if (picking) ctx.getString(if (on) R.string.pick_picked else R.string.pick_not_picked) else null)
    }

    companion object {
        private const val PAYLOAD_PICK = "pick"
        private val DIFF = object : DiffUtil.ItemCallback<Item>() {
            override fun areItemsTheSame(a: Item, b: Item) = a.id == b.id
            override fun areContentsTheSame(a: Item, b: Item) = a == b
        }
    }
}
