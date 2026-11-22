// main.ts — mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// mend applies an edit that an AI model wrote to a tree of text files, in one of four formats: a unified diff
// (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON.
// Each edit names old lines O that are found in the file at the first of three matching tiers (exact; trailing
// whitespace ignored; leading and trailing whitespace ignored), and every file is changed or nothing is.
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
  recordMove(oldP: string, newP: string): void {
    this.moves.push([oldP, newP]);
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

/** A file's lines, its line break and whether it ends with one (SPEC.md section 3). */
interface FileState {
  lines: string[];
  br: string;
  ends: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const ends = text.endsWith(br);
  if (ends) parts.pop();
  return { lines: parts, br, ends };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.ends ? f.br : '');
}

const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const keyAt = (line: string, tier: number): string => (tier === 0 ? line : tier === 1 ? trimEndST(line) : trimST(line));

/** Positions where O occurs in `lines` at `tier`, at or after `from`. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const k = o.length;
  if (k === 0) return out;
  for (let i = Math.max(0, from); i + k <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < k; j += 1) {
      if (keyAt(lines[i + j]!, tier) !== keyAt(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function tierList(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** The first tier at which O occurs at least once, with its occurrences, or null. */
function findTier(lines: string[], o: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  for (const t of tierList(strict)) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NLine {
  ctx?: number;
  text?: string;
}

/** N with context lines taken from the file and, at tier 2, the other lines re-indented (section 5). */
function buildN(fileLines: string[], at: number, o: string[], n: NLine[], tier: number): string[] {
  const out: string[] = [];
  const f = leadST(fileLines[at]!);
  const p = leadST(o[0]!);
  for (const item of n) {
    if (item.ctx !== undefined) {
      out.push(fileLines[at + item.ctx]!);
      continue;
    }
    let line = item.text!;
    if (tier === 2 && line !== '' && !/^[ \t]+$/.test(line) && line.startsWith(p)) line = f + line.slice(p.length);
    out.push(line);
  }
  return out;
}

/** O and N of a hunk or chunk body: context and `-` lines are O, context and `+` lines are N. */
function bodyON(body: string[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const bl of body) {
    if (bl.startsWith(' ')) {
      const t = bl.slice(1);
      o.push(t);
      n.push({ ctx: o.length - 1 });
    } else if (bl === '') {
      o.push('');
      n.push({ ctx: o.length - 1 });
    } else if (bl.startsWith('-')) {
      o.push(bl.slice(1));
    } else if (bl.startsWith('+')) {
      n.push({ text: bl.slice(1) });
    }
  }
  return { o, n };
}

/** Whether a `\` line follows the body's last context or `+` line (unified no-newline rule). */
function bodyNoEol(body: string[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k += 1) {
    const bl = body[k]!;
    if (bl === '' || bl.startsWith(' ') || bl.startsWith('+')) last = k;
  }
  if (last < 0) return false;
  const next = body[last + 1];
  return next !== undefined && next.startsWith('\\');
}

// ---- Section 6: unified diffs ----

interface Hunk {
  a: number;
  body: string[];
}

interface UniSection {
  diff: [string, string] | null;
  pair: [string | null, string | null] | null;
  renameFrom: string | null;
  renameTo: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** A `--- ` / `+++ ` path: text after the four characters, up to the first tab, trimmed; /dev/null is null. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** A hunk body's lines, up to the first line that is not one; trailing empty lines are not part of it. */
function hunkBody(lines: string[], i: number): { body: string[]; next: number } {
  const body: string[] = [];
  let j = i;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      body.push(l);
      j += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { body, next: j };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  const n = lines.length;
  const fresh = (diff: [string, string] | null, pair: [string | null, string | null] | null): UniSection => ({
    diff,
    pair,
    renameFrom: null,
    renameTo: null,
    isCreate: false,
    isDelete: false,
    hunks: [],
  });
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh([m[1]!, m[2]!], null);
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && cur.pair === null) {
        cur.pair = [headerPath(line), headerPath(lines[i + 1]!)];
        i += 2;
        continue;
      }
      cur = fresh(null, [headerPath(line), headerPath(lines[i + 1]!)]);
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('@@')) {
        const m = HUNK_RE.exec(line);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        inHeader = false;
        const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [] };
        cur.hunks.push(hunk);
        const r = hunkBody(lines, i + 1);
        hunk.body = r.body;
        i = r.next;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.isCreate = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (cur !== null) {
      if (line.startsWith('@@')) {
        const m = HUNK_RE.exec(line);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        const hunk: Hunk = { a: parseInt(m[1]!, 10), body: [] };
        cur.hunks.push(hunk);
        const r = hunkBody(lines, i + 1);
        hunk.body = r.body;
        i = r.next;
        continue;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i += 1;
  }
  return sections.map((s) => sectionEdit(s, strict));
}

function sectionEdit(sec: UniSection, strict: boolean): Edit {
  const oldPath = sec.pair !== null ? sec.pair[0] : sec.renameFrom !== null ? sec.renameFrom : sec.diff !== null ? sec.diff[0] : null;
  const newPath = sec.pair !== null ? sec.pair[1] : sec.renameTo !== null ? sec.renameTo : sec.diff !== null ? sec.diff[1] : null;
  const isCreate = oldPath === null || sec.isCreate;
  const isDelete = newPath === null || sec.isDelete;
  return (tree) => {
    if (isCreate) {
      const p = newPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const outLines: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        let lastPlus = -1;
        for (let k = 0; k < h.body.length; k += 1) if (h.body[k]!.startsWith('+')) lastPlus = k;
        if (lastPlus >= 0) {
          const nx = h.body[lastPlus + 1];
          noEol = nx !== undefined && nx.startsWith('\\');
        }
        for (const bl of h.body) if (bl.startsWith('+')) outLines.push(bl.slice(1));
      }
      tree.now.set(p, outLines.length === 0 ? '' : outLines.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const op = oldPath ?? '';
    if (!safe(op)) throw new Fail('unsafe', op);
    const isMove = newPath !== null && newPath !== oldPath;
    if (isMove && !safe(newPath!)) throw new Fail('unsafe', newPath!);
    const text = tree.get(op);
    if (text === null) throw new Fail('missing', op);
    if (isMove && tree.get(newPath!) !== null) throw new Fail('exists', newPath!);
    let f = parseFile(text);
    let d = 0;
    for (const h of sec.hunks) {
      const { o, n } = bodyON(h.body);
      if (o.length > 0) {
        const found = findTier(f.lines, o, strict, 0);
        if (found === null) throw new Fail('no-match', op);
        const target = h.a - 1 + d;
        let best = found.occ[0]!;
        let bestDist = Math.abs(best - target);
        for (const pos of found.occ) {
          const dist = Math.abs(pos - target);
          if (dist < bestDist) {
            best = pos;
            bestDist = dist;
          }
        }
        const noEol = bodyNoEol(h.body);
        const ends = best + o.length === f.lines.length ? !noEol : f.ends;
        f = {
          lines: [...f.lines.slice(0, best), ...buildN(f.lines, best, o, n, found.tier), ...f.lines.slice(best + o.length)],
          br: f.br,
          ends,
        };
      } else {
        const pos = Math.min(Math.max(h.a + d, 0), f.lines.length);
        const noEol = bodyNoEol(h.body);
        const ends = pos === f.lines.length ? !noEol : f.ends;
        const added = n.map((x) => x.text!);
        f = { lines: [...f.lines.slice(0, pos), ...added, ...f.lines.slice(pos)], br: f.br, ends };
      }
      d += n.length - o.length;
    }
    const out = renderFile(f);
    if (isMove) {
      tree.now.set(newPath!, out);
      tree.now.set(op, null);
      tree.recordMove(op, newPath!);
    } else {
      tree.now.set(op, out);
    }
  };
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let k = s - 1; k > prevEnd; k -= 1) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let k = s + 1; k < n; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < n; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const f = parseFile(text);
    const found = findTier(f.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const n: NLine[] = newLines.map((t) => ({ text: t }));
    const lines = [...f.lines.slice(0, at), ...buildN(f.lines, at, oldLines, n, found.tier), ...f.lines.slice(at + oldLines.length)];
    tree.now.set(path, renderFile({ lines, br: f.br, ends: f.ends }));
  };
}

// ---- Section 8: V4A patches ----

interface V4aChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(14).trim();
      const content: string[] = [];
      let j = i + 1;
      while (j < last) {
        const l = lines[j]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('+') || l === '') {
          content.push(l);
          j += 1;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      while (content.length > 0 && content[content.length - 1]!.trim() === '') content.pop();
      const fileLines = content.map((l) => (l === '' ? '' : l.slice(1)));
      edits.push(v4aAddEdit(path, fileLines));
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice(17).trim();
      edits.push(v4aDeleteEdit(path));
      i += 1;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const updLine = i;
      const path = line.slice(17).trim();
      i += 1;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice(13).trim();
        i += 1;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let firstChunk = true;
      while (i < last) {
        const l = lines[i]!;
        if (isSectionStart(l)) break;
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          cur = null;
          firstChunk = false;
          i += 1;
          continue;
        }
        if (l.startsWith('@@')) {
          cur = { anchor: l.slice(2).trim(), body: [], eof: false };
          chunks.push(cur);
          firstChunk = false;
          i += 1;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (firstChunk && chunks.length === 0) {
              cur = { anchor: null, body: [], eof: false };
              chunks.push(cur);
              firstChunk = false;
            } else {
              throw new Exit2(`error: parse ${i + 1}`);
            }
          }
          cur.body.push(l);
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        while (lastChunk.body.length > 0 && lastChunk.body[lastChunk.body.length - 1]!.trim() === '') lastChunk.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updLine + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null) {
      if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    }
    let f = parseFile(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const found = findTier(f.lines, [ch.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        cursor = found.occ[0]! + 1;
      }
      const { o, n } = bodyON(ch.body);
      if (o.length === 0) {
        const pos = ch.eof ? f.lines.length : cursor;
        const added = n.map((x) => x.text!);
        f = { lines: [...f.lines.slice(0, pos), ...added, ...f.lines.slice(pos)], br: f.br, ends: f.ends };
        cursor = pos + n.length;
        continue;
      }
      let found: { tier: number; pos: number } | null = null;
      for (const t of tierList(strict)) {
        const occs = occurrences(f.lines, o, t, cursor);
        const good = ch.eof ? occs.filter((p) => p + o.length === f.lines.length) : occs;
        if (good.length > 0) {
          found = { tier: t, pos: good[0]! };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', path);
      const pos = found.pos;
      f = {
        lines: [...f.lines.slice(0, pos), ...buildN(f.lines, pos, o, n, found.tier), ...f.lines.slice(pos + o.length)],
        br: f.br,
        ends: f.ends,
      };
      cursor = pos + n.length;
    }
    const out = renderFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.recordMove(path, moveTo);
    } else {
      tree.now.set(path, out);
    }
  };
}

// ---- Section 9: JSON edits ----

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

// ---- Sections 1, 2 and 10: invocation, output and atomicity ----

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
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
  const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const rows: Array<{ key: string; text: string }> = [];
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  for (const [o, nw] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(nw) === null && tree.get(nw) !== null) {
      rows.push({ key: nw, text: `R ${o} -> ${nw}` });
      rOld.add(o);
      rNew.add(nw);
    }
  }
  const changed = [...tree.now.keys()].sort(byteOrder);
  for (const p of changed) {
    if (rOld.has(p) || rNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  if (!check) {
    for (const p of changed) {
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
