package app.beam.android.data

import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.SystemClock
import app.beam.android.BeamApp
import app.beam.android.BuildConfig
import app.beam.android.R
import app.beam.android.core.AppUpdate
import app.beam.android.core.Format
import app.beam.android.core.Updates
import app.beam.android.notify.Notifier
import app.beam.android.update.SelfInstaller
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONException
import org.json.JSONObject
import java.io.File

/**
 * Keeps Beam up to date from the Beam server (docs/API.md, "App updates"): checks on launch, every
 * 6 hours while connected and on the SSE `app-update` event; downloads a newer build into app storage and
 * verifies its SHA-256. Then, where Android allows it, installs it quietly once Beam isn't on screen and
 * nothing is being transferred; otherwise it offers the update with a notification ([app.beam.android.ui.UpdateActivity]).
 */
class AppUpdater(private val app: BeamApp) {
    sealed interface State {
        data object Idle : State
        data object Checking : State
        data class UpToDate(val checkedAt: Long) : State
        data class Downloading(val update: AppUpdate, val done: Long, val total: Long) : State
        data class Ready(val update: AppUpdate, val file: File) : State
        data class Failed(val message: String) : State
    }

    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state
    private val lock = Mutex()

    private val _installStatus = MutableSharedFlow<Intent>(extraBufferCapacity = 4)
    /** PackageInstaller results for the install screen. */
    val installStatus: SharedFlow<Intent> = _installStatus

    /** An update that didn't install, in Android's words (shown with the update, and in the server's log). */
    data class Problem(val versionCode: Int, val version: String, val message: String)

    private val _problem = MutableStateFlow(loadProblem())
    /** The last update that didn't install, until a newer Beam runs. */
    val problem: StateFlow<Problem?> = _problem

    /** The version code a quiet install was already tried for (so a refusal isn't retried in a loop). */
    @Volatile private var quietTried = 0

    /**
     * When an install was last handed to Android, until its result arrives. Meanwhile no quiet install starts: it
     * would give up that session, perhaps the one whose prompt the user is answering (Beam is in the background then).
     */
    @Volatile private var handedOverAt = 0L

    /** The session of the latest install (0: none since Beam started); answers about older ones don't count. */
    @Volatile private var session = 0

    /** Session [id] goes to Android now ([SelfInstaller.install] from the install screen or the quiet path). */
    fun handingOver(id: Int) {
        session = id
        handedOverAt = SystemClock.elapsedRealtime()
    }

    /** False for an answer about an earlier try that was given up ([id] -1: the answer doesn't say). */
    fun isCurrent(id: Int): Boolean = id == -1 || session == 0 || id == session

    /** Android's final answer about the latest install arrived (anything but "the user must confirm"). */
    fun answered() {
        handedOverAt = 0L
    }

    private fun waitingForAnswer() = handedOverAt != 0L && SystemClock.elapsedRealtime() - handedOverAt < ANSWER_WITHIN_MS

    /** Returns false if no install screen is listening. */
    fun publishInstallStatus(intent: Intent): Boolean = _installStatus.subscriptionCount.value > 0 && _installStatus.tryEmit(intent)
    private val dir get() = File(app.filesDir, "updates")

    fun readyVersion(): String? = (_state.value as? State.Ready)?.update?.version

    /** The problem with [update], if its last try didn't install. */
    fun problemWith(update: AppUpdate?): Problem? = _problem.value?.takeIf { update != null && it.versionCode == update.versionCode }

    /** Installs quietly when an update is ready, Beam is in the background and no transfer is running. */
    fun start() {
        // This Beam is the one that didn't install (or newer): the problem is over.
        if ((_problem.value?.versionCode ?: Int.MAX_VALUE) <= BuildConfig.VERSION_CODE) setProblem(null)
        app.scope.launch {
            combine(_state, app.foreground, app.transfers.active) { s, fg, active -> Triple(s, fg, active) }
                .distinctUntilChanged()
                .collect { (s, fg, active) ->
                    if (s is State.Ready && !fg && active == 0 && quietTried != s.update.versionCode && SelfInstaller.canInstallQuietly(app)) {
                        delay(quietDelayMs) // not right after leaving the app (it may come straight back)
                        if (app.foreground.value || app.transfers.active.value > 0 || _state.value != s || waitingForAnswer()) return@collect
                        quietTried = s.update.versionCode
                        withContext(Dispatchers.IO) {
                            try {
                                SelfInstaller.install(app, s.file, ::handingOver)
                            } catch (e: Exception) {
                                answered()
                                installFailed(PackageInstaller.STATUS_FAILURE, e.message ?: e.javaClass.simpleName)
                            }
                        }
                    }
                }
        }
    }

    /** Checks in the background, at most every 6 hours unless [force]d. */
    fun checkSoon(force: Boolean = false) {
        app.scope.launch(Dispatchers.IO) { check(force) }
    }

    @Volatile private var lastDueCheck = 0L

    /**
     * From a moment the phone is awake anyway (a server event): checks when 6 hours have passed (after a
     * failure, at most every 30 minutes). Cheap when not due.
     */
    fun checkIfDue() {
        val now = System.currentTimeMillis()
        if (now - app.prefs.lastUpdateCheck < CHECK_EVERY_MS || now - lastDueCheck < 30 * 60_000L) return
        lastDueCheck = now
        checkSoon()
    }

    /** SSE `app-update`: the server has a new build right now. */
    fun onEvent(data: String) {
        val update = try {
            AppUpdate.parse(JSONObject(data).optJSONObject("android"))
        } catch (_: JSONException) {
            return
        }
        app.scope.launch(Dispatchers.IO) { lock.withLock { handle(update) } }
    }

    // Network I/O: always on a background thread, whoever calls it (the Settings button and the
    // update screen call from the main thread, where Android forbids network access).
    suspend fun check(force: Boolean = false): State = withContext(Dispatchers.IO) { checkLocked(force) }

    private suspend fun checkLocked(force: Boolean): State = lock.withLock {
        val api = app.api ?: return@withLock _state.value
        if (!force && System.currentTimeMillis() - app.prefs.lastUpdateCheck < CHECK_EVERY_MS && _state.value !is State.Failed) {
            return@withLock _state.value
        }
        if (force) _state.value = State.Checking
        val update = try {
            Updates.available(api)
        } catch (e: Exception) {
            _state.value = State.Failed(Format.error(e))
            return@withLock _state.value
        }
        app.prefs.lastUpdateCheck = System.currentTimeMillis()
        handle(update)
        _state.value
    }

    private fun handle(update: AppUpdate?) {
        val api = app.api ?: return
        if (update == null || !update.isNewerThan(BuildConfig.VERSION_CODE)) {
            _state.value = State.UpToDate(System.currentTimeMillis())
            Notifier.cancel(app, Notifier.ID_UPDATE)
            dir.listFiles()?.forEach { it.delete() } // leftovers of installed updates
            return
        }
        dir.mkdirs()
        val file = File(dir, "beam-${update.versionCode}.apk")
        dir.listFiles()?.filter { it.name != file.name }?.forEach { it.delete() }
        try {
            if (!Updates.matches(file, update)) {
                _state.value = State.Downloading(update, 0, update.size)
                Updates.download(api, update, file) { done, total -> _state.value = State.Downloading(update, done, total) }
            }
        } catch (e: Exception) {
            _state.value = State.Failed(Format.error(e))
            return
        }
        _state.value = State.Ready(update, file)
        // Where it can install by itself, it doesn't bother the user at all.
        if (!SelfInstaller.canInstallQuietly(app)) notifyReady(update, force = false)
    }

    private fun notifyReady(update: AppUpdate, force: Boolean) {
        if (force || app.prefs.notifiedUpdateCode != update.versionCode) {
            app.prefs.notifiedUpdateCode = update.versionCode
            Notifier.updateReady(app, update, problemWith(update)?.message)
        }
    }

    /** The user closed Android's install prompt or the install failed: keep the update on offer. */
    fun renotify() {
        (_state.value as? State.Ready)?.let { notifyReady(it.update, force = true) }
    }

    /**
     * Android didn't install the ready update ([status]: a PackageInstaller status; [detail]: its message, e.g.
     * "INSTALL_FAILED_…"). Kept and shown with the update (notification, banner, Settings, the install screen) and
     * reported to the server, whose log says it: an update that never arrives is never a mystery again. Closing
     * Android's prompt isn't a problem: the update just stays on offer. Returns what's shown.
     */
    fun installFailed(status: Int, detail: String?): String? {
        if (status == PackageInstaller.STATUS_FAILURE_ABORTED) {
            renotify()
            return null
        }
        val ready = _state.value as? State.Ready
        val message = describeFailure(status, detail)
        if (ready != null) {
            setProblem(Problem(ready.update.versionCode, ready.update.version, message))
            report(ready.update.version, message)
        }
        renotify()
        return message
    }

    /** What went wrong, in words, with Android's own message after it. */
    fun describeFailure(status: Int, detail: String?): String {
        val what = app.getString(
            when (status) {
                PackageInstaller.STATUS_FAILURE_BLOCKED -> R.string.update_blocked
                PackageInstaller.STATUS_FAILURE_CONFLICT -> R.string.update_conflict
                PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> R.string.update_incompatible
                PackageInstaller.STATUS_FAILURE_INVALID -> R.string.update_invalid
                PackageInstaller.STATUS_FAILURE_STORAGE -> R.string.update_storage
                PackageInstaller.STATUS_FAILURE_TIMEOUT -> R.string.update_timeout
                else -> R.string.update_failed
            },
        )
        val said = detail?.replace(Regex("\\s+"), " ")?.trim()?.take(200)
        return if (said.isNullOrEmpty()) what else "${what.removeSuffix(".")} ($said)."
    }

    private fun report(version: String, message: String) {
        val api = app.api ?: return
        app.scope.launch(Dispatchers.IO) {
            // A server before 1.6.2 doesn't take it (400): it only misses the log line.
            runCatching { api.reportUpdateProblem(version, message.take(300)) }
        }
    }

    private fun setProblem(p: Problem?) {
        _problem.value = p
        app.prefs.updateProblem = p?.let { JSONObject().put("versionCode", it.versionCode).put("version", it.version).put("message", it.message).toString() }
    }

    private fun loadProblem(): Problem? = app.prefs.updateProblem?.let {
        runCatching { JSONObject(it).let { o -> Problem(o.getInt("versionCode"), o.getString("version"), o.getString("message")) } }.getOrNull()
    }

    companion object {
        const val CHECK_EVERY_MS = 6 * 3600_000L

        /** How long Beam must have been in the background before it installs by itself (tests shorten it). */
        @Volatile var quietDelayMs = 10_000L

        /** An install Android hasn't answered in this long is taken as dropped (a quiet one may start again). */
        const val ANSWER_WITHIN_MS = 15 * 60_000L
    }
}
