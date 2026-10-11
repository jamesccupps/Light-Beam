package app.beam.android

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.test.core.app.ApplicationProvider
import app.beam.android.ui.Thumbs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ThumbsTest {
    private val app: BeamApp get() = ApplicationProvider.getApplicationContext()

    /** The previews folder keeps the most recently used ones (by count and size); old leftovers of writes go. */
    @Test
    fun previewsArePrunedLeastRecentlyUsedFirst() {
        val dir = File(app.cacheDir, "thumbs-test").apply { deleteRecursively(); mkdirs() }
        val now = System.currentTimeMillis()
        for (i in 0 until 30) File(dir, "p$i.jpg").apply { writeBytes(ByteArray(1_000)); setLastModified(now - (30 - i) * 60_000L) }
        File(dir, "half.jpg.tmp-7").apply { writeText("x"); setLastModified(now - 2 * 3_600_000L) } // an interrupted write
        File(dir, "fresh.jpg.tmp-8").writeText("x") // being written right now
        Thumbs.prune(dir, keepFiles = 10, keepBytes = 1_000_000)
        assertEquals((20 until 30).map { "p$it.jpg" }.toSet() + "fresh.jpg.tmp-8", dir.list()!!.toSet())
        Thumbs.prune(dir, keepFiles = 100, keepBytes = 5_500)
        assertEquals((25 until 30).map { "p$it.jpg" }.toSet() + "fresh.jpg.tmp-8", dir.list()!!.toSet())
        dir.deleteRecursively()
    }

    /** (1.13.2, audit) The server's thumbnail of a photo sent from here is 640 px (sharp on 2×–3× screens), under 256 KB. */
    @Test
    fun theServersThumbnailIs640px() {
        val photo = Bitmap.createBitmap(1600, 1200, Bitmap.Config.ARGB_8888).apply { eraseColor(0xFF33AA77.toInt()) }
        val jpeg = Thumbs.serverThumb(photo)!!
        assertTrue("${jpeg.size} bytes", jpeg.size <= 256 * 1024)
        val back = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size)
        assertEquals(640 to 480, back.width to back.height)
        val small = Bitmap.createBitmap(300, 200, Bitmap.Config.ARGB_8888)
        val kept = Thumbs.serverThumb(small)!!.let { BitmapFactory.decodeByteArray(it, 0, it.size) }
        assertEquals("never enlarged", 300 to 200, kept.width to kept.height)
    }
}
