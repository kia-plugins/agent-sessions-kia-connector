import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fsFiles } from '../../test/support/fs-files';
import { firstLine, listDir, OVERSIZED, readText, streamLines } from '../files';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-files-')); });
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

async function collect(it: AsyncGenerator<string | typeof OVERSIZED>) {
  const out: Array<string | typeof OVERSIZED> = [];
  for await (const x of it) out.push(x);
  return out;
}

it('listDir pages through >1000 entries and returns [] for a missing dir', async () => {
  for (let i = 0; i < 1203; i++) await fs.writeFile(path.join(dir, `f${String(i).padStart(4, '0')}`), '');
  const files = fsFiles({ r: dir });
  const all = await listDir(files, 'r', '');
  expect(all).toHaveLength(1203);
  expect(all[0]).toMatchObject({ name: 'f0000', rel: 'f0000', kind: 'file' });
  expect(await listDir(files, 'r', 'nope')).toEqual([]);
});

it('streams-multi-chunk-file: lines split across chunk boundaries come out whole', async () => {
  const lines = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(i % 97) }));
  await fs.writeFile(path.join(dir, 'a.jsonl'), lines.join('\n') + '\n');
  const size = (await fs.stat(path.join(dir, 'a.jsonl'))).size;
  const files = fsFiles({ r: dir });
  const out = await collect(streamLines(files, 'r', 'a.jsonl', size, { chunk: 4096 }));
  expect(out).toEqual(lines);
  expect(files.reads.every((r) => r.maxBytes <= 4096)).toBe(true);
});

it('streams-multi-chunk-file (> 16 MiB, real 4 MiB chunks)', async () => {
  const line = JSON.stringify({ pad: 'q'.repeat(1000) });
  const n = Math.ceil((17 * 1024 * 1024) / (line.length + 1));
  await fs.writeFile(path.join(dir, 'big.jsonl'), (line + '\n').repeat(n));
  const size = (await fs.stat(path.join(dir, 'big.jsonl'))).size;
  const files = fsFiles({ r: dir });
  let count = 0;
  for await (const x of streamLines(files, 'r', 'big.jsonl', size)) if (x === line) count++;
  expect(count).toBe(n);
  expect(files.reads.length).toBe(Math.ceil(size / (4 * 1024 * 1024)));
});

it('oversized-record-skipped-without-buffering', async () => {
  const big = JSON.stringify({ type: 'x', out: 'y'.repeat(3 * 1024 * 1024) });
  await fs.writeFile(path.join(dir, 'b.jsonl'), `{"a":1}\n${big}\n{"b":2}\n`);
  const size = (await fs.stat(path.join(dir, 'b.jsonl'))).size;
  const files = fsFiles({ r: dir });
  let peak = 0;
  const out: Array<string | typeof OVERSIZED> = [];
  for await (const x of streamLines(files, 'r', 'b.jsonl', size, { chunk: 256 * 1024, maxLine: 1024 * 1024 })) {
    if (typeof x === 'string') peak = Math.max(peak, x.length);
    out.push(x);
  }
  expect(out).toEqual(['{"a":1}', OVERSIZED, '{"b":2}']);
  expect(peak).toBeLessThanOrEqual(1024 * 1024);
});

it('skips-partial-last-line is left to the parser: an unterminated tail is yielded once', async () => {
  await fs.writeFile(path.join(dir, 'c.jsonl'), '{"a":1}\n{"b":');
  const size = (await fs.stat(path.join(dir, 'c.jsonl'))).size;
  const out = await collect(streamLines(fsFiles({ r: dir }), 'r', 'c.jsonl', size));
  expect(out).toEqual(['{"a":1}', '{"b":']);
});

it('multi-byte UTF-8 split across chunks decodes intact', async () => {
  const line = '日本語テキスト'.repeat(1000);
  await fs.writeFile(path.join(dir, 'u.jsonl'), line + '\n');
  const size = (await fs.stat(path.join(dir, 'u.jsonl'))).size;
  const out = await collect(streamLines(fsFiles({ r: dir }), 'r', 'u.jsonl', size, { chunk: 1001 }));
  expect(out).toEqual([line]);
});

it('readText caps the bytes read; firstLine reads only the first line', async () => {
  await fs.writeFile(path.join(dir, 'p.md'), '# Title\n' + 'z'.repeat(5000));
  const files = fsFiles({ r: dir });
  expect(await readText(files, 'r', 'p.md', 5008, 100)).toHaveLength(100);
  await fs.writeFile(path.join(dir, 'f.jsonl'), '{"first":true}\n{"second":true}\n');
  expect(await firstLine(files, 'r', 'f.jsonl', 31)).toBe('{"first":true}');
});
