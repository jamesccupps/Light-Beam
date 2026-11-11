package app.beam.android

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.Pairing
import app.beam.android.notify.Notifier
import app.beam.android.ui.FilesActivity
import app.beam.android.ui.MainActivity
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import java.time.Duration
import java.util.concurrent.Callable
import java.util.concurrent.Executors

/**
 * (1.19, server 1.33) The alerts inbox on the phone, against [FakeBeam]: an `inbox` event that the server says pops up
 * is a notification (its app's name and title, its text; priority 4-5 on the urgent channel; Open for its link), one
 * that doesn't (quiet, muted) isn't, the same alert twice is one; after a reconnect, what came meanwhile (the first time
 * with a server: nothing old); "Alerts" in the menu, and the list hosted like Shared folders (`#alerts`).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class AppAlerts119Test {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private val KEY = "bt_the_apps_own_token_0001"
    private var fake: FakeBeam? = null
    private val opened = mutableListOf<ActivityController<*>>()

    /** Every screen a test opens is closed after it (a screen left open spoils a later test's window: Look114Test). */
    private fun <C : ActivityController<*>> keep(c: C): C = c.also { opened += it }

    @After
    fun tearDown() {
        for (c in opened.asReversed()) runCatching { c.pause().stop().destroy() }
        opened.clear()
        app.connection.release("service")
        if (app.prefs.paired) app.unpair()
        fake?.close()
        CookieManager.getInstance().removeAllCookies(null)
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

    /** Network calls through the app's own client must not run on the main (test) thread. */
    private fun <T> offMain(block: () -> T): T {
        val ex = Executors.newSingleThreadExecutor()
        try {
            return ex.submit(Callable { block() }).get()
        } finally {
            ex.shutdown()
        }
    }

    private fun notifications(): List<Notification> = shadowOf(app.getSystemService(NotificationManager::class.java)).allNotifications
    private fun Notification.title() = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
    private fun Notification.text() = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()

    private fun start(features: List<String> = listOf("stream-modes", "inbox")): FakeBeam {
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        val f = FakeBeam(features).also { fake = it }
        app.completePairing(Pairing.Link(f.url, KEY), "Pixel", "fakebeam01")
        app.connection.acquire("service")
        idleUntil("connected") { app.connection.streamId != null && app.repo.state.value.info != null }
        return f
    }

    private fun alert(id: String, title: String, text: String, priority: Int = 3, extra: JSONObject.() -> Unit = {}) =
        JSONObject().put("id", id).put("sender", "a1b2c3d4").put("at", System.currentTimeMillis()).put("title", title).put("text", text).put("priority", priority).apply(extra)

    private fun sender(name: String = "Stock Watcher", muted: Boolean = false) =
        JSONObject().put("id", "a1b2c3d4").put("name", name).put("muted", muted).put("snoozeUntil", 0)

    @Test
    fun anAlertThatPopsUpIsANotificationOnItsChannel() {
        val f = start()
        f.send("inbox", JSONObject().put("alert", alert("1111111111111111", "Back in stock", "UniFi U7 Pro", 4) {
            put("emojis", "📦"); put("click", "https://store.example.com/u7")
        }).put("notify", true).put("sender", sender()))
        idleUntil("a notification") { notifications().any { it.title() == "Stock Watcher: 📦 Back in stock" } }
        val n = notifications().first { it.title() == "Stock Watcher: 📦 Back in stock" }
        assertEquals(Notifier.CH_APP_ALERTS_URGENT, n.channelId)
        assertEquals("UniFi U7 Pro", n.text())
        assertEquals(listOf("Open"), n.actions.map { it.title.toString() })
        assertEquals(FilesActivity::class.java.name, shadowOf(n.contentIntent).savedIntent.component?.className)
        // Priority 3: the ordinary channel. Not to pop up (quiet, muted): nothing. The same one again: once.
        f.send("inbox", JSONObject().put("alert", alert("2222222222222222", "", "Price drop", 3)).put("notify", true).put("sender", sender()))
        f.send("inbox", JSONObject().put("alert", alert("3333333333333333", "", "all quiet", 2)).put("notify", false).put("sender", sender()))
        f.send("inbox", JSONObject().put("alert", alert("1111111111111111", "Back in stock", "UniFi U7 Pro", 4)).put("notify", true).put("sender", sender()))
        idleUntil("the second") { notifications().any { it.text() == "Price drop" } }
        idle(300)
        val second = notifications().first { it.text() == "Price drop" }
        assertEquals(Notifier.CH_APP_ALERTS, second.channelId)
        assertEquals("Stock Watcher", second.title())
        assertFalse(notifications().any { it.text() == "all quiet" })
        assertEquals(1, notifications().count { it.text() == "UniFi U7 Pro" })
    }

    @Test
    fun afterAReconnectWhatCameMeanwhileIsShownOnceNothingOldTheFirstTime() {
        val f = start()
        val list = JSONArray().put(alert("4444444444444444", "Before", "old news", 4))
        f.inbox = JSONObject().put("senders", JSONArray().put(JSONObject().put("id", "beam").put("name", "Beam").put("builtIn", true)).put(sender())).put("alerts", list).put("read", 0)
        assertEquals(1, offMain { app.api!!.inbox() }.getJSONArray("alerts").length())
        app.prefs.inboxSeenUntil = 0L // (the connect's own catch-up may have looked already: this is the first look)
        offMain { app.appAlerts.catchUp() }
        assertTrue("the first look sets the start", app.prefs.inboxSeenUntil > 0)
        assertFalse(notifications().any { it.text() == "old news" })
        list.put(alert("5555555555555555", "Meanwhile", "came while away", 4))
        list.put(alert("6666666666666666", "", "Beam's own", 4) { put("sender", "beam") })
        list.put(alert("7777777777777777", "", "a quiet one", 2))
        offMain { app.appAlerts.catchUp() }
        assertTrue(notifications().any { it.text() == "came while away" })
        assertFalse(notifications().any { it.text() == "Beam's own" || it.text() == "a quiet one" })
        offMain { app.appAlerts.catchUp() }
        assertEquals(1, notifications().count { it.text() == "came while away" })
    }

    @Test
    fun alertsInTheMenuOpenTheListHostedLikeSharedFolders() {
        val f = start()
        val main = keep(Robolectric.buildActivity(MainActivity::class.java).setup()).get()
        idleUntil("the menu entry") { main.findViewById<androidx.appcompat.widget.Toolbar>(R.id.toolbar).menu.findItem(R.id.action_alerts)?.isVisible == true }
        val a = keep(Robolectric.buildActivity(FilesActivity::class.java, FilesActivity.alertsIntent(app)).setup())
        var web: WebView? = null
        idleUntil("the page") {
            web = a.get().findViewById<FrameLayout>(R.id.page).getChildAt(0) as? WebView
            web?.let { shadowOf(it).lastLoadedUrl } != null
        }
        assertEquals("${f.url}/#alerts", shadowOf(web!!).lastLoadedUrl)
        a.get().onBackPressedDispatcher.onBackPressed()
        idle()
        assertTrue(shadowOf(web!!).lastEvaluatedJavascript.contains("alertsBack()"))
        shadowOf(web!!).lastEvaluatedJavascriptCallback.onReceiveValue("false")
        idle()
        assertTrue(a.get().isFinishing)
    }

    @Test
    fun anOlderServerHasNoAlertsEntry() {
        start(features = listOf("stream-modes"))
        val main = keep(Robolectric.buildActivity(MainActivity::class.java).setup()).get()
        idle(200)
        assertFalse(main.findViewById<androidx.appcompat.widget.Toolbar>(R.id.toolbar).menu.findItem(R.id.action_alerts)?.isVisible == true)
    }
}
