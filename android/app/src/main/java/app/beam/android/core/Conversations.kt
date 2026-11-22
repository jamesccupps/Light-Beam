package app.beam.android.core

/**
 * How items are grouped into conversations (docs/API.md, "Conversations"). One conversation per other
 * device, plus [ALL] for broadcasts.
 */
object Conversations {
    /** Key of the "All devices" conversation. Device ids never contain '*'. */
    const val ALL = "*"

    /** (1.20, server 1.34) Key of Notes: messages to the device they were sent from, shown on every device. */
    const val NOTES = "~notes"

    /** (1.20.2) Key of the main list's Alerts row (the alerts inbox: not a conversation; it opens the list). */
    const val ALERTS = "~alerts"

    /** (1.21) Key of the main list's Weather row (LocalCast's page: not a conversation). */
    const val WEATHER = "~weather"

    /** The conversations [item] belongs to, seen from device [me]. Empty = not shown. */
    fun keysOf(item: Item, me: String, devices: Map<String, Device>): Set<String> {
        if (item.isNote) return setOf(NOTES) // (1.20) whoever wrote it (older apps: in none)
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
        /** (1.20.2) The Alerts row's line: its newest alert. (1.21) The Weather row's: now and today. */
        val note: String? = null,
        /** (1.21) The Weather row's temperature now (where a conversation's time is). */
        val side: String? = null,
    ) {
        val isAll get() = key == ALL
        val isNotes get() = key == NOTES
        val isAlerts get() = key == ALERTS
        val isWeather get() = key == WEATHER
    }

    /**
     * The conversation list: All devices first, then every other device by most recent activity.
     * [lastRead] maps a conversation key to the newest item time the user has seen there; items for me
     * newer than that count as unread. Replying counts as having read what came before the reply.
     */
    fun summaries(me: String, devices: List<Device>, items: List<Item>, lastRead: Map<String, Long>, notes: Boolean): List<Summary> {
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
            if (k != ALL && k != NOTES && k != me && k !in byId) {
                list += Summary(k, names[k] ?: "Unknown device", null, false, 0, false, item, unread[k] ?: 0)
            }
        }
        list.sortWith(
            compareByDescending<Summary> { it.last?.ts ?: 0L }
                .thenByDescending { it.online }
                .thenByDescending { it.lastSeen }
                .thenBy { it.name.lowercase() },
        )
        val head = listOf(Summary(ALL, "All devices", null, false, 0, true, last[ALL], unread[ALL] ?: 0))
        // (1.20) Notes right under All devices, on a Beam that keeps them [notes] (or while any are here); nothing is unread there
        val notesRow = if (notes || last[NOTES] != null) listOf(Summary(NOTES, "Notes", null, false, 0, true, last[NOTES], 0)) else emptyList()
        return head + notesRow + list
    }

    /**
     * Targets for sending into a conversation: none (= everyone) for All devices; for Notes (1.20) this device [me]
     * itself, never none (that's every device): "notes" while its id isn't known (the server reads it as the sender).
     */
    fun targets(key: String, me: String): List<String> = when (key) {
        ALL -> emptyList()
        NOTES -> listOf(me.ifBlank { "notes" })
        else -> listOf(key)
    }

    /** The newest item time in a conversation (used to mark it read). */
    fun newest(key: String, me: String, items: List<Item>, devices: Map<String, Device>): Long =
        items.asSequence().filter { key in keysOf(it, me, devices) }.maxOfOrNull { it.ts } ?: 0L

    /** "Sent" / "Delivered" / "Delivered to Pixel, Laptop" for one of my items shown in conversation [key]. */
    fun deliveryStatus(item: Item, key: String, me: String, devices: Map<String, Device>): String? {
        if (!item.isFrom(me)) return null
        if (key == NOTES) return null // (1.20) a note goes nowhere
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
