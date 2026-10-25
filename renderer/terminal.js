/* global Terminal, FitAddon, WebLinksAddon, api, state, $, esc, editor, cmd, extraKeys, afterBoot, saveSettings, activeTab, toast */
'use strict';
// Integrated terminal: xterm.js front-end, node-pty back-end (one shell per tab).

const terminals = []; // { id, term, fit, el, title, exited }
let activeTerm = null;

const TERM_THEME = {
  background: '#1a1b26', foreground: '#c8cbe0', cursor: '#c0a6ff', cursorAccent: '#1a1b26',
  selectionBackground: '#a882ff44',
  black: '#2a2c3d', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#c8cbe0',
  brightBlack: '#545870', brightRed: '#ff8fa3', brightGreen: '#b5e48c', brightYellow: '#f2c98a', brightBlue: '#9ab8ff', brightMagenta: '#cdb4ff', brightCyan: '#a4e1ff', brightWhite: '#eceef9',
};

api.pty.onData((id, data) => { const t = terminals.find((x) => x.id === id); if (t) t.term.write(data); });
api.pty.onExit((id, code) => {
  const t = terminals.find((x) => x.id === id);
  if (!t) return;
  t.exited = true;
  t.term.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`);
  // Closing the shell (exit / Ctrl+D) closes its tab, like VS Code.
  setTimeout(() => killTerminal(t), 400);
});

function panelVisible() { return !$('#panel').hidden; }

function showPanel(show) {
  $('#panel').hidden = !show;
  $('#panel-sash').hidden = !show;
  $('#act-term').classList.toggle('active', show);
  $('#panel').style.height = (state.settings.panelHeight || 260) + 'px';
  requestAnimationFrame(() => { editor && editor.layout(); fitActive(); });
}

async function newTerminal() {
  showPanel(true);
  const el = document.createElement('div');
  el.className = 'term-instance';
  $('#term-host').appendChild(el);
  const term = new Terminal({
    fontFamily: "'JetBrains Mono', 'Fira Code', 'DejaVu Sans Mono', monospace",
    fontSize: Math.max(10, state.settings.fontSize - 1),
    lineHeight: 1.2,
    cursorBlink: true,
    cursorStyle: 'bar',
    allowProposedApi: true,
    scrollback: 10000,
    theme: TERM_THEME,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, url) => window.open(url, '_blank')));
  term.open(el);
  fit.fit();
  const cwd = state.root || null;
  const { id, shell } = await api.pty.create(cwd, term.cols, term.rows);
  const t = { id, term, fit, el, title: shell, exited: false };
  terminals.push(t);
  term.onData((d) => api.pty.write(id, d));
  term.onResize(({ cols, rows }) => api.pty.resize(id, cols, rows));
  term.onTitleChange((title) => { t.title = title.replace(/^.*?:\s*/, '') || shell; renderTermTabs(); });
  // Copy / paste on Ctrl+Shift+C / V; Ctrl+C still sends SIGINT.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') { navigator.clipboard.writeText(term.getSelection()); return false; }
    if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') { navigator.clipboard.readText().then((s) => term.paste(s)); return false; }
    return true;
  });
  activateTerminal(t);
  return t;
}

function activateTerminal(t) {
  activeTerm = t;
  for (const x of terminals) x.el.hidden = x !== t;
  renderTermTabs();
  requestAnimationFrame(() => { fitActive(); t.term.focus(); });
}

function killTerminal(t = activeTerm) {
  if (!t) return;
  if (!t.exited) api.pty.kill(t.id);
  t.term.dispose();
  t.el.remove();
  const i = terminals.indexOf(t);
  if (i >= 0) terminals.splice(i, 1);
  if (activeTerm === t) {
    const next = terminals[i] || terminals[i - 1];
    if (next) activateTerminal(next);
    else { activeTerm = null; showPanel(false); if (activeTab()) editor.focus(); }
  }
  renderTermTabs();
}

function renderTermTabs() {
  $('#term-tabs').innerHTML = terminals.map((t, i) => `
    <span class="term-tab ${t === activeTerm ? 'active' : ''}" data-i="${i}">
      <svg viewBox="0 0 24 24"><path d="M5 8l4 4-4 4M12 16h7"/></svg><span class="tt-name" title="${esc(t.title)}">${esc(t.title.replace(/^.*\//, '') || t.title)}</span>
      <span class="term-close" data-close="${i}">×</span></span>`).join('');
}
$('#term-tabs').addEventListener('click', (e) => {
  const c = e.target.closest('[data-close]');
  if (c) return killTerminal(terminals[+c.dataset.close]);
  const tab = e.target.closest('.term-tab');
  if (tab) activateTerminal(terminals[+tab.dataset.i]);
});

function fitActive() {
  if (!activeTerm || !panelVisible()) return;
  try { activeTerm.fit.fit(); } catch { /* not laid out yet */ }
}
new ResizeObserver(() => fitActive()).observe($('#term-host'));

// Drag the horizontal sash to resize the panel.
$('#panel-sash').addEventListener('mousedown', (e) => {
  e.preventDefault();
  const sash = $('#panel-sash');
  sash.classList.add('dragging');
  document.body.style.cursor = 'row-resize';
  const mainRect = $('#main').getBoundingClientRect();
  const move = (ev) => {
    const h = Math.max(80, Math.min(mainRect.height - 120, mainRect.bottom - ev.clientY));
    $('#panel').style.height = h + 'px';
    state.settings.panelHeight = h;
    editor.layout();
  };
  const up = () => {
    sash.classList.remove('dragging'); document.body.style.cursor = '';
    removeEventListener('mousemove', move); removeEventListener('mouseup', up);
    saveSettings();
  };
  addEventListener('mousemove', move); addEventListener('mouseup', up);
});

// Build + run command for a source file, chosen by language and (for assembly) by extension:
//   .asm/.nasm → nasm + ld · .s → GNU as + ld · .S → gcc -c (C preprocessor) + ld
function runCommandFor(p, lang) {
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  const dir = p.slice(0, p.lastIndexOf('/')) || '/';
  const base = p.replace(/\.[^./]+$/, '');
  const bin = q(base), obj = q(base + '.o'), src = q(p);
  const run = `&& ${bin}`;
  const ext = (p.match(/\.([^./]+)$/) || [])[1] || '';
  switch (lang) {
    case 'c': return `gcc -Wall -Wextra -g ${src} -o ${bin} -lm ${run}`;
    case 'cpp': return `g++ -Wall -Wextra -std=c++20 -g ${src} -o ${bin} ${run}`;
    case 'rust': return `rustc -g ${src} -o ${bin} ${run}`;
    case 'python': return `$(command -v python3 || command -v python) ${src}`;
    case 'shell': return `bash ${src}`;
    case 'makefile': return `make -C ${q(dir)}`;
    case 'asm':
      if (/^(asm|nasm)$/i.test(ext)) return `nasm -f elf64 -g ${src} -o ${obj} && ld ${obj} -o ${bin} ${run}`;
      if (ext === 'S') return `gcc -c -g ${src} -o ${obj} && ld ${obj} -o ${bin} ${run}`;
      return `as -g ${src} -o ${obj} && ld ${obj} -o ${bin} ${run}`;
    default: return null;
  }
}

let panelMaximized = false;
afterBoot.push(() => {
  const openTerminal = () => {
    if (!terminals.length) return newTerminal();
    showPanel(true);
    activateTerminal(activeTerm || terminals[0]);
  };
  const hidePanel = () => { showPanel(false); if (activeTab()) editor.focus(); };
  cmd('terminal.toggle', 'Terminal: Toggle Panel', () => (panelVisible() ? hidePanel() : openTerminal()));
  // Ctrl+`: visible but unfocused → focus it; focused → hide.
  cmd('terminal.focus', 'Terminal: Focus / Hide Panel', () => {
    if (!panelVisible()) return openTerminal();
    if (document.activeElement?.closest('#panel')) return hidePanel();
    activateTerminal(activeTerm || terminals[0]);
  }, 'Ctrl+`');
  cmd('terminal.new', 'Terminal: New Terminal', () => newTerminal().catch((err) => toast('Terminal failed', err.message, 'error')), 'Ctrl+Shift+`');
  cmd('terminal.kill', 'Terminal: Kill Active Terminal', () => killTerminal());
  cmd('terminal.maximize', 'Terminal: Toggle Maximized Panel', () => {
    panelMaximized = !panelMaximized;
    $('#panel').style.height = panelMaximized ? ($('#main').clientHeight - 60) + 'px' : (state.settings.panelHeight || 260) + 'px';
    editor.layout(); fitActive();
  });
  cmd('terminal.clear', 'Terminal: Clear', () => activeTerm && activeTerm.term.clear());
  cmd('terminal.runFile', 'Run: Compile & Run Active File', async () => {
    const tab = activeTab();
    if (!tab || !tab.path || tab.diff) return toast('Nothing to run', 'Open a saved source file first.');
    const command = runCommandFor(tab.path, tab.model.getLanguageId());
    if (!command) return toast('Don\'t know how to run this file type', `${tab.name} (${tab.model.getLanguageId()})`);
    if (tab.model.getAlternativeVersionId() !== tab.savedVersion && !(await saveTab(tab))) return;
    const t = activeTerm && !activeTerm.exited ? activeTerm : await newTerminal();
    showPanel(true); activateTerminal(t);
    api.pty.write(t.id, command + '\r');
  }, 'Super+C / F5');
  Object.assign(extraKeys, {
    'Ctrl+`': 'terminal.focus', 'Ctrl+Shift+`': 'terminal.new', 'Ctrl+Shift+~': 'terminal.new', F5: 'terminal.runFile', 'Meta+c': 'terminal.runFile',
  });
});
