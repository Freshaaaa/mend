// main.ts is mend, the CLI SPEC.md specifies: one command-line tool that applies
// the edits AI models write, in four formats (unified diffs, SEARCH/REPLACE blocks,
// the V4A patch format, and JSON text-editor tool calls), to a tree of text files.
// It finds the lines each edit names at the first of three matching tiers, and
// changes every file or none at all. Node 22, the standard library alone; run it
// as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over.

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

/** A patch's lines: split at `\n`, one trailing `\r` removed, no empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingST = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A file as lines plus its own break and whether it ends with one. */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function fileModel(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function fileText(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/** One line matches at one tier (SPEC.md section 5). */
function lineMatches(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndST(a) === trimEndST(b);
  return trimST(a) === trimST(b);
}

/** Every 0-based position where O occurs in lines at a tier (occurrences may overlap). */
function tierOccurrences(O: string[], lines: string[], tier: number, from: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i += 1) {
    if (eofOnly && i + O.length !== lines.length) continue;
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (!lineMatches(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierResult {
  tier: number;
  occ: number[];
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs, with its positions. */
function findTierOcc(O: string[], lines: string[], strict: boolean, from: number, eofOnly: boolean): TierResult | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = tierOccurrences(O, lines, t, from, eofOnly);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/**
 * Build the replacement lines N for a match at pos: a context line is written as
 * the file's own matched line, never the patch's; at tier 2 every other line is
 * re-indented, replacing O's first line's leading spaces/tabs with the file's.
 */
function emitN(N: string[], ctxN: boolean[], ctxO: boolean[], fileLines: string[], pos: number, tier: number, O: string[]): string[] {
  const out: string[] = [];
  const oCtx: number[] = [];
  for (let j = 0; j < O.length; j += 1) if (ctxO[j]) oCtx.push(j);
  let f = '';
  let p = '';
  if (tier === 2 && O.length > 0) {
    f = leadingST(fileLines[pos]!);
    p = leadingST(O[0]!);
  }
  let ci = 0;
  for (let k = 0; k < N.length; k += 1) {
    if (ctxN[k]) {
      out.push(fileLines[pos + oCtx[ci]!]!);
      ci += 1;
    } else {
      const s = N[k]!;
      if (tier === 2 && O.length > 0 && !/^[ \t]*$/.test(s) && s.startsWith(p)) out.push(f + s.slice(p.length));
      else out.push(s);
    }
  }
  return out;
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

/** A move an edit performed, as [old path, new path]. An edit returns the moves it made. */
type Move = [string, string];
type Edit = (tree: Tree) => Move[];

/** Detect the patch format (SPEC.md section 4), or null when none holds. */
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
      return [];
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
      return [];
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const m = fileModel(before);
      if (line < 0 || line > m.lines.length) throw new Fail('no-match', p);
      m.lines.splice(line, 0, ...add);
      tree.now.set(p, fileText(m));
      return [];
    };
  }
  return null;
}

/** The JSON edits of a patch (SPEC.md section 9). */
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

/* Unified diffs (SPEC.md section 6). */

interface Hunk {
  A: number;
  O: string[];
  N: string[];
  ctxO: boolean[];
  ctxN: boolean[];
  body: string[];
}

interface USection {
  pairOld?: string;
  pairNew?: string;
  renOld?: string;
  renNew?: string;
  diffOld?: string;
  diffNew?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** A `--- ` / `+++ ` path: text after the four characters, up to the first tab, trimmed, one leading `a/` or `b/` removed. */
function patchPath(raw: string): string {
  const p = raw.split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Whether a `\` line follows the hunk's last context or `+` line (no final line break). */
function hunkNoEol(h: Hunk): boolean {
  const b = h.body;
  let last = -1;
  for (let k = 0; k < b.length; k += 1) {
    const l = b[k]!;
    if (l === '' || l.startsWith(' ') || l.startsWith('+')) last = k;
  }
  if (last < 0) return false;
  const nxt = b[last + 1];
  return nxt !== undefined && nxt.startsWith('\\');
}

/** Whether a `\` line follows the last `+` line of a creation, over all its hunks. */
function creationNoEol(hunks: Hunk[]): boolean {
  let found: { h: Hunk; idx: number } | null = null;
  for (const h of hunks) {
    for (let k = 0; k < h.body.length; k += 1) {
      if (h.body[k]!.startsWith('+')) found = { h, idx: k };
    }
  }
  if (found === null) return false;
  const nxt = found.h.body[found.idx + 1];
  return nxt !== undefined && nxt.startsWith('\\');
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  const startSection = (): USection => {
    const s: USection = { newFile: false, delFile: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ') || l === 'diff --git') {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = startSection();
      s.diffOld = m[1];
      s.diffNew = m[2];
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const A = parseInt(m[1]!, 10);
      i += 1;
      const body: string[] = [];
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push(b);
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const O: string[] = [];
      const N: string[] = [];
      const ctxO: boolean[] = [];
      const ctxN: boolean[] = [];
      for (const bl of body) {
        if (bl === '') {
          O.push('');
          N.push('');
          ctxO.push(true);
          ctxN.push(true);
        } else if (bl.startsWith(' ')) {
          O.push(bl.slice(1));
          N.push(bl.slice(1));
          ctxO.push(true);
          ctxN.push(true);
        } else if (bl.startsWith('-')) {
          O.push(bl.slice(1));
          ctxO.push(false);
        } else if (bl.startsWith('+')) {
          N.push(bl.slice(1));
          ctxN.push(false);
        }
      }
      cur.hunks.push({ A, O, N, ctxO, ctxN, body });
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        cur.pairOld = patchPath(l.slice(4));
        cur.pairNew = patchPath(lines[i + 1]!.slice(4));
      } else {
        const s = startSection();
        s.pairOld = patchPath(l.slice(4));
        s.pairNew = patchPath(lines[i + 1]!.slice(4));
      }
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) {
        cur.renOld = l.slice('rename from '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renNew = l.slice('rename to '.length).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.newFile = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.delFile = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(s: USection, strict: boolean): Edit {
  return (tree) => {
    const oldRaw = s.pairOld ?? s.renOld ?? s.diffOld;
    const newRaw = s.pairNew ?? s.renNew ?? s.diffNew;
    const oldNull = s.pairOld === '/dev/null';
    const newNull = s.pairNew === '/dev/null';
    let old: string | null | undefined = oldNull ? null : oldRaw;
    let nw: string | null | undefined = newNull ? null : newRaw;
    if (old === undefined && nw !== undefined) old = nw;
    if (nw === undefined && old !== undefined) nw = old;
    if (old === undefined) old = null;
    if (nw === undefined) nw = null;
    if (old !== null && !safe(old)) throw new Fail('unsafe', old);
    if (nw !== null && !safe(nw)) throw new Fail('unsafe', nw);
    const isCreate = old === null || s.newFile;
    if (isCreate) {
      if (nw === null) throw new Fail('unsafe', '');
      if (tree.get(nw) !== null) throw new Fail('exists', nw);
      const plus: string[] = [];
      for (const h of s.hunks) {
        for (let k = 0; k < h.N.length; k += 1) if (!h.ctxN[k]) plus.push(h.N[k]!);
      }
      const text = plus.length === 0 ? '' : plus.join('\n') + (creationNoEol(s.hunks) ? '' : '\n');
      tree.now.set(nw, text);
      return [];
    }
    const isDelete = nw === null || s.delFile;
    if (isDelete) {
      if (old === null) throw new Fail('unsafe', '');
      if (tree.get(old) === null) throw new Fail('missing', old);
      tree.now.set(old, null);
      return [];
    }
    if (old === null || nw === null) throw new Fail('unsafe', '');
    const before = tree.get(old);
    if (before === null) throw new Fail('missing', old);
    if (old !== nw && tree.get(nw) !== null) throw new Fail('exists', nw);
    const m = fileModel(before);
    let lines = m.lines;
    let final = m.final;
    let d = 0;
    for (const h of s.hunks) {
      if (h.O.length > 0) {
        const found = findTierOcc(h.O, lines, strict, 0, false);
        if (found === null) throw new Fail('no-match', old);
        const target = h.A - 1 + d;
        let pos = found.occ[0]!;
        let bestDist = Math.abs(pos - target);
        for (const p of found.occ) {
          const dist = Math.abs(p - target);
          if (dist < bestDist) {
            pos = p;
            bestDist = dist;
          }
        }
        const rep = emitN(h.N, h.ctxN, h.ctxO, lines, pos, found.tier, h.O);
        const runsToEnd = pos + h.O.length === lines.length;
        lines = [...lines.slice(0, pos), ...rep, ...lines.slice(pos + h.O.length)];
        if (runsToEnd) final = !hunkNoEol(h);
      } else {
        const at = Math.min(Math.max(h.A + d, 0), lines.length);
        const atEnd = at === lines.length;
        lines = [...lines.slice(0, at), ...h.N, ...lines.slice(at)];
        if (atEnd) final = !hunkNoEol(h);
      }
      d += h.N.length - h.O.length;
    }
    const text = fileText({ lines, br: m.br, final });
    if (old !== nw) {
      tree.now.set(old, null);
      tree.now.set(nw, text);
      return [[old, nw]];
    }
    tree.now.set(old, text);
    return [];
  };
}

/* SEARCH/REPLACE blocks (SPEC.md section 7). */

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return [];
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const m = fileModel(before);
    const found = findTierOcc(oldLines, m.lines, strict, 0, false);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const rep = emitN(newLines, newLines.map(() => false), [], m.lines, pos, found.tier, oldLines);
    const lines = [...m.lines.slice(0, pos), ...rep, ...m.lines.slice(pos + oldLines.length)];
    tree.now.set(path, fileText({ lines, br: m.br, final: m.final }));
    return [];
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    let sep = -1;
    for (let k = searchIdx + 1; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        sep = k;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (let k = sep + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevEnd = end;
    prevPath = path;
    i = end + 1;
  }
  return edits;
}

/* V4A patches (SPEC.md section 8). */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: string[];
  ctxO: boolean[];
  ctxN: boolean[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  raw: { text: string; no: number }[];
}

function v4aSectionEdit(sec: VSection, strict: boolean): Edit {
  const raw = [...sec.raw];
  while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
  if (sec.kind === 'add') {
    const fileLines: string[] = [];
    for (const r of raw) {
      if (r.text === '') fileLines.push('');
      else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
      else throw new Exit2(`error: parse ${r.no}`);
    }
    return (tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      return [];
    };
  }
  if (sec.kind === 'delete') {
    for (const r of raw) throw new Exit2(`error: parse ${r.no}`);
    return (tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return [];
    };
  }
  let moveTo: string | null = null;
  const chunks: VChunk[] = [];
  let curChunk: VChunk | null = null;
  for (const r of raw) {
    const l = r.text;
    if (l.startsWith('*** Move to: ')) {
      if (moveTo !== null || chunks.length > 0) throw new Exit2(`error: parse ${r.no}`);
      moveTo = l.slice(l.indexOf(': ') + 2).trim();
      continue;
    }
    if (l === '*** End of File') {
      if (curChunk === null) throw new Exit2(`error: parse ${r.no}`);
      curChunk.eof = true;
      curChunk = null;
      continue;
    }
    if (l.startsWith('@@')) {
      curChunk = { anchor: l.slice(2).trim(), eof: false, O: [], N: [], ctxO: [], ctxN: [] };
      chunks.push(curChunk);
      continue;
    }
    if (l.startsWith('***')) throw new Exit2(`error: parse ${r.no}`);
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (curChunk === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${r.no}`);
        curChunk = { anchor: null, eof: false, O: [], N: [], ctxO: [], ctxN: [] };
        chunks.push(curChunk);
      }
      if (l === '') {
        curChunk.O.push('');
        curChunk.N.push('');
        curChunk.ctxO.push(true);
        curChunk.ctxN.push(true);
      } else if (l.startsWith(' ')) {
        curChunk.O.push(l.slice(1));
        curChunk.N.push(l.slice(1));
        curChunk.ctxO.push(true);
        curChunk.ctxN.push(true);
      } else if (l.startsWith('-')) {
        curChunk.O.push(l.slice(1));
        curChunk.ctxO.push(false);
      } else {
        curChunk.N.push(l.slice(1));
        curChunk.ctxN.push(false);
      }
      continue;
    }
    throw new Exit2(`error: parse ${r.no}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
  return (tree) => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const m = fileModel(before);
    let lines = m.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const found = findTierOcc([ch.anchor], lines, strict, cursor, false);
        if (found === null) throw new Fail('no-match', sec.path);
        cursor = found.occ[0]! + 1;
      }
      if (ch.O.length === 0) {
        const at = ch.eof ? lines.length : cursor;
        lines = [...lines.slice(0, at), ...ch.N, ...lines.slice(at)];
        cursor = at + ch.N.length;
        continue;
      }
      const found = findTierOcc(ch.O, lines, strict, cursor, ch.eof);
      if (found === null) throw new Fail('no-match', sec.path);
      const pos = found.occ[0]!;
      const rep = emitN(ch.N, ch.ctxN, ch.ctxO, lines, pos, found.tier, ch.O);
      lines = [...lines.slice(0, pos), ...rep, ...lines.slice(pos + ch.O.length)];
      cursor = pos + rep.length;
    }
    const text = fileText({ lines, br: m.br, final: m.final });
    if (moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(moveTo, text);
      return [[sec.path, moveTo]];
    }
    tree.now.set(sec.path, text);
    return [];
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let cur: VSection | null = null;
  const finish = (): void => {
    if (cur !== null) {
      edits.push(v4aSectionEdit(cur, strict));
      cur = null;
    }
  };
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      finish();
      const kind = l.startsWith('*** Add') ? 'add' : l.startsWith('*** Delete') ? 'delete' : 'update';
      cur = { kind, path: l.slice(l.indexOf(': ') + 2).trim(), lineNo: i + 1, raw: [] };
      i += 1;
      continue;
    }
    if (cur === null) {
      if (blank(l)) {
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    cur.raw.push({ text: l, no: i + 1 });
    i += 1;
  }
  finish();
  return edits;
}

/* Invocation, output and exit codes (SPEC.md sections 1, 2 and 10). */

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function run(args: string[]): { code: number; out: string[] } {
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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: Move[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      moves.push(...edit(tree));
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const finalState = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const suppressed = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const [old, nw] of moves) {
    if (tree.original(old) !== null && finalState(old) === null && tree.original(nw) === null && finalState(nw) !== null) {
      rows.push({ key: nw, text: `R ${old} -> ${nw}` });
      suppressed.add(old);
      suppressed.add(nw);
    }
  }
  for (const p of [...tree.now.keys()].sort(byteCompare)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (suppressed.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));
  if (!check) {
    const keys = [...tree.now.keys()].sort(byteCompare);
    for (const p of keys) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of keys) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
