// mend: one patch tool for every AI edit format (SPEC.md version 1).
// Reads unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits,
// matches the lines each edit names at the first of three tiers, and writes
// every change or none. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

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
  readonly moves: Array<[string, string]> = [];
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

// ---------- Shared line helpers (SPEC.md sections 3 and 5) ----------

interface FileParts {
  lines: string[];
  br: string;
  eol: boolean;
}

/** Split a file's text into its lines, its line break, and whether it ends with one. */
function fileParts(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', eol: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const eol = text.endsWith(br);
  if (eol) lines.pop();
  return { lines, br, eol };
}

function joinParts(lines: string[], br: string, eol: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (eol ? br : '');
}

const trimEndWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWS(a) === trimEndWS(b);
  return trimWS(a) === trimWS(b);
}

/** Positions where O occurs in lines at one tier, at or after `from`. */
function occurrences(lines: string[], O: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!tierEq(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its positions, or null. */
function firstTier(lines: string[], O: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, O, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `from` equal to a single-line anchor, or null. */
function firstTierSingle(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (tierEq(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

type OpKind = 'ctx' | 'old' | 'new';
interface Op {
  k: OpKind;
  text: string;
}

/**
 * Replace O (the ctx+old ops) at `at` with N (the ctx+new ops), per section 5:
 * a context line is written as the file's own matched line; at tier 2 every
 * other line of N is re-indented from O's first line to the file's.
 */
function applyOps(lines: string[], at: number, ops: Op[], tier: number): string[] {
  const O = ops.filter((o) => o.k !== 'new').map((o) => o.text);
  const out = lines.slice(0, at);
  let F = '';
  let P = '';
  if (tier === 2 && O.length > 0) {
    F = leadWS(lines[at]!);
    P = leadWS(O[0]!);
  }
  let oi = 0;
  for (const op of ops) {
    if (op.k === 'ctx') {
      out.push(lines[at + oi]!);
      oi += 1;
    } else if (op.k === 'old') {
      oi += 1;
    } else {
      let t = op.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  out.push(...lines.slice(at + O.length));
  return out;
}

/** Insert only the new lines of ops at `at` (for an empty O). */
function insertOps(lines: string[], at: number, ops: Op[]): string[] {
  const add: string[] = [];
  for (const op of ops) {
    if (op.k === 'new') add.push(op.text);
  }
  return [...lines.slice(0, at), ...add, ...lines.slice(at)];
}

// ---------- Unified diffs (SPEC.md section 6) ----------

interface Hunk {
  a: number;
  ops: Op[];
  oLen: number;
  nLen: number;
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line (for creations). */
  noEolNew: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function parseHunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
  return m === null ? null : Number(m[1]);
}

/** A `--- `/`+++ ` path: text after the four characters, up to the first tab, trimmed; /dev/null means no file. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const newSection = (oldP: string | null, newP: string | null, hasPair: boolean): void => {
    cur = { oldPath: oldP, newPath: newP, hasPair, renameFrom: null, renameTo: null, create: false, del: false, hunks: [] };
    sections.push(cur);
    inHeader = true;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      newSection(m[1]!, m[2]!, false);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        cur.oldPath = headerPath(line);
        cur.newPath = headerPath(lines[i + 1]!);
        cur.hasPair = true;
      } else {
        newSection(headerPath(line), headerPath(lines[i + 1]!), true);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const a = parseHunkHeader(line);
      if (cur === null || a === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: Array<{ k: 'ctx' | 'old' | 'new' | 'bs'; text: string; raw: string }> = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          body.push({ k: 'ctx', text: '', raw: bl });
          j += 1;
          continue;
        }
        const c = bl[0]!;
        if (c === ' ') {
          body.push({ k: 'ctx', text: bl.slice(1), raw: bl });
          j += 1;
          continue;
        }
        if (c === '-') {
          body.push({ k: 'old', text: bl.slice(1), raw: bl });
          j += 1;
          continue;
        }
        if (c === '+') {
          body.push({ k: 'new', text: bl.slice(1), raw: bl });
          j += 1;
          continue;
        }
        if (c === '\\') {
          body.push({ k: 'bs', text: bl, raw: bl });
          j += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
      const followsBs = (pred: (b: (typeof body)[number]) => boolean): boolean => {
        for (let k = body.length - 1; k >= 0; k--) {
          if (pred(body[k]!)) return k + 1 < body.length && body[k + 1]!.k === 'bs';
        }
        return false;
      };
      const noEol = followsBs((b) => b.k === 'ctx' || b.k === 'new');
      const noEolNew = followsBs((b) => b.k === 'new');
      const ops: Op[] = body.filter((b) => b.k !== 'bs').map((b) => ({ k: b.k as OpKind, text: b.text }));
      cur.hunks.push({
        a,
        ops,
        oLen: ops.filter((o) => o.k !== 'new').length,
        nLen: ops.filter((o) => o.k !== 'old').length,
        noEol,
        noEolNew,
      });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line === 'new file mode' || line.startsWith('new file mode ')) cur.create = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) cur.del = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections;
}

/** Apply one hunk to a file's lines, honouring the nearest-occurrence rule and the final-break rule. */
function applyHunk(lines: string[], eol: boolean, h: Hunk, d: number, strict: boolean, path: string): { lines: string[]; eol: boolean } {
  if (h.oLen === 0) {
    const pos = Math.max(0, Math.min(h.a + d, lines.length));
    return { lines: insertOps(lines, pos, h.ops), eol: pos === lines.length ? !h.noEol : eol };
  }
  const O = h.ops.filter((o) => o.k !== 'new').map((o) => o.text);
  const found = firstTier(lines, O, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.occ[0]!;
  let bestDist = Math.abs(best - target);
  for (const o of found.occ) {
    const dist = Math.abs(o - target);
    if (dist < bestDist) {
      best = o;
      bestDist = dist;
    }
  }
  const atEnd = best + O.length === lines.length;
  return { lines: applyOps(lines, best, h.ops, found.tier), eol: atEnd ? !h.noEol : eol };
}

function unifiedEdits(sections: Section[], strict: boolean): Edit[] {
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    const oldP = sec.hasPair ? sec.oldPath : (sec.renameFrom ?? sec.oldPath);
    const newP = sec.hasPair ? sec.newPath : (sec.renameTo ?? sec.newPath);
    return (tree: Tree) => {
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
      const isCreate = (oldP === null && newP !== null) || sec.create;
      const isDelete = (newP === null && oldP !== null) || sec.del;
      if (isCreate) {
        const np = newP!;
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const plus: string[] = [];
        for (const h of sec.hunks) for (const op of h.ops) if (op.k === 'new') plus.push(op.text);
        let noEol = false;
        for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
          if (sec.hunks[hi]!.ops.some((o) => o.k === 'new')) {
            noEol = sec.hunks[hi]!.noEolNew;
            break;
          }
        }
        tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
        return;
      }
      if (isDelete) {
        const op = oldP!;
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
        return;
      }
      const isMove = oldP !== null && newP !== null && oldP !== newP;
      if (isMove) {
        if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
        if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
        let parts = fileParts(tree.get(oldP!)!);
        let d = 0;
        for (const h of sec.hunks) {
          const r = applyHunk(parts.lines, parts.eol, h, d, strict, oldP!);
          parts = { lines: r.lines, br: parts.br, eol: r.eol };
          d += h.nLen - h.oLen;
        }
        tree.now.set(oldP!, null);
        tree.now.set(newP!, joinParts(parts.lines, parts.br, parts.eol));
        tree.moves.push([oldP!, newP!]);
        return;
      }
      const p = oldP ?? newP!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      let parts = fileParts(tree.get(p)!);
      let d = 0;
      for (const h of sec.hunks) {
        const r = applyHunk(parts.lines, parts.eol, h, d, strict, p);
        parts = { lines: r.lines, br: parts.br, eol: r.eol };
        d += h.nLen - h.oLen;
      }
      tree.now.set(p, joinParts(parts.lines, parts.br, parts.eol));
    };
  });
}

// ---------- SEARCH/REPLACE blocks (SPEC.md section 7) ----------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const parts = fileParts(cur);
    const found = firstTier(parts.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const ops: Op[] = [
      ...oldLines.map((t): Op => ({ k: 'old', text: t })),
      ...newLines.map((t): Op => ({ k: 'new', text: t })),
    ];
    tree.now.set(path, joinParts(applyOps(parts.lines, found.occ[0]!, ops, found.tier), parts.br, parts.eol));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  for (;;) {
    let s = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    edits.push(srEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------- V4A patches (SPEC.md section 8) ----------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  ops: Op[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  fileLines: string[];
  chunks: VChunk[];
}

function parseV4a(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    while (i < last && blank(lines[i]!)) i++;
    if (i >= last) break;
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const updateLine = i + 1;
    i += 1;
    const raw: Array<{ text: string; num: number }> = [];
    while (i < last) {
      const l = lines[i]!;
      if (isSectionStart(l)) break;
      raw.push({ text: l, num: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.num}`);
      }
      sections.push({ kind, path, moveTo: null, fileLines, chunks: [] });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.num}`);
      sections.push({ kind, path, moveTo: null, fileLines: [], chunks: [] });
    } else {
      let moveTo: string | null = null;
      let rest = raw;
      if (rest.length > 0 && rest[0]!.text.startsWith('*** Move to: ')) {
        moveTo = rest[0]!.text.slice('*** Move to: '.length).trim();
        rest = rest.slice(1);
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (const r of rest) {
        const t = r.text;
        if (t.startsWith('@@')) {
          cur = { anchor: t.slice(2).trim(), eof: false, ops: [] };
          chunks.push(cur);
          continue;
        }
        if (t === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.num}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (cur === null) {
            if (chunks.length === 0) {
              cur = { anchor: null, eof: false, ops: [] };
              chunks.push(cur);
            } else {
              throw new Exit2(`error: parse ${r.num}`);
            }
          }
          const k: OpKind = t === '' || t[0] === ' ' ? 'ctx' : t[0] === '-' ? 'old' : 'new';
          cur.ops.push({ k, text: t === '' ? '' : t.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${r.num}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      sections.push({ kind, path, moveTo, fileLines: [], chunks });
    }
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections;
}

function v4aEdits(sections: VSection[], strict: boolean): Edit[] {
  return sections.map((sec) => {
    if (sec.kind === 'add') {
      return (tree: Tree) => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        tree.now.set(sec.path, sec.fileLines.length === 0 ? '' : sec.fileLines.join('\n') + '\n');
      };
    }
    if (sec.kind === 'delete') {
      return (tree: Tree) => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
      };
    }
    return (tree: Tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      const cur = tree.get(sec.path);
      if (cur === null) throw new Fail('missing', sec.path);
      if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
      let parts = fileParts(cur);
      let cursor = 0;
      for (const chunk of sec.chunks) {
        if (chunk.anchor !== null && chunk.anchor !== '') {
          const found = firstTierSingle(parts.lines, chunk.anchor, strict, cursor);
          if (found === null) throw new Fail('no-match', sec.path);
          cursor = found + 1;
        }
        const O = chunk.ops.filter((o) => o.k !== 'new').map((o) => o.text);
        const nLen = chunk.ops.filter((o) => o.k !== 'old').length;
        if (O.length === 0) {
          const pos = chunk.eof ? parts.lines.length : cursor;
          parts = { lines: insertOps(parts.lines, pos, chunk.ops), br: parts.br, eol: parts.eol };
          cursor = pos + nLen;
        } else if (chunk.eof) {
          const p = parts.lines.length - O.length;
          if (p < cursor) throw new Fail('no-match', sec.path);
          let tierFound: number | null = null;
          for (const t of strict ? [0] : [0, 1, 2]) {
            let ok = true;
            for (let j = 0; j < O.length; j++) {
              if (!tierEq(parts.lines[p + j]!, O[j]!, t)) {
                ok = false;
                break;
              }
            }
            if (ok) {
              tierFound = t;
              break;
            }
          }
          if (tierFound === null) throw new Fail('no-match', sec.path);
          parts = { lines: applyOps(parts.lines, p, chunk.ops, tierFound), br: parts.br, eol: parts.eol };
          cursor = p + nLen;
        } else {
          const found = firstTier(parts.lines, O, strict, cursor);
          if (found === null) throw new Fail('no-match', sec.path);
          const at = found.occ[0]!;
          parts = { lines: applyOps(parts.lines, at, chunk.ops, found.tier), br: parts.br, eol: parts.eol };
          cursor = at + nLen;
        }
      }
      const text = joinParts(parts.lines, parts.br, parts.eol);
      if (sec.moveTo !== null) {
        tree.now.set(sec.path, null);
        tree.now.set(sec.moveTo, text);
        tree.moves.push([sec.path, sec.moveTo]);
      } else {
        tree.now.set(sec.path, text);
      }
    };
  });
}

// ---------- Run (SPEC.md sections 1, 2 and 10) ----------

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
  // A patch saved with a UTF-8 byte-order mark (some editors add one) is the
  // same patch: drop the mark so format detection sees the first line as-is.
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(parseUnified(lines), strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(parseV4a(lines), strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; text: string }> = [];
  const suppressed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      suppressed.add(`D:${oldP}`);
      suppressed.add(`A:${newP}`);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const kindRow = was === null ? 'A' : now === null ? 'D' : 'M';
    if (suppressed.has(`${kindRow}:${p}`)) continue;
    rows.push({ key: p, text: `${kindRow} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const texts = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
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
