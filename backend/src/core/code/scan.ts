import {
  JS_AMBIGUOUS_DYNAMO_METHODS,
  JS_COMMANDS,
  JS_METHODS,
  PY_METHODS,
  PY_TABLE_METHODS,
  TARGET_FIELD,
  iamAction,
  type SdkOperation,
} from './catalog.js';

export interface CodeSource {
  path: string;
  content: string;
}

// ---- limits ----------------------------------------------------------------------------------------------
// Anyone can link a repository, so every file is untrusted. These keep one hostile file from taking the
// analyzer (or the server it shares a thread with) hostage: nothing below may do work proportional to the
// square of a file's size.

/** A line longer than this means minified or generated code, which is skipped rather than half-understood. */
export const MAX_LINE_LENGTH = 4000;
/** How much of a call's arguments is ever looked at. Real SDK calls are far shorter. */
const MAX_ARGS_CHARS = 8000;
/** Per file, so a file made of millions of tiny calls cannot make the later steps slow. */
const MAX_CALLS_PER_FILE = 2000;
const MAX_FUNCTIONS_PER_FILE = 3000;
/** How many source lines of a function are kept as context for inference (only the first ~4000 characters are used). */
const MAX_CONTEXT_LINES = 200;
/** Last-resort look-ahead for a bracket the one-pass index did not see (one inside a string literal). */
const FALLBACK_BRACKET_SPAN = 2000;
const MAX_FALLBACK_SCANS_PER_FILE = 5000;
/** Total time for scanning every file. Not reached by ordinary repositories. */
export const SCAN_BUDGET_MS = 20_000;

/** The analysis stopped because it hit a safety limit; the message is fit to show the user. */
export class AnalysisLimitError extends Error {}

/** Looks a key up in a table of known names, ignoring the built-ins every object inherits (toString, valueOf, constructor...). */
const own = <T>(table: Record<string, T>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

export interface CodeFunction {
  file: string;
  name: string;
  /** `path::name`, unique within a run. */
  qualified: string;
  lineStart: number;
  lineEnd: number;
}

export interface EnvRead {
  file: string;
  line: number;
  name: string;
  /** Qualified name of the enclosing function, if any. */
  function: string | null;
}

export type CallTarget =
  | { kind: 'env'; name: string }
  | { kind: 'literal'; value: string }
  | { kind: 'unknown'; hint: string | null };

export interface SdkCall {
  file: string;
  line: number;
  function: string | null;
  op: SdkOperation;
  action: string;
  target: CallTarget;
  /** Source of the enclosing function, trimmed. Used transiently for inference; never persisted. */
  context: string;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

/** One function calling another that Blueprint could resolve to a function in the analyzed files. */
export interface CodeCall {
  /** Qualified name of the caller. */
  caller: string;
  /** Qualified name of the callee. */
  callee: string;
  file: string;
  line: number;
}

export interface CodeFacts {
  /** Files that were not read, and why. */
  skipped: SkippedFile[];
  files: string[];
  functions: CodeFunction[];
  envReads: EnvRead[];
  sdkCalls: SdkCall[];
  calls: CodeCall[];
}

export type Language = 'js' | 'py';

export function languageOf(path: string): Language | null {
  if (/\.(?:[cm]?[jt]sx?)$/.test(path)) return 'js';
  if (path.endsWith('.py')) return 'py';
  return null;
}

// ---- text helpers ---------------------------------------------------------------------------------------

/** Blanks out comments but keeps string literals and every newline (so offsets/lines stay valid). */
function stripComments(src: string, lang: Language): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (lang === 'js' && c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (lang === 'js' && c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (lang === 'py' && c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '"' || c === "'" || c === '`') {
      const triple = lang === 'py' && src.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      let j = i + quote.length;
      while (j < src.length) {
        if (src[j] === '\\') j += 2;
        else if (src.startsWith(quote, j)) break;
        else if (!triple && c !== '`' && src[j] === '\n') break;
        else j++;
      }
      j = Math.min(j + quote.length, src.length);
      out += src.slice(i, j);
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function lineStarts(src: string): number[] {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

const UNCLOSED = -1;

/**
 * For every ( { [ outside a string literal, the index just past its closing bracket (UNCLOSED if it never
 * closes); 0 for every other position. One pass over the file, so asking about any bracket is instant. The
 * old way rescanned from each bracket to the end of the file, which made a file of unclosed brackets take minutes.
 */
function buildBracketIndex(src: string): Int32Array {
  const closes = new Int32Array(src.length);
  const open: Record<string, number[]> = { '(': [], '{': [], '[': [] };
  const openerOf: Record<string, string> = { ')': '(', '}': '{', ']': '[' };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') i++;
        i++;
      }
    } else if (c === '(' || c === '{' || c === '[') {
      open[c]!.push(i);
    } else if (c === ')' || c === '}' || c === ']') {
      const start = open[openerOf[c]!]!.pop();
      if (start !== undefined) closes[start] = i + 1;
    }
  }
  for (const stack of Object.values(open)) for (const start of stack) closes[start] = UNCLOSED;
  return closes;
}

// The scanner works on one file at a time, so the index of the file in hand is kept between calls.
let indexedSource: string | null = null;
let bracketIndex: Int32Array = new Int32Array(0);
let fallbackScans = 0;

/** Index just past the bracket that closes the one at `open`, skipping string literals. */
function matchBracket(src: string, open: number): number {
  if (src !== indexedSource) {
    indexedSource = src;
    bracketIndex = buildBracketIndex(src);
    fallbackScans = 0;
  }
  const close = bracketIndex[open]!;
  if (close > 0) return close;
  if (close === UNCLOSED) return src.length;

  // Not a bracket the index saw: it sits inside a string literal. Look a short way ahead, a bounded number of times.
  if (++fallbackScans > MAX_FALLBACK_SCANS_PER_FILE) return Math.min(open + 1, src.length);
  const opener = src[open]!;
  const closer = opener === '(' ? ')' : opener === '{' ? '}' : ']';
  const limit = Math.min(src.length, open + FALLBACK_BRACKET_SPAN);
  let depth = 0;
  for (let i = open; i < limit; i++) {
    const c = src[i]!;
    if (c === opener) depth++;
    else if (c === closer && --depth === 0) return i + 1;
  }
  return limit;
}

/** The text between a call's parentheses, capped so one enormous call cannot be copied over and over. */
function argsBetween(src: string, openParen: number): string {
  return src.slice(openParen + 1, Math.min(matchBracket(src, openParen) - 1, openParen + 1 + MAX_ARGS_CHARS));
}

// ---- value resolution --------------------------------------------------------------------------------------

const ENV_EXPR = [
  /^process\.env\.([A-Za-z_]\w*)/,
  /^process\.env\[\s*['"]([^'"]+)['"]\s*\]/,
  /^os\.environ\[\s*['"]([^'"]+)['"]\s*\]/,
  /^os\.environ\.get\(\s*['"]([^'"]+)['"]/,
  /^os\.getenv\(\s*['"]([^'"]+)['"]/,
  /^environ\[\s*['"]([^'"]+)['"]\s*\]/,
];

interface Consts {
  env: Map<string, string>;
  literal: Map<string, string>;
}

function resolveExpr(expr: string, consts: Consts): CallTarget {
  const e = expr.trim().replace(/^\(+|\)+$/g, '').trim();
  for (const pattern of ENV_EXPR) {
    const m = pattern.exec(e);
    if (m) return { kind: 'env', name: m[1]! };
  }
  const str = /^(['"])([^'"\n]*)\1$/.exec(e);
  if (str) return { kind: 'literal', value: str[2]! };
  const tmpl = /^`([^`$]*)`$/.exec(e);
  if (tmpl) return { kind: 'literal', value: tmpl[1]! };
  if (/^[A-Za-z_]\w*$/.test(e)) {
    const env = consts.env.get(e);
    if (env) return { kind: 'env', name: env };
    const literal = consts.literal.get(e);
    if (literal !== undefined) return { kind: 'literal', value: literal };
  }
  return { kind: 'unknown', hint: e.length > 0 && e.length <= 80 ? e : null };
}

/** Top-level module/function constants that name an env var or a literal. */
function collectConsts(src: string, lang: Language): Consts {
  const consts: Consts = { env: new Map(), literal: new Map() };
  const assign =
    lang === 'js'
      ? /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]{1,200})?=\s*([^;\n]{1,500})/g
      : /^[ \t]*([A-Za-z_]\w*)\s*(?::[^=\n]{1,200})?=\s*([^\n]{1,500})/gm;
  for (const m of src.matchAll(assign)) {
    const name = m[1]!;
    const target = resolveExpr(m[2]!.split(/\s*(?:\|\||\?\?|\bor\b)\s*/)[0]!, { env: new Map(), literal: new Map() });
    if (target.kind === 'env') consts.env.set(name, target.name);
    else if (target.kind === 'literal') consts.literal.set(name, target.value);
  }
  return consts;
}

/** Value of `Field: expr` / `Field=expr` / shorthand `Field,` inside a call's argument text. */
function readField(args: string, field: string, lang: Language, consts: Consts): CallTarget | null {
  const keyed = new RegExp(`\\b${field}\\s*${lang === 'js' ? ':' : '='}\\s*`).exec(args);
  if (keyed) {
    const rest = args.slice(keyed.index + keyed[0].length);
    let depth = 0;
    let end = 0;
    for (; end < rest.length; end++) {
      const c = rest[end]!;
      if (c === '"' || c === "'" || c === '`') {
        end++;
        while (end < rest.length && rest[end] !== c) {
          if (rest[end] === '\\') end++;
          end++;
        }
      } else if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) {
        if (depth === 0) break;
        depth--;
      } else if (c === ',' && depth === 0) break;
    }
    const expr = rest.slice(0, end).split(/\s*(?:\|\||\?\?)\s*/)[0]!;
    return resolveExpr(expr, consts);
  }
  if (lang === 'js' && new RegExp(`[{,]\\s*${field}\\s*[,}]`).test(args)) return resolveExpr(field, consts);
  return null;
}

// ---- functions -------------------------------------------------------------------------------------------

function findFunctions(path: string, src: string, lang: Language, starts: number[]): CodeFunction[] {
  const found: CodeFunction[] = [];
  const add = (name: string, startOffset: number, endOffset: number) => {
    found.push({
      file: path,
      name,
      qualified: `${path}::${name}`,
      lineStart: lineAt(starts, startOffset),
      lineEnd: lineAt(starts, Math.max(startOffset, endOffset - 1)),
    });
  };

  if (lang === 'py') {
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(lines[i]!);
      if (!m) continue;
      const indent = m[1]!.length;
      let end = i;
      for (let j = i + 1; j < lines.length; j++) {
        const text = lines[j]!;
        if (text.trim() === '') continue;
        if (text.length - text.trimStart().length <= indent) break;
        end = j;
      }
      found.push({ file: path, name: m[2]!, qualified: `${path}::${m[2]}`, lineStart: i + 1, lineEnd: end + 1 });
    }
    return found.slice(0, MAX_FUNCTIONS_PER_FILE);
  }

  const patterns: RegExp[] = [
    /\bfunction\s*\*?\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]{1,200})?=\s*(?:async\s*)?(?:function\b[^(]{0,100}\(|\([^)]{0,300}\)\s*(?::[^=\n{]{1,200})?=>|[A-Za-z_$][\w$]*\s*=>)/g,
    /\b(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b[^(]{0,100}\(|\([^)]{0,300}\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g,
  ];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    for (const m of src.matchAll(pattern)) {
      const name = m[1]!;
      const startOffset = m.index!;
      const afterHeader = startOffset + m[0].length;
      const lineEndOffset = src.indexOf('\n', afterHeader);
      const lineEnd = lineEndOffset === -1 ? src.length : lineEndOffset;
      let endOffset: number;
      if (m[0].includes('=>')) {
        // Arrow function: a `{` body, or an expression that ends at the end of the line.
        const bodyStart = afterHeader + /^\s*/.exec(src.slice(afterHeader))![0].length;
        endOffset = src[bodyStart] === '{' ? matchBracket(src, bodyStart) : lineEnd;
      } else {
        // `function name(...) {`: skip the parameter list, then match the body braces.
        const braceAt = src.indexOf('{', matchBracket(src, afterHeader - 1));
        endOffset = braceAt === -1 ? lineEnd : matchBracket(src, braceAt);
      }
      const key = `${name}@${startOffset}`;
      if (seen.has(key)) continue;
      seen.add(key);
      add(name, startOffset, endOffset);
      if (found.length >= MAX_FUNCTIONS_PER_FILE) return found;
    }
  }
  return found;
}

function enclosing(functions: CodeFunction[], line: number): CodeFunction | null {
  let best: CodeFunction | null = null;
  for (const fn of functions) {
    if (line >= fn.lineStart && line <= fn.lineEnd && (!best || fn.lineEnd - fn.lineStart < best.lineEnd - best.lineStart)) best = fn;
  }
  return best;
}

// ---- env reads ---------------------------------------------------------------------------------------------

function findEnvReads(path: string, src: string, lang: Language, starts: number[], functions: CodeFunction[]): EnvRead[] {
  const reads: EnvRead[] = [];
  const push = (name: string, offset: number) => {
    const line = lineAt(starts, offset);
    reads.push({ file: path, line, name, function: enclosing(functions, line)?.qualified ?? null });
  };
  const patterns =
    lang === 'js'
      ? [/process\.env\.([A-Za-z_]\w*)/g, /process\.env\[\s*['"]([^'"]+)['"]\s*\]/g]
      : [/os\.environ\[\s*['"]([^'"]+)['"]\s*\]/g, /os\.environ\.get\(\s*['"]([^'"]+)['"]/g, /os\.getenv\(\s*['"]([^'"]+)['"]/g, /(?<![\w.])environ\[\s*['"]([^'"]+)['"]\s*\]/g];
  for (const pattern of patterns) for (const m of src.matchAll(pattern)) push(m[1]!, m.index!);

  if (lang === 'js') {
    // const { A, B: alias } = process.env
    for (const m of src.matchAll(/\{([^}]{0,400})\}\s*=\s*process\.env\b/g)) {
      for (const part of m[1]!.split(',')) {
        const name = part.split(':')[0]!.split('=')[0]!.trim();
        if (/^[A-Za-z_]\w*$/.test(name)) push(name, m.index!);
      }
    }
  }
  return reads;
}

// ---- SDK calls -------------------------------------------------------------------------------------------------

function findSdkCalls(
  path: string,
  src: string,
  lang: Language,
  starts: number[],
  functions: CodeFunction[],
  consts: Consts,
): SdkCall[] {
  const calls: SdkCall[] = [];
  const lines = src.split('\n');

  const record = (op: SdkOperation, offset: number, args: string, receiverTarget: CallTarget | null) => {
    if (calls.length >= MAX_CALLS_PER_FILE) return;
    const line = lineAt(starts, offset);
    const fn = enclosing(functions, line);
    const field = TARGET_FIELD[op.service];
    const target = readField(args, field, lang, consts) ?? receiverTarget ?? { kind: 'unknown' as const, hint: null };
    const contextLines = fn ? lines.slice(fn.lineStart - 1, Math.min(fn.lineEnd, fn.lineStart - 1 + MAX_CONTEXT_LINES)) : lines.slice(Math.max(0, line - 16), line + 15);
    calls.push({
      file: path,
      line,
      function: fn?.qualified ?? null,
      op,
      action: iamAction(op),
      target,
      context: contextLines.join('\n').slice(0, 4000),
    });
  };

  const argsAt = (openParen: number) => argsBetween(src, openParen);

  if (lang === 'js') {
    for (const m of src.matchAll(/\bnew\s+([A-Za-z0-9_]+Command)\s*\(/g)) {
      const op = own(JS_COMMANDS, m[1]!);
      if (op) record(op, m.index!, argsAt(m.index! + m[0].length - 1), null);
    }
    for (const m of src.matchAll(/\.\s*([A-Za-z0-9_]+)\s*\(/g)) {
      const name = m[1]!;
      const open = m.index! + m[0].length - 1;
      const unambiguous = own(JS_METHODS, name);
      if (unambiguous) {
        const args = argsAt(open);
        // Method names like `publish`/`invoke`/`upload` are common; require the SDK's target field, or at least an object argument.
        if (new RegExp(`\\b${TARGET_FIELD[unambiguous.service]}\\b`).test(args) || /^\s*\{/.test(args)) record(unambiguous, m.index!, args, null);
        continue;
      }
      const ambiguous = own(JS_AMBIGUOUS_DYNAMO_METHODS, name);
      if (ambiguous) {
        const args = argsAt(open);
        if (/\bTableName\b/.test(args)) record(ambiguous, m.index!, args, null);
      }
    }
    return calls;
  }

  // Python: variables bound to a resource (Table(...), Bucket(...), get_queue_by_name(...)).
  const receivers = new Map<string, { kind: 'table' | 'other'; target: CallTarget }>();
  for (const m of src.matchAll(/\b([A-Za-z_]\w*)\s*=\s*[\w.]{0,100}(?:\([^)]{0,300}\))?\s*\.\s*(Table|Bucket|get_queue_by_name)\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const args = argsAt(open);
    const first = m[2] === 'get_queue_by_name' ? readField(args, 'QueueName', 'py', consts) : resolveExpr(args.split(',')[0]!, consts);
    receivers.set(m[1]!, { kind: m[2] === 'Table' ? 'table' : 'other', target: first ?? { kind: 'unknown', hint: null } });
  }
  for (const m of src.matchAll(/(?:\b([A-Za-z_]\w*)|\))\s*\.\s*([A-Za-z0-9_]+)\s*\(/g)) {
    const receiverName = m[1];
    const method = m[2]!;
    const open = m.index! + m[0].length - 1;
    const receiver = receiverName ? receivers.get(receiverName) : undefined;
    const op = own(PY_METHODS, method) ?? (receiver?.kind === 'table' ? own(PY_TABLE_METHODS, method) : undefined);
    if (!op) continue;
    const args = argsAt(open);
    // `publish`/`invoke`/`upload_*` etc. are generic words; require an SDK-looking call (known receiver or the target kwarg).
    const looksLikeSdk = receiver !== undefined || new RegExp(`\\b${TARGET_FIELD[op.service]}\\s*=`).test(args) || op.service === 's3' || op.service === 'dynamodb';
    if (!looksLikeSdk) continue;
    record(op, m.index!, args, receiver?.target ?? null);
  }
  return calls;
}

// ---- calls between functions ------------------------------------------------------------------------------------------
//
// Only calls that name their target are followed: a bare call to a function defined in the same file, a call to
// a name imported from another analyzed file, or `module.fn()` on an imported module. `obj.method()` is not
// followed, because which function it reaches depends on what `obj` is at runtime.

interface ImportBinding {
  /** The analyzed file the binding comes from. */
  file: string;
  /** The exported name for a named import; null for a whole-module (default/namespace/`import x`) binding. */
  name: string | null;
}

interface RawCall {
  caller: string;
  line: number;
  /** Set for `ns.name()`; null for a bare `name()`. */
  qualifier: string | null;
  name: string;
}

const JS_EXTENSIONS = ['', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'];

/** Resolves a relative module specifier to one of the analyzed files. */
function resolveJsModule(fromFile: string, specifier: string, allPaths: Set<string>): string | null {
  if (!specifier.startsWith('.')) return null; // packages are not analyzed
  const base = posixJoin(dirnameOf(fromFile), specifier);
  const candidates = [base, base.replace(/\.[mc]?js$/, '.ts'), base.replace(/\.[mc]?js$/, '.tsx')];
  for (const candidate of candidates) {
    for (const extension of JS_EXTENSIONS) if (allPaths.has(candidate + extension)) return candidate + extension;
    for (const extension of JS_EXTENSIONS.slice(1)) if (allPaths.has(`${candidate}/index${extension}`)) return `${candidate}/index${extension}`;
  }
  return null;
}

/** Resolves `pkg.mod`, `.sibling` or `..pkg.mod` to an analyzed Python file. */
function resolvePythonModule(fromFile: string, module: string, allPaths: Set<string>): string | null {
  const dots = /^\.*/.exec(module)![0].length;
  const rest = module.slice(dots).split('.').filter(Boolean).join('/');
  const here = dirnameOf(fromFile);
  const bases: string[] = [];
  if (dots > 0) {
    let dir = here;
    for (let i = 1; i < dots; i++) dir = dirnameOf(dir);
    bases.push(dir);
  } else {
    bases.push(here, ''); // the importing file's folder, then the repository root
  }
  for (const dir of bases) {
    const path = posixJoin(dir, rest);
    if (rest && allPaths.has(`${path}.py`)) return `${path}.py`;
    if (allPaths.has(`${path}/__init__.py`)) return `${path}/__init__.py`;
  }
  return null;
}

const dirnameOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function posixJoin(dir: string, relative: string): string {
  const out: string[] = dir ? dir.split('/') : [];
  for (const part of relative.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function findJsImports(file: string, src: string, allPaths: Set<string>): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  const bind = (local: string, specifier: string, name: string | null) => {
    const target = resolveJsModule(file, specifier, allPaths);
    if (target && /^[A-Za-z_$][\w$]*$/.test(local)) bindings.set(local, { file: target, name });
  };
  const named = (list: string, specifier: string, separator: RegExp) => {
    for (const item of list.split(',')) {
      const [imported, local] = item.trim().split(separator).map((part) => part.trim());
      if (imported) bind(local || imported, specifier, imported);
    }
  };
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) named(m[1]!, m[2]!, /\s*:\s*/);
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g)) bind(m[1]!, m[2]!, null);
  for (const m of src.matchAll(/import\s+(?!type\b)([^;'"]*?)\s+from\s*['"]([^'"]+)['"]/g)) {
    const clause = m[1]!;
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) named(braces[1]!, m[2]!, /\s+as\s+/);
    const namespace = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (namespace) bind(namespace[1]!, m[2]!, null);
    const defaultName = /^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause.replace(/\{[^}]*\}/, '').replace(/\*\s*as\s+\w+/, ''));
    if (defaultName) bind(defaultName[1]!, m[2]!, null);
  }
  return bindings;
}

function findPythonImports(file: string, src: string, allPaths: Set<string>): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  for (const m of src.matchAll(/^[ \t]*from\s+(\.*[\w.]*)\s+import\s+(\([^)]*\)|[^\n]+)/gm)) {
    const target = resolvePythonModule(file, m[1]!, allPaths);
    for (const item of m[2]!.replace(/[()]/g, ' ').split(',')) {
      const [imported, local] = item.trim().split(/\s+as\s+/);
      if (!imported || !/^\w+$/.test(imported)) continue;
      // `from pkg import sub` may import a submodule (file or package) rather than a name inside pkg.
      const submodule = resolvePythonModule(file, m[1]!.endsWith('.') ? `${m[1]}${imported}` : `${m[1]}.${imported}`, allPaths);
      if (submodule) bindings.set(local ?? imported, { file: submodule, name: null });
      else if (target) bindings.set(local ?? imported, { file: target, name: imported });
    }
  }
  for (const m of src.matchAll(/^[ \t]*import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm)) {
    const target = resolvePythonModule(file, m[1]!, allPaths);
    if (target) bindings.set(m[2] ?? m[1]!.split('.').pop()!, { file: target, name: null });
  }
  return bindings;
}

/** Every `name(` and `ns.name(` inside a function, with the function it is in. */
function findRawCalls(src: string, lang: Language, starts: number[], functions: CodeFunction[]): RawCall[] {
  const calls: RawCall[] = [];
  const header = lang === 'js' ? /(?:function\s*\*?\s*|class\s+)$/ : /(?:def|class)\s+$/;
  for (const m of src.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?\s*\(/g)) {
    const before = src.slice(Math.max(0, m.index! - 24), m.index!);
    if (header.test(before)) continue; // a declaration, not a call
    if (calls.length >= MAX_CALLS_PER_FILE) break;
    const line = lineAt(starts, m.index!);
    const caller = enclosing(functions, line);
    if (!caller) continue;
    calls.push(m[2] ? { caller: caller.qualified, line, qualifier: m[1]!, name: m[2] } : { caller: caller.qualified, line, qualifier: null, name: m[1]! });
  }
  return calls;
}

const CALL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'async', 'function', 'new', 'super', 'import', 'require', 'print']);

function resolveCalls(
  file: string,
  raw: RawCall[],
  imports: Map<string, ImportBinding>,
  functionsByQualified: Map<string, CodeFunction>,
): CodeCall[] {
  const calls: CodeCall[] = [];
  for (const call of raw) {
    if (CALL_KEYWORDS.has(call.name) && call.qualifier === null) continue;
    let target: string | undefined;
    if (call.qualifier === null) {
      const binding = imports.get(call.name);
      if (binding?.name) target = `${binding.file}::${binding.name}`;
      else if (!binding) target = `${file}::${call.name}`;
    } else {
      const binding = imports.get(call.qualifier);
      if (binding && binding.name === null) target = `${binding.file}::${call.name}`;
    }
    if (target && target !== call.caller && functionsByQualified.has(target)) {
      calls.push({ caller: call.caller, callee: target, file, line: call.line });
    }
  }
  return calls;
}

// ---- entry point ----------------------------------------------------------------------------------------------------

/** Whether any line is long enough to mean minified or generated code. Found without splitting the file. */
function hasVeryLongLine(content: string): boolean {
  let lineStart = 0;
  for (let i = 0; i <= content.length; i++) {
    if (i === content.length || content.charCodeAt(i) === 10) {
      if (i - lineStart > MAX_LINE_LENGTH) return true;
      lineStart = i + 1;
    }
  }
  return false;
}

export function scanCode(sources: CodeSource[], options: { budgetMs?: number } = {}): CodeFacts {
  const budgetMs = options.budgetMs ?? SCAN_BUDGET_MS;
  const facts: CodeFacts = { skipped: [], files: [], functions: [], envReads: [], sdkCalls: [], calls: [] };
  const allPaths = new Set(sources.filter((source) => languageOf(source.path)).map((source) => source.path));
  const pendingCalls: { path: string; raw: RawCall[]; imports: Map<string, ImportBinding> }[] = [];
  const startedAt = performance.now();
  for (const source of sources) {
    const lang = languageOf(source.path);
    if (!lang) continue;
    if (performance.now() - startedAt > budgetMs) {
      throw new AnalysisLimitError('This repository took too long to analyse. Link a smaller folder (for example just the infrastructure and the code it runs).');
    }
    if (hasVeryLongLine(source.content)) {
      facts.skipped.push({ path: source.path, reason: `it has a line over ${MAX_LINE_LENGTH} characters, so it looks minified or generated` });
      continue;
    }
    const src = stripComments(source.content, lang);
    const starts = lineStarts(src);
    const consts = collectConsts(src, lang);
    const functions = findFunctions(source.path, src, lang, starts);

    facts.files.push(source.path);
    facts.functions.push(...functions);
    facts.envReads.push(...findEnvReads(source.path, src, lang, starts, functions));
    facts.sdkCalls.push(...findSdkCalls(source.path, src, lang, starts, functions, consts));
    pendingCalls.push({
      path: source.path,
      raw: findRawCalls(src, lang, starts, functions),
      imports: lang === 'js' ? findJsImports(source.path, src, allPaths) : findPythonImports(source.path, src, allPaths),
    });
  }

  // Resolving a call needs every file's functions, so it happens once all files have been read.
  const functionsByQualified = new Map(facts.functions.map((fn) => [fn.qualified, fn]));
  for (const { path, raw, imports } of pendingCalls) facts.calls.push(...resolveCalls(path, raw, imports, functionsByQualified));
  return facts;
}
