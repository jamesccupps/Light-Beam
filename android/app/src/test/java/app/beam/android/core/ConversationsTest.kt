package app.beam.android.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationsTest {
    private val me = "me000000"
    private val x = "xxxxxxxx"
    private val y = "yyyyyyyy"
    private val devices = listOf(
        Device(me, "My phone", "android", true, 1),
        Device(x, "Desktop", "windows", true, 5),
        Device(y, "Laptop", "mac", false, 3),
    )
    private val byId = devices.associateBy { it.id }

    private fun item(id: String, from: String?, to: List<String>, ts: Long, device: String = "?", delivered: Map<String, Long> = emptyMap()) =
        Item(id, "text", "t$id", false, 3, null, 0, null, from, device, to, delivered, ts)

    @Test
    fun placesItemsLikeTheApiDescribes() {
        assertEquals(setOf(x), Conversations.keysOf(item("1", me, listOf(x), 1), me, byId))
        assertEquals(setOf(x, y), Conversations.keysOf(item("2", me, listOf(x, y), 1), me, byId))
        assertEquals(setOf(x), Conversations.keysOf(item("3", x, listOf(me), 1), me, byId))
        assertEquals(setOf(x), Conversations.keysOf(item("4", x, listOf(me, y), 1), me, byId))
        assertEquals(emptySet<String>(), Conversations.keysOf(item("5", x, listOf(y), 1), me, byId))
        assertEquals(setOf(Conversations.ALL), Conversations.keysOf(item("6", x, emptyList(), 1), me, byId))
        assertEquals(setOf(Conversations.ALL), Conversations.keysOf(item("7", me, emptyList(), 1), me, byId))
        // Legacy items without a sender id.
        assertEquals(setOf(Conversations.ALL), Conversations.keysOf(item("8", null, emptyList(), 1), me, byId))
        assertEquals(setOf(y), Conversations.keysOf(item("9", null, listOf(y), 1), me, byId))
        assertEquals(setOf(x), Conversations.keysOf(item("10", null, listOf(me), 1, device = "desktop"), me, byId))
        assertEquals(setOf(Conversations.ALL), Conversations.keysOf(item("11", null, listOf(me), 1, device = "curl"), me, byId))
    }

    @Test
    fun summariesSortByActivityWithUnreadCounts() {
        val items = listOf( // newest first
            item("c", y, listOf(me), 30),
            item("b", x, listOf(me), 20),
            item("a", x, listOf(me), 10),
            item("z", "gone0000", listOf(me), 5, device = "Old tablet"),
            item("all", me, emptyList(), 1),
        )
        val list = Conversations.summaries(me, devices, items, mapOf(x to 10L))
        assertEquals(listOf(Conversations.ALL, y, x, "gone0000"), list.map { it.key })
        assertEquals(1, list.first { it.key == x }.unread) // "a" was read, "b" wasn't
        assertEquals(1, list.first { it.key == y }.unread)
        assertEquals(0, list.first { it.isAll }.unread) // my own broadcast isn't unread
        assertEquals("Old tablet", list.last().name)
        assertEquals("all", list.first().last?.id)

        // Replying means what came before the reply was seen (e.g. a reply from the notification).
        val replied = Conversations.summaries(me, devices, listOf(item("r", me, listOf(y), 40)) + items, mapOf(x to 10L))
        assertEquals(0, replied.first { it.key == y }.unread)
        assertEquals(1, replied.first { it.key == x }.unread)
    }

    @Test
    fun threadIsOldestFirst() {
        val items = listOf(item("2", x, listOf(me), 20), item("1", me, listOf(x), 10), item("0", y, listOf(me), 5))
        assertEquals(listOf("1", "2"), Conversations.thread(x, me, items, byId).map { it.id })
    }

    @Test
    fun deliveryStatus() {
        val sent = item("1", me, listOf(x, y), 1, delivered = mapOf(x to 2L))
        assertEquals("Delivered", Conversations.deliveryStatus(sent, x, me, byId))
        assertEquals("Sent", Conversations.deliveryStatus(sent, y, me, byId))
        val broadcast = item("2", me, emptyList(), 1, delivered = mapOf(x to 2L, y to 3L))
        assertEquals("Delivered to Desktop, Laptop", Conversations.deliveryStatus(broadcast, Conversations.ALL, me, byId))
        assertNull(Conversations.deliveryStatus(item("3", x, listOf(me), 1), x, me, byId))
    }

    @Test
    fun parsesPairingLinks() {
        val link = Pairing.parse("https://robin-desktop.tail9876.ts.net/?key=abc_DEF-123")!!
        assertEquals("https://robin-desktop.tail9876.ts.net", link.baseUrl)
        assertEquals("abc_DEF-123", link.key)
        assertEquals("http://192.168.1.5:8765", Pairing.parse("Open http://192.168.1.5:8765/?key=k1 on your phone")!!.baseUrl)
        assertEquals("k%2F=", Pairing.parse(Pairing.link("http://h:1", "k%2F="))!!.key)
        assertNull(Pairing.parse("https://example.com/"))
        assertNull(Pairing.parse("hello"))
    }

    @Test
    fun encodesLikeJavaScript() {
        assertEquals("J%C3%A4mes%20Pixel", encodeURIComponent("Jämes Pixel"))
        assertEquals("a%2Bb", encodeURIComponent("a+b"))
    }

    @Test
    fun formatsSizes() {
        assertEquals("532 B", Format.size(532))
        assertEquals("1.5 KB", Format.size(1536))
        assertEquals("500 MB", Format.size(500L * 1024 * 1024))
        assertEquals("4.0 GB", Format.size(4L * 1024 * 1024 * 1024))
        assertTrue(Backoff().let { b -> listOf(b.next(), b.next(), b.next(), b.next(), b.next(), b.next(), b.next()) } == listOf(1000L, 2000, 4000, 8000, 16000, 30000, 30000))
    }
}
