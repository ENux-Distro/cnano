// cnano — language server manager (main process). Spawns servers over stdio and relays JSON-RPC.
const { ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const LSP_DIR = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'cnano', 'lsp', 'bin');

// First available candidate wins. C and C++ share one clangd per project.
const SERVERS = {
  clangd: { langs: ['c', 'cpp'], candidates: [['clangd', '--background-index', '--header-insertion=never', '--clang-tidy']] },
  rust: { langs: ['rust'], candidates: [['rust-analyzer']], rootMarkers: ['Cargo.toml'] },
  python: {
    langs: ['python'],
    candidates: [['basedpyright-langserver', '--stdio'], ['pyright-langserver', '--stdio'], ['pylsp'], ['jedi-language-server']],
  },
  asm: { langs: ['asm'], candidates: [['asm-lsp']] },
};
const SERVER_FOR_LANG = Object.fromEntries(Object.entries(SERVERS).flatMap(([k, v]) => v.langs.map((l) => [l, k])));

function which(cmd) {
  for (const dir of [...(process.env.PATH || '').split(':'), LSP_DIR]) {
    const p = path.join(dir, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

// Rust projects are rooted at the nearest Cargo.toml so rust-analyzer finds the crate.
function rootFor(kind, filePath, workspace) {
  const markers = SERVERS[kind].rootMarkers;
  if (markers) {
    let d = path.dirname(filePath);
    while (d.startsWith(workspace) || d === workspace) {
      if (markers.some((m) => fs.existsSync(path.join(d, m)))) return d;
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  return workspace;
}

class Server {
  constructor(kind, root, argv, emit) {
    this.kind = kind; this.root = root; this.emit = emit;
    this.seq = 1; this.pending = new Map(); this.buf = Buffer.alloc(0); this.docs = new Set();
    this.name = path.basename(argv[0]);
    this.proc = spawn(argv[0], argv.slice(1), { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    this.proc.stdout.on('data', (d) => this.onData(d));
    this.proc.stderr.on('data', () => { /* servers are chatty on stderr */ });
    this.proc.on('error', (err) => { this.dead = true; this.emit('lsp:status', { server: this.name, state: 'error', message: err.message }); });
    this.proc.on('exit', (code) => {
      this.dead = true;
      for (const { reject } of this.pending.values()) reject(new Error(`${this.name} exited`));
      this.pending.clear();
      this.emit('lsp:status', { server: this.name, state: 'stopped', code });
    });
    this.ready = this.initialize();
  }

  write(msg) {
    if (this.dead) return;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }), 'utf8');
    this.proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.proc.stdin.write(body);
  }
  request(method, params) {
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }
  notify(method, params) { this.write({ method, params }); }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const sep = this.buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const m = /Content-Length: *(\d+)/i.exec(this.buf.subarray(0, sep).toString());
      if (!m) { this.buf = this.buf.subarray(sep + 4); continue; }
      const len = +m[1];
      if (this.buf.length < sep + 4 + len) return;
      const body = this.buf.subarray(sep + 4, sep + 4 + len).toString('utf8');
      this.buf = this.buf.subarray(sep + 4 + len);
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      this.dispatch(msg);
    }
  }

  dispatch(msg) {
    if (msg.id !== undefined && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined) {
      // Server → client requests: answer the common ones so servers don't stall.
      let result = null;
      if (msg.method === 'workspace/configuration') result = (msg.params.items || []).map(() => null);
      else if (msg.method === 'workspace/workspaceFolders') result = [{ uri: pathToFileURL(this.root).href, name: path.basename(this.root) }];
      this.write({ id: msg.id, result });
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics') this.emit('lsp:diagnostics', msg.params);
    else if (msg.method === '$/progress') {
      const v = msg.params.value || {};
      if (v.kind === 'begin') this.emit('lsp:status', { server: this.name, state: 'busy', message: v.title });
      else if (v.kind === 'end') this.emit('lsp:status', { server: this.name, state: 'ready' });
    } else if (msg.method === 'window/showMessage' && msg.params.type <= 1) {
      this.emit('lsp:status', { server: this.name, state: 'error', message: msg.params.message });
    }
  }

  async initialize() {
    const rootUri = pathToFileURL(this.root).href;
    const res = await this.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'cnano' },
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(this.root) }],
      capabilities: {
        general: { positionEncodings: ['utf-16'] },
        window: { workDoneProgress: true },
        workspace: { configuration: true, workspaceFolders: true, applyEdit: false },
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          completion: {
            completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'], deprecatedSupport: true, labelDetailsSupport: true },
            contextSupport: true,
          },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true } } },
          definition: { linkSupport: false },
          declaration: { linkSupport: false },
          references: {},
          rename: { prepareSupport: false },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          formatting: {},
          codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source'] } }, isPreferredSupport: true },
          publishDiagnostics: { relatedInformation: false },
        },
      },
      initializationOptions: this.kind === 'clangd' ? { fallbackFlags: ['-Wall', '-Wextra'] } : undefined,
    });
    this.capabilities = res.capabilities || {};
    this.notify('initialized', {});
    this.emit('lsp:status', { server: this.name, state: 'ready' });
    return this.capabilities;
  }

  stop() {
    if (this.dead) return;
    this.request('shutdown', null).catch(() => {}).finally(() => { this.notify('exit', null); setTimeout(() => this.proc.kill(), 500); });
  }
}

const servers = new Map(); // `${kind}|${root}` -> Server
const byUri = new Map();   // uri -> Server

function register(getWin) {
  const emit = (ch, data) => { const w = getWin(); if (w && !w.isDestroyed()) w.webContents.send(ch, data); };

  ipcMain.handle('lsp:available', () => Object.fromEntries(Object.entries(SERVERS).map(([k, v]) => {
    const found = v.candidates.find((c) => which(c[0]));
    return [k, found ? found[0] : null];
  })));

  // Opens a document; starts the server if needed. Returns the server's capabilities, or null.
  ipcMain.handle('lsp:open', async (_e, workspace, filePath, lang, text, version) => {
    const kind = SERVER_FOR_LANG[lang];
    if (!kind || !workspace) return null;
    const root = rootFor(kind, filePath, workspace);
    const key = `${kind}|${root}`;
    let srv = servers.get(key);
    if (!srv || srv.dead) {
      const argv = SERVERS[kind].candidates.find((c) => which(c[0]));
      if (!argv) return null;
      srv = new Server(kind, root, [which(argv[0]), ...argv.slice(1)], emit);
      servers.set(key, srv);
      emit('lsp:status', { server: srv.name, state: 'starting' });
    }
    let caps;
    try { caps = await srv.ready; } catch (err) { emit('lsp:status', { server: srv.name, state: 'error', message: err.message }); return null; }
    const uri = pathToFileURL(filePath).href;
    byUri.set(uri, srv);
    if (!srv.docs.has(uri)) {
      srv.docs.add(uri);
      srv.notify('textDocument/didOpen', { textDocument: { uri, languageId: lang, version, text } });
    }
    return { uri, server: srv.name, capabilities: caps };
  });

  ipcMain.on('lsp:change', (_e, uri, text, version) => {
    byUri.get(uri)?.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
  });
  ipcMain.on('lsp:save', (_e, uri, text) => {
    byUri.get(uri)?.notify('textDocument/didSave', { textDocument: { uri }, text });
  });
  ipcMain.on('lsp:close', (_e, uri) => {
    const srv = byUri.get(uri);
    if (!srv) return;
    srv.notify('textDocument/didClose', { textDocument: { uri } });
    srv.docs.delete(uri);
    byUri.delete(uri);
  });
  ipcMain.handle('lsp:request', async (_e, uri, method, params) => {
    const srv = byUri.get(uri);
    if (!srv || srv.dead) return null;
    try { return await srv.request(method, params); } catch { return null; }
  });
  ipcMain.handle('lsp:restart', () => {
    for (const s of servers.values()) s.stop();
    servers.clear(); byUri.clear();
  });
}

function stopAll() { for (const s of servers.values()) s.stop(); }

module.exports = { register, stopAll };
