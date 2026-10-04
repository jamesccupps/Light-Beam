package app.beam.android.ui

import android.app.PendingIntent
import android.app.TaskStackBuilder
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.view.View
import android.widget.RemoteViews
import androidx.core.graphics.scale
import androidx.core.net.toUri
import app.beam.android.BeamApp
import app.beam.android.R
import app.beam.android.core.Conversations
import app.beam.android.core.Format
import app.beam.android.core.Item
import app.beam.android.data.Files
import app.beam.android.data.Repository
import app.beam.android.notify.Notifier
import app.beam.android.service.ActionReceiver
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * (1.12) The home-screen widget: the newest thing received on this phone (who sent it and when, its words, or the file
 * with its preview; a tap opens it, Copy for a text) and two quick sends, the clipboard and photos (each then asks where
 * to, as the share sheet does). Beam draws it when what it shows changes ([BeamApp] follows the app's state); the
 * launcher keeps the last drawing while Beam isn't running.
 */
class BeamWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
        val app = BeamApp.from(context)
        render(app, Shown.of(app, app.repo.state.value, app.prefs.localFiles.value), appWidgetIds)
    }

    /** What the widget shows: everything that, changed, means drawing it again. */
    data class Shown(
        val paired: Boolean,
        /** The app has its items (its saved copy at least): until then the widget keeps what it showed. */
        val loaded: Boolean,
        val item: Item?,
        val from: String,
        val conversation: String,
        /** The saved copy of a file (a content Uri), when there is one. */
        val local: String?,
        /** Today (times show as "14:02" today, with the date after). */
        val day: Long,
    ) {
        companion object {
            fun of(app: BeamApp, s: Repository.State, locals: Map<String, String>): Shown {
                val paired = app.prefs.paired
                val item = if (paired) s.items.firstOrNull { it.isFor(s.me) } else null // (newest first)
                return Shown(
                    paired,
                    s.loaded,
                    item,
                    item?.let { i -> i.from?.let { s.devicesById[it]?.name } ?: i.device }.orEmpty(),
                    item?.let { Conversations.keysOf(it, s.me, s.devicesById).firstOrNull() } ?: Conversations.ALL,
                    item?.let { locals[it.id] },
                    Format.dayKey(System.currentTimeMillis()),
                )
            }
        }
    }

    companion object {
        @Volatile private var drawn: Shown? = null

        fun ids(ctx: Context): IntArray =
            AppWidgetManager.getInstance(ctx).getAppWidgetIds(ComponentName(ctx, BeamWidget::class.java)) ?: IntArray(0)

        /** Draws [shown] on the Beam widgets (none on a home screen: nothing to do); a photo's preview follows. */
        fun render(app: BeamApp, shown: Shown, ids: IntArray = ids(app)) {
            if (ids.isEmpty() || (shown.paired && !shown.loaded)) return
            drawn = shown
            val manager = AppWidgetManager.getInstance(app)
            manager.updateAppWidget(ids, views(app, shown, null))
            val item = shown.item ?: return
            if (!item.isImage && !item.isVideo) return
            app.scope.launch(Dispatchers.IO) {
                val local = shown.local?.toUri()?.takeIf { Files.exists(app, it) }
                val bmp = runCatching { Thumbs.loadItem(app, item, local) }.getOrNull()?.let(::small) ?: return@launch
                withContext(Dispatchers.Main) { if (drawn == shown) manager.updateAppWidget(ids, views(app, shown, bmp)) }
            }
        }

        /** At most 256 px on its longer side: widgets travel to the launcher as a whole. */
        private fun small(bmp: Bitmap): Bitmap {
            val longest = maxOf(bmp.width, bmp.height)
            if (longest <= 256) return bmp
            val f = 256.0 / longest
            return bmp.scale((bmp.width * f).toInt().coerceAtLeast(1), (bmp.height * f).toInt().coerceAtLeast(1))
        }

        fun views(ctx: Context, shown: Shown, preview: Bitmap?): RemoteViews {
            val v = RemoteViews(ctx.packageName, R.layout.widget_beam)
            val item = shown.item
            for ((id, tap) in taps(ctx, shown)) v.setOnClickPendingIntent(id, pending(ctx, id, tap))
            v.setViewVisibility(R.id.widgetCopy, if (item?.isText == true) View.VISIBLE else View.GONE)
            v.setViewVisibility(R.id.widgetPreview, View.GONE)
            if (item == null) {
                v.setTextViewText(R.id.widgetFrom, ctx.getString(R.string.app_name))
                v.setTextViewText(R.id.widgetText, ctx.getString(if (shown.paired) R.string.widget_nothing else R.string.widget_signed_out))
                return v
            }
            val now = System.currentTimeMillis()
            val at = if (Format.dayKey(item.ts) == Format.dayKey(now)) Format.time(item.ts) else Format.at(item.ts, now)
            v.setTextViewText(R.id.widgetFrom, ctx.getString(R.string.widget_from, shown.from, at))
            if (item.isText) {
                v.setTextViewText(R.id.widgetText, item.text.orEmpty().trim())
                v.setContentDescription(R.id.widgetLast, ctx.getString(R.string.widget_open_text, shown.from))
            } else {
                v.setTextViewText(R.id.widgetText, ctx.getString(R.string.widget_file, item.displayName, Format.size(item.size)))
                if (preview != null) {
                    v.setImageViewBitmap(R.id.widgetPreview, preview)
                    v.setViewVisibility(R.id.widgetPreview, View.VISIBLE)
                }
                v.setContentDescription(R.id.widgetLast, ctx.getString(R.string.widget_open_file, item.displayName))
            }
            return v
        }

        /** What a tap starts: an activity, a broadcast (Copy), or a conversation with the conversation list behind it. */
        data class Tap(val intent: Intent, val broadcast: Boolean = false, val withList: Boolean = false)

        /** Each part of the widget (its view id) and what a tap on it does. Signed out: everything opens Beam. */
        fun taps(ctx: Context, shown: Shown): Map<Int, Tap> {
            val app = Tap(Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            if (!shown.paired) return mapOf(R.id.widgetLast to app, R.id.widgetSendClipboard to app, R.id.widgetSendPhoto to app)
            val taps = linkedMapOf(
                R.id.widgetSendClipboard to Tap(SendActivity.clipboardIntent(ctx).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)),
                R.id.widgetSendPhoto to Tap(SendActivity.photosIntent(ctx).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)),
            )
            val item = shown.item
            val local = shown.local?.toUri()
            taps[R.id.widgetLast] = when {
                item == null -> app
                // A file saved here: opened as its notification's Open does. Otherwise: its place in the conversation.
                item.isFile && local != null -> Tap(OpenActivity.intent(ctx, local, Files.mimeFor(item.displayName, item.mime), OpenActivity.MODE_OPEN, null, 0))
                else -> Tap(ThreadActivity.intent(ctx, shown.conversation, item.id), withList = true)
            }
            if (item != null && item.isText) {
                // As the notification's Copy (the whole text is fetched when it's long).
                val whole = if (!item.truncated && (item.text?.length ?: 0) <= 8000) item.text else null
                taps[R.id.widgetCopy] = Tap(ActionReceiver.copyIntent(ctx, item.id, whole, Notifier.tagFor(shown.conversation)), broadcast = true)
            }
            return taps
        }

        private const val IMMUTABLE_UPDATE = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT

        /** (The view's id is the request code: one PendingIntent per part of the widget, updated each time.) */
        private fun pending(ctx: Context, code: Int, tap: Tap): PendingIntent = when {
            tap.broadcast -> PendingIntent.getBroadcast(ctx, code, tap.intent, IMMUTABLE_UPDATE)
            tap.withList -> TaskStackBuilder.create(ctx).addNextIntentWithParentStack(tap.intent).getPendingIntent(code, IMMUTABLE_UPDATE)!!
            else -> PendingIntent.getActivity(ctx, code, tap.intent, IMMUTABLE_UPDATE)
        }
    }
}
