package app.beam.android

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Looper
import android.view.View
import android.widget.EditText
import android.widget.TextView
import androidx.core.view.isVisible
import androidx.test.core.app.ApplicationProvider
import app.beam.android.core.BeamApi
import app.beam.android.core.Pairing
import app.beam.android.core.PollResult
import app.beam.android.core.SignInClient
import app.beam.android.core.SignInTicket
import app.beam.android.core.TestNet
import app.beam.android.core.Updates
import app.beam.android.data.AppUpdater
import app.beam.android.data.Repository
import app.beam.android.service.InstallReceiver
import app.beam.android.ui.ApproveActivity
import app.beam.android.ui.MainActivity
import app.beam.android.ui.PairActivity
import app.beam.android.ui.UpdateActivity
import kotlinx.coroutines.runBlocking
import okhttp3.Request
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowDialog
import java.io.File
import java.time.Duration
import java.util.UUID
import kotlin.random.Random

/** Steam-style sign-in and self-updates, driven through the real screens against a scratch server. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class SignInSmokeTest {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()
    private val url = System.getProperty("beam.url").orEmpty()
    private val key = System.getProperty("beam.key").orEmpty()

    @Before
    fun setUp() {
        assumeTrue("Set BEAM_TEST_URL and BEAM_TEST_KEY", url.isNotEmpty() && key.isNotEmpty())
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
    }

    private fun idleUntil(what: String, timeoutMs: Long = 20_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(50))
            if (condition()) return
            Thread.sleep(40)
        }
        fail("Timed out waiting for $what")
    }

    private fun notifications(): List<Notification> = shadowOf(app.getSystemService(NotificationManager::class.java)).allNotifications
    private fun Notification.title() = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
    private fun Notification.text() = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()

    private fun signedInMain(): ActivityController<MainActivity> {
        val serverId = SignInClient(url).hello().serverId
        app.completePairing(Pairing.Link(url, key), "Robo Phone", serverId)
        val main = Robolectric.buildActivity(MainActivity::class.java).setup()
        idleUntil("connected") { app.repo.state.value.let { it.loaded && it.conn == Repository.Conn.CONNECTED } }
        return main
    }

    private fun pollNow(client: SignInClient, ticket: SignInTicket) = client.poll(ticket, wait = false)

    @Test
    fun approvingSignInsFromThisPhone() {
        val main = signedInMain()
        val newDevice = SignInClient(url)

        // 1. Scanning the approve QR code opens the sheet; Approve signs the new device in.
        val first = newDevice.createRequest("Work Laptop", "windows")
        idleUntil("sign-in notification") { notifications().any { it.title() == "Work Laptop wants to sign in" } }
        val n = notifications().first { it.title() == "Work Laptop wants to sign in" }
        assertTrue(n.text()!!.startsWith("Code ${first.code} · from "))
        assertEquals(listOf("Deny", "Approve"), n.actions.map { it.title.toString() })
        assertEquals(Notification.VISIBILITY_PRIVATE, n.visibility)

        main.get().handleScanned(first.approveUrl)
        val sheetIntent = shadowOf(main.get()).nextStartedActivity
        assertEquals(ApproveActivity::class.java.name, sheetIntent.component?.className)
        val approve = Robolectric.buildActivity(ApproveActivity::class.java, sheetIntent).setup()
        idleUntil("request details") { ShadowDialog.getLatestDialog()?.findViewById<TextView>(R.id.title)?.text?.toString() == "Work Laptop wants to sign in" }
        val sheet = ShadowDialog.getLatestDialog()
        assertEquals(first.code, sheet.findViewById<TextView>(R.id.code).text.toString())
        assertTrue(sheet.findViewById<TextView>(R.id.where).text.startsWith("From "))
        sheet.findViewById<View>(R.id.approve).performClick()
        // API v3: the approved device gets its own token (older servers: the key).
        idleUntil("approved on the server") { pollNow(newDevice, first).let { it is PollResult.Approved && (it.key == key || it.key.startsWith("bt_")) } }
        idleUntil("notification withdrawn") { notifications().none { it.title() == "Work Laptop wants to sign in" } }
        idleUntil("sheet says done") { sheet.findViewById<TextView>(R.id.message).text.contains("is signed in") }
        approve.pause().stop().destroy()

        // 2. The notification's Deny action.
        val second = newDevice.createRequest("Stranger PC", "windows")
        idleUntil("second notification") { notifications().any { it.title() == "Stranger PC wants to sign in" } }
        notifications().first { it.title() == "Stranger PC wants to sign in" }.actions.first { it.title == "Deny" }.actionIntent.send()
        idleUntil("denied on the server") { pollNow(newDevice, second) == PollResult.Denied }
        idleUntil("second notification withdrawn") { notifications().none { it.title() == "Stranger PC wants to sign in" } }

        // 3. The notification's Approve action (opens Beam, which approves right away).
        val third = newDevice.createRequest("Home iMac", "mac")
        idleUntil("third notification") { notifications().any { it.title() == "Home iMac wants to sign in" } }
        shadowOf(app).clearNextStartedActivities()
        notifications().first { it.title() == "Home iMac wants to sign in" }.actions.first { it.title == "Approve" }.actionIntent.send()
        val approveNow = shadowOf(app).nextStartedActivity
        assertEquals(ApproveActivity::class.java.name, approveNow.component?.className)
        val auto = Robolectric.buildActivity(ApproveActivity::class.java, approveNow).setup()
        idleUntil("approved from the notification") { pollNow(newDevice, third) is PollResult.Approved }
        auto.pause().stop().destroy()

        // 4. Requests made while disconnected show up after a reconnect (GET /api/login-requests).
        val fourth = newDevice.createRequest("Offline Tablet", "android")
        app.connection.restart()
        idleUntil("caught-up notification") { notifications().any { it.title() == "Offline Tablet wants to sign in" } }
        TestNet.device(url, key, "Cleanup", "cli").answerLoginRequest(fourth.code, approve = false)
        idleUntil("withdrawn after it was settled elsewhere") { notifications().none { it.title() == "Offline Tablet wants to sign in" } }

        // 5. Other codes.
        shadowOf(main.get()).clearNextStartedActivities()
        main.get().handleScanned(Pairing.link(url, key))
        main.get().handleScanned("hello")
        assertEquals(null, shadowOf(main.get()).nextStartedActivity)
        main.pause().stop().destroy()
    }

    /**
     * API v3 servers hand a new device its own token (never the master key), which then signs it in;
     * older servers hand out the key itself.
     */
    private fun assertOwnKey() {
        val k = app.prefs.key!!
        assertTrue(k, k == key || (k.startsWith("bt_") && app.prefs.hasDeviceToken))
        val ok = java.util.concurrent.Executors.newSingleThreadExecutor().submit(java.util.concurrent.Callable { app.api!!.me() }).get()
        assertTrue(ok)
    }

    @Test
    fun signingInThisPhoneWithThePassword() {
        val admin = TestNet.device(url, key, "Admin", "cli")
        admin.setPassword("correct horse battery")
        try {
            val pair = Robolectric.buildActivity(PairActivity::class.java).setup()
            val a = pair.get()
            // A bare host:port, like people type it (https is tried first, then http).
            a.findViewById<EditText>(R.id.link).setText(url.removePrefix("http://"))
            a.findViewById<EditText>(R.id.password).setText("not the password")
            a.findViewById<View>(R.id.pair).performClick()
            idleUntil("wrong password message") { a.findViewById<TextView>(R.id.error).let { it.isVisible && it.text.contains("isn") } }
            assertTrue(!app.prefs.paired)

            a.findViewById<EditText>(R.id.password).setText("correct horse battery")
            a.findViewById<EditText>(R.id.name).setText("Password Phone")
            a.findViewById<View>(R.id.pair).performClick()
            idleUntil("signed in with the password") { app.prefs.paired }
            assertEquals(url, app.prefs.baseUrl)
            assertOwnKey()
            assertEquals(SignInClient(url).hello().serverId, app.prefs.serverId)
            assertEquals("Password Phone", app.prefs.deviceName)
            assertEquals(MainActivity::class.java.name, shadowOf(a).nextStartedActivity.component?.className)
            pair.pause().stop().destroy()
        } finally {
            admin.setPassword("")
        }
    }

    @Test
    fun signingInThisPhoneWithAnotherDevice() {
        val pair = Robolectric.buildActivity(PairActivity::class.java).setup()
        val a = pair.get()
        a.findViewById<EditText>(R.id.link).setText(url)
        a.findViewById<View>(R.id.another).performClick()
        idleUntil("code shown") {
            ShadowDialog.getLatestDialog()?.findViewById<TextView>(R.id.code)?.text?.length == 9
        }
        val dialog = ShadowDialog.getLatestDialog()
        val code = dialog.findViewById<TextView>(R.id.code).text.toString()
        idleUntil("QR code shown") { dialog.findViewById<android.widget.ImageView>(R.id.qr).drawable != null }
        // Another device approves it (as the scan / notification flow above does).
        val approver = TestNet.device(url, key, "Approving phone", "android")
        idleUntil("request visible to the approver") { approver.loginRequests().any { it.code == code && it.platform == "android" } }
        approver.answerLoginRequest(code, approve = true)
        idleUntil("signed in by approval") { app.prefs.paired }
        assertOwnKey()
        assertEquals(url, app.prefs.baseUrl)
        assertEquals(MainActivity::class.java.name, shadowOf(a).nextStartedActivity.component?.className)
        pair.pause().stop().destroy()
    }

    @Test
    fun updatesAreDownloadedVerifiedAndOffered() {
        val dist = System.getProperty("beam.dist").orEmpty()
        assumeTrue("Set BEAM_TEST_DIST", dist.isNotEmpty())
        val apk = File(dist, "beam.apk")
        val sidecar = File(dist, "beam.apk.json")
        val bytes = Random(12).nextBytes(200_000)
        apk.writeBytes(bytes)
        sidecar.writeText("""{"version": "9.9.9", "versionCode": 999}""")
        try {
            val main = signedInMain()
            val state = runBlocking { app.updates.check(force = true) }
            assertTrue("state was $state", state is AppUpdater.State.Ready)
            val ready = state as AppUpdater.State.Ready
            assertEquals(999, ready.update.versionCode)
            assertTrue(Updates.matches(ready.file, ready.update))
            idleUntil("update notification") { notifications().any { it.title() == "Beam update ready (v9.9.9)" } }

            // Installing: without "Install unknown apps" permission, Beam explains and sends the user there.
            shadowOf(app.packageManager).setCanRequestPackageInstalls(false)
            val install = Robolectric.buildActivity(UpdateActivity::class.java, UpdateActivity.intent(app)).setup()
            idleUntil("permission explanation") {
                val d = ShadowDialog.getLatestDialog()
                d != null && d.isShowing && d.findViewById<TextView>(android.R.id.message)?.text?.contains("Allow from this source") == true
            }
            install.pause().stop().destroy()

            // With permission, the verified APK goes into a PackageInstaller session and is committed
            // (Android's own confirmation takes over from there; that part can't run here).
            shadowOf(app.packageManager).setCanRequestPackageInstalls(true)
            val install2 = Robolectric.buildActivity(UpdateActivity::class.java, UpdateActivity.intent(app)).setup()
            val installer = app.packageManager.packageInstaller
            idleUntil("install session", 30_000) { installer.allSessions.isNotEmpty() }
            val session = installer.allSessions.last()
            assertEquals(app.packageName, session.appPackageName)

            // (1.6.2) Android refuses it, here while its own prompt is in front (this screen stopped): the screen
            // still gets the answer and says why, in Android's words; Beam keeps that with the update (the
            // notification) and tells the server, whose log says it. (An answer without a status says nothing.)
            install2.pause().stop()
            val dialogText = { ShadowDialog.getLatestDialog()?.findViewById<TextView>(android.R.id.message)?.text?.toString().orEmpty() }
            InstallReceiver().onReceive(app, Intent(app, InstallReceiver::class.java).setAction(InstallReceiver.ACTION_STATUS))
            InstallReceiver().onReceive(
                app,
                Intent(app, InstallReceiver::class.java).setAction(InstallReceiver.ACTION_STATUS)
                    .putExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE_BLOCKED)
                    .putExtra(PackageInstaller.EXTRA_STATUS_MESSAGE, "INSTALL_FAILED_VERIFICATION_FAILURE: blocked in a test"),
            )
            val why = "Android blocked the update (INSTALL_FAILED_VERIFICATION_FAILURE: blocked in a test)."
            idleUntil("the reason on the install screen") { dialogText().startsWith(why) }
            assertEquals(why, app.updates.problem.value?.message)
            idleUntil("the reason in the notification") { notifications().any { it.title() == "Beam update ready (v9.9.9)" && it.text()?.contains(why) == true } }
            idleUntil("reported to the server") {
                val req = Request.Builder().url("$url/api/devices").header("Authorization", "Bearer $key").build()
                val devices = JSONObject(TestNet.client().newCall(req).execute().use { it.body!!.string() }).getJSONArray("devices")
                (0 until devices.length()).map { devices.getJSONObject(it) }.firstOrNull { it.optString("id") == app.prefs.deviceId }
                    ?.optJSONObject("status")?.optJSONObject("update")?.optString("problem") == why
            }
            install2.destroy()

            // A newer build lands in dist/: the server announces it (SSE `app-update`) and Beam fetches it.
            // Now that Beam may install apps, it doesn't bother the user: it installs by itself once it's
            // in the background (Android 12+, UPDATE_PACKAGES_WITHOUT_USER_ACTION).
            val sessionsBefore = installer.allSessions.map { it.sessionId }.toSet()
            apk.writeBytes(Random(13).nextBytes(150_000))
            sidecar.writeText("""{"version": "10.0.0", "versionCode": 1000}""")
            idleUntil("app-update event handled", 30_000) {
                (app.updates.state.value as? AppUpdater.State.Ready)?.update?.versionCode == 1000
            }
            val newer = app.updates.state.value as AppUpdater.State.Ready
            assertTrue(Updates.matches(newer.file, newer.update))
            assertTrue("no notification when it can install by itself", notifications().none { it.title() == "Beam update ready (v10.0.0)" })
            assertEquals("not while Beam is on screen", sessionsBefore, installer.allSessions.map { it.sessionId }.toSet())
            AppUpdater.quietDelayMs = 0
            main.pause().stop()
            idleUntil("quiet install in the background") { installer.allSessions.any { it.sessionId !in sessionsBefore } }
            // (the earlier try that never finished was given up: only the newest session is left)
            assertEquals(1, installer.mySessions.size)

            // Android hasn't answered that one yet: a newer build doesn't start a second install, which would give up
            // the first (perhaps the one whose prompt the user is answering right now).
            val unanswered = installer.allSessions.map { it.sessionId }.toSet()
            apk.writeBytes(Random(14).nextBytes(120_000))
            sidecar.writeText("""{"version": "10.0.1", "versionCode": 1001}""")
            val newest = runBlocking { app.updates.check(force = true) }
            assertEquals(1001, (newest as? AppUpdater.State.Ready)?.update?.versionCode)
            repeat(30) { shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100)); Thread.sleep(50) } // (the quiet path runs on other threads too)
            assertEquals("no second install while the first is unanswered", unanswered, installer.allSessions.map { it.sessionId }.toSet())
            main.destroy()
        } finally {
            apk.delete()
            sidecar.delete()
        }
    }

    @Suppress("unused")
    private fun newId() = UUID.randomUUID().toString().replace("-", "")
}
