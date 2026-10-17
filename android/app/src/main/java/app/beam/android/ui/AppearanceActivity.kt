package app.beam.android.ui

import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.widget.GridLayout
import android.widget.ImageView
import android.widget.Toast
import androidx.core.graphics.toColorInt
import androidx.core.view.ViewCompat
import androidx.core.view.isVisible
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import app.beam.android.R
import app.beam.android.core.Format
import app.beam.android.core.Look
import app.beam.android.databinding.ActivityAppearanceBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * (1.14) Settings → Appearance, as the web's page: light, dark or like the phone, an accent colour, and whether it's for
 * all the devices or only this phone. A screen of its own rather than a dialog: each change re-themes it at once (the
 * accent makes the screen again; a dialog would close).
 */
class AppearanceActivity : BaseActivity() {
    private lateinit var b: ActivityAppearanceBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityAppearanceBinding.inflate(layoutInflater)
        setContentView(b.root)
        b.appbar.padForSystemBars(top = true)
        b.scroll.padForSystemBars(bottom = true)
        b.toolbar.setNavigationOnClickListener { finish() }
        b.themeAuto.setOnClickListener { save { it.copy(theme = Look.AUTO) } }
        b.themeLight.setOnClickListener { save { it.copy(theme = Look.LIGHT) } }
        b.themeDark.setOnClickListener { save { it.copy(theme = Look.DARK) } }
        // Only this phone: its own look, starting as the one it shows; all devices: its own one goes.
        b.whereAll.setOnClickListener { if (app.looks.own != null) saveLook(null, ownLook = true) }
        b.whereOwn.setOnClickListener { if (app.looks.own == null) saveLook(app.looks.look.value, ownLook = true) }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                combine(app.looks.look, app.looks.hasOwn) { look, _ -> look }.collect { bind(it) }
            }
        }
    }

    private fun bind(look: Look) {
        val own = app.looks.own != null
        b.intro.setText(if (own) R.string.look_intro_own else R.string.look_intro_all)
        b.themes.check(
            when (look.theme) {
                Look.LIGHT -> R.id.themeLight
                Look.DARK -> R.id.themeDark
                else -> R.id.themeAuto
            },
        )
        b.where.check(if (own) R.id.whereOwn else R.id.whereAll)
        b.whereNote.setText(if (own) R.string.look_where_own_note else R.string.look_where_all_note)
        bindSwatches(look)
    }

    private fun bindSwatches(look: Look) {
        val custom = look.accent?.takeIf { !Look.isPreset(it) }
        val choices = Look.ACCENTS + listOfNotNull(custom?.let { getString(R.string.look_custom) to it })
        val size = (44 * resources.displayMetrics.density).toInt()
        val margin = (6 * resources.displayMetrics.density).toInt()
        b.swatches.removeAllViews()
        for ((name, hex) in choices) {
            val chosen = look.accent == hex
            val fill = (hex ?: Look.BEAM_ACCENT).toColorInt()
            b.swatches.addView(
                ImageView(this).apply {
                    background = GradientDrawable().apply {
                        shape = GradientDrawable.OVAL
                        setColor(fill)
                        if (chosen) setStroke((3 * resources.displayMetrics.density).toInt(), themeColor(com.google.android.material.R.attr.colorOnSurface))
                    }
                    if (chosen) {
                        setImageResource(R.drawable.ic_check)
                        imageTintList = ColorStateList.valueOf(Color.WHITE)
                        scaleType = ImageView.ScaleType.CENTER
                    }
                    contentDescription = name
                    isSelected = chosen
                    if (chosen) ViewCompat.setStateDescription(this, getString(R.string.look_selected))
                    // Your own colour stays as it is (it's picked on the web); a tap on it does nothing.
                    if (hex != custom) setOnClickListener { save { it.copy(accent = hex) } }
                    layoutParams = GridLayout.LayoutParams().apply {
                        width = size
                        height = size
                        setMargins(margin, margin, margin, margin)
                    }
                },
            )
        }
        b.customNote.isVisible = custom != null
        if (custom != null) {
            val shown = Look.ACCENTS.firstOrNull { it.second == Look.shownAs(custom) }?.first ?: "Beam"
            b.customNote.text = getString(R.string.look_custom_note, custom, shown)
        }
    }

    /** A change to the look as it is now, kept where it applies (this phone's own, or all devices'). */
    private fun save(change: (Look) -> Look) {
        val own = app.looks.own != null
        saveLook(change(app.looks.look.value), own)
    }

    private fun saveLook(look: Look?, ownLook: Boolean) {
        val app = app
        // In the app's scope: a new accent makes this screen again, and that would cancel a save of its own.
        app.scope.launch(Dispatchers.Main) {
            try {
                app.looks.save(look, ownLook)
            } catch (e: Exception) {
                Toast.makeText(app, Format.error(e), Toast.LENGTH_SHORT).show()
            }
        }
    }
}
