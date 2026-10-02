package app.beam.android.ui

import android.graphics.Typeface
import android.os.Bundle
import android.text.SpannableString
import android.text.Spanned
import android.text.style.BackgroundColorSpan
import android.text.style.StyleSpan
import android.view.LayoutInflater
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import androidx.core.view.isVisible
import androidx.core.widget.doAfterTextChanged
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import app.beam.android.R
import app.beam.android.core.Conversations
import app.beam.android.core.Format
import app.beam.android.core.Item
import app.beam.android.databinding.ActivitySearchBinding
import app.beam.android.databinding.ItemSearchBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Search across every conversation: texts and file names, on the device (works offline). Long texts
 * are matched in the part kept on the device; opening one shows all of it.
 */
class SearchActivity : BaseActivity() {
    private lateinit var b: ActivitySearchBinding
    private lateinit var adapter: ResultAdapter
    private var job: Job? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivitySearchBinding.inflate(layoutInflater)
        setContentView(b.root)
        b.appbar.padForSystemBars(top = true)
        b.list.padForSystemBars(bottom = true, ime = true)
        b.toolbar.setNavigationOnClickListener { finish() }
        adapter = ResultAdapter { item -> open(item) }
        b.list.layoutManager = LinearLayoutManager(this)
        b.list.adapter = adapter
        b.query.doAfterTextChanged { search(it?.toString().orEmpty()) }
        b.query.setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_SEARCH) {
                hideKeyboard()
                true
            } else {
                false
            }
        }
        b.query.requestFocus()
        search("")
    }

    private fun hideKeyboard() = getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(b.query.windowToken, 0)

    private fun search(query: String) {
        job?.cancel()
        job = lifecycleScope.launch {
            delay(150)
            val s = app.repo.state.value
            val results = withContext(Dispatchers.Default) { app.repo.search(query) }
            adapter.query = query.trim()
            adapter.names = { item ->
                val key = Conversations.keysOf(item, s.me, s.devicesById).firstOrNull()
                val from = if (item.isFrom(s.me)) getString(R.string.you) else item.from?.let { s.devicesById[it]?.name } ?: item.device
                when {
                    key == null -> from
                    key == Conversations.ALL -> getString(R.string.search_in_all, from)
                    item.isFrom(s.me) -> getString(R.string.search_to, s.devicesById[key]?.name ?: key)
                    else -> from
                }
            }
            // Same results, new words: the highlights change, so rebind everything.
            adapter.submitList(results) { adapter.notifyItemRangeChanged(0, adapter.itemCount) }
            b.empty.isVisible = results.isEmpty()
            b.empty.text = when {
                query.isBlank() -> getString(R.string.search_start)
                !s.loaded -> getString(R.string.connecting)
                else -> getString(R.string.search_none, query.trim())
            }
        }
    }

    private fun open(item: Item) {
        val s = app.repo.state.value
        val key = Conversations.keysOf(item, s.me, s.devicesById).firstOrNull() ?: Conversations.ALL
        startActivity(ThreadActivity.intent(this, key, item.id))
    }

    private class ResultAdapter(private val onOpen: (Item) -> Unit) : ListAdapter<Item, ResultAdapter.Holder>(DIFF) {
        var query = ""
        var names: (Item) -> String = { it.device }

        class Holder(val b: ItemSearchBinding) : RecyclerView.ViewHolder(b.root)

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
            Holder(ItemSearchBinding.inflate(LayoutInflater.from(parent.context), parent, false))

        override fun onBindViewHolder(holder: Holder, position: Int) {
            val item = getItem(position)
            val b = holder.b
            b.title.text = names(item)
            b.time.text = Format.relative(item.ts)
            b.icon.setImageResource(if (item.isText) R.drawable.ic_text_file else fileTypeIcon(item.mime, item.name))
            b.snippet.text = highlight(snippet(item), query, b.root.context.getColor(R.color.accent_soft))
            b.row.setOnClickListener { onOpen(item) }
        }

        /** The part of the text around the first match, on one or two lines. */
        private fun snippet(item: Item): String {
            val text = (if (item.isText) item.text.orEmpty() else item.displayName).replace(Regex("\\s+"), " ").trim()
            val first = query.lowercase().split(' ').firstOrNull { it.isNotEmpty() } ?: return text.take(200)
            val at = text.lowercase().indexOf(first)
            if (at < 40) return text.take(200)
            return "…" + text.substring(at - 30).take(200)
        }

        private fun highlight(text: String, query: String, color: Int): CharSequence {
            val s = SpannableString(text)
            val lower = text.lowercase()
            for (word in query.lowercase().split(' ').filter { it.isNotEmpty() }) {
                var i = lower.indexOf(word)
                while (i >= 0) {
                    s.setSpan(BackgroundColorSpan(color), i, i + word.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    s.setSpan(StyleSpan(Typeface.BOLD), i, i + word.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    i = lower.indexOf(word, i + word.length)
                }
            }
            return s
        }

        companion object {
            private val DIFF = object : DiffUtil.ItemCallback<Item>() {
                override fun areItemsTheSame(a: Item, b: Item) = a.id == b.id
                override fun areContentsTheSame(a: Item, b: Item) = a == b
            }
        }
    }
}
