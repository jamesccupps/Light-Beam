package app.beam.android.core

import app.beam.android.BuildConfig
import okhttp3.Call
import okhttp3.ConnectionPool
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okio.BufferedSink
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/**
 * An HTTP error reported by the server (4xx/5xx). Transport failures are plain [IOException]s instead,
 * so callers can tell "retry later" apart from "the server said no".
 */
class BeamException(
    message: String,
    val status: Int,
    /** For upload errors (409 and friends) the server reports its actual offset. */
    val offset: Long? = null,
    /** With 410: the server moved to this address (docs/API.md, "When the server moves"). */
    val movedTo: String? = null,
    /** Machine-readable reason some v3 endpoints add (e.g. autopair's 403). */
    val reason: String? = null,
    /** The body was Beam's own JSON error (`{"error": …}`), not some proxy's page. */
    val fromBeam: Boolean = false,
    /** The answering server's id (server 1.4 puts it in a 401), to tell it from another Beam at the same address. */
    val serverId: String? = null,
) : Exception(message)

/** Turns an unsuccessful response into a [BeamException] with the server's plain-language message. */
fun errorOf(res: Response): BeamException {
    val text = try { res.body?.string().orEmpty() } catch (_: IOException) { "" }
    val o = try { JSONObject(text) } catch (_: JSONException) { null }
    val message = o?.str("error") ?: when (res.code) {
        401 -> "The pairing key was rejected"
        404 -> "Not found"
        410 -> "Beam has moved"
        413 -> "Too large for the server"
        429 -> "Too many attempts. Wait a few minutes and try again."
        507 -> "The server's disk is full"
        in 500..599 -> "The server had a problem (HTTP ${res.code})"
        else -> "HTTP ${res.code}"
    }
    val offset = if (o != null && o.has("offset") && !o.isNull("offset")) o.optLong("offset") else null
    val movedTo = o?.str("movedTo")?.takeIf { it.isNotBlank() }
    return BeamException(message, res.code, offset, movedTo, o?.str("reason") ?: o?.str("code"), fromBeam = o?.has("error") == true, serverId = o?.str("serverId"))
}

/** Lets another thread cancel whatever request is currently in flight. */
class CallHolder {
    @Volatile private var call: Call? = null
    @Volatile var cancelled = false
        private set

    fun set(call: Call) {
        this.call = call
        if (cancelled) call.cancel()
    }

    /** Cancels for good: this and every later call. */
    fun cancel() {
        cancelled = true
        call?.cancel()
    }

    /** Aborts only the call in flight (e.g. after a network change); the caller retries at once. */
    fun abortCurrent() {
        call?.cancel()
    }
}

/** Same as JavaScript's encodeURIComponent (URLEncoder writes spaces as '+', which the server won't decode). */
fun encodeURIComponent(s: String): String = URLEncoder.encode(s, "UTF-8").replace("+", "%20")

/**
 * `path` below [base]: `https://nas/beam` + `/api/me` = `https://nas/beam/api/me`. Beam normally lives at
 * the root of its host, but a reverse proxy may serve it under a path prefix.
 */
fun HttpUrl.beamPath(path: String): HttpUrl {
    val prefix = encodedPath.trimEnd('/')
    return newBuilder().encodedPath(prefix + "/" + path.trimStart('/')).query(null).fragment(null).build()
}

/**
 * Client for the Beam server API (docs/API.md). Pure JVM (OkHttp + org.json) so it can be unit-tested
 * against a real server. All calls are blocking; run them off the main thread.
 */
class BeamApi(
    baseUrl: String,
    /** The master key or (API v3) this device's own token. Swapped in place when the server issues a token. */
    @Volatile var key: String,
    val deviceId: String,
    @Volatile var deviceName: String,
    val platform: String = "android",
    client: OkHttpClient? = null,
    /**
     * Which user account on this device the app runs under (`X-Beam-Profile`, API v3): keeps a work profile
     * or a second user from being merged with this one as a "reinstall". Null: not sent.
     */
    val profile: String? = null,
) {
    /** Where the server lives. Switched in place when the server moves, so retries follow it. */
    @Volatile var base: HttpUrl = baseUrl.toHttpUrl()
    val http: OkHttpClient = client ?: defaultClient()

    /** Called (on the calling thread) whenever a call answers 410 with a new address. */
    @Volatile var onMoved: ((String) -> Unit)? = null

    /** Called when a response offers this device its own token (`X-Beam-Token`, API v3). */
    @Volatile var onToken: ((String) -> Unit)? = null

    /** Called when the server says this device is known by another id (`X-Beam-You`, after a merge). */
    @Volatile var onYou: ((String) -> Unit)? = null

    /**
     * Called (on the calling thread) when the server answers 401 with its own error: this device's sign-in was
     * removed, revoked or has expired. Any call counts: API calls, the event stream, transfers.
     */
    @Volatile var onUnauthorized: ((BeamException) -> Unit)? = null

    /**
     * The client for the event stream: its read timeout is the heartbeat window, it has its own connection
     * (so the stream isn't multiplexed into a pooled HTTP/2 connection) and no HTTP/2 pings: the server's
     * own `: ping` comments keep it alive, and extra pings only wake the phone's radio.
     *
     * Over HTTP/1.1 OkHttp also puts the read timeout on the socket itself (SO_TIMEOUT), where it can't change
     * later: a stream opened on screen (70 s) and switched to the background (a heartbeat every 180 s) would die
     * after 70 s. So the socket gets none, and the heartbeat is Okio's timeout alone, which
     * [EventStream.setHeartbeat] changes on the open stream (HTTP/2 streams work that way already).
     */
    fun streamingClient(readTimeoutMs: Long): OkHttpClient =
        http.newBuilder()
            .connectionPool(ConnectionPool(1, 1, TimeUnit.MINUTES))
            .pingInterval(0, TimeUnit.MILLISECONDS)
            .readTimeout(readTimeoutMs, TimeUnit.MILLISECONDS)
            .callTimeout(0, TimeUnit.MILLISECONDS)
            .addNetworkInterceptor { chain ->
                chain.connection()?.socket()?.soTimeout = 0
                chain.proceed(chain.request())
            }
            .build()

    /**
     * A copy that keeps calling the server this one points at now, even after [base] moves on (another server, a new
     * address): to tell the server being left something. Same key, device and client, but none of the hooks, so that
     * server's answer can't move this phone or sign it out of the one it uses now.
     */
    fun pinned(): BeamApi = BeamApi(base.toString(), key, deviceId, deviceName, platform, http, profile)

    fun url(path: String, vararg query: Pair<String, String?>): HttpUrl {
        val b = base.beamPath(path).newBuilder()
        for ((k, v) in query) b.addQueryParameter(k, v)
        return b.build()
    }

    fun request(url: HttpUrl): Request.Builder = Request.Builder()
        .url(url)
        .header("Authorization", "Bearer $key")
        .header("X-Beam-Device-Id", deviceId)
        .header("X-Beam-Device", encodeURIComponent(deviceName))
        .header("X-Beam-Platform", platform)
        .header("X-Beam-App-Version", APP_VERSION)
        .apply { if (profile != null) header("X-Beam-Profile", profile) }

    // ---------------------------------------------------------------- basic calls

    /** `GET /api/me`: true if the key is accepted. Throws [BeamException] 401 for a bad key. */
    fun me(): Boolean = json(request(url("/api/me")).get().build()).optBoolean("ok")

    /**
     * The id the server knows this device by (`you` from `GET /api/me`) and, from API v3, the read markers
     * stored for it (conversation → newest item time read; "all" is the All devices conversation).
     */
    fun meResult(): MeResult {
        val o = json(request(url("/api/me")).get().build())
        return MeResult(o.str("you"), o.optJSONObject("read").longs())
    }

    fun you(): String? = meResult().you

    fun info(): ServerInfo = ServerInfo.parse(json(request(url("/api/info")).get().build()))

    // ---------------------------------------------------------------- sign-in (docs/API.md, "Signing in a new device")

    /** Pending sign-in requests from new devices. */
    fun loginRequests(): List<LoginRequest> {
        val a = json(request(url("/api/login-requests")).get().build()).optJSONArray("requests")
        return if (a == null) emptyList() else (0 until a.length()).mapNotNull { a.optJSONObject(it)?.let(LoginRequest::parse) }
    }

    /** Looks up a pending request by its code (case and dashes don't matter). 404: unknown, 409: already settled. */
    fun loginRequest(code: String): LoginRequest =
        LoginRequest.parse(json(request(url("/api/login-requests", "code" to code)).get().build()))

    /** Approves or denies a sign-in request; returns the new status. */
    fun answerLoginRequest(code: String, approve: Boolean): String {
        val body = JSONObject().put("code", code).toString().toRequestBody(JSON)
        val path = if (approve) "/api/login-requests/approve" else "/api/login-requests/deny"
        return json(request(url(path)).post(body).build()).optString("status")
    }

    /** Sets, changes or (with "") removes the sign-in password. Returns whether one is set now. */
    fun setPassword(password: String): Boolean {
        val body = JSONObject().put("password", password).toString().toRequestBody(JSON)
        return json(request(url("/api/password")).post(body).build()).optBoolean("passwordSet")
    }

    fun pairInfo(): JSONObject = json(request(url("/api/pair")).get().build())

    fun devices(): DevicesResult {
        val o = json(request(url("/api/devices")).get().build())
        return DevicesResult(Device.parseList(o.optJSONArray("devices")), o.str("you"))
    }

    /** `DELETE /api/devices/{id}`: forget a device (API v3 also revokes its tokens). */
    fun forgetDevice(id: String) {
        execute(request(url("/api/devices/$id")).delete().build()).close()
    }

    fun items(): List<Item> = Item.parseList(json(request(url("/api/items")).get().build()).optJSONArray("items"))

    /**
     * `GET /api/items`, or with [since] (a cursor from this server, 1.4 `items-since`) only what changed since:
     * `delta` true → [ItemsPage.items] were created or changed, [ItemsPage.deleted] are gone; false → the full list.
     */
    fun itemsPage(since: String? = null): ItemsPage {
        val u = if (since != null) url("/api/items", "since" to since) else url("/api/items")
        val o = json(request(u).get().build())
        return ItemsPage(Item.parseList(o.optJSONArray("items")), o.optJSONArray("deleted").strings(), o.str("cursor"), o.optBoolean("delta"))
    }

    fun item(id: String): Item = Item.parse(json(request(url("/api/items/$id")).get().build()))

    fun itemText(id: String): String = execute(request(url("/api/items/$id/text")).get().build()).use { it.body?.string().orEmpty() }

    fun ack(id: String): Map<String, Long> =
        json(request(url("/api/items/$id/ack")).post(ByteArray(0).toRequestBody(null)).build()).optJSONObject("delivered").longs()

    fun deleteItem(id: String) {
        execute(request(url("/api/items/$id")).delete().build()).close()
    }

    fun sendText(text: String, to: List<String>, reply: String? = null): Item {
        val body = JSONObject().put("text", text).put("to", JSONArray(to))
        if (reply != null) body.put("reply", reply) // (server 1.14 `replies`)
        return Item.parse(json(request(url("/api/text")).post(body.toString().toRequestBody(JSON)).build()))
    }

    // ---------------------------------------------------------------- API v3: forward, bulk delete, pins, read markers

    /** `POST /api/items/{id}/forward { to }`: a new item from this device (files are copied on the server). */
    fun forward(id: String, to: List<String>): Item {
        val body = JSONObject().put("to", JSONArray(to)).toString().toRequestBody(JSON)
        val o = json(request(url("/api/items/$id/forward")).post(body).build())
        return Item.parse(o.optJSONObject("item") ?: o)
    }

    /**
     * `POST /api/items/{id}/fastlink { hours }` (server 1.13 `fast-links`): a link anyone can download the file with
     * until it runs out, made by Beam Family on the server's machine → its `{ url, expires, … }`.
     */
    fun fastLink(id: String, hours: Int): JSONObject {
        val body = JSONObject().put("hours", hours).toString().toRequestBody(JSON)
        return json(request(url("/api/items/$id/fastlink")).post(body).build()).getJSONObject("link")
    }

    /** `POST /api/items/delete { ids }` → how many were deleted. */
    fun deleteItems(ids: Collection<String>): Int {
        val body = JSONObject().put("ids", JSONArray(ids)).toString().toRequestBody(JSON)
        return json(request(url("/api/items/delete")).post(body).build()).optInt("deleted")
    }

    /** `PATCH /api/items/{id} { pinned }`. */
    fun setPinned(id: String, pinned: Boolean) {
        val body = JSONObject().put("pinned", pinned).toString().toRequestBody(JSON)
        execute(request(url("/api/items/$id")).patch(body).build()).close()
    }

    /** `PUT|DELETE /api/items/{id}/reactions/{emoji}` (server 1.14 `reactions`): this device's reaction on or off. */
    fun react(id: String, emoji: String, on: Boolean) {
        val r = request(url("/api/items/$id/reactions").newBuilder().addPathSegment(emoji).build())
        execute((if (on) r.put(ByteArray(0).toRequestBody(null)) else r.delete()).build()).close()
    }

    /** `PATCH /api/items/{id} { text }` (server 1.14 `edit`): a text's new words → the item. */
    fun editText(id: String, text: String): Item {
        val body = JSONObject().put("text", text).toString().toRequestBody(JSON)
        return Item.parse(json(request(url("/api/items/$id")).patch(body).build()))
    }

    /** `PUT /api/read { conversation, ts }`: conversation is a device id or "all". */
    fun putRead(conversation: String, ts: Long) {
        val body = JSONObject().put("conversation", conversation).put("ts", ts).toString().toRequestBody(JSON)
        execute(request(url("/api/read")).put(body).build()).close()
    }

    // ---------------------------------------------------------------- server 1.3: device status, ring, wake, alerts

    /** `PUT /api/devices/me/status`: this device's battery, storage and OS. */
    fun putStatus(status: DeviceStatus) {
        execute(request(url("/api/devices/me/status")).put(status.toJson().toString().toRequestBody(JSON)).build()).close()
    }

    /** (1.6.2) An update that didn't install, for the server's log: status `update { version, problem }`. */
    fun reportUpdateProblem(version: String, problem: String) {
        val body = JSONObject().put("update", JSONObject().put("version", version).put("problem", problem))
        execute(request(url("/api/devices/me/status")).put(body.toString().toRequestBody(JSON)).build()).close()
    }

    /** `POST /api/devices/{id}/ring { stop }` → whether that device is online (it rings once it gets the event). */
    fun ring(id: String, stop: Boolean = false): Boolean {
        val body = JSONObject().apply { if (stop) put("stop", true) }.toString().toRequestBody(JSON)
        return json(request(url("/api/devices/$id/ring")).post(body).build()).optBoolean("online")
    }

    /** `POST /api/devices/{id}/wake`: Wake-on-LAN packets from the server → how many were sent (409 without MACs). */
    fun wake(id: String): Int = json(request(url("/api/devices/$id/wake")).post(ByteArray(0).toRequestBody(null)).build()).optInt("sent")

    // ---------------------------------------------------------------- server 1.5: the phone's notifications on PCs

    /** `PUT /api/devices/{id}/settings { phoneNotifications }`: whether that device shows the phone's notifications. */
    fun setShowsPhoneNotifications(deviceId: String, on: Boolean) {
        val body = JSONObject().put("phoneNotifications", on).toString().toRequestBody(JSON)
        execute(request(url("/api/devices/$deviceId/settings")).put(body).build()).close()
    }

    /** `PUT /api/phone/notifications/{key}`: shares (or updates) one notification. [body]: see docs/API.md (1.5). */
    fun putPhoneNotification(key: String, body: JSONObject) {
        execute(request(url("/api/phone/notifications/$key")).put(body.toString().toRequestBody(JSON)).build()).close()
    }

    /** `DELETE /api/phone/notifications/{key}`; a notification the server doesn't have (404) is gone already. */
    fun deletePhoneNotification(key: String) {
        try {
            execute(request(url("/api/phone/notifications/$key")).delete().build()).close()
        } catch (e: BeamException) {
            if (e.status != 404) throw e
        }
    }

    /** `DELETE /api/phone/notifications`: all of this phone's (sharing turned off, or access revoked). */
    fun deleteAllPhoneNotifications() {
        execute(request(url("/api/phone/notifications")).delete().build()).close()
    }

    /** `HEAD /api/phone/icons/{sha256}`: whether the server has this app icon (else upload it). */
    fun hasPhoneIcon(sha256: String): Boolean = try {
        execute(request(url("/api/phone/icons/$sha256")).head().build()).close()
        true
    } catch (e: BeamException) {
        if (e.status != 404) throw e
        false
    }

    /** `PUT /api/phone/icons/{sha256}`: an app icon (PNG, at most 32 KB). */
    fun putPhoneIcon(sha256: String, png: ByteArray) {
        execute(request(url("/api/phone/icons/$sha256")).put(png.toRequestBody(PNG)).build()).close()
    }

    /** `POST /api/phone/requests/{rid}`: how a reply, action or dismissal asked for by a PC went. */
    fun answerPhoneRequest(rid: String, ok: Boolean, error: String? = null) {
        val body = JSONObject().put("ok", ok).apply { if (!ok && error != null) put("error", error) }.toString().toRequestBody(JSON)
        execute(request(url("/api/phone/requests/$rid")).post(body).build()).close()
    }

    // ---------------------------------------------------------------- server 1.8.1 `backups`: the apps' settings

    /** `PUT /api/devices/me/backup { install, app: "android", version, settings }`: this install's settings (≤ 32 KB). */
    fun putBackup(install: String, version: String, settings: JSONObject) {
        val body = JSONObject().put("install", install).put("app", "android").put("version", version).put("settings", settings)
        execute(request(url("/api/devices/me/backup")).put(body.toString().toRequestBody(JSON)).build()).close()
    }

    /** `GET /api/devices/{id|me}/backups` → `{ device, name, backups: [{ install, app, version, at, settings }] }`, newest first. */
    fun backups(device: String = "me"): JSONObject = json(request(url("/api/devices/$device/backups")).get().build())

    // ---------------------------------------------------------------- remote control (server 1.6 `remote-control`)

    /** `GET /api/rc/sessions`: who controls which PC right now. */
    fun rcSessions(): List<RcSession> = RcSession.parseList(json(request(url("/api/rc/sessions")).get().build()).optJSONArray("sessions"))

    /** `POST /api/rc/sessions/{id}/end` ("stopped"). One that's unknown or already over is fine. */
    fun endRcSession(id: String) {
        require(RcSession.ID.matches(id)) { "Not a session id" }
        try {
            execute(request(url("/api/rc/sessions/$id/end")).post(JSONObject().put("reason", "stopped").toString().toRequestBody(JSON)).build()).close()
        } catch (e: BeamException) {
            if (e.status != 404 && e.status != 410) throw e
        }
    }

    /** `POST /api/rc/disable`: turns remote control off on PC [device] and ends its sessions (only the PC turns it on). */
    fun disableRemoteControl(device: String) {
        execute(request(url("/api/rc/disable")).post(JSONObject().put("device", device).toString().toRequestBody(JSON)).build()).close()
    }

    /**
     * A sign-in of its own for a page that acts as this device (remote control's viewer): `POST /api/login` with this
     * token in the body (never in a URL, where a proxy in front of the server might log it) answers like a browser's
     * sign-in: a new token for this device, as a cookie. None of the hooks run. The `__Host-beam_key` (1.7.6, audit S-10)
     * or `beam_key` `Set-Cookie` value, or null when the server gave none.
     */
    fun pageSignIn(): String? {
        val req = Request.Builder().url(url("/api/login"))
            .header("X-Beam-Device-Id", deviceId) // binds the new token to this device, even from the master key
            .header("X-Beam-Platform", platform)
            .post(JSONObject().put("secret", key).toString().toRequestBody(JSON)).build()
        return http.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw errorOf(res)
            val cookies = res.headers("Set-Cookie")
            cookies.firstOrNull { it.startsWith("__Host-beam_key=") } ?: cookies.firstOrNull { it.startsWith("beam_key=") }
        }
    }

    /** `POST /api/logout` as the page signed in with [token] (see [pageSignIn]): that token is revoked, never this app's. */
    fun pageSignOut(token: String) = pageSignOut(http, base, token)

    /** `GET /api/alerts`: the most recent alerts, newest last. */
    fun alerts(): List<Alert> {
        val raw = execute(request(url("/api/alerts")).get().build()).use { it.body?.string().orEmpty() }.trim()
        return if (raw.startsWith("[")) Alert.parseList(JSONArray(raw)) else Alert.parseList(JSONObject(raw.ifEmpty { "{}" }).optJSONArray("alerts"))
    }

    /** `GET /api/settings`. */
    fun settings(): JSONObject = json(request(url("/api/settings")).get().build())

    /** `PATCH /api/settings` with the fields to change → the settings after the change. */
    fun patchSettings(change: JSONObject): JSONObject = json(request(url("/api/settings")).patch(change.toString().toRequestBody(JSON)).build())

    // ---------------------------------------------------------------- resumable uploads

    /** Starts a resumable upload. [w]/[h]: a picture's size in pixels (API v3; older servers ignore them). */
    fun createUpload(name: String, size: Long, mime: String, to: List<String>, w: Int = 0, h: Int = 0): UploadInfo {
        val body = JSONObject().put("name", name).put("size", size).put("mime", mime).put("to", JSONArray(to))
        if (w > 0 && h > 0) body.put("w", w).put("h", h)
        return UploadInfo.parse(json(request(url("/api/uploads")).post(body.toString().toRequestBody(JSON)).build()))
    }

    /** `PUT /api/items/{id}/thumb` (API v3): a small JPEG preview of a picture or video this device sent. */
    fun putThumb(id: String, jpeg: ByteArray) {
        execute(request(url("/api/items/$id/thumb")).put(jpeg.toRequestBody(JPEG)).build()).close()
    }

    /** `GET /api/items/{id}/thumb` (API v3): the preview's bytes. */
    fun thumb(id: String): ByteArray = execute(request(url("/api/items/$id/thumb")).get().build()).use { it.body?.bytes() ?: ByteArray(0) }

    fun uploadStatus(id: String): UploadInfo = UploadInfo.parse(json(request(url("/api/uploads/$id")).get().build()))

    fun putChunk(id: String, offset: Long, body: RequestBody, holder: CallHolder): ChunkResult {
        val req = request(url("/api/uploads/$id", "offset" to offset.toString())).put(body).build()
        val o = json(req, holder)
        val item = o.optJSONObject("item")?.let(Item::parse)
        return ChunkResult(o.optLong("offset", if (item != null) item.size else offset), o.optBoolean("done"), item)
    }

    fun cancelUpload(id: String) {
        try {
            execute(request(url("/api/uploads/$id")).delete().build()).close()
        } catch (e: BeamException) {
            if (e.status != 404) throw e
        }
    }

    // ---------------------------------------------------------------- downloads & events

    /**
     * `GET /api/file/{id}`, from byte [from] onwards (HTTP Range). The caller must close the response.
     * Status is 200 (whole file) or 206 (partial).
     */
    fun openFile(id: String, from: Long, holder: CallHolder? = null): Response {
        val b = request(url("/api/file/$id")).get()
        if (from > 0) b.header("Range", "bytes=$from-")
        return execute(b.build(), holder)
    }

    /**
     * A call for `GET /api/events` (with the device also in the query, as the API describes). [mode]:
     * "background" or "foreground" (server 1.4 `stream-modes`; older servers ignore it).
     */
    fun eventsCall(readTimeoutMs: Long, mode: String? = null): Call {
        val params = mutableListOf<Pair<String, String?>>("device" to deviceId, "name" to deviceName, "platform" to platform, "version" to APP_VERSION)
        if (mode != null) params += "mode" to mode
        val u = url("/api/events", *params.toTypedArray())
        val req = request(u).get().header("Accept", "text/event-stream").header("Cache-Control", "no-cache").build()
        return streamingClient(readTimeoutMs).newCall(req)
    }

    /**
     * `POST /api/events/poke` (server 1.4): switches the open event stream [stream] to [mode] without
     * reconnecting; the server sends it what it held back, then `ping {poke: true}`. `alive` false: that stream
     * is gone, reconnect.
     */
    fun poke(stream: String, mode: String?): PokeResult {
        val body = JSONObject().put("stream", stream).apply { if (mode != null) put("mode", mode) }.toString().toRequestBody(JSON)
        val o = json(request(url("/api/events/poke")).post(body).build())
        return PokeResult(o.optBoolean("alive"), o.str("mode"), o.optInt("ping"))
    }

    // ---------------------------------------------------------------- plumbing

    fun execute(req: Request, holder: CallHolder? = null, client: OkHttpClient = http): Response {
        val call = client.newCall(req)
        holder?.set(call)
        val res = call.execute()
        if (!res.isSuccessful) throw res.use { errorFrom(it) }
        noticeToken(res)
        return res
    }

    /** API v3 hands a device that still uses the master key its own token; the app switches to it. */
    fun noticeToken(res: Response) {
        val token = res.header("X-Beam-Token")?.trim()
        if (!token.isNullOrEmpty() && token != key) onToken?.invoke(token)
        val you = res.header("X-Beam-You")?.trim()
        if (!you.isNullOrEmpty() && you != deviceId) onYou?.invoke(you)
    }

    private fun json(req: Request, holder: CallHolder? = null): JSONObject = execute(req, holder).use { res ->
        val text = res.body?.string().orEmpty()
        if (text.isBlank()) return JSONObject()
        try {
            JSONObject(text)
        } catch (e: JSONException) {
            throw IOException("The server sent an unexpected reply (is this a Beam server?)", e)
        }
    }

    fun errorFrom(res: Response): BeamException {
        val e = errorOf(res)
        val movedTo = e.movedTo
        if (e.status == 410 && movedTo != null) onMoved?.invoke(movedTo)
        if (e.status == 401 && e.fromBeam) onUnauthorized?.invoke(e)
        return e
    }

    companion object {
        /** `POST /api/logout` at [base] as the page signed in with [token]: that token is revoked (never an app's). */
        fun pageSignOut(client: OkHttpClient, base: HttpUrl, token: String) {
            // (1.7.6) as a bearer token: it doesn't depend on the cookie's name, which moves to __Host-beam_key
            val req = Request.Builder().url(base.beamPath("/api/logout")).header("Authorization", "Bearer $token").post("{}".toRequestBody(JSON)).build()
            client.newCall(req).execute().use { res -> if (!res.isSuccessful) throw errorOf(res) }
        }

        val JSON = "application/json; charset=utf-8".toMediaType()
        val OCTET = "application/octet-stream".toMediaType()
        val JPEG = "image/jpeg".toMediaType()
        val PNG = "image/png".toMediaType()

        /** Sent with every request (`X-Beam-App-Version`, `version=` on the event stream): the server logs it per device. */
        val APP_VERSION: String = BuildConfig.VERSION_NAME

        /**
         * The client for everything but the event stream. No HTTP/2 pings: over `tailscale serve` they woke the
         * radio every 30 s for up to 5 minutes after every request. Connections that die with a network change
         * are dropped when the network changes (see Connection), and OkHttp retries a request whose reused
         * connection turns out to be dead; timeouts catch the rest.
         */
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .writeTimeout(60, TimeUnit.SECONDS)
            .build()
    }
}

/** Streams exactly [length] bytes from [input] as an upload chunk. Never retried by OkHttp. */
class ChunkBody(
    private val input: InputStream,
    private val length: Long,
    private val onWritten: (Long) -> Unit,
) : RequestBody() {
    override fun contentType() = BeamApi.OCTET
    override fun contentLength() = length
    override fun isOneShot() = true

    override fun writeTo(sink: BufferedSink) {
        val buf = ByteArray(64 * 1024)
        var written = 0L
        while (written < length) {
            val n = input.read(buf, 0, minOf(buf.size.toLong(), length - written).toInt())
            if (n < 0) throw SourceChangedException()
            sink.write(buf, 0, n)
            written += n
            onWritten(written)
        }
    }
}

/** The file being sent got shorter than it was when the upload started. Not retried. */
class SourceChangedException : IOException("The file changed while it was being sent")
