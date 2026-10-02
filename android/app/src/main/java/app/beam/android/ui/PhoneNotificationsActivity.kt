package app.beam.android.ui

import android.app.StatusBarManager
import android.content.ComponentName
import android.content.Intent
import android.graphics.drawable.Drawable
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.isVisible
import androidx.core.widget.doAfterTextChanged
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.recyclerview.widget.ConcatAdapter
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import app.beam.android.R
import app.beam.android.core.Device
import app.beam.android.core.Format
import app.beam.android.databinding.ActivityPhoneNotificationsBinding
import app.beam.android.databinding.PhoneNotificationsHeaderBinding
import app.beam.android.phone.PcNotificationsTileService
import app.beam.android.phone.ShareListenerService
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.materialswitch.MaterialSwitch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Settings → "Notifications on your PCs": the master switch, the one-time notification access (detected when the
 * user comes back from Android's screen), where they show ("Show on": a server setting per device), and which apps
 * (every app off until picked; the ones seen notifying lately first, plus a search).
 */
class PhoneNotificationsActivity : BaseActivity() {
    private lateinit var b: ActivityPhoneNotificationsBinding
    private lateinit var header: PhoneNotificationsHeaderBinding
    private val apps = AppsAdapter()
    private var allApps: List<AppRow> = emptyList()
    private var query = ""

    /** The user switched it on without access yet: once Android's screen grants it, the setup carries on. */
    private var enableAfterAccess = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityPhoneNotificationsBinding.inflate(layoutInflater)
        setContentView(b.root)
        b.appbar.padForSystemBars(top = true)
        b.list.padForSystemBars(bottom = true, ime = true)
        b.toolbar.setNavigationOnClickListener { finish() }
        enableAfterAccess = savedInstanceState?.getBoolean(STATE_ENABLE_AFTER_ACCESS) == true

        b.list.layoutManager = LinearLayoutManager(this) // before inflating into it: RecyclerView needs it for the layout params
        header = PhoneNotificationsHeaderBinding.inflate(layoutInflater, b.list, false)
        b.list.adapter = ConcatAdapter(HeaderAdapter(header.root), apps)
        header.rowMaster.setOnClickListener { toggleMaster() }
        header.grant.setOnClickListener { openAccessSettings() }
        header.stayOn.setOnClickListener {
            app.prefs.stayConnected = true
            app.ensureBackgroundService()
            bind()
        }
        header.addTile.isVisible = Build.VERSION.SDK_INT >= 33
        header.addTile.setOnClickListener { addTile() }
        header.search.doAfterTextChanged {
            query = it?.toString().orEmpty().trim()
            showApps()
        }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                combine(app.repo.state, app.phone.changes) { s, _ -> s }.collect { bind() }
            }
        }
        loadApps()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putBoolean(STATE_ENABLE_AFTER_ACCESS, enableAfterAccess)
    }

    override fun onResume() {
        super.onResume()
        // Back from Android's notification access screen: carry on with the setup, or show what changed.
        if (enableAfterAccess && app.phone.accessGranted) {
            enableAfterAccess = false
            switchOn()
        }
        app.phone.recheck()
        bind()
    }

    // ---------------------------------------------------------------- the switch and its setup

    private fun toggleMaster() {
        val phone = app.phone
        when {
            phone.enabled -> phone.setEnabled(false)
            !app.prefs.paired || !phone.serverReady -> return
            !phone.accessGranted -> {
                enableAfterAccess = true
                openAccessSettings()
            }
            else -> switchOn()
        }
        bind()
    }

    /** On, after the first setup's "Show on" step (the Windows PCs checked, the user confirms). */
    private fun switchOn() {
        if (app.prefs.phoneSetupDone) {
            app.phone.setEnabled(true)
            bind()
            return
        }
        val others = otherDevices()
        if (others.isEmpty()) {
            app.prefs.phoneSetupDone = true
            app.phone.setEnabled(true)
            bind()
            return
        }
        val checked = BooleanArray(others.size) { others[it].phoneNotifications || others[it].platform == "windows" }
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.pc_notifications_setup_title)
            .setMultiChoiceItems(others.map { "${it.name} · ${platformName(it.platform)}" }.toTypedArray(), checked) { _, i, on -> checked[i] = on }
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.pc_notifications_setup_ok) { _, _ ->
                app.prefs.phoneSetupDone = true
                app.phone.setEnabled(true)
                others.forEachIndexed { i, d -> if (checked[i] != d.phoneNotifications) setShowsOn(d, checked[i]) }
                bind()
            }
            .show()
    }

    private fun openAccessSettings() {
        val component = ComponentName(this, ShareListenerService::class.java)
        val intents = buildList {
            if (Build.VERSION.SDK_INT >= 30) {
                add(Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS).putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, component.flattenToString()))
            }
            add(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
        for (intent in intents) {
            try {
                startActivity(intent)
                return
            } catch (_: Exception) {
            }
        }
        toast(getString(R.string.pc_notifications_access_missing))
    }

    private fun addTile() {
        if (Build.VERSION.SDK_INT < 33) return
        val sbm = getSystemService(StatusBarManager::class.java) ?: return
        sbm.requestAddTileService(
            ComponentName(this, PcNotificationsTileService::class.java),
            getString(R.string.pc_notifications_tile),
            Icon.createWithResource(this, R.drawable.ic_tile_pc_notifications),
            mainExecutor,
        ) { }
    }

    // ---------------------------------------------------------------- what's on screen

    private fun bind() {
        if (!::header.isInitialized) return
        val phone = app.phone
        val paired = app.prefs.paired
        val ready = paired && phone.serverReady
        header.master.isChecked = phone.enabled
        header.rowMaster.isEnabled = ready || phone.enabled
        header.rowMaster.alpha = if (ready || phone.enabled) 1f else 0.5f
        header.notice.isVisible = !ready
        header.notice.setText(if (!paired) R.string.pc_notifications_not_paired else R.string.pc_notifications_needs_server)
        header.accessCard.isVisible = ready && !phone.accessGranted
        header.stayCard.isVisible = ready && phone.enabled && !app.prefs.stayConnected
        bindShowOn()
    }

    private fun otherDevices(): List<Device> {
        val s = app.repo.state.value
        return s.devices.filter { it.id != s.me && it.id != app.prefs.deviceId }.sortedWith(compareByDescending<Device> { it.platform == "windows" }.thenBy { it.name.lowercase() })
    }

    private fun bindShowOn() {
        val list = header.showOn
        list.removeAllViews()
        val others = otherDevices()
        if (others.isEmpty()) {
            list.addView(row(getString(R.string.pc_notifications_show_on_none), null, null) {})
            return
        }
        val ready = app.prefs.paired && app.phone.serverReady
        for (d in others) {
            val summary = listOfNotNull(platformName(d.platform), Format.presence(d.online, d.lastSeen)).joinToString(" · ")
            list.addView(row(d.name, summary, d.phoneNotifications) { if (ready) setShowsOn(d, !d.phoneNotifications) })
        }
    }

    private fun row(title: String, summary: String?, on: Boolean?, onClick: () -> Unit): View {
        val row = LayoutInflater.from(this).inflate(R.layout.item_setting_switch, header.showOn, false) as LinearLayout
        row.findViewById<TextView>(R.id.title).text = title
        row.findViewById<TextView>(R.id.summary).apply {
            text = summary
            isVisible = summary != null
        }
        row.findViewById<MaterialSwitch>(R.id.toggle).apply {
            isVisible = on != null
            isChecked = on == true
        }
        row.setOnClickListener { onClick() }
        return row
    }

    /** "Show on": that device's own setting on the server (any device may change it for any device). */
    private fun setShowsOn(d: Device, on: Boolean) {
        val api = app.api ?: return
        lifecycleScope.launch {
            val error = withContext(Dispatchers.IO) { runCatching { api.setShowsPhoneNotifications(d.id, on) }.exceptionOrNull() }
            // The server's `devices` event brings the new value to every screen.
            if (error != null) toast(getString(R.string.pc_notifications_change_failed, Format.error(error)))
        }
    }

    private fun platformName(platform: String): String = when (platform) {
        "windows" -> getString(R.string.platform_windows)
        "android" -> getString(R.string.platform_android)
        "web" -> getString(R.string.platform_web)
        else -> platform.replaceFirstChar { it.uppercase() }
    }

    // ---------------------------------------------------------------- the apps

    class AppRow(val pkg: String, val label: String, val icon: Drawable?, val recent: Boolean)

    private fun loadApps() {
        lifecycleScope.launch {
            val recent = app.prefs.recentNotifiers
            val rows = withContext(Dispatchers.IO) {
                val pm = packageManager
                val pkgs = LinkedHashSet<String>()
                try {
                    pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0).forEach { pkgs += it.activityInfo.packageName }
                } catch (_: Exception) {
                }
                pkgs += recent.keys
                pkgs += app.prefs.sharedApps
                pkgs -= packageName
                pkgs.map { pkg ->
                    val (label, icon) = try {
                        val info = pm.getApplicationInfo(pkg, 0)
                        pm.getApplicationLabel(info).toString() to pm.getApplicationIcon(info)
                    } catch (_: Exception) {
                        pkg to null
                    }
                    AppRow(pkg, label, icon, pkg in recent)
                }.sortedWith(compareByDescending<AppRow> { recent[it.pkg] ?: 0L }.thenBy { it.label.lowercase() })
            }
            allApps = rows
            showApps()
        }
    }

    private fun showApps() {
        val q = query.lowercase()
        val shown = if (q.isEmpty()) allApps else allApps.filter { q in it.label.lowercase() || q in it.pkg.lowercase() }
        apps.submitList(shown)
        if (::header.isInitialized) {
            header.appsEmpty.isVisible = shown.isEmpty() && allApps.isNotEmpty()
            header.appsEmpty.setText(R.string.pc_notifications_no_apps)
        }
    }

    private inner class AppsAdapter : ListAdapter<AppRow, AppsAdapter.Holder>(object : DiffUtil.ItemCallback<AppRow>() {
        override fun areItemsTheSame(a: AppRow, b: AppRow) = a.pkg == b.pkg
        override fun areContentsTheSame(a: AppRow, b: AppRow) = a.pkg == b.pkg && a.label == b.label
    }) {
        inner class Holder(v: View) : RecyclerView.ViewHolder(v) {
            val icon: ImageView = v.findViewById(R.id.icon)
            val title: TextView = v.findViewById(R.id.title)
            val summary: TextView = v.findViewById(R.id.summary)
            val toggle: MaterialSwitch = v.findViewById(R.id.toggle)
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
            Holder(LayoutInflater.from(parent.context).inflate(R.layout.item_app_switch, parent, false))

        override fun onBindViewHolder(h: Holder, position: Int) {
            val row = getItem(position)
            h.icon.setImageDrawable(row.icon)
            h.title.text = row.label
            h.summary.text = if (row.recent) getString(R.string.pc_notifications_recent) else null
            h.summary.isVisible = row.recent
            h.toggle.isChecked = row.pkg in app.prefs.sharedApps
            h.itemView.setOnClickListener {
                val on = row.pkg !in app.prefs.sharedApps
                app.phone.setAppShared(row.pkg, on)
                h.toggle.isChecked = on
            }
        }
    }

    private class HeaderAdapter(private val view: View) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
        override fun getItemCount() = 1
        override fun getItemViewType(position: Int) = R.layout.phone_notifications_header
        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) = object : RecyclerView.ViewHolder(view) {}
        override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) = Unit
    }

    companion object {
        private const val STATE_ENABLE_AFTER_ACCESS = "enableAfterAccess"
    }
}
