package app.beam.android.core

import org.json.JSONArray
import org.json.JSONObject

/** A device registered on the Beam server (see docs/API.md, "Device"). */
data class Device(
    val id: String,
    val name: String,
    val platform: String,
    val online: Boolean,
    val lastSeen: Long,
    /** What the device last reported about itself (server 1.3): battery, storage, OS. */
    val status: DeviceStatus? = null,
    /** What can be done with it from here (server 1.3): ring it, wake it, open Remote Desktop; control it (1.6). */
    val can: DeviceCan = DeviceCan(),
    /** Its Tailscale MagicDNS name or address (server 1.3), for Remote Desktop. */
    val tailscaleDns: String? = null,
    /** The Beam version it runs, when the server knows it. */
    val appVersion: String? = null,
    /** It shows the phone's notifications (server 1.5 `phone-notifications`; `settings.phoneNotifications`). */
    val phoneNotifications: Boolean = false,
    /** When its Beam app last backed up its settings there (server 1.8.1 `backups`), or null. */
    val backupAt: Long? = null,
) {
    fun toJson(): JSONObject = JSONObject().put("id", id).put("name", name).put("platform", platform)
        .put("online", online).put("lastSeen", lastSeen)
        .apply {
            status?.let { put("status", it.toCacheJson()) }
            put("can", can.toJson())
            tailscaleDns?.let { put("tailscale", JSONObject().put("dns", it)) }
            appVersion?.let { put("appVersion", it) }
            if (phoneNotifications) put("settings", JSONObject().put("phoneNotifications", true))
            backupAt?.let { put("backup", JSONObject().put("at", it)) }
        }

    companion object {
        fun parse(o: JSONObject) = Device(
            id = o.optString("id"),
            name = o.str("name")?.takeIf { it.isNotBlank() } ?: "Unknown device",
            platform = o.str("platform") ?: "web",
            online = o.optBoolean("online"),
            lastSeen = o.optLong("lastSeen"),
            status = DeviceStatus.parse(o.optJSONObject("status")),
            can = DeviceCan.parse(o.optJSONObject("can")),
            // Its MagicDNS name, else its Tailscale address (what a Remote Desktop app can connect to).
            tailscaleDns = o.optJSONObject("tailscale")?.let { t -> t.str("dns") ?: t.str("ip") }?.trim()?.trimEnd('.')?.takeIf { it.isNotEmpty() },
            appVersion = o.str("appVersion") ?: o.str("version"),
            phoneNotifications = o.optJSONObject("settings")?.optBoolean("phoneNotifications") == true,
            backupAt = o.optJSONObject("backup")?.optLong("at")?.takeIf { it > 0 },
        )

        fun parseList(a: JSONArray?): List<Device> =
            if (a == null) emptyList() else (0 until a.length()).mapNotNull { a.optJSONObject(it)?.let(::parse) }
    }
}

/** A device's own report (`PUT /api/devices/me/status`; `status` in `GET /api/devices`). Every part optional. */
data class DeviceStatus(
    /** 0–100. */
    val batteryLevel: Int? = null,
    val charging: Boolean? = null,
    val storageFree: Long? = null,
    val storageTotal: Long? = null,
    /** E.g. "Android 16 · Pixel 9 Pro XL" or "Windows 11 Pro 24H2". */
    val os: String? = null,
    /** When the server received it (0 when sending). */
    val at: Long = 0,
    /** A PC's "Allow remote control" switch (server 1.6; only PCs report it, never this phone). */
    val remoteControl: Boolean? = null,
    /** A PC whose desktop is locked or signed out (server 1.6): Remote Desktop, not remote control. */
    val locked: Boolean? = null,
) {
    /** The request body for `PUT /api/devices/me/status`. */
    fun toJson(): JSONObject = JSONObject().apply {
        if (batteryLevel != null) {
            put("battery", JSONObject().put("level", batteryLevel).apply { if (charging != null) put("charging", charging) })
        }
        if (storageFree != null && storageTotal != null) put("storage", JSONObject().put("free", storageFree).put("total", storageTotal))
        if (os != null) put("os", os)
    }

    /** Stored in the device list cache: the same, plus when it was reported and a PC's remote-control state. */
    fun toCacheJson(): JSONObject = toJson().put("at", at).apply {
        if (remoteControl != null) put("remoteControl", remoteControl)
        if (locked != null) put("locked", locked)
    }

    companion object {
        fun parse(o: JSONObject?): DeviceStatus? {
            if (o == null) return null
            val battery = o.optJSONObject("battery")
            val storage = o.optJSONObject("storage")
            return DeviceStatus(
                batteryLevel = battery?.takeIf { it.has("level") }?.optInt("level")?.coerceIn(0, 100),
                charging = battery?.takeIf { it.has("charging") }?.optBoolean("charging"),
                storageFree = storage?.takeIf { it.has("free") }?.optLong("free"),
                storageTotal = storage?.takeIf { it.has("total") }?.optLong("total"),
                os = o.str("os")?.takeIf { it.isNotBlank() },
                at = o.optLong("at"),
                remoteControl = o.opt("remoteControl") as? Boolean,
                locked = o.opt("locked") as? Boolean,
            )
        }
    }
}

/** `can` in `GET /api/devices` (server 1.3; `remoteControl` 1.6: a Windows PC with Beam 1.6+, its switch on, unlocked). */
data class DeviceCan(val ring: Boolean = false, val wake: Boolean = false, val remoteDesktop: Boolean = false, val remoteControl: Boolean = false) {
    fun toJson(): JSONObject = JSONObject().put("ring", ring).put("wake", wake).put("remoteDesktop", remoteDesktop).put("remoteControl", remoteControl)

    companion object {
        fun parse(o: JSONObject?) = if (o == null) {
            DeviceCan()
        } else {
            DeviceCan(o.optBoolean("ring"), o.optBoolean("wake"), o.optBoolean("remoteDesktop"), o.optBoolean("remoteControl"))
        }
    }
}

/** A remote-control session (server 1.6 `GET /api/rc/sessions`): PC [host] controlled from [viewer]. */
data class RcSession(val id: String, val host: String, val viewer: String, val since: Long, val state: String) {
    companion object {
        /** Session ids: 16 hex digits (anything else never goes into a URL). */
        val ID = Regex("^[a-f0-9]{16}$")

        fun parseList(a: JSONArray?): List<RcSession> = if (a == null) {
            emptyList()
        } else {
            (0 until a.length()).mapNotNull { i ->
                val o = a.optJSONObject(i) ?: return@mapNotNull null
                val id = o.optString("id").takeIf { ID.matches(it) } ?: return@mapNotNull null
                RcSession(id, o.optString("host"), o.optString("viewer"), o.optLong("since"), o.optString("state"))
            }
        }
    }
}

/** An `alert` event / `GET /api/alerts` entry (server 1.3): battery or storage low, a device offline, the server's disk. */
data class Alert(
    val id: String,
    /** "battery", "storage", "offline", "online", "serverDisk", … */
    val kind: String,
    /** The device it's about (null for the server itself). */
    val device: String?,
    /** "warn" or "info". */
    val level: String,
    val text: String,
    val at: Long,
) {
    companion object {
        fun parse(o: JSONObject) = Alert(
            id = o.optString("id"),
            kind = o.optString("kind"),
            device = o.str("device")?.takeIf { it.isNotBlank() },
            level = o.str("level") ?: "warn",
            text = o.optString("text"),
            at = o.optLong("at"),
        )

        fun parseList(a: JSONArray?): List<Alert> =
            if (a == null) emptyList() else (0 until a.length()).mapNotNull { a.optJSONObject(it)?.let(::parse) }
    }
}

/** A text or file item (see docs/API.md, "Item"). */
data class Item(
    val id: String,
    val kind: String,
    val text: String?,
    val truncated: Boolean,
    val textLength: Int,
    val name: String?,
    val size: Long,
    val mime: String?,
    val from: String?,
    val device: String,
    val to: List<String>,
    val delivered: Map<String, Long>,
    val ts: Long,
    /** Pinned items never expire on the server (API v3). */
    val pinned: Boolean = false,
    /** The server has a small preview at `/api/items/{id}/thumb` (API v3, images and videos). */
    val thumb: Boolean = false,
    /** Picture size in pixels, when the sender said (API v3): lets a preview take its shape before it loads. */
    val w: Int = 0,
    val h: Int = 0,
) {
    val isText get() = kind == "text"
    val isFile get() = kind == "file"
    val isImage get() = isFile && mime?.startsWith("image/") == true && mime != "image/svg+xml"
    val isVideo get() = isFile && mime?.startsWith("video/") == true
    val displayName get() = name ?: "file"

    /** "An item is for me when (to is empty OR to contains my id) AND from != my id." */
    fun isFor(me: String) = (to.isEmpty() || me in to) && from != me

    fun isFrom(me: String) = from != null && from == me

    fun toJson(): JSONObject {
        val o = JSONObject().put("id", id).put("kind", kind).put("device", device).put("ts", ts)
            .put("to", JSONArray(to)).put("delivered", JSONObject(delivered as Map<*, *>))
        if (text != null) o.put("text", text)
        if (truncated) o.put("truncated", true).put("textLength", textLength)
        if (name != null) o.put("name", name)
        if (isFile) o.put("size", size)
        if (mime != null) o.put("mime", mime)
        if (from != null) o.put("from", from)
        if (pinned) o.put("pinned", true)
        if (thumb) o.put("thumb", true)
        if (w > 0 && h > 0) o.put("w", w).put("h", h)
        return o
    }

    companion object {
        fun parse(o: JSONObject): Item = Item(
            id = o.optString("id"),
            kind = o.str("kind") ?: "text",
            text = o.str("text"),
            truncated = o.optBoolean("truncated"),
            textLength = o.optInt("textLength", o.str("text")?.length ?: 0),
            name = o.str("name"),
            size = o.optLong("size"),
            mime = o.str("mime"),
            from = o.str("from"),
            device = o.str("device") ?: "Unknown device",
            to = o.optJSONArray("to").strings(),
            delivered = o.optJSONObject("delivered").longs(),
            ts = o.optLong("ts"),
            pinned = o.optBoolean("pinned"),
            thumb = o.optBoolean("thumb"),
            w = o.optInt("w"),
            h = o.optInt("h"),
        )

        fun parseList(a: JSONArray?): List<Item> =
            if (a == null) emptyList() else (0 until a.length()).mapNotNull { a.optJSONObject(it)?.let(::parse) }
    }
}

/**
 * State of a resumable upload session. [maxChunkSize]: the biggest chunk the server takes (server 1.4
 * `big-chunks`; 0 when it doesn't say).
 */
data class UploadInfo(val id: String, val name: String, val size: Long, val offset: Long, val chunkSize: Long, val maxChunkSize: Long = 0) {
    companion object {
        const val DEFAULT_CHUNK = 8L * 1024 * 1024

        fun parse(o: JSONObject) = UploadInfo(
            id = o.optString("id"),
            name = o.optString("name"),
            size = o.optLong("size"),
            offset = o.optLong("offset"),
            chunkSize = o.optLong("chunkSize", DEFAULT_CHUNK).takeIf { it > 0 } ?: DEFAULT_CHUNK,
            maxChunkSize = o.optLong("maxChunkSize", 0).coerceAtLeast(0),
        )
    }
}

data class ChunkResult(val offset: Long, val done: Boolean, val item: Item?)

data class DevicesResult(val devices: List<Device>, val you: String?)

/** `GET /api/items[?since=]` (see [BeamApi.itemsPage]). */
data class ItemsPage(val items: List<Item>, val deleted: List<String>, val cursor: String?, val delta: Boolean)

/** `POST /api/events/poke` (server 1.4). */
data class PokeResult(val alive: Boolean, val mode: String?, val ping: Int)

/** `GET /api/me`: who the server thinks this device is, and (API v3) its read markers. */
data class MeResult(val you: String?, val read: Map<String, Long>)

/**
 * `GET /api/info`. Everything past `version` is optional: older servers (API v2) leave it out, and the
 * app hides what they can't do (forward, pins, bulk delete, read markers).
 */
data class ServerInfo(
    val version: String,
    val api: Int,
    val features: Set<String>,
    val retentionDays: Int,
    val maxUpload: Long,
    val passwordSet: Boolean,
    val publicUrl: String?,
    val storageUsed: Long?,
    val storageFree: Long?,
    val storageTotal: Long?,
    val storageItems: Int?,
    /** (1.7) Beam Family's address (the family's chat, its own server), if this Beam knows it. */
    val family: String? = null,
    /** (1.7.6) Every address this Beam answers on, for finding it after a move (signed in; audit S-33). */
    val urls: List<String> = emptyList(),
) {
    /** A v3 feature such as "forward"; servers that don't list features have all of them from API 3. */
    fun has(feature: String) = if (features.isNotEmpty()) feature in features else api >= 3

    /** A feature this server names itself (1.4 additions: `items-since`, `live-download`, `big-chunks`…), never assumed. */
    fun lists(feature: String) = feature in features

    companion object {
        fun parse(o: JSONObject): ServerInfo {
            val storage = o.optJSONObject("storage")
            fun long(key: String) = storage?.takeIf { it.has(key) && !it.isNull(key) }?.optLong(key)
            return ServerInfo(
                version = o.optString("version"),
                api = o.optInt("api", 2),
                features = o.optJSONArray("features").strings().toSet(),
                retentionDays = o.optInt("retentionDays", 0),
                maxUpload = o.optLong("maxUpload"),
                passwordSet = o.optBoolean("passwordSet"),
                publicUrl = o.str("publicUrl")?.takeIf { it.isNotBlank() },
                storageUsed = long("used"),
                storageFree = long("free"),
                storageTotal = long("total"),
                storageItems = storage?.takeIf { it.has("items") }?.optInt("items"),
                family = o.str("family")?.takeIf { it.startsWith("https://") || it.startsWith("http://") },
                urls = o.optJSONArray("urls").strings(),
            )
        }
    }
}

// ---------------------------------------------------------------- JSON helpers

/** org.json's optString turns JSON null into the string "null"; this returns a real null. */
fun JSONObject.str(key: String): String? = if (!has(key) || isNull(key)) null else optString(key)

fun JSONArray?.strings(): List<String> =
    if (this == null) emptyList() else (0 until length()).mapNotNull { if (isNull(it)) null else optString(it) }

fun JSONObject?.longs(): Map<String, Long> {
    if (this == null) return emptyMap()
    val out = LinkedHashMap<String, Long>()
    for (k in keys()) out[k] = optLong(k)
    return out
}
