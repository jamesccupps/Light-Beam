package app.beam.android.phone

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import app.beam.android.BeamApp
import app.beam.android.R
import app.beam.android.ui.PhoneNotificationsActivity

/**
 * Quick Settings tile "PC notifications": one tap switches sharing on or off, and the tile shows which. Without
 * notification access (or a server that can take them, or a first setup) it opens the setup screen instead.
 */
class PcNotificationsTileService : TileService() {
    override fun onStartListening() {
        super.onStartListening()
        val app = BeamApp.from(this)
        val phone = app.phone
        qsTile?.apply {
            state = when {
                !app.prefs.paired || !phone.serverReady -> Tile.STATE_UNAVAILABLE
                phone.enabled && phone.accessGranted -> Tile.STATE_ACTIVE
                else -> Tile.STATE_INACTIVE
            }
            subtitle = when {
                !app.prefs.paired -> null
                !phone.serverReady -> getString(R.string.pc_notifications_tile_needs_server)
                phone.enabled && !phone.accessGranted -> getString(R.string.pc_notifications_tile_needs_access)
                phone.enabled -> getString(R.string.state_on)
                else -> getString(R.string.state_off)
            }
            updateTile()
        }
    }

    override fun onClick() {
        super.onClick()
        val app = BeamApp.from(this)
        val phone = app.phone
        when {
            !app.prefs.paired -> return
            // Off always works, even without access.
            phone.enabled -> {
                phone.setEnabled(false)
                onStartListening()
            }
            // On needs a 1.5 server, access and the first setup: else the setup screen.
            !phone.serverReady || !phone.accessGranted || !app.prefs.phoneSetupDone -> openSetup()
            // Not from the lock screen without unlocking: it sends the phone's notifications elsewhere.
            isLocked -> unlockAndRun {
                phone.setEnabled(true)
                onStartListening()
            }
            else -> {
                phone.setEnabled(true)
                onStartListening()
            }
        }
    }

    @SuppressLint("StartActivityAndCollapseDeprecated")
    private fun openSetup() {
        val intent = Intent(this, PhoneNotificationsActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val run = {
            if (Build.VERSION.SDK_INT >= 34) {
                startActivityAndCollapse(PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            } else {
                @Suppress("DEPRECATION")
                startActivityAndCollapse(intent)
            }
        }
        if (isLocked) unlockAndRun { run() } else run()
    }
}
