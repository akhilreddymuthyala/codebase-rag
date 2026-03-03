/**
 * api.js — CodeRAG API Client
 * Robust connection layer: health check, retries, session persistence.
 */

const API_BASE = 'http://127.0.0.1:8000';
const API_TIMEOUT_MS = 120000;   // 2 min (large uploads / slow LLM)
const HEALTH_INTERVAL_MS = 30000; // poll health every 30s

/* ── Internal fetch with timeout ──────────────────────────── */
async function fetchWithTimeout(url, options = {}, timeoutMs = API_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error('Request timed out. The server may be busy.');
    throw err;
  }
}

/* ── Core request with error normalisation ────────────────── */
async function apiRequest(path, options = {}) {
  const url = `${API_BASE}${path}`;
  let res;
  try {
    res = await fetchWithTimeout(url, {
      headers: { 'Accept': 'application/json', ...options.headers },
      ...options,
    });
  } catch (err) {
    throw new Error(`Network error: ${err.message}`);
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail = body.detail || body.error || detail;
    } catch (_) { /* ignore parse errors */ }
    throw new Error(detail);
  }

  return res.json();
}

/* ── Health check ─────────────────────────────────────────── */
const CodeRAG = {
  _statusEl: null,
  _dotEl: null,
  _labelEl: null,

  initStatusUI() {
    const wrap = document.getElementById('apiStatus');
    if (!wrap) return;
    this._dotEl   = wrap.querySelector('.status-dot');
    this._labelEl = wrap.querySelector('.status-label');
  },

  _setStatus(state, label) {
    if (!this._dotEl) return;
    this._dotEl.className = 'status-dot' + (state ? ` status-dot--${state}` : '');
    if (this._labelEl) this._labelEl.textContent = label;
  },

  async checkHealth() {
    try {
      const data = await fetchWithTimeout(`${API_BASE}/health`, {}, 5000)
        .then(r => r.ok ? r.json() : Promise.reject());
      this._setStatus('ok', `API · ${data.redis === 'connected' ? 'Redis ✓' : 'Redis ✗'}`);
      return true;
    } catch {
      this._setStatus('err', 'API offline');
      return false;
    }
  },

  startHealthPolling() {
    this.initStatusUI();
    this.checkHealth();
    setInterval(() => this.checkHealth(), HEALTH_INTERVAL_MS);
  },

  /* ── Upload ZIP ─────────────────────────────────────────── */
  async uploadZip(file, onProgress) {
    const formData = new FormData();
    formData.append('file', file);

    // Use XMLHttpRequest for real upload progress
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE}/api/upload/zip`);
      xhr.timeout = API_TIMEOUT_MS;

      xhr.upload.addEventListener('progress', e => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 60)); // 0-60% for upload
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch { reject(new Error('Invalid server response')); }
        } else {
          try {
            const body = JSON.parse(xhr.responseText);
            reject(new Error(body.detail || `Upload failed (${xhr.status})`));
          } catch {
            reject(new Error(`Upload failed (${xhr.status})`));
          }
        }
      });

      xhr.addEventListener('error',   () => reject(new Error('Network error during upload')));
      xhr.addEventListener('timeout', () => reject(new Error('Upload timed out')));
      xhr.send(formData);
    });
  },

  /* ── Upload GitHub ──────────────────────────────────────── */
  async uploadGitHub(repoUrl, branch = 'main') {
    return apiRequest('/api/upload/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo_url: repoUrl, branch }),
    });
  },

  /* ── Query ──────────────────────────────────────────────── */
  async query(sessionId, question) {
    return apiRequest('/api/query/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, question }),
    });
  },

  /* ── Session info ───────────────────────────────────────── */
  async getSession(sessionId) {
    return apiRequest(`/api/session/${sessionId}`);
  },

  /* ── Session storage helpers ────────────────────────────── */
  saveSession(data) {
    try {
      const sessions = this.getSavedSessions();
      sessions.unshift({
        session_id: data.session_id,
        filename: data.metadata?.filename || data.metadata?.repo_url || 'Unknown',
        file_count: data.metadata?.file_count || 0,
        chunk_count: data.metadata?.chunk_count || 0,
        primary_language: data.metadata?.primary_language || '',
        saved_at: Date.now(),
      });
      // Keep last 5
      localStorage.setItem('coderag_sessions', JSON.stringify(sessions.slice(0, 5)));
    } catch { /* localStorage may be unavailable */ }
  },

  getSavedSessions() {
    try {
      return JSON.parse(localStorage.getItem('coderag_sessions') || '[]');
    } catch { return []; }
  },

  getCurrentSession() {
    try { return JSON.parse(sessionStorage.getItem('coderag_active') || 'null'); }
    catch { return null; }
  },

  setCurrentSession(data) {
    try { sessionStorage.setItem('coderag_active', JSON.stringify(data)); }
    catch { /* ignore */ }
  },
};

// Auto-start health polling when DOM ready
document.addEventListener('DOMContentLoaded', () => CodeRAG.startHealthPolling());