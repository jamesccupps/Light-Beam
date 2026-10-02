package app.beam.android.core

import okhttp3.OkHttpClient
import java.net.ServerSocket
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import kotlin.random.Random

/**
 * Test clients that look like separate machines to the server. Every test client connects from 127.0.0.1,
 * which the server treats as one machine: it would merge browsers into apps there and treat a new app of
 * the same kind as a reinstall of an older one ("Unknown device" failures, borrowed history). Each fake
 * device therefore gets its own Tailscale-style address via X-Forwarded-For (trusted from loopback).
 */
object TestNet {
    private val next = AtomicInteger(Random.nextInt(1, 60_000))

    fun newId(): String = UUID.randomUUID().toString().replace("-", "")

    /** A fresh address in 100.64.0.0/10 (Tailscale's range). */
    fun tailscaleIp(): String {
        val n = next.incrementAndGet()
        return "100.${64 + (n shr 16) % 64}.${(n shr 8) and 255}.${(n and 255).coerceAtLeast(1)}"
    }

    fun client(ip: String = tailscaleIp()): OkHttpClient = BeamApi.defaultClient().newBuilder()
        .addInterceptor { c -> c.proceed(c.request().newBuilder().header("X-Forwarded-For", ip).build()) }
        .build()

    /** A device on its own (fake) machine; pass the same [ip] to put several on one machine. */
    fun device(url: String, key: String, name: String, platform: String = "android", id: String = newId(), ip: String = tailscaleIp()) =
        BeamApi(url, key, id, name, platform, client(ip))

    /** Ports handed out recently (a server may not be listening on them yet). */
    private val handedOut = java.util.concurrent.ConcurrentHashMap<Int, Long>()

    /**
     * A TCP port nobody listens on right now (for scratch servers started by tests). BEAM_TEST_PORTS
     * ("8813-8819") keeps them inside a range; otherwise any free port.
     */
    fun freePort(): Int {
        val spec = System.getProperty("beam.test.ports")?.takeIf { it.isNotBlank() } ?: System.getenv("BEAM_TEST_PORTS")
        val range = spec?.split('-')?.mapNotNull { it.trim().toIntOrNull() }
        if (range != null && range.size == 2) {
            for (p in range[0]..range[1]) {
                if (System.currentTimeMillis() - (handedOut[p] ?: 0L) < 30_000) continue
                val free = try {
                    ServerSocket(p, 1, java.net.InetAddress.getByName("127.0.0.1")).use { true }
                } catch (_: Exception) {
                    false
                }
                if (free) {
                    handedOut[p] = System.currentTimeMillis()
                    return p
                }
            }
            throw IllegalStateException("No free port in BEAM_TEST_PORTS=${range[0]}-${range[1]}")
        }
        return ServerSocket(0).use { it.localPort }
    }
}
