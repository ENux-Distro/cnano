/* global monaco, api, state, editor, activeTab, join, debounce, openDiff */
'use strict';
// Git gutter: added / modified / deleted markers against the staged (index) version of the file.

const gutterBase = new Map(); // relPath -> Promise<string|null>  (null = untracked)
let gutterDecos = null;

function invalidateGutterBase() { gutterBase.clear(); }

function baseFor(relPath, status) {
  if (!gutterBase.has(relPath)) {
    gutterBase.set(relPath, status === 'U' ? Promise.resolve(null) : api.git.show(state.git.root, '', relPath));
  }
  return gutterBase.get(relPath);
}

// Myers O(ND) line diff → list of hunks {aStart, aLen, bStart, bLen} (0-based).
function diffLines(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const A = a.slice(start, endA), B = b.slice(start, endB);
  const N = A.length, M = B.length;
  if (!N && !M) return [];
  if (!N || !M || N * M < 4) return [{ aStart: start, aLen: N, bStart: start, bLen: M }];
  const max = N + M, off = max;
  const v = new Int32Array(2 * max + 2);
  const trace = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) { found = true; break; }
    }
    if (d > 4000) return [{ aStart: start, aLen: N, bStart: start, bLen: M }]; // pathological; mark whole region
  }
  // Backtrack into an edit script of matching points.
  const edits = [];
  let x = N, y = M;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vv = trace[d], k = x - y;
    const prevK = k === -d || (k !== d && vv[off + k - 1] < vv[off + k + 1]) ? k + 1 : k - 1;
    const px = vv[off + prevK], py = px - prevK;
    while (x > px && y > py) { x--; y--; }
    if (d > 0) edits.push(x === px ? { type: 'ins', b: py } : { type: 'del', a: px });
    x = px; y = py;
  }
  edits.reverse();
  // Merge consecutive edits into hunks.
  const hunks = [];
  let ai = 0, bi = 0;
  let cur = null;
  for (const e of edits) {
    // Advance through equal lines up to this edit.
    const targetA = e.type === 'del' ? e.a : ai + (e.b - bi);
    const targetB = e.type === 'ins' ? e.b : bi + (e.a - ai);
    if (targetA > ai || targetB > bi) { if (cur) hunks.push(cur); cur = null; ai = targetA; bi = targetB; }
    if (!cur) cur = { aStart: ai + start, aLen: 0, bStart: bi + start, bLen: 0 };
    if (e.type === 'del') { cur.aLen++; ai++; } else { cur.bLen++; bi++; }
  }
  if (cur) hunks.push(cur);
  return hunks;
}

const updateGutter = debounce(async () => {
  if (!editor) return;
  const tab = activeTab();
  const clear = () => { if (gutterDecos) gutterDecos.clear(); };
  const g = state.git;
  if (!tab || tab.diff || !tab.path || !g.repo || !tab.path.startsWith(g.root + '/')) return clear();
  const relPath = tab.path.slice(g.root.length + 1);
  const entry = g.unstaged.find((f) => f.file === relPath);
  if (/(^|\/)\.git\//.test(relPath)) return clear();
  const isIgnoredClean = !entry && !g.staged.some((f) => f.file === relPath);
  const model = tab.model;
  const current = model.getLinesContent();
  let base = await baseFor(relPath, entry && entry.status);
  if (activeTab() !== tab) return;
  // Clean & tracked: base equals disk. Unknown & not in status: maybe ignored → show nothing.
  if (base === '' && isIgnoredClean) base = model.getValue();
  const decos = [];
  if (base === null) {
    decos.push({ range: new monaco.Range(1, 1, current.length, 1), options: deco('added') });
  } else {
    const baseLines = base.split('\n');
    if (current.length > 50000 || baseLines.length > 50000) return clear();
    for (const h of diffLines(baseLines, current)) {
      if (h.bLen === 0) {
        const line = Math.max(1, Math.min(h.bStart, current.length));
        decos.push({ range: new monaco.Range(line, 1, line, 1), options: deco('deleted') });
      } else {
        decos.push({ range: new monaco.Range(h.bStart + 1, 1, h.bStart + h.bLen, 1), options: deco(h.aLen === 0 ? 'added' : 'modified') });
      }
    }
  }
  if (!gutterDecos) gutterDecos = editor.createDecorationsCollection();
  gutterDecos.set(decos);
}, 250);

function deco(kind) {
  const color = { added: '#9ece6a', modified: '#e0af68', deleted: '#f7768e' }[kind];
  return {
    isWholeLine: true,
    linesDecorationsClassName: `gg gg-${kind}`,
    overviewRuler: { color: color + 'aa', position: monaco.editor.OverviewRulerLane.Left },
    minimap: { color: color + '88', position: monaco.editor.MinimapPosition.Gutter },
  };
}

// Clicking a gutter marker opens the diff for this file.
afterBoot.push(() => {
  editor.onMouseDown((e) => {
    if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS) return;
    const el = e.target.element;
    if (!el || !el.classList.contains('gg')) return;
    runCommand('git.diffActive');
  });
});
