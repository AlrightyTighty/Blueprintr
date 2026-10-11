/**
 * A deliberately small reader for HCL expressions of the shape `jsonencode({...})` bodies take:
 * objects, lists, strings, numbers, booleans and references. Anything fancier (operators,
 * conditionals, most function calls) makes it give up and return `undefined`, which callers treat
 * as "policy not analysable". References become `"${a.b.c}"` strings so the usual reference
 * extraction works on the result.
 */
type Token =
  | { t: 'punct'; v: '{' | '}' | '[' | ']' | '(' | ')' | ',' | '=' | ':' | 'nl' }
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }
  | { t: 'word'; v: string };

class GiveUp extends Error {}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\n') {
      tokens.push({ t: 'punct', v: 'nl' });
      i++;
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === '#' || (c === '/' && src[i + 1] === '/')) {
      while (i < src.length && src[i] !== '\n') i++;
    } else if ('{}[](),=:'.includes(c)) {
      tokens.push({ t: 'punct', v: c as never });
      i++;
    } else if (c === '"') {
      let out = '';
      i++;
      let depth = 0; // inside ${ ... } quotes are part of the expression
      while (i < src.length) {
        const ch = src[i]!;
        if (depth === 0 && ch === '"') break;
        if (depth === 0 && ch === '\\') {
          out += src[i + 1] ?? '';
          i += 2;
          continue;
        }
        if (ch === '$' && src[i + 1] === '{') depth++;
        else if (ch === '}' && depth > 0) depth--;
        out += ch;
        i++;
      }
      if (i >= src.length) throw new GiveUp();
      i++;
      tokens.push({ t: 'str', v: out });
    } else if (/[0-9-]/.test(c) && /^-?\d+(\.\d+)?/.test(src.slice(i))) {
      const m = /^-?\d+(\.\d+)?/.exec(src.slice(i))!;
      tokens.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i;
      // identifiers, dotted attribute chains and index/splat segments
      while (j < src.length && /[\w.\-*]/.test(src[j]!)) j++;
      while (src[j] === '[') {
        const close = src.indexOf(']', j);
        if (close === -1) throw new GiveUp();
        j = close + 1;
        while (j < src.length && /[\w.\-*]/.test(src[j]!)) j++;
      }
      tokens.push({ t: 'word', v: src.slice(i, j) });
      i = j;
    } else {
      throw new GiveUp();
    }
  }
  return tokens;
}

class Reader {
  private i = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token | undefined {
    return this.tokens[this.i];
  }

  private skipNewlines(): void {
    while (this.peek()?.t === 'punct' && (this.peek() as { v: string }).v === 'nl') this.i++;
  }

  private isPunct(v: string): boolean {
    const t = this.peek();
    return t?.t === 'punct' && t.v === v;
  }

  private expect(v: string): void {
    this.skipNewlines();
    if (!this.isPunct(v)) throw new GiveUp();
    this.i++;
  }

  value(): unknown {
    this.skipNewlines();
    const token = this.peek();
    if (!token) throw new GiveUp();
    if (token.t === 'str') {
      this.i++;
      return token.v;
    }
    if (token.t === 'num') {
      this.i++;
      return token.v;
    }
    if (token.t === 'punct' && token.v === '{') return this.object();
    if (token.t === 'punct' && token.v === '[') return this.list();
    if (token.t === 'word') {
      this.i++;
      if (token.v === 'true') return true;
      if (token.v === 'false') return false;
      if (token.v === 'null') return null;
      if (this.isPunct('(')) {
        this.skipCall();
        return null; // unknown function result
      }
      return `\${${token.v}}`;
    }
    throw new GiveUp();
  }

  private skipCall(): void {
    let depth = 0;
    do {
      const t = this.peek();
      if (!t) throw new GiveUp();
      if (t.t === 'punct' && t.v === '(') depth++;
      if (t.t === 'punct' && t.v === ')') depth--;
      this.i++;
    } while (depth > 0);
  }

  private object(): Record<string, unknown> {
    this.expect('{');
    const out: Record<string, unknown> = {};
    for (;;) {
      this.skipNewlines();
      while (this.isPunct(',')) {
        this.i++;
        this.skipNewlines();
      }
      if (this.isPunct('}')) {
        this.i++;
        return out;
      }
      const key = this.peek();
      if (!key || (key.t !== 'word' && key.t !== 'str')) throw new GiveUp();
      this.i++;
      this.skipNewlines();
      if (!this.isPunct('=') && !this.isPunct(':')) throw new GiveUp();
      this.i++;
      out[key.v] = this.value();
    }
  }

  private list(): unknown[] {
    this.expect('[');
    const out: unknown[] = [];
    for (;;) {
      this.skipNewlines();
      while (this.isPunct(',')) {
        this.i++;
        this.skipNewlines();
      }
      if (this.isPunct(']')) {
        this.i++;
        return out;
      }
      out.push(this.value());
    }
  }

  atEnd(): boolean {
    this.skipNewlines();
    return this.i >= this.tokens.length;
  }
}

export function parseHclExpression(source: string): unknown | undefined {
  try {
    const reader = new Reader(tokenize(source));
    const value = reader.value();
    return reader.atEnd() ? value : undefined;
  } catch (err) {
    if (err instanceof GiveUp) return undefined;
    throw err;
  }
}

/** Extracts `X` from `${jsonencode(X)}`. */
export function unwrapJsonencode(value: string): string | null {
  const trimmed = value.trim();
  const match = /^\$\{\s*jsonencode\(([\s\S]*)\)\s*\}$/.exec(trimmed);
  return match ? match[1]! : null;
}
