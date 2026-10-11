import { describe, expect, it } from 'vitest';
import { analyze } from '../src/core/analysis/pipeline.js';
import { AnalysisLimitError, MAX_LINE_LENGTH, scanCode } from '../src/core/code/scan.js';

// Anyone can link a repository, so a stranger's file must never make the analyzer slow. Before these limits
// existed, a 512 KB file of "{" took about 3 minutes and froze the server it ran on. Each case below used to
// take 16 to 177 seconds; the limit is generous so a slow machine doesn't fail them, yet far below that.
const KB = 1024;
const TIME_LIMIT_MS = 3000;
const repeat = (piece: string, bytes: number) => piece.repeat(Math.ceil(bytes / piece.length)).slice(0, bytes);
/** The same hostile text, broken into short lines so it is NOT caught by the minified-file rule. */
const inShortLines = (piece: string, bytes: number, lineLength = 1000) =>
  repeat(repeat(piece, lineLength) + '\n', bytes);

const hostile: { name: string; path: string; source: string }[] = [
  { name: 'only "{"', path: 'a.js', source: inShortLines('{', 512 * KB) },
  { name: 'only "("', path: 'a.js', source: inShortLines('(', 512 * KB) },
  { name: 'unclosed new XCommand(', path: 'a.js', source: inShortLines('new GetItemCommand(', 512 * KB) },
  { name: 'unclosed .method( calls', path: 'a.js', source: inShortLines('.getItem(', 512 * KB) },
  { name: 'braces then a call', path: 'a.js', source: `${inShortLines('{', 200 * KB)}.getItem(${inShortLines('}', 200 * KB)}` },
  { name: '"} = process.env" with no opening brace', path: 'a.js', source: inShortLines('} = process.env ', 512 * KB) },
  { name: 'const x = ( unclosed arrow headers', path: 'a.ts', source: inShortLines('const f = (', 512 * KB) },
  { name: 'python "x=("', path: 'a.py', source: inShortLines('x=(', 512 * KB) },
  { name: 'python "x = a."', path: 'a.py', source: inShortLines('x = a.', 512 * KB) },
  { name: 'python one long identifier per line', path: 'a.py', source: inShortLines('a', 512 * KB) },
  { name: 'python unclosed receivers', path: 'a.py', source: inShortLines('t = boto3.resource("dynamodb").Tab', 512 * KB) },
  { name: 'a huge number of tiny functions', path: 'a.js', source: repeat('function f(){}\n', 512 * KB) },
  { name: 'a huge number of SDK calls in one function', path: 'a.js', source: `function big(){\n${repeat('db.send(new GetItemCommand({TableName:"t"}));\n', 500 * KB)}}` },
];

describe('the code scanner stays fast on hostile files', () => {
  it.each(hostile)('$name', ({ path, source }) => {
    const started = performance.now();
    scanCode([{ path, content: source }]);
    expect(performance.now() - started).toBeLessThan(TIME_LIMIT_MS);
  });

  it('skips a file with a very long line instead of reading it', () => {
    const minified = `var a=1;${repeat('a=a+1;', 3 * MAX_LINE_LENGTH)}`;
    const facts = scanCode([{ path: 'bundle.js', content: minified }]);
    expect(facts.files).toEqual([]);
    expect(facts.skipped).toHaveLength(1);
    expect(facts.skipped[0]).toMatchObject({ path: 'bundle.js' });
    expect(facts.skipped[0].reason).toMatch(/minified or generated/);
  });

  it('does not skip an ordinary file', () => {
    const facts = scanCode([{ path: 'app.js', content: 'const x = 1;\n'.repeat(500) }]);
    expect(facts.files).toEqual(['app.js']);
    expect(facts.skipped).toEqual([]);
  });

  it('caps how many SDK calls it keeps from one file', () => {
    const facts = scanCode([{ path: 'a.js', content: repeat('db.send(new GetItemCommand({TableName:"t"}));\n', 200 * KB) }]);
    expect(facts.sdkCalls.length).toBeLessThanOrEqual(2000);
    expect(facts.sdkCalls.length).toBeGreaterThan(0);
  });

  it('stops with a clear message when the scan runs out of time', () => {
    const files = [{ path: 'a.js', content: 'const x = 1;\n' }, { path: 'b.js', content: 'const y = 2;\n' }];
    expect(() => scanCode(files, { budgetMs: -1 })).toThrow(AnalysisLimitError);
    expect(() => scanCode(files, { budgetMs: -1 })).toThrow(/took too long/);
  });

  it('reports a skipped file as a finding, so a missing function is never a mystery', async () => {
    const minified = `var a=1;${repeat('a=a+1;', 3 * MAX_LINE_LENGTH)}`;
    const out = await analyze({ files: [{ path: 'dist/bundle.js', content: minified }] });
    expect(out.findings.map((f) => f.title)).toContain('Skipped dist/bundle.js');
    expect(out.stats.skippedCodeFiles).toBe(1);
  });
});

describe('the scanner still finds real SDK calls', () => {
  it('reads a DynamoDB call with an env-var table name', () => {
    const facts = scanCode([
      { path: 'handler.js', content: 'async function get(id) {\n  return db.send(new GetItemCommand({ TableName: process.env.TABLE_NAME, Key: { id } }));\n}\n' },
    ]);
    expect(facts.sdkCalls).toHaveLength(1);
    expect(facts.sdkCalls[0]).toMatchObject({ action: 'dynamodb:GetItem', function: 'handler.js::get', target: { kind: 'env', name: 'TABLE_NAME' } });
  });

  it('finds a call whose arguments span many lines and nested brackets', () => {
    const facts = scanCode([
      { path: 'a.js', content: 'function f() {\n  return s3.send(new PutObjectCommand({\n    Bucket: process.env.B,\n    Body: JSON.stringify({ a: [1, 2, { b: (3) }] }),\n  }));\n}\n' },
    ]);
    expect(facts.sdkCalls).toHaveLength(1);
    expect(facts.sdkCalls[0].target).toEqual({ kind: 'env', name: 'B' });
  });

  it('finds a boto3 call on a known table', () => {
    const facts = scanCode([
      { path: 'w.py', content: 'import boto3\ntable = boto3.resource("dynamodb").Table("orders")\n\ndef save(item):\n    table.put_item(Item=item)\n' },
    ]);
    expect(facts.sdkCalls.map((c) => c.action)).toContain('dynamodb:PutItem');
  });
});

describe('names every object has are not SDK methods', () => {
  it('ignores toLocaleString, toString, valueOf and constructor calls', () => {
    const facts = scanCode([
      {
        path: 'ui.ts',
        content:
          "export const f = (d: string) => new Date(d).toLocaleString(undefined, { dateStyle: 'medium' });\nconst s = obj.toString({});\nconst v = x.valueOf({ a: 1 });\nconst c = y.constructor({ a: 1 });\nconst h = z.hasOwnProperty({ a: 1 });\n",
      },
      { path: 'u.py', content: 'x = a.toString(1)\ny = b.constructor(2)\nz = c.valueOf(3)\n' },
    ]);
    expect(facts.sdkCalls).toEqual([]);
  });
});
