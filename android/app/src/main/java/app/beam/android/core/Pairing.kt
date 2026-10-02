package app.beam.android.core

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * Parsing what people scan or type: pairing links (`https://host/?key=KEY`, docs/API.md "Pairing"),
 * sign-in approval links (`https://host/?approve=CODE`) and server addresses.
 *
 * Beam usually lives at the root of its host, but a reverse proxy may serve it under a path
 * (`https://nas/beam/`); that path is kept as part of the server address.
 */
object Pairing {
    data class Link(val baseUrl: String, val key: String)

    private val URL = Regex("""https?://\S+""", RegexOption.IGNORE_CASE)
    private val CODE = Regex("""^[A-Za-z0-9]{4}[- ]?[A-Za-z0-9]{4}$""")

    private fun firstUrl(text: String): HttpUrl? =
        URL.find(text)?.value?.trimEnd('.', ',', ')', '>', '"', '\'')?.toHttpUrlOrNull()

    /**
     * The server address in a URL: scheme://host[:port] plus any path prefix, without user info, query,
     * fragment or trailing slash. `https://pc.ts.net/?key=K` → `https://pc.ts.net`,
     * `https://nas/beam/?key=K` → `https://nas/beam`.
     */
    fun origin(url: HttpUrl): String {
        val path = url.encodedPath.trimEnd('/')
        return url.newBuilder().username("").password("").encodedPath(if (path.isEmpty()) "/" else path).query(null).fragment(null)
            .build().toString().removeSuffix("/")
    }

    /** Extracts the server address and key from a scanned or pasted pairing link; null if it isn't one. */
    fun parse(input: String): Link? {
        val text = input.trim()
        val url = firstUrl(text)
            ?: text.takeIf { "key=" in it && !it.contains(' ') }?.let { "https://$it".toHttpUrlOrNull() }
            ?: return null
        val key = url.queryParameter("key")?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return Link(origin(url), key)
    }

    fun link(baseUrl: String, key: String) = "${baseUrl.trimEnd('/')}/?key=${encodeURIComponent(key)}"

    /** Any http(s) Beam address in [input] (a pairing link, an approve link or a plain address); null if none. */
    fun anyServer(input: String): String? = firstUrl(input.trim())?.let(::origin)

    // ---------------------------------------------------------------- sign-in approval codes

    /** "k7qm-4r2x" → "K7QM4R2X" (the server ignores case and dashes). */
    fun normalizeCode(code: String) = code.uppercase().filter { it in 'A'..'Z' || it in '0'..'9' }

    /** "K7QM4R2X" → "K7QM-4R2X". */
    fun formatCode(code: String): String = normalizeCode(code).let { if (it.length == 8) it.take(4) + "-" + it.drop(4) else it }

    /**
     * The approval code in a scanned `https://<server>/?approve=CODE` link or a typed "K7QM-4R2X";
     * null if [input] is neither.
     */
    fun approveCode(input: String): String? {
        val text = input.trim()
        val url = firstUrl(text)
        if (url != null) return url.queryParameter("approve")?.let(::normalizeCode)?.takeIf { it.length == 8 }
        return if (CODE.matches(text)) normalizeCode(text) else null
    }

    /** The server address in an approval link (to explain codes that belong to another server). */
    fun approveHost(input: String): String? = firstUrl(input.trim())?.takeIf { it.queryParameter("approve") != null }?.let(::origin)

    /**
     * Whether an approval link's server ([origin], from [approveHost]) is this phone's own Beam: its address or one it's
     * also known by (1.7.6, audit S-35: a link for any other server never opens the approval sheet).
     */
    fun isOwnServer(origin: String?, base: String?, alternates: Set<String>): Boolean =
        origin != null && base != null && (alternates + base).any { it.equals(origin, ignoreCase = true) }

    // ---------------------------------------------------------------- server addresses

    /**
     * Addresses to try for what someone typed: a full URL as given, or for a bare host
     * ("robin-desktop.tailnet.ts.net", "192.168.1.5:8765", "nas.local/beam") https first, then plain http
     * (on port 8765 when none is given).
     */
    fun serverCandidates(input: String): List<String> {
        val text = input.trim().trimEnd('/')
        if (text.isEmpty() || text.any { it.isWhitespace() }) return emptyList()
        if (text.startsWith("http://", true) || text.startsWith("https://", true)) {
            return listOfNotNull(text.toHttpUrlOrNull()?.let(::origin))
        }
        val https = "https://$text".toHttpUrlOrNull() ?: return emptyList()
        val hasPort = https.port != 443
        val hostPort = text.substringBefore('/')
        val path = text.substring(hostPort.length)
        val http = (if (hasPort) "http://$text" else "http://$hostPort:8765$path").toHttpUrlOrNull()
        return listOfNotNull(origin(https), http?.let(::origin)).distinct()
    }

    /** Normalizes a server address, or null if it isn't a URL. */
    fun normalizeServer(address: String): String? = address.trim().toHttpUrlOrNull()?.let(::origin)

    /**
     * `https://beam.<tailnet>.ts.net` for a server on the same tailnet as [baseUrl] (where a Beam that
     * moved to its own Tailscale node usually lives), or null if [baseUrl] isn't a `*.ts.net` address.
     */
    fun tailnetBeam(baseUrl: String): String? {
        val host = baseUrl.toHttpUrlOrNull()?.host ?: return null
        if (!host.endsWith(".ts.net")) return null
        val tailnet = host.substringAfter('.')
        if (!tailnet.contains('.')) return null
        return "https://beam.$tailnet".takeIf { !host.startsWith("beam.") }
    }

    /** True for addresses that only work while Tailscale is on (MagicDNS names and 100.64.0.0/10). */
    fun needsTailscale(baseUrl: String): Boolean {
        val host = baseUrl.toHttpUrlOrNull()?.host ?: return false
        if (host.endsWith(".ts.net")) return true
        val parts = host.split('.')
        if (parts.size != 4) return false
        val a = parts[0].toIntOrNull() ?: return false
        val b = parts[1].toIntOrNull() ?: return false
        return a == 100 && b in 64..127
    }
}
