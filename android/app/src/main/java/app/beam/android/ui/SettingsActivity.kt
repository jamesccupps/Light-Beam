package app.beam.android.ui

import android.annotation.SuppressLint
import android.app.StatusBarManager
import android.content.ComponentName
import android.content.DialogInterface
import android.content.Intent
import android.content.pm.verify.domain.DomainVerificationManager
import android.content.pm.verify.domain.DomainVerificationUserState
import android.graphics.drawable.Icon
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.InputFilter
import android.text.InputType
import android.view.LayoutInflater
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.net.toUri
import androidx.core.view.isVisible
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import app.beam.android.BuildConfig
import app.beam.android.R
import app.beam.android.core.BeamApi
import app.beam.android.core.BeamException
import app.beam.android.core.Conversations
import app.beam.android.core.Device
import app.beam.android.core.Format
import app.beam.android.core.Pairing
import app.beam.android.core.ServerFinder
import app.beam.android.core.ServerInfo
import app.beam.android.data.AppUpdater
import app.beam.android.data.Prefs
import app.beam.android.data.Repository
import app.beam.android.data.SettingsBackups
import app.beam.android.databinding.ActivitySettingsBinding
import app.beam.android.notify.Notifier
import app.beam.android.service.ClipboardTileService
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.Executors

class SettingsActivity : BaseActivity() {
    private lateinit var b: ActivitySettingsBinding

    private val sizes = longArrayOf(50, 100, 250, 500, 1024, 2048, 4096, 0)
    private var passwordSet: Boolean? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivitySettingsBinding.inflate(layoutInflater)
        setContentView(b.root)
        b.appbar.padForSystemBars(top = true)
        b.scroll.padForSystemBars(bottom = true)
        b.toolbar.setNavigationOnClickListener { finish() }

        val prefs = app.prefs
        b.rowName.setOnClickListener { editName() }
        b.rowStay.setOnClickListener {
            prefs.stayConnected = !prefs.stayConnected
            app.ensureBackgroundService()
            bind()
        }
        b.rowAutoCopy.setOnClickListener {
            prefs.autoCopy = !prefs.autoCopy
            bind()
        }
        b.rowAutoDownload.setOnClickListener {
            prefs.autoDownload = !prefs.autoDownload
            bind()
        }
        b.rowWifiOnly.setOnClickListener {
            prefs.wifiOnlyDownloads = !prefs.wifiOnlyDownloads
            bind()
        }
        b.rowAlertBattery.setOnClickListener { changeAlerts { it.put("battery", !it.optBoolean("battery", true)) } }
        b.rowAlertStorage.setOnClickListener { changeAlerts { it.put("storage", !it.optBoolean("storage", true)) } }
        b.rowAlertServerDisk.setOnClickListener { changeAlerts { it.put("serverDisk", !it.optBoolean("serverDisk", true)) } }
        b.rowMaxSize.setOnClickListener { pickMaxSize() }
        b.rowNotifications.setOnClickListener { MainActivity.openNotificationSettings(this) }
        b.rowBattery.setOnClickListener { allowBackground() }
        b.rowTile.setOnClickListener { pickTileTarget() }
        b.rowOpenLinks.setOnClickListener { openLinkSettings() }
        b.rowApprove.setOnClickListener { enterApproveCode() }
        b.rowPassword.setOnClickListener { editPassword() }
        b.rowServer.setOnClickListener { changeServer() }
        b.rowServerInfo.setOnClickListener { refreshInfo() }
        b.rowPairAnother.setOnClickListener { PairQr.show(this) }
        b.rowUpdates.setOnClickListener { checkForUpdates() }
        b.rowPhoneNotifications.setOnClickListener { startActivity(Intent(this, PhoneNotificationsActivity::class.java)) }
        b.rowRestore.setOnClickListener {
            if (app.repo.state.value.info?.lists(SettingsBackups.FEATURE) == false) toast(getString(R.string.backup_needs_server))
            else RestoreSettings.choose(this) {
                bind()
                bindDevices(app.repo.state.value.devices)
            }
        }
        b.unpair.setOnClickListener {
            MaterialAlertDialogBuilder(this)
                .setMessage(R.string.settings_unpair_confirm)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.settings_unpair) { _, _ ->
                    app.unpair()
                    startActivity(Intent(this, PairActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
                    finish()
                }
                .show()
        }
        b.versionValue.text = getString(R.string.settings_version_value, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE)

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.repo.state.map { Triple(it.conn, it.info, it.devices) }.distinctUntilChanged().collect { (conn, info, devices) ->
                    b.serverStatus.setText(
                        when (conn) {
                            Repository.Conn.CONNECTED -> R.string.settings_server_connected
                            Repository.Conn.AUTH_FAILED -> R.string.auth_failed
                            Repository.Conn.OFFLINE -> R.string.settings_server_unreachable
                            else -> R.string.connecting
                        },
                    )
                    bindInfo(info)
                    bindDevices(devices)
                    bindRestore()
                }
            }
        }
        // Server 1.6: who controls which PC, shown with the devices (and ended from their menu).
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.remote.sessions.collect { bindDevices(app.repo.state.value.devices) }
            }
        }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                combine(app.updates.state, app.updates.problem) { s, _ -> s }.collect { s ->
                    b.updatesValue.text = when (s) {
                        AppUpdater.State.Checking -> getString(R.string.update_checking)
                        is AppUpdater.State.Downloading -> getString(R.string.update_downloading, s.update.version)
                        // (and why its last try didn't install, if it didn't)
                        is AppUpdater.State.Ready -> getString(R.string.update_ready, s.update.version) +
                            (app.updates.problemWith(s.update)?.let { "\n" + getString(R.string.update_last_try, it.message) } ?: "")
                        is AppUpdater.State.Failed -> s.message
                        is AppUpdater.State.UpToDate -> getString(R.string.update_none, BuildConfig.VERSION_NAME)
                        AppUpdater.State.Idle -> getString(R.string.settings_updates_summary)
                    }
                }
            }
        }
        if (savedInstanceState == null && intent.getBooleanExtra(EXTRA_CHANGE_SERVER, false)) changeServer()
    }

    override fun onResume() {
        super.onResume()
        bind()
        loadPasswordState()
        refreshInfo()
        loadAlerts()
        lifecycleScope.launch(Dispatchers.IO) { app.remote.refreshSessions() }
    }

    private fun bind() {
        val prefs = app.prefs
        b.nameValue.text = prefs.deviceName
        b.stay.isChecked = prefs.stayConnected
        b.autoCopy.isChecked = prefs.autoCopy
        b.autoDownload.isChecked = prefs.autoDownload
        b.wifiOnly.isChecked = prefs.wifiOnlyDownloads
        b.maxSizeValue.text = sizeLabel(prefs.maxDownloadMb)
        for (row in listOf(b.rowMaxSize, b.rowWifiOnly)) {
            row.isEnabled = prefs.autoDownload
            row.alpha = if (prefs.autoDownload) 1f else 0.5f
        }
        b.notificationsValue.setText(if (Notifier.canPost(this)) R.string.settings_notifications_on else R.string.settings_notifications_off)
        b.batteryValue.setText(if (ignoringBatteryOptimizations()) R.string.settings_battery_unrestricted else R.string.settings_battery_optimized)
        b.serverValue.text = prefs.baseUrl.orEmpty()
        b.tileValue.text = tileTargetLabel()
        b.phoneNotificationsValue.text = phoneNotificationsLabel()
        b.openLinksValue.setText(
            when (openLinksState()) {
                true -> R.string.settings_open_links_on
                false -> R.string.settings_open_links_off
                null -> R.string.settings_open_links_unknown
            },
        )
    }

    /** (1.8.2) "Kept on your Beam too (Oct 3, 08:23)", or what it needs. */
    private fun bindRestore() {
        val s = app.repo.state.value
        b.restoreValue.text = when {
            s.info?.lists(SettingsBackups.FEATURE) == false -> getString(R.string.backup_needs_server)
            else -> s.devicesById[s.me]?.backupAt?.let { getString(R.string.backup_summary_at, Format.at(it)) } ?: getString(R.string.backup_summary)
        }
    }

    /** "Off", "On · 3 apps · Desk, Laptop", or what's missing. */
    private fun phoneNotificationsLabel(): String {
        val phone = app.phone
        val s = app.repo.state.value
        return when {
            !phone.serverReady && s.info != null -> getString(R.string.pc_notifications_summary_needs_server)
            !phone.enabled -> getString(R.string.pc_notifications_summary_off)
            !phone.accessGranted -> getString(R.string.pc_notifications_summary_needs_access)
            else -> {
                val count = app.prefs.sharedApps.size
                val shownOn = s.devices.filter { it.phoneNotifications && it.id != s.me }.joinToString(", ") { it.name }
                getString(
                    R.string.pc_notifications_summary_on,
                    resources.getQuantityString(R.plurals.pc_notifications_app_count, count, count),
                    shownOn.ifEmpty { getString(R.string.pc_notifications_nowhere) },
                )
            }
        }
    }

    private fun sizeLabel(mb: Long) = when {
        mb <= 0 -> getString(R.string.settings_no_limit)
        mb >= 1024 -> "${mb / 1024} GB"
        else -> "$mb MB"
    }

    private fun pickMaxSize() {
        val labels = sizes.map { sizeLabel(it) }.toTypedArray()
        val current = sizes.indexOf(app.prefs.maxDownloadMb).coerceAtLeast(0)
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.settings_max_size)
            .setSingleChoiceItems(labels, current) { dialog, which ->
                app.prefs.maxDownloadMb = sizes[which]
                bind()
                dialog.dismiss()
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    // ---------------------------------------------------------------- battery

    private fun ignoringBatteryOptimizations(): Boolean =
        getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(packageName) == true

    /** One tap: Android's own "Let Beam always run in the background?" prompt. */
    @SuppressLint("BatteryLife") // Beam's whole job is to receive in the background; it asks the user.
    private fun allowBackground() {
        val intent = if (ignoringBatteryOptimizations()) Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        else Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, "package:$packageName".toUri())
        try {
            startActivity(intent)
        } catch (_: Exception) {
            try {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            } catch (_: Exception) {
                toast(getString(R.string.settings_battery_manual))
            }
        }
    }

    // ---------------------------------------------------------------- quick access

    private fun tileTargetLabel(): String = when (val t = app.prefs.tileTarget) {
        null -> getString(R.string.settings_tile_ask)
        Conversations.ALL -> getString(R.string.settings_tile_to, getString(R.string.all_devices))
        else -> getString(R.string.settings_tile_to, app.repo.state.value.devicesById[t]?.name ?: getString(R.string.unknown_device))
    }

    /** Where the Quick Settings tile sends the clipboard; plus a button that adds the tile (Android 13+). */
    private fun pickTileTarget() {
        val s = app.repo.state.value
        val devices = s.devices.filter { it.id != s.me }.sortedByDescending { it.lastSeen }
        val keys = listOf<String?>(null, Conversations.ALL) + devices.map { it.id }
        val labels = listOf(getString(R.string.settings_tile_ask_short), getString(R.string.all_devices)) + devices.map { it.name }
        val current = keys.indexOf(app.prefs.tileTarget).coerceAtLeast(0)
        val builder = MaterialAlertDialogBuilder(this)
            .setTitle(R.string.settings_tile)
            .setSingleChoiceItems(labels.toTypedArray(), current) { dialog, which ->
                app.prefs.tileTarget = keys[which]
                bind()
                dialog.dismiss()
            }
            .setNegativeButton(R.string.cancel, null)
        if (Build.VERSION.SDK_INT >= 33) builder.setNeutralButton(R.string.settings_tile_add) { _, _ -> addTile() }
        builder.show()
    }

    private fun addTile() {
        if (Build.VERSION.SDK_INT < 33) return
        val sbm = getSystemService(StatusBarManager::class.java) ?: return
        sbm.requestAddTileService(
            ComponentName(this, ClipboardTileService::class.java),
            getString(R.string.tile_label),
            Icon.createWithResource(this, R.drawable.ic_tile_clipboard),
            Executors.newSingleThreadExecutor(),
        ) { }
    }

    /**
     * Whether sign-in QR codes (https://….ts.net/?approve=…) open in Beam. Android can't verify Tailscale
     * addresses automatically, so the user allows it once in Android's "Open by default" page. Null: unknown.
     */
    private fun openLinksState(): Boolean? {
        if (Build.VERSION.SDK_INT < 31) return null
        return try {
            val state = getSystemService(DomainVerificationManager::class.java)?.getDomainVerificationUserState(packageName) ?: return null
            state.hostToStateMap.values.any { it == DomainVerificationUserState.DOMAIN_STATE_SELECTED || it == DomainVerificationUserState.DOMAIN_STATE_VERIFIED }
        } catch (_: Exception) {
            null
        }
    }

    private fun openLinkSettings() {
        val intent = if (Build.VERSION.SDK_INT >= 31) Intent(Settings.ACTION_APP_OPEN_BY_DEFAULT_SETTINGS, "package:$packageName".toUri())
        else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, "package:$packageName".toUri())
        try {
            startActivity(intent)
        } catch (_: Exception) {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, "package:$packageName".toUri()))
        }
    }

    // ---------------------------------------------------------------- devices

    private fun bindDevices(devices: List<Device>) {
        val me = app.prefs.deviceId
        val list = b.devicesList
        list.removeAllViews()
        val others = devices.filter { it.id != me }.sortedWith(compareByDescending<Device> { it.online }.thenByDescending { it.lastSeen })
        if (others.isEmpty()) {
            list.addView(row(getString(R.string.settings_devices_none), null) {})
            return
        }
        for (d in others) {
            val notes = listOfNotNull(
                Format.presence(d.online, d.lastSeen),
                if (d.phoneNotifications) getString(R.string.pc_notifications_shows) else null,
                app.remote.controlling(d.id).takeIf { it.isNotEmpty() }?.let { s ->
                    getString(R.string.remote_controlled_by, s.joinToString(", ") { DeviceActions.viewerName(this, it.viewer) })
                },
                Format.deviceStatus(d.status, withOs = true),
                d.appVersion?.let { "Beam $it" },
                if (d.id in offlineAlerts) getString(R.string.alerts_offline_on) else null,
                if (d.id in app.prefs.mutedDevices) getString(R.string.muted) else null,
                if (d.id in app.prefs.autoCopyDevices) getString(R.string.auto_copies) else null,
            ).joinToString(" · ")
            list.addView(row(d.name, notes) { deviceMenu(d) })
        }
    }

    private fun row(title: String, summary: String?, onClick: () -> Unit): LinearLayout {
        val row = LayoutInflater.from(this).inflate(R.layout.item_setting, b.devicesList, false) as LinearLayout
        row.findViewById<TextView>(R.id.title).text = title
        row.findViewById<TextView>(R.id.summary).apply {
            text = summary
            visibility = if (summary == null) android.view.View.GONE else android.view.View.VISIBLE
        }
        row.setOnClickListener { onClick() }
        return row
    }

    private fun deviceMenu(d: Device) {
        val muted = d.id in app.prefs.mutedDevices
        val copies = d.id in app.prefs.autoCopyDevices
        val alerting = d.id in offlineAlerts
        val alertEntry = if (alertSettings != null) {
            listOf(
                ActionSheet.Entry(R.drawable.ic_ring, getString(if (alerting) R.string.alerts_offline_off else R.string.alerts_offline_on)) {
                    changeAlerts { a ->
                        val ids = offlineAlerts.toMutableSet()
                        if (alerting) ids -= d.id else ids += d.id
                        a.put("offline", org.json.JSONArray(ids.toList()))
                    }
                },
            )
        } else {
            emptyList()
        }
        // Server 1.5: whether that device shows the phone's notifications (its own setting; any device may change it).
        val phoneEntry = if (app.phone.serverReady) {
            listOf(
                ActionSheet.Entry(R.drawable.ic_tile_pc_notifications, getString(if (d.phoneNotifications) R.string.pc_notifications_hide_on else R.string.pc_notifications_show_on_device)) {
                    val api = app.api ?: return@Entry
                    lifecycleScope.launch {
                        val error = withContext(Dispatchers.IO) { runCatching { api.setShowsPhoneNotifications(d.id, !d.phoneNotifications) }.exceptionOrNull() }
                        if (error != null) toast(getString(R.string.pc_notifications_change_failed, Format.error(error)))
                    }
                },
            )
        } else {
            emptyList()
        }
        ActionSheet.show(
            this, d.name,
            DeviceActions.entries(this, d, b.root) + alertEntry + phoneEntry + listOf(
                ActionSheet.Entry(R.drawable.ic_mute, getString(if (muted) R.string.unmute else R.string.mute)) {
                    app.prefs.mutedDevices = if (muted) app.prefs.mutedDevices - d.id else app.prefs.mutedDevices + d.id
                    bindDevices(app.repo.state.value.devices)
                },
                ActionSheet.Entry(R.drawable.ic_copy, getString(if (copies) R.string.auto_copy_from_off else R.string.auto_copy_from_on)) {
                    app.prefs.autoCopyDevices = if (copies) app.prefs.autoCopyDevices - d.id else app.prefs.autoCopyDevices + d.id
                    bindDevices(app.repo.state.value.devices)
                },
                ActionSheet.Entry(R.drawable.ic_delete, getString(R.string.forget_device)) { forgetDevice(d) },
            ),
        )
    }

    // ---------------------------------------------------------------- alerts (server 1.3)

    /** The server's `alerts` settings (null: an older server, or not loaded yet). */
    private var alertSettings: org.json.JSONObject? = null
    private val offlineAlerts: Set<String>
        get() = alertSettings?.optJSONArray("offline")?.let { a -> (0 until a.length()).map { a.optString(it) }.toSet() } ?: emptySet()

    private fun loadAlerts() {
        lifecycleScope.launch {
            val settings = withContext(Dispatchers.IO) { runCatching { app.api?.settings() }.getOrNull() }
            alertSettings = settings?.optJSONObject("alerts")
            bindAlerts()
            bindDevices(app.repo.state.value.devices)
        }
    }

    private fun bindAlerts() {
        val a = alertSettings
        b.alertsSection.isVisible = a != null
        if (a == null) return
        b.alertBattery.isChecked = a.optBoolean("battery", true)
        b.alertStorage.isChecked = a.optBoolean("storage", true)
        b.alertServerDisk.isChecked = a.optBoolean("serverDisk", true)
    }

    /** Changes the server's alert settings (shared by every device) and shows the result. */
    private fun changeAlerts(edit: (org.json.JSONObject) -> Unit) {
        val current = alertSettings ?: return
        val next = org.json.JSONObject(current.toString()).also(edit)
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching { app.api?.patchSettings(org.json.JSONObject().put("alerts", next)) }
            }
            result.onSuccess { saved ->
                alertSettings = saved?.optJSONObject("alerts") ?: next
            }.onFailure { toast(Format.error(it)) }
            bindAlerts()
            bindDevices(app.repo.state.value.devices)
        }
    }

    private fun forgetDevice(d: Device) {
        MaterialAlertDialogBuilder(this)
            .setTitle(getString(R.string.forget_device_title, d.name))
            .setMessage(R.string.forget_device_body)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.forget) { _, _ ->
                lifecycleScope.launch {
                    val error = withContext(Dispatchers.IO) { runCatching { app.api?.forgetDevice(d.id) }.exceptionOrNull() }
                    if (error != null) toast(Format.error(error)) else app.repo.refresh()
                }
            }
            .show()
    }

    // ---------------------------------------------------------------- server

    private fun refreshInfo() {
        lifecycleScope.launch { withContext(Dispatchers.IO) { app.refreshServerInfo() } }
    }

    private fun bindInfo(info: ServerInfo?) {
        if (info == null) {
            b.serverInfoValue.setText(R.string.settings_server_info_unknown)
            return
        }
        val parts = ArrayList<String>()
        parts += getString(R.string.settings_server_version, info.version)
        if (info.retentionDays > 0) parts += resources.getQuantityString(R.plurals.settings_retention, info.retentionDays, info.retentionDays)
        else parts += getString(R.string.settings_retention_forever)
        if (info.storageUsed != null) {
            parts += if (info.storageFree != null) getString(R.string.settings_storage, Format.size(info.storageUsed), Format.size(info.storageFree))
            else getString(R.string.settings_storage_used, Format.size(info.storageUsed))
        }
        if (info.maxUpload > 0) parts += getString(R.string.settings_max_upload, Format.size(info.maxUpload))
        b.serverInfoValue.text = parts.joinToString(" · ")
        passwordSet = info.passwordSet
    }

    /** A small dialog with one text field. */
    private fun askForText(title: Int, hint: Int, inputType: Int, initial: String, positive: Int, maxLength: Int = 0, onOk: (String) -> Unit) {
        val input = TextInputEditText(this).apply {
            setText(initial)
            this.inputType = inputType
            if (maxLength > 0) filters = arrayOf(InputFilter.LengthFilter(maxLength))
            setSelectAllOnFocus(true)
        }
        val layout = TextInputLayout(this).apply {
            this.hint = getString(hint)
            addView(input)
        }
        val frame = FrameLayout(this).apply {
            val pad = (20 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad / 2, pad, 0)
            addView(layout)
        }
        MaterialAlertDialogBuilder(this)
            .setTitle(title)
            .setView(frame)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(positive) { _, _ -> onOk(input.text?.toString()?.trim().orEmpty()) }
            .show()
        input.requestFocus()
    }

    private fun editName() {
        askForText(
            R.string.settings_name, R.string.settings_name, InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS,
            app.prefs.deviceName, R.string.save, Prefs.MAX_NAME,
        ) { name ->
            if (name.isNotEmpty()) {
                app.renameDevice(name)
                bind()
            }
        }
    }

    // ---------------------------------------------------------------- sign-in

    /** Approve a sign-in by typing the code the new device shows. */
    private fun enterApproveCode() {
        askForText(
            R.string.settings_approve, R.string.settings_approve_hint,
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS,
            "", R.string.next,
        ) { text ->
            val code = Pairing.approveCode(text)
            if (code == null) toast(getString(R.string.signin_not_a_code)) else startActivity(ApproveActivity.intent(this, code))
        }
    }

    private fun loadPasswordState() {
        lifecycleScope.launch {
            val set = withContext(Dispatchers.IO) { runCatching { app.api?.info()?.passwordSet }.getOrNull() }
            passwordSet = set
            b.passwordValue.setText(
                when (set) {
                    true -> R.string.settings_password_on
                    false -> R.string.settings_password_off
                    null -> R.string.settings_password_unknown
                },
            )
        }
    }

    /** Set, change or remove the password new devices can sign in with. */
    private fun editPassword() {
        val pad = (20 * resources.displayMetrics.density).toInt()
        fun field(hint: Int): Pair<TextInputEditText, TextInputLayout> {
            val edit = TextInputEditText(this).apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
            val layout = TextInputLayout(this).apply {
                this.hint = getString(hint)
                endIconMode = TextInputLayout.END_ICON_PASSWORD_TOGGLE
                addView(edit)
            }
            return edit to layout
        }
        val (first, firstLayout) = field(R.string.settings_password_new)
        val (second, secondLayout) = field(R.string.settings_password_again)
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, 0)
            addView(TextView(this@SettingsActivity).apply { setText(R.string.settings_password_explain) })
            addView(firstLayout)
            addView(secondLayout)
        }
        val builder = MaterialAlertDialogBuilder(this)
            .setTitle(R.string.settings_password)
            .setView(content)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.save, null)
        if (passwordSet == true) builder.setNeutralButton(R.string.remove) { _, _ -> savePassword("") }
        val dialog = builder.show()
        dialog.getButton(DialogInterface.BUTTON_POSITIVE).setOnClickListener {
            val pw = first.text?.toString().orEmpty()
            firstLayout.error = null
            secondLayout.error = null
            when {
                pw.length < 8 -> firstLayout.error = getString(R.string.settings_password_short)
                pw != second.text?.toString() -> secondLayout.error = getString(R.string.settings_password_mismatch)
                else -> {
                    dialog.dismiss()
                    savePassword(pw)
                }
            }
        }
    }

    private fun savePassword(password: String) {
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { app.api!!.setPassword(password) } }
            result.onSuccess { set ->
                passwordSet = set
                b.passwordValue.setText(if (set) R.string.settings_password_on else R.string.settings_password_off)
                toast(getString(if (set) R.string.settings_password_saved else R.string.settings_password_removed))
            }.onFailure { toast(Format.error(it)) }
        }
    }

    // ---------------------------------------------------------------- server address

    /** Points this phone at another address for its Beam (e.g. after the server moved). */
    private fun changeServer() {
        askForText(
            R.string.settings_server_change, R.string.settings_server_hint,
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI, app.prefs.baseUrl.orEmpty(), R.string.next,
        ) { text ->
            lifecycleScope.launch {
                val found = withContext(Dispatchers.IO) { runCatching { ServerFinder.find(text, app.http) } }
                found.onFailure { toast(Format.error(it)) }.onSuccess { f ->
                    val known = app.prefs.serverId
                    if (known != null && f.hello.serverId != known) {
                        MaterialAlertDialogBuilder(this@SettingsActivity)
                            .setTitle(R.string.settings_server_different_title)
                            .setMessage(R.string.settings_server_different_body)
                            .setNegativeButton(R.string.cancel, null)
                            .setPositiveButton(R.string.settings_server_switch_anyway) { _, _ -> switchServer(f, sameServer = false) }
                            .show()
                    } else {
                        switchServer(f, sameServer = true)
                    }
                }
            }
        }
    }

    private fun switchServer(found: ServerFinder.Found, sameServer: Boolean) {
        val key = app.prefs.key ?: return
        lifecycleScope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching { BeamApi(found.baseUrl, key, app.prefs.deviceId, app.prefs.deviceName, "android", app.http, app.prefs.profileId).me() }
            }
            ok.onFailure {
                toast(if (it is BeamException && it.status == 401) getString(R.string.settings_server_key_rejected) else Format.error(it))
            }.onSuccess {
                if (!sameServer) {
                    // The old server's copy of the shared notifications goes (first: it needs that server's info),
                    // and a viewer page's sign-in there.
                    app.phone.leaveServer()
                    app.remote.forget()
                    // Different items and devices: start fresh, without a flood of old notifications.
                    app.prefs.baselineDone = false
                    app.repo.clear()
                    app.status.forget() // it doesn't know this phone's battery, storage and Android version yet
                }
                app.moves.switchTo(found.baseUrl, found.hello.serverId)
                if (!sameServer) app.phone.onPaired() // sharing waits for the "Show on" setup there
                bind()
                toast(getString(R.string.settings_server_switched, found.baseUrl.substringAfter("://")))
            }
        }
    }

    // ---------------------------------------------------------------- updates

    private fun checkForUpdates() {
        if (app.updates.state.value is AppUpdater.State.Ready) {
            startActivity(UpdateActivity.intent(this))
            return
        }
        lifecycleScope.launch {
            if (app.updates.check(force = true) is AppUpdater.State.Ready) startActivity(UpdateActivity.intent(this@SettingsActivity))
        }
    }

    companion object {
        /** Open straight into "Server address" (from the offline banner's Change address). */
        const val EXTRA_CHANGE_SERVER = "changeServer"
    }
}
