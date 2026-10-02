// audit_trail_modification — a Claude Code tool call that writes to, or
// deletes from, xCLAUDE Gateway's own data folder (the audit trail, the
// connector baselines, the masking salt, the spool). An agent that edits or
// removes the record of what it did is the one thing an audit layer must not
// let pass unremarked.
//
// SCOPE (V1). Claude Code's native tools only — Write, Edit, MultiEdit,
// NotebookEdit and Bash — as seen by the PostToolUse hook. Only operations
// that MODIFY or DELETE; reading the folder is ordinary (developers read their
// own trail all the time: 214 reads in the real trail, every one from a
// development session).
// MCP servers are out of scope: their "paths" may live on another machine,
// and a tool's text mentioning the folder is not a file operation (the only 5
// MCP calls in the real trail that name it are Notion pages).
//
// FORENSIC, NOT PREVENTIVE. The hook fires AFTER the tool ran (PostToolUse):
// this records that it happened; it cannot stop it.
//
// HOW BASH IS READ. The command is split into segments on ; && || | & ( ) and
// newlines, respecting quotes, $(…), backticks and heredoc bodies (a heredoc
// is data, not commands). In each segment:
//   - leading VAR=val assignments and the wrappers `command`, `env` (with its
//     VAR=val and options) and `sudo` (with its options) are dropped, and the
//     executable is taken by basename (/bin/rm → rm);
//   - paths are normalised LEXICALLY: ~, $HOME and ${HOME} expand to the home
//     directory, quotes and escaped spaces are undone by the tokenizer,
//     relative paths resolve against the hook's cwd, and `cd <literal path>`
//     followed by && moves the effective cwd for the rest of the command.
//     No realpath: nothing here touches the disk;
//   - the operation is judged by the operand it acts on, never by the whole
//     command: an `rm` of a temp file next to an `ls` of the folder is not a
//     delete of the folder.
// Delete: rm, rmdir, unlink, truncate, shred, find … -delete — any operand in
// the folder. Write by destination: cp, ditto, install; ln (the link it
// creates); dd (of= only); mv (source OR destination — moving a file out of
// the folder removes it). Write by operand: chmod, chown, chflags, touch,
// sed -i, perl -i, tee, and the > / >> redirections.
//
// ACCEPTED FALSE NEGATIVES, stated so nobody mistakes this for more than it is:
//   - paths held in variables that are not literal ($D/x, "$(pwd)"/x);
//   - programs and scripts that write from the inside (python, node, a shell
//     script, an editor opened on the file);
//   - symlinks: without realpath, a link elsewhere that points into the folder
//     is not recognised;
//   - pipelines that feed paths to a command (find … | xargs rm);
//   - pushd, subshell bodies in $(…) and backticks, eval;
//   - commands run by find … -exec (-exec rm {}, -exec cp {} …): only
//     find … -delete is read;
//   - MCP tool calls, and every read.
// The folder is compared case-insensitively: macOS volumes are case-insensitive
// by default, so ~/library/application support/xclaude gateway is the same
// folder.

import { homedir } from 'node:os';
import { posix } from 'node:path';

import { xcgDataDir } from '@xcg/shared/config';

import type { DetectionFinding, Detector, DetectorInput, DetectorOutput } from '../types.js';

export type AuditTrailOp = 'write' | 'delete';

interface Word {
  text: string;
  /** True when any part of the word was quoted — an empty quoted word ('') is
   *  still a word. */
  quoted: boolean;
}

interface Redirect {
  op: string;
  target: Word | null;
}

interface Segment {
  words: Word[];
  redirects: Redirect[];
  /** The separator that ENDS this segment (null for the last one). */
  sep: string | null;
}

// ---- tokenizer ---------------------------------------------------------------

/** Split a shell command into segments of words and redirections. Deliberately
 *  small: enough shell to find the executable and its operands, not a shell. */
export function splitSegments(command: string): Segment[] {
  const segments: Segment[] = [];
  let words: Word[] = [];
  let redirects: Redirect[] = [];
  let cur = '';
  let curQuoted = false;
  let inWord = false;
  let pendingRedirect: Redirect | null = null;
  const heredocs: { delim: string; strip: boolean }[] = [];
  let pendingHeredoc: { strip: boolean } | null = null;

  const endWord = (): void => {
    if (!inWord) return;
    const w: Word = { text: cur, quoted: curQuoted };
    if (pendingHeredoc !== null) {
      heredocs.push({ delim: w.text, strip: pendingHeredoc.strip });
      pendingHeredoc = null;
    } else if (pendingRedirect !== null) {
      pendingRedirect.target = w;
      redirects.push(pendingRedirect);
      pendingRedirect = null;
    } else {
      words.push(w);
    }
    cur = '';
    curQuoted = false;
    inWord = false;
  };
  const endSegment = (sep: string | null): void => {
    endWord();
    if (pendingRedirect !== null) {
      redirects.push(pendingRedirect);
      pendingRedirect = null;
    }
    // An empty segment (a newline after &&, a trailing ;) keeps the previous
    // segment's separator: `cd x &&⏎ rm y` still chains on &&.
    if (words.length > 0 || redirects.length > 0) segments.push({ words, redirects, sep });
    words = [];
    redirects = [];
  };

  let i = 0;
  const n = command.length;
  while (i < n) {
    const c = command[i]!;
    // Heredoc bodies start after the newline that ends their command line.
    if (c === '\n') {
      endSegment('\n');
      i += 1;
      while (heredocs.length > 0) {
        const { delim, strip } = heredocs.shift()!;
        // Skip lines until the delimiter line.
        for (;;) {
          if (i >= n) break;
          const eol = command.indexOf('\n', i);
          const line = command.slice(i, eol === -1 ? n : eol);
          i = eol === -1 ? n : eol + 1;
          if ((strip ? line.replace(/^\t+/, '') : line) === delim) break;
        }
      }
      continue;
    }
    if (c === ' ' || c === '\t') {
      endWord();
      i += 1;
      continue;
    }
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      cur += command.slice(i + 1, end === -1 ? n : end);
      curQuoted = true;
      inWord = true;
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === '"') {
      i += 1;
      while (i < n && command[i] !== '"') {
        if (command[i] === '\\' && i + 1 < n && '"\\$`'.includes(command[i + 1]!)) {
          cur += command[i + 1];
          i += 2;
        } else {
          cur += command[i];
          i += 1;
        }
      }
      i += 1;
      curQuoted = true;
      inWord = true;
      continue;
    }
    if (c === '\\') {
      if (i + 1 < n && command[i + 1] === '\n') {
        i += 2; // line continuation
        continue;
      }
      cur += command[i + 1] ?? '';
      inWord = true;
      i += 2;
      continue;
    }
    if (c === '$' && command[i + 1] === '(') {
      // Command substitution: kept inside the word, never parsed (accepted FN).
      let depth = 0;
      let j = i + 1;
      for (; j < n; j++) {
        if (command[j] === '(') depth += 1;
        else if (command[j] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      cur += command.slice(i, j + 1);
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === '`') {
      const end = command.indexOf('`', i + 1);
      cur += command.slice(i, end === -1 ? n : end + 1);
      inWord = true;
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === '<') {
      endWord();
      if (command[i + 1] === '<' && command[i + 2] !== '<') {
        // Heredoc: <<DELIM or <<-DELIM; the delimiter is the next word.
        const strip = command[i + 2] === '-';
        pendingHeredoc = { strip };
        i += strip ? 3 : 2;
        continue;
      }
      // Input redirection (<, <<<): its target is read, not written.
      pendingRedirect = { op: '<', target: null };
      i += command[i + 1] === '<' ? 3 : 1;
      continue;
    }
    if (c === '>' || (c === '&' && command[i + 1] === '>')) {
      // N> and N>> — a word made only of digits is the fd, not an argument.
      let op = '';
      if (inWord && /^\d+$/.test(cur) && !curQuoted) {
        op = cur;
        cur = '';
        inWord = false;
      } else {
        endWord();
      }
      if (c === '&') {
        op += '&';
        i += 1;
      }
      op += '>';
      i += 1;
      if (command[i] === '>') {
        op += '>';
        i += 1;
      } else if (command[i] === '|') {
        op += '|';
        i += 1;
      }
      if (command[i] === '&') {
        // >&2, 2>&1: duplicating a descriptor writes no file.
        i += 1;
        while (i < n && /[0-9-]/.test(command[i]!)) i += 1;
        continue;
      }
      pendingRedirect = { op, target: null };
      continue;
    }
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')') {
      const two = command.slice(i, i + 2);
      const sep = two === '&&' || two === '||' ? two : c;
      endSegment(sep);
      i += sep.length;
      continue;
    }
    cur += c;
    inWord = true;
    i += 1;
  }
  endSegment(null);
  return segments;
}

// ---- paths -------------------------------------------------------------------

export interface PathContext {
  home: string;
  dataDir: string;
  cwd: string | null;
}

/** A literal path, lexically normalised, or null when it cannot be known
 *  without running the shell (a variable, a substitution, no cwd). */
export function resolvePath(text: string, ctx: PathContext): string | null {
  if (text === '') return null;
  let t = text;
  if (t === '~' || t.startsWith('~/')) t = ctx.home + t.slice(1);
  else if (t === '$HOME' || t.startsWith('$HOME/')) t = ctx.home + t.slice('$HOME'.length);
  else if (t === '${HOME}' || t.startsWith('${HOME}/')) t = ctx.home + t.slice('${HOME}'.length);
  if (t.includes('$') || t.includes('`')) return null;
  if (t.startsWith('/')) return posix.normalize(t);
  if (ctx.cwd === null) return null;
  return posix.resolve(ctx.cwd, t);
}

const GLOB = /[*?[]/;

/** Is this normalised path the data folder or inside it? A path under the
 *  folder counts even with glob characters in it (wrappers/*.jsonl); a glob
 *  ABOVE it counts when the folder itself would match (…/Application
 *  Support/*). Case-insensitive (see header). */
export function insideDataDir(path: string, dataDir: string): boolean {
  const p = path.toLowerCase().replace(/\/+$/, '');
  const d = dataDir.toLowerCase().replace(/\/+$/, '');
  if (p === d || p.startsWith(`${d}/`)) return true;
  if (!GLOB.test(p)) return false;
  const source = p
    .split('')
    .map((ch) => (ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : /[.+^${}()|\\\]]/.test(ch) ? `\\${ch}` : ch))
    .join('');
  try {
    return new RegExp(`^${source}$`).test(d);
  } catch {
    return false;
  }
}

// ---- commands ----------------------------------------------------------------

const DELETE_CMDS = new Set(['rm', 'rmdir', 'unlink', 'truncate', 'shred']);
const DEST_CMDS = new Set(['cp', 'ditto', 'install']);
const FIRST_IS_SPEC = new Set(['chmod', 'chown', 'chflags']);

/** Options that take a separate value, per command, so the value is not read
 *  as an operand. */
const VALUE_OPTS: Record<string, ReadonlySet<string>> = {
  truncate: new Set(['-s', '-r']),
  shred: new Set(['-n', '-s']),
  cp: new Set(['-t', '-S']),
  install: new Set(['-m', '-o', '-g', '-t', '-b', '-B', '-f', '-M', '-N', '-T']),
  mv: new Set(['-t', '-S']),
  ln: new Set(['-t', '-S']),
  touch: new Set(['-t', '-d', '-r', '-A']),
  sed: new Set(['-e', '-f', '-l']),
  perl: new Set(['-e', '-E', '-I', '-M', '-m', '-x']),
  tee: new Set([]),
  ditto: new Set(['--arch', '--bom']),
};

interface Parsed {
  operands: Word[];
  options: string[];
  values: Map<string, string>;
}

function parseArgs(cmd: string, args: readonly Word[]): Parsed {
  const operands: Word[] = [];
  const options: string[] = [];
  const values = new Map<string, string>();
  const withValue = VALUE_OPTS[cmd] ?? new Set<string>();
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!endOfOptions && !a.quoted && a.text === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && a.text.startsWith('-') && a.text.length > 1) {
      options.push(a.text);
      if (withValue.has(a.text) && i + 1 < args.length) {
        values.set(a.text, args[i + 1]!.text);
        i += 1;
      }
      continue;
    }
    operands.push(a);
  }
  return { operands, options, values };
}

/** Drop leading assignments and the command/env/sudo wrappers. Returns the
 *  executable's basename and its arguments, or null when the segment does not
 *  execute anything (only assignments, `command -v`). */
function executable(words: readonly Word[]): { cmd: string; args: Word[] } | null {
  let i = 0;
  const isAssign = (w: Word): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text);
  for (;;) {
    while (i < words.length && isAssign(words[i]!)) i += 1;
    if (i >= words.length) return null;
    const name = posix.basename(words[i]!.text);
    if (name === 'command') {
      i += 1;
      if (words[i]?.text === '-v' || words[i]?.text === '-V') return null; // a lookup, not a run
      while (i < words.length && words[i]!.text.startsWith('-')) i += 1;
      continue;
    }
    if (name === 'env') {
      i += 1;
      while (i < words.length) {
        const t = words[i]!.text;
        if (t === '-u' || t === '-P' || t === '-S') i += 2;
        else if (t.startsWith('-') || isAssign(words[i]!)) i += 1;
        else break;
      }
      continue;
    }
    if (name === 'sudo') {
      i += 1;
      while (i < words.length && words[i]!.text.startsWith('-')) {
        const t = words[i]!.text;
        i += ['-u', '-g', '-h', '-p', '-C', '-U', '-r', '-t', '-D', '-T'].includes(t) ? 2 : 1;
      }
      continue;
    }
    return { cmd: name, args: words.slice(i + 1) };
  }
}

/** The operations one segment performs on the folder. */
function segmentOps(seg: Segment, ctx: PathContext): { op: AuditTrailOp; cmd: string }[] {
  const out: { op: AuditTrailOp; cmd: string }[] = [];
  const hit = (w: Word | string | undefined): boolean => {
    if (w === undefined) return false;
    const p = resolvePath(typeof w === 'string' ? w : w.text, ctx);
    return p !== null && insideDataDir(p, ctx.dataDir);
  };

  const exe = executable(seg.words);

  // Redirections write wherever they point, whatever the command.
  for (const r of seg.redirects) {
    if (r.op === '<' || r.target === null) continue;
    if (hit(r.target)) out.push({ op: 'write', cmd: r.op });
  }
  if (exe === null) return out;
  const { cmd, args } = exe;

  if (DELETE_CMDS.has(cmd)) {
    const { operands } = parseArgs(cmd, args);
    if (operands.some(hit)) out.push({ op: 'delete', cmd });
    return out;
  }
  if (cmd === 'find') {
    if (!args.some((a) => a.text === '-delete')) return out;
    const starts: Word[] = [];
    for (const a of args) {
      if (a.text.startsWith('-') || a.text === '(' || a.text === '!') break;
      starts.push(a);
    }
    if ((starts.length === 0 ? ['.'] : starts).some(hit)) out.push({ op: 'delete', cmd });
    return out;
  }
  if (DEST_CMDS.has(cmd)) {
    const { operands, options, values } = parseArgs(cmd, args);
    const target = values.get('-t');
    if (target !== undefined) {
      if (hit(target)) out.push({ op: 'write', cmd });
    } else if (cmd === 'install' && options.includes('-d')) {
      if (operands.some(hit)) out.push({ op: 'write', cmd });
    } else if (operands.length >= 2 && hit(operands[operands.length - 1])) {
      out.push({ op: 'write', cmd });
    }
    return out;
  }
  if (cmd === 'ln') {
    const { operands, values } = parseArgs(cmd, args);
    const target = values.get('-t');
    let link: string | undefined;
    if (target !== undefined) link = target;
    else if (operands.length >= 2) link = operands[operands.length - 1]!.text;
    else if (operands.length === 1) link = posix.basename(operands[0]!.text); // created in cwd
    if (hit(link)) out.push({ op: 'write', cmd });
    return out;
  }
  if (cmd === 'dd') {
    const of = args.find((a) => a.text.startsWith('of='));
    if (of !== undefined && hit(of.text.slice(3))) out.push({ op: 'write', cmd });
    return out;
  }
  if (cmd === 'mv') {
    const { operands, values } = parseArgs(cmd, args);
    const target = values.get('-t');
    if (operands.some(hit) || (target !== undefined && hit(target))) out.push({ op: 'write', cmd });
    return out;
  }
  if (FIRST_IS_SPEC.has(cmd)) {
    const { operands, options } = parseArgs(cmd, args);
    // `chmod -w file`: a symbolic mode that starts with a dash parses as an
    // option, and then every operand is a file.
    const modeAsOption = cmd === 'chmod' && options.some((o) => /^-[rwxXst]+$/.test(o));
    const files = modeAsOption ? operands : operands.slice(1);
    if (files.some(hit)) out.push({ op: 'write', cmd });
    return out;
  }
  if (cmd === 'touch' || cmd === 'tee') {
    const { operands } = parseArgs(cmd, args);
    if (operands.some(hit)) out.push({ op: 'write', cmd });
    return out;
  }
  if (cmd === 'sed') {
    const inPlace = args.some((a) => a.text === '-i' || a.text.startsWith('-i') || a.text.startsWith('--in-place'));
    if (!inPlace) return out;
    // macOS: `-i ''` — the empty suffix is its own word.
    const cleaned = args.filter((a, idx) => !(a.quoted && a.text === '' && args[idx - 1]?.text === '-i'));
    const { operands, values } = parseArgs(cmd, cleaned);
    const files = values.has('-e') || values.has('-f') ? operands : operands.slice(1);
    if (files.some(hit)) out.push({ op: 'write', cmd });
    return out;
  }
  if (cmd === 'perl') {
    const inPlace = args.some((a) => /^-[A-Za-z]*i/.test(a.text));
    if (!inPlace) return out;
    const { operands, values } = parseArgs(cmd, args);
    const files = values.has('-e') || values.has('-E') ? operands : operands.slice(1);
    if (files.some(hit)) out.push({ op: 'write', cmd });
    return out;
  }
  return out;
}

/** Every write/delete a Bash command performs on the folder, in order. */
export function bashOps(
  command: string,
  ctx: PathContext,
): { op: AuditTrailOp; cmd: string }[] {
  const out: { op: AuditTrailOp; cmd: string }[] = [];
  let cwd = ctx.cwd;
  for (const seg of splitSegments(command)) {
    out.push(...segmentOps(seg, { ...ctx, cwd }));
    // `cd <literal>` followed by && moves the cwd for the rest of the command.
    const exe = executable(seg.words);
    if (exe?.cmd === 'cd' && seg.sep === '&&') {
      const first = exe.args[0];
      if (first?.text === '-') cwd = null; // the previous directory: unknown here
      else {
        const target = exe.args.find((a) => !a.text.startsWith('-'));
        cwd = target === undefined ? ctx.home : resolvePath(target.text, { ...ctx, cwd });
      }
    }
  }
  return out;
}

// ---- detector ----------------------------------------------------------------

// The argument that names the file each writing tool acts on. NotebookEdit
// counts in every edit_mode: deleting a cell rewrites the notebook too.
const WRITE_TOOL_PATH_ARG: ReadonlyMap<string, string> = new Map([
  ['Write', 'file_path'],
  ['Edit', 'file_path'],
  ['MultiEdit', 'file_path'],
  ['NotebookEdit', 'notebook_path'],
]);

export interface AuditTrailOptions {
  home?: string;
  dataDir?: string;
}

function argumentsOf(input: DetectorInput): Record<string, unknown> | null {
  const payload = input.envelope.payload;
  if (payload === null || typeof payload !== 'object') return null;
  const args = (payload as Record<string, unknown>)['arguments'];
  return args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : null;
}

export function createAuditTrailModification(opts: AuditTrailOptions = {}): Detector {
  const home = opts.home ?? homedir();
  const dataDir = opts.dataDir ?? xcgDataDir(home);
  return (input): DetectorOutput | null => {
    // Claude Code's own tools only: an mcp__server__tool call carries the
    // server as its mcp, never 'claude-code'.
    if (input.envelope.mcp !== 'claude-code') return null;
    const tool = input.toolName;
    if (tool === undefined) return null;
    const args = argumentsOf(input);
    if (args === null) return null;
    const ctx: PathContext = { home, dataDir, cwd: input.cwd ?? null };

    const findings: DetectionFinding[] = [];
    const pathArg = WRITE_TOOL_PATH_ARG.get(tool);
    if (pathArg !== undefined) {
      const file = args[pathArg];
      if (typeof file === 'string') {
        const p = resolvePath(file, ctx);
        if (p !== null && insideDataDir(p, dataDir)) findings.push({ type: 'write', location: tool });
      }
    } else if (tool === 'Bash') {
      const command = args['command'];
      if (typeof command === 'string') {
        const seen = new Set<string>();
        for (const { op, cmd } of bashOps(command, ctx)) {
          const key = `${op}|${cmd}`;
          if (seen.has(key)) continue;
          seen.add(key);
          findings.push({ type: op, location: tool, rule: cmd });
        }
      }
    }
    if (findings.length === 0) return null;
    return { category: 'audit_trail_modification', severity: 'high', findings };
  };
}

export const auditTrailModification: Detector = createAuditTrailModification();
