import type { HostFor } from '@kiagent/connector-sdk';

export type Files = HostFor<'files'>['files'];

export interface FileStat {
  rel: string;
  name: string;
  kind: 'file' | 'directory' | 'other';
  size: number;
  mtimeMs: number;
  dev: string;
  ino: string;
}

export const READ_CHUNK = 4 * 1024 * 1024;
export const MAX_LINE = 1024 * 1024;
export const OVERSIZED: unique symbol = Symbol('oversized');

const joinRel = (a: string, b: string): string => (a ? `${a}/${b}` : b);

/** ScopedFiles errors cross the RPC boundary as plain messages. */
export function isMissing(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /ENOENT|no such file|ENOTDIR|not a directory/i.test(msg);
}

export async function listDir(files: Files, root: string, rel: string): Promise<FileStat[]> {
  const out: FileStat[] = [];
  let cursor: string | undefined;
  do {
    let page;
    try {
      page = await files.list({ root, rel }, { cursor, limit: 1000 });
    } catch (e) {
      // A missing folder is empty. Any other error on a SUB-folder (EACCES,
      // a transient RPC failure) skips only that folder this tick; only the
      // root listing may fail the whole pull (revoked or unreadable root).
      if (isMissing(e) || rel !== '') return out;
      throw e;
    }
    for (const e of page.entries)
      out.push({ rel: joinRel(rel, e.name), name: e.name, kind: e.kind, size: e.size, mtimeMs: e.mtimeMs, dev: e.dev, ino: e.ino });
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

export async function readText(files: Files, root: string, rel: string, size: number, cap = 2 * 1024 * 1024): Promise<string> {
  const want = Math.min(size, cap);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < want) {
    const bytes = await files.read({ root, rel }, { offset, maxBytes: Math.min(READ_CHUNK, want - offset) });
    if (bytes.length === 0) break;
    chunks.push(bytes);
    offset += bytes.length;
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

/** Yields whole lines (≤ maxLine chars). A longer line is never buffered:
 *  its bytes are discarded up to the next newline and OVERSIZED is yielded
 *  once in its place. An unterminated final line is yielded as-is (callers
 *  treat unparsable lines as skippable — a file may be mid-write). */
export async function* streamLines(
  files: Files,
  root: string,
  rel: string,
  size: number,
  opts: { chunk?: number; maxLine?: number } = {},
): AsyncGenerator<string | typeof OVERSIZED> {
  const chunk = opts.chunk ?? READ_CHUNK;
  const maxLine = opts.maxLine ?? MAX_LINE;
  const decoder = new TextDecoder('utf-8');
  let offset = 0;
  let buf = '';
  let skipping = false;
  while (offset < size) {
    const bytes = await files.read({ root, rel }, { offset, maxBytes: Math.min(chunk, size - offset) });
    if (bytes.length === 0) break;
    offset += bytes.length;
    const text = decoder.decode(bytes, { stream: true });
    let start = 0;
    for (;;) {
      const nl = text.indexOf('\n', start);
      const piece = nl < 0 ? text.slice(start) : text.slice(start, nl);
      if (skipping) {
        if (nl >= 0) skipping = false;
      } else if (buf.length + piece.length > maxLine) {
        buf = '';
        yield OVERSIZED;
        if (nl < 0) skipping = true;
      } else if (nl >= 0) {
        const line = buf + piece;
        buf = '';
        if (line) yield line;
      } else {
        buf += piece;
      }
      if (nl < 0) break;
      start = nl + 1;
    }
  }
  buf += decoder.decode();
  if (buf && !skipping) yield buf;
}

export async function firstLine(files: Files, root: string, rel: string, size: number): Promise<string | null> {
  // Small chunk: a Codex session_meta line is ~20 KiB; never pull 4 MiB for it.
  for await (const line of streamLines(files, root, rel, size, { chunk: 64 * 1024 })) return typeof line === 'string' ? line : null;
  return null;
}
