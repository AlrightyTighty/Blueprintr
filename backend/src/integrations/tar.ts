import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';

export interface TarFile {
  path: string;
  content: Buffer;
}

export interface TarOptions {
  /** Return true to keep a file's content; skipped files are streamed past without buffering. */
  want(path: string, size: number): boolean;
  /** Abort if more than this many bytes of kept content accumulate. */
  maxTotalBytes: number;
}

function readString(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
}

function readOctal(buf: Buffer, start: number, length: number): number {
  const text = readString(buf, start, length).trim();
  return text === '' ? 0 : parseInt(text, 8);
}

/** Parses pax extended header records ("<len> key=value\n") and returns the `path` if present. */
function paxPath(data: Buffer): string | undefined {
  const text = data.toString('utf8');
  let offset = 0;
  while (offset < text.length) {
    const space = text.indexOf(' ', offset);
    if (space === -1) break;
    const length = parseInt(text.slice(offset, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, offset + length - 1);
    if (record.startsWith('path=')) return record.slice(5);
    offset += length;
  }
  return undefined;
}

/**
 * Streams a gzipped tarball (as served by GitHub), returning the regular files `options.want` accepts.
 * The archive's single top-level directory ("owner-repo-sha/") is stripped from every path.
 * Nothing is written to disk and nothing is executed.
 */
export async function readTarGz(body: ReadableStream<Uint8Array>, options: TarOptions): Promise<TarFile[]> {
  const stream = Readable.fromWeb(body as never).pipe(createGunzip());
  const files: TarFile[] = [];
  let total = 0;

  let pending: Buffer = Buffer.alloc(0);
  let state: 'header' | 'data' | 'skip' = 'header';
  let remaining = 0; // bytes of the current entry's data still to read
  let padding = 0; // bytes of block padding to discard after the data
  let entryPath = '';
  let entryKind: 'file' | 'pax' | 'ignore' = 'ignore';
  let collected: Buffer[] = [];
  let nextPath: string | undefined; // from a preceding pax or GNU long-name entry

  const finishEntry = () => {
    const data = Buffer.concat(collected);
    collected = [];
    if (entryKind === 'pax') nextPath = paxPath(data);
    else if (entryKind === 'file') files.push({ path: entryPath, content: data });
  };

  for await (const chunk of stream as AsyncIterable<Buffer>) {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);

    for (;;) {
      if (state === 'header') {
        if (pending.length < 512) break;
        const header = pending.subarray(0, 512);
        pending = pending.subarray(512);
        if (header.every((byte) => byte === 0)) continue; // end-of-archive padding

        const name = readString(header, 0, 100);
        const prefix = readString(header, 345, 155);
        const size = readOctal(header, 124, 12);
        const type = String.fromCharCode(header[156] || 48); // '0' or NUL means regular file
        const fullName = nextPath ?? (prefix ? `${prefix}/${name}` : name);
        padding = (512 - (size % 512)) % 512;
        remaining = size;

        if (type === 'x') entryKind = 'pax';
        else if (type === 'g') entryKind = 'ignore'; // global pax header (GitHub puts the commit sha here)
        else if (type === 'L') entryKind = 'ignore';
        else if (type === '0' || type === '\0') {
          const stripped = fullName.split('/').slice(1).join('/');
          entryPath = stripped;
          entryKind = stripped && options.want(stripped, size) ? 'file' : 'ignore';
          nextPath = undefined;
        } else {
          entryKind = 'ignore';
          nextPath = undefined;
        }
        if (entryKind === 'file') {
          total += size;
          if (total > options.maxTotalBytes) throw new Error('Repository is too large to analyze');
        }
        state = entryKind === 'ignore' ? 'skip' : 'data';
        if (remaining === 0) {
          finishEntry();
          state = 'header';
          const drop = Math.min(padding, pending.length);
          pending = pending.subarray(drop);
          padding -= drop;
          if (padding > 0) state = 'skip';
        }
        continue;
      }

      if (pending.length === 0) break;
      if (state === 'data') {
        const take = Math.min(remaining, pending.length);
        collected.push(Buffer.from(pending.subarray(0, take)));
        pending = pending.subarray(take);
        remaining -= take;
        if (remaining === 0) {
          finishEntry();
          state = padding > 0 ? 'skip' : 'header';
        }
      } else {
        // skip: discard remaining entry bytes, then padding
        const take = Math.min(remaining > 0 ? remaining : padding, pending.length);
        pending = pending.subarray(take);
        if (remaining > 0) remaining -= take;
        else padding -= take;
        if (remaining === 0 && padding === 0) state = 'header';
      }
    }
  }
  return files;
}
