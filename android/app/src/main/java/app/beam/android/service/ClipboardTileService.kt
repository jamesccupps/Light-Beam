package app.beam.android.service

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import app.beam.android.BeamApp
import app.beam.android.R
import app.beam.android.core.Conversations
import app.beam.android.ui.SendActivity

/**
 * Quick Settings tile "Send clipboard": sends the clipboard to the device chosen in Settings (one tap), or
 * opens the device chooser. A see-through activity reads the clipboard, because Android 10+ only lets the
 * focused app read it.
 */
class ClipboardTileService : TileService() {
    override fun onStartListening() {
        super.onStartListening()
        val app = BeamApp.from(this)
        qsTile?.apply {
            state = if (app.prefs.paired) Tile.STATE_INACTIVE else Tile.STATE_UNAVAILABLE
            subtitle = when (val t = app.prefs.tileTarget) {
                null -> null
                Conversations.ALL -> getString(R.string.all_devices)
                else -> app.repo.state.value.devicesById[t]?.name
            }
            updateTile()
        }
    }

    override fun onClick() {
        super.onClick()
        if (isLocked) unlockAndRun { launch() } else launch()
    }

    @SuppressLint("StartActivityAndCollapseDeprecated")
    private fun launch() {
        val intent = SendActivity.clipboardIntent(this)
            .putExtra(SendActivity.EXTRA_FROM_TILE, true)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }
}
