package app.beam.android.ui

import android.Manifest
import android.content.ClipData
import android.content.ClipDescription
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.MotionEvent
import android.view.View
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.core.net.toUri
import androidx.core.view.ContentInfoCompat
import androidx.core.view.ViewCompat
import androidx.core.view.isVisible
import androidx.core.widget.doAfterTextChanged
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.recyclerview.widget.SimpleItemAnimator
import app.beam.android.R
import app.beam.android.core.Conversations
import app.beam.android.core.Device
import app.beam.android.core.Format
import app.beam.android.core.Item
import android.view.inputmethod.InputMethodManager
import app.beam.android.data.Files
import app.beam.android.data.Outbox
import app.beam.android.data.Repository
import app.beam.android.data.TransferManager
import app.beam.android.databinding.ActivityThreadBinding
import app.beam.android.notify.Notifier
import app.beam.android.service.Ringer
import app.beam.android.service.TransferService
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.snackbar.Snackbar
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.launch
import java.io.File

/** One conversation: chat bubbles (mine on the right), compose bar, attach, drag and drop. */
/** (1.11, server 1.14) The quick reactions on top of a message's sheet. */
private val QUICK_REACTIONS = listOf("👍", "❤️", "😂", "😮", "😢", "🙏")

class ThreadActivity : BaseActivity(), MessageAdapter.Actions {
    private lateinit var b: ActivityThreadBinding
    private lateinit var adapter: MessageAdapter
    private lateinit var picks: Picker
    private lateinit var key: String
    private var convTitle = ""
    @Volatile private var newestTs = 0L // set while the rows are built (off the main thread)
    private var firstList = true
    private var isResumed = false
    private var scrollTo: String? = null
    private var cameraFile: File? = null
    /** (1.11, server 1.14) Replying to this message, or editing this text: the bar above the message box says which. */
    private var replyTo: Item? = null
    private var editing: Item? = null
    private var draftBeforeEdit = ""

    private val picker = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris -> sendFiles(uris, persist = true) }
    private val photos = registerForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(50)) { uris -> sendFiles(uris, persist = true) }
    /** Beam declares CAMERA (to scan QR codes), so Android lets it start the camera app only once that's granted. */
    private val cameraPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) takePhoto() else snack(getString(R.string.camera_permission_needed))
    }
    private val camera = registerForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val file = cameraFile
        if (ok && file != null && file.length() > 0) sendFiles(listOf(cameraUri(file)), persist = false) else file?.delete()
        cameraFile = null
    }

    /** Save / Open / Share tapped here finished downloading: act on it while this screen is on top. */
    private val finishedHandler = TransferManager.FinishedHandler { f ->
        val s = app.repo.state.value
        if (key !in Conversations.keysOf(f.item, s.me, s.devicesById)) return@FinishedHandler false
        runOnUiThread { if (!picks.onFinished(f)) onDownloadFinished(f) }
        true
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        key = intent.getStringExtra(EXTRA_KEY) ?: Conversations.ALL
        scrollTo = intent.getStringExtra(EXTRA_ITEM)
        cameraFile = savedInstanceState?.getString(STATE_CAMERA)?.let(::File)
        b = ActivityThreadBinding.inflate(layoutInflater)
        setContentView(b.root)
        b.appbar.padForSystemBars(top = true)
        b.composeBar.padForSystemBars(bottom = true, ime = true)
        setUpToolbar()

        adapter = MessageAdapter(this, this)
        picks = Picker(
            this, b.toolbar,
            all = { app.repo.state.value.let { s -> Conversations.thread(key, s.me, s.items, s.devicesById) } },
            onChange = {
                adapter.clearSelection()
                adapter.setPicking(picks.active, picks.ids)
            },
            onEnd = {
                setUpToolbar()
                renderHeader(app.repo.state.value)
            },
            snack = ::snack,
        )
        adapter.highlightId = scrollTo
        b.list.layoutManager = LinearLayoutManager(this).apply { stackFromEnd = true }
        b.list.adapter = adapter
        (b.list.itemAnimator as? SimpleItemAnimator)?.supportsChangeAnimations = false
        // Scrolling the list ends a text selection (like tapping outside it, see dispatchTouchEvent).
        b.list.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrollStateChanged(recyclerView: RecyclerView, newState: Int) {
                if (newState == RecyclerView.SCROLL_STATE_DRAGGING) adapter.clearSelection()
            }
        })

        if (savedInstanceState == null) b.input.setText(app.prefs.drafts.value[key].orEmpty())
        b.send.isEnabled = !b.input.text.isNullOrBlank()
        b.input.doAfterTextChanged {
            b.send.isEnabled = !it.isNullOrBlank()
            if (editing == null) app.prefs.setDraft(key, it?.toString().orEmpty()) // (the words being edited aren't a draft)
        }
        b.send.setOnClickListener { sendText() }
        b.replyClose.setOnClickListener { endCompose() }
        b.attach.setOnClickListener { attach() }
        b.root.setOnDragListener(Drops.listener(this, { key }) { hover -> b.dropOverlay.isVisible = hover })
        // Pictures from the keyboard (Gboard clipboard, GIFs) and pasted files go out as files.
        ViewCompat.setOnReceiveContentListener(b.input, arrayOf("image/*", "video/*", "application/*", "audio/*")) { _, payload ->
            val split = payload.partition { it.uri != null }
            val uris = split.first?.let { c -> (0 until c.clip.itemCount).mapNotNull { c.clip.getItemAt(it).uri } }.orEmpty()
            if (uris.isNotEmpty()) sendFiles(uris, persist = false)
            split.second
        }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                combine(
                    app.repo.state, app.transfers.uploads, app.transfers.downloads, app.prefs.localFiles, app.outbox.entries,
                ) { s, ups, downs, locals, out -> Snapshot(s, buildRows(s, ups, downs, locals, out), downs) }
                    .flowOn(Dispatchers.Default) // the rows go over every item: not on the main thread
                    .conflate() // a busy transfer: only the latest rows get drawn
                    .collect { render(it) }
            }
        }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                // "Ring" turns into "Stop ringing" while that device rings (for up to a minute).
                app.ringer.others.collectLatest {
                    bindDeviceMenu(app.repo.state.value.devicesById[key])
                    delay(Ringer.RING_MS + 500)
                    bindDeviceMenu(app.repo.state.value.devicesById[key])
                }
            }
        }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                // The offline banner appears a few seconds into an outage; re-check while it lasts.
                while (true) {
                    delay(5_000)
                    bindBanner(app.repo.state.value)
                }
            }
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        cameraFile?.let { outState.putString(STATE_CAMERA, it.path) }
    }

    private class Snapshot(val state: Repository.State, val rows: List<Row>, val downloads: Map<String, TransferManager.Download>)

    /** The conversation's own toolbar (put back after picking several, which borrows it). */
    private fun setUpToolbar() {
        b.toolbar.menu.clear()
        b.toolbar.inflateMenu(R.menu.thread)
        b.toolbar.setNavigationIcon(R.drawable.ic_back)
        b.toolbar.setNavigationContentDescription(R.string.back)
        b.toolbar.setNavigationOnClickListener { finish() }
        b.toolbar.setOnMenuItemClickListener {
            onToolbarItem(it.itemId)
            true
        }
    }

    private fun onToolbarItem(id: Int) {
        val device = app.repo.state.value.devicesById[key]
        when (id) {
            R.id.action_send_clipboard -> sendClipboard()
            R.id.action_gallery -> startActivity(GalleryActivity.intent(this, key))
            R.id.action_select -> picks.start()
            R.id.action_clear -> clearConversation()
            R.id.action_ring -> device?.let { d -> DeviceActions.ring(this, d, stop = false, b.composeBar) }
            R.id.action_stop_ringing -> device?.let { d -> DeviceActions.ring(this, d, stop = true, b.composeBar) }
            R.id.action_wake -> device?.let { d -> DeviceActions.wake(this, d, b.composeBar) }
            R.id.action_remote_desktop -> device?.let { d -> DeviceActions.remoteDesktopIntent(this, d)?.let(::startActivity) }
            R.id.action_control -> device?.takeIf { app.remote.canControl(it) }?.let { d -> startActivity(RemoteActivity.intent(this, d.id)) }
        }
    }

    private fun buildRows(
        s: Repository.State,
        uploads: List<TransferManager.Upload>,
        downloads: Map<String, TransferManager.Download>,
        locals: Map<String, String>,
        outbox: List<Outbox.Entry>,
    ): List<Row> {
        val devices = s.devicesById
        val items = Conversations.thread(key, s.me, s.items, devices)
        newestTs = items.lastOrNull()?.ts ?: 0L
        val pending = uploads.filter { if (key == Conversations.ALL) it.to.isEmpty() else key in it.to }.sortedBy { it.createdAt }
        val waiting = outbox.filter { Conversations.targets(key) == it.to }.sortedBy { it.createdAt }
        val rows = ArrayList<Row>(items.size + pending.size + waiting.size + 8)
        var lastDay = Long.MIN_VALUE
        fun day(ts: Long) {
            val d = Format.dayKey(ts)
            if (d != lastDay) {
                lastDay = d
                rows += Row.Day(Format.day(ts), "d:$d")
            }
        }
        for (item in items) {
            day(item.ts)
            val mine = item.isFrom(s.me)
            val sender = when {
                mine -> null
                item.from == null -> getString(R.string.from_device, item.device)
                key == Conversations.ALL -> devices[item.from]?.name ?: item.device
                else -> null
            }
            rows += Row.Msg(
                item, mine, sender,
                Conversations.deliveryStatus(item, key, s.me, devices),
                mine && Conversations.isDelivered(item, key, s.me),
                downloads[item.id],
                locals[item.id]?.toUri(),
            )
        }
        for (up in pending) {
            day(up.createdAt)
            rows += Row.Up(up)
        }
        for (e in waiting) {
            day(e.createdAt)
            rows += Row.Out(e)
        }
        val arriving = s.incoming.values.filter { s.item(it.id) == null && key in Conversations.keysOf(it.asItem(), s.me, devices) }
        for (inc in arriving.sortedBy { it.ts }) {
            day(inc.ts)
            rows += Row.In(inc, downloads[inc.id])
        }
        return rows
    }

    private fun render(snap: Snapshot) {
        val s = snap.state
        renderHeader(s)
        b.dropText.text = getString(R.string.drop_here, convTitle)
        b.empty.isVisible = s.loaded && snap.rows.isEmpty()
        b.empty.setText(R.string.no_messages_drop)
        bindBanner(s)

        val lm = b.list.layoutManager as LinearLayoutManager
        val atBottom = lm.findLastVisibleItemPosition() >= adapter.itemCount - 2
        val previousLast = adapter.currentList.lastOrNull()?.rowId
        adapter.submitList(snap.rows) {
            val last = snap.rows.lastIndex
            if (last < 0) return@submitList
            val target = scrollTo?.let { id -> snap.rows.indexOfFirst { it.rowId == "i:$id" } }?.takeIf { it >= 0 }
            val newLast = snap.rows.last()
            val grewAtEnd = newLast.rowId != previousLast
            val mineAtEnd = newLast is Row.Up || newLast is Row.Out || (newLast is Row.Msg && newLast.mine)
            when {
                firstList && target != null -> {
                    lm.scrollToPositionWithOffset(target, (b.list.height / 3).coerceAtLeast(0))
                    scrollTo = null
                    b.list.postDelayed({
                        adapter.highlightId = null
                        adapter.notifyItemChanged(target, MessageAdapter.PAYLOAD_META)
                        adapter.notifyItemChanged(target)
                    }, 2500)
                }
                firstList -> b.list.scrollToPosition(last)
                // Not while text is selected: the list stays put under the selection.
                grewAtEnd && (atBottom || mineAtEnd) && !adapter.hasSelection -> b.list.smoothScrollToPosition(last)
            }
            if (snap.rows.isNotEmpty()) firstList = false
        }
        picks.keepOnly(snap.rows.mapNotNullTo(HashSet()) { (it as? Row.Msg)?.item?.id })
        picks.onDownloads(snap.downloads)
        if (isResumed) markRead()
    }

    /** Title, subtitle and the device's menu entries (not while the toolbar is the selection bar). */
    private fun renderHeader(s: Repository.State) {
        val device = s.devicesById[key]
        convTitle = when {
            key == Conversations.ALL -> getString(R.string.all_devices)
            device != null -> device.name
            else -> s.items.firstOrNull { it.from == key }?.device ?: getString(R.string.unknown_device)
        }
        if (picks.active) return
        b.toolbar.title = convTitle
        b.toolbar.subtitle = when {
            s.conn == Repository.Conn.AUTH_FAILED -> getString(R.string.auth_failed)
            s.conn == Repository.Conn.OFFLINE -> getString(R.string.offline)
            !s.loaded && s.conn != Repository.Conn.CONNECTED -> getString(R.string.connecting)
            key == Conversations.ALL -> getString(R.string.broadcast_subtitle)
            // "Online · 85% battery · 120 GB free" (what the device last reported, server 1.3).
            device != null -> listOfNotNull(Format.presence(device.online, device.lastSeen), Format.deviceStatus(device.status)).joinToString(" · ")
            else -> getString(R.string.no_longer_registered)
        }
        bindDeviceMenu(device)
    }

    /** Control / Ring / Stop ringing / Wake / Remote Desktop in the menu, for what this device can do right now. */
    private fun bindDeviceMenu(device: Device?) {
        val menu = b.toolbar.menu
        val ringing = device != null && app.ringer.isRinging(device.id)
        menu.findItem(R.id.action_ring)?.isVisible = device?.can?.ring == true && !ringing
        menu.findItem(R.id.action_stop_ringing)?.isVisible = device?.can?.ring == true && ringing
        menu.findItem(R.id.action_wake)?.isVisible = device != null && DeviceActions.canWake(device)
        menu.findItem(R.id.action_remote_desktop)?.isVisible = device != null && DeviceActions.remoteDesktopIntent(this, device) != null
        menu.findItem(R.id.action_control)?.isVisible = device != null && app.remote.canControl(device)
    }

    private fun bindBanner(s: Repository.State) {
        val banner = b.banner
        OfflineBanner.bind(this, banner.root, banner.bannerText, banner.bannerAction, banner.bannerAction2, s)
    }

    override fun onResume() {
        super.onResume()
        isResumed = true
        app.visibleConversation = key
        app.transfers.finishedHandler = finishedHandler
        picks.resume()
        Notifier.cancelConversation(this, key)
        markRead()
    }

    /**
     * A tap anywhere outside the selected text ends the selection and its toolbar. (Android only does that
     * when the tap moves the focus, so taps on the list, other bubbles or the bars left it standing.)
     */
    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (ev.actionMasked == MotionEvent.ACTION_DOWN && ::adapter.isInitialized && adapter.hasSelection && !adapter.selectionContains(ev.rawX, ev.rawY)) {
            adapter.clearSelection()
        }
        return super.dispatchTouchEvent(ev)
    }

    override fun onPause() {
        if (::adapter.isInitialized) adapter.clearSelection()
        isResumed = false
        if (app.visibleConversation == key) app.visibleConversation = null
        if (app.transfers.finishedHandler === finishedHandler) app.transfers.finishedHandler = null
        super.onPause()
    }

    private fun markRead() {
        if (newestTs > 0) app.readMarkers.markRead(key, newestTs)
    }

    // ---------------------------------------------------------------- sending

    private fun sendText() {
        val text = b.input.text?.toString().orEmpty()
        editing?.let { return saveEdit(it, text) }
        if (text.isBlank()) return
        val reply = replyTo?.id
        adapter.clearSelection()
        b.input.setText("")
        app.prefs.setDraft(key, "")
        endCompose()
        lifecycleScope.launch {
            // Queued (not lost) while offline: it shows as "Waiting to send…" and goes out on reconnect.
            val result = app.outbox.send(text, Conversations.targets(key), reply)
            if (result is Outbox.Result.Failed) snack(result.message)
        }
    }

    // ---------------------------------------------------------------- replying and editing (1.11, server 1.14)

    private fun startReply(item: Item) {
        if (editing != null) endCompose()
        replyTo = item
        renderReplyBar()
        showKeyboard()
    }

    private fun startEdit(item: Item) {
        lifecycleScope.launch {
            val text = try {
                app.repo.fullText(item)
            } catch (e: Exception) {
                snack(Format.error(e))
                return@launch
            }
            if (editing == null) draftBeforeEdit = b.input.text?.toString().orEmpty()
            replyTo = null
            editing = item
            b.input.setText(text)
            b.input.setSelection(b.input.text?.length ?: 0)
            renderReplyBar()
            showKeyboard()
        }
    }

    /** The bar's ×: no reply, or the edit dropped (the draft comes back). */
    private fun endCompose() {
        if (editing != null) {
            editing = null
            b.input.setText(draftBeforeEdit)
            b.input.setSelection(b.input.text?.length ?: 0)
            draftBeforeEdit = ""
        }
        replyTo = null
        renderReplyBar()
    }

    private fun renderReplyBar() {
        val item = editing ?: replyTo
        b.replyBar.isVisible = item != null
        if (item == null) return
        val what = if (item.isText) item.text.orEmpty().replace(Regex("\\s+"), " ").trim() else getString(R.string.reply_file, item.displayName)
        b.replyIcon.setImageResource(if (editing != null) R.drawable.ic_edit else R.drawable.ic_reply)
        b.replyBarText.text = if (editing != null) getString(R.string.editing, what) else getString(R.string.replying_to, senderOf(item), what)
    }

    private fun saveEdit(item: Item, text: String) {
        if (text.isBlank()) return snack(getString(R.string.edit_empty))
        lifecycleScope.launch {
            try {
                if (item.truncated || text != item.text) app.repo.editText(item, text)
                editing = null
                b.input.setText(draftBeforeEdit)
                b.input.setSelection(b.input.text?.length ?: 0)
                draftBeforeEdit = ""
                renderReplyBar()
            } catch (e: Exception) {
                snack(Format.error(e))
            }
        }
    }

    private fun showKeyboard() {
        b.input.requestFocus()
        getSystemService(InputMethodManager::class.java)?.showSoftInput(b.input, 0)
    }

    override fun react(item: Item, emoji: String) {
        val on = app.repo.me !in item.reactions[emoji].orEmpty()
        lifecycleScope.launch {
            try {
                app.repo.react(item, emoji, on)
            } catch (e: Exception) {
                snack(Format.error(e))
            }
        }
    }

    /** The message a reply answers: scrolled to and lit up for a moment (or a note when it's gone). */
    override fun showReplied(id: String) {
        val pos = adapter.currentList.indexOfFirst { it.rowId == "i:$id" }
        if (pos < 0) return snack(getString(R.string.reply_gone))
        (b.list.layoutManager as LinearLayoutManager).scrollToPositionWithOffset(pos, (b.list.height / 3).coerceAtLeast(0))
        adapter.highlightId = id
        adapter.notifyItemChanged(pos)
        b.list.postDelayed({
            if (adapter.highlightId == id) adapter.highlightId = null
            val p = adapter.currentList.indexOfFirst { it.rowId == "i:$id" }
            if (p >= 0) adapter.notifyItemChanged(p)
        }, 2500)
    }

    override fun nameOf(deviceId: String?, fallback: String?): String {
        val s = app.repo.state.value
        return when {
            deviceId != null && deviceId == app.repo.me -> getString(R.string.you)
            deviceId != null -> s.devicesById[deviceId]?.name ?: fallback ?: deviceId
            else -> fallback ?: "?"
        }
    }

    override fun myId(): String = app.repo.me

    private fun sendFiles(uris: List<Uri>, persist: Boolean) {
        if (uris.isEmpty()) return
        if (persist) {
            for (uri in uris) {
                // Lets the upload resume (or be retried) after this screen is gone, even after a restart.
                try {
                    contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                } catch (_: Exception) {
                }
            }
        }
        if (!TransferService.upload(this, uris, Conversations.targets(key))) snack(getString(R.string.send_failed_start))
    }

    /** Sends what's on the clipboard to this conversation (text as a message, files as files). */
    private fun sendClipboard() {
        val (texts, uris) = Clip.read(this)
        if (texts.isEmpty() && uris.isEmpty()) {
            snack(getString(R.string.clipboard_empty))
            return
        }
        if (uris.isNotEmpty()) sendFiles(uris, persist = false)
        lifecycleScope.launch {
            for (t in texts) {
                val result = app.outbox.send(t, Conversations.targets(key))
                if (result is Outbox.Result.Failed) snack(result.message)
            }
        }
    }

    private fun attach() {
        ActionSheet.show(
            this, null,
            listOf(
                ActionSheet.Entry(R.drawable.ic_image, getString(R.string.attach_photos)) {
                    photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo))
                },
                ActionSheet.Entry(R.drawable.ic_camera, getString(R.string.attach_camera)) { takePhoto() },
                ActionSheet.Entry(R.drawable.ic_file, getString(R.string.attach_files)) { picker.launch(arrayOf("*/*")) },
            ),
        )
    }

    private fun takePhoto() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            cameraPermission.launch(Manifest.permission.CAMERA)
            return
        }
        val dir = File(cacheDir, "camera").apply { mkdirs() }
        // Photos already sent are left for a day, then cleared.
        dir.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 86_400_000L }?.forEach { it.delete() }
        val file = File(dir, "IMG_" + java.text.SimpleDateFormat("yyyyMMdd_HHmmss", java.util.Locale.US).format(java.util.Date()) + ".jpg")
        cameraFile = file
        try {
            camera.launch(cameraUri(file))
        } catch (_: SecurityException) {
            snack(getString(R.string.camera_permission_needed))
        } catch (_: Exception) {
            snack(getString(R.string.no_camera))
        }
    }

    private fun cameraUri(file: File): Uri = FileProvider.getUriForFile(this, "$packageName.files", file)

    private fun clearConversation() {
        val s = app.repo.state.value
        val ids = Conversations.thread(key, s.me, s.items, s.devicesById).map { it.id }
        if (ids.isEmpty()) return
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.clear_conversation)
            .setMessage(resources.getQuantityString(R.plurals.clear_conversation_confirm, ids.size, ids.size, convTitle))
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.clear) { _, _ ->
                lifecycleScope.launch {
                    try {
                        app.repo.deleteAll(ids)
                    } catch (e: Exception) {
                        snack(Format.error(e))
                    }
                }
            }
            .show()
    }

    // ---------------------------------------------------------------- bubble actions

    private fun localCopy(item: Item): Uri? = app.prefs.localFile(item.id)?.takeIf { Files.exists(this, it) }

    private fun mimeOf(item: Item) = Files.mimeFor(item.displayName, item.mime)

    override fun open(item: Item) {
        val local = localCopy(item)
        if (local != null) FileActions.open(this, local, mimeOf(item)) else app.transfers.download(item, TransferManager.Reason.OPEN)
    }

    private fun share(item: Item) {
        if (item.isText) {
            lifecycleScope.launch {
                try {
                    FileActions.shareText(this@ThreadActivity, app.repo.fullText(item))
                } catch (e: Exception) {
                    snack(Format.error(e))
                }
            }
            return
        }
        val local = localCopy(item)
        if (local != null) FileActions.share(this, local, mimeOf(item)) else app.transfers.download(item, TransferManager.Reason.SHARE)
    }

    private fun copy(item: Item) {
        lifecycleScope.launch {
            try {
                if (Clip.copy(this@ThreadActivity, app.repo.fullText(item)) && Build.VERSION.SDK_INT < 33) toast(getString(R.string.copied))
            } catch (e: Exception) {
                snack(Format.error(e))
            }
        }
    }

    override fun forward(item: Item) = ForwardSheet.show(this, item, b.composeBar)

    /** Saves a file while it's still arriving: the download trails the upload (server 1.4 `live-download`). */
    override fun saveArriving(inc: Repository.Incoming) {
        if (inc.from == app.repo.me || inc.from == app.prefs.deviceId) return // this phone's own upload
        if (app.repo.state.value.info?.lists("live-download") != true) {
            snack(getString(R.string.arriving_wait))
            return
        }
        app.transfers.download(inc.asItem(), TransferManager.Reason.SAVE)
        snack(getString(R.string.arriving_saving, inc.name))
    }

    override fun delete(item: Item) {
        MaterialAlertDialogBuilder(this)
            .setMessage(R.string.delete_confirm)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.delete) { _, _ ->
                lifecycleScope.launch {
                    try {
                        app.repo.delete(item.id)
                    } catch (e: Exception) {
                        snack(Format.error(e))
                    }
                }
            }
            .show()
    }

    private fun togglePin(item: Item) {
        lifecycleScope.launch {
            try {
                app.repo.setPinned(item, !item.pinned)
            } catch (e: Exception) {
                snack(Format.error(e))
            }
        }
    }

    private fun senderOf(item: Item): String {
        val s = app.repo.state.value
        return if (item.isFrom(s.me)) getString(R.string.you) else item.from?.let { s.devicesById[it]?.name } ?: item.device
    }

    /** The one menu for every bubble: what applies to this item. */
    override fun menu(row: Row, anchor: View) {
        when (row) {
            is Row.Msg -> itemMenu(row)
            is Row.Up -> ActionSheet.show(
                this, row.up.name,
                listOf(ActionSheet.Entry(R.drawable.ic_close, getString(if (row.up.status == TransferManager.Status.FAILED) R.string.remove else R.string.cancel)) { cancelUpload(row.up) }),
            )
            is Row.Out -> ActionSheet.show(
                this, row.entry.text.take(120),
                listOfNotNull(
                    ActionSheet.Entry(R.drawable.ic_copy, getString(R.string.copy)) { Clip.copy(this, row.entry.text) },
                    if (row.entry.status == Outbox.Status.FAILED) ActionSheet.Entry(R.drawable.ic_refresh, getString(R.string.retry)) { retryOutbox(row.entry) } else null,
                    ActionSheet.Entry(R.drawable.ic_delete, getString(R.string.dont_send)) { cancelOutbox(row.entry) },
                ),
            )
            is Row.In, is Row.Day -> Unit
        }
    }

    private fun itemMenu(row: Row.Msg) {
        val item = row.item
        val info = app.repo.state.value.info
        val entries = ArrayList<ActionSheet.Entry>()
        // (1.11, server 1.14) Reply first, as in any chat; Edit for a text
        if (info?.lists("replies") == true) entries += ActionSheet.Entry(R.drawable.ic_reply, getString(R.string.reply)) { startReply(item) }
        if (item.isText) {
            entries += ActionSheet.Entry(R.drawable.ic_copy, getString(R.string.copy)) { copy(item) }
            if (info?.lists("edit") == true) entries += ActionSheet.Entry(R.drawable.ic_edit, getString(R.string.edit)) { startEdit(item) }
            entries += ActionSheet.Entry(R.drawable.ic_select_text, getString(R.string.select_text)) { TextSheet.show(this, item, senderOf(item)) }
            Notifier.firstLink(item.text.orEmpty())?.let { link ->
                entries += ActionSheet.Entry(R.drawable.ic_link, getString(R.string.open_link)) { FileActions.openLink(this, link) }
            }
        } else {
            entries += ActionSheet.Entry(R.drawable.ic_open, getString(R.string.open)) { open(item) }
            if (row.local == null) entries += ActionSheet.Entry(R.drawable.ic_download, getString(R.string.save)) { app.transfers.download(item, TransferManager.Reason.SAVE) }
        }
        entries += ActionSheet.Entry(R.drawable.ic_share, getString(R.string.share)) { share(item) }
        entries += ActionSheet.Entry(R.drawable.ic_check, getString(R.string.pick_select)) { picks.start(item.id) }
        if (item.isText || info?.has("forward") == true) {
            entries += ActionSheet.Entry(R.drawable.ic_forward, getString(R.string.forward)) { ForwardSheet.show(this, item, b.composeBar) }
        }
        if (!item.isText && info?.has(FastLinks.FEATURE) == true) {
            entries += ActionSheet.Entry(R.drawable.ic_link, getString(R.string.fast_link)) { FastLinks.show(this, item, ::snack) }
        }
        if (info?.has("pin") == true) {
            entries += ActionSheet.Entry(R.drawable.ic_pin, getString(if (item.pinned) R.string.unpin else R.string.pin)) { togglePin(item) }
        }
        entries += ActionSheet.Entry(R.drawable.ic_delete, getString(R.string.delete)) { delete(item) }
        val title = if (item.isText) item.text.orEmpty().trim().replace(Regex("\\s+"), " ").take(120) else item.displayName
        // (server 1.14) quick reactions on top; this phone's own stand out
        val quick = if (info?.lists("reactions") == true) QUICK_REACTIONS else emptyList()
        val mine = app.repo.me
        ActionSheet.show(this, title, entries, quick, item.reactions.filterValues { mine in it }.keys) { react(item, it) }
    }

    override fun showAll(item: Item) = TextSheet.show(this, item, senderOf(item))


    override fun cancelDownload(item: Item) = app.transfers.cancelDownload(item.id)

    override fun retryDownload(item: Item) {
        if (app.transfers.downloads.value[item.id]?.status == TransferManager.Status.PAUSED) app.transfers.resumeAll()
        else app.transfers.download(item, TransferManager.Reason.SAVE)
    }

    override fun cancelUpload(up: TransferManager.Upload) = app.transfers.cancelUpload(up.localId)

    override fun retryUpload(up: TransferManager.Upload) {
        if (up.status == TransferManager.Status.PAUSED) app.transfers.resumeAll() else app.transfers.retryUpload(up.localId)
    }

    override fun retryOutbox(entry: Outbox.Entry) = app.outbox.retry(entry.localId)

    override fun cancelOutbox(entry: Outbox.Entry) = app.outbox.cancel(entry.localId)

    /** Drag a saved file out of Beam into another app (split screen, desktop windows). */
    override fun dragOut(view: View, item: Item, uri: Uri): Boolean {
        val clip = ClipData(ClipDescription(item.displayName, arrayOf(mimeOf(item))), ClipData.Item(uri))
        return view.startDragAndDrop(clip, View.DragShadowBuilder(view), Drops.LOCAL_DRAG, View.DRAG_FLAG_GLOBAL or View.DRAG_FLAG_GLOBAL_URI_READ)
    }

    override fun pick(row: Row.Msg) = picks.toggle(row.item.id)

    /**
     * A long-press while picking several: in split screen (or a desktop window), on a picked file saved here, every
     * picked file saved here goes in one drag into the other app; anywhere else it picks, like a tap.
     */
    override fun pickLong(row: Row.Msg, view: View): Boolean {
        if (isInMultiWindowMode && row.item.isFile && row.item.id in picks.ids) {
            val files = picks.items().filter { it.isFile }.mapNotNull { i -> localCopy(i)?.let { i to it } }
            if (files.isNotEmpty()) {
                val label = if (files.size == 1) files[0].first.displayName else resources.getQuantityString(R.plurals.file_count, files.size, files.size)
                val clip = ClipData(ClipDescription(label, files.map { mimeOf(it.first) }.distinct().toTypedArray()), ClipData.Item(files[0].second))
                for (f in files.drop(1)) clip.addItem(ClipData.Item(f.second))
                return view.startDragAndDrop(clip, View.DragShadowBuilder(view), Drops.LOCAL_DRAG, View.DRAG_FLAG_GLOBAL or View.DRAG_FLAG_GLOBAL_URI_READ)
            }
        }
        picks.toggle(row.item.id)
        return true
    }

    private fun onDownloadFinished(f: TransferManager.Finished) {
        val mime = mimeOf(f.item)
        when (f.reason) {
            TransferManager.Reason.OPEN -> FileActions.open(this, f.uri, mime)
            TransferManager.Reason.SHARE -> FileActions.share(this, f.uri, mime)
            // (GROUP: one of several picked in another screen that's gone now: it's saved.)
            TransferManager.Reason.SAVE, TransferManager.Reason.GROUP -> Snackbar.make(b.root, R.string.saved_to, Snackbar.LENGTH_LONG)
                .setAnchorView(b.composeBar)
                .setAction(R.string.open) { FileActions.open(this, f.uri, mime) }
                .show()
            else -> Unit
        }
    }

    private fun snack(message: String) = Snackbar.make(b.root, message, Snackbar.LENGTH_LONG).setAnchorView(b.composeBar).show()

    companion object {
        private const val EXTRA_KEY = "conversation"
        private const val EXTRA_ITEM = "item"
        private const val STATE_CAMERA = "cameraFile"

        /** Opens conversation [key]; with [itemId], scrolled to that item (from search) and highlighted. */
        fun intent(ctx: Context, key: String, itemId: String? = null): Intent = Intent(ctx, ThreadActivity::class.java)
            .setAction("app.beam.android.CONVERSATION")
            .setData("beam://conversation/${Uri.encode(key)}".toUri())
            .putExtra(EXTRA_KEY, key)
            .apply { if (itemId != null) putExtra(EXTRA_ITEM, itemId) }
    }
}
