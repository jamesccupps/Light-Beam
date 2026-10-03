package app.beam.android.data

import android.annotation.SuppressLint
import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import android.provider.Settings
import app.beam.android.core.DeviceStatus
import androidx.core.content.edit
import androidx.core.net.toUri
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import org.json.JSONArray
import org.json.JSONObject

/**
 * Everything Beam stores on the device (SharedPreferences, excluded from backups). The sign-in is sealed with a key in
 * Android's Keystore (1.7.6, [SecretBox]).
 */
class Prefs(context: Context, private val box: SecretBox = KeystoreBox()) {
    private val ctx = context.applicationContext
    private val sp = ctx.getSharedPreferences("beam", Context.MODE_PRIVATE)

    // ---------------------------------------------------------------- pairing & identity

    val baseUrl: String? get() = sp.getString(K_BASE, null)

    /**
     * The secret sent as `Authorization: Bearer`: the master key, or (API v3) this device's own token. Sealed on disk
     * (1.7.6, audit S-23); one kept in clear by an older version is sealed the first time it's read.
     */
    val key: String?
        get() {
            cachedKey?.let { return it }
            val sealed = sp.getString(K_KEY_SEALED, null)
            val key = if (sealed != null) box.open(sealed) ?: sp.getString(K_KEY, null)
            else sp.getString(K_KEY, null)?.also { plain -> sp.edit(commit = true) { putKey(plain) } }
            cachedKey = key
            return key
        }

    @Volatile private var cachedKey: String? = null

    /** Writes [key] sealed, once it opens again; where the Keystore doesn't work it's kept as before (never lost). */
    private fun SharedPreferences.Editor.putKey(key: String) {
        val sealed = box.seal(key)?.takeIf { box.open(it) == key }
        if (sealed != null) {
            putString(K_KEY_SEALED, sealed)
            remove(K_KEY)
        } else {
            putString(K_KEY, key)
            remove(K_KEY_SEALED)
        }
        cachedKey = key
    }

    val paired: Boolean get() = !baseUrl.isNullOrEmpty() && !key.isNullOrEmpty()

    /** True once the app switched from the master key to its own device token (API v3). */
    val hasDeviceToken: Boolean get() = sp.getString(K_KEY_KIND, null) == KIND_TOKEN

    /**
     * Generated once and kept forever (also across unpairing): this device's identity. An id that is
     * already stored is never changed. New installs derive it from ANDROID_ID (per signing key and device),
     * so a reinstall comes back as the same device instead of a second entry.
     */
    val deviceId: String by lazy {
        sp.getString(K_DEVICE_ID, null) ?: newDeviceId().also {
            sp.edit(commit = true) { putString(K_DEVICE_ID, it) }
        }
    }

    private fun newDeviceId(): String {
        val androidId = androidId() ?: return UUID.randomUUID().toString().replace("-", "")
        val digest = MessageDigest.getInstance("SHA-256").digest("beam-device:${ctx.packageName}:$androidId".toByteArray())
        return digest.joinToString("") { "%02x".format(it) }.take(32)
    }

    /**
     * ANDROID_ID (per signing key, user and device), or null where it's missing or the shared broken value.
     * Used on purpose, and only hashed: it lets a reinstall be recognised as the same device.
     */
    @SuppressLint("HardwareIds")
    private fun androidId(): String? {
        val id = try {
            Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID)
        } catch (_: Exception) {
            null
        }
        // 9774d56d682e549c is the value some old devices share; never derive an identity from it.
        return id?.takeIf { it.isNotBlank() && it != "9774d56d682e549c" }
    }

    /**
     * The OS user account Beam runs under (`X-Beam-Profile`, API v3): the first 16 hex digits of
     * sha256("android|" + ANDROID_ID). Stable across reinstalls, different in a work profile or for another
     * user, so the server never merges those as a "reinstall". Null when there is no usable ANDROID_ID.
     */
    val profileId: String? by lazy {
        androidId()?.let { id -> MessageDigest.getInstance("SHA-256").digest("android|$id".toByteArray()).joinToString("") { "%02x".format(it) }.take(16) }
    }

    /**
     * The id the server knows this device by, when it differs from [deviceId] (it merged this device into
     * another one; `X-Beam-You`). Null normally. [deviceId] itself never changes.
     */
    var effectiveId: String?
        get() = sp.getString(K_EFFECTIVE_ID, null)
        set(v) = sp.edit(commit = true) { putString(K_EFFECTIVE_ID, v) }

    var deviceName: String
        get() = sp.getString(K_NAME, null)?.takeIf { it.isNotBlank() } ?: defaultDeviceName(ctx)
        set(value) = sp.edit { putString(K_NAME, value.trim().take(MAX_NAME)) }

    /** The server's permanent id (from `/api/hello`), to recognise it after it moves. */
    var serverId: String?
        get() = sp.getString(K_SERVER_ID, null)
        set(v) = sp.edit(commit = true) { putString(K_SERVER_ID, v) }

    /** Points this device at a new address for the same server (the key stays the same). */
    fun moveServer(baseUrl: String) = sp.edit(commit = true) { putString(K_BASE, baseUrl) }

    /** Swaps the secret in place (the server issued this device its own token). */
    fun switchKey(key: String, deviceToken: Boolean) = sp.edit(commit = true) {
        putKey(key)
        putString(K_KEY_KIND, if (deviceToken) KIND_TOKEN else KIND_MASTER)
    }

    fun savePairing(baseUrl: String, key: String, name: String, serverId: String? = null) = sp.edit(commit = true) {
        putString(K_BASE, baseUrl)
        putKey(key)
        // API v3 sign-ins (Tailscale, password, approval, one-time links) hand out this device's own token.
        if (key.startsWith("bt_") || key.startsWith("bp_")) putString(K_KEY_KIND, KIND_TOKEN) else remove(K_KEY_KIND)
        remove(K_EFFECTIVE_ID)
        putString(K_SERVER_ID, serverId)
        putString(K_NAME, name.trim().take(MAX_NAME))
        putBoolean(K_BASELINE, false)
        remove(K_HANDLED)
        remove(K_PENDING_ACKS)
        remove(K_LAST_READ)
        remove(K_ALTERNATES)
        remove(K_SERVER_INFO)
        remove(K_ALERTS_SEEN)
        remove(K_ALERTS_SHOWN)
        remove(K_LAST_STATUS)
        remove(K_SIGNED_OUT_FROM)
    }

    /**
     * The server this device was signed out of (it answered 401), so sign-in can say so and offer the same
     * address again. Cleared by the next pairing.
     */
    var signedOutFrom: String?
        get() = sp.getString(K_SIGNED_OUT_FROM, null)
        set(v) = sp.edit(commit = true) { if (v == null) remove(K_SIGNED_OUT_FROM) else putString(K_SIGNED_OUT_FROM, v) }

    /** Forgets the server (keeps the device id, name and settings). */
    fun clearPairing() {
        sp.edit(commit = true) {
            remove(K_BASE)
            remove(K_KEY)
            remove(K_KEY_SEALED)
            remove(K_KEY_KIND)
            remove(K_EFFECTIVE_ID)
            remove(K_SERVER_ID)
            remove(K_HANDLED)
            remove(K_PENDING_ACKS)
            remove(K_LAST_READ)
            remove(K_LOCAL)
            remove(K_PENDING_DL)
            remove(K_ALTERNATES)
            remove(K_SERVER_INFO)
            remove(K_OUTBOX)
            remove(K_TRANSFERS)
            remove(K_DRAFTS)
            remove(K_ALERTS_SEEN)
            remove(K_ALERTS_SHOWN)
            remove(K_LAST_STATUS)
            putBoolean(K_BASELINE, false)
        }
        synchronized(this) {
            handled.clear()
            pendingAcks.clear()
        }
        _lastRead.value = emptyMap()
        _localFiles.value = emptyMap()
        _drafts.value = emptyMap()
        cachedKey = null
    }

    /**
     * Other addresses the same server answered on or advertised (its LAN and Tailscale addresses), tried
     * when the usual one stops answering for a long time.
     */
    var alternates: Set<String>
        get() = sp.getStringSet(K_ALTERNATES, emptySet()).orEmpty()
        set(v) = sp.edit { putStringSet(K_ALTERNATES, v.filter { it.isNotBlank() && it != baseUrl }.take(6).toSet()) }

    /** The last `/api/info` answer (JSON), shown in Settings while offline. */
    var serverInfoJson: String?
        get() = sp.getString(K_SERVER_INFO, null)
        set(v) = sp.edit { putString(K_SERVER_INFO, v) }

    // ---------------------------------------------------------------- settings

    var stayConnected: Boolean
        get() = sp.getBoolean("stayConnected", true)
        set(v) = sp.edit { putBoolean("stayConnected", v) }

    var autoCopy: Boolean
        get() = sp.getBoolean("autoCopy", false)
        set(v) = sp.edit { putBoolean("autoCopy", v) }

    var autoDownload: Boolean
        get() = sp.getBoolean("autoDownload", true)
        set(v) = sp.edit { putBoolean("autoDownload", v) }

    /** Download automatically only on unmetered networks (Wi-Fi, Ethernet). */
    var wifiOnlyDownloads: Boolean
        get() = sp.getBoolean("wifiOnlyDownloads", false)
        set(v) = sp.edit { putBoolean("wifiOnlyDownloads", v) }

    /** Largest file (MB) to download automatically; 0 = no limit. */
    var maxDownloadMb: Long
        get() = sp.getLong("maxDownloadMb", 500)
        set(v) = sp.edit { putLong("maxDownloadMb", v) }

    /** Where the Quick Settings tile sends the clipboard: null = ask, "*" = all devices, else a device id. */
    var tileTarget: String?
        get() = sp.getString("tileTarget", null)
        set(v) = sp.edit { putString("tileTarget", v) }

    // ---------------------------------------------------------------- notifications on your PCs (server 1.5)

    /** The master switch: notifications of the apps in [sharedApps] go to the PCs set to show them. Off by default. */
    var shareNotifications: Boolean
        get() = sp.getBoolean("shareNotifications", false)
        set(v) = sp.edit(commit = true) { putBoolean("shareNotifications", v) }

    /** Apps whose notifications are shared (package names). None until the user picks them. */
    var sharedApps: Set<String>
        get() = sp.getStringSet("sharedApps", emptySet()).orEmpty()
        set(v) = sp.edit { putStringSet("sharedApps", v) }

    /** Apps seen notifying lately (package → when), so the app list shows them first. No content. */
    var recentNotifiers: Map<String, Long>
        get() = loadLongMap("recentNotifiers")
        set(v) = sp.edit { putString("recentNotifiers", JSONObject(v as Map<*, *>).toString()) }

    /**
     * The first setup ("Show on") was confirmed, for the server paired now: on another server sharing stays off
     * until the user confirms it there.
     */
    var phoneSetupDone: Boolean
        get() = sp.getString("phoneSetupServer", null).let { it != null && it == (serverId ?: baseUrl) }
        set(v) = sp.edit { if (v) putString("phoneSetupServer", serverId ?: baseUrl) else remove("phoneSetupServer") }

    /** Sharing was switched off but the server didn't hear yet (offline): it's told at the next connect. */
    var phoneRemovalPending: Boolean
        get() = sp.getBoolean("phoneRemovalPending", false)
        set(v) = sp.edit { putBoolean("phoneRemovalPending", v) }

    /**
     * Notifications on your PCs: the posted time of the newest one this server took (a timestamp only, no content).
     * After a restart, what was posted until then counts as on the PCs already; anything newer pops up there.
     */
    var phoneSyncedAt: Long
        get() = sp.getLong("phoneSyncedAt", 0L)
        set(v) = sp.edit { putLong("phoneSyncedAt", v) }

    /**
     * Remote control: the viewer pages' own sign-ins not revoked yet ("<server> <token>"): the open viewer's, and any a
     * crash or a lost network left, revoked at the next chance (so none stays valid for good).
     */
    var remotePageTokens: Set<String>
        get() = sp.getStringSet("remotePageTokens", null)?.toSet().orEmpty()
        set(v) = sp.edit { if (v.isEmpty()) remove("remotePageTokens") else putStringSet("remotePageTokens", HashSet(v)) }

    /** The viewer page has run in this phone's WebView (so there may be something to forget there). */
    var remoteUsed: Boolean
        get() = sp.getBoolean("remoteUsed", false)
        set(v) = sp.edit { putBoolean("remoteUsed", v) }

    /** Devices whose items don't make a sound or pop up (they still arrive and count as unread). */
    var mutedDevices: Set<String>
        get() = sp.getStringSet("mutedDevices", emptySet()).orEmpty()
        set(v) = sp.edit { putStringSet("mutedDevices", v) }

    /** Devices whose texts always go straight to the clipboard, even with auto-copy off. */
    var autoCopyDevices: Set<String>
        get() = sp.getStringSet("autoCopyDevices", emptySet()).orEmpty()
        set(v) = sp.edit { putStringSet("autoCopyDevices", v) }

    var lastUpdateCheck: Long
        get() = sp.getLong("lastUpdateCheck", 0)
        set(v) = sp.edit { putLong("lastUpdateCheck", v) }

    /** The newest update we've already notified about (so it isn't announced every 6 hours). */
    var notifiedUpdateCode: Int
        get() = sp.getInt("notifiedUpdateCode", 0)
        set(v) = sp.edit { putInt("notifiedUpdateCode", v) }

    /** The last update that didn't install and why (`{ versionCode, version, message }`), until a newer Beam runs. */
    var updateProblem: String?
        get() = sp.getString("updateProblem", null)
        set(v) = sp.edit { if (v == null) remove("updateProblem") else putString("updateProblem", v) }

    var askedForNotifications: Boolean
        get() = sp.getBoolean("askedNotifications", false)
        set(v) = sp.edit { putBoolean("askedNotifications", v) }

    // ---------------------------------------------------------------- the settings' backup on the server (1.8.2)

    /** This install of Beam (made up once; a reinstall gets a new one): which backup on the server is this one's. */
    val installId: String
        @Synchronized get() = sp.getString(K_INSTALL_ID, null) ?: UUID.randomUUID().toString().replace("-", "").also {
            sp.edit(commit = true) { putString(K_INSTALL_ID, it) }
        }

    /** The offer to put back an earlier install's settings was answered (or there was none): this one's go up now. */
    var restoreChecked: Boolean
        get() = sp.getBoolean(K_RESTORE_CHECKED, false)
        set(v) = sp.edit(commit = true) { putBoolean(K_RESTORE_CHECKED, v) }

    /** What the server took last ("<server> <sha-256 of the settings>"), so unchanged settings aren't sent again. */
    var backupSent: String?
        get() = sp.getString(K_BACKUP_SENT, null)
        set(v) = sp.edit { if (v == null) remove(K_BACKUP_SENT) else putString(K_BACKUP_SENT, v) }

    // (Android keeps only a weak reference to it.)
    private var settingsWatcher: SharedPreferences.OnSharedPreferenceChangeListener? = null

    /** [onChange] runs (on the main thread) whenever a setting that a backup holds changes, from anywhere. */
    fun watchSettings(onChange: () -> Unit) {
        settingsWatcher?.let(sp::unregisterOnSharedPreferenceChangeListener)
        val watcher = SharedPreferences.OnSharedPreferenceChangeListener { _, key -> if (key in BACKED_UP) onChange() }
        settingsWatcher = watcher
        sp.registerOnSharedPreferenceChangeListener(watcher)
    }

    /** The last status report the server accepted, so an unchanged phone doesn't report again after a restart. */
    var lastStatus: DeviceStatus?
        get() = sp.getString(K_LAST_STATUS, null)?.let { runCatching { DeviceStatus.parse(JSONObject(it)) }.getOrNull() }
        set(v) = sp.edit { if (v == null) remove(K_LAST_STATUS) else putString(K_LAST_STATUS, v.toJson().toString()) }

    /** When this server's alert history was first looked at (0: not yet; older alerts aren't shown then). */
    var alertsSeenUntil: Long
        get() = sp.getLong(K_ALERTS_SEEN, 0L)
        set(v) = sp.edit { putLong(K_ALERTS_SEEN, v) }

    /** Remembers a server alert as shown (the last 100). False if it was shown before. */
    @Synchronized
    fun markAlertShown(id: String): Boolean {
        val shown = LinkedHashSet(split(sp.getString(K_ALERTS_SHOWN, "")))
        if (!shown.add(id)) return false
        while (shown.size > 100) shown.remove(shown.first())
        sp.edit { putString(K_ALERTS_SHOWN, shown.joinToString(",")) }
        return true
    }

    /** Set once the first sync after pairing marked older items as already handled. */
    var baselineDone: Boolean
        get() = sp.getBoolean(K_BASELINE, false)
        set(v) = sp.edit { putBoolean(K_BASELINE, v) }

    // ---------------------------------------------------------------- handled items (capped)

    private val handled: LinkedHashSet<String> by lazy { LinkedHashSet(split(sp.getString(K_HANDLED, ""))) }
    private val pendingAcks: LinkedHashSet<String> by lazy { LinkedHashSet(split(sp.getString(K_PENDING_ACKS, ""))) }

    @Synchronized
    fun isHandled(id: String) = id in handled

    @Synchronized
    fun markHandled(ids: Collection<String>) {
        if (ids.isEmpty()) return
        handled.addAll(ids)
        val it = handled.iterator()
        while (handled.size > MAX_HANDLED && it.hasNext()) {
            it.next()
            it.remove()
        }
        sp.edit { putString(K_HANDLED, handled.joinToString(",")) }
    }

    @Synchronized
    fun addPendingAck(id: String) {
        pendingAcks += id
        while (pendingAcks.size > 200) pendingAcks.remove(pendingAcks.first())
        sp.edit { putString(K_PENDING_ACKS, pendingAcks.joinToString(",")) }
    }

    @Synchronized
    fun removePendingAck(id: String) {
        if (pendingAcks.remove(id)) sp.edit { putString(K_PENDING_ACKS, pendingAcks.joinToString(",")) }
    }

    @Synchronized
    fun pendingAcks(): List<String> = pendingAcks.toList()

    // ---------------------------------------------------------------- read state per conversation

    private val _lastRead = MutableStateFlow(loadLongMap(K_LAST_READ))
    val lastRead: StateFlow<Map<String, Long>> = _lastRead

    /** Remembers [ts] (a server timestamp) as the newest item seen in conversation [key]. Returns true if it moved on. */
    fun markRead(key: String, ts: Long): Boolean {
        if (ts <= (_lastRead.value[key] ?: 0L)) return false
        _lastRead.update { it + (key to maxOf(ts, it[key] ?: 0L)) }
        sp.edit { putString(K_LAST_READ, JSONObject(_lastRead.value as Map<*, *>).toString()) }
        return true
    }

    fun markAllRead(values: Map<String, Long>) {
        _lastRead.update { old -> old + values.filter { (k, v) -> v > (old[k] ?: 0L) } }
        sp.edit { putString(K_LAST_READ, JSONObject(_lastRead.value as Map<*, *>).toString()) }
    }

    // ---------------------------------------------------------------- drafts

    private val _drafts = MutableStateFlow(loadStringMap(K_DRAFTS))

    /** Unsent text per conversation. */
    val drafts: StateFlow<Map<String, String>> = _drafts

    fun setDraft(conversation: String, text: String) {
        val clean = text.takeIf { it.isNotBlank() }
        if (_drafts.value[conversation] == clean) return
        _drafts.update { if (clean == null) it - conversation else it + (conversation to clean) }
        sp.edit { putString(K_DRAFTS, JSONObject(_drafts.value as Map<*, *>).toString()) }
    }

    // ---------------------------------------------------------------- downloaded files

    private val _localFiles = MutableStateFlow(loadStringMap(K_LOCAL))

    /** Item id → content Uri of the saved copy in Downloads/Beam. */
    val localFiles: StateFlow<Map<String, String>> = _localFiles

    fun localFile(itemId: String): Uri? = _localFiles.value[itemId]?.toUri()

    fun setLocalFile(itemId: String, uri: Uri?) {
        _localFiles.update { old ->
            val m = LinkedHashMap(old)
            if (uri == null) m.remove(itemId) else m[itemId] = uri.toString()
            while (m.size > 1000) m.remove(m.keys.first())
            m
        }
        sp.edit { putString(K_LOCAL, JSONObject(_localFiles.value as Map<*, *>).toString()) }
    }

    /** Unfinished downloads (item id → pending MediaStore Uri), so they can resume after a restart. */
    fun pendingDownload(itemId: String): Uri? = loadStringMap(K_PENDING_DL)[itemId]?.toUri()

    @Synchronized
    fun setPendingDownload(itemId: String, uri: Uri?) {
        val m = LinkedHashMap(loadStringMap(K_PENDING_DL))
        if (uri == null) m.remove(itemId) else m[itemId] = uri.toString()
        while (m.size > 50) m.remove(m.keys.first())
        sp.edit { putString(K_PENDING_DL, JSONObject(m as Map<*, *>).toString()) }
    }

    // ---------------------------------------------------------------- persisted queues (outbox, transfers)

    fun loadArray(key: String): JSONArray = try {
        JSONArray(sp.getString(key, null) ?: "[]")
    } catch (_: Exception) {
        JSONArray()
    }

    fun saveArray(key: String, a: JSONArray) = sp.edit { putString(key, a.toString()) }

    // ---------------------------------------------------------------- helpers

    private fun split(s: String?) = s.orEmpty().split(',').filter { it.isNotEmpty() }

    private fun loadLongMap(key: String): Map<String, Long> = try {
        val o = JSONObject(sp.getString(key, null) ?: "{}")
        o.keys().asSequence().associateWith { o.optLong(it) }
    } catch (_: Exception) {
        emptyMap()
    }

    private fun loadStringMap(key: String): Map<String, String> = try {
        val o = JSONObject(sp.getString(key, null) ?: "{}")
        val m = LinkedHashMap<String, String>()
        for (k in o.keys()) m[k] = o.optString(k)
        m
    } catch (_: Exception) {
        emptyMap()
    }

    companion object {
        const val MAX_NAME = 40 // the server cuts names to 40 characters
        private const val MAX_HANDLED = 2000
        private const val K_BASE = "baseUrl"
        private const val K_KEY = "key"
        private const val K_KEY_SEALED = "keySealed"
        private const val K_KEY_KIND = "keyKind"
        private const val KIND_MASTER = "master"
        private const val KIND_TOKEN = "token"
        private const val K_SERVER_ID = "serverId"
        private const val K_DEVICE_ID = "deviceId"
        private const val K_EFFECTIVE_ID = "effectiveId"
        private const val K_NAME = "deviceName"
        private const val K_BASELINE = "baselineDone"
        private const val K_HANDLED = "handled"
        private const val K_PENDING_ACKS = "pendingAcks"
        private const val K_LAST_READ = "lastRead"
        private const val K_LOCAL = "localFiles"
        private const val K_PENDING_DL = "pendingDownloads"
        private const val K_ALTERNATES = "alternates"
        private const val K_SERVER_INFO = "serverInfo"
        private const val K_DRAFTS = "drafts"
        private const val K_ALERTS_SEEN = "alertsSeenUntil"
        private const val K_ALERTS_SHOWN = "alertsShown"
        private const val K_LAST_STATUS = "lastStatus"
        private const val K_SIGNED_OUT_FROM = "signedOutFrom"
        private const val K_INSTALL_ID = "installId"
        private const val K_RESTORE_CHECKED = "restoreChecked"
        private const val K_BACKUP_SENT = "backupSent"
        const val K_OUTBOX = "outbox"
        const val K_TRANSFERS = "transfers"

        /** The settings a backup holds ([SettingsBackups]): never the sign-in, the ids or what's only this phone's. */
        val BACKED_UP = setOf(
            K_NAME, "stayConnected", "autoCopy", "autoDownload", "wifiOnlyDownloads", "maxDownloadMb", "tileTarget",
            "mutedDevices", "autoCopyDevices", "shareNotifications", "sharedApps",
        )

        fun defaultDeviceName(ctx: Context): String {
            val name = try {
                Settings.Global.getString(ctx.contentResolver, Settings.Global.DEVICE_NAME)
            } catch (_: Exception) {
                null
            }
            return (name?.takeIf { it.isNotBlank() } ?: Build.MODEL ?: "Android").trim().take(MAX_NAME)
        }
    }
}
