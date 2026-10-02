package app.beam.android

import android.os.Looper
import android.os.NetworkOnMainThreadException
import okhttp3.OkHttpClient
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Debug builds only: fails any request the app makes on the main thread, the way Android does on a phone.
 * Robolectric tests don't enforce that themselves (the 1.1.0 "Check for updates" bug slipped through), so
 * the tests also assert [violations] stays empty.
 */
object MainThreadGuard {
    val violations = CopyOnWriteArrayList<String>()

    /** Debug builds: the latest requests the app made ("GET /api/items"), for the idle-cost tests. */
    private val recent = java.util.concurrent.ConcurrentLinkedDeque<Pair<Long, String>>()
    private val counter = java.util.concurrent.atomic.AtomicLong()

    /** How many requests so far; pass it to [requestsSince]. */
    fun mark(): Long = counter.get()

    /** The requests after [mark] (of the last [KEEP]). */
    fun requestsSince(mark: Long): List<String> = recent.filter { it.first > mark }.map { it.second }

    private const val KEEP = 2_000

    fun install(client: OkHttpClient): OkHttpClient {
        if (!BuildConfig.DEBUG) return client
        return client.newBuilder().addInterceptor { chain ->
            val onMain = try {
                Looper.getMainLooper()?.isCurrentThread == true
            } catch (_: Throwable) {
                false
            }
            if (onMain) {
                violations += chain.request().url.toString()
                throw NetworkOnMainThreadException()
            }
            recent.addLast(counter.incrementAndGet() to chain.request().method + " " + chain.request().url.encodedPath)
            while (recent.size > KEEP) recent.pollFirst()
            chain.proceed(chain.request())
        }.build()
    }
}
