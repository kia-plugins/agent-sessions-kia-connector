#!/usr/bin/env node
// Usage: node scripts/bench.mjs [claude|codex ...]
// Backfill then one unchanged tick against the real ~/.claude and ~/.codex,
// through a direct-fs adapter (host RPC cost is measured by the manual smoke).
// Nothing is written anywhere; documents are counted and discarded.
import { build } from 'esbuild';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const out = path.join(os.tmpdir(), `agent-sessions-bench-${process.pid}.cjs`);
await build({
  stdin: {
    contents: `
      export { fsFiles } from './test/support/fs-files';
      export { claudeSource } from './src/claude/source';
      export { codexSource } from './src/codex/source';
      export { fakeSession } from '@kiagent/connector-sdk/testing';`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error',
});
const { fsFiles, claudeSource, codexSource, fakeSession } = createRequire(import.meta.url)(out);

const make = { claude: claudeSource, codex: codexSource };
for (const root of process.argv.slice(2).length ? process.argv.slice(2) : ['claude', 'codex']) {
  const src = make[root](fsFiles({ [root]: path.join(os.homedir(), `.${root}`) }));
  const pull = async (cursor) => {
    const t0 = Date.now();
    const types = {};
    let docs = 0;
    for await (const b of src.pull(fakeSession(), cursor)) {
      docs += b.items.length;
      for (const d of b.items) types[d.type] = (types[d.type] ?? 0) + 1;
      cursor = b.cursor;
    }
    return { ms: Date.now() - t0, docs, types, cursor, cursorBytes: JSON.stringify(cursor).length };
  };
  const backfill = await pull(null);
  const tick = await pull(backfill.cursor);
  console.log(root, JSON.stringify({ backfill: { ms: backfill.ms, docs: backfill.docs, types: backfill.types, cursorBytes: backfill.cursorBytes },
    unchangedTick: { ms: tick.ms, docs: tick.docs } }));
}
