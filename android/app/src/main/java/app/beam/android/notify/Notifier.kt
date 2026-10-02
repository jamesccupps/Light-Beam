package app.beam.android.notify

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.service.notification.StatusBarNotification
import android.util.Patterns
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.app.TaskStackBuilder
import androidx.core.content.ContextCompat
import androidx.core.content.LocusIdCompat
import androidx.core.net.toUri
import app.beam.android.BeamApp
import app.beam.android.R
import app.beam.android.core.AppUpdate
import app.beam.android.core.Alert
import app.beam.android.core.Conversations
import app.beam.android.core.Format
import app.beam.android.core.Item
import app.beam.android.core.LoginRequest
import app.beam.android.data.Files
import app.beam.android.data.Repository
import app.beam.android.service.ActionReceiver
import app.beam.android.service.TransferService
import app.beam.android.ui.ApproveActivity
import app.beam.android.ui.MainActivity
import app.beam.android.ui.OpenActivity
import app.beam.android.ui.ThreadActivity
import app.beam.android.ui.UpdateActivity

object Notifier {
    const val CH_MESSAGES = "messages"
    const val CH_TRANSFERS = "transfers"
    const val CH_CONNECTION = "connection"
    const val CH_SIGNIN = "signin"
    const val CH_SERVER = "server"
    const val CH_UPDATES = "updates"
    const val CH_RING = "ring"
    const val CH_ALERTS = "alerts"
    private const val TAG_SIGNIN = "signin"

    const val ID_CONNECTION = 1
    const val ID_TRANSFERS = 2
    const val ID_UPDATE = 3
    const val ID_PAUSED = 4
    const val ID_RING = 6
    private const val ID_SUMMARY = 5

    /** Every conversation has one texts notification: tag "c:<conversation>", this id. */
    const val ID_TEXTS = 100
    const val GROUP_ITEMS = "app.beam.android.ITEMS"
    private const val EXTRA_ITEM_ID = "app.beam.android.itemId"
    const val KEY_REPLY = "reply"
    private const val MAX_MESSAGES = 8
    private const val IMMUTABLE = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT

    fun createChannels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
        nm.createNotificationChannels(
            listOf(
                NotificationChannel(CH_MESSAGES, ctx.getString(R.string.channel_messages), NotificationManager.IMPORTANCE_HIGH).apply {
                    description = ctx.getString(R.string.channel_messages_desc)
                },
                NotificationChannel(CH_TRANSFERS, ctx.getString(R.string.channel_transfers), NotificationManager.IMPORTANCE_LOW).apply {
                    description = ctx.getString(R.string.channel_transfers_desc)
                    setShowBadge(false)
                },
                NotificationChannel(CH_CONNECTION, ctx.getString(R.string.channel_connection), NotificationManager.IMPORTANCE_MIN).apply {
                    description = ctx.getString(R.string.channel_connection_desc)
                    setShowBadge(false)
                },
                NotificationChannel(CH_SIGNIN, ctx.getString(R.string.channel_signin), NotificationManager.IMPORTANCE_HIGH).apply {
                    description = ctx.getString(R.string.channel_signin_desc)
                    lockscreenVisibility = Notification.VISIBILITY_PRIVATE
                },
                NotificationChannel(CH_SERVER, ctx.getString(R.string.channel_server), NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = ctx.getString(R.string.channel_server_desc)
                },
                NotificationChannel(CH_UPDATES, ctx.getString(R.string.channel_updates), NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = ctx.getString(R.string.channel_updates_desc)
                },
                // Beam plays the alarm sound and vibrates itself (loud, on the alarm stream): the channel stays quiet.
                NotificationChannel(CH_RING, ctx.getString(R.string.channel_ring), NotificationManager.IMPORTANCE_HIGH).apply {
                    description = ctx.getString(R.string.channel_ring_desc)
                    setSound(null, null)
                    enableVibration(false)
                    lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                },
                NotificationChannel(CH_ALERTS, ctx.getString(R.string.channel_alerts), NotificationManager.IMPORTANCE_DEFAULT).apply {
                    description = ctx.getString(R.string.channel_alerts_desc)
                },
            ),
        )
    }

    fun canPost(ctx: Context): Boolean =
        NotificationManagerCompat.from(ctx).areNotificationsEnabled() &&
            (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)

    @SuppressLint("MissingPermission")
    fun post(ctx: Context, id: Int, n: Notification, tag: String? = null) {
        if (!canPost(ctx)) return
        try {
            NotificationManagerCompat.from(ctx).notify(tag, id, n)
        } catch (_: SecurityException) {
        }
    }

    fun cancel(ctx: Context, id: Int, tag: String? = null) = NotificationManagerCompat.from(ctx).cancel(tag, id)

    fun cancelAll(ctx: Context) = NotificationManagerCompat.from(ctx).cancelAll()

    private fun active(ctx: Context): List<StatusBarNotification> = try {
        ctx.getSystemService(NotificationManager::class.java)?.activeNotifications?.toList().orEmpty()
    } catch (_: Exception) {
        emptyList()
    }

    /** Clears the notifications of one conversation (when it's opened). */
    fun cancelConversation(ctx: Context, key: String) {
        val tag = tagFor(key)
        active(ctx).filter { it.tag == tag }.forEach { cancel(ctx, it.id, it.tag) }
        updateSummary(ctx)
    }

    fun tagFor(conversation: String) = "c:$conversation"
    fun idFor(itemId: String) = itemId.hashCode().let { if (it in 0..999) it + 1000 else it } // never clashes with fixed ids
    private fun request(itemId: String, action: Int) = itemId.hashCode() * 8 + action

    private fun base(ctx: Context, channel: String) = NotificationCompat.Builder(ctx, channel)
        .setSmallIcon(R.drawable.ic_stat_beam)
        .setColor(ctx.getColor(R.color.accent))

    /** Opens a conversation, with the conversation list behind it. */
    fun conversationIntent(ctx: Context, key: String): PendingIntent =
        TaskStackBuilder.create(ctx)
            .addNextIntentWithParentStack(ThreadActivity.intent(ctx, key))
            .getPendingIntent(key.hashCode(), IMMUTABLE)!!

    private fun mainIntent(ctx: Context): PendingIntent =
        PendingIntent.getActivity(ctx, 0, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), IMMUTABLE)

    /** Clears the group summary with the last child (swiped away or cancelled by Beam). */
    private fun dismissedIntent(ctx: Context): PendingIntent =
        PendingIntent.getBroadcast(ctx, 9, ActionReceiver.childDismissedIntent(ctx), IMMUTABLE)

    // ---------------------------------------------------------------- received texts (one conversation notification each)

    private fun me(ctx: Context) = Person.Builder().setName(ctx.getString(R.string.you)).setKey("me").build()

    private fun sender(ctx: Context, name: String, key: String) = Person.Builder().setName(name).setKey(key).setImportant(true).build()

    /** The conversation's texts notification as it is now (recovered from the shade), or null. */
    private fun activeStyle(ctx: Context, conversation: String): NotificationCompat.MessagingStyle? {
        val sbn = active(ctx).firstOrNull { it.tag == tagFor(conversation) && it.id == ID_TEXTS } ?: return null
        return NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(sbn.notification)
    }

    /** The first web link in [text], if any (the domain of an e-mail address isn't one). */
    fun firstLink(text: String): String? {
        val m = Patterns.WEB_URL.matcher(text)
        while (m.find()) {
            val start = m.start()
            val end = m.end()
            if (start > 0 && text[start - 1] == '@') continue // …@example.com
            if (end < text.length && text[end] == '@') continue // name.surname@…
            val url = m.group()
            val web = url.startsWith("http://", true) || url.startsWith("https://", true)
            if (!web && url.contains("://")) continue // rtsp://, ftp://: nothing a browser opens
            return if (web) url else "https://$url"
        }
        return null
    }

    /**
     * A text arrived: one conversation-style notification per device (MessagingStyle, linked to that
     * device's sharing shortcut), with Copy, Open link (when there is one) and an inline Reply.
     */
    fun textReceived(ctx: Context, item: Item, text: String, senderName: String, conversation: String, copied: Boolean, muted: Boolean) {
        val title = if (conversation == Conversations.ALL) ctx.getString(R.string.all_devices) else senderName
        Shortcuts.ensure(ctx, conversation, title, platformOf(ctx, conversation))
        val style = activeStyle(ctx, conversation) ?: NotificationCompat.MessagingStyle(me(ctx))
        style.conversationTitle = if (conversation == Conversations.ALL) title else null
        style.isGroupConversation = conversation == Conversations.ALL
        val message = NotificationCompat.MessagingStyle.Message(text.take(4000), item.ts, sender(ctx, senderName, item.from ?: senderName))
        message.extras.putString(EXTRA_ITEM_ID, item.id)
        style.addMessage(message)
        while (style.messages.size > MAX_MESSAGES) style.messages.removeAt(0)
        post(ctx, ID_TEXTS, buildTexts(ctx, conversation, style, item, text, copied, muted, alert = true), tagFor(conversation))
        updateSummary(ctx)
    }

    /** My reply from the notification: shown in the conversation without alerting again. */
    fun replied(ctx: Context, conversation: String, text: String) {
        val style = activeStyle(ctx, conversation) ?: return
        style.addMessage(NotificationCompat.MessagingStyle.Message(text, System.currentTimeMillis(), null as Person?))
        post(ctx, ID_TEXTS, buildTexts(ctx, conversation, style, null, null, copied = false, muted = true, alert = false), tagFor(conversation))
    }

    private fun buildTexts(
        ctx: Context,
        conversation: String,
        style: NotificationCompat.MessagingStyle,
        latest: Item?,
        latestText: String?,
        copied: Boolean,
        muted: Boolean,
        alert: Boolean,
    ): Notification {
        val tag = tagFor(conversation)
        val b = base(ctx, CH_MESSAGES)
            .setStyle(style)
            .setShortcutId(Shortcuts.idFor(conversation))
            .setLocusId(LocusIdCompat(Shortcuts.idFor(conversation)))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(if (muted) NotificationCompat.PRIORITY_LOW else NotificationCompat.PRIORITY_HIGH)
            .setSilent(muted || !alert)
            .setOnlyAlertOnce(!alert)
            .setAutoCancel(true)
            .setSubText(if (copied) ctx.getString(R.string.copied) else null)
            .setContentIntent(conversationIntent(ctx, conversation))
            .setDeleteIntent(dismissedIntent(ctx))
            .setGroup(GROUP_ITEMS)
        val last = style.messages.lastOrNull { it.person != null } ?: style.messages.lastOrNull()
        val lastItemId = latest?.id ?: last?.extras?.getString(EXTRA_ITEM_ID)
        val lastText = latestText ?: last?.text?.toString()
        // Plain title/text too: older launchers, the group summary and accessibility read these.
        b.setContentTitle(style.conversationTitle ?: last?.person?.name)
        b.setContentText(last?.text)
        last?.timestamp?.let { b.setWhen(it).setShowWhen(true) }
        if (lastItemId != null && lastText != null) {
            val copy = PendingIntent.getBroadcast(
                ctx, request(lastItemId, 1),
                ActionReceiver.copyIntent(ctx, lastItemId, if (lastText.length <= 8000) lastText else null, tag),
                IMMUTABLE,
            )
            b.addAction(NotificationCompat.Action.Builder(R.drawable.ic_copy, ctx.getString(R.string.copy), copy).build())
            firstLink(lastText)?.let { link ->
                val open = PendingIntent.getActivity(
                    ctx, request(lastItemId, 5),
                    Intent(Intent.ACTION_VIEW, link.toUri()).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    IMMUTABLE,
                )
                b.addAction(NotificationCompat.Action.Builder(R.drawable.ic_link, ctx.getString(R.string.open_link), open).build())
            }
        }
        // Inline reply goes back to the device (or to everyone, in All devices).
        val input = RemoteInput.Builder(KEY_REPLY).setLabel(ctx.getString(R.string.reply)).build()
        val reply = PendingIntent.getBroadcast(
            ctx, conversation.hashCode() * 8 + 6,
            ActionReceiver.replyIntent(ctx, conversation),
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT, // RemoteInput fills in the text
        )
        b.addAction(
            NotificationCompat.Action.Builder(R.drawable.ic_reply, ctx.getString(R.string.reply), reply)
                .addRemoteInput(input)
                .setAllowGeneratedReplies(true)
                .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
                .setShowsUserInterface(false)
                .build(),
        )
        return b.build()
    }

    private fun platformOf(ctx: Context, conversation: String): String? =
        BeamApp.from(ctx).repo.state.value.devicesById[conversation]?.platform

    // ---------------------------------------------------------------- files

    /** A file was saved: tapping opens it; Open and Share act on it directly. */
    fun fileSaved(ctx: Context, item: Item, uri: Uri, name: String, senderName: String, conversation: String, muted: Boolean) {
        val mime = Files.mimeFor(name, item.mime)
        val tag = tagFor(conversation)
        val open = PendingIntent.getActivity(ctx, request(item.id, 2), OpenActivity.intent(ctx, uri, mime, OpenActivity.MODE_OPEN, tag, idFor(item.id)), IMMUTABLE)
        val share = PendingIntent.getActivity(ctx, request(item.id, 3), OpenActivity.intent(ctx, uri, mime, OpenActivity.MODE_SHARE, tag, idFor(item.id)), IMMUTABLE)
        val b = base(ctx, CH_MESSAGES)
            .setContentTitle(senderName)
            .setContentText("$name · ${Format.size(item.size)} · ${ctx.getString(R.string.saved_to)}")
            .setWhen(item.ts)
            .setShowWhen(true)
            .setAutoCancel(true)
            .setSilent(muted)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(if (muted) NotificationCompat.PRIORITY_LOW else NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(open)
            .setDeleteIntent(dismissedIntent(ctx))
            .addAction(R.drawable.ic_open, ctx.getString(R.string.open), open)
            .addAction(R.drawable.ic_share, ctx.getString(R.string.share), share)
            .setGroup(GROUP_ITEMS)
        if (item.isImage) {
            thumbnail(ctx, uri)?.let { bmp ->
                b.setLargeIcon(bmp).setStyle(NotificationCompat.BigPictureStyle().bigPicture(bmp).bigLargeIcon(null as Bitmap?))
            }
        }
        post(ctx, idFor(item.id), b.build(), tag)
        updateSummary(ctx)
    }

    /** A file that wasn't downloaded automatically (too large, auto-download off, or waiting for Wi-Fi). */
    fun fileOffer(ctx: Context, item: Item, senderName: String, conversation: String, muted: Boolean, waitingForWifi: Boolean) {
        val text = "${item.displayName} · ${Format.size(item.size)}" + if (waitingForWifi) " · ${ctx.getString(R.string.waiting_for_wifi)}" else ""
        val n = base(ctx, CH_MESSAGES)
            .setContentTitle(senderName)
            .setContentText(text)
            .setWhen(item.ts)
            .setShowWhen(true)
            .setAutoCancel(true)
            .setSilent(muted || waitingForWifi)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(if (muted) NotificationCompat.PRIORITY_LOW else NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(conversationIntent(ctx, conversation))
            .setDeleteIntent(dismissedIntent(ctx))
            .addAction(R.drawable.ic_download, ctx.getString(if (waitingForWifi) R.string.download_now else R.string.download), downloadAction(ctx, item.id, tagFor(conversation)))
            .setGroup(GROUP_ITEMS)
            .build()
        post(ctx, idFor(item.id), n, tagFor(conversation))
        updateSummary(ctx)
    }

    fun downloadFailed(ctx: Context, item: Item, error: Throwable, senderName: String, conversation: String) {
        val n = base(ctx, CH_MESSAGES)
            .setContentTitle(ctx.getString(R.string.notify_save_failed, item.displayName))
            .setContentText(ctx.getString(R.string.notify_from, senderName) + " " + Format.error(error))
            .setAutoCancel(true)
            .setContentIntent(conversationIntent(ctx, conversation))
            .addAction(R.drawable.ic_refresh, ctx.getString(R.string.retry), downloadAction(ctx, item.id, tagFor(conversation)))
            .build()
        post(ctx, idFor(item.id), n, tagFor(conversation))
    }

    private fun downloadAction(ctx: Context, itemId: String, tag: String): PendingIntent =
        PendingIntent.getForegroundService(ctx, request(itemId, 4), TransferService.downloadIntent(ctx, itemId, tag, idFor(itemId)), IMMUTABLE)

    fun uploadFailed(ctx: Context, name: String, error: String, conversation: String) {
        val n = base(ctx, CH_MESSAGES)
            .setContentTitle(ctx.getString(R.string.notify_send_failed, name))
            .setContentText(error)
            .setStyle(NotificationCompat.BigTextStyle().bigText(error))
            .setAutoCancel(true)
            .setContentIntent(conversationIntent(ctx, conversation))
            .build()
        post(ctx, ("upload:$name").hashCode(), n, tagFor(conversation))
    }

    // ---------------------------------------------------------------- keeping the shade in step with the server

    /** An item was deleted (here or on another device): take it out of the shade. */
    fun itemDeleted(ctx: Context, itemId: String) = itemsDeleted(ctx, listOf(itemId))

    /** Items were deleted: one pass over the shade for all of them (a delta can delete many). */
    fun itemsDeleted(ctx: Context, itemIds: Collection<String>) {
        if (itemIds.isEmpty()) return
        val ids = itemIds.toHashSet()
        val notificationIds = ids.mapTo(HashSet()) { idFor(it) }
        var changed = false
        for (sbn in active(ctx)) {
            if (sbn.id in notificationIds) {
                cancel(ctx, sbn.id, sbn.tag)
                changed = true
            } else if (sbn.id == ID_TEXTS && sbn.tag?.startsWith("c:") == true) {
                val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(sbn.notification) ?: continue
                if (style.messages.none { it.extras.getString(EXTRA_ITEM_ID) in ids }) continue
                style.messages.removeAll { it.extras.getString(EXTRA_ITEM_ID) in ids }
                repostOrCancel(ctx, sbn, style)
                changed = true
            }
        }
        if (changed) updateSummary(ctx)
    }

    /** Conversation [key] was read up to [ts] (here or in another client with this identity). */
    fun conversationRead(ctx: Context, key: String, ts: Long) {
        val tag = tagFor(key)
        for (sbn in active(ctx).filter { it.tag == tag }) {
            if (sbn.id == ID_TEXTS) {
                val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(sbn.notification) ?: continue
                if (style.messages.none { it.timestamp <= ts }) continue
                style.messages.removeAll { it.timestamp <= ts }
                repostOrCancel(ctx, sbn, style)
            } else if (sbn.notification.`when` in 1..ts) {
                cancel(ctx, sbn.id, sbn.tag)
            }
        }
        updateSummary(ctx)
    }

    private fun repostOrCancel(ctx: Context, sbn: StatusBarNotification, style: NotificationCompat.MessagingStyle) {
        val conversation = sbn.tag?.removePrefix("c:") ?: return
        if (style.messages.none { it.person != null }) {
            cancel(ctx, sbn.id, sbn.tag)
            return
        }
        post(ctx, ID_TEXTS, buildTexts(ctx, conversation, style, null, null, copied = false, muted = true, alert = false), sbn.tag)
    }

    /** One summary for Beam's item notifications, so a burst of items collapses into one group. */
    fun updateSummary(ctx: Context) {
        val children = active(ctx).filter { it.notification.group == GROUP_ITEMS && (it.notification.flags and Notification.FLAG_GROUP_SUMMARY) == 0 }
        if (children.isEmpty()) {
            cancel(ctx, ID_SUMMARY)
            return
        }
        val inbox = NotificationCompat.InboxStyle()
        children.sortedByDescending { it.notification.`when` }.take(5).forEach { sbn ->
            val e = sbn.notification.extras
            val title = e.getCharSequence(Notification.EXTRA_TITLE) ?: e.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE) ?: ""
            val text = e.getCharSequence(Notification.EXTRA_TEXT) ?: ""
            inbox.addLine("$title  $text")
        }
        val n = base(ctx, CH_MESSAGES)
            .setContentTitle(ctx.getString(R.string.app_name))
            .setContentText(ctx.resources.getQuantityString(R.plurals.notify_new_items, children.size, children.size))
            .setStyle(inbox)
            .setGroup(GROUP_ITEMS)
            .setGroupSummary(true)
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .setSilent(true)
            .setAutoCancel(true)
            .setContentIntent(mainIntent(ctx))
            .build()
        post(ctx, ID_SUMMARY, n)
    }

    // ---------------------------------------------------------------- sign-in requests

    private fun signInId(requestId: String) = ("signin:" + requestId).hashCode()

    /** "Work Laptop wants to sign in · code K7QM-4R2X · from …" with Deny / Approve. */
    fun signInRequest(ctx: Context, r: LoginRequest) {
        val id = signInId(r.id)
        val open = PendingIntent.getActivity(ctx, id * 4, ApproveActivity.intent(ctx, r.code), IMMUTABLE)
        // Approving opens Beam (so a locked phone must be unlocked first); denying doesn't need to.
        val approve = PendingIntent.getActivity(ctx, id * 4 + 1, ApproveActivity.intent(ctx, r.code, approveNow = true), IMMUTABLE)
        val deny = PendingIntent.getBroadcast(ctx, id * 4 + 2, ActionReceiver.denySignInIntent(ctx, r.id, r.code), IMMUTABLE)
        val title = ctx.getString(if (r.isMove) R.string.signin_wants_move else R.string.signin_wants, r.name)
        val where = listOfNotNull(r.who, r.where.takeIf { it.isNotBlank() }).joinToString(" · ")
        val text = if (where.isNotBlank()) ctx.getString(R.string.signin_code_from, r.code, where) else ctx.getString(R.string.signin_code, r.code)
        val hidden = base(ctx, CH_SIGNIN).setContentTitle(ctx.getString(R.string.signin_request)).setContentText(ctx.getString(R.string.signin_unlock)).build()
        val b = base(ctx, CH_SIGNIN)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text + "\n" + ctx.getString(if (r.isMove) R.string.signin_move_warning else R.string.signin_only_yours)))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(hidden)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .addAction(NotificationCompat.Action.Builder(R.drawable.ic_close, ctx.getString(R.string.deny), deny).build())
            .addAction(
                NotificationCompat.Action.Builder(R.drawable.ic_check, ctx.getString(R.string.approve), approve)
                    .setAuthenticationRequired(true)
                    .build(),
            )
        val left = r.expiresAt - r.createdAt
        if (left > 0) b.setTimeoutAfter(left)
        post(ctx, id, b.build(), TAG_SIGNIN)
    }

    fun cancelSignIn(ctx: Context, requestId: String) = cancel(ctx, signInId(requestId), TAG_SIGNIN)

    // ---------------------------------------------------------------- ringing & alerts (server 1.3)

    /** "Ringing from Desktop" with Stop, while this phone rings. Tapping it opens Beam, which stops it too. */
    fun ringing(ctx: Context, by: String?) {
        val stop = PendingIntent.getBroadcast(ctx, ID_RING, ActionReceiver.stopRingingIntent(ctx), IMMUTABLE)
        val n = base(ctx, CH_RING)
            .setContentTitle(if (by != null) ctx.getString(R.string.ring_title, by) else ctx.getString(R.string.ring_title_unknown))
            .setContentText(ctx.getString(R.string.ring_text))
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(true)
            .setContentIntent(mainIntent(ctx))
            .addAction(R.drawable.ic_close, ctx.getString(R.string.ring_stop), stop)
            .build()
        post(ctx, ID_RING, n)
    }

    /** A server alert: low battery or storage, a device offline (or back), the server's disk. */
    fun alert(ctx: Context, alert: Alert, deviceName: String?) {
        // The alert's text names the device itself; a device this phone doesn't know (yet) gets just "Beam".
        val title = deviceName ?: if (alert.device == null) ctx.getString(R.string.alert_server) else ctx.getString(R.string.app_name)
        val open = alert.device?.let { conversationIntent(ctx, it) } ?: mainIntent(ctx)
        val n = base(ctx, CH_ALERTS)
            .setContentTitle(title)
            .setContentText(alert.text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(alert.text))
            .setWhen(if (alert.at > 0) alert.at else System.currentTimeMillis())
            .setShowWhen(true)
            .setAutoCancel(true)
            .setSilent(alert.level == "info")
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setContentIntent(open)
            .build()
        // One per device and kind; "back online" replaces "offline".
        val kind = if (alert.kind == "offline" || alert.kind == "online") "presence" else alert.kind
        post(ctx, "alert:$kind:${alert.device ?: "server"}".hashCode(), n)
    }

    // ---------------------------------------------------------------- server moves

    fun serverMoved(ctx: Context, newAddress: String) {
        val n = base(ctx, CH_SERVER)
            .setContentTitle(ctx.getString(R.string.moved_title, newAddress.substringAfter("://")))
            .setContentText(ctx.getString(R.string.moved_body))
            .setAutoCancel(true)
            .setContentIntent(mainIntent(ctx))
            .build()
        post(ctx, "moved".hashCode(), n)
    }

    fun cancelSignedOut(ctx: Context) = cancel(ctx, "signedOut".hashCode())

    /** The server signed this phone out (401) while Beam wasn't on screen: say so once. */
    fun signedOut(ctx: Context) {
        val body = ctx.getString(R.string.signed_out_body)
        val n = base(ctx, CH_SERVER)
            .setContentTitle(ctx.getString(R.string.signed_out_title))
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(mainIntent(ctx))
            .build()
        post(ctx, "signedOut".hashCode(), n)
    }

    fun moveRejected(ctx: Context, claimedAddress: String) {
        val body = ctx.getString(R.string.moved_rejected_body)
        val n = base(ctx, CH_SERVER)
            .setContentTitle(ctx.getString(R.string.moved_rejected_title, claimedAddress.substringAfter("://")))
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(mainIntent(ctx))
            .build()
        post(ctx, "moved".hashCode(), n)
    }

    // ---------------------------------------------------------------- app updates

    /** "Beam update ready (v1.2.0): tap to install". */
    /** An update to install; [problem]: why its last try didn't install (Android's words), shown in full. */
    fun updateReady(ctx: Context, update: AppUpdate, problem: String? = null) {
        val install = PendingIntent.getActivity(ctx, ID_UPDATE, UpdateActivity.intent(ctx), IMMUTABLE)
        val text = if (problem != null) ctx.getString(R.string.update_last_try, problem) else ctx.getString(R.string.update_tap)
        val n = base(ctx, CH_UPDATES)
            .setContentTitle(ctx.getString(R.string.update_ready, update.version))
            .setContentText(text)
            .apply { if (problem != null) setStyle(NotificationCompat.BigTextStyle().bigText(text)) }
            .setAutoCancel(true)
            .setContentIntent(install)
            .addAction(R.drawable.ic_download, ctx.getString(R.string.update_install), install)
            .build()
        post(ctx, ID_UPDATE, n)
    }

    /**
     * Android wants the user to confirm an update Beam started in the background: tapping shows Android's
     * own confirmation (an activity can't be opened from the background).
     */
    fun updateNeedsConfirmation(ctx: Context, version: String?, confirm: Intent) {
        val pi = PendingIntent.getActivity(ctx, ID_UPDATE + 1, confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), IMMUTABLE)
        val n = base(ctx, CH_UPDATES)
            .setContentTitle(if (version != null) ctx.getString(R.string.update_ready, version) else ctx.getString(R.string.update_title))
            .setContentText(ctx.getString(R.string.update_confirm))
            .setAutoCancel(true)
            .setContentIntent(pi)
            .addAction(R.drawable.ic_download, ctx.getString(R.string.update_install), pi)
            .build()
        post(ctx, ID_UPDATE, n)
    }

    // ---------------------------------------------------------------- ongoing

    fun connection(ctx: Context, conn: Repository.Conn, offline: Repository.Offline? = null): Notification {
        val title = when {
            conn == Repository.Conn.CONNECTED -> ctx.getString(R.string.connection_ready)
            conn == Repository.Conn.AUTH_FAILED -> ctx.getString(R.string.connection_key_rejected)
            conn == Repository.Conn.OFFLINE && offline == Repository.Offline.TAILSCALE_OFF -> ctx.getString(R.string.offline_tailscale_short)
            conn == Repository.Conn.OFFLINE && offline == Repository.Offline.NO_NETWORK -> ctx.getString(R.string.offline_no_network_short)
            conn == Repository.Conn.OFFLINE -> ctx.getString(R.string.connection_waiting)
            else -> ctx.getString(R.string.connecting)
        }
        return base(ctx, CH_CONNECTION)
            .setContentTitle(title)
            .setContentText(if (conn == Repository.Conn.AUTH_FAILED) ctx.getString(R.string.auth_failed) else ctx.getString(R.string.connection_body))
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setContentIntent(mainIntent(ctx))
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_DEFERRED)
            .build()
    }

    /**
     * The ongoing "Sending… / Receiving…" notification. Big transfers use Android 16's progress-centric
     * style, which the system may promote to a Live Update chip in the status bar.
     */
    fun transfers(ctx: Context, title: String, text: String, percent: Int, indeterminate: Boolean, big: Boolean): Notification {
        val cancel = PendingIntent.getBroadcast(ctx, 7, ActionReceiver.cancelTransfersIntent(ctx), IMMUTABLE)
        val b = base(ctx, CH_TRANSFERS)
            .setContentTitle(title)
            .setContentText(text)
            .setProgress(100, percent, indeterminate)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setContentIntent(mainIntent(ctx))
            .addAction(R.drawable.ic_close, ctx.getString(R.string.cancel), cancel)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
        if (big && Build.VERSION.SDK_INT >= 36) {
            b.setStyle(
                NotificationCompat.ProgressStyle()
                    .addProgressSegment(NotificationCompat.ProgressStyle.Segment(100))
                    .setProgress(percent)
                    .setProgressIndeterminate(indeterminate)
                    .setStyledByProgress(true),
            )
            b.setRequestPromotedOngoing(true)
            if (!indeterminate) b.setShortCriticalText("$percent%")
        }
        return b.build()
    }

    /** Android's daily limit for background transfers ran out: everything is paused, one tap resumes it. */
    fun transfersPaused(ctx: Context) {
        val resume = PendingIntent.getForegroundService(ctx, 11, TransferService.resumeIntent(ctx), IMMUTABLE)
        val n = base(ctx, CH_TRANSFERS)
            .setContentTitle(ctx.getString(R.string.transfers_paused))
            .setContentText(ctx.getString(R.string.transfers_paused_body))
            .setStyle(NotificationCompat.BigTextStyle().bigText(ctx.getString(R.string.transfers_paused_body)))
            .setAutoCancel(true)
            .setContentIntent(resume)
            .addAction(R.drawable.ic_refresh, ctx.getString(R.string.resume), resume)
            .build()
        post(ctx, ID_PAUSED, n)
    }

    private fun thumbnail(ctx: Context, uri: Uri): Bitmap? = try {
        ImageDecoder.decodeBitmap(ImageDecoder.createSource(ctx.contentResolver, uri)) { decoder, info, _ ->
            val longest = maxOf(info.size.width, info.size.height)
            if (longest > 768) {
                val scale = 768.0 / longest
                decoder.setTargetSize((info.size.width * scale).toInt().coerceAtLeast(1), (info.size.height * scale).toInt().coerceAtLeast(1))
            }
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
        }
    } catch (_: Exception) {
        null
    }
}
