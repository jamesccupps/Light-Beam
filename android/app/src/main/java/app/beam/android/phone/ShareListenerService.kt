package app.beam.android.phone

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import app.beam.android.BeamApp

/**
 * Android's notification access for "Notifications on your PCs". Everything happens in [PhoneNotifications]; with
 * the switch off this unbinds itself right away (and Android leaves it unbound until the switch goes on again).
 */
class ShareListenerService : NotificationListenerService() {
    private val phone get() = BeamApp.from(this).phone

    override fun onListenerConnected() {
        super.onListenerConnected()
        phone.onListenerConnected(this)
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        phone.onListenerDisconnected(this)
    }

    override fun onNotificationPosted(sbn: StatusBarNotification, rankingMap: RankingMap?) {
        phone.onPosted(this, sbn, rankingMap)
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        phone.onPosted(this, sbn, null)
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification, rankingMap: RankingMap?, reason: Int) {
        phone.onRemoved(sbn)
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification, rankingMap: RankingMap?) {
        phone.onRemoved(sbn)
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        phone.onRemoved(sbn)
    }
}
