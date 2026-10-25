// cnano — AI agent backend: provider adapters, tool execution, approvals, key storage.
const { app, ipcMain, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { spawn, execFile } = require('child_process');

const KEYS_FILE = () => path.join(app.getPath('userData'), 'keys.json');
const OPENAI_COMPAT = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
};
const MAX_TOOL_OUTPUT = 30000;
const MAX_STEPS = 50;

// ---------------------------------------------------------------- keys
async function loadKeys() {
  try { return JSON.parse(await fs.readFile(KEYS_FILE(), 'utf8')); } catch { return {}; }
}
const KEY_ENV = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', openrouter: 'OPENROUTER_API_KEY', nvidia: 'NVIDIA_API_KEY' };
async function getKey(provider) {
  const stored = (await loadKeys())[provider];
  // Fall back to the conventional environment variables (shared with cnano-tui).
  if (!stored) return process.env[KEY_ENV[provider]] || (provider === 'gemini' ? process.env.GOOGLE_API_KEY : null) || null;
  if (stored.enc) return safeStorage.decryptString(Buffer.from(stored.enc, 'base64'));
  return stored.plain || null;
}
async function setKey(provider, key) {
  const keys = await loadKeys();
  if (!key) delete keys[provider];
  else if (safeStorage.isEncryptionAvailable()) keys[provider] = { enc: safeStorage.encryptString(key).toString('base64') };
  else keys[provider] = { plain: key };
  await fs.mkdir(path.dirname(KEYS_FILE()), { recursive: true });
  await fs.writeFile(KEYS_FILE(), JSON.stringify(keys, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------- tools
const TOOLS = [
  {
    name: 'list_files',
    description: 'List files and folders in a directory of the workspace. Use recursive=true for a tree (ignores .git, node_modules, build dirs).',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Directory relative to the workspace root ("." for root).' }, recursive: { type: 'boolean' } }, required: ['path'] },
  },
  {
    name: 'read_file',
    description: 'Read a text file. Returns numbered lines. Optionally pass start_line/end_line (1-based, inclusive) for large files.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['path'] },
  },
  {
    name: 'search',
    description: 'Search file contents in the workspace with a regular expression (grep -E). Returns file:line:text matches.',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Optional subdirectory to search in.' } }, required: ['pattern'] },
  },
  {
    name: 'edit_file',
    description: 'Replace an exact snippet in a file. old_string must appear exactly once in the file; include enough surrounding context to make it unique. Prefer this over write_file for changes to existing files.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] },
  },
  {
    name: 'write_file',
    description: 'Create a new file or completely overwrite an existing one with the given content. Parent folders are created.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'run_command',
    description: 'Run a shell command (bash) in the workspace root, e.g. to build (make, gcc, cargo), run tests, or inspect the system. Returns exit code, stdout and stderr. Times out after 120s; do not start long-running servers.',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
];
const NEEDS_APPROVAL = { edit_file: 'edits', write_file: 'edits', run_command: 'commands' };
const IGNORED = new Set(['.git', 'node_modules', 'target', 'build', '.cache', '__pycache__', '.venv', 'dist']);

const truncate = (s) => (s.length > MAX_TOOL_OUTPUT ? s.slice(0, MAX_TOOL_OUTPUT) + `\n… [truncated ${s.length - MAX_TOOL_OUTPUT} chars]` : s);
const resolvePath = (root, p) => path.resolve(root, p || '.');

async function runTool(name, args, ctx) {
  const root = ctx.root;
  switch (name) {
    case 'list_files': {
      const base = resolvePath(root, args.path);
      const out = [];
      const walk = async (dir, depth) => {
        const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
          if (out.length > 1500) return;
          const r = path.relative(base, path.join(dir, e.name));
          out.push(e.isDirectory() ? r + '/' : r);
          if (e.isDirectory() && args.recursive && !IGNORED.has(e.name) && depth < 12) await walk(path.join(dir, e.name), depth + 1);
        }
      };
      await walk(base, 0);
      return out.join('\n') || '(empty directory)';
    }
    case 'read_file': {
      const text = await fs.readFile(resolvePath(root, args.path), 'utf8');
      const lines = text.split('\n');
      const s = Math.max(1, args.start_line || 1), e = Math.min(lines.length, args.end_line || lines.length);
      return truncate(lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(5)}\t${l}`).join('\n'));
    }
    case 'search': {
      const target = resolvePath(root, args.path);
      return new Promise((resolve) => {
        execFile('grep', ['-rnIE', '--exclude-dir=.git', '--exclude-dir=node_modules', '--exclude-dir=target', '--exclude-dir=build', '-m', '30', '--', args.pattern, target],
          { maxBuffer: 16 * 1024 * 1024, timeout: 30000 }, (err, stdout) => {
            const lines = stdout.split('\n').filter(Boolean).slice(0, 300).map((l) => l.startsWith(root + '/') ? l.slice(root.length + 1) : l);
            resolve(lines.length ? truncate(lines.map((l) => l.slice(0, 400)).join('\n')) : 'No matches.');
          });
      });
    }
    case 'edit_file': {
      const p = resolvePath(root, args.path);
      const text = await fs.readFile(p, 'utf8');
      const count = text.split(args.old_string).length - 1;
      if (count === 0) throw new Error('old_string not found in file. Re-read the file and copy the snippet exactly (including whitespace).');
      if (count > 1) throw new Error(`old_string appears ${count} times; include more context so it is unique.`);
      await fs.writeFile(p, text.replace(args.old_string, () => args.new_string));
      ctx.emit({ type: 'file_changed', path: p });
      return `Edited ${args.path}.`;
    }
    case 'write_file': {
      const p = resolvePath(root, args.path);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, args.content);
      ctx.emit({ type: 'file_changed', path: p });
      return `Wrote ${args.content.split('\n').length} lines to ${args.path}.`;
    }
    case 'run_command':
      return new Promise((resolve) => {
        const child = spawn('bash', ['-lc', args.command], { cwd: root, env: { ...process.env, TERM: 'dumb', GIT_TERMINAL_PROMPT: '0' } });
        let out = '';
        const add = (d) => { out += d; if (out.length > MAX_TOOL_OUTPUT * 2) out = out.slice(-MAX_TOOL_OUTPUT * 2); };
        child.stdout.on('data', add); child.stderr.on('data', add);
        const timer = setTimeout(() => { out += '\n[timed out after 120s, killed]'; child.kill('SIGKILL'); }, 120000);
        ctx.signal.addEventListener('abort', () => child.kill('SIGKILL'));
        child.on('close', (code) => { clearTimeout(timer); resolve(truncate(`exit code: ${code}\n${out}`)); });
      });
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

// ---------------------------------------------------------------- SSE helper
async function* sse(res) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try { yield JSON.parse(data); } catch { /* keep-alive / partial */ }
    }
  }
}

async function httpError(res) {
  let body = await res.text();
  try { const j = JSON.parse(body); body = (j.error && (j.error.message || JSON.stringify(j.error))) || body; } catch { /* raw */ }
  return new Error(`HTTP ${res.status}: ${body.slice(0, 800)}`);
}

// ---------------------------------------------------------------- provider adapters
// Neutral history: {role:'user', text} | {role:'assistant', text, calls:[{id,name,args}], raw?} | {role:'tool', id, name, result}

async function callAnthropic({ key, model, system, history, onText, signal }) {
  const messages = [];
  for (const h of history) {
    if (h.role === 'user') messages.push({ role: 'user', content: h.text });
    else if (h.role === 'assistant') {
      const content = [];
      if (h.text) content.push({ type: 'text', text: h.text });
      for (const c of h.calls) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
      messages.push({ role: 'assistant', content });
    } else {
      const block = { type: 'tool_result', tool_use_id: h.id, content: h.result, is_error: !!h.error };
      const last = messages[messages.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content[0]?.type === 'tool_result') last.content.push(block);
      else messages.push({ role: 'user', content: [block] });
    }
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model, max_tokens: 16000, stream: true,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
      messages,
    }),
  });
  if (!res.ok) throw await httpError(res);
  let text = '';
  const blocks = {};
  for await (const ev of sse(res)) {
    if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') blocks[ev.index] = { id: ev.content_block.id, name: ev.content_block.name, json: '' };
    else if (ev.type === 'content_block_delta') {
      if (ev.delta.type === 'text_delta') { text += ev.delta.text; onText(ev.delta.text); }
      else if (ev.delta.type === 'input_json_delta') blocks[ev.index].json += ev.delta.partial_json;
    } else if (ev.type === 'error') throw new Error(ev.error?.message || 'stream error');
  }
  const calls = Object.values(blocks).map((b) => ({ id: b.id, name: b.name, args: b.json ? JSON.parse(b.json) : {} }));
  return { text, calls };
}

async function callOpenAICompat({ provider, key, model, system, history, onText, signal }) {
  const messages = [{ role: 'system', content: system }];
  for (const h of history) {
    if (h.role === 'user') messages.push({ role: 'user', content: h.text });
    else if (h.role === 'assistant') {
      const m = { role: 'assistant', content: h.text || null };
      if (h.calls.length) m.tool_calls = h.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      messages.push(m);
    } else messages.push({ role: 'tool', tool_call_id: h.id, content: h.result });
  }
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
  if (provider === 'openrouter') { headers['HTTP-Referer'] = 'https://github.com/cnano'; headers['X-Title'] = 'cnano'; }
  const res = await fetch(`${OPENAI_COMPAT[provider]}/chat/completions`, {
    method: 'POST', signal, headers,
    body: JSON.stringify({
      model, stream: true, messages,
      tools: TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
    }),
  });
  if (!res.ok) throw await httpError(res);
  let text = '';
  const calls = [];
  for await (const ev of sse(res)) {
    if (ev.error) throw new Error(ev.error.message || JSON.stringify(ev.error));
    const d = ev.choices && ev.choices[0] && ev.choices[0].delta;
    if (!d) continue;
    if (d.content) { text += d.content; onText(d.content); }
    for (const tc of d.tool_calls || []) {
      const i = tc.index ?? calls.length;
      calls[i] = calls[i] || { id: '', name: '', json: '' };
      if (tc.id) calls[i].id = tc.id;
      if (tc.function?.name) calls[i].name += tc.function.name;
      if (tc.function?.arguments) calls[i].json += tc.function.arguments;
    }
  }
  return {
    text,
    calls: calls.filter(Boolean).map((c, i) => ({ id: c.id || `call_${Date.now()}_${i}`, name: c.name, args: c.json ? JSON.parse(c.json) : {} })),
  };
}

async function callGemini({ key, model, system, history, onText, signal }) {
  const contents = [];
  for (const h of history) {
    if (h.role === 'user') contents.push({ role: 'user', parts: [{ text: h.text }] });
    else if (h.role === 'assistant') {
      // Replay the raw parts so thought signatures survive across tool turns.
      contents.push({ role: 'model', parts: h.raw || [...(h.text ? [{ text: h.text }] : []), ...h.calls.map((c) => ({ functionCall: { name: c.name, args: c.args } }))] });
    } else {
      const part = { functionResponse: { name: h.name, response: { result: h.result } } };
      const last = contents[contents.length - 1];
      if (last && last.role === 'user' && last.parts[0]?.functionResponse) last.parts.push(part);
      else contents.push({ role: 'user', parts: [part] });
    }
  }
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools: [{ functionDeclarations: TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }],
    }),
  });
  if (!res.ok) throw await httpError(res);
  let text = '';
  const raw = [], calls = [];
  for await (const ev of sse(res)) {
    if (ev.error) throw new Error(ev.error.message);
    for (const part of ev.candidates?.[0]?.content?.parts || []) {
      raw.push(part);
      if (part.text && !part.thought) { text += part.text; onText(part.text); }
      if (part.functionCall) calls.push({ id: `g_${Date.now()}_${calls.length}`, name: part.functionCall.name, args: part.functionCall.args || {} });
    }
  }
  return { text, calls, raw };
}

// ---------------------------------------------------------------- model lists
const CLAUDE_CLI_MODELS = ['default', 'opus', 'sonnet', 'haiku', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

async function listModels(provider) {
  if (provider === 'claude-cli') return CLAUDE_CLI_MODELS;
  const key = await getKey(provider);
  if (!key) throw new Error('No API key set for this provider.');
  if (provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
    if (!res.ok) throw await httpError(res);
    return (await res.json()).data.map((m) => m.id);
  }
  if (provider === 'gemini') {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
    if (!res.ok) throw await httpError(res);
    return (await res.json()).models.filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).map((m) => m.name.replace(/^models\//, ''));
  }
  const res = await fetch(`${OPENAI_COMPAT[provider]}/models`, { headers: { authorization: `Bearer ${key}` } });
  if (!res.ok) throw await httpError(res);
  let ids = (await res.json()).data.map((m) => m.id);
  if (provider === 'openai') ids = ids.filter((id) => /^(gpt|o\d|chatgpt|codex)/.test(id) && !/(audio|realtime|tts|transcribe|image|search)/.test(id));
  return ids.sort();
}

// ---------------------------------------------------------------- runs
function systemPrompt(root) {
  return `You are cnano's coding agent, embedded in a desktop code editor. The user mostly writes C, C++, Assembly and shell scripts (bash/sh), sometimes Rust and Python.
Workspace root: ${root}
Platform: ${process.platform}. Today: ${new Date().toISOString().slice(0, 10)}.

Work like a careful senior engineer:
- Explore with list_files / search / read_file before changing code. Never guess file contents.
- Make focused changes with edit_file; use write_file for new files.
- After changing code, build or test with run_command when that's possible (e.g. make, gcc -Wall -Wextra, cargo build, shellcheck).
- Keep answers concise. Use Markdown; put code in fenced blocks with a language tag.
- Paths are relative to the workspace root.`;
}

const runs = new Map();      // runId -> { abort }
const approvals = new Map(); // approvalId -> resolve
const chats = new Map();     // chatId -> { history, claudeSession }

function chat(id) {
  if (!chats.has(id)) chats.set(id, { history: [], claudeSession: null });
  return chats.get(id);
}

// Every tool call must be answered before the next request, or providers reject the history.
function repairHistory(history) {
  const answered = new Set(history.filter((h) => h.role === 'tool').map((h) => h.id));
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.role !== 'assistant') continue;
    const missing = h.calls.filter((c) => !answered.has(c.id));
    history.splice(i + 1 + h.calls.length - missing.length, 0,
      ...missing.map((c) => ({ role: 'tool', id: c.id, name: c.name, result: 'Cancelled by user.', error: true })));
    break;
  }
}

async function runApiAgent(cfg, text, emit, signal) {
  try { await apiLoop(cfg, text, emit, signal); } finally { repairHistory(chat(cfg.chatId).history); }
}

async function apiLoop(cfg, text, emit, signal) {
  const key = await getKey(cfg.provider);
  if (!key) throw new Error(`No API key for ${cfg.provider}. Add one in the agent settings (gear icon).`);
  const c = chat(cfg.chatId);
  c.history.push({ role: 'user', text });
  const system = systemPrompt(cfg.root);
  const call = cfg.provider === 'anthropic' ? callAnthropic : cfg.provider === 'gemini' ? callGemini : callOpenAICompat;
  for (let step = 0; step < MAX_STEPS; step++) {
    emit({ type: 'step_start' });
    const r = await call({ provider: cfg.provider, key, model: cfg.model, system, history: c.history, signal, onText: (t) => emit({ type: 'text', text: t }) });
    c.history.push({ role: 'assistant', text: r.text, calls: r.calls, raw: r.raw });
    if (!r.calls.length) return;
    for (const tc of r.calls) {
      emit({ type: 'tool_call', id: tc.id, name: tc.name, args: tc.args });
      const kind = NEEDS_APPROVAL[tc.name];
      let approved = true;
      if (kind && !cfg.autoApprove?.[kind]) {
        let preview = null;
        if (tc.name === 'edit_file' || tc.name === 'write_file') {
          try { preview = { before: await fs.readFile(resolvePath(cfg.root, tc.args.path), 'utf8') }; } catch { preview = { before: '' }; }
        }
        const approvalId = `${tc.id}_a`;
        emit({ type: 'approval', id: tc.id, approvalId, name: tc.name, args: tc.args, preview });
        approved = await new Promise((resolve) => {
          approvals.set(approvalId, resolve);
          signal.addEventListener('abort', () => resolve(false));
        });
        approvals.delete(approvalId);
      }
      let result, error = false;
      if (signal.aborted) { result = 'Cancelled by user.'; error = true; }
      else if (!approved) { result = 'The user declined this action. Ask them how to proceed or try a different approach.'; error = true; }
      else {
        try { result = await runTool(tc.name, tc.args || {}, { root: cfg.root, emit, signal }); } catch (err) { result = `Error: ${err.message}`; error = true; }
      }
      c.history.push({ role: 'tool', id: tc.id, name: tc.name, result, error });
      emit({ type: 'tool_result', id: tc.id, result, error, declined: !approved });
    }
    if (signal.aborted) return;
  }
  emit({ type: 'text', text: `\n\n_Stopped after ${MAX_STEPS} steps._` });
}

function runClaudeCli(cfg, text, emit, signal) {
  const c = chat(cfg.chatId);
  const args = ['-p', text, '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-mode', cfg.claudePermissionMode || 'acceptEdits'];
  if (cfg.model && cfg.model !== 'default') args.push('--model', cfg.model);
  if (c.claudeSession) args.push('--resume', c.claudeSession);
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd: cfg.root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    signal.addEventListener('abort', () => child.kill('SIGTERM'));
    const toolInputs = {};
    let buf = '', stderr = '', resultSeen = false;
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.session_id) c.claudeSession = ev.session_id;
        // Sub-agent chatter is skipped; only the main thread is shown.
        if (ev.parent_tool_use_id) continue;
        if (ev.type === 'stream_event') {
          const e = ev.event;
          if (e.type === 'message_start') emit({ type: 'step_start' });
          if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') emit({ type: 'text', text: e.delta.text });
        } else if (ev.type === 'assistant') {
          for (const b of ev.message.content || []) {
            if (b.type === 'tool_use') { toolInputs[b.id] = b; emit({ type: 'tool_call', id: b.id, name: b.name, args: b.input }); }
          }
        } else if (ev.type === 'user') {
          for (const b of (ev.message && ev.message.content) || []) {
            if (b.type !== 'tool_result') continue;
            const out = Array.isArray(b.content) ? b.content.map((x) => x.text || '').join('\n') : String(b.content ?? '');
            emit({ type: 'tool_result', id: b.tool_use_id, result: truncate(out), error: !!b.is_error });
            const t = toolInputs[b.tool_use_id];
            const fp = t && t.input && (t.input.file_path || t.input.notebook_path);
            if (fp && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(t.name)) emit({ type: 'file_changed', path: path.resolve(cfg.root, fp) });
          }
        } else if (ev.type === 'result') {
          resultSeen = true;
          const denials = (ev.permission_denials || []).map((p) => p.tool_name);
          emit({ type: 'usage', cost: ev.total_cost_usd, turns: ev.num_turns, denials });
          if (ev.is_error && ev.result) emit({ type: 'text', text: `\n\n**Error:** ${ev.result}` });
        }
      }
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => reject(new Error(`Could not start \`claude\`: ${err.message}. Is Claude Code installed and on PATH?`)));
    child.on('close', (code) => {
      if (signal.aborted || code === 0 || resultSeen) resolve();
      else reject(new Error(stderr.trim() || `claude exited with code ${code}`));
    });
  });
}

function register(getWin) {
  ipcMain.handle('agent:keys', async () => {
    const keys = await loadKeys();
    const fromEnv = Object.keys(KEY_ENV).filter((p) => process.env[KEY_ENV[p]]);
    return { providers: [...new Set([...Object.keys(keys), ...fromEnv])], encrypted: safeStorage.isEncryptionAvailable() };
  });
  ipcMain.handle('agent:setKey', (_e, provider, key) => setKey(provider, key));
  ipcMain.handle('agent:models', (_e, provider) => listModels(provider));
  ipcMain.handle('agent:reset', (_e, chatId) => { chats.delete(chatId); });
  ipcMain.on('agent:approve', (_e, approvalId, ok) => { const r = approvals.get(approvalId); if (r) r(ok); });
  ipcMain.on('agent:stop', (_e, runId) => { const r = runs.get(runId); if (r) r.abort(); });
  ipcMain.handle('agent:send', async (_e, runId, cfg, text) => {
    const controller = new AbortController();
    runs.set(runId, controller);
    const emit = (ev) => { const w = getWin(); if (w && !w.isDestroyed()) w.webContents.send('agent:event', runId, ev); };
    try {
      if (cfg.provider === 'claude-cli') await runClaudeCli(cfg, text, emit, controller.signal);
      else await runApiAgent(cfg, text, emit, controller.signal);
      emit({ type: 'done', aborted: controller.signal.aborted });
    } catch (err) {
      if (controller.signal.aborted || err.name === 'AbortError') emit({ type: 'done', aborted: true });
      else { emit({ type: 'error', message: err.message }); emit({ type: 'done' }); }
    } finally {
      runs.delete(runId);
    }
  });
}

module.exports = { register };
