package app.beam.android.update

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import app.beam.android.service.InstallReceiver
import java.io.File

/**
 * Installs a downloaded, SHA-256-verified Beam update with a PackageInstaller session.
 *
 * Everything that installs APKs lives in this package plus AppUpdater, UpdateActivity and InstallReceiver
 * (and the REQUEST_INSTALL_PACKAGES / UPDATE_PACKAGES_WITHOUT_USER_ACTION permissions): a build for an
 * app store leaves exactly those out.
 */
object SelfInstaller {
    /**
     * Android 12+ lets an app update itself without asking, once the user allowed it to install apps
     * ("Install unknown apps"). Android still asks when it wants to (e.g. the first time); the result then
     * says STATUS_PENDING_USER_ACTION.
     */
    fun canInstallQuietly(ctx: Context): Boolean =
        Build.VERSION.SDK_INT >= 31 && ctx.packageManager.canRequestPackageInstalls()

    /**
     * Writes [file] into a new session and commits it; the result arrives at [InstallReceiver]. [created] gets the
     * session's id before the commit (only its answer counts from then on). Blocking.
     */
    fun install(ctx: Context, file: File, created: (Int) -> Unit) {
        val installer = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(ctx.packageName)
        params.setSize(file.length())
        if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        val sessionId = installer.createSession(params)
        created(sessionId)
        // Earlier tries still open (one waiting on a prompt nobody answered, one cut off) are given up: only this one
        // counts (Android answers an abandoned one "aborted", which is then ignored).
        for (old in installer.mySessions) if (old.sessionId != sessionId) runCatching { installer.abandonSession(old.sessionId) }
        installer.openSession(sessionId).use { session ->
            session.openWrite("beam.apk", 0, file.length()).use { out ->
                file.inputStream().use { it.copyTo(out, 256 * 1024) }
                session.fsync(out)
            }
            val status = PendingIntent.getBroadcast(
                ctx, sessionId,
                // (which try it answers, whether or not Android says)
                Intent(ctx, InstallReceiver::class.java).setAction(InstallReceiver.ACTION_STATUS).putExtra(InstallReceiver.EXTRA_SESSION, sessionId),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE, // the installer adds the result
            )
            session.commit(status.intentSender)
        }
    }
}
