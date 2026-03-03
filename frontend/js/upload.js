/**
 * upload.js — Upload page logic (ZIP + GitHub)
 */

document.addEventListener('DOMContentLoaded', () => {

  /* ── Elements ─────────────────────────────────────────────── */
  const tabZip       = document.getElementById('tabZip');
  const tabGithub    = document.getElementById('tabGithub');
  const panelZip     = document.getElementById('panelZip');
  const panelGithub  = document.getElementById('panelGithub');
  const dropzone     = document.getElementById('dropzone');
  const fileInput    = document.getElementById('fileInput');
  const browseBtn    = document.getElementById('browseBtn');
  const dropzoneIdle = document.getElementById('dropzoneIdle');
  const dropzoneFile = document.getElementById('dropzoneFile');
  const fileName     = document.getElementById('fileName');
  const fileSize     = document.getElementById('fileSize');
  const fileClear    = document.getElementById('fileClear');
  const repoUrl      = document.getElementById('repoUrl');
  const branch       = document.getElementById('branch');
  const indexBtn     = document.getElementById('indexBtn');
  const btnLabel     = document.getElementById('btnLabel');
  const progressWrap = document.getElementById('progressWrap');
  const progressFill = document.getElementById('progressFill');
  const progressLabel= document.getElementById('progressLabel');
  const errorWrap    = document.getElementById('errorWrap');
  const errorMsg     = document.getElementById('errorMsg');
  const stage1       = document.getElementById('stage1');
  const stage2       = document.getElementById('stage2');
  const stage3       = document.getElementById('stage3');
  const stage4       = document.getElementById('stage4');

  let selectedFile = null;
  let activeTab    = 'zip';
  let isIndexing   = false;

  /* ── Tab switching ────────────────────────────────────────── */
  function switchTab(tab) {
    activeTab = tab;
    tabZip.classList.toggle('tab--active', tab === 'zip');
    tabGithub.classList.toggle('tab--active', tab === 'github');
    panelZip.classList.toggle('tab-panel--active', tab === 'zip');
    panelGithub.classList.toggle('tab-panel--active', tab === 'github');
    hideError();
    updateBtn();
  }

  tabZip.addEventListener('click', () => switchTab('zip'));
  tabGithub.addEventListener('click', () => switchTab('github'));

  /* ── Dropzone ─────────────────────────────────────────────── */
  browseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  dropzone.addEventListener('click', () => {
    if (!selectedFile) fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) setFile(fileInput.files[0]);
  });

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dropzone--over');
  });
  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dropzone--over');
  });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dropzone--over');
    const f = e.dataTransfer.files[0];
    if (f && f.name.endsWith('.zip')) setFile(f);
    else showError('Only .zip files are accepted.');
  });

  function setFile(file) {
    if (!file.name.endsWith('.zip')) { showError('Only .zip files are accepted.'); return; }
    if (file.size > 100 * 1024 * 1024) { showError('File exceeds 100MB limit.'); return; }
    selectedFile = file;
    fileName.textContent = file.name;
    fileSize.textContent = formatBytes(file.size);
    dropzoneIdle.hidden = true;
    dropzoneFile.hidden = false;
    hideError();
    updateBtn();
  }

  fileClear.addEventListener('click', (e) => {
    e.stopPropagation();
    selectedFile = null;
    fileInput.value = '';
    dropzoneIdle.hidden = false;
    dropzoneFile.hidden = true;
    updateBtn();
  });

  repoUrl.addEventListener('input', () => { hideError(); updateBtn(); });

  /* ── Button state ─────────────────────────────────────────── */
  function updateBtn() {
    if (isIndexing) { indexBtn.disabled = true; return; }
    indexBtn.disabled = activeTab === 'zip' ? !selectedFile : !repoUrl.value.trim();
  }

  /* ── Index button ─────────────────────────────────────────── */
  indexBtn.addEventListener('click', () => {
    if (isIndexing) return;
    if (activeTab === 'zip') runUploadZip();
    else runUploadGithub();
  });

  /* ── ZIP upload — uses CodeRAG.uploadZip() from api.js ───── */
  async function runUploadZip() {
    startLoading();
    try {
      setProgress(5, 'Uploading file…', 0);

      // CodeRAG.uploadZip() uses XHR internally and calls onProgress with 0-60
      const data = await CodeRAG.uploadZip(selectedFile, (pct) => {
        setProgress(5 + pct, 'Uploading file…', 0);
      });

      setProgress(70, 'Parsing codebase…', 1);
      await sleep(400);
      setProgress(88, 'Generating embeddings…', 2);
      await sleep(400);
      setProgress(100, 'Ready!', 3);
      await sleep(600);

      CodeRAG.setCurrentSession(data);
      window.location.href = 'chat.html';

    } catch (err) {
      stopLoading();
      showError(err.message || 'Upload failed. Please try again.');
    }
  }

  /* ── GitHub upload — uses CodeRAG.uploadGitHub() from api.js  */
  async function runUploadGithub() {
    const url = repoUrl.value.trim();
    if (!url) { showError('Please enter a GitHub repository URL.'); return; }

    startLoading();
    try {
      setProgress(10, 'Cloning repository…', 0);

      // CodeRAG.uploadGitHub() already knows the correct API_BASE + path
      const data = await CodeRAG.uploadGitHub(url, branch.value.trim() || 'main');

      setProgress(70, 'Parsing codebase…', 1);
      await sleep(400);
      setProgress(88, 'Generating embeddings…', 2);
      await sleep(400);
      setProgress(100, 'Ready!', 3);
      await sleep(600);

      CodeRAG.setCurrentSession(data);
      window.location.href = 'chat.html';

    } catch (err) {
      stopLoading();
      showError(err.message || 'Clone failed. Check the URL and try again.');
    }
  }

  /* ── Progress ─────────────────────────────────────────────── */
  const stages = [stage1, stage2, stage3, stage4];

  function setProgress(pct, label, stageIdx) {
    progressFill.style.width = pct + '%';
    progressLabel.textContent = label;
    stages.forEach((s, i) => {
      s.classList.remove('stage--active', 'stage--done');
      if (i < stageIdx)        s.classList.add('stage--done');
      else if (i === stageIdx) s.classList.add('stage--active');
    });
  }

  function startLoading() {
    isIndexing = true;
    btnLabel.textContent = 'Indexing…';
    indexBtn.disabled = true;
    progressWrap.hidden = false;
    hideError();
  }

  function stopLoading() {
    isIndexing = false;
    btnLabel.textContent = 'Index Codebase';
    progressWrap.hidden = true;
    updateBtn();
  }

  /* ── Error ────────────────────────────────────────────────── */
  function showError(msg) {
    errorMsg.textContent = msg;
    errorWrap.hidden = false;
  }
  function hideError() { errorWrap.hidden = true; }

  /* ── Utils ────────────────────────────────────────────────── */
  function formatBytes(bytes) {
    if (bytes < 1024)    return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

});