package app.beam.android

import android.Manifest
import android.app.Notification
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Looper
import android.provider.Settings
import android.service.notification.StatusBarNotification
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.BeamApi
import app.beam.android.core.EventStream
import app.beam.android.core.Pairing
import app.beam.android.core.SignInClient
import app.beam.android.core.TestNet
import app.beam.android.data.Repository
import app.beam.android.phone.NotificationReader
import app.beam.android.phone.PhoneNotifications
import app.beam.android.phone.ShareListenerService
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowNotificationListenerService
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files
import java.time.Duration
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * "Notifications on your PCs" against a real 1.5 server of its own (BEAM_SERVER_JS, a port from BEAM_TEST_PORTS):
 * the phone shares, a PC that shows them gets them, replies, presses a button and dismisses, the switch going off
 * removes them, and a restarted server gets them again. Afterwards the server's data folder and log must not
 * contain any of the content.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class PhoneProtocolTest {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private val serverJs = System.getProperty("beam.server.js").orEmpty()
    private val chat = "com.example.chat"
    private var server: Process? = null
    private var data: File? = null
    private var port = 0
    private val streams = CopyOnWriteArrayList<EventStream>()
    private val received = CopyOnWriteArrayList<Intent>()
    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            received += intent
        }
    }

    @After
    fun tearDown() {
        runCatching { app.phone.setEnabled(false) }
        app.connection.release("service")
        if (app.prefs.paired) app.unpair()
        streams.forEach { it.cancel() }
        stopServer()
        data?.deleteRecursively()
        runCatching { app.unregisterReceiver(receiver) }
    }

    private fun idleUntil(what: String, timeoutMs: Long = 15_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(20))
            if (condition()) return
            Thread.sleep(10)
        }
        throw AssertionError("timed out: $what")
    }

    private fun startServer(): String {
        val dir = data ?: Files.createTempDirectory("beam-phone-notifications").toFile().also { data = it }
        if (port == 0) port = TestNet.freePort()
        val pb = ProcessBuilder("node", serverJs).redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.appendTo(File(dir, "server.log")))
        pb.environment().apply {
            put("BEAM_HOST", "127.0.0.1")
            put("BEAM_PORT", port.toString())
            put("BEAM_DATA", dir.absolutePath)
            put("BEAM_DIST", dir.absolutePath)
            put("BEAM_TAILSCALE", "off")
            remove("BEAM_PUBLIC_URL")
            remove("BEAM_MOVED_TO")
        }
        server = pb.start()
        val base = "http://127.0.0.1:$port"
        val deadline = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < deadline) {
            try {
                val c = URL("$base/api/hello").openConnection() as HttpURLConnection
                c.connectTimeout = 500
                if (c.responseCode == 200) break
            } catch (_: Exception) {
            }
            Thread.sleep(150)
        }
        return base
    }

    private fun stopServer() {
        server?.let {
            it.destroy()
            if (!it.waitFor(10, TimeUnit.SECONDS)) it.destroyForcibly().waitFor()
        }
        server = null
    }

    /** A device's event stream, into a queue. */
    private fun listen(api: BeamApi): LinkedBlockingQueue<Pair<String, JSONObject>> {
        val q = LinkedBlockingQueue<Pair<String, JSONObject>>()
        val s = EventStream(api, mode = "background").also { streams += it }
        thread(isDaemon = true) {
            runCatching {
                s.run(object : EventStream.Listener {
                    override fun onOpen() {}
                    override fun onEvent(event: String, data: String) {
                        q.put(event to (runCatching { JSONObject(data) }.getOrNull() ?: JSONObject()))
                    }
                })
            }
        }
        return q
    }

    private fun LinkedBlockingQueue<Pair<String, JSONObject>>.next(name: String, ms: Long = 10_000, match: (JSONObject) -> Boolean = { true }): JSONObject {
        val deadline = System.currentTimeMillis() + ms
        while (true) {
            val left = deadline - System.currentTimeMillis()
            if (left <= 0) throw AssertionError("no $name event")
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(10))
            val (event, data) = poll(minOf(left, 100), TimeUnit.MILLISECONDS) ?: continue
            if (event == name && match(data)) return data
        }
    }

    private fun BeamApi.listed(): List<String> = execute(request(url("/api/phone/notifications")).get().build()).use { res ->
        val a = JSONObject(res.body!!.string()).getJSONArray("notifications")
        (0 until a.length()).map { a.getJSONObject(it).getString("id") }
    }

    /** What a fresh process has: the phone's memory of what it shared is gone (an update, a reboot, a kill). */
    private fun newProcess() {
        val field = BeamApp::class.java.getDeclaredField("phone")
        field.isAccessible = true
        field.set(app, PhoneNotifications(app))
    }

    private fun BeamApi.post(path: String, body: JSONObject): JSONObject =
        execute(request(url(path)).post(body.toString().toRequestBody(BeamApi.JSON)).build()).use { JSONObject(it.body!!.string().ifEmpty { "{}" }) }

    @Test
    fun aPcSeesRepliesToAndDismissesThePhonesNotifications() {
        assumeTrue("Set BEAM_SERVER_JS to run the 1.5 protocol tests", serverJs.isNotEmpty())
        val base = startServer()
        val key = File(data, "key").readText().trim()
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        ShadowNotificationListenerService.reset()
        app.registerReceiver(receiver, IntentFilter().apply { addAction(REPLY); addAction(READ) }, Context.RECEIVER_NOT_EXPORTED)

        // A PC that shows the phone's notifications, listening.
        val desk = TestNet.device(base, key, "Desk", "windows")
        desk.me()
        desk.setShowsPhoneNotifications("me", true)
        var events = listen(desk)
        events.next("hello")

        // The phone, sharing one app.
        app.completePairing(Pairing.Link(base, key), "Pixel", SignInClient(base).hello().serverId)
        app.connection.acquire("service")
        idleUntil("connected to a 1.5 server") { app.repo.state.value.conn == Repository.Conn.CONNECTED && app.phone.serverReady }
        Settings.Secure.putString(app.contentResolver, "enabled_notification_listeners", ComponentName(app, ShareListenerService::class.java).flattenToString())
        app.prefs.phoneSetupDone = true
        app.phone.setAppShared(chat, true)
        app.phone.setEnabled(true)
        val service = Robolectric.setupService(ShareListenerService::class.java)
        service.onListenerConnected()
        val sbn = post(service, chatNotification("Mom" to "$MARK dinner at 7?"))
        val id = app.repo.me + "/" + NotificationReader.keyOf(sbn)

        // The PC gets it.
        val shown = events.next("notification")
        assertEquals(id, shown.getString("id"))
        // When it was posted, and not a re-send (a server that keeps the optional fields passes them on).
        val serverKeepsThem = shown.has("posted")
        if (serverKeepsThem) {
            assertEquals(sbn.postTime, shown.getLong("posted"))
            assertTrue(!shown.optBoolean("resent"))
        } else {
            println("this server drops `posted`/`resent` (older than the 1.5 review): not checked")
        }
        assertEquals("Mom", shown.getString("title"))
        assertEquals("Mom: $MARK dinner at 7?", shown.getJSONArray("lines").getString(0))
        assertEquals(listOf("Reply", "Mark as read"), (0 until shown.getJSONArray("actions").length()).map { shown.getJSONArray("actions").getJSONObject(it).getString("title") })

        val actions = shown.getJSONArray("actions").let { a -> (0 until a.length()).map { a.getJSONObject(it).getString("id") } }
        // It replies: the phone answers through the app's own reply action.
        val rid = desk.post("/api/phone/notifications/$id/reply", JSONObject().put("action", actions[0]).put("text", "$MARK on my way")).getString("request")
        val done = events.next("notification-request-done")
        assertEquals(rid, done.getString("request"))
        assertTrue("replied: $done", done.getBoolean("ok"))
        idleUntil("the app got it") { received.any { it.action == REPLY } }
        assertEquals("$MARK on my way", RemoteInput.getResultsFromIntent(received.first { it.action == REPLY })?.getCharSequence("reply_text")?.toString())

        // A button.
        desk.post("/api/phone/notifications/$id/action", JSONObject().put("action", actions[1]))
        assertTrue(events.next("notification-request-done").getBoolean("ok"))
        idleUntil("the button") { received.any { it.action == READ } }

        // Dismissed on the PC: gone from the phone, and the phone's own removal takes it off the server.
        desk.post("/api/phone/notifications/$id/dismiss", JSONObject())
        assertTrue(events.next("notification-request-done").getBoolean("ok"))
        assertTrue(service.activeNotifications.none { it.key == sbn.key })
        service.onNotificationRemoved(sbn, null, NotificationListenerServiceReasonCancel)
        assertEquals(id, events.next("notification-removed").getString("id"))

        // Another one, then the server restarts: it forgot (memory only), and the phone sends it again.
        val again = post(service, chatNotification("Dad" to "$MARK call me"))
        events.next("notification")
        stopServer()
        startServer()
        events = listen(desk)
        events.next("hello")
        val back = events.next("notification", 30_000)
        assertEquals(app.repo.me + "/" + NotificationReader.keyOf(again), back.getString("id"))
        if (serverKeepsThem) {
            assertTrue("sent again after the restart: a re-send", back.optBoolean("resent"))
            assertEquals(again.postTime, back.getLong("posted"))
        }

        // The phone's process starts again (an update, a reboot) after one of them went away meanwhile: the server's
        // copy is replaced, so the PCs don't keep it for a day (review of 1.5.0).
        val shadow: ShadowNotificationListenerService = Shadow.extract(service)
        val gone = post(service, chatNotification("Grandma" to "$MARK hello"))
        val goneId = app.repo.me + "/" + NotificationReader.keyOf(gone)
        events.next("notification") { it.optString("id") == goneId }
        newProcess()
        service.cancelNotification(gone.key) // nobody hears it: the process isn't running
        service.onListenerConnected()
        assertTrue(events.next("notification-removed").optBoolean("all"))
        val resynced = events.next("notification")
        assertEquals(app.repo.me + "/" + NotificationReader.keyOf(again), resynced.getString("id"))
        if (serverKeepsThem) assertTrue("the process's first sync: a re-send", resynced.optBoolean("resent"))
        Thread.sleep(500)
        assertTrue("the gone one isn't listed", goneId !in desk.listed())

        // Switched off on the phone: everything goes from the PCs.
        app.phone.setEnabled(false)
        assertTrue(events.next("notification-removed") { it.optBoolean("all") }.optBoolean("all"))
        stopServer()

        // Nothing of the content on the server's disk or in its log.
        val leaks = data!!.walkTopDown().filter { it.isFile }.filter { f -> runCatching { f.readText().contains(MARK) }.getOrDefault(false) }.toList()
        assertTrue("content on disk: $leaks", leaks.isEmpty())
    }

    private fun post(service: ShareListenerService, n: Notification): StatusBarNotification {
        val shadow: ShadowNotificationListenerService = Shadow.extract(service)
        val key = shadow.addActiveNotification(chat, ++ids, n)
        val sbn = service.activeNotifications.last { it.key == key }
        service.onNotificationPosted(sbn, null)
        return sbn
    }

    private var ids = 0

    private fun chatNotification(vararg messages: Pair<String, String>): Notification {
        val style = NotificationCompat.MessagingStyle(Person.Builder().setName("You").build())
        messages.forEachIndexed { i, (who, text) -> style.addMessage(text, 1_000L + i, Person.Builder().setName(who).build()) }
        val reply = PendingIntent.getBroadcast(app, 1, Intent(REPLY).setPackage(app.packageName), PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val read = PendingIntent.getBroadcast(app, 2, Intent(READ).setPackage(app.packageName), PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(app, "chat")
            .setSmallIcon(R.drawable.ic_stat_beam)
            .setStyle(style)
            .addAction(NotificationCompat.Action.Builder(0, "Reply", reply).addRemoteInput(RemoteInput.Builder("reply_text").setLabel("Reply").build()).build())
            .addAction(NotificationCompat.Action.Builder(0, "Mark as read", read).build())
            .build()
    }

    companion object {
        /** A string that must never reach the server's disk or log. */
        private const val MARK = "zq-phone-note-7f3a"
        private const val REPLY = "app.beam.android.test.PROTOCOL_REPLY"
        private const val READ = "app.beam.android.test.PROTOCOL_READ"
        private const val NotificationListenerServiceReasonCancel = 2 // NotificationListenerService.REASON_CANCEL
    }
}
