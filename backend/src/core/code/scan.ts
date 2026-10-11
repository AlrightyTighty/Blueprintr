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

export interface CodeFacts {
  files: string[];
  functions: CodeFunction[];
  envReads: EnvRead[];
  sdkCalls: SdkCall[];
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

/** Index just past the bracket that closes the one at `open`, skipping string literals. */
function matchBracket(src: string, open: number): number {
  const opener = src[open]!;
  const closer = opener === '(' ? ')' : opener === '{' ? '}' : ']';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') i++;
        i++;
      }
    } else if (c === opener) depth++;
    else if (c === closer && --depth === 0) return i + 1;
  }
  return src.length;
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
      ? /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*([^;\n]+)/g
      : /^[ \t]*([A-Za-z_]\w*)\s*(?::[^=\n]+)?=\s*([^\n]+)/gm;
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
    return found;
  }

  const patterns: RegExp[] = [
    /\bfunction\s*\*?\s+([A-Za-z_$][\w$]*)\s*\(/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:function\b[^(]*\(|\([^)]*\)\s*(?::[^=\n{]+)?=>|[A-Za-z_$][\w$]*\s*=>)/g,
    /\b(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b[^(]*\(|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g,
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
    for (const m of src.matchAll(/\{([^}]*)\}\s*=\s*process\.env\b/g)) {
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
    const line = lineAt(starts, offset);
    const fn = enclosing(functions, line);
    const field = TARGET_FIELD[op.service];
    const target = readField(args, field, lang, consts) ?? receiverTarget ?? { kind: 'unknown' as const, hint: null };
    const contextLines = fn ? lines.slice(fn.lineStart - 1, fn.lineEnd) : lines.slice(Math.max(0, line - 16), line + 15);
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

  const argsAt = (openParen: number) => src.slice(openParen + 1, matchBracket(src, openParen) - 1);

  if (lang === 'js') {
    for (const m of src.matchAll(/\bnew\s+([A-Za-z0-9_]+Command)\s*\(/g)) {
      const op = JS_COMMANDS[m[1]!];
      if (op) record(op, m.index!, argsAt(m.index! + m[0].length - 1), null);
    }
    for (const m of src.matchAll(/\.\s*([A-Za-z0-9_]+)\s*\(/g)) {
      const name = m[1]!;
      const open = m.index! + m[0].length - 1;
      const unambiguous = JS_METHODS[name];
      if (unambiguous) {
        const args = argsAt(open);
        // Method names like `publish`/`invoke`/`upload` are common; require the SDK's target field, or at least an object argument.
        if (new RegExp(`\\b${TARGET_FIELD[unambiguous.service]}\\b`).test(args) || /^\s*\{/.test(args)) record(unambiguous, m.index!, args, null);
        continue;
      }
      const ambiguous = JS_AMBIGUOUS_DYNAMO_METHODS[name];
      if (ambiguous) {
        const args = argsAt(open);
        if (/\bTableName\b/.test(args)) record(ambiguous, m.index!, args, null);
      }
    }
    return calls;
  }

  // Python: variables bound to a resource (Table(...), Bucket(...), get_queue_by_name(...)).
  const receivers = new Map<string, { kind: 'table' | 'other'; target: CallTarget }>();
  for (const m of src.matchAll(/([A-Za-z_]\w*)\s*=\s*[\w.]*(?:\([^)]*\))?\s*\.\s*(Table|Bucket|get_queue_by_name)\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const args = argsAt(open);
    const first = m[2] === 'get_queue_by_name' ? readField(args, 'QueueName', 'py', consts) : resolveExpr(args.split(',')[0]!, consts);
    receivers.set(m[1]!, { kind: m[2] === 'Table' ? 'table' : 'other', target: first ?? { kind: 'unknown', hint: null } });
  }
  for (const m of src.matchAll(/(?:([A-Za-z_]\w*)|\))\s*\.\s*([A-Za-z0-9_]+)\s*\(/g)) {
    const receiverName = m[1];
    const method = m[2]!;
    const open = m.index! + m[0].length - 1;
    const receiver = receiverName ? receivers.get(receiverName) : undefined;
    const op = PY_METHODS[method] ?? (receiver?.kind === 'table' ? PY_TABLE_METHODS[method] : undefined);
    if (!op) continue;
    const args = argsAt(open);
    // `publish`/`invoke`/`upload_*` etc. are generic words; require an SDK-looking call (known receiver or the target kwarg).
    const looksLikeSdk = receiver !== undefined || new RegExp(`\\b${TARGET_FIELD[op.service]}\\s*=`).test(args) || op.service === 's3' || op.service === 'dynamodb';
    if (!looksLikeSdk) continue;
    record(op, m.index!, args, receiver?.target ?? null);
  }
  return calls;
}

// ---- entry point ----------------------------------------------------------------------------------------------------

export function scanCode(sources: CodeSource[]): CodeFacts {
  const facts: CodeFacts = { files: [], functions: [], envReads: [], sdkCalls: [] };
  for (const source of sources) {
    const lang = languageOf(source.path);
    if (!lang) continue;
    const src = stripComments(source.content, lang);
    const starts = lineStarts(src);
    const consts = collectConsts(src, lang);
    const functions = findFunctions(source.path, src, lang, starts);

    facts.files.push(source.path);
    facts.functions.push(...functions);
    facts.envReads.push(...findEnvReads(source.path, src, lang, starts, functions));
    facts.sdkCalls.push(...findSdkCalls(source.path, src, lang, starts, functions, consts));
  }
  return facts;
}
