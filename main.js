// cnano — main process: window management, filesystem and git bridges.
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fssync = require('fs');
const { execFile } = require('child_process');
const pty = require('node-pty');
const agent = require('./agent');
const lsp = require('./lsp');

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'target', 'build', '.cache', '__pycache__', '.venv']);

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 700,
    minHeight: 400,
    frame: false,
    backgroundColor: '#1a1b26',
    title: 'cnano',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Dev aid: CNANO_SCREENSHOT=out.png captures the window after startup and exits.
  if (process.env.CNANO_SCREENSHOT) {
    win.webContents.on('console-message', (e) => console.log('[renderer]', e.level, e.message));
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      if (process.env.CNANO_EVAL) await win.webContents.executeJavaScript(process.env.CNANO_EVAL).catch((err) => console.log('eval error', err));
      await new Promise((r) => setTimeout(r, 1500));
      fssync.writeFileSync(process.env.CNANO_SCREENSHOT, (await win.capturePage()).toPNG());
      app.quit();
    }, 3000));
  }
  win.on('maximize', () => win.webContents.send('win:maximized', true));
  win.on('unmaximize', () => win.webContents.send('win:maximized', false));
  // Links in the markdown preview open in the system browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); }
  });
}

app.whenReady().then(createWindow);
agent.register(() => win);
lsp.register(() => win);
app.on('window-all-closed', () => app.quit());

// ---------- window controls ----------
ipcMain.on('win:minimize', () => win.minimize());
ipcMain.on('win:maximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
ipcMain.on('win:close', () => win.close());
ipcMain.handle('app:argv', () => {
  const args = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-'));
  return args.length ? path.resolve(args[0]) : null;
});

// ---------- terminals ----------
const terms = new Map();
let termSeq = 1;
ipcMain.handle('pty:create', (_e, cwd, cols, rows) => {
  const id = termSeq++;
  const shell = process.env.SHELL || '/bin/bash';
  const p = pty.spawn(shell, [], {
    name: 'xterm-256color', cols, rows,
    cwd: cwd && fssync.existsSync(cwd) ? cwd : app.getPath('home'),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'cnano' },
  });
  terms.set(id, p);
  p.onData((d) => win && !win.isDestroyed() && win.webContents.send('pty:data', id, d));
  p.onExit(({ exitCode }) => { terms.delete(id); win && !win.isDestroyed() && win.webContents.send('pty:exit', id, exitCode); });
  return { id, shell: path.basename(shell) };
});
ipcMain.on('pty:write', (_e, id, data) => terms.get(id)?.write(data));
ipcMain.on('pty:resize', (_e, id, cols, rows) => { try { terms.get(id)?.resize(cols, rows); } catch { /* exited */ } });
ipcMain.on('pty:kill', (_e, id) => { terms.get(id)?.kill(); terms.delete(id); });
app.on('before-quit', () => { for (const p of terms.values()) p.kill(); lsp.stopAll(); });

// ---------- settings ----------
ipcMain.handle('settings:load', async () => {
  try { return JSON.parse(await fs.readFile(SETTINGS_FILE(), 'utf8')); } catch { return {}; }
});
ipcMain.handle('settings:save', async (_e, data) => {
  await fs.mkdir(path.dirname(SETTINGS_FILE()), { recursive: true });
  await fs.writeFile(SETTINGS_FILE(), JSON.stringify(data, null, 2));
});

// ---------- dialogs ----------
ipcMain.handle('dialog:openFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:openFile', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('dialog:saveAs', async (_e, defaultPath) => {
  const r = await dialog.showSaveDialog(win, { defaultPath });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('dialog:confirm', async (_e, message, detail) => {
  const r = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Yes', 'Cancel'], defaultId: 0, cancelId: 1, message, detail,
  });
  return r.response === 0;
});
ipcMain.handle('dialog:unsaved', async (_e, name) => {
  const r = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Save', "Don't Save", 'Cancel'], defaultId: 0, cancelId: 2,
    message: `Save changes to ${name}?`, detail: 'Your changes will be lost if you don\'t save them.',
  });
  return ['save', 'discard', 'cancel'][r.response];
});

// ---------- filesystem ----------
ipcMain.handle('fs:readDir', async (_e, dir) => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .map((d) => ({ name: d.name, path: path.join(dir, d.name), dir: d.isDirectory() }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
});
ipcMain.handle('fs:readFile', async (_e, p) => {
  const buf = await fs.readFile(p);
  // Treat files with NUL bytes in the first 8K as binary.
  if (buf.subarray(0, 8192).includes(0)) return { binary: true, content: '' };
  return { binary: false, content: buf.toString('utf8') };
});
ipcMain.handle('fs:writeFile', (_e, p, content) => fs.writeFile(p, content, 'utf8'));
ipcMain.handle('fs:createFile', async (_e, p) => {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, '', { flag: 'wx' });
});
ipcMain.handle('fs:createDir', (_e, p) => fs.mkdir(p, { recursive: true }));
ipcMain.handle('fs:rename', (_e, a, b) => fs.rename(a, b));
ipcMain.handle('fs:delete', (_e, p) => shell.trashItem(p));
ipcMain.handle('fs:exists', (_e, p) => fssync.existsSync(p));
ipcMain.handle('fs:reveal', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('path:info', (_e, p) => ({ base: path.basename(p), dir: path.dirname(p), sep: path.sep }));

async function walk(root, out, limit = 20000) {
  const stack = [root];
  while (stack.length && out.length < limit) {
    const dir = stack.pop();
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of entries) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) { if (!IGNORED_DIRS.has(d.name)) stack.push(full); }
      else if (d.isFile()) out.push(full);
    }
  }
  return out;
}
ipcMain.handle('fs:listAll', async (_e, root) => (await walk(root, [])).map((f) => path.relative(root, f)));

ipcMain.handle('fs:search', async (_e, root, query, opts = {}) => {
  if (!query) return [];
  let re;
  try {
    const src = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(opts.word ? `\\b${src}\\b` : src, opts.caseSensitive ? 'g' : 'gi');
  } catch (err) { return { error: err.message }; }
  const files = await walk(root, []);
  const results = [];
  let total = 0;
  for (const f of files) {
    if (total > 2000) break;
    let text;
    try {
      const st = await fs.stat(f);
      if (st.size > 2 * 1024 * 1024) continue;
      const buf = await fs.readFile(f);
      if (buf.subarray(0, 8192).includes(0)) continue;
      text = buf.toString('utf8');
    } catch { continue; }
    const matches = [];
    text.split('\n').forEach((line, i) => {
      re.lastIndex = 0;
      const m = re.exec(line);
      if (m) matches.push({ line: i + 1, col: m.index + 1, len: m[0].length, text: line.slice(0, 300) });
    });
    if (matches.length) { results.push({ file: f, rel: path.relative(root, f), matches }); total += matches.length; }
  }
  return results;
});

// ---------- git ----------
function git(cwd, args, timeout = 120000) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd, timeout, maxBuffer: 64 * 1024 * 1024,
      // Never block on an interactive credential prompt; SSH keys / credential helpers still work.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? err.code : 0, stdout, stderr: stderr || (err ? err.message : '') });
    });
  });
}

ipcMain.handle('git:run', (_e, cwd, args) => git(cwd, args));

ipcMain.handle('git:status', async (_e, cwd) => {
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return { repo: false };
  const root = top.stdout.trim();
  const st = await git(root, ['status', '--porcelain=v1', '-b', '-z', '-uall']);
  const parts = st.stdout.split('\0');
  let branch = '', ahead = 0, behind = 0, upstream = null;
  const staged = [], unstaged = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p.startsWith('## ')) {
      const h = p.slice(3);
      const m = h.match(/^(?:No commits yet on |Initial commit on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(.*)\])?/);
      if (m) {
        branch = m[1]; upstream = m[2] || null;
        const a = (m[3] || '').match(/ahead (\d+)/), b = (m[3] || '').match(/behind (\d+)/);
        ahead = a ? +a[1] : 0; behind = b ? +b[1] : 0;
      }
      continue;
    }
    const x = p[0], y = p[1], file = p.slice(3);
    let orig = null;
    if (x === 'R' || x === 'C') orig = parts[++i];
    if (x === '?' && y === '?') { unstaged.push({ file, status: 'U' }); continue; }
    if (x !== ' ') staged.push({ file, status: x, orig });
    if (y !== ' ') unstaged.push({ file, status: y });
  }
  const remotes = (await git(root, ['remote'])).stdout.split('\n').filter(Boolean);
  return { repo: true, root, branch, upstream, ahead, behind, staged, unstaged, remotes };
});

ipcMain.handle('git:show', async (_e, root, ref, file) => {
  const r = await git(root, ['show', `${ref}:${file}`]);
  return r.ok ? r.stdout : '';
});

ipcMain.handle('git:log', async (_e, root) => {
  const r = await git(root, ['log', '-n', '100', '--date=relative', '--pretty=format:%h%x1f%an%x1f%ad%x1f%s']);
  if (!r.ok) return [];
  return r.stdout.split('\n').filter(Boolean).map((l) => {
    const [hash, author, date, subject] = l.split('\x1f');
    return { hash, author, date, subject };
  });
});

ipcMain.handle('git:branches', async (_e, root) => {
  const r = await git(root, ['branch', '--format=%(refname:short)']);
  return r.stdout.split('\n').filter(Boolean);
});

ipcMain.handle('git:clone', async (_e, url, parent) => {
  const r = await git(parent, ['clone', '--progress', url], 30 * 60 * 1000);
  if (!r.ok) return { ok: false, stderr: r.stderr };
  const m = r.stderr.match(/Cloning into '(.+?)'/);
  const name = m ? m[1] : path.basename(url).replace(/\.git$/, '');
  return { ok: true, dir: path.join(parent, name) };
});
