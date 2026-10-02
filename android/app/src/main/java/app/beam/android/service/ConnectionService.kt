package app.beam.android.service

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import app.beam.android.BeamApp
import app.beam.android.notify.Notifier
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Keeps the event stream open in the background ("Stay connected"), with a quiet ongoing notification.
 * Foreground service type `remoteMessaging`: it receives messages and files sent from the user's other
 * devices.
 */
class ConnectionService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var holding = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val app = BeamApp.from(this)
        try {
            // The remoteMessaging type exists from Android 14; older versions need no type here.
            val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else 0
            val s = app.repo.state.value
            ServiceCompat.startForeground(this, Notifier.ID_CONNECTION, Notifier.connection(this, s.conn, s.offline), type)
        } catch (_: Exception) {
            // Not allowed to start in the background right now (e.g. a sticky restart): give up quietly.
            stopSelf()
            return
        }
        app.connection.acquire(HOLDER)
        holding = true
        scope.launch {
            app.repo.state.map { it.conn to it.offline }.distinctUntilChanged().collect { (conn, offline) ->
                Notifier.post(this@ConnectionService, Notifier.ID_CONNECTION, Notifier.connection(this@ConnectionService, conn, offline))
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val prefs = BeamApp.from(this).prefs
        if (!holding || !prefs.paired || !prefs.stayConnected) {
            stopSelf()
            return START_NOT_STICKY
        }
        return START_STICKY
    }

    override fun onDestroy() {
        scope.cancel()
        if (holding) BeamApp.from(this).connection.release(HOLDER)
        super.onDestroy()
    }

    companion object {
        private const val HOLDER = "service"

        fun start(ctx: Context) {
            try {
                ContextCompat.startForegroundService(ctx, Intent(ctx, ConnectionService::class.java))
            } catch (_: Exception) {
                // Background start not allowed; it starts next time the app is opened.
            }
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, ConnectionService::class.java))
        }
    }
}
