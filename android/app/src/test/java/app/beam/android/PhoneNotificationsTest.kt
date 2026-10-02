package app.beam.android

import android.Manifest
import android.app.Notification
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.DialogInterface
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.graphics.Bitmap
import android.graphics.drawable.BitmapDrawable
import android.os.Looper
import android.provider.Settings
import android.service.notification.StatusBarNotification
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.Device
import app.beam.android.core.Pairing
import app.beam.android.phone.NotificationReader
import app.beam.android.phone.PcNotificationsTileService
import app.beam.android.phone.PhoneNotifications
import app.beam.android.phone.ShareListenerService
import app.beam.android.ui.MainActivity
import app.beam.android.ui.PhoneNotificationsActivity
import app.beam.android.ui.SettingsActivity
import android.content.pm.ActivityInfo
import android.content.pm.ResolveInfo
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.core.view.isVisible
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.materialswitch.MaterialSwitch
import org.robolectric.shadows.ShadowDialog
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowNotificationListenerService
import java.time.Duration
import java.util.concurrent.CopyOnWriteArrayList

/**
 * "Notifications on your PCs" (1.5) on the phone: what's shared and what of it, the switches, sending (debounced,
 * batched, icons on a 404, again for a restarted server), and carrying out replies, buttons and dismissals asked
 * for by a PC. Against [FakeBeam].
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], qualifiers = "w412dp-h2000dp")
class PhoneNotificationsTest {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private val desk = "desk00000001"
    private val chat = "com.example.chat"
    private val other = "com.example.other"
    private var fake: FakeBeam? = null
    private val received = CopyOnWriteArrayList<Intent>()
    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            received += intent
        }
    }

    @Before
    fun setUp() {
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        ShadowNotificationListenerService.reset()
        Settings.Secure.putString(app.contentResolver, "enabled_notification_listeners", "") // no access until a test grants it
        app.registerReceiver(receiver, IntentFilter().apply { addAction(REPLY); addAction(READ) }, Context.RECEIVER_NOT_EXPORTED)
    }

    @After
    fun tearDown() {
        app.phone.setEnabled(false)
        app.connection.release("service")
        app.unpair()
        fake?.close()
        runCatching { app.unregisterReceiver(receiver) }
    }

    private fun idle(ms: Long = 20) = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ms))

    private fun idleUntil(what: String, timeoutMs: Long = 10_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            idle()
            if (condition()) return
            Thread.sleep(10)
        }
        throw AssertionError("timed out: $what")
    }

    private fun idleFor(ms: Long) {
        val until = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < until) {
            idle()
            Thread.sleep(10)
        }
    }

    private fun grantAccess() = Settings.Secure.putString(app.contentResolver, "enabled_notification_listeners",
        ComponentName(app, ShareListenerService::class.java).flattenToString())

    /** Paired with a FakeBeam that has the feature, connected; Desk and Laptop (Windows) and a browser. */
    private fun start(features: List<String> = listOf("stream-modes", "phone-notifications")): FakeBeam {
        val f = FakeBeam(features).also { fake = it }
        val now = System.currentTimeMillis()
        f.devices = JSONArray()
            .put(Device(desk, "Desk", "windows", true, now).toJson())
            .put(Device("laptop000001", "Laptop", "windows", true, now).toJson())
            .put(Device("browser00001", "Chrome", "web", true, now).toJson())
        app.completePairing(Pairing.Link(f.url, "k"), "Pixel", "fakebeam01")
        app.connection.acquire("service")
        idleUntil("connected") { app.connection.streamId != null && app.repo.state.value.info != null && app.repo.state.value.devices.size == 3 }
        return f
    }

    /** Sharing on for [apps], with access, and the listener connected. */
    private fun listening(vararg apps: String): ShareListenerService {
        grantAccess()
        app.prefs.phoneSetupDone = true
        apps.forEach { app.phone.setAppShared(it, true) }
        app.phone.setEnabled(true)
        val service = Robolectric.setupService(ShareListenerService::class.java)
        service.onListenerConnected()
        fake?.let { f -> idleUntil("the first sync") { f.requests.contains("DELETE /api/phone/notifications") } }
        return service
    }

    /** The ids the PCs see for a shared notification's buttons. */
    private fun actionIds(f: FakeBeam, key: String): List<String> =
        f.phoneNotifications.getValue(key).getJSONArray("actions").let { a -> (0 until a.length()).map { a.getJSONObject(it).getString("id") } }

    private fun shadow(service: ShareListenerService): ShadowNotificationListenerService = Shadow.extract(service)

    private fun post(service: ShareListenerService, pkg: String, id: Int, n: Notification): StatusBarNotification {
        val key = shadow(service).addActiveNotification(pkg, id, n)
        val sbn = service.activeNotifications.last { it.key == key } // an update: the newest version
        service.onNotificationPosted(sbn, null)
        return sbn
    }

    /** What the phone sees of [n] when app [pkg] posts it (no listener needed). */
    private fun sbnOf(pkg: String, n: Notification, id: Int = 1): StatusBarNotification {
        val service = Robolectric.setupService(ShareListenerService::class.java)
        val key = shadow(service).addActiveNotification(pkg, id, n)
        return service.activeNotifications.first { it.key == key }
    }

    private fun chatNotification(vararg messages: Pair<String, String>, group: String? = null, opens: Boolean = false): Notification {
        val style = NotificationCompat.MessagingStyle(Person.Builder().setName("You").build())
        if (group != null) style.setConversationTitle(group).setGroupConversation(true)
        messages.forEachIndexed { i, (who, text) -> style.addMessage(text, 1_000L + i, Person.Builder().setName(who).build()) }
        val reply = PendingIntent.getBroadcast(app, 1, Intent(REPLY).setPackage(app.packageName), PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val read = if (opens) {
            PendingIntent.getActivity(app, 2, Intent(app, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        } else {
            PendingIntent.getBroadcast(app, 2, Intent(READ).setPackage(app.packageName), PendingIntent.FLAG_IMMUTABLE)
        }
        return NotificationCompat.Builder(app, "chat")
            .setSmallIcon(R.drawable.ic_stat_beam)
            .setStyle(style)
            .addAction(NotificationCompat.Action.Builder(0, "Reply", reply).addRemoteInput(RemoteInput.Builder("reply_text").setLabel("Reply").build()).build())
            .addAction(NotificationCompat.Action.Builder(0, if (opens) "Open" else "Mark as read", read).build())
            .build()
    }

    private fun plain(title: String, text: String, build: NotificationCompat.Builder.() -> Unit = {}): Notification =
        NotificationCompat.Builder(app, "c").setSmallIcon(R.drawable.ic_stat_beam).setContentTitle(title).setContentText(text).apply(build).build()

    // ---------------------------------------------------------------- what's shared, and what of it

    @Test
    fun onlyPickedAppsAndNothingThatShouldStayOnThePhone() {
        val picked = setOf(chat)
        fun shared(pkg: String, n: Notification, active: List<StatusBarNotification> = emptyList()) =
            NotificationReader.shareable(sbnOf(pkg, n), app.packageName, picked, active)
        assertTrue(shared(chat, plain("Mom", "Dinner at 7?")))
        assertFalse("an app that wasn't picked", shared(other, plain("Ad", "Buy now")))
        assertFalse("Beam's own", NotificationReader.shareable(sbnOf(app.packageName, plain("Beam", "x")), app.packageName, picked + app.packageName, emptyList()))
        assertFalse("ongoing", shared(chat, plain("Call", "00:42") { setOngoing(true) }))
        assertFalse("secret", shared(chat, plain("Secret", "x") { setVisibility(NotificationCompat.VISIBILITY_SECRET) }))
        val fgs = plain("Syncing", "x").apply { flags = flags or Notification.FLAG_FOREGROUND_SERVICE }
        assertFalse("a foreground service's", shared(chat, fgs))
        // A group summary: alone it's shared; with a child of its own that is, it isn't (it'd show twice).
        val summary = plain("2 new messages", "Mom, Dad") { setGroup("g").setGroupSummary(true) }
        val child = sbnOf(chat, plain("Mom", "Dinner at 7?") { setGroup("g") }, id = 2)
        assertTrue("a summary alone", shared(chat, summary))
        assertFalse("a summary with a shared child", shared(chat, summary, listOf(child)))
        assertFalse("local only: the app asks not to bridge it", shared(chat, plain("Bank", "Approve the sign-in?") { setLocalOnly(true) }))
        // The same app in a work profile: not picked (review of 1.5.0).
        @Suppress("DEPRECATION")
        val work = StatusBarNotification(chat, chat, 1, null, 1010123, 0, 0, plain("Work chat", "Q3 numbers are in"),
            android.os.UserHandle.getUserHandleForUid(1010123), System.currentTimeMillis())
        assertFalse("another profile's", NotificationReader.shareable(work, app.packageName, picked, emptyList()))
    }

    @Test
    fun messagesBigTextAndInboxAreReadWithinTheLimits() {
        // MessagingStyle, one to one: the sender and the last 5 messages.
        val talk = (1..7).map { "Mom" to "message $it" }.toTypedArray()
        val (one, actions) = NotificationReader.read(sbnOf(chat, chatNotification(*talk)), "Chat", null, silent = false)!!
        assertEquals("Mom", one.title)
        assertEquals("message 7", one.text)
        assertEquals((3..7).map { "Mom: message $it" }, one.lines)
        assertNull(one.conversation)
        assertEquals(listOf("Reply" to true, "Mark as read" to false), one.actions.map { it.title to it.reply })
        assertEquals(listOf(NotificationReader.actionId(0, "Reply"), NotificationReader.actionId(1, "Mark as read")), one.actions.map { it.id })
        assertTrue(one.actions.all { it.id.matches(Regex("^a\\d-[0-9a-f]{6}$")) })
        assertEquals(2, actions.size)
        // A group: the conversation's name.
        val (group, _) = NotificationReader.read(sbnOf(chat, chatNotification("Mom" to "Dinner at 7?", "Dad" to "👍", group = "Family")), "Chat", null, false)!!
        assertEquals("Family", group.title)
        assertEquals("Family", group.conversation)
        assertEquals(listOf("Mom: Dinner at 7?", "Dad: 👍"), group.lines)
        // BigText and Inbox.
        val big = plain("Article", "short") { setStyle(NotificationCompat.BigTextStyle().bigText("the whole long text")) }
        assertEquals("the whole long text", NotificationReader.read(sbnOf(chat, big), "Chat", null, false)!!.first.text)
        val inbox = plain("3 new mails", "") { setStyle(NotificationCompat.InboxStyle().addLine("one").addLine("two").addLine("three")) }
        assertEquals(listOf("one", "two", "three"), NotificationReader.read(sbnOf(chat, inbox), "Chat", null, false)!!.first.lines)
        // The server's limits.
        val huge = plain("t".repeat(300), "x".repeat(10_000)) {
            setStyle(NotificationCompat.InboxStyle().also { s -> repeat(12) { s.addLine("l".repeat(1_000)) } })
            repeat(5) { i -> addAction(0, "Action number $i with a very long title indeed", PendingIntent.getBroadcast(app, 10 + i, Intent(READ), PendingIntent.FLAG_IMMUTABLE)) }
        }
        val (capped, _) = NotificationReader.read(sbnOf(chat, huge), "Chat", null, false)!!
        assertEquals(200, capped.title.length)
        assertTrue(capped.text.toByteArray().size <= 4 * 1024)
        assertTrue(capped.lines.size <= 10 && capped.lines.all { it.length <= 500 })
        assertEquals(3, capped.actions.size)
        assertTrue(capped.actions.all { it.title.length <= 40 })
        assertTrue("within 16 KB with the icon's hash too", capped.copy(icon = "f".repeat(64)).toJson().put("resent", true).toString().toByteArray().size <= 16 * 1024)
        // Nothing to show.
        assertNull(NotificationReader.read(sbnOf(chat, plain("", "")), "Chat", null, false))
    }

    // ---------------------------------------------------------------- the switches and sending

    @Test
    fun withTheSwitchOffNothingIsBoundOrSent() {
        val f = start()
        grantAccess()
        val service = Robolectric.setupService(ShareListenerService::class.java)
        service.onListenerConnected()
        assertEquals("Android unbinds it", 1, shadow(service).unbindRequestCount)
        assertNull(app.phone.listener)
        app.prefs.sharedApps = setOf(chat)
        post(service, chat, 1, plain("Mom", "Dinner at 7?"))
        idleFor(1_500)
        assertTrue("nothing sent: ${f.requests}", f.requests.none { it.contains("/api/phone/") })
    }

    @Test
    fun sharingFollowsTheSwitchAndThePickedApps() {
        val f = start()
        // The picked app, with an icon (uploaded once, when the server doesn't have it).
        shadowOf(app.packageManager).installPackage(PackageInfo().apply {
            packageName = chat
            applicationInfo = ApplicationInfo().apply { packageName = chat; nonLocalizedLabel = "Chat" }
        })
        shadowOf(app.packageManager).setApplicationIcon(chat, BitmapDrawable(app.resources, Bitmap.createBitmap(96, 96, Bitmap.Config.ARGB_8888).apply { eraseColor(0xff3366cc.toInt()) }))
        val service = listening(chat)
        val sbn = post(service, chat, 1, chatNotification("Mom" to "Dinner at 7?"))
        post(service, other, 2, plain("Ad", "Buy now"))
        val key = NotificationReader.keyOf(sbn)
        idleUntil("shared") { f.phoneNotifications.containsKey(key) }
        val body = f.phoneNotifications.getValue(key)
        assertEquals("when it was posted on the phone", sbn.postTime, body.getLong("posted"))
        assertFalse("a new one isn't a re-send", body.has("resent"))
        assertEquals(chat, body.getString("app"))
        assertEquals("Chat", body.getString("appName"))
        assertEquals("Mom", body.getString("title"))
        assertEquals("Mom: Dinner at 7?", body.getJSONArray("lines").getString(0))
        assertTrue(body.getJSONArray("actions").getJSONObject(0).getBoolean("reply"))
        val icon = body.getString("icon")
        assertTrue("the icon was uploaded", f.phoneIcons.containsKey(icon))
        idleFor(700)
        assertEquals("only the picked app", 1, f.phoneNotifications.size)
        assertEquals("the first sync, one HEAD, one icon PUT, one notification PUT",
            listOf("DELETE /api/phone/notifications", "HEAD /api/phone/icons/$icon", "PUT /api/phone/icons/$icon", "PUT /api/phone/notifications/$key"),
            f.requests.filter { "/api/phone/" in it })

        // Switched off: everything goes from the server, and Android unbinds the listener.
        val deletes = f.requests.count { it == "DELETE /api/phone/notifications" }
        app.phone.setEnabled(false)
        idleUntil("removed") { f.requests.count { it == "DELETE /api/phone/notifications" } > deletes }
        assertTrue(f.phoneNotifications.isEmpty())
        assertEquals(1, shadow(service).unbindRequestCount)
        // On again: Android binds it again.
        val rebinds = ShadowNotificationListenerService.getRebindRequestCount()
        app.phone.setEnabled(true)
        assertEquals(rebinds + 1, ShadowNotificationListenerService.getRebindRequestCount())
    }

    @Test
    fun aNewOneGoesAtOnceAndItsUpdatesAtMostEveryTwoSeconds() {
        val f = start()
        val service = listening(chat)
        // A new one goes at once (nothing waits without a wake lock).
        val t0 = System.currentTimeMillis()
        val first = post(service, chat, 1, plain("Mom", "one"))
        val key = NotificationReader.keyOf(first)
        idleUntil("sent at once") { f.phoneNotifications.containsKey(key) }
        assertTrue("at once: ${System.currentTimeMillis() - t0} ms", System.currentTimeMillis() - t0 < PhoneNotifications.PUT_DELAY_MS)
        // Two updates right after: one more request, with the latest, after the floor.
        post(service, chat, 1, plain("Mom", "two"))
        post(service, chat, 1, plain("Mom", "three"))
        idleUntil("the latest", 5_000) { f.phoneNotifications.getValue(key).getString("text") == "three" }
        idleFor(500)
        assertEquals(2, f.requests.count { it == "PUT /api/phone/notifications/$key" })
        // An app that re-posts every 0.8 s: at most one PUT per 2 s; the same text with a newer time: nothing (review).
        repeat(6) { i ->
            post(service, chat, 1, plain("Timer", "${i + 1} s"))
            idleFor(800)
        }
        idleFor(2_200)
        val puts = f.requests.count { it == "PUT /api/phone/notifications/$key" } - 2
        assertTrue("6 updates in 4.8 s: $puts PUTs", puts in 2..4)
        assertEquals("6 s", f.phoneNotifications.getValue(key).getString("text"))
        val before = f.requests.count { it == "PUT /api/phone/notifications/$key" }
        post(service, chat, 1, plain("Timer", "6 s") { setWhen(System.currentTimeMillis() + 60_000) })
        idleFor(2_500)
        assertEquals("only the time changed", before, f.requests.count { it == "PUT /api/phone/notifications/$key" })
        // Removed: one DELETE, a second later (removals are batched).
        val t1 = System.currentTimeMillis()
        service.onNotificationRemoved(first, null, 0)
        idleUntil("deleted") { !f.phoneNotifications.containsKey(key) }
        assertTrue("batched: ${System.currentTimeMillis() - t1} ms", System.currentTimeMillis() - t1 >= PhoneNotifications.REMOVE_DELAY_MS - 100)
    }

    @Test
    fun aRestartedServerGetsThemAgain() {
        val f = start()
        val service = listening(chat)
        val key = NotificationReader.keyOf(post(service, chat, 1, plain("Mom", "Dinner at 7?")))
        idleUntil("shared") { f.phoneNotifications.containsKey(key) }
        // The server restarts: its memory is empty, and its stream says hello with a new instance.
        f.phoneNotifications.clear()
        f.instance = "instance2"
        val opened = f.eventsRequests.size
        f.dropStreams()
        idleUntil("reconnected") { f.eventsRequests.size > opened }
        idleUntil("shared again") { f.phoneNotifications.containsKey(key) }
        assertTrue("marked as a re-send", f.phoneNotifications.getValue(key).optBoolean("resent"))
        // A real update afterwards is a normal send again.
        post(service, chat, 1, plain("Mom", "Dinner at 8!"))
        idleUntil("updated") { f.phoneNotifications.getValue(key).getString("text") == "Dinner at 8!" }
        assertFalse(f.phoneNotifications.getValue(key).has("resent"))
    }

    // ---------------------------------------------------------------- requests from PCs

    @Test
    fun repliesButtonsAndDismissalsFromAPc() {
        val f = start()
        val service = listening(chat)
        val sbn = post(service, chat, 1, chatNotification("Mom" to "Dinner at 7?"))
        val key = NotificationReader.keyOf(sbn)
        idleUntil("shared") { f.phoneNotifications.containsKey(key) }
        fun ask(rid: String, kind: String, extra: JSONObject.() -> Unit = {}): JSONObject {
            f.send("notification-request", JSONObject().put("request", rid).put("kind", kind).put("keys", JSONArray().put(key))
                .put("from", desk).put("by", "Desk").apply(extra))
            idleUntil("answer $rid") { f.phoneAnswers.any { it.first == rid } }
            return f.phoneAnswers.first { it.first == rid }.second
        }
        val (replyId, readId) = actionIds(f, key)
        // A reply: through the app's own reply action, with the text in its RemoteInput.
        assertTrue(ask("r1", "reply") { put("action", replyId).put("text", "On my way") }.getBoolean("ok"))
        idleUntil("the app got the reply") { received.any { it.action == REPLY } }
        val results = RemoteInput.getResultsFromIntent(received.first { it.action == REPLY })
        assertEquals("On my way", results?.getCharSequence("reply_text")?.toString())
        // A button.
        assertTrue(ask("r2", "action") { put("action", readId) }.getBoolean("ok"))
        idleUntil("the app got the button") { received.any { it.action == READ } }
        // A button that isn't there, or that moved since the PC got it: refused (review: a stale click).
        assertFalse(ask("r3", "action") { put("action", "a7-000000") }.getBoolean("ok"))
        assertEquals(PhoneNotifications.CHANGED, ask("r3b", "action") { put("action", "a1-ffffff") }.getString("error"))
        // A key the phone doesn't have (gone while Beam wasn't running): a dismissal counts as done, and the server
        // is told to drop it (review: such ones stayed on the PCs for a day).
        f.phoneNotifications["stalekey"] = JSONObject().put("title", "old")
        f.send("notification-request", JSONObject().put("request", "r4").put("kind", "dismiss").put("keys", JSONArray().put("stalekey")))
        idleUntil("answer r4") { f.phoneAnswers.any { it.first == "r4" } }
        assertTrue(f.phoneAnswers.first { it.first == "r4" }.second.getBoolean("ok"))
        idleUntil("dropped from the server") { !f.phoneNotifications.containsKey("stalekey") }
        // Dismissed on the PC: gone from the phone (whose removal then deletes it on the server).
        assertTrue(ask("r5", "dismiss").getBoolean("ok"))
        assertTrue(service.activeNotifications.none { it.key == sbn.key })
    }

    @Test
    fun aButtonThatOpensAScreenSaysOpenItOnThePhone() {
        val f = start()
        val service = listening(chat)
        val key = NotificationReader.keyOf(post(service, chat, 1, chatNotification("Mom" to "Look", opens = true)))
        idleUntil("shared") { f.phoneNotifications.containsKey(key) }
        f.send("notification-request", JSONObject().put("request", "o1").put("kind", "action").put("keys", JSONArray().put(key)).put("action", actionIds(f, key)[1]))
        idleUntil("answer") { f.phoneAnswers.any { it.first == "o1" } }
        val answer = f.phoneAnswers.first { it.first == "o1" }.second
        assertFalse(answer.getBoolean("ok"))
        assertEquals(PhoneNotifications.OPEN_ON_PHONE, answer.getString("error"))
    }

    /** "Dismiss all" while one of them is already gone on the phone: the rest go, and it says ok (review). */
    @Test
    fun aBulkDismissWithOneJustGoneDismissesTheRest() {
        val f = start()
        val service = listening(chat)
        val a = post(service, chat, 1, plain("Mom", "one"))
        val b = post(service, chat, 2, plain("Dad", "two"))
        val c = post(service, chat, 3, plain("Bank", "can't be swiped") { setOngoing(false) }.apply { flags = flags or Notification.FLAG_NO_CLEAR })
        idleUntil("all three shared") { f.phoneNotifications.size == 3 }
        service.onNotificationRemoved(a, null, 8)
        fun dismiss(rid: String, vararg sbns: StatusBarNotification): JSONObject {
            f.send("notification-request", JSONObject().put("request", rid).put("kind", "dismiss")
                .put("keys", JSONArray().apply { sbns.forEach { put(NotificationReader.keyOf(it)) } }).put("from", desk).put("by", "Desk"))
            idleUntil("answer $rid") { f.phoneAnswers.any { it.first == rid } }
            return f.phoneAnswers.first { it.first == rid }.second
        }
        assertTrue(dismiss("bulk1", a, b).getBoolean("ok"))
        assertTrue("the other one was dismissed", service.activeNotifications.none { it.key == b.key })
        // One Android won't let go (FLAG_NO_CLEAR): the PC hears so instead of "Sent ✓".
        val stuck = dismiss("nc1", c)
        assertFalse(stuck.getBoolean("ok"))
        assertEquals(PhoneNotifications.CANT_DISMISS, stuck.getString("error"))
    }

    /** A send that fails once goes again a moment later, while the stream stays up (review: it waited for a reconnect). */
    @Test
    fun aFailedSendIsTriedAgainWithoutAReconnect() {
        val f = start()
        val service = listening(chat)
        f.status = 500 // the server has a problem for a moment (the open stream stays)
        val key = NotificationReader.keyOf(post(service, chat, 1, plain("Mom", "Dinner at 7?")))
        idleUntil("the PUT was tried") { f.requests.contains("PUT /api/phone/notifications/$key") }
        f.status = 0
        val opened = f.eventsRequests.size
        idleUntil("sent again after the backoff", 6_000) { f.phoneNotifications.containsKey(key) }
        assertEquals("no reconnect needed", opened, f.eventsRequests.size)
        assertFalse("the server never took it: not a re-send", f.phoneNotifications.getValue(key).has("resent"))

        // A 429, and another one a second later: the backoff too (it used to wait for a reconnect).
        f.status = 429
        val busy = NotificationReader.keyOf(post(service, chat, 2, plain("Dad", "Running late")))
        idleUntil("tried twice", 5_000) { f.requests.count { it == "PUT /api/phone/notifications/$busy" } >= 2 }
        f.status = 0
        idleUntil("sent after the backoff", 6_000) { f.phoneNotifications.containsKey(busy) }
        assertEquals("no reconnect needed", opened, f.eventsRequests.size)
        assertFalse(f.phoneNotifications.getValue(busy).has("resent"))
    }

    /**
     * `resent` only for what the server most likely has already. A PUT it never took that goes at a reconnect is a
     * normal send (the PCs judge it by `posted`); a picked app's notifications already in the shade, and what the
     * server had when the listener connects again, are re-sends.
     */
    @Test
    fun onlyWhatTheServerHadIsAReSend() {
        val f = start()
        val service = listening(chat)
        // Never taken: the server fails it (at once and 2 s later), then it goes at a reconnect, before its next try.
        f.status = 500
        val failed = NotificationReader.keyOf(post(service, chat, 1, plain("Mom", "Dinner at 7?")))
        idleUntil("tried twice", 8_000) { f.requests.count { it == "PUT /api/phone/notifications/$failed" } >= 2 }
        f.status = 0
        val opened = f.eventsRequests.size
        app.connection.restart()
        idleUntil("sent at the reconnect (its next try is 10 s away)", 6_000) { f.phoneNotifications.containsKey(failed) }
        assertTrue("it went at the reconnect", f.eventsRequests.size > opened)
        assertFalse("never taken: a normal send", f.phoneNotifications.getValue(failed).has("resent"))

        // An app picked with a notification already in the shade: a re-send (no balloon for an old one).
        val shipped = NotificationReader.keyOf(post(service, other, 2, plain("Shop", "Your order shipped")))
        idleFor(700)
        assertFalse("not picked yet", f.phoneNotifications.containsKey(shipped))
        app.phone.setAppShared(other, true)
        idleUntil("the picked app's") { f.phoneNotifications.containsKey(shipped) }
        assertTrue(f.phoneNotifications.getValue(shipped).optBoolean("resent"))

        // The listener connects again: what the server had goes again, as re-sends.
        val puts = f.requests.count { it == "PUT /api/phone/notifications/$failed" }
        service.onListenerDisconnected()
        service.onListenerConnected()
        idleUntil("sent again after the sync") {
            f.requests.count { it == "PUT /api/phone/notifications/$failed" } > puts && f.phoneNotifications.containsKey(failed)
        }
        assertTrue(f.phoneNotifications.getValue(failed).optBoolean("resent"))
    }

    /** Notification access taken away in Android's settings, the switch still on: the server's copy goes too. */
    @Test
    fun takingAccessAwayRemovesThemFromTheServer() {
        val f = start()
        val service = listening(chat)
        val key = NotificationReader.keyOf(post(service, chat, 1, plain("Mom", "Dinner at 7?")))
        idleUntil("shared") { f.phoneNotifications.containsKey(key) }
        val deletes = f.requests.count { it == "DELETE /api/phone/notifications" }
        Settings.Secure.putString(app.contentResolver, "enabled_notification_listeners", "")
        service.onListenerDisconnected()
        idleUntil("removed") { f.requests.count { it == "DELETE /api/phone/notifications" } > deletes }
        assertTrue(f.phoneNotifications.isEmpty())
        assertTrue("the switch stays on (for when access comes back)", app.phone.enabled)
        assertFalse(app.phone.sharing)
    }

    /** The listener was gone a while (Android tells it nothing then): what went away meanwhile isn't sent again. */
    @Test
    fun aListenerReconnectSendsOnlyWhatsInTheShadeNow() {
        val f = start()
        val service = listening(chat)
        val gone = post(service, chat, 1, plain("Mom", "Dinner at 7?"))
        val stays = post(service, chat, 2, plain("Dad", "Running late"))
        idleUntil("both shared") { f.phoneNotifications.size == 2 }
        // Gone from the shade while the listener was disconnected (no callback), then it connects again.
        val deletes = f.requests.count { it == "DELETE /api/phone/notifications" }
        service.onListenerDisconnected()
        service.cancelNotification(gone.key)
        service.onListenerConnected()
        idleUntil("synced") {
            f.requests.count { it == "DELETE /api/phone/notifications" } > deletes && f.phoneNotifications.size == 1
        }
        idleFor(1_500)
        assertEquals(setOf(NotificationReader.keyOf(stays)), f.phoneNotifications.keys.toSet())
        assertTrue("the server had it: a re-send", f.phoneNotifications.getValue(NotificationReader.keyOf(stays)).optBoolean("resent"))
        assertEquals(setOf(NotificationReader.keyOf(stays)), app.phone.sharedKeys)
        assertFalse(NotificationReader.keyOf(gone) in f.phoneNotifications.keys)
    }

    /**
     * Unpair: the server's copy goes while the sign-in still works; paired with another server, nothing is shared
     * there until the "Show on" setup is confirmed there (review).
     */
    @Test
    fun unpairClearsTheServersCopyAndAnotherServerAsksFirst() {
        val first = start()
        val service = listening(chat)
        val key = NotificationReader.keyOf(post(service, chat, 1, plain("Mom", "Dinner at 7?")))
        idleUntil("shared") { first.phoneNotifications.containsKey(key) }
        val deletes = first.requests.count { it == "DELETE /api/phone/notifications" }
        app.unpair()
        idleUntil("the first server's copy went") { first.requests.count { it == "DELETE /api/phone/notifications" } > deletes }
        assertTrue(first.phoneNotifications.isEmpty())

        val second = FakeBeam(listOf("stream-modes", "phone-notifications"))
        try {
            second.devices = JSONArray().put(Device(desk, "Desk", "windows", true, System.currentTimeMillis()).toJson())
            app.completePairing(Pairing.Link(second.url, "k"), "Pixel", "fakebeam02")
            idleUntil("connected") { app.connection.streamId != null && app.phone.serverReady }
            assertFalse("the setup is per server", app.prefs.phoneSetupDone)
            assertFalse("off until confirmed there", app.phone.enabled)
            service.onListenerConnected()
            post(service, chat, 2, plain("Dad", "Call me"))
            idleFor(1_500)
            assertTrue(second.requests.none { "/api/phone/" in it })
        } finally {
            second.close()
        }
    }

    /**
     * Settings → the server's address → another Beam → "Switch anyway", with a send still in flight: the old server's
     * copy goes to the old server (after that send, though the app already points at the new one), none of it reaches
     * the new one, and that gets nothing until the "Show on" setup is confirmed there (1.5 review and its re-check).
     */
    @Test
    fun switchAnywayWithASendInFlightClearsTheOldServer() {
        val first = start()
        val service = listening(chat)
        val key = NotificationReader.keyOf(post(service, chat, 1, plain("Mom", "Dinner at 7?")))
        idleUntil("shared") { first.phoneNotifications.containsKey(key) }
        val second = FakeBeam(listOf("stream-modes", "phone-notifications")).apply { serverId = "fakebeam02" }
        try {
            first.phonePutDelayMs = 3_000 // the next send stays in flight while the user switches
            val inFlight = NotificationReader.keyOf(post(service, chat, 2, plain("Dad", "Call me")))
            idleUntil("a send in flight") { first.requests.contains("PUT /api/phone/notifications/$inFlight") }
            val deletes = first.requests.count { it == "DELETE /api/phone/notifications" }
            val settings = Robolectric.buildActivity(SettingsActivity::class.java).setup()
            settings.get().findViewById<View>(R.id.rowServer).performClick()
            val ask = ShadowDialog.getLatestDialog() as AlertDialog
            ask.window!!.decorView.firstEditText()!!.setText(second.url)
            ask.getButton(DialogInterface.BUTTON_POSITIVE).performClick()
            idleUntil("another Beam: it asks first") { ShadowDialog.getLatestDialog() !== ask }
            (ShadowDialog.getLatestDialog() as AlertDialog).getButton(DialogInterface.BUTTON_POSITIVE).performClick()
            idleUntil("switched") { app.prefs.serverId == "fakebeam02" }
            idleUntil("the old server's copy went", 8_000) { first.requests.count { it == "DELETE /api/phone/notifications" } > deletes }
            idleFor(500)
            assertTrue("nothing left on the old server: ${first.phoneNotifications.keys}", first.phoneNotifications.isEmpty())
            assertFalse("off until it's set up there", app.phone.enabled)
            post(service, chat, 3, plain("Sis", "Hi"))
            idleFor(1_500)
            assertTrue("nothing at the new server: ${second.requests}", second.requests.none { "/api/phone/" in it })
            settings.pause().stop().destroy()
        } finally {
            second.close()
        }
    }

    /**
     * The process starts again (an update, a reboot): what the PCs had goes again as re-sends, and what came while it
     * was down (posted after the newest one the server took) as new, so the PCs judge it by `posted` (re-check).
     */
    @Test
    fun afterARestartWhatCameMeanwhileIsNew() {
        val f = start()
        val service = listening(chat)
        val before = NotificationReader.keyOf(post(service, chat, 1, plain("Mom", "Dinner at 7?")))
        idleUntil("shared") { f.phoneNotifications.containsKey(before) }
        Thread.sleep(5)
        newProcess()
        val added = shadow(service).addActiveNotification(chat, 2, plain("Dad", "Call me")) // nobody hears it
        val meanwhile = NotificationReader.keyOf(service.activeNotifications.first { it.key == added })
        val deletes = f.requests.count { it == "DELETE /api/phone/notifications" }
        service.onListenerConnected()
        idleUntil("synced") {
            f.requests.count { it == "DELETE /api/phone/notifications" } > deletes && f.phoneNotifications.keys.containsAll(listOf(before, meanwhile))
        }
        assertTrue("on the PCs before: a re-send", f.phoneNotifications.getValue(before).optBoolean("resent"))
        assertFalse("came while it was down: new", f.phoneNotifications.getValue(meanwhile).has("resent"))
    }

    /**
     * A clock that was ahead (then set right) doesn't stick: a `posted` time a month ahead doesn't move
     * `phoneSyncedAt`, and one saved while the clock was ahead counts as now. What comes while the process is down
     * afterwards still pops up on the PCs (final check of the 1.5 review).
     */
    @Test
    @Suppress("DEPRECATION")
    fun aClockThatWasAheadDoesNotStick() {
        val f = start()
        val service = listening(chat)
        val month = 30L * 24 * 3600 * 1000
        // Posted while the clock was a month ahead, sent once it was right again.
        val ahead = StatusBarNotification(chat, chat, 900, null, android.os.Process.myUid(), 0, 0, plain("Clock", "ahead"),
            android.os.Process.myUserHandle(), System.currentTimeMillis() + month)
        service.onNotificationPosted(ahead, null)
        idleUntil("taken") { f.phoneNotifications.containsKey(NotificationReader.keyOf(ahead)) }
        assertTrue("not moved by a time far ahead", app.prefs.phoneSyncedAt <= System.currentTimeMillis())

        // One saved while the clock was ahead: after a restart it counts as now, and the next one taken sets it right.
        app.prefs.phoneSyncedAt = System.currentTimeMillis() + month
        newProcess()
        val deletes = f.requests.count { it == "DELETE /api/phone/notifications" }
        service.onListenerConnected()
        idleUntil("synced") { f.requests.count { it == "DELETE /api/phone/notifications" } > deletes }
        Thread.sleep(5)
        val mom = NotificationReader.keyOf(post(service, chat, 1, plain("Mom", "Dinner at 7?")))
        idleUntil("shared") { f.phoneNotifications.containsKey(mom) }
        idleUntil("set right") { app.prefs.phoneSyncedAt <= System.currentTimeMillis() }

        // So after another restart, one that came while the process was down is new to the PCs.
        Thread.sleep(5)
        newProcess()
        val added = shadow(service).addActiveNotification(chat, 2, plain("Dad", "Call me")) // nobody hears it
        val meanwhile = NotificationReader.keyOf(service.activeNotifications.first { it.key == added })
        service.onListenerConnected()
        idleUntil("sent after the restart") { f.phoneNotifications.containsKey(meanwhile) }
        assertFalse("new to the PCs", f.phoneNotifications.getValue(meanwhile).has("resent"))
    }

    /** A change while the notification's PUT is still on its way waits the full 2 s from when that PUT started. */
    @Test
    fun aChangeDuringASendWaitsTheFullFloor() {
        val f = start()
        val service = listening(chat)
        f.phonePutDelayMs = 300
        val key = NotificationReader.keyOf(post(service, chat, 1, plain("Mom", "one")))
        idleUntil("the first PUT") { f.requests.contains("PUT /api/phone/notifications/$key") }
        val t1 = System.currentTimeMillis()
        post(service, chat, 1, plain("Mom", "two")) // while the first is in flight
        idleUntil("the second PUT", 5_000) { f.requests.count { it == "PUT /api/phone/notifications/$key" } >= 2 }
        val gap = System.currentTimeMillis() - t1
        assertTrue("the floor: $gap ms", gap >= PhoneNotifications.UPDATE_EVERY_MS - 300)
        idleUntil("the latest") { f.phoneNotifications.getValue(key).getString("text") == "two" }
    }

    /** The phone's process starts again: a new [PhoneNotifications] (nothing in memory; the prefs stay). */
    private fun newProcess() {
        BeamApp::class.java.getDeclaredField("phone").apply { isAccessible = true }.set(app, PhoneNotifications(app))
    }

    private fun View.firstEditText(): EditText? = when (this) {
        is EditText -> this
        is ViewGroup -> (0 until childCount).firstNotNullOfOrNull { getChildAt(it).firstEditText() }
        else -> null
    }

    /** Content (a notification, a reply) never reaches the phone's prefs or files (from the 1.5 review). */
    @Test
    fun noContentInThePhonesPrefsOrFiles() {
        val f = start()
        val service = listening(chat)
        val sbn = post(service, chat, 1, chatNotification("Mom" to "$MARK dinner"))
        val key = NotificationReader.keyOf(sbn)
        idleUntil("shared") { f.phoneNotifications.containsKey(key) }
        f.send("notification-request", JSONObject().put("request", "rp1").put("kind", "reply").put("keys", JSONArray().put(key))
            .put("action", actionIds(f, key)[0]).put("text", "$MARK reply").put("from", desk).put("by", "Desk"))
        idleUntil("answered") { f.phoneAnswers.any { it.first == "rp1" } }
        idleUntil("the app got the reply") { received.any { it.action == REPLY } }
        idleFor(2_500) // saves (the saved copy, prefs) settle
        app.repo.saveNow()
        val prefs = app.getSharedPreferences("beam", Context.MODE_PRIVATE).all.filterValues { it.toString().contains(MARK) }
        val files = app.dataDir.walkTopDown().filter { it.isFile }
            .filter { file -> runCatching { String(file.readBytes(), Charsets.ISO_8859_1).contains(MARK) }.getOrDefault(false) }.toList()
        assertTrue("prefs: ${prefs.keys}", prefs.isEmpty())
        assertTrue("files: $files", files.isEmpty())
    }

    @Test
    fun anOlderServerHidesItAndNothingIsSent() {
        val f = start(listOf("stream-modes"))
        assertFalse(app.phone.serverReady)
        grantAccess()
        app.prefs.sharedApps = setOf(chat)
        app.prefs.shareNotifications = true
        val service = Robolectric.setupService(ShareListenerService::class.java)
        service.onListenerConnected()
        post(service, chat, 1, plain("Mom", "Dinner at 7?"))
        idleFor(1_500)
        assertTrue(f.requests.none { "/api/phone/" in it })
    }

    @Test
    fun theTileIsUnavailableOnAnOlderServerAndSwitchesOffWithoutAccess() {
        start(listOf("stream-modes"))
        val tile = Robolectric.setupService(PcNotificationsTileService::class.java)
        tile.onStartListening()
        assertEquals(android.service.quicksettings.Tile.STATE_UNAVAILABLE, tile.qsTile.state)
        // On, but access was taken away: a tap switches it off.
        app.prefs.shareNotifications = true
        tile.onClick()
        assertFalse(app.phone.enabled)
    }

    @Test
    fun theTileSwitchesItAndShowsWhich() {
        start()
        grantAccess()
        app.prefs.phoneSetupDone = true
        val tile = Robolectric.setupService(PcNotificationsTileService::class.java)
        tile.onStartListening()
        assertEquals(android.service.quicksettings.Tile.STATE_INACTIVE, tile.qsTile.state)
        tile.onClick()
        assertTrue(app.phone.enabled)
        assertEquals(android.service.quicksettings.Tile.STATE_ACTIVE, tile.qsTile.state)
        tile.onClick()
        assertFalse(app.phone.enabled)
        assertEquals(android.service.quicksettings.Tile.STATE_INACTIVE, tile.qsTile.state)
    }

    // ---------------------------------------------------------------- the settings screen

    private fun texts(v: View): List<String> = when (v) {
        is TextView -> listOf(v.text.toString())
        is ViewGroup -> (0 until v.childCount).flatMap { texts(v.getChildAt(it)) }
        else -> emptyList()
    }

    @Test
    fun theSettingsScreenSetsItUp() {
        val f = start()
        // Two apps on the phone; one of them was seen notifying lately.
        val pm = shadowOf(app.packageManager)
        for ((pkg, label) in listOf(chat to "Chat", other to "Other")) {
            val info = ApplicationInfo().apply { packageName = pkg; nonLocalizedLabel = label }
            pm.installPackage(PackageInfo().apply { packageName = pkg; applicationInfo = info })
            pm.addResolveInfoForIntent(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER),
                ResolveInfo().apply { activityInfo = ActivityInfo().apply { packageName = pkg; name = "$pkg.Main"; applicationInfo = info } })
        }
        app.prefs.recentNotifiers = mapOf(other to System.currentTimeMillis())
        val screen = Robolectric.buildActivity(PhoneNotificationsActivity::class.java).setup()
        val a = screen.get()
        val list = a.findViewById<RecyclerView>(R.id.list)
        idleUntil("the apps") { (list.adapter?.itemCount ?: 0) == 3 }
        list.measure(View.MeasureSpec.makeMeasureSpec(1000, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(6000, View.MeasureSpec.EXACTLY))
        list.layout(0, 0, 1000, 6000)
        fun appRows() = (1 until list.childCount).map { list.getChildAt(it) }
        // Off, and the access setup shows. Every app is off; the one seen notifying comes first.
        assertFalse(a.findViewById<MaterialSwitch>(R.id.master).isChecked)
        assertTrue(a.findViewById<View>(R.id.accessCard).isVisible)
        assertEquals(listOf("Other", "Chat"), appRows().map { it.findViewById<TextView>(R.id.title).text.toString() })
        assertTrue(appRows().none { it.findViewById<MaterialSwitch>(R.id.toggle).isChecked })
        // Search.
        a.findViewById<TextView>(R.id.search).text = "cha"
        idleUntil("filtered") { list.adapter?.itemCount == 2 }
        a.findViewById<TextView>(R.id.search).text = ""
        idleUntil("all again") { list.adapter?.itemCount == 3 }
        list.layout(0, 0, 1000, 6000)
        appRows().first { it.findViewById<TextView>(R.id.title).text == "Chat" }.performClick()
        assertEquals(setOf(chat), app.prefs.sharedApps)

        // Switching it on without access: Android's access screen, then (granted) the first "Show on" step.
        a.findViewById<View>(R.id.rowMaster).performClick()
        assertEquals(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS, shadowOf(a).nextStartedActivity.action)
        assertFalse(app.phone.enabled)
        grantAccess()
        screen.pause().resume()
        val dialog = ShadowDialog.getLatestDialog() as AlertDialog
        val names = (0 until dialog.listView.adapter.count).map { dialog.listView.adapter.getItem(it).toString() }
        assertEquals(listOf("Desk · Windows", "Laptop · Windows", "Chrome · Browser"), names)
        // The Windows PCs come checked: confirming shows them there, and nowhere else.
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick()
        idle() // the dialog hands the click to its handler
        assertTrue(app.phone.enabled)
        idleUntil("shown on the two PCs") {
            app.repo.state.value.devices.filter { it.phoneNotifications }.map { it.name }.toSet() == setOf("Desk", "Laptop")
        }
        assertEquals(2, f.requests.count { it.endsWith("/settings") })
        // The Show on list follows the server.
        idleUntil("show on") { texts(a.findViewById(R.id.showOn)).containsAll(listOf("Desk", "Laptop", "Chrome")) }
        screen.pause().stop().destroy()
    }

    companion object {
        private const val MARK = "zq-phone-content-31"
        private const val REPLY = "app.beam.android.test.REPLY"
        private const val READ = "app.beam.android.test.READ"
    }
}
