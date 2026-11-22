// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** ---- Sections 5 to 8: line matching, unified diffs, SEARCH/REPLACE, V4A. ---- */

/** Moves an edit applied, in patch order: a deletion paired with a creation becomes one R line. */
const recordedMoves: Array<{ old: string; new: string }> = [];

interface FileModel {
  lines: string[];
  br: string;
  ends: boolean;
}

function parseFileModel(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const ends = text.endsWith(br);
  const parts = text.split(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function serializeFileModel(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.ends ? m.br : '');
}

const stripTrailingWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailingWs(a) === stripTrailingWs(b);
  return stripBothWs(a) === stripBothWs(b);
}

function occurrencesAt(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const start = Math.max(0, from);
  for (let i = start; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its positions. */
function firstTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrencesAt(lines, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/**
 * One hunk, chunk or block: old lines O, new lines N. nCtx[i] is the index into O
 * of N's i-th line when it is a context line, else -1.
 */
interface Chunk {
  o: string[];
  n: string[];
  nCtx: number[];
  /** A `\` line follows the chunk's last context or `+` line. */
  noNl: boolean;
  /** A `\` line follows the chunk's last `+` line. */
  noNlPlus: boolean;
  /** The chunk holds at least one `+` line. */
  hasPlus: boolean;
}

/** Lines of N as written over a match at `at`, at the given tier (section 5). */
function replacementLines(model: FileModel, at: number, c: Chunk, tier: number): string[] {
  const f = at < model.lines.length ? leadingWs(model.lines[at]!) : '';
  const p = c.o.length > 0 ? leadingWs(c.o[0]!) : '';
  return c.n.map((ln, i) => {
    const ci = c.nCtx[i]!;
    if (ci >= 0) return model.lines[at + ci]!;
    if (tier === 2 && ln !== '' && ln.trim() !== '' && ln.startsWith(p)) return f + ln.slice(p.length);
    return ln;
  });
}

/** Replace O (non-empty) at `at` by N. When touchEnds, the final break follows section 6 when the match runs to the end. */
function applyChunkAt(model: FileModel, at: number, c: Chunk, tier: number, touchEnds = true): void {
  const rep = replacementLines(model, at, c, tier);
  const runsToEnd = at + c.o.length === model.lines.length;
  model.lines.splice(at, c.o.length, ...rep);
  if (touchEnds && runsToEnd) model.ends = !c.noNl;
}

/** Insert N (O empty) after `at` lines. When touchEnds, the final break follows section 6 when the insertion is at the end. */
function insertChunkAt(model: FileModel, at: number, c: Chunk, touchEnds = true): void {
  const pos = Math.min(Math.max(0, at), model.lines.length);
  const atEnd = pos === model.lines.length;
  model.lines.splice(pos, 0, ...c.n);
  if (touchEnds && atEnd) model.ends = !c.noNl;
}

/** Build a chunk from body lines: ` ` and empty are context, `-` old, `+` new, `\` a no-newline marker. */
function chunkFromBody(body: string[]): Chunk {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: number[] = [];
  let lastKept = -1;
  let lastPlus = -1;
  for (let i = 0; i < body.length; i += 1) {
    const l = body[i]!;
    if (l.startsWith('\\')) continue;
    if (l === '') {
      o.push('');
      n.push('');
      nCtx.push(o.length - 1);
      lastKept = i;
    } else if (l[0] === ' ') {
      const t = l.slice(1);
      o.push(t);
      n.push(t);
      nCtx.push(o.length - 1);
      lastKept = i;
    } else if (l[0] === '-') {
      o.push(l.slice(1));
    } else if (l[0] === '+') {
      n.push(l.slice(1));
      nCtx.push(-1);
      lastKept = i;
      lastPlus = i;
    }
  }
  const noNl = lastKept >= 0 && body[lastKept + 1] !== undefined && body[lastKept + 1]!.startsWith('\\');
  const noNlPlus = lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]!.startsWith('\\');
  return { o, n, nCtx, noNl, noNlPlus, hasPlus: lastPlus >= 0 };
}

/** ---- Section 6: unified diffs. ---- */

interface Hunk {
  a: number;
  chunk: Chunk;
}

interface UnifiedSection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function stripAbPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Path after `--- ` / `+++ `: text after the four characters, up to the first tab, trimmed. Null is /dev/null. */
function headerPath(line: string): string | null {
  const t = line.slice(4).split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  return stripAbPrefix(t);
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseUnified(lines: string[], strict: boolean): Edit[] {
  interface Build {
    pairOld: string | null | undefined;
    pairNew: string | null | undefined;
    renameFrom: string | null;
    renameTo: string | null;
    diffOld: string | null;
    diffNew: string | null;
    create: boolean;
    del: boolean;
    hunks: Hunk[];
  }
  const sections: UnifiedSection[] = [];
  let cur: Build | null = null;
  const finish = (): void => {
    if (cur === null) return;
    const oldP = cur.pairOld !== undefined ? cur.pairOld : cur.renameFrom !== null ? cur.renameFrom : cur.diffOld;
    const newP = cur.pairNew !== undefined ? cur.pairNew : cur.renameTo !== null ? cur.renameTo : cur.diffNew;
    sections.push({
      oldPath: oldP,
      newPath: newP,
      create: oldP === null || cur.create,
      del: newP === null || cur.del,
      hunks: cur.hunks,
    });
    cur = null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${i + 1}`);
      const sep = rest.indexOf(' b/');
      if (sep < 0) throw new Exit2(`error: parse ${i + 1}`);
      const dOld = rest.slice(2, sep);
      const dNew = rest.slice(sep + 3);
      if (dOld === '' || dNew === '') throw new Exit2(`error: parse ${i + 1}`);
      finish();
      cur = { pairOld: undefined, pairNew: undefined, renameFrom: null, renameTo: null, diffOld: dOld, diffNew: dNew, create: false, del: false, hunks: [] };
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && next !== undefined && next.startsWith('+++ ')) {
      const pOld = headerPath(line);
      const pNew = headerPath(next);
      if (cur !== null && cur.hunks.length === 0 && cur.pairOld === undefined) {
        cur.pairOld = pOld;
        cur.pairNew = pNew;
      } else {
        finish();
        cur = { pairOld: pOld, pairNew: pNew, renameFrom: null, renameTo: null, diffOld: null, diffNew: null, create: false, del: false, hunks: [] };
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('--- ') && lines[j + 1] !== undefined && lines[j + 1]!.startsWith('+++ ')) break;
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
          body.push(l);
          j += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ a, chunk: chunkFromBody(body) });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.del = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  finish();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(s: UnifiedSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (s.create) {
      const np = newP ?? '';
      if (np === '') throw new Fail('unsafe', '');
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let noNlPlus = false;
      for (const h of s.hunks) {
        for (let k = 0; k < h.chunk.n.length; k += 1) {
          if (h.chunk.nCtx[k] === -1) plus.push(h.chunk.n[k]!);
        }
        if (h.chunk.hasPlus) noNlPlus = h.chunk.noNlPlus;
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noNlPlus ? '' : '\n'));
      return;
    }
    if (s.del) {
      const op = oldP ?? '';
      if (op === '') throw new Fail('unsafe', '');
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldP ?? '';
    const np = newP ?? '';
    if (op === '' || np === '') throw new Fail('unsafe', op === '' ? op : np);
    const isMove = op !== np;
    if (isMove) {
      if (tree.get(op) === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
    } else if (tree.get(op) === null) {
      throw new Fail('missing', op);
    }
    const model = parseFileModel(tree.get(op)!);
    let d = 0;
    for (const h of s.hunks) {
      if (h.chunk.o.length === 0) {
        insertChunkAt(model, h.a + d, h.chunk);
        d += h.chunk.n.length;
        continue;
      }
      const found = firstTier(model.lines, h.chunk.o, strict, 0);
      if (found === null) throw new Fail('no-match', op);
      const target = h.a - 1 + d;
      let best = found.pos[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      applyChunkAt(model, best, h.chunk, found.tier);
      d += h.chunk.n.length - h.chunk.o.length;
    }
    const out = serializeFileModel(model);
    if (isMove) {
      tree.now.set(op, null);
      tree.now.set(np, out);
      recordedMoves.push({ old: op, new: np });
    } else {
      tree.now.set(op, out);
    }
  };
}

/** ---- Section 7: SEARCH/REPLACE blocks. ---- */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    const searchLine = i + 1;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let end = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine}`);
    let path: string | null = null;
    for (let j = i - 1; j >= searchFrom; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    prevPath = path;
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, end);
    edits.push(srEdit(path, oldLines, newLines, strict));
    searchFrom = end + 1;
    i = end;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = parseFileModel(before);
    const found = firstTier(model.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const at = found.pos[0]!;
    const chunk: Chunk = { o: oldLines, n: newLines, nCtx: newLines.map(() => -1), noNl: false, noNlPlus: false, hasPlus: false };
    const rep = replacementLines(model, at, chunk, found.tier);
    model.lines.splice(at, oldLines.length, ...rep);
    tree.now.set(path, serializeFileModel(model));
  };
}

/** ---- Section 8: V4A patches. ---- */

interface V4aRawChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  chunk: Chunk;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File:')) {
      const path = l.slice('*** Add File:'.length).trim();
      i += 1;
      const body: string[] = [];
      while (i < last) {
        const bl = lines[i]!;
        if (bl.startsWith('*** Add File:') || bl.startsWith('*** Delete File:') || bl.startsWith('*** Update File:') || bl.trim() === '*** End Patch') break;
        if (bl === '') {
          body.push('');
          i += 1;
          continue;
        }
        if (bl.startsWith('+')) {
          body.push(bl.slice(1));
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop();
      const p = path;
      const b = body;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, b.length === 0 ? '' : b.join('\n') + '\n');
      });
      continue;
    }
    if (l.startsWith('*** Delete File:')) {
      const path = l.slice('*** Delete File:'.length).trim();
      i += 1;
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    if (l.startsWith('*** Update File:')) {
      const updateLine = i + 1;
      const path = l.slice('*** Update File:'.length).trim();
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to:')) {
        moveTo = lines[i]!.slice('*** Move to:'.length).trim();
        i += 1;
      }
      const rawChunks: V4aRawChunk[] = [];
      let cur: V4aRawChunk | null = null;
      const flush = (): void => {
        if (cur !== null) {
          rawChunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const bl = lines[i]!;
        if (bl.startsWith('*** Add File:') || bl.startsWith('*** Delete File:') || bl.startsWith('*** Update File:') || bl.trim() === '*** End Patch') break;
        if (bl.startsWith('*** Move to:')) throw new Exit2(`error: parse ${i + 1}`);
        if (bl.trim() === '*** End of File') {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          cur.eof = true;
          flush();
          i += 1;
          continue;
        }
        if (bl.startsWith('*** ')) throw new Exit2(`error: parse ${i + 1}`);
        if (bl.startsWith('@@')) {
          flush();
          cur = { anchor: bl.slice(2).trim(), body: [], eof: false };
          i += 1;
          continue;
        }
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+') {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          cur.body.push(bl);
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      flush();
      if (rawChunks.length > 0) {
        const lb = rawChunks[rawChunks.length - 1]!.body;
        while (lb.length > 0 && lb[lb.length - 1]!.trim() === '') lb.pop();
      }
      if (rawChunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, rawChunks.map((r) => ({ anchor: r.anchor, eof: r.eof, chunk: chunkFromBody(r.body) })), strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = parseFileModel(before);
    let cursor = 0;
    for (const c of chunks) {
      if (c.anchor !== null && c.anchor !== '') {
        const found = firstTier(model.lines, [c.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.pos[0]! + 1;
      }
      if (c.chunk.o.length === 0) {
        const at = c.eof ? model.lines.length : cursor;
        insertChunkAt(model, at, c.chunk, false);
        cursor = at + c.chunk.n.length;
        continue;
      }
      let found: { tier: number; pos: number[] } | null = null;
      if (c.eof) {
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          const pos = occurrencesAt(model.lines, c.chunk.o, t, cursor).filter((p) => p + c.chunk.o.length === model.lines.length);
          if (pos.length > 0) {
            found = { tier: t, pos };
            break;
          }
        }
      } else {
        found = firstTier(model.lines, c.chunk.o, strict, cursor);
      }
      if (found === null) throw new Fail('no-match', path);
      const at = found.pos[0]!;
      applyChunkAt(model, at, c.chunk, found.tier, false);
      cursor = at + c.chunk.n.length;
    }
    const out = serializeFileModel(model);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      recordedMoves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  recordedMoves.length = 0;
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? parseUnified(lines, strict) : kind === 'search-replace' ? parseSearchReplace(lines, strict) : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: Array<{ path: string; now: string | null; row: string }> = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ path: p, now, row: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  // A move pairs one deletion with one creation into a single R line, sorted by the new path.
  const rows: Array<{ key: string; row: string }> = [];
  const paired = new Set<string>();
  for (const m of recordedMoves) {
    const del = changed.find((c) => c.path === m.old && c.row.startsWith('D '));
    const add = changed.find((c) => c.path === m.new && c.row.startsWith('A '));
    if (del !== undefined && add !== undefined) {
      rows.push({ key: m.new, row: `R ${m.old} -> ${m.new}` });
      paired.add(m.old);
      paired.add(m.new);
    }
  }
  for (const c of changed) {
    if (paired.has(c.path)) continue;
    rows.push({ key: c.path, row: c.row });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const c of changed) {
      if (c.now === null) rmSync(c.path, { force: true });
      else {
        mkdirSync(dirname(c.path), { recursive: true });
        writeFileSync(c.path, c.now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.row), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
