package app.beam.android.notify

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.createBitmap
import androidx.core.graphics.drawable.IconCompat
import app.beam.android.R
import app.beam.android.core.Conversations
import app.beam.android.ui.ThreadActivity
import app.beam.android.ui.platformIcon

/**
 * One long-lived shortcut per device you talk to. The same shortcut is
 * - a Direct Share target: "Share → Desktop" in Android's share sheet sends in one tap,
 * - a launcher shortcut (long-press the Beam icon),
 * - the identity of that device's conversation notifications (Android's Conversations section).
 */
object Shortcuts {
    /** Must match the category in res/xml/shortcuts.xml (share-target). */
    const val SHARE_CATEGORY = "app.beam.android.category.SHARE_TARGET"
    private const val PREFIX = "conv_"
    /** In res/xml/shortcuts.xml (Send clipboard, Search): they count towards the per-activity limit. */
    private const val STATIC_SHORTCUTS = 2

    fun idFor(conversation: String) = PREFIX + if (conversation == Conversations.ALL) "all" else conversation

    /** The conversation a shortcut id stands for (from a Direct Share or launcher tap), or null. */
    fun conversationFor(shortcutId: String?): String? {
        val rest = shortcutId?.takeIf { it.startsWith(PREFIX) }?.removePrefix(PREFIX) ?: return null
        return if (rest == "all") Conversations.ALL else rest
    }

    private fun build(ctx: Context, conversation: String, name: String, platform: String?, rank: Int): ShortcutInfoCompat {
        val icon = icon(ctx, platform, conversation == Conversations.ALL)
        return ShortcutInfoCompat.Builder(ctx, idFor(conversation))
            .setShortLabel(name.take(24))
            .setLongLabel(name)
            .setIcon(icon)
            .setIntent(ThreadActivity.intent(ctx, conversation).setAction("app.beam.android.CONVERSATION"))
            .setLongLived(true)
            .setRank(rank)
            .setCategories(setOf(SHARE_CATEGORY))
            .setPerson(Person.Builder().setName(name).setKey(conversation).setIcon(icon).build())
            .build()
    }

    /** Makes sure [conversation] has a shortcut (before its notification refers to it). */
    fun ensure(ctx: Context, conversation: String, name: String, platform: String?) {
        try {
            ShortcutManagerCompat.pushDynamicShortcut(ctx, build(ctx, conversation, name, platform, 0))
        } catch (_: Exception) {
        }
    }

    /**
     * Publishes the most recent devices (most recent first), dropping ones that are gone. Up to 8: Android's
     * share sheet picks its Direct Share row from these (the launcher menu shows the first few).
     */
    fun publish(ctx: Context, summaries: List<Conversations.Summary>) {
        try {
            val max = (ShortcutManagerCompat.getMaxShortcutCountPerActivity(ctx) - STATIC_SHORTCUTS).coerceIn(1, 8)
            val wanted = summaries.filter { it.known }.take(max)
            val keep = wanted.map { idFor(it.key) }.toSet()
            val stale = ShortcutManagerCompat.getDynamicShortcuts(ctx).map { it.id }.filter { it.startsWith(PREFIX) && it !in keep }
            if (stale.isNotEmpty()) ShortcutManagerCompat.removeDynamicShortcuts(ctx, stale)
            wanted.forEachIndexed { rank, s ->
                val name = if (s.isAll) ctx.getString(R.string.all_devices) else s.name
                ShortcutManagerCompat.pushDynamicShortcut(ctx, build(ctx, s.key, name, s.platform, rank))
            }
        } catch (_: Exception) {
        }
    }

    /**
     * Something was just sent to [to] (empty: All devices), from any path: the share sheet, a conversation, the
     * tile, a notification reply. Tells Android, which ranks Direct Share targets by use: a target that's never
     * reported is often not shown at all. Blocking (binder calls); call it off the main thread.
     */
    fun reportSent(ctx: Context, to: List<String>, names: Map<String, Pair<String, String?>>) {
        val keys = to.ifEmpty { listOf(Conversations.ALL) }
        for (key in keys) {
            try {
                val (name, platform) = names[key] ?: continue
                // Make sure it exists (a device outside the recent ones), then count the use.
                ShortcutManagerCompat.pushDynamicShortcut(ctx, build(ctx, key, name, platform, 0))
                ShortcutManagerCompat.reportShortcutUsed(ctx, idFor(key))
            } catch (_: Exception) {
            }
        }
    }

    fun removeAll(ctx: Context) {
        try {
            ShortcutManagerCompat.removeAllDynamicShortcuts(ctx)
            ShortcutManagerCompat.removeLongLivedShortcuts(ctx, ShortcutManagerCompat.getShortcuts(ctx, ShortcutManagerCompat.FLAG_MATCH_CACHED).map { it.id })
        } catch (_: Exception) {
        }
    }

    /** The device's platform icon on Beam's soft accent colour, as an adaptive icon. */
    private fun icon(ctx: Context, platform: String?, isAll: Boolean): IconCompat {
        val size = 216 // 108 dp at 2x; the middle 72 dp is always visible
        val bmp = createBitmap(size, size)
        val canvas = Canvas(bmp)
        canvas.drawColor(ctx.getColor(R.color.accent_soft_fixed))
        val d = ContextCompat.getDrawable(ctx, platformIcon(platform, isAll))?.mutate()
        if (d != null) {
            d.setTint(ctx.getColor(R.color.accent_fixed))
            val inset = size * 30 / 100
            d.setBounds(inset, inset, size - inset, size - inset)
            d.draw(canvas)
        }
        return IconCompat.createWithAdaptiveBitmap(bmp)
    }
}
