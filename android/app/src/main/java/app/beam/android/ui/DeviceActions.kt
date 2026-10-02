package app.beam.android.ui

import android.content.Context
import android.content.Intent
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.core.net.toUri
import androidx.lifecycle.lifecycleScope
import app.beam.android.BeamApp
import app.beam.android.R
import app.beam.android.core.Device
import app.beam.android.core.Format
import com.google.android.material.snackbar.Snackbar
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * What can be done to another device (server 1.3): ring it (to find it), stop ringing it, wake it up
 * (Wake-on-LAN, when it's offline and the server knows its network card) and open Remote Desktop to it
 * (a Windows PC that accepts it, when a Remote Desktop app is installed here). Server 1.6: control a PC that
 * allows it (a locked one shows Remote Desktop, as before), and the kill switch: end whoever controls it, or turn its
 * remote control off (never on: that's only at the PC).
 */
object DeviceActions {
    /** The entries that apply to [d] right now, for its menu. [anchor]: where results show (a snackbar). */
    fun entries(activity: AppCompatActivity, d: Device, anchor: View): List<ActionSheet.Entry> {
        val app = BeamApp.from(activity)
        val list = ArrayList<ActionSheet.Entry>()
        // Being controlled right now: first, so it's quick to end if something looks wrong.
        if (app.remote.available) {
            for (s in app.remote.controlling(d.id)) {
                list += ActionSheet.Entry(R.drawable.ic_remote_control, activity.getString(R.string.remote_controlled_by_end, viewerName(activity, s.viewer))) {
                    endControl(activity, d, s.id, anchor)
                }
            }
        }
        if (d.can.ring) {
            list += if (app.ringer.isRinging(d.id)) {
                ActionSheet.Entry(R.drawable.ic_mute, activity.getString(R.string.device_stop_ringing)) { ring(activity, d, stop = true, anchor) }
            } else {
                ActionSheet.Entry(R.drawable.ic_ring, activity.getString(R.string.device_ring)) { ring(activity, d, stop = false, anchor) }
            }
        }
        if (canWake(d)) list += ActionSheet.Entry(R.drawable.ic_power, activity.getString(R.string.device_wake)) { wake(activity, d, anchor) }
        if (app.remote.canControl(d)) {
            list += ActionSheet.Entry(R.drawable.ic_remote_control, activity.getString(R.string.device_control)) {
                activity.startActivity(RemoteActivity.intent(activity, d.id))
            }
        }
        remoteDesktopIntent(activity, d)?.let { intent ->
            list += ActionSheet.Entry(R.drawable.ic_desktop, activity.getString(R.string.device_remote_desktop)) { activity.startActivity(intent) }
        }
        if (app.remote.available && d.status?.remoteControl == true) {
            list += ActionSheet.Entry(R.drawable.ic_power, activity.getString(R.string.remote_turn_off)) { turnOffControl(activity, d, anchor) }
        }
        return list
    }

    /** Who a session's viewer is, for "Being controlled from …". */
    fun viewerName(ctx: Context, id: String): String {
        val app = BeamApp.from(ctx)
        return if (id == app.repo.me) ctx.getString(R.string.remote_this_phone) else app.repo.state.value.devicesById[id]?.name ?: id
    }

    /** The kill switch: ends session [id] controlling [d]. */
    fun endControl(activity: AppCompatActivity, d: Device, id: String, anchor: View) {
        val app = BeamApp.from(activity)
        activity.lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { app.remote.end(id) } }
            result.onSuccess { Snackbar.make(anchor, activity.getString(R.string.remote_ended, d.name), Snackbar.LENGTH_SHORT).show() }
                .onFailure { Snackbar.make(anchor, Format.error(it), Snackbar.LENGTH_LONG).show() }
        }
    }

    /** Turns [d]'s remote control off (its sessions end); only the PC itself can turn it on again. */
    fun turnOffControl(activity: AppCompatActivity, d: Device, anchor: View) {
        val app = BeamApp.from(activity)
        activity.lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { app.remote.turnOff(d.id) } }
            result.onSuccess { Snackbar.make(anchor, activity.getString(R.string.remote_turned_off, d.name), Snackbar.LENGTH_LONG).show() }
                .onFailure { Snackbar.make(anchor, Format.error(it), Snackbar.LENGTH_LONG).show() }
        }
    }

    fun canWake(d: Device) = !d.online && d.can.wake

    /** Rings [d] (or stops it). Shows the result as a snackbar on [anchor]. */
    fun ring(activity: AppCompatActivity, d: Device, stop: Boolean, anchor: View) {
        val app = BeamApp.from(activity)
        activity.lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { app.api?.ring(d.id, stop) ?: throw IllegalStateException("Not signed in") } }
            result.onSuccess { online ->
                app.ringer.rangOther(d.id, stop = stop || !online)
                when {
                    stop -> Snackbar.make(anchor, activity.getString(R.string.device_ring_stopped, d.name), Snackbar.LENGTH_SHORT).show()
                    !online -> Snackbar.make(anchor, activity.getString(R.string.device_ring_offline, d.name), Snackbar.LENGTH_LONG).show()
                    else -> Snackbar.make(anchor, activity.getString(R.string.device_ringing, d.name), RING_SNACK_MS)
                        .setAction(R.string.ring_stop) { ring(activity, d, stop = true, anchor) }
                        .show()
                }
            }.onFailure { Snackbar.make(anchor, Format.error(it), Snackbar.LENGTH_LONG).show() }
        }
    }

    /** Asks the server to send Wake-on-LAN packets to [d]. */
    fun wake(activity: AppCompatActivity, d: Device, anchor: View) {
        val app = BeamApp.from(activity)
        activity.lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) { runCatching { app.api?.wake(d.id) ?: throw IllegalStateException("Not signed in") } }
            result.onSuccess { Snackbar.make(anchor, activity.getString(R.string.device_wake_sent, d.name), Snackbar.LENGTH_LONG).show() }
                .onFailure { Snackbar.make(anchor, Format.error(it), Snackbar.LENGTH_LONG).show() }
        }
    }

    /**
     * `rdp://full%20address=s:<host>` for a PC that accepts Remote Desktop, if an app here opens such links
     * (Microsoft's "Windows App"/Remote Desktop do). Null otherwise: the entry isn't shown.
     */
    fun remoteDesktopIntent(ctx: Context, d: Device): Intent? {
        if (!d.can.remoteDesktop) return null
        val host = d.tailscaleDns?.takeIf { HOST.matches(it) } ?: return null
        val intent = Intent(Intent.ACTION_VIEW, "rdp://full%20address=s:$host".toUri()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return intent.takeIf { ctx.packageManager.resolveActivity(it, 0) != null }
    }

    /** The PC in the viewer's Remote Desktop download, `…/api/devices/<id>/remote-desktop.rdp` (1.7.6), or null. */
    fun rdpDevice(path: String?): String? = path?.let { RDP_PATH.find(it)?.groupValues?.get(1) }

    private val RDP_PATH = Regex("/api/devices/([A-Za-z0-9_-]{1,64})/remote-desktop\\.rdp$")
    private val HOST = Regex("^[A-Za-z0-9.-]{1,253}$")
    private const val RING_SNACK_MS = 60_000
}
