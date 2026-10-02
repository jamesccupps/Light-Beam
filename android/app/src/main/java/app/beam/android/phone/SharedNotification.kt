package app.beam.android.phone

import android.app.Notification
import android.app.NotificationManager
import android.os.Build
import android.os.Process
import android.os.UserHandle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import androidx.core.app.NotificationCompat
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/** One of the phone's notifications as shared with the PCs (`PUT /api/phone/notifications/{key}`, server 1.5). */
data class SharedNotification(
    val key: String,
    val app: String,
    val appName: String,
    /** sha256 hex of the app's 64×64 PNG icon (uploaded when the server doesn't have it), or null. */
    val icon: String?,
    val title: String,
    val text: String,
    val lines: List<String>,
    /** A group conversation's name (MessagingStyle), else null. */
    val conversation: String?,
    /** The time the app set (often the message's or mail's own time). */
    val `when`: Long,
    val silent: Boolean,
    val actions: List<SharedAction>,
    /** When it was posted (or last updated) on the phone: PCs tell old ones from new ones by this, not by [when]. */
    val posted: Long = 0,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("app", app).put("appName", appName).put("icon", icon ?: JSONObject.NULL)
        .put("title", title).put("text", text).put("lines", JSONArray(lines)).put("conversation", conversation ?: JSONObject.NULL)
        .put("when", `when`).put("posted", posted).put("silent", silent)
        .put("actions", JSONArray().apply { actions.forEach { put(JSONObject().put("id", it.id).put("title", it.title).apply { if (it.reply) put("reply", true) }) } })
}

/** An action as the PCs see it: "a0"… by position, `reply` when it takes text (a RemoteInput). */
data class SharedAction(val id: String, val title: String, val reply: Boolean)

/**
 * Which notifications are shared and what of them: the parts the server takes, within its limits. Content stays in
 * memory (privacy: it never touches a disk or a log).
 */
object NotificationReader {
    const val MAX_TITLE = 200
    const val MAX_TEXT_BYTES = 4 * 1024
    const val MAX_LINES = 10
    const val MAX_LINE = 500
    const val MAX_ACTIONS = 3
    const val MAX_ACTION_TITLE = 40
    const val MAX_BODY_BYTES = 16 * 1024
    const val MAX_MESSAGES = 5

    /** The key the PCs know it by: a hash of Android's key (≤ 200 URI-safe characters). */
    fun keyOf(sbn: StatusBarNotification): String = sha256Hex("beam:" + sbn.key).take(32)

    /**
     * Whether to share [sbn]: only apps the user picked, in this profile (a work profile's same app isn't picked),
     * never Beam's own, nothing ongoing or from a foreground service, nothing secret or local-only (an app's "don't
     * bridge this to other devices"), and no group summary whose children are shared themselves.
     */
    fun shareable(sbn: StatusBarNotification, ownPackage: String, picked: Set<String>, active: List<StatusBarNotification>, ranking: NotificationListenerService.Ranking? = null): Boolean {
        if (sbn.packageName == ownPackage || sbn.packageName !in picked) return false
        // Another profile (a work profile's same app) isn't what was picked: the posting app's user must be this one.
        if (UserHandle.getUserHandleForUid(sbn.uid) != Process.myUserHandle()) return false
        val n = sbn.notification ?: return false
        if (sbn.isOngoing || n.flags and Notification.FLAG_ONGOING_EVENT != 0 || n.flags and Notification.FLAG_FOREGROUND_SERVICE != 0) return false
        if (n.flags and Notification.FLAG_LOCAL_ONLY != 0) return false
        if (n.visibility == Notification.VISIBILITY_SECRET) return false
        if (Build.VERSION.SDK_INT >= 31 && ranking != null && ranking.lockscreenVisibilityOverride == Notification.VISIBILITY_SECRET) return false
        if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) {
            val children = active.any { it.key != sbn.key && it.packageName == sbn.packageName && it.groupKey == sbn.groupKey &&
                (it.notification?.flags ?: 0) and Notification.FLAG_GROUP_SUMMARY == 0 }
            if (children) return false
        }
        return true
    }

    /**
     * What's shared of [sbn], or null when there's nothing to show. MessagingStyle: the conversation's name plus the
     * last [MAX_MESSAGES] messages as lines; BigText and Inbox when they're there; else title and text. Android 15+
     * already redacts one-time codes for listeners: shared as they come.
     */
    fun read(sbn: StatusBarNotification, appName: String, icon: String?, silent: Boolean): Pair<SharedNotification, List<Notification.Action>>? {
        val n = sbn.notification ?: return null
        val extras = n.extras
        var title = extras.getCharSequence(Notification.EXTRA_TITLE_BIG)?.toString() ?: extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        var text = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString() ?: extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
        var lines: List<String> = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)?.map { it.toString() }.orEmpty()
        var conversation: String? = null
        val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n)
        if (style != null && style.messages.isNotEmpty()) {
            val messages = style.messages.takeLast(MAX_MESSAGES)
            val me = style.user.name?.toString()
            lines = messages.map { m ->
                val who = m.person?.name?.toString() ?: me
                val body = m.text?.toString().orEmpty()
                if (who.isNullOrBlank()) body else "$who: $body"
            }
            conversation = style.conversationTitle?.toString()?.takeIf { it.isNotBlank() }
            val last = messages.last()
            title = conversation ?: last.person?.name?.toString() ?: title
            text = last.text?.toString() ?: text
        }
        if (title.isBlank() && text.isBlank() && lines.isEmpty()) return null
        val platform = n.actions.orEmpty().filter { it.actionIntent != null && !it.title.isNullOrBlank() }.take(MAX_ACTIONS)
        val actions = platform.mapIndexed { i, a -> SharedAction(actionId(i, a.title), a.title.toString().take(MAX_ACTION_TITLE), a.remoteInputs?.any { it.allowFreeFormInput } == true) }
        var shared = SharedNotification(
            key = keyOf(sbn),
            app = sbn.packageName,
            appName = appName.take(MAX_TITLE),
            icon = icon,
            title = title.take(MAX_TITLE),
            text = capBytes(text, MAX_TEXT_BYTES),
            lines = lines.take(MAX_LINES).map { it.take(MAX_LINE) },
            conversation = conversation?.take(MAX_TITLE),
            `when` = if (n.`when` > 0) n.`when` else sbn.postTime,
            silent = silent,
            actions = actions,
            posted = sbn.postTime,
        )
        // Within the body limit (measured with the icon's hash, which goes in later): lines go first, then the text.
        while (shared.copy(icon = "0".repeat(64)).toJson().put("resent", true).toString().toByteArray().size > MAX_BODY_BYTES) {
            shared = when {
                shared.lines.isNotEmpty() -> shared.copy(lines = shared.lines.dropLast(1))
                shared.text.length > 200 -> shared.copy(text = shared.text.take(shared.text.length / 2))
                else -> return null
            }
        }
        return shared to platform
    }

    /**
     * An action's id: its position plus a short hash of its title. A PC still showing an older version of the
     * notification then can't press a button that moved: the phone refuses an id that doesn't match.
     */
    fun actionId(position: Int, title: CharSequence?): String = "a$position-" + sha256Hex(title?.toString().orEmpty()).take(6)

    /** What changes the PCs need to hear about: everything but the times (`when`, `posted`) and the icon. */
    fun contentHash(n: SharedNotification): Int = n.copy(`when` = 0, posted = 0, icon = null).toJson().toString().hashCode()

    /** Silent on the phone: a channel below "default" importance makes no sound, and neither should the PCs. */
    @Suppress("DEPRECATION") // Notification.priority: what's left when there's no ranking
    fun silent(sbn: StatusBarNotification, ranking: NotificationListenerService.Ranking?): Boolean {
        if (ranking != null) return ranking.importance in NotificationManager.IMPORTANCE_NONE until NotificationManager.IMPORTANCE_DEFAULT
        return (sbn.notification?.priority ?: 0) < Notification.PRIORITY_DEFAULT
    }

    /** [s] cut to at most [max] UTF-8 bytes, on a character boundary. */
    fun capBytes(s: String, max: Int): String {
        if (s.toByteArray().size <= max) return s
        var lo = 0
        var hi = s.length
        while (lo < hi) {
            val mid = (lo + hi + 1) / 2
            if (s.substring(0, mid).toByteArray().size <= max) lo = mid else hi = mid - 1
        }
        if (lo > 0 && Character.isHighSurrogate(s[lo - 1])) lo--
        return s.substring(0, lo)
    }

    fun sha256Hex(s: String): String = sha256Hex(s.toByteArray())

    fun sha256Hex(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
