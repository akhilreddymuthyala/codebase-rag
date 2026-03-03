/**
 * chat.js — Chat page logic
 * Handles: session load, query send, answer rendering,
 * code snippet display with copy buttons, file tree sidebar.
 */

document.addEventListener('DOMContentLoaded', () => {

  /* ── Elements ─────────────────────────────────────────────── */
  const messagesEl  = document.getElementById('messages');
  const welcomeMsg  = document.getElementById('welcomeMsg');
  const chatInput   = document.getElementById('chatInput');
  const sendBtn     = document.getElementById('sendBtn');
  const sessionBadge= document.getElementById('sessionBadge');
  const sessionMeta = document.getElementById('sessionMeta');
  const fileTree    = document.getElementById('fileTree');
  const fileCount   = document.getElementById('fileCount');
  const modelBadge  = document.getElementById('modelBadge');
  const newSessionBtn = document.getElementById('newSessionBtn');

  let sessionId   = null;
  let isQuerying  = false;
  let lastQuestion = "";
  let lastModel   = '';

  /* ── Session init ─────────────────────────────────────────── */
  function init() {
    const session = CodeRAG.getCurrentSession();
    if (!session?.session_id) {
      window.location.href = 'index.html';
      return;
    }

    sessionId = session.session_id;
    const meta = session.metadata || {};

    sessionBadge.textContent = sessionId.slice(0, 20) + '...';
    sessionMeta.textContent = [
      meta.file_count   ? `${meta.file_count} files`   : '',
      meta.chunk_count  ? `${meta.chunk_count} chunks`  : '',
      meta.primary_language || '',
    ].filter(Boolean).join(' · ');

    // Populate file tree
    if (meta.filename || meta.repo_url) {
      renderFileTree(session);
    }

    sendBtn.disabled = false;
  }

  /* ── File tree sidebar ────────────────────────────────────── */
  const EXT_ICONS = {
    ts: '𝑻', tsx: '⚛', js: '𝑱', jsx: '⚛', py: '🐍',
    md: '📄', css: '🎨', html: '🌐', json: '{}', txt: '📝',
  };
  const EXT_CLASS = {
    ts: 'ts', tsx: 'ts', js: 'js', jsx: 'js',
    py: 'py', css: 'css', html: 'html', md: 'md',
  };

  function renderFileTree(session) {
    const files = session.relevant_files || [];
    const count = session.metadata?.file_count || files.length;
    fileCount.textContent = count;

    if (!files.length) {
      fileTree.innerHTML = '<p style="padding:12px;font-family:var(--font-mono);font-size:.72rem;color:var(--text-3)">Files will appear after first query.</p>';
      return;
    }

    fileTree.innerHTML = files.map(f => {
      const parts = f.replace(/\\/g, '/').split('/');
      const name = parts[parts.length - 1];
      const ext  = name.split('.').pop().toLowerCase();
      const icon = EXT_ICONS[ext] || '◻';
      const cls  = EXT_CLASS[ext] || '';
      return `
        <div class="file-item file-item--${cls}" title="${f}">
          <span class="file-item__icon">${icon}</span>
          <span class="file-item__name">${name}</span>
        </div>`;
    }).join('');
  }

  /* ── Auto-resize textarea ─────────────────────────────────── */
  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 160) + 'px';
    sendBtn.disabled = !chatInput.value.trim() || isQuerying;
  });

  /* ── Send on Ctrl+Enter or Enter (no shift) ───────────────── */
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!isQuerying && chatInput.value.trim()) sendQuery();
    }
  });

  sendBtn.addEventListener('click', () => {
    if (!isQuerying && chatInput.value.trim()) sendQuery();
  });

  /* ── Suggestion chips ─────────────────────────────────────── */
  document.querySelectorAll('.suggestion-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      chatInput.value = chip.textContent.trim();
      chatInput.dispatchEvent(new Event('input'));
      sendQuery();
    });
  });

  /* ── New session ──────────────────────────────────────────── */
  if (newSessionBtn) {
    newSessionBtn.addEventListener('click', () => {
      window.location.href = 'index.html';
    });
  }

  /* ── Query ────────────────────────────────────────────────── */
  async function sendQuery() {
    const question = chatInput.value.trim();
    if (!question || isQuerying || !sessionId) return;

    isQuerying = true;
    lastQuestion = question;
    sendBtn.disabled = true;
    chatInput.value = '';
    chatInput.style.height = 'auto';

    // Hide welcome message on first real query
    if (welcomeMsg) welcomeMsg.style.display = 'none';

    // Render user bubble
    appendUserMsg(question);

    // Render thinking indicator
    const thinkingEl = appendThinking();

    try {
      const data = await CodeRAG.query(sessionId, question);

      thinkingEl.remove();

      // Update model badge
      if (data.metadata?.model_used) {
        lastModel = data.metadata.model_used;
        modelBadge.textContent = lastModel.split('/').pop();
      }

      // Update file tree with relevant files from this response
      if (data.relevant_files?.length) {
        const session = CodeRAG.getCurrentSession() || {};
        session.relevant_files = data.relevant_files;
        CodeRAG.setCurrentSession(session);
        renderFileTree(session);
      }

      appendAssistantMsg(data);

    } catch (err) {
      thinkingEl.remove();

      // Handle session expiry
      if (err.message.includes('session') || err.message.includes('404')) {
        appendError('Session expired. Please upload your codebase again.', true);
      } else {
        appendError(err.message || 'Query failed. Please try again.');
      }
    } finally {
      isQuerying = false;
      sendBtn.disabled = !chatInput.value.trim();
      scrollToBottom();
    }
  }

  /* ── Message rendering ────────────────────────────────────── */
  function appendUserMsg(text) {
    const msg = document.createElement('div');
    msg.className = 'msg msg--user';
    msg.innerHTML = `<div class="msg__bubble">${escapeHtml(text)}</div>`;
    messagesEl.appendChild(msg);
    scrollToBottom();
  }

  function appendThinking() {
    const el = document.createElement('div');
    el.className = 'msg msg--assistant';
    el.innerHTML = `
      <div class="thinking">
        <div class="thinking__dots">
          <div class="thinking__dot"></div>
          <div class="thinking__dot"></div>
          <div class="thinking__dot"></div>
        </div>
        <span>Analyzing code...</span>
      </div>`;
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  function appendAssistantMsg(data) {
    const msg = document.createElement('div');
    msg.className = 'msg msg--assistant';

    // ── Answer text (markdown → HTML)
    const answerHtml = markdownToHtml(data.answer || '');

    // ── Code snippets — 3 display modes:
    // 1. REFUSAL: LLM said it can't answer → hide snippets entirely
    // 2. OVERVIEW: general project question → collapsible toggle
    // 3. CODE: specific code question → show directly

    const REFUSAL_RE = /cannot (determine|answer|find|provide)|not (contain|found|present)|no information|outside.*scope|unrelated to (the |this )?(code|project)/i;
    const isRefusal = REFUSAL_RE.test(data.answer || '');

    // Question intent detection:
    // OVERVIEW   → collapsible toggle (don't flood with code)
    // EXPLAIN    → hide snippets entirely (answer is enough)
    // CODE_REQ   → show snippets directly (user wants code)
    // REFUSAL    → hide everything

    const OVERVIEW_RE  = /^(what does|what is|explain the project|overview|summarize|how does this work|architecture|tell me about|describe the project)/i;
    const EXPLAIN_RE   = /^(what is|what does|explain|why does|why is|what.*purpose|what.*mean|how does.*work|what.*do)/i;
    const CODE_REQ_RE  = /^(write|generate|create|add|give me|show me|can you write|can you create|how (do|can) i (write|create|add|implement))/i;

    const isOverview  = OVERVIEW_RE.test(lastQuestion || '');
    const isExplain   = EXPLAIN_RE.test(lastQuestion || '') && !isOverview;
    const isCodeReq   = CODE_REQ_RE.test(lastQuestion || '');
    const hideSnippets = isRefusal || isExplain;

    let snippetsHtml = '';
    if (data.code_snippets?.length && !hideSnippets) {
      const count = data.code_snippets.length;
      const inner = data.code_snippets.map((s, i) => renderSnippet(s, i)).join('');
      if (isOverview || (!isCodeReq && !isOverview)) {
        // Collapsible for overviews and ambiguous questions
        snippetsHtml = '<div class="msg__snippets-wrap">' +
          '<button class="snippets-toggle-btn" onclick="var el=this.nextElementSibling;var open=el.style.display!==\'none\';el.style.display=open?\'none\':\'flex\';this.textContent=open?\'▼ View ' + count + ' source snippets\':\'▲ Hide snippets\';">▼ View ' + count + ' source snippets</button>' +
          '<div class="msg__snippets" style="display:none;flex-direction:column;gap:12px;margin-top:12px">' + inner + '</div>' +
          '</div>';
      } else {
        // Show directly only for explicit code requests
        snippetsHtml = '<div class="msg__snippets">' + inner + '</div>';
      }
    }

    // ── Relevant files chips — hidden on refusals
    let filesHtml = '';
    if (data.relevant_files?.length && !isRefusal && !isExplain) {
      filesHtml = `<div class="msg__files">
        ${data.relevant_files.map(f => {
          const name = f.replace(/\\/g, '/').split('/').pop();
          return `<span class="file-chip">${name}</span>`;
        }).join('')}
      </div>`;
    }

    // ── Metadata row
    const tokens = data.metadata?.tokens;
    const time   = data.processing_time;
    const model  = data.metadata?.model_used || '';
    const metaHtml = `
      <div class="msg__meta">
        ${model ? `<span class="msg__meta-item"><span class="msg__meta-label">model</span> <span class="msg__meta-model">${model.split('/').pop()}</span></span>` : ''}
        ${time   ? `<span class="msg__meta-item"><span class="msg__meta-label">time</span> <span class="msg__meta-value">${time.toFixed(2)}s</span></span>` : ''}
        ${tokens?.total ? `<span class="msg__meta-item"><span class="msg__meta-label">tokens</span> <span class="msg__meta-value">${tokens.total.toLocaleString()}</span></span>` : ''}
        ${filesHtml ? `<span class="msg__meta-item msg__meta-item--files">referenced: ${filesHtml}</span>` : ''}
      </div>`;

    msg.innerHTML = `
      <div class="msg__bubble">
        <div class="msg__answer">${answerHtml}</div>
        ${snippetsHtml}
        ${metaHtml}
      </div>`;

    messagesEl.appendChild(msg);

    // Wire up copy buttons
    msg.querySelectorAll('.snippet__copy').forEach(btn => {
      btn.addEventListener('click', () => {
        const code = btn.closest('.snippet').querySelector('.snippet__code').textContent;
        navigator.clipboard.writeText(code).then(() => {
          btn.textContent = 'Copied!';
          btn.classList.add('snippet__copy--copied');
          setTimeout(() => {
            btn.textContent = 'Copy';
            btn.classList.remove('snippet__copy--copied');
          }, 2000);
        });
      });
    });

    scrollToBottom();
  }

  function renderSnippet(snippet, index) {
    const file  = (snippet.file || '').replace(/\\/g, '/');
    const name  = file.split('/').pop();
    const lang  = snippet.language || 'code';
    const lines = snippet.lines || '';
    const code  = escapeHtml(snippet.code || '');

    return `
      <div class="snippet">
        <div class="snippet__header">
          <span class="snippet__file" title="${file}">◻ ${name}</span>
          ${lines ? `<span class="snippet__lines">L${lines}</span>` : ''}
          <span class="snippet__lang">${lang}</span>
          <button class="snippet__copy">Copy</button>
        </div>
        <pre class="snippet__code"><code>${code}</code></pre>
      </div>`;
  }

  function appendError(msg, showLink = false) {
    const el = document.createElement('div');
    el.className = 'msg msg--assistant';
    el.innerHTML = `
      <div class="msg__error">
        <span>⚠</span>
        <span>${escapeHtml(msg)}
          ${showLink ? ' <a href="index.html" style="color:var(--accent);text-decoration:underline">Upload again →</a>' : ''}
        </span>
      </div>`;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  /* ── Minimal Markdown → HTML ──────────────────────────────── */
  function markdownToHtml(md) {
    return md
      // Code blocks (```lang\n...\n```)
      .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
        `<pre style="background:var(--bg-3);border:1px solid var(--border);border-radius:6px;padding:12px 14px;overflow-x:auto;margin:10px 0"><code style="font-family:var(--font-mono);font-size:.78rem;color:var(--text)">${escapeHtml(code.trimEnd())}</code></pre>`)
      // Inline code
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      // Bold
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // H2
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      // H3
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      // Unordered list items
      .replace(/^\s*[-*] (.+)$/gm, '<li>$1</li>')
      // Wrap consecutive <li> in <ul>
      .replace(/(<li>.*<\/li>\n?)+/gs, m => `<ul>${m}</ul>`)
      // Paragraphs (double newline)
      .replace(/\n{2,}/g, '</p><p>')
      .replace(/^(?!<[hup]|<li|<pre)/, '<p>')
      .replace(/$(?!<\/[hup]|<\/pre)/, '</p>')
      // Single newlines → <br> inside paragraphs
      .replace(/(?<!>)\n(?!<)/g, '<br>');
  }

  /* ── Helpers ──────────────────────────────────────────────── */
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: 'smooth' });
    });
  }

  /* ── Boot ─────────────────────────────────────────────────── */
  /* Health status wired to new chat.html IDs */
  const statusDotEl  = document.getElementById("statusDot");
  const statusTextEl = document.getElementById("statusText");
  async function pingHealth() {
    try {
      const ok = await CodeRAG.checkHealth();
      if (statusDotEl)  statusDotEl.className  = ok ? "status-dot status-dot--ok" : "status-dot status-dot--warn";
      if (statusTextEl) statusTextEl.textContent = ok ? "API online" : "Degraded";
    } catch {
      if (statusDotEl)  statusDotEl.className  = "status-dot status-dot--err";
      if (statusTextEl) statusTextEl.textContent = "API offline";
    }
  }
  pingHealth();
  setInterval(pingHealth, 30000);
  init();
});