/* global monaco, api, state, editor, $, esc, toast, openFile, findTab, activeTab, cmd, afterBoot, basename, rel, debounce */
'use strict';
// LSP client glue: keeps Monaco models in sync with language servers and maps LSP features onto Monaco providers.

const LSP_LANGS = ['c', 'cpp', 'rust', 'python', 'asm'];
const docs = new Map();          // uri string -> { model, version, server, caps }
const registered = new Set();    // languages with providers registered
const serverState = {};          // server name -> { state, message }

const toLsp = (pos) => ({ line: pos.lineNumber - 1, character: pos.column - 1 });
const toRange = (r) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
const uriOf = (model) => model.uri.toString();
const isFileModel = (model) => model.uri.scheme === 'file';

// ------------------------------------------------------------ document sync
async function lspOpen(model) {
  const lang = model.getLanguageId();
  if (!isFileModel(model) || !LSP_LANGS.includes(lang) || !state.root) return;
  const uri = uriOf(model);
  if (docs.has(uri)) return;
  const doc = { model, version: 1, pending: true };
  docs.set(uri, doc);
  const res = await api.lsp.open(state.root, model.uri.path, lang, model.getValue(), doc.version);
  if (!res || model.isDisposed()) { docs.delete(uri); return; }
  Object.assign(doc, { server: res.server, caps: res.capabilities, pending: false });
  registerProviders(lang, res.capabilities);
  const push = debounce(() => {
    if (model.isDisposed()) return;
    doc.version++;
    api.lsp.change(uri, model.getValue(), doc.version);
  }, 150);
  doc.sub = model.onDidChangeContent(push);
  updateLspStatus();
}

function lspClose(model) {
  const uri = uriOf(model);
  const doc = docs.get(uri);
  if (!doc) return;
  doc.sub?.dispose();
  docs.delete(uri);
  api.lsp.close(uri);
}

function lspDidSave(model) {
  const doc = docs.get(uriOf(model));
  if (doc && !doc.pending) api.lsp.save(uriOf(model), model.getValue());
}

// Language changed (e.g. via "Change Language Mode"): reopen under the new language.
function lspReopen(model) { lspClose(model); lspOpen(model); }

// ------------------------------------------------------------ diagnostics
const SEVERITY = () => ({ 1: monaco.MarkerSeverity.Error, 2: monaco.MarkerSeverity.Warning, 3: monaco.MarkerSeverity.Info, 4: monaco.MarkerSeverity.Hint });
api.lsp.onDiagnostics(({ uri, diagnostics }) => {
  const model = monaco.editor.getModel(monaco.Uri.parse(uri));
  if (!model) return;
  const sev = SEVERITY();
  monaco.editor.setModelMarkers(model, 'lsp', diagnostics.map((d) => ({
    ...rangeObj(d.range),
    severity: sev[d.severity || 1],
    message: d.message,
    source: d.source,
    code: d.code !== undefined ? String(typeof d.code === 'object' ? d.code.value : d.code) : undefined,
  })));
  updateProblems();
});
function rangeObj(r) {
  return { startLineNumber: r.start.line + 1, startColumn: r.start.character + 1, endLineNumber: r.end.line + 1, endColumn: r.end.character + 1 };
}

function updateProblems() {
  const markers = monaco.editor.getModelMarkers({ owner: 'lsp' });
  const errors = markers.filter((m) => m.severity === monaco.MarkerSeverity.Error).length;
  const warnings = markers.filter((m) => m.severity === monaco.MarkerSeverity.Warning).length;
  const el = $('#sb-problems');
  el.hidden = !docs.size && !markers.length;
  el.innerHTML = `<span class="${errors ? 'pr-err' : ''}">⊗ ${errors}</span><span class="${warnings ? 'pr-warn' : ''}">⚠ ${warnings}</span>`;
}

api.lsp.onStatus((s) => { serverState[s.server] = s; updateLspStatus(); if (s.state === 'error' && s.message) toast(`${s.server}`, s.message, 'error'); });
function updateLspStatus() {
  const tab = activeTab();
  const doc = tab && tab.model && docs.get(uriOf(tab.model));
  const el = $('#sb-lsp');
  if (!doc || !doc.server) { el.hidden = true; return; }
  const st = serverState[doc.server] || { state: 'ready' };
  el.hidden = false;
  el.title = `${doc.server}: ${st.state}${st.message ? ' — ' + st.message : ''}`;
  el.innerHTML = `<span class="lsp-dot ${st.state}"></span>${esc(doc.server)}${st.state === 'busy' && st.message ? ` <span class="muted">${esc(st.message)}</span>` : ''}`;
}

// ------------------------------------------------------------ providers
const req = (model, method, params) => api.lsp.request(uriOf(model), method, { textDocument: { uri: uriOf(model) }, ...params });
const markdown = (c) => {
  if (!c) return null;
  if (typeof c === 'string') return { value: c };
  if (Array.isArray(c)) return c.map(markdown).filter(Boolean).map((x) => x.value).join('\n\n') ? { value: c.map(markdown).filter(Boolean).map((x) => x.value).join('\n\n') } : null;
  if (c.kind) return { value: c.kind === 'markdown' ? c.value : '```\n' + c.value + '\n```' };
  if (c.language) return { value: '```' + c.language + '\n' + c.value + '\n```' };
  return null;
};
const locations = (res) => (res ? (Array.isArray(res) ? res : [res]) : []).map((l) => ({
  uri: monaco.Uri.parse(l.uri || l.targetUri), range: toRange(l.range || l.targetSelectionRange || l.targetRange),
}));

function completionKind(k) {
  const K = monaco.languages.CompletionItemKind;
  return ({ 1: K.Text, 2: K.Method, 3: K.Function, 4: K.Constructor, 5: K.Field, 6: K.Variable, 7: K.Class, 8: K.Interface, 9: K.Module,
    10: K.Property, 11: K.Unit, 12: K.Value, 13: K.Enum, 14: K.Keyword, 15: K.Snippet, 16: K.Color, 17: K.File, 18: K.Reference,
    19: K.Folder, 20: K.EnumMember, 21: K.Constant, 22: K.Struct, 23: K.Event, 24: K.Operator, 25: K.TypeParameter })[k] ?? K.Text;
}
function symbolKind(k) { return Math.max(0, (k || 13) - 1); } // LSP SymbolKind is Monaco's + 1

function registerProviders(lang, caps) {
  if (registered.has(lang)) return;
  registered.add(lang);
  const L = monaco.languages;

  if (caps.completionProvider) {
    L.registerCompletionItemProvider(lang, {
      triggerCharacters: caps.completionProvider.triggerCharacters || ['.'],
      async provideCompletionItems(model, position, context) {
        const res = await req(model, 'textDocument/completion', {
          position: toLsp(position),
          context: { triggerKind: context.triggerKind === 1 ? 2 : 1, triggerCharacter: context.triggerCharacter },
        });
        const items = Array.isArray(res) ? res : (res?.items || []);
        const word = model.getWordUntilPosition(position);
        const fallback = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, position.column);
        return {
          incomplete: !!res?.isIncomplete,
          suggestions: items.slice(0, 500).map((it) => {
            const te = it.textEdit;
            const range = te ? toRange(te.range || te.replace) : fallback;
            const label = it.labelDetails ? { label: it.label, detail: it.labelDetails.detail, description: it.labelDetails.description } : it.label;
            return {
              label,
              kind: completionKind(it.kind),
              detail: it.detail,
              documentation: markdown(it.documentation) || undefined,
              insertText: (te && te.newText) ?? it.insertText ?? it.label,
              insertTextRules: it.insertTextFormat === 2 ? L.CompletionItemInsertTextRule.InsertAsSnippet : 0,
              range: te && te.insert ? { insert: toRange(te.insert), replace: toRange(te.replace) } : range,
              sortText: it.sortText, filterText: it.filterText, preselect: it.preselect,
              tags: it.deprecated ? [1] : undefined,
              additionalTextEdits: (it.additionalTextEdits || []).map((e) => ({ range: toRange(e.range), text: e.newText })),
            };
          }),
        };
      },
    });
  }
  if (caps.hoverProvider) {
    L.registerHoverProvider(lang, {
      async provideHover(model, position) {
        const res = await req(model, 'textDocument/hover', { position: toLsp(position) });
        const md = res && markdown(res.contents);
        return md && md.value.trim() ? { contents: [md], range: res.range ? toRange(res.range) : undefined } : null;
      },
    });
  }
  if (caps.signatureHelpProvider) {
    L.registerSignatureHelpProvider(lang, {
      signatureHelpTriggerCharacters: caps.signatureHelpProvider.triggerCharacters || ['(', ','],
      signatureHelpRetriggerCharacters: caps.signatureHelpProvider.retriggerCharacters || [','],
      async provideSignatureHelp(model, position) {
        const res = await req(model, 'textDocument/signatureHelp', { position: toLsp(position) });
        if (!res || !res.signatures?.length) return null;
        return {
          value: {
            activeSignature: res.activeSignature || 0,
            activeParameter: res.activeParameter || 0,
            signatures: res.signatures.map((s) => ({
              label: s.label, documentation: markdown(s.documentation) || undefined,
              parameters: (s.parameters || []).map((p) => ({ label: p.label, documentation: markdown(p.documentation) || undefined })),
              activeParameter: s.activeParameter,
            })),
          },
          dispose() {},
        };
      },
    });
  }
  if (caps.definitionProvider) {
    L.registerDefinitionProvider(lang, { provideDefinition: async (model, position) => locations(await req(model, 'textDocument/definition', { position: toLsp(position) })) });
  }
  if (caps.declarationProvider) {
    L.registerDeclarationProvider(lang, { provideDeclaration: async (model, position) => locations(await req(model, 'textDocument/declaration', { position: toLsp(position) })) });
  }
  if (caps.referencesProvider) {
    L.registerReferenceProvider(lang, {
      provideReferences: async (model, position, ctx) => locations(await req(model, 'textDocument/references', { position: toLsp(position), context: { includeDeclaration: ctx.includeDeclaration } })),
    });
  }
  if (caps.documentSymbolProvider) {
    L.registerDocumentSymbolProvider(lang, {
      async provideDocumentSymbols(model) {
        const res = await req(model, 'textDocument/documentSymbol', {});
        const conv = (s) => ({
          name: s.name, detail: s.detail || '', kind: symbolKind(s.kind), tags: [],
          range: toRange(s.range || s.location.range), selectionRange: toRange(s.selectionRange || s.range || s.location.range),
          children: (s.children || []).map(conv),
        });
        return (res || []).map(conv);
      },
    });
  }
  if (caps.documentFormattingProvider) {
    L.registerDocumentFormattingEditProvider(lang, {
      async provideDocumentFormattingEdits(model, options) {
        const res = await req(model, 'textDocument/formatting', { options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } });
        return (res || []).map((e) => ({ range: toRange(e.range), text: e.newText }));
      },
    });
  }
  if (caps.codeActionProvider) {
    L.registerCodeActionProvider(lang, {
      async provideCodeActions(model, range, context) {
        const sevBack = { [monaco.MarkerSeverity.Error]: 1, [monaco.MarkerSeverity.Warning]: 2, [monaco.MarkerSeverity.Info]: 3, [monaco.MarkerSeverity.Hint]: 4 };
        const diagnostics = context.markers.filter((m) => m.owner === 'lsp').map((m) => ({
          range: { start: { line: m.startLineNumber - 1, character: m.startColumn - 1 }, end: { line: m.endLineNumber - 1, character: m.endColumn - 1 } },
          message: m.message, severity: sevBack[m.severity], source: m.source, code: m.code,
        }));
        const res = await req(model, 'textDocument/codeAction', {
          range: { start: toLsp(range.getStartPosition()), end: toLsp(range.getEndPosition()) },
          context: { diagnostics, only: context.only ? [context.only] : undefined },
        });
        const actions = [];
        for (const a of res || []) {
          if (!a.edit) continue; // command-only actions need server round-trips we don't support
          const { edits } = await applyWorkspaceEdit(a.edit, true);
          actions.push({ title: a.title, kind: a.kind, isPreferred: a.isPreferred, diagnostics: context.markers, edit: { edits } });
        }
        return { actions, dispose() {} };
      },
    }, { providedCodeActionKinds: ['quickfix', 'refactor', 'source'] });
  }
  if (caps.renameProvider) {
    L.registerRenameProvider(lang, {
      async provideRenameEdits(model, position, newName) {
        const res = await req(model, 'textDocument/rename', { position: toLsp(position), newName });
        return res ? applyWorkspaceEdit(res) : { edits: [] };
      },
    });
  }
}

// Open documents get Monaco edits (undoable); files that aren't open are edited on disk directly.
async function applyWorkspaceEdit(we, openOnly = false) {
  const byUri = {};
  for (const [uri, edits] of Object.entries(we.changes || {})) byUri[uri] = edits;
  for (const dc of we.documentChanges || []) if (dc.textDocument) byUri[dc.textDocument.uri] = dc.edits;
  const edits = [];
  let onDisk = 0;
  for (const [uri, list] of Object.entries(byUri)) {
    const resource = monaco.Uri.parse(uri);
    if (monaco.editor.getModel(resource) || openOnly) {
      for (const e of list) edits.push({ resource, versionId: undefined, textEdit: { range: toRange(e.range), text: e.newText } });
    } else {
      const { content } = await api.fs.readFile(resource.path);
      const lines = content.split('\n');
      const offset = (p) => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
      let text = content;
      for (const e of [...list].sort((a, b) => offset(b.range.start) - offset(a.range.start))) {
        text = text.slice(0, offset(e.range.start)) + e.newText + text.slice(offset(e.range.end));
      }
      await api.fs.writeFile(resource.path, text);
      onDisk++;
    }
  }
  if (onDisk) toast('Rename', `Also updated ${onDisk} file${onDisk > 1 ? 's' : ''} that weren't open.`, 'success', 3000);
  return { edits };
}

// ------------------------------------------------------------ wiring
afterBoot.push(async () => {
  monaco.editor.onDidCreateModel((m) => { if (isFileModel(m)) setTimeout(() => lspOpen(m)); });
  monaco.editor.onWillDisposeModel((m) => { if (isFileModel(m)) lspClose(m); });
  monaco.editor.onDidChangeModelLanguage(({ model }) => { if (isFileModel(model)) lspReopen(model); });
  editor.onDidChangeModel(() => updateLspStatus());
  monaco.editor.onDidChangeMarkers(() => updateProblems());

  // Go to Definition / references into another file opens it as a cnano tab.
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      if (resource.scheme !== 'file') return false;
      const pos = selectionOrPosition && ('startLineNumber' in selectionOrPosition
        ? { line: selectionOrPosition.startLineNumber, col: selectionOrPosition.startColumn }
        : { line: selectionOrPosition.lineNumber, col: selectionOrPosition.column });
      openFile(resource.path, pos ? { line: pos.line, col: pos.col } : {});
      return true;
    },
  });

  cmd('lsp.restart', 'LSP: Restart Language Servers', async () => {
    const models = [...docs.values()].map((d) => d.model);
    for (const m of models) lspClose(m);
    await api.lsp.restart();
    for (const m of models) if (!m.isDisposed()) lspOpen(m);
    toast('Language servers restarted');
  });
  cmd('lsp.status', 'LSP: Show Language Server Status', async () => {
    const avail = await api.lsp.available();
    const names = { clangd: 'C / C++', rust: 'Rust', python: 'Python', asm: 'Assembly' };
    toast('Language servers', Object.entries(avail).map(([k, v]) => `${names[k].padEnd(9)} ${v || 'not installed — run scripts/install-lsp.sh'}`).join('\n'), 'info', 9000);
  });
  cmd('lsp.symbol', 'Go to Symbol in File…', () => editor.getAction('editor.action.quickOutline')?.run(), 'Ctrl+Shift+O');
  cmd('lsp.definition', 'Go to Definition', () => editor.getAction('editor.action.revealDefinition')?.run(), 'F12');
  cmd('lsp.references', 'Find All References', () => editor.getAction('editor.action.goToReferences')?.run(), 'Shift+F12');
  cmd('lsp.rename', 'Rename Symbol', () => editor.getAction('editor.action.rename')?.run(), 'F2');
  cmd('lsp.nextProblem', 'Go to Next Problem', () => editor.getAction('editor.action.marker.next')?.run(), 'F8');
  $('#sb-problems').addEventListener('click', () => { editor.focus(); editor.getAction('editor.action.marker.next')?.run(); });
  $('#sb-lsp').addEventListener('click', () => runCommand('lsp.status'));

  // Models created before this hook ran (files restored at startup).
  for (const m of monaco.editor.getModels()) if (isFileModel(m)) lspOpen(m);
});
