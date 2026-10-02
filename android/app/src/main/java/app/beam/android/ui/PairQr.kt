package app.beam.android.ui

import android.content.DialogInterface
import android.os.Build
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.isVisible
import androidx.lifecycle.lifecycleScope
import app.beam.android.BeamApp
import app.beam.android.R
import app.beam.android.core.Pairing
import app.beam.android.core.str
import app.beam.android.databinding.DialogQrBinding
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.zxing.BarcodeFormat
import com.journeyapps.barcodescanner.BarcodeEncoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Shows a pairing link as a QR code so another device can join the same server. API v3 servers hand out
 * a one-time link (it never contains the master key); older servers still send the key itself. This
 * device's own token is never put into a link.
 */
object PairQr {
    fun show(activity: AppCompatActivity, onScanInstead: (() -> Unit)? = null) {
        val app = BeamApp.from(activity)
        val b = DialogQrBinding.inflate(activity.layoutInflater)
        var link: String? = null
        val builder = MaterialAlertDialogBuilder(activity)
            .setTitle(R.string.pair_another)
            .setView(b.root)
            .setPositiveButton(android.R.string.ok, null)
            .setNeutralButton(R.string.copy, null)
        if (onScanInstead != null) builder.setNegativeButton(R.string.scan_their_code) { _, _ -> onScanInstead() }
        val dialog = builder.show()
        dialog.getButton(DialogInterface.BUTTON_NEUTRAL).setOnClickListener {
            link?.let {
                Clip.copy(activity, it)
                if (Build.VERSION.SDK_INT < 33) Toast.makeText(activity, R.string.copied, Toast.LENGTH_SHORT).show()
            }
        }
        activity.lifecycleScope.launch {
            val info = withContext(Dispatchers.IO) { runCatching { app.api?.pairInfo() }.getOrNull() }
            val secret = info?.str("token") ?: info?.str("key")
            if (info == null || secret == null) {
                b.progress.isVisible = false
                b.body.setText(if (app.prefs.hasDeviceToken) R.string.pair_qr_unavailable else R.string.pair_qr_offline)
                return@launch
            }
            // Prefer the server's public (e.g. Tailscale) address; fall back to the one this device uses.
            val base = info.str("publicUrl")?.takeIf { it.isNotBlank() } ?: app.prefs.baseUrl ?: return@launch
            val oneTime = info.has("token") || info.has("expiresAt")
            b.body.setText(if (oneTime) R.string.pair_qr_body_once else R.string.pair_qr_body)
            val text = info.str("link")?.takeIf { it.isNotBlank() && info.str("publicUrl") != null } ?: Pairing.link(base, secret)
            link = text
            val bitmap = withContext(Dispatchers.Default) {
                runCatching { BarcodeEncoder().encodeBitmap(text, BarcodeFormat.QR_CODE, 720, 720) }.getOrNull()
            }
            b.progress.isVisible = false
            b.qr.setImageBitmap(bitmap)
            b.link.text = text
        }
    }
}
