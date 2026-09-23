import fs from 'node:fs/promises';
import path from 'node:path';
import type { Files } from '../../src/files';

export function fsFiles(roots: Record<string, string>) {
  const reads: Array<{ rel: string; offset: number; maxBytes: number }> = [];
  const abs = (ref: { root: string; rel: string }): string => {
    const base = roots[ref.root];
    if (!base) throw new Error(`file root ${ref.root} is unknown or revoked`);
    return path.join(base, ref.rel);
  };
  const info = async (p: string) => {
    const st = await fs.lstat(p);
    return {
      kind: st.isSymbolicLink() ? 'other' : st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other',
      size: st.size, blocks: st.blocks, mtimeMs: st.mtimeMs, dev: String(st.dev), ino: String(st.ino),
      nlink: st.nlink, mode: st.mode, symbolicLink: st.isSymbolicLink(),
    } as const;
  };
  const files = {
    reads,
    async roots() {
      return Object.keys(roots).map((id) => ({ id, name: `~/.${id}`, writable: false }));
    },
    async stat(ref: { root: string; rel: string }) {
      return info(abs(ref));
    },
    async list(ref: { root: string; rel: string }, o: { cursor?: string; limit?: number } = {}) {
      const names = (await fs.readdir(abs(ref))).sort();
      const start = o.cursor ? Number(o.cursor) : 0;
      const limit = o.limit ?? 200;
      const entries = await Promise.all(
        names.slice(start, start + limit).map(async (name) => ({ name, ...(await info(path.join(abs(ref), name))) })),
      );
      return { entries, nextCursor: start + limit < names.length ? String(start + limit) : undefined };
    },
    async read(ref: { root: string; rel: string }, o: { offset?: number; maxBytes?: number } = {}) {
      const maxBytes = o.maxBytes ?? 16 * 1024 * 1024;
      if (maxBytes > 16 * 1024 * 1024) throw new Error('invalid or oversized read');
      reads.push({ rel: ref.rel, offset: o.offset ?? 0, maxBytes });
      const fh = await fs.open(abs(ref), 'r');
      try {
        const buf = Buffer.alloc(maxBytes);
        const { bytesRead } = await fh.read(buf, 0, maxBytes, o.offset ?? 0);
        return new Uint8Array(buf.subarray(0, bytesRead));
      } finally {
        await fh.close();
      }
    },
  };
  return files as unknown as Files & { reads: typeof reads };
}
