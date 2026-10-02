package app.beam.android.core

/**
 * How items are grouped into conversations (docs/API.md, "Conversations"). One conversation per other
 * device, plus [ALL] for broadcasts.
 */
object Conversations {
    /** Key of the "All devices" conversation. Device ids never contain '*'. */
    const val ALL = "*"

    /** The conversations [item] belongs to, seen from device [me]. Empty = not shown. */
    fun keysOf(item: Item, me: String, devices: Map<String, Device>): Set<String> {
        if (item.to.isEmpty()) return setOf(ALL)
        val from = item.from
        // Mine, sent to X: in X's conversation (one per target).
        if (from == me) return item.to.filterTo(LinkedHashSet()) { it != me }
        // From X to me: in X's conversation.
        if (from != null) return if (me in item.to) setOf(from) else emptySet()
        // Old items without a sender id (curl, Shortcuts): in the conversations of the devices they
        // target. If they target me, file them under the device whose name matches the sender name,
        // or under All devices when no device matches.
        val keys = item.to.filterTo(LinkedHashSet()) { it != me }
        if (me in item.to) {
            keys += devices.values.firstOrNull { it.id != me && it.name.equals(item.device, ignoreCase = true) }?.id ?: ALL
        }
        return keys
    }

    /** Items of one conversation, oldest first. [items] is newest first, as the server sends it. */
    fun thread(key: String, me: String, items: List<Item>, devices: Map<String, Device>): List<Item> =
        items.filter { key in keysOf(it, me, devices) }.sortedBy { it.ts }

    data class Summary(
        val key: String,
        val name: String,
        val platform: String?,
        val online: Boolean,
        val lastSeen: Long,
        /** False for devices that were forgotten on the server but still have items. */
        val known: Boolean,
        val last: Item?,
        val unread: Int,
    ) {
        val isAll get() = key == ALL
    }

    /**
     * The conversation list: All devices first, then every other device by most recent activity.
     * [lastRead] maps a conversation key to the newest item time the user has seen there; items for me
     * newer than that count as unread. Replying counts as having read what came before the reply.
     */
    fun summaries(me: String, devices: List<Device>, items: List<Item>, lastRead: Map<String, Long>): List<Summary> {
        val byId = devices.associateBy { it.id }
        val last = HashMap<String, Item>()
        val unread = HashMap<String, Int>()
        val names = HashMap<String, String>()
        val replied = HashMap<String, Long>()
        for (item in items) {
            if (item.isFrom(me)) for (k in keysOf(item, me, byId)) replied[k] = maxOf(replied[k] ?: 0L, item.ts)
        }
        for (item in items) {
            for (k in keysOf(item, me, byId)) {
                val prev = last[k]
                if (prev == null || item.ts > prev.ts) last[k] = item
                if (item.isFor(me) && item.ts > maxOf(lastRead[k] ?: 0L, replied[k] ?: 0L)) unread[k] = (unread[k] ?: 0) + 1
                if (k != ALL && k !in byId && item.from == k) names.putIfAbsent(k, item.device)
            }
        }
        val list = ArrayList<Summary>()
        for (d in devices) {
            if (d.id != me) list += Summary(d.id, d.name, d.platform, d.online, d.lastSeen, true, last[d.id], unread[d.id] ?: 0)
        }
        for ((k, item) in last) {
            if (k != ALL && k != me && k !in byId) {
                list += Summary(k, names[k] ?: "Unknown device", null, false, 0, false, item, unread[k] ?: 0)
            }
        }
        list.sortWith(
            compareByDescending<Summary> { it.last?.ts ?: 0L }
                .thenByDescending { it.online }
                .thenByDescending { it.lastSeen }
                .thenBy { it.name.lowercase() },
        )
        return listOf(Summary(ALL, "All devices", null, false, 0, true, last[ALL], unread[ALL] ?: 0)) + list
    }

    /** Targets for sending into a conversation: none (= everyone) for All devices. */
    fun targets(key: String): List<String> = if (key == ALL) emptyList() else listOf(key)

    /** The newest item time in a conversation (used to mark it read). */
    fun newest(key: String, me: String, items: List<Item>, devices: Map<String, Device>): Long =
        items.asSequence().filter { key in keysOf(it, me, devices) }.maxOfOrNull { it.ts } ?: 0L

    /** "Sent" / "Delivered" / "Delivered to Pixel, Laptop" for one of my items shown in conversation [key]. */
    fun deliveryStatus(item: Item, key: String, me: String, devices: Map<String, Device>): String? {
        if (!item.isFrom(me)) return null
        if (key != ALL) return if (key in item.delivered) "Delivered" else "Sent"
        val names = item.delivered.keys.filter { it != me }.map { devices[it]?.name ?: "a device" }
        return when (names.size) {
            0 -> "Sent"
            1, 2 -> "Delivered to " + names.joinToString(", ")
            else -> "Delivered to ${names[0]}, ${names[1]} +${names.size - 2}"
        }
    }

    /** Whether one of my items counts as delivered in conversation [key] (for the tick icon). */
    fun isDelivered(item: Item, key: String, me: String): Boolean =
        if (key == ALL) item.delivered.keys.any { it != me } else key in item.delivered
}
