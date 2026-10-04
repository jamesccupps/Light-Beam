package app.beam.android

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.InetSocketAddress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Just enough of a Beam server (1.4 protocol: stream modes + poke, `items?since=`, live downloads) to test the
 * app's side of it without the real server: records what the app asks for and lets a test push events.
 * [features]: what `/api/info` says; without "stream-modes" the `hello` has no stream id (like 1.3.0).
 */
class FakeBeam(private val features: List<String>) : AutoCloseable {
    private val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 50)
    val url: String get() = "http://127.0.0.1:${server.address.port}"

    /** Query strings of every `GET /api/events` and `GET /api/items`, and the bodies of every poke. */
    val eventsRequests = CopyOnWriteArrayList<String>()
    val itemsRequests = CopyOnWriteArrayList<String>()
    val fileRequests = CopyOnWriteArrayList<String>()
    val pokes = CopyOnWriteArrayList<JSONObject>()

    /** Every request but the event stream's, as "METHOD /path". */
    val requests = CopyOnWriteArrayList<String>()

    /** JSON replies sent gzipped (like server 1.4 `gzip`: over 1 KB, when the request accepts it). */
    val gzipped = AtomicInteger()

    /** Poke answers: `alive` true/false, and whether the poke's `ping` goes out on the stream. */
    @Volatile var pokeAlive = true
    @Volatile var answerPokes = true

    /** Heartbeats (seconds after the last write, like server 1.4), and how long a poke's reply trails its ping. */
    @Volatile var pingForeground = 25
    @Volatile var pingBackground = 180
    @Volatile var pokeReplyDelayMs = 0L

    private fun pingFor(mode: String) = if (mode == "background") pingBackground else pingForeground

    /**
     * Every request but `/api/hello` (the event stream too) answers with this status while it isn't 0, the way
     * the real server does: 401 once this device's sign-in is gone, 5xx when it has a problem, 503 while it
     * moves, 410 with [movedTo] after a move. [plain401]: a 401 that isn't Beam's (some proxy's page).
     */
    @Volatile var status = 0
    @Volatile var plain401 = false
    @Volatile var movedTo: String? = null

    /** This server's id: in `/api/hello`, and (like server 1.4) in its 401s unless [serverIdIn401] is off. */
    @Volatile var serverId = "fakebeam01"
    @Volatile var serverIdIn401 = true

    /** How long `GET /api/items` takes to answer; the answer itself is made when the request arrives (a slow link). */
    @Volatile var itemsDelayMs = 0L

    /**
     * Server 1.5 `phone-notifications`: what the phone shares (key → body), its app icons, and its answers to
     * requests (request id → body). [instance] goes into the stream's `hello` (a new one: the server restarted).
     */
    val phoneNotifications = java.util.concurrent.ConcurrentHashMap<String, JSONObject>()
    /**
     * Remote control (1.6, with "remote-control"): the sessions `GET /api/rc/sessions` lists (ended ones drop out),
     * and the ids ended. A viewer page's sign-in: the keys traded with `POST /api/login`, the tokens handed out for
     * them (as the `beam_key` cookie) and the ones signed out again (`POST /api/logout` with the cookie).
     */
    val rcSessions = CopyOnWriteArrayList<JSONObject>()
    val rcEnded = CopyOnWriteArrayList<String>()
    val rcDisabled = CopyOnWriteArrayList<String>()
    val pageKeys = CopyOnWriteArrayList<String>()
    val pageTokens = CopyOnWriteArrayList<String>()
    val pageSignOuts = CopyOnWriteArrayList<String>()

    /** How long that sign-in (`POST /api/login`) takes to answer: the viewer is still signing in meanwhile. */
    @Volatile var loginDelayMs = 0L

    /** How long a notification PUT takes to answer (it's stored at once): the phone's send stays in flight meanwhile. */
    @Volatile var phonePutDelayMs = 0L
    val phoneIcons = java.util.concurrent.ConcurrentHashMap<String, ByteArray>()
    val phoneAnswers = CopyOnWriteArrayList<Pair<String, JSONObject>>()
    @Volatile var instance = "instance1"

    /** Picking several (1.12): the ids of each `POST /api/items/delete`, and each forward (item id to its targets). */
    val bulkDeletes = CopyOnWriteArrayList<List<String>>()
    val forwards = CopyOnWriteArrayList<Pair<String, List<String>>>()

    /** Fast links (1.13): each `POST /api/items/{id}/fastlink` (item id to its hours). */
    val fastLinks = CopyOnWriteArrayList<Pair<String, Int>>()

    /** (1.14) Each `POST /api/text` body; each reaction (item, emoji, on); each edit (item, its new words). */
    val texts = CopyOnWriteArrayList<JSONObject>()
    val reactionCalls = CopyOnWriteArrayList<Triple<String, String, Boolean>>()
    val edits = CopyOnWriteArrayList<Pair<String, String>>()

    /** The item list (newest first), its cursor, and what a `since` request returns. */
    @Volatile var items: List<JSONObject> = emptyList()
    @Volatile var cursor = "c1"
    @Volatile var delta: JSONObject? = null

    /** A file still arriving: `GET /api/file/{id}` sends [liveFile] in [liveSteps] pieces, [liveStepMs] apart. */
    @Volatile var liveFile: ByteArray = ByteArray(0)
    @Volatile var liveSteps = 4
    @Volatile var liveStepMs = 150L

    var devices: JSONArray = JSONArray()

    private class Stream(val id: String, @Volatile var mode: String, val queue: LinkedBlockingQueue<String>)

    private val streams = CopyOnWriteArrayList<Stream>()
    private val streamCount = AtomicInteger()

    init {
        server.executor = Executors.newCachedThreadPool { r -> Thread(r, "fake-beam").apply { isDaemon = true } }
        server.createContext("/") { ex ->
            try {
                handle(ex)
            } catch (_: IOException) {
            } finally {
                ex.close()
            }
        }
        server.start()
    }

    /** Sends an event to every open stream. */
    fun send(event: String, data: JSONObject) {
        for (s in streams) s.queue.put("event: $event\ndata: $data\n\n")
    }

    /** The mode of every open stream, as the server sees it. */
    fun modes(): List<String> = streams.map { it.mode }

    /** Closes every open stream (as a server restart or a dead network would). */
    fun dropStreams() {
        for (s in streams) s.queue.put(CLOSE)
    }

    private fun json(ex: HttpExchange, code: Int, body: Any) {
        var bytes = body.toString().toByteArray()
        ex.responseHeaders.add("Content-Type", "application/json")
        if ("gzip" in features && bytes.size > 1024 && ex.requestHeaders.getFirst("Accept-Encoding").orEmpty().contains("gzip")) {
            bytes = java.io.ByteArrayOutputStream().also { out -> java.util.zip.GZIPOutputStream(out).use { it.write(bytes) } }.toByteArray()
            ex.responseHeaders.add("Content-Encoding", "gzip")
            gzipped.incrementAndGet()
        }
        ex.sendResponseHeaders(code, if (code == 204) -1 else bytes.size.toLong())
        if (code != 204) ex.responseBody.use { it.write(bytes) }
    }

    private fun query(ex: HttpExchange): Map<String, String> = ex.requestURI.rawQuery.orEmpty().split('&').filter { it.isNotEmpty() }
        .associate { p -> p.substringBefore('=') to java.net.URLDecoder.decode(p.substringAfter('=', ""), "UTF-8") }

    private fun handle(ex: HttpExchange) {
        val path = ex.requestURI.path
        val method = ex.requestMethod
        if (path != "/api/events") requests += "$method $path"
        val forced = status
        if (forced != 0 && path != "/api/hello") {
            if (path == "/api/events") eventsRequests += ex.requestURI.rawQuery.orEmpty()
            if (forced == 401 && plain401) {
                val page = "<html><body>401 Authorization Required</body></html>".toByteArray()
                ex.responseHeaders.add("Content-Type", "text/html")
                ex.sendResponseHeaders(401, page.size.toLong())
                ex.responseBody.use { it.write(page) }
                return
            }
            val error = when (forced) {
                401 -> JSONObject().put("error", "Not paired — open a pairing link first").apply { if (serverIdIn401) put("serverId", serverId) }
                410 -> JSONObject().put("error", "Beam has moved").put("movedTo", movedTo)
                503 -> JSONObject().put("error", "Beam is moving to a new server. Try again in a minute.").put("retryAfter", 30)
                else -> JSONObject().put("error", "The server had a problem")
            }
            return json(ex, forced, error)
        }
        when {
            path == "/api/hello" -> json(ex, 200, JSONObject().put("beam", true).put("version", "1.4.0").put("serverId", serverId).put("api", 3))
            path == "/api/info" -> json(ex, 200, JSONObject().put("version", "1.4.0").put("api", 3).put("features", JSONArray(features)))
            path == "/api/me" -> json(ex, 200, JSONObject().put("ok", true).put("you", ex.requestHeaders.getFirst("X-Beam-Device-Id")).put("read", JSONObject()))
            path == "/api/devices" -> json(ex, 200, JSONObject().put("devices", devices).put("you", ex.requestHeaders.getFirst("X-Beam-Device-Id")))
            path == "/api/items" && method == "GET" -> {
                val q = query(ex)
                itemsRequests += ex.requestURI.rawQuery.orEmpty()
                val d = delta
                val now = JSONObject().put("items", JSONArray(items)).put("cursor", cursor).put("delta", false)
                if (itemsDelayMs > 0) Thread.sleep(itemsDelayMs)
                if (q["since"] != null && d != null && "items-since" in features) {
                    json(ex, 200, d)
                } else {
                    json(ex, 200, now)
                }
            }
            path == "/api/events" -> stream(ex)
            path.startsWith("/api/phone/") && "phone-notifications" !in features -> json(ex, 404, JSONObject().put("error", "Not found"))
            path == "/api/phone/notifications" && method == "DELETE" -> {
                phoneNotifications.clear()
                json(ex, 204, "")
            }
            path.startsWith("/api/phone/notifications/") && method == "PUT" -> {
                phoneNotifications[path.substringAfterLast('/')] = JSONObject(ex.requestBody.readBytes().decodeToString())
                if (phonePutDelayMs > 0) Thread.sleep(phonePutDelayMs)
                json(ex, 204, "")
            }
            path.startsWith("/api/phone/notifications/") && method == "DELETE" -> {
                if (phoneNotifications.remove(path.substringAfterLast('/')) == null) json(ex, 404, JSONObject().put("error", "Not found")) else json(ex, 204, "")
            }
            path.startsWith("/api/phone/icons/") && method == "HEAD" -> ex.sendResponseHeaders(if (phoneIcons.containsKey(path.substringAfterLast('/'))) 200 else 404, -1)
            path.startsWith("/api/phone/icons/") && method == "PUT" -> {
                phoneIcons[path.substringAfterLast('/')] = ex.requestBody.readBytes()
                json(ex, 204, "")
            }
            path.startsWith("/api/phone/requests/") && method == "POST" -> {
                phoneAnswers += path.substringAfterLast('/') to JSONObject(ex.requestBody.readBytes().decodeToString())
                json(ex, 204, "")
            }
            path.startsWith("/api/devices/") && path.endsWith("/settings") && method == "PUT" -> {
                val id = path.removePrefix("/api/devices/").removeSuffix("/settings")
                val on = JSONObject(ex.requestBody.readBytes().decodeToString()).optBoolean("phoneNotifications")
                for (i in 0 until devices.length()) {
                    val d = devices.getJSONObject(i)
                    if (d.optString("id") == id) d.put("settings", JSONObject().put("phoneNotifications", on))
                }
                json(ex, 204, "")
                send("devices", JSONObject().put("devices", devices))
            }
            path == "/api/events/poke" && method == "POST" -> {
                if ("stream-modes" !in features) return json(ex, 404, JSONObject().put("error", "Not found"))
                val body = JSONObject(ex.requestBody.readBytes().decodeToString())
                pokes += body
                val s = streams.firstOrNull { it.id == body.optString("stream") }
                if (s == null || !pokeAlive) return json(ex, 200, JSONObject().put("alive", false))
                s.mode = body.optString("mode", s.mode)
                // Like the server: the ping goes out on the stream first, then the reply.
                if (answerPokes) s.queue.put("event: ping\ndata: {\"poke\":true}\n\n")
                if (pokeReplyDelayMs > 0) Thread.sleep(pokeReplyDelayMs)
                json(ex, 200, JSONObject().put("alive", true).put("mode", s.mode).put("ping", pingFor(s.mode)))
            }
            path.startsWith("/api/file/") -> live(ex)
            path == "/api/login" && method == "POST" -> {
                pageKeys += JSONObject(ex.requestBody.readBytes().decodeToString()).optString("secret")
                if (loginDelayMs > 0) Thread.sleep(loginDelayMs)
                val token = "bt_page" + pageTokens.size
                pageTokens += token
                ex.responseHeaders.add("Set-Cookie", "beam_key=$token; Path=/; Max-Age=315360000; HttpOnly; SameSite=Lax")
                ex.sendResponseHeaders(204, -1)
            }
            path == "/api/logout" && method == "POST" -> {
                // The token signed out, as the server reads it: a bearer token (the app since 1.7.6) or the cookie.
                val bearer = ex.requestHeaders.getFirst("Authorization")?.takeIf { it.startsWith("Bearer ") }?.substring(7)?.trim()
                (bearer ?: Regex("beam_key=([^;]+)").find(ex.requestHeaders.getFirst("Cookie").orEmpty())?.groupValues?.get(1))
                    ?.let { pageSignOuts += it }
                json(ex, 204, "")
            }
            path.startsWith("/api/rc/") && "remote-control" !in features -> json(ex, 404, JSONObject().put("error", "Not found"))
            path == "/api/rc/sessions" && method == "GET" -> json(ex, 200, JSONObject().put("sessions", JSONArray(rcSessions.toList())))
            path == "/api/rc/disable" && method == "POST" -> {
                val pc = JSONObject(ex.requestBody.readBytes().decodeToString()).optString("device")
                rcDisabled += pc
                rcSessions.removeIf { it.optString("host") == pc }
                json(ex, 202, JSONObject())
            }
            path.startsWith("/api/rc/sessions/") && path.endsWith("/end") && method == "POST" -> {
                val id = path.removePrefix("/api/rc/sessions/").removeSuffix("/end")
                rcEnded += id
                rcSessions.removeIf { it.optString("id") == id }
                json(ex, 204, "")
            }
            path == "/api/items/delete" && method == "POST" -> {
                val ids = JSONObject(ex.requestBody.readBytes().decodeToString()).optJSONArray("ids") ?: JSONArray()
                val list = (0 until ids.length()).map { ids.getString(it) }
                bulkDeletes += list
                items = items.filter { it.optString("id") !in list }
                json(ex, 200, JSONObject().put("deleted", list.size))
            }
            path.startsWith("/api/items/") && path.endsWith("/forward") && method == "POST" -> {
                val id = path.removePrefix("/api/items/").removeSuffix("/forward")
                val to = JSONObject(ex.requestBody.readBytes().decodeToString()).optJSONArray("to") ?: JSONArray()
                val targets = (0 until to.length()).map { to.getString(it) }
                forwards += id to targets
                // A new item from this device, like the server's copy.
                val copy = JSONObject(items.firstOrNull { it.optString("id") == id }?.toString() ?: "{}")
                    .put("id", "f" + "%015d".format(forwards.size)).put("to", JSONArray(targets)).put("delivered", JSONObject())
                    .put("from", ex.requestHeaders.getFirst("X-Beam-Device-Id")).put("ts", System.currentTimeMillis()).put("forwardedFrom", id)
                json(ex, 200, copy)
            }
            path.startsWith("/api/items/") && path.endsWith("/fastlink") && method == "POST" -> {
                val id = path.removePrefix("/api/items/").removeSuffix("/fastlink")
                val hours = JSONObject(ex.requestBody.readBytes().decodeToString()).optInt("hours", 24)
                fastLinks += id to hours
                val link = JSONObject().put("id", "link0001").put("url", "https://family.example.ts.net:8443/f/" + "a".repeat(32))
                    .put("expires", System.currentTimeMillis() + hours * 3_600_000L)
                json(ex, 201, JSONObject().put("link", link))
            }
            path == "/api/text" && method == "POST" -> {
                val body = JSONObject(ex.requestBody.readBytes().decodeToString())
                val to = body.optJSONArray("to") ?: JSONArray()
                val known = (0 until devices.length()).map { devices.getJSONObject(it).optString("id") }.toSet()
                if ((0 until to.length()).any { to.getString(it) !in known }) return json(ex, 400, JSONObject().put("error", "No such device"))
                texts += body
                val item = JSONObject().put("id", "t" + "%015d".format(texts.size)).put("kind", "text").put("text", body.optString("text"))
                    .put("from", ex.requestHeaders.getFirst("X-Beam-Device-Id")).put("device", "Phone").put("to", body.optJSONArray("to") ?: JSONArray())
                    .put("delivered", JSONObject()).put("ts", System.currentTimeMillis())
                body.optString("reply").takeIf { it.isNotEmpty() }?.let { id ->
                    val src = items.firstOrNull { it.optString("id") == id }
                    item.put("reply", JSONObject().put("id", id).put("kind", "text").put("text", src?.optString("text")).put("from", src?.optString("from")))
                }
                json(ex, 201, item)
            }
            path.startsWith("/api/items/") && path.contains("/reactions/") && (method == "PUT" || method == "DELETE") -> {
                val id = path.removePrefix("/api/items/").substringBefore("/reactions/")
                reactionCalls += Triple(id, path.substringAfter("/reactions/"), method == "PUT")
                json(ex, 200, JSONObject(items.firstOrNull { it.optString("id") == id }?.toString() ?: "{}"))
            }
            path.startsWith("/api/items/") && method == "PATCH" -> {
                val id = path.removePrefix("/api/items/")
                val body = JSONObject(ex.requestBody.readBytes().decodeToString())
                if (body.has("text")) edits += id to body.getString("text")
                val item = JSONObject(items.firstOrNull { it.optString("id") == id }?.toString() ?: "{}")
                if (body.has("text")) item.put("text", body.getString("text")).put("edited", System.currentTimeMillis())
                json(ex, 200, item)
            }
            path == "/api/login-requests" -> json(ex, 200, JSONObject().put("requests", JSONArray()))
            path == "/api/alerts" -> json(ex, 200, JSONObject().put("alerts", JSONArray()))
            path == "/api/read" -> json(ex, 200, JSONObject().put("read", JSONObject()))
            path == "/api/devices/me/status" -> json(ex, 204, "")
            path == "/api/updates" -> json(ex, 200, JSONObject())
            else -> json(ex, 404, JSONObject().put("error", "Not found"))
        }
    }

    private fun stream(ex: HttpExchange) {
        eventsRequests += ex.requestURI.rawQuery.orEmpty()
        val mode = query(ex)["mode"] ?: "foreground"
        val s = Stream("s" + streamCount.incrementAndGet(), mode, LinkedBlockingQueue())
        ex.responseHeaders.add("Content-Type", "text/event-stream")
        ex.sendResponseHeaders(200, 0)
        val out = ex.responseBody
        val hello = JSONObject().put("beam", true)
        if ("stream-modes" in features) hello.put("stream", s.id).put("mode", mode).put("ping", pingFor(mode))
        if ("phone-notifications" in features) hello.put("instance", instance)
        out.write("event: hello\ndata: $hello\n\n".toByteArray())
        out.flush()
        streams += s
        try {
            var last = System.currentTimeMillis()
            while (true) {
                val next = s.queue.poll(100, TimeUnit.MILLISECONDS)
                    ?: if (System.currentTimeMillis() - last >= pingFor(s.mode) * 1000L) "event: ping\ndata: {}\n\n" else continue
                if (next === CLOSE) break
                out.write(next.toByteArray())
                out.flush()
                last = System.currentTimeMillis()
            }
        } finally {
            streams -= s
        }
    }

    /** A file that's still arriving: the final size up front, then the bytes a piece at a time. */
    private fun live(ex: HttpExchange) {
        fileRequests += ex.requestURI.path + " " + (ex.requestHeaders.getFirst("Range") ?: "")
        val data = liveFile
        val from = ex.requestHeaders.getFirst("Range")?.removePrefix("bytes=")?.substringBefore('-')?.toIntOrNull() ?: 0
        if (from > 0) {
            ex.responseHeaders.add("Content-Range", "bytes $from-${data.size - 1}/${data.size}")
            ex.sendResponseHeaders(206, (data.size - from).toLong())
        } else {
            ex.sendResponseHeaders(200, data.size.toLong())
        }
        ex.responseBody.use { out ->
            val step = maxOf(1, (data.size - from) / liveSteps)
            var at = from
            while (at < data.size) {
                val n = minOf(step, data.size - at)
                out.write(data, at, n)
                out.flush()
                at += n
                Thread.sleep(liveStepMs)
            }
        }
    }

    override fun close() {
        dropStreams()
        server.stop(0)
    }

    companion object {
        private val CLOSE = String(charArrayOf('\u0000'))
    }
}
