package app.beam.android.ui

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.LayoutInflater
import android.view.ViewGroup
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
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
import app.beam.android.core.Pairing
import app.beam.android.data.AppUpdater
import app.beam.android.data.Repository
import app.beam.android.databinding.ActivityMainBinding
import app.beam.android.databinding.ItemConversationBinding
import app.beam.android.notify.Notifier
import app.beam.android.update.SelfInstaller
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.snackbar.Snackbar
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Home: one conversation per device, "All devices" pinned first. */
class MainActivity : BaseActivity() {
    private lateinit var b: ActivityMainBinding
    private lateinit var adapter: ConversationAdapter

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { updateBanner() }

    private val scanner = registerForActivityResult(ScanContract()) { result -> result.contents?.let(::handleScanned) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!app.prefs.paired) {
            startActivity(Intent(this, PairActivity::class.java))
            finish()
            return
        }
        b = ActivityMainBinding.inflate(layoutInflater)
        setContentView(b.root)
        b.appbar.padForSystemBars(top = true)
        b.list.padForSystemBars(bottom = true)
        b.empty.padForSystemBars(bottom = true)

        b.toolbar.setOnMenuItemClickListener {
            when (it.itemId) {
                R.id.action_search -> startActivity(Intent(this, SearchActivity::class.java))
                R.id.action_send_clipboard -> startActivity(SendActivity.clipboardIntent(this))
                R.id.action_scan -> scanner.launch(
                    ScanOptions()
                        .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                        .setPrompt(getString(R.string.scan_prompt))
                        .setBeepEnabled(false)
                        .setOrientationLocked(false),
                )
                R.id.action_pair -> PairQr.show(this)
                R.id.action_settings -> startActivity(Intent(this, SettingsActivity::class.java))
                // In the browser: that's where its notifications work (Web Push), and where it can be installed.
                R.id.action_family -> app.repo.state.value.info?.family?.let { FileActions.openLink(this, it) }
            }
            true
        }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.repo.state.map { it.info?.family }.distinctUntilChanged().collect { url ->
                    b.toolbar.menu.findItem(R.id.action_family)?.isVisible = url != null
                }
            }
        }
        adapter = ConversationAdapter(this, { startActivity(ThreadActivity.intent(this, it.key)) }, ::conversationMenu)
        b.list.layoutManager = LinearLayoutManager(this)
        b.list.adapter = adapter
        b.refresh.setColorSchemeColors(getColor(R.color.accent))
        b.refresh.setOnRefreshListener { refresh() }
        b.emptyPair.setOnClickListener { PairQr.show(this) }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                // Keep "5 min" style times current, and the offline banner (it waits a few seconds).
                while (true) {
                    delay(5_000)
                    updateBanner()
                    if (System.currentTimeMillis() / 5_000 % 6 == 0L) adapter.notifyItemRangeChanged(0, adapter.itemCount)
                }
            }
        }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                combine(app.repo.state, app.prefs.lastRead) { s, read -> s to Conversations.summaries(s.me, s.devices, s.items, read) }
                    .flowOn(Dispatchers.Default) // the summaries go over every item: not on the main thread
                    .conflate()
                    .collect { (s, list) ->
                        adapter.me = s.me
                        adapter.muted = app.prefs.mutedDevices
                        adapter.submitList(list)
                        b.empty.isVisible = s.loaded && list.size == 1 && list[0].last == null
                        if (s.loaded && b.refresh.isRefreshing && !manualRefresh) b.refresh.isRefreshing = false
                        b.toolbar.subtitle = when (s.conn) {
                            Repository.Conn.CONNECTED -> null
                            Repository.Conn.OFFLINE -> getString(R.string.offline)
                            Repository.Conn.AUTH_FAILED -> null
                            else -> if (s.loaded) null else getString(R.string.connecting)
                        }
                        updateBanner()
                    }
            }
        }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) { combine(app.updates.state, app.updates.problem) { _, _ -> }.collect { updateBanner() } }
        }
        // Instant on a cold start: the saved copy shows right away; only a first-ever start waits.
        if (!app.repo.state.value.loaded) b.refresh.isRefreshing = true
        maybeAskForNotifications()
    }

    override fun onResume() {
        super.onResume()
        if (::b.isInitialized) updateBanner()
    }

    private var manualRefresh = false

    /**
     * A scanned QR code: approve a new device's sign-in, or explain what else it was. A pairing link of
     * this same Beam at a new address switches to it in place (the server moved).
     */
    fun handleScanned(contents: String) {
        val code = Pairing.approveCode(contents)
        val link = Pairing.parse(contents)
        when {
            code != null -> startActivity(ApproveActivity.intent(this, code, host = Pairing.approveHost(contents)))
            link != null -> {
                val ours = app.prefs.baseUrl.orEmpty()
                if (link.baseUrl == ours) {
                    Snackbar.make(b.root, R.string.scan_already_signed_in, Snackbar.LENGTH_LONG).show()
                    return
                }
                lifecycleScope.launch {
                    val there = withContext(Dispatchers.IO) { app.moves.verify(link.baseUrl) }
                    if (there != null) {
                        app.moves.switchTo(link.baseUrl, there.serverId)
                        Snackbar.make(b.root, getString(R.string.settings_server_switched, link.baseUrl.substringAfter("://")), Snackbar.LENGTH_LONG).show()
                    } else {
                        Snackbar.make(b.root, getString(R.string.scan_already_signed_in_elsewhere, ours.substringAfter("://")), Snackbar.LENGTH_LONG).show()
                    }
                }
            }
            else -> Snackbar.make(b.root, R.string.scan_not_beam, Snackbar.LENGTH_LONG).show()
        }
    }

    private fun refresh() {
        manualRefresh = true
        app.connection.kick()
        lifecycleScope.launch {
            val error = app.repo.refresh()
            manualRefresh = false
            b.refresh.isRefreshing = false
            if (error != null) Snackbar.make(b.root, Format.error(error), Snackbar.LENGTH_LONG).show()
        }
    }

    private fun maybeAskForNotifications() {
        if (Build.VERSION.SDK_INT < 33 || app.prefs.askedForNotifications) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        app.prefs.askedForNotifications = true
        notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    /** One notice at a time, most important first. */
    private fun updateBanner() {
        val s = app.repo.state.value
        val banner = b.banner
        banner.bannerAction2.isVisible = false
        when {
            s.conn == Repository.Conn.AUTH_FAILED -> {
                banner.bannerText.setText(R.string.auth_failed)
                banner.bannerAction.setText(R.string.settings)
                banner.bannerAction.setOnClickListener { startActivity(Intent(this, SettingsActivity::class.java)) }
                banner.root.isVisible = true
            }
            OfflineBanner.bind(this, banner.root, banner.bannerText, banner.bannerAction, banner.bannerAction2, s) -> Unit
            !Notifier.canPost(this) -> {
                banner.bannerText.setText(R.string.notifications_off)
                banner.bannerAction.setText(R.string.turn_on)
                banner.bannerAction.setOnClickListener { openNotificationSettings(this) }
                banner.root.isVisible = true
            }
            // (an update Beam can install by itself shows only if its last try didn't install, with why)
            app.updates.state.value.let { it is AppUpdater.State.Ready && (!SelfInstaller.canInstallQuietly(this) || app.updates.problemWith(it.update) != null) } -> {
                val ready = app.updates.state.value as AppUpdater.State.Ready
                val problem = app.updates.problemWith(ready.update)
                banner.bannerText.text = if (problem != null) getString(R.string.update_didnt_install, ready.update.version, problem.message) else getString(R.string.update_ready, ready.update.version)
                banner.bannerAction.setText(if (problem != null) R.string.update_try_again else R.string.update_install)
                banner.bannerAction.setOnClickListener { startActivity(UpdateActivity.intent(this)) }
                banner.root.isVisible = true
            }
            else -> banner.root.isVisible = false
        }
    }

    /** Long-press on a conversation: per-device notifications, auto-copy, clear, forget. */
    private fun conversationMenu(s: Conversations.Summary) {
        val entries = ArrayList<ActionSheet.Entry>()
        // Ring / Stop ringing / Wake / Remote Desktop, when the device can (server 1.3).
        app.repo.state.value.devicesById[s.key]?.let { d -> entries += DeviceActions.entries(this, d, b.root) }
        if (!s.isAll) {
            val muted = s.key in app.prefs.mutedDevices
            entries += ActionSheet.Entry(R.drawable.ic_mute, getString(if (muted) R.string.unmute else R.string.mute)) {
                app.prefs.mutedDevices = if (muted) app.prefs.mutedDevices - s.key else app.prefs.mutedDevices + s.key
                adapter.muted = app.prefs.mutedDevices
                adapter.notifyItemRangeChanged(0, adapter.itemCount)
            }
            val copies = s.key in app.prefs.autoCopyDevices
            entries += ActionSheet.Entry(R.drawable.ic_copy, getString(if (copies) R.string.auto_copy_from_off else R.string.auto_copy_from_on)) {
                app.prefs.autoCopyDevices = if (copies) app.prefs.autoCopyDevices - s.key else app.prefs.autoCopyDevices + s.key
            }
        }
        entries += ActionSheet.Entry(R.drawable.ic_clear_all, getString(R.string.clear_conversation)) { clearConversation(s) }
        if (!s.isAll && s.known) entries += ActionSheet.Entry(R.drawable.ic_delete, getString(R.string.forget_device)) { forgetDevice(s) }
        ActionSheet.show(this, if (s.isAll) getString(R.string.all_devices) else s.name, entries)
    }

    private fun clearConversation(s: Conversations.Summary) {
        val state = app.repo.state.value
        val ids = Conversations.thread(s.key, state.me, state.items, state.devicesById).map { it.id }
        if (ids.isEmpty()) return
        val name = if (s.isAll) getString(R.string.all_devices) else s.name
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.clear_conversation)
            .setMessage(resources.getQuantityString(R.plurals.clear_conversation_confirm, ids.size, ids.size, name))
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.clear) { _, _ ->
                lifecycleScope.launch {
                    try {
                        app.repo.deleteAll(ids)
                    } catch (e: Exception) {
                        Snackbar.make(b.root, Format.error(e), Snackbar.LENGTH_LONG).show()
                    }
                }
            }
            .show()
    }

    private fun forgetDevice(s: Conversations.Summary) {
        MaterialAlertDialogBuilder(this)
            .setTitle(getString(R.string.forget_device_title, s.name))
            .setMessage(R.string.forget_device_body)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.forget) { _, _ ->
                lifecycleScope.launch {
                    val error = withContext(Dispatchers.IO) {
                        runCatching { app.api?.forgetDevice(s.key) }.exceptionOrNull()
                    }
                    if (error != null) Snackbar.make(b.root, Format.error(error), Snackbar.LENGTH_LONG).show() else app.repo.refresh()
                }
            }
            .show()
    }

    companion object {
        fun openNotificationSettings(activity: Activity) {
            activity.startActivity(
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName),
            )
        }
    }
}

class ConversationAdapter(
    private val activity: Activity,
    private val onOpen: (Conversations.Summary) -> Unit,
    private val onMenu: (Conversations.Summary) -> Unit = {},
) : ListAdapter<Conversations.Summary, ConversationAdapter.Holder>(DIFF) {
    var me: String = ""
    var muted: Set<String> = emptySet()

    class Holder(val b: ItemConversationBinding) : RecyclerView.ViewHolder(b.root) {
        val normalBackground: Drawable? = b.row.background
        var key: String = Conversations.ALL
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
        val holder = Holder(ItemConversationBinding.inflate(LayoutInflater.from(parent.context), parent, false))
        holder.b.row.setOnDragListener(
            Drops.listener(activity, { holder.key }) { hover ->
                holder.b.row.background = if (hover) ContextCompat.getDrawable(activity, R.drawable.row_drop_highlight) else holder.normalBackground
            },
        )
        return holder
    }

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val s = getItem(position)
        val b = holder.b
        val ctx = b.root.context
        holder.key = s.key
        b.title.text = if (s.isAll) ctx.getString(R.string.all_devices) else s.name
        b.avatar.setImageResource(platformIcon(s.platform, s.isAll))
        b.onlineDot.isVisible = s.online
        b.muted.isVisible = s.key in muted
        b.time.text = s.last?.let { Format.relative(it.ts) }.orEmpty()
        val last = s.last
        b.preview.text = when {
            last == null && s.isAll -> ctx.getString(R.string.broadcast_subtitle)
            last == null -> Format.presence(s.online, s.lastSeen)
            else -> {
                val body = if (last.isText) last.text.orEmpty().lineSequence().firstOrNull { it.isNotBlank() }.orEmpty().trim()
                else ctx.getString(R.string.file_prefix, last.displayName)
                if (last.isFrom(me)) ctx.getString(R.string.you_prefix, body) else body
            }
        }
        val unread = s.unread > 0
        b.badge.isVisible = unread
        b.badge.text = if (s.unread > 99) "99+" else s.unread.toString()
        b.preview.setTextColor(ctx.getColor(if (unread) R.color.text else R.color.muted))
        b.preview.setTypeface(null, if (unread) Typeface.BOLD else Typeface.NORMAL)
        b.row.setOnClickListener { onOpen(s) }
        b.row.setOnLongClickListener {
            onMenu(s)
            true
        }
        b.row.contentDescription = listOfNotNull(
            b.title.text,
            if (s.online) ctx.getString(R.string.online) else null,
            if (s.key in muted) ctx.getString(R.string.muted) else null,
            if (unread) ctx.resources.getQuantityString(R.plurals.unread_count, s.unread, s.unread) else null,
            b.preview.text,
        ).joinToString(", ")
    }

    companion object {
        private val DIFF = object : DiffUtil.ItemCallback<Conversations.Summary>() {
            override fun areItemsTheSame(a: Conversations.Summary, b: Conversations.Summary) = a.key == b.key
            override fun areContentsTheSame(a: Conversations.Summary, b: Conversations.Summary) = a == b
        }
    }
}
