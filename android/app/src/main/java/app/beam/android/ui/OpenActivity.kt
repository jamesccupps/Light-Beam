package app.beam.android.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import app.beam.android.data.Files
import app.beam.android.notify.Notifier

/**
 * Invisible helper behind the Open / Share buttons of "file received" notifications: checks the file
 * still exists, then hands it to the viewer or the share sheet. Never opens anything by itself.
 */
class OpenActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val uri = intent.data
        val mime = intent.type ?: "*/*"
        intent.getStringExtra(EXTRA_TAG)?.let { Notifier.cancel(this, intent.getIntExtra(EXTRA_ID, 0), it) }
        when {
            uri == null -> Unit
            !Files.exists(this, uri) -> Toast.makeText(this, "That file is no longer in Downloads.", Toast.LENGTH_LONG).show()
            intent.getStringExtra(EXTRA_MODE) == MODE_SHARE -> FileActions.share(this, uri, mime)
            else -> FileActions.open(this, uri, mime)
        }
        finish()
    }

    companion object {
        const val MODE_OPEN = "open"
        const val MODE_SHARE = "share"
        private const val EXTRA_MODE = "mode"
        private const val EXTRA_TAG = "tag"
        private const val EXTRA_ID = "id"

        fun intent(ctx: Context, uri: Uri, mime: String, mode: String, tag: String?, id: Int): Intent =
            Intent(ctx, OpenActivity::class.java)
                .setAction("app.beam.android.action.$mode")
                .setDataAndType(uri, mime)
                .putExtra(EXTRA_MODE, mode)
                .putExtra(EXTRA_TAG, tag)
                .putExtra(EXTRA_ID, id)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
    }
}
