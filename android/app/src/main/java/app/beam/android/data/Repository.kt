package app.beam.android.data

import app.beam.android.BeamApp
import app.beam.android.core.BeamException
import app.beam.android.core.Conversations
import app.beam.android.core.Device
import app.beam.android.core.Item
import app.beam.android.core.ItemsPage
import app.beam.android.core.ServerInfo
import app.beam.android.core.longs
import app.beam.android.core.strings
import app.beam.android.core.str
import app.beam.android.notify.Notifier
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.File

/**
 * In-memory copy of the server's devices and items, kept current by the event stream and saved to disk,
 * so Beam opens instantly with the last known history and stays readable (and searchable) offline.
 */
class Repository(private val app: BeamApp) {
    enum class Conn { IDLE, CONNECTING, CONNECTED, OFFLINE, AUTH_FAILED }

    /** Why the server can't be reached right now (shown in the offline banner). */
    enum class Offline { NO_NETWORK, TAILSCALE_OFF, UNREACHABLE }

    data class State(
        val me: String,
        val devices: List<Device> = emptyList(),
        val items: List<Item> = emptyList(),
        /** There is something to show: from the server, or the copy saved on the device. */
        val loaded: Boolean = false,
        /** The data came from the server during this run (not only from the saved copy). */
        val fresh: Boolean = false,
        val conn: Conn = Conn.IDLE,
        val offline: Offline? = null,
        /** When the current offline stretch began (0 while connected). */
        val offlineSince: Long = 0,
        val info: ServerInfo? = null,
        /** Files other devices are sending right now (API v3 `upload` events), by upload id. */
        val incoming: Map<String, Incoming> = emptyMap(),
        /**
         * The server's cursor for [items] (server 1.4 `items-since`): after a reconnect only what changed since
         * then is fetched. Set together with the items it describes, and saved with them. Null: fetch everything.
         */
        val cursor: String? = null,
    ) {
        val devicesById: Map<String, Device> by lazy { devices.associateBy { it.id } }
        fun item(id: String) = items.firstOrNull { it.id == id }
    }

    /** A file on its way from another device ("incoming 35%"); becomes an item when it's complete. */
    data class Incoming(val id: String, val name: String, val size: Long, val offset: Long, val mime: String?,
        val from: String?, val device: String, val to: List<String>, val ts: Long) {
        /** As an item, for placing it in conversations. */
        fun asItem() = Item(id, "file", null, false, 0, name, size, mime, from, device, to, emptyMap(), ts)
    }

    private val cacheFile get() = File(app.filesDir, "state.json")
    private val _state = MutableStateFlow(State(app.prefs.effectiveId ?: app.prefs.deviceId))
    val state: StateFlow<State> = _state
    private var saveJob: Job? = null

    /** Guards the saved copy's file (the rename into place, and deleting it); a save never waits on a clear. */
    private val saving = Any()

    /** Saves run one at a time. */
    private val writing = Any()

    /** Bumped by [clear]: a save that began before it is thrown away instead of putting the old copy back. */
    @Volatile private var generation = 0

    /**
     * Refreshes may overlap (one can hang on a dead connection for a minute; it mustn't hold up the next), but they
     * land in order: an answer to an older request than one already applied is thrown away, as is one for an
     * earlier pairing.
     */
    private val refreshing = Any()
    private val refreshes = java.util.concurrent.atomic.AtomicLong()
    private var landed = 0L

    /** This device's id as the server knows it (normally the stored id; see [Prefs.effectiveId]). */
    val me: String get() = app.prefs.effectiveId ?: app.prefs.deviceId

    init {
        loadCache()
    }

    fun setConn(conn: Conn, offline: Offline? = null) = _state.update {
        val since = when {
            conn == Conn.OFFLINE && it.offlineSince == 0L -> System.currentTimeMillis()
            conn == Conn.OFFLINE -> it.offlineSince
            conn == Conn.CONNECTING -> it.offlineSince
            else -> 0L
        }
        val reason = if (conn == Conn.OFFLINE) offline ?: it.offline else if (conn == Conn.CONNECTING) it.offline else null
        if (it.conn == conn && it.offline == reason && it.offlineSince == since) it else it.copy(conn = conn, offline = reason, offlineSince = since)
    }

    fun setInfo(info: ServerInfo) = _state.update { it.copy(info = info) }

    /** Forgets everything held here, and the saved copy. Cheap: never waits for a save in progress. */
    fun clear() {
        synchronized(saving) {
            generation++
            _state.update { State(me, conn = it.conn) }
            saveJob?.cancel()
            cacheFile.delete()
        }
    }

    /** Counts `devices` events, so a slow refresh doesn't put back an older device list over a newer one. */
    @Volatile private var devicesEvents = 0

    /**
     * Fetches devices and items (only the changes, when the server can). Blocking; throws on failure. [full]: all
     * of them. Overlapping refreshes land in the order they were asked for (see [refreshing]). Called on the
     * stream's thread after a connect (no events are read meanwhile); from anywhere else use [resyncBlocking],
     * which also catches what arrived while it fetched.
     */
    fun refreshBlocking(full: Boolean = false) {
        val api = app.api ?: return
        val request = refreshes.incrementAndGet()
        val seen = devicesEvents
        val devices = api.devices()
        val start = _state.value
        val since = start.cursor.takeIf { !full && start.loaded && start.info?.lists("items-since") == true }
        val page = api.itemsPage(since)
        var gone: List<String> = emptyList()
        synchronized(refreshing) {
            if (request < landed || app.api !== api) return // a newer answer already landed, or this is another pairing
            landed = request
            devices.you?.let(::adoptYou)
            _state.update {
                // A `devices` event arrived while this was fetching (the items can take a while): it's newer.
                val list = if (devicesEvents != seen) it.devices else devices.devices
                val items = if (since != null && page.delta) {
                    val held = it.items.mapTo(HashSet()) { i -> i.id }
                    gone = page.deleted.filter { id -> id in held } // a delta's `deleted` can name thousands never seen here
                    applyDelta(it.items, page)
                } else {
                    page.items
                }
                it.copy(me = me, devices = list, items = items, cursor = page.cursor, loaded = true, fresh = true)
            }
        }
        if (gone.isNotEmpty()) Notifier.itemsDeleted(app, gone)
        saveSoon()
    }

    /**
     * [refreshBlocking] from off the stream's thread: events kept arriving while the answer was on its way, and
     * the older answer just replaced what they brought (a new message, a delete). So, right away, what changed
     * since the answer's own cursor (server 1.4 `items-since`; a small delta).
     */
    fun resyncBlocking(full: Boolean = false) {
        refreshBlocking(full)
        if (_state.value.info?.lists("items-since") == true && _state.value.cursor != null) refreshBlocking()
    }

    /** The items held here plus a delta: changed and new ones replace theirs, deleted ones go. Newest first. */
    private fun applyDelta(current: List<Item>, page: ItemsPage): List<Item> {
        val gone = page.deleted.toHashSet()
        val changed = page.items.associateBy { it.id }
        return (current.filter { it.id !in gone && it.id !in changed } + page.items).sortedByDescending { it.ts }
    }

    /**
     * The server knows this device by another id (after a merge on the server): see things from that id.
     * The stored device id itself never changes; requests keep sending it and the server maps it.
     */
    fun adoptYou(you: String) {
        val adopted = you.takeIf { it != app.prefs.deviceId }
        if (app.prefs.effectiveId == adopted) return
        app.prefs.effectiveId = adopted
        _state.update { it.copy(me = me) }
    }

    /** Refreshes in the background; returns the error, if any. [full]: the whole list, not only the changes. */
    suspend fun refresh(full: Boolean = false): Throwable? = withContext(Dispatchers.IO) {
        try {
            resyncBlocking(full)
            if (_state.value.conn == Conn.AUTH_FAILED) setConn(Conn.CONNECTING)
            null
        } catch (e: Exception) {
            if (e is BeamException && e.status == 401 && app.prefs.paired) setConn(Conn.AUTH_FAILED)
            e
        }
    }

    /** Applies one server-sent event. Returns the item for `item` events. */
    fun onEvent(type: String, data: String): Item? {
        val o = try {
            JSONObject(data)
        } catch (_: JSONException) {
            return null
        }
        when (type) {
            "item" -> {
                val item = Item.parse(o)
                if (item.id.isNotEmpty()) {
                    if (item.id in _state.value.incoming) _state.update { it.copy(incoming = it.incoming - item.id) }
                    upsert(item)
                }
                return item
            }
            "delete" -> {
                val id = o.optString("id")
                val held = _state.value.item(id) != null
                remove(id)
                if (held) Notifier.itemDeleted(app, id)
            }
            "update" -> {
                val id = o.optString("id")
                val delivered = if (o.has("delivered")) o.optJSONObject("delivered").longs() else null
                val pinned = if (o.has("pinned")) o.optBoolean("pinned") else null
                val thumb = if (o.has("thumb")) o.optBoolean("thumb") else null
                _state.update { s ->
                    s.copy(items = s.items.map {
                        if (it.id != id) it else it.copy(delivered = delivered ?: it.delivered, pinned = pinned ?: it.pinned, thumb = thumb ?: it.thumb)
                    })
                }
                saveSoon()
            }
            // API v3: another device is sending a file ("incoming 35%"), until the item arrives.
            "upload" -> {
                val id = o.optString("id").ifEmpty { return null }
                // The server sends every stream the upload events, the sender's too: this phone's own upload is
                // "Sending…", never "Arriving…" (like the web app).
                val from = o.str("from")
                if (from != null && (from == me || from == app.prefs.deviceId)) return null
                val inc = Incoming(
                    id, o.optString("name", "file"), o.optLong("size"), o.optLong("offset"), o.str("mime"), o.str("from"),
                    o.str("device") ?: "", o.optJSONArray("to").strings(), _state.value.incoming[id]?.ts ?: System.currentTimeMillis(),
                )
                _state.update { it.copy(incoming = it.incoming + (id to inc)) }
            }
            "upload-done", "upload-cancelled" -> {
                val id = o.optString("id")
                _state.update { it.copy(incoming = it.incoming - id) }
                if (type == "upload-cancelled") app.transfers.cancelDownload(id)
            }
            "devices" -> {
                devicesEvents++
                val list = Device.parseList(o.optJSONArray("devices"))
                val before = _state.value.devices
                _state.update { it.copy(devices = list) }
                // The saved copy needs the devices (names, share targets), not every battery, status or presence
                // change of theirs (other devices report those often; the next connect brings them fresh). The
                // server sorts by last seen, so every report reorders the list: compare without the order.
                fun names(l: List<Device>) = l.mapTo(HashSet()) { Triple(it.id, it.name, it.platform) }
                if (names(list) != names(before)) saveSoon()
            }
            // Devices were linked (a browser merged into an app on the same machine): item senders and
            // targets were rewritten, so fetch everything again.
            // (Devices were merged: every sender may have changed, so the whole list, not a delta.)
            "refresh" -> app.scope.launch { refresh(full = true) }
            // API v3: read markers of this device (e.g. read in a browser tab linked to it).
            "read" -> {
                val device = o.str("device")
                val conversation = o.str("conversation") ?: return null
                if (device == null || device == me) app.readMarkers.onRemoteRead(conversation, o.optLong("ts"))
            }
            // API v3: the server announced its new address before answering 410.
            "moved" -> o.str("movedTo")?.let { app.moves.onMoved(it) }
            // Server 1.3: "ring this device" (only the device it's for rings) and alerts.
            "ring" -> app.ringer.onEvent(o)
            "alert" -> app.alerts.onEvent(o)
        }
        return null
    }

    fun upsert(item: Item) {
        _state.update { s ->
            val existing = s.items.indexOfFirst { it.id == item.id }
            val items = if (existing >= 0) {
                s.items.toMutableList().also { it[existing] = item }
            } else {
                (s.items + item).sortedByDescending { it.ts }
            }
            s.copy(items = items, loaded = true)
        }
        saveSoon()
    }

    fun remove(id: String) {
        _state.update { s -> s.copy(items = s.items.filterNot { it.id == id }) }
        saveSoon()
    }

    fun removeAll(ids: Collection<String>) {
        val set = ids.toSet()
        _state.update { s -> s.copy(items = s.items.filterNot { it.id in set }) }
        saveSoon()
    }

    // ---------------------------------------------------------------- actions

    /** Sends a text right now (the [Outbox] wraps this with queueing while offline). */
    suspend fun sendText(text: String, to: List<String>): Item = withContext(Dispatchers.IO) { sendTextBlocking(text, to) }

    fun sendTextBlocking(text: String, to: List<String>): Item {
        val api = app.api ?: throw IllegalStateException("Not paired")
        val item = try {
            api.sendText(text, to)
        } catch (e: BeamException) {
            // A target that was forgotten on the server: refresh the device list so it disappears.
            if (e.status == 400) runCatching { resyncBlocking() }
            throw e
        }
        upsert(item)
        return item
    }

    suspend fun delete(id: String) = withContext(Dispatchers.IO) {
        try {
            app.api?.deleteItem(id)
        } catch (e: BeamException) {
            if (e.status != 404) throw e
        }
        remove(id)
        Notifier.itemDeleted(app, id)
    }

    /** Deletes several items at once (`POST /api/items/delete`, or one by one on older servers). */
    suspend fun deleteAll(ids: List<String>): Int = withContext(Dispatchers.IO) {
        val api = app.api ?: throw IllegalStateException("Not paired")
        if (ids.isEmpty()) return@withContext 0
        val count = if (_state.value.info?.has("bulk-delete") == true) {
            api.deleteItems(ids)
        } else {
            var n = 0
            for (id in ids) {
                try {
                    api.deleteItem(id)
                    n++
                } catch (e: BeamException) {
                    if (e.status != 404) throw e
                }
            }
            n
        }
        removeAll(ids)
        ids.forEach { Notifier.itemDeleted(app, it) }
        count
    }

    /**
     * Sends [item] on to [to]: the server copies it (API v3, no re-upload). Older servers can only
     * forward text, which is simply sent again.
     */
    suspend fun forward(item: Item, to: List<String>): Item = withContext(Dispatchers.IO) {
        val api = app.api ?: throw IllegalStateException("Not paired")
        val forwarded = if (_state.value.info?.has("forward") == true) {
            api.forward(item.id, to)
        } else if (item.isText) {
            api.sendText(fullTextBlocking(item), to)
        } else {
            throw IllegalStateException("Update your Beam server to forward files.")
        }
        upsert(forwarded)
        forwarded
    }

    suspend fun setPinned(item: Item, pinned: Boolean) = withContext(Dispatchers.IO) {
        val api = app.api ?: throw IllegalStateException("Not paired")
        api.setPinned(item.id, pinned)
        _state.update { s -> s.copy(items = s.items.map { if (it.id == item.id) it.copy(pinned = pinned) else it }) }
        saveSoon()
    }

    /** A fast link for a file (server 1.13 `fast-links`) → its address and when it stops working. */
    suspend fun fastLink(item: Item, hours: Int): Pair<String, Long> = withContext(Dispatchers.IO) {
        val api = app.api ?: throw IllegalStateException("Not paired")
        val link = api.fastLink(item.id, hours)
        link.getString("url") to link.optLong("expires")
    }

    /** The whole text of an item (lists and events cut long texts short). */
    suspend fun fullText(item: Item): String = withContext(Dispatchers.IO) { fullTextBlocking(item) }

    private fun fullTextBlocking(item: Item): String =
        if (item.truncated) app.api?.itemText(item.id) ?: item.text.orEmpty() else item.text.orEmpty()

    /**
     * Items whose text or file name contains every word of [query] (case-insensitive), newest first.
     * Long texts are searched in the part kept on the device.
     */
    fun search(query: String, limit: Int = 200): List<Item> {
        val words = query.trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (words.isEmpty()) return emptyList()
        val s = _state.value
        val devices = s.devicesById
        return s.items.asSequence().filter { item ->
            if (Conversations.keysOf(item, s.me, devices).isEmpty()) return@filter false
            val hay = (item.text ?: item.name ?: "").lowercase()
            words.all { it in hay }
        }.take(limit).toList()
    }

    // ---------------------------------------------------------------- the copy on disk

    private fun loadCache() {
        if (!app.prefs.paired) return
        try {
            val f = cacheFile
            if (!f.isFile || f.length() > 32L * 1024 * 1024) return
            val o = JSONObject(f.readText())
            // Only a copy of this server's data, made for this device.
            if (o.optString("me") != me || o.optString("server") != (app.prefs.serverId ?: app.prefs.baseUrl)) return
            val devices = Device.parseList(o.optJSONArray("devices"))
            val items = Item.parseList(o.optJSONArray("items"))
            val info = o.optJSONObject("info")?.let(ServerInfo::parse)
            _state.update { it.copy(devices = devices, items = items, loaded = true, info = info, cursor = o.str("cursor")) }
        } catch (_: Exception) {
            cacheFile.delete()
        }
    }

    /** Saves a copy shortly after changes settle (on a background thread). */
    fun saveSoon() {
        if (!app.prefs.paired) return
        saveJob?.cancel()
        saveJob = app.scope.launch(Dispatchers.IO) {
            delay(1500)
            saveNow()
        }
    }

    /** How often the saved copy was written (tests: idle cost). */
    val cacheWrites = java.util.concurrent.atomic.AtomicLong()

    fun saveNow() {
        synchronized(writing) {
            val gen = generation
            val s = _state.value // items and their cursor: one snapshot
            if (!s.loaded || !app.prefs.paired) return
            cacheWrites.incrementAndGet()
            val tmp = File(cacheFile.path + ".tmp")
            try {
                val o = JSONObject()
                    .put("version", 1)
                    .put("me", s.me)
                    .put("server", app.prefs.serverId ?: app.prefs.baseUrl)
                    .put("savedAt", System.currentTimeMillis())
                    .put("cursor", s.cursor)
                    .put("devices", JSONArray().apply { s.devices.forEach { put(it.toJson()) } })
                    .put("items", JSONArray().apply { s.items.forEach { put(it.toJson()) } })
                app.prefs.serverInfoJson?.let { o.put("info", JSONObject(it)) }
                tmp.writeText(o.toString())
                synchronized(saving) {
                    // Signed out or unpaired while this was written: the old copy must not come back.
                    if (gen != generation || !app.prefs.paired) {
                        tmp.delete()
                        return
                    }
                    if (!tmp.renameTo(cacheFile)) {
                        cacheFile.delete()
                        tmp.renameTo(cacheFile)
                    }
                }
            } catch (_: Exception) {
                tmp.delete()
            }
        }
    }

    companion object {
        /** The server names the All devices conversation "all"; the app calls it [Conversations.ALL]. */
        fun serverConversation(key: String) = if (key == Conversations.ALL) "all" else key
        fun appConversation(key: String) = if (key == "all") Conversations.ALL else key
    }
}
