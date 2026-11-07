package app.beam.android.ui

import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.os.Bundle
import android.text.InputFilter
import android.text.InputType
import android.util.Base64
import android.util.LruCache
import android.view.LayoutInflater
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.core.net.toUri
import androidx.core.view.isVisible
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import app.beam.android.R
import app.beam.android.core.Format
import app.beam.android.core.Site
import app.beam.android.core.SitesResult
import app.beam.android.databinding.ActivitySitesBinding
import app.beam.android.databinding.ItemSiteBinding
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * (1.17, server 1.31) Sites: the web pages your machines serve over Tailscale. Each PC's Beam for Windows finds the
 * pages it serves; others (a Raspberry Pi's, a NAS's) are added by address. A tap opens one in the browser; touch and
 * hold for more. The server checks each one when the list is read (whether it answers); pull down to check again.
 */
class SitesActivity : BaseActivity() {
    private lateinit var b: ActivitySitesBinding
    private lateinit var adapter: SiteAdapter
    private var result: SitesResult? = null
    private var loading: Job? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivitySitesBinding.inflate(layoutInflater)
        setContentView(b.root)
        b.appbar.padForSystemBars(top = true)
        b.list.padForSystemBars(bottom = true)
        b.toolbar.setNavigationOnClickListener { finish() }
        b.toolbar.setOnMenuItemClickListener {
            when (it.itemId) {
                R.id.action_add_site -> addSite()
                R.id.action_check_sites -> checkAgain()
            }
            true
        }
        adapter = SiteAdapter(::open, ::siteMenu)
        b.list.layoutManager = LinearLayoutManager(this)
        b.list.adapter = adapter
        b.refresh.setColorSchemeColors(themeColor(R.attr.beamAccent))
        b.refresh.setOnRefreshListener { checkAgain() }
        // The list now, and again whenever the server says it changed or a check finished (the `sites` event).
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.repo.sitesChanged.collect { load() }
            }
        }
    }

    private fun load() {
        val api = app.api ?: return
        loading?.cancel()
        loading = lifecycleScope.launch {
            try {
                result = withContext(Dispatchers.IO) { api.sites() }
                show()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                b.refresh.isRefreshing = false
                b.empty.isVisible = adapter.itemCount == 0
                if (adapter.itemCount == 0) b.empty.text = getString(R.string.sites_failed, Format.error(e)) else toast(getString(R.string.sites_failed, Format.error(e)))
            }
        }
    }

    private fun show() {
        val r = result ?: return
        val list = r.sites.filter { !it.hidden } + r.sites.filter { it.hidden }
        adapter.checking = r.checking
        adapter.submitList(list) { adapter.notifyItemRangeChanged(0, adapter.itemCount) }
        if (!r.checking) b.refresh.isRefreshing = false
        b.toolbar.subtitle = when {
            r.checking -> getString(R.string.sites_checking)
            r.checkedAt > 0 -> getString(R.string.sites_checked_at, Format.time(r.checkedAt))
            else -> null
        }
        b.empty.isVisible = list.isEmpty()
        b.empty.text = getString(R.string.sites_empty)
    }

    private fun checkAgain() {
        val api = app.api ?: return
        b.refresh.isRefreshing = true
        lifecycleScope.launch {
            val error = withContext(Dispatchers.IO) { runCatching { api.checkSites() }.exceptionOrNull() }
            if (error != null) {
                b.refresh.isRefreshing = false
                toast(getString(R.string.sites_failed, Format.error(error)))
            } else {
                load()
            }
        }
    }

    private fun open(site: Site) {
        val intent = Intent(Intent.ACTION_VIEW, site.url.toUri()).addCategory(Intent.CATEGORY_BROWSABLE)
        if (runCatching { startActivity(intent) }.isFailure) toast(getString(R.string.sites_no_browser, site.host))
    }

    private fun siteMenu(site: Site) {
        val entries = mutableListOf(
            ActionSheet.Entry(R.drawable.ic_open, getString(R.string.sites_open)) { open(site) },
            ActionSheet.Entry(R.drawable.ic_copy, getString(R.string.sites_copy)) { if (Clip.copy(this, site.url)) toast(getString(R.string.sites_copied)) },
            ActionSheet.Entry(R.drawable.ic_edit, getString(R.string.sites_rename)) { rename(site) },
        )
        if (site.renamed) entries += ActionSheet.Entry(R.drawable.ic_refresh, getString(R.string.sites_use_title)) { edit(site, JSONObject().put("name", JSONObject.NULL)) }
        entries += when {
            site.found && site.hidden -> ActionSheet.Entry(R.drawable.ic_check, getString(R.string.sites_show)) { edit(site, JSONObject().put("hidden", false)) }
            site.found -> ActionSheet.Entry(R.drawable.ic_close, getString(R.string.sites_hide)) { edit(site, JSONObject().put("hidden", true)) }
            else -> ActionSheet.Entry(R.drawable.ic_delete, getString(R.string.sites_remove)) { remove(site) }
        }
        ActionSheet.show(this, site.name, entries)
    }

    private fun edit(site: Site, change: JSONObject) {
        val api = app.api ?: return
        lifecycleScope.launch {
            val error = withContext(Dispatchers.IO) { runCatching { api.editSite(site.id, change) }.exceptionOrNull() }
            if (error != null) toast(getString(R.string.sites_change_failed, Format.error(error)))
            load()
        }
    }

    private fun rename(site: Site) {
        askForText(R.string.sites_rename, R.string.sites_name, InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS, site.name, 60) { name ->
            if (name != site.name) edit(site, JSONObject().put("name", if (name.isEmpty()) JSONObject.NULL else name))
        }
    }

    private fun remove(site: Site) {
        MaterialAlertDialogBuilder(this)
            .setMessage(getString(R.string.sites_remove_q, site.name))
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.sites_remove) { _, _ ->
                val api = app.api ?: return@setPositiveButton
                lifecycleScope.launch {
                    val error = withContext(Dispatchers.IO) { runCatching { api.deleteSite(site.id) }.exceptionOrNull() }
                    if (error != null) toast(getString(R.string.sites_change_failed, Format.error(error)))
                    load()
                }
            }
            .show()
    }

    private fun addSite() {
        askForText(R.string.sites_add, R.string.sites_address_hint, InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI, "", 500) { address ->
            if (address.isEmpty()) return@askForText
            val api = app.api ?: return@askForText
            lifecycleScope.launch {
                val r = withContext(Dispatchers.IO) { runCatching { api.addSite(address) } }
                r.onSuccess { toast(getString(if (it.up == false) R.string.sites_added_down else R.string.sites_added, it.name)) }
                r.onFailure { toast(getString(R.string.sites_change_failed, Format.error(it))) }
                load()
            }
        }
    }

    /** A small dialog with one text field (as Settings has). */
    private fun askForText(title: Int, hint: Int, inputType: Int, initial: String, maxLength: Int, onOk: (String) -> Unit) {
        val input = TextInputEditText(this).apply {
            setText(initial)
            this.inputType = inputType
            filters = arrayOf(InputFilter.LengthFilter(maxLength))
            setSelectAllOnFocus(true)
        }
        val layout = TextInputLayout(this).apply {
            this.hint = getString(hint)
            addView(input)
        }
        val frame = FrameLayout(this).apply {
            val pad = (20 * resources.displayMetrics.density).toInt()
            setPadding(pad, pad / 2, pad, 0)
            addView(layout)
        }
        MaterialAlertDialogBuilder(this)
            .setTitle(title)
            .setView(frame)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.save) { _, _ -> onOk(input.text?.toString()?.trim().orEmpty()) }
            .show()
        input.requestFocus()
    }

    private class SiteAdapter(private val onOpen: (Site) -> Unit, private val onMenu: (Site) -> Unit) : ListAdapter<Site, SiteAdapter.Holder>(DIFF) {
        var checking = false

        class Holder(val b: ItemSiteBinding) : RecyclerView.ViewHolder(b.root)

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
            Holder(ItemSiteBinding.inflate(LayoutInflater.from(parent.context), parent, false))

        override fun onBindViewHolder(holder: Holder, position: Int) {
            val site = getItem(position)
            val b = holder.b
            val ctx = b.root.context
            b.name.text = site.name
            var where = if (site.found) ctx.getString(R.string.sites_on, site.host, site.deviceName ?: "?") else ctx.getString(R.string.sites_added_here, site.host)
            if (site.hidden) where = ctx.getString(R.string.sites_hidden_suffix, where)
            b.where.text = where
            b.problem.isVisible = site.up == false
            b.problem.text = ctx.getString(R.string.sites_not_answering, site.problem ?: "")
            val state = when (site.up) {
                true -> ctx.getString(R.string.sites_answering)
                false -> ctx.getString(R.string.sites_not_answering, site.problem ?: "")
                null -> ctx.getString(if (checking) R.string.sites_checking else R.string.sites_not_checked)
            }
            b.dot.backgroundTintList = ColorStateList.valueOf(
                when (site.up) {
                    true -> ctx.getColor(R.color.online)
                    false -> ctx.getColor(R.color.danger)
                    null -> Color.rgb(0x8a, 0x91, 0x9c)
                },
            )
            b.dot.contentDescription = state
            val bitmap = iconOf(site)
            b.icon.setImageBitmap(bitmap)
            b.icon.isVisible = bitmap != null
            b.letter.isVisible = bitmap == null
            b.letter.text = site.name.firstOrNull { it.isLetterOrDigit() }?.uppercase() ?: "?"
            b.row.alpha = if (site.hidden) 0.55f else 1f
            b.row.contentDescription = "${site.name}, $where, $state"
            b.row.setOnClickListener { onOpen(site) }
            b.row.setOnLongClickListener { onMenu(site); true }
        }

        companion object {
            private val DIFF = object : DiffUtil.ItemCallback<Site>() {
                override fun areItemsTheSame(a: Site, b: Site) = a.id == b.id
                override fun areContentsTheSame(a: Site, b: Site) = a == b
            }

            // Icons arrive as data: URLs in the list; decoded once each (a few KB).
            private val icons = LruCache<String, Bitmap>(64)
            private val NO_ICON = Bitmap.createBitmap(1, 1, Bitmap.Config.ALPHA_8)

            fun iconOf(site: Site): Bitmap? {
                val data = site.icon ?: return null
                val comma = data.indexOf(',')
                if (!data.startsWith("data:image/") || comma < 0) return null
                val cached = icons.get(data)
                if (cached != null) return cached.takeIf { it !== NO_ICON }
                val bitmap = runCatching {
                    val bytes = Base64.decode(data.substring(comma + 1), Base64.DEFAULT)
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                }.getOrNull()
                icons.put(data, bitmap ?: NO_ICON)
                return bitmap
            }
        }
    }
}
