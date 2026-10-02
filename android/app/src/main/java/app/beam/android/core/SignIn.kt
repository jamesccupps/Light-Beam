package app.beam.android.core

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.TimeUnit
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** A new device asking to sign in (SSE `login-request`, `GET /api/login-requests`). */
data class LoginRequest(
    val id: String,
    /** Formatted like "K7QM-4R2X". */
    val code: String,
    val name: String,
    val platform: String,
    /** Where it comes from, e.g. "work-laptop (100.64.0.50)". */
    val where: String,
    val createdAt: Long,
    val expiresAt: Long,
    /** The requesting device's own id (API v3), so a device can ignore its own request. */
    val deviceId: String? = null,
    /** Who is asking according to Tailscale, e.g. "robin@example.com on work-laptop" (API v3, when known). */
    val who: String? = null,
    /** "move": the request asks for a full copy of this Beam (`node server.js import-from`), not a sign-in. */
    val purpose: String = "sign-in",
) {
    val isMove get() = purpose == "move"

    companion object {
        fun parse(o: JSONObject): LoginRequest {
            val ts = o.optJSONObject("tailscale")
            val login = o.str("tailscaleUser") ?: ts?.str("login") ?: ts?.str("user")
            val node = o.str("tailscaleNode") ?: ts?.str("node") ?: ts?.str("host")
            val where = o.str("where").orEmpty()
            // `where` usually names the Tailscale machine and account already; only add what it leaves out.
            val who = o.str("who") ?: listOfNotNull(login?.takeIf { it !in where }, node?.takeIf { it !in where })
                .joinToString(" on ").ifEmpty { null }
            return LoginRequest(
                id = o.optString("id"),
                code = o.optString("code"),
                name = o.str("name") ?: "New device",
                platform = o.str("platform") ?: "web",
                where = where,
                createdAt = o.optLong("createdAt"),
                expiresAt = o.optLong("expiresAt"),
                deviceId = o.str("deviceId"),
                who = who?.takeIf { it.isNotBlank() },
                purpose = o.str("purpose") ?: "sign-in",
            )
        }
    }
}

/** `GET /api/hello`: proof that an address is a Beam server, and which one. */
data class Hello(
    val version: String,
    val serverId: String?,
    val movedTo: String?,
    /** API version (2 for servers that don't say). */
    val api: Int = 2,
    /** HMAC over serverId + nonce with this device's secret, when asked for (API v3). */
    val proof: String? = null,
    /** Every address this Beam is known by (API v3), for finding it again after a move. */
    val urls: List<String> = emptyList(),
)

/** A sign-in request this device made, waiting for approval on a signed-in device. */
data class SignInTicket(val id: String, val code: String, val secret: String, val approveUrl: String, val expiresAt: Long)

/** The key (and the server's preferred address) handed to a device that signed in. */
data class SignInResult(val key: String, val server: String?)

sealed interface PollResult {
    data object Pending : PollResult
    data object Denied : PollResult
    /** Expired or unknown: create a fresh request. */
    data object Expired : PollResult
    data class Approved(val key: String, val server: String?, val approvedBy: String?) : PollResult
}

/** The address answered, but not like a Beam server. */
class NotBeamServerException : IOException("That address doesn't answer like a Beam server")

/**
 * Proof that a server holds this device's secret (docs/API.md, API v3 "Proof for moves"). A server that
 * merely claims to be ours (same serverId) must also prove it knows the key before the app follows it.
 */
object Proof {
    private fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)
    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

    /** Which secret the proof is for: the first 16 hex digits of sha256(sha256(secret)). */
    fun tokenId(secret: String): String = hex(sha256(sha256(secret.toByteArray()))).take(16)

    /** hex(HMAC-SHA256(key = sha256(secret), serverId + ':' + nonce)). */
    fun expected(secret: String, serverId: String, nonce: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(sha256(secret.toByteArray()), "HmacSHA256"))
        return hex(mac.doFinal("$serverId:$nonce".toByteArray()))
    }

    fun nonce(): String = hex(ByteArray(16).also { SecureRandom().nextBytes(it) })

    fun matches(secret: String, serverId: String, nonce: String, proof: String?): Boolean =
        proof != null && MessageDigest.isEqual(expected(secret, serverId, nonce).toByteArray(), proof.lowercase().toByteArray())
}

/**
 * The calls a device can make before it has a key: find the server, sign in with the password, sign in
 * by its Tailscale identity, or ask a signed-in device to approve it (docs/API.md, "Signing in a new device").
 */
class SignInClient(baseUrl: String, client: OkHttpClient? = null) {
    val base: HttpUrl = baseUrl.toHttpUrl()
    private val http: OkHttpClient = (client ?: BeamApi.defaultClient()).newBuilder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(35, TimeUnit.SECONDS) // long polls answer within 20 s
        .addInterceptor { c -> c.proceed(c.request().newBuilder().header("X-Beam-App-Version", BeamApi.APP_VERSION).build()) }
        .build()

    private fun url(path: String) = base.beamPath(path)

    private fun json(req: Request, holder: CallHolder? = null): JSONObject {
        val call = http.newCall(req)
        holder?.set(call)
        call.execute().use { res ->
            if (!res.isSuccessful) throw errorOf(res)
            val text = res.body?.string().orEmpty()
            return try {
                JSONObject(text.ifBlank { "{}" })
            } catch (_: JSONException) {
                throw NotBeamServerException()
            }
        }
    }

    /** `GET /api/hello`. Throws [NotBeamServerException] if this isn't Beam. */
    fun hello(): Hello = hello(null, null)

    /**
     * `GET /api/hello?nonce=N&tid=T`: with a [secret], the server (API v3) also proves it knows it.
     * Check the result with [Proof.matches].
     */
    fun hello(secret: String?, nonce: String?): Hello {
        val u = url("/api/hello").newBuilder().apply {
            if (secret != null && nonce != null) {
                addQueryParameter("nonce", nonce)
                addQueryParameter("tid", Proof.tokenId(secret))
            }
        }.build()
        val o = try {
            json(Request.Builder().url(u).get().build())
        } catch (e: BeamException) {
            if (e.status == 404) throw NotBeamServerException()
            throw e
        }
        if (!o.optBoolean("beam")) throw NotBeamServerException()
        return Hello(
            o.optString("version"),
            o.str("serverId")?.takeIf { it.isNotBlank() },
            o.str("movedTo")?.takeIf { it.isNotBlank() },
            o.optInt("api", 2),
            o.str("proof")?.takeIf { it.isNotBlank() },
            o.optJSONArray("urls").strings(),
        )
    }

    /**
     * `POST /api/autopair { client: 'app', ... }` (API v3): signs this device in without any step when the
     * server recognises its owner by Tailscale identity. Throws [BeamException] (403) when it can't.
     */
    fun autopair(deviceId: String, name: String, platform: String = "android", profile: String? = null): SignInResult {
        val body = JSONObject().put("client", "app").put("deviceId", deviceId).put("name", name).put("platform", platform)
            .toString().toRequestBody(BeamApi.JSON)
        val req = Request.Builder().url(url("/api/autopair")).post(body)
            .header("X-Beam-Device-Id", deviceId)
            .header("X-Beam-Device", encodeURIComponent(name))
            .header("X-Beam-Platform", platform)
            .apply { if (profile != null) header("X-Beam-Profile", profile) }
            .build()
        val o = json(req)
        val key = o.str("key")?.takeIf { it.isNotBlank() } ?: throw BeamException("This server can't sign in apps automatically", 403)
        return SignInResult(key, o.str("server")?.takeIf { it.isNotBlank() })
    }

    /**
     * `POST /api/login` with the sign-in password (or a pairing link/key). 403: wrong, 429: locked out.
     * [deviceId] ties the key the server hands out (API v3: this device's own token) to this device.
     */
    fun loginWithPassword(secret: String, deviceId: String? = null): SignInResult {
        val body = JSONObject().put("secret", secret).put("client", "app").apply { if (deviceId != null) put("deviceId", deviceId) }
            .toString().toRequestBody(BeamApi.JSON)
        val o = json(Request.Builder().url(url("/api/login")).post(body).build())
        val key = o.str("key") ?: throw IOException("The server didn't send a key")
        return SignInResult(key, o.str("server")?.takeIf { it.isNotBlank() })
    }

    /** `POST /api/login-requests`: returns the code and QR link to show, and the secret for polling. */
    fun createRequest(name: String, platform: String = "android", deviceId: String? = null): SignInTicket {
        val body = JSONObject().put("name", name).put("platform", platform).apply { if (deviceId != null) put("deviceId", deviceId) }
            .toString().toRequestBody(BeamApi.JSON)
        val o = json(Request.Builder().url(url("/api/login-requests")).post(body).build())
        return SignInTicket(o.optString("id"), o.optString("code"), o.optString("secret"), o.optString("approveUrl"), o.optLong("expiresAt"))
    }

    /** `GET /api/login-requests/{id}?wait`: returns within ~20 s with the request's state. */
    fun poll(ticket: SignInTicket, wait: Boolean = true, holder: CallHolder? = null): PollResult {
        val u = url("/api/login-requests/${ticket.id}").newBuilder().apply { if (wait) addQueryParameter("wait", "") }.build()
        val req = Request.Builder().url(u).get().header("X-Beam-Login-Secret", ticket.secret).build()
        val o = try {
            json(req, holder)
        } catch (e: BeamException) {
            if (e.status == 404) return PollResult.Expired
            throw e
        }
        return when (o.optString("status")) {
            "approved" -> PollResult.Approved(o.optString("key"), o.str("server")?.takeIf { it.isNotBlank() }, o.str("approvedBy"))
            "denied" -> PollResult.Denied
            "expired", "withdrawn" -> PollResult.Expired
            else -> PollResult.Pending
        }
    }

    /**
     * `DELETE /api/login-requests/{id}`: the user closed the sign-in screen, so signed-in devices stop
     * being asked. Best effort.
     */
    fun withdraw(ticket: SignInTicket) {
        try {
            val req = Request.Builder().url(url("/api/login-requests/${ticket.id}")).delete().header("X-Beam-Login-Secret", ticket.secret).build()
            http.newCall(req).execute().close()
        } catch (_: IOException) {
        }
    }
}

/** Finds the Beam server behind what someone typed (see [Pairing.serverCandidates]). */
object ServerFinder {
    data class Found(val baseUrl: String, val hello: Hello)

    /**
     * Returns the first candidate that answers `/api/hello` like Beam, following `movedTo` if the
     * server says it moved (only when the new address is the same Beam). Throws the last error otherwise.
     */
    fun find(input: String, client: OkHttpClient? = null): Found {
        val candidates = Pairing.serverCandidates(input)
        if (candidates.isEmpty()) throw IllegalArgumentException("Enter your Beam server's address, like my-pc.tailnet.ts.net")
        var last: Exception = NotBeamServerException()
        for (base in candidates) {
            try {
                val hello = SignInClient(base, client).hello()
                val moved = hello.movedTo?.let { Pairing.normalizeServer(it) }
                if (moved != null && moved != base) {
                    val there = SignInClient(moved, client).hello()
                    if (there.serverId == null || there.serverId == hello.serverId) return Found(moved, there)
                }
                return Found(base, hello)
            } catch (e: Exception) {
                last = e
            }
        }
        throw last
    }
}
