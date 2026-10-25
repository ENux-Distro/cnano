/* global api, state, $, $$, esc, basename, rel, editor, monaco, marked, DOMPurify, cmd, extraKeys, afterBoot, saveSettings, activeTab,
   toast, findTab, isDirty, reloadOpenFile, refreshTree, refreshGit, openFile, join */
'use strict';
// AI agent side panel: chat UI, tool cards with approvals, provider/model selection, API keys.

const PROVIDERS = {
  'claude-cli': { label: 'Claude Code (Pro plan)', defaultModel: 'default', needsKey: false },
  anthropic: { label: 'Anthropic API', defaultModel: 'claude-sonnet-5-5', needsKey: true, keyHint: 'sk-ant-…' },
  openai: { label: 'OpenAI', defaultModel: 'gpt-5', needsKey: true, keyHint: 'sk-…' },
  gemini: { label: 'Google Gemini', defaultModel: 'gemini-2.5-pro', needsKey: true, keyHint: 'AIza…' },
  openrouter: { label: 'OpenRouter', defaultModel: 'anthropic/claude-sonnet-4.5', needsKey: true, keyHint: 'sk-or-…' },
  nvidia: { label: 'NVIDIA Build', defaultModel: 'meta/llama-3.3-70b-instruct', needsKey: true, keyHint: 'nvapi-…' },
};

const agent = {
  chatId: `chat_${Date.now()}`,
  runId: null,
  turnEl: null,      // current assistant turn container
  textEl: null,      // current streaming markdown block
  textBuf: '',
  cards: new Map(),  // tool id -> card element
  keys: new Set(),
  includeContext: true,
};
let runSeq = 1;

// ------------------------------------------------------------ layout
function agentVisible() { return !$('#agentbar').hidden; }
function showAgent(show) {
  $('#agentbar').hidden = !show;
  $('#agent-sash').hidden = !show;
  $('#act-agent').classList.toggle('active', show);
  state.settings.agentOpen = show;
  saveSettings();
  $('#agentbar').style.width = (state.settings.agentWidth || 400) + 'px';
  requestAnimationFrame(() => editor && editor.layout());
  if (show) { updateContextChip(); $('#agent-input').focus(); }
}
$('#agent-sash').addEventListener('mousedown', (e) => {
  e.preventDefault();
  const sash = $('#agent-sash');
  sash.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  const move = (ev) => {
    const w = Math.max(280, Math.min(900, innerWidth - ev.clientX));
    $('#agentbar').style.width = w + 'px';
    state.settings.agentWidth = w;
    editor.layout();
  };
  const up = () => {
    sash.classList.remove('dragging'); document.body.style.cursor = '';
    removeEventListener('mousemove', move); removeEventListener('mouseup', up);
    saveSettings();
  };
  addEventListener('mousemove', move); addEventListener('mouseup', up);
});

// ------------------------------------------------------------ provider & model
function currentProvider() { return $('#agent-provider').value; }
function modelFor(p) { return (state.settings.agentModels || {})[p] || PROVIDERS[p].defaultModel; }

function syncProviderUi() {
  const p = currentProvider();
  $('#agent-model').value = modelFor(p);
  const cached = (state.settings.agentModelLists || {})[p] || (p === 'claude-cli' ? ['default', 'opus', 'sonnet', 'haiku'] : []);
  $('#agent-models').innerHTML = cached.map((m) => `<option value="${esc(m)}">`).join('');
  renderEmptyState();
}
$('#agent-provider').addEventListener('change', () => {
  state.settings.agentProvider = currentProvider();
  saveSettings();
  syncProviderUi();
});
$('#agent-model').addEventListener('change', () => {
  state.settings.agentModels = { ...(state.settings.agentModels || {}), [currentProvider()]: $('#agent-model').value.trim() };
  saveSettings();
});
$('#agent-refresh-models').addEventListener('click', async () => {
  const p = currentProvider();
  const btn = $('#agent-refresh-models');
  btn.querySelector('svg').classList.add('spin');
  try {
    const list = await api.agent.models(p);
    state.settings.agentModelLists = { ...(state.settings.agentModelLists || {}), [p]: list };
    saveSettings();
    $('#agent-models').innerHTML = list.map((m) => `<option value="${esc(m)}">`).join('');
    toast(`${list.length} models available`, 'Click the model box to pick one, or type an id.', 'success', 2500);
    $('#agent-model').focus();
  } catch (err) {
    toast('Could not fetch models', err.message, 'error');
  } finally {
    btn.querySelector('svg').classList.remove('spin');
  }
});

// ------------------------------------------------------------ settings drawer (keys etc.)
async function renderSettings() {
  const info = await api.agent.keys();
  agent.keys = new Set(info.providers);
  const s = state.settings;
  const auto = s.agentAutoApprove || {};
  $('#agent-settings').innerHTML = `
    <div class="as-section">
      <div class="as-title">API keys</div>
      <div class="as-note">${info.encrypted ? 'Stored encrypted with your system keyring.' : '⚠ No system keyring found — keys are stored in plain text in cnano\'s config folder.'}</div>
      ${Object.entries(PROVIDERS).filter(([, v]) => v.needsKey).map(([id, v]) => `
        <label class="as-key">
          <span>${esc(v.label)} ${agent.keys.has(id) ? '<span class="as-ok">● saved</span>' : ''}</span>
          <div class="as-row">
            <input type="password" data-key="${id}" placeholder="${agent.keys.has(id) ? '••••••••  (leave empty to keep)' : esc(v.keyHint)}" spellcheck="false">
            <button class="btn" data-save-key="${id}">Save</button>
            ${agent.keys.has(id) ? `<button class="btn" data-clear-key="${id}" title="Remove key">✕</button>` : ''}
          </div>
        </label>`).join('')}
    </div>
    <div class="as-section">
      <div class="as-title">Auto-approve (API providers)</div>
      <label class="as-check"><input type="checkbox" data-auto="edits" ${auto.edits ? 'checked' : ''}> File edits & writes</label>
      <label class="as-check"><input type="checkbox" data-auto="commands" ${auto.commands ? 'checked' : ''}> Shell commands</label>
    </div>
    <div class="as-section">
      <div class="as-title">Claude Code permissions</div>
      <select id="as-claude-mode">
        ${[['acceptEdits', 'Accept edits (asks nothing, edits allowed, other tools need allow-rules)'], ['bypassPermissions', 'Bypass all permissions (full auto, runs commands)'], ['default', 'Default (anything that needs approval is denied)'], ['plan', 'Plan mode (read-only)']]
          .map(([v, l]) => `<option value="${v}" ${(s.claudePermissionMode || 'acceptEdits') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
      </select>
      <div class="as-note">Uses the <code>claude</code> CLI with your logged-in Pro/Max plan. Sessions resume across messages in the same chat.</div>
    </div>
    <div class="as-actions"><button class="btn primary" data-cmd="agent.settings">Done</button></div>`;
}
$('#agent-settings').addEventListener('click', async (e) => {
  const save = e.target.closest('[data-save-key]');
  const clear = e.target.closest('[data-clear-key]');
  if (save) {
    const id = save.dataset.saveKey;
    const v = $(`[data-key="${id}"]`).value.trim();
    if (!v) return;
    await api.agent.setKey(id, v);
    toast(`${PROVIDERS[id].label} key saved`, '', 'success', 2000);
    renderSettings();
    renderEmptyState();
  } else if (clear) {
    await api.agent.setKey(clear.dataset.clearKey, null);
    renderSettings();
  }
});
$('#agent-settings').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.dataset.key) $(`[data-save-key="${e.target.dataset.key}"]`).click();
});
$('#agent-settings').addEventListener('change', (e) => {
  if (e.target.dataset.auto) {
    state.settings.agentAutoApprove = { ...(state.settings.agentAutoApprove || {}), [e.target.dataset.auto]: e.target.checked };
    saveSettings();
  } else if (e.target.id === 'as-claude-mode') {
    state.settings.claudePermissionMode = e.target.value;
    saveSettings();
  }
});

// ------------------------------------------------------------ context chip
function selectionContext() {
  const tab = activeTab();
  if (!tab || tab.diff || !tab.path) return null;
  const sel = editor.getSelection();
  const ctx = { path: tab.path, name: tab.name, lang: tab.model.getLanguageId() };
  if (sel && !sel.isEmpty()) {
    ctx.startLine = sel.startLineNumber;
    ctx.endLine = sel.endLineNumber;
    ctx.text = tab.model.getValueInRange(sel);
  } else {
    ctx.line = editor.getPosition()?.lineNumber;
  }
  return ctx;
}
function updateContextChip() {
  if (!agentVisible()) return;
  const ctx = selectionContext();
  const el = $('#agent-context');
  if (!ctx) { el.innerHTML = ''; return; }
  const range = ctx.text ? `:${ctx.startLine}${ctx.endLine !== ctx.startLine ? '-' + ctx.endLine : ''}` : '';
  el.innerHTML = `<span class="ctx-chip ${agent.includeContext ? '' : 'off'}" title="${agent.includeContext ? 'Included — click to exclude' : 'Excluded — click to include'}">
    <svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>${esc(ctx.name)}${range}</span>`;
}
$('#agent-context').addEventListener('click', () => { agent.includeContext = !agent.includeContext; updateContextChip(); });

function buildPrompt(text) {
  const ctx = agent.includeContext ? selectionContext() : null;
  if (!ctx) return text;
  let block = `\n\n<editor_context>\nActive file: ${rel(ctx.path)}`;
  if (ctx.text) block += `\nSelected lines ${ctx.startLine}-${ctx.endLine}:\n\`\`\`${ctx.lang}\n${ctx.text}\n\`\`\``;
  else if (ctx.line) block += ` (cursor on line ${ctx.line})`;
  return text + block + '\n</editor_context>';
}

// ------------------------------------------------------------ rendering
const msgs = () => $('#agent-messages');
const nearBottom = () => { const m = msgs(); return m.scrollHeight - m.scrollTop - m.clientHeight < 80; };
const scrollDown = (force) => { if (force || nearBottom()) msgs().scrollTop = msgs().scrollHeight; };

function renderEmptyState() {
  if (msgs().querySelector('.ag-msg')) return;
  const p = currentProvider();
  const needsKey = PROVIDERS[p].needsKey && !agent.keys.has(p);
  msgs().innerHTML = `<div class="ag-empty">
    <div class="ag-spark">✦</div>
    <h3>What are we building?</h3>
    <p>The agent can read, search and edit files in <b>${esc(state.root ? basename(state.root) : 'your workspace')}</b> and run commands like <code>make</code>.</p>
    ${needsKey ? `<p class="ag-warn">No API key for ${esc(PROVIDERS[p].label)} yet. <a data-cmd="agent.settings">Add one</a></p>` : ''}
    <div class="ag-suggest">
      <button data-suggest="Explain what the active file does, briefly.">Explain this file</button>
      <button data-suggest="Find bugs, undefined behaviour and memory-safety issues in the active file.">Find bugs / UB</button>
      <button data-suggest="Write a Makefile for this project with debug and release targets.">Write a Makefile</button>
      <button data-suggest="Build the project and fix any compiler warnings (-Wall -Wextra).">Fix warnings</button>
    </div></div>`;
}
msgs().addEventListener('click', (e) => {
  const s = e.target.closest('[data-suggest]');
  if (s) { $('#agent-input').value = s.dataset.suggest; send(); return; }
  const head = e.target.closest('.tool-head');
  if (head) { head.parentElement.classList.toggle('open'); return; }
  const fileLink = e.target.closest('[data-open]');
  if (fileLink) openFile(fileLink.dataset.open);
});

function addUserMessage(text) {
  msgs().querySelector('.ag-empty')?.remove();
  const el = document.createElement('div');
  el.className = 'ag-msg ag-user';
  el.textContent = text;
  msgs().appendChild(el);
  scrollDown(true);
}

function ensureTurn() {
  if (!agent.turnEl) {
    agent.turnEl = document.createElement('div');
    agent.turnEl.className = 'ag-msg ag-assistant';
    msgs().appendChild(agent.turnEl);
  }
  return agent.turnEl;
}

function renderMarkdown(el, text, colorize) {
  el.innerHTML = DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: false }));
  $$('a[href^="http"]', el).forEach((a) => a.setAttribute('target', '_blank'));
  if (!colorize) return;
  const aliases = { sh: 'shell', bash: 'shell', zsh: 'shell', 'c++': 'cpp', cc: 'cpp', rs: 'rust', py: 'python', nasm: 'asm', s: 'asm', make: 'makefile', js: 'javascript' };
  $$('pre code', el).forEach(async (code) => {
    const cls = [...code.classList].find((c) => c.startsWith('language-'));
    const lang = cls && (aliases[cls.slice(9)] || cls.slice(9));
    const pre = code.parentElement;
    const btn = document.createElement('button');
    btn.className = 'code-copy'; btn.textContent = 'Copy';
    const raw = code.textContent;
    btn.onclick = () => { navigator.clipboard.writeText(raw); btn.textContent = 'Copied'; setTimeout(() => (btn.textContent = 'Copy'), 1200); };
    pre.appendChild(btn);
    if (lang && monaco.languages.getLanguages().some((l) => l.id === lang)) {
      try { code.innerHTML = await monaco.editor.colorize(raw.replace(/\n$/, ''), lang, { tabSize: 4 }); } catch { /* plain */ }
    }
  });
}

let textRaf = 0;
function appendText(t) {
  if (!agent.textEl) {
    agent.textEl = document.createElement('div');
    agent.textEl.className = 'ag-text markdown-body';
    ensureTurn().appendChild(agent.textEl);
    agent.textBuf = '';
  }
  agent.textBuf += t;
  if (!textRaf) {
    textRaf = requestAnimationFrame(() => {
      textRaf = 0;
      if (agent.textEl) { renderMarkdown(agent.textEl, agent.textBuf, false); scrollDown(); }
    });
  }
}
function finishText() {
  if (agent.textEl) {
    cancelAnimationFrame(textRaf); textRaf = 0;
    if (agent.textBuf.trim()) renderMarkdown(agent.textEl, agent.textBuf, true);
    else agent.textEl.remove();
  }
  agent.textEl = null; agent.textBuf = '';
}

const TOOL_META = {
  list_files: ['📁', (a) => `List ${a.path || '.'}`], read_file: ['📄', (a) => `Read ${a.path}`],
  search: ['🔍', (a) => `Search /${a.pattern}/`], edit_file: ['✏️', (a) => `Edit ${a.path}`],
  write_file: ['📝', (a) => `Write ${a.path}`], run_command: ['›_', (a) => a.command],
  // Claude Code's tool names
  Read: ['📄', (a) => `Read ${relish(a.file_path)}`], Edit: ['✏️', (a) => `Edit ${relish(a.file_path)}`], MultiEdit: ['✏️', (a) => `Edit ${relish(a.file_path)}`],
  Write: ['📝', (a) => `Write ${relish(a.file_path)}`], Bash: ['›_', (a) => a.command], Grep: ['🔍', (a) => `Search /${a.pattern}/`],
  Glob: ['📁', (a) => `Find ${a.pattern}`], LS: ['📁', (a) => `List ${relish(a.path)}`], WebFetch: ['🌐', (a) => a.url], WebSearch: ['🌐', (a) => a.query],
  TodoWrite: ['☑', () => 'Update plan'], Task: ['🤖', (a) => a.description || 'Sub-agent'],
};
function relish(p) { return p ? rel(p) : ''; }

function addToolCard(ev) {
  finishText();
  const [icon, summarize] = TOOL_META[ev.name] || ['⚙', () => ev.name];
  let summary = '';
  try { summary = summarize(ev.args || {}); } catch { summary = ev.name; }
  const card = document.createElement('div');
  card.className = 'tool-card running';
  const filePath = ev.args && (ev.args.file_path || (ev.args.path && state.root ? join(state.root, ev.args.path) : null));
  card.innerHTML = `
    <div class="tool-head"><span class="tool-icon">${esc(icon)}</span><span class="tool-sum">${esc(summary)}</span>
      ${filePath && !/^(list_files|LS)$/.test(ev.name) ? `<a class="tool-open" data-open="${esc(filePath)}" title="Open file">↗</a>` : ''}
      <span class="tool-status"></span></div>
    <div class="tool-body">${ev.name === 'TodoWrite' && ev.args?.todos ? renderTodos(ev.args.todos) : ''}</div>`;
  ensureTurn().appendChild(card);
  agent.cards.set(ev.id, card);
  if (ev.name === 'TodoWrite') card.classList.add('open');
  scrollDown();
}
function renderTodos(todos) {
  return `<ul class="todos">${todos.map((t) => `<li class="${t.status}">${t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'} ${esc(t.content)}</li>`).join('')}</ul>`;
}

function diffPreview(before, after) {
  // Compact line diff for approvals: show only changed lines with a little context.
  const a = before.split('\n'), b = after.split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const ctx = 2;
  const lines = [];
  for (let i = Math.max(0, s - ctx); i < s; i++) lines.push(` ${a[i]}`);
  for (let i = s; i < ea; i++) lines.push(`-${a[i]}`);
  for (let i = s; i < eb; i++) lines.push(`+${b[i]}`);
  for (let i = ea; i < Math.min(a.length, ea + ctx); i++) lines.push(` ${a[i]}`);
  const shown = lines.slice(0, 400);
  return `<pre class="diff">${shown.map((l) => `<span class="${l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : ''}">${esc(l)}</span>`).join('')}${lines.length > 400 ? '\n…' : ''}</pre>`;
}

function showApproval(ev) {
  const card = agent.cards.get(ev.id);
  if (!card) return;
  card.classList.add('open', 'awaiting');
  let preview = '';
  const a = ev.args || {};
  if (ev.name === 'run_command') preview = `<pre class="cmd">$ ${esc(a.command)}</pre>`;
  else if (ev.name === 'edit_file') {
    const before = ev.preview?.before || '';
    preview = before.includes(a.old_string) ? diffPreview(before, before.replace(a.old_string, () => a.new_string)) : diffPreview(a.old_string || '', a.new_string || '');
  } else if (ev.name === 'write_file') {
    preview = (ev.preview?.before ? '<div class="as-note">Overwrites existing file</div>' : '<div class="as-note">New file</div>') + diffPreview(ev.preview?.before || '', a.content || '');
  }
  const body = card.querySelector('.tool-body');
  body.innerHTML = `${preview}<div class="approval-row">
    <button class="btn primary" data-approve="1">${ev.name === 'run_command' ? 'Run' : 'Apply'}</button>
    <button class="btn" data-approve="0">Reject</button>
    <label class="as-check small"><input type="checkbox" data-always> always allow ${ev.name === 'run_command' ? 'commands' : 'edits'}</label></div>`;
  body.querySelector('[data-approve="1"]').focus({ preventScroll: true });
  body.addEventListener('click', function onClick(e) {
    const b = e.target.closest('[data-approve]');
    if (!b) return;
    body.removeEventListener('click', onClick);
    const ok = b.dataset.approve === '1';
    if (ok && body.querySelector('[data-always]').checked) {
      const kind = ev.name === 'run_command' ? 'commands' : 'edits';
      state.settings.agentAutoApprove = { ...(state.settings.agentAutoApprove || {}), [kind]: true };
      saveSettings();
    }
    body.querySelector('.approval-row').remove();
    card.classList.remove('awaiting');
    if (!ok) card.classList.remove('open');
    api.agent.approve(ev.approvalId, ok);
  });
  scrollDown(true);
}

function finishToolCard(ev) {
  const card = agent.cards.get(ev.id);
  if (!card) return;
  card.classList.remove('running', 'awaiting');
  card.classList.add(ev.declined ? 'declined' : ev.error ? 'error' : 'ok');
  const body = card.querySelector('.tool-body');
  if (!card.querySelector('.todos')) {
    const keepDiff = body.querySelector('.diff, .cmd');
    body.innerHTML = (keepDiff ? keepDiff.outerHTML : '') + (ev.result ? `<pre class="tool-out">${esc(ev.result.slice(0, 20000))}</pre>` : '');
  }
  if (ev.error && !ev.declined) card.classList.add('open');
}

function setRunning(running) {
  const btn = $('#agent-send');
  btn.classList.toggle('stop', running);
  btn.title = running ? 'Stop (Esc)' : 'Send (Enter)';
  btn.innerHTML = running ? '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  $('#agent-provider').disabled = running;
}

// ------------------------------------------------------------ events
const changedFiles = new Set();
const flushFileChanges = (() => {
  let t;
  return () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const files = [...changedFiles];
      changedFiles.clear();
      for (const p of files) {
        const tab = findTab(p);
        if (tab && !isDirty(tab)) await reloadOpenFile(p);
        else if (tab) toast('File changed by agent', `${basename(p)} has unsaved edits in the editor; not reloaded.`, 'error');
      }
      await refreshTree(true);
      refreshGit();
    }, 150);
  };
})();

api.agent.onEvent((runId, ev) => {
  if (runId !== agent.runId) return;
  switch (ev.type) {
    case 'step_start': break;
    case 'text': appendText(ev.text); break;
    case 'tool_call': addToolCard(ev); break;
    case 'approval': showApproval(ev); break;
    case 'tool_result': finishToolCard(ev); break;
    case 'file_changed': changedFiles.add(ev.path); flushFileChanges(); break;
    case 'usage': {
      finishText();
      const parts = [];
      if (ev.turns) parts.push(`${ev.turns} turn${ev.turns > 1 ? 's' : ''}`);
      if (ev.cost) parts.push(`≈ $${ev.cost.toFixed(3)} (covered by plan)`);
      if (ev.denials && ev.denials.length) parts.push(`denied: ${[...new Set(ev.denials)].join(', ')} — change permissions in ⚙`);
      if (parts.length) {
        const el = document.createElement('div');
        el.className = 'ag-usage';
        el.textContent = parts.join(' · ');
        ensureTurn().appendChild(el);
      }
      break;
    }
    case 'error': {
      finishText();
      const el = document.createElement('div');
      el.className = 'ag-error';
      el.textContent = ev.message;
      ensureTurn().appendChild(el);
      scrollDown(true);
      break;
    }
    case 'done':
      finishText();
      for (const card of agent.cards.values()) if (card.classList.contains('running')) { card.classList.remove('running', 'awaiting'); card.classList.add('declined'); card.querySelector('.approval-row')?.remove(); }
      if (ev.aborted) {
        const el = document.createElement('div');
        el.className = 'ag-usage'; el.textContent = 'Stopped.';
        ensureTurn().appendChild(el);
      }
      agent.runId = null; agent.turnEl = null; agent.cards.clear();
      setRunning(false);
      scrollDown();
      break;
    default: break;
  }
});

async function send() {
  if (agent.runId) return;
  const input = $('#agent-input');
  const text = input.value.trim();
  if (!text) return;
  const provider = currentProvider();
  if (PROVIDERS[provider].needsKey && !agent.keys.has(provider)) {
    toast('API key needed', `Add your ${PROVIDERS[provider].label} key in the agent settings.`, 'error');
    if ($('#agent-settings').hidden) runCommand('agent.settings');
    return;
  }
  if (!state.root) { toast('Open a folder first', 'The agent works inside a workspace folder.'); return; }
  input.value = '';
  autoGrow();
  addUserMessage(text);
  agent.runId = `run_${runSeq++}`;
  agent.turnEl = null;
  setRunning(true);
  const cfg = {
    chatId: agent.chatId,
    provider,
    model: $('#agent-model').value.trim() || PROVIDERS[provider].defaultModel,
    root: state.root,
    autoApprove: state.settings.agentAutoApprove || {},
    claudePermissionMode: state.settings.claudePermissionMode || 'acceptEdits',
  };
  ensureTurn().innerHTML = '<div class="ag-thinking"><span></span><span></span><span></span></div>';
  const clearThinking = () => agent.turnEl?.querySelector('.ag-thinking')?.remove();
  const obs = new MutationObserver(() => { if (agent.turnEl && agent.turnEl.children.length > 1) { clearThinking(); obs.disconnect(); } });
  obs.observe(agent.turnEl, { childList: true });
  try { await api.agent.send(agent.runId, cfg, buildPrompt(text)); } finally { obs.disconnect(); clearThinking(); }
}

function stop() { if (agent.runId) api.agent.stop(agent.runId); }

function newChat() {
  if (agent.runId) stop();
  api.agent.reset(agent.chatId);
  agent.chatId = `chat_${Date.now()}`;
  agent.turnEl = null; agent.textEl = null; agent.cards.clear();
  msgs().innerHTML = '';
  renderEmptyState();
  $('#agent-input').focus();
}

function autoGrow() {
  const ta = $('#agent-input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(260, Math.max(64, ta.scrollHeight)) + 'px';
}
$('#agent-input').addEventListener('input', autoGrow);
$('#agent-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  else if (e.key === 'Escape' && agent.runId) { e.preventDefault(); stop(); }
});
$('#agent-send').addEventListener('click', () => (agent.runId ? stop() : send()));

// ------------------------------------------------------------ boot
afterBoot.push(async () => {
  $('#agent-provider').value = state.settings.agentProvider || 'claude-cli';
  agent.keys = new Set((await api.agent.keys()).providers);
  syncProviderUi();
  editor.onDidChangeCursorSelection(() => updateContextChip());
  editor.onDidChangeModel(() => updateContextChip());

  // Buttons (activity bar, ✕) toggle purely on visibility; clicking moves focus off the input.
  cmd('agent.toggle', 'Agent: Toggle Panel', () => {
    if (agentVisible()) { showAgent(false); if (activeTab()) editor.focus(); } else showAgent(true);
  });
  // Ctrl+L: open → focus the input; already focused → close.
  cmd('agent.focus', 'Agent: Focus / Close Panel', () => {
    if (!agentVisible()) showAgent(true);
    else if (document.activeElement === $('#agent-input')) { showAgent(false); if (activeTab()) editor.focus(); }
    else $('#agent-input').focus();
  }, 'Ctrl+L');
  cmd('agent.new', 'Agent: New Chat', () => { showAgent(true); newChat(); });
  cmd('agent.settings', 'Agent: Settings & API Keys', async () => {
    showAgent(true);
    const el = $('#agent-settings');
    if (el.hidden) { await renderSettings(); el.hidden = false; } else { el.hidden = true; renderEmptyState(); }
  });
  cmd('agent.askSelection', 'Agent: Ask About Selection', () => {
    agent.includeContext = true;
    showAgent(true);
  });
  Object.assign(extraKeys, { 'Ctrl+l': 'agent.focus' });
  if (state.settings.agentOpen) showAgent(true);
});
