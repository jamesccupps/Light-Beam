package app.beam.android.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import java.util.concurrent.CopyOnWriteArraySet

/**
 * Watches the default network for the whole process: the event stream reconnects and running transfers
 * resume over the new network right away (instead of waiting for a timeout), and the offline banner can
 * tell "Tailscale is off" apart from "no network".
 */
class NetworkMonitor(context: Context) {
    fun interface Listener {
        /** [switched]: a different network became the default one (old sockets are probably dead). */
        fun onNetworkChanged(available: Boolean, switched: Boolean)
    }

    private val cm = context.applicationContext.getSystemService(ConnectivityManager::class.java)
    private val listeners = CopyOnWriteArraySet<Listener>()
    @Volatile private var current: Network? = null
    @Volatile private var started = false

    fun start() {
        if (started || cm == null) return
        started = true
        try {
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(n: Network) {
                    val previous = current
                    current = n
                    listeners.forEach { it.onNetworkChanged(available = true, switched = previous != null && previous != n) }
                }

                override fun onLost(n: Network) {
                    if (n == current) {
                        current = null
                        listeners.forEach { it.onNetworkChanged(available = false, switched = true) }
                    }
                }
            })
        } catch (_: Exception) {
            started = false
        }
    }

    fun addListener(l: Listener) = listeners.add(l)

    fun removeListener(l: Listener) = listeners.remove(l)

    private fun caps(): NetworkCapabilities? = try {
        cm?.getNetworkCapabilities(cm.activeNetwork)
    } catch (_: Exception) {
        null
    }

    /** Any usable default network at all. */
    val online: Boolean get() = cm?.activeNetwork != null

    /** A VPN carries this app's traffic (Tailscale is one; Beam can't tell which VPN it is). */
    val vpnActive: Boolean get() = caps()?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true

    /** Mobile data or a hotspot: large automatic downloads can wait for Wi-Fi. */
    val metered: Boolean get() = try {
        cm?.isActiveNetworkMetered ?: false
    } catch (_: Exception) {
        false
    }
}
