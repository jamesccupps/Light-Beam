package app.beam.android

import android.util.Base64
import app.beam.android.ui.Thumbs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.util.zip.CRC32
import java.util.zip.DeflaterOutputStream

/**
 * (1.20.1, the 2026-11-14 audit, finding 5) A site's icon is decoded at the size it's shown: one whose header says
 * 6000 × 6000 (a few KB, about 144 MB in full) comes out small, a small one as it is, a broken one as none.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [36])
class Audit1114Test {
    private fun png(w: Int, h: Int): ByteArray {
        val out = ByteArrayOutputStream()
        fun chunk(type: String, body: ByteArray) {
            val t = type.toByteArray()
            out.write(ByteBuffer.allocate(4).putInt(body.size).array())
            out.write(t)
            out.write(body)
            val crc = CRC32().apply { update(t); update(body) }
            out.write(ByteBuffer.allocate(4).putInt(crc.value.toInt()).array())
        }
        out.write(byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A))
        chunk("IHDR", ByteBuffer.allocate(13).putInt(w).putInt(h).put(8).put(0).put(0).put(0).put(0).array())
        val idat = ByteArrayOutputStream()
        DeflaterOutputStream(idat).use { z -> val row = ByteArray(w + 1); repeat(h) { z.write(row) } }
        chunk("IDAT", idat.toByteArray())
        chunk("IEND", ByteArray(0))
        return out.toByteArray()
    }

    private fun dataUrl(bytes: ByteArray) = "data:image/png;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)

    @Test
    fun aSitesIconIsDecodedAtTheSizeShown() {
        val huge = png(6000, 6000)
        assertTrue("a few KB that say 6000 × 6000 (${huge.size} bytes)", huge.size < 64 * 1024)
        val big = Thumbs.fromDataUrl(dataUrl(huge), 72)
        assertTrue("decoded", big != null)
        assertTrue("${big!!.width} × ${big.height}", maxOf(big.width, big.height) <= 72)
        val small = Thumbs.fromDataUrl(dataUrl(png(32, 32)), 72)!!
        assertEquals(listOf(32, 32), listOf(small.width, small.height))
        assertEquals(null, Thumbs.fromDataUrl("data:image/png;base64,AAAA", 72))
        assertEquals(null, Thumbs.fromDataUrl("http://example.test/i.png", 72))
    }
}
