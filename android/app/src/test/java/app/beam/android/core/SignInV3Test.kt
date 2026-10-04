package app.beam.android.core

import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.Files

/**
 * API v3 sign-in against a scratch server started for the test (needs BEAM_SERVER_JS): an owner's phone
 * signs in with no step at all (Tailscale identity), strangers don't, pairing links become the device's
 * own token, and a server proves it knows a device's secret.
 */
class SignInV3Test {
    private val serverJs = System.getProperty("beam.server.js").orEmpty()
    private var process: Process? = null
    private var data: File? = null
    private lateinit var base: String
    private lateinit var master: String

    @Before
    fun start() {
        assumeTrue("Set BEAM_SERVER_JS to run the v3 sign-in tests", serverJs.isNotEmpty())
        val port = TestNet.freePort()
        val dir = Files.createTempDirectory("beam-v3-signin").toFile().also { data = it }
        val pb = ProcessBuilder("node", serverJs).redirectErrorStream(true).redirectOutput(File(dir, "server.log"))
        pb.environment().apply {
            put("BEAM_HOST", "127.0.0.1")
            put("BEAM_PORT", port.toString())
            put("BEAM_DATA", dir.absolutePath)
            put("BEAM_DIST", dir.absolutePath)
            put("BEAM_TAILSCALE", "off") // identities come from the Tailscale-User-Login header only
            put("BEAM_TAILSCALE_OWNERS", OWNER)
            remove("BEAM_PUBLIC_URL")
            remove("BEAM_MOVED_TO")
        }
        process = pb.start()
        base = "http://127.0.0.1:$port"
        val deadline = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < deadline) {
            try {
                val c = URL("$base/api/hello").openConnection() as HttpURLConnection
                c.connectTimeout = 500
                if (c.responseCode == 200) break
            } catch (_: Exception) {
            }
            Thread.sleep(150)
        }
        master = File(dir, "key").readText().trim()
    }

    @After
    fun stop() {
        process?.destroyForcibly()?.waitFor()
        data?.deleteRecursively()
    }

    /** What `tailscale serve` adds in front of Beam: the caller's Tailscale address and account. */
    private fun viaTailscale(login: String?, ip: String = TestNet.tailscaleIp()): OkHttpClient =
        BeamApi.defaultClient().newBuilder().addInterceptor { c ->
            val b = c.request().newBuilder().header("X-Forwarded-For", ip)
            if (login != null) b.header("Tailscale-User-Login", login)
            c.proceed(b.build())
        }.build()

    /**
     * Since server 1.7.2 an automatic sign-in needs Tailscale itself (tailscaled's whois) to confirm who is calling:
     * the Tailscale-User-Login header alone (here, without a tailscaled: BEAM_TAILSCALE=off) signs nobody in, not even
     * as the owner. (The owner's phone signing in with a confirmed identity is covered by the server's own tests, which
     * fake tailscaled's LocalAPI.) Was "an owner's phone signs in without any step", written before that rule.
     */
    @Test
    fun aTailscaleHeaderAloneSignsNobodyIn() {
        for (login in listOf(OWNER, "stranger@example.com", null)) {
            try {
                SignInClient(base, viaTailscale(login)).autopair(TestNet.newId(), "Other Phone")
                fail("expected 403 for $login")
            } catch (e: BeamException) {
                assertEquals(403, e.status)
            }
        }
        assertFalse("nobody new among the devices", TestNet.device(base, master, "Desk", "windows").devices().devices.any { it.name == "Other Phone" })
    }

    @Test
    fun aPairingLinkBecomesTheNewDevicesOwnToken() {
        val desk = TestNet.device(base, master, "Desk", "windows")
        val pairing = desk.pairInfo()
        val secret = pairing.getString("key")
        assertTrue(secret, secret.startsWith("bp_"))
        val link = Pairing.parse(pairing.optString("link").ifEmpty { Pairing.link(base, secret) })!!
        assertEquals(secret, link.key)
        val id = TestNet.newId()
        val phone = BeamApi(base, link.key, id, "Linked Phone", "android", TestNet.client())
        assertTrue(phone.me())
        assertTrue("keeps working as this phone's key", phone.me())
        assertEquals(id, phone.meResult().you)
        assertFalse("never the master key", link.key == master)
    }

    @Test
    fun theServerProvesItKnowsTheSecret() {
        val nonce = Proof.nonce()
        val hello = SignInClient(base).hello(master, nonce)
        assertTrue(hello.api >= 3)
        val serverId = hello.serverId!!
        assertTrue(Proof.matches(master, serverId, nonce, hello.proof))
        assertFalse("another nonce", Proof.matches(master, serverId, Proof.nonce(), hello.proof))
        assertFalse("another secret", Proof.matches("not-the-key", serverId, nonce, hello.proof))
        // Device tokens too: a phone's own, from a pairing link (an automatic sign-in needs a real tailscaled since 1.7.2).
        val token = TestNet.device(base, master, "Desk", "windows").pairInfo().getString("key")
        val phone = BeamApi(base, token, TestNet.newId(), "Proof Phone", "android", TestNet.client())
        assertTrue(phone.me())
        val n2 = Proof.nonce()
        assertTrue(Proof.matches(token, serverId, n2, SignInClient(base).hello(token, n2).proof))
    }

    companion object {
        const val OWNER = "owner@example.com"
    }
}
