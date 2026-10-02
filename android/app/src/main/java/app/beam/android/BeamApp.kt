package app.beam.android

import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.StrictMode
import app.beam.android.core.BeamApi
import app.beam.android.core.Conversations
import app.beam.android.core.BeamException
import app.beam.android.core.Pairing
import app.beam.android.core.SignInClient
import app.beam.android.core.ServerInfo
import app.beam.android.data.Alerts
import app.beam.android.data.AppUpdater
import app.beam.android.data.Connection
import app.beam.android.data.Inbox
import app.beam.android.data.NetworkMonitor
import app.beam.android.data.Outbox
import app.beam.android.data.Prefs
import app.beam.android.data.ReadMarkers
import app.beam.android.data.Repository
import app.beam.android.data.ServerMoves
import app.beam.android.data.SignIns
import app.beam.android.data.StatusReporter
import app.beam.android.data.TransferManager
import app.beam.android.notify.Notifier
import app.beam.android.notify.Shortcuts
import app.beam.android.phone.PhoneNotifications
import app.beam.android.remote.RemoteControl
import app.beam.android.service.ConnectionService
import app.beam.android.service.Ringer
import app.beam.android.ui.PairActivity
import app.beam.android.ui.Thumbs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import org.json.JSONObject
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

class BeamApp : Application() {
    lateinit var prefs: Prefs
        private set
    lateinit var network: NetworkMonitor
        private set
    lateinit var repo: Repository
        private set
    lateinit var readMarkers: ReadMarkers
        private set
    lateinit var outbox: Outbox
        private set
    lateinit var inbox: Inbox
        private set
    lateinit var transfers: TransferManager
        private set
    lateinit var connection: Connection
        private set
    lateinit var signIns: SignIns
        private set
    lateinit var moves: ServerMoves
        private set
    lateinit var updates: AppUpdater
        private set
    lateinit var status: StatusReporter
        private set
    lateinit var ringer: Ringer
        private set
    lateinit var alerts: Alerts
        private set
    lateinit var phone: PhoneNotifications
        private set
    lateinit var remote: RemoteControl
        private set

    /** Lives as long as the process. */
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val http: OkHttpClient by lazy { MainThreadGuard.install(BeamApi.defaultClient()) }

    /** Null while not paired. */
    @Volatile
    var api: BeamApi? = null
        private set

    /** The conversation currently on screen (no notifications for it). */
    @Volatile
    var visibleConversation: String? = null

    private var startedActivities = 0
    private var checkedOnLaunch = false
    private val _foreground = MutableStateFlow(false)
    /** Some Beam screen is visible. */
    val foreground: StateFlow<Boolean> = _foreground
    val isInForeground: Boolean get() = _foreground.value
    private val switchingKey = AtomicBoolean(false)
    private val wiping = AtomicBoolean(false)

    override fun onCreate() {
        super.onCreate()
        if (BuildConfig.DEBUG) {
            // Debug builds log main-thread disk and network work and leaked resources (logcat "StrictMode").
            StrictMode.setThreadPolicy(StrictMode.ThreadPolicy.Builder().detectAll().penaltyLog().build())
            StrictMode.setVmPolicy(StrictMode.VmPolicy.Builder().detectLeakedClosableObjects().detectLeakedRegistrationObjects().penaltyLog().build())
        }
        prefs = Prefs(this)
        Notifier.createChannels(this)
        network = NetworkMonitor(this).also { it.start() }
        moves = ServerMoves(this)
        rebuildApi()
        repo = Repository(this)
        readMarkers = ReadMarkers(this)
        outbox = Outbox(this)
        inbox = Inbox(this)
        transfers = TransferManager(this)
        connection = Connection(this)
        signIns = SignIns(this)
        updates = AppUpdater(this).also { it.start() }
        status = StatusReporter(this).also { it.start() }
        ringer = Ringer(this)
        alerts = Alerts(this)
        phone = PhoneNotifications(this)
        remote = RemoteControl(this)
        publishShortcuts()
        // Folders a sign-out moved aside, if the process ended before they were deleted.
        scope.launch(Dispatchers.IO) { cacheDir.listFiles { f -> f.name.contains(GONE) }?.forEach { it.deleteRecursively() } }

        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            override fun onActivityStarted(activity: Activity) {
                // Opening Beam stops "Ring this phone".
                if (ringer.ringing.value) ringer.stop(tellServer = true)
                if (startedActivities++ == 0) {
                    _foreground.value = true
                    connection.acquire("ui")
                    connection.onScreenChanged()
                    ensureBackgroundService()
                    if (prefs.paired) {
                        updates.checkSoon(force = !checkedOnLaunch) // "check on launch", then at most every 6 hours
                        checkedOnLaunch = true
                    }
                }
            }

            override fun onActivityStopped(activity: Activity) {
                if (--startedActivities == 0) {
                    // Turning the phone or a theme switch: the same screen starts again at once. Keep the stream
                    // (letting go closed it and the next start reconnected: ~8 requests and a new handshake).
                    if (activity.isChangingConfigurations) return
                    _foreground.value = false
                    connection.release("ui")
                    connection.onScreenChanged()
                }
            }

            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
            override fun onActivityResumed(activity: Activity) {}
            override fun onActivityPaused(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        })
    }

    fun rebuildApi() {
        val base = prefs.baseUrl
        val key = prefs.key
        api = if (prefs.paired && base != null && key != null) {
            BeamApi(base, key, prefs.deviceId, prefs.deviceName, "android", http, prefs.profileId).also {
                it.onMoved = moves::onMoved
                it.onToken = ::adoptToken
                it.onYou = { you -> if (::repo.isInitialized) repo.adoptYou(you) }
                it.onUnauthorized = { e -> onSignedOut(it, e) }
            }
        } else {
            null
        }
    }

    /**
     * API v3: the server offers this device its own token in place of the shared master key. Switch once it
     * has been seen to work, then forget the master key (a lost phone can then be signed out on its own).
     */
    private fun adoptToken(token: String) {
        if (!switchingKey.compareAndSet(false, true)) return
        scope.launch(Dispatchers.IO) {
            try {
                val base = prefs.baseUrl ?: return@launch
                val trial = BeamApi(base, token, prefs.deviceId, prefs.deviceName, "android", http, prefs.profileId)
                if (trial.me()) {
                    prefs.switchKey(token, deviceToken = true)
                    api?.key = token
                }
            } catch (_: Exception) {
                // Not accepted (yet): keep the current key; the server offers it again.
            } finally {
                switchingKey.set(false)
            }
        }
    }

    /** Starts or stops the background connection service to match the "Stay connected" setting. */
    fun ensureBackgroundService() {
        if (prefs.paired && prefs.stayConnected) ConnectionService.start(this) else ConnectionService.stop(this)
    }

    /**
     * The event stream is open: catch up. Called on the stream's thread before any event is read; the
     * refresh runs first so events apply to current data.
     */
    fun onConnected() {
        try {
            repo.refreshBlocking()
        } catch (_: Exception) {
        }
        inbox.catchUp()
        scope.launch(Dispatchers.IO) {
            moves.refreshHello()
            refreshServerInfo()
            readMarkers.push()
            if (repo.state.value.info?.has("read-markers") == true) {
                runCatching { api?.meResult() }.getOrNull()?.let { me ->
                    me.you?.let(repo::adoptYou)
                    readMarkers.merge(me.read)
                }
            }
            signIns.sync()
            outbox.flush()
            transfers.onConnected()
            status.onConnected()
            alerts.catchUp()
            phone.onConnected()
            remote.onConnected()
        }
        updates.checkSoon()
    }

    /** `/api/info`: what the server can do (API v3 features), its storage and addresses. Blocking. */
    fun refreshServerInfo() {
        val api = api ?: return
        try {
            val raw = api.execute(api.request(api.url("/api/info")).get().build()).use { it.body?.string().orEmpty() }
            val info = ServerInfo.parse(JSONObject(raw))
            prefs.serverInfoJson = raw
            repo.setInfo(info)
            moves.learn(info.publicUrl)
        } catch (_: Exception) {
        }
    }

    @OptIn(FlowPreview::class)
    private fun publishShortcuts() {
        scope.launch {
            // Settle first, then compute: the summaries go over every item.
            repo.state
                .debounce(1500)
                .map { s -> Conversations.summaries(s.me, s.devices, s.items, emptyMap()).map { Triple(it.key, it.name, it.platform) } to s.loaded }
                .distinctUntilChanged()
                .collect { (_, loaded) ->
                    if (!loaded || !prefs.paired) return@collect
                    val s = repo.state.value
                    Shortcuts.publish(this@BeamApp, Conversations.summaries(s.me, s.devices, s.items, emptyMap()))
                }
        }
    }

    /** Something is being sent to [to] (any path): Android ranks Direct Share targets by this. Blocking. */
    fun reportSent(to: List<String>) {
        val s = repo.state.value
        val names = HashMap<String, Pair<String, String?>>()
        names[Conversations.ALL] = getString(R.string.all_devices) to null
        for (d in s.devices) names[d.id] = d.name to d.platform
        Shortcuts.reportSent(this, to, names)
    }

    fun completePairing(link: Pairing.Link, name: String, serverId: String? = null) {
        prefs.savePairing(link.baseUrl, link.key, name, serverId)
        rebuildApi()
        repo.clear()
        status.forget() // a new (or restored) server gets this phone's status
        phone.onPaired() // sharing waits for the "Show on" setup on a server where it wasn't confirmed
        remote.forget() // a page sign-in left for the old server is revoked there; the viewer's WebView starts afresh
        Notifier.cancelSignedOut(this)
        connection.restart()
        ensureBackgroundService()
    }

    fun renameDevice(name: String) {
        prefs.deviceName = name
        api?.deviceName = prefs.deviceName
        connection.restart() // re-registers the name with the server right away
    }

    /** "Unpair" in Settings (main thread: the folders are moved aside now and deleted in the background). */
    fun unpair() {
        phone.leaveServer() // the server's copy of the shared notifications goes while the sign-in still works
        forgetServer()
    }

    /**
     * Nothing this server's sign-in had stays on the phone: the saved copy and its cursor, the outbox, previews
     * (and the small copies of saved photos), read marks, drafts, pending uploads and downloads with their resume
     * records, notifications and the Direct Share shortcuts (they name the devices). Files the user saved stay;
     * they're the user's. The device id, name and settings stay too.
     */
    private fun forgetServer() {
        transfers.cancelAll()
        outbox.clear()
        ConnectionService.stop(this)
        prefs.clearPairing()
        api = null
        repo.clear()
        connection.restart()
        readMarkers.clear()
        signIns.clear()
        status.forget()
        phone.forget()
        remote.forget() // a viewer page's sign-in left there is revoked (with its own cookie)
        Thumbs.forgetAll(this)
        for (dir in listOf("outgoing", "camera")) discard(File(cacheDir, dir)) // copies waiting to be sent
        Notifier.cancelAll(this)
        Shortcuts.removeAll(this)
    }

    /** Moves a folder aside at once (a rename) and deletes it in the background. */
    fun discard(dir: File) {
        if (!dir.exists()) return
        val aside = File(dir.parentFile, dir.name + GONE + System.nanoTime())
        val target = if (dir.renameTo(aside)) aside else dir
        scope.launch(Dispatchers.IO) { target.deleteRecursively() }
    }

    /**
     * The server answered 401 (from any call): this device's sign-in was removed from another device, revoked
     * or has expired. Like the web app: everything goes ([forgetServer]), then sign-in shows, with the server's
     * address filled in. Network errors, 5xx, 503 (moving) and 410 (moved) never get here; that's offline mode.
     * Only the current sign-in counts: a late answer to an earlier one (or a test key) changes nothing.
     *
     * Only this Beam's 401 counts: its server id (in the 401 from 1.4, else from `/api/hello`) must be the one
     * paired with. A different or fresh Beam at the same address (a wrong data folder, a restore, a move gone
     * wrong) keeps everything and shows "rejected"; so does a check that can't be made (no network) until the
     * next 401.
     */
    private fun onSignedOut(from: BeamApi, e: BeamException) {
        if (from !== api || !wiping.compareAndSet(false, true)) return
        scope.launch(Dispatchers.IO) {
            try {
                val expected = prefs.serverId
                val actual = e.serverId ?: runCatching { SignInClient(prefs.baseUrl ?: from.base.toString(), http).hello().serverId }.getOrNull()
                if (from !== api) return@launch
                if (expected == null || actual == null || actual != expected) {
                    repo.setConn(Repository.Conn.AUTH_FAILED)
                    return@launch
                }
                val server = prefs.baseUrl
                forgetServer()
                if (isInForeground) {
                    startActivity(
                        Intent(this@BeamApp, PairActivity::class.java).putExtra(PairActivity.EXTRA_SIGNED_OUT, server)
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK),
                    )
                } else {
                    Notifier.signedOut(this@BeamApp)
                }
                prefs.signedOutFrom = server // last: tests (and sign-in after a restart) take it as "all done"
            } finally {
                wiping.set(false)
            }
        }
    }

    companion object {
        /** Folders moved aside by [discard] are named `<name>.gone-<n>` until deleted (also after a restart). */
        private const val GONE = ".gone-"

        fun from(context: Context) = context.applicationContext as BeamApp
    }
}
