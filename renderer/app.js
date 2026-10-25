/* global require, monaco, marked, DOMPurify, registerCnanoLanguages, defineCnanoTheme, languageForFile, languageFromShebang */
'use strict';

const api = window.cnano;
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
const dirname = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '.' : p.slice(0, i) || '/'; };
const join = (...parts) => parts.join('/').replace(/\/+/g, '/');
const rel = (p) => (state.root && p.startsWith(state.root + '/') ? p.slice(state.root.length + 1) : p);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const ICONS = {
  chev: '<svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
  undo: '<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>',
  open: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  branch: '<svg viewBox="0 0 24 24"><circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="8" r="2.2"/><path d="M6 7.2v9.6M18 10.2c0 4-6 3-11 7"/></svg>',
  sync: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>',
  folder: '<svg viewBox="0 0 24 24" style="color:#7d8199"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  folderOpen: '<svg viewBox="0 0 24 24" style="color:#a882ff"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1"/><path d="M3 7v10a2 2 0 0 0 2 2h12.5a2 2 0 0 0 1.9-1.4L21.5 12H7.2a2 2 0 0 0-1.9 1.4L3 19"/></svg>',
};

// Small coloured badges per file type — readable at a glance for a C-heavy workflow.
function fileIcon(name) {
  const lang = languageForFile(name);
  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  const map = {
    c: ['C', '#7aa2f7'], h: ['H', '#bb9af7'], cpp: ['C++', '#2ac3de'], asm: ['ASM', '#f7768e'],
    shell: ['$_', '#9ece6a'], rust: ['RS', '#ff9e64'], python: ['PY', '#e0af68'], markdown: ['M↓', '#a882ff'],
    makefile: ['MK', '#e0af68'], json: ['{}', '#e0af68'], linkerscript: ['LD', '#f7768e'], yaml: ['YM', '#f7768e'],
    ini: ['≡', '#7d8199'], javascript: ['JS', '#e0af68'], typescript: ['TS', '#7aa2f7'], html: ['<>', '#ff9e64'],
  };
  let key = lang;
  if (ext === 'h' || ext === 'hpp' || ext === 'hh') key = ext === 'h' ? 'h' : 'cpp';
  if (lower === '.gitignore' || lower === '.gitmodules') return `<span class="ficon" style="color:#f7768e">⎇</span>`;
  if (lower.startsWith('license') || lower.startsWith('copying')) return `<span class="ficon" style="color:#e0af68">©</span>`;
  const m = map[key];
  if (!m) return `<span class="ficon" style="color:var(--fg-faint)">${ICONS.open.replace('<svg', '<svg style="width:14px;height:14px"')}</span>`;
  return `<span class="ficon" style="color:${m[1]};background:${m[1]}1f;font-size:${m[0].length > 2 ? 7 : 8.5}px">${m[0]}</span>`;
}

// ============================================================ state
const state = {
  root: null,
  tabs: [],
  active: null,
  expanded: new Set(),
  selected: null,
  git: { repo: false },
  settings: { fontSize: 14, recent: [], sidebarWidth: 270, wordWrap: 'off', minimap: true, previewWidth: 0.5 },
  untitledCounter: 1,
  view: 'explorer',
};
let editor, diffEditor;
let tabIdSeq = 1;

const saveSettings = debounce(() => api.settings.save(state.settings), 300);

// ============================================================ toasts / status
function toast(title, body = '', kind = 'info', ms = 4500) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div class="t-title">${esc(title)}</div>${body ? `<div class="t-body">${esc(body.trim())}</div>` : ''}`;
  el.onclick = () => el.remove();
  $('#toasts').appendChild(el);
  if (ms) setTimeout(() => el.remove(), kind === 'error' ? ms * 2 : ms);
}
function statusMsg(text, spinning = false) {
  $('#sb-msg').innerHTML = text ? `${spinning ? ICONS.sync.replace('<svg', '<svg class="spin"') : ''}${esc(text)}` : '';
}

// ============================================================ quick input (palette, quick open, prompts)
const qi = { items: [], filtered: [], index: 0, onAccept: null, onCancel: null, matcher: null, mode: 'pick' };

function fuzzy(query, text) {
  if (!query) return { score: 0, hits: [] };
  const q = query.toLowerCase(), t = text.toLowerCase();
  let qi_ = 0, score = 0, last = -2;
  const hits = [];
  for (let i = 0; i < t.length && qi_ < q.length; i++) {
    if (t[i] === q[qi_]) {
      hits.push(i);
      score += last === i - 1 ? 5 : 1;
      if (i === 0 || '/_-. '.includes(t[i - 1])) score += 3;
      last = i; qi_++;
    }
  }
  if (qi_ < q.length) return null;
  return { score: score - t.length * 0.01, hits };
}
function highlightHits(text, hits) {
  if (!hits || !hits.length) return esc(text);
  const set = new Set(hits);
  return [...text].map((c, i) => (set.has(i) ? `<b>${esc(c)}</b>` : esc(c))).join('');
}

function showQuickPick(items, { placeholder = '', onAccept, value = '', matchOn = 'label' } = {}) {
  qi.mode = 'pick'; qi.items = items; qi.onAccept = onAccept; qi.matchOn = matchOn;
  const input = $('#qi-input');
  input.placeholder = placeholder; input.value = value;
  $('#quickinput').hidden = false;
  filterQuickPick();
  input.focus();
}
function filterQuickPick() {
  const q = $('#qi-input').value.trim();
  if (qi.mode === 'prompt') return;
  const scored = [];
  for (const it of qi.items) {
    const target = qi.matchOn === 'full' ? (it.desc ? `${it.desc}/${it.label}` : it.label) : it.label;
    const m = fuzzy(q, target);
    if (!m) continue;
    // Re-map hits onto the label for highlighting when matching on full path.
    const offset = target.length - it.label.length;
    scored.push({ it, score: m.score, hits: m.hits.filter((h) => h >= offset).map((h) => h - offset) });
  }
  if (q) scored.sort((a, b) => b.score - a.score);
  qi.filtered = scored.slice(0, 200);
  qi.index = 0;
  renderQuickPick();
}
function renderQuickPick() {
  $('#qi-list').innerHTML = qi.filtered.map(({ it, hits }, i) => `
    <div class="qi-item ${i === qi.index ? 'active' : ''}" data-i="${i}">
      ${it.icon || ''}<span class="label">${highlightHits(it.label, hits)}</span>
      ${it.desc ? `<span class="desc">${esc(it.desc)}</span>` : ''}
      ${it.kb ? `<span class="kb">${esc(it.kb)}</span>` : ''}
    </div>`).join('') || (qi.items.length ? '<div class="qi-hint">No matching results</div>' : '');
  const act = $('#qi-list .qi-item.active');
  if (act) act.scrollIntoView({ block: 'nearest' });
}
function prompt(placeholder, value = '', hint = '') {
  return new Promise((resolve) => {
    qi.mode = 'prompt';
    qi.onAccept = (v) => resolve(v);
    qi.onCancel = () => resolve(null);
    const input = $('#qi-input');
    input.placeholder = placeholder; input.value = value;
    $('#qi-list').innerHTML = hint ? `<div class="qi-hint">${esc(hint)}</div>` : '';
    $('#quickinput').hidden = false;
    input.focus();
    const dot = value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : value.length);
  });
}
function closeQuickInput(cancelled = true) {
  if ($('#quickinput').hidden) return;
  $('#quickinput').hidden = true;
  const cb = qi.onCancel; qi.onCancel = null; qi.onAccept = null;
  if (cancelled && cb) cb();
  if (editor && activeTab() && !activeTab().diff) editor.focus();
}
function acceptQuickInput() {
  const accept = qi.onAccept;
  if (qi.mode === 'prompt') {
    const v = $('#qi-input').value;
    qi.onCancel = null;
    closeQuickInput(false);
    accept && accept(v);
    return;
  }
  const sel = qi.filtered[qi.index];
  closeQuickInput(false);
  if (sel && accept) accept(sel.it);
}
$('#qi-input').addEventListener('input', filterQuickPick);
$('#qi-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeQuickInput(); }
  else if (e.key === 'Enter') { e.preventDefault(); acceptQuickInput(); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!qi.filtered.length) return;
    qi.index = (qi.index + (e.key === 'ArrowDown' ? 1 : -1) + qi.filtered.length) % qi.filtered.length;
    renderQuickPick();
  }
});
$('#qi-input').addEventListener('blur', () => setTimeout(() => {
  if (!$('#quickinput').contains(document.activeElement)) closeQuickInput();
}, 120));
$('#qi-list').addEventListener('mousedown', (e) => {
  const item = e.target.closest('.qi-item');
  if (!item) return;
  e.preventDefault();
  qi.index = +item.dataset.i;
  acceptQuickInput();
});

// ============================================================ context menu
function showContextMenu(x, y, items) {
  const m = $('#ctxmenu');
  m.innerHTML = items.map((it, i) => (it === '-' ? '<div class="ctx-sep"></div>'
    : `<div class="ctx-item ${it.danger ? 'danger' : ''}" data-i="${i}"><span>${esc(it.label)}</span><span class="muted">${esc(it.kb || '')}</span></div>`)).join('');
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 6) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 6) + 'px';
  m.onclick = (e) => {
    const el = e.target.closest('.ctx-item');
    if (!el) return;
    m.hidden = true;
    items[+el.dataset.i].run();
  };
}
document.addEventListener('mousedown', (e) => { if (!$('#ctxmenu').contains(e.target)) $('#ctxmenu').hidden = true; });

// ============================================================ commands
const commands = {};
// Extension points used by gutter.js / terminal.js / agent.js.
const extraKeys = {};
const afterBoot = [];
const gutterHook = () => typeof updateGutter === 'function' && updateGutter();
function cmd(id, label, run, kb) { commands[id] = { id, label, run, kb }; }
function runCommand(id, ...args) {
  const c = commands[id];
  if (!c) return console.warn('unknown command', id);
  Promise.resolve(c.run(...args)).catch((err) => toast(`${c.label} failed`, err.message || String(err), 'error'));
}
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-cmd]');
  if (el) { e.preventDefault(); runCommand(el.dataset.cmd); }
});

// ============================================================ tabs & editor
const activeTab = () => state.tabs.find((t) => t.id === state.active);
const findTab = (p) => state.tabs.find((t) => t.path === p && !t.diff);

function isDirty(tab) { return !tab.diff && tab.model && tab.model.getAlternativeVersionId() !== tab.savedVersion; }

async function openFile(p, { line, col, focus = true } = {}) {
  let tab = findTab(p);
  if (!tab) {
    let res;
    try { res = await api.fs.readFile(p); } catch (err) { toast('Could not open file', err.message, 'error'); return; }
    if (res.binary) { toast('Binary file', `${basename(p)} looks binary and can't be edited here.`); return; }
    let lang = languageForFile(basename(p));
    if (lang === 'plaintext') lang = languageFromShebang(res.content.split('\n', 1)[0]) || lang;
    const uri = monaco.Uri.file(p);
    const model = monaco.editor.getModel(uri) || monaco.editor.createModel(res.content, lang, uri);
    applyLanguageDefaults(model);
    tab = { id: tabIdSeq++, path: p, name: basename(p), model, savedVersion: model.getAlternativeVersionId(), viewState: null };
    tab.preview = lang === 'markdown' && state.settings.autoPreview;
    model.onDidChangeContent(() => { renderTabs(); if (tab.id === state.active) { schedulePreview(); gutterHook(); } });
    state.tabs.push(tab);
    pushRecentFile(p);
  }
  activateTab(tab.id);
  if (line) {
    editor.setPosition({ lineNumber: line, column: col || 1 });
    editor.revealLineInCenter(line);
  }
  if (focus) editor.focus();
  return tab;
}

function applyLanguageDefaults(model) {
  const lang = model.getLanguageId();
  // Hard tabs where the toolchain demands or convention expects them.
  if (lang === 'makefile') model.updateOptions({ insertSpaces: false, tabSize: 8 });
  else if (lang === 'asm') model.updateOptions({ tabSize: 8 });
  else if (lang === 'c' || lang === 'cpp' || lang === 'rust' || lang === 'python') model.updateOptions({ tabSize: 4 });
  else if (lang === 'shell') model.updateOptions({ tabSize: 4 });
  // Respect whatever indentation the file already uses.
  const lines = model.getLinesContent().slice(0, 300);
  const tabbed = lines.filter((l) => l.startsWith('\t')).length;
  const spaced = lines.filter((l) => /^ {2,}\S/.test(l)).length;
  if (tabbed > spaced) model.updateOptions({ insertSpaces: false });
  else if (spaced > tabbed && lang !== 'makefile') model.updateOptions({ insertSpaces: true });
}

function newUntitled(content = '', lang = 'plaintext') {
  const name = `Untitled-${state.untitledCounter++}`;
  const model = monaco.editor.createModel(content, lang, monaco.Uri.parse(`untitled:${name}`));
  const tab = { id: tabIdSeq++, path: null, name, model, savedVersion: content ? -1 : model.getAlternativeVersionId(), viewState: null };
  model.onDidChangeContent(() => { renderTabs(); if (tab.id === state.active) { schedulePreview(); gutterHook(); } });
  state.tabs.push(tab);
  activateTab(tab.id);
  editor.focus();
}

function activateTab(id) {
  const prev = activeTab();
  if (prev && !prev.diff && prev.id !== id) prev.viewState = editor.saveViewState();
  state.active = id;
  const tab = activeTab();
  $('#welcome').hidden = !!tab;
  if (!tab) {
    $('#editor-host').hidden = false; $('#diff-host').hidden = true;
    editor.setModel(null);
    updatePreviewVisibility();
    renderTabs(); renderBreadcrumbs(); updateStatusBar(); updateTitle(); highlightActiveInTree();
    return;
  }
  if (tab.diff) {
    $('#editor-host').hidden = true; $('#diff-host').hidden = false;
    diffEditor.setModel({ original: tab.diff.original, modified: tab.diff.modified });
    diffEditor.layout();
  } else {
    $('#editor-host').hidden = false; $('#diff-host').hidden = true;
    editor.setModel(tab.model);
    if (tab.viewState) editor.restoreViewState(tab.viewState);
    editor.layout();
  }
  updatePreviewVisibility();
  renderTabs(); renderBreadcrumbs(); updateStatusBar(); updateTitle(); highlightActiveInTree();
  gutterHook();
}

async function closeTab(id, { force = false } = {}) {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return true;
  if (!force && isDirty(tab)) {
    activateTab(id);
    const choice = await api.dialog.unsaved(tab.name);
    if (choice === 'cancel') return false;
    if (choice === 'save' && !(await saveTab(tab))) return false;
  }
  const idx = state.tabs.indexOf(tab);
  state.tabs.splice(idx, 1);
  if (tab.diff) { tab.diff.original.dispose(); if (tab.diff.ownsModified) tab.diff.modified.dispose(); }
  else if (!state.tabs.some((t) => t.diff && t.diff.modified === tab.model)) tab.model.dispose();
  if (state.active === id) {
    const next = state.tabs[idx] || state.tabs[idx - 1];
    activateTab(next ? next.id : null);
  } else renderTabs();
  return true;
}

async function saveTab(tab, saveAs = false) {
  if (!tab || tab.diff) return false;
  let p = tab.path;
  if (!p || saveAs) {
    p = await api.dialog.saveAs(p || join(state.root || '', tab.name));
    if (!p) return false;
  }
  if (state.settings.trimTrailingWhitespace !== false) trimTrailing(tab.model);
  try { await api.fs.writeFile(p, tab.model.getValue()); } catch (err) { toast('Save failed', err.message, 'error'); return false; }
  if (p !== tab.path) {
    // Re-home the content in a model with the right URI/language.
    const lang = languageForFile(basename(p));
    const old = tab.model;
    const vs = tab.id === state.active ? editor.saveViewState() : null;
    tab.model = monaco.editor.getModel(monaco.Uri.file(p)) || monaco.editor.createModel(old.getValue(), lang, monaco.Uri.file(p));
    tab.model.setValue(old.getValue());
    tab.model.onDidChangeContent(() => { renderTabs(); if (tab.id === state.active) { schedulePreview(); gutterHook(); } });
    applyLanguageDefaults(tab.model);
    tab.path = p; tab.name = basename(p);
    if (tab.id === state.active) { editor.setModel(tab.model); if (vs) editor.restoreViewState(vs); }
    old.dispose();
    refreshTree();
  }
  tab.savedVersion = tab.model.getAlternativeVersionId();
  if (typeof lspDidSave === 'function') lspDidSave(tab.model);
  renderTabs(); updateTitle(); renderBreadcrumbs();
  statusMsg(`Saved ${tab.name}`);
  setTimeout(() => statusMsg(''), 1800);
  refreshGit();
  return true;
}

function trimTrailing(model) {
  const edits = [];
  const n = model.getLineCount();
  for (let i = 1; i <= n; i++) {
    const line = model.getLineContent(i);
    const m = line.match(/[ \t]+$/);
    if (m) edits.push({ range: new monaco.Range(i, line.length - m[0].length + 1, i, line.length + 1), text: '' });
  }
  if (edits.length) model.pushEditOperations([], edits, () => null);
}

function renderTabs() {
  const host = $('#tabs');
  host.innerHTML = state.tabs.map((t) => {
    const dup = state.tabs.filter((o) => o.name === t.name).length > 1;
    const desc = t.diff ? t.diff.label : dup && t.path ? rel(dirname(t.path)) : '';
    return `<div class="tab ${t.id === state.active ? 'active' : ''} ${isDirty(t) ? 'dirty' : ''}" data-id="${t.id}" draggable="true" title="${esc(t.path || t.name)}">
      ${fileIcon(t.name)}<span class="tab-name">${esc(t.name)}</span>${desc ? `<span class="tab-desc">${esc(desc)}</span>` : ''}
      <span class="close">${ICONS.close}</span></div>`;
  }).join('');
  const act = $('.tab.active', host);
  if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  updateTitle();
}
$('#tabs').addEventListener('mousedown', (e) => {
  const tabEl = e.target.closest('.tab');
  if (!tabEl) return;
  const id = +tabEl.dataset.id;
  if (e.button === 1) { e.preventDefault(); closeTab(id); return; }
  if (e.button !== 0) return;
  if (e.target.closest('.close')) return;
  activateTab(id);
});
$('#tabs').addEventListener('click', (e) => {
  const close = e.target.closest('.close');
  if (close) closeTab(+close.closest('.tab').dataset.id);
});
$('#tabs').addEventListener('dblclick', (e) => { if (e.target === $('#tabs')) runCommand('file.newFile'); });
$('#tabs').addEventListener('contextmenu', (e) => {
  const tabEl = e.target.closest('.tab');
  if (!tabEl) return;
  const id = +tabEl.dataset.id;
  const tab = state.tabs.find((t) => t.id === id);
  showContextMenu(e.clientX, e.clientY, [
    { label: 'Close', kb: 'Ctrl+W', run: () => closeTab(id) },
    { label: 'Close Others', run: async () => { for (const t of state.tabs.filter((t) => t.id !== id)) if (!(await closeTab(t.id))) break; } },
    { label: 'Close to the Right', run: async () => { const i = state.tabs.findIndex((t) => t.id === id); for (const t of state.tabs.slice(i + 1)) if (!(await closeTab(t.id))) break; } },
    { label: 'Close All', run: () => runCommand('tabs.closeAll') },
    '-',
    ...(tab.path ? [
      { label: 'Copy Path', run: () => navigator.clipboard.writeText(tab.path) },
      { label: 'Copy Relative Path', run: () => navigator.clipboard.writeText(rel(tab.path)) },
      { label: 'Reveal in Explorer', run: () => revealInTree(tab.path) },
      { label: 'Open Containing Folder', run: () => api.fs.reveal(tab.path) },
    ] : []),
  ]);
});
// drag to reorder
let dragTabId = null;
$('#tabs').addEventListener('dragstart', (e) => { const t = e.target.closest('.tab'); if (t) dragTabId = +t.dataset.id; });
$('#tabs').addEventListener('dragover', (e) => {
  e.preventDefault();
  $$('.tab.drag-over').forEach((x) => x.classList.remove('drag-over'));
  const t = e.target.closest('.tab'); if (t) t.classList.add('drag-over');
});
$('#tabs').addEventListener('drop', (e) => {
  e.preventDefault();
  const t = e.target.closest('.tab');
  if (!t || dragTabId == null) return;
  const from = state.tabs.findIndex((x) => x.id === dragTabId);
  const [moved] = state.tabs.splice(from, 1);
  state.tabs.splice(state.tabs.findIndex((x) => x.id === +t.dataset.id), 0, moved);
  dragTabId = null;
  renderTabs();
});

function renderBreadcrumbs() {
  const tab = activeTab();
  const bc = $('#breadcrumbs');
  if (!tab) { bc.innerHTML = ''; bc.hidden = true; return; }
  bc.hidden = false;
  const parts = tab.path ? rel(tab.path).split('/') : [tab.name];
  bc.innerHTML = parts.map((p) => `<span class="crumb">${esc(p)}</span>`).join('<span class="sep">›</span>')
    + (tab.diff ? `<span class="sep">·</span><span class="muted">${esc(tab.diff.label)}</span>` : '');
}

function updateTitle() {
  const tab = activeTab();
  const folder = state.root ? basename(state.root) : '';
  const parts = [tab ? (isDirty(tab) ? '● ' : '') + tab.name : null, folder || null, 'cnano'].filter(Boolean);
  document.title = parts.join(' — ');
  $('#title-text').textContent = parts.join(' — ');
}

function updateStatusBar() {
  const tab = activeTab();
  if (!tab || tab.diff) {
    $('#sb-cursor').textContent = ''; $('#sb-indent').textContent = ''; $('#sb-eol').textContent = '';
    $('#sb-lang').textContent = tab ? 'Diff' : '';
    return;
  }
  const pos = editor.getPosition();
  const sel = editor.getSelection();
  const selLen = sel && !sel.isEmpty() ? tab.model.getValueInRange(sel).length : 0;
  $('#sb-cursor').textContent = pos ? `Ln ${pos.lineNumber}, Col ${pos.column}${selLen ? ` (${selLen} selected)` : ''}` : '';
  const o = tab.model.getOptions();
  $('#sb-indent').textContent = o.insertSpaces ? `Spaces: ${o.tabSize}` : `Tab Size: ${o.tabSize}`;
  $('#sb-eol').textContent = tab.model.getEOL() === '\n' ? 'LF' : 'CRLF';
  const id = tab.model.getLanguageId();
  const info = monaco.languages.getLanguages().find((l) => l.id === id);
  $('#sb-lang').textContent = (info && info.aliases && info.aliases[0]) || id;
}

// ============================================================ markdown preview
let previewMode = 'off'; // off | split | full  (applies to markdown tabs)

function updatePreviewVisibility() {
  const tab = activeTab();
  const isMd = tab && !tab.diff && tab.model.getLanguageId() === 'markdown';
  const show = isMd && previewMode !== 'off';
  $('#preview').hidden = !show;
  $('#preview-sash').hidden = !(show && previewMode === 'split');
  $('#preview').classList.toggle('full', show && previewMode === 'full');
  $('#editor-host').hidden = !!(tab && tab.diff) || (show && previewMode === 'full');
  $('#preview').style.flex = show && previewMode === 'split' ? `0 0 ${state.settings.previewWidth * 100}%` : '';
  if (show) renderPreview();
  if (editor) requestAnimationFrame(() => editor.layout());
}

const schedulePreview = debounce(() => { if (!$('#preview').hidden) renderPreview(); }, 150);

async function renderPreview() {
  const tab = activeTab();
  if (!tab || tab.diff) return;
  let src = tab.model.getValue();
  // Obsidian-style [[wikilinks]] and ==highlights==, skipped inside fenced code.
  src = src.split(/(```[\s\S]*?```)/g).map((chunk, i) => (i % 2 ? chunk : chunk
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, label) => `<a class="wikilink" href="#" data-wiki="${esc(target)}">${esc(label || target)}</a>`)
    .replace(/==([^=\n]+)==/g, '<mark>$1</mark>'))).join('');
  const html = DOMPurify.sanitize(marked.parse(src, { gfm: true }), { ADD_ATTR: ['data-wiki', 'target'] });
  const pv = $('#preview');
  const scrollRatio = pv.scrollTop / Math.max(1, pv.scrollHeight - pv.clientHeight);
  pv.innerHTML = html;
  const base = tab.path ? dirname(tab.path) : state.root;
  // Callouts: > [!note] Title
  $$('blockquote', pv).forEach((bq) => {
    const p = bq.querySelector('p');
    const m = p && p.innerHTML.match(/^\[!(\w+)\][+-]?\s*([^\n<]*)(?:\n|<br>)?/);
    if (!m) return;
    bq.classList.add('callout', m[1].toLowerCase());
    p.innerHTML = p.innerHTML.slice(m[0].length);
    const title = document.createElement('div');
    title.className = 'callout-title';
    title.textContent = m[2] || m[1];
    bq.prepend(title);
  });
  // Relative images resolve against the markdown file's folder.
  $$('img', pv).forEach((img) => {
    const s = img.getAttribute('src') || '';
    if (base && !/^(https?:|data:|file:|\/)/.test(s)) img.src = 'file://' + join(base, s);
    else if (s.startsWith('/')) img.src = 'file://' + s;
  });
  $$('a[href^="http"]', pv).forEach((a) => a.setAttribute('target', '_blank'));
  // Syntax-highlight fenced code with Monaco's own tokenizer so it matches the editor.
  await Promise.all($$('pre code', pv).map(async (code) => {
    const cls = [...code.classList].find((c) => c.startsWith('language-'));
    if (!cls) return;
    const aliases = { sh: 'shell', bash: 'shell', zsh: 'shell', 'c++': 'cpp', cc: 'cpp', rs: 'rust', py: 'python', nasm: 'asm', s: 'asm', gas: 'asm', make: 'makefile', js: 'javascript' };
    const lang = aliases[cls.slice(9)] || cls.slice(9);
    if (!monaco.languages.getLanguages().some((l) => l.id === lang)) return;
    try { code.innerHTML = await monaco.editor.colorize(code.textContent.replace(/\n$/, ''), lang, { tabSize: 4 }); } catch { /* leave plain */ }
  }));
  pv.scrollTop = scrollRatio * (pv.scrollHeight - pv.clientHeight);
}
$('#preview').addEventListener('click', async (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  const href = a.getAttribute('href') || '';
  const tab = activeTab();
  const base = tab && tab.path ? dirname(tab.path) : state.root;
  if (a.dataset.wiki) {
    e.preventDefault();
    let target = a.dataset.wiki.split('#')[0].trim();
    if (!/\.\w+$/.test(target)) target += '.md';
    const direct = join(base || '', target);
    if (await api.fs.exists(direct)) return openFile(direct);
    if (state.root) {
      const all = await api.fs.listAll(state.root);
      const hit = all.find((f) => basename(f).toLowerCase() === basename(target).toLowerCase());
      if (hit) return openFile(join(state.root, hit));
    }
    toast('Note not found', target);
  } else if (href.startsWith('#')) {
    e.preventDefault();
    const id = decodeURIComponent(href.slice(1));
    const target = $$('h1,h2,h3,h4,h5,h6', $('#preview')).find((h) => h.id === id || h.textContent.trim().toLowerCase().replace(/[^\w]+/g, '-') === id);
    if (target) target.scrollIntoView({ behavior: 'smooth' });
  } else if (!/^[a-z]+:/i.test(href) && base) {
    e.preventDefault();
    openFile(join(base, decodeURIComponent(href.split('#')[0])));
  }
});

// ============================================================ explorer tree
const dirCache = new Map();

async function readDirCached(dir, force = false) {
  if (!force && dirCache.has(dir)) return dirCache.get(dir);
  let entries = [];
  try { entries = await api.fs.readDir(dir); } catch { /* unreadable */ }
  entries = entries.filter((e) => e.name !== '.git');
  dirCache.set(dir, entries);
  return entries;
}

async function openFolder(dir) {
  if (!dir) return;
  if (state.tabs.some(isDirty)) {
    for (const t of [...state.tabs]) if (!(await closeTab(t.id))) return;
  } else {
    for (const t of [...state.tabs]) await closeTab(t.id, { force: true });
  }
  state.root = dir;
  state.expanded = new Set(state.settings.expanded && state.settings.expanded[dir] || []);
  dirCache.clear();
  state.settings.lastFolder = dir;
  state.settings.recent = [dir, ...state.settings.recent.filter((r) => r !== dir)].slice(0, 10);
  saveSettings();
  $('#explorer-empty').hidden = true;
  $('#explorer-root-name').textContent = basename(dir);
  await refreshTree(true);
  renderRecent();
  updateTitle();
  refreshGit();
}

async function refreshTree(force = false) {
  if (!state.root) { $('#tree').innerHTML = ''; $('#explorer-empty').hidden = false; $('#explorer-root-name').textContent = ''; return; }
  if (force) dirCache.clear();
  const frag = document.createDocumentFragment();
  await buildTreeLevel(state.root, 0, frag);
  $('#tree').replaceChildren(frag);
  highlightActiveInTree();
}

async function buildTreeLevel(dir, depth, parent) {
  const entries = await readDirCached(dir);
  const gitMarks = gitMarkMap();
  for (const e of entries) {
    const row = document.createElement('div');
    const open = e.dir && state.expanded.has(e.path);
    const mark = gitMarks.files.get(e.path);
    const dirMark = e.dir && gitMarks.dirs.has(e.path);
    row.className = `tree-row ${mark ? 'git-' + mark : ''} ${dirMark ? 'git-dir' : ''} ${state.selected === e.path ? 'selected' : ''}`;
    row.dataset.path = e.path;
    row.dataset.dir = e.dir ? '1' : '';
    row.style.paddingLeft = 10 + depth * 14 + 'px';
    row.innerHTML = `${e.dir ? ICONS.chev.replace('class="chev"', `class="chev ${open ? 'open' : ''}"`) : '<svg class="chev none"></svg>'}
      ${e.dir ? (open ? ICONS.folderOpen : ICONS.folder) : fileIcon(e.name)}
      <span class="name">${esc(e.name)}</span>${mark ? `<span class="git-mark git-${mark}">${mark}</span>` : dirMark ? '<span class="git-mark" style="color:var(--yellow)">•</span>' : ''}`;
    if (e.name.startsWith('.')) row.style.opacity = '0.7';
    parent.appendChild(row);
    if (open) {
      const kids = document.createElement('div');
      kids.className = 'tree-children';
      kids.style.setProperty('--guide', 10 + depth * 14 + 7 + 'px');
      await buildTreeLevel(e.path, depth + 1, kids);
      parent.appendChild(kids);
    }
  }
}

function gitMarkMap() {
  const files = new Map(), dirs = new Set();
  const g = state.git;
  if (!g.repo) return { files, dirs };
  for (const f of [...g.staged, ...g.unstaged]) {
    const abs = join(g.root, f.file);
    const s = f.status === '?' ? 'U' : f.status === 'R' ? 'A' : f.status;
    if (!files.has(abs) || s === 'U') files.set(abs, s);
    let d = dirname(abs);
    while (d.length >= g.root.length && d !== '/') { dirs.add(d); d = dirname(d); }
  }
  return { files, dirs };
}

function highlightActiveInTree() {
  const tab = activeTab();
  $$('.tree-row.active-file').forEach((r) => r.classList.remove('active-file'));
  if (tab && tab.path) {
    const row = $(`.tree-row[data-path="${CSS.escape(tab.path)}"]`);
    if (row) row.classList.add('active-file');
  }
}

function selectRow(p) {
  state.selected = p;
  $$('.tree-row.selected').forEach((r) => r.classList.remove('selected'));
  const row = $(`.tree-row[data-path="${CSS.escape(p)}"]`);
  if (row) { row.classList.add('selected'); row.scrollIntoView({ block: 'nearest' }); }
}

async function toggleDir(p, open) {
  const isOpen = state.expanded.has(p);
  if (open === undefined) open = !isOpen;
  if (open) state.expanded.add(p); else state.expanded.delete(p);
  state.settings.expanded = { ...(state.settings.expanded || {}), [state.root]: [...state.expanded] };
  saveSettings();
  await refreshTree();
}

async function revealInTree(p) {
  if (!state.root || !p.startsWith(state.root)) return;
  setView('explorer');
  let d = dirname(p);
  while (d.length > state.root.length) { state.expanded.add(d); d = dirname(d); }
  await refreshTree();
  selectRow(p);
}

$('#tree').addEventListener('click', (e) => {
  const row = e.target.closest('.tree-row');
  if (!row) return;
  selectRow(row.dataset.path);
  if (row.dataset.dir) toggleDir(row.dataset.path);
  else openFile(row.dataset.path, { focus: false });
});
$('#tree').addEventListener('dblclick', (e) => {
  const row = e.target.closest('.tree-row');
  if (row && !row.dataset.dir) editor.focus();
});
$('#tree').addEventListener('keydown', async (e) => {
  const rows = $$('.tree-row');
  let i = rows.findIndex((r) => r.dataset.path === state.selected);
  const row = rows[i];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    i = Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    if (rows[i]) selectRow(rows[i].dataset.path);
  } else if (!row) {
    // nothing selected
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (row.dataset.dir) toggleDir(row.dataset.path); else openFile(row.dataset.path);
  } else if (e.key === 'ArrowRight' && row.dataset.dir) toggleDir(row.dataset.path, true);
  else if (e.key === 'ArrowLeft') {
    if (row.dataset.dir && state.expanded.has(row.dataset.path)) toggleDir(row.dataset.path, false);
    else if (dirname(row.dataset.path) !== state.root) selectRow(dirname(row.dataset.path));
  } else if (e.key === 'F2') renamePath(row.dataset.path);
  else if (e.key === 'Delete') deletePath(row.dataset.path);
});
$('#tree').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.tree-row');
  const p = row ? row.dataset.path : state.root;
  if (!p) return;
  const isDir = row ? !!row.dataset.dir : true;
  if (row) selectRow(p);
  const dir = isDir ? p : dirname(p);
  showContextMenu(e.clientX, e.clientY, [
    { label: 'New File…', run: () => createEntry(dir, false) },
    { label: 'New Folder…', run: () => createEntry(dir, true) },
    '-',
    ...(row ? [
      { label: 'Rename…', kb: 'F2', run: () => renamePath(p) },
      { label: 'Move to Trash', kb: 'Del', danger: true, run: () => deletePath(p) },
      '-',
    ] : []),
    { label: 'Copy Path', run: () => navigator.clipboard.writeText(p) },
    { label: 'Copy Relative Path', run: () => navigator.clipboard.writeText(rel(p)) },
    { label: 'Open Containing Folder', run: () => api.fs.reveal(p) },
  ]);
});

async function createEntry(dir, isDir) {
  const name = await prompt(isDir ? 'New folder name' : 'New file name (folders allowed: src/main.c)', '', `in ${rel(dir) || basename(dir)}`);
  if (!name) return;
  const p = join(dir, name.trim());
  try {
    if (isDir) await api.fs.createDir(p); else await api.fs.createFile(p);
  } catch (err) { toast('Create failed', err.message, 'error'); return; }
  let d = isDir ? p : dirname(p);
  while (d.length >= state.root.length) { state.expanded.add(d); d = dirname(d); }
  await refreshTree(true);
  selectRow(p);
  if (!isDir) openFile(p);
  refreshGit();
}
async function renamePath(p) {
  const name = await prompt('New name', basename(p));
  if (!name || name === basename(p)) return;
  const np = join(dirname(p), name);
  try { await api.fs.rename(p, np); } catch (err) { toast('Rename failed', err.message, 'error'); return; }
  for (const t of state.tabs) {
    if (t.path && (t.path === p || t.path.startsWith(p + '/'))) {
      const newPath = np + t.path.slice(p.length);
      const content = t.model.getValue();
      const dirty = isDirty(t);
      const old = t.model;
      t.model = monaco.editor.createModel(content, languageForFile(basename(newPath)), monaco.Uri.file(newPath));
      t.model.onDidChangeContent(() => { renderTabs(); if (t.id === state.active) { schedulePreview(); gutterHook(); } });
      t.savedVersion = dirty ? -1 : t.model.getAlternativeVersionId();
      t.path = newPath; t.name = basename(newPath);
      if (t.id === state.active) editor.setModel(t.model);
      old.dispose();
    }
  }
  await refreshTree(true);
  renderTabs(); renderBreadcrumbs();
  refreshGit();
}
async function deletePath(p) {
  if (!(await api.dialog.confirm(`Move '${basename(p)}' to trash?`, p))) return;
  try { await api.fs.delete(p); } catch (err) { toast('Delete failed', err.message, 'error'); return; }
  for (const t of [...state.tabs]) if (t.path && (t.path === p || t.path.startsWith(p + '/'))) await closeTab(t.id, { force: true });
  await refreshTree(true);
  refreshGit();
}

// ============================================================ search view
const searchOpts = { caseSensitive: false, word: false, regex: false };
['case', 'word', 'regex'].forEach((k) => {
  const key = { case: 'caseSensitive', word: 'word', regex: 'regex' }[k];
  $(`#search-${k}`).addEventListener('click', (e) => {
    searchOpts[key] = !searchOpts[key];
    e.currentTarget.classList.toggle('on', searchOpts[key]);
    doSearch();
  });
});
const doSearch = debounce(async () => {
  const q = $('#search-input').value;
  const out = $('#search-results');
  if (!q || !state.root) { out.innerHTML = ''; $('#search-summary').textContent = state.root ? '' : 'Open a folder to search.'; return; }
  $('#search-summary').textContent = 'Searching…';
  const res = await api.fs.search(state.root, q, searchOpts);
  if (res.error) { $('#search-summary').textContent = res.error; out.innerHTML = ''; return; }
  const total = res.reduce((n, r) => n + r.matches.length, 0);
  $('#search-summary').textContent = total ? `${total} result${total > 1 ? 's' : ''} in ${res.length} file${res.length > 1 ? 's' : ''}` : 'No results found.';
  out.innerHTML = res.map((r) => `
    <div class="sr-file" data-file="${esc(r.file)}">${fileIcon(basename(r.file))}<span>${esc(basename(r.file))}</span>
      <span class="dir">${esc(dirname(r.rel) === '.' ? '' : dirname(r.rel))}</span><span class="count">${r.matches.length}</span></div>
    ${r.matches.slice(0, 50).map((m) => {
      const start = Math.max(0, m.col - 1 - 30);
      const pre = m.text.slice(start, m.col - 1).replace(/^\s+/, ''), hit = m.text.substr(m.col - 1, m.len), post = m.text.slice(m.col - 1 + m.len);
      return `<div class="sr-match" data-file="${esc(r.file)}" data-line="${m.line}" data-col="${m.col}">${esc(pre)}<mark>${esc(hit)}</mark>${esc(post)}</div>`;
    }).join('')}`).join('');
}, 250);
$('#search-input').addEventListener('input', doSearch);
$('#search-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
$('#search-results').addEventListener('click', (e) => {
  const m = e.target.closest('.sr-match');
  if (m) {
    openFile(m.dataset.file, { line: +m.dataset.line, col: +m.dataset.col }).then(() => {
      const q = $('#search-input').value;
      const model = editor.getModel();
      if (model) {
        const found = model.findMatches(q, new monaco.Range(+m.dataset.line, 1, +m.dataset.line + 1, 1), searchOpts.regex, searchOpts.caseSensitive, searchOpts.word ? ' \t()[]{};,.' : null, false);
        if (found[0]) editor.setSelection(found[0].range);
      }
    });
    return;
  }
  const f = e.target.closest('.sr-file');
  if (f) openFile(f.dataset.file);
});

// ============================================================ git
let gitBusy = false;
const gitUi = { openSections: { staged: true, changes: true, log: false }, message: '' };

async function refreshGit() {
  const cwd = state.root;
  if (!cwd) { state.git = { repo: false }; renderGit(); updateGitStatusBar(); return; }
  let next;
  try { next = await api.git.status(cwd); } catch { next = { repo: false }; }
  if (next.repo && gitUi.openSections.log) next.log = await api.git.log(next.root);
  const changed = JSON.stringify(next) !== JSON.stringify(state.git);
  state.git = next;
  if (!changed && $('#git-content').childElementCount) return;
  if (typeof invalidateGutterBase === 'function') { invalidateGutterBase(); gutterHook(); }
  // Don't clobber the commit box while the user is typing in it.
  if (document.activeElement !== $('#commit-msg')) renderGit();
  updateGitStatusBar();
  // Refresh tree colouring without re-reading the disk.
  if (state.root) refreshTree();
}

async function gitRun(args, label, { quiet = false } = {}) {
  if (!state.git.repo && args[0] !== 'init') return null;
  const cwd = state.git.repo ? state.git.root : state.root;
  gitBusy = true;
  statusMsg(`${label}…`, true);
  const r = await api.git.run(cwd, args);
  gitBusy = false;
  statusMsg('');
  if (!r.ok) toast(`git ${args[0]} failed`, r.stderr || r.stdout, 'error');
  else if (!quiet) toast(label, (r.stdout + '\n' + r.stderr).trim().split('\n').slice(-6).join('\n'), 'success', 3000);
  await refreshGit();
  return r;
}

function updateGitStatusBar() {
  const g = state.git;
  const b = $('#sb-branch'), s = $('#sb-sync'), badge = $('#git-badge');
  if (!g.repo) { b.hidden = true; s.hidden = true; badge.hidden = true; return; }
  b.hidden = false;
  b.innerHTML = `${ICONS.branch}${esc(g.branch || '(detached)')}${g.unstaged.length || g.staged.length ? '*' : ''}`;
  s.hidden = false;
  s.innerHTML = `${ICONS.sync}${g.upstream ? `${g.behind}↓ ${g.ahead}↑` : 'Publish'}`;
  s.title = g.upstream ? `Sync with ${g.upstream}` : 'Publish branch';
  const n = g.staged.length + g.unstaged.length;
  badge.hidden = !n;
  badge.textContent = n > 99 ? '99+' : n;
}

function renderGit() {
  const host = $('#git-content');
  const g = state.git;
  // Preserve the commit message the user is typing across re-renders.
  const ta = $('#commit-msg');
  if (ta) gitUi.message = ta.value;
  if (!state.root) {
    host.innerHTML = `<div class="empty-state"><p>Open a folder to use source control, or clone a repository.</p>
      <button class="btn primary" data-cmd="file.openFolder">Open Folder</button>
      <button class="btn" data-cmd="git.clone">Clone Repository</button></div>`;
    return;
  }
  if (!g.repo) {
    host.innerHTML = `<div class="empty-state"><p>The current folder isn't a git repository.</p>
      <button class="btn primary" data-cmd="git.init">Initialize Repository</button>
      <button class="btn" data-cmd="git.clone">Clone Repository</button></div>`;
    return;
  }
  const fileRow = (f, kind) => {
    const name = basename(f.file), dir = dirname(f.file);
    const st = f.status === '?' ? 'U' : f.status;
    const acts = kind === 'staged'
      ? `<button class="icon-btn" data-act="open" title="Open File">${ICONS.open}</button><button class="icon-btn" data-act="unstage" title="Unstage">${ICONS.minus}</button>`
      : `<button class="icon-btn" data-act="open" title="Open File">${ICONS.open}</button><button class="icon-btn" data-act="discard" title="Discard Changes">${ICONS.undo}</button><button class="icon-btn" data-act="stage" title="Stage">${ICONS.plus}</button>`;
    return `<div class="git-file" data-file="${esc(f.file)}" data-kind="${kind}" data-status="${st}" title="${esc(f.file)}">
      ${fileIcon(name)}<span class="fname git-${st === 'R' ? 'A' : st}">${esc(name)}</span><span class="fdir">${dir === '.' ? '' : esc(dir)}</span>
      <span class="acts">${acts}</span><span class="st git-${st === 'R' ? 'A' : st}">${st}</span></div>`;
  };
  const section = (key, title, files, kind, acts) => `
    <div class="git-section-head ${gitUi.openSections[key] ? 'open' : ''}" data-section="${key}">
      ${ICONS.chev}<span>${title}</span><span class="count">${files.length}</span><span class="acts">${acts}</span></div>
    ${gitUi.openSections[key] ? files.map((f) => fileRow(f, kind)).join('') : ''}`;
  const canCommit = g.staged.length || g.unstaged.length;
  host.innerHTML = `
    <div class="git-branch-line">${ICONS.branch}<span>${esc(g.branch || 'detached')}</span>
      ${g.upstream ? `<span class="muted">→ ${esc(g.upstream)}</span>` : g.remotes.length ? '<span class="muted">(not published)</span>' : '<span class="muted">(no remote)</span>'}
      ${g.ahead || g.behind ? `<span style="margin-left:auto">${g.behind}↓ ${g.ahead}↑</span>` : ''}</div>
    <div class="git-commit-box">
      <textarea id="commit-msg" placeholder="Message (Ctrl+Enter to commit on '${esc(g.branch)}')" spellcheck="true">${esc(gitUi.message)}</textarea>
      <div class="git-btn-row">
        <button class="btn primary" data-cmd="git.commit" ${canCommit ? '' : 'disabled'}>${ICONS.check.replace('<svg', '<svg style="vertical-align:-3px;margin-right:4px"')}Commit</button>
        <button class="btn" data-cmd="git.commitPush" ${canCommit ? '' : 'disabled'} title="Commit and push">Commit & Push</button>
        <button class="btn icon" data-cmd="git.more" title="More actions">⋯</button>
      </div>
    </div>
    ${g.staged.length ? section('staged', 'Staged Changes', g.staged, 'staged', `<button class="icon-btn" data-act="unstage-all" title="Unstage All">${ICONS.minus}</button>`) : ''}
    ${section('changes', 'Changes', g.unstaged, 'changes', `<button class="icon-btn" data-act="discard-all" title="Discard All">${ICONS.undo}</button><button class="icon-btn" data-act="stage-all" title="Stage All">${ICONS.plus}</button>`)}
    <div class="git-section-head ${gitUi.openSections.log ? 'open' : ''}" data-section="log">${ICONS.chev}<span>History</span></div>
    ${gitUi.openSections.log ? `<div class="git-log">${(g.log || []).map((c) => `
      <div class="git-log-item" title="${esc(c.subject)}"><span class="subj">${esc(c.subject)}</span>
      <span class="meta"><code>${esc(c.hash)}</code> · ${esc(c.author)} · ${esc(c.date)}</span></div>`).join('') || '<div class="pad muted small">No commits yet.</div>'}</div>` : ''}`;
  const t = $('#commit-msg');
  t.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runCommand('git.commit'); }
  });
  t.addEventListener('input', () => { gitUi.message = t.value; });
}

$('#git-content').addEventListener('click', async (e) => {
  const g = state.git;
  const actBtn = e.target.closest('[data-act]');
  const head = e.target.closest('.git-section-head');
  if (actBtn) {
    e.stopPropagation();
    const act = actBtn.dataset.act;
    const row = actBtn.closest('.git-file');
    const file = row && row.dataset.file;
    if (act === 'stage') await gitRun(['add', '--', file], 'Stage', { quiet: true });
    else if (act === 'unstage') await gitRun(['restore', '--staged', '--', file], 'Unstage', { quiet: true });
    else if (act === 'open') openFile(join(g.root, file));
    else if (act === 'discard') {
      const untracked = row.dataset.status === 'U';
      if (!(await api.dialog.confirm(untracked ? `Delete untracked file '${file}'?` : `Discard changes in '${file}'?`, 'This cannot be undone.'))) return;
      if (untracked) await gitRun(['clean', '-f', '--', file], 'Discard', { quiet: true });
      else await gitRun(['restore', '--', file], 'Discard', { quiet: true });
      await reloadOpenFile(join(g.root, file));
    } else if (act === 'stage-all') await gitRun(['add', '-A'], 'Stage all', { quiet: true });
    else if (act === 'unstage-all') await gitRun(['reset', '-q'], 'Unstage all', { quiet: true });
    else if (act === 'discard-all') {
      if (!(await api.dialog.confirm('Discard ALL unstaged changes?', 'Tracked files are restored; untracked files are kept. This cannot be undone.'))) return;
      await gitRun(['restore', '.'], 'Discard all', { quiet: true });
      for (const t of state.tabs) if (t.path) await reloadOpenFile(t.path);
    }
    return;
  }
  if (head) {
    const key = head.dataset.section;
    gitUi.openSections[key] = !gitUi.openSections[key];
    if (key === 'log' && gitUi.openSections.log) state.git.log = await api.git.log(g.root);
    renderGit();
    return;
  }
  const row = e.target.closest('.git-file');
  if (row) openDiff(row.dataset.file, row.dataset.kind === 'staged', row.dataset.status);
});

async function reloadOpenFile(p) {
  const tab = findTab(p);
  if (!tab) return;
  try {
    const res = await api.fs.readFile(p);
    tab.model.pushEditOperations([], [{ range: tab.model.getFullModelRange(), text: res.content }], () => null);
    tab.savedVersion = tab.model.getAlternativeVersionId();
    renderTabs();
  } catch { await closeTab(tab.id, { force: true }); }
}

async function openDiff(file, staged, status) {
  const g = state.git;
  const abs = join(g.root, file);
  const label = staged ? 'Staged' : 'Working Tree';
  const existing = state.tabs.find((t) => t.diff && t.diff.file === file && t.diff.staged === staged);
  if (existing) await closeTab(existing.id, { force: true });
  const lang = languageForFile(basename(file));
  // staged: HEAD ↔ index · unstaged: index ↔ working tree
  const origText = status === 'U' || status === 'A' && staged ? '' : await api.git.show(g.root, staged ? 'HEAD' : '', file);
  const original = monaco.editor.createModel(origText, lang);
  let modified, ownsModified = true;
  if (staged) modified = monaco.editor.createModel(status === 'D' ? '' : await api.git.show(g.root, '', file), lang);
  else {
    const open = findTab(abs);
    if (open) { modified = open.model; ownsModified = false; }
    else {
      let text = '';
      if (status !== 'D') { try { text = (await api.fs.readFile(abs)).content; } catch { /* deleted */ } }
      modified = monaco.editor.createModel(text, lang);
    }
  }
  const tab = { id: tabIdSeq++, path: abs, name: basename(file), diff: { original, modified, ownsModified, file, staged, label } };
  state.tabs.push(tab);
  activateTab(tab.id);
}

async function gitCommit(andPush = false) {
  const g = state.git;
  if (!g.repo) return;
  const msg = ($('#commit-msg') ? $('#commit-msg').value : gitUi.message).trim();
  if (!msg) { toast('Commit message required', 'Write a message describing your changes.'); $('#commit-msg') && $('#commit-msg').focus(); return; }
  // Save dirty files first so what you see is what gets committed.
  for (const t of state.tabs) if (isDirty(t) && t.path) await saveTab(t);
  await refreshGit();
  if (!state.git.staged.length) {
    if (!state.git.unstaged.length) { toast('Nothing to commit'); return; }
    // VS Code-style "smart commit": nothing staged → stage everything.
    const s = await api.git.run(g.root, ['add', '-A']);
    if (!s.ok) { toast('git add failed', s.stderr, 'error'); return; }
  }
  const r = await gitRun(['commit', '-m', msg], 'Committed');
  if (r && r.ok) {
    gitUi.message = '';
    if ($('#commit-msg')) $('#commit-msg').value = '';
    if (andPush) await gitPush();
  }
}

async function gitPush() {
  const g = state.git;
  if (!g.repo) return;
  if (!g.remotes.length) {
    const url = await prompt('No remote configured. Remote URL for "origin"', '', 'e.g. git@github.com:you/project.git');
    if (!url) return;
    const r = await gitRun(['remote', 'add', 'origin', url.trim()], 'Added remote', { quiet: true });
    if (!r || !r.ok) return;
  }
  const remotes = state.git.remotes;
  if (!state.git.upstream) {
    const remote = remotes.includes('origin') ? 'origin' : remotes[0];
    return gitRun(['push', '-u', remote, state.git.branch], `Published ${state.git.branch}`);
  }
  return gitRun(['push'], 'Pushed');
}

async function gitClone() {
  const url = await prompt('Repository URL to clone', '', 'HTTPS or SSH, e.g. https://github.com/torvalds/linux.git — Enter, then pick a parent folder');
  if (!url || !url.trim()) return;
  const parent = await api.dialog.openFolder();
  if (!parent) return;
  statusMsg(`Cloning ${url.trim()}…`, true);
  toast('Cloning…', url.trim(), 'info', 2500);
  const r = await api.git.clone(url.trim(), parent);
  statusMsg('');
  if (!r.ok) { toast('Clone failed', r.stderr, 'error'); return; }
  toast('Cloned', r.dir, 'success');
  await openFolder(r.dir);
}

async function gitCheckout() {
  const g = state.git;
  if (!g.repo) return;
  const branches = await api.git.branches(g.root);
  const items = [
    { label: '+ Create new branch…', action: 'create' },
    ...branches.map((b) => ({ label: b, desc: b === g.branch ? 'current' : '', icon: ICONS.branch, branch: b })),
  ];
  showQuickPick(items, {
    placeholder: 'Select a branch to checkout',
    onAccept: async (it) => {
      if (it.action === 'create') {
        const name = await prompt('New branch name');
        if (name) await gitRun(['checkout', '-b', name.trim()], `Switched to new branch ${name.trim()}`);
      } else if (it.branch !== g.branch) {
        await gitRun(['checkout', it.branch], `Switched to ${it.branch}`);
        for (const t of state.tabs) if (t.path && !isDirty(t)) await reloadOpenFile(t.path);
      }
    },
  });
}

function gitMore() {
  const items = [
    { label: 'Pull', run: () => runCommand('git.pull') },
    { label: 'Push', run: () => runCommand('git.push') },
    { label: 'Fetch', run: () => gitRun(['fetch', '--all', '--prune'], 'Fetched') },
    { label: 'Checkout / Create Branch…', run: () => runCommand('git.checkout') },
    { label: 'Amend Last Commit', run: () => runCommand('git.amend') },
    { label: 'Undo Last Commit (soft)', run: () => runCommand('git.undoCommit') },
    { label: 'Stash Changes', run: () => gitRun(['stash', 'push', '-u'], 'Stashed') },
    { label: 'Pop Stash', run: () => gitRun(['stash', 'pop'], 'Popped stash') },
    { label: 'Add Remote…', run: () => runCommand('git.addRemote') },
  ];
  const btn = $('[data-cmd="git.more"]').getBoundingClientRect();
  showContextMenu(btn.left, btn.bottom + 4, items);
}

// ============================================================ views / layout
function setView(view) {
  if (state.view === view && !$('#sidebar').hidden) { /* keep */ }
  state.view = view;
  $('#sidebar').hidden = false; $('#sidebar-sash').hidden = false;
  $$('.act[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => (v.hidden = v.id !== `view-${view}`));
  if (view === 'search') { $('#search-input').focus(); $('#search-input').select(); }
  if (view === 'git') refreshGit();
  requestAnimationFrame(() => editor && editor.layout());
}
$$('.act[data-view]').forEach((b) => b.addEventListener('click', () => {
  if (state.view === b.dataset.view && !$('#sidebar').hidden) toggleSidebar();
  else setView(b.dataset.view);
}));
function toggleSidebar() {
  const hide = !$('#sidebar').hidden;
  $('#sidebar').hidden = hide; $('#sidebar-sash').hidden = hide;
  $$('.act[data-view]').forEach((b) => b.classList.toggle('active', !hide && b.dataset.view === state.view));
  requestAnimationFrame(() => editor.layout());
}

function makeSash(sash, onMove) {
  sash.addEventListener('mousedown', (e) => {
    e.preventDefault();
    sash.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    const move = (ev) => { onMove(ev); editor.layout(); };
    const up = () => {
      sash.classList.remove('dragging'); document.body.style.cursor = '';
      removeEventListener('mousemove', move); removeEventListener('mouseup', up);
      saveSettings();
    };
    addEventListener('mousemove', move); addEventListener('mouseup', up);
  });
}
makeSash($('#sidebar-sash'), (ev) => {
  const w = Math.max(160, Math.min(700, ev.clientX - 48));
  $('#sidebar').style.width = w + 'px';
  state.settings.sidebarWidth = w;
});
makeSash($('#preview-sash'), (ev) => {
  const r = $('#editor-area').getBoundingClientRect();
  state.settings.previewWidth = Math.max(0.15, Math.min(0.85, (r.right - ev.clientX) / r.width));
  $('#preview').style.flex = `0 0 ${state.settings.previewWidth * 100}%`;
});

function renderRecent() {
  $('#recent-list').innerHTML = state.settings.recent.slice(0, 6).map((r) => `<a data-recent="${esc(r)}" title="${esc(r)}">${esc(basename(r))}<span>${esc(dirname(r).replace(/^\/home\/[^/]+/, '~'))}</span></a>`).join('')
    || '<span class="muted">No recent folders</span>';
}
$('#recent-list').addEventListener('click', (e) => { const a = e.target.closest('[data-recent]'); if (a) openFolder(a.dataset.recent); });

function pushRecentFile(p) {
  state.settings.recentFiles = [p, ...(state.settings.recentFiles || []).filter((f) => f !== p)].slice(0, 30);
  saveSettings();
}

function setFontSize(n) {
  state.settings.fontSize = Math.max(8, Math.min(32, n));
  editor.updateOptions({ fontSize: state.settings.fontSize });
  diffEditor.updateOptions({ fontSize: state.settings.fontSize });
  saveSettings();
}

// ============================================================ command registry
function registerCommands() {
  cmd('palette.show', 'Show All Commands', () => {
    showQuickPick(Object.values(commands).filter((c) => c.id !== 'palette.show').map((c) => ({ label: c.label, kb: c.kb, id: c.id })).sort((a, b) => a.label.localeCompare(b.label)), {
      placeholder: 'Type a command', onAccept: (it) => runCommand(it.id),
    });
  }, 'Ctrl+Shift+P');
  cmd('file.quickOpen', 'Go to File…', async () => {
    const recent = (state.settings.recentFiles || []).filter((f) => !state.root || f.startsWith(state.root + '/'));
    if (!state.root) {
      showQuickPick(recent.map((f) => ({ label: basename(f), desc: dirname(f), path: f, icon: fileIcon(basename(f)) })), { placeholder: 'Recently opened files', onAccept: (it) => openFile(it.path), matchOn: 'full' });
      return;
    }
    const files = await api.fs.listAll(state.root);
    const recentSet = new Set(recent);
    const items = files.map((f) => ({ label: basename(f), desc: dirname(f) === '.' ? '' : dirname(f), path: join(state.root, f), icon: fileIcon(basename(f)) }));
    items.sort((a, b) => (recentSet.has(b.path) ? 1 : 0) - (recentSet.has(a.path) ? 1 : 0) || recent.indexOf(a.path) - recent.indexOf(b.path));
    showQuickPick(items, { placeholder: 'Search files by name (append :line to jump)', onAccept: (it) => openFile(it.path, { line: qi.pendingLine }), matchOn: 'full' });
  }, 'Ctrl+P');
  cmd('editor.cutLine', 'Cut Line (nano)', () => activeTab() && !activeTab().diff && cutLine(), 'Ctrl+K');
  cmd('editor.deleteWordLeft', 'Delete Word Left (nano)', () => editor.trigger('keyboard', 'deleteWordLeft'), 'Alt+Backspace');
  cmd('editor.gotoLine', 'Go to Line…', async () => {
    if (!activeTab() || activeTab().diff) return;
    const v = await prompt(`Go to line (1 – ${editor.getModel().getLineCount()}), optionally line:col`);
    if (!v) return;
    const [l, c] = v.split(':').map((x) => parseInt(x, 10));
    if (!l) return;
    editor.setPosition({ lineNumber: l, column: c || 1 }); editor.revealLineInCenter(l); editor.focus();
  }, 'Ctrl+G');
  cmd('file.newFile', 'New File', () => (state.root && state.view === 'explorer' && !$('#sidebar').hidden
    ? createEntry(state.selected ? ($(`.tree-row[data-path="${CSS.escape(state.selected)}"]`)?.dataset.dir ? state.selected : dirname(state.selected)) : state.root, false)
    : newUntitled()), 'Ctrl+N');
  cmd('file.newUntitled', 'New Untitled File', () => newUntitled());
  cmd('file.newFolder', 'New Folder', () => state.root && createEntry(state.selected && $(`.tree-row[data-path="${CSS.escape(state.selected)}"]`)?.dataset.dir ? state.selected : state.root, true));
  cmd('file.openFile', 'Open File…', async () => { for (const p of await api.dialog.openFile()) await openFile(p); }, 'Ctrl+O');
  cmd('file.openFolder', 'Open Folder…', async () => openFolder(await api.dialog.openFolder()), 'Ctrl+K Ctrl+O (outside the editor)');
  cmd('file.closeFolder', 'Close Folder', async () => {
    for (const t of [...state.tabs]) if (!(await closeTab(t.id))) return;
    state.root = null; state.settings.lastFolder = null; saveSettings();
    refreshTree(); refreshGit(); updateTitle();
  });
  cmd('file.save', 'Save', () => saveTab(activeTab()), 'Ctrl+S');
  cmd('file.saveAs', 'Save As…', () => saveTab(activeTab(), true), 'Ctrl+Shift+S');
  cmd('file.saveAll', 'Save All', async () => { for (const t of state.tabs) if (isDirty(t)) await saveTab(t); }, 'Ctrl+Alt+S');
  cmd('tabs.close', 'Close Editor', () => activeTab() && closeTab(state.active), 'Ctrl+W');
  cmd('tabs.closeAll', 'Close All Editors', async () => { for (const t of [...state.tabs]) if (!(await closeTab(t.id))) break; });
  cmd('tabs.next', 'Next Editor', () => cycleTab(1), 'Ctrl+Tab');
  cmd('tabs.prev', 'Previous Editor', () => cycleTab(-1), 'Ctrl+Shift+Tab');
  cmd('view.explorer', 'Show Explorer', () => setView('explorer'), 'Ctrl+Shift+E');
  cmd('view.search', 'Search in Files', () => setView('search'), 'Ctrl+Shift+F');
  cmd('view.git', 'Show Source Control', () => setView('git'), 'Ctrl+Shift+G');
  cmd('view.toggleSidebar', 'Toggle Sidebar', toggleSidebar, 'Ctrl+B');
  cmd('explorer.refresh', 'Refresh Explorer', () => refreshTree(true));
  cmd('explorer.collapse', 'Collapse Folders in Explorer', () => { state.expanded.clear(); refreshTree(); });
  cmd('explorer.reveal', 'Reveal Active File in Explorer', () => activeTab()?.path && revealInTree(activeTab().path));
  cmd('markdown.preview', 'Markdown: Toggle Preview to the Side', () => {
    const tab = activeTab();
    if (!tab || tab.diff || tab.model.getLanguageId() !== 'markdown') { toast('Not a markdown file', 'Open a .md file to preview it.'); return; }
    previewMode = previewMode === 'split' ? 'off' : 'split';
    updatePreviewVisibility();
  }, 'Ctrl+Shift+V');
  cmd('markdown.readingView', 'Markdown: Toggle Reading View', () => {
    const tab = activeTab();
    if (!tab || tab.diff || tab.model.getLanguageId() !== 'markdown') return;
    previewMode = previewMode === 'full' ? 'off' : 'full';
    updatePreviewVisibility();
  }, 'Ctrl+E');
  cmd('editor.toggleWrap', 'Toggle Word Wrap', () => {
    state.settings.wordWrap = state.settings.wordWrap === 'on' ? 'off' : 'on';
    editor.updateOptions({ wordWrap: state.settings.wordWrap }); saveSettings();
  }, 'Alt+Z');
  cmd('editor.toggleMinimap', 'Toggle Minimap', () => {
    state.settings.minimap = !state.settings.minimap;
    editor.updateOptions({ minimap: { enabled: state.settings.minimap } }); saveSettings();
  });
  cmd('editor.toggleWhitespace', 'Toggle Render Whitespace', () => {
    state.settings.renderWhitespace = state.settings.renderWhitespace === 'all' ? 'selection' : 'all';
    editor.updateOptions({ renderWhitespace: state.settings.renderWhitespace }); saveSettings();
  });
  cmd('editor.toggleIndent', 'Change Indentation…', () => {
    const tab = activeTab(); if (!tab || tab.diff) return;
    const items = [2, 4, 8].flatMap((n) => [{ label: `Indent Using Spaces: ${n}`, s: true, n }, { label: `Indent Using Tabs: ${n}`, s: false, n }]);
    items.push({ label: 'Convert Indentation to Spaces', conv: 'spaces' }, { label: 'Convert Indentation to Tabs', conv: 'tabs' });
    showQuickPick(items, {
      placeholder: 'Select indentation',
      onAccept: (it) => {
        if (it.conv) { editor.getAction(it.conv === 'spaces' ? 'editor.action.indentationToSpaces' : 'editor.action.indentationToTabs').run(); }
        else tab.model.updateOptions({ insertSpaces: it.s, tabSize: it.n });
        updateStatusBar();
      },
    });
  });
  cmd('editor.changeLanguage', 'Change Language Mode…', () => {
    const tab = activeTab(); if (!tab || tab.diff) return;
    const items = monaco.languages.getLanguages().map((l) => ({ label: (l.aliases && l.aliases[0]) || l.id, desc: l.id, id: l.id }));
    showQuickPick(items, {
      placeholder: 'Select language mode',
      onAccept: (it) => { monaco.editor.setModelLanguage(tab.model, it.id); applyLanguageDefaults(tab.model); updateStatusBar(); updatePreviewVisibility(); },
    });
  });
  cmd('editor.format', 'Format Document', () => editor.getAction('editor.action.formatDocument')?.run(), 'Ctrl+Shift+I');
  cmd('settings.fontUp', 'Zoom In (Editor Font)', () => setFontSize(state.settings.fontSize + 1), 'Ctrl+=');
  cmd('settings.fontDown', 'Zoom Out (Editor Font)', () => setFontSize(state.settings.fontSize - 1), 'Ctrl+-');
  cmd('settings.fontReset', 'Reset Zoom', () => setFontSize(14), 'Ctrl+0');
  cmd('settings.trim', 'Toggle Trim Trailing Whitespace on Save', () => {
    state.settings.trimTrailingWhitespace = state.settings.trimTrailingWhitespace === false;
    saveSettings();
    toast(`Trim trailing whitespace on save: ${state.settings.trimTrailingWhitespace ? 'on' : 'off'}`);
  });
  cmd('settings.autoPreview', 'Markdown: Toggle Auto-Open Preview', () => {
    state.settings.autoPreview = !state.settings.autoPreview; saveSettings();
    toast(`Auto-open markdown preview: ${state.settings.autoPreview ? 'on' : 'off'}`);
  });
  // git
  cmd('git.refresh', 'Git: Refresh', refreshGit);
  cmd('git.init', 'Git: Initialize Repository', async () => {
    if (!state.root) return toast('Open a folder first');
    const r = await api.git.run(state.root, ['init']);
    if (!r.ok) return toast('git init failed', r.stderr, 'error');
    toast('Initialized repository', state.root, 'success');
    refreshGit();
  });
  cmd('git.clone', 'Git: Clone…', gitClone);
  cmd('git.commit', 'Git: Commit', () => gitCommit(false));
  cmd('git.commitPush', 'Git: Commit & Push', () => gitCommit(true));
  cmd('git.push', 'Git: Push', gitPush);
  cmd('git.pull', 'Git: Pull', async () => {
    await gitRun(['pull', '--ff-only'], 'Pulled');
    for (const t of state.tabs) if (t.path && !isDirty(t)) await reloadOpenFile(t.path);
  });
  cmd('git.sync', 'Git: Sync (pull then push)', async () => {
    if (!state.git.repo) return;
    if (!state.git.upstream) return gitPush();
    const r = await gitRun(['pull', '--ff-only'], 'Pulled', { quiet: true });
    if (r && r.ok) await gitRun(['push'], 'Synced');
    for (const t of state.tabs) if (t.path && !isDirty(t)) await reloadOpenFile(t.path);
  });
  cmd('git.checkout', 'Git: Checkout to…', gitCheckout);
  cmd('git.more', 'Git: More Actions…', gitMore);
  cmd('git.amend', 'Git: Amend Last Commit', async () => {
    const msg = ($('#commit-msg')?.value || '').trim();
    for (const t of state.tabs) if (isDirty(t) && t.path) await saveTab(t);
    await gitRun(msg ? ['commit', '--amend', '-m', msg] : ['commit', '--amend', '--no-edit'], 'Amended');
  });
  cmd('git.undoCommit', 'Git: Undo Last Commit', async () => {
    if (!(await api.dialog.confirm('Undo the last commit?', 'Changes are kept and staged (git reset --soft HEAD~1).'))) return;
    await gitRun(['reset', '--soft', 'HEAD~1'], 'Undid last commit');
  });
  cmd('git.addRemote', 'Git: Add Remote…', async () => {
    const name = await prompt('Remote name', 'origin');
    if (!name) return;
    const url = await prompt(`URL for remote "${name}"`);
    if (url) await gitRun(['remote', 'add', name.trim(), url.trim()], `Added remote ${name}`);
  });
  cmd('git.log', 'Git: Show History', async () => { setView('git'); gitUi.openSections.log = true; await refreshGit(); });
  cmd('git.diffActive', 'Git: Open Changes for Active File', () => {
    const tab = activeTab();
    if (!tab || !tab.path || !state.git.repo) return;
    const r = tab.path.slice(state.git.root.length + 1);
    const f = state.git.unstaged.find((x) => x.file === r) || state.git.staged.find((x) => x.file === r);
    if (!f) return toast('No changes', r);
    openDiff(r, !state.git.unstaged.includes(f), f.status === '?' ? 'U' : f.status);
  });
}

// nano-style cut: Ctrl+K removes the current line (or every line the selection touches).
// Repeated Ctrl+K without other edits in between builds up one block, like nano's cutbuffer;
// the block goes to the clipboard, so Ctrl+V pastes it back.
let cutBuffer = { text: '', uri: null, version: -1, pos: null };
function cutLine() {
  const model = editor.getModel();
  if (!model) return;
  const sel = editor.getSelection();
  let first = sel.startLineNumber, last = sel.endLineNumber;
  if (!sel.isEmpty() && sel.endColumn === 1 && last > first) last--; // selection ending at column 1 doesn't include that line
  const lineCount = model.getLineCount();
  const range = last < lineCount
    ? new monaco.Range(first, 1, last + 1, 1)
    : first > 1
      ? new monaco.Range(first - 1, model.getLineMaxColumn(first - 1), last, model.getLineMaxColumn(last))
      : new monaco.Range(first, 1, last, model.getLineMaxColumn(last));
  let text = model.getValueInRange(range);
  if (last >= lineCount && first > 1) text = text.slice(model.getEOL().length) + model.getEOL(); // last line: keep it line-shaped
  const continuing = cutBuffer.uri === model.uri.toString() && cutBuffer.version === model.getAlternativeVersionId()
    && cutBuffer.pos && editor.getPosition().equals(cutBuffer.pos);
  cutBuffer.text = continuing ? cutBuffer.text + text : text;
  editor.pushUndoStop();
  editor.executeEdits('cnano.cutLine', [{ range, text: '' }]);
  editor.pushUndoStop();
  const line = Math.min(first, model.getLineCount());
  editor.setPosition({ lineNumber: line, column: Math.min(model.getLineFirstNonWhitespaceColumn(line) || 1, model.getLineMaxColumn(line)) });
  cutBuffer.uri = model.uri.toString();
  cutBuffer.version = model.getAlternativeVersionId();
  cutBuffer.pos = editor.getPosition();
  navigator.clipboard.writeText(cutBuffer.text).catch(() => {});
}

function cycleTab(d) {
  if (!state.tabs.length) return;
  const i = state.tabs.findIndex((t) => t.id === state.active);
  activateTab(state.tabs[(i + d + state.tabs.length) % state.tabs.length].id);
}

// Global keybindings — captured before Monaco so they work everywhere.
let chordK = false;
function onKey(e) {
  // Super/Win is its own modifier on Linux; it only stands in for Ctrl on macOS (Cmd).
  const isMac = navigator.platform.startsWith('Mac');
  const ctrl = e.ctrlKey || (isMac && e.metaKey);
  const meta = e.metaKey && !isMac;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const combo = `${meta ? 'Meta+' : ''}${ctrl ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${e.shiftKey ? 'Shift+' : ''}${k}`;
  if (chordK) {
    chordK = false;
    if (combo === 'Ctrl+o') { e.preventDefault(); e.stopPropagation(); return runCommand('file.openFolder'); }
  }
  const map = {
    'Ctrl+Shift+p': 'palette.show', F1: 'palette.show', 'Ctrl+p': 'file.quickOpen', 'Ctrl+g': 'editor.gotoLine',
    'Ctrl+n': 'file.newUntitled', 'Ctrl+o': 'file.openFile', 'Ctrl+s': 'file.save', 'Ctrl+Shift+s': 'file.saveAs', 'Ctrl+Alt+s': 'file.saveAll',
    'Ctrl+w': 'tabs.close', 'Ctrl+Tab': 'tabs.next', 'Ctrl+Shift+Tab': 'tabs.prev', 'Ctrl+PageDown': 'tabs.next', 'Ctrl+PageUp': 'tabs.prev',
    'Ctrl+Shift+e': 'view.explorer', 'Ctrl+Shift+f': 'view.search', 'Ctrl+Shift+g': 'view.git', 'Ctrl+b': 'view.toggleSidebar',
    'Ctrl+Shift+v': 'markdown.preview', 'Ctrl+e': 'markdown.readingView', 'Alt+z': 'editor.toggleWrap',
    'Ctrl+=': 'settings.fontUp', 'Ctrl++': 'settings.fontUp', 'Ctrl+Shift++': 'settings.fontUp', 'Ctrl+-': 'settings.fontDown', 'Ctrl+0': 'settings.fontReset',
  };
  Object.assign(map, extraKeys);
  // Inside the terminal, plain Ctrl+letter belongs to the shell (Ctrl+W, Ctrl+P, Ctrl+B…).
  const inTerminal = document.activeElement && document.activeElement.closest && document.activeElement.closest('#panel');
  if (inTerminal && !(e.shiftKey && ctrl) && !/^Ctrl\+(`|Tab|PageUp|PageDown)$/.test(combo) && combo !== 'F1' && combo !== 'Meta+c') return;
  if (inTerminal && combo === 'Ctrl+Shift+v') return;
  // nano keys while typing in the editor: Ctrl+K cuts the line, Alt+Backspace deletes the word to the left.
  const inEditor = editor && editor.hasTextFocus() && activeTab() && !activeTab().diff;
  if (inEditor && combo === 'Ctrl+k') { e.preventDefault(); e.stopPropagation(); return runCommand('editor.cutLine'); }
  if (inEditor && combo === 'Alt+Backspace') { e.preventDefault(); e.stopPropagation(); return editor.trigger('keyboard', 'deleteWordLeft'); }
  if (combo === 'Ctrl+k') { chordK = true; e.preventDefault(); e.stopPropagation(); return; }
  if (e.key === 'Escape' && !$('#ctxmenu').hidden) { $('#ctxmenu').hidden = true; return; }
  const id = map[combo];
  if (!id) return;
  // Let the commit box keep Ctrl+Enter etc; but global commands win elsewhere.
  if (!$('#quickinput').hidden && id !== 'palette.show' && id !== 'file.quickOpen') return;
  e.preventDefault(); e.stopPropagation();
  if (!$('#quickinput').hidden) closeQuickInput();
  runCommand(id);
}
window.addEventListener('keydown', onKey, true);

// Quick open ":line" suffix support.
$('#qi-input').addEventListener('input', () => {
  const m = $('#qi-input').value.match(/:(\d+)$/);
  qi.pendingLine = m ? +m[1] : undefined;
  if (m && qi.mode === 'pick') {
    const saved = $('#qi-input').value;
    $('#qi-input').value = saved.replace(/:\d+$/, '');
    filterQuickPick();
    $('#qi-input').value = saved;
  }
});

// ============================================================ window chrome
$('#wc-min').onclick = () => api.win.minimize();
$('#wc-max').onclick = () => api.win.maximize();
$('#wc-close').onclick = () => attemptClose();
$('#titlebar').addEventListener('dblclick', (e) => { if (!e.target.closest('button')) api.win.maximize(); });

let allowClose = false;
async function attemptClose() {
  for (const t of state.tabs.filter(isDirty)) {
    activateTab(t.id);
    const c = await api.dialog.unsaved(t.name);
    if (c === 'cancel') return;
    if (c === 'save' && !(await saveTab(t))) return;
  }
  allowClose = true;
  api.win.close();
}
window.addEventListener('beforeunload', (e) => {
  if (!allowClose && state.tabs.some(isDirty)) { e.returnValue = false; setTimeout(attemptClose); }
});

// Refresh git + tree when the window regains focus (files may have changed externally).
window.addEventListener('focus', debounce(async () => {
  if (!state.root) return;
  dirCache.clear();
  await refreshGit();
  for (const t of state.tabs) if (t.path && !t.diff && !isDirty(t)) {
    try {
      const res = await api.fs.readFile(t.path);
      if (res.content !== t.model.getValue()) await reloadOpenFile(t.path);
    } catch { /* file gone; keep buffer */ }
  }
}, 200));

// ============================================================ boot
async function boot() {
  Object.assign(state.settings, await api.settings.load());
  $('#sidebar').style.width = state.settings.sidebarWidth + 'px';
  renderRecent();

  require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });
  await new Promise((resolve) => require(['vs/editor/editor.main'], resolve));

  registerCnanoLanguages(monaco);
  defineCnanoTheme(monaco);

  const common = {
    theme: 'cnano-night',
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'DejaVu Sans Mono', monospace",
    fontLigatures: true,
    fontSize: state.settings.fontSize,
    lineHeight: 1.6,
    automaticLayout: true,
    smoothScrolling: true,
    scrollBeyondLastLine: false,
    padding: { top: 10 },
    // Monaco's shadow-DOM context menu sits outside the editor and loses the theme colours.
    useShadowDOM: false,
  };
  editor = monaco.editor.create($('#editor-host'), {
    ...common,
    model: null,
    minimap: { enabled: state.settings.minimap, renderCharacters: false, scale: 1, maxColumn: 100 },
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    cursorWidth: 2,
    renderWhitespace: state.settings.renderWhitespace || 'selection',
    rulers: [80, 120],
    wordWrap: state.settings.wordWrap,
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: 'active', indentation: true },
    stickyScroll: { enabled: true },
    renderLineHighlight: 'all',
    lineDecorationsWidth: 14,
    fixedOverflowWidgets: true,
    mouseWheelZoom: true,
    linkedEditing: true,
    'semanticHighlighting.enabled': false,
  });
  diffEditor = monaco.editor.createDiffEditor($('#diff-host'), {
    ...common,
    renderSideBySide: true,
    readOnly: false,
    originalEditable: false,
    ignoreTrimWhitespace: false,
    renderOverviewRuler: false,
  });
  editor.onDidChangeCursorPosition(updateStatusBar);
  editor.onDidChangeCursorSelection(updateStatusBar);
  editor.onDidChangeModelLanguage(() => { updateStatusBar(); updatePreviewVisibility(); });
  editor.onDidChangeModelOptions(updateStatusBar);
  // Editor-pane scroll drives the preview scroll proportionally.
  editor.onDidScrollChange((e) => {
    const pv = $('#preview');
    if (pv.hidden || previewMode !== 'split' || !e.scrollTopChanged) return;
    const max = editor.getScrollHeight() - editor.getLayoutInfo().height;
    pv.scrollTop = (e.scrollTop / Math.max(1, max)) * (pv.scrollHeight - pv.clientHeight);
  });

  registerCommands();
  for (const fn of afterBoot) await fn();
  const argPath = await api.argv();
  if (argPath && (await api.fs.exists(argPath))) {
    const entries = await api.fs.readDir(argPath).catch(() => null);
    if (entries) await openFolder(argPath);
    else { if (state.settings.lastFolder && argPath.startsWith(state.settings.lastFolder)) await openFolder(state.settings.lastFolder); await openFile(argPath); }
  } else if (state.settings.lastFolder && (await api.fs.exists(state.settings.lastFolder))) {
    await openFolder(state.settings.lastFolder);
  } else {
    refreshTree(); renderGit();
  }
  activateTab(state.active);
  // Light polling keeps the git badge honest while you work.
  setInterval(() => { if (document.hasFocus() && !gitBusy && state.root) refreshGit(); }, 5000);
}

boot().catch((err) => { console.error(err); toast('cnano failed to start', err.stack || String(err), 'error', 0); });
